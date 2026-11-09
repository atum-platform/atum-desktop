"""Real selected-home curator settings and owned CLI process receipts."""
import json
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def client(monkeypatch, tmp_path, _isolate_hermes_home):
    from hermes_cli import profiles, web_server
    from hermes_cli.web_routers import ops
    from starlette.testclient import TestClient
    root = tmp_path / 'root'
    other = root / 'profiles' / 'worker_beta'
    other.mkdir(parents=True)
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_HOME', str(root))
    monkeypatch.setattr(profiles, '_get_default_hermes_home', lambda: root)
    monkeypatch.setattr(profiles, '_get_profiles_root', lambda: root / 'profiles')
    monkeypatch.setattr(ops, '_LOCAL_MAINTENANCE', {})
    for home, paused in [(root, False), (other, True)]:
        (home / 'skills').mkdir()
        (home / 'skills' / '.curator_state').write_text(json.dumps({'paused': paused, 'run_count': 0}))
        (home / 'config.yaml').write_text('curator:\n  consolidate: false\n  prune_builtins: false\n')
        (home / '.env').write_text('FIXTURE_PRIVATE=non-public-local-value\n')
    result = TestClient(web_server.app)
    result.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    yield result, root, other
    for state in ops._LOCAL_MAINTENANCE.values():
        proc = state['proc']
        if hasattr(proc, 'terminate') and proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)


def test_pause_is_persisted_in_selected_home_and_legacy_default_preserved(client):
    http, root, other = client
    before = (root / 'skills' / '.curator_state').read_bytes()
    assert http.get('/api/curator?profile=worker_beta').json()['paused'] is True
    assert http.get('/api/curator').json()['paused'] is False
    response = http.put('/api/curator/paused?profile=worker_beta', json={'paused': False})
    assert response.status_code == 200 and response.json()['profile_scoped'] is True
    assert json.loads((other / 'skills' / '.curator_state').read_text())['paused'] is False
    assert (root / 'skills' / '.curator_state').read_bytes() == before
    assert http.get('/api/curator?profile=worker_beta').json()['paused'] is False


def test_failed_pause_write_cannot_claim_success(client, monkeypatch):
    import utils
    http, root, other = client
    def fail(*args, **kwargs):
        raise OSError('private-filesystem-detail')
    monkeypatch.setattr(utils, 'atomic_json_write', fail)
    # curator imported this helper already; patch its actual dependency too.
    from agent import curator
    monkeypatch.setattr(curator, 'atomic_json_write', fail)
    response = http.put('/api/curator/paused?profile=worker_beta', json={'paused': False})
    assert response.status_code == 500 and 'private-filesystem-detail' not in response.text
    assert json.loads((other / 'skills' / '.curator_state').read_text())['paused'] is True


@pytest.mark.parametrize('paused', [True, False])
def test_review_process_preserves_new_http_pause_intent(client, tmp_path, paused):
    http, root, other = client
    assert http.put('/api/curator/paused?profile=worker_beta', json={'paused': not paused}).status_code == 200
    root_before = (root / 'skills' / '.curator_state').read_bytes()
    ready, release = tmp_path / 'ready', tmp_path / 'release'
    # Real imports in a separate selected-home process, with no provider keys.
    # Its completion snapshot is deliberately older than the gateway action.
    child = subprocess.Popen(
        [sys.executable, '-c', '''
import sys, time
from pathlib import Path
from agent import curator
ready, release = map(Path, sys.argv[1:])
state = curator.load_state()
state['last_run_summary'] = 'completed review'
ready.touch()
deadline = time.monotonic() + 15
while not release.exists():
    if time.monotonic() > deadline:
        raise TimeoutError('test synchronization timed out')
    time.sleep(.02)
curator.save_state(state, strict=True, preserve_paused=True)
''', str(ready), str(release)],
        cwd=Path(__file__).resolve().parents[2],
        env={'HOME': str(tmp_path), 'HERMES_HOME': str(other)},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while not ready.exists():
            assert child.poll() is None, child.communicate()
            assert time.monotonic() < deadline
            time.sleep(.02)
        response = http.put('/api/curator/paused?profile=worker_beta', json={'paused': paused})
        assert response.status_code == 200
        release.touch()
        output = child.communicate(timeout=10)
        assert child.returncode == 0, output
        result = http.get('/api/curator?profile=worker_beta')
        assert result.status_code == 200 and result.json()['paused'] is paused
        state = json.loads((other / 'skills' / '.curator_state').read_text())
        assert state['last_run_summary'] == 'completed review'
        assert (root / 'skills' / '.curator_state').read_bytes() == root_before
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=5)


def test_real_run_uses_selected_cli_home_and_retains_terminal_receipt(client):
    http, root, other = client
    before = {p: p.read_bytes() for p in [root / 'config.yaml', root / '.env', root / 'skills' / '.curator_state']}
    response = http.post('/api/curator/run?profile=worker_beta')
    assert response.status_code == 200 and response.json()['name'] == 'curator-run'
    deadline = time.monotonic() + 35
    while True:
        result = http.get('/api/actions/curator-run/status?profile=worker_beta').json()
        if not result['running']:
            break
        assert time.monotonic() < deadline
        time.sleep(.05)
    assert result['exit_code'] == 0 and result['profile_scoped'] is True, result
    assert json.loads((other / 'skills' / '.curator_state').read_text())['run_count'] == 1
    assert (other / 'logs' / 'action-curator-run.log').exists()
    assert all(p.read_bytes() == content for p, content in before.items())
    assert http.get('/api/actions/curator-run/status?profile=default').json()['pid'] is None
    assert http.get('/api/actions/curator-run/status?profile=worker_beta').json()['pid'] == result['pid']


def test_concurrent_run_requests_do_not_replace_live_process(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from hermes_cli.web_routers import ops
    http, root, other = client
    spawns = []
    def spawn(args, name, *, home):
        spawns.append((args, name, home))
        return SimpleNamespace(pid=34567, poll=lambda: None)
    monkeypatch.setattr(ops, '_spawn_hermes_action', spawn)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: http.post('/api/curator/run?profile=worker_beta'), range(6)))
    assert all(r.status_code == 200 and r.json()['pid'] == 34567 for r in results)
    assert len(spawns) == 1 and spawns[0] == (['curator', 'run', '--sync', '--require-success'], 'curator-run', other.resolve())
    assert sum(not r.json()['reused'] for r in results) == 1


def test_corrupt_or_cross_home_state_fails_closed(client):
    http, root, other = client
    state = other / 'skills' / '.curator_state'
    state.write_text('not-json')
    assert http.get('/api/curator?profile=worker_beta').status_code == 409
    assert http.post('/api/curator/run?profile=worker_beta').status_code == 409
    state.unlink()
    state.symlink_to(root / 'skills' / '.curator_state')
    assert http.put('/api/curator/paused?profile=worker_beta', json={'paused': True}).status_code == 409
    assert json.loads((root / 'skills' / '.curator_state').read_text())['paused'] is False
