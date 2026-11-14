"""Real ABC, manager and SQLite paths; synthetic authority and evidence only."""
import copy
import json
import sqlite3
import threading
import time
from uuid import uuid4

import pytest

from agent.atum_awareness import AtumAwarenessProvider, AwarenessRunBinding, AwarenessSessionError
from agent.atum_awareness_contract import AwarenessContractError
from agent.memory_run_lifecycle import MemoryRunLifecycle, compose_managed_memory
from hermes_state import SessionDB
from tests.agent.test_atum_awareness import item


def binding():
    owner = str(uuid4())
    return dict(profile='atum.awareness-run/2', runId=str(uuid4()), agentPrincipal=str(uuid4()),
                sessionId=str(uuid4()), capabilityVersion='atum.awareness/2', capabilityDigest='a' * 64,
                owner=dict(kind='personal', ownerPrincipal=owner),
                audience=dict(**{'class': 'private_owner'}, ownerPrincipal=owner),
                control=dict(state='on', revision=1, policyGeneration=1, keyGeneration=1, serviceGeneration=1),
                embedding=dict(mode='keyword', billable=False, fallback='keyword'))


def response(req, stop):
    evidence = item()
    evidence['lineage'] = dict(kind='personal', ownerPrincipal=req['binding']['owner']['ownerPrincipal'],
                               sourcePolicyGeneration=1)
    return dict(requestId=req['requestId'], runId=req['binding']['runId'], capabilityVersion='atum.awareness/2',
                status='ok', items=[evidence], coverage=[], contentBytes=len(evidence['content'].encode()))


def provider(tmp_path, b=None, read=response, record=None, current=lambda: True, invalid=lambda: None, **kwargs):
    b = b or binding()
    p = AtumAwarenessProvider(AwarenessRunBinding(b['sessionId'], str(tmp_path), b['agentPrincipal'],
                                                {'class': 'private_owner'}, False, 'managed'),
                              cloud_binding=b, retrieve=read, record_provenance=record or (lambda _: None),
                              is_current=current, invalidate_run=invalid, mark_google_derived=lambda: False, **kwargs)
    p.initialize(b['sessionId'], hermes_home=str(tmp_path))
    return p


