"""Restore skew and bounded batch-hold contracts using real SQLite."""
import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from plugins.platforms.matrix.intake import MatrixIntakeStore


@pytest.fixture
def pair(tmp_path):
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch, admit_session_input
    db = SessionDB(db_path=tmp_path / 'state.db')
    db.create_session('s', 'matrix')
    epoch = begin_runtime_epoch(db, instance_id='fixture')
    row = admit_session_input(db, epoch=epoch, principal_id='messaging:test', session_id='s',
        request_id='$event', payload={'native_text_v1': {'source': {'chat_id': '!room'}}, 'text': 'hello'})
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    yield db, store, row, epoch
    store.close()
    db.close()


@pytest.mark.parametrize('status', ['terminal', 'queued', 'started', 'unknown', 'missing'])
def test_reconcile_table(pair, status):
    from gateway.backup_restore import reconcile
    db, store, row, epoch = pair
    receipt = row['admission_id']
    if status == 'missing':
        db._execute_write(lambda c: c.execute('DELETE FROM session_admissions'))
    else:
        db._execute_write(lambda c: c.execute(
            'UPDATE session_admissions SET status=?,owner_epoch=?,generation=1 WHERE admission_id=?',
            (status, epoch, receipt)))
    store.mark('$event', 'done', receipt, room_id='!room')
    result = reconcile(db, store, {'generation': 7, 'timestamp': '2026-11-13T00:00:00Z'})
    assert result['reread'] == ([['!room', '$event']] if status == 'missing' else [])
    assert result['ask'] == ([receipt] if status in ('started', 'unknown') else [])
    assert store.get('restore')['generation'] == 7
    if status in ('started', 'unknown'):
        assert db._read_one('SELECT value FROM state_meta WHERE key=?', ('restore_backup:' + receipt,))
    if status == 'queued':
        assert db._read_one('SELECT status FROM session_admissions')['status'] == 'queued'


@pytest.mark.parametrize('status', ['queued', 'started', 'unknown'])
def test_older_journal_reuses_native_receipt(pair, status):
    from gateway.backup_restore import reconcile
    db, store, row, epoch = pair
    db._execute_write(lambda c: c.execute(
        'UPDATE session_admissions SET status=?,owner_epoch=?,generation=1', (status, epoch)))
    result = reconcile(db, store, {'generation': 7, 'timestamp': 'T'})
    assert result['ask'] == ([row['admission_id']] if status != 'queued' else [])
    assert store.state('$event') == 'native'
    assert store.db.execute('SELECT receipt,room_id FROM intake_events').fetchone() == (row['admission_id'], '!room')


@pytest.mark.asyncio
async def test_hold_waits_between_batches_and_releases_on_disconnect(tmp_path):
    from gateway.intake_hold import IntakeHold
    store = MatrixIntakeStore(tmp_path / 'i.db')
    hold = IntakeHold(store, timeout=.3)
    await hold.start()
    await hold.lock.acquire()
    reader, writer = await asyncio.open_unix_connection(hold.path)
    writer.write(b'hold\n'); await writer.drain()
    read = asyncio.create_task(reader.readline())
    await asyncio.sleep(.02)
    assert not read.done()
    hold.lock.release()
    assert json.loads(await read)['held']
    start = time.monotonic()
    assert hold.lock.locked()
    writer.close(); await writer.wait_closed()
    async with hold.lock:
        elapsed = time.monotonic() - start
    print(f'hold disconnect release: {elapsed:.6f}s')
    assert elapsed < .3
    await hold.close(); store.close()


@pytest.mark.asyncio
async def test_hold_deadline_and_pending_refusal(tmp_path):
    from gateway.intake_hold import IntakeHold
    store = MatrixIntakeStore(tmp_path / 'i.db')
    hold = IntakeHold(store, timeout=.05)
    await hold.start()
    reader, writer = await asyncio.open_unix_connection(hold.path)
    writer.write(b'hold\n'); await writer.drain()
    assert json.loads(await reader.readline())['held']
    start = time.monotonic()
    async with hold.lock:
        elapsed = time.monotonic() - start
    print(f'hold hard deadline: {elapsed:.6f}s')
    assert .02 < elapsed < .2
    writer.close(); await writer.wait_closed()
    store.accept({'next_batch': 'x'})
    reader, writer = await asyncio.open_unix_connection(hold.path)
    writer.write(b'hold\n'); await writer.drain()
    assert not json.loads(await reader.readline())['held']
    writer.close(); await writer.wait_closed()
    await hold.close(); store.close()


