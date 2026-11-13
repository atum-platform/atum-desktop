"""Restart-incarnation and process-readiness contracts."""
import json
from pathlib import Path

import pytest

from gateway import status
from gateway.readiness import collect_runtime_readiness


@pytest.mark.parametrize('source', ['runtime', 'pid'])
def test_persisted_pid_cannot_cross_lock_incarnation(tmp_path, monkeypatch, source):
    home = tmp_path / 'home'
    home.mkdir()
    locks = tmp_path / 'locks'
    locks.mkdir()
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setenv('HERMES_GATEWAY_LOCK_DIR', str(locks))
    monkeypatch.setattr(status, 'get_process_boot_id', lambda: 'sandbox-a')
    record = status._build_pid_record()
    record['gateway_state'] = 'running'
    monkeypatch.setattr(status, '_pid_exists', lambda pid: True)
    monkeypatch.setattr(status, '_record_matches_live_gateway_pid', lambda *a, **kw: True)
    assert status._live_pid_from_record(record) == record['pid']
    # Container restart preserves home, replaces its private tmpfs lock rendezvous.
    monkeypatch.setattr(status, 'get_process_boot_id', lambda: 'sandbox-b')
    if source == 'runtime':
        assert status.get_runtime_status_running_pid(record) is None
    else:
        assert status._live_pid_from_record(record) is None


@pytest.mark.parametrize('fault', ['home', 'store', 'platform'])
def test_storage_and_required_adapter_failures_are_process_faults(tmp_path, monkeypatch, fault):
    from hermes_cli import config_home
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    runtime = {'gateway_state': 'running', 'platforms': {}}
    if fault == 'home':
        def denied(*a, **kw):
            raise config_home.HomeInitializationError('Permission denied')
        monkeypatch.setattr(config_home, '_ensure_directory', denied)
        with pytest.raises(config_home.HomeInitializationError):
            config_home.initialize_home(tmp_path, (), set())
    elif fault == 'store':
        runtime['session_store'] = {'status': 'unavailable'}
    else:
        runtime['platforms']['matrix'] = {'state': 'retrying', 'error_code': 'adapter_unavailable'}
    result = collect_runtime_readiness(configured_model='test', runtime_status=runtime)
    assert result['process_healthy'] is False
    assert {'process_healthy', 'paused_conversations', 'wedge', 'alert'} <= result.keys()


def test_previous_sandbox_platform_writer_is_not_current(monkeypatch):
    from hermes_cli.web_server_gateway import _owned_profile_platforms
    monkeypatch.setattr(status, 'get_process_boot_id', lambda: 'new')
    entries = {'matrix': {'writer_pid': 2, 'writer_start_time': 10, 'writer_boot_id': 'old'}}
    assert _owned_profile_platforms((2, 10), entries) == {}
    entries['matrix']['writer_boot_id'] = 'new'
    assert _owned_profile_platforms((2, 10), entries) == entries


def test_storage_permissions_visible_to_separate_healthcheck(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr('gateway.readiness.os.access', lambda *a: False)
    assert collect_runtime_readiness(configured_model='test', runtime_status={
        'gateway_state': 'running'})['process_healthy'] is False


@pytest.mark.parametrize('fstype,release,expected', [
    ('9p', '4.19.0-gvisor', False), ('9p', '6.1.0', True),
    ('virtiofs', '4.19.0-gvisor', True), ('fuse.virtiofs', '6.1.0', True),
])
def test_gofer_is_distinct_from_cross_vm_filesystems(tmp_path, monkeypatch, fstype, release, expected):
    from types import SimpleNamespace
    import hermes_state_wal as wal
    monkeypatch.setattr(wal.sys, 'platform', 'linux')
    monkeypatch.setattr(wal.os, 'uname', lambda: SimpleNamespace(release=release))
    mounts = tmp_path / 'mountinfo'
    mounts.write_text(f'25 1 0:1 / / rw - {fstype} none rw\n')
    assert wal._detect_cross_vm_fs('/data', str(mounts)) is expected
