"""Desktop turns must carry their durable conversation ID into real tools."""

import json
import shlex
import sys
import threading
from types import SimpleNamespace

from tools.environments.local import LocalEnvironment


def test_turn_binds_current_agent_identity_in_reused_terminal(tmp_path, monkeypatch):
    from tui_gateway import server

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_SESSION_ID", "foreign-process-global")
    monkeypatch.setattr(server, "_hermes_home", tmp_path)
    for name in (
        "_wire_callbacks", "_sync_agent_model_with_config", "_register_session_cwd",
    ):
        monkeypatch.setattr(server, name, lambda *args, **kwargs: None)
    monkeypatch.setattr(server, "_load_interim_assistant_messages", lambda: False)
    monkeypatch.setattr(server, "_tts_stream_begin", lambda: None)
    monkeypatch.setattr(server, "_voice_tts_enabled", lambda: False)
    monkeypatch.setattr(server, "_session_info", lambda *args: {})
    monkeypatch.setattr(server, "_get_usage", lambda *args: {})
    monkeypatch.setattr(server, "_drain_queued_prompt", lambda *args: False)
    monkeypatch.setattr(server, "_get_db", lambda: None)
    events = []
    monkeypatch.setattr(server, "_emit", lambda name, sid, payload: events.append((name, payload)))

    # Capture a real shell snapshot BEFORE the turn, as a cached terminal can
    # outlive a build thread, session switch, or compression boundary.
    terminal = LocalEnvironment(cwd=str(tmp_path), timeout=10)
    probe = (
        "import json,os; print(json.dumps({k:os.environ.get(k) for k in "
        "['HERMES_SESSION_ID','HERMES_SESSION_KEY','HERMES_UI_SESSION_ID']}))"
    )
    command = f"{shlex.quote(sys.executable)} -c {shlex.quote(probe)}"
    seen = []

    def run(message, **kwargs):
        result = terminal.execute(command)
        assert result["returncode"] == 0, result
        seen.append(json.loads(result["output"].strip()))
        return {"final_response": "done", "messages": [
            {"role": "user", "content": message},
            {"role": "assistant", "content": "done"},
        ]}

    agent = SimpleNamespace(
        model="test/model", provider="test", _session_db=None,
        session_id="conversation-first", run_conversation=run,
    )
    session = {
        "agent": agent, "session_key": "logical-workspace-key", "cwd": str(tmp_path),
        "history": [], "history_lock": threading.Lock(), "running": True,
    }
    monkeypatch.setattr(server, "_sessions", {"desktop-tab": session})
    expected = []
    try:
        for identity in ("conversation-first", "conversation-after-compression"):
            agent.session_id = identity
            session["running"] = True
            expected.append({
                "HERMES_SESSION_ID": identity,
                "HERMES_SESSION_KEY": session["session_key"],
                "HERMES_UI_SESSION_ID": "desktop-tab",
            })
            server._run_prompt_submit("request", "desktop-tab", session, "probe")
            session["_run_thread"].join(timeout=20)
            assert not session["_run_thread"].is_alive()
            assert not [event for event in events if event[0] == "error"], events
        assert seen == expected
    finally:
        terminal.cleanup()


def test_unbound_thread_cannot_replay_identity_from_shell_snapshot(tmp_path, monkeypatch):
    from gateway.session_context import clear_session_vars, set_session_vars

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    tokens = set_session_vars(session_id="snapshot-owner", session_key="snapshot-key")
    terminal = LocalEnvironment(cwd=str(tmp_path), timeout=10)
    clear_session_vars(tokens)
    command = f"{shlex.quote(sys.executable)} -c " + shlex.quote(
        "import json,os; print(json.dumps(os.environ.get('HERMES_SESSION_ID')))"
    )
    seen = []
    worker = threading.Thread(target=lambda: seen.append(terminal.execute(command)))
    try:
        worker.start()
        worker.join(timeout=15)
        assert not worker.is_alive()
        assert seen[0]["returncode"] == 0, seen
        assert json.loads(seen[0]["output"].strip()) is None
    finally:
        terminal.cleanup()


def test_context_restore_preserves_user_exports_and_quotes_values(tmp_path, monkeypatch):
    from gateway.session_context import clear_session_vars, set_session_vars

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    injected = tmp_path / "must-not-be-created"
    name = f"Alex's $(touch {shlex.quote(str(injected))})\nsecond line"
    tokens = set_session_vars(session_id="current-chat", chat_name=name)
    terminal = LocalEnvironment(cwd=str(tmp_path), timeout=10)
    try:
        assert terminal.execute("export ATUM_TEST_USER_VALUE=kept")["returncode"] == 0
        command = f"{shlex.quote(sys.executable)} -c " + shlex.quote(
            "import json,os; print(json.dumps([os.environ.get('HERMES_SESSION_CHAT_NAME'),"
            "os.environ.get('ATUM_TEST_USER_VALUE')]))"
        )
        result = terminal.execute(command)
        assert result["returncode"] == 0, result
        assert json.loads(result["output"].strip()) == [name, "kept"]
        assert not injected.exists()
    finally:
        terminal.cleanup()
        clear_session_vars(tokens)


def test_terminal_still_runs_when_optional_gateway_import_is_unavailable(tmp_path, monkeypatch):
    import builtins

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    terminal = LocalEnvironment(cwd=str(tmp_path), timeout=10)
    original_import = builtins.__import__

    def without_gateway(name, *args, **kwargs):
        if name == "gateway.session_context":
            raise ImportError("optional gateway dependency unavailable")
        return original_import(name, *args, **kwargs)

    try:
        with monkeypatch.context() as isolated:
            isolated.setattr(builtins, "__import__", without_gateway)
            result = terminal.execute("printf terminal-ready")
        assert result["returncode"] == 0, result
        assert result["output"].strip() == "terminal-ready"
    finally:
        terminal.cleanup()
