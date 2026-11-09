import json
import os
import subprocess
import sys
import threading
import time
import types
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_cli.active_sessions import active_session_registry_snapshot
from hermes_cli.browser_connect import ChromeDebugLaunch
from tui_gateway import server


@pytest.fixture(autouse=True)
def _neuter_agent_prewarm_timer(request, monkeypatch):
    """Stub the deferred agent pre-warm timer for every test in this module.

    ``session.create`` and non-eager ``session.resume`` fire a 50 ms
    background ``threading.Timer`` (``_schedule_agent_build``) that calls
    whatever ``server._make_agent`` is patched in AT FIRE TIME. Left live,
    a timer armed by one test outlives it and lands in the NEXT test's
    ``_make_agent`` mock, racily corrupting its captured state (the
    ``'tip' == 'cont_tip'`` flakes in the session_resume tests). Tests that
    exercise the deferred build itself opt back in with
    ``@pytest.mark.real_agent_prewarm``.
    """
    if request.node.get_closest_marker("real_agent_prewarm"):
        yield
        return
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *a, **k: None)
    yield


def test_session_drafts_do_not_consume_active_session_limit(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    (home / "config.yaml").write_text("max_concurrent_sessions: 1\n", encoding="utf-8")
    token = set_hermes_home_override(home)

    def _clear_server_sessions():
        for session in list(server._sessions.values()):
            server._teardown_session(session)
        server._sessions.clear()

    try:
        server._cfg_cache = None
        server._cfg_sig = None
        server._cfg_path = None
        _clear_server_sessions()
        monkeypatch.setattr(server, "_start_agent_build", lambda *args, **kwargs: None)
        monkeypatch.setattr(server, "_completion_cwd", lambda params=None: str(tmp_path))

        first = server._methods["session.create"]("r1", {"cols": 80})
        assert "result" in first
        sid = first["result"]["session_id"]

        second = server._methods["session.create"]("r2", {"cols": 80})
        assert "result" in second
        assert active_session_registry_snapshot() == []
        # Upstream claims on the first real turn, not tile/draft creation. Atum's
        # single home still needs exclusive writers once work actually begins.
        assert server._ensure_active_session_slot(sid, server._sessions[sid]) is None
        refusal = server._ensure_active_session_slot(
            second["result"]["session_id"], server._sessions[second["result"]["session_id"]]
        )
        assert "active session limit" in refusal

        closed = server._methods["session.close"]("r3", {"session_id": sid})
        assert closed["result"]["closed"] is True
        assert active_session_registry_snapshot() == []

        third = server._methods["session.create"]("r4", {"cols": 80})
        assert "result" in third
    finally:
        _clear_server_sessions()
        server._cfg_cache = None
        server._cfg_sig = None
        server._cfg_path = None
        reset_hermes_home_override(token)


def test_dashboard_process_isolation_config_defaults_without_default_merge(monkeypatch):
    """tui_gateway.server::_load_cfg is raw YAML, so defaults live at read site."""
    monkeypatch.setattr(server, "_load_cfg", dict)

    assert server._load_dashboard_process_isolation_config() == {
        "turn_isolation": False,
        "compute_host_heartbeat_secs": 15,
        "compute_host_respawn_max": 3,
    }


def test_default_config_seeds_dashboard_process_isolation_keys():
    from hermes_cli.config import DEFAULT_CONFIG

    dashboard = DEFAULT_CONFIG["dashboard"]
    assert dashboard["turn_isolation"] is False
    assert dashboard["compute_host_heartbeat_secs"] == 15
    assert dashboard["compute_host_respawn_max"] == 3


def _write_profile_cfg(home: Path, cwd: str | None) -> Path:
    import yaml

    home.mkdir(parents=True, exist_ok=True)
    cfg = {"terminal": {"cwd": cwd}} if cwd is not None else {}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    return home


def test_terminal_task_cwd_preserves_remote_home_sentinel(monkeypatch):
    """Sentinel/auto cwd values are not real remote paths, so the SSH branch
    must defer to the session cwd rather than registering a meaningless dir."""
    monkeypatch.setenv("TERMINAL_ENV", "ssh")
    monkeypatch.setenv("TERMINAL_CWD", "auto")
    monkeypatch.setattr(server, "_load_cfg", lambda: {"terminal": {"cwd": "."}})

    assert server._terminal_task_cwd({"cwd": "/host/session/dir"}) == "~"


class _ChunkyStdout:
    def __init__(self):
        self.parts: list[str] = []

    def write(self, text: str) -> int:
        for ch in text:
            self.parts.append(ch)
            time.sleep(0.0001)
        return len(text)

    def flush(self) -> None:
        return None


class _BrokenStdout:
    def write(self, text: str) -> int:
        raise BrokenPipeError

    def flush(self) -> None:
        return None


def test_config_get_verbose_reports_the_sessions_live_tool_progress_mode(monkeypatch):
    # The Matrix resume decision reads this before a prompt is sent: a tool start is only
    # observable (and so a run only provably read-only) when the session's mode is not "off".
    monkeypatch.setenv("HERMES_TUI_TOOL_PROGRESS", "all")
    monkeypatch.setitem(server._sessions, "verbose-off", {"tool_progress_mode": "off"})
    monkeypatch.setitem(server._sessions, "verbose-new", {"tool_progress_mode": "new"})

    def get(**params):
        return server.handle_request({"id": "1", "method": "config.get", "params": {"key": "verbose", **params}})

    assert get(session_id="verbose-off")["result"]["value"] == "off"
    assert get(session_id="verbose-new")["result"]["value"] == "new"
    # No such session: the process-wide setting (the environment pin beats config.yaml).
    assert get(session_id="missing")["result"]["value"] == "all"
    monkeypatch.setenv("HERMES_TUI_TOOL_PROGRESS", "off")
    assert get()["result"]["value"] == "off"


def test_system_battery_returns_reading(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "agent.battery",
        types.SimpleNamespace(
            read_battery=lambda: types.SimpleNamespace(
                available=True, percent=77, plugged=False
            ),
            battery_category=lambda _s: "good",
        ),
    )

    resp = server.dispatch({"id": "b1", "method": "system.battery", "params": {}})

    assert resp["result"] == {
        "available": True,
        "percent": 77,
        "plugged": False,
        "category": "good",
    }


def test_load_enabled_toolsets_keeps_followup_sweeps_tool_free(monkeypatch):
    monkeypatch.setenv("HERMES_TUI_TOOLSETS", "web,terminal")
    monkeypatch.setattr(
        server,
        "_load_cfg",
        lambda: {
            "atum_followup_sweep": True,
            "platform_toolsets": {"cli": []},
            "plugins": {"enabled": []},
        },
    )

    # The controller's classifier contract overrides every generic recovery path, including an
    # operator env pin. ``[]`` is the AIAgent sentinel for an intentional zero-tool request;
    # ``None`` would expose every tool and trip followup_sweep_tools_present before submission.
    enabled = server._load_enabled_toolsets()
    assert enabled == []

    from model_tools import get_tool_definitions

    assert get_tool_definitions(enabled_toolsets=enabled, quiet_mode=True) == []


def test_load_enabled_toolsets_all_env_warns_about_ignored_extra_entries(
    monkeypatch, capsys
):
    monkeypatch.setenv("HERMES_TUI_TOOLSETS", "all,nope")

    assert server._load_enabled_toolsets() is None
    assert "ignoring additional entries: nope" in capsys.readouterr().err




def test_resolve_model_uses_managed_default_only_when_config_is_empty(monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.delenv("HERMES_INFERENCE_MODEL", raising=False)
    monkeypatch.setenv("ATUM_MANAGED_MODEL_DEFAULT", "binh-minh")
    monkeypatch.setattr(server, "_load_cfg", lambda: {"model": ""})

    assert server._resolve_model() == "binh-minh"

    monkeypatch.setattr(
        server, "_load_cfg", lambda: {"model": {"default": "user/chosen-model"}}
    )

    assert server._resolve_model() == "user/chosen-model"


def _sync_test_session(**extra):
    session = {
        "agent": types.SimpleNamespace(model="old/model"),
        "session_key": "session-key",
    }
    session.update(extra)
    return session


def _patch_config_model(monkeypatch, model, provider=""):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.delenv("HERMES_INFERENCE_MODEL", raising=False)
    cfg_model = {"default": model}
    if provider:
        cfg_model["provider"] = provider
    monkeypatch.setattr(server, "_load_cfg", lambda: {"model": cfg_model})


def test_config_model_target_never_reads_env(monkeypatch):
    monkeypatch.setenv("HERMES_MODEL", "seed/model")
    monkeypatch.setenv("HERMES_INFERENCE_MODEL", "seed/model")
    monkeypatch.setattr(server, "_load_cfg", lambda: {"model": {"provider": "nous"}})

    assert server._config_model_target() == ("", "nous")


def test_model_picker_context_uses_launch_provider_before_agent_exists(monkeypatch):
    class Context:
        current_provider = ""

        def with_overrides(self, **values):
            return values

    monkeypatch.setattr("hermes_cli.inventory.load_picker_context", Context)
    monkeypatch.setattr(server, "_resolve_model", lambda: "binh-minh")
    monkeypatch.delenv("HERMES_TUI_PROVIDER", raising=False)
    monkeypatch.delenv("HERMES_INFERENCE_PROVIDER", raising=False)
    monkeypatch.setenv("ATUM_MANAGED_MODEL_DEFAULT", "binh-minh")

    context = server._model_picker_context(None)

    assert context["current_provider"] == "atum-managed"
    assert context["current_model"] == "binh-minh"


def test_startup_runtime_uses_managed_default_only_without_config_model(monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.delenv("HERMES_INFERENCE_MODEL", raising=False)
    monkeypatch.delenv("HERMES_TUI_PROVIDER", raising=False)
    monkeypatch.setenv("ATUM_MANAGED_MODEL_DEFAULT", "binh-minh")
    monkeypatch.setattr(server, "_load_cfg", lambda: {"model": ""})

    assert server._resolve_startup_runtime() == ("binh-minh", "atum-managed")

    monkeypatch.setattr(
        server,
        "_load_cfg",
        lambda: {"model": {"default": "user/chosen-model", "provider": "openrouter"}},
    )

    assert server._resolve_startup_runtime() == ("user/chosen-model", None)


def test_startup_runtime_detects_provider_for_model_env(monkeypatch):
    monkeypatch.setenv("HERMES_MODEL", "sonnet")
    monkeypatch.delenv("HERMES_TUI_PROVIDER", raising=False)
    monkeypatch.delenv("HERMES_INFERENCE_PROVIDER", raising=False)
    monkeypatch.setattr(server, "_load_cfg", lambda: {"model": {"provider": "auto"}})

    def fake_detect(model, current_provider):
        assert model == "sonnet"
        assert current_provider == "auto"
        return "anthropic", "anthropic/claude-sonnet-4.6"

    monkeypatch.setattr(
        "hermes_cli.models.detect_static_provider_for_model", fake_detect
    )

    assert server._resolve_startup_runtime() == (
        "anthropic/claude-sonnet-4.6",
        "anthropic",
    )


def _session(agent=None, **extra):
    return {
        "agent": agent if agent is not None else types.SimpleNamespace(),
        "session_key": "session-key",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "attached_images": [],
        "image_counter": 0,
        "cols": 80,
        "slash_worker": None,
        "show_reasoning": False,
        "tool_progress_mode": "all",
        **extra,
    }


def test_ws_orphan_reap_closes_worker_when_session_stays_detached(monkeypatch):
    """A detached WS session past its grace window has its slash_worker closed.

    Regression for #38591 fallout: every dashboard refresh spawned a fresh
    session + _SlashWorker but never reaped the previous one, leaking one
    python subprocess per refresh.
    """
    closed = {"worker": False}

    class _FakeWorker:
        def close(self):
            closed["worker"] = True

    server._sessions["orphan-sid"] = _session(
        transport=server._detached_ws_transport,
        slash_worker=_FakeWorker(),
        running=False,
    )
    # Run the reap body synchronously (no real timer/grace) to assert behaviour.
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0.01)
    try:
        # Directly invoke the orphaned-check + teardown the timer would run.
        assert server._ws_session_is_orphaned(server._sessions["orphan-sid"]) is True
        session = server._sessions.pop("orphan-sid")
        server._teardown_session(session)
        assert closed["worker"] is True
    finally:
        server._sessions.pop("orphan-sid", None)


class _StopAfterOneNotificationPoll:
    def __init__(self):
        self._checks = 0

    def is_set(self):
        self._checks += 1
        return self._checks > 1


def _configure_immediate_prompt_run(
    monkeypatch, tmp_path, *, immediate_threads=True
):
    class _ImmediateThread:
        def __init__(self, target=None, daemon=None, **_kwargs):
            self._target = target

        def start(self):
            if self._target is not None:
                self._target()

        def is_alive(self):
            return False

    if immediate_threads:
        monkeypatch.setattr(server.threading, "Thread", _ImmediateThread)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "make_stream_renderer", lambda _cols: None)
    monkeypatch.setattr(server, "render_message", lambda _raw, _cols: None)
    monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda *_args: None)
    monkeypatch.setattr(server, "_session_cwd", lambda _session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(server, "_set_session_context", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server, "_clear_session_context", lambda _tokens: None)
    monkeypatch.setattr(server, "_session_info", lambda *_args: {})
    monkeypatch.setattr(server, "_get_usage", lambda _agent: {})
    monkeypatch.setattr(
        server, "_sync_session_key_after_compress", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(server, "_drain_queued_prompt", lambda *_args: False)
    monkeypatch.setattr(server, "_voice_tts_enabled", lambda: False)
    monkeypatch.setattr(server, "_get_db", lambda: None)


class _RecordingAgent:
    model = "test-model"
    provider = "test-provider"

    def __init__(self, turns):
        self._turns = turns

    def clear_interrupt(self):
        return None

    def run_conversation(
        self, prompt, conversation_history=None, stream_callback=None
    ):
        self._turns.append(prompt)
        return {"final_response": "", "messages": []}


def test_desktop_launch_cwd_is_not_an_explicit_workspace(monkeypatch, tmp_path):
    """Without an explicit workspace, cwd is left null so the session groups
    under "No workspace" rather than the gateway's launch directory."""
    created = []

    class _FakeDB:
        def create_session(self, key, source=None, model=None, model_config=None, parent_session_id=None, cwd=None, **_kwargs):
            created.append(
                {"key": key, "source": source, "model": model, "model_config": model_config, "cwd": cwd}
            )

    monkeypatch.setattr(server, "_get_db", lambda: _FakeDB())
    monkeypatch.setattr(server, "_resolve_model", lambda: "test-model")
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.delenv("HERMES_DESKTOP_TERMINAL", raising=False)

    server._ensure_session_db_row({"session_key": "k1", "cwd": str(tmp_path), "source": "desktop"})

    assert created == [
        {"key": "k1", "source": "desktop", "model": "test-model", "model_config": None, "cwd": None}
    ]


def test_desktop_contract_includes_approval_mode_rpc():
    assert server.DESKTOP_BACKEND_CONTRACT >= 3


def test_setup_status_reports_provider_config(monkeypatch):
    monkeypatch.setattr("hermes_cli.main._has_any_provider_configured", lambda **_kw: False)

    resp = server.handle_request({"id": "1", "method": "setup.status", "params": {}})

    assert resp["result"]["provider_configured"] is False


def test_complete_slash_drops_removed_provider_alias():
    # `/provider` was folded into a single `/model` command, so autocomplete
    # must no longer offer the dead alias...
    resp = server.handle_request(
        {"id": "1", "method": "complete.slash", "params": {"text": "/pro"}}
    )

    assert not any(item["text"] == "provider" for item in resp["result"]["items"])

    # ...while `/model` stays the canonical command.
    resp_model = server.handle_request(
        {"id": "2", "method": "complete.slash", "params": {"text": "/mod"}}
    )

    assert any(item["text"] == "model" for item in resp_model["result"]["items"])


def test_complete_slash_includes_tui_details_command():
    resp = server.handle_request(
        {"id": "1", "method": "complete.slash", "params": {"text": "/det"}}
    )

    assert any(item["text"] == "/details" for item in resp["result"]["items"])


def test_complete_slash_includes_tui_mouse_command():
    resp = server.handle_request(
        {"id": "1", "method": "complete.slash", "params": {"text": "/mou"}}
    )

    assert any(item["text"] == "/mouse" for item in resp["result"]["items"])


def test_complete_slash_reasoning_includes_current_efforts_and_global_scope():
    resp = server.handle_request(
        {"id": "1", "method": "complete.slash", "params": {"text": "/reasoning "}}
    )

    values = {item["text"] for item in resp["result"]["items"]}
    assert {"max", "ultra", "--global"} <= values


def test_config_set_model_uses_live_switch_path(monkeypatch):
    server._sessions["sid"] = _session()
    seen = {}

    def _fake_apply(sid, session, raw, **_kwargs):
        seen["args"] = (sid, session["session_key"], raw)
        return {"value": "new/model", "warning": "catalog unreachable"}

    monkeypatch.setattr(server, "_apply_model_switch", _fake_apply)
    resp = server.handle_request(
        {
            "id": "1",
            "method": "config.set",
            "params": {"session_id": "sid", "key": "model", "value": "new/model"},
        }
    )

    assert resp["result"]["value"] == "new/model"
    assert resp["result"]["warning"] == "catalog unreachable"
    assert seen["args"] == ("sid", "session-key", "new/model")


def test_session_compress_forwards_bounded_budget_to_compute_host(monkeypatch):
    session = _session(agent=None, _compute_host_active=True)
    server._sessions["sid"] = session
    calls = []

    def send_control(*args, **kwargs):
        calls.append((args, kwargs))
        return {
            "type": "control.ack",
            "result": {
                "status": "compressed",
                "messages": [],
                "removed": 0,
                "summary": {"headline": "Already compressed", "noop": True},
            },
        }

    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: True)
    monkeypatch.setattr(server, "_send_compute_host_control", send_control)

    try:
        resp = server.handle_request(
            {"id": "1", "method": "session.compress", "params": {"session_id": "sid"}}
        )
    finally:
        server._sessions.pop("sid", None)

    assert resp["result"]["status"] == "compressed"
    assert len(calls) == 1
    args, request = calls[0]
    assert args == ("sid",)
    assert request["route_name"] == "session.compress" and request["command"] == "/compress"
    assert request["wait"] is True and 0 < request["timeout"] < 3600
    assert callable(request["on_late_ack"])


def test_file_attach_preserves_equal_named_room_and_local_document_bytes(tmp_path):
    """Matrix supplies both as bytes; Hermes, not Atum, owns collision naming."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    server._sessions["sid"] = _session(cwd=str(workspace))
    try:
        responses = [
            server.handle_request({
                "id": str(index), "method": "file.attach",
                "params": {"session_id": "sid", "name": "report.txt",
                           "data_url": f"data:text/plain;base64,{payload}"},
            })["result"]
            for index, payload in enumerate(["cm9vbQ==", "bG9jYWw="])
        ]
        assert len({r["path"] for r in responses}) == 2
        assert all(r["ref_text"].startswith("@file:") and r["ref_text"].endswith(Path(r["path"]).name) for r in responses)
        assert [Path(r["path"]).read_bytes() for r in responses] == [b"room", b"local"]
    finally:
        server._sessions.pop("sid", None)


def test_commands_catalog_includes_tui_mouse_command():
    resp = server.handle_request(
        {"id": "1", "method": "commands.catalog", "params": {}}
    )

    pairs = dict(resp["result"]["pairs"])
    tui_cat = next(c for c in resp["result"]["categories"] if c["name"] == "TUI")
    tui_pairs = dict(tui_cat["pairs"])

    assert "/mouse" in pairs
    assert "/mouse" in tui_pairs


def test_plugins_list_surfaces_loader_error(monkeypatch):
    with patch("hermes_cli.plugins.get_plugin_manager", side_effect=Exception("boom")):
        resp = server.handle_request(
            {"id": "1", "method": "plugins.list", "params": {}}
        )

    assert "error" in resp
    assert "boom" in resp["error"]["message"]


def test_complete_slash_surfaces_completer_error(monkeypatch):
    with patch(
        "hermes_cli.commands_completion.SlashCommandCompleter",
        side_effect=Exception("no completer"),
    ):
        resp = server.handle_request(
            {"id": "1", "method": "complete.slash", "params": {"text": "/mo"}}
        )

    assert "error" in resp
    assert "no completer" in resp["error"]["message"]


def test_input_detect_drop_attaches_image(monkeypatch):
    fake_cli = types.ModuleType("cli")
    fake_cli._detect_file_drop = lambda raw: {
        "path": Path("/tmp/cat.png"),
        "is_image": True,
        "remainder": "",
    }

    server._sessions["sid"] = _session()
    monkeypatch.setitem(sys.modules, "cli", fake_cli)

    resp = server.handle_request(
        {
            "id": "1",
            "method": "input.detect_drop",
            "params": {"session_id": "sid", "text": "/tmp/cat.png"},
        }
    )

    assert resp["result"]["matched"] is True
    assert resp["result"]["is_image"] is True
    assert resp["result"]["text"] == "[User attached image: cat.png]"


def test_completion_cwd_prefers_recorded_atum_workspace_root(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (tmp_path / "atum-workspace-root").write_text(f"{workspace}\n")
    monkeypatch.setattr(server, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(server, "_profile_configured_cwd", lambda *_: None)
    monkeypatch.setattr(server, "_launch_configured_cwd", lambda: None)

    monkeypatch.delenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", raising=False)
    assert server._completion_cwd({}) != str(workspace)

    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    assert server._completion_cwd({}) == str(workspace)
    # An explicit cwd still wins over the account workspace.
    assert server._completion_cwd({"cwd": str(tmp_path)}) == str(tmp_path)
    # A stale marker (directory gone) is ignored.
    (tmp_path / "atum-workspace-root").write_text(str(tmp_path / "missing"))
    assert server._completion_cwd({}) != str(tmp_path / "missing")


@pytest.mark.parametrize("params", [{}, {"profile": "named-agent"}])
def test_completion_cwd_uses_main_workspace_marker_after_account_rehome(monkeypatch, tmp_path, params):
    """Both default and named profile backends keep Electron's workspace root.

    Account-scoped backends intentionally use a different ``HERMES_HOME`` than
    the installation home where Electron owns the account lifecycle marker.
    The explicit marker environment pointer must therefore win for either
    profile form without relying on a profile-local duplicate.
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    installation_home = tmp_path / "installation-hermes"
    installation_home.mkdir()
    marker = installation_home / "atum-workspace-root"
    marker.write_text(f"{workspace}\n", encoding="utf-8")
    account_home = tmp_path / "accounts" / "account-a" / "hermes"
    account_home.mkdir(parents=True)
    profile_cwd = tmp_path / "named-profile-cwd"
    profile_cwd.mkdir()

    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    monkeypatch.setenv("ATUM_WORKSPACE_ROOT_MARKER", str(marker))
    named_home = account_home / "profiles" / "named-agent"
    named_home.mkdir(parents=True)
    monkeypatch.setattr(server, "_profile_home", lambda name: named_home if name else None)
    monkeypatch.setattr(server, "get_hermes_home", lambda: account_home)
    monkeypatch.setattr(server, "_profile_configured_cwd", lambda *_: str(profile_cwd))
    monkeypatch.setattr(server, "_launch_configured_cwd", lambda: None)

    assert server._completion_cwd(params) == str(workspace)


def test_tool_complete_emits_authoritative_edit_metadata(monkeypatch, tmp_path):
    target = tmp_path / "document.md"
    target.write_text("before\n")

    class _Mgr:
        enabled = True

        def current_checkpoint(self, cwd):
            assert cwd == str(tmp_path)
            return "a" * 40

        def diff(self, cwd, checkpoint_hash, file_path=None):
            assert file_path == "document.md"
            return {"success": True, "diff": "diff --git a/document.md b/document.md\n"}

    events = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload: events.append(payload))
    server._sessions["sid"] = _session(
        agent=types.SimpleNamespace(_checkpoint_mgr=_Mgr()),
        cwd=str(tmp_path),
        active_turn_id="turn-1",
        edit_snapshots={},
        edit_targets={},
        tool_started_at={},
    )
    server._on_tool_start("sid", "call-1", "write_file", {"path": str(target)})
    target.write_text("after\n")
    server._on_tool_complete(
        "sid", "call-1", "write_file", {"path": str(target)}, '{"success": true}'
    )

    edit = events[-1]["edit"]
    assert edit == {
        "session_id": "sid",
        "turn_id": "turn-1",
        "tool_call_id": "call-1",
        "tool": "write_file",
        "working_dir": str(tmp_path),
        "files": [{"path": str(target), "restore_path": "document.md", "kind": "modified"}],
        "checkpoint": {"hash": "a" * 40, "working_dir": str(tmp_path)},
        "diff": "diff --git a/document.md b/document.md\n",
        "diff_truncated": False,
        "restore_available": True,
    }


