"""``call_llm(retry_policy="none")``: one request, one bill — over real HTTP to a loopback model.

Atum's metered one-shot callers (the voxel pet hatch, the follow-up sweep, the ChatGPT relay) pass
it; the default path keeps Hermes' bounded same-provider retry.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import agent.auxiliary_client as aux


@pytest.fixture
def model_server():
    hits: list[str] = []
    status = {"code": 503}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length") or 0))
            hits.append(self.path)
            if status["code"] != 200:
                body = json.dumps({"error": {"message": "unavailable", "type": "server_error"}}).encode()
                self.send_response(status["code"])
            else:
                body = json.dumps({"id": "x", "object": "chat.completion", "created": 0, "model": "m",
                                   "choices": [{"index": 0, "finish_reason": "stop",
                                                "message": {"role": "assistant", "content": "ok"}}],
                                   "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
                self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/v1", hits, status
    finally:
        httpd.shutdown()
        thread.join(timeout=5)


def _call(base_url: str, **kwargs):
    return aux.call_llm(task="pet_hatch", provider="custom", model="m", base_url=base_url, api_key="k" * 32,
                        messages=[{"role": "user", "content": "hi"}], timeout=10, **kwargs)


def test_none_is_exactly_one_request_and_raises_as_is(model_server, monkeypatch) -> None:
    base_url, hits, _status = model_server
    monkeypatch.setattr(aux, "_TRANSIENT_RETRY_BACKOFF_BASE", 0.0)

    with pytest.raises(Exception):
        _call(base_url, retry_policy="none")

    assert hits == ["/v1/chat/completions"]


def test_none_returns_the_one_answer(model_server) -> None:
    base_url, hits, status = model_server
    status["code"] = 200

    response = _call(base_url, retry_policy="none")

    assert aux.extract_content_or_reasoning(response) == "ok" and len(hits) == 1


def test_the_default_policy_keeps_the_bounded_same_provider_retry(model_server, monkeypatch) -> None:
    base_url, hits, _status = model_server
    monkeypatch.setattr(aux, "_TRANSIENT_RETRY_BACKOFF_BASE", 0.0)
    monkeypatch.setattr(aux, "_transient_retry_count", lambda: 1)

    with pytest.raises(Exception):
        _call(base_url)

    assert len(hits) >= 2, "the shared recovery chain still retries a transient blip"
