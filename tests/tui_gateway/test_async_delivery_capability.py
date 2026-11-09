"""Session-scoped async-delivery capability behavior in the TUI gateway."""

import threading
from types import SimpleNamespace

import pytest

from gateway.session_context import async_delivery_supported
from tui_gateway import server


@pytest.fixture(autouse=True)
def isolated_sessions(monkeypatch):
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    yield
    for session in list(server._sessions.values()):
        server._teardown_session(session)
    server._sessions.clear()


def _configure_real_prompt_turn(monkeypatch, tmp_path):
    """Keep the real turn runner deterministic while preserving its control flow."""
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "make_stream_renderer", lambda _cols: None)
    monkeypatch.setattr(server, "render_message", lambda _raw, _cols: None)
    monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda *_args: None)
    monkeypatch.setattr(server, "_session_cwd", lambda _session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(server, "_session_info", lambda *_args: {})
    monkeypatch.setattr(server, "_get_usage", lambda _agent: {})
    monkeypatch.setattr(
        server, "_sync_session_key_after_compress", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(server, "_drain_queued_prompt", lambda *_args: False)
    monkeypatch.setattr(server, "_voice_tts_enabled", lambda: False)
    monkeypatch.setattr(server, "_get_db", lambda: None)


def _turn_session(tmp_path, *, async_delivery: bool, run):
    agent = SimpleNamespace(
        model="test-model",
        provider="test-provider",
        session_id="durable-session",
        clear_interrupt=lambda: None,
        run_conversation=run,
    )
    return {
        "agent": agent,
        "async_delivery": async_delivery,
        "attached_images": [],
        "cols": 80,
        "cwd": str(tmp_path),
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": True,
        "session_key": "durable-session",
    }


class _ImmediateThread:
    """Execute the real runner synchronously, including nested follow-up turns."""

    def __init__(self, target=None, **_kwargs):
        self._target = target

    def start(self):
        if self._target is not None:
            self._target()

    def join(self, timeout=None):
        return None

    def is_alive(self):
        return False


def test_create_false_binds_context_and_suppresses_autonomous_delivery(monkeypatch):
    """A finite client can opt out without relying on source/env special cases."""
    response = server._methods["session.create"](
        "create", {"async_delivery": False, "source": "matrix"}
    )
    result = response["result"]
    session = server._sessions[result["session_id"]]

    assert result["async_delivery"] is False
    assert session["async_delivery"] is False

    tokens = server._set_session_context(session["session_key"])
    try:
        assert async_delivery_supported() is False
    finally:
        server._clear_session_context(tokens)

    monkeypatch.setattr(
        server,
        "_wire_desktop_sinks",
        lambda: (_ for _ in ()).throw(AssertionError("false session started poller")),
    )
    stop = server._start_notification_poller(result["session_id"], session)
    assert isinstance(stop, threading.Event)
    assert not stop.is_set()
    assert not [t for t in threading.enumerate() if t.name == f"tui-notif-poller-{result['session_id']}"]

    import tui_gateway.request_recovery as recovery

    # Recovery and auto-continue never start a turn of their own for an opted-out session.
    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    assert recovery.resume_pending(server, result["session_id"], session) is False
    monkeypatch.setattr(
        server,
        "read_turn_marker",
        lambda *_args: (_ for _ in ()).throw(AssertionError("false session read its turn marker")),
        raising=False,
    )
    assert server._maybe_schedule_auto_continue(result["session_id"], session, session["session_key"]) is None

    default = server._methods["session.create"]("default", {})
    assert default["result"]["async_delivery"] is True


def test_false_capability_survives_lazy_and_deferred_resume_records(monkeypatch):
    """Both non-eager resume record constructors retain the explicit opt-out."""
    target = "stored-session"

    class DB:
        def get_session(self, requested):
            return {"id": requested}

        def get_session_by_title(self, _title):
            return None

        def resolve_resume_session_id(self, requested):
            return requested

        def reopen_session(self, _sid):
            return None

        def get_messages_as_conversation(self, _sid, **_kwargs):
            return [{"role": "user", "content": "hello"}]

        def get_resume_conversations(self, session_id):
            history = self.get_messages_as_conversation(session_id)
            return history, history

        def get_ancestor_display_prefix(self, _sid):
            return []

    monkeypatch.setattr(server, "_get_db", lambda: DB())

    lazy = server._methods["session.resume"](
        "lazy", {"session_id": target, "lazy": True, "async_delivery": False}
    )
    lazy_sid = lazy["result"]["session_id"]
    assert lazy["result"]["async_delivery"] is False
    assert server._sessions[lazy_sid]["async_delivery"] is False

    server._teardown_session(server._sessions.pop(lazy_sid))
    deferred = server._methods["session.resume"](
        "deferred", {"session_id": target, "async_delivery": False}
    )
    deferred_sid = deferred["result"]["session_id"]
    assert deferred["result"]["async_delivery"] is False
    assert server._sessions[deferred_sid]["async_delivery"] is False


def test_resume_live_preserves_omitted_false_and_rejects_busy_capability_change(monkeypatch):
    """Per-turn resume cannot silently re-enable a live finite session."""
    created = server._methods["session.create"]("create", {"async_delivery": False})
    sid = created["result"]["session_id"]
    session = server._sessions[sid]
    key = session["session_key"]

    class DB:
        def get_session(self, requested):
            return {"id": requested}

        def get_session_by_title(self, _title):
            return None

        def resolve_resume_session_id(self, requested):
            return requested

    monkeypatch.setattr(server, "_get_db", lambda: DB())

    resumed = server._methods["session.resume"]("resume", {"session_id": key})
    assert resumed["result"]["session_id"] == sid
    assert resumed["result"]["async_delivery"] is False
    assert session["async_delivery"] is False

    session["running"] = True
    rejected = server._methods["session.resume"](
        "busy", {"session_id": key, "async_delivery": True}
    )
    assert rejected["error"]["code"] == 4009
    assert session["async_delivery"] is False


@pytest.mark.parametrize("async_delivery", [False, True])
def test_real_turn_gates_goal_continuation_by_async_capability(
    monkeypatch, tmp_path, async_delivery
):
    """A real completed turn only schedules Ralph continuation when supported."""
    _configure_real_prompt_turn(monkeypatch, tmp_path)
    monkeypatch.setattr(server.threading, "Thread", _ImmediateThread)
    import hermes_cli.goals as goals

    prompts = []
    evaluations = []

    class GoalManager:
        def __init__(self, **_kwargs):
            evaluations.append("created")

        def is_active(self):
            return True

        def evaluate_after_turn(self, *_args, **_kwargs):
            evaluations.append("evaluated")
            # The continuation itself gets a second real turn. It must stop
            # there or this test would deliberately create an infinite loop.
            return {
                "message": "continue",
                "should_continue": len(prompts) == 1,
                "continuation_prompt": "goal follow-up",
            }

    monkeypatch.setattr(goals, "GoalManager", GoalManager)

    def run(prompt, **_kwargs):
        assert async_delivery_supported() is async_delivery
        prompts.append(prompt)
        return {"final_response": "done", "messages": []}

    session = _turn_session(tmp_path, async_delivery=async_delivery, run=run)
    server._sessions["ui"] = session
    server._run_prompt_submit("turn", "ui", session, "user prompt")
    session["_run_thread"].join(timeout=10)
    assert not session["_run_thread"].is_alive()

    if async_delivery:
        assert prompts == ["user prompt", "goal follow-up"]
        assert evaluations == ["created", "evaluated", "created", "evaluated"]
    else:
        assert prompts == ["user prompt"]
        assert evaluations == []


@pytest.mark.parametrize("async_delivery", [False, True])
def test_real_turn_gates_post_turn_completion_drain_by_async_capability(
    monkeypatch, tmp_path, async_delivery
):
    """After a real turn, completions that arrived mid-turn are drained (and may start a turn)
    only for a capable session; an opted-out session's events stay on the queue."""
    import contextlib

    _configure_real_prompt_turn(monkeypatch, tmp_path)
    monkeypatch.setattr(server.threading, "Thread", _ImmediateThread)
    import tools.process_registry_awaiting as awaiting

    prompts = []
    drained = []
    handled = []

    @contextlib.contextmanager
    def drained_for(_registry, _owns):
        drained.append(True)
        yield [{"type": "completion", "session_id": "process-1"}]

    monkeypatch.setattr(awaiting, "drained_for", drained_for)
    monkeypatch.setattr(server, "_notif_handle_ready", lambda _sid, _session, events, *_a, **_k: handled.extend(events))

    def run(prompt, **_kwargs):
        assert async_delivery_supported() is async_delivery
        prompts.append(prompt)
        return {"final_response": "done", "messages": []}

    session = _turn_session(tmp_path, async_delivery=async_delivery, run=run)
    server._sessions["ui"] = session
    server._run_prompt_submit("turn", "ui", session, "user prompt")
    session["_run_thread"].join(timeout=10)
    assert not session["_run_thread"].is_alive()

    assert prompts == ["user prompt"]
    if async_delivery:
        assert drained == [True]
    else:
        assert drained == [] and handled == []


def test_stopped_false_poller_leaves_pending_completion_queued(monkeypatch):
    """Opting out after a poller exists cannot fall through to shutdown drain."""
    import queue

    from tools.process_registry import process_registry

    pending = queue.Queue()
    event = {"type": "completion", "session_id": "pending-process"}
    pending.put(event)
    session = {
        "async_delivery": False,
        "history_lock": threading.Lock(),
        "running": False,
        "session_key": "durable-session",
    }
    monkeypatch.setattr(process_registry, "completion_queue", pending)
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("poller dispatched")),
    )

    server._notification_poller_loop(threading.Event(), "ui", session)
    assert pending.get_nowait() == event
    assert pending.empty()


