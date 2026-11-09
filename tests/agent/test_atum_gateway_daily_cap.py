"""The Matrix desktop's gateway endpoint ends a turn plainly at the agent's daily cap.

Hermes resolves the desktop's ``atum-gateway`` custom endpoint to the generic
``custom`` provider, so the gate is the endpoint plus a structured 403 body, not a
provider name. These tests build the agent the way the desktop's backend does (the
app's own setup call, the real runtime resolver, the real OpenAI client) against a
real loopback HTTP stub standing in for the bridge/gateway.
"""
import json
import itertools
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import pytest

from agent.conversation_loop import ATUM_DAILY_CAP_LINE
from agent.error_classifier import (
    FailoverReason,
    classify_api_error,
    is_atum_gateway_daily_cap_refusal,
    is_atum_gateway_endpoint,
)
from run_agent import AIAgent

# What LiteLLM's proxy returns for the gateway's HTTPException(403, detail): the
# refusal text in ``message`` and the HTTP status (not a Hermes code) in ``code``.
GATEWAY_CAP_BODY = {
    "error": {"message": "atum_daily_cap_exhausted", "type": "None", "param": "None", "code": "403"}
}


class _Stub:
    """A loopback server answering every completion with one fixed status and body."""

    def __init__(self, status=403, body=None):
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length") or 0)
                stub.requests.append(json.loads(self.rfile.read(length) or b"{}"))
                payload = json.dumps(body if body is not None else GATEWAY_CAP_BODY).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def stub():
    servers = []

    def make(**kwargs):
        servers.append(_Stub(**kwargs))
        return servers[-1]

    yield make
    for server in servers:
        server.close()


def _configure_like_the_desktop(base_url):
    """The desktop's setup call (hermes-setup.ts configureEndpoint), through Hermes's own code."""
    from hermes_cli.config import load_config, save_config
    from hermes_cli.web_models import CustomEndpointUpdate
    from hermes_cli.web_routers.config_env import _write_custom_endpoint

    cfg = load_config()
    body = CustomEndpointUpdate(
        id="atum-gateway",
        name="Atum",
        base_url=base_url,
        model="nguyet-thuc",
        api_key="local-bridge-key",
        replace_api_key=True,
        make_default=True,
        discover_models=False,
    )
    _write_custom_endpoint(cfg, body)
    # configureMatrixManagedModel also declares the context length, so Hermes never probes
    # the bridge for it (MATRIX_MANAGED_CONTEXT_LENGTH).
    cfg["model"]["context_length"] = 75_000
    save_config(cfg)


def _agent_like_the_tui_gateway():
    """AIAgent built from the real runtime resolution, as tui_gateway/server.py does."""
    from hermes_cli.runtime_provider import resolve_runtime_provider

    runtime = resolve_runtime_provider()
    with (
        patch("model_tools.get_tool_definitions", return_value=[]),
        patch("model_tools.check_toolset_requirements", return_value={}),
    ):
        agent = AIAgent(
            model="nguyet-thuc",
            provider=runtime.get("provider"),
            base_url=runtime.get("base_url"),
            api_key=runtime.get("api_key"),
            api_mode=runtime.get("api_mode"),
            credential_pool=runtime.get("credential_pool"),
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
    agent._cached_system_prompt = "You are helpful."
    agent._use_prompt_caching = False
    agent.tool_delay = 0
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


def _run(agent, text, history=None):
    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_try_activate_fallback") as fallback,
        patch.object(agent, "_try_recover_primary_transport") as recovery,
    ):
        result = agent.run_conversation(text, conversation_history=history)
    return result, fallback, recovery


def test_the_endpoint_resolves_to_the_generic_custom_provider(stub):
    """The premise: neither identity Hermes keeps names the endpoint, only the base URL does."""
    gateway = stub()
    _configure_like_the_desktop(gateway.base_url)
    agent = _agent_like_the_tui_gateway()

    assert "atum-gateway" not in {agent.provider, agent.requested_provider}
    assert agent.provider != "atum-managed"
    assert is_atum_gateway_endpoint(agent.base_url)


def test_gateway_cap_ends_the_turn_plainly_with_one_call_and_no_fallback(stub):
    gateway = stub()
    _configure_like_the_desktop(gateway.base_url)
    agent = _agent_like_the_tui_gateway()

    result, fallback, recovery = _run(agent, "Do this task")

    assert len(gateway.requests) == 1
    assert result["completed"] is True
    assert result["failed"] is False
    assert result["daily_cap"] is True
    assert "error" not in result
    assert result["final_response"] == ATUM_DAILY_CAP_LINE
    assert not re.search(r"\d", result["final_response"])
    fallback.assert_not_called()
    recovery.assert_not_called()
    # The user's message is untouched and the turn closes as the assistant: no synthetic
    # user message, so the next turn's history alternates.
    assert [m["role"] for m in result["messages"] if m["role"] != "system"] == ["user", "assistant"]
    assert gateway.requests[0]["messages"][-1] == {"role": "user", "content": "Do this task"}