def test_tool_complete_failure_keeps_edit_metadata_but_disables_restore(monkeypatch, tmp_path):
    target = tmp_path / "new.md"

    class _Mgr:
        enabled = True

        def current_checkpoint(self, cwd):
            return "b" * 40

        def diff(self, cwd, checkpoint_hash, file_path=None):
            return {"success": True, "diff": ""}

    events = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload: events.append(payload))
    server._sessions["sid"] = _session(
        agent=types.SimpleNamespace(_checkpoint_mgr=_Mgr()), cwd=str(tmp_path),
        active_turn_id="turn-2", edit_snapshots={}, edit_targets={}, tool_started_at={},
    )
    server._on_tool_start("sid", "call-2", "patch", {"path": str(target)})
    server._on_tool_complete(
        "sid", "call-2", "patch", {"path": str(target)},
        '{"success": false, "error": "patch failed"}',
    )

    assert events[-1]["edit"]["checkpoint"]["hash"] == "b" * 40
    assert events[-1]["edit"]["restore_available"] is False


def test_tool_complete_edit_outside_workspace_is_not_restorable(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "package.json").write_text("{}")
    target = elsewhere / "notes.md"
    target.write_text("before\n")

    class _Mgr:
        enabled = True

        def get_working_dir_for_path(self, path):
            return str(elsewhere)

        def current_checkpoint(self, cwd):
            return "c" * 40

        def diff(self, cwd, checkpoint_hash, file_path=None):
            return {"success": True, "diff": "diff --git a/notes.md b/notes.md\n"}

    events = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload: events.append(payload))
    server._sessions["sid"] = _session(
        agent=types.SimpleNamespace(_checkpoint_mgr=_Mgr()), cwd=str(workspace),
        active_turn_id="turn-3", edit_snapshots={}, edit_targets={}, tool_started_at={},
    )
    server._on_tool_start("sid", "call-3", "write_file", {"path": str(target)})
    target.write_text("after\n")
    server._on_tool_complete("sid", "call-3", "write_file", {"path": str(target)}, '{"success": true}')

    edit = events[-1]["edit"]
    assert edit["working_dir"] == str(elsewhere)
    assert edit["files"] == [{"path": str(target), "restore_path": "notes.md", "kind": "modified"}]
    assert edit["checkpoint"] == {"hash": "c" * 40, "working_dir": str(elsewhere)}
    assert edit["restore_available"] is False


