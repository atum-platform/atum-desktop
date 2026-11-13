"""Native deterministic process boundaries; no reference worker or paid service."""
import os
from pathlib import Path
import subprocess
import sys
import pytest

ROOT = Path(__file__).resolve().parents[2]


def environment(home, point):
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'TZ') if k in os.environ}
    return dict(env, HOME=str(home), HERMES_HOME=str(home), PYTHONPATH=str(ROOT),
                ATUM_FAULT_TEST='1', ATUM_FAULT_POINT=point,
                ATUM_FAULT_ONCE=str(home / 'fired'), ATUM_NATIVE_FAULTS='1')


@pytest.mark.parametrize('point', ['H1', 'H2'])
def test_native_intake_process_crash(tmp_path, point):
    env = environment(tmp_path, point)
    code = '''
import asyncio, os
from pathlib import Path
from plugins.platforms.matrix.intake import MatrixIntakeStore
s = MatrixIntakeStore(Path(os.environ['HERMES_HOME']) / 'intake.db')
s.accept({'next_batch': 'new', 'rooms': {}})
s.close()
'''
    first = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True)
    assert first.returncode == 86, first.stderr
    from plugins.platforms.matrix.intake import MatrixIntakeStore
    s = MatrixIntakeStore(tmp_path / 'intake.db')
    assert s.get('next_batch') == ('new' if point == 'H2' else None)
    assert (s.get('pending') is not None) == (point == 'H2')
    s.close()


@pytest.mark.parametrize('point,hook,effects', [('H4','before_safe',0), ('H5','before_effect',0), ('H6','after_effect',1)])
def test_real_gateway_hook_restart(tmp_path, point, hook, effects):
    env = environment(tmp_path, point)
    peer = ROOT / 'tests/gateway/fixtures/tool_resume_peer.py'
    first = subprocess.run([sys.executable, str(peer), 'crash', hook], env=env,
                           capture_output=True, text=True, timeout=80)
    assert first.returncode == 86, first.stdout + first.stderr
    assert (tmp_path / 'fired').exists()
    second = subprocess.run([sys.executable, str(peer), 'resume', hook], env=env,
                            capture_output=True, text=True, timeout=80)
    assert second.returncode == 0, second.stdout + second.stderr
    counter = tmp_path / 'pending-count'
    if point != 'H4':
        assert (len(counter.read_text().splitlines()) if counter.exists() else 0) == effects
        import json
        verdict = json.loads((tmp_path / 'verdict.json').read_text())
        assert any('tiếp tục' in msg for msg in verdict['sent'])


@pytest.mark.parametrize('point', ['H8', 'H12'])
def test_native_obligation_crash_or_write_failure(tmp_path, point):
    env = environment(tmp_path, point)
    code = '''
from gateway.delivery_ledger import record_obligation
record_obligation(obligation_id='test', session_key='s', platform='matrix',
                  chat_id='room', thread_id=None, content='reply', source_event_id='$source')
'''
    first = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True)
    assert first.returncode == (86 if point == 'H8' else 1), first.stderr
    assert (tmp_path / 'fired').exists()
    second = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True)
    assert second.returncode == 0, second.stderr

@pytest.mark.parametrize('point,count', [('H9',1), ('H10',5)])
def test_real_matrix_frozen_send_plan_across_process_loss(tmp_path, point, count):
    env = environment(tmp_path, point)
    env['CHUNKS'] = str(count)
    code = r'''
import asyncio, json, os, sqlite3
from pathlib import Path
from gateway.config import PlatformConfig
from gateway.delivery_ledger import record_obligation, mark_delivered
from plugins.platforms.matrix.adapter import MatrixAdapter
home = Path(os.environ['HERMES_HOME'])
# Transport double only: independent durable Matrix transaction table, like a homeserver.
wire = sqlite3.connect(home / 'transport.db')
wire.execute('CREATE TABLE IF NOT EXISTS sends (txn TEXT PRIMARY KEY, body TEXT)')
class Transport:
    async def send_message_event(self, room, kind, content, txn_id):
        value = json.dumps(content, sort_keys=True)
        row = wire.execute('SELECT body FROM sends WHERE txn=?', (txn_id,)).fetchone()
        assert row is None or row[0] == value
        wire.execute('INSERT OR IGNORE INTO sends VALUES (?,?)', (txn_id, value)); wire.commit()
        return '$' + txn_id
async def main():
    a = MatrixAdapter(PlatformConfig(enabled=True, token='fixture', extra={
        'homeserver':'http://127.0.0.1', 'user_id':'@bot:local', 'sender_id':'stable-agent'}))
    a._client = Transport()
    a.truncate_message = lambda *args, **kw: ['chunk-' + str(i) for i in range(int(os.environ['CHUNKS']))]
    if not (home / 'fired').exists():
        record_obligation(obligation_id='reply',session_key='s',platform='matrix',chat_id='!room:local',
                          thread_id=None,content='answer',source_event_id='$source')
    result = await a.send('!room:local', 'answer', metadata={'delivery_obligation_id':'reply'})
    assert result.success, result
    mark_delivered('reply')
asyncio.run(main())
'''
    for expected in (86, 0):
        result = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True)
        assert result.returncode == expected, result.stdout + result.stderr
    import sqlite3
    with sqlite3.connect(tmp_path / 'transport.db') as db:
        rows = db.execute('SELECT body FROM sends ORDER BY rowid').fetchall()
    assert len(rows) == count
    import json
    assert [json.loads(row[0])['body'] for row in rows] == ['chunk-' + str(i) for i in range(count)]


