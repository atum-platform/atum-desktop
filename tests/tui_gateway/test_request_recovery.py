"""Recovery discovery, dispatch and visible pause behavior at the gateway seam."""
import json
from types import SimpleNamespace
import threading
import uuid

import pytest

from agent.request_checkpoint import CheckpointUnavailable, RequestCheckpoint, checkpoint_key
from tui_gateway.request_recovery import (
    latch_stop, pending_conversations, pending_submission, resume_pending, start_profile_recovery,
)
from tui_gateway.surface_context import capabilities, claim_submission, context_db, finish_submission, submission_status


@pytest.fixture
def pending(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    session = {"session_key": "conversation", "profile_home": str(tmp_path), "history": [],
               "history_lock": threading.RLock(), "agent": object(), "running": False}
    owner = capabilities(tmp_path, session)
    _, _, handle = claim_submission(tmp_path, owner, str(uuid.uuid4()), "original", None, [], None)
    with context_db(tmp_path) as db:
        checkpoint = RequestCheckpoint(db, handle["key"], {})
        checkpoint.pending({"request_id": "original-operation"})
        db.set_meta("desktop.managed.last.v1:" + handle["key"].rsplit(":", 1)[0], handle["key"])
    return tmp_path, session, owner, handle


def test_discovery_is_profile_and_conversation_scoped(pending, tmp_path):
    home, session, owner, handle = pending
    assert pending_submission(home, owner) == handle
    other_conversation = {**owner, "conversation_id": "other"}
    assert pending_submission(home, other_conversation) is None
    other_home = tmp_path / "other-profile"
    other_home.mkdir()
    other_owner = capabilities(home, {**session, "profile_home": str(other_home)})
    assert pending_submission(other_home, other_owner) is None


@pytest.mark.parametrize("isolated", [False, True])
def test_recovery_uses_existing_dispatch_without_resubmitting_a_user_turn(pending, isolated):
    home, session, owner, handle = pending
    dispatched = []
    ready = threading.Event()

    def dispatch(*args, **kwargs):
        dispatched.append((args, kwargs))
        ready.set()
        return {"result": {"status": "streaming"}}

    server = SimpleNamespace(
        _hermes_home=home, logger=SimpleNamespace(warning=lambda *_a: None),
        _start_inflight_turn=lambda *_a: None, _clear_inflight_turn=lambda *_a: None,
        _load_dashboard_process_isolation_config=lambda: {},
        _session_uses_compute_host=lambda *_a: isolated,
        _submit_prompt_to_compute_host=dispatch, _run_prompt_submit=dispatch,
        _start_agent_build=lambda *_a: None,
        _wait_agent=lambda *_a: None,
    )
    assert resume_pending(server, "runtime", session)
    assert ready.wait(2)
    assert len(dispatched) == 1
    args, kwargs = dispatched[0]
    assert args[1:3] == ("runtime", session)
    assert args[3] == ""
    assert kwargs == {"submission_receipt": handle, "resume_request": True}
    assert not resume_pending(server, "runtime", session), "a live turn cannot gain a second worker"
    with context_db(home) as db:
        assert db.get_messages_as_conversation("conversation") == []


def test_uncertain_or_corrupt_work_reaches_the_pause_adapter_without_erasing_evidence(pending):
    home, _session, owner, handle = pending
    with context_db(home) as db:
        raw = db.get_meta(checkpoint_key(handle["key"]))
        value = json.loads(raw)
        value["phase"] = "consuming"
        db.set_meta(checkpoint_key(handle["key"]), json.dumps(value))
        assert pending_submission(home, owner) == handle
        db.set_meta(checkpoint_key(handle["key"]), "broken")
        assert pending_submission(home, owner) == handle
        assert db.get_meta(checkpoint_key(handle["key"])) == "broken"


def test_task_pause_projects_existing_non_replay_desktop_copy():
    from tui_gateway.managed_model_failure import project_managed_failure
    session = {"agent": SimpleNamespace(provider="atum-managed", model="binh-minh")}
    for reason in ("task_checkpoint_context_changed", "task_checkpoint_not_recoverable", "task_checkpoint_invalid"):
        projected = project_managed_failure(session, text=CheckpointUnavailable(reason))
        assert projected["recovery"] == "pause"
        assert not projected["transient"] and not projected["preserve_draft"]


def test_stop_survives_process_restart_and_late_completion(pending):
    home, _session, owner, handle = pending
    latch_stop(home, owner)
    assert pending_submission(home, owner) is None
    finish_submission(handle, "complete")
    assert submission_status(home, owner, handle["key"].rsplit(":", 1)[-1])["status"] == "interrupted"
    with context_db(home) as db:
        with pytest.raises(CheckpointUnavailable):
            RequestCheckpoint(db, handle["key"], {}, recover=True)


def test_stop_reconciles_a_racing_request_receipt_update(pending, monkeypatch):
    from hermes_state import SessionDB

    home, _session, owner, handle = pending
    compare = SessionDB.compare_meta
    raced = False

    def request_wins_once(db, key, expected, value):
        nonlocal raced
        if key == handle["key"] and not raced:
            raced = True
            receipt = json.loads(db.get_meta(key))
            receipt["managed_request"] = {"request_id": "provider-request", "logical_id": "call:1"}
            db.set_meta(key, json.dumps(receipt))
        return compare(db, key, expected, value)

    monkeypatch.setattr(SessionDB, "compare_meta", request_wins_once)
    latch_stop(home, owner)

    assert raced
    assert pending_submission(home, owner) is None
    assert submission_status(home, owner, handle["key"].rsplit(":", 1)[-1])["status"] == "interrupted"


def test_startup_reattaches_pending_work_once_without_opening_each_conversation(pending, monkeypatch):
    from tui_gateway.transport import current_transport

    home, _session, owner, handle = pending
    with context_db(home) as db:
        # Foreign employee indexes and a corrupt sibling receipt cannot prevent
        # this employee's healthy pending task from being discovered.
        prefix = "desktop.managed.last.v1:desktop.submission.v1:"
        db.set_meta(prefix + str(uuid.uuid4()) + ":" + owner["agent_id"] + ":foreign", handle["key"])
        own_prefix = prefix + owner["backend_id"] + ":" + owner["agent_id"] + ":"
        bad_key = "desktop.submission.v1:" + owner["backend_id"] + ":" + owner["agent_id"] + ":broken:bad"
        db.set_meta(own_prefix + "broken", bad_key)
        db.set_meta(bad_key, "broken")
    assert list(pending_conversations(home)) == ["conversation"]
    monkeypatch.setattr("agent.workspace_route_guard.read_route_authority", lambda: {"accountKey": "a" * 64})
    transport = object()
    calls = []
    server = SimpleNamespace(_hermes_home=home, handle_request=lambda req: calls.append((req, current_transport())))
    thread = start_profile_recovery(server, transport)
    thread.join(2)
    assert not thread.is_alive()
    assert len(calls) == 1
    assert calls[0][0]["method"] == "session.resume"
    assert calls[0][0]["params"] == {"session_id": "conversation"}
    assert calls[0][1] is transport
    assert start_profile_recovery(server, transport) is None


def test_startup_can_retry_when_account_authority_was_unavailable(pending, monkeypatch):
    home, _session, _owner, _handle = pending
    calls = []
    server = SimpleNamespace(_hermes_home=home, handle_request=lambda req: calls.append(req),
                             logger=SimpleNamespace(warning=lambda *_a, **_k: None))
    monkeypatch.setattr("agent.workspace_route_guard.read_route_authority", lambda: {})
    start_profile_recovery(server).join(2)
    assert calls == []
    monkeypatch.setattr("agent.workspace_route_guard.read_route_authority", lambda: {"accountKey": "a" * 64})
    start_profile_recovery(server).join(2)
    assert len(calls) == 1


def test_request_recording_cannot_overwrite_a_racing_stop(pending, monkeypatch):
    from agent.request_checkpoint import CheckpointSuperseded
    from hermes_state import SessionDB
    from tui_gateway.surface_context import bind_managed_submission

    home, _session, owner, handle = pending
    compare = SessionDB.compare_meta

    def stop_before_write(db, key, expected, value):
        if key == handle["key"]:
            receipt = json.loads(db.get_meta(key))
            receipt["status"] = "interrupted"
            db.set_meta(key, json.dumps(receipt))
        return compare(db, key, expected, value)

    monkeypatch.setattr(SessionDB, "compare_meta", stop_before_write)
    agent = SimpleNamespace(provider="other")
    with bind_managed_submission(agent, handle):
        with pytest.raises(CheckpointSuperseded):
            agent._atum_record_model_request("operation", "logical")
    assert submission_status(home, owner, handle["key"].rsplit(":", 1)[-1])["status"] == "interrupted"


@pytest.mark.parametrize("recovered", [True, False])
def test_host_crash_reports_failure_only_if_its_owner_cannot_continue(tmp_path, recovered):
    from tui_gateway.host_supervisor import HostSupervisor

    events, completions = [], []
    supervisor = HostSupervisor(registry_path=tmp_path / "host.json", autostart=False, rpc_sink=events.append)

    def complete(frame):
        completions.append(frame)
        return recovered

    supervisor._pending_turns["request"] = ("runtime", complete)
    supervisor._fail_pending_turns(reason="crash", message="compute host exited")
    assert len(completions) == 1
    assert completions[0]["reason"] == "crash"
    assert len(events) == (0 if recovered else 1)


def test_recovery_agent_build_timeout_clears_busy_state(pending):
    from tui_gateway import server as real_server

    home, session, _owner, _handle = pending
    session.update(agent=None, agent_ready=threading.Event(), lazy=True)
    paused = threading.Event()
    server = SimpleNamespace(
        _hermes_home=home, logger=SimpleNamespace(warning=lambda *_a: None),
        _start_inflight_turn=lambda *_a: None, _clear_inflight_turn=lambda *_a: None,
        _load_dashboard_process_isolation_config=lambda: {},
        _session_uses_compute_host=lambda *_a: False, _start_agent_build=lambda *_a: None,
        _wait_agent=lambda s, rid: real_server._wait_agent(s, rid, timeout=0.01),
        _emit=lambda *_a: paused.set(),
    )
    assert resume_pending(server, "runtime", session)
    assert paused.wait(2)
    assert not session["running"]


def test_startup_uses_real_session_resume_and_reuses_its_runtime_identity(pending, monkeypatch):
    from tui_gateway import server

    home, _session, _owner, handle = pending
    monkeypatch.setattr("agent.workspace_route_guard.read_route_authority", lambda: {"accountKey": "a" * 64})
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_profile_home", lambda _profile: None)
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_claim_active_session_slot", lambda *_a, **_k: (None, None))
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *_a: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda *_a: None)
    monkeypatch.setattr(server, "_load_dashboard_process_isolation_config", lambda: {})
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_a: True)
    dispatched = []

    def dispatch(*args, **kwargs):
        dispatched.append((args, kwargs))
        return {"result": {"status": "streaming"}}

    monkeypatch.setattr(server, "_submit_prompt_to_compute_host", dispatch)
    with context_db(home) as db:
        db.create_session("conversation", "cli", model="binh-minh", cwd=str(home))
        monkeypatch.setattr(server, "_get_db", lambda: db)
        thread = start_profile_recovery(server)
        thread.join(2)
        assert not thread.is_alive()
        assert len(dispatched) == len(server._sessions) == 1
        sid = next(iter(server._sessions))
        assert dispatched[0][0][1] == sid
        assert dispatched[0][1] == {"submission_receipt": handle, "resume_request": True}
        # A window opening later receives the same running session, not a new
        # worker or lost navigation identity, through the existing attach RPC.
        attached = server.handle_request({"id": "window", "method": "session.resume", "params": {"session_id": "conversation"}})
        assert attached["result"]["session_id"] == sid
        assert attached["result"]["running"]
        assert len(dispatched) == 1


