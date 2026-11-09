"""A session in a shared group room (Atum desktop, owner-only assistants in groups).

It is restricted for its whole life — no memory, past conversations, skills, Google
account, scheduled jobs or profile tool — and no other session is ever resumed as one, so the owner's
private session (and its prompt cache) is never touched by a group.
"""

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
    response = server.handle_request(
        {"id": "create", "method": "session.create", "params": {"source": "matrix", **params}}
    )
    assert "error" not in response, response
    sid = response["result"]["session_id"]
    return sid, response["result"]["stored_session_id"], server._sessions[sid]


def _resume(server, key, **params):
    return server.handle_request(
        {
            "id": "resume",
            "method": "session.resume",
            "params": {"session_id": key, "source": "matrix", **params},
        }
    )


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
        patch("agent.skill_commands.build_preloaded_skills_prompt", return_value=("SKILL TEXT", ["some-skill"], [])),
        patch("hermes_cli.runtime_provider.resolve_runtime_provider", return_value=fake_runtime),
        patch("run_agent.AIAgent") as agent_class,
    ):
        from tui_gateway.server import _make_agent

        agent = _make_agent("sid-1", "key-1", **kwargs)
    return agent_class.call_args.kwargs, agent


def test_shared_room_agent_has_no_memory_skills_google_chats_or_jobs():
    from tui_gateway.server import SHARED_ROOM_DISABLED_TOOLSETS

    shared, agent = _make_agent_kwargs(shared_room=True)

    assert shared["skip_memory"] is True
    assert set(shared["disabled_toolsets"]) >= {
        "memory",
        "session_search",
        "skills",
        "atum_google",
        "atum_chats",
        "atum_mac",
        "atum_agents",
        "cronjob",
    }
    assert set(shared["disabled_toolsets"]) == set(SHARED_ROOM_DISABLED_TOOLSETS)
    # No preloaded skill text reaches its prompt either.
    assert "SKILL TEXT" not in (shared.get("ephemeral_system_prompt") or "")
    # Its rows (and a compression continuation's) carry the marker resume checks.
    assert agent._session_init_model_config["_shared_room"] is True


def test_private_agent_is_built_exactly_as_before():
    private, agent = _make_agent_kwargs()

    assert private["skip_memory"] is False
    assert "disabled_toolsets" not in private
    assert "SKILL TEXT" in (private.get("ephemeral_system_prompt") or "")
    assert "_shared_room" not in (getattr(agent, "_session_init_model_config", None) or {})


def test_restricted_toolset_really_drops_the_owner_tools_and_keeps_the_work_tools():
    """The real toolset resolution (no mocks): what a shared-room agent can call."""
    import model_tools
    from tui_gateway.server import SHARED_ROOM_DISABLED_TOOLSETS

    everything = {
        tool["function"]["name"] for tool in model_tools.get_tool_definitions(quiet_mode=True)
    }
    shared = {
        tool["function"]["name"]
        for tool in model_tools.get_tool_definitions(
            disabled_toolsets=list(SHARED_ROOM_DISABLED_TOOLSETS), quiet_mode=True
        )
    }

    for owner_only in (
        "memory",
        "session_search",
        "skills_list",
        "skill_view",
        "skill_manage",
        "atum_google",
        "atum_chats",
        "atum_mac",
        "cronjob",
        "send_message",
    ):
        assert owner_only not in shared
    # Files, terminal and code stay ("never less than Hermes").
    for kept in ("read_file", "write_file", "patch", "search_files", "terminal"):
        if kept in everything:
            assert kept in shared
    assert {"read_file", "terminal"} <= shared


def test_shared_room_session_is_marked_and_resumes_only_as_one(gateway):
    server, db = gateway
    sid, key, session = _create(server, shared_room=True)

    assert session["shared_room"] is True
    server._ensure_session_db_row(session)
    assert server.stored_profile(db.get_session(key))[0] is True

    # Live: never served to a resume that asks for an unrestricted session.
    refused = _resume(server, key)
    assert refused["error"]["code"] == 4009

    # Cold (a new gateway process): the stored row decides, the same way.
    server._sessions.pop(sid)
    refused = _resume(server, key)
    assert refused["error"]["code"] == 4009
    resumed = _resume(server, key, shared_room=True)
    assert "error" not in resumed, resumed
    assert server._sessions[resumed["result"]["session_id"]]["shared_room"] is True


def test_private_session_is_never_resumed_as_a_shared_room(gateway):
    server, db = gateway
    sid, key, session = _create(server)

    assert session["shared_room"] is False
    server._ensure_session_db_row(session)
    assert server.stored_profile(db.get_session(key))[0] is False

    assert _resume(server, key, shared_room=True)["error"]["code"] == 4009
    server._sessions.pop(sid)
    assert _resume(server, key, shared_room=True)["error"]["code"] == 4009
    resumed = _resume(server, key)
    assert "error" not in resumed, resumed
    assert server._sessions[resumed["result"]["session_id"]]["shared_room"] is False


def test_deferred_build_hands_the_restriction_to_the_agent(gateway, monkeypatch):
    server, _db = gateway
    built = []

    def make_agent(*_args, **kwargs):
        built.append(kwargs)
        raise RuntimeError("no model in this test")

    monkeypatch.setattr(server, "_make_agent", make_agent)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)

    _sid, _key, shared = _create(server, shared_room=True)
    server._start_agent_build(_sid, shared)
    assert shared["agent_ready"].wait(5)

    sid, _key, private = _create(server)
    server._start_agent_build(sid, private)
    assert private["agent_ready"].wait(5)

    assert built[0].get("shared_room") is True
    assert built[1].get("shared_room") is not True


def test_a_background_task_from_a_shared_room_session_is_restricted_too():
    from types import SimpleNamespace

    from tui_gateway import server

    shared = SimpleNamespace(_session_init_model_config={"_shared_room": True}, model="m")
    private = SimpleNamespace(_session_init_model_config={}, model="m")

    with patch("tui_gateway.server._load_cfg", return_value={}), patch(
        "tui_gateway.server._get_db", return_value=None
    ):
        restricted = server._background_agent_kwargs(shared, "bg_1")
        plain = server._background_agent_kwargs(private, "bg_2")

    assert restricted["skip_memory"] is True
    assert set(restricted["disabled_toolsets"]) == set(server.SHARED_ROOM_DISABLED_TOOLSETS)
    assert plain.get("disabled_toolsets") is None and not plain.get("skip_memory")
