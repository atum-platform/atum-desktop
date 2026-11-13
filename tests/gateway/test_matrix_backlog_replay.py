"""Offline backlog regressions at the real adapter/startup/admission seams."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.run_inbound import GatewayInboundMixin
from tests.gateway.test_matrix_durable_intake import adapter, batch, event


class PastStartupGate(Exception):
    pass


def intake_runner():
    runner = SimpleNamespace(_startup_restore_in_progress=True, _startup_restore_queue=[])
    runner._queue_startup_restore_event = runner._startup_restore_queue.append
    def passed_gate():
        raise PastStartupGate
    runner._scale_to_zero_note_real_inbound = passed_gate
    return runner


@pytest.mark.asyncio
@pytest.mark.parametrize('durable', [False, True])
async def test_startup_gate_leaves_journaled_input_with_transport(durable):
    from gateway.config import Platform
    from gateway.platforms.event import MessageEvent
    from gateway.session import SessionSource
    runner = intake_runner()
    e = MessageEvent(text='hello', message_id='$one', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room', user_id='@alice', chat_type='dm'))
    e._matrix_durable_intake = durable
    if durable:
        with pytest.raises(PastStartupGate):
            await GatewayInboundMixin._hm_admit_event(runner, e)
        assert runner._startup_restore_queue == []
    else:
        assert await GatewayInboundMixin._hm_admit_event(runner, e) is None
        assert runner._startup_restore_queue == [e]


@pytest.mark.asyncio
@pytest.mark.parametrize('backlog,text,approval', [(False, 'use the other file', False), (False, 'yes', True), (True, 'ack 05', False)])
async def test_journal_followup_preserves_live_controls(backlog, text, approval):
    from gateway.platforms.event import MessageEvent
    from gateway.config import Platform
    from gateway.session import SessionSource
    source = SessionSource(platform=Platform.MATRIX, chat_id='!room', user_id='@alice', chat_type='dm')
    e = MessageEvent(text=text, message_id='$followup', source=source)
    e._matrix_durable_intake = True
    e._matrix_backlog = backlog
    runner = SimpleNamespace(_is_session_running=lambda key: True,
        _route_plaintext_approval_while_busy=AsyncMock(return_value=approval),
        _hm_busy_preempt=AsyncMock(return_value=True),
        _hm_post_admission_consume=AsyncMock(return_value=(False, None)))
    authority = SimpleNamespace()
    with patch('gateway.session_authorities.active_authority', return_value=authority), patch(
            'gateway.session_ingress.admit_message', new_callable=AsyncMock, return_value='queued') as admit:
        result = await GatewayInboundMixin._hm_authority_admission(runner, e, source, 'route', False)
    if backlog:
        runner._hm_busy_preempt.assert_not_awaited()
        runner._route_plaintext_approval_while_busy.assert_not_awaited()
        admit.assert_awaited_once_with(authority, e)
        assert result == (True, 'queued')
    else:
        runner._route_plaintext_approval_while_busy.assert_awaited_once()
        assert runner._hm_busy_preempt.await_count == (0 if approval else 1)
        admit.assert_not_awaited()


@pytest.mark.asyncio
async def test_25_old_events_paginate_restart_and_dispatch_in_order(tmp_path):
    from plugins.platforms.matrix.adapter import MatrixAdapter
    from plugins.platforms.matrix.intake import MatrixIntakeStore
    a = adapter(tmp_path)
    a._startup_ts = 9999999999
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a._note_late_grace_drop = MagicMock()
    baseline = batch('$baseline', token='before-stop')
    a._intake.accept(baseline)
    a._intake.finish(baseline)
    a._intake.close()
    a._intake = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    ids = [f'$check5-{i:02}' for i in range(1, 26)]
    sync = batch(*ids[15:], limited=True)
    pages = [SimpleNamespace(events=[event(i) for i in reversed(ids[5:15])], end='page-1'),
             SimpleNamespace(events=[event(i) for i in reversed(['$baseline'] + ids[:5])], end='page-2')]
    client = SimpleNamespace(get_messages=AsyncMock(side_effect=pages))
    finals = []
    async def answer(room, sender, eid, *args):
        # Deterministic model/delivery double. The receipt and source must stay independent.
        a._intake.mark(eid, 'native', 'receipt-' + eid, room_id=room)
        finals.append((eid, {'m.in_reply_to': {'event_id': eid}}))
    a._handle_text_message = answer
    async def handle_sync(data):
        for room, joined in data.get('rooms', {}).get('join', {}).items():
            for raw in joined.get('timeline', {}).get('events', []):
                await a._on_room_message(SimpleNamespace(room_id=room, sender=raw['sender'],
                    event_id=raw['event_id'], timestamp=1, content=raw['content']))
        return []
    client.handle_sync = handle_sync
    a._client = client
    a._dispatch_sync = lambda data: MatrixAdapter._dispatch_sync(a, data)
    try:
        await a._absorb_sync(client, sync)
        # Restart after native acceptance, replaying the exact batch must owe no second turns.
        a._intake.close()
        a._intake = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
        await a._dispatch_sync(sync)
        assert [eid for eid, _ in finals] == ids
        assert all(rel['m.in_reply_to']['event_id'] == eid for eid, rel in finals)
        assert client.get_messages.await_count == 2
        a._note_late_grace_drop.assert_not_called()
    finally:
        a._intake.close()


def test_native_runtime_25_linked_finals_during_startup(tmp_path):
    import os
    from pathlib import Path
    import subprocess
    import sys
    repo = Path(__file__).resolve().parents[2]
    home, state = tmp_path / 'home', tmp_path / 'state'
    home.mkdir()
    state.mkdir()
    env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'LANG', 'TZ') if key in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(state),
               PYTHONPATH=str(repo), PYTHONUNBUFFERED='1')
    result = subprocess.run([sys.executable, str(Path(__file__).parent / 'fixtures' / 'matrix_backlog_peer.py')],
        cwd=repo, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180, check=False)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
