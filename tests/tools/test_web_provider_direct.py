"""The keyless page reader (plugins/web/direct) and how ``web_extract`` reaches it.

Behaviour, not snapshots: a page goes in as HTML and comes out as readable text, every hop of a
redirect is checked, and a search-only backend (the Atum default, ddgs) no longer leaves
``web_extract`` with nothing to read a page with.
"""

import asyncio
import json

import httpx
import pytest

from tests.tools.conftest import register_all_web_providers


ARTICLE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Robots learn to dance</title>
<meta name="description" content="A short summary.">
<style>.x{color:red}</style><script>var tracking = 1;</script>
</head><body>
<nav><a href="/home">Home</a><a href="/about">About</a></nav>
<header><h1>Robots learn to dance</h1></header>
<main><article>
<p>The <b>first</b> robot danced on Tuesday.</p>
<p>Read <a href="/more/robots">more about robots</a> and <a href="https://example.org/x">a source</a>.</p>
<ul><li>Fast</li><li>Funny</li></ul>
<pre>def dance():
    return 1</pre>
<table><tr><th>Name</th><th>Score</th></tr><tr><td>Ada</td><td>10</td></tr></table>
</article></main>
<footer>Copyright 2026 Example Inc.</footer>
<script>document.write("hidden")</script>
</body></html>"""


def _page(handler):
    """Make the reader's HTTP client talk to ``handler`` instead of the network."""

    def factory(**kwargs):
        kwargs.pop("trust_env", None)
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)

    return factory


@pytest.fixture
def reader(monkeypatch):
    from plugins.web.direct.provider import DirectWebExtractProvider

    async def allow(_url: str) -> bool:
        return True

    monkeypatch.setattr("tools.url_safety.async_is_safe_url", allow)
    monkeypatch.setattr("tools.website_policy.check_website_access", lambda _url, config_path=None: None)
    monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False, raising=False)
    return DirectWebExtractProvider()


def _extract(reader, handler, monkeypatch, urls=("https://news.example/story",)):
    monkeypatch.setattr("tools.url_safety.create_ssrf_safe_async_client", _page(handler))
    return asyncio.run(reader.extract(list(urls)))


class TestPageToText:
    def test_reads_an_article_without_the_page_chrome(self, reader, monkeypatch):
        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=ARTICLE)

        [page] = _extract(reader, handler, monkeypatch)
        text = page["content"]
        assert page["title"] == "Robots learn to dance"
        assert text.startswith("# Robots learn to dance")
        assert "The first robot danced on Tuesday." in text
        assert "[more about robots](https://news.example/more/robots)" in text
        assert "[a source](https://example.org/x)" in text
        assert "- Fast" in text and "- Funny" in text
        assert "def dance():\n    return 1" in text
        assert "Ada | 10" in text
        # Menus, footers, scripts and styles are not page text.
        for noise in ("About", "Copyright 2026", "tracking", "hidden", "color:red"):
            assert noise not in text
        assert page["raw_content"] == text
        assert page["metadata"]["status"] == 200
        assert page["metadata"]["description"] == "A short summary."

    def test_a_site_that_marks_its_article_up_inside_chrome_is_not_read_as_empty(self, reader, monkeypatch):
        body = "<html><head><title>T</title></head><body><aside>" + "Real story text. " * 30 + "</aside></body></html>"

        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/html"}, text=body)

        [page] = _extract(reader, handler, monkeypatch)
        assert "Real story text." in page["content"]

    def test_a_missing_head_close_does_not_hide_the_body(self, reader, monkeypatch):
        body = "<html><head><title>T</title><body><p>" + "Visible words here. " * 20 + "</p></body></html>"

        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/html"}, text=body)

        [page] = _extract(reader, handler, monkeypatch)
        assert "Visible words here." in page["content"]

    def test_a_page_with_almost_no_text_says_it_may_need_a_browser(self, reader, monkeypatch):
        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/html"},
                                  text="<html><body><div id=app></div><script>render()</script></body></html>")

        [page] = _extract(reader, handler, monkeypatch)
        assert "browser" in page["content"].lower()

    def test_text_and_json_pass_through(self, reader, monkeypatch):
        def handler(request):
            if request.url.path == "/data.json":
                return httpx.Response(200, headers={"content-type": "application/json"}, text='{"ok": true}')
            return httpx.Response(200, headers={"content-type": "text/plain; charset=utf-8"}, text="plain words")

        pages = _extract(reader, handler, monkeypatch, ["https://x.example/data.json", "https://x.example/a.txt"])
        assert pages[0]["content"] == '{"ok": true}'
        assert pages[1]["content"] == "plain words"

    def test_results_keep_the_order_of_the_urls(self, reader, monkeypatch):
        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/plain"}, text=request.url.path)

        urls = [f"https://x.example/{n}" for n in range(6)]
        pages = _extract(reader, handler, monkeypatch, urls)
        assert [page["content"] for page in pages] == [f"/{n}" for n in range(6)]


