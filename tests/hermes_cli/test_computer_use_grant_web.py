"""The fixed-name OS permission action must keep its live process custody."""

from types import SimpleNamespace
from unittest.mock import Mock
import json
import os
from pathlib import Path
import sys
import time

import pytest


@pytest.fixture
def grant_client(monkeypatch, _isolate_hermes_home):
    from fastapi.testclient import TestClient
    from hermes_cli import web_server
    from hermes_cli import web_server_gateway as gateway
    from hermes_cli.web_routers import _common
    from hermes_cli.web_routers import tools as tools_router

    monkeypatch.setattr(tools_router, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(gateway, "_ACTION_PROCS", {})
    monkeypatch.setattr(gateway, "_ACTION_RESULTS", {})
    monkeypatch.setattr(gateway, "_ACTION_COMMANDS", {})
    monkeypatch.setattr(web_server, "_SESSION_TOKEN", "synthetic-cua-grant-test")
    with TestClient(web_server.app, base_url="http://127.0.0.1",
                    headers={"Authorization": "Bearer synthetic-cua-grant-test"}) as client:
        yield client, tools_router, gateway, _common


def test_a_live_grant_cannot_be_replaced_or_respawned(grant_client, monkeypatch):
    client, _router, gateway, _profiles = grant_client
    existing = SimpleNamespace(pid=123, poll=lambda: None)
    gateway._ACTION_PROCS["computer-use-grant"] = existing
    spawn = Mock()
    monkeypatch.setattr(gateway, "_spawn_hermes_action", spawn)

    response = client.post("/api/tools/computer-use/permissions/grant?profile=default")

    assert response.status_code == 409
    spawn.assert_not_called()
    assert gateway._ACTION_PROCS["computer-use-grant"] is existing


@pytest.mark.skipif(sys.platform != "darwin", reason="Real macOS CLI permission branch")
def test_actual_selected_profile_cli_invokes_only_the_synthetic_driver(
    grant_client, monkeypatch, tmp_path
):
    """Endpoint -> detached Hermes CLI -> synthetic driver, never macOS TCC."""
    client, router, gateway, _profiles = grant_client
    monkeypatch.setattr(router, "sys", sys)
    monkeypatch.setattr(gateway, "_ACTION_LOG_DIR", tmp_path / "logs")
    base_home = Path(os.environ["HERMES_HOME"])
    selected_home = base_home / "profiles" / "selected-agent"
    selected_home.mkdir(parents=True)
    (selected_home / "config.yaml").write_text("{}\n")
    sentinel = tmp_path / "driver-call.json"
    release = tmp_path / "release"
    driver = tmp_path / "synthetic-cua-driver"
    driver.write_text(
        f"#!{sys.executable}\n"
        "import json, os, pathlib, sys, time\n"
        f"pathlib.Path({str(sentinel)!r}).write_text(json.dumps({{"
        "'home': os.environ.get('HERMES_HOME'), 'args': sys.argv[1:] }))\n"
        f"release = pathlib.Path({str(release)!r})\n"
        "deadline = time.monotonic() + 15\n"
        "while not release.exists() and time.monotonic() < deadline: time.sleep(0.02)\n"
        "sys.exit(0 if release.exists() else 2)\n"
    )
    driver.chmod(0o700)
    monkeypatch.setenv("HERMES_CUA_DRIVER_CMD", str(driver))
    response = client.post("/api/tools/computer-use/permissions/grant?profile=selected-agent")
    assert response.status_code == 200
    start = response.json()
    proc = gateway._ACTION_PROCS["computer-use-grant"]
    try:
        deadline = time.monotonic() + 10
        while not sentinel.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert sentinel.exists(), (tmp_path / "logs" / "computer-use-grant.log").read_text()
        assert json.loads(sentinel.read_text()) == {
            "home": str(selected_home), "args": ["permissions", "grant"]
        }
        assert start == {"ok": True, "pid": proc.pid, "name": "computer-use-grant"}
        live = client.get("/api/actions/computer-use-grant/status?lines=1").json()
        assert live["running"] is True and live["pid"] == proc.pid
        duplicate = client.post("/api/tools/computer-use/permissions/grant?profile=selected-agent")
        assert duplicate.status_code == 409
        assert gateway._ACTION_PROCS["computer-use-grant"] is proc
        release.touch()
        assert proc.wait(timeout=10) == 0
        terminal = client.get("/api/actions/computer-use-grant/status?lines=1").json()
        assert terminal["running"] is False
        assert terminal["pid"] == start["pid"] and terminal["exit_code"] == 0
    finally:
        release.touch()
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=10)
def test_a_finished_grant_allows_a_fresh_request_for_the_selected_profile(grant_client, monkeypatch):
    client, _router, gateway, profiles = grant_client
    gateway._ACTION_PROCS["computer-use-grant"] = SimpleNamespace(pid=123, poll=lambda: 0)
    profile_args = Mock(return_value=["--profile", "agent-a"])
    spawn = Mock(return_value=SimpleNamespace(pid=456))
    monkeypatch.setattr(profiles, "_profile_cli_args", profile_args)
    monkeypatch.setattr(gateway, "_spawn_hermes_action", spawn)

    response = client.post("/api/tools/computer-use/permissions/grant?profile=agent-a")

    assert response.status_code == 200
    profile_args.assert_called_once_with("agent-a")
    spawn.assert_called_once_with(
        ["--profile", "agent-a", "computer-use", "permissions", "grant"],
        "computer-use-grant",
    )
    assert response.json() == {"ok": True, "pid": 456, "name": "computer-use-grant"}


def test_non_mac_grants_never_spawn(grant_client, monkeypatch):
    client, router, gateway, _profiles = grant_client
    monkeypatch.setattr(router, "sys", SimpleNamespace(platform="linux"))
    spawn = Mock()
    monkeypatch.setattr(gateway, "_spawn_hermes_action", spawn)

    response = client.post("/api/tools/computer-use/permissions/grant?profile=default")

    assert response.status_code == 400
    spawn.assert_not_called()
