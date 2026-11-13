"""Execution-local transport port for native host-authority plugins.

The trusted gateway binds a callable around one admitted owner turn or cron
occurrence. It closes over Operation.call and native effect indexes. Credentials,
owner identity and operation IDs never come from tool arguments. The host still
checks the owner's live grant on every call. Advertisement is fixed at startup;
an enabled host process without a binding refuses instead of borrowing another route.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timezone
from email.utils import format_datetime, parsedate_to_datetime
from typing import Callable
from urllib.error import HTTPError

_transport: ContextVar[Callable | None] = ContextVar('atum_source_transport', default=None)
_host_transport_enabled = False


def enable_source_transport() -> None:
    """Trusted plugin startup only, BEFORE any agents/tool catalogs are built.

    This monotonic process marker advertises capability, never grants access.
    Do not toggle it per turn: registry and model catalogs are process-cached.
    """
    global _host_transport_enabled
    _host_transport_enabled = True


def source_transport_enabled() -> bool:
    return _host_transport_enabled


def _retry_after(value: object) -> str | None:
    """Accept HTTP delay-seconds or a date, never arbitrary host text."""
    if not isinstance(value, str) or not 0 < len(value) <= 128 or not value.isascii():
        return None
    if value.isdigit():
        return value
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is not None:
            return format_datetime(date.astimezone(timezone.utc), usegmt=True)
    except (TypeError, ValueError, OverflowError):
        pass
    return None


def source_transport_http_error(error: Exception) -> str | None:
    """Native urllib operations raise for HTTP refusals; do not expose their body/URL."""
    if not isinstance(error, HTTPError):
        return None
    try:
        code = {429: 'rate_limited', 404: 'not_found'}.get(error.code)
        if code is not None:
            retry = error.headers.get('Retry-After') if error.headers is not None else None
            return source_transport_error({'error': code, 'retryAfter': retry})
        return None
    finally:
        error.close()


def source_transport_error(result: dict) -> str | None:
    """Expose only corrective host codes, never raw host errors or credentials."""
    from tools.registry import tool_error

    messages = {
        'invalid_input': 'Invalid input. Correct the request before trying again.',
        'owner_turn_required': 'This action needs the owner’s current turn.',
        'confirmationRequired': 'Confirm this action with the owner before continuing.',
        'not_found': 'The requested item was not found. Check its identifier before retrying.',
        'rate_limited': 'Rate limited.',
    }
    code = result.get('code') or result.get('error')
    if result.get('confirmationRequired') is True:
        code = 'confirmationRequired'
    if not isinstance(code, str) or code not in messages:
        return None
    extra = {}
    if code == 'rate_limited':
        retry = _retry_after(result.get('retryAfter'))
        extra['hint'] = 'Do not retry immediately; try again later.'
        if retry is not None:
            extra['retryAfter'] = retry
            extra['hint'] = f'Respect Retry-After {retry} before retrying.'
    operation = result.get('operationId')
    if code == 'confirmationRequired' and isinstance(operation, str) and 0 < len(operation) <= 256:
        extra['operationId'] = operation
    return tool_error(messages[code], code=code, **extra)


@contextmanager
def bind_source_transport(call: Callable):
    """Bind the host's semantic (tool, payload) caller to this execution only.

    Enable advertisement at plugin startup; bind around the native run only
    AFTER its session identity is installed. Worker threads must use Hermes's
    existing context propagation, as memory providers do. Every call must
    still match that session; inherited contexts rebound to another room fail closed.
    Exit invalidates copied contexts too, preventing a late worker using a closed run.
    """
    from gateway.session_context import bound_session_key, get_session_env
    from agent.atum_google_fence import scoped_source_holding

    def session_identity():
        return (bound_session_key(), get_session_env('HERMES_SESSION_ID'),
                get_session_env('HERMES_SESSION_PROFILE'))

    identity = session_identity()
    active = True

    def matches_session():
        return session_identity() == identity

    def scoped(tool, payload):
        if not active:
            raise RuntimeError('operation_closed')
        if not (identity[0] or identity[1]) or not matches_session():
            raise RuntimeError('source_session_mismatch')
        return call(tool, payload)

    token = _transport.set(scoped)
    try:
        with scoped_source_holding(matches_session):
            yield
    finally:
        active = False
        _transport.reset(token)


def source_transport() -> Callable | None:
    """Return the trusted execution binding, if installed by the native plugin."""
    return _transport.get()
