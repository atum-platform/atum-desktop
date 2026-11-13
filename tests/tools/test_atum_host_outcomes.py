"""A host write with no clean confirmation must never look safe to resend."""
import json

import pytest

from tools import atum_google_tool as google, atum_chats_tool as chats
from tools.atum_source_transport import bind_source_transport


@pytest.fixture(autouse=True)
def native_source_session():
    from gateway.session_context import scoped_session_key, scoped_current_session_id
    with scoped_session_key('source-fixture'), scoped_current_session_id('source-fixture'):
        yield


@pytest.mark.parametrize('action', ['send_email', 'create_event', 'update_event'])
@pytest.mark.parametrize('receipt', [None, {'error': 'outcome_unknown'}, {'error': 'unavailable'},
    {'code': 'outcome_unknown'}, {'ok': False},
    {'ok': True, 'closedAfter': True}, {'body': 'x' * (256 * 1024)}])
def test_uncertain_write_returns_unknown_not_unavailable(monkeypatch, action, receipt):
    monkeypatch.setattr(google, '_background_run', lambda: False)
    with bind_source_transport(lambda *a: receipt):
        result = json.loads(google.atum_google({'action': action}))
    assert result['code'] == 'outcome_unknown'
    assert 'check before retrying' in result['error']


@pytest.mark.parametrize('tool', ['google', 'chats'])
@pytest.mark.parametrize('code', ['invalid_input', 'owner_turn_required', 'confirmationRequired'])
def test_host_correctable_errors_preserve_only_typed_fields(monkeypatch, tool, code):
    monkeypatch.setattr(google, '_background_run', lambda: False)
    with bind_source_transport(lambda *a: {'error': code, 'operationId': 'op-fixture', 'secret': 'private host detail'}):
        result = json.loads(google.atum_google({'action': 'send_email'}) if tool == 'google' else chats.atum_chats('list'))
    assert result['code'] == code
    assert 'private host detail' not in json.dumps(result)
    if code == 'confirmationRequired':
        assert result['operationId'] == 'op-fixture'


def test_closed_chat_result_is_not_returned_as_data():
    with bind_source_transport(lambda *a: {'rooms': [], 'truncated': False, 'closedAfter': True}):
        assert 'error' in json.loads(chats.atum_chats('list'))
