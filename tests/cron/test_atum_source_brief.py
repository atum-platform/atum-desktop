"""Native cron execution and DM delivery with fixture source/model boundaries."""
import asyncio
import json
from concurrent.futures import Future
from unittest.mock import MagicMock

from cron import jobs, scheduler, scheduler_delivery
from gateway.config import Platform, PlatformConfig
from hermes_state import SessionDB
from tools import atum_chats_tool as chats, atum_google_tool as google
from tools.atum_source_transport import bind_source_transport


def test_seeded_brief_reads_sources_history_and_delivers_once(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_MODEL', 'fixture-model')
    monkeypatch.setenv('MATRIX_ACCESS_TOKEN', 'offline-fixture')
    monkeypatch.delenv(google.URL_ENV, raising=False)
    monkeypatch.delenv(google.TOKEN_ENV, raising=False)
    monkeypatch.setattr(google, 'mark_holding', lambda: None)
    monkeypatch.setattr(chats.desktop_ui, '_request', None)
    monkeypatch.setattr(chats.desktop_ui, '_emit', None)
    monkeypatch.setattr(scheduler, '_get_hermes_home', lambda: tmp_path)
    monkeypatch.setattr(scheduler, 'get_fallback_chain', lambda cfg: [])
    monkeypatch.setattr(scheduler, '_guard_job_credential_exfil', lambda job: None)
    monkeypatch.setattr('hermes_constants.resolve_reasoning_config', lambda *a, **kw: None)
    monkeypatch.setattr('hermes_cli.runtime_provider.resolve_runtime_provider', lambda **kw: {
        'api_key': 'fixture', 'provider': 'test-provider', 'base_url': None,
        'api_mode': None, 'command': None, 'args': None})
    monkeypatch.setattr('tools.mcp_tool_discovery.discover_mcp_tools', list)
    db = SessionDB(tmp_path / 'history.db')
    db.create_session('previous', source='cli')
    db.append_message('previous', 'user', 'Remember the budget review')
    db.close()
    reads = []

    def source(tool, payload):
        reads.append(tool)
        if tool == 'google':
            return {'agenda': 'Design review at 09:00'}
        return {'id': '!owner:fixture', 'label': 'Owner', 'messages': [
            {'eventId': '$one', 'at': 1, 'from': 'Alex', 'mine': False,
             'kind': 'text', 'text': 'Please review the proposal'}]}

    class FixtureModel:
        def __init__(self, **kwargs):
            self.session_id = kwargs['session_id']
            # Mirror AIAgent's native constructor identity publication
            # (agent/agent_init.py), not the cron job's delivery origin.
            from gateway.session_context import set_current_session_id
            set_current_session_id(self.session_id)
            self.task_id = self.session_id
            self.db = kwargs['session_db']

        def run_conversation(self, prompt, *, task_id=None):
            assert google._background_run()
            agenda = json.loads(google.atum_google({'action': 'agenda'}))['agenda']
            chat = json.loads(chats.atum_chats('read', room_id='!owner:fixture'))['messages'][0]['text']
            history = SessionDB(tmp_path / 'history.db')
            try:
                rows = history.search_messages('budget')
                assert rows
            finally:
                history.close()
            brief = f'{agenda}. {chat}. {rows[0]["snippet"]}'
            self.db.create_session(self.session_id, source='cron')
            self.db.append_message(self.session_id, 'user', prompt)
            self.db.append_message(self.session_id, 'assistant', brief)
            return {'completed': True, 'failed': False, 'final_response': brief}

        def close(self):
            pass

    monkeypatch.setattr('run_agent.AIAgent', FixtureModel)
    job = jobs.create_job('Morning brief from Google, chats and history', '0 1 * * *',
                          name='Morning brief', deliver='matrix:!owner:fixture')
    # The private plugin installs its binding after native cron session context,
    # before the real watchdog copies that context into the model worker.
    native_watchdog = scheduler._run_agent_with_watchdog
    def bound_watchdog(*args, **kwargs):
        with bind_source_transport(source):
            return native_watchdog(*args, **kwargs)
    monkeypatch.setattr(scheduler, '_run_agent_with_watchdog', bound_watchdog)
    success, _doc, final, error = scheduler.run_job(job, native_claimed=True)
    assert success, error
    assert reads == ['google', 'chats']
    assert 'Design review' in final and 'proposal' in final and 'budget' in final
    sent = []
    adapter = MagicMock()
    async def send(chat_id, content, **kwargs):
        sent.append((chat_id, content))
        return {'success': True, 'message_id': '$brief'}
    adapter.send = send
    config = MagicMock()
    config.platforms = {Platform.MATRIX: PlatformConfig(enabled=True)}
    config.get_home_channel = lambda p: None
    monkeypatch.setattr('gateway.config.load_gateway_config', lambda: config)
    monkeypatch.setattr(scheduler, 'load_config', lambda: {'cron': {'wrap_response': False}})
    def run_coro(coro, loop):
        result = Future()
        result.set_result(asyncio.run(coro))
        return result
    monkeypatch.setattr(asyncio, 'run_coroutine_threadsafe', run_coro)
    loop = MagicMock()
    loop.is_running.return_value = True
    assert scheduler_delivery._deliver_result(job, final, adapters={Platform.MATRIX: adapter}, loop=loop) is None
    assert len(sent) == 1 and sent[0] == ('!owner:fixture', final)
    assert not (tmp_path / 'google_token.json').exists()
