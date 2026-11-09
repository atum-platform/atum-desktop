"""Regression coverage for Atum request shaping through ProviderProfile.

The managed provider is a plugin profile.  These tests intentionally use the
normal registered-profile branch of ``ChatCompletionsTransport`` rather than
the retired ``is_atum_managed`` compatibility flag.
"""

from copy import deepcopy
from uuid import UUID

import pytest


@pytest.fixture
def atum_profile(monkeypatch, tmp_path):
    """Load the installed bundled profile with an isolated account home."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "account"))

    from providers import get_provider_profile

    profile = get_provider_profile("atum-managed")
    assert profile is not None
    assert type(profile).__module__ == "plugins.model_providers.atum_managed"
    return profile


@pytest.fixture
def transport():
    import agent.transports.chat_completions
    from agent.transports import get_transport

    return get_transport("chat_completions")


def _build_registered_kwargs(transport, profile, *, reasoning_config=None, session_id=None,
                             messages=None, tools=None):
    return transport.build_kwargs(
        model="binh-minh",
        messages=messages if messages is not None else [{"role": "user", "content": "Hello"}],
        tools=tools if tools is not None else [],
        provider_profile=profile,
        provider_name="atum-managed",
        base_url="http://127.0.0.1:45678/v1",
        reasoning_config=reasoning_config,
        session_id=session_id,
        supports_reasoning=False,
    )


def _minimal_registered_agent(transport, *, reasoning_config, session_id):
    """Construct only the attributes used by AIAgent's kwargs builder."""
    from run_agent import AIAgent

    agent = object.__new__(AIAgent)
    agent._print_fn = lambda *_args, **_kwargs: None
    agent._image_rejecting_models = set()
    agent._force_ascii_payload = False
    agent._client_kwargs = {}
    agent.api_mode = "chat_completions"
    agent.provider = "atum-managed"
    agent.model = "binh-minh"
    agent.base_url = "http://127.0.0.1:45678/v1"
    agent._base_url_lower = agent.base_url.lower()
    agent.tools = []
    agent.max_tokens = None
    agent.reasoning_config = reasoning_config
    agent.request_overrides = {}
    agent.session_id = session_id
    agent._ephemeral_max_output_tokens = None
    agent._ollama_num_ctx = None
    agent.openrouter_min_coding_score = None
    agent.providers_allowed = []
    agent.providers_ignored = []
    agent.providers_order = []
    agent.provider_sort = None
    agent.provider_require_parameters = False
    agent.provider_data_collection = None
    agent._get_transport = lambda: transport
    agent._is_qwen_portal = lambda: False
    agent._is_openrouter_url = lambda: False
    agent._prepare_messages_for_non_vision_model = lambda messages: messages
    agent._resolved_api_call_timeout = lambda: 30.0
    agent._max_tokens_param = lambda value: {"max_tokens": value}
    agent._supports_reasoning_extra_body = lambda: False
    return agent


@pytest.mark.parametrize(
    ("effort", "wire_effort"),
    [
        ("minimal", "low"),
        ("low", "low"),
        ("medium", "high"),
        ("high", "high"),
        ("xhigh", "max"),
        ("max", "max"),
        ("ultra", "max"),
    ],
)
def test_registered_atum_profile_shapes_every_thinking_level(
    transport, atum_profile, effort, wire_effort
):
    kwargs = _build_registered_kwargs(
        transport,
        atum_profile,
        reasoning_config={"enabled": True, "effort": effort},
    )

    assert kwargs["reasoning_effort"] == wire_effort
    assert kwargs["extra_body"]["thinking"] == {"type": "enabled"}


def test_registered_atum_profile_explicitly_disables_thinking(transport, atum_profile):
    kwargs = _build_registered_kwargs(
        transport,
        atum_profile,
        reasoning_config={"enabled": False, "effort": "ultra"},
    )

    assert "reasoning_effort" not in kwargs
    assert kwargs["extra_body"]["thinking"] == {"type": "disabled"}


def test_registered_atum_profile_forwards_only_valid_session_id(transport, atum_profile):
    # Go through AIAgent._build_api_kwargs: this is the normal registered
    # ProviderProfile branch and deliberately supplies no legacy flag.
    agent = _minimal_registered_agent(
        transport,
        reasoning_config=None,
        session_id="atum-session:calendar.1",
    )
    valid = agent._build_api_kwargs([{"role": "user", "content": "Hello"}])
    invalid = _build_registered_kwargs(transport, atum_profile, session_id="bad session id")

    assert valid["extra_headers"] == {"x-atum-session-id": "atum-session:calendar.1"}
    assert "extra_headers" not in invalid


