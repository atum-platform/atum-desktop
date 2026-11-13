"""Admission sees native source identity rather than prompts or reply anchors."""
from types import SimpleNamespace

import pytest

from tests.agent.test_admission_execution_binding import policy


@pytest.mark.asyncio
async def test_matrix_media_identity_comes_from_native_event(policy):
    from gateway.config import Platform
    from gateway.platforms.event import MessageEvent
    from gateway.session import SessionSource
    from gateway.run_turn import GatewayTurnMixin
    from gateway.run_inbound import GatewayInboundMixin
    seen = []
    policy[1].register_hook('pre_turn_admission', lambda **kw: seen.append(kw) or False, fail_closed=True)
    origin = SessionSource(platform=Platform.MATRIX, chat_id='!room:example.org', user_id='@owner:example.org')
    event = MessageEvent(text='untrusted prompt', source=origin, message_id='$raw', reply_to_message_id='$reply-anchor')
    async def admitted(*args):
        return await GatewayInboundMixin._prepare_inbound_message_text(SimpleNamespace(),
            event=event, source=origin, history=[], session_key='route')
    runner = SimpleNamespace(_handle_message_with_agent_admitted=admitted)
    assert await GatewayTurnMixin._handle_message_with_agent(runner, event, origin, 'route', 1) is None
    assert seen[0]['source'] == {'kind': 'owner_turn', 'room': origin.chat_id, 'event': '$raw'}
    assert seen[0]['source_sender'] == origin.user_id


def test_cron_prepare_reads_selected_native_occurrence_not_job_fields(policy):
    from cron.execution_identity import enter_cron_execution, exit_cron_execution
    from cron.scheduler import _prepare_job_prompt
    seen = []
    policy[1].register_hook('pre_turn_admission', lambda **kw: seen.append(kw) or False, fail_closed=True)
    job = {'id': 'selected', 'prompt': 'read my chats', 'next_run_at': '2099-01-01T00:00:00Z',
           'source': {'kind': 'owner_turn', 'room': '!fake', 'event': '$fake'}}
    token = enter_cron_execution(job, 'selected-execution', {
        'source': 'builtin', 'scheduled_instant': '2026-11-13T01:02:03+00:00'})
    try:
        early, _ = _prepare_job_prompt(job, job['id'], 'name', None, None)
    finally:
        exit_cron_execution(token)
    assert early is not None
    assert seen[0]['source'] == {'kind': 'schedule', 'job': 'selected', 'scheduledAt': 1794531723000}
    assert seen[0]['cron_execution_id'] == 'selected-execution'
