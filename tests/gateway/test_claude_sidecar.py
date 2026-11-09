from __future__ import annotations

import asyncio
import json
import os
import signal
import uuid

import pytest

from gateway.claude_sidecar import (
    CLAUDE_SIDECAR_TRANSCRIPT_MARKER,
    ClaudeModeStateStore,
    ClaudeSidecarConfig,
    ClaudeSessionState,
    ClaudeTurnLockRegistry,
    _env_with_profile,
    _format_shared_history,
    build_claude_conversation_prompt,
    run_claude_conversation,
)


def test_config_defaults_to_codex_and_terminal_cwd(tmp_path):
    workdir = tmp_path / "workspace"
    workdir.mkdir()
    hermes_home = tmp_path / "profile"
    hermes_home.mkdir()
    cfg = ClaudeSidecarConfig.from_gateway_config(
        {"terminal": {"cwd": str(workdir)}},
        hermes_home=hermes_home,
    )

    assert cfg.enabled is True
    assert cfg.default_mode == "codex"
    assert cfg.default_model == "sonnet"
    assert cfg.workdir == str(workdir)
    assert cfg.timeout_seconds == 600
    assert cfg.max_turns == 60


def test_config_accepts_conversation_block(tmp_path):
    workdir = tmp_path / "workspace"
    workdir.mkdir()
    cfg = ClaudeSidecarConfig.from_gateway_config(
        {
            "conversation": {
                "enabled": True,
                "default_mode": "claude",
                "default_model": "opus",
                "timeout_seconds": 1200,
                "max_turns": 99,
                "permission_mode": "plan",
                "allowed_tools": "Read,Grep,Glob",
                "disallowed_tools": [
                    "Bash",
                    "Write",
                    "Edit",
                    "NotebookEdit",
                    "WebFetch",
                    "WebSearch",
                    "Task",
                ],
                "workdir": str(workdir),
                "prompt_files": ["IDENTITY.md", "/tmp/EXTRA.md"],
                "append_system_prompt": "Speak plainly.",
            }
        },
        hermes_home=tmp_path,
    )

    assert cfg.default_mode == "claude"
    assert cfg.default_model == "opus"
    assert cfg.timeout_seconds == 1200
    assert cfg.max_turns == 60
    assert cfg.permission_mode == "plan"
    assert cfg.allowed_tools == "Read,Grep,Glob"
    assert cfg.disallowed_tools == "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task"
    assert cfg.prompt_files == ("IDENTITY.md", "/tmp/EXTRA.md")
    assert cfg.append_system_prompt == "Speak plainly."


def test_config_rejects_mutating_allowed_tools(tmp_path):
    with pytest.raises(ValueError, match="mutating allowed tools"):
        ClaudeSidecarConfig.from_gateway_config(
            {
                "conversation": {
                    "allowed_tools": "Read,Edit",
                    "workdir": str(tmp_path),
                }
            },
            hermes_home=tmp_path,
        )


def test_config_accepts_mutating_allowed_tools_when_enabled(tmp_path):
    cfg = ClaudeSidecarConfig.from_gateway_config(
        {
            "conversation": {
                "allow_mutating_tools": True,
                "allowed_tools": "Read,Bash,Write,Edit",
                "workdir": str(tmp_path),
            }
        },
        hermes_home=tmp_path,
    )

    assert cfg.allow_mutating_tools is True
    assert cfg.allowed_tools == "Read,Bash,Write,Edit"


def test_config_avoids_hermes_home_as_workdir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    hermes_home = tmp_path
    cfg = ClaudeSidecarConfig.from_gateway_config(
        {"terminal": {"cwd": str(hermes_home)}},
        hermes_home=hermes_home,
    )

    assert cfg.workdir != str(hermes_home)
    assert ".hermes" not in cfg.workdir


def test_state_store_persists_mode_model_and_uuid(tmp_path):
    store = ClaudeModeStateStore(tmp_path / "state.json")
    cfg = ClaudeSidecarConfig(default_mode="claude", default_model="sonnet")

    initial = store.get("telegram:dm:1", cfg)
    uuid.UUID(initial.claude_session_id)
    assert initial.mode == "claude"
    assert initial.model == "sonnet"
    assert initial.created is False

    switched = store.set_mode("telegram:dm:1", "codex", cfg)
    modeled = store.set_model("telegram:dm:1", "opus", cfg)
    created = store.mark_created("telegram:dm:1", cfg)

    assert switched.claude_session_id == initial.claude_session_id
    assert modeled.claude_session_id == initial.claude_session_id
    assert modeled.mode == "codex"
    assert modeled.model == "opus"
    assert created.created is True

    reloaded = ClaudeModeStateStore(tmp_path / "state.json").get(
        "telegram:dm:1",
        cfg,
    )
    assert reloaded == created