def test_eager_and_branch_builds_bind_false_async_capability(monkeypatch, tmp_path):
    """Pre-registration constructors bind false before calling `_make_agent`."""
    observed = []

    class DB:
        def get_session(self, requested):
            return {"id": requested}

        def get_session_by_title(self, _title):
            return None

        def resolve_resume_session_id(self, requested):
            return requested

        def reopen_session(self, _sid):
            return None

        def get_resume_conversations(self, _sid):
            return [], []

        def get_ancestor_display_prefix(self, _sid):
            return []

        def get_session_title(self, _sid):
            return "parent"

        def get_next_title_in_lineage(self, title):
            return f"{title} branch"

        def create_session(self, *_args, **_kwargs):
            return None

        def append_message(self, *_args, **_kwargs):
            return None

        def append_messages_batch(self, *_args, **_kwargs):
            return None

        def __getattr__(self, _name):
            # Branch persistence bookkeeping (titles, lineage) is not under test here.
            return lambda *_args, **_kwargs: None

        def set_session_title(self, *_args, **_kwargs):
            return None

    db = DB()
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_session_info", lambda *_args: {})

    def make_agent(*_args, **_kwargs):
        observed.append(async_delivery_supported())
        return SimpleNamespace(model="test", provider="test", session_id="child")

    def init_session(sid, key, agent, history, *, async_delivery=True, **_kwargs):
        server._sessions[sid] = {
            "agent": agent,
            "async_delivery": async_delivery,
            "history": history,
            "history_lock": threading.Lock(),
            "running": False,
            "session_key": key,
        }

    monkeypatch.setattr(server, "_make_agent", make_agent)
    monkeypatch.setattr(server, "_init_session", init_session)

    eager = server._methods["session.resume"](
        "eager", {"session_id": "stored", "eager_build": True, "async_delivery": False}
    )
    assert "result" in eager, eager
    assert eager["result"]["async_delivery"] is False

    parent = _turn_session(tmp_path, async_delivery=False, run=lambda *_a, **_k: {})
    parent["history"] = [{"role": "user", "content": "branch me"}]
    server._sessions["parent-ui"] = parent
    branch = server._methods["session.branch"]("branch", {"session_id": "parent-ui"})
    assert "result" in branch, branch
    assert branch["result"]["async_delivery"] is False
    assert observed == [False, False]