def test_registered_atum_profile_preserves_prompt_history_and_tools(transport, atum_profile):
    messages = [
        {"role": "system", "content": "Follow the user."},
        {"role": "user", "content": "Summarize my calendar."},
    ]
    tools = [{"type": "function", "function": {"name": "calendar_list", "parameters": {}}}]
    original_messages = deepcopy(messages)
    original_tools = deepcopy(tools)

    kwargs = _build_registered_kwargs(
        transport,
        atum_profile,
        reasoning_config={"enabled": True, "effort": "ultra"},
        messages=messages,
        tools=tools,
    )

    assert kwargs["messages"] is messages
    assert kwargs["tools"] is tools
    assert messages == original_messages
    assert tools == original_tools


def test_registered_atum_profile_does_not_revoke_workspace_permit(monkeypatch, transport, atum_profile):
    from agent.transports import chat_completions

    revoked = []
    monkeypatch.setattr(
        chat_completions,
        "_clear_atum_workspace_source_reads",
        lambda: revoked.append(True),
    )

    _build_registered_kwargs(transport, atum_profile, session_id="atum-session:one")

    assert revoked == []


def test_foreign_registered_profile_revokes_workspace_permit(monkeypatch, transport):
    from agent.transports import chat_completions
    from providers.base import ProviderProfile

    revoked = []
    monkeypatch.setattr(
        chat_completions,
        "_clear_atum_workspace_source_reads",
        lambda: revoked.append(True),
    )
    foreign = ProviderProfile(name="foreign")

    transport.build_kwargs(
        model="foreign-model",
        messages=[{"role": "user", "content": "Hello"}],
        tools=[],
        provider_profile=foreign,
        provider_name="foreign",
        base_url="https://example.invalid/v1",
        reasoning_config=None,
        supports_reasoning=False,
    )

    assert revoked == [True]


@pytest.mark.parametrize("endpoint", ["https://foreign.invalid/v1", "http://127.0.0.1:9999/v1", "http://127.0.0.1:45678/v1"])
def test_backend_capability_only_goes_to_the_current_managed_loopback(monkeypatch, atum_profile, endpoint):
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_TOKEN", "local-backend-capability")
    _, extras = atum_profile.build_api_kwargs_extras(base_url=endpoint, session_id="session-one")
    assert (extras.get("extra_headers", {}).get("x-atum-backend-token") == "local-backend-capability") is (endpoint == "http://127.0.0.1:45678/v1")


@pytest.mark.parametrize("protected", [False, True])
def test_real_iteration_summary_and_retry_preserve_backend_identity(monkeypatch, transport, atum_profile, protected):
    from types import SimpleNamespace
    from agent import workspace_route_guard

    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_TOKEN", "summary-backend")
    monkeypatch.setattr(workspace_route_guard, "protected_workspace_route", lambda: {
        "base_url": "http://127.0.0.1:45678/v1", "api_key": "proxy", "model": "binh-minh"
    } if protected else None)
    agent = _minimal_registered_agent(transport, reasoning_config={"enabled": True, "effort": "low"}, session_id="summary-session")
    agent.max_iterations = 5
    agent._cached_system_prompt = "Keep this system prefix."
    agent.ephemeral_system_prompt = None
    agent.prefill_messages = []
    agent._should_sanitize_tool_calls = lambda: False
    agent._copy_reasoning_content_for_api = lambda *_args: None
    agent._sanitize_api_messages = lambda messages: messages
    agent._drop_thinking_only_and_merge_users = lambda messages: messages
    requests = []
    def create(**kwargs):
        requests.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="" if len(requests) == 1 else "Completed summary", tool_calls=None), finish_reason="stop")], usage=None)
    agent._interruptible_api_call = lambda kwargs: create(**kwargs)
    result = agent._handle_max_iterations([{"role": "assistant", "content": "Working"}], 5)
    assert result == "Completed summary"
    assert len(requests) == 2
    for request in requests:
        headers = request["extra_headers"]
        assert headers["x-atum-backend-token"] == "summary-backend"
        # Summary calls retain backend authority while using a separate
        # accounting identity, without inheriting the main task's training.
        assert headers["x-atum-session-id"].startswith("aux:")
        assert str(UUID(headers["x-atum-request-id"])) == headers["x-atum-request-id"]
        assert "x-atum-training-task-id" not in headers
        assert "x-atum-conversation-id" not in headers
        assert "x-atum-assistant-identity-id" not in headers
        assert request["extra_body"]["thinking"] == {"type": "enabled"}
        assert request["messages"][0] == {"role": "system", "content": "Keep this system prefix."}
