"""Tests for the Mac device host (WS-4, S1 build plan §4).

The protocol, the forced command environment and the process-group bookkeeping run everywhere. The
end-to-end paths (Hermes's own tools inside a real ``sandbox-exec`` profile, Stop reaching a running
command, the sandboxed artifact read) need ``/usr/bin/sandbox-exec`` and run on macOS only.
"""

import base64
import json
import os
import struct
import sys
import threading
import time
import zlib

import pytest

from hermes_cli import atum_device_host as host_mod
from hermes_cli.atum_device_host import (
    HOST_CONFIG,
    DeviceHost,
    Transport,
    bound_screenshot,
    forced_command_env,
    snapshot_seal,
)

darwin_only = pytest.mark.skipif(sys.platform != "darwin", reason="Seatbelt sandbox-exec is macOS only")
ALLOW_ALL = "(version 1)\n(allow default)\n"


class _Wire:
    """Captures what the host writes and lets a test answer reverse requests."""

    def __init__(self):
        self.frames = []
        self.lock = threading.Lock()
        self.transport = Transport(self._write)

    def _write(self, text):
        with self.lock:
            self.frames.append(json.loads(text))

    def replies(self, request_id):
        with self.lock:
            return [f for f in self.frames if f.get("id") == request_id and ("result" in f or "error" in f)]

    def wait_reply(self, request_id, timeout=60.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = self.replies(request_id)
            if found:
                return found[0]
            time.sleep(0.02)
        raise AssertionError(f"no reply to {request_id}")

    def notifications(self, method):
        with self.lock:
            return [f for f in self.frames if f.get("method") == method and "id" not in f]


def _host():
    wire = _Wire()
    return DeviceHost(transport=wire.transport), wire


# --------------------------------------------------------------------------- protocol


def test_unknown_method_returns_method_not_found():
    host, wire = _host()
    host._dispatch({"jsonrpc": "2.0", "id": 1, "method": "nope", "params": {}})
    assert wire.wait_reply(1)["error"]["code"] == "method_not_found"


def test_shutdown_kills_every_group_then_acknowledges_and_exits(monkeypatch):
    host, wire = _host()
    killed = []
    monkeypatch.setattr(DeviceHost, "_kill_group", staticmethod(lambda pgid: killed.append(pgid) or True))
    host._pgids = {"a": [101], "b": [202, 203]}
    with pytest.raises(SystemExit):
        host._dispatch({"jsonrpc": "2.0", "id": 2, "method": "device.shutdown"})
    assert sorted(killed) == [101, 202, 203]
    assert wire.wait_reply(2)["result"] == {"stopping": True}


def test_stop_kills_the_named_command_and_remembers_it_for_late_spawns(monkeypatch):
    host, wire = _host()
    killed = []
    monkeypatch.setattr(DeviceHost, "_kill_group", staticmethod(lambda pgid: killed.append(pgid) or True))
    host._pgids = {"cmd-1": [4242], "cmd-2": [5252]}
    host._dispatch({"jsonrpc": "2.0", "id": 3, "method": "device.stop", "params": {"commandId": "cmd-1"}})
    assert wire.wait_reply(3)["result"] == {"killed": ["cmd-1"]}
    assert killed == [4242]

    # A group the stopped command spawns afterwards (a race with Stop) is killed at once, and main hears of it.
    host._spawned("cmd-1", 4343)
    assert killed == [4242, 4343]
    assert {"commandId": "cmd-1", "pgid": 4343} in [n["params"] for n in wire.notifications("device.spawned")]


def test_stop_without_a_command_stops_everything(monkeypatch):
    host, wire = _host()
    killed = []
    monkeypatch.setattr(DeviceHost, "_kill_group", staticmethod(lambda pgid: killed.append(pgid) or True))
    host._pgids = {"a": [1001], "b": [1002]}
    host._dispatch({"jsonrpc": "2.0", "id": 4, "method": "device.stop", "params": {}})
    assert wire.wait_reply(4)["result"] == {"killed": ["a", "b"]}
    assert sorted(killed) == [1001, 1002]


def test_reverse_request_round_trip_and_failure():
    wire = _Wire()
    answers = {}

    def ask():
        answers["value"] = wire.transport.request("device.gui_authorize", {"x": 1}, timeout=10)

    thread = threading.Thread(target=ask)
    thread.start()
    deadline = time.time() + 5
    while time.time() < deadline and not [f for f in wire.frames if f.get("method") == "device.gui_authorize"]:
        time.sleep(0.01)
    request = [f for f in wire.frames if f.get("method") == "device.gui_authorize"][0]
    assert isinstance(request["id"], str) and request["id"].startswith("h")
    assert wire.transport.resolve({"jsonrpc": "2.0", "id": request["id"], "result": {"allow": True}})
    thread.join(5)
    assert answers["value"] == {"allow": True}

    # When the pipe closes, a waiting request fails instead of hanging the worker.
    failed = {}

    def ask_again():
        try:
            wire.transport.request("device.gui_authorize", {}, timeout=10)
        except RuntimeError as exc:
            failed["code"] = str(exc)

    thread = threading.Thread(target=ask_again)
    thread.start()
    time.sleep(0.1)
    wire.transport.fail_all("device_host_closing")
    thread.join(5)
    assert failed["code"] == "device_host_closing"


def test_off_darwin_or_unsupported_work_reports_no_effect(monkeypatch):
    monkeypatch.setattr(host_mod, "_IS_DARWIN", False)
    host, wire = _host()
    host._dispatch({"jsonrpc": "2.0", "id": 5, "method": "device.exec", "params": {
        "commandId": "c", "tool": "terminal", "args": {"command": "echo hi"}, "profile": ALLOW_ALL}})
    assert wire.wait_reply(5)["result"]["state"] == "failed_no_effect"
    # Stop on an unsupported host must not access Unix-only process-group APIs.
    monkeypatch.setattr(host_mod.os, "getpgid", lambda _: pytest.fail("off-Darwin process-group access"), raising=False)
    assert DeviceHost._kill_group(4242) is False


def test_background_and_pty_terminal_work_is_refused_before_anything_runs(monkeypatch):
    monkeypatch.setattr(host_mod, "_IS_DARWIN", True)
    host, wire = _host()
    for request_id, flag in ((6, "background"), (7, "pty")):
        host._dispatch({"jsonrpc": "2.0", "id": request_id, "method": "device.exec", "params": {
            "commandId": f"c{request_id}", "tool": "terminal", "args": {"command": "sleep 1", flag: True},
            "profile": ALLOW_ALL}})
        result = wire.wait_reply(request_id)["result"]
        assert result["state"] == "failed_no_effect"
        assert "foreground" in result["result"]["error"]
    assert wire.notifications("device.spawned") == []


# --------------------------------------------------------------------------- the command environment


def test_forced_env_points_at_the_device_proxy_and_carries_the_agent_socket_only_when_granted():
    base = {"HTTPS_PROXY": "http://127.0.0.1:5555", "HTTP_PROXY": "http://127.0.0.1:5555",
            "ALL_PROXY": "http://127.0.0.1:5555", "GIT_SSH_COMMAND": "ssh -o ProxyCommand=x",
            "SSH_AUTH_SOCK": "/tmp/agent", "AWS_SECRET_ACCESS_KEY": "nope",
            "ATUM_DEVICE_PROXY_TOKEN": "synthetic", "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.proxyAuthMethod", "GIT_CONFIG_VALUE_0": "basic",
            "GIT_TEMPLATE_DIR": "/trusted/empty-template"}
    forced = forced_command_env(base)
    assert forced["https_proxy"] == forced["HTTPS_PROXY"] == "http://127.0.0.1:5555"
    assert forced["NO_PROXY"] == "localhost,127.0.0.1,::1"
    assert "SSH_AUTH_SOCK" not in forced
    assert "AWS_SECRET_ACCESS_KEY" not in forced
    for key in ("ATUM_DEVICE_PROXY_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
                "GIT_CONFIG_VALUE_0", "GIT_TEMPLATE_DIR"):
        assert forced[key] == base[key]
        assert forced_command_env(base, {key: "untrusted"})[key] == base[key]
    assert forced_command_env(base, {"SSH_AUTH_SOCK": "/private/tmp/launchd/Listeners"})["SSH_AUTH_SOCK"] == (
        "/private/tmp/launchd/Listeners")

    seal = snapshot_seal(forced, "cmd-1")
    assert "export HTTPS_PROXY='http://127.0.0.1:5555'" in seal
    assert "unset SSH_AUTH_SOCK" in seal
    assert seal.rstrip().endswith("export ATUM_DEVICE_OP='cmd-1'")


def test_the_host_home_turns_the_lsp_layer_off(tmp_path, monkeypatch):
    home = tmp_path / "device-home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    host, _ = _host()
    host._ensure_home()
    assert (home / "config.yaml").read_text() == HOST_CONFIG
    assert "enabled: false" in HOST_CONFIG
    assert oct((home / "config.yaml").stat().st_mode & 0o777) == "0o600"


# --------------------------------------------------------------------------- screenshots


def _noise_png(width, height):
    raw = b"".join(b"\x00" + os.urandom(width * 3) for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _capture(image_b64):
    return {"_multimodal": True, "content": [
        {"type": "text", "text": "capture"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}}], "meta": {"width": 10}}


def test_a_small_screenshot_is_left_alone():
    small = base64.b64encode(_noise_png(8, 8)).decode()
    assert bound_screenshot(_capture(small), limit=10_000)["content"][1]["image_url"]["url"].endswith(small)


@darwin_only
def test_an_oversized_screenshot_is_reencoded_to_fit_the_receipt():
    big = base64.b64encode(_noise_png(1600, 1000)).decode()
    out = bound_screenshot(_capture(big), limit=600_000)
    url = out["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,")
    assert len(url.split(",", 1)[1]) <= 600_000


def test_a_screenshot_that_cannot_fit_is_replaced_by_a_note(monkeypatch):
    monkeypatch.setattr(host_mod, "_shrink_image", lambda raw, limit: None)
    big = base64.b64encode(b"x" * 5000).decode()
    out = bound_screenshot(_capture(big), limit=100)
    assert out["content"][1]["type"] == "text"
    assert "too large" in out["content"][1]["text"]


# --------------------------------------------------------------------------- end to end on macOS


def _profile_denying(*paths):
    lines = [ALLOW_ALL.strip()]
    for path in paths:
        lines.append(f'(deny file-read* file-write* (subpath "{os.path.realpath(path)}"))')
    return "\n".join(lines) + "\n"


@pytest.fixture
def mac_host(tmp_path, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:59999")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:59999")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:59999")
    host, wire = _host()
    yield host, wire, tmp_path
    host._kill_everything()


@darwin_only
def test_terminal_runs_under_sandbox_exec_with_the_marker_and_the_device_proxy(mac_host):
    host, wire, tmp = mac_host
    host._dispatch({"jsonrpc": "2.0", "id": 10, "method": "device.exec", "params": {
        "commandId": "cmd-e2e", "tool": "terminal", "cwd": str(tmp), "timeoutMs": 60_000, "profile": ALLOW_ALL,
        "args": {"command": "echo hi; echo marker=$ATUM_DEVICE_OP; echo proxy=$HTTPS_PROXY; echo agent=${SSH_AUTH_SOCK:-none}"}}})
    reply = wire.wait_reply(10)["result"]
    assert reply["state"] == "completed"
    output = reply["result"]["output"]
    assert "hi" in output
    assert "marker=cmd-e2e" in output
    assert "proxy=http://127.0.0.1:59999" in output
    assert "agent=none" in output
    assert reply["result"]["exit_code"] == 0
    # Every spawn (the sandboxed login snapshot and the command) was reported with its process group.
    spawned = [n["params"] for n in wire.notifications("device.spawned") if n["params"]["commandId"] == "cmd-e2e"]
    assert spawned and all(isinstance(each["pgid"], int) for each in spawned)


def _run_file_tool(host, wire, *, request_id, tool, cwd, profile, args):
    host._dispatch({"jsonrpc": "2.0", "id": request_id, "method": "device.exec", "params": {
        "commandId": f"cmd-{tool}-{request_id}", "tool": tool, "cwd": str(cwd), "timeoutMs": 60_000,
        "profile": profile, "args": args}})
    return wire.wait_reply(request_id)["result"]


@pytest.mark.platforms("macos")
def test_read_file_uses_the_supplied_profile_for_allowed_and_denied_paths(mac_host):
    host, wire, tmp = mac_host
    secret_dir = tmp / "secret"
    secret_dir.mkdir()
    (secret_dir / "canary.txt").write_text("canary-secret\n")
    (tmp / "open.txt").write_text("open-text\n")
    profile = _profile_denying(secret_dir)

    allowed = _run_file_tool(
        host, wire, request_id=11, tool="read_file", cwd=tmp, profile=profile,
        args={"path": str(tmp / "open.txt")})
    denied = _run_file_tool(
        host, wire, request_id=12, tool="read_file", cwd=tmp, profile=profile,
        args={"path": str(secret_dir / "canary.txt")})

    assert "open-text" in json.dumps(allowed["result"])
    assert "canary-secret" not in json.dumps(denied["result"])


@pytest.mark.platforms("macos")
def test_write_file_uses_the_supplied_profile_for_allowed_and_denied_paths(mac_host):
    host, wire, tmp = mac_host
    secret_dir = tmp / "secret"
    secret_dir.mkdir()
    profile = _profile_denying(secret_dir)
    allowed_path = tmp / "open-write.txt"
    denied_path = secret_dir / "denied-write.txt"

    allowed = _run_file_tool(
        host, wire, request_id=15, tool="write_file", cwd=tmp, profile=profile,
        args={"path": str(allowed_path), "content": "allowed-write\n"})
    denied = _run_file_tool(
        host, wire, request_id=16, tool="write_file", cwd=tmp, profile=profile,
        args={"path": str(denied_path), "content": "denied-write\n"})

    assert allowed["state"] == "completed"
    assert allowed_path.read_text() == "allowed-write\n"
    assert denied["state"] == "completed"
    assert denied["result"].get("error")
    assert not denied_path.exists()


@pytest.mark.platforms("macos")
def test_patch_uses_the_supplied_profile_for_allowed_and_denied_paths(mac_host):
    host, wire, tmp = mac_host
    secret_dir = tmp / "secret"
    secret_dir.mkdir()
    allowed_path = tmp / "open-patch.txt"
    denied_path = secret_dir / "canary.txt"
    allowed_path.write_text("old-open\n")
    denied_path.write_text("canary-secret\n")
    profile = _profile_denying(secret_dir)

    allowed = _run_file_tool(
        host, wire, request_id=17, tool="patch", cwd=tmp, profile=profile,
        args={"mode": "replace", "path": str(allowed_path),
              "old_string": "old-open", "new_string": "new-open"})
    denied = _run_file_tool(
        host, wire, request_id=18, tool="patch", cwd=tmp, profile=profile,
        args={"mode": "replace", "path": str(denied_path),
              "old_string": "canary-secret", "new_string": "leaked-write"})

    assert allowed["state"] == "completed"
    assert allowed_path.read_text() == "new-open\n"
    assert denied["state"] == "completed"
    assert denied["result"].get("error")
    assert denied_path.read_text() == "canary-secret\n"


@pytest.mark.platforms("macos")
def test_search_files_uses_the_supplied_profile_for_allowed_and_denied_paths(mac_host):
    host, wire, tmp = mac_host
    open_dir = tmp / "open"
    secret_dir = tmp / "secret"
    open_dir.mkdir()
    secret_dir.mkdir()
    (open_dir / "visible.txt").write_text("open-search\n")
    (secret_dir / "canary.txt").write_text("canary-secret\n")
    profile = _profile_denying(secret_dir)

    allowed = _run_file_tool(
        host, wire, request_id=19, tool="search_files", cwd=tmp, profile=profile,
        args={"pattern": "*.txt", "target": "files", "path": str(open_dir)})
    denied = _run_file_tool(
        host, wire, request_id=20, tool="search_files", cwd=tmp, profile=profile,
        args={"pattern": "*.txt", "target": "files", "path": str(secret_dir)})

    assert "visible.txt" in json.dumps(allowed["result"])
    assert "canary.txt" not in json.dumps(denied["result"])


@darwin_only
def test_stop_reaches_a_command_that_is_still_running(mac_host):
    host, wire, tmp = mac_host
    started = time.time()
    host._dispatch({"jsonrpc": "2.0", "id": 13, "method": "device.exec", "params": {
        "commandId": "cmd-long", "tool": "terminal", "cwd": str(tmp), "timeoutMs": 120_000, "profile": ALLOW_ALL,
        "args": {"command": "sleep 60; echo finished"}}})

    deadline = time.time() + 30
    while time.time() < deadline and len([n for n in wire.notifications("device.spawned")
                                          if n["params"]["commandId"] == "cmd-long"]) < 2:
        time.sleep(0.05)

    host._dispatch({"jsonrpc": "2.0", "id": 14, "method": "device.stop", "params": {"commandId": "cmd-long"}})
    assert wire.wait_reply(14, timeout=5)["result"] == {"killed": ["cmd-long"]}
    reply = wire.wait_reply(13, timeout=30)["result"]
    assert time.time() - started < 45
    assert "finished" not in json.dumps(reply)


@darwin_only
def test_send_file_reads_inside_the_profile_and_caps_the_size(mac_host):
    host, wire, tmp = mac_host
    secret_dir = tmp / "secret"
    secret_dir.mkdir()
    (secret_dir / "id_canary").write_text("canary\n")
    (tmp / "hello.txt").write_text("hello world")
    (tmp / "link.txt").symlink_to(secret_dir / "id_canary")
    profile = _profile_denying(secret_dir)
    out_dir = tmp / "artifacts"
    out_dir.mkdir()

    cases = [(20, "hello.txt", None), (21, str(secret_dir / "id_canary"), None), (22, "link.txt", None),
             (23, "hello.txt", 4), (24, "missing.txt", None)]
    for request_id, path, limit in cases:
        params = {"commandId": f"cmd-send-{request_id}", "path": path, "cwd": str(tmp), "profile": profile,
                  "dest": str(out_dir / f"{request_id}.bin")}
        if limit:
            params["maxBytes"] = limit
        host._dispatch({"jsonrpc": "2.0", "id": request_id, "method": "device.read_artifact", "params": params})

    ok = wire.wait_reply(20)["result"]
    assert ok == {"state": "completed", "size": 11, "name": "hello.txt"}
    assert (out_dir / "20.bin").read_bytes() == b"hello world"
    assert oct((out_dir / "20.bin").stat().st_mode & 0o777) == "0o600"
    for request_id in (21, 22):
        assert wire.wait_reply(request_id)["result"] == {"state": "failed_no_effect", "error": "unreadable"}
        assert not (out_dir / f"{request_id}.bin").exists()
    assert wire.wait_reply(23)["result"] == {"state": "failed_no_effect", "error": "too_large"}
    assert wire.wait_reply(24)["result"] == {"state": "failed_no_effect", "error": "unreadable"}


@pytest.mark.parametrize("result", [
    {"error": "backend unavailable"},
    {"ok": False, "code": "no_target"},
    {"ok": False, "code": "human_has_control", "error": "human owns screen"},
])
def test_gui_tool_errors_report_no_effect(monkeypatch, result):
    from tools.computer_use import tool as cu

    host, _ = _host()
    monkeypatch.setattr(host_mod, "_IS_DARWIN", True)
    monkeypatch.setattr(cu, "handle_computer_use", lambda *a, **kw: json.dumps(result))
    try:
        assert host._computer_use({"commandId": "c", "grantId": "g", "args": {"action": "click"}}) == {
            "state": "failed_no_effect", "result": result,
        }
    finally:
        host._pool.shutdown(wait=True)


def test_gui_shutdown_fences_queued_calls_and_releases_sessions(monkeypatch):
    from tools.computer_use import tool as cu

    host, _ = _host()
    released = []
    host._gui_sessions.update(["one", "two"])
    monkeypatch.setattr(host_mod, "_IS_DARWIN", True)
    monkeypatch.setattr(cu, "release_computer_use_session", released.append)
    monkeypatch.setattr(cu, "handle_computer_use", lambda *a, **kw: pytest.fail("dispatched after shutdown"))
    try:
        host._kill_everything()
        host._release_gui({})
        assert sorted(released) == ["atum-device-gui-one", "atum-device-gui-two"]
        assert not host._gui_sessions
        assert host._computer_use({"commandId": "c", "grantId": "one"})["state"] == "failed_no_effect"
    finally:
        host._pool.shutdown(wait=True)


@pytest.mark.parametrize("grant_id", [None, "", "  ", 123, [], {}])
def test_release_gui_rpc_requires_one_grant(monkeypatch, grant_id):
    host, wire = _host()
    host._gui_sessions.update(["one", "two"])
    monkeypatch.setattr(host, "_release_gui", lambda _: pytest.fail("released sessions"))
    try:
        host._dispatch({"id": 90, "method": "device.release_gui", "params": {"grantId": grant_id}})
        assert wire.wait_reply(90)["error"]["code"] == "invalid_params"
        assert host._gui_sessions == {"one", "two"}
        assert not host._ended_gui_grants
    finally:
        host._pool.shutdown(wait=True)


@pytest.mark.parametrize("closing", ["shutdown", "eof"])
def test_closing_refuses_authorization_started_during_teardown(monkeypatch, closing):
    from tools.computer_use import tool as cu

    host, wire = _host()
    starting = threading.Event()
    closing_started = threading.Event()
    released = []
    host._gui_sessions.add("g")
    monkeypatch.setattr(host_mod, "_IS_DARWIN", True)
    monkeypatch.setattr(host, "_ensure_home", lambda: None)
    monkeypatch.setattr(cu, "release_computer_use_session", released.append)
    original_fail = wire.transport.fail_all

    def fail_all(code):
        original_fail(code)
        closing_started.set()

    def handle(args, *, session_id, action_authorizer):
        starting.set()
        assert closing_started.wait(2)
        assert not action_authorizer("click", args, "click", object())
        return json.dumps({"error": "denied by device host"})

    monkeypatch.setattr(wire.transport, "fail_all", fail_all)
    monkeypatch.setattr(cu, "handle_computer_use", handle)
    worker = threading.Thread(target=lambda: host._computer_use({"commandId": "c", "grantId": "g", "args": {"action": "click"}}))
    worker.start()
    assert starting.wait(2)
    try:
        if closing == "shutdown":
            with pytest.raises(SystemExit):
                host._dispatch({"id": 91, "method": "device.shutdown"})
        else:
            host.serve(iter(()))
        worker.join(2)
        assert not worker.is_alive()
        assert released == ["atum-device-gui-g"]
        assert not [f for f in wire.frames if f.get("method") == "device.gui_authorize"]
        with pytest.raises(RuntimeError, match="device_host_closing"):
            wire.transport.request("device.gui_authorize", {}, timeout=90)
    finally:
        host._pool.shutdown(wait=True)


def test_focus_raise_target_keeps_requested_app():
    assert DeviceHost._gui_target("bring_to_front", {"action": "focus_app", "app": "Terminal"}, object()) == {
        "requestedApp": "Terminal",
    }


def test_gui_dispatch_exception_is_unknown_after_input_may_have_landed(monkeypatch):
    from tools.computer_use import tool as cu
    from contextlib import contextmanager

    host, _ = _host()
    monkeypatch.setattr(host_mod, "_IS_DARWIN", True)

    @contextmanager
    def backend(*args, **kwargs):
        yield object()

    def dispatch(*args, **kwargs):
        raise TimeoutError("driver timed out after posting click")

    monkeypatch.setattr(cu, "_backend_for_call", backend)
    monkeypatch.setattr(cu, "_dispatch", dispatch)
    monkeypatch.setattr(host, "_gui_authorize", lambda *args: {"allow": True})
    try:
        result = host._computer_use({"commandId": "c", "grantId": "g", "args": {"action": "click", "coordinate": [1, 2]}})
        assert result["state"] == "unknown"
        assert result["result"]["error"].startswith("click failed:")
    finally:
        host._pool.shutdown(wait=True)
