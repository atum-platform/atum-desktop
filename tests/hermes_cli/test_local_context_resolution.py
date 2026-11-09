"""Preserve recovery, isolation and completion behavior across failures."""

from __future__ import annotations

import http.server
import json
import threading

import pytest

import agent.model_metadata as mm


GRANTED = 262144


@pytest.fixture
def router():
    """Stub of the llama-server router with the model UNLOADED:
    /v1/models carries meta=null; /props answers from the preset."""

    class _Router(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/props"):
                body = {"default_generation_settings": {"n_ctx": GRANTED}}
            elif self.path == "/v1/models":
                body = {"data": [{
                    "id": "Qwen-Test-UD-Q4_K_M",
                    "owned_by": "llamacpp",
                    "meta": None,
                    "status": {"value": "unloaded"},
                }]}
            else:  # /v1/models/{id} -> 404, as the real router answers
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), _Router)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


def test_unloaded_llamacpp_model_resolves_granted_window(router, monkeypatch):
    monkeypatch.setattr(mm, "detect_local_server_type", lambda *a, **k: "llamacpp")
    monkeypatch.setattr(mm, "_endpoint_blackholed", lambda *a, **k: False)
    ctx = mm._query_local_context_length_uncached("Qwen-Test-UD-Q4_K_M", router)
    assert ctx == GRANTED, (
        f"resolved {ctx}; an unloaded model must resolve the preset window "
        "from /props, not fall through to name-pattern catch-alls")


def test_props_beats_meta_when_model_loaded(router, monkeypatch):
    """/props is probed first even when /v1/models would answer: n_ctx from
    /props is the same runtime value, and probing it first keeps loaded and
    unloaded models on one code path."""
    monkeypatch.setattr(mm, "detect_local_server_type", lambda *a, **k: "llamacpp")
    monkeypatch.setattr(mm, "_endpoint_blackholed", lambda *a, **k: False)
    ctx = mm._query_local_context_length_uncached("Qwen-Test-UD-Q4_K_M", router)
    assert ctx == GRANTED


def test_non_llamacpp_servers_skip_props(monkeypatch):
    """Ollama/LM Studio/vLLM keep their existing probe order — /props is
    llama.cpp-shaped and must not be consulted for other server types."""
    calls = []

    class _FakeResp:
        status_code = 404

        def json(self):
            return {}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url):
            calls.append(url)
            return _FakeResp()

        def post(self, url, **k):
            calls.append(url)
            return _FakeResp()

    import httpx
    monkeypatch.setattr(httpx, "Client", _FakeClient)
    monkeypatch.setattr(mm, "detect_local_server_type", lambda *a, **k: "vllm")
    monkeypatch.setattr(mm, "_endpoint_blackholed", lambda *a, **k: False)
    mm._query_local_context_length_uncached("m", "http://127.0.0.1:9999/v1")
    assert not any("/props" in u for u in calls)
