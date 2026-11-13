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


@pytest.mark.parametrize('tool', ['google', 'chats'])
@pytest.mark.parametrize('field', ['error', 'code'])
@pytest.mark.parametrize('code', ['rate_limited', 'not_found'])
def test_source_read_refusals_keep_safe_codes_and_retry_hint(tool, field, code):
    receipt = {field: code, 'retryAfter': '37', 'detail': 'private host detail'}
    with bind_source_transport(lambda *_: receipt):
        result = json.loads(google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list'))
    assert result['code'] == code
    assert 'private host detail' not in json.dumps(result)
    if code == 'rate_limited':
        assert result['retryAfter'] == '37'
        assert '37' in result['hint'] and 'retry' in result['hint'].lower()
    else:
        assert 'retryAfter' not in result


@pytest.mark.parametrize('retry', [None, True, [], {}, -1, 'bad\r\nheader', 'x' * 129])
@pytest.mark.parametrize('tool', ['google', 'chats'])
def test_bad_retry_hint_is_not_forwarded(tool, retry):
    with bind_source_transport(lambda *_: {'error': 'rate_limited', 'retryAfter': retry}):
        result = json.loads(google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list'))
    assert result['code'] == 'rate_limited'
    assert 'retryAfter' not in result
    assert 'retry' in result['hint'].lower()


@pytest.mark.parametrize('tool', ['google', 'chats'])
def test_closed_read_never_exposes_a_corrective_refusal(tool):
    with bind_source_transport(lambda *_: {'error': 'rate_limited', 'retryAfter': '37', 'closedAfter': True}):
        result = json.loads(google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list'))
    assert result.get('code') != 'rate_limited'
    assert 'retryAfter' not in result


@pytest.mark.parametrize('tool', ['google', 'chats'])
@pytest.mark.parametrize('status,code', [(429, 'rate_limited'), (404, 'not_found')])
def test_native_operation_http_refusal_preserves_code_without_host_body(tool, status, code):
    from email.message import Message
    from io import BytesIO
    from urllib.error import HTTPError

    headers = Message()
    headers['Retry-After'] = '37'
    error = HTTPError('https://fixture.invalid/private', status, 'private host reason', headers,
                      BytesIO(b'private host body'))
    def refused(*_):
        raise error
    with bind_source_transport(refused):
        result = json.loads(google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list'))
    assert result['code'] == code
    assert 'private' not in json.dumps(result)
    if code == 'rate_limited':
        assert result['retryAfter'] == '37'


@pytest.mark.parametrize('tool', ['google', 'chats'])
def test_retry_after_http_date_is_preserved(tool):
    retry = 'Wed, 18 Nov 2026 01:00:00 GMT'
    with bind_source_transport(lambda *_: {'error': 'rate_limited', 'retryAfter': retry}):
        result = json.loads(google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list'))
    assert result['code'] == 'rate_limited'
    assert result['retryAfter'] == retry
