"""An inherited live binding cannot authorize another session's host call."""
from contextvars import copy_context
import json

import pytest


@pytest.mark.parametrize('change', ['key', 'id'])
@pytest.mark.parametrize('tool', ['google', 'chats'])
def test_source_binding_checks_executing_session_on_every_call(monkeypatch, change, tool):
    from gateway.session_context import scoped_session_key, scoped_current_session_id
    from tools import atum_google_tool as google, atum_chats_tool as chats
    from tools.atum_source_transport import bind_source_transport
    monkeypatch.setattr(google, 'mark_holding', lambda: None)
    calls = []
    def host(name, payload):
        calls.append(name)
        return {'agenda': []} if name == 'google' else {'rooms': [], 'truncated': False}
    def invoke():
        return json.loads(google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list'))
    with scoped_session_key('owner-dm'), scoped_current_session_id('owner-session'):
        with bind_source_transport(host):
            inherited = copy_context()
            assert 'error' not in invoke()
            with scoped_session_key('group' if change == 'key' else 'owner-dm'), scoped_current_session_id('other' if change == 'id' else 'owner-session'):
                assert 'unavailable for this run' in invoke()['error']
            assert 'error' not in inherited.run(invoke)
    assert calls == [tool, tool]


@pytest.mark.parametrize('tool', ['google', 'chats'])
def test_binding_without_any_native_session_refuses(tool):
    from gateway.session_context import scoped_session_key, scoped_current_session_id
    from tools import atum_google_tool as google, atum_chats_tool as chats
    from tools.atum_source_transport import bind_source_transport
    with scoped_session_key(''), scoped_current_session_id(''):
        with bind_source_transport(lambda *a: pytest.fail('sessionless host call')):
            result = google.atum_google({'action': 'agenda'}) if tool == 'google' else chats.atum_chats('list')
    assert 'unavailable for this run' in json.loads(result)['error']
