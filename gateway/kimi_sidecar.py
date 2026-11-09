"""Kimi Code ACP sidecar support for gateway conversation routing."""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections import deque
from pathlib import Path
from typing import Any

from gateway.claude_sidecar import (
    ClaudeModeStateStore,
    ClaudeSessionState,
    ClaudeSidecarConfig,
    _format_shared_history,
    _kill_process_tree,
    _read_prompt_files,
)
from tools.environments.local import hermes_subprocess_env


KIMI_SIDECAR_TRANSCRIPT_MARKER = "<!-- hermes:kimi-sidecar -->"


class KimiACPError(RuntimeError):
    """An ACP request failed or the Kimi subprocess exited unexpectedly."""


def build_kimi_conversation_prompt(
    *,
    message: str,
    config: ClaudeSidecarConfig,
    context_prompt: str = "",
    shared_history: list[dict[str, Any]] | None = None,
) -> str:
    sections = [
        "You are responding in direct Kimi conversation mode inside Hermes.",
        "Be conversational and preserve the agent's identity and boundaries.",
    ]
    if config.allow_mutating_tools:
        sections.append(
            "You may use the configured Kimi Code tools when the user asks for "
            "concrete execution. Keep changes scoped to the active workspace and "
            "explain risky filesystem or shell actions before doing them."
        )
    else:
        sections.append(
            "Do not edit files, run mutating commands, send messages, or change "
            "external systems. Hand execution work back to Codex."
        )
    if config.append_system_prompt.strip():
        sections.append(config.append_system_prompt.strip())
    if config.include_context_prompt and context_prompt.strip():
        sections.append(f"Hermes session context:\n{context_prompt.strip()}")
    history_text = _format_shared_history(
        shared_history or [],
        sidecar_marker=KIMI_SIDECAR_TRANSCRIPT_MARKER,
    )
    if history_text:
        sections.append("Recent shared Hermes transcript:\n" + history_text)
    prompt_docs = _read_prompt_files(config.prompt_files, config.workdir)
    if prompt_docs:
        sections.append("Agent identity/context documents:\n" + prompt_docs)
    sections.append("User message:\n" + message.strip())
    return "\n\n".join(part for part in sections if part.strip())


async def run_kimi_conversation(
    *,
    message: str,
    config: ClaudeSidecarConfig,
    state: ClaudeSessionState,
    context_prompt: str = "",
    shared_history: list[dict[str, Any]] | None = None,
    state_store: ClaudeModeStateStore | None = None,
    session_key: str | None = None,
    env: dict[str, str] | None = None,
) -> str:
    """Run one Kimi ACP turn, loading the prior ACP session when available."""
    if not message or not message.strip():
        raise ValueError("message is required")

    cwd = Path(config.workdir).expanduser().resolve()
    prompt = build_kimi_conversation_prompt(
        message=message,
        config=config,
        context_prompt=context_prompt,
        shared_history=shared_history,
    )
    process_env = hermes_subprocess_env(inherit_credentials=True)
    if env is not None:
        process_env.update(env)

    client = _KimiACPProcess(
        command=config.kimi_bin,
        cwd=cwd,
        env=process_env,
        timeout_seconds=config.kimi_timeout_seconds,
    )
    try:
        await client.start()
        await client.request(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {
                    "name": "hermes-agent",
                    "title": "Hermes Agent",
                    "version": "0.0.0",
                },
            },
        )

        session_id = state.kimi_session_id if state.kimi_created else ""
        if session_id:
            try:
                await client.request(
                    "session/load",
                    {
                        "sessionId": session_id,
                        "cwd": str(cwd),
                        "mcpServers": [],
                    },
                )
            except KimiACPError:
                session_id = ""

        if not session_id:
            result = await client.request(
                "session/new",
                {"cwd": str(cwd), "mcpServers": []},
            ) or {}
            session_id = str(result.get("sessionId") or "").strip()
            if not session_id:
                raise KimiACPError("Kimi ACP session/new did not return a sessionId")
            if state_store is not None and session_key:
                state_store.set_kimi_session(session_key, session_id, config)

        await client.request(
            "session/set_config_option",
            {
                "sessionId": session_id,
                "configId": "model",
                "value": config.kimi_model,
            },
        )
        await client.request(
            "session/set_config_option",
            {
                "sessionId": session_id,
                "configId": "mode",
                "value": config.kimi_mode,
            },
        )
        text_parts: list[str] = []
        await client.request(
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": prompt}],
            },
            text_parts=text_parts,
        )
        response = "".join(text_parts).strip()
        if not response:
            raise KimiACPError("Kimi ACP completed without an assistant response")
        return response
    finally:
        await client.close()


