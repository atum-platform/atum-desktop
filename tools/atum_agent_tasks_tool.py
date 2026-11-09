"""Authenticated hand-offs between persistent owned Atum agents."""

from __future__ import annotations

import json
import re

from tools import desktop_ui
from tools.registry import registry, tool_error

_UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
_MAX_TEXT_BYTES = 40_000
_HOST_TIMEOUT_SECONDS = 90

_MODEL_FIELDS_BY_OPERATION = {
    "start": ("target", "prompt", "timeout_minutes"),
    "list": (),
    "read": ("task_id",),
    "stop": ("task_id",),
    "steer": ("task_id", "text"),
}


def atum_agent_tasks(
    operation: str,
    target: str = "",
    task_id: str = "",
    prompt: str = "",
    text: str = "",
    timeout_minutes: int | None = None,
) -> str:
    """Start, inspect or control one durable named-agent task."""
    if operation not in {"start", "list", "read", "stop", "steer"}:
        return tool_error("operation must be start, list, read, stop, or steer.")

    payload: dict[str, object] = {"operation": operation}
    if operation == "start":
        if not isinstance(target, str) or not _UUID.fullmatch(target):
            return tool_error("start requires the exact target principal returned by atum_agents list.")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode("utf-8")) > _MAX_TEXT_BYTES:
            return tool_error("prompt must be from 1 through 40000 UTF-8 bytes.")
        if timeout_minutes is not None and (
            isinstance(timeout_minutes, bool)
            or not isinstance(timeout_minutes, int)
            or not 1 <= timeout_minutes <= 30
        ):
            return tool_error("timeout_minutes must be an integer from 1 through 30.")
        if task_id or text:
            return tool_error("start accepts target, prompt, and an optional timeout_minutes only.")
        payload.update(target=target, prompt=prompt)
        if timeout_minutes is not None:
            payload["timeoutMinutes"] = timeout_minutes
    elif operation == "list":
        if any((target, task_id, prompt, text, timeout_minutes is not None)):
            return tool_error("list does not accept task fields.")
    else:
        if not isinstance(task_id, str) or not _UUID.fullmatch(task_id):
            return tool_error(f"{operation} requires an exact task_id returned by start or list.")
        if target or prompt or timeout_minutes is not None:
            return tool_error(f"{operation} does not accept target, prompt, or timeout_minutes.")
        payload["taskId"] = task_id
        if operation == "steer":
            if not isinstance(text, str) or not text.strip() or len(text.encode("utf-8")) > _MAX_TEXT_BYTES:
                return tool_error("steer requires text from 1 through 40000 UTF-8 bytes.")
            payload["text"] = text
        elif text:
            return tool_error(f"{operation} does not accept text.")

    # Starting or coordinating a task can require a roster refresh plus several
    # Matrix operations. Keep this above the host's individual request budgets.
    receipt = desktop_ui.request("atum.agent_tasks.request", payload, timeout=_HOST_TIMEOUT_SECONDS)
    if receipt is None:
        return tool_error("Agent tasks are available only through a live Atum agent turn.")
    if not receipt:
        return tool_error("The Atum host did not confirm the task request.")
    try:
        result = json.loads(receipt)
    except (TypeError, ValueError):
        return tool_error("The Atum host returned an invalid task response.")
    if not isinstance(result, dict):
        return tool_error("The Atum host returned an invalid task response.")
    if result.get("error"):
        return tool_error(str(result["error"]))
    if not (isinstance(result.get("tasks"), list) ^ isinstance(result.get("task"), dict)):
        return tool_error("The Atum host returned an invalid task response.")
    return json.dumps(result, ensure_ascii=False)


ATUM_AGENT_TASKS_SCHEMA = {
    "name": "atum_agent_tasks",
    "description": (
        "Hand a durable task to another owned Atum agent and inspect or control it. "
        "The target uses its own identity, tools, model grant, billing, and Hermes home. "
        "start returns pending until the target acknowledges; stop_requested and steer_sent "
        "confirm delivery only, while the task state remains the execution truth. Ordinary "
        "agents control tasks they started; the current Main agent may coordinate owned tasks."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "operation": {"type": "string", "enum": ["start", "list", "read", "stop", "steer"]},
            "target": {"type": "string", "description": "Exact target agent principal from atum_agents list."},
            "task_id": {"type": "string", "description": "Exact task ID returned by start or list."},
            "prompt": {"type": "string", "description": "Complete task for the target agent."},
            "text": {"type": "string", "description": "Additional direction for a running task."},
            "timeout_minutes": {"type": "integer", "minimum": 1, "maximum": 30},
        },
        "required": ["operation"],
    },
}


def _handle_atum_agent_tasks(args: object) -> str:
    if not isinstance(args, dict):
        return atum_agent_tasks(operation="")
    operation = args.get("operation", "")
    fields = (
        _MODEL_FIELDS_BY_OPERATION.get(operation, ())
        if isinstance(operation, str)
        else ()
    )
    selected = {
        field: args[field]
        for field in fields
        if field in args
    }
    return atum_agent_tasks(
        operation=operation,
        target=selected.get("target", ""),
        task_id=selected.get("task_id", ""),
        prompt=selected.get("prompt", ""),
        text=selected.get("text", ""),
        timeout_minutes=selected.get("timeout_minutes"),
    )


registry.register(
    name="atum_agent_tasks",
    toolset="atum_agent_tasks",
    schema=ATUM_AGENT_TASKS_SCHEMA,
    handler=lambda args, **_kw: _handle_atum_agent_tasks(args),
    check_fn=desktop_ui.available,
    emoji="⇄",
)
