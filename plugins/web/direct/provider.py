"""Direct page reader — plugin form, no key and no third-party reader.

``web_extract`` has no free backend upstream: DuckDuckGo (``ddgs``) only searches, and the
readers (Firecrawl, Tavily, Exa, Parallel) need a key and send the URL to their service. This
provider fetches the page itself, from wherever Hermes runs, and turns the HTML into clean
Markdown-like text, so "read this page" works for everyone out of the box (the page is read by
the same machine and network that would run ``curl`` in the terminal; no new data processor).

Where Hermes runs matters for the network, never for this code:

- On a Mac the request goes out directly (the SSRF-safe client pins the connect to a vetted IP).
- In Atum's cloud sandbox, which has no DNS and one route out, ``HTTPS_PROXY`` / ``HTTP_PROXY``
  point at the controller's egress proxy. httpx honours them (``trust_env``), the proxy resolves
  the name and refuses private destinations, and ``tools.url_safety.is_safe_url`` delegates its
  check to it (see ``_dns_delegated_to_egress_proxy``).

A page that needs JavaScript to show its text comes back thin; the result says so, and the
browser tools (which run a real Chromium) are the next step. Selecting a paid reader in
``web.extract_backend`` still wins: this provider is the keyless default for a search-only
``web.backend`` (``tools.web_tools.web_extract_tool``), never a silent switch to another service.
"""

from __future__ import annotations

import asyncio
import logging
import re
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlsplit

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)

# One page's body, in bytes: enough for any article, small enough that a hostile or runaway
# response cannot fill memory (the tool trims what it sends to the model on top of this).
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 5
# Wall-clock cap for one URL, redirects included (connect and read have their own limits too).
FETCH_TIMEOUT_SECS = 30.0
MAX_PARALLEL_FETCHES = 4

# A page whose readable text is shorter than this probably needs JavaScript (or is an error page).
THIN_PAGE_CHARS = 200

# Honest about being an automated reader, in the shape sites expect from a browser.
USER_AGENT = (
    "Mozilla/5.0 (compatible; Atum/1.0; +https://atumplatform.com) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)
REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
}

_HTML_TYPES = ("text/html", "application/xhtml+xml")
_TEXT_TYPES = (
    "text/",
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/rss+xml",
    "application/atom+xml",
    "application/x-ndjson",
    "application/yaml",
)

# Tags whose content is never page text.
_DROP = frozenset({
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
    "select", "option", "datalist", "dialog",
})
# Page chrome: dropped in the first pass, kept in the fallback pass when that finds almost nothing.
_CHROME = frozenset({"nav", "footer", "aside", "form", "button", "menu"})
_BLOCK = frozenset({
    "div", "section", "article", "main", "header", "dt", "dd", "tr", "thead", "tbody",
    "figcaption", "address", "summary", "fieldset", "legend", "hr", "li",
})
# Blocks that read as a paragraph of their own: a blank line around them.
_PARAGRAPH = frozenset({"p", "ul", "ol", "dl", "table", "blockquote", "figure", "details"})
_HEADING = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_VOID = frozenset({"br", "hr", "img", "input", "meta", "link", "source", "wbr", "area", "base", "col", "embed", "param", "track"})


