"""Tests for CodexEventProjector — codex item/* events → Hermes messages list.

Drives projection against fixture notifications captured from codex 0.130.0
plus synthetic ones for item types we couldn't auth-test live."""

from __future__ import annotations

import json

import pytest

from agent.transports.codex_event_projector import (
    CodexEventProjector,
    _deterministic_call_id,
    _format_tool_args,
)


# --- Fixture: real `commandExecution` notification captured from codex 0.130.0
COMMAND_EXEC_COMPLETED = {
    "method": "item/completed",
    "params": {
        "item": {
            "type": "commandExecution",
            "id": "00000000-0000-4000-8000-610b81fb7d4f",
            "command": "/bin/bash -lc 'echo hello && ls /tmp | head -3'",
            "cwd": "/tmp",
            "processId": None,
            "source": "userShell",
            "status": "completed",
            "commandActions": [
                {"type": "listFiles", "command": "ls /tmp", "path": "tmp"}
            ],
            "aggregatedOutput": "hello\naa_lang.json\n",
            "exitCode": 0,
            "durationMs": 10,
        },
        "threadId": "00000000-0000-4000-8000-000000000903",
        "turnId": "00000000-0000-4000-8000-000000000904",
        "completedAtMs": 1778562381151,
    },
}


class TestProjectionInvariants:
    """Universal invariants that must hold across all projection paths."""

    def test_streaming_deltas_dont_materialize(self) -> None:
        p = CodexEventProjector()
        for delta_method in (
            "item/commandExecution/outputDelta",
            "item/agentMessage/delta",
            "item/reasoning/delta",
        ):
            r = p.project({"method": delta_method, "params": {"delta": "x"}})
            assert r.messages == [], (
                f"{delta_method} should NOT produce messages — only "
                f"item/completed materializes"
            )
            assert r.is_tool_iteration is False
            assert r.final_text is None

    def test_turn_started_and_completed_are_silent(self) -> None:
        p = CodexEventProjector()
        for method in ("turn/started", "turn/completed", "thread/started"):
            r = p.project({"method": method, "params": {}})
            assert r.messages == []

    def test_unknown_method_silent(self) -> None:
        p = CodexEventProjector()
        r = p.project({"method": "totally/unknown", "params": {}})
        assert r.messages == []


class TestCommandExecutionProjection:
    """Real captured notification → assistant tool_call + tool result."""

    def test_command_completed_produces_two_messages(self) -> None:
        p = CodexEventProjector()
        r = p.project(COMMAND_EXEC_COMPLETED)
        assert len(r.messages) == 2
        assert r.is_tool_iteration is True

    def test_first_message_is_assistant_tool_call(self) -> None:
        p = CodexEventProjector()
        msgs = p.project(COMMAND_EXEC_COMPLETED).messages
        assistant = msgs[0]
        assert assistant["role"] == "assistant"
        assert assistant["content"] is None
        assert len(assistant["tool_calls"]) == 1
        tc = assistant["tool_calls"][0]
        assert tc["type"] == "function"
        assert tc["function"]["name"] == "exec_command"
        args = json.loads(tc["function"]["arguments"])
        assert "echo hello" in args["command"]
        assert args["cwd"] == "/tmp"

    def test_second_message_is_tool_result_correlating_by_id(self) -> None:
        p = CodexEventProjector()
        msgs = p.project(COMMAND_EXEC_COMPLETED).messages
        assistant, tool = msgs
        assert tool["role"] == "tool"
        assert tool["tool_call_id"] == assistant["tool_calls"][0]["id"]
        assert "hello" in tool["content"]

    def test_nonzero_exit_code_annotated_in_tool_result(self) -> None:
        item = {**COMMAND_EXEC_COMPLETED["params"]["item"], "exitCode": 2,
                "aggregatedOutput": "boom"}
        notif = {
            "method": "item/completed",
            "params": {**COMMAND_EXEC_COMPLETED["params"], "item": item},
        }
        p = CodexEventProjector()
        msgs = p.project(notif).messages
        payload = json.loads(msgs[1]["content"])
        assert payload == {"exit_code": 2, "output": "boom"}
        assert "boom" in msgs[1]["content"]

    def test_deterministic_call_id_across_replay(self) -> None:
        # Same item id → same call_id (prefix cache must stay valid).
        p1 = CodexEventProjector()
        p2 = CodexEventProjector()
        a = p1.project(COMMAND_EXEC_COMPLETED).messages
        b = p2.project(COMMAND_EXEC_COMPLETED).messages
        assert a[0]["tool_calls"][0]["id"] == b[0]["tool_calls"][0]["id"]


