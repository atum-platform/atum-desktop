"""Opt-in real Hermes bridge for the paired platform acceptance harness.

Pytest supplies the repository's existing credential, Keychain and home
isolation. Only a temporary loopback capability and public task descriptor cross
stdin/file boundaries; the provider key and private instructions stay in the
parent platform process. Normal test discovery skips this external harness.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlparse
import uuid

import pytest


@pytest.mark.skipif(not os.environ.get("ATUM_TRAINING_ACCEPTANCE_INPUT"),
                    reason="run with the paired platform acceptance harness")
def test_real_trained_task(tmp_path, monkeypatch):
    payload = json.loads(Path(os.environ["ATUM_TRAINING_ACCEPTANCE_INPUT"]).read_text())
    endpoint = urlparse(payload["environment"]["ATUM_MANAGED_MODEL_BASE_URL"])
    assert endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1"
    assert endpoint.port and endpoint.path == "/v1" and not endpoint.username
    home = tmp_path / "agent"
    workspace = tmp_path / "workspace"
    home.mkdir()
    workspace.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_CWD", str(workspace))
    monkeypatch.delenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", raising=False)
    monkeypatch.chdir(workspace)
    for key, value in payload["environment"].items():
        assert key in {"ATUM_MANAGED_MODEL_BASE_URL", "ATUM_MANAGED_MODEL_PROXY_TOKEN",
                       "ATUM_MANAGED_MODEL_DEFAULT", "ATUM_FILESYSTEM_BROKER_TOKEN", "NO_PROXY", "no_proxy"}
        monkeypatch.setenv(key, value)
    task = payload["task"]
    (home / "profile.yaml").write_text("identity_id: " + task["assistant_identity_id"] + "\n")
    (home / "config.yaml").write_text("model:\n  context_length: 75000\n")
    (workspace / "invoices.csv").write_text(payload["input_csv"])

    from hermes_cli.atum_training import bind_task
    from tui_gateway.surface_context import bind_managed_submission, capabilities, claim_submission
    from hermes_state import SessionDB
    from run_agent import AIAgent

    owner = capabilities(home, {"session_key": task["conversation_id"], "profile_home": str(home)})
    bind_task(home, owner, task)
    claimed, _, handle = claim_submission(home, owner, str(uuid.uuid4()), payload["prompt"], None, [], None)
    assert claimed
    db = SessionDB(db_path=home / "state.db")
    agent = AIAgent(
        api_key=payload["environment"]["ATUM_MANAGED_MODEL_PROXY_TOKEN"],
        base_url=payload["environment"]["ATUM_MANAGED_MODEL_BASE_URL"],
        provider="atum-managed", model="binh-minh", api_mode="chat_completions",
        max_iterations=4, max_tokens=2048, enabled_toolsets=["file"],
        quiet_mode=True, tool_delay=0, skip_context_files=True, skip_memory=True,
        reasoning_config={"enabled": False}, session_id=task["conversation_id"],
        session_db=db, platform="cli",
    )
    try:
        with bind_managed_submission(agent, handle):
            result = agent.run_conversation(payload["prompt"], task_id=task["conversation_id"])
        messages = result.get("messages") or []
        calls = [call for message in messages for call in message.get("tool_calls", [])]
        report = {
            "completed": bool(result.get("completed")),
            "failed": bool(result.get("failed")),
            "error": str(result.get("error") or "")[:500],
            "final_response": str(result.get("final_response") or "")[:20000],
            "tools": [call["function"]["name"] for call in calls],
            "tool_results": [str(message.get("content", ""))[:10000]
                             for message in messages if message.get("role") == "tool"],
            "private_skill_files": [str(p.relative_to(home)) for p in home.rglob("SKILL.md")],
            "api_calls": result.get("api_calls"),
        }
        Path(payload["report_path"]).write_text(json.dumps(report))
        assert report["completed"] and not report["failed"], report["error"]
        assert "read_file" in report["tools"], "useful task must use the ordinary local file tool"
        assert not report["private_skill_files"]
    finally:
        close = getattr(agent, "close", None)
        if callable(close):
            close()
        db.close()
