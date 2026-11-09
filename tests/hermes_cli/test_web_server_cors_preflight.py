"""Tests for CORS preflight ordering on the dashboard web server.

Regression: ``CORSMiddleware`` was registered *before* the
``@app.middleware("http")`` auth decorators, making it the innermost
layer in Starlette's onion model.  A cross-origin ``OPTIONS`` preflight
hit the auth middleware first → 401, and the CORS headers were never
sent.  Moving the ``add_middleware(CORSMiddleware, …)`` call *after*
all ``@app.middleware("http")`` registrations makes CORS outermost so
preflights are answered before auth runs.

See: https://github.com/NousResearch/hermes-agent/issues/59052
"""

from __future__ import annotations

import pytest

from hermes_cli import web_server

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(web_server.app.state, "bound_host", "127.0.0.1", raising=False)
    monkeypatch.setattr(web_server.app.state, "bound_port", 8092, raising=False)
    return TestClient(web_server.app, base_url="http://127.0.0.1:8092")


# ---- CORS preflight (OPTIONS) must not be blocked by auth ------------


def test_options_preflight_returns_cors_headers(client):
    """OPTIONS with Origin + Access-Control-Request-Method → 200 + CORS."""
    resp = client.options(
        "/api/skills",
        headers={
            "Origin": "http://127.0.0.1:8092",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-hermes-session-token",
        },
    )
    assert resp.status_code == 200
    assert "access-control-allow-origin" in resp.headers
    assert resp.headers["access-control-allow-origin"] == "http://127.0.0.1:8092"
    assert "access-control-allow-methods" in resp.headers


