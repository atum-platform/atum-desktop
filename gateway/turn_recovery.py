"""Provider-owned durable continuation for an admitted native turn.

Adapters authenticate saved results. The authority retains admission, route and
FIFO ownership. The ordinary agent loop retains response consumption and tools.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import logging

from agent.request_checkpoint import CheckpointUnavailable

current_admission = ContextVar('native_turn_recovery_admission', default=None)


def adapters():
    from hermes_cli.plugins import get_plugin_manager
    return getattr(get_plugin_manager(), '_native_turn_recovery', {})


class NativeContinuationPending(BaseException):
    """Uncertain execution must bypass ordinary error-to-final-reply handlers."""


@contextmanager
def bind_turn(agent):
    row = current_admission.get()
    adapter = adapters().get(getattr(agent, 'provider', None))
    if row is None:
        yield
        return
    if adapter is None:
        from agent.request_checkpoint import checkpoint_key
        db = getattr(agent, '_session_db', None)
        if db is not None and db.get_meta(checkpoint_key('native.admission:' + row['admission_id'])) is not None:
            raise NativeContinuationPending()
        yield
        return
    try:
        with adapter.bind_turn(agent, row):
            yield
    except CheckpointUnavailable as exc:
        raise NativeContinuationPending() from exc


def recover_unknown(db, row, epoch):
    """Read-only authentication precedes the authority's transactional requeue."""
    from hermes_state_runtime import requeue_checkpointed_input
    for adapter in tuple(adapters().values()):
        try:
            proof = adapter.recover(db, row)
            if proof is not None:
                return requeue_checkpointed_input(db, epoch=epoch, row=row, **proof)
        except Exception:
            logging.getLogger(__name__).warning('Native continuation remains fenced')
    return False
