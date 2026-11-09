"""One bounded, stateless classifier call for an admitted Atum follow-up sweep."""

from __future__ import annotations

import math
import re
import time
from typing import Any, Callable

from agent.auxiliary_client import call_llm, extract_content_or_reasoning

_UUID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")
_EFFORTS = frozenset({"low", "medium", "high"})
_MAX_PROMPT_BYTES = 5_000
_MAX_OUTPUT_TOKENS = 1_000
_TIMEOUT_SECONDS = 110.0


class BackgroundSweepError(ValueError):
    """Closed validation or classifier failure; never contains evidence text."""


def _usage(response: Any) -> dict[str, int]:
    usage = getattr(response, "usage", None)

    def number(*names: str) -> int:
        for name in names:
            value = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
        return 0

    return {
        "inputTokens": min(number("prompt_tokens", "input_tokens"), 8_000),
        "outputTokens": min(number("completion_tokens", "output_tokens"), _MAX_OUTPUT_TOKENS),
        "modelMicroProtons": number("model_micro_protons", "micro_protons"),
    }


def classify_background_sweep(
    params: dict[str, Any],
    *,
    invoke: Callable[..., Any] = call_llm,
    now: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Make exactly one tool-free provider request with no fallback or repair."""
    if set(params) != {"authorizationId", "prompt", "model", "effort"}:
        raise BackgroundSweepError("background_sweep_invalid")

    authorization_id = params.get("authorizationId")
    prompt = params.get("prompt")
    model = params.get("model")
    effort = params.get("effort")

    if (
        not isinstance(authorization_id, str)
        or _UUID.fullmatch(authorization_id) is None
        or not isinstance(prompt, str)
        or not prompt.strip()
        or len(prompt.encode("utf-8")) > _MAX_PROMPT_BYTES
        or not isinstance(model, str)
        or _MODEL.fullmatch(model) is None
        or effort not in _EFFORTS
    ):
        raise BackgroundSweepError("background_sweep_invalid")

    started = now()
    try:
        response = invoke(
            task="followup_sweep",
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=_MAX_OUTPUT_TOKENS,
            tools=[],
            timeout=_TIMEOUT_SECONDS,
            reasoning_config={"effort": effort},
            retry_policy="none",
        )
    except Exception as exc:
        raise BackgroundSweepError("background_sweep_model_failed") from exc

    elapsed = max(0.0, now() - started)
    text = extract_content_or_reasoning(response)

    if not isinstance(text, str):
        raise BackgroundSweepError("background_sweep_model_invalid")

    return {
        "text": text.strip(),
        "usage": {
            "computeSeconds": min(120, math.ceil(elapsed)),
            "modelAttempts": 1,
            **_usage(response),
        },
    }