class TestAgentMessageProjection:
    """assistant text → final_text + assistant message."""

    def test_agent_message_projects_to_assistant(self) -> None:
        p = CodexEventProjector()
        r = p.project({
            "method": "item/completed",
            "params": {"item": {"type": "agentMessage", "id": "x",
                                "text": "hi there"}},
        })
        assert r.final_text == "hi there"
        assert r.messages == [{"role": "assistant", "content": "hi there"}]
        assert r.is_tool_iteration is False

    def test_pending_reasoning_attaches_to_next_assistant_message(self) -> None:
        p = CodexEventProjector()
        # First a reasoning item lands
        r1 = p.project({
            "method": "item/completed",
            "params": {"item": {"type": "reasoning", "id": "r1",
                                "summary": ["thinking..."],
                                "content": ["step 1", "step 2"]}},
        })
        assert r1.messages == []  # reasoning alone produces no message
        # Then the assistant message
        r2 = p.project({
            "method": "item/completed",
            "params": {"item": {"type": "agentMessage", "id": "a1",
                                "text": "ok"}},
        })
        assistant = r2.messages[0]
        assert "reasoning" in assistant
        assert "thinking" in assistant["reasoning"]
        assert "step 1" in assistant["reasoning"]

    def test_reasoning_consumed_after_attaching(self) -> None:
        p = CodexEventProjector()
        p.project({"method": "item/completed", "params": {"item": {
            "type": "reasoning", "id": "r1", "summary": ["once"], "content": []}}})
        first = p.project({"method": "item/completed", "params": {"item": {
            "type": "agentMessage", "id": "a", "text": "first"}}}).messages[0]
        second = p.project({"method": "item/completed", "params": {"item": {
            "type": "agentMessage", "id": "b", "text": "second"}}}).messages[0]
        assert "reasoning" in first
        assert "reasoning" not in second


class TestFileChangeProjection:
    def test_file_change_summary_no_inlined_content(self) -> None:
        item = {
            "type": "fileChange",
            "id": "fc1",
            "status": "applied",
            "changes": [
                {"kind": {"type": "add"}, "path": "/tmp/new.py"},
                {"kind": {"type": "update"}, "path": "/tmp/old.py"},
            ],
        }
        p = CodexEventProjector()
        msgs = p.project({"method": "item/completed",
                          "params": {"item": item}}).messages
        assert len(msgs) == 2
        tc = msgs[0]["tool_calls"][0]
        assert tc["function"]["name"] == "apply_patch"
        args = json.loads(tc["function"]["arguments"])
        assert len(args["changes"]) == 2
        assert all("kind" in c and "path" in c for c in args["changes"])
        assert "applied" in msgs[1]["content"]


class TestMcpToolCallProjection:
    def test_mcp_tool_call_namespaced(self) -> None:
        item = {
            "type": "mcpToolCall",
            "id": "m1",
            "server": "obsidian",
            "tool": "search_notes",
            "status": "completed",
            "arguments": {"query": "hermes"},
            "result": {"content": [{"text": "found"}]},
            "error": None,
        }
        msgs = CodexEventProjector().project(
            {"method": "item/completed", "params": {"item": item}}
        ).messages
        assert msgs[0]["tool_calls"][0]["function"]["name"] == "mcp.obsidian.search_notes"
        assert "found" in msgs[1]["content"]

    def test_mcp_error_surfaced(self) -> None:
        item = {
            "type": "mcpToolCall", "id": "m2",
            "server": "x", "tool": "y", "status": "failed",
            "arguments": {}, "result": None,
            "error": {"code": -1, "message": "no"},
        }
        msgs = CodexEventProjector().project(
            {"method": "item/completed", "params": {"item": item}}
        ).messages
        assert "error" in msgs[1]["content"]