def test_wire_binding_provenance_and_cache(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    b, calls, records = binding(), [], []
    p = provider(tmp_path, b, read=lambda req, stop: calls.append(req) or response(req, stop), record=records.append)
    manager = compose_managed_memory(provider=p, enabled=True, session_id=b['sessionId'], hermes_home=str(tmp_path))['memory_manager']
    prompt, schemas = manager.build_system_prompt(), manager.get_all_tool_schemas()
    b['control']['revision'] = 9
    for query in ['launch', 'decision']:
        result = json.loads(manager.handle_tool_call('atum_recall', {'query': query, 'limit': 20}))
        assert result['status'] == 'ok'
        assert result['items'][0]['lineage']['kind'] == 'personal'
    assert calls[0]['binding']['control']['revision'] == 1
    assert calls[0]['requestId'] != calls[1]['requestId']
    assert calls[0]['limits'] == {'maxItems': 5, 'maxContentBytes': 1536}
    assert set(calls[0]) == {'binding', 'query', 'limits', 'requestId'}
    assert len(records) == 2 and 'content' not in records[0]['items'][0]
    assert prompt == manager.build_system_prompt() and schemas == manager.get_all_tool_schemas()


@pytest.mark.parametrize('field', ['principal', 'url', 'token', 'factId', 'path', 'binding', 'audience'])
def test_model_authority_refused(tmp_path, field):
    calls = []
    p = provider(tmp_path, read=lambda req, stop: calls.append(req))
    assert json.loads(p.handle_tool_call('atum_recall', {'query': 'launch', field: 'forged'}))['error'] == 'awareness_args_invalid'
    assert not calls


@pytest.mark.parametrize('mutation', ['run', 'owner', 'generation', 'google', 'native', 'bytes', 'malformed_source'])
def test_untrusted_response_is_unavailable(tmp_path, mutation):
    def read(req, stop):
        r = response(req, stop)
        if mutation == 'run': r['runId'] = str(uuid4())
        if mutation == 'owner': r['items'][0]['lineage']['ownerPrincipal'] = str(uuid4())
        if mutation == 'generation': r['items'][0]['lineage']['sourcePolicyGeneration'] = 2
        if mutation == 'google': r['items'][0]['provenance'] = {'google': True}
        if mutation == 'native': r['items'][0]['source'] = {'kind': 'native_memory', 'id': 'entry'}
        if mutation == 'bytes': r['contentBytes'] += 1
        if mutation == 'malformed_source': r['items'][0]['source'] = []
        return r
    assert provider(tmp_path, read=read).recall({'query': 'launch'})['status'] == 'unavailable'


def test_inflight_cancellation_does_not_wait_for_destination(tmp_path):
    entered, release, cancelled = threading.Event(), threading.Event(), []
    def read(req, stop):
        cancelled.append(stop)
        entered.set()
        release.wait(2)
        return response(req, stop)
    p = provider(tmp_path, read=read)
    result = []
    t = threading.Thread(target=lambda: result.append(p.handle_tool_call('atum_recall', {'query': 'launch'})))
    t.start()
    assert entered.wait(1)
    start = time.monotonic()
    p.invalidate()
    t.join(0.3)
    try:
        assert not t.is_alive() and time.monotonic() - start < 0.3
        assert cancelled[0].is_set()
        assert json.loads(result[0])['error'] == 'awareness_fresh_session_required'
    finally:
        release.set()
        t.join()


def test_provenance_failure_closes_run(tmp_path):
    def fail(_): raise OSError('unavailable')
    p = provider(tmp_path, record=fail)
    with pytest.raises(AwarenessSessionError): p.recall({'query': 'launch'})
    with pytest.raises(AwarenessSessionError): p.assert_run_authority()


def test_compression_keeps_binding_and_rewind_retires(tmp_path):
    b, calls = binding(), []
    p = provider(tmp_path, b, read=lambda req, stop: calls.append(req) or response(req, stop))
    physical = str(uuid4())
    p.on_session_switch(physical, parent_session_id=b['sessionId'])
    p.assert_run_authority()
    assert json.loads(p.handle_tool_call('atum_recall', {'query': 'launch'}, session_id=physical))['status'] == 'ok'
    assert calls[0]['binding']['sessionId'] == b['sessionId']
    p.on_session_switch(physical, rewound=True)
    with pytest.raises(AwarenessSessionError): p.assert_run_authority()


def test_composition_off_and_unbound_child(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    assert compose_managed_memory(provider=provider(tmp_path)) == {'skip_memory': True}
    assert compose_managed_memory(child=True) == {'skip_memory': True}
    from agent.memory_manager import MemoryManager
    existing = MemoryManager()
    first = provider(tmp_path)
    existing.add_provider(first)
    assert compose_managed_memory(existing, provider=provider(tmp_path), enabled=True)['memory_manager'] is existing
    assert existing.providers == [first]


def test_sticky_native_lineage_retirement_and_search(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    path = tmp_path / 'state.db'
    db = SessionDB(db_path=path)
    lifecycle = MemoryRunLifecycle(db)
    b = binding()
    root = b['sessionId']
    db.create_session(root, 'cli')
    db.append_message(root, 'user', 'launchcanary private context')
    for sid, parent, source in [('compressed', root, 'cli'), ('branch', root, 'cli'), ('child', 'compressed', 'subagent')]:
        db.create_session(sid, source, parent_session_id=parent)
        db.append_message(sid, 'assistant', 'launchcanary derived context')
    db.create_session('sibling', 'cli')
    db.append_message('sibling', 'user', 'launchcanary unrelated')
    p = provider(tmp_path, b, record=lifecycle.record)
    p.recall({'query': 'launch'})
    assert len(db.list_meta_prefix('memory.provenance.v2.')) == 1
    receipt = lifecycle.retire(root)
    assert set(receipt['retiredSessions']) == {root, 'compressed', 'branch', 'child'}
    assert receipt['complete'] is False and receipt['physicalPurge'] == 'not_proven'
    for sid in receipt['retiredSessions']:
        with pytest.raises(AwarenessSessionError): db.get_messages_as_conversation(sid)
        with pytest.raises(AwarenessSessionError): db.assert_resume_safe(sid, max_messages=0)
        with pytest.raises(sqlite3.IntegrityError): db.append_message(sid, 'user', 'reseed')
    with pytest.raises(sqlite3.IntegrityError): db.create_session('new-child', 'subagent', parent_session_id=root)
    assert all(r['session_id'] == 'sibling' for r in db.search_messages('launchcanary'))
    assert all('derived' not in r.get('snippet', '') for r in db.search_messages('launchcanary', fields=['snippet']))
    db.close()
    # A late transcript reader must recover the closed writer and still enforce
    # retirement; close-race recovery cannot turn a retired transcript readable.
    with pytest.raises(AwarenessSessionError):
        db.get_messages('child')
    db.close()
    db = SessionDB(db_path=path)
    try:
        with pytest.raises(AwarenessSessionError): db.get_messages_as_conversation('child')
        with pytest.raises(sqlite3.IntegrityError): db.create_session(root, 'cli')
        assert db.get_messages_as_conversation('sibling')[0]['content'] == 'launchcanary unrelated'
    finally:
        db.close()


def test_native_cleanup_preserves_edited_and_mixed_entries(tmp_path, monkeypatch):
    import hashlib
    from agent.memory_run_lifecycle import cleanup_native_entries
    from tools.memory_tool_store import MemoryStore
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    store = MemoryStore()
    assert store.add('memory', 'Generated launch decision')['success']
    assert store.add('memory', 'Generated budget; user annotation')['success']
    def record(key, text):
        return dict(artifactId=key, target='memory', entry=text, generatedOnly=True,
                    digest=hashlib.sha256(text.encode()).hexdigest())
    receipts = cleanup_native_entries(store, [record('launch', 'Generated launch decision'),
                                               record('budget', 'Generated budget')])
    assert [r['activeStorage'] for r in receipts] == ['purged', 'pending']
    assert all(r['complete'] is False for r in receipts)
    store.load_from_disk()
    text = store.format_for_system_prompt('memory')
    assert 'user annotation' in text and 'launch decision' not in text


def test_factory_rejects_retired_replay_after_restart(tmp_path, monkeypatch):
    from agent.memory_run_lifecycle import bind_cloud_memory
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    db = SessionDB(db_path=tmp_path / 'state.db')
    try:
        lifecycle, b = MemoryRunLifecycle(db), binding()
        db.create_session(b['sessionId'], 'cli')
        kwargs = dict(binding=b, hermes_home=str(tmp_path), lifecycle=lifecycle, retrieve=response,
                      is_current=lambda: True, invalidate_run=lambda: None)
        assert bind_cloud_memory(**kwargs) == {'skip_memory': True}
        manager = bind_cloud_memory(**kwargs, enabled=True)['memory_manager']
        manager.assert_run_authority()
        lifecycle.retire(b['sessionId'])
        with pytest.raises(AwarenessSessionError): manager.assert_run_authority()
        with pytest.raises(AwarenessSessionError): bind_cloud_memory(**kwargs, enabled=True)
    finally:
        db.close()


def test_managed_google_requires_live_native_protected_route(tmp_path):
    def marked(req, stop):
        result = response(req, stop)
        result['items'][0]['provenance'] = {'google': True}
        return result
    for admission in [None, lambda: False, lambda: 1]:
        p = provider(tmp_path, read=marked, admit_managed_google=admission)
        assert p.recall({'query': 'launch'})['status'] == 'unavailable'
    live, records, retired = [True], [], []
    p = provider(tmp_path, read=marked, record=records.append,
                 admit_managed_google=lambda: live[0], invalid=lambda: retired.append(True))
    prompt = p.system_prompt_block()
    result = p.recall({'query': 'launch'})
    assert result['items'][0]['provenance'] == {'google': True}
    assert records and not p.local_only
    assert p.system_prompt_block() == prompt
    live[0] = False
    with pytest.raises(AwarenessSessionError): p.assert_run_authority()
    live[0] = True
    with pytest.raises(AwarenessSessionError): p.assert_run_authority()
    assert retired == [True]


def test_legacy_managed_cannot_opt_into_google(tmp_path):
    b = binding()
    with pytest.raises(AwarenessContractError):
        AtumAwarenessProvider(
            AwarenessRunBinding(b['sessionId'], str(tmp_path), b['agentPrincipal'],
                                {'class': 'private_owner'}, False, 'managed'),
            retrieve=response, is_current=lambda: True, mark_google_derived=lambda: True,
            invalidate_run=lambda: None, admit_managed_google=lambda: True)


def test_factory_preserves_google_requirement_after_restart_and_compression(tmp_path, monkeypatch):
    from agent.memory_run_lifecycle import bind_cloud_memory
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    path, b = tmp_path / 'sticky.db', binding()
    def marked(req, stop):
        result = response(req, stop)
        result['items'][0]['provenance'] = {'google': True}
        return result
    db = SessionDB(db_path=path)
    db.create_session(b['sessionId'], 'cli')
    lifecycle = MemoryRunLifecycle(db)
    kwargs = dict(binding=b, hermes_home=str(tmp_path), lifecycle=lifecycle, retrieve=marked,
                  is_current=lambda: True, invalidate_run=lambda: None, enabled=True,
                  admit_managed_google=lambda: True)
    manager = bind_cloud_memory(**kwargs)['memory_manager']
    assert json.loads(manager.handle_tool_call('atum_recall', {'query': 'launch'}))['status'] == 'ok'
    # A repeated ID with a missing marker cannot undo retained Google history.
    saved = db.list_meta_prefix('memory.provenance.v2.')[0][1]
    unmarked = json.loads(saved)
    unmarked['items'][0].pop('provenance')
    unmarked.pop('googleDerived')
    lifecycle.record(unmarked)
    assert lifecycle.google_derived(b['sessionId'])
    db.create_session('compressed-google', 'cli', parent_session_id=b['sessionId'])
    db.close()
    db = SessionDB(db_path=path)
    try:
        lifecycle = MemoryRunLifecycle(db)
        assert lifecycle.google_derived(b['sessionId'])
        assert lifecycle.google_derived('compressed-google')
        assert not lifecycle.google_derived('unrelated')
        with pytest.raises(AwarenessSessionError):
            bind_cloud_memory(**dict(kwargs, lifecycle=lifecycle, admit_managed_google=lambda: False))
    finally:
        db.close()
