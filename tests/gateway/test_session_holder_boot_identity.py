"""Durable session/compression owners must survive PID reuse across sandbox boots."""
import json
import os
import subprocess
import sys
import time

import pytest

from gateway import status
from hermes_state import SessionDB, _compression_lock_holder_process_is_dead
from hermes_state_pidns import holder_namespace_token
import hermes_state_common as common


@pytest.fixture
def boot(monkeypatch):
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-A:1')
    return monkeypatch


def holder(turn):
    return f'pid={os.getpid()}{holder_namespace_token()}:turn={turn}'


@pytest.mark.parametrize('kind', ['turn', 'compression'])
def test_restart_reclaims_without_wait_even_when_pid_is_our_own(tmp_path, boot, kind):
    path = tmp_path / 'state.db'
    db = SessionDB(path)
    db.create_session('s', source='test')
    old = holder('crashed')
    acquire = db.try_acquire_session_turn_lease if kind == 'turn' else db.try_acquire_compression_lock
    assert acquire('s', old)
    db.close()  # durable row survives the crashed runtime
    boot.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    db = SessionDB(path)
    try:
        if kind == 'turn':
            notices = []
            assert db.acquire_session_turn_lease('s', holder('next'), wait_seconds=0, on_wait=notices.append)
            assert notices == []
            # Late cleanup from the crashed turn cannot delete the successor.
            db.release_session_turn_lease('s', old)
            assert not db.try_acquire_session_turn_lease('s', holder('third'))
        else:
            assert db.try_acquire_compression_lock('s', holder('next'))
    finally:
        db.close()


def test_same_boot_live_process_blocks(tmp_path, boot):
    db = SessionDB(tmp_path / 'state.db')
    try:
        db.create_session('s', source='test')
        assert db.try_acquire_session_turn_lease('s', holder('live'))
        assert not db.try_acquire_session_turn_lease('s', holder('contender'))
        assert not _compression_lock_holder_process_is_dead(holder('live'))
    finally:
        db.close()


def test_legacy_row_defers_only_until_expiry(tmp_path, boot):
    db = SessionDB(tmp_path / 'state.db')
    try:
        db.create_session('s', source='test')
        legacy = f'pid={os.getpid()}:turn=legacy'
        assert db.try_acquire_session_turn_lease('s', legacy)
        assert not db.try_acquire_session_turn_lease('s', holder('new'))
        db._execute_write(lambda conn: conn.execute('UPDATE session_turn_leases SET expires_at=?', (time.time() - 1,)))
        assert db.try_acquire_session_turn_lease('s', holder('new'))
    finally:
        db.close()


def test_file_lock_metadata_carries_boot_and_rejects_recycled_pid(tmp_path, boot):
    with (tmp_path / 'repair.lock').open('w+b') as handle:
        common._write_lock_holder_record(handle)
        record = common._read_lock_holder_record(handle)
    assert record['boot_epoch'] == 'boot-A:1'
    assert not common._lock_holder_provably_dead(record)
    boot.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    assert common._lock_holder_provably_dead(record)
    record.pop('boot_epoch')
    assert not common._lock_holder_provably_dead(record)  # legacy live owner remains protected


@pytest.mark.parametrize('kind', ['turn', 'compression'])
def test_two_real_processes_never_own_same_turn(tmp_path, boot, kind):
    path = tmp_path / 'state.db'
    db = SessionDB(path)
    db.create_session('s', source='test')
    acquire = db.try_acquire_session_turn_lease if kind == 'turn' else db.try_acquire_compression_lock
    assert acquire('s', holder('crashed'))
    db.close()
    code = '''
import json, os, sys
from pathlib import Path
from gateway import status
from hermes_state import SessionDB
from hermes_state_pidns import holder_namespace_token
status.get_process_epoch = lambda: 'boot-B:1'
db = SessionDB(Path(sys.argv[1]))
owner = f'pid={os.getpid()}{holder_namespace_token()}:turn=child'
acquire = db.try_acquire_session_turn_lease if sys.argv[2] == 'turn' else db.try_acquire_compression_lock
release = db.release_session_turn_lease if sys.argv[2] == 'turn' else db.release_compression_lock
won = acquire('s', owner)
print(json.dumps(won), flush=True)
sys.stdin.readline()  # keep winner alive until both contenders have reported
if won: release('s', owner)
db.close()
'''
    children = [subprocess.Popen([sys.executable, '-c', code, str(path), kind], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    try:
        import select
        results = []
        for child in children:
            ready, _, _ = select.select([child.stdout], [], [], 30)
            assert ready, 'child did not report admission'
            results.append(json.loads(child.stdout.readline()))
        assert sum(results) == 1
    finally:
        for child in children:
            _out, err = child.communicate('\n', timeout=30)
            assert child.returncode == 0, err


def test_same_boot_namespace_rules_and_unreadable_witness_stay_conservative(boot):
    import hermes_state_pidns as identity

    boot.setattr(identity, '_LOCAL_PID_NS', identity.LocalPidNamespace('42', True))
    stamped = holder('live')
    assert identity.holder_pid_checkable(stamped)
    assert not identity.holder_pid_checkable(stamped.replace('pidns=42', 'pidns=43'))
    assert not identity.holder_pid_checkable('pid=999999:turn=legacy')
    boot.setattr(status, 'get_process_epoch', lambda: None)
    assert ':boot_epoch=' not in holder('no-witness')
    assert not identity.holder_boot_epoch_conflicts('pid=999999:boot_epoch=broken:turn=x')


def test_live_file_lock_is_not_broken_in_same_boot(tmp_path, boot):
    pytest.importorskip('fcntl')
    import fcntl

    path = tmp_path / 'repair.lock'
    with path.open('a+b') as owner, path.open('a+b') as contender:
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        common._write_lock_holder_record(owner)
        acquired, returned = common._acquire_db_flock(path, contender, 0, 0.01, 'test')
        assert acquired is False
        assert returned is contender
        assert path.stat().st_ino == os.fstat(owner.fileno()).st_ino
