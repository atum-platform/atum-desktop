"""Disposable offline Matrix/native-runtime backlog probe with a loopback model."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import threading
import sys
import traceback
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'messages' not in request:
            self.send_error(400, 'fixture accepts chat completions')
            return
        latest = next(m['content'] for m in reversed(request['messages']) if m['role'] == 'user')
        numbers = re.findall(r'CHECK5_(\d+)', str(latest))
        text = 'ack ' + numbers[-1] if numbers else 'unexpected input'
        # Hermes also uses the model for periodic memory maintenance.
        if numbers:
            self.server.inputs.append(numbers)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if request.get('stream') else 'application/json')
        self.end_headers()
        base = {'id': 'offline', 'model': 'local-wire-stub', 'created': 1}
        if request.get('stream'):
            for delta, finish in [({'role': 'assistant', 'content': text}, None), ({}, 'stop')]:
                chunk = {**base, 'object': 'chat.completion.chunk', 'choices': [
                    {'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.wfile.write(json.dumps({**base, 'choices': [
                {'index': 0, 'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}}).encode())


async def probe(peer):
    from gateway.config import Platform, PlatformConfig
    from gateway.platforms.event import MessageEvent
    from gateway.run import GatewayRunner
    from gateway.session import SessionSource
    from gateway.session_authority import initialize_session_authority
    from plugins.platforms.matrix.adapter import MatrixAdapter
    from plugins.platforms.matrix.intake import MatrixIntakeStore
    from tests.waiting import async_wait_until

    runner = GatewayRunner()
    await initialize_session_authority(runner, profile_id='default', instance_id='offline-owner')
    a = MatrixAdapter(PlatformConfig(enabled=True, token='offline', extra={
        'homeserver': 'https://matrix.example.org', 'user_id': '@bot:example.org',
        'allowed_users': '@alice:example.org'}))
    a.gateway_runner = runner
    runner.adapters[Platform.MATRIX] = a
    a.set_message_handler(runner._primary_message_handler())
    a._intake = MatrixIntakeStore(Path(os.environ['HERMES_HOME']) / 'intake.sqlite3')
    a._startup_ts = 9999999999
    a._refresh_dm_cache = AsyncMock()
    a._warn_encrypted_drops = MagicMock()
    a._schedule_pending_invite_joins = MagicMock()
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a.send_typing = AsyncMock()
    a.on_processing_start = AsyncMock()
    a.on_processing_complete = AsyncMock()
    finals = []
    publications = []
    transactions = {}

    async def send_message_event(room, kind, content, txn_id=None, **kwargs):
        if txn_id not in transactions:
            transactions[txn_id] = '$reply-' + str(len(transactions))
            publications.append(content)
            parent = content.get('m.relates_to', {}).get('m.in_reply_to', {}).get('event_id')
            if parent is not None:
                finals.append((parent, content.get('body')))
        return transactions[txn_id]

    async def inbound(room, sender, eid, timestamp, content, relates):
        from datetime import datetime, UTC
        e = MessageEvent(timestamp=datetime.fromtimestamp(timestamp, UTC), text=content['body'], message_id=eid, source=SessionSource(
            platform=Platform.MATRIX, chat_id=room, chat_type='dm', user_id=sender))
        await a.handle_message(e)
    a._handle_text_message = inbound
    def raw(i):
        return {'type': 'm.room.message', 'event_id': f'$check5-{i:02}', 'sender': '@alice:example.org',
                'origin_server_ts': 1, 'content': {'msgtype': 'm.text', 'body': f'CHECK5_{i:02}'}}
    def batch(events, token, limited=False):
        return {'next_batch': token, 'rooms': {'join': {'!room:example.org': {'timeline': {
            'events': events, 'limited': limited, 'prev_batch': 'page-0'}}}}}
    async def handle_sync(data):
        for room, joined in data.get('rooms', {}).get('join', {}).items():
            for raw_event in joined.get('timeline', {}).get('events', []):
                await a._on_room_message(SimpleNamespace(room_id=room, sender=raw_event['sender'],
                    event_id=raw_event['event_id'], timestamp=1, content=raw_event['content']))
        return []
    client = SimpleNamespace(handle_sync=handle_sync, send_message_event=send_message_event,
        get_messages=AsyncMock(side_effect=[
            SimpleNamespace(events=[raw(i) for i in range(15, 5, -1)], end='page-1'),
            SimpleNamespace(events=[raw(i) for i in range(5, -1, -1)], end='page-2')]))
    a._client = client
    baseline = batch([raw(0)], 'before-stop')
    a._intake.accept(baseline)
    a._intake.finish(baseline)
    a._intake.close()
    a._intake = MatrixIntakeStore(Path(os.environ['HERMES_HOME']) / 'intake.sqlite3')
    runner._startup_restore_in_progress = True
    runner._startup_restore_queue = []
    legacy = '--legacy-resume' in sys.argv
    if legacy:
        from gateway.run import _AGENT_PENDING_SENTINEL
        source = SessionSource(platform=Platform.MATRIX, chat_id='!room:example.org',
            chat_type='dm', user_id='@alice:example.org')
        entry = runner.session_store.get_or_create_session(source)
        runner.session_store.mark_resume_pending(entry.session_key, reason='restart_interrupted')
        runner._session_state(entry.session_key).turn.agent = _AGENT_PENDING_SENTINEL
        async def finish_legacy():
            await asyncio.sleep(1)
            assert finals == [] and peer.inputs == [], 'durable turn overlapped legacy resume'
            runner._release_running_agent_state(entry.session_key)
        release = asyncio.create_task(finish_legacy())
        a._startup_ts = 0  # the new durable event is live
    count = 1 if legacy else 25
    sync = (batch([raw(1)], 'live-during-resume') if legacy else
        batch([raw(i) for i in range(16, 26)], 'after-restart', True))
    await asyncio.wait_for(a._absorb_sync(client, sync), 60)
    await async_wait_until(lambda: len(finals) == count, timeout=90, what='source-linked finals')
    if legacy:
        await release
    assert finals == [(f'$check5-{i:02}', f'ack {i:02}') for i in range(1, count + 1)], finals
    assert not any('send it again' in str(content).lower() for content in publications), publications
    assert runner._startup_restore_queue == [], runner._startup_restore_queue
    assert all(len(numbers) == 1 for numbers in peer.inputs), peer.inputs
    assert len(peer.inputs) == count, peer.inputs
    # Reopen the journal as on process restart, replay the multi-page batch.
    a._intake.close()
    a._intake = MatrixIntakeStore(Path(os.environ['HERMES_HOME']) / 'intake.sqlite3')
    await a._dispatch_sync(sync)
    assert len(finals) == count
    assert client.get_messages.await_count == (0 if legacy else 2)
    a._intake.close()
    print(json.dumps({'finals': finals, 'model_calls': len(peer.inputs), 'startup_queue': 0}))


if __name__ == '__main__':
    peer = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    peer.inputs = []
    threading.Thread(target=peer.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{peer.server_port}/v1'
    os.environ.update(OPENAI_API_KEY='offline-loopback', OPENAI_BASE_URL=url, MATRIX_ALLOWED_USERS='@alice:example.org')
    Path(os.environ['HERMES_HOME'], 'config.yaml').write_text(
        f'model:\n  default: local-wire-stub\n  provider: custom\n  api_mode: chat_completions\n  base_url: {url}\n'
        'auxiliary:\n  title_generation:\n    enabled: false\n'
        'display:\n  busy_input_mode: interrupt\n  streaming: false\n'
        f'terminal:\n  cwd: {os.environ["HERMES_HOME"]}\n')
    status = 0
    try:
        asyncio.run(probe(peer))
    except BaseException:
        traceback.print_exc()
        status = 1
    finally:
        peer.shutdown()
        peer.server_close()
    os._exit(status)