class _ReadableHTML(HTMLParser):
    """HTML to Markdown-like text, with the standard library only.

    Keeps headings, paragraphs, lists, links (as ``[text](url)``), code and tables' text; drops
    scripts, styles and (unless ``keep_chrome``) navigation, footers, sidebars and forms.
    """

    def __init__(self, base_url: str, keep_chrome: bool = False) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.keep_chrome = keep_chrome
        self.parts: List[str] = []
        self.title = ""
        self.description = ""
        self.og_title = ""
        self._in_title = False
        self._title_parts: List[str] = []
        self._drop_depth = 0
        self._chrome_depth = 0
        self._pre_depth = 0
        self._links: List[Tuple[Optional[str], int]] = []

    # -- helpers -----------------------------------------------------------

    @property
    def _hidden(self) -> bool:
        return self._drop_depth > 0 or (self._chrome_depth > 0 and not self.keep_chrome)

    def _newline(self, count: int = 1) -> None:
        if self.parts:
            self.parts.append("\n" * count)

    def _href(self, value: Optional[str]) -> Optional[str]:
        value = (value or "").strip()
        if not value or value.startswith("#") or value.lower().startswith(("javascript:", "data:")):
            return None
        try:
            return urljoin(self.base_url, value)
        except ValueError:
            return None

    # -- parser callbacks --------------------------------------------------

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        values = dict(attrs)
        if tag == "title":
            self._in_title = True
            return
        if tag == "meta":
            key = (values.get("name") or values.get("property") or "").lower()
            content = (values.get("content") or "").strip()
            if key in ("description", "og:description") and content and not self.description:
                self.description = content
            elif key == "og:title" and content:
                self.og_title = content
            return
        if tag in _DROP:
            if tag not in _VOID:
                self._drop_depth += 1
            return
        if tag in _CHROME:
            self._chrome_depth += 1
            return
        if self._hidden:
            return
        if tag == "br":
            self.parts.append("\n")
        elif tag in _HEADING:
            self._newline(2)
            self.parts.append("#" * _HEADING[tag] + " ")
        elif tag == "li":
            self._newline()
            self.parts.append("- ")
        elif tag == "pre":
            self._newline(2)
            self._pre_depth += 1
            self.parts.append("```\n")
        elif tag in ("td", "th"):
            if self.parts and not self.parts[-1].endswith(("\n", "| ")):
                self.parts.append(" | ")
        elif tag == "a":
            self._links.append((self._href(values.get("href")), len(self.parts)))
        elif tag == "img":
            alt = (values.get("alt") or "").strip()
            if len(alt) >= 4:
                self.parts.append(f"[image: {alt}]")
        elif tag in _PARAGRAPH:
            self._newline(2)
        elif tag in _BLOCK:
            self._newline()

    def handle_startendtag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        # `<nav/>` or `<div/>` opens and closes at once; a void tag has no end tag to match.
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
            if not self.title:
                self.title = re.sub(r"\s+", " ", "".join(self._title_parts)).strip()
            return
        if tag in _DROP:
            if tag not in _VOID and self._drop_depth:
                self._drop_depth -= 1
            return
        if tag in _CHROME:
            if self._chrome_depth:
                self._chrome_depth -= 1
            return
        if self._hidden:
            return
        if tag in _HEADING:
            self._newline(2)
        elif tag == "pre":
            if self._pre_depth:
                self._pre_depth -= 1
                self.parts.append("\n```")
            self._newline(2)
        elif tag == "a":
            if self._links:
                href, start = self._links.pop()
                label = re.sub(r"\s+", " ", "".join(self.parts[start:])).strip()
                # A card-style link can hold a heading: its marker is not part of the link text.
                label = re.sub(r"(^|\s)#{1,6}\s", r"\1", label).strip()
                if href and label and not label.startswith("["):
                    del self.parts[start:]
                    self.parts.append(f"[{label}]({href})")
        elif tag in _PARAGRAPH:
            self._newline(2)
        elif tag in _BLOCK:
            self._newline()

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
            return
        if self._hidden or not data:
            return
        self.parts.append(data if self._pre_depth else re.sub(r"\s+", " ", data))

    # -- result ------------------------------------------------------------

    def text(self) -> str:
        lines: List[str] = []
        fenced = False
        for line in "".join(self.parts).replace("\r\n", "\n").split("\n"):
            if line.strip() == "```":
                fenced = not fenced
                lines.append("```")
            elif fenced:
                lines.append(line.rstrip())
            else:
                lines.append(line.strip())
        text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
        # A pipe left dangling at a table row's end by the cell separators.
        text = re.sub(r"[ \t]*\|[ \t]*(?=\n|$)", "", text)
        return text.strip()


