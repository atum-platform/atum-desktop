"""Execution-local transport port for native host-authority plugins.

The trusted gateway binds a callable around one admitted owner turn or cron
occurrence. It closes over Operation.call and native effect indexes. Credentials,
owner identity and operation IDs never come from tool arguments. The host still
checks the owner's live grant on every call. Advertisement is fixed at startup;
an enabled host process without a binding refuses instead of borrowing another route.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Callable

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


def source_transport_error(result: dict) -> str | None:
    """Expose only corrective host codes, never raw host errors or credentials."""
    from tools.registry import tool_error

    messages = {
        'invalid_input': 'Invalid input. Correct the request before trying again.',
        'owner_turn_required': 'This action needs the owner’s current turn.',
        'confirmationRequired': 'Confirm this action with the owner before continuing.',
    }
    code = result.get('code') or result.get('error')
    if result.get('confirmationRequired') is True:
        code = 'confirmationRequired'
    if not isinstance(code, str) or code not in messages:
        return None
    extra = {}
    operation = result.get('operationId')
    if code == 'confirmationRequired' and isinstance(operation, str) and 0 < len(operation) <= 256:
        extra['operationId'] = operation
    return tool_error(messages[code], code=code, **extra)


@contextmanager
def bind_source_transport(call: Callable):
    """Bind the host's semantic (tool, payload) caller to this execution only.

    Enable the process at plugin startup, then enter before agent construction. Worker
    threads must use Hermes's existing context propagation, as memory providers do.
    Exit invalidates copied contexts too, preventing a late worker using a closed run.
    """
    active = True

    def scoped(tool, payload):
        if not active:
            raise RuntimeError('operation_closed')
        return call(tool, payload)

    token = _transport.set(scoped)
    try:
        yield
    finally:
        active = False
        _transport.reset(token)


def source_transport() -> Callable | None:
    """Return the trusted execution binding, if installed by the native plugin."""
    return _transport.get()
