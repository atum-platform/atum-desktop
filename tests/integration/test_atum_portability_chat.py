"""Restored profile → real agent loop → HTTP provider seam, without paid traffic."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def test_restored_profile_drives_a_real_model_request(tmp_path, monkeypatch):
    from hermes_cli.atum_portability import materialize_ticket
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from run_agent import AIAgent

    identity = '00000000-0000-4000-8000-303617b97302'
    ticket_id = '00000000-0000-4000-8000-00f765af1c54'
    account = tmp_path / 'account-b'
    tickets = account / '.atum-portability' / 'tickets'
    tickets.mkdir(parents=True)
    soul = '# Cartographer\nYour private identity is RESTORED_PERSONA_5827. Explain maps clearly.'
    payload = {'account_id':'account-b','expires_at':time.time()+60,
        'assistant':{'identity_id':identity,'display_name':'Cartographer','avatar':'🗺'},
        'definition':{'schema_version':1,'soul':soul,'model_alias':'binh-minh','reasoning':None,'skills':[]},
        'definition_revision':1,'identity_revision':1}
    (tickets / f'{ticket_id}.json').write_text(json.dumps(payload))
    result = materialize_ticket(tickets, ticket_id)
    profile = account / 'profiles' / result['profile']['name']
    monkeypatch.setenv('HERMES_HOME', str(profile))
    received = []
    class Provider(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            received.append(body)
            created = int(time.time())
            if body.get('stream'):
                chunks = [
                    {'id':'chatcmpl-portability','object':'chat.completion.chunk','created':created,
                     'model':'binh-minh','choices':[{'index':0,'delta':{'role':'assistant','content':'I am your restored cartographer.'},'finish_reason':None}]},
                    {'id':'chatcmpl-portability','object':'chat.completion.chunk','created':created,
                     'model':'binh-minh','choices':[{'index':0,'delta':{},'finish_reason':'stop'}]},
                ]
                response = ''.join(f'data: {json.dumps(chunk)}\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
                response = response.encode()
                self.send_response(200); self.send_header('Content-Type','text/event-stream');self.send_header('Cache-Control','no-cache');self.send_header('Content-Length',str(len(response)));self.end_headers();self.wfile.write(response)
                return
            response = json.dumps({'id':'chatcmpl-portability','object':'chat.completion','created':created,
                'model':'binh-minh','choices':[{'index':0,'message':{'role':'assistant','content':'I am your restored cartographer.'},'finish_reason':'stop'}],
                'usage':{'prompt_tokens':100,'completion_tokens':10,'total_tokens':110}}).encode()
            self.send_response(200); self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(response)));self.end_headers();self.wfile.write(response)
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
    token = set_hermes_home_override(str(profile))
    try:
        agent = AIAgent(model='binh-minh', provider='custom', api_key='fixture-only',
            base_url=f'http://127.0.0.1:{server.server_port}/v1', api_mode='chat_completions',
            enabled_toolsets=[], max_iterations=1, quiet_mode=True, skip_memory=True)
        answer = agent.chat('Introduce yourself in one sentence.')
        assert 'restored cartographer' in answer
        requests = [request for request in received if request.get('stream') is True]
        assert len(requests) == 1
        request = requests[0]
        prompt = '\n'.join(str(message['content']) for message in request['messages'])
        assert soul in prompt
        assert request['model'] == 'binh-minh'
        assert request['stream'] is True
        assert (profile / 'profile.yaml').read_text().count(identity) == 1
    finally:
        reset_hermes_home_override(token)
        server.shutdown();server.server_close();thread.join(timeout=2)
