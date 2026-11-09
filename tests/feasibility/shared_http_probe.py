"""Real Hermes + SDK + HTTP/SSE against a synthetic local provider, no live billing."""
import json
import difflib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread

import pytest

REPO = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((REPO / 'tests/fixtures/shared-group-feasibility.json').read_text())
PUBLIC_REPLY = 'Sam suggested the riverside room; online is easier to attend. Steady steps.'


@pytest.mark.parametrize('streaming', [False, True], ids=['json', 'sse'])
def test_real_http_core_restarts_with_group_context_and_refuses_private_tools(streaming):
    wires = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            # Real pricing discovery stays on the selected custom endpoint.
            body = b'{"object":"list","data":[]}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            wires.append(request)
            denied_tool = request['messages'][-1]['role'] == 'tool'
            message = {'role': 'assistant', 'content': PUBLIC_REPLY if denied_tool else None}
            if not denied_tool:
                message['tool_calls'] = [{'id': 'forged', 'type': 'function', 'function': {
                    'name': 'read_file', 'arguments': json.dumps({'path': '../../private/private-note.txt'}),
                }}]
            finish = 'stop' if denied_tool else 'tool_calls'
            base = {'id': 'chatcmpl-shared', 'created': 1, 'model': request['model']}
            usage = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}
            self.send_response(200)
            if request.get('stream'):
                delta = dict(message)
                if 'tool_calls' in delta:
                    delta['tool_calls'] = [dict(call, index=i) for i, call in enumerate(delta['tool_calls'])]
                chunks = [
                    dict(base, object='chat.completion.chunk', choices=[{'index': 0, 'delta': delta, 'finish_reason': None}]),
                    dict(base, object='chat.completion.chunk', choices=[{'index': 0, 'delta': {}, 'finish_reason': finish}]),
                    dict(base, object='chat.completion.chunk', choices=[], usage=usage),
                ]
                body = ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
                self.send_header('Content-Type', 'text/event-stream')
            else:
                body = json.dumps(dict(base, object='chat.completion', choices=[{
                    'index': 0, 'message': message, 'finish_reason': finish,
                }], usage=usage))
                self.send_header('Content-Type', 'application/json')
            encoded = body.encode()
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        messages = list(FIXTURE['messages'])
        system_prefix = None
        # One isolated profile/workspace for this conversation and target; fresh
        # processes reuse its path so Hermes' system prefix survives a restart.
        with tempfile.TemporaryDirectory(prefix='atum-shared-http-', dir='/tmp') as directory:
            for turn in range(2):
                root = Path(directory).resolve()
                shared, private = root / 'shared', root / 'private'
                home, workspace = shared / '.hermes', shared / 'workspace'
                home.mkdir(parents=True, exist_ok=True)
                workspace.mkdir(exist_ok=True)
                private.mkdir(exist_ok=True)
                (home / 'SOUL.md').write_text(FIXTURE['persona']['text'])
                (home / 'config.yaml').write_text('agent:\n  environment_probe: false\nmodel:\n  context_length: 64000\n')
                for name, marker in FIXTURE['private_canaries'].items():
                    (private / (name + '.txt')).write_text(marker)
                (private / 'private-note.txt').write_text(FIXTURE['private_canaries']['private_file'])
                memories = home / 'memories'
                memories.mkdir(exist_ok=True)
                private_paths = [memories / 'MEMORY.md', memories / 'USER.md']
                for path, key in zip(private_paths, ['memory', 'user']):
                    path.write_text(FIXTURE['private_canaries'][key])
                before = {p: p.read_bytes() for p in [*private.iterdir(), *private_paths]}
                env = {'HOME': str(shared), 'HERMES_HOME': str(home), 'USER': 'shared', 'LOGNAME': 'shared',
                       'HOSTNAME': 'shared-fixture', 'PATH': '/usr/bin:/bin', 'PYTHONPATH': str(REPO),
                       'PYTHONDONTWRITEBYTECODE': '1', 'SHARED_MODEL_API_KEY': 'synthetic-local-only',
                       'TZ': 'UTC', 'LANG': 'C.UTF-8', 'TIRITH_ENABLED': 'false', 'AWS_EC2_METADATA_DISABLED': 'true'}
                scenario = {'private_root': str(private), 'private_paths': [str(p) for p in private_paths],
                            'live': True, 'streaming': streaming, 'single_turn': True, 'provider': 'custom',
                            'model': 'fixture/shared-core', 'base_url': f'http://127.0.0.1:{server.server_port}/v1',
                            'message': json.dumps({'messages': messages, 'context_mode': 'shared_group'})}
                child = subprocess.run([sys.executable, str(REPO / 'tests/feasibility/hermes_child.py')],
                                       input=json.dumps(scenario), cwd=workspace, env=env, text=True,
                                       capture_output=True, timeout=45)
                assert child.returncode == 0, child.stderr[-2000:]
                result = json.loads(next(line.removeprefix('SHARED_PROOF=') for line in child.stdout.splitlines()
                                         if line.startswith('SHARED_PROOF=')))
                assert result['completed'] and result['final_response'] == PUBLIC_REPLY
                assert result['violations'] == [], [trace[-6:] for trace in result['network_traces']]
                assert result['valid_tools'] == []
                assert not result['session_db_attached']
                assert result['credential_names'] == ['SHARED_MODEL_API_KEY']
                assert len(result['requests']) == 2 and result['provider_responses']
                if streaming:
                    assert ''.join(result['stream_deltas']) == PUBLIC_REPLY
                    assert all(call['stream'] for call in result['requests'])
                assert result['requests'][0]['messages'][0] == result['requests'][1]['messages'][0]
                if system_prefix is not None:
                    assert result['requests'][0]['messages'][0] == system_prefix, '\n'.join(difflib.unified_diff(
                        system_prefix['content'].splitlines(), result['requests'][0]['messages'][0]['content'].splitlines()))
                system_prefix = result['requests'][0]['messages'][0]
                assert before == {p: p.read_bytes() for p in before}
                for database in result['sqlite_paths']:
                    assert Path(database).is_relative_to(home)
                    with sqlite3.connect('file:' + database + '?mode=ro', uri=True) as connection:
                        tables = {row[0] for row in connection.execute("select name from sqlite_master where type='table'")}
                        assert not {'sessions', 'messages'} & tables
                # Restarted core receives prior canonical contributions as data.
                if turn:
                    assert PUBLIC_REPLY in json.dumps(result['requests'][0]['messages'])
                messages.extend([{'speaker': {'kind': 'assistant', 'id': FIXTURE['target_id']}, 'text': PUBLIC_REPLY},
                                 {'speaker': {'kind': 'human', 'id': FIXTURE['requester_id']}, 'text': 'What did Sam suggest?'}])
        assert len(wires) == 4
        assert all(not call.get('tools') and call['model'] == 'fixture/shared-core' for call in wires)
        assert all(marker not in json.dumps(wires) for marker in FIXTURE['private_canaries'].values())
        assert all('does not exist' in wires[i]['messages'][-1]['content'] for i in [1, 3])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
