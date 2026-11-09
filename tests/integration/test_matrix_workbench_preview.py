"""Actual Matrix gateway + agent + existing preview tool, with loopback-only inference."""
import json
import queue
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGET = 'https://example.test/preview'


def test_real_matrix_turn_emits_bound_preview_without_async_delivery(tmp_path):
    real_turn(tmp_path, 'preview')


def test_real_matrix_turn_streams_reads_and_closes_background_terminal_without_async_delivery(tmp_path):
    real_turn(tmp_path, 'terminal')


def test_real_matrix_turn_resolves_word_request_without_changing_prompt_or_tool_schemas(tmp_path):
    real_turn(tmp_path, 'word')


def real_turn(tmp_path, kind):
    wires = []
    process_ids = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.reply(b'{"object":"list","data":[]}', 'application/json')

        def reply(self, body, content_type):
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            wires.append(request)
            step = len(wires)
            done = step == (2 if kind in {'preview', 'word'} else 4)
            message = {'role': 'assistant', 'content': 'Your preview is ready.' if done else None}
            if not done:
                if kind == 'preview':
                    name, args = 'open_preview', {'url': TARGET, 'label': 'A web preview'}
                elif kind == 'word':
                    name, args = 'word_document', {'action': 'read'}
                elif step == 1:
                    name, args = 'terminal', {'command': "printf '\\033[32mTERM_PROOF\\033[0m\\n'; sleep 2; printf 'FINISHED\\n'", 'background': True}
                elif step == 2:
                    process_ids.append(json.loads(request['messages'][-1]['content'])['session_id'])
                    name, args = 'read_terminal', {'start': 0, 'count': 24}
                else:
                    name, args = 'close_terminal', {'process_id': process_ids[0]}
                message['tool_calls'] = [{'id': f'call-{step}', 'type': 'function', 'function': {
                    'name': name, 'arguments': json.dumps(args)}}]
            finish = 'stop' if done else 'tool_calls'
            base = {'id': 'chatcmpl-preview', 'created': 1, 'model': request['model']}
            usage = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}
            if request.get('stream'):
                delta = dict(message)
                if 'tool_calls' in delta:
                    delta['tool_calls'] = [dict(call, index=i) for i, call in enumerate(delta['tool_calls'])]
                chunks = [dict(base, object='chat.completion.chunk', choices=[{'index': 0, 'delta': delta, 'finish_reason': None}]),
                          dict(base, object='chat.completion.chunk', choices=[{'index': 0, 'delta': {}, 'finish_reason': finish}]),
                          dict(base, object='chat.completion.chunk', choices=[], usage=usage)]
                body = ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
                self.reply(body.encode(), 'text/event-stream')
            else:
                body = dict(base, object='chat.completion', choices=[{'index': 0, 'message': message, 'finish_reason': finish}], usage=usage)
                self.reply(json.dumps(body).encode(), 'application/json')

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    home = tmp_path / 'home'
    home.mkdir()
    (home / 'config.yaml').write_text(json.dumps({
        'model': {'default': 'fixture/preview', 'provider': 'custom:fixture', 'context_length': 64000},
        'providers': {'fixture': {'base_url': f'http://127.0.0.1:{provider.server_port}/v1',
                                 'key_env': 'PREVIEW_FIXTURE_KEY', 'default_model': 'fixture/preview',
                                 'api_mode': 'chat_completions'}},
        'agent': {'environment_probe': False, 'max_turns': 6},
        'display': {'streaming': True}, 'mcp_servers': {},
    }))
    # No ambient provider keys, user config, home, cwd, or network credentials.
    env = {'HOME': str(home), 'HERMES_HOME': str(home), 'PATH': '/usr/bin:/bin',
           'PYTHONPATH': str(REPO), 'PYTHONDONTWRITEBYTECODE': '1', 'LANG': 'C.UTF-8', 'TZ': 'UTC',
           'HERMES_DESKTOP': '1', 'HERMES_DESKTOP_CRON': '0', 'TIRITH_ENABLED': 'false',
           'PREVIEW_FIXTURE_KEY': 'synthetic-local-only', 'AWS_EC2_METADATA_DISABLED': 'true'}
    if kind == 'word':
        env['ATUM_WORD_COMPANION'] = '1'
    launch = """
import socket
connect = socket.socket.connect
connect_ex = socket.socket.connect_ex
def local(address):
    return not isinstance(address, tuple) or address[0] in {'127.0.0.1', 'localhost', '::1'}
def guarded(self, address):
    if not local(address):
        raise OSError('fixture refuses non-loopback networking')
    return connect(self, address)
def guarded_ex(self, address):
    return connect_ex(self, address) if local(address) else 111
socket.socket.connect = guarded
socket.socket.connect_ex = guarded_ex
from tui_gateway.entry import main
main()
"""
    frames = queue.Queue()
    with (tmp_path / 'gateway.stderr').open('w') as stderr:
        child = subprocess.Popen([sys.executable, '-c', launch], cwd=home, env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
        reader = threading.Thread(target=lambda: [frames.put(line) for line in child.stdout], daemon=True)
        reader.start()
        try:
            def read():
                return json.loads(frames.get(timeout=25))

            ready = read()
            assert ready['params']['type'] == 'gateway.ready'
            child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'session.create',
                                         'params': {'source': 'matrix', 'cwd': str(home), 'async_delivery': False}}) + '\n')
            child.stdin.flush()
            while True:
                response = read()
                if response.get('id') == 1:
                    break
            assert 'error' not in response, response
            session = response['result']
            assert session['async_delivery'] is False
            child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'prompt.submit',
                                         'params': {'session_id': session['session_id'], 'text': 'Offer a web preview.'}}) + '\n')
            child.stdin.flush()
            events = []
            output = ''
            word_ref = None
            while True:
                frame = read()
                if frame.get('method') == 'event':
                    event = frame['params']
                    events.append(event)
                    assert event['type'] != 'error', event
                    if kind == 'word' and event['type'] == 'word.document.request':
                        start = next(e for e in events if e['type'] == 'message.start')
                        assert event['session_id'] == session['session_id']
                        assert event['payload']['turn_id'] == start['payload']['turn_id']
                        word_ref = {'request_id': event['payload']['request_id'], 'session_id': session['session_id'],
                                    'turn_id': start['payload']['turn_id']}
                        child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 3, 'method': 'word.document.resolve',
                                                     'params': word_ref}) + '\n')
                        child.stdin.flush()
                    if kind == 'terminal' and event['type'] == 'agent.terminal.output':
                        output += event['payload']['chunk']
                    if kind == 'terminal' and event['type'] == 'terminal.read.request':
                        assert event['session_id'] == session['session_id']
                        start = next(e for e in events if e['type'] == 'message.start')
                        assert event['payload']['turn_id'] == start['payload']['turn_id']
                        # The actual Chromium/xterm proof validates this renderer projection separately.
                        text = output.replace('\x1b[32m', '').replace('\x1b[0m', '').strip()
                        assert 'TERM_PROOF' in text
                        reply = {'total_lines': 24, 'start': 0, 'end': 24, 'viewport_rows': 24,
                                 'cursor_row': 1, 'text': text}
                        child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 3, 'method': 'terminal.read.respond',
                            'params': {'request_id': event['payload']['request_id'], 'session_id': session['session_id'],
                                       'turn_id': start['payload']['turn_id'], 'text': json.dumps(reply)}}) + '\n')
                        child.stdin.flush()
                    if event['type'] == 'message.complete':
                        break
                elif frame.get('id') == 2:
                    assert 'error' not in frame, frame
                elif kind == 'word' and frame.get('id') == 3:
                    assert 'error' not in frame, frame
                    assert frame['result']['action'] == 'read'
                    assert frame['result']['durable_session_id'] == session['stored_session_id']
                    assert frame['result']['expires_at'] > 0
                    # Real Word/controller proof exercises the Apple Events leg separately.
                    receipt = {'text': 'WORD_PROOF unsaved', 'revision': 'native-revision', 'saved': False,
                               'selection': {'text': 'WORD_PROOF', 'start': 0, 'end': 10}}
                    child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 4, 'method': 'word.document.respond',
                                                 'params': {**word_ref, 'result': json.dumps(receipt)}}) + '\n')
                    child.stdin.flush()
            start = next(event for event in events if event['type'] == 'message.start')
            assert events[-1]['payload']['text'] == 'Your preview is ready.'
            assert len(wires) == (2 if kind in {'preview', 'word'} else 4)
            assert all(wires[0]['messages'][0] == wire['messages'][0] for wire in wires)
            assert all(wires[0]['tools'] == wire['tools'] for wire in wires)
            if kind == 'preview':
                previews = [event for event in events if event['type'] == 'preview.open']
                assert len(previews) == 1
                assert previews[0]['session_id'] == start['session_id'] == session['session_id']
                assert previews[0]['payload'] == {'url': TARGET, 'label': 'A web preview',
                                                 'turn_id': start['payload']['turn_id']}
                assert any(tool['function']['name'] == 'open_preview' for tool in wires[0]['tools'])
                assert 'requested' in wires[1]['messages'][-1]['content']
            elif kind == 'word':
                assert any(tool['function']['name'] == 'word_document' for tool in wires[0]['tools'])
                result = json.loads(wires[1]['messages'][-1]['content'])
                assert result['text'] == 'WORD_PROOF unsaved' and result['saved'] is False
                assert result['selection']['text'] == 'WORD_PROOF'
            else:
                output_events = [e for e in events if e['type'] == 'agent.terminal.output']
                assert output_events and all(e['session_id'] == session['session_id'] for e in output_events)
                tool_results = [m for m in wires[-1]['messages'] if m.get('role') == 'tool']
                results = {m['name']: json.loads(m['content']) for m in tool_results}
                assert 'TERM_PROOF' in results['read_terminal']['text']
                assert results['close_terminal'].get('status') == 'ok', results
                assert results['close_terminal']['closed'] == results['terminal']['session_id']
                closes = [e for e in events if e['type'] == 'terminal.close']
                assert len(closes) == 1 and closes[0]['session_id'] == session['session_id']
                assert closes[0]['payload']['process_id'] == results['terminal']['session_id']
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            child.stdout.close()
            reader.join(timeout=2)
            provider.shutdown()
            provider.server_close()
            thread.join(timeout=2)