def test_state_store_corrupt_session_id_forces_created_false(tmp_path):
    path = tmp_path / "state.json"
    existing = {
        "sessions": {
            "telegram:dm:1": {
                "mode": "claude",
                "model": "opus",
                "claude_session_id": "not-a-uuid",
                "created": True,
            }
        }
    }
    path.write_text(json.dumps(existing), encoding="utf-8")

    state = ClaudeModeStateStore(path).get(
        "telegram:dm:1",
        ClaudeSidecarConfig(default_mode="codex"),
    )

    uuid.UUID(state.claude_session_id)
    assert state.created is False


def test_state_store_peek_does_not_create_file_or_session(tmp_path):
    path = tmp_path / "state.json"
    store = ClaudeModeStateStore(path)
    cfg = ClaudeSidecarConfig(default_mode="codex", default_model="sonnet")

    state = store.peek("telegram:dm:1", cfg)

    uuid.UUID(state.claude_session_id)
    assert state.mode == "codex"
    assert state.model == "sonnet"
    assert not path.exists()


def test_prompt_includes_context_and_identity_docs(tmp_path):
    identity = tmp_path / "IDENTITY.md"
    identity.write_text("You are Moon.", encoding="utf-8")
    cfg = ClaudeSidecarConfig(
        workdir=str(tmp_path),
        prompt_files=("IDENTITY.md",),
        append_system_prompt="Use reflective questions.",
    )

    prompt = build_claude_conversation_prompt(
        message="hello",
        config=cfg,
        context_prompt="Telegram DM with user 123",
    )

    assert "direct Claude conversation mode" in prompt
    assert "Use reflective questions." in prompt
    assert "Telegram DM with user 123" in prompt
    assert "You are Moon." in prompt
    assert "User message:\nhello" in prompt


def test_prompt_includes_recent_shared_history(tmp_path):
    cfg = ClaudeSidecarConfig(workdir=str(tmp_path))

    prompt = build_claude_conversation_prompt(
        message="what were we discussing?",
        config=cfg,
        shared_history=[
            {"role": "user", "content": "We are debugging Moon onboarding."},
            {"role": "assistant", "content": "I found the signup issue."},
            {"role": "tool", "content": "ignored"},
        ],
    )

    assert "Recent shared Hermes/Codex transcript" in prompt
    assert "user: We are debugging Moon onboarding." in prompt
    assert "assistant: I found the signup issue." in prompt
    assert "tool: ignored" not in prompt


def test_shared_history_skips_prior_claude_sidecar_pair():
    history = [
        {"role": "user", "content": "Codex, inspect the repo."},
        {"role": "assistant", "content": "Codex found failing tests."},
        {"role": "user", "content": "Claude, what do you think?"},
        {
            "role": "assistant",
            "content": f"Claude response already in Claude session.\n\n{CLAUDE_SIDECAR_TRANSCRIPT_MARKER}",
        },
    ]

    rendered = _format_shared_history(history)

    assert "Codex, inspect the repo." in rendered
    assert "Codex found failing tests." in rendered
    assert "Claude, what do you think?" not in rendered
    assert "Claude response already in Claude session." not in rendered
    assert CLAUDE_SIDECAR_TRANSCRIPT_MARKER not in rendered


def test_shared_history_includes_compact_tool_results():
    rendered = _format_shared_history(
        [
            {"role": "user", "content": "Run tests."},
            {"role": "tool", "tool_name": "terminal", "content": "pytest failed: test_x"},
            {"role": "assistant", "content": "Tests failed."},
        ],
    )

    assert "tool result (terminal): pytest failed: test_x" in rendered
    assert "assistant: Tests failed." in rendered


@pytest.mark.asyncio
async def test_run_claude_conversation_uses_expected_cli_args(monkeypatch, tmp_path):
    created = {}

    class FakeProcess:
        returncode = 0

        async def communicate(self, input=None):
            created["stdin"] = input
            return b"hello from claude", b""

    async def fake_create_subprocess_exec(*args, **kwargs):
        created["args"] = args
        created["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    state = ClaudeSessionState(
        mode="claude",
        model="opus",
        claude_session_id=str(uuid.uuid4()),
    )
    cfg = ClaudeSidecarConfig(
        claude_bin="/bin/claude",
        workdir=str(tmp_path),
        timeout_seconds=30,
        max_turns=12,
        allowed_tools="Read,Grep,Glob",
        disallowed_tools="Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task",
    )

    out = await run_claude_conversation(
        message="talk to me",
        config=cfg,
        state=state,
        env={"PATH": "/bin", "CLAUDE_CODE_OAUTH_TOKEN": "ambient"},
    )

    assert out == "hello from claude"
    args = created["args"]
    assert args[0] == "/bin/claude"
    assert "-p" in args
    assert "talk to me" not in args
    assert "--model" in args
    assert args[args.index("--model") + 1] == "opus"
    assert "--permission-mode" in args
    assert args[args.index("--permission-mode") + 1] == "plan"
    assert "--allowedTools" in args
    assert args[args.index("--allowedTools") + 1] == "Read,Grep,Glob"
    assert "--disallowedTools" in args
    assert (
        args[args.index("--disallowedTools") + 1]
        == "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task"
    )
    assert "--session-id" in args
    assert args[args.index("--session-id") + 1] == state.claude_session_id
    assert created["kwargs"]["cwd"] == str(tmp_path)
    assert created["kwargs"]["stdin"] is asyncio.subprocess.PIPE
    assert created["kwargs"]["start_new_session"] is True
    assert b"User message:\ntalk to me" in created["stdin"]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in created["kwargs"]["env"]


