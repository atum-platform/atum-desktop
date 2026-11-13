"""Producers that pin epoch 0 for a stable retry fingerprint still record local time (not 1970)."""
from datetime import UTC, datetime

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import SendResult
from gateway.platforms.event import MessageEvent
from gateway.run import GatewayRunner
from gateway.session_authority import initialize_session_authority
from gateway.session_ingress import admit_message
from gateway.session_results import execution_result

CHAT = '12025550113@s.whatsapp.net'


@pytest.mark.asyncio
async def test_epoch_zero_producer_timestamp_runs_with_local_time_and_keeps_retry_identity(tmp_path, monkeypatch):
    from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
    monkeypatch.setenv('WHATSAPP_ALLOWED_USERS', '12025550113')
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / 'sessions'))
    adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra={'session_path': str(tmp_path / 'wa')}))
    adapter.gateway_runner, runner.adapters = runner, {Platform.WHATSAPP: adapter}
    authority = await initialize_session_authority(runner, profile_id='default', instance_id='stamp')
    runner._wire_adapter_handlers(adapter)
    stamps = []

    async def send(chat_id, content, **_):
        return SendResult(success=True, message_id='s')

    async def turn(event, *_args, **_kwargs):
        stamps.append(event.timestamp)
        execution_result.get()['result'] = {'final_response': 'ok', 'messages': []}
        return 'ok'

    monkeypatch.setattr(adapter, 'send', send)
    monkeypatch.setattr(runner, '_handle_message_with_agent', turn)
    source = adapter.build_source(chat_id=CHAT, user_id=CHAT, chat_type='dm')
    pinned = lambda: MessageEvent(text='hi', source=source, message_id='p1',
                                  timestamp=datetime.fromtimestamp(0, UTC))
    try:
        before = datetime.now()
        assert await admit_message(authority, pinned()) == 'ok'
        assert len(stamps) == 1 and stamps[0].timestamp() >= before.timestamp(), stamps  # was 1970-01-01 (persisted as 0)
        # The redelivered provider id is still the same admission: no second turn.
        first = await authority.admit_native(pinned())
        assert first.status == 'terminal' and len(stamps) == 1
    finally:
        authority.db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('stamp,resolved', [(datetime.fromtimestamp(0, UTC), False), (None, True)])
async def test_unknown_provider_time_never_answers_a_pending_crash_resume_question(
        tmp_path, monkeypatch, stamp, resolved):
    """Real ingress -> run_turn -> TurnRunner -> pending_resume_policy: unknown time is not consent."""
    from types import SimpleNamespace
    from gateway.resume_policy import ResumePolicy, pending_resume_policy
    from gateway.run_turn_runner import TurnRunner
    from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('WHATSAPP_ALLOWED_USERS', '12025550113')
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / 'sessions'))
    adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra={'session_path': str(tmp_path / 'wa')}))
    adapter.gateway_runner, runner.adapters = runner, {Platform.WHATSAPP: adapter}
    authority = await initialize_session_authority(runner, profile_id='default', instance_id='consent')
    runner._wire_adapter_handlers(adapter)
    source = adapter.build_source(chat_id=CHAT, user_id=CHAT, chat_type='dm')
    entry = runner.session_store.get_or_create_session(source)
    pending_resume_policy(runner.session_store, entry, ResumePolicy(True, ('write',), frozenset()), '', can_resolve=False)
    assert entry.resume_ask and entry.resume_ask['admission_seq'] is not None
    entry.resume_ask.pop('admission_seq')  # the worst case: ordering falls back to created_at < now
    captured = []

    async def send(chat_id, content, **_):
        return SendResult(success=True, message_id='s')

    async def run_agent(**kwargs):
        metadata = kwargs['persist_user_display_metadata']
        turn = object.__new__(TurnRunner)
        turn._runner = runner
        turn._ctx = SimpleNamespace(
            source=source, session_key=kwargs['session_key'], session_id=kwargs['session_id'], history=[],
            message=metadata['crash_resume_decision_text'], persist_user_message=None, persist_user_timestamp=None,
            inbound_message_id=kwargs['inbound_message_id'], persist_user_display_metadata=metadata)
        turn._prepare_turn_message([])
        captured.append(metadata)
        execution_result.get()['result'] = {'final_response': 'ok', 'messages': []}
        return {'final_response': 'ok', 'messages': []}

    monkeypatch.setattr(adapter, 'send', send)
    monkeypatch.setattr(runner, '_run_agent', run_agent)
    event = MessageEvent(text='yes', source=source, message_id='consent-1',
                         timestamp=stamp if stamp is not None else datetime.now(UTC))
    try:
        assert await admit_message(authority, event) == 'ok'
        assert len(captured) == 1
        assert (runner.session_store._entries[entry.session_key].resume_ask is None) is resolved
    finally:
        authority.db.close()
