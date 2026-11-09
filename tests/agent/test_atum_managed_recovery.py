"""The hosted managed route owns bounded retries and model/funding authority."""
from unittest.mock import MagicMock, patch

import pytest

from run_agent import AIAgent


@pytest.mark.parametrize("status,code", [
    (409, "managed_request_outcome_unknown"),
    (429, "managed_capacity_wait"),
    (502, "managed_model_transport_failed"),
])
def test_managed_proxy_failure_is_not_retried_or_retargeted_by_agent(status, code, monkeypatch):
    monkeypatch.delenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", raising=False)
    with (
        patch("model_tools.get_tool_definitions", return_value=[]),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        agent = AIAgent(api_key="test-key", base_url="https://api.openai.com/v1",
                        provider="openai", model="gpt-5.5", api_mode="chat_completions",
                        quiet_mode=True, skip_context_files=True, skip_memory=True)
    agent.provider = "atum-managed"
    agent.requested_provider = "atum-managed"
    agent.model = "binh-minh"
    agent._cached_system_prompt = "You are helpful."
    agent._use_prompt_caching = False
    agent.tool_delay = 0
    agent.compression_enabled = False
    agent.save_trajectories = False
    agent.client = MagicMock()
    error = Exception(code)
    error.status_code = status
    agent.client.chat.completions.create.side_effect = error
    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_try_activate_fallback") as fallback,
        patch.object(agent, "_try_recover_primary_transport") as recovery,
    ):
        result = agent.run_conversation("Do this task")
    assert agent.client.chat.completions.create.call_count == 1
    assert result["failed"] is True
    assert code in result["error"]
    fallback.assert_not_called()
    recovery.assert_not_called()


def _daily_cap_error(details=None):
    error = Exception("atum_daily_cap_exhausted")
    error.status_code = 403
    error.body = {
        "error": {
            "message": "atum_daily_cap_exhausted",
            "type": "atum_managed_model_error",
            "code": "atum_daily_cap_exhausted",
            "details": details or {
                "reason": "daily_cap_exhausted",
                "cap": {
                    "dailyProtons": 200_000,
                    "timeZone": "Asia/Ho_Chi_Minh",
                    "warningPercent": 80,
                    "counts": "atum_billed_only",
                },
                "spend": {"day": "2026-10-21", "usedProtons": 200_123},
            },
        }
    }
    return error


def _managed_agent(monkeypatch):
    monkeypatch.delenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", raising=False)
    with (
        patch("model_tools.get_tool_definitions", return_value=[]),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        agent = AIAgent(api_key="test-key", base_url="https://api.openai.com/v1",
                        provider="openai", model="gpt-5.5", api_mode="chat_completions",
                        quiet_mode=True, skip_context_files=True, skip_memory=True)
    agent.provider = "atum-managed"
    agent.requested_provider = "atum-managed"
    agent.model = "binh-minh"
    agent._cached_system_prompt = "You are helpful."
    agent._use_prompt_caching = False
    agent.tool_delay = 0
    agent.compression_enabled = False
    agent.save_trajectories = False
    agent.client = MagicMock()
    return agent


def test_managed_daily_cap_ends_the_turn_plainly_and_is_not_retried(monkeypatch):
    import re

    from agent.conversation_loop import ATUM_DAILY_CAP_LINE

    agent = _managed_agent(monkeypatch)
    agent.client.chat.completions.create.side_effect = _daily_cap_error()

    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_try_activate_fallback") as fallback,
        patch.object(agent, "_try_recover_primary_transport") as recovery,
    ):
        result = agent.run_conversation("Do this task")

    assert agent.client.chat.completions.create.call_count == 1
    assert result["completed"] is True
    assert result["failed"] is False
    assert result["daily_cap"] is True
    assert "error" not in result
    assert result["final_response"] == ATUM_DAILY_CAP_LINE
    # Plain state copy: no cap, spend or balance fact ever reaches the chat.
    assert not re.search(r"\d", result["final_response"])
    assert "200000" not in repr(result)
    assert "200123" not in repr(result)
    fallback.assert_not_called()
    recovery.assert_not_called()


def test_managed_daily_cap_refuses_every_later_turn_the_same_way(monkeypatch):
    from agent.conversation_loop import ATUM_DAILY_CAP_LINE

    agent = _managed_agent(monkeypatch)
    agent.client.chat.completions.create.side_effect = _daily_cap_error()

    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_try_activate_fallback") as fallback,
    ):
        first = agent.run_conversation("First task")
        second = agent.run_conversation("Second task")

    assert agent.client.chat.completions.create.call_count == 2
    for result in (first, second):
        assert result["completed"] is True
        assert result["failed"] is False
        assert result["final_response"] == ATUM_DAILY_CAP_LINE
    fallback.assert_not_called()


def test_an_unrelated_managed_failure_still_fails(monkeypatch):
    agent = _managed_agent(monkeypatch)
    error = Exception("managed_model_transport_failed")
    error.status_code = 503
    agent.client.chat.completions.create.side_effect = error

    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
    ):
        result = agent.run_conversation("Do this task")

    assert agent.client.chat.completions.create.call_count == 1
    assert result["failed"] is True
    assert result["completed"] is False


def test_daily_cap_classifier_reads_the_structured_code_not_the_message():
    from agent.error_classifier import classify_api_error

    error = _daily_cap_error()
    error.body["error"]["message"] = "refused"

    classified = classify_api_error(error, provider="atum-managed")
    assert classified.reason.value == "billing"
    assert classified.retryable is False
    assert classified.should_fallback is False
    assert classified.error_context == {"atum_daily_cap": True}
