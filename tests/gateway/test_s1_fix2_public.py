"""Offline contracts separating transport health from conversation recovery."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest

@pytest.mark.asyncio
@pytest.mark.parametrize('error', [TimeoutError(), ConnectionResetError(), OSError('network down')])
async def test_transient_sync_never_posts_or_wedges(tmp_path, monkeypatch, error):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from tests.gateway.test_matrix_durable_intake import adapter
    from gateway.status import write_runtime_status, read_runtime_status
    a = adapter(tmp_path)
    a._joined_rooms = {'!group'}
    a.send = AsyncMock()
    write_runtime_status(gateway_state='running')
    await a._intake_failure(error)
    assert not a.send.called
    assert not read_runtime_status()['platforms'].get('matrix', {}).get('needs_attention')
    a._intake.close()

@pytest.mark.asyncio
async def test_wedge_notice_only_configured_control_room(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from tests.gateway.test_matrix_durable_intake import adapter
    from plugins.platforms.matrix.intake import IntakeGapError
    a = adapter(tmp_path)
    a.config.extra['control_room'] = '!owner'
    a._joined_rooms = {'!group', '!owner'}
    a.send = AsyncMock(return_value=SimpleNamespace(success=True))
    await a._intake_failure(IntakeGapError('gap'))
    await a._intake_failure(IntakeGapError('gap'))
    assert [c.kwargs['chat_id'] for c in a.send.call_args_list] == ['!owner']
    a._intake.close()

@pytest.mark.asyncio
async def test_paused_poison_keeps_process_healthy_and_sibling_runs(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from tests.gateway.test_s1_fix_b import test_poison_reclaim_path_stops_before_fourth_model_turn
    from gateway.status import write_runtime_status, read_runtime_status
    from gateway.readiness import collect_runtime_readiness
    write_runtime_status(gateway_state='running')
    await test_poison_reclaim_path_stops_before_fourth_model_turn(tmp_path, monkeypatch)
    ready = collect_runtime_readiness(configured_model='fixture', runtime_status=read_runtime_status())
    assert ready['process_healthy'] is True
    assert ready['paused_conversations'] == 1
    assert ready['alert']['code'] == 'restart_loop'
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch, admit_session_input, claim_session_input
    db = SessionDB(db_path=tmp_path/'state.db')
    db.create_session('sibling', 'matrix')
    epoch = begin_runtime_epoch(db, instance_id='sibling')
    admit_session_input(db, epoch=epoch, principal_id='messaging:test', session_id='sibling', request_id='ok', payload={'text':'hello'})
    assert claim_session_input(db, epoch=epoch, session_id='sibling')
    db.close()

@pytest.mark.asyncio
async def test_connected_cannot_clear_pause_alert(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from gateway.resume_policy import resume_boot_allowed
    from gateway.status import write_runtime_status, read_runtime_status
    from gateway.readiness import collect_runtime_readiness
    for _ in range(4):
        await resume_boot_allowed(SimpleNamespace(), {'admission_id':'poison'})
    write_runtime_status(gateway_state='running', platform='matrix', platform_state='connected', error_code=None)
    ready = collect_runtime_readiness(configured_model='fixture', runtime_status=read_runtime_status())
    assert ready['alert']['code'] == 'restart_loop'

@pytest.mark.parametrize('seconds,seq,expected', [(30,None,True), (-30,11,True), (-30,9,False), (600,11,False), (0,11,False)])
def test_ask_skew_and_admission_fence(tmp_path, seconds, seq, expected):
    from gateway.resume_policy import pending_resume_policy
    now = datetime.now(timezone.utc)
    entry = SimpleNamespace(session_key='s', resume_ask={'token':'token', 'actions':['write'], 'created_at':now.isoformat(), 'admission_seq':10})
    class Store:
        def _update_entry(self, key, update): update(entry)
        def clear_resume_pending(self, key): pass
    stamp = datetime.fromtimestamp(0, timezone.utc) if seconds == 0 else now + timedelta(seconds=seconds)
    kwargs = {'message_admission_seq': seq} if seq is not None else {}
    result = pending_resume_policy(Store(), entry, None, 'yes', can_resolve=True, message_timestamp=stamp.isoformat(), **kwargs)
    assert (result is None) is expected

def test_restore_zero_and_missing_timestamp_not_now(tmp_path):
    from gateway.session_envelope import restore_native
    from gateway.session import SessionSource
    from gateway.config import Platform
    payload = {'text':'yes', 'native_text_v1': {'source':dict(SessionSource(platform=Platform.MATRIX, chat_id='!room').to_dict(), is_bot=False), 'timestamp':'1970-01-01T00:00:00+00:00', 'event':{}}}
    assert restore_native(payload).timestamp.timestamp() == 0
    del payload['native_text_v1']['timestamp']
    assert restore_native(payload).timestamp.timestamp() == 0

@pytest.mark.asyncio
async def test_boot_scan_only_latest_old_epoch_failure(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch, admit_session_input, claim_session_input, settle_session_input
    from gateway.run_runtime import recover_profile_native_sessions
    db = SessionDB(db_path=tmp_path/'state.db')
    epoch = begin_runtime_epoch(db, instance_id='first')
    for sid in ['old_failure', 'eligible', 'current']:
        db.create_session(sid, 'matrix')
        row = admit_session_input(db, epoch=epoch, principal_id='p', session_id=sid, request_id='fail', payload={'text':'hello'})
        claimed = claim_session_input(db, epoch=epoch, session_id=sid)
        settle_session_input(db, epoch=epoch, admission_id=row['admission_id'], generation=claimed['generation'], outcome='failed')
    row = admit_session_input(db, epoch=epoch, principal_id='p', session_id='old_failure', request_id='success', payload={'text':'ok'})
    claimed = claim_session_input(db, epoch=epoch, session_id='old_failure')
    settle_session_input(db, epoch=epoch, admission_id=row['admission_id'], generation=claimed['generation'], outcome='completed')
    # The scan must exclude current-epoch failed rows and obsolete failures before binding.
    rows = db._read_all("SELECT * FROM session_admissions WHERE target_session_id='current'")
    current_epoch = begin_runtime_epoch(db, instance_id='second')
    db._conn.execute("UPDATE session_admissions SET owner_epoch=? WHERE target_session_id='current'", (current_epoch,))
    db._conn.commit()
    from contextlib import nullcontext
    monkeypatch.setattr('gateway.session_authorities.owner_scope', lambda a: nullcontext())
    monkeypatch.setattr('gateway.session_results.admission_result', lambda db, aid: {'result':{'failure_reason':'session_persistence_failed:disk'}})
    recover = AsyncMock(return_value={})
    authority = SimpleNamespace(db=db, epoch=current_epoch, logical_owner=lambda sid:sid, recover_native_sessions=recover)
    runner = SimpleNamespace(session_store=SimpleNamespace(list_sessions=lambda:[SimpleNamespace(session_id=s, origin=s) for s in ['old_failure','eligible','current']]), _adapter_for_source=lambda s:s)
    await recover_profile_native_sessions(runner, authority)
    assert [b[0] for b in recover.call_args.args[0]] == ['eligible']
    db.close()

@pytest.mark.asyncio
async def test_long_outage_alert_is_quiet_and_healthy(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    (tmp_path/'config.yaml').write_text('agent:\n  reconnect_attention_after: 60\n')
    from tests.gateway.test_matrix_durable_intake import adapter
    from gateway.status import write_runtime_status, read_runtime_status
    from gateway.readiness import collect_runtime_readiness
    a = adapter(tmp_path)
    a.send = AsyncMock()
    write_runtime_status(gateway_state='running')
    await a._intake_failure(TimeoutError())
    a._sync_outage_started -= 61
    await a._intake_failure(TimeoutError())
    result = collect_runtime_readiness(configured_model='fixture', runtime_status=read_runtime_status())
    assert result['process_healthy'] is True
    assert result['alert']['code'] == 'sync_outage'
    assert result['wedge'] is None
    a.send.assert_not_called()
    a._intake.close()


def test_ask_captures_real_admission_fence(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from gateway.session import SessionStore, SessionSource
    from gateway.config import Platform, GatewayConfig
    from gateway.resume_policy import ResumePolicy, pending_resume_policy
    from hermes_state_runtime import begin_runtime_epoch, admit_session_input
    store = SessionStore(sessions_dir=tmp_path/'sessions', config=GatewayConfig())
    source = SessionSource(platform=Platform.MATRIX, chat_id='!owner')
    entry = store.get_or_create_session(source)
    epoch = begin_runtime_epoch(store._db, instance_id='first')
    before = admit_session_input(store._db, epoch=epoch, principal_id='p', session_id=entry.session_id, request_id='before', payload={'text':'yes'})
    pending_resume_policy(store, entry, ResumePolicy(True, ('write',), frozenset()), '', can_resolve=False)
    after = admit_session_input(store._db, epoch=epoch, principal_id='p', session_id=entry.session_id, request_id='after', payload={'text':'yes'})
    skewed = (datetime.now(timezone.utc)-timedelta(seconds=30)).isoformat()
    assert pending_resume_policy(store, entry, None, 'yes', can_resolve=True, message_timestamp=skewed, message_admission_seq=before['seq']).ask
    assert pending_resume_policy(store, entry, None, 'yes', can_resolve=True, message_timestamp=skewed, message_admission_seq=after['seq']) is None
    store._db.close()

@pytest.mark.asyncio
async def test_broken_intake_journal_can_still_notice_owner_once(tmp_path, monkeypatch):
    import sqlite3
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from tests.gateway.test_matrix_durable_intake import adapter
    from gateway.readiness import collect_runtime_readiness
    from gateway.status import write_runtime_status, read_runtime_status
    a = adapter(tmp_path)
    a.config.extra['control_room'] = '!owner'
    a.send = AsyncMock(return_value=SimpleNamespace(success=True))
    write_runtime_status(gateway_state='running')
    a._intake.close()
    for _ in range(2):
        await a._intake_failure(sqlite3.OperationalError('disk full'))
    a.send.assert_awaited_once()
    assert a.send.call_args.kwargs['chat_id'] == '!owner'
    result = collect_runtime_readiness(configured_model='fixture', runtime_status=read_runtime_status())
    assert result['wedge']['kind'] == 'journal'
    assert result['alert']['code'] == 'intake_wedged'
    assert result['process_healthy'] is True