class TestRefusals:
    def test_http_errors_say_what_happened_and_what_to_try(self, reader, monkeypatch):
        def handler(request):
            return httpx.Response(403, text="no")

        [page] = _extract(reader, handler, monkeypatch)
        assert "HTTP 403" in page["error"] and "browser" in page["error"].lower()
        assert page["content"] == ""

    def test_a_pdf_is_named_not_garbled(self, reader, monkeypatch):
        def handler(request):
            return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.7 ...")

        [page] = _extract(reader, handler, monkeypatch)
        assert "PDF" in page["error"]

    def test_a_binary_file_is_refused(self, reader, monkeypatch):
        def handler(request):
            return httpx.Response(200, headers={"content-type": "image/png"}, content=b"\x89PNG")

        [page] = _extract(reader, handler, monkeypatch)
        assert "Not a text page" in page["error"]

    def test_every_redirect_hop_is_checked_for_a_private_destination(self, reader, monkeypatch):
        seen = []

        async def only_public(url: str) -> bool:
            seen.append(url)
            return "169.254.169.254" not in url

        monkeypatch.setattr("tools.url_safety.async_is_safe_url", only_public)

        def handler(request):
            if request.url.host == "news.example":
                return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"})
            raise AssertionError("the private hop must never be requested")

        [page] = _extract(reader, handler, monkeypatch)
        assert "private or internal" in page["error"]
        assert seen == ["https://news.example/story", "http://169.254.169.254/latest/meta-data"]

    def test_redirects_are_followed_a_bounded_number_of_times(self, reader, monkeypatch):
        def handler(request):
            return httpx.Response(302, headers={"location": request.url.path + "x"})

        [page] = _extract(reader, handler, monkeypatch)
        assert "Too many redirects" in page["error"]

    def test_a_relative_redirect_is_followed(self, reader, monkeypatch):
        def handler(request):
            if request.url.path == "/story":
                return httpx.Response(301, headers={"location": "/moved"})
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="arrived")

        [page] = _extract(reader, handler, monkeypatch)
        assert page["content"] == "arrived"
        assert page["url"] == "https://news.example/moved"

    def test_the_website_policy_is_honoured_before_any_request(self, reader, monkeypatch):
        monkeypatch.setattr(
            "tools.website_policy.check_website_access",
            lambda url, config_path=None: {"host": "news.example", "rule": "news.example", "source": "config",
                                           "message": "Blocked by your website policy"})

        def handler(request):
            raise AssertionError("a blocked site must not be requested")

        [page] = _extract(reader, handler, monkeypatch)
        assert page["error"] == "Blocked by your website policy"
        assert page["blocked_by_policy"]["host"] == "news.example"

    def test_a_huge_page_is_cut_off_not_loaded_whole(self, reader, monkeypatch):
        from plugins.web.direct import provider

        monkeypatch.setattr(provider, "MAX_BODY_BYTES", 1000)

        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"a" * 5000)

        [page] = _extract(reader, handler, monkeypatch)
        assert page["metadata"]["truncated"] is True
        assert page["metadata"]["bytes"] == 1000

    def test_one_failing_url_does_not_lose_the_others(self, reader, monkeypatch):
        def handler(request):
            if request.url.path == "/bad":
                raise httpx.ConnectError("refused")
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="fine")

        pages = _extract(reader, handler, monkeypatch, ["https://x.example/bad", "https://x.example/good"])
        assert pages[0]["error"].startswith("Could not read the page")
        assert pages[1]["content"] == "fine"