def test_hooks_double_gated_and_one_shot(tmp_path, monkeypatch):
    from gateway.fault_injection import hit
    monkeypatch.delenv('ATUM_FAULT_TEST', raising=False)
    monkeypatch.setenv('ATUM_FAULT_POINT', 'H12')
    marker = tmp_path / 'fired'
    monkeypatch.setenv('ATUM_FAULT_ONCE', str(marker))
    hit('H12')
    assert not marker.exists()
    monkeypatch.setenv('ATUM_FAULT_TEST', '1')
    with pytest.raises(OSError):
        hit('H12')
    hit('H12')

@pytest.mark.asyncio
async def test_native_admission_and_gap_hook_locations(tmp_path, monkeypatch):
    from gateway import fault_injection
    from tests.gateway import test_matrix_durable_intake as native
    points = []
    monkeypatch.setattr(fault_injection, 'hit', points.append)
    await native.test_durable_handoff_is_not_process_local_base_acceptance(tmp_path)
    assert 'H3' in points
    await native.test_missing_frontier_fails_closed()
    assert 'H14' in points


@pytest.mark.asyncio
async def test_expired_cursor_injection_enters_native_frontier_recovery(tmp_path, monkeypatch):
    from tests.gateway import test_matrix_durable_intake as native
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    a = native.adapter(tmp_path)
    b = native.batch('$frontier')
    a._intake.accept(b)
    a._intake.finish(b)
    for key, value in environment(tmp_path, 'H13').items():
        if key.startswith('ATUM_'):
            monkeypatch.setenv(key, value)
    client = SimpleNamespace(sync=AsyncMock(return_value=native.batch('$new', token='recovered')))
    with patch('plugins.platforms.matrix.intake.fill_gaps', new_callable=AsyncMock) as gaps:
        await a._connect_initial_sync(client)
    assert (tmp_path / 'fired').exists()
    assert gaps.await_args_list[0].kwargs == {'reset': True}
    assert gaps.await_args_list[0].args[2] == {'!room:example.org': '$frontier'}
    assert await a._intake.get_next_batch() == 'recovered'


@pytest.mark.asyncio
async def test_stream_hook_only_after_visible_nonfinal_update(monkeypatch):
    from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig, _Tick
    from gateway import fault_injection
    from unittest.mock import AsyncMock, MagicMock
    points = []
    monkeypatch.setattr(fault_injection, 'hit', points.append)
    adapter = MagicMock()
    adapter.max_message_length = 4000
    adapter.message_len_fn = len
    consumer = GatewayStreamConsumer(adapter, 'room', config=StreamConsumerConfig())
    consumer._accumulated = 'a visible partial answer'
    consumer._send_or_edit = AsyncMock(return_value=True)
    await consumer._push_update(_Tick())
    assert points == ['H11']
    points.clear()
    await consumer._push_update(_Tick(got_done=True))
    assert points == []


@pytest.mark.parametrize('hook', ['before_safe', 'before_effect'])
def test_native_tool_call_write_failure_prevents_every_tool(tmp_path, hook):
    env = environment(tmp_path, 'H7')
    peer = ROOT / 'tests/gateway/fixtures/tool_resume_peer.py'
    result = subprocess.run([sys.executable, str(peer), 'crash', hook], env=env,
                            capture_output=True, text=True, timeout=80)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / 'fired').exists()
    assert not (tmp_path / 'done-count').exists()
    assert not (tmp_path / 'pending-count').exists()
    assert 'injected persistence failure: H7' in (tmp_path / 'logs/errors.log').read_text()

    second = subprocess.run([sys.executable, str(peer), 'resume', hook], env=env,
                            capture_output=True, text=True, timeout=80)
    assert second.returncode == 0, second.stdout + second.stderr
    import json
    verdict = json.loads((tmp_path / 'verdict.json').read_text())
    assert verdict['sent'], verdict
    failure = json.loads((tmp_path / 'failure-verdict.json').read_text())
    assert failure['sent'], failure  # the original storage failure alerts the owner
    original, recovered = failure['rows'][0], verdict['rows'][0]
    assert original['status'] == 'terminal' and original['outcome'] == 'failed'
    assert recovered['generation'] > original['generation']
    for key in ('admission_id', 'request_id', 'seq', 'payload'):
        assert recovered[key] == original[key]
    if hook == 'before_effect':
        assert not (tmp_path / 'done-count').exists()
        assert not (tmp_path / 'pending-count').exists()
    else:
        assert (tmp_path / 'done-count').read_text().splitlines() == ['once']
        assert (tmp_path / 'pending-count').read_text().splitlines() == ['once']


@pytest.mark.parametrize('point', ['H8', 'H9', 'H10'])
def test_completed_side_effect_final_crash_never_reexecutes_or_asks(tmp_path, point):
    env = environment(tmp_path, point)
    peer = ROOT / 'tests/gateway/fixtures/tool_resume_peer.py'
    for mode, expected in [('crash', 86), ('recover', 0)]:
        result = subprocess.run([sys.executable, str(peer), mode, 'completed_final'], env=env,
            capture_output=True, text=True, timeout=100)
        assert result.returncode == expected, result.stdout + result.stderr
    assert (tmp_path / 'final-verdict.json').exists()
