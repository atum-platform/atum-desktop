"""One bounded ChatGPT-plan call for the desktop device relay.

The parent process owns authorization and size limits. This helper is intentionally not a server,
tool, or credential API: it reads one JSON request from stdin, uses Hermes's existing
``openai-codex`` credential/session machinery, writes one projected JSON answer, and exits. OAuth
material stays in Hermes's local auth store and never enters stdin/stdout or an exception response.
"""

from __future__ import annotations

import json
import logging
import sys
from types import SimpleNamespace
from typing import Any

from agent.auxiliary_client import call_llm
from agent.history_commentary import _commentary_items, visible_commentary

MAX_INPUT = 800_000
MAX_OUTPUT = 800_000
ALLOWED_EXTRA = {
    "tool_choice", "top_p", "stop", "parallel_tool_calls", "response_format", "seed",
    "frequency_penalty", "presence_penalty",
}

_MISSING = object()
_NO_DEFAULT = object()
_USAGE_FIELDS = (
    "prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens",
    "cache_read_input_tokens", "prompt_cache_hit_tokens",
)
_USAGE_DETAIL_FIELDS = (
    "cached_tokens", "cache_write_tokens", "cache_creation_tokens",
    "cache_creation_input_tokens", "reasoning_tokens",
)


def _member(value: object, name: str, default: object = _NO_DEFAULT) -> Any:
    if isinstance(value, SimpleNamespace):
        fields = vars(value)
    elif isinstance(value, dict):
        fields = value
    else:
        raise TypeError("unsupported relay response object")
    if name in fields:
        return fields[name]
    if default is not _NO_DEFAULT:
        return default
    raise TypeError("missing relay response field")


def _json_scalar(value: object, *, nullable: bool = False) -> Any:
    if value is None and nullable:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError("unsupported relay response scalar")


def _project_tool_call(value: object) -> dict[str, Any]:
    function = _member(value, "function")
    return {
        "id": _json_scalar(_member(value, "id")),
        "type": _json_scalar(_member(value, "type", "function")),
        "function": {
            "name": _json_scalar(_member(function, "name")),
            "arguments": _json_scalar(_member(function, "arguments")),
        },
    }


def _project_message(value: object) -> dict[str, Any]:
    tool_calls = _member(value, "tool_calls", None)
    if tool_calls is not None and not isinstance(tool_calls, (list, tuple)):
        raise TypeError("unsupported relay tool calls")
    projected = {
        "role": _json_scalar(_member(value, "role")),
        "content": _json_scalar(_member(value, "content", None), nullable=True),
        "tool_calls": None if tool_calls is None else [_project_tool_call(call) for call in tool_calls],
    }
    # Chat Completions tool rounds use content for interim narration. Reuse Hermes's
    # phase selector and redactor; reasoning mixes commentary with private analysis.
    # Final-only rounds keep their canonical answer, and provider replay items stay local.
    if tool_calls:
        commentary = [
            visible for text in _commentary_items({
                "codex_message_items": _member(value, "codex_message_items", None)
            }) if (visible := visible_commentary(text))
        ]
        if commentary:
            projected["content"] = "\n\n".join(dict.fromkeys(commentary))
    # The controller's fallback predicate reads message.refusal; dropping it would turn a refusal
    # into an empty, apparently successful answer.
    refusal = _member(value, "refusal", None)
    if refusal is not None:
        projected["refusal"] = _json_scalar(refusal, nullable=True)
    return projected


def _project_usage_details(value: object) -> dict[str, Any]:
    projected = {}
    for name in _USAGE_DETAIL_FIELDS:
        item = _member(value, name, _MISSING)
        if item is not _MISSING:
            projected[name] = _json_scalar(item)
    return projected


def _project_usage(value: object) -> dict[str, Any]:
    projected = {}
    for name in _USAGE_FIELDS:
        item = _member(value, name, _MISSING)
        if item is not _MISSING:
            projected[name] = _json_scalar(item)
    for name in (
        "prompt_tokens_details", "input_tokens_details",
        "completion_tokens_details", "output_tokens_details",
    ):
        item = _member(value, name, _MISSING)
        if item is not _MISSING and item is not None:
            projected[name] = _project_usage_details(item)
    return projected


def _project_namespace_completion(answer: object) -> dict[str, Any]:
    if not isinstance(answer, SimpleNamespace):
        raise TypeError("unsupported relay response type")
    choices = _member(answer, "choices")
    if not isinstance(choices, (list, tuple)):
        raise TypeError("unsupported relay choices")
    projected_choices = []
    for choice in choices:
        projected_choices.append({
            "index": _json_scalar(_member(choice, "index")),
            "message": _project_message(_member(choice, "message")),
            "finish_reason": _json_scalar(_member(choice, "finish_reason", None), nullable=True),
        })
    projected: dict[str, Any] = {
        "choices": projected_choices,
        "model": _json_scalar(_member(answer, "model")),
    }
    usage = _member(answer, "usage", _MISSING)
    if usage is not _MISSING:
        projected["usage"] = None if usage is None else _project_usage(usage)
    return projected


def _write_failure(exit_code: int, stage: str, code: str) -> int:
    encoded = json.dumps(
        {"error": {"stage": stage, "code": code}}, separators=(",", ":")
    ).encode("utf-8")
    sys.stdout.buffer.write(encoded)
    return exit_code


def _main() -> int:
    logging.disable(logging.CRITICAL)
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not raw or len(raw) > MAX_INPUT:
        return 2
    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {"model", "effort", "request"}:
            return 2
        model, effort, request = value["model"], value["effort"], value["request"]
        if not isinstance(model, str) or not isinstance(request, dict) or effort not in {"low", "medium", "high"}:
            return 2
        messages = request.get("messages")
        tools = request.get("tools")
        if not isinstance(messages, list) or not messages or request.get("stream") is True:
            return 2
        extra = {key: request[key] for key in ALLOWED_EXTRA if key in request}
    except Exception:
        return 2
    try:
        answer = call_llm(
            provider="openai-codex", model=model, api_mode="codex_responses",
            messages=messages, tools=tools if isinstance(tools, list) else None,
            temperature=request.get("temperature") if isinstance(request.get("temperature"), (int, float)) else None,
            max_tokens=request.get("max_tokens") if isinstance(request.get("max_tokens"), int) else None,
            reasoning_config={"effort": effort}, timeout=55, extra_body=extra,
            retry_policy="none",
        )
    except Exception:
        return _write_failure(5, "provider_call", "provider_call_failed")
    try:
        projected: Any = (
            answer.model_dump(mode="json")
            if hasattr(answer, "model_dump")
            else _project_namespace_completion(answer)
        )
        encoded = json.dumps(projected, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except Exception:
        return _write_failure(4, "response_encode", "response_not_serializable")
    if len(encoded) > MAX_OUTPUT:
        return _write_failure(3, "response_encode", "response_too_large")
    sys.stdout.buffer.write(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