@pytest.mark.parametrize("file_path", ["/etc/passwd", "../outside.txt"])
def test_rollback_restore_rejects_outside_workspace_before_manager(file_path, tmp_path):
    class _Mgr:
        enabled = True

        def unsupported_backend_reason(self, _task):
            return None

        def list_checkpoints(self, cwd):
            raise AssertionError("checkpoint lookup must not run")

        def restore(self, cwd, target, file_path=None, safe=False):
            raise AssertionError("restore must not run")

    server._sessions["sid"] = _session(
        agent=types.SimpleNamespace(_checkpoint_mgr=_Mgr()), cwd=str(tmp_path)
    )
    resp = server.handle_request({
        "id": "1", "method": "rollback.restore",
        "params": {"session_id": "sid", "hash": "a" * 40, "file_path": file_path},
    })

    assert resp["result"]["success"] is False
    assert resp["result"]["code"] == "path_outside_workspace"


def test_rollback_restore_rejects_checkpoint_from_another_workspace(monkeypatch, tmp_path):
    restored = []

    class _Mgr:
        enabled = True

        def unsupported_backend_reason(self, _task):
            return None

        def list_checkpoints(self, cwd):
            return [{"hash": "a" * 40}]

        def restore(self, cwd, commit_hash, file_path=None, safe=False):
            restored.append(commit_hash)
            return {"success": True, "restored_to": commit_hash[:8], "file": file_path}

    server._sessions["sid"] = _session(agent=types.SimpleNamespace(_checkpoint_mgr=_Mgr()), cwd=str(tmp_path), history=[])
    try:
        foreign = server.handle_request(
            {"id": "r1", "method": "rollback.restore", "params": {"session_id": "sid", "hash": "b" * 40, "file_path": "doc.md"}}
        )
        assert foreign["result"]["success"] is False
        assert foreign["result"]["code"] == "checkpoint_not_found"
        assert restored == []

        own = server.handle_request(
            {"id": "r2", "method": "rollback.restore", "params": {"session_id": "sid", "hash": "a" * 40, "file_path": "doc.md"}}
        )
        assert own["result"]["success"] is True
        assert restored == ["a" * 40]
    finally:
        server._sessions.pop("sid", None)


