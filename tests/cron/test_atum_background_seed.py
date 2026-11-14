"""A seeded native cron record, real agent loop/catalog, and execution-bound sources."""
from contextvars import copy_context
from copy import deepcopy
from concurrent.futures import Future
import asyncio
import json
from unittest.mock import MagicMock

import pytest

from cron import jobs, scheduler, scheduler_delivery
from gateway.config import Platform, PlatformConfig
from gateway.session_context import scoped_current_session_id, scoped_session_key
from tools import atum_source_transport as sources


def _answer(name=None, arguments=None):
    from openai.types.chat import ChatCompletion

    message = {"role": "assistant", "content": "Your review is at 09:00."}
    if name:
        message = {"role": "assistant", "content": None, "tool_calls": [{
            "id": f"call_{name}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }]}
    return ChatCompletion.model_validate({
        "id": "fixture", "object": "chat.completion", "created": 1, "model": "test-model",
        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if name else "stop"}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
    })


def test_seeded_background_job_loads_stable_readonly_tools_and_session_sources(tmp_path, monkeypatch):
    from model_tools import get_tool_definitions, handle_function_call
    from run_agent import AIAgent
    from tools import atum_chats_tool as chats, atum_google_tool as google
    from tools.registry import invalidate_check_fn_cache
    from tools.skills_tool import clear_skills_cache

    home = tmp_path / "home"
    home.mkdir()
    skill_dir = tmp_path / "persona" / "skills" / "fixture-brief"
    skill_dir.mkdir(parents=True)
    marker = "Morning Brief Fixture: read sources, then offer a short next step."
    (skill_dir / "SKILL.md").write_text(
        "---\nname: fixture-brief\ndescription: Read a short morning brief.\n---\n" + marker)
    (home / "config.yaml").write_text(json.dumps({
        "timezone": "Asia/Ho_Chi_Minh",
        "model": {"context_length": 75000},
        "agent": {"max_turns": 4},
        "skills": {"external_dirs": [str(skill_dir.parent)]},
        "tools": {"tool_search": {"enabled": False}},
        "mcp_servers": {"fixture": {"command": "must-not-execute"}},
    }))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_MODEL", "test-model")
    monkeypatch.setenv("MATRIX_ACCESS_TOKEN", "offline-fixture")
    monkeypatch.delenv(google.URL_ENV, raising=False)
    monkeypatch.delenv(google.TOKEN_ENV, raising=False)
    monkeypatch.setattr(chats.desktop_ui, "_request", None)
    monkeypatch.setattr(chats.desktop_ui, "_emit", None)
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: home)
    monkeypatch.setattr(scheduler, "get_fallback_chain", lambda _: [])
    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider", lambda **_: {
        "api_key": "fixture", "provider": "openai-compat", "base_url": "http://127.0.0.1:1/v1",
        "api_mode": "chat_completions", "command": None, "args": None})
    monkeypatch.setattr("agent.title_generator.maybe_auto_title", lambda *_, **__: None)
    # No MCP process or model network request may run. Resolution still sees an
    # enabled MCP entry and must remove it via the native no_mcp job sentinel.
    monkeypatch.setattr("tools.mcp_tool_discovery.discover_mcp_tools", list)
    monkeypatch.setattr(sources, "_host_transport_enabled", False)
    sources.enable_source_transport()
    invalidate_check_fn_cache()
    clear_skills_cache()
    reads, requests, inherited = [], [], []

    def source(tool, payload):
        reads.append((tool, payload))
        return {"events": [{"title": "Review at 09:00"}]} if tool == "google" else {
            "rooms": [{"id": "!company:fixture", "label": "Team", "kind": "group",
                       "members": ["Alex"], "memberCount": 2, "notifications": 1,
                       "highlights": None, "lastAt": None, "last": None, "encrypted": False,
                       "space": {"kind": "company", "companyId": "12345678-1234-4123-8123-123456789abc", "name": "Team"}}],
            "truncated": False}

    answers = [_answer("atum_google_readonly", {"action": "agenda"}),
               _answer("atum_chats", {"op": "list"}), _answer()]

    def model(self, request):
        requests.append(deepcopy(request))
        assert google._background_run()
        names = {t["function"]["name"] for t in request.get("tools", [])}
        assert {"atum_google_readonly", "atum_chats", "session_search", "read_file"} <= names
        assert names <= {"atum_google_readonly", "atum_chats", "atum_mac", "session_search",
                         "read_file", "search_files", "skills_list", "skill_view"}
        assert marker in json.dumps(request["messages"])
        count = len(reads)
        # Even an inherited binding must refuse when a worker is rebound to
        # another room/session; it must never borrow the admitted owner's source.
        with scoped_session_key("other-room"), scoped_current_session_id("other-session"):
            for name, args in (("atum_google_readonly", {"action": "agenda"}), ("atum_chats", {"op": "list"})):
                assert "unavailable for this run" in json.loads(handle_function_call(name, args))["error"]
        assert len(reads) == count
        return answers.pop(0)

    monkeypatch.setattr(AIAgent, "_interruptible_api_call", model)
    native_construct = scheduler._construct_cron_agent

    def construct(*args, **kwargs):
        agent = native_construct(*args, **kwargs)
        agent._disable_streaming = True  # Only the complete-response model boundary is replaced.
        return agent

    monkeypatch.setattr(scheduler, "_construct_cron_agent", construct)
    native_watchdog = scheduler._run_agent_with_watchdog

    def bound_watchdog(*args, **kwargs):
        # Trusted plugin seam: after native constructor publishes session identity,
        # before the native watchdog copies it into the model worker.
        with sources.bind_source_transport(source):
            inherited.append(copy_context())
            return native_watchdog(*args, **kwargs)

    monkeypatch.setattr(scheduler, "_run_agent_with_watchdog", bound_watchdog)
    try:
        with jobs.use_cron_store(home):
            # Native seed shape, with fixture content rather than private product skills.
            job = jobs.create_job("Read sources for a short brief", "0 8 * * *", name="fixture-brief",
                                  skills=["fixture-brief"], context_from="self", deliver="origin",
                                  origin={"platform": "matrix", "chat_id": "!owner:fixture"},
                                  enabled_toolsets=["atum_background_readonly", "no_mcp"], attach_to_session=True)
            job.update(seed_key="morning-brief", seed_version=2)
            jobs.save_jobs([job])
            seeded = jobs.load_jobs()[0]
            success, _doc, final, error = scheduler.run_job(seeded, native_claimed=True)
        assert success, error
        assert final == "Your review is at 09:00."
        assert reads == [("google", {"action": "agenda"}), ("chats", {"op": "list"})]
        assert len(requests) == 3 and not answers
        tools = json.dumps(requests[0]["tools"])
        prefix = requests[0]["messages"]
        for request in requests[1:]:
            assert json.dumps(request["tools"]) == tools
            assert request["messages"][:len(prefix)] == prefix
        transcript = json.dumps(requests[-1]["messages"])
        assert "Review at 09:00" in transcript and "companyId" in transcript
        assert sources.source_transport() is None
        with pytest.raises(RuntimeError, match="operation_closed"):
            inherited[0].run(lambda: sources.source_transport()("chats", {"op": "list"}))
        assert google.available() and chats.available()  # Advertisement never follows authority lifetime.
        assert "error" in json.loads(chats.atum_chats("list"))
        after = get_tool_definitions(enabled_toolsets=["atum_background_readonly"], quiet_mode=True)
        assert {t["function"]["name"] for t in after} == {t["function"]["name"] for t in requests[0]["tools"]}
        # Resolve deliver=origin through the real delivery path, not an explicit
        # matrix target invented for this test. Only the adapter send is offline.
        sent = []
        adapter = MagicMock()

        async def send(chat_id, content, **kwargs):
            sent.append((chat_id, content))
            return {"success": True, "message_id": "$fixture-brief"}

        adapter.send = send
        config = MagicMock()
        config.platforms = {Platform.MATRIX: PlatformConfig(enabled=True)}
        config.get_home_channel = lambda _: None
        monkeypatch.setattr("gateway.config.load_gateway_config", lambda: config)
        monkeypatch.setattr(scheduler, "load_config", lambda: {"cron": {"wrap_response": False}})

        def run_coro(coro, loop):
            result = Future()
            result.set_result(asyncio.run(coro))
            return result

        monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", run_coro)
        loop = MagicMock()
        loop.is_running.return_value = True
        with jobs.use_cron_store(home):
            assert scheduler_delivery._deliver_result(
                seeded, final, adapters={Platform.MATRIX: adapter}, loop=loop) is None
        assert sent == [("!owner:fixture", final)]
    finally:
        clear_skills_cache()
        invalidate_check_fn_cache()
