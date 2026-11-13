"""Execution-local transport port for native host-authority plugins.

The trusted gateway binds a callable around one admitted owner turn or cron
occurrence. It closes over Operation.call and native effect indexes. Credentials,
owner identity and operation IDs never come from tool arguments. The host still
checks the owner's live grant on every call. No binding means legacy transport.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Callable

_transport: ContextVar[Callable | None] = ContextVar('atum_source_transport', default=None)


@contextmanager
def bind_source_transport(call: Callable):
    """Bind the host's semantic (tool, payload) caller to this execution only.

    Enter before native agent construction so check_fn sees the binding. Worker
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
