"""The Mac device host for cloud-mode agent reach-down (S1 build plan §4, WS-4).

``apps/desktop/electron/matrix/device/host.ts`` spawns and owns this process **through the disclaim
launcher**, so this host and everything it starts answer to TCC for themselves and never inherit
Atum's Accessibility/Automation grants. It speaks newline-delimited JSON-RPC over stdin/stdout (no
socket, no port: the only way in is the pipe its parent holds).

What it runs, always for a command Electron main has already admitted:

* ``device.exec``: Hermes's own ``terminal``/``read_file``/``write_file``/``patch``/``search_files``
  inside a ``SeatbeltEnvironment`` (a ``LocalEnvironment`` whose every spawn, including the login
  snapshot, goes through ``sandbox-exec -f <per-command profile>``), pre-registered in
  ``tools.terminal_tool._active_environments`` so the file tools resolve to it unchanged.
* ``device.read_artifact``: ``device_send_file``'s read, done by ``cat`` under the same profile, so a
  protected file can never be sent; the bytes land in a file main hashes and transfers.
* ``device.computer_use``: Hermes's own ``computer_use`` (its CuaDriver session is a child of this
  host, not of Hermes), with an approval callback that asks main's GUI broker before every mutating
  action (``device.gui_authorize``, a reverse request).
* ``device.sudo``: the owner-approved exact argv under ``sudo -S -k`` with the password on stdin. macOS
  refuses setuid binaries inside any Seatbelt sandbox, so this one path runs outside the profile.

Every spawn is reported at once as ``device.spawned {commandId, pgid}``: main kills those process
groups itself on Stop, and keeps working even when this host is wedged. Requests run on worker
threads, so ``device.stop`` is served while commands are still running.

Authority (admission, approvals, grants, the GUI broker's decisions, the ledger) lives in Electron
main. This host only runs what it is handed and never decides anything on its own.
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.util
import json
import os
import plistlib
import re
import signal
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any, Callable, Dict, List, Optional

_IS_DARWIN = sys.platform == "darwin"
_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
_SUDO = "/usr/bin/sudo"

FILE_TOOLS = ("terminal", "read_file", "write_file", "patch", "search_files")
MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
#: A screenshot's base64 must leave room in a 1 MiB Receipt frame for the rest of the result.
MAX_SCREENSHOT_B64 = 640 * 1024
MAX_SUDO_OUTPUT = 64 * 1024
#: How long a GUI action waits for main's broker (an upload approval can take up to its 60 s).
GUI_AUTHORIZE_TIMEOUT = 90.0

#: The host's own Hermes configuration. The LSP layer is off because language servers run in this
#: host process, outside the sandbox, on files the agent wrote (a project's tsconfig plugin would be
#: code running unsandboxed).
HOST_CONFIG = "# Written by the Atum device host; agent commands cannot change it.\nlsp:\n  enabled: false\n"

_NOT_SUPPORTED_IN_S1 = ("background", "pty", "notify_on_complete", "watch_patterns")


def _log(code: str) -> None:
    # stderr only, and code-only: never command text or output, which can carry user data.
    sys.stderr.write(f"[atum-device-host] {code}\n")
    sys.stderr.flush()


class Transport:
    """Newline-delimited JSON-RPC over a text stream, shared by many threads.

    Requests from main carry numeric ids. The host's own reverse requests carry string ids
    (``h1``, ``h2``, ...) and are answered by main on the same pipe.
    """

    def __init__(self, write: Callable[[str], None]):
        self._write = write
        self._lock = threading.Lock()
        self._next = 0
        self._waiting: dict[str, Future] = {}
        self._closed: Optional[str] = None

    def emit(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False)
        with self._lock:
            self._write(line + "\n")

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.emit({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: dict[str, Any], timeout: float) -> Any:
        with self._lock:
            if self._closed is not None:
                raise RuntimeError(self._closed)
            self._next += 1
            request_id = f"h{self._next}"
            future: Future = Future()
            self._waiting[request_id] = future
        self.emit({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        try:
            return future.result(timeout=timeout)
        finally:
            with self._lock:
                self._waiting.pop(request_id, None)

    def resolve(self, message: dict[str, Any]) -> bool:
        """Settle a reverse request from main's answer. False when the message is not one."""
        request_id = message.get("id")
        if not isinstance(request_id, str) or ("result" not in message and "error" not in message):
            return False
        with self._lock:
            future = self._waiting.get(request_id)
        if future is None:
            return True
        if "error" in message:
            future.set_exception(RuntimeError(str((message.get("error") or {}).get("code", "error"))))
        else:
            future.set_result(message.get("result"))
        return True

    def fail_all(self, code: str) -> None:
        with self._lock:
            self._closed = code
            waiting = list(self._waiting.values())
        for future in waiting:
            if not future.done():
                future.set_exception(RuntimeError(code))


