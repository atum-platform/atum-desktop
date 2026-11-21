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


# ── Honesty: a sign-in the carried store refuses is reported, never a success ────────────────────

def _fresh_grant():
    """The store payload a just-completed interactive Codex login hands to the saver."""
    return {'providers': {'openai-codex': {'tokens': {'access_token': 'new-a', 'refresh_token': 'new-r'},
                                           'last_refresh': '2026-01-01T00:00:00Z', 'auth_mode': 'chatgpt'}},
            'credential_pool': {'openai-codex': [{'access_token': 'new-a', 'refresh_token': 'new-r'}]},
            'active_provider': 'openai-codex'}


@pytest.mark.parametrize('action', ['begin', 'commit'])
def test_interactive_save_is_refused_and_writes_nothing(account, action):
    """A person watching a sign-in must not be told it worked when the store dropped it."""
    home, _ = account
    transition(home, action)
    before = (home / 'auth.json').read_text(encoding='utf-8')
    from hermes_cli.auth import CredentialCarried, _save_auth_store
    with pytest.raises(CredentialCarried) as refused:
        _save_auth_store(_fresh_grant(), target_path=home / 'auth.json', interactive=True)
    assert refused.value.code == 'discarded_carried'
    assert (home / 'auth.json').read_text(encoding='utf-8') == before
    store = read(home)
    assert store['chatgpt_carry']['state'] == ('paused' if action == 'begin' else 'carried')
    assert 'new-r' not in json.dumps(store)
    assert store.get('active_provider') is None


def test_internal_save_still_strips_silently_and_leaves_no_dangling_active_provider(account):
    """Stale pool/refresh saves keep today's silent strip: the tombstone must hold."""
    home, _ = account
    transition(home, 'begin')
    transition(home, 'commit')
    from hermes_cli.auth import _save_auth_store
    store = _fresh_grant()
    store['unrelated'] = 'preserved'
    _save_auth_store(store, target_path=home / 'auth.json')
    saved = read(home)
    assert 'openai-codex' not in saved.get('providers', {})
    assert 'openai-codex' not in saved.get('credential_pool', {})
    assert saved['chatgpt_carry'] == {'state': 'carried'}
    assert saved['unrelated'] == 'preserved'
    # The pair the diagnosis found: active on a provider the same write deleted.
    assert saved.get('active_provider') is None


def test_interactive_save_without_a_tombstone_is_saved_and_active(account):
    home, _ = account
    from hermes_cli.auth import _save_auth_store
    _save_auth_store(_fresh_grant(), target_path=home / 'auth.json', interactive=True)
    saved = read(home)
    assert saved['providers']['openai-codex']['tokens']['refresh_token'] == 'new-r'
    assert saved['active_provider'] == 'openai-codex'


def test_oauth_flow_ends_in_error_with_the_carried_code(account, monkeypatch):
    """The dashboard sign-in's own path: approved upstream, refused by the store, reported as such."""
    import asyncio

    from hermes_cli.web_routers import oauth

    home, _ = account
    transition(home, 'begin')
    transition(home, 'commit')
    before = (home / 'auth.json').read_text(encoding='utf-8')
    monkeypatch.setattr(oauth, '_codex_request_user_code', lambda httpx: {
        'device_auth_id': 'device-auth-id', 'interval': 1, 'user_code': 'CODE-1234'})
    monkeypatch.setattr(oauth, '_codex_poll_authorization', lambda httpx, sess, sid: {
        'authorization_code': 'code', 'code_verifier': 'verifier'})
    monkeypatch.setattr(oauth, '_codex_exchange_tokens', lambda httpx, resp: {
        'access_token': 'new-a', 'refresh_token': 'new-r'})
    sid, sess = oauth._new_oauth_session('openai-codex', 'device_code')
    try:
        oauth._codex_full_login_worker(sid)
        assert sess['status'] == 'error'
        assert sess['error_code'] == 'discarded_carried'
        assert 'cloud' in sess['error_message']
        payload = asyncio.run(oauth.poll_oauth_session('openai-codex', sid))
        assert payload['status'] == 'error'
        assert payload['error_code'] == 'discarded_carried'
        assert (home / 'auth.json').read_text(encoding='utf-8') == before
    finally:
        oauth._oauth_sessions.pop(sid, None)


def test_oauth_flow_still_approves_a_save_the_store_keeps(account, monkeypatch):
    """No tombstone: the same worker path approves exactly as before."""
    from hermes_cli.web_routers import oauth

    home, _ = account
    monkeypatch.setattr(oauth, '_codex_request_user_code', lambda httpx: {
        'device_auth_id': 'device-auth-id', 'interval': 1, 'user_code': 'CODE-1234'})
    monkeypatch.setattr(oauth, '_codex_poll_authorization', lambda httpx, sess, sid: {
        'authorization_code': 'code', 'code_verifier': 'verifier'})
    monkeypatch.setattr(oauth, '_codex_exchange_tokens', lambda httpx, resp: {
        'access_token': 'new-a', 'refresh_token': 'new-r'})
    sid, sess = oauth._new_oauth_session('openai-codex', 'device_code')
    try:
        oauth._codex_full_login_worker(sid)
        assert sess['status'] == 'approved'
        assert sess.get('error_code') is None
        assert read(home)['providers']['openai-codex']['tokens']['refresh_token'] == 'new-r'
    finally:
        oauth._oauth_sessions.pop(sid, None)

