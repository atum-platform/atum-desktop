"""Real provider/ledger loopback over the controller's exact event/RPC shapes."""
import copy
import json
import threading

import pytest

from agent.atum_awareness import AwarenessSessionError
from hermes_state import SessionDB
from tests.agent.test_atum_awareness_v2 import binding, response
from tui_gateway import server
from tui_gateway.managed_memory import admission, build_cloud_memory


@pytest.fixture
def setup(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(server, '_sessions', {})
    monkeypatch.setattr(server, '_idempotency_keys', {})
    monkeypatch.setattr(server, '_schedule_agent_build', lambda *a: None)
    monkeypatch.setattr(server, '_schedule_session_cap_enforcement', lambda: None)
    db = SessionDB(tmp_path / 'state.db')
    monkeypatch.setattr(server, '_get_db', lambda: db)
    yield db, tmp_path
    db.close()


def create(b=None, **extra):
    params = {'source': 'matrix', 'async_delivery': False, **extra}
    if b is not None:
        params['managed_memory'] = {'binding': b}
    return server.handle_request({'jsonrpc': '2.0', 'id': 'create', 'method': 'session.create', 'params': params})


def test_create_echo_frozen_binding_and_idempotent_retry(setup):
    b = binding()
    result = create(b, idempotency_key='create-once')['result']
    assert result['managed_memory'] == {'run_id': b['runId'], 'session_id': b['sessionId']}
    assert result['stored_session_id'] == b['sessionId']
    again = create(b, idempotency_key='create-once')['result']
    assert again['managed_memory'] == result['managed_memory']
    assert again['session_id'] == result['session_id']
    assert 'error' in create(binding(), idempotency_key='create-once')
    b['control']['revision'] = 99
    session = server._sessions[result['session_id']]
    assert session['_managed_memory_binding']['control']['revision'] == 1


def test_unmanaged_create_and_local_admission_unchanged(setup):
    result = create()['result']
    assert 'managed_memory' not in result
    session = server._sessions[result['session_id']]
    assert session['_managed_memory_binding'] is None
    assert admission({}, object(), object()) is None
    with pytest.raises(ValueError):
        admission({'source': 'matrix', 'async_delivery': False, 'managed_memory': {'binding': binding()}}, object(), object())
    assert 'error' in create(binding(), source='desktop')
    assert 'error' in create(binding(), async_delivery=True)


def test_controller_loopback_cache_stability_and_retirement(setup, monkeypatch):
    db, home = setup
    b = binding()
    result = create(b)['result']
    sid = result['session_id']
    session = server._sessions[sid]
    session['profile_home'] = str(home)
    session['running'] = True
    calls = []
    state = {'current': True}

    def controller(event, event_sid, payload):
        calls.append((event, copy.deepcopy(payload)))
        assert event_sid == sid
        assert set(payload) == {'request_id', 'request'}
        if event == 'atum.memory.retrieve.request':
            answer = {'ok': True, 'response': response(payload['request'], threading.Event())}
        elif event == 'atum.memory.current.request':
            answer = {'ok': True, 'current': state['current']}
        else:
            assert event == 'atum.memory.invalidate.request'
            answer = {'ok': True}
        rpc = server.handle_request({'jsonrpc': '2.0', 'id': 'answer',
            'method': event.replace('.request', '.respond'), 'params': {
                'session_id': sid, 'request_id': payload['request_id'], 'result': json.dumps(answer)}})
        assert rpc['result'] == {'accepted': True}
        return True

    monkeypatch.setattr(server, '_emit', controller)
    manager = build_cloud_memory(session, sid, b['sessionId'], db)['memory_manager']
    assert calls == []  # controller only listens after submission
    prompt, tools = manager.build_system_prompt(), manager.get_all_tool_schemas()
    for query in ('launch', 'decision'):
        manager.assert_run_authority()
        answer = json.loads(manager.handle_tool_call('atum_recall', {'query': query}))
        assert answer['status'] == 'ok'
    assert manager.build_system_prompt() == prompt
    assert manager.get_all_tool_schemas() == tools
    assert any(e == 'atum.memory.retrieve.request' for e, _ in calls)
    state['current'] = False
    with pytest.raises(AwarenessSessionError):
        manager.assert_run_authority()
    assert calls[-1][0] == 'atum.memory.invalidate.request'
    assert db.get_meta('memory.retired.v2.' + b['sessionId']) == 'true'
    assert session['_turn_cancel_requested'] is True


def test_closed_response_codes_and_transport_scope(setup, monkeypatch):
    db, home = setup
    b = binding()
    sid = create(b)['result']['session_id']
    session = server._sessions[sid]
    session['profile_home'] = str(home)
    build_cloud_memory(session, sid, b['sessionId'], db)
    bridge = session['_managed_memory_bridge']
    slot = {'kind': 'current', 'event': threading.Event(), 'result': None}
    bridge.pending['req'] = slot
    def reply(value, kind='current'):
        return server.handle_request({'jsonrpc': '2.0', 'id': 'reply',
            'method': f'atum.memory.{kind}.respond', 'params': {
                'session_id': sid, 'request_id': 'req', 'result': json.dumps(value)}})
    for value in ({'ok': False, 'error': 'private detail'}, {'ok': True, 'current': 'yes'},
                  {'ok': True, 'current': True, 'token': 'forged'}):
        assert reply(value)['result']['accepted'] is False
    assert reply({'ok': True}, 'invalidate')['result']['accepted'] is False
    monkeypatch.setattr(server, 'current_transport', lambda: object())
    assert 'error' in reply({'ok': True, 'current': True})
    monkeypatch.setattr(server, 'current_transport', lambda: None)
    assert reply({'ok': True, 'current': True})['result']['accepted'] is True
    assert reply({'ok': True, 'current': True})['result']['accepted'] is False


def test_cancelled_retrieve_emits_nothing(setup, monkeypatch):
    db, home = setup
    b = binding()
    sid = create(b)['result']['session_id']
    session = server._sessions[sid]
    session['profile_home'] = str(home)
    build_cloud_memory(session, sid, b['sessionId'], db)
    monkeypatch.setattr(server, '_emit', lambda *a: pytest.fail('cancelled request sent'))
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(AwarenessSessionError):
        session['_managed_memory_bridge'].retrieve({}, cancelled)


def test_factory_routes_managed_and_preserves_unmanaged_path(setup, monkeypatch):
    from tests.tui_gateway.test_shared_room_sessions import _make_agent_kwargs
    from tui_gateway import awareness_provider, managed_memory
    calls = []
    marker = object()
    monkeypatch.setattr(awareness_provider, 'build_memory_manager',
                        lambda *args: calls.append(args) or marker)
    kwargs, _ = _make_agent_kwargs()
    assert kwargs['memory_manager'] is marker
    assert calls == [(None, 'sid-1', 'key-1')]
    calls.clear()
    b = binding()
    session = {'_managed_memory_binding': b}
    server._sessions['sid-1'] = session
    monkeypatch.setattr(managed_memory, 'build_cloud_memory',
                        lambda *args: calls.append(args) or {'memory_manager': marker})
    kwargs, _ = _make_agent_kwargs(session_id=b['sessionId'])
    assert kwargs['memory_manager'] is marker
    assert len(calls) == 1 and calls[0][:3] == (session, 'sid-1', b['sessionId'])


def test_factory_binds_real_native_manager_before_agent(setup, monkeypatch):
    from tests.tui_gateway.test_shared_room_sessions import _make_agent_kwargs
    db, home = setup
    b = binding()
    session = {'_managed_memory_binding': b, 'profile_home': str(home)}
    server._sessions['sid-1'] = session
    monkeypatch.setattr(server, '_emit', lambda *a: pytest.fail('construction sent a bridge request'))
    kwargs, _ = _make_agent_kwargs(session_id=b['sessionId'], session_db=db)
    manager = kwargs['memory_manager']
    assert manager.providers and kwargs['skip_memory'] is False
    assert manager.get_all_tool_schemas()[0]['name'] == 'atum_recall'
    assert session['_managed_memory_bridge'].constructing is False
