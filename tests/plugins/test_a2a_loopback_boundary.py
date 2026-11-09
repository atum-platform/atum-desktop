import io
from email.message import Message
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from plugins.platforms.a2a.adapter import A2ARequestHandler


@pytest.mark.parametrize('host,origin,content_type', [
    ('localhost:9900', None, 'text/plain'),
    ('localhost:9900', 'http://localhost:8000', 'application/json'),
    ('localhost:9900', 'null', 'application/json'),
    ('rebound.example:9900', None, 'application/json'),
])
def test_local_no_token_rejects_browser_requests_before_auth(host, origin, content_type):
    handler = object.__new__(A2ARequestHandler)
    handler.headers = Message()
    handler.headers['Host'] = host
    handler.headers['Content-Type'] = content_type
    if origin is not None:
        handler.headers['Origin'] = origin
    auth = Mock(return_value=None)
    handler.server = SimpleNamespace(adapter=SimpleNamespace(_security_context=SimpleNamespace(localhost_only=lambda: True, authenticate=auth)))
    handler._client_ip = lambda: '127.0.0.1'
    handler._error = Mock()
    handler.rfile = io.BytesIO(b'{}')
    handler.do_POST()
    auth.assert_not_called()
    assert handler._error.call_args.args[0] in (400, 403, 415)


def test_native_json_loopback_reaches_authentication():
    handler = object.__new__(A2ARequestHandler)
    handler.headers = Message()
    handler.headers['Host'] = '127.0.0.1:9900'
    handler.headers['Content-Type'] = 'application/json; charset=utf-8'
    auth = Mock(return_value=None)
    handler.server = SimpleNamespace(adapter=SimpleNamespace(_security_context=SimpleNamespace(localhost_only=lambda: True, authenticate=auth)))
    handler._client_ip = lambda: '127.0.0.1'
    handler._error = Mock()
    handler.do_POST()
    auth.assert_called_once_with(None, '127.0.0.1')


# --- real loopback server: the browser-delivered path from the 2026-11-06 audit lead -----------
# (a2a/localhost-only-mode-no-host-origin-check). The tests above call do_POST with a stubbed
# security context. These bind the real adapter on 127.0.0.1 and speak HTTP to it, so a regression
# in the live request path (not just the handler's branch order) fails here.

import asyncio
import http.client
import json
import socket

_SEND = {"jsonrpc": "2.0", "id": "1", "method": "message/send",
         "params": {"message": {"role": "ROLE_USER", "parts": [{"text": "from a web page"}], "messageId": "m1"}}}


def _live_no_token_adapter(monkeypatch):
    from gateway.config import PlatformConfig
    from plugins.platforms.a2a.adapter import A2AAdapter

    for name in ("A2A_BEARER_TOKEN", "A2A_PEER_TOKENS", "A2A_TRUSTED_PEERS", "A2A_ALLOW_ALL_USERS", "A2A_HOST"):
        monkeypatch.delenv(name, raising=False)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setenv("A2A_PORT", str(port))
    adapter = A2AAdapter(PlatformConfig(enabled=True, extra={"port": port}))
    delivered = []

    async def handle_message(event):
        delivered.append(event)
        await adapter.send(event.source.chat_id, "ok", metadata={"notify": True})

    adapter.handle_message = handle_message  # type: ignore
    adapter._message_handler = object()
    return adapter, port, delivered


def _raw_post(port, headers, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.putrequest("POST", "/", skip_host="Host" in headers, skip_accept_encoding=True)
        for k, v in headers.items():
            conn.putheader(k, v)
        payload = json.dumps(body or _SEND).encode()
        conn.putheader("Content-Length", str(len(payload)))
        conn.endheaders(payload)
        resp = conn.getresponse()
        resp.read()
        return resp.status
    finally:
        conn.close()


@pytest.mark.parametrize("label,headers,expected", [
    # What a cross-site <form>/fetch(no-cors) sends: simple content type, Origin set, Host is the real loopback.
    ("cross-origin text/plain", {"Content-Type": "text/plain", "Origin": "https://evil.example"}, 403),
    # Same, but the attacker also sends application/json (only possible with a preflight, which the server never answers).
    ("cross-origin json", {"Content-Type": "application/json", "Origin": "https://evil.example"}, 403),
    ("null origin", {"Content-Type": "text/plain", "Origin": "null"}, 403),
    # DNS rebinding: same-origin from the browser's view, so no Origin header; Host is the attacker's name.
    ("rebound host", {"Content-Type": "application/json", "Host": "rebind.evil.example:9900"}, 403),
    ("rebound host text/plain", {"Content-Type": "text/plain", "Host": "rebind.evil.example"}, 403),
    # No Origin, loopback Host, but a CORS-simple content type: refused before any parse.
    ("simple content type", {"Content-Type": "text/plain"}, 415),
    ("no content type", {}, 415),
])
def test_live_server_refuses_browser_delivered_posts(monkeypatch, label, headers, expected):
    adapter, port, delivered = _live_no_token_adapter(monkeypatch)

    async def run():
        assert await adapter.connect() is True
        try:
            return await asyncio.to_thread(_raw_post, port, headers)
        finally:
            await adapter.disconnect()

    assert asyncio.run(run()) == expected, label
    assert delivered == [], f"{label}: a refused request must not reach the message handler"


def test_live_server_still_accepts_native_loopback_json(monkeypatch):
    adapter, port, delivered = _live_no_token_adapter(monkeypatch)

    async def run():
        assert await adapter.connect() is True
        try:
            status = await asyncio.to_thread(
                _raw_post, port, {"Host": f"127.0.0.1:{port}", "Content-Type": "application/json"})
            return status
        finally:
            await adapter.disconnect()

    assert asyncio.run(run()) == 200
    assert len(delivered) == 1
