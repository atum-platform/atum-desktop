"""Edge TTS reaches Microsoft through the cloud sandbox's egress proxy, or not at all.

The sandbox has no direct route to the internet; its only way out is the controller's HTTP
CONNECT proxy (packages/cloud-controller/src/egress/egress-proxy.ts). Edge TTS opens a
*websocket* (``wss://speech.platform.bing.com``) with ``aiohttp.ClientSession(trust_env=True)``
and no explicit proxy, and aiohttp looks an environment proxy up by the URL's scheme: ``wss``
takes ``WSS_PROXY`` and does not fall back to ``HTTPS_PROXY``. The controller therefore names
the proxy under ``WSS_PROXY`` / ``WS_PROXY`` too (task-executor.ts ``environment()``, pinned by
packages/cloud-controller/test/task-executor.test.ts), and the sandbox lists those names as
approved companions (packages/cloud-sandbox/entrypoint/sandbox_env.py).

This is the Hermes half of that chain: given the environment the sandbox gives Hermes, aiohttp
sends the websocket through the proxy and still reaches the model broker directly. No network.
"""
from __future__ import annotations

import pytest
from yarl import URL

from aiohttp import helpers

PROXY = "http://10.231.0.1:3128"
BROKER_HOST = "10.231.0.1"
# Edge TTS's endpoint (edge_tts.constants.WSS_URL), with a connection id and token as it sends.
EDGE_WSS = URL("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?ConnectionId=abc")
BROKER = URL(f"http://{BROKER_HOST}:8080/v1/chat/completions")


def _sandbox_environment(monkeypatch: pytest.MonkeyPatch, **extra: str) -> None:
    """The proxy-related part of a task's environment, as task-executor.ts builds it."""
    import os

    for name in list(os.environ):
        if name.lower().endswith("_proxy"):
            monkeypatch.delenv(name)
    base = {
        "HTTPS_PROXY": PROXY,
        "HTTP_PROXY": PROXY,
        "NO_PROXY": BROKER_HOST,
    }
    for name, value in {**base, **extra}.items():
        monkeypatch.setenv(name, value)


def _proxy_for(url: URL) -> str | None:
    try:
        proxy, _auth = helpers.get_env_proxy_for_url(url)
    except LookupError:
        return None
    return str(proxy)


def test_a_websocket_url_has_no_proxy_from_https_proxy_alone(monkeypatch):
    # What the sandbox environment was before WSS_PROXY: Edge TTS would go direct and fail.
    _sandbox_environment(monkeypatch)
    assert _proxy_for(EDGE_WSS) is None


def test_the_websocket_goes_through_the_egress_proxy_and_the_model_broker_stays_direct(monkeypatch):
    _sandbox_environment(
        monkeypatch,
        WSS_PROXY=PROXY,
        WS_PROXY=PROXY,
        https_proxy=PROXY,
        http_proxy=PROXY,
        no_proxy=BROKER_HOST,
    )
    assert _proxy_for(EDGE_WSS) == PROXY
    assert _proxy_for(URL("https://example.com/")) == PROXY
    assert _proxy_for(BROKER) is None


def test_edge_tts_opens_a_websocket_on_that_host():
    # The premise above: if the library moved to a plain https endpoint the proxy names would
    # no longer be the point, and this test says so.
    constants = pytest.importorskip("edge_tts.constants")
    url = URL(constants.WSS_URL)
    assert (url.scheme, url.host) == ("wss", "speech.platform.bing.com")
