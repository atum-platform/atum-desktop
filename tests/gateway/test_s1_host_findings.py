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
    record = status._build_pid_record()
    record['gateway_state'] = 'running'
    monkeypatch.setattr(status, '_pid_exists', lambda pid: True)
    monkeypatch.setattr(status, '_record_matches_live_gateway_pid', lambda *a, **kw: True)
    assert status._live_pid_from_record(record) == record['pid']
    # Container restart preserves home, replaces its private tmpfs lock rendezvous.
    for child in locks.iterdir():
        child.unlink()
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
