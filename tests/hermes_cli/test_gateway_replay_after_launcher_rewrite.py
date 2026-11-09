"""N-1 gateway argv must survive publication of a POSIX shell launcher during update."""
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from hermes_cli import _launchers, update_cmd_posix_pause as pause


@pytest.mark.platforms("posix")
@pytest.mark.spawns_gateway_lookalike
def test_paused_gateway_restarts_after_its_python_launcher_became_a_shell_script(tmp_path, monkeypatch):
    root = tmp_path / "source"
    package = root / "hermes_cli"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (root / "hermes_bootstrap.py").write_text("")
    capture = tmp_path / "started.json"
    (package / "main.py").write_text(
        "import json, os, sys\nfrom pathlib import Path\nfrom threading import Event\n"
        "Path(os.environ['CAPTURE']).write_text(json.dumps({'pid': os.getpid(), 'argv': sys.argv[1:]}))\n"
        "Event().wait(30)\n")
    launcher = tmp_path / "bin" / "hermes"
    launcher.parent.mkdir()
    launcher.write_text("#!/bin/sh\nexit 70\n")
    old = [sys.executable, str(launcher), "--profile", "named profile", "gateway", "run", "--quiet"]
    broken = subprocess.run(old, capture_output=True, text=True, timeout=10, check=False)
    assert broken.returncode != 0 and "SyntaxError" in broken.stderr
    monkeypatch.setattr(pause, "__file__", str(package / "update_cmd_posix_pause.py"))
    monkeypatch.setattr(_launchers, "resolve_store_python", lambda _root: Path(sys.executable))
    monkeypatch.setattr(pause, "_replay_env", lambda home: dict(os.environ, HERMES_HOME=home, CAPTURE=str(capture)))
    monkeypatch.setattr(pause, "_gateway_on_home", lambda *_: json.loads(capture.read_text())["pid"]
                        if capture.exists() else None)
    processes = []
    popen = subprocess.Popen
    def start(*args, **kwargs):
        proc = popen(*args, **kwargs)
        processes.append(proc)
        return proc
    monkeypatch.setattr(pause.subprocess, "Popen", start)
    try:
        pid = pause._relaunch_bare({"pid": 424242, "argv": old, "home": str(tmp_path / "home")})
        assert processes[0].poll() is None and pid == processes[0].pid
        assert json.loads(capture.read_text())["argv"] == old[2:]
    finally:
        for proc in processes:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)


@pytest.mark.parametrize("shape", ["module", "checkout-script", "direct-launcher"])
def test_other_gateway_launch_shapes_remain_intact(tmp_path, shape):
    argv = {"module": [sys.executable, "-m", "hermes_cli.main", "gateway", "run"],
            "checkout-script": [sys.executable, str(tmp_path / "hermes"), "gateway", "run"],
            "direct-launcher": [str(tmp_path / "bin/hermes"), "gateway", "run"]}[shape]
    assert _launchers.respawnable_command(tmp_path, argv) == argv