def test_rollback_restore_structured_checkpoint_failures(tmp_path):
    class _DisabledMgr:
        enabled = False

    server._sessions["sid"] = _session(
        agent=types.SimpleNamespace(_checkpoint_mgr=_DisabledMgr()), cwd=str(tmp_path)
    )
    disabled = server.handle_request({
        "id": "1", "method": "rollback.restore",
        "params": {"session_id": "sid", "hash": "a" * 40},
    })
    assert disabled["result"]["code"] == "checkpoints_disabled"

    class _MissingMgr:
        enabled = True

        def unsupported_backend_reason(self, _task):
            return None

        def list_checkpoints(self, cwd):
            return []

        def restore(self, cwd, target, file_path=None, safe=False):
            return {"success": False, "code": "checkpoint_not_found", "error": "missing"}

    server._sessions["sid"] = _session(
        agent=types.SimpleNamespace(_checkpoint_mgr=_MissingMgr()), cwd=str(tmp_path)
    )
    missing = server.handle_request({
        "id": "2", "method": "rollback.restore",
        "params": {"session_id": "sid", "hash": "a" * 40},
    })
    # The handler refuses a hash the workspace does not own before asking the
    # manager, so only the code is contractual here.
    assert missing["result"]["success"] is False
    assert missing["result"]["code"] == "checkpoint_not_found"


# ── session.steer ────────────────────────────────────────────────────


