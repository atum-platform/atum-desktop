"""The authority reclaims only an authenticated pending provider checkpoint."""
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from agent.request_checkpoint import RequestCheckpoint, CheckpointUnavailable, checkpoint_key
from gateway.turn_recovery import bind_turn, current_admission, NativeContinuationPending, recover_unknown
from hermes_state import SessionDB
from hermes_state_runtime import (admit_session_input, begin_runtime_epoch, claim_session_input,
    get_session_admission, recover_session_inputs)


@pytest.mark.parametrize('refusal', ['none', 'revoked', 'consuming', 'changed', 'stopped'])
def test_recovery_proof_cannot_override_native_fences(tmp_path, monkeypatch, refusal):
    db = SessionDB(tmp_path / 'state.db')
    try:
        db.create_session('conversation', source='matrix')
        epoch = begin_runtime_epoch(db, instance_id='first')
        admitted = admit_session_input(db, epoch=epoch, principal_id='owner', session_id='conversation',
            request_id='event', payload={'text': 'read', 'native_text_v1': {'source': {'platform': 'matrix'}}})
        started = claim_session_input(db, epoch=epoch, session_id='conversation')
        checkpoint = RequestCheckpoint(db, 'native.admission:' + admitted['admission_id'], {'owner': 'one'})
        checkpoint.pending({'request_id': 'invocation'})
        proof = dict(checkpoint_key=checkpoint.key, checkpoint_raw=checkpoint.raw)
        if refusal == 'consuming':
            checkpoint.consume()
        if refusal == 'changed':
            checkpoint.finish(completed=False)
        epoch = begin_runtime_epoch(db, instance_id='second')
        recover_session_inputs(db, epoch=epoch)
        row = get_session_admission(db, admission_id=admitted['admission_id'])
        if refusal == 'stopped':
            db._execute_write(lambda conn: conn.execute(
                'UPDATE sessions SET runtime_generation=runtime_generation+1 WHERE id=?', ('conversation',)))
        class Adapter:
            def recover(self, db, row):
                if refusal == 'revoked':
                    raise PermissionError('revoked')
                return proof
        monkeypatch.setattr('gateway.turn_recovery.adapters', lambda: {'fixture': Adapter()})
        assert recover_unknown(db, row, epoch) == (refusal == 'none')
        assert recover_unknown(db, row, epoch) is False  # double startup/reclaim
        assert get_session_admission(db, admission_id=admitted['admission_id'])['status'] == (
            'queued' if refusal == 'none' else 'unknown')
    finally:
        db.close()


def test_checkpoint_failure_bypasses_error_to_final_conversion(monkeypatch):
    class Adapter:
        @contextmanager
        def bind_turn(self, agent, row):
            raise CheckpointUnavailable('uncertain')
            yield
    monkeypatch.setattr('gateway.turn_recovery.adapters', lambda: {'fixture': Adapter()})
    token = current_admission.set({'admission_id': 'owned'})
    try:
        with pytest.raises(NativeContinuationPending):
            with bind_turn(SimpleNamespace(provider='fixture')):
                pytest.fail('turn ran')
    finally:
        current_admission.reset(token)


def test_recovered_admission_cannot_run_on_a_changed_provider(tmp_path, monkeypatch):
    db = SessionDB(tmp_path / 'state.db')
    row = {'admission_id': 'original'}
    checkpoint = RequestCheckpoint(db, 'native.admission:original', {'owner': 'one'})
    checkpoint.pending({'request_id': 'saved'})
    monkeypatch.setattr('gateway.turn_recovery.adapters', lambda: {})
    token = current_admission.set(row)
    try:
        with pytest.raises(NativeContinuationPending):
            with bind_turn(SimpleNamespace(provider='changed', _session_db=db)):
                pytest.fail('changed provider executed the admitted turn')
    finally:
        current_admission.reset(token)
        db.close()