# --------------------------------------------------------------------------- environment


def forced_command_env(base: dict[str, str], extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    """The variables every device command gets on top of its shell environment.

    The proxy settings point at the device egress proxy (so a proxy the owner's own profile sets cannot
    route agent traffic around it), loopback is reached directly, and ``SSH_AUTH_SOCK`` is present only
    when this one command's grant includes the SSH agent (``extra``).
    """
    forced: dict[str, str] = {}
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"):
        value = base.get(key)
        if value:
            forced[key] = value
            forced[key.lower()] = value
    forced["NO_PROXY"] = forced["no_proxy"] = "localhost,127.0.0.1,::1"
    if base.get("GIT_SSH_COMMAND"):
        forced["GIT_SSH_COMMAND"] = base["GIT_SSH_COMMAND"]
    for key in ("ATUM_DEVICE_PROXY_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
                "GIT_CONFIG_VALUE_0", "GIT_TEMPLATE_DIR"):
        if base.get(key):
            forced[key] = base[key]
    for key, value in (extra or {}).items():
        if key == "SSH_AUTH_SOCK" and value:
            forced[key] = value
    return forced


def _shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def snapshot_seal(forced: dict[str, str], command_id: str) -> str:
    """Shell lines appended to the login snapshot, so they win over whatever the profile exported."""
    lines = ["# atum device: forced after the owner's profile"]
    for key in sorted(forced):
        lines.append(f"export {key}={_shell_quote(forced[key])}")
    if "SSH_AUTH_SOCK" not in forced:
        lines.append("unset SSH_AUTH_SOCK")
    lines.append(f"export ATUM_DEVICE_OP={_shell_quote(command_id)}")
    return "\n".join(lines) + "\n"


def make_seatbelt_environment(
    profile_path: str,
    command_id: str,
    cwd: str,
    timeout: int,
    extra_env: Optional[dict[str, str]] = None,
    on_spawn: Optional[Callable[[int], None]] = None,
):
    """Build the per-command ``SeatbeltEnvironment``. Imported lazily: macOS hosts only."""
    from tools.environments.base_output import _pipe_stdin
    from tools.environments.local import (
        LocalEnvironment,
        _find_bash,
        _make_run_env,
        _prepend_shell_init,
        _resolve_safe_cwd,
        _resolve_shell_init_files,
    )

    class SeatbeltEnvironment(LocalEnvironment):
        """``LocalEnvironment`` whose every bash spawn runs under the per-command Seatbelt profile.

        Overriding ``_run_bash`` (rather than patching an instance after construction) matters: the
        constructor runs ``init_session``'s login shell, and that must already be sandboxed.
        """

        # Native local-file fast paths run in the host Python process and would
        # bypass this environment's Seatbelt profile.  The native file layer
        # treats this generic capability flag as requiring backend execution.
        hermes_file_tools_shell_only = True

        def __init__(self) -> None:
            self.atum_profile_path = profile_path
            self.atum_command_id = command_id
            self._hermes_force_shell_file_ops = True
            self.atum_forced = forced_command_env(dict(os.environ), extra_env)
            self.atum_pgids: list[int] = []
            super().__init__(cwd=cwd, timeout=timeout, env={"ATUM_DEVICE_OP": command_id})
            self._atum_seal_snapshot()

        def _atum_seal_snapshot(self) -> None:
            path = getattr(self, "_snapshot_path", None)
            if not getattr(self, "_snapshot_ready", False) or not path or not os.path.isfile(path):
                return
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(snapshot_seal(self.atum_forced, self.atum_command_id))

        def _run_bash(self, cmd_string: str, *, login: bool = False, timeout: int = 120,
                      stdin_data: Optional[str] = None) -> subprocess.Popen:
            bash = _find_bash()
            if login:
                init_files = _resolve_shell_init_files()
                if init_files:
                    cmd_string = _prepend_shell_init(cmd_string, init_files)
            inner = [bash, "-l", "-c", cmd_string] if login else [bash, "-c", cmd_string]
            run_env = _make_run_env(self.env)
            run_env.pop("SSH_AUTH_SOCK", None)
            run_env.update(self.atum_forced)
            run_env["ATUM_DEVICE_OP"] = self.atum_command_id
            self.cwd = _resolve_safe_cwd(self.cwd)
            # A new session and process group for every spawn: Seatbelt's signal/process-info denies
            # treat everything outside the command's own group as "others", and Stop kills the group.
            proc = subprocess.Popen(
                [_SANDBOX_EXEC, "-f", self.atum_profile_path, *inner],
                text=True,
                env=run_env,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
                start_new_session=True,
                cwd=self.cwd,
            )
            try:
                pgid = os.getpgid(proc.pid)
                proc._hermes_pgid = pgid  # type: ignore[attr-defined]
                self.atum_pgids.append(pgid)
                if on_spawn is not None:
                    on_spawn(pgid)
            except (ProcessLookupError, OSError):
                pass
            if stdin_data is not None:
                _pipe_stdin(proc, stdin_data)
            return proc

    return SeatbeltEnvironment()


# --------------------------------------------------------------------------- GUI targets

_libproc = None


def process_path(pid: int) -> str:
    """The executable path of a process (``proc_pidpath``), or "" when it cannot be read."""
    global _libproc
    if not _IS_DARWIN or not isinstance(pid, int) or pid <= 0:
        return ""
    try:
        if _libproc is None:
            _libproc = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib")
        buffer = ctypes.create_string_buffer(4096)
        length = _libproc.proc_pidpath(pid, buffer, ctypes.sizeof(buffer))
        return buffer.value.decode("utf-8", "replace") if length > 0 else ""
    except Exception:
        return ""


def bundle_id_of(executable: str) -> str:
    """The CFBundleIdentifier of the app an executable lives in, or ""."""
    match = re.match(r"^(.*?\.(?:app|bundle))/", executable or "")
    if not match:
        return ""
    try:
        plist_path = os.path.join(match.group(1), "Contents", "Info.plist")
        with open(plist_path, "rb") as handle:
            value = plistlib.load(handle).get("CFBundleIdentifier", "")
            return value if isinstance(value, str) else ""
    except Exception:
        return ""


def clipboard_bytes() -> int:
    """Size of the text on the pasteboard (a paste is an upload when it is large)."""
    try:
        out = subprocess.run(["/usr/bin/pbpaste"], capture_output=True, timeout=5, check=False).stdout
        return len(out)
    except Exception:
        return 0


def bound_screenshot(result: Any, limit: int = MAX_SCREENSHOT_B64) -> Any:
    """Keep a multimodal capture inside the Receipt frame: re-encode an oversized image as a
    smaller JPEG (``sips``), and drop it, saying so, when even that does not fit."""
    if not isinstance(result, dict) or not result.get("_multimodal"):
        return result
    content = result.get("content")
    if not isinstance(content, list):
        return result
    for part in content:
        url = ((part or {}).get("image_url") or {}).get("url") if isinstance(part, dict) else None
        if not isinstance(url, str) or not url.startswith("data:"):
            continue
        _header, _, data = url.partition(",")
        if len(data) <= limit:
            continue
        smaller = _shrink_image(base64.b64decode(data), limit)
        if smaller is not None:
            part["image_url"]["url"] = "data:image/jpeg;base64," + smaller
        else:
            part.clear()
            part.update({"type": "text", "text": "(screenshot too large to send from this Mac; use mode='ax')"})
    return result


def _shrink_image(raw: bytes, limit: int) -> Optional[str]:
    if not _IS_DARWIN:
        return None
    with tempfile.TemporaryDirectory(prefix="atum-shot-") as work:
        source = os.path.join(work, "in")
        with open(source, "wb") as handle:
            handle.write(raw)
        for max_side, quality in ((1456, 70), (1200, 60), (960, 50), (720, 45)):
            target = os.path.join(work, f"out-{max_side}.jpg")
            done = subprocess.run(
                ["/usr/bin/sips", "-Z", str(max_side), "-s", "format", "jpeg", "-s", "formatOptions", str(quality),
                 source, "--out", target],
                capture_output=True, timeout=30, check=False,
            )
            if done.returncode != 0 or not os.path.isfile(target):
                return None
            with open(target, "rb") as handle:
                encoded = base64.b64encode(handle.read()).decode("ascii")
            if len(encoded) <= limit:
                return encoded
    return None


# --------------------------------------------------------------------------- the host


class DeviceHost:
    """The JSON-RPC loop: run admitted commands under their profiles, report and kill their groups."""

    def __init__(self, transport: Optional[Transport] = None, workers: int = 8) -> None:
        self.transport = transport or Transport(self._stdout_write)
        self._lock = threading.Lock()
        self._pgids: dict[str, list[int]] = {}
        self._cancelled: set = set()
        self._gui_lock = threading.Lock()
        self._gui_sessions: set[str] = set()
        self._ended_gui_grants: set[str] = set()
        self._gui_closing = False
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="atum-device")

    @staticmethod
    def _stdout_write(text: str) -> None:
        sys.stdout.write(text)
        sys.stdout.flush()

    # -- transport ---------------------------------------------------------

    def serve(self, stream=None) -> None:
        self._ensure_home()
        self.transport.notify("device.ready", {"pid": os.getpid()})
        for line in stream or sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                _log("protocol_invalid")
                continue
            if isinstance(message, dict):
                self._dispatch(message)
        # The parent closed the pipe: nothing may outlive it.
        self._kill_everything()
        self.transport.fail_all("device_host_closing")
        self._release_gui({})

    def _ensure_home(self) -> None:
        """Write the host's own Hermes config (LSP off) into its HERMES_HOME."""
        home = os.environ.get("HERMES_HOME")
        if not home:
            return
        os.makedirs(home, mode=0o700, exist_ok=True)
        path = os.path.join(home, "config.yaml")
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                if handle.read() == HOST_CONFIG:
                    return
        except OSError:
            pass
        temp = path + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            handle.write(HOST_CONFIG)
        os.chmod(temp, 0o600)
        os.replace(temp, path)

    def _reply(self, request_id: Any, result: Any = None, error: Optional[str] = None) -> None:
        if error is not None:
            self.transport.emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": error}})
        else:
            self.transport.emit({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _dispatch(self, message: dict[str, Any]) -> None:
        if self.transport.resolve(message):
            return
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}
        if method == "device.stop":
            self._reply(request_id, self._stop(params))
            return
        if method == "device.shutdown":
            self._kill_everything()
            self.transport.fail_all("device_host_closing")
            self._release_gui({})
            self._reply(request_id, {"stopping": True})
            raise SystemExit(0)
        if method == "device.release_gui":
            grant_id = params.get("grantId")
            if not isinstance(grant_id, str) or not grant_id.strip():
                self._reply(request_id, error="invalid_params")
                return
            # Fence queued calls before handing teardown to a worker. Never block the protocol
            # reader on a GUI action that is waiting for a reverse broker response.
            with self._lock:
                self._ended_gui_grants.add(str(params.get("grantId") or ""))
        handler = {
            "device.release_gui": self._release_gui,
            "device.exec": self._exec,
            "device.read_artifact": self._read_artifact,
            "device.computer_use": self._computer_use,
            "device.sudo": self._sudo,
        }.get(method)
        if handler is None:
            self._reply(request_id, error="method_not_found")
            return
        self._pool.submit(self._run, handler, request_id, params)

    def _run(self, handler: Callable[[dict[str, Any]], dict[str, Any]], request_id: Any, params: dict[str, Any]) -> None:
        try:
            result = handler(params)
        except Exception as exc:  # never leak detail to the controller
            _log(f"request_failed:{type(exc).__name__}")
            self._reply(request_id, error="device_exec_failed")
            return
        finally:
            command_id = params.get("commandId")
            if isinstance(command_id, str):
                with self._lock:
                    self._pgids.pop(command_id, None)
                    self._cancelled.discard(command_id)
        self._reply(request_id, result)

    # -- process groups ----------------------------------------------------

    def _spawned(self, command_id: str, pgid: int) -> None:
        with self._lock:
            self._pgids.setdefault(command_id, []).append(pgid)
            cancelled = command_id in self._cancelled
        self.transport.notify("device.spawned", {"commandId": command_id, "pgid": pgid})
        if cancelled:
            self._kill_group(pgid)

    def _stop(self, params: dict[str, Any]) -> dict[str, Any]:
        command_id = params.get("commandId")
        with self._lock:
            if isinstance(command_id, str):
                self._cancelled.add(command_id)
                targets = {command_id: list(self._pgids.get(command_id, []))}
            else:
                self._cancelled.update(self._pgids.keys())
                targets = {cid: list(groups) for cid, groups in self._pgids.items()}
        killed = []
        for cid, groups in targets.items():
            if all(self._kill_group(pgid) for pgid in groups) and groups:
                killed.append(cid)
        return {"killed": sorted(killed)}

    def _kill_everything(self) -> None:
        with self._lock:
            self._gui_closing = True
            groups = [pgid for each in self._pgids.values() for pgid in each]
            self._cancelled.update(self._pgids.keys())
        for pgid in groups:
            self._kill_group(pgid)

    @staticmethod
    def _kill_group(pgid: int) -> bool:
        if not _IS_DARWIN or pgid <= 1 or pgid == os.getpgid(0):
            return False
        try:
            os.killpg(pgid, signal.SIGKILL)  # windows-footgun: ok (guarded macOS device host)
        except ProcessLookupError:
            return True
        except OSError:
            return False
        return True

    def _command_cancelled(self, command_id: str) -> bool:
        with self._lock:
            return command_id in self._cancelled

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _write_profile(command_id: str, profile: str) -> str:
        fd, path = tempfile.mkstemp(prefix=f"atum-sb-{command_id[:8]}-", suffix=".sb")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(profile)
        os.chmod(path, 0o600)
        return path

    @staticmethod
    def _extra_env(params: dict[str, Any]) -> dict[str, str]:
        extra = params.get("env") or {}
        return {k: str(v) for k, v in extra.items() if k == "SSH_AUTH_SOCK" and isinstance(v, str)}

    # -- device.exec -------------------------------------------------------

    def _exec(self, params: dict[str, Any]) -> dict[str, Any]:
        command_id = str(params["commandId"])
        tool = str(params["tool"])
        args = dict(params.get("args") or {})
        cwd = str(params.get("cwd") or os.path.expanduser("~"))
        timeout = max(1, int(params.get("timeoutMs") or 120_000) // 1000)
        profile = str(params.get("profile") or "")

        if not _IS_DARWIN:
            return {"state": "failed_no_effect", "result": {"error": "the device host runs on macOS only"}}
        if tool not in FILE_TOOLS or not profile:
            return {"state": "failed_no_effect", "result": {"error": f"unsupported device tool: {tool}"}}
        if tool == "terminal":
            unsupported = [key for key in _NOT_SUPPORTED_IN_S1 if args.get(key)]
            if unsupported:
                return {"state": "failed_no_effect", "result": {
                    "output": "", "exit_code": -1, "status": "blocked",
                    "error": "Background and interactive (pty) processes are not available on this Mac yet; "
                             "run the command in the foreground."}}
        if self._command_cancelled(command_id):
            return {"state": "failed_no_effect", "result": {"error": "stopped before it started"}}

        profile_path = self._write_profile(command_id, profile)
        from tools import terminal_tool as terminal_mod

        try:
            try:
                env = make_seatbelt_environment(
                    profile_path, command_id, cwd, timeout, self._extra_env(params),
                    on_spawn=lambda pgid: self._spawned(command_id, pgid),
                )
            except Exception as exc:
                _log(f"environment_failed:{type(exc).__name__}")
                return {"state": "failed_no_effect", "result": {"error": "the sandbox could not start this command"}}
            if self._command_cancelled(command_id):
                env.cleanup()
                return {"state": "failed_no_effect", "result": {"error": "stopped before it started"}}

            terminal_mod.register_task_env_overrides(command_id, {"env_type": "local", "cwd": cwd})
            with terminal_mod._env_lock:
                terminal_mod._active_environments[command_id] = env
            try:
                output = self._run_tool(tool, args, command_id, timeout)
            except Exception as exc:
                _log(f"tool_failed:{type(exc).__name__}")
                return {"state": "unknown", "result": {"error": "the command failed while running"}}
            finally:
                self._teardown(command_id)
            return {"state": "completed", "result": output}
        finally:
            try:
                os.unlink(profile_path)
            except OSError:
                pass

    @staticmethod
    def _run_tool(tool: str, args: dict[str, Any], command_id: str, timeout: int) -> Any:
        if tool == "terminal":
            from tools.terminal_tool import terminal_tool

            requested = args.get("timeout")
            raw = terminal_tool(
                command=str(args.get("command", "")),
                task_id=command_id,
                timeout=min(timeout, int(requested)) if isinstance(requested, int) and requested > 0 else timeout,
                workdir=args.get("workdir") if isinstance(args.get("workdir"), str) else None,
            )
        elif tool == "read_file":
            from tools.file_tools import read_file_tool

            raw = read_file_tool(
                path=str(args.get("path", "")),
                offset=int(args.get("offset", 1) or 1),
                limit=int(args.get("limit", 500) or 500),
                task_id=command_id,
            )
        elif tool == "write_file":
            from tools.file_tools import write_file_tool

            raw = write_file_tool(path=str(args.get("path", "")), content=str(args.get("content", "")), task_id=command_id)
        elif tool == "patch":
            from tools.file_tools import patch_tool

            raw = patch_tool(
                mode=str(args.get("mode", "replace")),
                path=args.get("path"),
                old_string=args.get("old_string"),
                new_string=args.get("new_string"),
                replace_all=bool(args.get("replace_all", False)),
                patch=args.get("patch"),
                task_id=command_id,
            )
        else:
            from tools.file_tools import search_tool

            raw = search_tool(
                pattern=str(args.get("pattern", "")),
                target=str(args.get("target", "content")),
                path=str(args.get("path", ".")),
                file_glob=args.get("file_glob") if isinstance(args.get("file_glob"), str) else None,
                limit=int(args.get("limit", 50) or 50),
                offset=int(args.get("offset", 0) or 0),
                output_mode=str(args.get("output_mode", "content")),
                context=int(args.get("context", 0) or 0),
                task_id=command_id,
            )
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return raw
        return raw

    @staticmethod
    def _teardown(command_id: str) -> None:
        from tools import terminal_tool as terminal_mod

        with terminal_mod._env_lock:
            env = terminal_mod._active_environments.pop(command_id, None)
        if env is not None:
            try:
                env.cleanup()
            except Exception:
                pass
        for clear in ("clear_task_env_overrides",):
            try:
                getattr(terminal_mod, clear)(command_id)
            except Exception:
                pass
        try:
            from tools.file_tools import clear_file_ops_cache

            clear_file_ops_cache(command_id)
        except Exception:
            pass

    # -- device.read_artifact ---------------------------------------------

    def _read_artifact(self, params: dict[str, Any]) -> dict[str, Any]:
        command_id = str(params["commandId"])
        cwd = str(params.get("cwd") or os.path.expanduser("~"))
        requested = os.path.expanduser(str(params.get("path") or ""))
        path = requested if os.path.isabs(requested) else os.path.join(cwd, requested)
        dest = str(params["dest"])
        limit = min(int(params.get("maxBytes") or MAX_ARTIFACT_BYTES), MAX_ARTIFACT_BYTES)
        profile = str(params.get("profile") or "")

        if not _IS_DARWIN or not profile or not requested:
            return {"state": "failed_no_effect", "error": "unreadable"}
        if self._command_cancelled(command_id):
            return {"state": "failed_no_effect", "error": "stopped"}

        profile_path = self._write_profile(command_id, profile)
        try:
            # The read happens inside the profile: a protected file (or a symlink to one) fails here.
            script = 'test -f "$1" && test -r "$1" && exec /bin/cat -- "$1"'
            proc = subprocess.Popen(
                [_SANDBOX_EXEC, "-f", profile_path, "/bin/sh", "-c", script, "atum-send", path],
                cwd=cwd if os.path.isdir(cwd) else None,
                env={"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "")},
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            self._spawned(command_id, os.getpgid(proc.pid))
            size = 0
            fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            too_large = False
            with os.fdopen(fd, "wb") as out:
                while True:
                    chunk = proc.stdout.read(65536)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > limit:
                        too_large = True
                        self._kill_group(proc.pid)
                        break
                    out.write(chunk)
            code = proc.wait(timeout=30)
            if too_large or code != 0 or self._command_cancelled(command_id):
                os.unlink(dest)
                reason = "too_large" if too_large else ("stopped" if self._command_cancelled(command_id) else "unreadable")
                return {"state": "failed_no_effect", "error": reason}
            return {"state": "completed", "size": size, "name": os.path.basename(path)}
        finally:
            try:
                os.unlink(profile_path)
            except OSError:
                pass

    # -- device.computer_use ----------------------------------------------

    def _release_gui(self, params: dict[str, Any]) -> dict[str, Any]:
        from tools.computer_use import tool as cu

        grant_id = params.get("grantId")
        with self._gui_lock:
            sessions = [str(grant_id)] if grant_id is not None else list(self._gui_sessions)
            for grant in sessions:
                cu.release_computer_use_session(f"atum-device-gui-{grant}")
                self._gui_sessions.discard(grant)
        return {"released": True}

    def _computer_use(self, params: dict[str, Any]) -> dict[str, Any]:
        command_id = str(params["commandId"])
        args = dict(params.get("args") or {})
        if not _IS_DARWIN:
            return {"state": "failed_no_effect", "result": {"error": "the device host runs on macOS only"}}
        from tools.computer_use import tool as cu

        refused: list[str] = []

        def authorize(action: str, action_args: dict[str, Any], summary: str, backend) -> bool:
            verdict = self._gui_authorize(command_id, action, action_args, summary, backend)
            if verdict.get("allow") is True:
                return True
            refused.append(str(verdict.get("reason") or "refused"))
            return False

        # One GUI session at a time: the CuaDriver backend keeps a sticky target window.
        with self._gui_lock:
            grant_id = params.get("grantId")
            with self._lock:
                stopped = self._gui_closing or grant_id in self._ended_gui_grants or command_id in self._cancelled
            if not isinstance(grant_id, str) or not grant_id or stopped:
                return {"state": "failed_no_effect", "result": {"error": "GUI grant is missing or stopped", "refusal": "stopped"}}
            self._gui_sessions.add(grant_id)
            raw = cu.handle_computer_use(args, session_id=f"atum-device-gui-{grant_id}", action_authorizer=authorize)
        if isinstance(raw, str):
            try:
                result: Any = json.loads(raw)
            except json.JSONDecodeError:
                result = raw
        else:
            result = raw
        if refused:
            message = {
                "command_app": "Atum does not let an agent drive command or script apps outside the command sandbox.",
                "no_target": "Capture the window first.",
                "security_ui": "Atum does not let an agent act on security prompts or System Settings.",
                "own_app": "Atum does not let an agent drive Atum itself.",
                "paused": "This Mac is waiting for an approval; try again in a moment.",
                "stopped": "The owner stopped this on the Mac.",
                "approval_denied": "The owner declined this upload on the Mac.",
                "approval_timeout": "Nobody approved this upload on the Mac in time.",
            }.get(refused[0], "This Mac refused the action.")
            return {"state": "failed_no_effect", "result": {"error": message, "refusal": refused[0]}}
        # Dispatch can fail after input was posted. Do not promise a safe retry.
        if isinstance(result, dict) and str(result.get("error", "")).startswith(f"{args.get('action')} failed:"):
            return {"state": "unknown", "result": result}
        if isinstance(result, dict) and (result.get("error") or (
                result.get("ok") is False and result.get("code") in ("no_target", "no_active_window"))):
            return {"state": "failed_no_effect", "result": result}
        return {"state": "completed", "result": bound_screenshot(result)}

    def _gui_authorize(self, command_id: str, action: str, args: dict[str, Any], summary: str, backend) -> dict[str, Any]:
        """Ask main's GUI broker about one mutating action, describing its real target window."""
        target = self._gui_target(action, args, backend)
        text = args.get("text") if isinstance(args.get("text"), str) else args.get("value")
        keys = str(args.get("keys") or "").lower()
        pastes = action == "key" and re.search(r"(cmd|command|ctrl|control)\s*\+\s*v\b", keys) is not None
        try:
            answer = self.transport.request(
                "device.gui_authorize",
                {
                    "commandId": command_id,
                    "action": action,
                    "summary": summary[:300],
                    "target": target,
                    "textBytes": len(text.encode("utf-8")) if isinstance(text, str) else 0,
                    "pasteBytes": clipboard_bytes() if pastes else 0,
                },
                timeout=GUI_AUTHORIZE_TIMEOUT,
            )
        except (FutureTimeout, RuntimeError, TimeoutError):
            return {"allow": False, "reason": "stopped"}
        return answer if isinstance(answer, dict) else {"allow": False, "reason": "refused"}

    @staticmethod
    def _gui_target(action: str, args: dict[str, Any], backend) -> dict[str, Any]:
        """The window a mutating action will reach: the backend's sticky target (CuaDriver posts the
        event to that process), or, for focus/launch, the app being asked for."""
        target: dict[str, Any] = {}
        if action in ("focus_app", "launch_app") or args.get("action") == "focus_app":
            target["requestedApp"] = str(args.get("app") or args.get("bundle_id") or args.get("name") or "")
        try:
            pid = getattr(backend, "_active_pid", None)
            window_id = getattr(backend, "_active_window_id", None)
        except Exception:
            return target
        if isinstance(pid, int):
            executable = process_path(pid)
            target.update({"pid": pid, "processPath": executable, "bundleId": bundle_id_of(executable)})
            try:
                for window in backend.list_windows():
                    if window.get("pid") == pid and (window_id is None or window.get("window_id") == window_id):
                        target["appName"] = str(window.get("app_name") or "")
                        target["title"] = str(window.get("title") or "")
                        break
            except Exception:
                pass
        return target

    # -- device.sudo -------------------------------------------------------

    def _sudo(self, params: dict[str, Any]) -> dict[str, Any]:
        """Run the owner-approved argv as root. Outside the sandbox: macOS refuses setuid binaries
        inside one. The password arrives once on the pipe, goes to sudo's stdin, and is dropped."""
        command_id = str(params["commandId"])
        argv = [str(each) for each in (params.get("argv") or [])]
        password = params.pop("password", None)
        cwd = str(params.get("cwd") or os.path.expanduser("~"))
        timeout = max(1, int(params.get("timeoutMs") or 120_000) // 1000)
        if not _IS_DARWIN or not argv or not isinstance(password, str):
            return {"state": "failed_no_effect", "result": {"error": "sudo is not available"}}
        if self._command_cancelled(command_id):
            return {"state": "failed_no_effect", "result": {"error": "stopped before it started"}}
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": os.environ.get("HOME", ""), "LANG": "en_US.UTF-8"}
        env.update(forced_command_env(dict(os.environ)))
        proc = subprocess.Popen(
            [_SUDO, "-S", "-k", "-p", "", "--", *argv],
            cwd=cwd if os.path.isdir(cwd) else None,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self._spawned(command_id, os.getpgid(proc.pid))
        try:
            proc.stdin.write((password + "\n").encode("utf-8"))
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        password = None
        try:
            output, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._kill_group(proc.pid)  # a session leader: its group id is its pid
            output, _ = proc.communicate()
            return {"state": "unknown", "result": {"output": "", "exit_code": -1, "error": "sudo command timed out"}}
        text = (output or b"")[:MAX_SUDO_OUTPUT].decode("utf-8", "replace")
        return {"state": "completed", "result": {"output": text, "exit_code": proc.returncode, "error": None}}


def main() -> None:
    DeviceHost().serve()


if __name__ == "__main__":
    main()
