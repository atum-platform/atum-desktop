"""Gateway-owned lifecycle tests for reply pet intents.

These exercise the real prompt runner: the collector is bound after a turn has
an ID, its callback reaches the existing pet tool, and only a completed reply
can carry the drained intents.
"""

import json
import threading
from itertools import pairwise
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest

from tui_gateway.pet_intents import PetIntentBuffer
from agent.request_checkpoint import CheckpointSuperseded


@pytest.fixture()
def localhost_provider():
    """A real OpenAI-compatible transport with scripted tool-call responses."""
    requests = []
    responses = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if not self.path.endswith("/chat/completions"):
                self.send_error(404)
                return
            requests.append(request)
            message = responses.pop(0)
            calls = message.get("tool_calls", [])
            finish = "tool_calls" if calls else "stop"
            self.send_response(200)
            if request.get("stream"):
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                delta = {"role": "assistant", "content": message.get("content", "")}
                if calls:
                    delta["tool_calls"] = [{**call, "index": index} for index, call in enumerate(calls)]
                for chunk in (
                    {"id": "pet-intent", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {"id": "pet-intent", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
                ):
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return
            payload = json.dumps({
                "id": "pet-intent",
                "choices": [{"index": 0, "message": {"role": "assistant", **message}, "finish_reason": finish}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
            }).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    http = HTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=http.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{http.server_port}/v1", requests, responses
    finally:
        http.shutdown()
        http.server_close()
        worker.join(timeout=2)


def _configure_turn_runner(server, monkeypatch, tmp_path, events):
    """Keep the real turn lifecycle while removing unrelated UI effects."""
    monkeypatch.setattr(server, "_emit", lambda name, sid, payload=None: events.append((name, sid, payload)))
    monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda *_args: None)
    monkeypatch.setattr(server, "_session_cwd", lambda _session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(server, "_session_info", lambda *_args: {})
    monkeypatch.setattr(server, "_get_usage", lambda _agent: {})
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_drain_queued_prompt", lambda *_args: False)
    monkeypatch.setattr(server, "_voice_tts_enabled", lambda: False)
    monkeypatch.setattr(server, "_load_interim_assistant_messages", lambda: False)
    monkeypatch.setattr(server, "_get_db", lambda: None)


def _session(tmp_path, agent, key="pet-turn"):
    return {
        "agent": agent,
        "async_delivery": False,
        "attached_images": [],
        "cols": 80,
        "cwd": str(tmp_path),
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": True,
        "session_key": key,
    }


def _wait(session):
    session["_run_thread"].join(timeout=10)
    assert not session["_run_thread"].is_alive()


class _TurnAgent(SimpleNamespace):
    """A turn double whose only modeled capability is its real collector."""

    def __init__(self, result, commands=()):
        super().__init__(
            model="test-model",
            provider="test-provider",
            session_id="pet-turn",
            _session_db=None,
            _pet_intent_buffer=PetIntentBuffer(),
            clear_interrupt=lambda: None,
        )
        self._result = result
        self._commands = commands
        self.callbacks = []

    def run_conversation(self, message, **_kwargs):
        callback = self.pet_callback
        self.callbacks.append(callback)
        for command in self._commands:
            assert callback(command) == {"ok": True, "queued": True}
        if isinstance(self._result, Exception):
            raise self._result
        return self._result(message)


def _complete(text="done"):
    return lambda message: {
        "final_response": text,
        "messages": [
            {"role": "user", "content": message},
            {"role": "assistant", "content": text},
        ],
    }


def _message_events(events, name):
    return [payload for event, _sid, payload in events if event == name]


def test_completed_turn_drains_deduped_intents_and_next_turn_starts_empty(
    monkeypatch, tmp_path
):
    from tui_gateway import server

    events = []
    _configure_turn_runner(server, monkeypatch, tmp_path, events)
    agent = _TurnAgent(
        _complete(),
        commands=(
            {"action": "wave"},
            {"action": "wave"},
            {"action": "go", "place": "left"},
            {"action": "sit"},
        ),
    )
    session = _session(tmp_path, agent)
    server._sessions["pet-ui"] = session

    server._run_prompt_submit("first", "pet-ui", session, "first prompt")
    _wait(session)
    first_callback = agent.callbacks[-1]

    assert _message_events(events, "message.complete")[-1]["pet_intents"] == [
        {"action": "wave"},
        {"action": "go", "place": "left"},
        {"action": "sit"},
    ]
    assert first_callback({"action": "jump"}) == {
        "ok": False,
        "reason": "no_active_pet_turn",
    }
    assert agent.pet_callback is None

    agent._commands = ()
    session["running"] = True
    server._run_prompt_submit("second", "pet-ui", session, "second prompt")
    _wait(session)

    assert "pet_intents" not in _message_events(events, "message.complete")[-1]
    assert not _message_events(events, "pet.command")


@pytest.mark.parametrize(
    "result",
    [
        lambda message: {"final_response": "stopped", "interrupted": True, "messages": []},
        lambda message: {"final_response": "failed", "error": "provider failure", "messages": []},
        RuntimeError("turn exploded"),
        CheckpointSuperseded("task_checkpoint_superseded"),
    ],
    ids=("interrupted", "failed", "exception", "superseded"),
)
def test_unsuccessful_turns_discard_queued_intents(monkeypatch, tmp_path, result):
    from tui_gateway import server

    events = []
    _configure_turn_runner(server, monkeypatch, tmp_path, events)
    agent = _TurnAgent(result, commands=({"action": "wave"},))
    session = _session(tmp_path, agent)
    server._sessions["pet-ui"] = session

    server._run_prompt_submit("failed", "pet-ui", session, "prompt")
    _wait(session)

    assert all(
        "pet_intents" not in (payload or {})
        for _event, _sid, payload in events
    )
    assert agent.pet_callback is None


def test_turn_collectors_are_isolated_between_sessions(monkeypatch, tmp_path):
    from tui_gateway import server

    events = []
    _configure_turn_runner(server, monkeypatch, tmp_path, events)
    left = _TurnAgent(_complete("left"), commands=({"action": "wave"},))
    right = _TurnAgent(_complete("right"), commands=({"action": "sit"},))
    left_session = _session(tmp_path, left, key="left")
    right_session = _session(tmp_path, right, key="right")
    server._sessions.update({"left-ui": left_session, "right-ui": right_session})

    server._run_prompt_submit("left", "left-ui", left_session, "left prompt")
    _wait(left_session)
    server._run_prompt_submit("right", "right-ui", right_session, "right prompt")
    _wait(right_session)

    complete = _message_events(events, "message.complete")
    assert complete[0]["pet_intents"] == [{"action": "wave"}]
    assert complete[1]["pet_intents"] == [{"action": "sit"}]


@pytest.mark.parametrize("deferred", [False, True])
def test_real_agent_pet_tool_reaches_completion_without_mutating_its_schema(
    monkeypatch, tmp_path, localhost_provider, deferred
):
    """Exercise the complete reply path through a real agent and HTTP transport."""
    from hermes_state import SessionDB
    from tui_gateway import server

    base_url, requests, responses = localhost_provider
    events = []
    _configure_turn_runner(server, monkeypatch, tmp_path, events)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_TUI_TOOLSETS", "pet")
    monkeypatch.setenv("ATUM_PET_INTENTS", "reply")
    monkeypatch.setattr(server, "_hermes_home", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: pet-turn-test\nagent:\n  system_prompt: ''\n"
        + f"tools:\n  tool_search:\n    enabled: {'on' if deferred else 'off'}\n"
    )
    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        lambda **_: {
            "provider": "openai",
            "base_url": base_url,
            "api_key": "test-only",
            "api_mode": "chat_completions",
            "credential_pool": None,
        },
    )
    responses.extend([
        {
            "content": "",
            "tool_calls": [{
                "id": "pet-wave",
                "type": "function",
                # The pet is an Atum direct tool under tool_search too (toolsets.ATUM_DIRECT_TOOLS):
                # the model always calls it by name, never through the deferred bridge.
                "function": {"name": "pet", "arguments": json.dumps({"action": "wave"})},
            }],
        },
        {"content": "The pet waved."},
        {"content": "A plain follow-up."},
    ])
    db = SessionDB(tmp_path / "state.db")
    try:
        agent = server._make_agent(
            "pet-ui", "pet-real-turn", session_db=db, pet_surface=True
        )
        assert "pet" in {tool["function"]["name"] for tool in agent.tools}
        schema = json.dumps(agent.tools, sort_keys=True, separators=(",", ":"))
        session = _session(tmp_path, agent, key="pet-real-turn")
        server._sessions["pet-ui"] = session

        server._run_prompt_submit("first", "pet-ui", session, "please wave")
        _wait(session)
        first = _message_events(events, "message.complete")[-1]
        assert first.get("pet_intents") == [{"action": "wave"}], _message_events(events, "tool.complete")
        assert not _message_events(events, "pet.command")
        assert agent.pet_callback is None

        session["running"] = True
        server._run_prompt_submit("second", "pet-ui", session, "just answer")
        _wait(session)
        assert "pet_intents" not in _message_events(events, "message.complete")[-1]
        assert json.dumps(agent.tools, sort_keys=True, separators=(",", ":")) == schema
        request_schemas = [
            json.dumps(request["tools"], sort_keys=True, separators=(",", ":"))
            for request in requests
        ]
        assert request_schemas and set(request_schemas) == {schema}
        system_prefixes = [message["content"] for request in requests for message in request["messages"] if message["role"] == "system"]
        assert system_prefixes and len(set(system_prefixes)) == 1
        for request in requests:
            messages = request["messages"]
            assert all(left["role"] != right["role"] for left, right in pairwise(messages) if left["role"] in {"user", "assistant"})
    finally:
        db.close()


@pytest.mark.asyncio
async def test_native_matrix_agent_completion_uses_presentation_hooks(monkeypatch, tmp_path, localhost_provider):
    """Real agent/provider/tool lifecycle, followed by native ledgered Matrix delivery."""
    import asyncio
    from unittest.mock import AsyncMock
    from gateway.config import Platform, PlatformConfig
    from gateway.platforms.event import MessageEvent
    from gateway.session import SessionSource
    from hermes_cli import plugins
    from hermes_state import SessionDB
    from plugins.platforms.matrix.adapter import MatrixAdapter
    from plugins.platforms.matrix import presentation as p
    from run_agent import AIAgent

    base_url, requests, responses = localhost_provider
    monkeypatch.setenv('ATUM_PET_INTENTS', 'reply')
    monkeypatch.setattr('agent.title_generator.maybe_auto_title', lambda *args, **kwargs: None)
    monkeypatch.setattr('agent.model_metadata.fetch_model_metadata', lambda *args, **kwargs: {})
    (tmp_path / 'config.yaml').write_text('tools:\n  tool_search:\n    enabled: false\n')
    manager = plugins.PluginManager()
    p.register_hooks(SimpleNamespace(register_hook=lambda name, fn: manager._hooks.setdefault(name, []).append(fn)))
    monkeypatch.setattr(plugins, '_delivery_manager', lambda: manager)
    responses.extend([
        {'content': '', 'tool_calls': [{'id': 'wave', 'type': 'function',
            'function': {'name': 'pet', 'arguments': '{"action":"wave"}'}}]},
        {'content': 'The native reply carries the pet intent.'},
    ])
    db = SessionDB(tmp_path / 'state.db')
    a = p.adapter_class(MatrixAdapter)(PlatformConfig(enabled=True, token='fixture', extra={}))
    a.max_message_length = 25
    a._presentation_box = p.Outbox(tmp_path / 'presentation.sqlite3')
    a._presentation_turns = {}
    a._presentation_send = AsyncMock(return_value='$progress')
    a._client = SimpleNamespace(send_message_event=AsyncMock(return_value='$answer'))
    event = MessageEvent(text='please wave', message_id='$native', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room', chat_type='dm', user_id='@owner'))
    agent = None
    try:
        agent = AIAgent(api_key='test-only', provider='openai', base_url=base_url,
            model='gpt-4.1-mini', enabled_toolsets=['pet'], platform='matrix', quiet_mode=True,
            skip_context_files=True, skip_memory=True, skip_background_review=True,
            session_id='native-pet', session_db=db)
        agent.compression_enabled = False
        schema = json.dumps(agent.tools, sort_keys=True)
        async with a.admission_presentation_scope(event, 'session', 'admission'):
            result = await asyncio.to_thread(agent.run_conversation, 'please wave')
        assert result['completed'] and not result['failed'], result
        delivered, _ = await a.send_final_ledgered(event, 'session', result['final_response'], {}, reply_to='$native')
        assert delivered.success
        sent = [call.args[2] for call in a._client.send_message_event.await_args_list]
        assert len(sent) > 1
        assert all('io.atum.pet' not in part for part in sent[:-1])
        assert sent[-1]['io.atum.pet'] == {'v': 1, 'intents': [{'action': 'wave'}]}
        assert json.dumps(agent.tools, sort_keys=True) == schema
        assert len(requests) == 2
        assert requests[0]['messages'][0] == requests[1]['messages'][0]
    finally:
        if agent:
            agent.close()
        for turn, *_ in list(a._presentation_turns.values()):
            await turn.end()
        a._presentation_box.db.close()
        db.close()


@pytest.mark.parametrize("explicit", [False, True])
def test_config_learning_keeps_explicit_session_identity_distinct(monkeypatch, tmp_path, localhost_provider, explicit):
    from hermes_state import SessionDB
    from tui_gateway import server
    from tui_gateway.room_session_profiles import stored_profile

    base_url, requests, _responses = localhost_provider
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(server, "_hermes_home", str(tmp_path))
    monkeypatch.delenv("ATUM_PET_INTENTS", raising=False)
    (tmp_path / "config.yaml").write_text(json.dumps({
        "model": {"default": "learning-fixture"}, "atum_first_learning": True,
        "platform_toolsets": {"cli": ["atum_first_learning"]},
        "tools": {"tool_search": {"enabled": "off"}},
    }))
    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider", lambda **_: {
        "provider": "openai", "base_url": base_url, "api_key": "test-only",
        "api_mode": "chat_completions", "credential_pool": None,
    })
    db = SessionDB(tmp_path / "state.db")
    try:
        server._agent_cbs("learning-ui")
        agent = server._make_agent("learning-ui", "learning-real", session_db=db, first_learning=explicit)
        assert agent.enabled_toolsets == ["atum_first_learning"]
        assert not {"terminal", "write_file", "patch"} & set(agent.valid_tool_names)
        assert (agent._session_init_model_config.get("_first_learning") is True) is explicit
        db.create_session("learning-real", "matrix", model_config=agent._session_init_model_config)
        assert stored_profile(db.get_session("learning-real"))[-1] is explicit
        assert requests == []
    finally:
        db.close()
