"""Direct page reader plugin — bundled, auto-loaded.

Keyless ``web_extract`` backend: the page is fetched from the machine Hermes runs on and cleaned
to Markdown-like text, so reading a page works with no account and no third-party reader.
"""

from __future__ import annotations

from plugins.web.direct.provider import DirectWebExtractProvider


def register(ctx) -> None:
    """Register the direct page reader with the plugin context."""
    ctx.register_web_search_provider(DirectWebExtractProvider())
