"""Real profile, SessionDB and skill-tool paths for public cloud training."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import threading
import time
import uuid

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from hermes_cli import atum_store_proof as proof
from hermes_cli.atum_training import bind_task, training_context
from hermes_cli.profiles import assign_profile_identity
from tui_gateway.surface_context import capabilities, context_db
from tools.skills_tool import skills_list, skill_view


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    session = {'session_key': 'training-chat', 'profile_home': str(tmp_path),
               'history': [], 'history_lock': threading.Lock(), 'running': False,
               'model_override': {'provider': 'atum-managed', 'model': 'binh-minh'}}
    owner = capabilities(tmp_path, session)
    task = {'task_id': str(uuid.uuid4()), 'assistant_id': str(uuid.uuid4()),
            'assistant_identity_id': owner['agent_id'],
            'conversation_id': owner['conversation_id'], 'skill_id': 'cloud/briefing'}
    key = Ed25519PrivateKey.generate()
    monkeypatch.setattr(proof, 'PINNED_PUBLIC_KEYS', {'training-test': base64.urlsafe_b64encode(
        key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode().rstrip('=')})
    envelope = {'v': 3, 'account_id': 'training-test', 'issued_at': int(time.time()),
                'expires_at': int(time.time()) + 3600, 'key_id': 'training-test',
                'entitlements': [{'kind': 'skill', 'id': task['skill_id'], 'state': 'active',
                                  'assistant_id': task['assistant_id'],
                                  'assistant_identity_id': task['assistant_identity_id']}],
                'catalog_owned': [{'kind': 'skill', 'id': task['skill_id'],
                                   'identifier': task['skill_id'], 'delivery': 'cloud', 'hashes': []}]}
    payload = json.dumps(envelope, sort_keys=True, separators=(',', ':')).encode()
    envelope['signature'] = base64.urlsafe_b64encode(key.sign(payload)).decode().rstrip('=')
    store = tmp_path / 'atum-store'
    store.mkdir()
    (store / 'entitlement-proof.json').write_text(json.dumps(envelope))
    proof._reset_caches()
    yield tmp_path, session, owner, task
    proof._reset_caches()


def test_selected_training_uses_ordinary_discovery_without_local_private_files(setup):
    home, _, owner, task = setup
    bind_task(home, owner, task)
    listing = json.loads(skills_list(task_id=task['conversation_id']))
    assert any(s['name'] == task['skill_id'] and s['delivery'] == 'cloud' for s in listing['skills'])
    result = json.loads(skill_view(task['skill_id'], task_id=task['conversation_id']))
    assert result['success'] and result['state'] == 'selected'
    assert 'skill_dir' not in result and 'files' not in result
    assert not (home / 'skills' / task['skill_id']).exists()
    assert not list(home.rglob('SKILL.md'))
    denied = json.loads(skill_view(task['skill_id'], 'references/private.md', task_id=task['conversation_id']))
    assert not denied['success'] and 'download' in denied['error']
    with pytest.raises(proof.StoreEntitlementError, match='cloud_training_required'):
        proof.enforce_catalog_item('skill', task['skill_id'])


def test_unselected_training_is_actionable_and_never_claims_loaded(setup):
    _, _, _, task = setup
    result = json.loads(skill_view(task['skill_id'], task_id=task['conversation_id']))
    assert not result['success'] and result['state'] == 'not_selected'
    assert 'new task' in result['error'] and 'content' not in result
    listing = json.loads(skills_list(task_id=task['conversation_id']))
    assert any(s['name'] == task['skill_id'] for s in listing['skills'])


def test_clone_cannot_use_parent_grant_and_restore_keeps_identity(setup):
    home, _, _, task = setup
    original = assign_profile_identity(home)
    assert proof.entitlement_state(None, 'skill', task['skill_id']) == 'active'
    assert assign_profile_identity(home) == original  # rename/restore existing metadata
    assert assign_profile_identity(home, regenerate=True) != original  # actual clone seam
    assert proof.entitlement_state(None, 'skill', task['skill_id']) is None
    result = json.loads(skill_view(task['skill_id'], task_id='new-chat'))
    assert result['state'] == 'training_required' and not result['success']


def test_task_pin_survives_compression_restart_and_rejects_cross_agent(setup):
    home, _, owner, task = setup
    bind_task(home, owner, task)
    with context_db(home) as db:
        db.create_session('training-chat', source='desktop')
        db.end_session('training-chat', 'compression')
        db.create_session('compressed-chat', source='desktop', parent_session_id='training-chat')
    context = training_context('compressed-chat', home)
    assert context['x-atum-conversation-id'] == 'training-chat'
    assert context['x-atum-training-task-id'] == task['task_id']
    assert bind_task(home, owner, task) == task
    with pytest.raises(ValueError, match='another agent'):
        bind_task(home, {**owner, 'agent_id': str(uuid.uuid4())}, task)
    assign_profile_identity(home, regenerate=True)
    with pytest.raises(ValueError, match='ownership mismatch'):
        training_context('compressed-chat', home)


def test_conflicting_pins_cannot_replace_each_other_in_a_race(setup):
    home, _, owner, task = setup
    candidates = [{**task, 'task_id': str(uuid.uuid4())} for _ in range(6)]
    def bind(candidate):
        try:
            return bind_task(home, owner, candidate)
        except ValueError:
            return None
    with ThreadPoolExecutor(max_workers=6) as pool:
        winners = [result for result in pool.map(bind, candidates) if result]
    assert len(winners) == 1
    assert training_context(task['conversation_id'], home)['x-atum-training-task-id'] == winners[0]['task_id']


def test_gateway_binds_only_before_first_prompt_using_real_session_lock(setup, monkeypatch):
    from tui_gateway import server
    home, session, _, task = setup
    monkeypatch.setattr(server, '_hermes_home', home)
    monkeypatch.setitem(server._sessions, 'runtime', session)
    binding = server._methods['training.bind']
    params = {'session_id': 'runtime', 'task': task}
    session['model_override']['provider'] = 'external'
    assert 'error' in binding(0, params)
    session['model_override']['provider'] = 'atum-managed'
    session['running'] = True
    assert 'error' in binding(1, params)
    session['running'] = False
    session['history'] = [{'role': 'user', 'content': 'existing conversation'}]
    assert 'error' in binding(2, params)
    session['history'] = []
    assert binding(3, params)['result'] == task



@pytest.mark.parametrize("skill_id", [None, "private-skill"])
def test_gateway_binding_status_uses_actual_session_identity_and_restored_pin(setup, monkeypatch, skill_id):
    from tui_gateway import server
    home, session, owner, task = setup
    task = {**task, "skill_id": skill_id}
    monkeypatch.setattr(server, '_hermes_home', home)
    monkeypatch.setitem(server._sessions, 'runtime', session)
    status = server._methods['training.status']
    result = status(0, {'session_id': 'runtime'})['result']
    assert result == {**{key: owner[key] for key in ('agent_id', 'conversation_id')},
                      'task': None, 'managed': True, 'can_bind': True}
    bind_task(home, owner, task)
    session['history'] = [{'role': 'user', 'content': 'existing conversation'}]
    result = status(1, {'session_id': 'runtime'})['result']
    assert result['task'] == task
    assert result['can_bind'] is False
    assert 'instructions' not in result
    session['model_override']['provider'] = 'external'
    assert status(2, {'session_id': 'runtime'})['result']['managed'] is False


def test_public_descriptor_roundtrips_real_history_export_import(setup):
    from types import SimpleNamespace
    from hermes_cli.atum_training import stamp_training_result
    home, _, owner, task = setup
    bind_task(home, owner, task)
    with context_db(home) as db:
        db.create_session(task['conversation_id'], source='desktop')
        db.append_message(task['conversation_id'], 'user', 'Read my brief')
        result = {'messages': [{'role': 'user', 'content': 'Read my brief',
                              'display_kind': 'surface_context', 'display_metadata': {'prompt_text': 'Read my brief'}}]}
        stamp_training_result(SimpleNamespace(_session_db=db, session_id=task['conversation_id']),
                              task['conversation_id'], 'Read my brief', result)
        exported = db.export_session(task['conversation_id'])
    new_home = home / 'restored'
    new_home.mkdir()
    (new_home / 'profile.yaml').write_bytes((home / 'profile.yaml').read_bytes())
    with context_db(new_home) as db:
        assert db.import_sessions([exported])['ok']
    recovered = training_context(task['conversation_id'], new_home)
    assert recovered['x-atum-training-task-id'] == task['task_id']
    assert result['messages'][0]['content'] == 'Read my brief'
    assert result['messages'][0]['display_kind'] == 'surface_context'
    assert result['messages'][0]['display_metadata']['prompt_text'] == 'Read my brief'
    assert not list(new_home.rglob('SKILL.md'))


@pytest.mark.parametrize("ordinary_hire", [False, True])
def test_hidden_training_budget_uses_real_compressor_and_is_not_subtracted_twice(setup, ordinary_hire):
    from types import SimpleNamespace
    from agent.context_compressor import ContextCompressor
    from hermes_cli.atum_training import apply_training_context_budget, TRAINING_CONTEXT_RESERVE
    home, _, owner, task = setup
    if ordinary_hire:
        task = {**task, 'skill_id': None}
    compressor = ContextCompressor(model='binh-minh', config_context_length=75_000, max_tokens=8192)
    agent = SimpleNamespace(context_compressor=compressor)
    apply_training_context_budget(agent, task['conversation_id'])
    assert compressor.context_length == 75_000  # ordinary work is unchanged
    bind_task(home, owner, task)
    for _ in range(2):
        apply_training_context_budget(agent, task['conversation_id'])
        assert compressor.context_length == 75_000 - TRAINING_CONTEXT_RESERVE
        assert compressor.threshold_tokens + TRAINING_CONTEXT_RESERVE + 8192 < 75_000
        compressor.last_real_prompt_tokens = 12_345
        compressor.last_prompt_tokens = 12_345
        compressor.last_rough_tokens_when_real_prompt_fit = 23_456
        compressor.awaiting_real_usage_after_compression = True
    assert compressor.last_real_prompt_tokens == 12_345
    apply_training_context_budget(agent, task['conversation_id'])
    assert compressor.last_prompt_tokens == 12_345
    assert compressor.last_real_prompt_tokens == 12_345
    assert compressor.last_rough_tokens_when_real_prompt_fit == 23_456
    assert compressor.awaiting_real_usage_after_compression is True
    compressor.update_model('nguyet-thuc', 128_000)
    apply_training_context_budget(agent, task['conversation_id'])
    assert compressor.context_length == 128_000 - TRAINING_CONTEXT_RESERVE
    apply_training_context_budget(agent, 'ordinary-chat')
    assert compressor.context_length == 128_000
