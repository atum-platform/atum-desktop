"""Agent cron must enter the owner before importing any agent-side storage."""
import asyncio
from contextlib import asynccontextmanager

import pytest

from cron import scheduler


def test_agent_cron_is_transport_only_and_refuses_without_owner(monkeypatch):
    from hermes_cli import gateway_client
    calls = []

    @asynccontextmanager
    async def unavailable():
        calls.append('connect')
        raise gateway_client.GatewayClientError('owner_unavailable')
        yield

    monkeypatch.setattr(gateway_client, 'connect_gateway', unavailable)
    monkeypatch.setattr(scheduler, '_prepare_job_prompt', lambda *a: (_ for _ in ()).throw(
        AssertionError('agent prompt preparation belongs to the owner')))
    result = scheduler.run_job({'id': 'job', 'prompt': 'test'}, execution_id='fire')
    assert calls == ['connect']
    assert result[0] is False and 'owner_unavailable' in result[3]


def test_owner_ticker_uses_direct_admission_without_loopback(monkeypatch):
    from gateway import session_cron
    from types import SimpleNamespace
    from hermes_constants import get_hermes_home
    import threading

    async def probe():
        authority = SimpleNamespace(db=SimpleNamespace(db_path=str(get_hermes_home() / 'state.db')))
        session_cron.bind_owner(authority)
        calls = []

        async def request(owner, operation, params, actor=None):
            assert owner is authority
            calls.append((operation, threading.get_ident()))
            if operation == 'submit':
                return {'session_id': 'cron-fire', 'admission_id': 'admit'}
            return {'status': 'terminal', 'result': [True, 'document', 'answer', None]}

        monkeypatch.setattr(session_cron, 'operation', request)
        # A nested job must not inherit its parent's execution authorization.
        token = session_cron._execution.set((authority, 'parent-session', 'parent-job', 'parent-fire'))
        try:
            result = await asyncio.to_thread(scheduler.run_job, {'id': 'job'}, execution_id='fire')
        finally:
            session_cron._execution.reset(token)
        assert result == (True, 'document', 'answer', None)
        assert [op for op, _ in calls] == ['submit', 'status']
        assert all(tid == threading.get_ident() for _, tid in calls)
        session_cron.unbind_owner(authority)

    asyncio.run(probe())


def test_lost_cron_ack_retains_identity_instead_of_reporting_failure(tmp_path, monkeypatch):
    from cron.scheduler_authority import run_canonical_job, CronExecutionUnknown
    from hermes_cli import gateway_client
    from hermes_constants import get_hermes_home
    import json
    import pytest

    class Peer:
        async def rpc(self, method, **params):
            raise gateway_client.GatewayClientError('Gateway disconnected')

    @asynccontextmanager
    async def connected():
        yield Peer()

    monkeypatch.setattr(gateway_client, 'connect_gateway', connected)
    with pytest.raises(CronExecutionUnknown):
        run_canonical_job({'id': 'job'}, execution_id='fire')
    records = list((get_hermes_home() / 'cron' / 'admissions').glob('*.json'))
    assert len(records) == 1
    assert json.loads(records[0].read_text())['params']['request_id'] == 'fire'


def test_cold_owner_attachment_retries_before_spending_fire(monkeypatch):
    """A timed-out ticket and a losing gateway launch precede any admission.

    Inject the exact pre-submit failures seen in the Desktop tenancy canary;
    the same fire must reach submit once, with no failed-run result in between.
    """
    from cron.scheduler_authority import run_canonical_job, journal_path
    from hermes_cli import gateway_client
    failures = [TimeoutError('timed out'), gateway_client.GatewayUnavailableError(
        'losing launch exited', 'inaccessible', 'runtime_exited')]
    calls = []

    class Peer:
        async def rpc(self, method, **params):
            calls.append(method)
            if method == 'cron.submit':
                return {'session_id': 'cron-fire', 'admission_id': 'admit'}
            return {'status': 'terminal', 'result': [True, 'document', 'answer', None]}

    @asynccontextmanager
    async def connecting():
        if failures:
            assert not journal_path('job', 'fire').exists(), 'no admission attempted during attach'
            raise failures.pop(0)
        yield Peer()

    monkeypatch.setattr(gateway_client, 'connect_gateway', connecting)
    assert run_canonical_job({'id': 'job'}, execution_id='fire') == (True, 'document', 'answer', None)
    assert calls == ['cron.submit', 'cron.status']


