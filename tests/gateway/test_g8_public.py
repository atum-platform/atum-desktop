"""Offline public sleep admission, native cron publication and D1 regressions."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


def test_cron_publication_add_edit_remove(tmp_path):
    from cron.jobs import use_cron_store, create_job, update_job, remove_job
    with use_cron_store(tmp_path):
        job = create_job(prompt='fixture', schedule='2099-01-01T00:00:00Z')
        def read():
            return json.loads((tmp_path / 'cron/jobs.json').read_text())['sleep_wake']
        first = read()
        assert first['known'] and first['next_cron_due'] is not None
        update_job(job['id'], {'schedule': '2099-02-01T00:00:00Z'})
        assert read()['next_cron_due'] > first['next_cron_due']
        remove_job(job['id'])
        assert read() == {'known': True, 'next_cron_due': None}


def test_live_idle_sources_and_since(tmp_path, monkeypatch):
    from gateway.sleep_wake import collect_sleep_readiness
    from gateway.session_authorities import SessionAuthorities
    runner = SimpleNamespace(
        _running_agent_count=lambda: 0, _running_cron_job_count=lambda: 0,
        _api_server_hook=lambda _: 0, _active_work_count=lambda: 0,
        _scale_to_zero_has_live_background_work=lambda: False,
        _last_inbound_at=1, adapters={}, session_authorities=SessionAuthorities(tmp_path))
    # A missing authority is unknown, including during wake bootstrap.
    assert not collect_sleep_readiness(runner, open_operations=0, now=1000)['idle']
    db = SimpleNamespace(_conn=None)
    authority = SimpleNamespace(db=db, profile_id=str(tmp_path), pending_deliveries={}, pending_results={})
    import sqlite3
    db._conn = sqlite3.connect(':memory:')
    db._conn.execute('CREATE TABLE session_admissions(status TEXT)')
    runner.session_authorities.add(tmp_path, authority)
    monkeypatch.setattr('gateway.sleep_wake.next_native_schedule', lambda _: None)
    a = collect_sleep_readiness(runner, open_operations=0, now=1000)
    assert a['idle'] and a['idle_since'] == 1000
    assert collect_sleep_readiness(runner, open_operations=0, now=1100)['idle_since'] == 1000
    for field, value in [('_running_cron_job_count', lambda: 1),
                         ('_api_server_hook', lambda _: 1),
                         ('_scale_to_zero_has_live_background_work', lambda: True)]:
        old = getattr(runner, field)
        setattr(runner, field, value)
        assert not collect_sleep_readiness(runner, open_operations=0, now=1101)['idle']
        setattr(runner, field, old)
    assert not collect_sleep_readiness(runner, now=1102)['idle']
    assert not collect_sleep_readiness(runner, open_operations=1, now=1102)['idle']
    db._conn.execute("INSERT INTO session_admissions VALUES ('queued')")
    assert not collect_sleep_readiness(runner, open_operations=0, now=1102)['idle']
    db._conn.execute('DELETE FROM session_admissions')
    authority.pending_deliveries['owed'] = True
    assert not collect_sleep_readiness(runner, open_operations=0, now=1102)['idle']
    authority.pending_deliveries.clear()
    monkeypatch.setattr('gateway.sleep_wake.next_native_schedule', lambda _: 1222)
    assert not collect_sleep_readiness(runner, open_operations=0, now=1102)['idle']
    db._conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('phase', ['pending', 'waking'])
async def test_stop_before_turn_survives_restart(tmp_path, phase):
    from plugins.platforms.matrix import presentation as p
    from gateway.platforms.event import MessageEvent
    from gateway.session import SessionSource
    from gateway.config import Platform
    class Base:
        pass
    Adapter = p.adapter_class(Base)
    adapter = Adapter()
    adapter._presentation_turns = {}
    adapter._presentation_box = p.Outbox(tmp_path / 'presentation.sqlite3')
    adapter._presentation_ready = asyncio.Event()
    if phase == 'pending':
        adapter._presentation_ready.set()
    assert not await adapter.stop_presentation_turn('!room', '$a', '@owner', authenticated=False)
    assert await adapter.stop_presentation_turn('!room', '$a', '@owner', authenticated=True)
    adapter._presentation_box.db.close()
    adapter._presentation_box = p.Outbox(tmp_path / 'presentation.sqlite3')
    adapter._presentation_ready.set()
    event = MessageEvent(text='hello', message_id='$a', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room', user_id='@owner', chat_type='dm'))
    execute = AsyncMock()
    await adapter.run_admission_presentation(event, 'session', 'admission', execute)
    execute.assert_not_awaited()
    assert not adapter._presentation_box.cancelled('!room', '$b', '@owner')
    assert not adapter._presentation_box.cancelled('!room', '$a', '@other')
    adapter._presentation_box.db.close()
