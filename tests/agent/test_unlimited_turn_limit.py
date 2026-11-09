"""Behavior of an AIAgent whose turn cap is "unlimited" (agent.max_turns: null).

The cap reaches the agent as ``max_iterations``. These tests build real agents
(only the provider call and the tool handler are faked) and run real
conversations, so they cover the iteration budget, the loop guard, the
exhaustion path and the places that record or show the cap.
"""

import json
import sys
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agent.iteration_budget import IterationBudget
from agent.tool_guardrails import LoopCapConfig, ToolCallGuardrailConfig, ToolCallGuardrailController
from hermes_cli.config import TURN_LIMIT_UNLIMITED, resolve_turn_limit
from run_agent import AIAgent


def _tool_defs(*names):
    return [
        {
            "type": "function",
            "function": {
                "name": n,
                "description": f"{n} tool",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for n in names
    ]


def _make_agent(**kwargs):
    if "max_iterations" in kwargs:
        kwargs["max_iterations"] = resolve_turn_limit(kwargs["max_iterations"])
    with (
        patch("model_tools.get_tool_definitions", return_value=_tool_defs("web_search")),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            **kwargs,
        )
    agent.client = MagicMock()
    agent._tool_guardrails = ToolCallGuardrailController(
        ToolCallGuardrailConfig(loop_caps=LoopCapConfig(max_web_searches=0))
    )
    agent._persist_session = lambda *a, **k: None
    agent._save_trajectory = lambda *a, **k: None
    return agent


def _response(content="", tool_calls=None, finish_reason="stop"):
    msg = SimpleNamespace(
        content=content,
        tool_calls=tool_calls,
        reasoning=None,
        reasoning_content=None,
        reasoning_details=None,
    )
    resp = SimpleNamespace(
        choices=[SimpleNamespace(message=msg, finish_reason=finish_reason)], model="test/model"
    )
    resp.usage = None
    return resp


def _tool_turn(index):
    # A different argument every turn so the repeated-call guard has nothing to flag.
    call = SimpleNamespace(
        id=f"call_{uuid.uuid4().hex[:8]}",
        type="function",
        function=SimpleNamespace(name="web_search", arguments=json.dumps({"q": f"step {index}"})),
    )
    return _response(tool_calls=[call], finish_reason="tool_calls")


def _run(agent, tool_turns, *, final="done"):
    """Run one conversation: ``tool_turns`` tool-calling responses, then ``final`` as text."""
    queue = [_tool_turn(i) for i in range(tool_turns)] + [_response(content=final)]
    calls = {"n": 0}

    def _fake_api_call(api_kwargs):
        calls["n"] += 1
        if calls["n"] > agent.max_iterations:
            return _response(content="summary of what was done")
        if queue:
            return queue.pop(0)
        # Past the script (a capped agent asking for its wrap-up summary): answer in text.
        return _response(content="summary of what was done")

    agent._interruptible_api_call = _fake_api_call
    with patch("model_tools.handle_function_call", return_value="ok"):
        result = agent.run_conversation("do the long task")
    return result, calls["n"]


@pytest.mark.parametrize("raw", [None, 0, -1, "unlimited", "none", TURN_LIMIT_UNLIMITED])
def test_unlimited_spellings_become_the_sentinel_on_the_agent(raw):
    agent = _make_agent(max_iterations=raw)

    assert agent.max_iterations == TURN_LIMIT_UNLIMITED
    assert agent.iteration_budget.max_total == TURN_LIMIT_UNLIMITED
    assert agent.iteration_budget.remaining > 10**12


def test_explicit_positive_cap_is_unchanged():
    agent = _make_agent(max_iterations=30)

    assert agent.max_iterations == 30
    assert agent.iteration_budget.max_total == 30
    assert agent.iteration_budget.remaining == 30


def test_library_default_when_nothing_is_passed_is_unlimited():
    # AIAgent's native default now matches the config-level unlimited default.
    agent = _make_agent()

    assert agent.max_iterations == TURN_LIMIT_UNLIMITED


def test_unlimited_cap_is_stored_as_null_in_the_session_row():
    agent = _make_agent(max_iterations=None)
    capped = _make_agent(max_iterations=30)

    # model_config is JSON in the sessions table; 2**63-1 would reach JS readers as 9.22e18.
    assert agent._session_init_model_config["max_iterations"] is None
    assert capped._session_init_model_config["max_iterations"] == 30
    assert str(sys.maxsize) not in json.dumps(agent._session_init_model_config)


def test_a_long_task_runs_past_the_old_ninety_turn_ceiling_when_unlimited():
    agent = _make_agent(max_iterations=None)

    result, api_calls = _run(agent, tool_turns=120)

    assert result["completed"] is True
    assert result["final_response"] == "done"
    assert api_calls == 121
    assert result["api_calls"] == 121
    assert "max_iterations_reached" not in str(result.get("turn_exit_reason"))


def test_a_finite_cap_still_stops_the_same_task():
    agent = _make_agent(max_iterations=30)

    result, api_calls = _run(agent, tool_turns=120)

    assert result["completed"] is False
    assert str(result["turn_exit_reason"]).startswith("max_iterations_reached(30/30)")
    # The wrap-up summary is a separate toolless request, not a counted turn.
    assert api_calls == 31
    assert result["api_calls"] == 30


def test_activity_summary_keeps_the_numeric_cap_for_callers_that_compare():
    agent = _make_agent(max_iterations=None)

    summary = agent.get_activity_summary()

    # Numeric on purpose: callers compare and format it; they format through
    # hermes_cli.config.format_turn_progress before showing it.
    assert summary["max_iterations"] == TURN_LIMIT_UNLIMITED
    assert summary["budget_max"] == TURN_LIMIT_UNLIMITED