def test_session_steer_forwards_and_echoes_reservation_id():
    calls = []
    steer_id = "00000000-0000-4000-8000-131f2cfdc809"

    class _Agent:
        def steer(self, text, *, ticket=None):
            calls.append((text, ticket))
            return True

    server._sessions["sid"] = _session(agent=_Agent(), running=True)
    try:
        resp = server.handle_request(
            {
                "id": "1",
                "method": "session.steer",
                "params": {
                    "session_id": "sid",
                    "text": "also inspect the audit log",
                    "steer_id": steer_id,
                },
            }
        )
    finally:
        server._sessions.pop("sid", None)

    assert resp["result"] == {
        "status": "queued",
        "text": "also inspect the audit log",
        "steer_id": steer_id,
    }
    assert calls == [("also inspect the audit log", steer_id)]


def test_session_steer_rejects_invalid_reservation_id():
    server._sessions["sid"] = _session(
        agent=types.SimpleNamespace(steer=lambda text, steer_id=None: True)
    )
    try:
        resp = server.handle_request(
            {
                "id": "1",
                "method": "session.steer",
                "params": {"session_id": "sid", "text": "hi", "steer_id": "not-a-uuid"},
            }
        )
    finally:
        server._sessions.pop("sid", None)

    assert resp["error"]["code"] == 4002


def test_session_info_includes_mcp_servers(monkeypatch):
    fake_status = [
        {"name": "github", "transport": "http", "tools": 12, "connected": True},
        {"name": "filesystem", "transport": "stdio", "tools": 4, "connected": True},
        {"name": "broken", "transport": "stdio", "tools": 0, "connected": False},
    ]
    fake_mod = types.ModuleType("tools.mcp_tool_discovery")
    fake_mod.get_mcp_status = lambda: fake_status
    monkeypatch.setitem(sys.modules, "tools.mcp_tool_discovery", fake_mod)

    info = server._session_info(types.SimpleNamespace(tools=[], model="", provider="openai-codex"))

    assert info["provider"] == "openai-codex"
    assert info["mcp_servers"] == fake_status


def test_session_info_reports_frozen_runtime_instructions_and_skills(monkeypatch):
    agent = types.SimpleNamespace(
        tools=[],
        model="",
        provider="openai-codex",
        _atum_instructions_runtime={
            "version": 1,
            "source": "soul",
            "sections": [
                {"heading": "Who you are", "level": 2, "body": "A careful editor."},
                {"heading": "Extra", "level": 3, "body": "Keep this section too."},
            ],
        },
        _atum_runtime_skills=None,
    )
    monkeypatch.setattr(
        "hermes_cli.banner.get_available_skills",
        lambda: {"work": ["research", "email"], "more": ["research"]},
    )

    first = server._session_info(agent)
    assert first["instructions_runtime"] == {
        "version": 1,
        "source": "soul",
        "sections": [
            {"heading": "Who you are", "level": 2, "body": "A careful editor."},
            {"heading": "Extra", "level": 3, "body": "Keep this section too."},
        ],
        "skills": ["email", "research"],
    }

    monkeypatch.setattr("hermes_cli.banner.get_available_skills", lambda: {"work": ["new"]})
    assert server._session_info(agent)["instructions_runtime"]["skills"] == [
        "email",
        "research",
    ]


def test_session_info_does_not_freeze_empty_skills_when_scan_fails(monkeypatch):
    agent = types.SimpleNamespace(
        tools=[],
        model="",
        provider="openai-codex",
        _atum_instructions_runtime={"version": 1, "source": "default", "sections": []},
        _atum_runtime_skills=None,
    )

    def fail_scan():
        raise OSError("scanner unavailable")

    monkeypatch.setattr("hermes_cli.banner.get_available_skills", fail_scan)
    assert server._session_info(agent)["instructions_runtime"]["skills"] is None
    assert agent._atum_runtime_skills is None

    monkeypatch.setattr(
        "hermes_cli.banner.get_available_skills", lambda: {"work": ["email"]}
    )
    assert server._session_info(agent)["instructions_runtime"]["skills"] == ["email"]


def test_session_info_omits_runtime_instructions_for_plain_hermes(monkeypatch):
    agent = types.SimpleNamespace(
        tools=[],
        model="",
        provider="openai-codex",
        _atum_instructions_runtime=None,
    )
    monkeypatch.setattr("hermes_cli.banner.get_available_skills", dict)

    assert "instructions_runtime" not in server._session_info(agent)


# ---------------------------------------------------------------------------
# History-mutating commands must reject while session.running is True.
# Without these guards, prompt.submit's post-run history write either
# clobbers the mutation (version matches) or silently drops the agent's
# output (version mismatch) — both produce UI<->backend state desync.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# session.interrupt must only cancel pending prompts owned by the calling
# session — it must not blast-resolve clarify/sudo/secret prompts on
# unrelated sessions sharing the same tui_gateway process.  Without
# session scoping the other sessions' prompts silently resolve to empty
# strings, unblocking their agent threads as if the user cancelled.
# ---------------------------------------------------------------------------






# ---------------------------------------------------------------------------
# /model switch and other agent-mutating commands must reject while the
# session is running.  agent.switch_model() mutates self.model, self.provider,
# self.base_url, self.client etc. in place — the worker thread running
# agent.run_conversation is reading those on every iteration.  Same class of
# bug as the session.undo / session.compress mid-run silent-drop; same fix
# pattern: reject with 4009 while running.
# ---------------------------------------------------------------------------


def test_config_set_model_defers_without_mutating_running_agent(monkeypatch):
    """/model via config.set must reject during an in-flight turn."""
    seen = {"called": False}

    def _fake_apply(sid, session, raw, **_kwargs):
        seen["called"] = True
        return {"value": raw, "warning": ""}

    monkeypatch.setattr(server, "_apply_model_switch", _fake_apply)

    server._sessions["sid"] = _session(running=True)
    try:
        resp = server.handle_request(
            {
                "id": "1",
                "method": "config.set",
                "params": {
                    "session_id": "sid",
                    "key": "model",
                    "value": "anthropic/claude-sonnet-4.6",
                },
            }
        )
        assert "result" in resp, resp
        assert server._sessions["sid"]["pending_model_switch"]["raw"] == "anthropic/claude-sonnet-4.6"
        assert not seen["called"], (
            "_apply_model_switch was called mid-turn — would race with "
            "the worker thread reading agent.model / agent.client"
        )
    finally:
        server._sessions.pop("sid", None)


def test_config_set_model_allowed_when_idle(monkeypatch):
    """Regression guard: idle sessions can still switch models."""
    seen = {"called": False}

    def _fake_apply(sid, session, raw, **_kwargs):
        seen["called"] = True
        return {"value": "newmodel", "warning": ""}

    monkeypatch.setattr(server, "_apply_model_switch", _fake_apply)

    server._sessions["sid"] = _session(running=False)
    try:
        resp = server.handle_request(
            {
                "id": "1",
                "method": "config.set",
                "params": {"session_id": "sid", "key": "model", "value": "newmodel"},
            }
        )
        assert resp.get("result")
        assert resp["result"]["value"] == "newmodel"
        assert seen["called"]
    finally:
        server._sessions.pop("sid", None)


_PARTIAL_FAKE_HISTORY = [
    {"role": "user", "content": "msg1"},
    {"role": "assistant", "content": "resp1"},
    {"role": "user", "content": "msg2"},
    {"role": "assistant", "content": "resp2"},
    {"role": "user", "content": "keep this"},
    {"role": "assistant", "content": "keep this too"},
]
_PARTIAL_COMPRESSED_HEAD = [
    {"role": "user", "content": "[summary]"},
    {"role": "assistant", "content": "ok"},
]


def _partial_compress_agent(compress_context_calls):
    """Agent stub whose _compress_context records (history, focus_topic)."""
    agent = types.SimpleNamespace(
        _cached_system_prompt=None,
        tools=None,
        session_id="s1",
        context_compressor=None,  # keep _get_usage on the simple path
    )

    def _fake_compress_context(history, sys, approx_tokens=0, focus_topic=None, **kw):
        compress_context_calls.append((list(history), focus_topic))
        return list(_PARTIAL_COMPRESSED_HEAD), {}

    agent._compress_context = _fake_compress_context
    return agent


