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
unsafe = hook in ('before_effect', 'after_effect')


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
        if mode == 'crash' and index == 1 and hook == 'between':
            os.kill(os.getpid(), signal.SIGKILL)
        # Deliberately attempt the completed call again after restart. The executor must refuse.
        if index < 2:
            name = 'write_file' if index == 1 and unsafe else 'read_file'
            args = {'path': str(home / ('done' if index == 0 else 'pending'))}
            if name == 'write_file':
                args['content'] = 'one line'
            message = {'role': 'assistant', 'content': '', 'tool_calls': [
                {'id': 'call_' + str(index), 'type': 'function',
                 'function': {'name': name, 'arguments': json.dumps(args)}}]}
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
        if mode == 'crash' and pending and hook != 'after_effect':
            os.kill(os.getpid(), signal.SIGKILL)
        counter = home / ('pending-count' if pending else 'done-count')
        with counter.open('a') as out:
            out.write('once\n'); out.flush(); os.fsync(out.fileno())
        if mode == 'crash' and pending:
            os.kill(os.getpid(), signal.SIGKILL)
        return json.dumps({'content': 'fixture read', 'bytes_written': 8})
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
        verdict = await authority.recover_native_sessions([(entry.session_id, source, adapter)])
        assert verdict[entry.session_id] == 'ready', verdict
        task = authority.sessions[entry.session_id].task
        if task is not None:
            await asyncio.wait_for(task, 40)
        rows = list_session_admissions(authority.db, session_id=entry.session_id, pending_only=False)
        assert len(rows) == 1 and rows[0]['status'] == 'terminal', rows
        assert rows[0]['outcome'] == 'completed', rows
        assert any(('tiếp tục' if unsafe else 'Đã đọc xong') in text for text in adapter.sent), adapter.sent
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