def test_byok_stop_does_not_depend_on_managed_receipt_storage(monkeypatch):
    from tui_gateway import server

    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    interrupted = []
    agent = SimpleNamespace(provider="openrouter", model="byok-model", interrupt=lambda: interrupted.append(True))
    session = {"agent": agent, "running": True, "history_lock": threading.RLock(), "session_key": "byok"}
    monkeypatch.setattr(server, "_sess_nowait", lambda *_a: (session, None))
    monkeypatch.setattr(server, "_sess", lambda *_a: (session, None))
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_a: False)
    monkeypatch.setattr(server, "_clear_inflight_turn", lambda *_a: None)
    monkeypatch.setattr(server, "_clear_pending", lambda *_a: None)
    monkeypatch.setattr("tui_gateway.surface_context.capabilities", lambda *_a: pytest.fail("BYOK Stop opened managed storage"))
    result = server.handle_request({"id": "stop", "method": "session.interrupt", "params": {"session_id": "byok"}})
    assert result["result"]["status"] == "interrupted"
    assert interrupted == [True]


@pytest.mark.parametrize("isolated", [False, True])
def test_managed_stop_latches_pending_work_before_interrupt(pending, monkeypatch, isolated):
    """Stop closes the durable receipt before either execution branch can return."""
    from tui_gateway import server

    home, session, owner, _handle = pending
    interrupted = []
    session.update(
        agent=SimpleNamespace(
            provider="atum-managed",
            requested_provider="atum-managed",
            model="binh-minh",
            interrupt=lambda *_a, **_k: interrupted.append(True),
        ),
        running=True,
    )
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sess_nowait", lambda *_a: (session, None))
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_a: isolated)
    monkeypatch.setattr(server, "_interrupt_session_turn", lambda *_a, **_k: interrupted.append(True))
    monkeypatch.setattr(server, "_retire_turn_marker", lambda *_a, **_k: None)

    result = server.handle_request(
        {"id": "stop", "method": "session.interrupt", "params": {"session_id": "runtime"}}
    )

    assert result["result"]["status"] == "interrupted"
    assert pending_submission(home, owner) is None
    assert not resume_pending(SimpleNamespace(_hermes_home=home), "runtime", session)
    assert interrupted