# ---------------------------------------------------------------------------
# session.create / session.close race: fast /new churn must not orphan the
# slash_worker subprocess or the global approval-notify registration.
# ---------------------------------------------------------------------------




# --------------------------------------------------------------------------
# session.delete — TUI resume picker `d` key
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# model.options — curated-list parity with `hermes model` and classic /model
# --------------------------------------------------------------------------


def test_model_options_hides_unconfigured_providers_by_default(monkeypatch):
    from hermes_cli.inventory import ConfigContext

    calls = []

    monkeypatch.setattr(server, "_resolve_model", lambda: "")
    monkeypatch.setattr(
        "hermes_cli.inventory.load_picker_context",
        lambda: ConfigContext(
            current_provider="",
            current_model="",
            current_base_url="",
            user_providers={},
            custom_providers=[],
        ),
    )

    def _fake_build_models_payload(_ctx, **kwargs):
        calls.append(kwargs)
        return {"providers": [], "model": "", "provider": ""}

    monkeypatch.setattr(
        "hermes_cli.inventory.build_models_payload",
        _fake_build_models_payload,
    )

    resp = server._methods["model.options"](99, {"session_id": ""})
    assert "result" in resp, resp
    assert calls[-1]["explicit_only"] is False
    assert calls[-1]["include_unconfigured"] is False

    resp = server._methods["model.options"](
        100,
        {"session_id": "", "explicit_only": True},
    )
    assert "result" in resp, resp
    assert calls[-1]["explicit_only"] is True

    resp = server._methods["model.options"](
        101,
        {"session_id": "", "include_unconfigured": True},
    )
    assert "result" in resp, resp
    assert calls[-1]["include_unconfigured"] is True


# ---------------------------------------------------------------------------
# prompt.submit — auto-title
# ---------------------------------------------------------------------------


def test_model_options_refresh_allows_custom_provider_probes(monkeypatch):
    monkeypatch.setattr(
        server,
        "_load_cfg",
        lambda: {"providers": {}, "custom_providers": []},
    )
    with patch(
        "hermes_cli.model_switch.list_authenticated_providers",
        return_value=[],
    ) as listing:
        resp = server._methods["model.options"](78, {"session_id": "", "refresh": True})

    assert "result" in resp, resp
    assert listing.call_args.kwargs["probe_custom_providers"] is True
    assert listing.call_args.kwargs["probe_current_custom_provider"] is False


class _ImmediateThread:
    """Runs the target callable synchronously so assertions can follow."""

    def __init__(self, target=None, daemon=None):
        self._target = target

    def start(self):
        self._target()








# ── active live TUI sessions ─────────────────────────────────────────


# ── session.most_recent ──────────────────────────────────────────────


# ── verification.status ──────────────────────────────────────────────


# ── browser.manage ───────────────────────────────────────────────────


def _stub_urlopen(monkeypatch, *, ok: bool):
    """Patch urllib.request.urlopen used by browser.manage to short-circuit probes."""

    class _Resp:
        status = 200 if ok else 503

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def _opener(_url, timeout=2.0):
        if not ok:
            raise OSError("probe failed")
        return _Resp()

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", _opener)


def _stub_urlopen_capture(monkeypatch, *, ok: bool):
    urls: list[str] = []

    class _Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def _opener(url, timeout=2.0):
        urls.append(url)
        if not ok:
            raise OSError("probe failed")
        return _Resp()

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", _opener)
    return urls


def test_browser_manage_status_does_not_call_get_cdp_override(monkeypatch):
    """Regression guard for Copilot's "status must not block" review:
    status must NOT route through `_get_cdp_override`, which performs a
    `/json/version` HTTP probe with a multi-second timeout."""
    monkeypatch.setenv("BROWSER_CDP_URL", "http://127.0.0.1:9222")

    fake = types.SimpleNamespace(
        _get_cdp_override=lambda: pytest.fail(
            "_get_cdp_override must not run on /browser status (network I/O)"
        )
    )
    with patch.dict(sys.modules, {"tools.browser_tool": fake}):
        resp = server.handle_request(
            {"id": "1", "method": "browser.manage", "params": {"action": "status"}}
        )

    assert resp["result"]["connected"] is True


# ── config.get indicator normalization ───────────────────────────────


def test_config_get_indicator_returns_known_value_verbatim(monkeypatch):
    monkeypatch.setattr(
        server, "_load_cfg", lambda: {"display": {"tui_status_indicator": "emoji"}}
    )
    resp = server.handle_request(
        {"id": "1", "method": "config.get", "params": {"key": "indicator"}}
    )
    assert resp["result"] == {"value": "emoji"}


def test_config_get_indicator_falls_back_when_unset(monkeypatch):
    monkeypatch.setattr(server, "_load_cfg", lambda: {"display": {}})
    resp = server.handle_request(
        {"id": "1", "method": "config.get", "params": {"key": "indicator"}}
    )
    assert resp["result"] == {"value": "kaomoji"}


# ── config.set indicator validation ──────────────────────────────────


def test_config_set_indicator_falsy_non_string_surfaces_in_error(monkeypatch):
    """`0` / `False` / `[]` are not valid styles, but the error message
    must still tell the user what they sent — `value or ""` would have
    erased them to a blank string."""
    monkeypatch.setattr(server, "_write_config_key", lambda *a, **k: None)

    for bad in (0, False, []):
        resp = server.handle_request(
            {
                "id": "1",
                "method": "config.set",
                "params": {"key": "indicator", "value": bad},
            }
        )
        assert "error" in resp
        msg = resp["error"]["message"]
        assert "unknown indicator" in msg
        # The exact repr varies; `0`/`False` stringify with content,
        # `[]` becomes an empty list — what matters is the diagnostic
        # is no longer just `unknown indicator: ` with nothing after.
        assert msg.split("; ")[0] != "unknown indicator: ''"


def test_config_set_indicator_none_keeps_blank_repr(monkeypatch):
    """`None` is the genuine 'no value' case — empty raw is acceptable."""
    monkeypatch.setattr(server, "_write_config_key", lambda *a, **k: None)
    resp = server.handle_request(
        {
            "id": "1",
            "method": "config.set",
            "params": {"key": "indicator", "value": None},
        }
    )
    assert "error" in resp
    assert "unknown indicator: ''" in resp["error"]["message"]


# ── reload.env ───────────────────────────────────────────────────────


def test_reload_env_rpc_calls_hermes_cli_reload_env(monkeypatch):
    """reload.env mirrors classic CLI's `/reload` — re-reads ~/.hermes/.env
    into the gateway process and reports the count of vars updated."""
    calls = {"n": 0}

    def _fake_reload():
        calls["n"] += 1
        return 7

    fake = types.SimpleNamespace(reload_env=_fake_reload)
    with patch.dict(sys.modules, {"hermes_cli.config": fake}):
        resp = server.handle_request({"id": "1", "method": "reload.env", "params": {}})

    assert resp["result"] == {"updated": 7}
    assert calls["n"] == 1


# ── max_iterations config reading ─────────────────────────────────────


def _setup_make_agent_mocks(monkeypatch, cfg):
    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)
    monkeypatch.setattr(
        server, "_resolve_startup_runtime", lambda: ("test-model", None)
    )
    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        lambda requested=None, target_model=None: {
            "provider": None,
            "base_url": None,
            "api_key": None,
            "api_mode": None,
            "command": None,
            "args": None,
            "credential_pool": None,
        },
    )
    monkeypatch.setattr(server, "_load_tool_progress_mode", lambda: "off")
    monkeypatch.setattr(server, "_load_reasoning_config", lambda model="": None)
    monkeypatch.setattr(server, "_load_service_tier", lambda: None)
    def load_enabled_toolsets(_platform=None, *, matrix_discovery=False):
        assert matrix_discovery is False

    monkeypatch.setattr(server, "_load_enabled_toolsets", load_enabled_toolsets)
    monkeypatch.setattr(server, "_get_db", lambda: None)
    monkeypatch.setattr(server, "_agent_cbs", lambda sid: {})


