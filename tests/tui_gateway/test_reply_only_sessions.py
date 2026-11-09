"""Reply-only is a fixed empty toolset, including background/preview work.

All shared/reply/pet/first-learning profile identities remain separate across
live, cold and lazy resumes. Real tool resolution exercises configured/plugin/MCP boundaries.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture()
def gateway(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tui_gateway import server

    db = SessionDB(db_path=tmp_path / "state.db")
    server._sessions.clear()
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        server, "_claim_active_session_slot", lambda *_args, **_kwargs: (None, None)
    )
    monkeypatch.setattr(server, "_resolve_model", lambda: "test/model")
    yield server, db
    server._sessions.clear()
    db.close()


def _create(server, **params):
    response = server.handle_request({
        "id": "create",
        "method": "session.create",
        "params": {"source": "matrix", **params},
    })
    assert "error" not in response, response
    sid = response["result"]["session_id"]
    return sid, response["result"]["stored_session_id"], server._sessions[sid]


def _resume(server, key, **params):
    return server.handle_request({
        "id": "resume",
        "method": "session.resume",
        "params": {"session_id": key, "source": "matrix", **params},
    })


def _make_agent_kwargs(**kwargs):
    fake_runtime = {
        "provider": "openrouter",
        "base_url": "https://example.invalid/v1",
        "api_key": "test-key",
        "api_mode": "chat_completions",
        "command": None,
        "args": None,
        "credential_pool": None,
    }
    with (
        patch("tui_gateway.server._load_cfg", return_value={"agent": {}}),
        patch("tui_gateway.server._get_db", return_value=MagicMock()),
        patch("tui_gateway.server._load_reasoning_config", return_value=None),
        patch("tui_gateway.server._load_service_tier", return_value=None),
        patch("tui_gateway.server._load_enabled_toolsets", return_value=None),
        patch("tui_gateway.server._parse_tui_skills_env", return_value=["some-skill"]),
        patch(
            "agent.skill_commands.build_preloaded_skills_prompt",
            return_value=("SKILL TEXT", ["some-skill"], []),
        ),
        patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value=fake_runtime,
        ),
        patch("run_agent.AIAgent") as agent_class,
    ):
        from tui_gateway.server import _make_agent

        if kwargs.get("first_learning"):
            agent_class.return_value.valid_tool_names = {
                "read_file",
                "search_files",
                "memory",
                "session_search",
                "skills_list",
                "skill_view",
                "atum_chats",
                "atum_mac",
                "atum_google_readonly",
            }
        agent = _make_agent("sid-1", "key-1", **kwargs)
    return agent_class.call_args.kwargs, agent


@pytest.mark.parametrize("shared_room", [False, True])
@pytest.mark.parametrize("pet_surface", [False, True])
def test_reply_only_agent_is_born_without_any_tools_or_private_context(
    shared_room, pet_surface
):
    import model_tools

    kwargs, agent = _make_agent_kwargs(
        shared_room=shared_room, reply_only=True, pet_surface=pet_surface
    )
    assert kwargs["enabled_toolsets"] == []
    assert kwargs["skip_memory"] is True
    assert kwargs["skip_context_files"] is True
    assert "SKILL TEXT" not in (kwargs.get("ephemeral_system_prompt") or "")
    assert agent._session_init_model_config["_reply_only"] is True
    assert (
        model_tools.get_tool_definitions(
            enabled_toolsets=kwargs["enabled_toolsets"], quiet_mode=True
        )
        == []
    )


def test_first_learning_agent_is_born_with_only_the_closed_learning_toolset():
    kwargs, agent = _make_agent_kwargs(first_learning=True)

    assert kwargs["enabled_toolsets"] == ["atum_first_learning"]
    assert kwargs["skip_memory"] is False
    assert kwargs["skip_context_files"] is False
    assert agent._session_init_model_config["_first_learning"] is True


@pytest.mark.parametrize(
    "flags",
    [
        {
            "shared_room": shared,
            "reply_only": reply,
            "pet_surface": pet,
            "first_learning": learning,
        }
        for shared in (False, True)
        for reply in (False, True)
        for pet in (False, True)
        for learning in (False, True)
    ],
)
def test_every_profile_is_fixed_across_live_cold_and_lazy_resume(gateway, flags):
    server, db = gateway
    sid, key, session = _create(server, **flags)
    server._ensure_session_db_row(session)
    expected = tuple(flags.values())
    assert server.live_profile(session) == expected
    assert server.stored_profile(db.get_session(key)) == expected
    for name in flags:
        other = {**flags, name: not flags[name]}
        assert _resume(server, key, **other)["error"]["code"] == 4009
        assert server.live_profile(session) == expected
    server._sessions.pop(sid)
    for name in flags:
        assert (
            _resume(server, key, **{**flags, name: not flags[name]})["error"]["code"]
            == 4009
        )
    resumed = _resume(server, key, lazy=True, **flags)
    assert "error" not in resumed, resumed
    assert (
        server.live_profile(server._sessions[resumed["result"]["session_id"]])
        == expected
    )


def test_reply_only_background_and_preview_do_not_restore_configured_tools():
    from types import SimpleNamespace
    import model_tools
    from tui_gateway import server

    agent = SimpleNamespace(
        _session_init_model_config={"_reply_only": True}, enabled_toolsets=[], model="m"
    )
    with (
        patch("tui_gateway.server._load_cfg", return_value={}),
        patch("tui_gateway.server._get_db", return_value=None),
        patch(
            "tui_gateway.server._load_enabled_toolsets",
            return_value=["terminal", "file", "skills"],
        ),
    ):
        for build in (
            server._background_agent_kwargs,
            server._ephemeral_preview_agent_kwargs,
        ):
            kwargs = build(agent, "background")
            assert kwargs["enabled_toolsets"] == []
            assert kwargs["skip_memory"] is True
            assert kwargs["skip_context_files"] is True
            assert (
                model_tools.get_tool_definitions(
                    enabled_toolsets=kwargs["enabled_toolsets"], quiet_mode=True
                )
                == []
            )


def test_deferred_build_hands_all_profile_flags_to_the_agent(gateway, monkeypatch):
    server, _db = gateway
    built = []

    def make_agent(*_args, **kwargs):
        built.append(kwargs)
        raise RuntimeError("no model in this test")

    monkeypatch.setattr(server, "_make_agent", make_agent)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    sid, _key, session = _create(
        server, shared_room=True, reply_only=True, pet_surface=True
    )
    server._start_agent_build(sid, session)
    assert session["agent_ready"].wait(5)
    assert all(
        built[0][name] is True for name in ("shared_room", "reply_only", "pet_surface")
    )


def test_profile_keys_match_the_shared_contract_and_are_distinct():
    from tui_gateway.room_session_profiles import profile_key

    keys = [
        profile_key(shared, reply, pet, learning)
        for shared in (False, True)
        for reply in (False, True)
        for pet in (False, True)
        for learning in (False, True)
    ]
    assert len(set(keys)) == len(keys)
    assert profile_key(True, True, False) == "room:shared=1:reply=1:pet=0"
    assert profile_key(True, True, False, True) == "room:shared=1:reply=1:pet=0:learn=1"


@pytest.mark.parametrize(
    "flags",
    [
        {"shared_room": shared, "reply_only": reply, "pet_surface": pet}
        for shared in (False, True)
        for reply in (False, True)
        for pet in (False, True)
    ],
)
def test_reply_pet_admission_is_fixed_for_every_profile_and_absent_from_children(
    monkeypatch, tmp_path, flags
):
    """Resolve real schemas for all eight profile rows, including child agents."""
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from tui_gateway import server
    from tui_gateway.room_session_profiles import inherit_profile

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_TUI_TOOLSETS", "pet")
    monkeypatch.setenv("ATUM_PET_INTENTS", "reply")
    monkeypatch.setattr(server, "_hermes_home", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: pet-profile-test\nagent:\n  system_prompt: ''\n"
    )
    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        lambda **_: {
            "provider": "openai",
            "base_url": "http://127.0.0.1:1/v1",
            "api_key": "test-only",
            "api_mode": "chat_completions",
            "credential_pool": None,
        },
    )
    db = SessionDB(tmp_path / "state.db")
    try:
        agent = server._make_agent("pet-profile", "pet-profile", session_db=db, **flags)
        parent_schema = json.dumps(agent.tools, sort_keys=True, separators=(",", ":"))
        import model_tools
        parent_names = {tool["function"]["name"] for tool in model_tools.get_tool_definitions(
            enabled_toolsets=agent.enabled_toolsets, disabled_toolsets=agent.disabled_toolsets,
            quiet_mode=True, skip_tool_search_assembly=True)}
        admitted = not flags["shared_room"] and not flags["reply_only"] and flags["pet_surface"]

        assert ("pet" in parent_names) is admitted
        assert hasattr(agent, "_pet_intent_buffer") is admitted
        # The tool list is constructed at birth and is stable while this
        # conversation remains in the same immutable profile.
        assert json.dumps(agent.tools, sort_keys=True, separators=(",", ":")) == parent_schema

        for build in (server._background_agent_kwargs, server._ephemeral_preview_agent_kwargs):
            child = inherit_profile(AIAgent(**build(agent, f"child-{build.__name__}")), agent)
            child_names = {tool["function"]["name"] for tool in child.tools}
            assert "pet" not in child_names
            assert not hasattr(child, "_pet_intent_buffer")
            assert {
                name: child._session_init_model_config[name]
                for name in ("_shared_room", "_reply_only", "_pet_surface")
            } == {
                "_shared_room": flags["shared_room"],
                "_reply_only": flags["reply_only"],
                "_pet_surface": flags["pet_surface"],
            }
        from tools.delegate_tool import _build_child_agent

        delegated = _build_child_agent(0, "Reply", None, None, None, 1, 1, agent)
        assert "pet" not in {tool["function"]["name"] for tool in delegated.tools}
        assert getattr(delegated, "pet_callback", None) is None
    finally:
        db.close()


@pytest.fixture()
def reply_provider():
    """Real HTTP transport returns unsolicited tools, then a words-only reply."""
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
                    delta["tool_calls"] = [
                        {**call, "index": i} for i, call in enumerate(calls)
                    ]
                for chunk in (
                    {
                        "id": "reply-test",
                        "choices": [
                            {"index": 0, "delta": delta, "finish_reason": None}
                        ],
                    },
                    {
                        "id": "reply-test",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                    },
                ):
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                payload = json.dumps({
                    "id": "reply-test",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", **message},
                            "finish_reason": finish,
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 10,
                        "total_tokens": 20,
                    },
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


@pytest.mark.parametrize("shared_room", [False, True])
@pytest.mark.parametrize("pet_surface", [False, True])
def test_real_gateway_constructor_has_no_tools_despite_configured_tools(
    monkeypatch, tmp_path, shared_room, pet_surface, reply_provider
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_TUI_TOOLSETS", "terminal,file,skills,pet")
    monkeypatch.delenv("HERMES_IGNORE_RULES", raising=False)
    from hermes_state import SessionDB
    from tui_gateway import server

    monkeypatch.setattr(server, "_hermes_home", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: reply-test-model\nagent:\n  system_prompt: ''\n"
    )
    base_url, requests, responses = reply_provider
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
    db = SessionDB(tmp_path / "state.db")
    try:
        agent = server._make_agent(
            "reply-test-sid",
            "reply-test-key",
            session_db=db,
            shared_room=shared_room,
            reply_only=True,
            pet_surface=pet_surface,
        )
        assert agent.tools == []
        assert agent.enabled_toolsets == []
        assert agent._session_init_model_config["_reply_only"] is True
        agent._ensure_db_session()
        assert server.stored_profile(db.get_session("reply-test-key")) == (
            shared_room,
            True,
            pet_surface,
            False,
        )
        from tui_gateway.room_session_profiles import inherit_profile
        from run_agent import AIAgent

        child = inherit_profile(
            AIAgent(**server._background_agent_kwargs(agent, "bg-reply")), agent
        )
        assert child.tools == []
        child._ensure_db_session()
        assert server.stored_profile(db.get_session("bg-reply")) == (
            shared_room,
            True,
            pet_surface,
            False,
        )
        for current in (agent, child):
            start = len(requests)
            responses.extend([
                {
                    "content": "",
                    "tool_calls": [
                        {
                            "id": f"call-{i}",
                            "type": "function",
                            "function": {"name": name, "arguments": "{}"},
                        }
                        for i, name in enumerate((
                            "terminal",
                            "read_file",
                            "execute_code",
                            "memory",
                            "tool_call",
                            "desktop_google",
                        ))
                    ],
                },
                {"content": "Words-only answer."},
            ])
            with patch.object(current, "_execute_tool_calls") as execute:
                result = current.run_conversation(
                    "Reply in this meeting.", conversation_history=[]
                )
                execute.assert_not_called()
            assert result["final_response"] == "Words-only answer."
            assert all(not request.get("tools") for request in requests[start:])
            rejected = [
                message
                for message in result["messages"]
                if message.get("role") == "tool"
            ]
            assert len(rejected) == 6
            assert all(
                message["name"] in message["content"]
                and "does not exist" in message["content"]
                for message in rejected
            )
    finally:
        db.close()