@pytest.mark.parametrize('manifest', [None, {'version': 1, 'generation': 7, 'timestamp': 'T', 'archives': {'private': {'name': 'a.zip', 'sha256': 'bad'}, 'persona': {'name': 'b.zip', 'sha256': 'bad'}}}])
def test_restore_refuses_incomplete_generation(tmp_path, manifest):
    from gateway.backup_restore import restore_generation
    path = tmp_path / 'manifest.json'
    if manifest is not None:
        path.write_text(json.dumps(manifest))
    (tmp_path / 'a.zip').write_bytes(b'bad')
    with pytest.raises((ValueError, FileNotFoundError)):
        restore_generation(path, 7, tmp_path / 'restored')
    assert not (tmp_path / 'restored').exists()


def test_native_backup_import_roundtrip_and_wal_journal(pair, tmp_path, monkeypatch):
    import hashlib
    from hermes_cli.backup import _write_full_zip_backup
    from gateway.backup_restore import restore_generation
    db, store, row, _ = pair
    store.db.execute('PRAGMA journal_mode=WAL')
    store.mark('$event', 'done', row['admission_id'], room_id='!room')
    home = tmp_path / 'source'
    (home / 'identity').mkdir(parents=True)
    from hermes_cli.backup_sqlite import _safe_copy_db
    assert _safe_copy_db(tmp_path / 'state.db', home / 'state.db')
    # A live WAL-backed .sqlite3 must pass through the native SQLite copier.
    live = MatrixIntakeStore(home / 'identity' / 'intake-test.sqlite3')
    live.db.execute('PRAGMA journal_mode=WAL')
    live.mark('$event', 'done', row['admission_id'], room_id='!room')
    (home / 'config.yaml').write_text('model: fixture\n')
    persona = tmp_path / 'persona'
    persona.mkdir()
    (persona / 'SOUL.md').write_text('persona fixture')
    archives = {}
    for part, root in [('private', home), ('persona', persona)]:
        path = tmp_path / (part + '.zip')
        assert _write_full_zip_backup(path, root)
        if part == 'private':
            import zipfile
            with zipfile.ZipFile(path) as archive:
                assert archive.namelist()[:2] == ['state.db', 'identity/intake-test.sqlite3']
        archives[part] = {'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    live.close()
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({'version': 1, 'generation': 7, 'timestamp': 'T', 'archives': archives}))
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'unrelated'))
    target = restore_generation(manifest, 7, tmp_path / 'restored')
    restored = MatrixIntakeStore(target / 'private/identity/intake-test.sqlite3')
    assert restored.state('$event') == 'done'
    assert restored.get('restore')['generation'] == 7
    assert (target / 'persona/SOUL.md').read_text() == 'persona fixture'
    restored.close()


@pytest.mark.asyncio
async def test_actual_back_to_back_copies_under_hold(pair, tmp_path):
    from gateway.intake_hold import IntakeHold
    from hermes_cli.backup_sqlite import _safe_copy_db
    db, store, _, _ = pair
    hold = IntakeHold(store)
    await hold.start()
    reader, writer = await asyncio.open_unix_connection(hold.path)
    writer.write(b'hold\n'); await writer.drain()
    assert json.loads(await reader.readline())['held']
    started = time.monotonic()
    assert await asyncio.to_thread(_safe_copy_db, tmp_path / 'state.db', tmp_path / 'state-copy.db')
    assert await asyncio.to_thread(_safe_copy_db, tmp_path / 'intake.sqlite3', tmp_path / 'intake-copy.sqlite3')
    elapsed = time.monotonic() - started
    writer.write(b'release\n'); await writer.drain()
    assert await reader.readline() == b''
    print(f'back-to-back SQLite hold: {elapsed:.6f}s')
    assert elapsed < 2
    writer.close(); await writer.wait_closed()
    await hold.close()


@pytest.mark.parametrize('reason', ['stale', 'abandoned'])
def test_stale_markers_and_abandoned_delivery_use_native_ask(pair, reason, monkeypatch):
    from datetime import datetime, UTC
    from unittest.mock import MagicMock
    from gateway.backup_restore import apply_restore_attention
    db, _, _, _ = pair
    entry = SimpleNamespace(session_key='route', resume_ask=None,
        resume_pending=reason == 'stale', last_resume_marked_at=datetime.fromtimestamp(1, UTC))
    sessions = SimpleNamespace(list_sessions=lambda: [entry], _db=db)
    def update(key, action):
        action(entry)
    sessions._update_entry = update
    if reason == 'abandoned':
        db._execute_write(lambda c: c.execute('CREATE TABLE delivery_obligations (session_key TEXT,state TEXT)'))
        db._execute_write(lambda c: c.execute("INSERT INTO delivery_obligations VALUES ('route','abandoned')"))
    status = MagicMock()
    monkeypatch.setattr('gateway.status.write_runtime_status', status)
    assert apply_restore_attention(sessions, db, {'generation': 7, 'timestamp': 'T'}) == ['route']
    assert entry.resume_ask
    assert status.call_args.kwargs['needs_attention']
