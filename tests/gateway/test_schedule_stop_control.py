"""Exact schedule Stop through the same-user socket and native cron cancellation."""
import asyncio
from types import SimpleNamespace

import pytest
import pytest_asyncio

pytestmark = pytest.mark.platforms('posix')


@pytest_asyncio.fixture
async def control(tmp_path, monkeypatch):
    from cron import jobs
    from gateway import run, session_cron
    from gateway.config import GatewayConfig
    from gateway.control_socket import GatewayControlServer, query_gateway_control
    from gateway.session import SessionStore
    from gateway.session_authorities import SessionAuthorities
    from gateway.session_authority import SessionAuthority
    from gateway.source_control import register_source_stop
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch

    home = tmp_path.resolve()
    home.chmod(0o700)
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setattr(jobs, 'get_job', lambda jid: {'id': jid, 'prompt': 'p', 'model': 'm'})
    monkeypatch.setattr(run, '_load_gateway_config', lambda: {'model': {}, 'platform_toolsets': {'cli': []}})
    db = SessionDB(home / 'state.db')
    runner = SimpleNamespace(_draining=False, session_store=SessionStore(home / 'sessions', GatewayConfig()),
                             adapters={}, session_authorities=SessionAuthorities(home))
    authority = SessionAuthority(runner, profile_id=str(home), instance_id='test', db=db,
                                 epoch=begin_runtime_epoch(db, instance_id='test'))
    runner.session_authorities.add(home, authority)
    monkeypatch.setattr(authority, '_schedule', lambda ref: None)
    server = GatewayControlServer(home)
    register_source_stop(server, runner, asyncio.get_running_loop())
    assert await server.start()

    async def submit(job='job', execution='fire'):
        return await session_cron.operation(authority, 'submit',
            dict(job_id=job, request_id=execution, extra_prompt=None))

    async def stop(job='job', execution='fire', action='stop', **metadata):
        return await asyncio.to_thread(query_gateway_control, home, 'stop-source', timeout=8,
            params=dict(profile_id=str(home), kind='schedule', job=job, execution=execution,
                        action=action, **metadata))
    try:
        yield SimpleNamespace(authority=authority, db=db, submit=submit, stop=stop, home=home)
    finally:
        await server.stop()
        db.close()


@pytest.mark.asyncio
async def test_running_schedule_stop_uses_native_cancel_and_retains_receipt(control, monkeypatch):
    from cron import scheduler
    from gateway import session_cron
    from gateway.session_contract import SessionRef
    from hermes_state_runtime import claim_session_input, settle_session_input
    c = control
    receipt = await c.submit()
    row = claim_session_input(c.db, epoch=c.authority.epoch, session_id=receipt['session_id'])
    policy = next(iter(c.authority.runner.adapters.values())).policies[receipt['session_id']]
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()

    def run_job(job, *, extra_prompt, execution_id, cancel_event):
        loop.call_soon_threadsafe(entered.set)
        assert (job['id'], execution_id) == ('job', 'fire')
        assert cancel_event.wait(5)
        return False, '', '', 'interrupted'
    monkeypatch.setattr(scheduler, 'run_job', run_job)

    async def execute():
        with pytest.raises(RuntimeError, match='interrupted'):
            await session_cron.execute(c.authority, SessionRef(str(c.home), receipt['session_id']), row, policy)
        settle_session_input(c.db, epoch=c.authority.epoch, admission_id=row['admission_id'],
                             generation=row['generation'], outcome='interrupted')
    task = asyncio.create_task(execute())
    await asyncio.wait_for(entered.wait(), 5)
    result = await c.stop(member='opaque-member')
    await task
    assert result == {'accepted': True, 'state': 'interrupted', 'receipt': {
        'kind': 'schedule', 'job': 'job', 'execution': 'fire', 'member': 'opaque-member',
        'state': 'interrupted'}}
    # Read persisted receipt with a new server call, without an in-memory cancellation event.
    assert c.authority._cron_cancellations == {}
    assert await c.stop(action='receipt', member='opaque-member') == result


@pytest.mark.asyncio
async def test_finished_schedule_is_explicit(control):
    from hermes_state_runtime import claim_session_input, settle_session_input
    c = control
    receipt = await c.submit()
    row = claim_session_input(c.db, epoch=c.authority.epoch, session_id=receipt['session_id'])
    settle_session_input(c.db, epoch=c.authority.epoch, admission_id=row['admission_id'],
                         generation=row['generation'], outcome='completed')
    result = await c.stop()
    assert result['accepted'] and result['state'] == result['receipt']['state'] == 'finished'
    assert not getattr(c.authority, '_cron_cancellations', {})


@pytest.mark.asyncio
@pytest.mark.parametrize('job,execution', [('missing', 'fire'), ('job', 'missing'), ('other', 'fire')])
async def test_unknown_or_other_job_never_acknowledges_or_cancels(control, job, execution):
    from hermes_state_runtime import claim_session_input
    c = control
    receipt = await c.submit()
    row = claim_session_input(c.db, epoch=c.authority.epoch, session_id=receipt['session_id'])
    result = await c.stop(job=job, execution=execution, member='metadata-is-not-authority')
    assert result == {'accepted': False, 'state': 'unknown', 'receipt': None}
    assert not getattr(c.authority, '_cron_cancellations', {})
    assert row['admission_id']