@pytest.mark.asyncio
async def test_run_claude_conversation_marks_session_created_after_success(
    monkeypatch,
    tmp_path,
):
    store = ClaudeModeStateStore(tmp_path / "state.json")
    cfg_state = ClaudeSidecarConfig(workdir=str(tmp_path))
    state = store.get("telegram:dm:1", cfg_state)

    class FakeProcess:
        returncode = 0

        async def communicate(self, input=None):
            return b"created", b""

    async def fake_create_subprocess_exec(*args, **kwargs):
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    out = await run_claude_conversation(
        message="first turn succeeds",
        config=cfg_state,
        state=state,
        state_store=store,
        session_key="telegram:dm:1",
    )

    assert out == "created"
    assert store.get("telegram:dm:1", cfg_state).created is True


@pytest.mark.asyncio
async def test_run_claude_conversation_recovers_existing_session_error(
    monkeypatch,
    tmp_path,
):
    store = ClaudeModeStateStore(tmp_path / "state.json")
    cfg_state = ClaudeSidecarConfig(workdir=str(tmp_path))
    state = store.get("telegram:dm:1", cfg_state)
    calls = []

    class FakeProcess:
        def __init__(self, returncode, stdout=b"", stderr=b""):
            self.returncode = returncode
            self._stdout = stdout
            self._stderr = stderr

        async def communicate(self, input=None):
            return self._stdout, self._stderr

    async def fake_create_subprocess_exec(*args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            return FakeProcess(1, stderr=b"Session already exists")
        return FakeProcess(0, stdout=b"resumed ok")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    out = await run_claude_conversation(
        message="recover",
        config=cfg_state,
        state=state,
        state_store=store,
        session_key="telegram:dm:1",
    )

    assert out == "resumed ok"
    assert "--session-id" in calls[0]
    assert "--resume" in calls[1]
    assert store.get("telegram:dm:1", cfg_state).created is True


@pytest.mark.asyncio
async def test_run_claude_conversation_resumes_created_session(monkeypatch, tmp_path):
    created = {}

    class FakeProcess:
        returncode = 0

        async def communicate(self, input=None):
            return b"resumed", b""

    async def fake_create_subprocess_exec(*args, **kwargs):
        created["args"] = args
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    state = ClaudeSessionState(
        mode="claude",
        model="sonnet",
        claude_session_id=str(uuid.uuid4()),
        created=True,
    )
    cfg = ClaudeSidecarConfig(claude_bin="/bin/claude", workdir=str(tmp_path))

    await run_claude_conversation(message="again", config=cfg, state=state)

    args = created["args"]
    assert "--resume" in args
    assert args[args.index("--resume") + 1] == state.claude_session_id
    assert "--session-id" not in args


@pytest.mark.asyncio
async def test_turn_lock_registry_reuses_lock_per_session():
    registry = ClaudeTurnLockRegistry()
    lock_a1 = await registry.get("a")
    lock_a2 = await registry.get("a")
    lock_b = await registry.get("b")

    assert lock_a1 is lock_a2
    assert lock_a1 is not lock_b


@pytest.mark.asyncio
async def test_run_claude_conversation_kills_process_group_on_timeout(
    monkeypatch,
    tmp_path,
):
    killed = {}

    class FakeProcess:
        pid = 12345

        async def communicate(self, input=None):
            await asyncio.sleep(1)
            return b"", b""

        async def wait(self):
            return 0

        def kill(self):
            killed["fallback"] = True

    async def fake_create_subprocess_exec(*args, **kwargs):
        return FakeProcess()

    def fake_killpg(pid, sig):
        killed["pid"] = pid
        killed["sig"] = sig

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(os, "killpg", fake_killpg)

    state = ClaudeSessionState(
        mode="claude",
        model="sonnet",
        claude_session_id=str(uuid.uuid4()),
    )
    cfg = ClaudeSidecarConfig(
        claude_bin="/bin/claude",
        workdir=str(tmp_path),
        timeout_seconds=1,
    )

    with pytest.raises(TimeoutError):
        await run_claude_conversation(message="slow", config=cfg, state=state)

    assert killed == {"pid": 12345, "sig": signal.SIGKILL}


def test_env_with_profile_injects_only_claude_auth_keys(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "export CLAUDE_CODE_OAUTH_TOKEN=profile-token",
                "OPENAI_API_KEY=should-not-leak",
            ]
        ),
        encoding="utf-8",
    )

    env = _env_with_profile(
        env={
            "PATH": "/bin",
            "CLAUDE_CODE_OAUTH_TOKEN": "ambient-token",
            "OPENAI_API_KEY": "ambient-openai",
        },
        hermes_home=tmp_path,
    )

    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "profile-token"
    assert env["OPENAI_API_KEY"] == "ambient-openai"