def html_to_text(html_text: str, base_url: str) -> Dict[str, str]:
    """Readable text, title and description of an HTML document.

    First pass without page chrome (menus, footers, sidebars, forms); when that leaves almost
    nothing, a second pass keeps everything, so a site that marks its article up inside ``<nav>``
    or ``<aside>`` is not read as empty.
    """
    best: Optional[_ReadableHTML] = None
    best_text = ""
    for keep_chrome in (False, True):
        parser = _ReadableHTML(base_url, keep_chrome=keep_chrome)
        try:
            parser.feed(html_text)
            parser.close()
        except Exception as exc:  # noqa: BLE001 — malformed markup: keep what was read
            logger.debug("direct extract: HTML parse stopped early: %s", exc)
        text = parser.text()
        if best is None or len(text) > len(best_text):
            best, best_text = parser, text
        if len(text) >= THIN_PAGE_CHARS:
            break
    assert best is not None
    return {
        "title": best.title or best.og_title,
        "description": best.description,
        "text": best_text,
    }


def _content_type(header: str) -> str:
    return header.split(";", 1)[0].strip().lower()


def _is_html(content_type: str, body: bytes) -> bool:
    if content_type in _HTML_TYPES:
        return True
    if content_type:
        return False
    head = body[:512].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html"))


def _is_text(content_type: str) -> bool:
    return any(content_type.startswith(kind) for kind in _TEXT_TYPES)


def _decode(body: bytes, charset: Optional[str]) -> str:
    for encoding in (charset, "utf-8"):
        if not encoding:
            continue
        try:
            return body.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", errors="replace")


def _meta_charset(body: bytes) -> Optional[str]:
    match = re.search(rb"<meta[^>]+charset=[\"']?\s*([A-Za-z0-9_\-]+)", body[:4096], re.IGNORECASE)
    return match.group(1).decode("ascii", "ignore") if match else None


def _failure_hint(status: int) -> str:
    if status in (401, 403, 429, 451) or status >= 500:
        return " The site may block automated readers; try the browser tools if they are available."
    return ""


