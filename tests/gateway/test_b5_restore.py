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


def test_older_journal_reuses_native_receipt(pair):
    from gateway.backup_restore import reconcile
    db, store, row, _ = pair
    reconcile(db, store, {'generation': 7, 'timestamp': 'T'})
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


@pytest.mark.parametrize('manifest', [None, {'version': 1, 'generation': 7, 'archives': {'private': {'name': 'a.zip', 'sha256': 'bad'}}}])
def test_restore_refuses_incomplete_generation(tmp_path, manifest):
    from gateway.backup_restore import restore_generation
    path = tmp_path / 'manifest.json'
    if manifest is not None:
        path.write_text(json.dumps(manifest))
    (tmp_path / 'a.zip').write_bytes(b'bad')
    with pytest.raises((ValueError, FileNotFoundError)):
        restore_generation(path, 7, tmp_path / 'restored')
    assert not (tmp_path / 'restored').exists()