def test_options_preflight_allows_localhost_origin(client):
    """Preflight from a different localhost port is rejected."""
    resp = client.options(
        "/api/status",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert resp.status_code == 400
    assert "access-control-allow-origin" not in resp.headers


def test_options_preflight_rejects_disallowed_origin(client):
    """Preflight from a non-localhost origin is rejected (no CORS headers)."""
    resp = client.options(
        "/api/skills",
        headers={
            "Origin": "http://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    # Starlette CORSMiddleware returns 400 for disallowed origins on preflight
    assert resp.status_code == 400
    assert "access-control-allow-origin" not in resp.headers


# ---- gated (OAuth/cookie) mode: the plugin gate must not 401 preflights either


def test_options_preflight_bypasses_gated_auth(client, monkeypatch):
    """With auth_required on, the cookie gate still lets CORS answer preflights."""
    monkeypatch.setattr(web_server.app.state, "auth_required", True, raising=False)
    resp = client.options(
        "/api/skills",
        headers={
            "Origin": "http://127.0.0.1:8092",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:8092"


# ---- auth still enforced on real requests ---------------------------


def test_get_without_origin_has_no_cors_headers(client):
    """A same-origin GET (no Origin header) has no CORS headers."""
    resp = client.get(
        "/api/status",
        headers={web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN},
    )
    assert resp.status_code == 200
    assert "access-control-allow-origin" not in resp.headers


def test_get_with_matching_origin_has_cors_headers(client):
    """A cross-origin GET from an allowed origin has CORS headers."""
    resp = client.get(
        "/api/status",
        headers={
            "Origin": "http://127.0.0.1:8092",
            web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN,
        },
    )
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:8092"


def test_get_without_token_still_401s(client):
    """The token gate is untouched: a real unauthenticated GET still 401s."""
    resp = client.get("/api/skills", headers={"Origin": "http://127.0.0.1:8092"})
    assert resp.status_code == 401


def test_websocket_origin_port_must_match():
    from types import SimpleNamespace
    from hermes_cli.web_server_boundary import ws_host_origin_reason
    state = SimpleNamespace(bound_host="127.0.0.1", bound_port=8092)
    ws = SimpleNamespace(headers={"host": "127.0.0.1:8092", "origin": "http://127.0.0.1:8000"})
    assert ws_host_origin_reason(ws, state).startswith("origin_mismatch")
    ws.headers["origin"] = "http://127.0.0.1:8092"
    assert ws_host_origin_reason(ws, state) is None
    ws.headers["host"] = "127.0.0.1:8000"
    assert ws_host_origin_reason(ws, state).startswith("origin_mismatch")


def test_websocket_public_https_default_port():
    from types import SimpleNamespace
    from hermes_cli.web_server_boundary import ws_host_origin_reason
    state = SimpleNamespace(bound_host="127.0.0.1", bound_port=8092,
                            trusted_public_hosts=frozenset({"dashboard.example.test"}))
    ws = SimpleNamespace(headers={"host": "dashboard.example.test", "origin": "https://dashboard.example.test"})
    assert ws_host_origin_reason(ws, state) is None
    ws.headers["origin"] = "https://dashboard.example.test:8000"
    assert ws_host_origin_reason(ws, state).startswith("origin_mismatch")


@pytest.mark.parametrize("authority", ["127.0.0.1:55555", "localhost:18092", "localhost", "localhost:5173"])
def test_forwarded_and_dev_proxy_hosts(client, monkeypatch, authority):
    from types import SimpleNamespace
    from hermes_cli import web_server
    from hermes_cli.web_server_boundary import ws_host_origin_reason
    monkeypatch.setattr(web_server.app.state, "bound_port", 8092, raising=False)
    response = client.get("/api/status", headers={
        "Host": authority, web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN})
    assert response.status_code == 200
    state = SimpleNamespace(bound_host="127.0.0.1", bound_port=8092)
    ws = SimpleNamespace(headers={"host": authority, "origin": "http://" + authority})
    assert ws_host_origin_reason(ws, state) is None
    ws.headers["origin"] = "http://localhost:8000"
    assert ws_host_origin_reason(ws, state).startswith("origin_mismatch")


def test_desktop_dev_origin_is_explicit_and_desktop_only(monkeypatch):
    from types import SimpleNamespace
    from hermes_cli.web_server_boundary import ws_host_origin_reason
    state = SimpleNamespace(bound_host="127.0.0.1", bound_port=8092)
    ws = SimpleNamespace(headers={"host": "127.0.0.1:8092", "origin": "http://localhost:5174"})
    monkeypatch.setenv("HERMES_DESKTOP_DEV_SERVER", "http://localhost:5174")
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    assert ws_host_origin_reason(ws, state).startswith("origin_mismatch")
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    assert ws_host_origin_reason(ws, state) is None
    ws.headers["origin"] = "http://localhost:8000"
    assert ws_host_origin_reason(ws, state).startswith("origin_mismatch")
    monkeypatch.delenv("HERMES_DESKTOP_DEV_SERVER")
    ws.headers["origin"] = "http://localhost:5174"
    assert ws_host_origin_reason(ws, state).startswith("origin_mismatch")
    ws.headers["origin"] = "file://"
    assert ws_host_origin_reason(ws, state) is None


@pytest.mark.parametrize("gated", [False, True])
def test_public_origin_exception_requires_auth_gate(monkeypatch, gated):
    from types import SimpleNamespace
    from hermes_cli.web_server_boundary import ws_host_origin_reason

    monkeypatch.setenv("HERMES_DASHBOARD_PUBLIC_URL", "https://dashboard.example.test/hermes")
    state = SimpleNamespace(bound_host="127.0.0.1", auth_required=gated,
                            trusted_public_hosts=frozenset({"dashboard.example.test"}))
    ws = SimpleNamespace(headers={"host": "127.0.0.1:8092",
                                  "origin": "https://dashboard.example.test"})
    reason = ws_host_origin_reason(ws, state)
    if gated:
        assert reason is None
    else:
        assert reason.startswith("origin_mismatch")
    # Declaring a public URL never relaxes DNS-rebinding Host validation.
    ws.headers["host"] = "hostile.example.test:8092"
    assert ws_host_origin_reason(ws, state).startswith("host_mismatch")
