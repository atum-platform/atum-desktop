"""A native source read fences its own execution, never the other gateway sessions."""
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import json

import pytest

from agent import atum_google_fence as fence
from gateway.session_context import scoped_current_session_id, scoped_session_key, set_session_vars
from hermes_cli.plugins import resolve_pre_tool_block
from tools.atum_google_tool import atum_google_readonly
from tools.atum_source_transport import bind_source_transport


@pytest.mark.parametrize("fence_on", [True, False])
def test_background_google_read_does_not_latch_the_gateway(monkeypatch, fence_on):
    monkeypatch.setattr(fence, "_holding", False)
    monkeypatch.delenv(fence.LATCHED_ENV, raising=False)
    if fence_on:
        monkeypatch.setenv(fence.ROUTE_ENV, "http://127.0.0.1:43123/v1")
    else:
        monkeypatch.delenv(fence.ROUTE_ENV, raising=False)
    set_session_vars(session_key="cron-fixture", session_id="cron-fixture", cron_session="1")
    tools = ("web_search", "browser_navigate", "send_message")
    with bind_source_transport(lambda *_: {"events": [{"title": "Private review"}]}):
        copied = copy_context()
        # Native cron uses copied worker contexts; the result must fence the parent
        # execution too, not just whichever thread happened to receive it.
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(copied.run, atum_google_readonly, {"action": "agenda"}).result(timeout=10)
        assert "events" in json.loads(result)
        for tool in tools:
            assert bool(resolve_pre_tool_block(tool, {})) is fence_on
        with scoped_session_key("owner-dm"), scoped_current_session_id("owner-session"):
            for tool in tools:
                assert resolve_pre_tool_block(tool, {}) is None
        assert fence.holding_google() is fence_on
    for tool in tools:
        assert resolve_pre_tool_block(tool, {}) is None
    # Closing authority does not un-fence a late worker that already holds data.
    assert copied.run(fence.holding_google) is fence_on


def test_separate_source_runs_do_not_share_the_holding_state(monkeypatch):
    monkeypatch.setattr(fence, "_holding", False)
    monkeypatch.setenv(fence.ROUTE_ENV, "http://127.0.0.1:43123/v1")
    monkeypatch.delenv(fence.LATCHED_ENV, raising=False)
    with scoped_session_key("run-a"), scoped_current_session_id("run-a"):
        with bind_source_transport(lambda *_: {"events": []}):
            assert "events" in json.loads(atum_google_readonly({"action": "agenda"}))
            assert fence.holding_google()
    with scoped_session_key("run-b"), scoped_current_session_id("run-b"):
        with bind_source_transport(lambda *_: {"events": []}):
            assert not fence.holding_google()
            assert resolve_pre_tool_block("web_search", {}) is None


def test_nested_binding_cannot_clear_its_session_fence(monkeypatch):
    monkeypatch.setattr(fence, "_holding", False)
    monkeypatch.setenv(fence.ROUTE_ENV, "http://127.0.0.1:43123/v1")
    monkeypatch.delenv(fence.LATCHED_ENV, raising=False)
    with scoped_current_session_id("same-session"):
        with bind_source_transport(lambda *_: {"events": []}):
            assert "events" in json.loads(atum_google_readonly({"action": "agenda"}))
            with bind_source_transport(lambda *_: {"events": []}):
                assert resolve_pre_tool_block("web_search", {}) == fence.EGRESS_MESSAGE
            assert fence.holding_google()
