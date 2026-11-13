"""Offline cloud source binding regressions, with no desktop or Google token."""
import json

import pytest

from tools import atum_chats_tool as chats, atum_google_tool as google


def test_cron_sources_use_native_operation(monkeypatch):
    from tools import atum_source_transport as host
    from tools.atum_source_transport import bind_source_transport
    monkeypatch.setattr(host, '_host_transport_enabled', False)
    host.enable_source_transport()
    monkeypatch.setenv('HERMES_CRON_SESSION', '1')
    monkeypatch.delenv(google.URL_ENV, raising=False)
    monkeypatch.delenv(google.TOKEN_ENV, raising=False)
    monkeypatch.setattr(chats.desktop_ui, '_request', None)
    monkeypatch.setattr(chats.desktop_ui, '_emit', None)
    monkeypatch.setattr(google, 'mark_holding', lambda: None)
    calls = []

    def call(tool, payload):
        calls.append((tool, payload))
        return {'events': ['Team review at 09:00']} if tool == 'google' else {'rooms': [], 'truncated': False}

    with bind_source_transport(call):
        assert google.available() and chats.available()
        assert json.loads(google.atum_google({'action': 'agenda'}))['events']
        assert json.loads(chats.atum_chats('list')) == {'rooms': [], 'truncated': False}
    assert calls == [('google', {'action': 'agenda'}), ('chats', {'op': 'list'})]
    assert google.available() and chats.available()  # fixed across run boundaries


@pytest.mark.parametrize('tool', ['google', 'chats'])
def test_revoked_grant_refuses_without_desktop_fallback(monkeypatch, tool):
    from tools.atum_source_transport import bind_source_transport
    monkeypatch.setattr(chats.desktop_ui, 'request', lambda *a, **k: pytest.fail('authority fallback'))
    def denied(*args):
        raise RuntimeError('secret host details')
    with bind_source_transport(denied):
        result = google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list')
    error = json.loads(result)['error']
    assert error == ('Google is unavailable for this run.' if tool == 'google' else 'Owner chats are unavailable for this run.')


def test_bound_google_keeps_background_write_restriction(monkeypatch):
    from tools.atum_source_transport import bind_source_transport
    monkeypatch.setenv('HERMES_CRON_SESSION', '1')
    with bind_source_transport(lambda *a: pytest.fail('write dispatched')):
        assert json.loads(google.atum_google({'action': 'send_email'}))['error'] == 'owner_turn_required'


def test_binding_isolated_and_closed_in_copied_context():
    from contextvars import copy_context
    from tools.atum_source_transport import bind_source_transport, source_transport
    assert source_transport() is None
    with bind_source_transport(lambda *a: {'ok': True}):
        copied = copy_context()
        with bind_source_transport(lambda *a: {'nested': True}):
            assert source_transport()('google', {}) == {'nested': True}
        assert source_transport()('google', {}) == {'ok': True}
    with pytest.raises(RuntimeError, match='operation_closed'):
        copied.run(lambda: source_transport()('google', {}))


@pytest.mark.parametrize('tool', ['google', 'chats'])
def test_missing_grant_is_short_owner_facing_refusal(tool):
    from tools.atum_source_transport import bind_source_transport
    with bind_source_transport(lambda *a: {'error': 'disabled'}):
        result = google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list')
    assert json.loads(result)['error'] == (
        'Google is unavailable for this run.' if tool == 'google'
        else 'Owner chats are unavailable for this run.')


def test_write_transport_failure_preserves_unknown_outcome(monkeypatch):
    from tools.atum_source_transport import bind_source_transport
    monkeypatch.setattr(google, '_background_run', lambda: False)
    def lost_reply(*args):
        raise OSError('lost reply')
    with bind_source_transport(lost_reply):
        result = json.loads(google.atum_google({'action': 'create_event'}))
    assert result['code'] == 'outcome_unknown'
