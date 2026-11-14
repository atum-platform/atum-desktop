import copy
import json
import pytest
from hermes_cli.chatgpt_carry import transition

@pytest.fixture
def account(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('ATUM_ACCOUNT_AUTH_HOME', str(tmp_path))
    from hermes_cli.auth import _save_auth_store
    store = {'providers': {'openai-codex': {'tokens': {'access_token': 'fake-a', 'refresh_token': 'fake-r'}}},
             'credential_pool': {'openai-codex': [{'access_token': 'fake-a', 'refresh_token': 'fake-r'}]},
             'unrelated': 'preserved'}
    _save_auth_store(copy.deepcopy(store), target_path=tmp_path / 'auth.json')
    return tmp_path, store


def read(home):
    return json.loads((home / 'auth.json').read_text())


def test_pause_and_recover(account):
    home, _ = account
    assert transition(home, 'begin')['state'] == 'paused'
    assert not read(home)['credential_pool'].get('openai-codex')
    assert transition(home, 'begin')['refresh_token'] == 'fake-r'
    assert transition(home, 'rollback') == {'state': 'local'}
    assert read(home)['providers']['openai-codex']['tokens']['refresh_token'] == 'fake-r'


def test_commit_erases_pair_and_stale_save_cannot_resurrect(account):
    home, stale = account
    transition(home, 'begin')
    transition(home, 'commit')
    from hermes_cli.auth import _save_auth_store
    _save_auth_store(stale, target_path=home / 'auth.json')
    assert read(home)['chatgpt_carry'] == {'state': 'carried'}
    assert 'fake-r' not in json.dumps(read(home))
    assert transition(home, 'rollback') == {'state': 'carried'}
    assert read(home)['unrelated'] == 'preserved'


@pytest.mark.parametrize('action', ['begin', 'commit'])
def test_cached_refresh_refused_before_network(account, monkeypatch, action):
    home, _ = account
    transition(home, 'begin')
    if action == 'commit': transition(home, 'commit')
    from hermes_cli import auth_codex
    monkeypatch.setattr(auth_codex, '_codex_http_client', lambda **kw: pytest.fail('network reached'))
    with pytest.raises(Exception, match='held by the cloud'):
        auth_codex.refresh_codex_oauth_pure('fake-a', 'fake-r')


def test_stale_save_during_pause_preserves_recovery_pair(account):
    home, stale = account
    from hermes_cli.auth import _save_auth_store
    transition(home, 'begin')
    _save_auth_store(stale, target_path=home / 'auth.json')
    assert read(home)['chatgpt_carry']['state'] == 'paused'
    assert not read(home)['providers'].get('openai-codex')
    assert transition(home, 'rollback')['state'] == 'local'


def test_begin_waits_for_inflight_rotation(account, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from hermes_cli import auth_codex
    from hermes_cli.auth import _load_auth_store, _save_auth_store
    home, _ = account
    started, finish = Event(), Event()
    def refresh(*args, **kwargs):
        started.set()
        assert finish.wait(3)
        store = _load_auth_store(home / 'auth.json')
        store['providers']['openai-codex']['tokens']['refresh_token'] = 'fake-rotated'
        store['credential_pool']['openai-codex'][0]['refresh_token'] = 'fake-rotated'
        _save_auth_store(store, target_path=home / 'auth.json')
        return {}
    monkeypatch.setattr(auth_codex, '_refresh_codex_owned', refresh)
    with ThreadPoolExecutor(2) as pool:
        rotating = pool.submit(auth_codex.refresh_codex_oauth_pure, 'fake-a', 'fake-r')
        assert started.wait(3)
        beginning = pool.submit(transition, home, 'begin')
        assert not beginning.done()
        finish.set()
        rotating.result()
        assert beginning.result()['refresh_token'] == 'fake-rotated'
