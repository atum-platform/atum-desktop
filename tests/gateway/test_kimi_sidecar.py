from __future__ import annotations

import json
import stat
import textwrap

import pytest

from gateway.claude_sidecar import ClaudeModeStateStore, ClaudeSidecarConfig
from gateway.kimi_sidecar import (
    KIMI_SIDECAR_TRANSCRIPT_MARKER,
    build_kimi_conversation_prompt,
    run_kimi_conversation,
)


def _fake_kimi(tmp_path):
    script = tmp_path / "fake-kimi"
    script.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import json
            import os
            import sys

            log_path = os.environ["FAKE_KIMI_LOG"]
            for raw in sys.stdin:
                request = json.loads(raw)
                with open(log_path, "a", encoding="utf-8") as log:
                    log.write(json.dumps(request) + "\\n")
                request_id = request["id"]
                method = request["method"]
                if method == "initialize":
                    result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
                elif method == "session/new":
                    result = {"sessionId": "session_test"}
                elif method == "session/load":
                    result = {}
                elif method == "session/set_config_option":
                    result = {"configOptions": []}
                elif method == "session/prompt":
                    update = {
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {
                            "sessionId": request["params"]["sessionId"],
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": "hello from kimi"},
                            },
                        },
                    }
                    print(json.dumps(update), flush=True)
                    result = {"stopReason": "end_turn"}
                else:
                    print(json.dumps({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32601, "message": "unknown"},
                    }), flush=True)
                    continue
                print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}), flush=True)
            """
        ),
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


def test_kimi_config_defaults_and_mutation_gate(tmp_path):
    config = ClaudeSidecarConfig.from_gateway_config(
        {"terminal": {"cwd": str(tmp_path)}},
        hermes_home=tmp_path / "profile",
    )

    assert config.kimi_enabled is True
    assert config.kimi_model == "kimi-code/k3"
    assert config.kimi_mode == "plan"

    with pytest.raises(ValueError, match="requires allow_mutating_tools"):
        ClaudeSidecarConfig.from_gateway_config(
            {"conversation": {"kimi_mode": "auto", "workdir": str(tmp_path)}},
            hermes_home=tmp_path / "profile",
        )


def test_kimi_prompt_skips_prior_kimi_turn(tmp_path):
    config = ClaudeSidecarConfig(workdir=str(tmp_path))
    prompt = build_kimi_conversation_prompt(
        message="new turn",
        config=config,
        shared_history=[
            {"role": "user", "content": "old kimi turn"},
            {
                "role": "assistant",
                "content": f"old answer\n\n{KIMI_SIDECAR_TRANSCRIPT_MARKER}",
            },
        ],
    )

    assert "User message:\nnew turn" in prompt
    assert "old kimi turn" not in prompt
    assert "old answer" not in prompt


@pytest.mark.asyncio
async def test_kimi_acp_creates_then_loads_persistent_session(tmp_path):
    fake_kimi = _fake_kimi(tmp_path)
    log_path = tmp_path / "requests.jsonl"
    store = ClaudeModeStateStore(tmp_path / "state.json")
    config = ClaudeSidecarConfig(
        workdir=str(tmp_path),
        kimi_bin=str(fake_kimi),
        kimi_model="kimi-code/k3",
        kimi_mode="plan",
        kimi_timeout_seconds=30,
    )
    state = store.get("telegram:dm:1", config)

    first = await run_kimi_conversation(
        message="first",
        config=config,
        state=state,
        state_store=store,
        session_key="telegram:dm:1",
        env={"FAKE_KIMI_LOG": str(log_path)},
    )
    persisted = store.get("telegram:dm:1", config)
    second = await run_kimi_conversation(
        message="second",
        config=config,
        state=persisted,
        state_store=store,
        session_key="telegram:dm:1",
        env={"FAKE_KIMI_LOG": str(log_path)},
    )

    requests = [json.loads(line) for line in log_path.read_text().splitlines()]
    methods = [request["method"] for request in requests]
    assert first == "hello from kimi"
    assert second == "hello from kimi"
    assert persisted.kimi_session_id == "session_test"
    assert persisted.kimi_created is True
    assert methods.count("session/new") == 1
    assert methods.count("session/load") == 1
    config_updates = [
        request["params"]
        for request in requests
        if request["method"] == "session/set_config_option"
    ]
    assert {update["configId"] for update in config_updates} == {"model", "mode"}
    assert all(
        request["params"].get("sessionId") == "session_test"
        for request in requests
        if request["method"].startswith("session/")
        and request["method"] != "session/new"
    )
