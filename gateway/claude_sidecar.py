"""Claude Code sidecar support for gateway-level conversation routing.

This module is intentionally independent from ``gateway.run`` so direct
Claude conversation mode can be tested without constructing a gateway.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import tempfile
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hermes_constants import get_hermes_home
from utils import atomic_json_write, is_truthy_value


CLAUDE_AUTH_KEYS = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
}

DEFAULT_CLAUDE_BIN = "claude"
DEFAULT_CLAUDE_TIMEOUT_SECONDS = 600
DEFAULT_CLAUDE_MAX_TURNS = 60
MIN_CLAUDE_MAX_TURNS = 1
MAX_CLAUDE_MAX_TURNS = 60
DEFAULT_KIMI_BIN = "kimi"
DEFAULT_KIMI_MODEL = "kimi-code/k3"
DEFAULT_KIMI_TIMEOUT_SECONDS = 600

VALID_MODES = frozenset({"codex", "claude", "kimi"})
VALID_PERMISSION_MODES = frozenset({"default", "acceptEdits", "bypassPermissions", "plan"})
VALID_KIMI_MODES = frozenset({"default", "plan", "auto", "yolo"})
MUTATING_TOOL_ROOTS = frozenset(
    {
        "bash",
        "edit",
        "write",
        "notebookedit",
        "webfetch",
        "websearch",
        "task",
    }
)
MODEL_ALIASES = {
    "sonnet": "sonnet",
    "opus": "opus",
    "fable": "fable",
}
CLAUDE_SIDECAR_TRANSCRIPT_MARKER = "<!-- hermes:claude-sidecar -->"


@dataclass(frozen=True)
class ClaudeSidecarConfig:
    """Profile-local config for Claude conversation mode."""

    enabled: bool = True
    default_mode: str = "codex"
    default_model: str = "sonnet"
    opus_model: str = "opus"
    sonnet_model: str = "sonnet"
    fable_model: str = "fable"
    claude_bin: str = DEFAULT_CLAUDE_BIN
    timeout_seconds: int = DEFAULT_CLAUDE_TIMEOUT_SECONDS
    max_turns: int = DEFAULT_CLAUDE_MAX_TURNS
    permission_mode: str = "plan"
    allowed_tools: str = ""
    disallowed_tools: str = ""
    allow_mutating_tools: bool = False
    workdir: str = ""
    prompt_files: tuple[str, ...] = ()
    include_context_prompt: bool = True
    append_system_prompt: str = ""
    kimi_enabled: bool = True
    kimi_bin: str = DEFAULT_KIMI_BIN
    kimi_model: str = DEFAULT_KIMI_MODEL
    kimi_mode: str = "plan"
    kimi_timeout_seconds: int = DEFAULT_KIMI_TIMEOUT_SECONDS

    @classmethod
    def from_gateway_config(
        cls,
        user_config: dict[str, Any] | None,
        *,
        hermes_home: Path | None = None,
    ) -> "ClaudeSidecarConfig":
        cfg = user_config or {}
        raw = cfg.get("conversation") or cfg.get("claude_conversation") or {}
        if not isinstance(raw, dict):
            raw = {}

        default_mode = _normalize_mode(raw.get("default_mode"), default="codex")
        default_model = _normalize_model(raw.get("default_model"), default="sonnet")
        sonnet_model = _normalize_model(raw.get("sonnet_model"), default="sonnet")
        opus_model = _normalize_model(raw.get("opus_model"), default="opus")
        fable_model = _normalize_model(raw.get("fable_model"), default="fable")

        timeout_seconds = _bounded_int(
            raw.get("timeout_seconds"),
            default=DEFAULT_CLAUDE_TIMEOUT_SECONDS,
            minimum=30,
            maximum=3600,
        )
        max_turns = _bounded_int(
            raw.get("max_turns"),
            default=DEFAULT_CLAUDE_MAX_TURNS,
            minimum=MIN_CLAUDE_MAX_TURNS,
            maximum=MAX_CLAUDE_MAX_TURNS,
        )

        workdir = str(raw.get("workdir") or "")
        if not workdir:
            terminal_cfg = cfg.get("terminal") or {}
            if isinstance(terminal_cfg, dict):
                workdir = str(terminal_cfg.get("cwd") or "")
        if not workdir:
            home = hermes_home or get_hermes_home()
            workdir = _safe_default_workdir(home)
        else:
            workdir = _avoid_secret_workdir(workdir, hermes_home or get_hermes_home())

        prompt_files = _coerce_path_tuple(raw.get("prompt_files"))
        append_system_prompt = str(raw.get("append_system_prompt") or "")
        permission_mode = _normalize_permission_mode(raw.get("permission_mode"))
        allowed_tools = _normalize_tool_csv(raw.get("allowed_tools"))
        disallowed_tools = _normalize_tool_csv(raw.get("disallowed_tools"))
        allow_mutating_tools = is_truthy_value(
            raw.get("allow_mutating_tools"),
            default=False,
        )
        _validate_claude_tool_policy(
            allowed_tools,
            permission_mode,
            allow_mutating_tools=allow_mutating_tools,
        )
        kimi_mode = _normalize_kimi_mode(raw.get("kimi_mode"))
        if kimi_mode in {"auto", "yolo"} and not allow_mutating_tools:
            raise ValueError(
                f"Kimi conversation mode `{kimi_mode}` requires allow_mutating_tools"
            )

        return cls(
            enabled=is_truthy_value(raw.get("enabled"), default=True),
            default_mode=default_mode,
            default_model=default_model,
            opus_model=opus_model,
            sonnet_model=sonnet_model,
            fable_model=fable_model,
            claude_bin=str(raw.get("claude_bin") or DEFAULT_CLAUDE_BIN),
            timeout_seconds=timeout_seconds,
            max_turns=max_turns,
            permission_mode=permission_mode,
            allowed_tools=allowed_tools,
            disallowed_tools=disallowed_tools,
            allow_mutating_tools=allow_mutating_tools,
            workdir=workdir,
            prompt_files=prompt_files,
            include_context_prompt=is_truthy_value(
                raw.get("include_context_prompt"),
                default=True,
            ),
            append_system_prompt=append_system_prompt,
            kimi_enabled=is_truthy_value(raw.get("kimi_enabled"), default=True),
            kimi_bin=str(raw.get("kimi_bin") or DEFAULT_KIMI_BIN),
            kimi_model=str(raw.get("kimi_model") or DEFAULT_KIMI_MODEL),
            kimi_mode=kimi_mode,
            kimi_timeout_seconds=_bounded_int(
                raw.get("kimi_timeout_seconds"),
                default=DEFAULT_KIMI_TIMEOUT_SECONDS,
                minimum=30,
                maximum=3600,
            ),
        )

    def resolve_model(self, requested: str | None = None) -> str:
        model = _normalize_model(requested, default=self.default_model)
        if model == "sonnet":
            return self.sonnet_model
        if model == "opus":
            return self.opus_model
        if model == "fable":
            return self.fable_model
        return model


@dataclass(frozen=True)
class ClaudeSessionState:
    mode: str
    model: str
    claude_session_id: str
    created: bool = False
    kimi_session_id: str = ""
    kimi_created: bool = False


class ClaudeModeStateStore:
    """Persistent per-gateway-session Claude mode state."""

    def __init__(self, path: Path | None = None):
        self.path = path or (get_hermes_home() / "claude_sidecar_state.json")
        self._lock_holder = threading.local()

    def get(self, session_key: str, config: ClaudeSidecarConfig) -> ClaudeSessionState:
        with self._locked_data() as data:
            return self._state_from_data(data, session_key, config)

    def peek(self, session_key: str, config: ClaudeSidecarConfig) -> ClaudeSessionState:
        """Return session state without creating or saving a sidecar entry."""
        with self._read_data() as data:
            sessions = data.get("sessions", {})
            raw = sessions.get(session_key) if isinstance(sessions, dict) else None
            return self._state_from_raw(raw, config)

    def set_mode(
        self,
        session_key: str,
        mode: str,
        config: ClaudeSidecarConfig,
    ) -> ClaudeSessionState:
        with self._locked_data() as data:
            state = self._state_from_data(data, session_key, config)
            sessions = data.setdefault("sessions", {})
            sessions[session_key] = {
                "mode": _normalize_mode(mode, default=config.default_mode),
                "model": state.model,
                "claude_session_id": state.claude_session_id,
                "created": state.created,
                "kimi_session_id": state.kimi_session_id,
                "kimi_created": state.kimi_created,
            }
            return self._state_from_data(data, session_key, config)

    def set_model(
        self,
        session_key: str,
        model: str,
        config: ClaudeSidecarConfig,
    ) -> ClaudeSessionState:
        with self._locked_data() as data:
            state = self._state_from_data(data, session_key, config)
            sessions = data.setdefault("sessions", {})
            sessions[session_key] = {
                "mode": state.mode,
                "model": _normalize_model(model, default=config.default_model),
                "claude_session_id": state.claude_session_id,
                "created": state.created,
                "kimi_session_id": state.kimi_session_id,
                "kimi_created": state.kimi_created,
            }
            return self._state_from_data(data, session_key, config)

    def mark_created(
        self,
        session_key: str,
        config: ClaudeSidecarConfig,
    ) -> ClaudeSessionState:
        with self._locked_data() as data:
            state = self._state_from_data(data, session_key, config)
            sessions = data.setdefault("sessions", {})
            sessions[session_key] = {
                "mode": state.mode,
                "model": state.model,
                "claude_session_id": state.claude_session_id,
                "created": True,
                "kimi_session_id": state.kimi_session_id,
                "kimi_created": state.kimi_created,
            }
            return self._state_from_data(data, session_key, config)

    def set_kimi_session(
        self,
        session_key: str,
        kimi_session_id: str,
        config: ClaudeSidecarConfig,
    ) -> ClaudeSessionState:
        """Persist the ACP-created Kimi session for future ``session/load`` calls."""
        sid = str(kimi_session_id or "").strip()
        if not sid:
            raise ValueError("kimi_session_id is required")
        with self._locked_data() as data:
            state = self._state_from_data(data, session_key, config)
            sessions = data.setdefault("sessions", {})
            sessions[session_key] = {
                "mode": state.mode,
                "model": state.model,
                "claude_session_id": state.claude_session_id,
                "created": state.created,
                "kimi_session_id": sid,
                "kimi_created": True,
            }
            return self._state_from_data(data, session_key, config)

    def reset(self, session_key: str) -> None:
        with self._locked_data() as data:
            sessions = data.setdefault("sessions", {})
            sessions.pop(session_key, None)

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        if not isinstance(data.get("sessions"), dict):
            data["sessions"] = {}
        return data

    def _save(self, data: dict[str, Any]) -> None:
        atomic_json_write(self.path, data, indent=2, sort_keys=True)

    @contextlib.contextmanager
    def _locked_data(self):
        from hermes_cli.auth import _file_lock

        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        with _file_lock(
            lock_path,
            self._lock_holder,
            timeout_seconds=30,
            timeout_message=f"Timed out waiting for Claude sidecar state lock ({lock_path})",
        ):
            data = self._load()
            yield data
            self._save(data)

    @contextlib.contextmanager
    def _read_data(self):
        from hermes_cli.auth import _file_lock

        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        with _file_lock(
            lock_path,
            self._lock_holder,
            timeout_seconds=30,
            timeout_message=f"Timed out waiting for Claude sidecar state lock ({lock_path})",
        ):
            yield self._load()

    def _state_from_data(
        self,
        data: dict[str, Any],
        session_key: str,
        config: ClaudeSidecarConfig,
    ) -> ClaudeSessionState:
        sessions = data.setdefault("sessions", {})
        raw = sessions.get(session_key)
        if not isinstance(raw, dict):
            raw = {}
        state = self._state_from_raw(raw, config)
        sessions[session_key] = {
            "mode": state.mode,
            "model": state.model,
            "claude_session_id": state.claude_session_id,
            "created": state.created,
            "kimi_session_id": state.kimi_session_id,
            "kimi_created": state.kimi_created,
        }
        return state

    def _state_from_raw(
        self,
        raw: Any,
        config: ClaudeSidecarConfig,
    ) -> ClaudeSessionState:
        if not isinstance(raw, dict):
            raw = {}
        mode = _normalize_mode(raw.get("mode"), default=config.default_mode)
        model = _normalize_model(raw.get("model"), default=config.default_model)
        sid = str(raw.get("claude_session_id") or "")
        created = bool(raw.get("created"))
        kimi_session_id = str(raw.get("kimi_session_id") or "").strip()
        kimi_created = bool(raw.get("kimi_created") and kimi_session_id)
        if not _is_uuid(sid):
            sid = str(uuid.uuid4())
            created = False
        return ClaudeSessionState(
            mode=mode,
            model=model,
            claude_session_id=sid,
            created=created,
            kimi_session_id=kimi_session_id,
            kimi_created=kimi_created,
        )


class ClaudeTurnLockRegistry:
    """In-process per-session locks for direct Claude turns."""

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._guard = asyncio.Lock()

    async def get(self, session_key: str) -> asyncio.Lock:
        async with self._guard:
            lock = self._locks.get(session_key)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[session_key] = lock
            return lock


def build_claude_conversation_prompt(
    *,
    message: str,
    config: ClaudeSidecarConfig,
    context_prompt: str = "",
    shared_history: list[dict[str, Any]] | None = None,
) -> str:
    """Build the user prompt passed to Claude Code conversation mode."""
    sections: list[str] = [
        "You are responding in direct Claude conversation mode inside Hermes.",
        "Be conversational and preserve the agent's identity and boundaries.",
    ]
    if config.allow_mutating_tools:
        sections.append(
            "You may use the configured Claude Code tools when the user asks for concrete execution. "
            "Be deliberate: explain risky filesystem or shell actions before doing them, and keep changes scoped to the active workspace."
        )
    else:
        sections.extend(
            [
                "Do not edit files, run mutating commands, send messages, or change external systems.",
                "If the user asks for execution or coding work, propose a clear handoff to Codex instead of doing it yourself.",
            ]
        )
    if config.append_system_prompt.strip():
        sections.append(config.append_system_prompt.strip())
    if config.include_context_prompt and context_prompt.strip():
        sections.append(f"Hermes session context:\n{context_prompt.strip()}")
    history_text = _format_shared_history(shared_history or [])
    if history_text:
        sections.append("Recent shared Hermes/Codex transcript:\n" + history_text)
    prompt_docs = _read_prompt_files(config.prompt_files, config.workdir)
    if prompt_docs:
        sections.append("Agent identity/context documents:\n" + prompt_docs)
    sections.append("User message:\n" + (message or "").strip())
    return "\n\n".join(part for part in sections if part.strip())


async def run_claude_conversation(
    *,
    message: str,
    config: ClaudeSidecarConfig,
    state: ClaudeSessionState,
    context_prompt: str = "",
    shared_history: list[dict[str, Any]] | None = None,
    env: dict[str, str] | None = None,
    state_store: ClaudeModeStateStore | None = None,
    session_key: str | None = None,
) -> str:
    """Run one direct Claude Code conversation turn."""
    if not message or not message.strip():
        raise ValueError("message is required")
    cwd = Path(config.workdir).expanduser().resolve()
    prompt = build_claude_conversation_prompt(
        message=message,
        config=config,
        context_prompt=context_prompt,
        shared_history=shared_history,
    )
    resolved_env = _env_with_profile(env=env)
    model = config.resolve_model(state.model)
    current_state = state
    for attempt in range(2):
        result = await _run_claude_process(
            prompt=prompt,
            config=config,
            state=current_state,
            env=resolved_env,
            cwd=cwd,
        )
        if result["ok"]:
            if state_store is not None and session_key and not current_state.created:
                state_store.mark_created(session_key, config)
            return str(result["stdout"]).strip()
        error_text = str(result["stderr"] or result["stdout"]).strip()
        if (
            attempt == 0
            and not current_state.created
            and state_store is not None
            and session_key
            and _looks_like_existing_session_error(error_text)
        ):
            current_state = state_store.mark_created(session_key, config)
            continue
        raise RuntimeError(f"Claude Code exited {result['returncode']}: {error_text}")
    raise RuntimeError("Claude Code failed after session resume recovery")


async def _run_claude_process(
    *,
    prompt: str,
    config: ClaudeSidecarConfig,
    state: ClaudeSessionState,
    env: dict[str, str],
    cwd: Path,
) -> dict[str, Any]:
    model = config.resolve_model(state.model)
    session_args = (
        ("--resume", state.claude_session_id)
        if state.created
        else ("--session-id", state.claude_session_id)
    )
    tool_args: list[str] = []
    if config.allowed_tools:
        tool_args.extend(["--allowedTools", config.allowed_tools])
    if config.disallowed_tools:
        tool_args.extend(["--disallowedTools", config.disallowed_tools])
    proc = await asyncio.create_subprocess_exec(
        config.claude_bin,
        "-p",
        "--model",
        model,
        "--permission-mode",
        config.permission_mode,
        "--max-turns",
        str(config.max_turns),
        *tool_args,
        *session_args,
        cwd=str(cwd),
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(prompt.encode("utf-8")),
            timeout=config.timeout_seconds,
        )
    except asyncio.TimeoutError:
        _kill_process_tree(proc)
        await proc.wait()
        raise TimeoutError(
            f"Claude conversation timed out after {config.timeout_seconds}s"
        )

    out = stdout.decode("utf-8", errors="replace").strip()
    err = stderr.decode("utf-8", errors="replace").strip()
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": out,
        "stderr": err,
    }


def _normalize_mode(value: Any, *, default: str) -> str:
    mode = str(value or default).strip().lower()
    return mode if mode in VALID_MODES else default


def _normalize_model(value: Any, *, default: str) -> str:
    model = str(value or default).strip().lower()
    return MODEL_ALIASES.get(model, model or default)


def _normalize_permission_mode(value: Any) -> str:
    mode = str(value or "plan").strip() or "plan"
    return mode if mode in VALID_PERMISSION_MODES else "plan"


def _normalize_kimi_mode(value: Any) -> str:
    mode = str(value or "plan").strip().lower() or "plan"
    return mode if mode in VALID_KIMI_MODES else "plan"


def _normalize_tool_csv(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        parts = [str(item).strip() for item in value]
    else:
        parts = str(value).replace(" ", ",").split(",")
    return ",".join(part for part in parts if part)


def _tool_roots(csv: str) -> set[str]:
    roots: set[str] = set()
    for item in _normalize_tool_csv(csv).split(","):
        if not item:
            continue
        roots.add(item.split("(", 1)[0].strip().lower())
    return roots


def _validate_claude_tool_policy(
    allowed_tools: str,
    permission_mode: str,
    *,
    allow_mutating_tools: bool = False,
) -> None:
    if permission_mode == "bypassPermissions":
        raise ValueError("Claude conversation mode refuses bypassPermissions")
    mutating_allowed = _tool_roots(allowed_tools) & MUTATING_TOOL_ROOTS
    if mutating_allowed and not allow_mutating_tools:
        tools = ", ".join(sorted(mutating_allowed))
        raise ValueError(f"Claude conversation mode refuses mutating allowed tools: {tools}")


def _format_shared_history(
    history: list[dict[str, Any]],
    *,
    max_messages: int = 24,
    max_chars: int = 16000,
    sidecar_marker: str = CLAUDE_SIDECAR_TRANSCRIPT_MARKER,
) -> str:
    """Render transcript rows not already held by the selected sidecar session."""
    rendered: list[str] = []
    selected = _select_shared_history_for_sidecar(
        history,
        max_messages=max_messages,
        sidecar_marker=sidecar_marker,
    )
    for msg in selected:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "").strip()
        if role not in {"user", "assistant", "system", "tool"}:
            continue
        content = msg.get("content")
        if not content:
            continue
        text = _compact_history_content(content).strip()
        if not text:
            continue
        if role == "assistant":
            text = (
                text.replace(sidecar_marker, "")
                .replace(CLAUDE_SIDECAR_TRANSCRIPT_MARKER, "")
                .replace("<!-- hermes:kimi-sidecar -->", "")
                .strip()
            )
        if role == "tool":
            tool_name = str(msg.get("tool_name") or "tool").strip()
            rendered.append(f"tool result ({tool_name}): {text}")
        else:
            rendered.append(f"{role}: {text}")

    if not rendered:
        return ""

    text = "\n\n".join(rendered)
    if len(text) <= max_chars:
        return text
    return "[Earlier shared history truncated]\n" + text[-max_chars:].lstrip()


def _select_shared_history_for_claude(
    history: list[dict[str, Any]],
    *,
    max_messages: int,
) -> list[dict[str, Any]]:
    """Backward-compatible Claude wrapper for sidecar history selection."""
    return _select_shared_history_for_sidecar(
        history,
        max_messages=max_messages,
        sidecar_marker=CLAUDE_SIDECAR_TRANSCRIPT_MARKER,
    )


def _select_shared_history_for_sidecar(
    history: list[dict[str, Any]],
    *,
    max_messages: int,
    sidecar_marker: str,
) -> list[dict[str, Any]]:
    """Choose transcript rows the active persistent sidecar does not own."""
    filtered: list[dict[str, Any]] = []
    skip_previous_user = False
    for msg in reversed(history or []):
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "").strip()
        content = msg.get("content")
        is_sidecar_assistant = (
            role == "assistant"
            and isinstance(content, str)
            and sidecar_marker in content
        )
        if is_sidecar_assistant:
            skip_previous_user = True
            continue
        if skip_previous_user and role == "user":
            skip_previous_user = False
            continue
        skip_previous_user = False
        if role in {"user", "assistant", "system", "tool"}:
            filtered.append(msg)
        if len(filtered) >= max_messages:
            break
    return list(reversed(filtered))


def _strip_sidecar_marker(text: str) -> str:
    return text.replace(CLAUDE_SIDECAR_TRANSCRIPT_MARKER, "").strip()


def _compact_history_content(content: Any, *, max_chars: int = 2000) -> str:
    if isinstance(content, str):
        text = content
    else:
        try:
            text = json.dumps(content, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(content)
    text = text.strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n[truncated]"


def _bounded_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def _coerce_path_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,) if value.strip() else ()
    if isinstance(value, (list, tuple)):
        return tuple(str(item) for item in value if str(item).strip())
    return ()


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except (TypeError, ValueError):
        return False


def _looks_like_existing_session_error(error_text: str) -> bool:
    lowered = error_text.lower()
    return (
        "session" in lowered
        and (
            "already exists" in lowered
            or "exists already" in lowered
            or "duplicate" in lowered
        )
    )


def _safe_default_workdir(hermes_home: Path) -> str:
    cwd = Path.cwd().resolve()
    return str(_avoid_secret_workdir(str(cwd), hermes_home))


def _avoid_secret_workdir(workdir: str, hermes_home: Path) -> str:
    path = Path(workdir).expanduser().resolve()
    home = hermes_home.expanduser().resolve()
    if path == home or home in path.parents:
        cwd = Path.cwd().resolve()
        if cwd != home and home not in cwd.parents:
            return str(cwd)
        fallback = Path(tempfile.gettempdir()) / "hermes-claude-sidecar"
        fallback.mkdir(parents=True, exist_ok=True)
        return str(fallback.resolve())
    return str(path)


def _read_prompt_files(prompt_files: tuple[str, ...], workdir: str) -> str:
    parts: list[str] = []
    base = Path(workdir).expanduser()
    for raw in prompt_files:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = base / path
        try:
            text = path.read_text(encoding="utf-8-sig", errors="ignore").strip()
        except OSError:
            continue
        if text:
            parts.append(f"--- {path} ---\n{text}")
    return "\n\n".join(parts)


def _profile_env(hermes_home: Path | None = None) -> dict[str, str]:
    home = hermes_home or get_hermes_home()
    env_path = home / ".env"
    values: dict[str, str] = {}
    if not env_path.is_file():
        return values
    try:
        lines = env_path.read_text(encoding="utf-8-sig", errors="ignore").splitlines()
    except OSError:
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def _env_with_profile(
    *,
    env: dict[str, str] | None = None,
    hermes_home: Path | None = None,
) -> dict[str, str]:
    resolved = dict(env or os.environ)
    profile_env = _profile_env(hermes_home)
    for key in CLAUDE_AUTH_KEYS:
        resolved.pop(key, None)
        if profile_env.get(key):
            resolved[key] = profile_env[key]
    resolved.setdefault(
        "PATH",
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    )
    return resolved


def _kill_process_tree(proc: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)  # windows-footgun: ok — Exception fallback calls proc.kill()
    except ProcessLookupError:
        return
    except Exception:
        proc.kill()