class TestUserWebSearchAndOpaqueProjection:
    def test_expected_initial_user_echo_is_ignored_once(self) -> None:
        item = {
            "type": "userMessage", "id": "u1",
            "content": [
                {"type": "text", "text": "hello"},
                {"type": "image", "url": "http://x/y"},
                {"type": "text", "text": "world"},
            ],
        }
        projector = CodexEventProjector(expected_user_echo="hello\nworld")
        notification = {"method": "item/completed", "params": {"item": item}}

        assert projector.project(notification).messages == []
        assert projector.project(notification).messages == [
            {"role": "user", "content": "hello\nworld"}
        ]

    def test_unowned_user_message_projects_for_mid_turn_steer(self) -> None:
        item = {
            "type": "userMessage",
            "id": "steer-1",
            "content": [{"type": "text", "text": "use the v2 API instead"}],
        }
        msgs = CodexEventProjector(expected_user_echo="original prompt").project(
            {"method": "item/completed", "params": {"item": item}}
        ).messages
        assert msgs == [{"role": "user", "content": "use the v2 API instead"}]

    def test_web_search_projects_as_a_structured_tool_call(self) -> None:
        item = {
            "type": "webSearch",
            "id": "search-1",
            "query": "popular Hermes forks",
            "action": {"type": "search", "query": "popular Hermes forks"},
            "status": "completed",
        }
        msgs = CodexEventProjector().project(
            {"method": "item/completed", "params": {"item": item}}
        ).messages

        assert len(msgs) == 2
        assistant, tool = msgs
        tool_call = assistant["tool_calls"][0]
        assert assistant["role"] == "assistant"
        assert assistant["content"] is None
        assert tool_call["function"]["name"] == "web_search"
        assert json.loads(tool_call["function"]["arguments"]) == {
            "query": "popular Hermes forks"
        }
        assert tool["role"] == "tool"
        assert tool["tool_call_id"] == tool_call["id"]
        assert json.loads(tool["content"])["status"] == "completed"
        assert all("[codex webSearch]" not in str(message) for message in msgs)

    def test_web_search_consumes_pending_reasoning(self) -> None:
        projector = CodexEventProjector()
        projector.project({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "reasoning",
                    "id": "r1",
                    "summary": ["checking sources"],
                }
            },
        })
        msgs = projector.project({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "webSearch",
                    "id": "w1",
                    "query": "Hermes Agent",
                }
            },
        }).messages
        assert msgs[0]["reasoning"] == "checking sources"

    def test_opaque_item_recorded_without_fabricated_tool_calls(self) -> None:
        item = {"type": "plan", "id": "p1", "text": "do the thing"}
        msgs = CodexEventProjector().project(
            {"method": "item/completed", "params": {"item": item}}
        ).messages
        assert len(msgs) == 1
        assert msgs[0]["role"] == "assistant"
        assert "plan" in msgs[0]["content"].lower()
        assert "tool_calls" not in msgs[0]


class TestHelpers:
    def test_deterministic_call_id_stable(self) -> None:
        assert _deterministic_call_id("exec", "abc") == _deterministic_call_id("exec", "abc")
        assert _deterministic_call_id("exec", "abc") != _deterministic_call_id("exec", "xyz")

    def test_deterministic_call_id_handles_missing_id(self) -> None:
        # Should not raise, should be stable for same item type
        a = _deterministic_call_id("exec", "")
        b = _deterministic_call_id("exec", "")
        assert a == b
        assert "exec" in a

    def test_format_tool_args_sorted_keys(self) -> None:
        # Sorted keys = deterministic across replays = prefix cache stays valid
        a = _format_tool_args({"b": 1, "a": 2})
        b = _format_tool_args({"a": 2, "b": 1})
        assert a == b


class TestRoleAlternationInvariant:
    """The project must never emit two assistant messages back-to-back from
    one item — that breaks Hermes' message alternation invariant."""

    @pytest.mark.parametrize(
        "item",
        [
            {"type": "commandExecution", "id": "c1", "command": "x",
             "cwd": "/", "status": "completed", "aggregatedOutput": "",
             "exitCode": 0, "commandActions": []},
            {"type": "fileChange", "id": "f1", "status": "applied",
             "changes": []},
            {"type": "mcpToolCall", "id": "m1", "server": "s", "tool": "t",
             "status": "completed", "arguments": {}, "result": None,
             "error": None},
            {"type": "dynamicToolCall", "id": "d1", "tool": "x",
             "arguments": {}, "status": "completed",
             "contentItems": [], "success": True},
            {"type": "webSearch", "id": "w1", "query": "x",
             "action": {"type": "search", "query": "x"},
             "status": "completed"},
        ],
    )
    def test_tool_items_emit_assistant_then_tool(self, item) -> None:
        msgs = CodexEventProjector().project(
            {"method": "item/completed", "params": {"item": item}}
        ).messages
        assert len(msgs) == 2
        assert msgs[0]["role"] == "assistant"
        assert msgs[1]["role"] == "tool"
        assert msgs[1]["tool_call_id"] == msgs[0]["tool_calls"][0]["id"]