@pytest.mark.parametrize("async_delivery", [False, True])
def test_controller_session_runs_background_work_in_its_turn(async_delivery):
    """A cloud controller session (``async_delivery: false``) hands out no detached work: a
    background delegate_task runs synchronously and terminal's notify_on_complete is dropped
    (upstream's stateless-channel fallbacks), because the controller exports the home and ends
    the process once the turn is answered. A capable session keeps the detached behaviour."""
    from types import SimpleNamespace

    from tools.delegate_tool_dispatch import _resolve_async_wake_sid
    from tools.terminal_tool_background import _apply_async_support

    created = server._methods["session.create"](
        "create", {"source": "matrix", **({} if async_delivery else {"async_delivery": False})})
    session = server._sessions[created["result"]["session_id"]]
    tokens = server._set_session_context(session["session_key"])
    try:
        # None: run the batch inline in this tool round; "": detach and push the result later.
        assert _resolve_async_wake_sid("") == ("" if async_delivery else None)
        proc = SimpleNamespace(id="proc-1", notify_on_complete=True, watcher_platform="", session_key="")
        result = {}
        notify, _watch = _apply_async_support(proc, result, True, None)
        assert notify is async_delivery
        assert ("notify_unsupported" in result) is (not async_delivery)
    finally:
        server._clear_session_context(tokens)


def test_the_wire_contract_admits_and_echoes_the_opt_out():
    """Through the dispatcher (unknown params answer 4000): the controller's and the Matrix runner's
    ``async_delivery: false`` is a declared parameter and the reply confirms it."""
    handle_request = server.handle_request
    created = handle_request({"jsonrpc": "2.0", "id": "c", "method": "session.create",
                              "params": {"source": "matrix", "async_delivery": False}})
    assert "error" not in created, created
    assert created["result"]["async_delivery"] is False
    key = server._sessions[created["result"]["session_id"]]["session_key"]
    resumed = handle_request({"jsonrpc": "2.0", "id": "r", "method": "session.resume",
                              "params": {"session_id": key, "source": "matrix", "async_delivery": False}})
    assert resumed.get("error", {}).get("code") != 4000, resumed
