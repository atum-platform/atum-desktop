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
from typing import Any

from agent.auxiliary_client import call_llm

MAX_INPUT = 800_000
MAX_OUTPUT = 800_000
ALLOWED_EXTRA = {
    "tool_choice", "top_p", "stop", "parallel_tool_calls", "response_format", "seed",
    "frequency_penalty", "presence_penalty",
}


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
        answer = call_llm(
            provider="openai-codex", model=model, api_mode="codex_responses",
            messages=messages, tools=tools if isinstance(tools, list) else None,
            temperature=request.get("temperature") if isinstance(request.get("temperature"), (int, float)) else None,
            max_tokens=request.get("max_tokens") if isinstance(request.get("max_tokens"), int) else None,
            reasoning_config={"effort": effort}, timeout=55, extra_body=extra,
            retry_policy="none",
        )
        projected: Any = answer.model_dump(mode="json") if hasattr(answer, "model_dump") else answer
        encoded = json.dumps(projected, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_OUTPUT:
            return 3
        sys.stdout.buffer.write(encoded)
        return 0
    except Exception:
        return 4


if __name__ == "__main__":
    raise SystemExit(_main())
