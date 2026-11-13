"""Exercise continuation through the real Hermes loop and ordinary file tools."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
import uuid

import pytest

from agent.request_checkpoint import CheckpointUnavailable, RequestCheckpoint
from hermes_state import SessionDB


class ProcessDied(BaseException):
    pass


def _agent(home, db, endpoint="http://127.0.0.1:45678/v1"):
    from run_agent import AIAgent
    agent = AIAgent(
        api_key="temporary-proxy-capability", base_url=endpoint, provider="atum-managed",
        model="binh-minh", api_mode="chat_completions", max_iterations=4, max_tokens=1024,
        enabled_toolsets=["file"], quiet_mode=True, tool_delay=0,
        skip_context_files=True, skip_memory=True, reasoning_config={"enabled": False},
        session_id="test-conversation", session_db=db, platform="cli",
    )
    agent._disable_streaming = True  # These tests stub the complete-response boundary.
    return agent


def _response(*, tool=False):
    from openai.types.chat import ChatCompletion
    message = {"role": "assistant", "content": "The saved file says ORIGINAL."}
    if tool:
        message = {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call_read", "type": "function", "function": {
                "name": "read_file", "arguments": json.dumps({"path": "note.txt"}),
            },
        }]}
    return ChatCompletion.model_validate({
        "id": "response", "object": "chat.completion", "created": 1, "model": "binh-minh",
        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool else "stop"}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
    })


@pytest.fixture
def managed_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_TOKEN", "temporary-broker-capability")
    monkeypatch.delenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", raising=False)
    monkeypatch.chdir(tmp_path)
    # Checkpoint behavior is below the native Relay wrapper; keep the provider
    # callback direct so this offline test does not require the optional
    # ``nemo_relay`` package.
    monkeypatch.setattr(
        "agent.relay_llm.execute",
        lambda request, callback, **_kwargs: callback(request),
    )
    coordinator = MagicMock()
    coordinator.acquire_conversation.return_value = SimpleNamespace(parent_session_id="")
    coordinator.begin_turn.return_value = SimpleNamespace(relay_enabled=False)
    monkeypatch.setattr("agent.relay_runtime.SESSION_COORDINATOR", coordinator)
    (home / "profile.yaml").write_text("identity_id: " + str(uuid.uuid4()) + "\n")
    # The main response is stubbed below, but auto-title uses its own client.
    # Keep instant titles and disable the unrelated background model request so
    # pytest's title-thread joins cannot wait on the fake managed endpoint.
    (home / "config.yaml").write_text(
        "model:\n  context_length: 75000\n"
        "auxiliary:\n  title_generation:\n    model_upgrade_enabled: false\n",
        encoding="utf-8",
    )
    title_call = MagicMock(side_effect=AssertionError("Checkpoint tests must stay offline"))
    monkeypatch.setattr("agent.title_generator.call_llm", title_call)
    (tmp_path / "note.txt").write_text("ORIGINAL")
    db = SessionDB(db_path=home / "state.db")
    yield home, db
    db.close()
    title_call.assert_not_called()


def test_restores_exact_second_request_without_repeating_tool_or_user(managed_home, monkeypatch):
    home, db = managed_home
    first = _agent(home, db)
    first._atum_submission_identity = "accepted-submission"
    first._request_checkpoint = RequestCheckpoint(db, "accepted-submission", {"account": "one"})
    sent = []

    def dispatch(request):
        sent.append(json.loads(json.dumps(request)))
        if len(sent) == 2:
            raise ProcessDied()
        return _response(tool=True)

    monkeypatch.setattr(first, "_interruptible_api_call", dispatch)
    try:
        with pytest.raises(ProcessDied):
            first.run_conversation("Read note.txt and tell me what it says.", task_id="test-conversation")
        retained = first._request_checkpoint.value["payload"]
        assert retained["loop"]["api_call_count"] == 2
        assert any(m["role"] == "tool" and "ORIGINAL" in str(m["content"])
                   for m in retained["context"]["messages"])
        assert "temporary-proxy-capability" not in json.dumps(retained)
        assert "temporary-broker-capability" not in json.dumps(retained)
        Path("note.txt").write_text("CHANGED AFTER THE CRASH")
        second = _agent(home, db)
        second._atum_submission_identity = "accepted-submission"
        second._request_checkpoint = RequestCheckpoint(db, "accepted-submission", {"account": "one"}, recover=True)
        second._request_resume = second._request_checkpoint.value["payload"]
        recovered_requests = []

        def recover(request):
            recovered_requests.append(json.loads(json.dumps(request)))
            return _response()

        monkeypatch.setattr(second, "_interruptible_api_call", recover)
        monkeypatch.setattr(second, "_execute_tool_calls", lambda *_a: pytest.fail("completed tool replayed"))
        try:
            result = second.run_conversation("must not append this new user row", task_id="test-conversation")
            assert result["completed"] and not result.get("failed")
            assert result["api_calls"] == 2
            assert second.iteration_budget.used == retained["budget"]["used"]
            from agent.turn_checkpoint import semantic_request
            assert semantic_request(recovered_requests[0]) == semantic_request(sent[-1])
            assert recovered_requests[0]["extra_headers"]["x-atum-request-id"] == sent[-1]["extra_headers"]["x-atum-request-id"]
            assert sum(m["role"] == "user" for m in result["messages"]) == 1
            persisted = db.get_messages_as_conversation("test-conversation")
            assert sum(m["role"] == "user" for m in persisted) == 1
            assert "CHANGED AFTER THE CRASH" not in json.dumps(result)
        finally:
            second.close()
    finally:
        first.close()


def test_runtime_change_pauses_before_dispatch(managed_home, monkeypatch):
    home, db = managed_home
    first = _agent(home, db)
    first._atum_submission_identity = "changed-model"
    first._request_checkpoint = RequestCheckpoint(db, "changed-model", {})
    monkeypatch.setattr(first, "_interruptible_api_call", lambda _request: (_ for _ in ()).throw(ProcessDied()))
    try:
        with pytest.raises(ProcessDied):
            first.run_conversation("hello")
        second = _agent(home, db)
        second._atum_submission_identity = "changed-model"
        second._request_checkpoint = RequestCheckpoint(db, "changed-model", {}, recover=True)
        second._request_resume = second._request_checkpoint.value["payload"]
        second.model = "different-model"
        monkeypatch.setattr(second, "_interruptible_api_call", lambda _request: pytest.fail("changed route dispatched"))
        try:
            with pytest.raises(CheckpointUnavailable):
                second.run_conversation("ignored")
        finally:
            second.close()
    finally:
        first.close()


@pytest.mark.parametrize("failure", ["checkpoint", "http413", "changed_request"])
def test_recovery_integrity_or_content_failure_pauses_without_retry_or_budget_refund(managed_home, monkeypatch, failure):
    import httpx
    from openai import APIStatusError
    from tui_gateway.managed_model_failure import project_managed_failure

    home, db = managed_home
    first = _agent(home, db)
    first._atum_submission_identity = "error-test"
    first._request_checkpoint = RequestCheckpoint(db, "error-test", {})
    monkeypatch.setattr(first, "_interruptible_api_call", lambda _r: (_ for _ in ()).throw(ProcessDied()))
    try:
        with pytest.raises(ProcessDied):
            first.run_conversation("hello")
        second = _agent(home, db)
        second._atum_submission_identity = "error-test"
        second._request_checkpoint = RequestCheckpoint(db, "error-test", {}, recover=True)
        second._request_resume = second._request_checkpoint.value["payload"]
        saved = json.loads(json.dumps(second._request_resume))
        calls = []

        def dispatch(request):
            calls.append(request)
            if failure == "http413":
                raise APIStatusError("managed_request_too_large", response=httpx.Response(413, request=httpx.Request("POST", "http://localhost")), body={})
            raise CheckpointUnavailable("task_checkpoint_request_changed")

        monkeypatch.setattr(second, "_interruptible_api_call", dispatch)
        monkeypatch.setattr(second, "_try_activate_fallback", lambda *_a, **_k: pytest.fail("recovery attempted fallback"))
        if failure == "changed_request":
            second._request_resume["request"]["model"] = "changed"
        try:
            with pytest.raises(CheckpointUnavailable) as error:
                second.run_conversation("ignored")
            assert len(calls) == (0 if failure == "changed_request" else 1)
            assert second.iteration_budget.used == saved["budget"]["used"]
            assert project_managed_failure({"agent": second}, text=error.value)["recovery"] == "pause"
        finally:
            second.close()
    finally:
        first.close()


def test_optional_unserializable_checkpoint_does_not_break_fresh_managed_turn(managed_home, monkeypatch):
    from agent import turn_checkpoint

    home, db = managed_home
    agent = _agent(home, db)
    agent._atum_submission_identity = "optional"
    checkpoint = agent._request_checkpoint = RequestCheckpoint(db, "optional", {})
    capture = turn_checkpoint.capture_turn

    def unserializable(agent, state):
        agent.session_estimated_cost_usd = float("nan")
        return capture(agent, state)

    monkeypatch.setattr(turn_checkpoint, "capture_turn", unserializable)
    monkeypatch.setattr(agent, "_interruptible_api_call", lambda _request: _response())
    try:
        result = agent.run_conversation("hello")
        assert result["completed"]
        assert checkpoint.value["phase"] == "paused"
        assert agent._request_checkpoint is None
    finally:
        agent.close()


def test_non_json_runtime_policy_disables_only_optional_recovery(managed_home, monkeypatch):
    from agent.turn_checkpoint import runtime_policy
    from tui_gateway.request_recovery import bind_checkpoint

    home, db = managed_home
    agent = _agent(home, db)
    agent.tools = [{"default": object()}]
    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    try:
        with pytest.raises(CheckpointUnavailable):
            runtime_policy(agent)
        with bind_checkpoint(agent, {"home": str(home), "key": "not-read"}):
            assert not getattr(agent, "_request_checkpoint", None)
    finally:
        agent.close()


def test_stream_callback_is_fenced_before_display_or_voice_effect(managed_home):
    from agent.turn_checkpoint import checkpointed_call

    home, db = managed_home
    agent = _agent(home, db)
    agent._atum_submission_identity = "stream-consumption"
    checkpoint = agent._request_checkpoint = RequestCheckpoint(db, "stream-consumption", {})
    delivered = []

    def display(text):
        assert checkpoint.value["phase"] == "consuming"
        with pytest.raises(CheckpointUnavailable):
            RequestCheckpoint(db, "stream-consumption", {}, recover=True)
        delivered.append(text)

    agent._stream_callback = display

    def perform(_request):
        agent._stream_callback("hello")
        return _response()

    try:
        checkpointed_call(agent, {"model": "binh-minh", "messages": []}, {}, perform)
        assert delivered == ["hello"]
        assert agent._stream_callback is display
    finally:
        agent.close()


def test_transport_failure_after_stream_consumption_cannot_retry_voice_or_text(managed_home, monkeypatch):
    import httpx
    from openai import APIConnectionError

    home, db = managed_home
    agent = _agent(home, db)
    agent._disable_streaming = False
    agent._atum_submission_identity = "partial-stream"
    agent._request_checkpoint = RequestCheckpoint(db, "partial-stream", {})
    calls, delivered = [], []

    def dispatch(request, **_kwargs):
        calls.append(request)
        agent._stream_callback("first words")
        raise APIConnectionError(request=httpx.Request("POST", "http://localhost"))

    monkeypatch.setattr(agent, "_interruptible_streaming_api_call", dispatch)
    try:
        with pytest.raises(CheckpointUnavailable, match="task_checkpoint_not_recoverable"):
            agent.run_conversation("hello", stream_callback=delivered.append)
        assert len(calls) == 1
        assert delivered == ["first words"]
    finally:
        agent.close()


@pytest.mark.parametrize("failure", ["http413", "unicode", "uncertain"])
def test_fresh_request_rewrites_require_confirmed_non_dispatch(managed_home, monkeypatch, failure):
    import httpx
    from openai import APIConnectionError, APIStatusError

    home, db = managed_home
    agent = _agent(home, db)
    agent._atum_submission_identity = "fresh-rewrite"
    checkpoint = agent._request_checkpoint = RequestCheckpoint(db, "fresh-rewrite", {})
    sent = []

    def dispatch(request):
        sent.append(json.loads(json.dumps(request)))
        if len(sent) == 1:
            if failure == "http413":
                raise APIStatusError("managed_request_too_large", response=httpx.Response(413, request=httpx.Request("POST", "http://localhost")),
                                     body={"code": "managed_request_too_large", "type": "atum_managed_model_error"})
            if failure == "unicode":
                raise UnicodeEncodeError("ascii", "café", 3, 4, "ordinal not in range(128)")
            raise APIConnectionError(request=httpx.Request("POST", "http://localhost"))
        return _response()

    monkeypatch.setattr(agent, "_interruptible_api_call", dispatch)
    # Exercise the actual outer compression/retry path, with compression itself
    # returning a deterministic shorter history instead of making an extra call.
    monkeypatch.setattr(agent, "_compress_context", lambda messages, _system, **_kw: (messages[-1:], agent._cached_system_prompt))
    if failure == "uncertain":
        build = agent._build_api_kwargs
        count = 0

        def changing_request(messages):
            nonlocal count
            count += 1
            request = build(messages)
            request["max_tokens"] = 1024 + count
            return request

        monkeypatch.setattr(agent, "_build_api_kwargs", changing_request)
    history = [{"role": "user", "content": "old request " * 1000},
               {"role": "assistant", "content": "old answer " * 1000}]
    try:
        # A checkpointed managed request is fail-closed after any dispatched
        # exception. The loop must not infer that a transport/encoding failure
        # was safe to rewrite and submit under a second request identity.
        with pytest.raises(CheckpointUnavailable, match="task_checkpoint_not_recoverable"):
            agent.run_conversation("café", conversation_history=history)
        assert len(sent) == 1
        assert checkpoint.value["phase"] == "pending"
    finally:
        agent.close()
