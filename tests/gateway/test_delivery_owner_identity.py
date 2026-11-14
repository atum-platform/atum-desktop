"""Delivery ownership across namespaces that recycle PID and start ticks."""
import pytest
from gateway import delivery_ledger as dl
from gateway import status


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(dl, '_db_path', lambda: tmp_path / 'state.db')
    monkeypatch.setattr(dl, '_start_time', lambda pid: 7)
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-A:1')
    dl.record_obligation(obligation_id='reply', session_key='s', platform='slack',
                         chat_id='c', thread_id=None, content='answer')
    dl.mark_attempting('reply')
    return monkeypatch


def test_namespace_restart_reclaims_identical_pid_start(ledger):
    ledger.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    assert len(dl.sweep_recoverable()) == 1


def test_live_owner_respected(ledger):
    assert dl.sweep_recoverable() == []


def test_legacy_owner_reclaimed(ledger):
    with dl._transaction() as conn:
        conn.execute('UPDATE delivery_obligations SET owner_boot_epoch=NULL')
    assert len(dl.sweep_recoverable()) == 1


def test_stale_alive_owner_abandoned(ledger):
    assert dl.sweep_recoverable(now=10**12) == []
    assert dl.get_delivery_state('reply') == 'abandoned'


def test_attempts_cap_alive_owner_abandoned(ledger):
    with dl._transaction() as conn:
        conn.execute('UPDATE delivery_obligations SET attempts=?', (dl.MAX_ATTEMPTS,))
    assert dl.sweep_recoverable() == []
    assert dl.get_delivery_state('reply') == 'abandoned'


def test_second_live_gateway_cannot_claim(ledger):
    ledger.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    assert len(dl.sweep_recoverable()) == 1
    ledger.setattr(dl.os, 'getpid', lambda: 87654)
    assert dl.sweep_recoverable() == []


def test_runtime_sweep_cannot_adopt_previous_boot(ledger):
    dl.mark_failed('reply', 'send_path_degraded')
    ledger.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    assert dl.sweep_failed_for_runtime('slack', now=10**12) == []
    dl.mark_attempting('reply')
    assert dl.release_runtime_claim('reply') is False


def test_two_processes_race_for_one_claim(ledger):
    import json
    import subprocess
    import sys
    code = '''
import json, sys
from pathlib import Path
from gateway import delivery_ledger as dl, status
dl._db_path = lambda: Path(sys.argv[1])
dl._start_time = lambda pid: 7
status.get_process_epoch = lambda: 'boot-B:1'
status._pid_exists = lambda pid: True
print(json.dumps(dl.sweep_recoverable()))
'''
    children = [subprocess.Popen([sys.executable, '-c', code, str(dl._db_path())],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                for _ in range(2)]
    claims = []
    for child in children:
        out, err = child.communicate(timeout=30)
        assert child.returncode == 0, err
        claims.extend(json.loads(out))
    assert len(claims) == 1


def test_retry_timer_ignores_previous_boot(ledger):
    dl.mark_failed('reply', 'flood_wait:60')
    ledger.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    assert dl.pending_retries() == []


def test_cron_owner_checks_epoch_before_recycled_pid(monkeypatch):
    from cron import executions
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    monkeypatch.setattr(status, '_pid_exists', lambda pid: True)
    monkeypatch.setattr(executions, '_process_start_time', lambda pid: 7)
    assert not executions._owner_is_live(2, 7, 'boot-A:1')
    assert not executions._owner_is_live(2, 7, None)
    assert executions._owner_is_live(2, 7, 'boot-B:1')


def test_delegation_owner_checks_epoch_before_recycled_pid(monkeypatch):
    from tools import async_delegation
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    monkeypatch.setattr(status, '_pid_exists', lambda pid: True)
    monkeypatch.setattr(status, 'get_process_start_time', lambda pid: 7)
    alive = async_delegation._owner_liveness()
    assert not alive(2, 7, 'boot-A:1')
    assert not alive(2, 7, None)
    assert alive(2, 7, 'boot-B:1')


def test_api_owner_checks_epoch_before_recycled_pid(monkeypatch):
    from gateway.platforms import api_server_runs
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    monkeypatch.setattr(status, '_pid_exists', lambda pid: True)
    monkeypatch.setattr(status, 'get_process_start_time', lambda pid: 7)
    assert not api_server_runs._owner_alive(2, 7, 'boot-A:1')
    assert not api_server_runs._owner_alive(2, 7, None)
    assert api_server_runs._owner_alive(2, 7, 'boot-B:1')


def test_api_store_preserves_original_boot_across_restart(tmp_path, monkeypatch):
    from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
    path = str(tmp_path / 'runs.db')
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-A:1')
    first = RunIdempotencyStore(path)
    outcome, record = first.reserve('scope', 'key', 'hash', 'run', {'status': 'running'},
                                    owner_pid=2, owner_started=7)
    assert outcome == 'created'
    assert record['owner_boot_epoch'] == 'boot-A:1'
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    second = RunIdempotencyStore(path)
    outcome, record = second.lookup('scope', 'key', 'hash')
    assert outcome == 'reused'
    assert record['owner_boot_epoch'] == 'boot-A:1'
    assert second.status_for_run('scope', 'run')['owner_boot_epoch'] == 'boot-A:1'


def test_planned_stop_marker_from_previous_boot_cannot_stop_reused_pid(tmp_path, monkeypatch):
    monkeypatch.setattr(status, '_get_planned_stop_marker_path', lambda: tmp_path / 'stop.json')
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-A:1')
    monkeypatch.setattr(status, '_get_process_start_time', lambda pid: 7)
    assert status.write_planned_stop_marker(status.os.getpid())
    assert status.planned_stop_marker_targets_self()
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    assert not status.planned_stop_marker_targets_self()


def test_cron_execution_recovered_after_namespace_restart(tmp_path, monkeypatch):
    from cron import executions
    monkeypatch.setattr(executions, 'EXECUTIONS_FILE', tmp_path / 'executions.db')
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-A:1')
    monkeypatch.setattr(status, '_pid_exists', lambda pid: True)
    monkeypatch.setattr(executions, '_process_start_time', lambda pid: 7)
    executions.create_execution('job', source='builtin')
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    monkeypatch.setattr(executions, '_PROCESS_ID', 'new-gateway')
    assert executions.recover_interrupted_executions() == 1
    assert executions.latest_execution('job')['status'] == 'unknown'


def test_profile_pid_record_cannot_prove_ownership_across_boots(tmp_path, monkeypatch):
    from hermes_cli.gateway_profile_lifecycle import _launch_record_owns
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-A:1')
    monkeypatch.setattr(status, '_get_process_start_time', lambda pid: 7)
    monkeypatch.setattr(status, '_read_pid_record', lambda: {
        'kind': 'hermes-gateway', 'pid': 2, 'start_time': 7,
        'hermes_home': str(tmp_path), 'boot_epoch': 'boot-A:1'})
    assert _launch_record_owns(2, tmp_path)
    monkeypatch.setattr(status, 'get_process_epoch', lambda: 'boot-B:1')
    assert not _launch_record_owns(2, tmp_path)
