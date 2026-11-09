"""Regression tests: every remaining cua-driver spawn site must sanitize the
subprocess environment.

PR #58889 fixed the CLI-fallback transport; review of that fix found four
sibling spawn sites still handing the third-party ``cua-driver`` binary the
full parent environment (provider API keys included):

- ``cua_backend._resolve_mcp_invocation`` (``cua-driver manifest``) — no
  ``env=`` at all
- ``cua_backend.cua_driver_update_check`` (``check-update --json``) —
  telemetry env but no secret sanitization
- ``doctor._drive_health_report`` (``<binary> mcp``) — telemetry env only
- ``permissions._run`` (every permission probe) — telemetry env only
"""

import json
import os
from unittest.mock import MagicMock

import pytest

SECRET = "sk-super-secret-should-not-leak"


def _fake_completed_process(stdout: str) -> MagicMock:
    proc = MagicMock()
    proc.stdout = stdout
    proc.stderr = ""
    proc.returncode = 0
    return proc


def _capture_run(captured, stdout=""):
    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env")
        return _fake_completed_process(stdout)
    return fake_run


def _assert_sanitized(captured):
    env = captured["env"]
    assert env is not None, "subprocess must receive an explicit env="
    assert "ANTHROPIC_API_KEY" not in env
    # Sanitization filters secrets, not everything — ordinary vars survive.
    # Native subprocess sanitization may prepend the active Hermes runtime's
    # bin directory; the caller's ordinary PATH entries must remain intact.
    assert env.get("PATH", "").endswith("/usr/bin:/bin")
    # Confirms the telemetry helper still ran (default: telemetry disabled).
    assert env.get("CUA_DRIVER_RS_TELEMETRY_ENABLED") == "0"


def test_resolve_mcp_invocation_sanitizes_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.delenv("HERMES_CUA_TELEMETRY", raising=False)

    from tools.computer_use import cua_backend, cua_backend_driver

    captured = {}
    manifest = json.dumps({"mcp_invocation": {"command": "cua-driver", "args": ["mcp"]}})
    monkeypatch.setattr(
        cua_backend.subprocess, "run", _capture_run(captured, stdout=manifest)
    )

    cmd, args = cua_backend_driver._resolve_mcp_invocation("cua-driver")
    assert cmd == "cua-driver"
    _assert_sanitized(captured)


def test_runtime_contract_check_sanitizes_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.delenv("HERMES_CUA_TELEMETRY", raising=False)

    from tools.computer_use import cua_backend, cua_backend_driver

    captured = {}
    payload = json.dumps({"binary_version": "1.0.0"})
    monkeypatch.setattr(
        cua_backend_driver, "resolve_cua_driver_cmd", lambda *a, **k: "cua-driver"
    )
    monkeypatch.setattr(
        cua_backend.subprocess, "run", _capture_run(captured, stdout=payload)
    )

    cua_backend_driver.cua_driver_runtime_contract_status("cua-driver")
    _assert_sanitized(captured)


def test_permissions_run_sanitizes_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.delenv("HERMES_CUA_TELEMETRY", raising=False)

    from tools.computer_use import permissions

    captured = {}
    monkeypatch.setattr(
        permissions.subprocess, "run", _capture_run(captured, stdout="{}")
    )

    permissions._run("cua-driver", "doctor", "--json", timeout=1.0)
    _assert_sanitized(captured)


def test_doctor_sanitized_env_helper(monkeypatch):
    """_drive_health_report spawns via Popen; assert the env helper it uses
    strips secrets (mocking the whole JSON-RPC handshake is not worth it)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.delenv("HERMES_CUA_TELEMETRY", raising=False)

    from tools.computer_use import doctor
    env = doctor._sanitized_cua_env()
    assert "ANTHROPIC_API_KEY" not in env
    assert env.get("PATH", "").endswith("/usr/bin:/bin")
    assert env.get("CUA_DRIVER_RS_TELEMETRY_ENABLED") == "0"


@pytest.mark.parametrize("surface", ["runtime", "doctor", "permissions"])
def test_macos_driver_uses_os_home_without_changing_terminal_isolation(monkeypatch, tmp_path, surface):
    import hermes_constants
    from tools.computer_use import cua_backend, doctor, permissions
    from tools.environments.local import _sanitize_subprocess_env

    profile = tmp_path / ("isolated-profile-" * 8)
    profile_home = profile / "home"
    profile_home.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(profile_home))
    monkeypatch.setenv("HERMES_HOME", str(profile))
    monkeypatch.setenv("TERMINAL_HOME_MODE", "profile")
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", SECRET)
    monkeypatch.setattr(cua_backend.sys, "platform", "darwin")
    monkeypatch.setattr(hermes_constants, "get_real_home", lambda _env=None: "/home/example")

    helpers = {
        "runtime": lambda: _sanitize_subprocess_env(cua_backend.cua_driver_child_env()),
        "doctor": doctor._sanitized_cua_env,
        "permissions": permissions._child_env,
    }
    env = helpers[surface]()
    assert env["HOME"] == "/home/example"
    assert env["HERMES_HOME"] == str(profile)
    assert "ANTHROPIC_API_KEY" not in env
    assert "HERMES_DASHBOARD_SESSION_TOKEN" not in env
    # This override belongs to the driver child, not the gateway or its shell.
    assert _sanitize_subprocess_env(dict(os.environ))["HOME"] == str(profile_home)
