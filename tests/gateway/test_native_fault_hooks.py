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
