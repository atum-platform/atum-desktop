"""Native interim frames: think-stripped, secret-redacted, deduplicated, final answer intact."""
import json
import subprocess
import sys
from pathlib import Path


def test_native_interim_frames_are_safe_and_ordered():
    fixture = Path(__file__).parent / "fixtures" / "native_interim_frames.py"
    run = subprocess.run([sys.executable, str(fixture)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-2000:]
    frames = json.loads(run.stdout)
    assert [frame["params"]["type"] for frame in frames] == ["message.interim", "message.complete"]
    interim = frames[0]["params"]["payload"]["text"]
    assert "I am checking" in interim
    assert "PRIVATE" not in interim and "ghp_" + "A" * 36 not in interim
    assert frames[1]["params"]["payload"]["text"] == "Here is the answer."
