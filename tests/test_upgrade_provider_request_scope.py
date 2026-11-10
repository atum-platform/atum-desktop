"""Shared-provider background traffic must not count as the CLI's turn."""
import json
from urllib.request import Request, urlopen

from tests.e2e.core.upgrade._provider_requests import requests_for_marker
from tests.fakes.fake_llm_provider import FakeLLMServer


def test_cli_turn_count_ignores_cron_and_sibling_turns():
    marker = "post-update turn unique-leg"
    with FakeLLMServer() as provider:
        for text in ("cron summarize the day", marker, "other leg", "cron summarize again"):
            request = Request(provider.base_url + "/chat/completions", data=json.dumps({
                "model": "fake-model",
                "tools": [{"type": "function", "function": {
                    "name": "noop", "parameters": {"type": "object"},
                }}],
                "messages": [{"role": "user", "content": text}],
            }).encode(), headers={"Content-Type": "application/json"})
            with urlopen(request, timeout=5) as response:
                assert response.status == 200
        assert len(provider.main_requests()) == 4
        assert len(requests_for_marker(provider, marker)) == 1