@pytest.mark.parametrize("isolated", [False, True])
def test_managed_stop_reports_when_restart_latch_cannot_persist(pending, monkeypatch, isolated):
    """The live turn is still interrupted, but restart remains visibly unsafe."""
    from tui_gateway import server

    home, session, _owner, _handle = pending
    interrupted = []
    session.update(
        agent=SimpleNamespace(
            provider="atum-managed",
            requested_provider="atum-managed",
            model="binh-minh",
            interrupt=lambda *_a, **_k: interrupted.append(True),
        ),
        running=True,
    )
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sess_nowait", lambda *_a: (session, None))
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_a: isolated)
    monkeypatch.setattr(server, "_interrupt_session_turn", lambda *_a, **_k: interrupted.append(True))
    monkeypatch.setattr(server, "_retire_turn_marker", lambda *_a, **_k: None)
    monkeypatch.setattr("tui_gateway.request_recovery.latch_stop", lambda *_a: (_ for _ in ()).throw(OSError("disk full")))

    result = server.handle_request(
        {"id": "stop", "method": "session.interrupt", "params": {"session_id": "runtime"}}
    )

    assert result["error"]["code"] == 5030
    assert "press Stop again before restarting" in result["error"]["message"]
    assert interrupted


@pytest.mark.parametrize("async_delivery", [False, True])
def test_compute_host_crash_resumes_only_async_managed_turns(pending, monkeypatch, async_delivery):
    """A crash reattaches durable work immediately only for push-capable sessions."""
    from tui_gateway import server

    _home, session, _owner, _handle = pending
    session.update(async_delivery=async_delivery, running=True)
    resumed = []
    emitted = []
    monkeypatch.setattr(
        "tui_gateway.request_recovery.resume_pending",
        lambda _server, sid, candidate: resumed.append((sid, candidate)) or True,
    )
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload: emitted.append((event, sid, payload)))
    monkeypatch.setattr(server, "_clear_inflight_turn", lambda *_a: None)
    monkeypatch.setattr(server, "_release_deferred_active_session_lease", lambda *_a: None)
    monkeypatch.setattr(server, "_drain_queued_prompt", lambda *_a: None)
    monkeypatch.setattr(server, "_compute_host_session_info", lambda *_a: {"running": False})

    continued = server._on_compute_host_turn_done(
        "request", "runtime", session,
        {"type": "turn.error", "reason": "crash", "message": "compute host exited"},
    )

    assert bool(resumed) is async_delivery
    assert (continued is True) is async_delivery
    assert bool([event for event in emitted if event[0] == "message.complete"]) is (not async_delivery)