class TestProviderContract:
    def test_it_reads_pages_and_does_not_search(self, reader):
        assert reader.name == "direct"
        assert reader.supports_extract() is True
        assert reader.supports_search() is False
        assert reader.is_available() is True
        assert reader.get_setup_schema()["env_vars"] == []


class TestWebExtractUsesItWhenTheBackendOnlySearches:
    @pytest.fixture(autouse=True)
    def _registry(self):
        register_all_web_providers()
        yield
        from agent.web_search_registry import _reset_for_tests

        _reset_for_tests()

    def _setup(self, monkeypatch, *, with_reader: bool):
        from agent.web_search_registry import register_provider
        from plugins.web.direct.provider import DirectWebExtractProvider
        from tools import web_tools

        if with_reader:
            register_provider(DirectWebExtractProvider())
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"backend": "ddgs"})
        monkeypatch.setattr(web_tools, "_ddgs_package_importable", lambda: True)
        monkeypatch.setattr(web_tools, "_is_tool_gateway_ready", lambda: False)

        async def allow(_url: str) -> bool:
            return True

        monkeypatch.setattr(web_tools, "async_is_safe_url", allow)
        monkeypatch.setattr("tools.url_safety.async_is_safe_url", allow)
        monkeypatch.setattr("tools.website_policy.check_website_access", lambda _url, config_path=None: None)
        monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False, raising=False)
        return web_tools

    def test_ddgs_default_still_reads_pages(self, monkeypatch):
        web_tools = self._setup(monkeypatch, with_reader=True)

        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/html"}, text=ARTICLE)

        monkeypatch.setattr("tools.url_safety.create_ssrf_safe_async_client", _page(handler))
        result = json.loads(asyncio.run(web_tools.web_extract_tool(["https://news.example/story"])))
        [page] = result["results"]
        assert page["error"] is None
        assert "The first robot danced on Tuesday." in page["content"]

    def test_without_the_reader_the_search_only_error_stays(self, monkeypatch):
        web_tools = self._setup(monkeypatch, with_reader=False)
        # Plugin discovery inside web_extract_tool would register the bundled reader again.
        monkeypatch.setattr(web_tools, "_KEYLESS_EXTRACT_BACKEND", "absent")
        result = json.loads(asyncio.run(web_tools.web_extract_tool(["https://news.example/story"])))
        assert result["success"] is False
        assert "search-only" in result["error"].lower()

    def test_a_reader_the_person_selected_is_never_replaced_by_it(self, monkeypatch):
        from agent.web_search_provider import WebSearchProvider
        from agent.web_search_registry import register_provider

        web_tools = self._setup(monkeypatch, with_reader=True)
        called = []

        class Chosen(WebSearchProvider):
            name = "chosen"

            def is_available(self):
                return True

            def supports_search(self):
                return False

            def supports_extract(self):
                return True

            def extract(self, urls, **kwargs):
                called.append(urls)
                return [{"url": u, "title": "", "content": "from the chosen reader"} for u in urls]

        register_provider(Chosen())
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"backend": "ddgs", "extract_backend": "chosen"})
        result = json.loads(asyncio.run(web_tools.web_extract_tool(["https://news.example/story"])))
        assert called and result["results"][0]["content"] == "from the chosen reader"


class TestRegistryChoice:
    @pytest.fixture(autouse=True)
    def _registry(self, monkeypatch):
        for name in ("EXA_API_KEY", "PARALLEL_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setattr("agent.web_search_registry._read_config_key", lambda *path: None)
        register_all_web_providers()
        yield
        from agent.web_search_registry import _reset_for_tests

        _reset_for_tests()

    def test_it_is_the_reader_when_nothing_with_a_key_is_set_up(self):
        from agent.web_search_registry import _resolve, register_provider
        from plugins.web.direct.provider import DirectWebExtractProvider

        register_provider(DirectWebExtractProvider())
        assert _resolve(None, capability="extract").name == "direct"
        # It never searches, so it can never become the search provider.
        assert _resolve(None, capability="search") is None or _resolve(None, capability="search").name != "direct"

    def test_a_reader_with_a_key_comes_first(self, monkeypatch):
        from agent.web_search_registry import _resolve, register_provider
        from plugins.web.direct.provider import DirectWebExtractProvider

        register_provider(DirectWebExtractProvider())
        monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
        assert _resolve(None, capability="extract").name == "tavily"
