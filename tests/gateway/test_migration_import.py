"""Synthetic migration fixtures; native SQLite and Matrix admission paths."""
import asyncio
import copy
import json

import pytest

from hermes_state import SessionDB
from plugins.platforms.matrix.intake import MatrixIntakeStore
from gateway.migration_import import import_history, reverse_handover


@pytest.fixture
def export():
    # Versioned wire fixture, produced by the private side; no credentials.
    return json.loads('''{
      "version": "hermes.migration/1", "agent_id": "fixture-agent",
      "generation": 2, "session_id": "fixture-history",
      "messages": [
        {"source_id":"$old-user", "room_id":"!room:example.org",
         "role":"user", "content":"Remember the blue notebook", "timestamp":1700000000},
        {"source_id":"$old-answer", "room_id":"!room:example.org",
         "role":"assistant", "content":"Remembered", "timestamp":1700000001,
         "tool_summaries":["memory saved"]}],
      "cutover":{"next_batch":"opaque-at-export",
                 "frontier":{"!room:example.org":"$old-answer"}}
    }''')


@pytest.fixture
def stores(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    db = SessionDB(tmp_path / 'state.db')
    intake = MatrixIntakeStore(tmp_path / 'intake.db')
    yield db, intake
    intake.close()
    db.close()


def authorize(agent, generation, runtime):
    return (agent, generation, runtime) in {
        ('fixture-agent', 2, 'hermes'), ('fixture-agent', 3, 'controller')}


def run(stores, export):
    return import_history(*stores, export, authorize=authorize)


def test_native_history_once_and_provenance(stores, export):
    assert run(stores, export)['imported'] == 2
    assert run(stores, export)['imported'] == 0
    db, journal = stores
    rows = db.export_session('fixture-history')['messages']
    assert [m['content'] for m in rows] == [m['content'] for m in export['messages']]
    assert all(m['display_metadata']['imported'] for m in rows)
    assert rows[-1]['display_metadata']['tool_summaries'] == ['memory saved']
    assert db._read_rows('SELECT * FROM session_admissions') == []
    assert journal.state('$old-user') == 'done'
    journal.compact(now=2000000000)
    assert journal.state('$old-user') == 'done'


def test_source_identity_dedupes_across_exports(stores, export):
    run(stores, export)
    export['messages'].insert(1, dict(export['messages'][0], source_id='$extra', content='more'))
    assert run(stores, export)['imported'] == 1
    assert run(stores, export)['imported'] == 0


def test_cutover_retry_does_not_rewind_live_cursor(stores, export):
    run(stores, export)
    journal = stores[1]
    assert asyncio.run(journal.get_next_batch()) == 'opaque-at-export'
    journal.accept({'next_batch':'live-token', 'rooms':{}})
    journal.finish({'rooms':{}})
    run(stores, export)
    assert asyncio.run(journal.get_next_batch()) == 'live-token'


def test_restart_between_databases_is_repairable(stores, export, monkeypatch):
    journal = stores[1]
    seed = journal.seed_migration
    monkeypatch.setattr(journal, 'seed_migration', lambda *a, **k: (_ for _ in ()).throw(OSError('disk full')))
    with pytest.raises(OSError):
        run(stores, export)
    assert len(stores[0].export_session('fixture-history')['messages']) == 2
    assert asyncio.run(journal.get_next_batch()) is None
    monkeypatch.setattr(journal, 'seed_migration', seed)
    assert run(stores, export)['imported'] == 0
    assert journal.state('$old-user') == 'done'


@pytest.mark.parametrize('mutation', ['version', 'generation', 'role', 'timestamp', 'duplicate', 'frontier', 'early_frontier', 'missing_room'])
def test_invalid_export_no_writes(stores, export, mutation):
    if mutation == 'version': export['version'] = 'unknown'
    if mutation == 'generation': export['generation'] = True
    if mutation == 'role': export['messages'][0]['role'] = 'developer'
    if mutation == 'timestamp': export['messages'][0]['timestamp'] = float('nan')
    if mutation == 'duplicate': export['messages'].append(copy.deepcopy(export['messages'][0]))
    if mutation == 'frontier': export['cutover']['frontier']['!room:example.org'] = '$missing'
    if mutation == 'early_frontier': export['cutover']['frontier']['!room:example.org'] = '$old-user'
    if mutation == 'missing_room': export['messages'][0]['room_id'] = '!other:example.org'
    with pytest.raises(ValueError): run(stores, export)
    assert stores[0].get_session('fixture-history') is None
    assert asyncio.run(stores[1].get_next_batch()) is None


def test_stale_fence_and_active_intake_refused(stores, export):
    with pytest.raises(PermissionError):
        import_history(*stores, export, authorize=lambda *a: False)
    stores[1].accept({'next_batch':'existing', 'rooms':{}})
    with pytest.raises(ValueError): run(stores, export)
    assert stores[0].get_session('fixture-history') is None


def test_source_conflict_is_atomic(stores, export):
    run(stores, export)
    export['messages'][0]['content'] = 'different'
    with pytest.raises(ValueError): run(stores, export)
    assert len(stores[0].export_session('fixture-history')['messages']) == 2


def test_reverse_keeps_window_and_fences_old_side(stores, export):
    run(stores, export)
    journal = stores[1]
    batch = {'next_batch':'window-token', 'rooms':{'join':{'!room:example.org':{
        'timeline':{'events':[{'event_id':'$window', 'type':'m.room.message',
                             'content':{'body':'during move'}}]}}}}}
    journal.accept(batch)
    result = reverse_handover(*stores, agent_id='fixture-agent', generation=2,
                              session_id='fixture-history', authorize=authorize)
    assert result['journal']['pending'] == batch
    assert result['journal']['next_batch'] == 'window-token'
    assert len(result['history']['messages']) == 2
    with pytest.raises(PermissionError):
        reverse_handover(*stores, agent_id='fixture-agent', generation=3,
                         session_id='fixture-history', authorize=authorize)


@pytest.mark.asyncio
async def test_native_matrix_handler_runs_only_new_events(stores, export, tmp_path):
    from types import SimpleNamespace
    from tests.gateway.test_matrix_durable_intake import adapter
    from hermes_state_runtime import (begin_runtime_epoch, admit_session_input,
                                     claim_session_input, settle_session_input)
    db, journal = stores
    run(stores, export)
    epoch = begin_runtime_epoch(db, instance_id='fixture-runtime')
    a = adapter(tmp_path)
    a._intake.close()
    a._intake = journal
    a._user_id = '@bot:example.org'
    answered = []

    async def native_turn(room, sender, eid, timestamp, content, relates):
        row = admit_session_input(db, epoch=epoch, principal_id='fixture-owner',
                                  session_id='fixture-history', request_id=eid,
                                  payload={'text':content['body']})
        journal.mark(eid, 'native', row['admission_id'], room_id=room)
        turn = claim_session_input(db, epoch=epoch, session_id='fixture-history')
        if turn:
            answered.append(eid)
            settle_session_input(db, epoch=epoch, admission_id=turn['admission_id'],
                                 generation=turn['generation'], outcome='completed')

    a._handle_text_message = native_turn
    for eid in ('$old-user', '$old-answer', '$live', '$live'):
        await a._on_room_message(SimpleNamespace(room_id='!room:example.org',
            sender='@alice:example.org', event_id=eid, timestamp=1700000002,
            content={'msgtype':'m.text', 'body':'new question'}))
    assert answered == ['$live']
    assert len(db._read_rows('SELECT * FROM session_admissions')) == 1


def test_reverse_retains_native_frozen_delivery_and_terminal_receipts(stores, export, monkeypatch):
    from gateway import delivery_ledger as ledger
    from hermes_state_runtime import (begin_runtime_epoch, admit_session_input,
                                     claim_session_input, settle_session_input)
    db, journal = stores
    monkeypatch.setattr(ledger, '_db_path', lambda: db.db_path)
    run(stores, export)
    epoch = begin_runtime_epoch(db, instance_id='outgoing')
    admitted = admit_session_input(db, epoch=epoch, principal_id='fixture-owner',
        session_id='fixture-history', request_id='$during', payload={'text':'window'})
    turn = claim_session_input(db, epoch=epoch, session_id='fixture-history')
    settle_session_input(db, epoch=epoch, admission_id=turn['admission_id'],
                         generation=turn['generation'], outcome='completed')
    journal.mark('$during', 'native', admitted['admission_id'], room_id='!room:example.org')
    ledger.record_obligation(obligation_id='owed', session_key='fixture-history',
        platform='matrix', chat_id='!room:example.org', thread_id=None,
        content='frozen answer', source_event_id='$during')
    plan = ledger.matrix_send_plan('owed', '!room:example.org',
                                  [{'msgtype':'m.text', 'body':'frozen answer'}], sender_id='fixture')
    result = reverse_handover(db, journal, agent_id='fixture-agent', generation=2,
                              session_id='fixture-history', authorize=authorize)
    assert result['admissions'][0]['status'] == 'completed'
    assert result['delivery_obligations'][0]['source_event_id'] == '$during'
    assert json.loads(result['delivery_obligations'][0]['matrix_send_plan']) == plan
    # Advancing the native epoch fences a late outgoing execution, while exact
    # terminal replay remains terminal: controller must not re-answer it.
    next_epoch = begin_runtime_epoch(db, instance_id='returning-controller')
    assert next_epoch > epoch
    assert admit_session_input(db, epoch=next_epoch, principal_id='fixture-owner',
        session_id='fixture-history', request_id='$during', payload={'text':'window'})['status'] == 'completed'
    assert claim_session_input(db, epoch=next_epoch, session_id='fixture-history') is None
