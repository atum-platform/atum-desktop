"""Real gateway/agent/SQLite crash peer; loopback model and filesystem-only test tools."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import sys
import threading
import traceback

home = Path(os.environ['HERMES_HOME'])
mode, hook = sys.argv[1:]
unsafe = hook in ('before_effect', 'after_effect', 'unknown_sequential', 'unknown_concurrent')


class Peer(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"data": []}')

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'messages' not in request:
            raise AssertionError('unexpected auxiliary model request')
        requests = home / (mode + '-requests.jsonl')
        with requests.open('a') as out:
            out.write(json.dumps(request) + '\n')
        index = self.server.index
        self.server.index += 1
        if mode == 'crash' and ((index == 1 and hook in ('between', 'unknown_concurrent')) or (index == 2 and hook == 'unknown_sequential')):
            os.kill(os.getpid(), signal.SIGKILL)
        # Deliberately attempt the completed call again after restart. The executor must refuse.
        if index < 2 or (mode in ('pending_again', 'ask_crash') and index % 3 < 2):
            name = 'write_file' if unsafe and (index == 1 or mode in ('pending_again', 'ask_crash')) else 'read_file'
            args = {'path': str(home / ('done' if index == 0 else 'pending'))}
            if name == 'write_file':
                args['content'] = 'one line'
            message = {'role': 'assistant', 'content': '', 'tool_calls': [
                {'id': 'call_' + str(index), 'type': 'function',
                 'function': {'name': name, 'arguments': json.dumps(args)}}]}
            if mode == 'crash' and hook == 'unknown_concurrent' and index == 0:
                message['tool_calls'].append({'id': 'parallel-write', 'type': 'function',
                    'function': {'name': 'write_file', 'arguments': json.dumps({
                        'path': str(home / 'pending'), 'content': 'one line'})}})
            finish = 'tool_calls'
        else:
            message = {'role': 'assistant', 'content': (
                'Việc ghi tệp có thể đã chạy một phần; bạn có muốn tôi tiếp tục không?' if unsafe else 'Đã đọc xong.')}
            finish = 'stop'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if request.get('stream') else 'application/json')
        self.end_headers()
        base = {'id': 'local', 'model': 'local-wire-stub', 'created': 1}
        if request.get('stream'):
            delta = dict(message)
            if 'tool_calls' in delta:
                delta['tool_calls'] = [{**call, 'index': i} for i, call in enumerate(delta['tool_calls'])]
            for item, reason in [(delta, None), ({}, finish)]:
                chunk = {**base, 'object': 'chat.completion.chunk',
                         'choices': [{'index': 0, 'delta': item, 'finish_reason': reason}]}
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.wfile.write(json.dumps({**base, 'object': 'chat.completion',
                'choices': [{'index': 0, 'message': message, 'finish_reason': finish}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}).encode())


async def probe():
    from gateway.config import Platform, PlatformConfig
    from gateway.platforms.base import BasePlatformAdapter, SendResult
    from gateway.platforms.event import MessageEvent
    from gateway.run import GatewayRunner
    from gateway.session import SessionSource
    from gateway.session_authority import initialize_session_authority
    from hermes_state_runtime import list_session_admissions
    from tests.waiting import async_wait_until
    import model_tools
    from tools.registry import registry
    # Replace only the tool handler in this disposable subprocess. Schema/discovery/dispatch,
    # recording, agent loop and runtime ownership are the production path.
    def handler(args, **kwargs):
        pending = Path(args['path']).name == 'pending'
        with (home / 'handler-events').open('a') as evidence:
            evidence.write(json.dumps({'mode': mode, 'hook': hook, 'path': args['path'],
                'pending': pending, 'stack': traceback.format_stack()}) + '\n')
        if mode == 'crash' and pending and hook not in ('after_effect', 'unknown_sequential', 'unknown_concurrent'):
            os.kill(os.getpid(), signal.SIGKILL)
            threading.Event().wait()  # never race ahead while another thread receives SIGKILL
        counter = home / ('pending-count' if pending else 'done-count')
        with counter.open('a') as out:
            out.write('once\n'); out.flush(); os.fsync(out.fileno())
        if mode == 'crash' and pending and not hook.startswith('unknown_'):
            os.kill(os.getpid(), signal.SIGKILL)
            threading.Event().wait()
        return json.dumps({'content': 'fixture read', 'bytes_written': 8})
    if hook.startswith('unknown_'):
        # Both sequential/concurrent native completion paths converge at this persistence seam.
        # Persist the exact native timeout evidence, then crash on the next provider request.
        from agent import tool_executor
        original_commit = tool_executor._commit_tool_result
        def commit_unknown(agent, messages, ref, result, **kwargs):
            if mode == 'crash' and ref.name == 'write_file':
                kwargs['effect_disposition'] = 'unknown'
                result = '[Command interrupted]'
            return original_commit(agent, messages, ref, result, **kwargs)
        tool_executor._commit_tool_result = commit_unknown
    registry._tools['read_file'].handler = handler
    registry._tools['write_file'].handler = handler

    class Adapter(BasePlatformAdapter):
        tool_aware_resume = True
        def __init__(self):
            super().__init__(PlatformConfig(enabled=True, token='local-fixture'), Platform.TELEGRAM)
            self.sent = []
        async def connect(self): return True
        async def disconnect(self): pass
        async def send(self, chat_id, content, reply_to=None, metadata=None):
            self.sent.append(content)
            return SendResult(success=True, message_id=str(len(self.sent)))
        async def edit_message(self, chat_id, message_id, content, **kwargs):
            return await self.send(chat_id, content)
        async def send_typing(self, *args, **kwargs): pass
        async def get_chat_info(self, chat_id): return {'id': chat_id}

    from agent import tool_executor
    original_dispatch = tool_executor._dispatch_authorized_once
    dispatch_evidence = []
    def dispatch(agent, *args, **kwargs):
        guard = getattr(agent, '_crash_resume_tool_guard', None)
        resume = guard.args[0] if guard is not None else None
        dispatch_evidence.append({'ask': getattr(resume, 'ask', None),
            'pending': [getattr(entry, 'resume_ask', None) for entry in runner.session_store._entries.values()]})
        return original_dispatch(agent, *args, **kwargs)
    tool_executor._dispatch_authorized_once = dispatch
    runner = GatewayRunner()
    await initialize_session_authority(runner, profile_id='default', instance_id=mode)
    adapter = Adapter()
    runner.adapters[Platform.TELEGRAM] = adapter
    adapter.set_message_handler(runner._handle_message)
    source = SessionSource(platform=Platform.TELEGRAM, chat_id='fixture', chat_type='dm', user_id='fixture-user')
    authority = runner.session_authority
    if mode == 'crash':
        await adapter.handle_message(MessageEvent(text='Đọc tài liệu rồi làm tiếp.', source=source, message_id='source-1'))
        await async_wait_until(lambda: False, timeout=40, what='fixture SIGKILL')
    else:
        entry = runner.session_store.get_or_create_session(source)
        if mode == 'ask_crash':
            from copy import deepcopy
            from hermes_state_runtime import admit_session_input
            original = list_session_admissions(authority.db, session_id=entry.session_id, pending_only=False)[0]
            payload = deepcopy(original['payload'])
            payload['text'] = 'yes'
            payload['native_text_v1']['event']['message_id'] = 'queued-before-ask'
            admit_session_input(authority.db, epoch=authority.epoch, principal_id=original['principal_id'],
                                session_id=entry.session_id, request_id='queued-before-ask', payload=payload)
        verdict = await authority.recover_native_sessions([(entry.session_id, source, adapter)])
        assert verdict[entry.session_id] == 'ready', verdict
        task = authority.sessions[entry.session_id].task
        if task is not None:
            await asyncio.wait_for(task, 40)
        if mode == 'pending_again':
            assert entry.resume_ask
            event = MessageEvent(text='Finish the work.', source=source, message_id='after-restart')
            await adapter.handle_message(event)
            await async_wait_until(lambda: event._gateway_accepted and not adapter._background_tasks,
                                   timeout=40, what='accepted conversational turn completed')
            assert entry.resume_ask
            assert not (home / 'pending-count').exists(), {'dispatch': dispatch_evidence, 'sent': adapter.sent, 'handlers': (home / 'handler-events').read_text()}
            event = MessageEvent(text='KHÔNG!', source=source, message_id='decline')
            await adapter.handle_message(event)
            await async_wait_until(lambda: event._gateway_accepted and not adapter._background_tasks,
                                   timeout=40, what='accepted owner decline completed')
            assert entry.resume_ask is None
            assert not (home / 'pending-count').exists(), {'dispatch': dispatch_evidence, 'sent': adapter.sent, 'handlers': (home / 'handler-events').read_text()}
            return
        rows = list_session_admissions(authority.db, session_id=entry.session_id, pending_only=False)
        assert all(row['status'] == 'terminal' for row in rows), rows
        assert rows[0]['outcome'] == 'completed', rows
        assert any(('tiếp tục' if unsafe else 'Đã đọc xong') in text for text in adapter.sent), adapter.sent
        if mode == 'ask_crash':
            assert len(rows) == 2, rows
            assert not (home / 'pending-count').exists(), {'dispatch': dispatch_evidence, 'sent': adapter.sent, 'handlers': (home / 'handler-events').read_text()}
            assert entry.resume_ask
            os.kill(os.getpid(), signal.SIGKILL)
        (home / 'verdict.json').write_text(json.dumps({'rows': rows, 'sent': adapter.sent}))


peer = ThreadingHTTPServer(('127.0.0.1', 0), Peer)
peer.index = 0
threading.Thread(target=peer.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{peer.server_port}/v1'
os.environ.update(OPENAI_API_KEY='explicit-loopback-fixture', OPENAI_BASE_URL=base,
                  TELEGRAM_ALLOWED_USERS='fixture-user')
(home / 'config.yaml').write_text(
    f'model:\n  default: local-wire-stub\n  provider: custom\n  base_url: {base}\n'
    'auxiliary:\n  title_generation:\n    enabled: false\n'
    f'terminal:\n  cwd: {home}\ndisplay:\n  streaming: false\n  busy_input_mode: queue\n')
status = 0
try:
    asyncio.run(probe())
except BaseException:
    traceback.print_exc()
    status = 1
finally:
    sys.stdout.flush(); sys.stderr.flush()
os._exit(status)