def test_make_agent_waits_for_shared_mcp_discovery(monkeypatch):
    _setup_make_agent_mocks(monkeypatch, {})
    waited = []

    from hermes_cli import mcp_startup

    monkeypatch.setattr(
        mcp_startup,
        "wait_for_mcp_discovery",
        lambda timeout=0.75: waited.append(timeout),
    )

    with patch("run_agent.AIAgent"):
        server._make_agent("sid1", "key1")

    assert waited == [0.75]


def test_make_agent_defaults_to_unlimited(monkeypatch):
    from hermes_cli.config import TURN_LIMIT_UNLIMITED

    _setup_make_agent_mocks(monkeypatch, {})

    with patch("run_agent.AIAgent") as mock_agent:
        server._make_agent("sid1", "key1")

    assert mock_agent.call_args.kwargs["max_iterations"] == TURN_LIMIT_UNLIMITED


@pytest.mark.parametrize(
    "cfg, expected",
    [
        ({"agent": {"max_turns": None}}, "unlimited"),
        ({"agent": {"max_turns": "unlimited"}}, "unlimited"),
        ({"agent": {"max_turns": 0}}, "unlimited"),
        ({"agent": {"max_turns": -1}}, "unlimited"),
        ({"agent": {"max_turns": 30}}, 30),
        ({"agent": {"max_turns": 90}}, 90),
        ({"max_turns": "none"}, "unlimited"),
    ],
)
def test_make_agent_cap_follows_agent_max_turns(monkeypatch, cfg, expected):
    from hermes_cli.config import TURN_LIMIT_UNLIMITED

    _setup_make_agent_mocks(monkeypatch, cfg)

    with patch("run_agent.AIAgent") as mock_agent:
        server._make_agent("sid1", "key1")

    want = TURN_LIMIT_UNLIMITED if expected == "unlimited" else expected
    assert mock_agent.call_args.kwargs["max_iterations"] == want


def test_make_agent_cli_flag_env_beats_config(monkeypatch):
    monkeypatch.setenv("HERMES_TUI_MAX_TURNS", "12")
    _setup_make_agent_mocks(monkeypatch, {"agent": {"max_turns": 500}})

    with patch("run_agent.AIAgent") as mock_agent:
        server._make_agent("sid1", "key1")

    assert mock_agent.call_args.kwargs["max_iterations"] == 12


class _FakeAgentForBackground:
    base_url = None
    api_key = None
    provider = None
    api_mode = None
    acp_command = None
    acp_args = None
    model = "test-model"
    enabled_toolsets = None
    ephemeral_system_prompt = None
    providers_allowed = None
    providers_ignored = None
    providers_order = None
    provider_sort = None
    provider_require_parameters = False
    provider_data_collection = None
    reasoning_config = None
    service_tier = None
    request_overrides = {}
    _fallback_model = None


def test_background_agent_kwargs_has_no_private_turn_cap(monkeypatch):
    """With no agent.max_turns configured a /background task is as unlimited as the foreground agent."""
    from hermes_cli.config import TURN_LIMIT_UNLIMITED

    monkeypatch.setattr(server, "_load_cfg", dict)
    monkeypatch.delenv("HERMES_TUI_MAX_TURNS", raising=False)

    kwargs = server._background_agent_kwargs(_FakeAgentForBackground(), "task_1")

    assert kwargs["max_iterations"] == TURN_LIMIT_UNLIMITED
    assert kwargs["max_iterations"] == server._cfg_max_turns({})


def test_config_show_displays_nested_max_turns(monkeypatch):
    monkeypatch.setattr(
        server,
        "_load_cfg",
        lambda: {"agent": {"max_turns": 120}, "enabled_toolsets": [], "verbose": False},
    )
    monkeypatch.setattr(server, "_resolve_model", lambda: "test-model")

    resp = server.handle_request({"id": "1", "method": "config.show", "params": {}})
    sections = resp["result"]["sections"]
    agent_rows = next(
        section["rows"] for section in sections if section["title"] == "Agent"
    )

    assert ["Max Turns", "120"] in agent_rows


# --- image.attach_bytes / pdf.attach (remote-client byte upload) -------------

# Smallest valid 1x1 PNG, base64-encoded.
_PNG_1X1_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _attach_bytes_cli(monkeypatch):
    fake_cli = types.ModuleType("cli")
    fake_cli._IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
    monkeypatch.setitem(sys.modules, "cli", fake_cli)


def test_session_close_rpc_claims_then_tears_down(monkeypatch):
    seen = []
    claimed = {"session_key": "k"}
    monkeypatch.setattr(server, "_pop_session_by_id", lambda sid: seen.append(sid) or claimed)
    monkeypatch.setattr(
        server,
        "_teardown_popped_session",
        lambda session, *, end_reason: seen.append((session, end_reason)) or True,
    )
    resp = server.handle_request(
        {"id": "1", "method": "session.close", "params": {"session_id": "s9"}}
    )
    assert resp["result"]["closed"] is True
    assert seen == ["s9", (claimed, "tui_close")]


def _idle_evictable_session(now):
    """A session that satisfies every eviction precondition."""
    ready = threading.Event()
    ready.set()
    old = now - 10 * 3600  # well past the 6h TTL
    return {
        "running": False,
        "agent_ready": ready,
        "transport": server._detached_ws_transport,  # dead/detached
        "last_active": old,
        "created_at": old,
    }


# ── billing/subscription state + error serialization ─────────────────


class _BillingHeaders:
    def __init__(self, values):
        self._values = values

    def get(self, key):
        return self._values.get(key)


# ── subscription change RPCs (V3): preview + pending-change + upgrade ──


def _sub_rpc(method, params):
    # These RPCs are in _LONG_HANDLERS (pool-routed → dispatch returns None and the
    # worker writes via the transport), so drive the inline handler directly.
    return server.handle_request({"id": "1", "method": method, "params": params})["result"]


def test_subscription_resume(monkeypatch):
    import hermes_cli.nous_billing as nb

    monkeypatch.setattr(
        nb,
        "delete_subscription_pending_change",
        lambda: {"rail": "stripe", "cancelAtPeriodEnd": False, "message": "Resumed."},
    )
    res = _sub_rpc("subscription.resume", {})
    assert res["ok"] is True
    assert res["message"] == "Resumed."


# ── _get_usage active_subagents (TUI status-bar ⛓ indicator) ──────────────
# Mirrors the classic CLI status bar: _get_usage embeds a live count of
# background/async subagents from tools.async_delegation.active_count() so the
# Ink status bar can render ⛓ N. Source of truth is the same registry the CLI
# reads; the field rides the existing per-update `usage` payload.


class _BareAgent:
    """Agent stub with no compressor — exercises the active_subagents path
    independent of the `if comp:` context-percent block."""

    model = "x"


def test_get_usage_active_subagents_zero(monkeypatch):
    import tools.async_delegation as ad_mod
    monkeypatch.setattr(ad_mod, "active_count", lambda: 0)
    usage = server._get_usage(_BareAgent())
    assert usage["active_subagents"] == 0






# ---------------------------------------------------------------------------
# _resolve_runtime_with_fallback — init-time provider fallback
# ---------------------------------------------------------------------------

