"""Closed error metadata for hosts; exception strings are never diagnostic fields."""

_CLASSES = frozenset({
    "ValueError",
    "TypeError",
    "RuntimeError",
    "TimeoutError",
    "ConnectionError",
    "OSError",
    "PermissionError",
    "FileNotFoundError",
    "KeyError",
    "AttributeError",
    "ImportError",
    "ModuleNotFoundError",
    "ContextWindowTooSmallError",
    "BadRequestError",
    "AuthenticationError",
    "PermissionDeniedError",
    "NotFoundError",
    "RateLimitError",
    "APIConnectionError",
    "APITimeoutError",
    "APIStatusError",
    "InternalServerError",
    "GoogleFenceRouteRequired",
    "BackgroundSweepError",
})
_KINDS = frozenset({
    "context_length_exceeded",
    "context_window_too_small",
    "rate_limit_exceeded",
    "invalid_api_key",
    "model_not_found",
})


def error_diagnostic(error: Exception) -> dict:
    name = type(error).__name__
    result = {"class": name if name in _CLASSES else "Exception"}
    kind = getattr(error, "code", None)
    if isinstance(kind, str) and kind in _KINDS:
        result["kind"] = kind
    return result