class DirectWebExtractProvider(WebSearchProvider):
    """Keyless ``web_extract`` backend that fetches and cleans the page itself."""

    @property
    def name(self) -> str:
        return "direct"

    @property
    def display_name(self) -> str:
        return "Direct fetch (built-in)"

    def is_available(self) -> bool:
        """Always, as long as httpx (a core dependency) imports. No key, no network I/O here."""
        try:
            import httpx  # noqa: F401

            return True
        except ImportError:
            return False

    def supports_search(self) -> bool:
        return False

    def supports_extract(self) -> bool:
        return True

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Direct fetch (built-in)",
            "badge": "free · no key · extract only",
            "tag": "Reads the page from this machine — no key, no third-party reader (pair with any search provider)",
            "env_vars": [],
        }

    # -- extract -----------------------------------------------------------

    async def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        from tools.interrupt import is_interrupted

        if is_interrupted():
            return [{"url": u, "error": "Interrupted", "title": "", "content": ""} for u in urls]
        gate = asyncio.Semaphore(MAX_PARALLEL_FETCHES)

        async def one(url: str) -> Dict[str, Any]:
            async with gate:
                return await self._extract_one(url)

        return list(await asyncio.gather(*(one(url) for url in urls)))

    async def _extract_one(self, url: str) -> Dict[str, Any]:
        failed = {"url": url, "title": "", "content": "", "raw_content": ""}
        try:
            return await asyncio.wait_for(self._fetch_and_clean(url), timeout=FETCH_TIMEOUT_SECS)
        except asyncio.TimeoutError:
            return {**failed, "error": (
                f"Timed out after {int(FETCH_TIMEOUT_SECS)}s — the page is slow or too large. "
                "Try the browser tools if they are available."
            )}
        except _Refused as refusal:
            return {**failed, "url": refusal.url or url, "error": refusal.message,
                    **({"blocked_by_policy": refusal.policy} if refusal.policy else {})}
        except Exception as exc:  # noqa: BLE001 — one bad URL never loses the others
            logger.debug("direct extract failed for %s: %s", url, exc)
            return {**failed, "error": f"Could not read the page: {type(exc).__name__}"}

    async def _fetch_and_clean(self, url: str) -> Dict[str, Any]:
        from tools.url_safety import create_ssrf_safe_async_client

        import httpx

        client = create_ssrf_safe_async_client(
            follow_redirects=False,
            headers=REQUEST_HEADERS,
            timeout=httpx.Timeout(20.0, connect=10.0),
            trust_env=True,
        )
        async with client:
            final_url, status, content_type, charset, body, truncated = await self._get(client, url)

        if status >= 400:
            raise _Refused(f"HTTP {status} from {urlsplit(final_url).netloc}.{_failure_hint(status)}", final_url)
        if content_type == "application/pdf":
            raise _Refused(
                "This is a PDF. Download it with the terminal and read it with a PDF tool or skill.", final_url)
        if not (_is_html(content_type, body) or _is_text(content_type) or not content_type):
            raise _Refused(f"Not a text page ({content_type or 'unknown type'}).", final_url)

        metadata: Dict[str, Any] = {
            "status": status, "content_type": content_type, "final_url": final_url, "truncated": truncated,
            "bytes": len(body),
        }
        if _is_html(content_type, body):
            # Parsing a large page is CPU work: keep it off the event loop other tools share.
            document = await asyncio.to_thread(
                html_to_text, _decode(body, charset or _meta_charset(body)), final_url)
            title = document["title"]
            text = document["text"]
            if document["description"]:
                metadata["description"] = document["description"]
            if len(text) < THIN_PAGE_CHARS:
                text += (
                    "\n\n(This page has very little text. If you expected more, it may build its content "
                    "with JavaScript: the browser tools, if available, can open it.)"
                )
        else:
            title = ""
            text = _decode(body, charset).strip()
        if truncated:
            text += "\n\n(The page was cut off at 2 MB.)"
        header = f"# {title}\n\n" if title else ""
        content = f"{header}{text}".strip()
        return {"url": final_url, "title": title, "content": content, "raw_content": content, "metadata": metadata}

    async def _get(self, client: Any, url: str) -> Tuple[str, int, str, Optional[str], bytes, bool]:
        """GET with every hop checked: the website policy and the SSRF policy, redirects included."""
        from tools.url_safety import async_is_safe_url
        from tools.website_policy import check_website_access

        current = url
        for _hop in range(MAX_REDIRECTS + 1):
            blocked = check_website_access(current)
            if blocked:
                raise _Refused(blocked["message"], current, {
                    "host": blocked["host"], "rule": blocked["rule"], "source": blocked["source"]})
            if not await async_is_safe_url(current):
                raise _Refused("Blocked: URL targets a private or internal network address", current)
            async with client.stream("GET", current) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise _Refused("The site redirected without saying where.", current)
                    current = urljoin(current, location)
                    continue
                chunks: List[bytes] = []
                size = 0
                truncated = False
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_BODY_BYTES:
                        keep = len(chunk) - (size - MAX_BODY_BYTES)
                        chunks.append(chunk[:max(0, keep)])
                        truncated = True
                        break
                    chunks.append(chunk)
                content_type = _content_type(response.headers.get("content-type", ""))
                return current, response.status_code, content_type, response.charset_encoding, b"".join(chunks), truncated
        raise _Refused(f"Too many redirects (more than {MAX_REDIRECTS}).", current)


class _Refused(Exception):
    """A URL the reader will not or cannot read, with the words the model is told."""

    def __init__(self, message: str, url: str = "", policy: Optional[Dict[str, str]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.url = url
        self.policy = policy