def test_gateway_cap_refuses_every_later_turn_the_same_way_with_one_call_each(stub):
    gateway = stub()
    _configure_like_the_desktop(gateway.base_url)
    agent = _agent_like_the_tui_gateway()

    first, *_ = _run(agent, "First task")
    second, fallback, _recovery = _run(agent, "Second task", history=first["messages"])

    assert len(gateway.requests) == 2
    assert first["final_response"] == second["final_response"] == ATUM_DAILY_CAP_LINE
    assert second["completed"] is True and second["failed"] is False
    fallback.assert_not_called()
    # Roles still alternate across both turns, and the first turn's prefix is byte-identical.
    roles = [m["role"] for m in second["messages"] if m["role"] != "system"]
    assert all(a != b for a, b in itertools.pairwise(roles))
    assert gateway.requests[1]["messages"][: len(gateway.requests[0]["messages"])] == gateway.requests[0]["messages"]


def test_a_foreign_endpoint_with_the_same_body_is_not_a_daily_cap(stub):
    atum = stub()
    foreign = stub()
    _configure_like_the_desktop(atum.base_url)
    agent = _agent_like_the_tui_gateway()
    # The same generic provider pointed somewhere else (a user's own loopback server).
    agent.base_url = foreign.base_url

    error = Exception("403")
    error.status_code = 403
    error.body = GATEWAY_CAP_BODY["error"]

    assert not is_atum_gateway_daily_cap_refusal(error, foreign.base_url)
    assert is_atum_gateway_daily_cap_refusal(error, atum.base_url)
    classified = classify_api_error(error, provider="custom", base_url=foreign.base_url)
    assert classified.reason != FailoverReason.billing or classified.retryable is not False


@pytest.mark.parametrize("base_url", [
    "https://api.openai.com/v1",
    "https://gateway.atumplatform.com/v1",
    "http://192.168.1.10:8080/v1",
    "http://127.0.0.1:1/v1",
    "",
])
def test_no_external_or_undeclared_endpoint_is_atum_gateway(stub, base_url):
    _configure_like_the_desktop(stub().base_url)
    error = Exception("403")
    error.status_code = 403
    error.body = GATEWAY_CAP_BODY["error"]

    assert not is_atum_gateway_endpoint(base_url)
    assert not is_atum_gateway_daily_cap_refusal(error, base_url)


def test_without_an_atum_gateway_endpoint_in_the_profile_nothing_matches():
    error = Exception("403")
    error.status_code = 403
    error.body = GATEWAY_CAP_BODY["error"]

    assert not is_atum_gateway_endpoint("http://127.0.0.1:47890/v1")
    assert not is_atum_gateway_daily_cap_refusal(error, "http://127.0.0.1:47890/v1")


def test_only_the_structured_closed_code_on_a_403_counts(stub):
    gateway = stub()
    _configure_like_the_desktop(gateway.base_url)
    url = gateway.base_url

    def error(status, body, message="403"):
        exc = Exception(message)
        exc.status_code = status
        if body is not None:
            exc.body = body
        return exc

    cap = GATEWAY_CAP_BODY["error"]
    assert is_atum_gateway_daily_cap_refusal(error(403, cap), url)
    # The wire shape, a code field, a detail string and a prefixed message all carry it.
    assert is_atum_gateway_daily_cap_refusal(error(403, {"error": cap}), url)
    assert is_atum_gateway_daily_cap_refusal(error(403, {"code": "atum_daily_cap_exhausted"}), url)
    assert is_atum_gateway_daily_cap_refusal(error(403, {"detail": "atum_daily_cap_exhausted"}), url)
    assert is_atum_gateway_daily_cap_refusal(
        error(403, {"message": "Rejected: atum_daily_cap_exhausted"}), url
    )
    # Not the status, not the code, not a longer token, and never free message text.
    assert not is_atum_gateway_daily_cap_refusal(error(402, cap), url)
    assert not is_atum_gateway_daily_cap_refusal(error(500, cap), url)
    assert not is_atum_gateway_daily_cap_refusal(error(403, {"message": "insufficient_protons", "code": "403"}), url)
    assert not is_atum_gateway_daily_cap_refusal(error(403, {"message": "x_atum_daily_cap_exhausted_y"}), url)
    assert not is_atum_gateway_daily_cap_refusal(error(403, None, "atum_daily_cap_exhausted"), url)
    assert not is_atum_gateway_daily_cap_refusal(error(403, {"message": "denied"}, "atum_daily_cap_exhausted"), url)
    # The legacy bare Mac code is not the gateway's.
    assert not is_atum_gateway_daily_cap_refusal(error(403, {"code": "daily_cap_exhausted"}), url)


def test_classifier_makes_the_gateway_cap_final(stub):
    gateway = stub()
    _configure_like_the_desktop(gateway.base_url)
    error = Exception("403")
    error.status_code = 403
    error.body = GATEWAY_CAP_BODY["error"]

    classified = classify_api_error(error, provider="custom", base_url=gateway.base_url)

    assert classified.reason == FailoverReason.billing
    assert classified.retryable is False
    assert classified.should_fallback is False
    assert classified.should_rotate_credential is False


def test_a_balance_refusal_on_the_gateway_classifies_exactly_as_before(stub):
    gateway = stub()
    _configure_like_the_desktop(gateway.base_url)
    error = Exception("402")
    error.status_code = 402
    error.body = {"message": "insufficient_protons", "type": "None", "param": "None", "code": "402"}

    with_endpoint = classify_api_error(error, provider="custom", base_url=gateway.base_url)
    without = classify_api_error(error, provider="custom")

    assert not is_atum_gateway_daily_cap_refusal(error, gateway.base_url)
    assert with_endpoint == without
