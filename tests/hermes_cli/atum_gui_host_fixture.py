"""Real device-host protocol and Cua backend with a synthetic OS-edge driver. No GUI access."""
import sys
import subprocess
import threading
from hermes_cli import atum_device_host as host_mod
from tools.computer_use import tool as cu
from tools.computer_use.cua_backend import CuaDriverBackend
from tools.computer_use.backend import ActionResult, CaptureResult

mode = "manual" if sys.argv[1] == "interactive" else sys.argv[1]
host_mod.HOST_CONFIG += f"\napprovals:\n  mode: {mode}\n"
host = host_mod.DeviceHost()
host_mod._IS_DARWIN = True
host_mod.process_path = lambda pid: "/Applications/Fixture.app/Contents/MacOS/Fixture"
host_mod.bundle_id_of = lambda path: "test.fixture"


resources = []


class FakeDriver:
    def call_tool(self, name, args, timeout=30):
        host.transport.notify("fixture.driver", {"action": name, "pid": args.get("pid"),
            "processes": sum(proc.poll() is None for proc, thread in resources),
            "threads": sum(thread.is_alive() for proc, thread in resources)})
        return {"isError": False, "data": {}, "structuredContent": {"effect": "confirmed"}}

    def supports_input_property(self, tool, prop):
        return prop != "snapshot_token"

    def supports_capability(self, capability, tool=None):
        return False

    def _has_tool(self, name):
        return True


created = 0


def backend_for_mode(mode):
    global created
    created += 1
    pid = 40 + created
    host.transport.notify("fixture.backend", {})
    backend = CuaDriverBackend.__new__(CuaDriverBackend)
    backend._session = FakeDriver()
    backend._session_id = "fixture"
    backend._active_pid = None
    backend._active_window_id = None
    backend._snapshot_tokens = {}
    # Model the resources owned by each real driver without accessing the GUI.
    stopped = threading.Event()
    bridge = threading.Thread(target=stopped.wait, daemon=True)
    process = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)

    def start():
        bridge.start()
        resources.append((process, bridge))

    def stop():
        process.stdin.close()
        process.wait(timeout=5)
        stopped.set()
        bridge.join(timeout=5)
        host.transport.notify("fixture.released", {"pid": pid, "processStopped": process.poll() is not None, "threadStopped": not bridge.is_alive()})

    def focus(app, raise_window=False):
        backend._active_pid = pid
        backend._active_window_id = 7
        return ActionResult(ok=True, action="focus_app")

    backend.start = start
    backend.stop = stop
    backend.focus_app = focus

    def capture(mode="som", app=None, **kwargs):
        focus(app)
        backend.list_windows = lambda: [{"pid": pid, "window_id": 7, "app_name": app or "Fixture", "title": "Fixture"}]
        return CaptureResult(mode=mode, width=1, height=1, png_b64=None, elements=[], app=app or "Fixture", window_title="Fixture")

    backend.capture = capture
    backend.list_windows = lambda: [{"pid": pid, "window_id": 7, "app_name": "Fixture", "title": "Fixture"}]
    return backend


cu._new_backend = backend_for_mode
host.serve()