class _KimiACPProcess:
    """Small sequential JSON-RPC client for one Kimi ACP turn."""

    def __init__(
        self,
        *,
        command: str,
        cwd: Path,
        env: dict[str, str],
        timeout_seconds: int,
    ) -> None:
        self.command = command
        self.cwd = cwd
        self.env = env
        self.timeout_seconds = timeout_seconds
        self.process: asyncio.subprocess.Process | None = None
        self._next_id = 0
        self._stderr_tail: deque[str] = deque(maxlen=40)
        self._stderr_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        try:
            self.process = await asyncio.create_subprocess_exec(
                self.command,
                "acp",
                cwd=str(self.cwd),
                env=self.env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            raise KimiACPError(
                f"Could not start Kimi Code at '{self.command}'. Set conversation.kimi_bin."
            ) from exc
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    async def close(self) -> None:
        process = self.process
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                _kill_process_tree(process)
                await process.wait()
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stderr_task

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        text_parts: list[str] | None = None,
    ) -> Any:
        process = self.process
        if process is None or process.stdin is None or process.stdout is None:
            raise KimiACPError("Kimi ACP process is not running")
        self._next_id += 1
        request_id = self._next_id
        await self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }
        )

        async def _wait_for_response() -> Any:
            while True:
                line = await process.stdout.readline()
                if not line:
                    detail = "\n".join(self._stderr_tail).strip()
                    suffix = f": {detail}" if detail else ""
                    raise KimiACPError(f"Kimi ACP exited during {method}{suffix}")
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if await self._handle_server_message(message, text_parts=text_parts):
                    continue
                if message.get("id") != request_id:
                    continue
                if "error" in message:
                    error = message.get("error") or {}
                    raise KimiACPError(
                        f"Kimi ACP {method} failed: {error.get('message') or error}"
                    )
                return message.get("result")

        try:
            return await asyncio.wait_for(
                _wait_for_response(),
                timeout=self.timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"Kimi conversation timed out after {self.timeout_seconds}s during {method}"
            ) from exc

    async def _handle_server_message(
        self,
        message: dict[str, Any],
        *,
        text_parts: list[str] | None,
    ) -> bool:
        method = message.get("method")
        if not isinstance(method, str):
            return False
        if method == "session/update":
            update = ((message.get("params") or {}).get("update") or {})
            if update.get("sessionUpdate") == "agent_message_chunk" and text_parts is not None:
                content = update.get("content") or {}
                text_parts.append(str(content.get("text") or ""))
            return True
        if "id" not in message:
            return True
        if method == "session/request_permission":
            await self._write(
                {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {"outcome": {"outcome": "cancelled"}},
                }
            )
            return True
        await self._write(
            {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "error": {
                    "code": -32601,
                    "message": f"ACP client method '{method}' is not supported by Hermes",
                },
            }
        )
        return True

    async def _write(self, payload: dict[str, Any]) -> None:
        process = self.process
        if process is None or process.stdin is None:
            raise KimiACPError("Kimi ACP stdin is unavailable")
        process.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await process.stdin.drain()

    async def _drain_stderr(self) -> None:
        process = self.process
        if process is None or process.stderr is None:
            return
        while True:
            line = await process.stderr.readline()
            if not line:
                return
            self._stderr_tail.append(line.decode("utf-8", errors="replace").rstrip())
