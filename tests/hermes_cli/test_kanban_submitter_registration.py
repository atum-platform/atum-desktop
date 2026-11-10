"""The submitter owns a recoverable PID before an owner can execute its claim."""

import os
import time

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_db_dispatch as kbd
from hermes_cli import kanban_worker_client as client


@pytest.fixture
def claim(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    path = tmp_path / 'kanban.db'
    kbc.init_db(path)
    with kbc.connect(path) as conn:
        tid = kb.create_task(conn, title='restart card', assignee='default')
        task = kb.claim_task(conn, tid)
        assert task is not None
        for key, value in {'TASK': tid, 'BOARD': 'default', 'DB': str(path),
                           'RUN_ID': str(task.current_run_id), 'CLAIM_LOCK': task.claim_lock}.items():
            monkeypatch.setenv('HERMES_KANBAN_' + key, value)
        yield conn, task, path


@pytest.mark.parametrize('dispatcher_recorded_pid', [False, True])
def test_submitter_registers_before_owner_admission(claim, monkeypatch, dispatcher_recorded_pid):
    conn, task, path = claim
    if dispatcher_recorded_pid:
        kbd._set_worker_pid(conn, task.id, os.getpid(), run_id=task.current_run_id,
                            claim_lock=task.claim_lock)
    # Force the restart's stale sweep at admission, regardless of machine speed.
    conn.execute('UPDATE tasks SET claim_expires=? WHERE id=?', (int(time.time()) - 10, task.id))
    conn.commit()
    admitted = []

    async def owner(params, board_db):
        admitted.append(params)
        assert board_db == str(path)
        assert kb.release_stale_claims(conn) == 0
        row = kb.get_task(conn, task.id)
        assert row.status == 'running' and row.current_run_id == task.current_run_id
        assert row.worker_pid == os.getpid()
        run = conn.execute('SELECT worker_pid, worker_started_at FROM task_runs WHERE id=?',
                           (task.current_run_id,)).fetchone()
        assert run['worker_pid'] == os.getpid()
        assert run['worker_started_at'] == kbd._process_fingerprint(os.getpid())
        return 0

    monkeypatch.setattr(client, 'run', owner)
    assert client._submit() == 0
    assert len(admitted) == 1


def test_reclaimed_submitter_never_contacts_owner(claim, monkeypatch):
    conn, task, _ = claim
    conn.execute('UPDATE tasks SET claim_expires=? WHERE id=?', (int(time.time()) - 10, task.id))
    conn.commit()
    assert kb.release_stale_claims(conn) == 1
    replacement = kb.claim_task(conn, task.id)
    assert replacement.current_run_id != task.current_run_id

    async def owner(*_):
        pytest.fail('stale submitter contacted the owner')

    monkeypatch.setattr(client, 'run', owner)
    assert client._submit() == 1
    assert kb.get_task(conn, task.id).current_run_id == replacement.current_run_id
