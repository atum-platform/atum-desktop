"""Exercise outage backlog classification through sync AND adapter intake."""
import asyncio
from datetime import datetime, UTC
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from tests.gateway.test_matrix_durable_intake import adapter, batch


@pytest.mark.asyncio
@pytest.mark.parametrize('initial', [False, True])
async def test_adapter_sync_poll_marks_queued_input_but_not_live_typing(tmp_path, monkeypatch, initial):
    from gateway.platforms.event import MessageEvent
    from gateway.platforms.base import BasePlatformAdapter
    from plugins.platforms.matrix.adapter import MatrixAdapter

    a = adapter(tmp_path)
    a._startup_ts = 100  # process remains up for the outage
    clock = SimpleNamespace(now=1000)
    monkeypatch.setattr('plugins.platforms.matrix.adapter.time.time', lambda: clock.now)
    baseline = batch('$baseline', token='before-outage')
    a._intake.accept(baseline)
    a._intake.finish(baseline)
    a.gateway_runner = SimpleNamespace(session_authority=SimpleNamespace(native_transport_receipt=AsyncMock(return_value=None)))
    received = []
    async def accept(_adapter, e):
        received.append((e.message_id, e._matrix_backlog))
        e._on_transport_commit(SimpleNamespace(admission_id='receipt-' + e.message_id))
    monkeypatch.setattr(BasePlatformAdapter, 'handle_message', accept)
    monkeypatch.setattr(a, '_is_authorized_user', lambda *args: True)
    sync = batch('$queued-1', '$queued-2', '$queued-3', '$skew', '$live')
    for raw, ts in zip(sync['rooms']['join']['!room:example.org']['timeline']['events'], [900, 910, 920, 1098, 1101]):
        raw['origin_server_ts'] = ts * 1000
    attempts = []
    async def poll(**kwargs):
        attempts.append(kwargs)
        if not initial and len(attempts) <= 2:
            clock.now += 50
            raise ConnectionError('homeserver unavailable')
        # Server returns late: classifying against response time would mislabel live typing.
        if initial:
            clock.now = 1000  # initial poll started at 1000
            for raw in sync['rooms']['join']['!room:example.org']['timeline']['events'][3:]:
                raw['origin_server_ts'] -= 100000
        clock.now += 120
        a._closing = True
        return sync
    async def handle_sync(data):
        for room, joined in data.get('rooms', {}).get('join', {}).items():
            for raw in joined.get('timeline', {}).get('events', []):
                await a.handle_message(MessageEvent(text=raw['content']['body'], message_id=raw['event_id'],
                    source=a.build_source(chat_id=room, user_id=raw['sender'], chat_type='dm'),
                    timestamp=datetime.fromtimestamp(raw['origin_server_ts'] / 1000, UTC)))
        return []
    client = SimpleNamespace(sync=poll, sync_store=a._intake, handle_sync=handle_sync)
    a._client = client
    a._dispatch_sync = lambda data: MatrixAdapter._dispatch_sync(a, data)
    a._intake_failure = AsyncMock(return_value=0)
    try:
        if initial:
            await a._intake_initial_sync(client)
        else:
            await a._sync_loop()
        assert len(attempts) == (1 if initial else 3)
        assert received == [(f'$queued-{i}', True) for i in range(1, 4)] + [('$skew', False), ('$live', False)]
        assert a._intake.get('pending') is None
    finally:
        a._intake.close()


def test_native_25_source_outage_replay_has_ordered_finals_without_interrupts(tmp_path):
    import json
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
    result = subprocess.run([sys.executable, str(Path(__file__).parent / 'fixtures' / 'matrix_backlog_peer.py'),
        '--sync-outage'], cwd=repo, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=180, check=False)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    report = next(json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"finals":'))
    assert report['model_calls'] == 25
    assert len(report['finals']) == 25
    assert report['mode'] == 'sync-outage'