@pytest.mark.asyncio
async def test_running_schedule_reaches_native_hard_stop(control, monkeypatch):
    """Exercise the cron watchdog, including its longer poll than the control ACK budget."""
    import threading
    from cron import scheduler
    from gateway import session_cron
    from gateway.session_contract import SessionRef
    from hermes_state_runtime import claim_session_input, settle_session_input
    c = control
    receipt = await c.submit()
    row = claim_session_input(c.db, epoch=c.authority.epoch, session_id=receipt['session_id'])
    policy = next(iter(c.authority.runner.adapters.values())).policies[receipt['session_id']]
    entered, stopped = threading.Event(), threading.Event()
    calls = []

    class Agent:
        def run_conversation(self, prompt, task_id):
            entered.set()
            assert stopped.wait(12)
            return {'final_response': ''}

        def hard_interrupt(self, message=None, **kwargs):
            calls.append('hard')
            stopped.set()

        def interrupt(self, message=None):
            calls.append('soft')
            stopped.set()

    def run_job(job, *, extra_prompt, execution_id, cancel_event):
        try:
            scheduler._run_agent_with_watchdog(Agent(), '', job, job['id'], 'fixture', 'task', cancel_event)
        except RuntimeError as exc:
            return False, '', '', str(exc)
        raise AssertionError('cancelled run returned normally')
    monkeypatch.setattr(scheduler, 'run_job', run_job)
    monkeypatch.setattr(scheduler, '_cron_inactivity_seconds', lambda: 0)

    async def execute():
        with pytest.raises(RuntimeError):
            await session_cron.execute(c.authority, SessionRef(str(c.home), receipt['session_id']), row, policy)
        settle_session_input(c.db, epoch=c.authority.epoch, admission_id=row['admission_id'],
                             generation=row['generation'], outcome='interrupted')
    task = asyncio.create_task(execute())
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        assert await c.stop() == {'accepted': False, 'state': 'pending', 'receipt': None}
        await asyncio.wait_for(task, 10)
        assert calls == ['hard']
        result = await c.stop(action='receipt')
        assert result['accepted'] and result['state'] == 'interrupted'
    finally:
        stopped.set()
        await task


@pytest.mark.asyncio
async def test_queued_stop_and_other_execution_isolation(control):
    from hermes_state_runtime import get_session_admission
    c = control
    first, other = await c.submit(), await c.submit(execution='next')
    result = await c.stop(member='opaque')
    assert result['accepted'] and result['state'] == 'interrupted'
    assert get_session_admission(c.db, admission_id=first['admission_id'])['outcome'] == 'cancelled'
    assert get_session_admission(c.db, admission_id=other['admission_id'])['status'] == 'queued'
    # A changed annotation cannot select or cancel another execution, even on receipt retry.
    assert await c.stop(action='receipt', member='changed') == result


@pytest.mark.asyncio
async def test_finished_execution_ledger_without_admission(control):
    from cron.executions import create_execution, finish_execution, mark_execution_running
    c = control
    record = create_execution('job', source='builtin')
    mark_execution_running(record['id'])
    finish_execution(record['id'], success=True)
    result = await c.stop(execution=record['id'])
    assert result['accepted'] and result['state'] == 'finished'
    assert not getattr(c.authority, '_cron_cancellations', {})


@pytest.mark.asyncio
async def test_stop_isolates_two_claimed_jobs_with_same_execution_token(control):
    from gateway.session_cron import _cancellations
    from hermes_state_runtime import claim_session_input, settle_session_input
    c = control
    first, other = await c.submit(), await c.submit(job='other')
    a = claim_session_input(c.db, epoch=c.authority.epoch, session_id=first['session_id'])
    b = claim_session_input(c.db, epoch=c.authority.epoch, session_id=other['session_id'])
    import threading
    events = _cancellations(c.authority)
    events[a['admission_id']] = threading.Event()
    events[b['admission_id']] = threading.Event()

    async def finish():
        while not events[a['admission_id']].is_set():
            await asyncio.sleep(.01)
        settle_session_input(c.db, epoch=c.authority.epoch, admission_id=a['admission_id'],
                             generation=a['generation'], outcome='interrupted')
    task = asyncio.create_task(finish())
    result = await c.stop()
    await task
    assert result['accepted']
    assert not events[b['admission_id']].is_set()


@pytest.mark.asyncio
async def test_recovery_unknown_is_never_finished(control):
    from hermes_state_runtime import claim_session_input, begin_runtime_epoch, recover_session_inputs
    c = control
    receipt = await c.submit()
    claim_session_input(c.db, epoch=c.authority.epoch, session_id=receipt['session_id'])
    epoch = begin_runtime_epoch(c.db, instance_id='replacement')
    recover_session_inputs(c.db, epoch=epoch)
    assert await c.stop() == {'accepted': False, 'state': 'unknown', 'receipt': None}
