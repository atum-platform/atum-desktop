"""Offline provider -> native callback -> JSON-RPC fixture for the Matrix adapter."""
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from agent.agent_runtime_helpers import strip_think_blocks
from agent.stream_delivery import StreamDeliveryMixin
from agent.transports.chat_completions import ChatCompletionsTransport
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tui_gateway import server


class OfflineAgent(StreamDeliveryMixin):
    _strip_think_blocks = strip_think_blocks


with tempfile.TemporaryDirectory() as home:
    Path(home, 'config.yaml').write_text('display:\n  interim_assistant_messages: true\nsecurity:\n  redact_secrets: true\n')
    token = set_hermes_home_override(home)
    try:
        frames = []
        sid = 'offline-interim'
        session = {'profile_home': home}
        with patch.dict(server._sessions, {sid: session}), patch.object(
            server, 'write_json', lambda frame: frames.append(frame) or True
        ), patch.object(server, '_load_interim_assistant_messages', return_value=True):
            agent = OfflineAgent()
            agent.interim_assistant_callback = server._agent_cbs(sid)['interim_assistant_callback']
            transport = ChatCompletionsTransport()
            secret = 'ghp_' + 'A' * 36
            tool = NS(id='call-1', type='function', function=NS(name='terminal', arguments='{}'))
            sequence = [
                NS(content=f'<think>PRIVATE ANALYSIS</think>I am checking {secret}.', tool_calls=[tool]),
                NS(content='', tool_calls=[tool]),
                NS(content='Here is the answer.', tool_calls=None),
            ]
            for message in sequence:
                message.reasoning = 'PRIVATE REASONING'
                normalized = transport.normalize_response(NS(choices=[NS(
                    message=message, finish_reason='tool_calls' if message.tool_calls else 'stop'
                )]))
                if normalized.tool_calls:
                    stored = {'role': 'assistant', 'content': normalized.content, 'reasoning': normalized.reasoning}
                    agent._emit_interim_assistant_message(stored)
                    # A repeated delivery must be deduplicated by the real native core.
                    agent._emit_interim_assistant_message(stored)
                else:
                    server._emit('message.complete', sid, {'text': normalized.content, 'status': 'complete'})
            assert len(frames) == 2, 'empty and duplicate rounds must not emit'
            assert secret not in json.dumps(frames), 'native boundary must redact credentials'
            assert 'PRIVATE' not in json.dumps(frames), 'reasoning must stay hidden'
        # tui_gateway.server points sys.stdout at stderr on import (its JSON-RPC channel); report on the real stdout.
        print(json.dumps(frames), file=sys.__stdout__, flush=True)
    finally:
        reset_hermes_home_override(token)
