"""Actual HTTP -> detached CLI -> selected-profile ZIP proof (no user data)."""
import os
from pathlib import Path
import sqlite3
import stat
import time
import zipfile
from types import SimpleNamespace

import pytest


@pytest.fixture
def local_client(monkeypatch, tmp_path, _isolate_hermes_home):
    from hermes_cli import profiles, web_server
    from hermes_cli.web_routers import ops
    from starlette.testclient import TestClient
    root = tmp_path / 'agent-root'
    root.mkdir()
    other = root / 'profiles' / 'worker_beta'
    other.mkdir(parents=True)
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_HOME', str(root))
    monkeypatch.setattr(profiles, '_get_default_hermes_home', lambda: root)
    monkeypatch.setattr(profiles, '_get_profiles_root', lambda: root / 'profiles')
    monkeypatch.setattr(ops, '_LOCAL_MAINTENANCE', {})
    for home, label in [(root, 'root-fixture'), (other, 'worker-fixture')]:
        (home / 'config.yaml').write_text('memory:\n  provider: none\n', encoding='utf8')
        (home / 'MEMORY.md').write_text(label, encoding='utf8')
        (home / '.env').write_text('FIXTURE_PRIVATE_KEY=fixture-local-only\n', encoding='utf8')
        with sqlite3.connect(home / 'fixture.db') as db:
            db.execute('create table proof (label text)')
            db.execute('insert into proof values (?)', (label,))
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    yield client, root, other
    for state in ops._LOCAL_MAINTENANCE.values():
        proc = state['proc']
        if hasattr(proc, 'terminate') and proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)


@pytest.mark.parametrize('profile', ['default', 'worker_beta'])
def test_real_cli_archive_contains_only_selected_home_and_is_private(local_client, profile):
    client, root, other = local_client
    home = root if profile == 'default' else other
    (home / 'backups').mkdir(mode=0o777)
    (home / 'backups').chmod(0o777)
    before = {p: p.read_bytes() for h in [root, other] for p in [h / 'config.yaml', h / '.env', h / 'MEMORY.md']}
    response = client.post('/api/ops/backup', params={'profile': profile}, json={})
    assert response.status_code == 200, response.text
    started = response.json()
    deadline = time.monotonic() + 40
    while True:
        result = client.get('/api/actions/backup/status', params={'profile': profile, 'lines': 200}).json()
        if not result['running']:
            break
        assert time.monotonic() < deadline, result
        time.sleep(0.05)
    assert result['exit_code'] == 0, result
    archive = home / 'backups' / os.path.basename(result['archive'])
    assert archive == Path(started['archive'])
    assert stat.S_IMODE(archive.stat().st_mode) == 0o600
    if os.name != "nt":
        assert stat.S_IMODE(archive.parent.stat().st_mode) == 0o700
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        assert zf.testzip() is None
        assert zf.read('MEMORY.md') == before[home / 'MEMORY.md']
        assert zf.read('.env') == before[home / '.env']
        assert 'fixture.db' in names
        assert not any(name.startswith(('profiles/', 'backups/', '_external/')) for name in names)
    other_status = client.get('/api/actions/backup/status', params={'profile': 'worker_beta' if profile == 'default' else 'default'}).json()
    assert other_status['pid'] is None and other_status['exit_code'] is None
    assert (home / 'logs' / 'action-backup.log').is_file()
    assert {p: p.read_bytes() for p in before} == before


@pytest.mark.parametrize('action', ['doctor', 'backup'])
def test_live_process_is_not_replaced_and_status_recovers_after_reopen(local_client, monkeypatch, action):
    from hermes_cli.web_routers import ops
    client, root, other = local_client
    spawned = []
    code = [None]
    def fake_spawn(args, name, *, home):
        spawned.append((args, name, home))
        return SimpleNamespace(pid=12345, poll=lambda: code[0])
    monkeypatch.setattr(ops, '_spawn_hermes_action', fake_spawn)
    def start(profile):
        return client.post('/api/ops/' + action, params={'profile': profile}, **({'json': {}} if action == 'backup' else {}))
    first = start('worker_beta')
    second = start('worker_beta')
    assert first.status_code == second.status_code == 200
    assert second.json()['reused'] is True
    assert first.json()['pid'] == second.json()['pid']
    assert len(spawned) == 1 and spawned[0][2] == other.resolve()
    if action == 'backup':
        assert '--profile-only' in spawned[0][0]
        assert len(list((other / 'backups').glob('*.zip'))) == 1
    status = client.get(f'/api/actions/{action}/status?profile=worker_beta').json()
    assert status['running'] is True
    code[0] = 3
    reopened = client.get(f'/api/actions/{action}/status?profile=worker_beta').json()
    assert reopened['running'] is False and reopened['exit_code'] == 3
    assert reopened['archive'] is None
    assert client.get(f'/api/actions/{action}/status?profile=default').json()['pid'] is None


def test_spawn_pins_child_home_and_closes_parent_log_handle(local_client, monkeypatch):
    from hermes_cli import web_server_gateway
    _, _, other = local_client
    captured = {}
    def popen(cmd, **kwargs):
        captured.update(kwargs)
        captured['cmd'] = cmd
        return SimpleNamespace(pid=42)
    monkeypatch.setattr(web_server_gateway.subprocess, 'Popen', popen)
    web_server_gateway._spawn_hermes_action(['doctor'], 'doctor', home=other)
    assert captured['env']['HERMES_HOME'] == str(other)
    assert captured['env']['HERMES_NONINTERACTIVE'] == '1'
    assert '_HERMES_GATEWAY' not in captured['env']
    assert captured['stdout'].closed
    assert captured['cmd'][-1] == 'doctor' and '--fix' not in captured['cmd']


def test_profile_backup_rejects_output_and_symlink_directory(local_client, tmp_path):
    client, _, other = local_client
    assert client.post('/api/ops/backup?profile=worker_beta', json={'output': str(tmp_path / 'foreign.zip')}).status_code == 400
    outside = tmp_path / 'outside'
    outside.mkdir()
    (other / 'backups').symlink_to(outside, target_is_directory=True)
    assert client.post('/api/ops/backup?profile=worker_beta', json={}).status_code == 500
    assert list(outside.iterdir()) == []


def test_concurrent_confirmed_requests_share_one_live_process(local_client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from hermes_cli.web_routers import ops
    client, _, other = local_client
    spawned = []
    def spawn(args, name, *, home):
        spawned.append(home)
        return SimpleNamespace(pid=34567, poll=lambda: None)
    monkeypatch.setattr(ops, '_spawn_hermes_action', spawn)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: client.post('/api/ops/backup?profile=worker_beta', json={}), range(6)))
    assert all(response.status_code == 200 and response.json()['pid'] == 34567 for response in results)
    assert spawned == [other.resolve()]
    assert sum(not response.json()['reused'] for response in results) == 1
    assert len(list((other / 'backups').glob('*.zip'))) == 1


def test_real_incomplete_profile_backup_never_becomes_a_successful_archive(local_client):
    client, _, other = local_client
    (other / 'broken.db').write_bytes(b'fixture-not-a-database')
    response = client.post('/api/ops/backup?profile=worker_beta', json={})
    assert response.status_code == 200
    deadline = time.monotonic() + 40
    while True:
        result = client.get('/api/actions/backup/status?profile=worker_beta').json()
        if not result['running']:
            break
        assert time.monotonic() < deadline, result
        time.sleep(0.05)
    assert result['exit_code'] == 1
    assert result['archive'] is None
    assert any('Backup incomplete' in line for line in result['lines'])
