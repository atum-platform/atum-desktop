"""Real config handler/process/profile bytes; no provider or user credential access."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


def _profile_call(tmp_path, mode: str, effort: str, scope: str = "session"):
    home = tmp_path / "home"
    profile = home / "profile"
    profile.mkdir(parents=True)
    config = profile / "config.yaml"
    config.write_text("# byte-preserved profile\nagent:\n  reasoning_effort: medium\n", encoding="utf-8")
    program = r'''
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tui_gateway.server as server

mode, effort, scope = json.loads(os.environ["P6_TEST_INPUT"])
profile = Path(os.environ["HERMES_HOME"])
config = profile / "config.yaml"
before = config.read_bytes()
agent = SimpleNamespace(reasoning_config=None, model="synthetic-model", provider="synthetic", session_id="synthetic") if mode == "live" else None
session = {"session_key": "synthetic", "agent": agent, "running": mode == "busy"}
if mode != "retired":
    server._sessions["synthetic"] = session
reply = server._methods["config.set"]("p6", {"key": "reasoning", "value": effort, "session_id": "synthetic", "scope": scope})
Path(os.environ["P6_TEST_OUTPUT"]).write_text(json.dumps({"reply": reply, "same_bytes": config.read_bytes() == before,
                  "override": session.get("create_reasoning_override"),
                  "live_effort": getattr(agent, "reasoning_config", None),
                  "config_effort": server._load_cfg().get("agent", {}).get("reasoning_effort")}), encoding="utf-8")
'''
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home),
        "HERMES_HOME": str(profile),
        "PYTHONHASHSEED": "0",
        "P6_TEST_INPUT": json.dumps([mode, effort, scope]),
        "P6_TEST_OUTPUT": str(profile / "proof.json"),
    }
    result = subprocess.run(
        [sys.executable, "-c", program], cwd=Path(__file__).resolve().parents[2],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return json.loads((profile / "proof.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("mode", ["lazy", "live"])
@pytest.mark.parametrize("effort", ["low", "medium", "high"])
def test_selected_session_effort_preserves_real_profile_bytes(tmp_path, mode, effort):
    result = _profile_call(tmp_path, mode, effort)
    assert result["reply"]["result"] == {"key": "reasoning", "value": effort}
    assert result["same_bytes"] is True
    assert result["config_effort"] == "medium"
    assert result["override"] == {"enabled": True, "effort": effort}
    if mode == "live":
        assert result["live_effort"] == result["override"]


def test_retired_session_refuses_before_any_profile_write(tmp_path):
    result = _profile_call(tmp_path, "retired", "high")
    assert result["reply"]["error"]["code"] == 4001
    assert result["same_bytes"] is True
    assert result["config_effort"] == "medium"
    assert result["override"] is None


def test_busy_session_updates_only_its_runtime_effort(tmp_path):
    result = _profile_call(tmp_path, "busy", "high")
    assert result["reply"]["result"] == {"key": "reasoning", "value": "high"}
    assert result["same_bytes"] is True
    assert result["config_effort"] == "medium"
    assert result["override"] == {"enabled": True, "effort": "high"}


def test_deliberate_global_effort_keeps_existing_behavior(tmp_path):
    result = _profile_call(tmp_path, "retired", "high", scope="global")
    assert result["reply"]["result"]["value"] == "high"
    assert result["same_bytes"] is False
    assert result["config_effort"] == "high"
