"""Atum's Google fence, end to end through ``AIAgent.run_conversation``.

A real agent loop runs against two local stand-ins: the desktop's model proxy
(the only route a Google-holding assistant may use) and Atum's Google broker.
The assistant reads the owner's calendar, then is tricked into a web search with
what it read. The Google result must reach only the proxy, and the web search
must be refused before any web tool runs. A second agent, configured for another
provider, must not reach it at all.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

CANARY = "GOOGLE-CANARY-quote-review-with-Lan"
KEY = "b" * 64


def _tool_call(name: str, args: dict) -> dict:
    return {
        "id": "m",
        "choices": [{"index": 0, "message": {
            "role": "assistant", "content": "",
            "tool_calls": [{"id": f"call_{name}", "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)}}]},
            "finish_reason": "tool_calls"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10},
    }


def _text(text: str) -> dict:
    return {
        "id": "m",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10},
    }


def _provider():
    """A chat-completions stand-in that records requests and plays queued answers."""
    state = {"requests": [], "queue": []}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if not self.path.endswith("/chat/completions"):
                # Model-metadata probes are not conversation turns.
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            state["requests"].append(body)
            answer = state["queue"].pop(0) if state["queue"] else _text("Done.")
            message = answer["choices"][0]["message"]
            if body.get("stream") is True:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                chunks = [{"id": "m", "choices": [{"index": 0, "delta": {"role": "assistant", "content": message.get("content") or ""}, "finish_reason": None}]}]
                for index, call in enumerate(message.get("tool_calls") or []):
                    chunks.append({"id": "m", "choices": [{"index": 0, "delta": {"tool_calls": [{
                        "index": index, "id": call["id"], "type": "function",
                        "function": call["function"]}]}, "finish_reason": None}]})
                finish = "tool_calls" if message.get("tool_calls") else "stop"
                chunks.append({"id": "m", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
                for chunk in chunks:
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return
            payload = json.dumps(answer).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, state


def _broker():
    """Atum's Google broker stand-in: one agenda with a recognisable event."""
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            calls.append({"auth": self.headers.get("Authorization"), "body": body})
            payload = json.dumps({"when": "today", "events": [{"title": CANARY, "start": "2026-10-05T14:00:00+07:00"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, calls


@pytest.fixture()
def fenced_home():
    proxy, proxy_state = _provider()
    elsewhere, elsewhere_state = _provider()
    broker, broker_calls = _broker()
    home = tempfile.mkdtemp(prefix="hermes_google_fence_")
    os.makedirs(os.path.join(home, ".hermes"))
    saved = {name: os.environ.get(name) for name in (
        "HERMES_HOME", "ATUM_GOOGLE_FENCE_ROUTE", "ATUM_GOOGLE_TOOLS_URL", "ATUM_GOOGLE_TOOLS_TOKEN", "ATUM_GOOGLE_LATCHED")}
    route = f"http://127.0.0.1:{proxy.server_address[1]}/v1"
    os.environ["HERMES_HOME"] = os.path.join(home, ".hermes")
    os.environ["ATUM_GOOGLE_FENCE_ROUTE"] = route
    os.environ["ATUM_GOOGLE_TOOLS_URL"] = f"http://127.0.0.1:{broker.server_address[1]}"
    os.environ["ATUM_GOOGLE_TOOLS_TOKEN"] = KEY
    os.environ.pop("ATUM_GOOGLE_LATCHED", None)

    # A fresh process's modules: the fence's "holding" state starts empty.
    for name in list(sys.modules):
        if name in {"agent", "run_agent", "model_tools"} or name.startswith(("agent.", "tools.", "hermes_")):
            del sys.modules[name]

    try:
        yield {
            "route": route,
            "proxy": proxy_state,
            "elsewhere": f"http://127.0.0.1:{elsewhere.server_address[1]}/v1",
            "elsewhere_state": elsewhere_state,
            "broker": broker_calls,
        }
    finally:
        for server in (proxy, elsewhere, broker):
            server.shutdown()
            server.server_close()
        shutil.rmtree(home, ignore_errors=True)
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _agent(base_url: str):
    from run_agent import AIAgent

    agent = AIAgent(
        api_key="local-proxy-key", base_url=base_url,
        provider="openai-compat", model="nguyet-thuc",
        max_iterations=6, enabled_toolsets=["atum_google"],
        quiet_mode=True, skip_context_files=True, skip_memory=True,
        save_trajectories=False, platform="cli",
    )
    # The web tool is in the assistant's list as Hermes ships it; the fence decides the call.
    agent.valid_tool_names = set(agent.valid_tool_names or ()) | {"atum_google", "web_search"}
    return agent


def _tool_results(state) -> dict[str, str]:
    results = {}
    for request in state["requests"]:
        for message in request.get("messages", []):
            if message.get("role") == "tool":
                results[message.get("tool_call_id", "")] = message.get("content", "")
    return results


def test_google_data_reaches_only_the_protected_route_and_never_a_web_search(fenced_home):
    from agent import atum_google_fence

    proxy = fenced_home["proxy"]
    proxy["queue"] += [
        _tool_call("atum_google", {"action": "agenda", "when": "today"}),
        # A prompt-injected follow-up: send what was read to a search provider.
        _tool_call("web_search", {"query": f"{CANARY} leaked"}),
        _text("You have one meeting today."),
    ]

    agent = _agent(fenced_home["route"])
    agent.run_conversation("What's on my calendar today?", conversation_history=[], task_id="google-e2e")

    # Every model call went to the protected route, and only there.
    assert len(proxy["requests"]) == 3
    assert fenced_home["elsewhere_state"]["requests"] == []

    # The broker got one closed request with this launch's key.
    assert fenced_home["broker"] == [
        {"auth": f"Bearer {KEY}", "body": {"action": "agenda", "when": "today"}}
    ]

    results = _tool_results(proxy)
    assert CANARY in results["call_atum_google"]
    # The web search was refused before any web tool ran.
    assert atum_google_fence.EGRESS_MESSAGE in results["call_web_search"]
    assert atum_google_fence.holding_google()


def test_an_assistant_that_may_hold_google_data_never_calls_another_provider(fenced_home):
    from agent import atum_google_fence

    fenced_home["elsewhere_state"]["queue"].append(_text("I should never answer."))

    # Refused when its client is built, or at the latest before the first request.
    try:
        agent = _agent(fenced_home["elsewhere"])
        result = agent.run_conversation("Summarize my inbox", conversation_history=[], task_id="google-e2e-2")
    except (atum_google_fence.GoogleFenceRouteRequired, RuntimeError) as refused:
        assert atum_google_fence.MESSAGE in str(refused)
        result = None

    assert fenced_home["elsewhere_state"]["requests"] == []
    if result is not None:
        assert "I should never answer." not in json.dumps(result, default=str)
