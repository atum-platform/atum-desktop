"""Synthetic child for shared-profile feasibility; not a product executor."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import socket
from urllib.parse import urlparse

# Parent selects HOME/HERMES_HOME/cwd and a minimal environment before Python
# starts. The observer is installed before ANY Hermes import.
scenario = json.loads(sys.stdin.read())
private_root = Path(scenario['private_root']).resolve()
private_paths = {Path(p).resolve() for p in scenario.get('private_paths', [])}
shared_root = Path(os.environ['HOME']).resolve()
accesses = []
other_accesses = set()
sqlite_paths = set()
violations = []
network_traces = []
subprocesses = []
live = scenario.get('live', False)
endpoint = urlparse(scenario.get('base_url', 'https://fixture.invalid/v1'))
# Resolve only the explicitly selected provider before importing Hermes.
allowed_ips = {entry[4][0] for entry in socket.getaddrinfo(endpoint.hostname, endpoint.port or 443)} if live else set()


def audit(event, args):
    if event not in ('open', 'sqlite3.connect', 'subprocess.Popen', 'socket.connect'):
        return
    if event == 'socket.connect':
        address = args[1]
        if live and isinstance(address, tuple) and address[0] in allowed_ips and address[1] == (endpoint.port or 443):
            return
        violations.append('unexpected_network:' + repr(address))
        frame = sys._getframe(1)
        trace = []
        while frame is not None:
            trace.append(f'{Path(frame.f_code.co_filename).name}:{frame.f_lineno}:{frame.f_code.co_name}')
            frame = frame.f_back
        network_traces.append(trace)
        raise PermissionError('Fixture has no network transport')
    if event == 'subprocess.Popen':
        # Python's platform.architecture inspects its own interpreter. This
        # reads installed runtime code, not profile data, and is not an agent tool.
        if (isinstance(args[1], list) and len(args[1]) == 3 and args[1][:2] == ['file', '-b']
                and os.path.realpath(args[1][2]) == os.path.realpath(sys.executable)):
            subprocesses.append('interpreter_format_probe')
            return
        # OpenAI's HTTP client identifies its runtime CPU through Python's
        # platform module. Exact no-argument-data probe; no agent tools or shell.
        if live and args[1] == ['uname', '-p']:
            subprocesses.append('runtime_cpu_probe')
            return
        violations.append('unexpected_subprocess:' + repr(args[1]))
        raise PermissionError('Discussion fixture has no subprocess tools')
    raw = args[0]
    if not isinstance(raw, (str, os.PathLike)) or str(raw) == ':memory:':
        return
    path = Path(raw).resolve()
    if event == 'sqlite3.connect':
        sqlite_paths.add(str(path))
    if path in private_paths:
        violations.append('private_profile_location')
        raise PermissionError('Private fixture at normal profile location')
    if path.is_relative_to(private_root):
        violations.append('private:' + str(path.relative_to(private_root)))
        raise PermissionError('Private fixture access denied and recorded')
    # Even if an operator has a repository .env, never read it in this proof.
    if path.name == '.env' and not path.is_relative_to(shared_root):
        violations.append('external_dotenv')
        raise PermissionError('External dotenv is outside the fixture')
    if path.is_relative_to(shared_root):
        accesses.append({'event': event, 'path': str(path.relative_to(shared_root))})
    else:
        other_accesses.add((event, str(path)))


sys.addaudithook(audit)

import copy
from types import SimpleNamespace
from unittest.mock import MagicMock
import run_agent
import agent.model_metadata
from hermes_constants import get_hermes_home

requests = []
responses = list(scenario.get('responses', []))


def completion(**kwargs):
    requests.append(copy.deepcopy(kwargs))
    kind = responses.pop(0) if responses else 'reply'
    calls = None
    if kind == 'forged_tool':
        calls = [SimpleNamespace(id='forged', type='function', function=SimpleNamespace(
            name='read_file', arguments=json.dumps({'path': os.path.relpath(private_root / 'private-note.txt', Path.cwd())})))]
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=None if calls else 'Harbor fixture reply. Steady steps.', tool_calls=calls),
        finish_reason='tool_calls' if calls else 'stop',
    )], model='fixture/owned-advisor', usage=None)


client = MagicMock()
client.chat.completions.create.side_effect = completion
if not live:
    run_agent.OpenAI = lambda **kwargs: client
agent.model_metadata.fetch_model_metadata = lambda *args, **kwargs: {}
stream_deltas = []
agent = run_agent.AIAgent(
    api_key=os.environ['SHARED_MODEL_API_KEY'], base_url=scenario.get('base_url', 'https://fixture.invalid/v1'),
    provider=scenario.get('provider', 'openrouter'), api_mode='chat_completions', platform='cli',
    model=scenario.get('model', 'fixture/owned-advisor'), max_iterations=3, quiet_mode=True,
    skip_memory=True, skip_context_files=True, load_soul_identity=True,
    enabled_toolsets=[], session_db=None, session_id='synthetic-shared-child',
    save_trajectories=False,
    stream_delta_callback=stream_deltas.append if scenario.get('streaming') else None,
)
agent._persist_disabled = True
provider_responses = []
if live:
    # Hermes creates request-scoped clients. Observe the real SDK method for
    # every client; an instance-only spy silently misses the actual requests.
    from openai.resources.chat.completions import Completions
    agent._disable_streaming = not scenario.get('streaming', False)
    real_completion = Completions.create
    def observed_completion(self, **kwargs):
        requests.append(copy.deepcopy(kwargs))
        result = real_completion(self, **kwargs)
        if kwargs.get('stream'):
            class ObservedStream:
                def __iter__(self):
                    for chunk in result:
                        provider_responses.append(chunk.model_dump())
                        yield chunk
                def __getattr__(self, name):
                    return getattr(result, name)
            return ObservedStream()
        provider_responses.append(result.model_dump())
        return result
    Completions.create = observed_completion
first = agent.run_conversation(scenario['message'])
second = first if scenario.get('single_turn') else agent.run_conversation('What did Sam suggest?', conversation_history=first['messages'])
# Return synthetic captures, not environment values or host identifiers.
print('SHARED_PROOF=' + json.dumps({
    'final_response': first.get('final_response'), 'provider_responses': provider_responses,
    'stream_deltas': stream_deltas,
    'requests': requests, 'valid_tools': sorted(agent.valid_tool_names),
    'violations': violations, 'shared_accesses': accesses, 'subprocesses': subprocesses,
    'network_traces': network_traces,
    'other_accesses': sorted(other_accesses), 'sqlite_paths': sorted(sqlite_paths),
    'resolved_home': str(get_hermes_home()), 'module_home': str(run_agent._hermes_home),
    'session_db_attached': agent._session_db is not None,
    'credential_names': sorted(key for key in os.environ if key.endswith(('_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD'))),
    'completed': bool(first.get('completed')) and bool(second.get('completed')),
}, default=str))