class TestResolveRuntimeWithFallback:
    """Tests for _resolve_runtime_with_fallback(): init-time provider
    fallback when the primary provider raises AuthError."""

    def test_primary_success_returns_runtime(self, monkeypatch):
        """When primary resolve succeeds, return its result directly."""
        expected = {"provider": "openai", "api_key": "tok"}
        monkeypatch.setattr(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            lambda **kw: expected,
        )
        resolution = server._resolve_runtime_with_fallback(
            {"requested": "openai"}
        )
        assert resolution.runtime == expected
        assert resolution.selected_model is None
        assert resolution.used_fallback is False

    def test_auth_error_tries_fallback_chain(self, monkeypatch):
        """On AuthError from primary, walk fallback_providers chain."""
        from hermes_cli.auth import AuthError

        fallback_runtime = {"provider": "deepseek", "api_key": "fb-tok"}

        def fake_resolve(**kwargs):
            if kwargs.get("requested") == "openai-codex":
                raise AuthError("No Codex credentials stored")
            return fallback_runtime

        monkeypatch.setattr(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            fake_resolve,
        )
        monkeypatch.setattr(
            server,
            "_load_fallback_model",
            lambda: [{"provider": "deepseek", "model": "deepseek-v4-pro"}],
        )
        resolution = server._resolve_runtime_with_fallback(
            {"requested": "openai-codex"},
        )
        assert resolution.runtime == fallback_runtime
        assert resolution.selected_model == "deepseek-v4-pro"
        assert resolution.used_fallback is True

    def test_auth_error_skips_provider_only_fallback(self, monkeypatch):
        """Auth fallback requires one complete provider/model pair."""
        from hermes_cli.auth import AuthError

        requested = []
        fallback_runtime = {"provider": "openrouter", "api_key": "fb-tok"}

        def fake_resolve(**kwargs):
            requested.append(kwargs.get("requested"))
            if kwargs.get("requested") == "openai-codex":
                raise AuthError("No Codex credentials stored")
            return fallback_runtime

        monkeypatch.setattr(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            fake_resolve,
        )
        monkeypatch.setattr(
            server,
            "_load_fallback_model",
            lambda: [
                {"provider": "anthropic"},
                {"provider": "openrouter", "model": "z-ai/glm-5.2"},
            ],
        )

        resolution = server._resolve_runtime_with_fallback(
            {"requested": "openai-codex"}
        )

        assert requested == ["openai-codex", "openrouter"]
        assert resolution.runtime == fallback_runtime
        assert resolution.selected_model == "z-ai/glm-5.2"
        assert resolution.used_fallback is True

    def test_fallback_entry_key_env_resolves_api_key(self, monkeypatch):
        """A fallback entry naming its key via key_env passes the resolved
        env value as explicit_api_key (#43861, @VrtxOmega)."""
        from hermes_cli.auth import AuthError

        monkeypatch.setenv("FB_TEST_KEY", "env-resolved-key")
        captured = {}
        fallback_runtime = {"provider": "openrouter", "api_key": "x"}

        def fake_resolve(**kwargs):
            if kwargs.get("requested") == "openai-codex":
                raise AuthError("No Codex credentials stored")
            captured.update(kwargs)
            return fallback_runtime

        monkeypatch.setattr(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            fake_resolve,
        )
        monkeypatch.setattr(
            server,
            "_load_fallback_model",
            lambda: [
                {
                    "provider": "openrouter",
                    "model": "z-ai/glm-5.2",
                    "key_env": "FB_TEST_KEY",
                }
            ],
        )
        resolution = server._resolve_runtime_with_fallback(
            {"requested": "openai-codex"}
        )
        assert resolution.used_fallback is True
        assert captured.get("explicit_api_key") == "env-resolved-key"

    def test_auth_error_all_fallbacks_fail_raises(self, monkeypatch):
        """When all fallbacks also fail, re-raise the original AuthError."""
        from hermes_cli.auth import AuthError

        def fake_resolve(**kwargs):
            raise AuthError("No credentials for " + str(kwargs.get("requested")))

        monkeypatch.setattr(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            fake_resolve,
        )
        monkeypatch.setattr(
            server,
            "_load_fallback_model",
            lambda: [{"provider": "deepseek", "model": "deepseek-v4-pro"}],
        )
        import pytest

        with pytest.raises(AuthError, match="No credentials for openai-codex"):
            server._resolve_runtime_with_fallback(
                {"requested": "openai-codex"},
            )

    def test_auth_error_skips_non_dict_entries(self, monkeypatch):
        """Fallback chain entries that are not dicts are skipped."""
        from hermes_cli.auth import AuthError

        fallback_runtime = {"provider": "anthropic", "api_key": "ant-tok"}

        def fake_resolve(**kwargs):
            if kwargs.get("requested") == "openai-codex":
                raise AuthError("No Codex credentials stored")
            return fallback_runtime

        monkeypatch.setattr(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            fake_resolve,
        )
        monkeypatch.setattr(
            server,
            "_load_fallback_model",
            lambda: [
                "invalid-string-entry",
                {"provider": "anthropic", "model": "claude-sonnet-4-6"},
            ],
        )
        resolution = server._resolve_runtime_with_fallback(
            {"requested": "openai-codex"},
        )
        assert resolution.runtime == fallback_runtime
        assert resolution.selected_model == "claude-sonnet-4-6"
        assert resolution.used_fallback is True

    def test_make_agent_uses_fallback_on_auth_error(self, monkeypatch):
        """Integration: _make_agent falls back to configured fallback
        provider when the primary provider raises AuthError."""
        import types

        from hermes_cli.auth import AuthError

        captured = {}
        fallback_runtime = {
            "provider": "deepseek",
            "api_key": "fb-tok",
            "base_url": "https://fallback.invalid/v1",
        }

        def fake_resolve(**kwargs):
            if kwargs.get("requested") in (None, "openai-codex"):
                raise AuthError("No Codex credentials stored")
            return fallback_runtime

        def fake_agent(**kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(model=kwargs.get("model"))

        monkeypatch.delenv("HERMES_MODEL", raising=False)
        monkeypatch.delenv("HERMES_INFERENCE_MODEL", raising=False)
        monkeypatch.delenv("HERMES_TUI_PROVIDER", raising=False)
        monkeypatch.setattr(
            server,
            "_load_cfg",
            lambda: {
                "model": {"default": "gpt-5.5", "provider": "openai-codex"},
                "fallback_providers": [
                    {"provider": "deepseek", "model": "deepseek-v4-pro"},
                ],
            },
        )
        monkeypatch.setattr(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            fake_resolve,
        )
        monkeypatch.setattr("run_agent.AIAgent", fake_agent)
        monkeypatch.setattr(
            server,
            "_load_enabled_toolsets",
            lambda *_args, matrix_discovery=False: ["file"],
        )
        monkeypatch.setattr(server, "_get_db", lambda: None)

        agent = server._make_agent(
            "sid",
            "session-key",
            model_override={
                "model": "gpt-5.5",
                "provider": "openai-codex",
                "base_url": "https://chatgpt.com/backend-api/codex",
                "api_key": "stale-codex-token",
            },
        )

        assert agent.model == "deepseek-v4-pro"
        assert captured["provider"] == "deepseek"
        assert captured["base_url"] == "https://fallback.invalid/v1"
        assert captured["api_key"] == "fb-tok"


# ---------------------------------------------------------------------------
# Streaming TTS — per-turn pipeline + barge-in
# ---------------------------------------------------------------------------

def _fake_tts_modules(monkeypatch, *, requirements=True, playback_stops=None, listen=None, transcribe=None):
    """Install lightweight tools.tts_tool / tools.voice_mode fakes."""
    started = {}

    def fake_stream(text_queue, stop, done, **_kw):
        started["queue"] = text_queue
        stop.wait(5)
        done.set()

    def default_listen(should_stop, capture=False, on_trigger=None, **_kw):
        return None if capture else False

    monkeypatch.setitem(
        sys.modules,
        "tools.tts_tool",
        types.SimpleNamespace(
            check_tts_requirements=lambda: requirements,
            stream_tts_to_speaker=fake_stream,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "tools.voice_mode",
        types.SimpleNamespace(
            stop_playback=lambda: (playback_stops.append(True) if playback_stops is not None else None),
            listen_for_speech=listen or default_listen,
            transcribe_recording=transcribe or (lambda path, model=None: {"success": True, "transcript": ""}),
        ),
    )
    return started