def test_cold_owner_retry_never_replays_submit(monkeypatch):
    from cron.scheduler_authority import run_canonical_job, CronExecutionUnknown
    from hermes_cli import gateway_client
    import pytest
    attaches = []

    class Peer:
        async def rpc(self, method, **params):
            raise TimeoutError('submit answer lost')

    @asynccontextmanager
    async def connecting():
        attaches.append(True)
        yield Peer()

    monkeypatch.setattr(gateway_client, 'connect_gateway', connecting)
    with pytest.raises(CronExecutionUnknown):
        run_canonical_job({'id': 'job'}, execution_id='fire')
    assert len(attaches) == 1


@pytest.mark.platforms("posix")
def test_delayed_control_socket_does_not_lose_cron_fire(monkeypatch):
    """Real socket I/O: identify was ready, but ticket handling stalls past its
    five-second receive deadline. No sleeps or model/network service needed.
    """
    import socket
    from types import SimpleNamespace
    from hermes_cli import gateway_runtime_discovery, gateway_client
    from hermes_constants import get_hermes_home
    from cron import jobs

    client, server = socket.socketpair()
    endpoint = SimpleNamespace(profile_id=str(get_hermes_home()), instance_id='boot',
                               control_home=None)
    monkeypatch.setattr(gateway_runtime_discovery, 'connect_private', lambda *a: client)
    attempts = []
    submits = []

    class Peer:
        async def rpc(self, method, **params):
            if method == 'cron.submit':
                submits.append(params)
                return {'session_id': 'cron-fire', 'admission_id': 'admit'}
            return {'status': 'terminal', 'result': [True, 'document', 'answer', None]}

    @asynccontextmanager
    async def connecting():
        attempts.append(True)
        if len(attempts) == 1:
            # The peer deliberately withholds its reply until the client times out.
            await asyncio.to_thread(gateway_client._session_ticket, get_hermes_home(), endpoint)
        yield Peer()

    monkeypatch.setattr(gateway_client, 'connect_gateway', connecting)
    try:
        job = jobs.create_job(prompt='report', schedule='every 1h', deliver='local')
        assert scheduler.run_one_job(job, verbose=False)
        stored = jobs.get_job(job['id'])
        assert stored['last_status'] == 'ok', stored.get('last_error')
        assert stored['repeat']['completed'] == 1
        assert len(attempts) == 2 and len(submits) == 1
        assert b'session-ticket' in server.recv(65536)
    finally:
        client.close()
        server.close()


def test_owner_refusal_is_not_retried(monkeypatch):
    from cron.scheduler_authority import run_canonical_job
    from hermes_cli import gateway_client
    attempts = []

    @asynccontextmanager
    async def refused():
        attempts.append(True)
        raise gateway_client.GatewayUnavailableError('permission denied', 'inaccessible', 'access_denied')
        yield

    monkeypatch.setattr(gateway_client, 'connect_gateway', refused)
    result = run_canonical_job({'id': 'job'}, execution_id='fire')
    assert not result[0] and 'permission denied' in result[3]
    assert len(attempts) == 1


def test_attachment_deadline_does_not_limit_admitted_job(monkeypatch):
    from cron.scheduler_authority import run_canonical_job
    from hermes_cli import gateway_client, gateway_runtime

    monkeypatch.setattr(gateway_runtime, 'DEFAULT_ENSURE_TIMEOUT', 2)

    class Peer:
        async def rpc(self, method, **params):
            if method == 'cron.submit':
                return {'session_id': 'cron-fire', 'admission_id': 'admit'}
            complete = asyncio.Event()
            timer = asyncio.get_running_loop().call_later(4, complete.set)
            try:
                await complete.wait()
            finally:
                timer.cancel()
            return {'status': 'terminal', 'result': [True, 'document', 'answer', None]}

    @asynccontextmanager
    async def connected():
        yield Peer()

    monkeypatch.setattr(gateway_client, 'connect_gateway', connected)
    assert run_canonical_job({'id': 'job'}, execution_id='fire')[0] is True


def test_stalled_attachment_has_finite_budget_and_no_admission(monkeypatch):
    from cron.scheduler_authority import run_canonical_job, journal_path
    from hermes_cli import gateway_client, gateway_runtime
    attempts = []
    monkeypatch.setattr(gateway_runtime, 'DEFAULT_ENSURE_TIMEOUT', 2)

    @asynccontextmanager
    async def stalled():
        attempts.append(True)
        await asyncio.Event().wait()
        yield

    monkeypatch.setattr(gateway_client, 'connect_gateway', stalled)
    result = run_canonical_job({'id': 'job'}, execution_id='fire')
    assert not result[0] and 'TimeoutError' in result[3]
    assert len(attempts) == 1
    assert not journal_path('job', 'fire').exists()
