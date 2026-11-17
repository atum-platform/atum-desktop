"""Atum's Google fence: an assistant that may hold Google data calls only its protected route.

Each forbidden route out (another provider for the main loop, a helper model, a
fallback client, an external memory provider) must refuse before anything is sent.
An ordinary install (no fence variable) must be untouched.
"""

from types import SimpleNamespace

import pytest

from agent import atum_google_fence as fence

ROUTE = "http://127.0.0.1:43123/v1"


@pytest.fixture(autouse=True)
def _not_holding(monkeypatch):
    # Holding Google data is sticky for a process; each test starts from a fresh one.
    monkeypatch.setattr(fence, "_holding", False)
    monkeypatch.delenv(fence.LATCHED_ENV, raising=False)
    monkeypatch.delenv(fence.MODEL_BASE_ENV, raising=False)


@pytest.fixture
def fenced(monkeypatch):
    monkeypatch.setenv(fence.ROUTE_ENV, ROUTE)


@pytest.fixture
def unfenced(monkeypatch):
    monkeypatch.delenv(fence.ROUTE_ENV, raising=False)


@pytest.fixture
def holding(fenced, monkeypatch):
    monkeypatch.setenv(fence.LATCHED_ENV, "1")


def test_ordinary_installs_are_untouched(unfenced):
    assert fence.fence_route() is None
    assert fence.route_allowed("https://api.openai.com/v1", "anthropic_messages")
    fence.assert_route("https://openrouter.ai/api/v1")
    assert fence.fence_resolved_client((SimpleNamespace(base_url="https://x.test/v1"), "m"))[0] is not None
    assert fence.memory_provider_allowed("honcho")


def test_only_the_protected_route_in_chat_format_is_allowed(fenced):
    assert fence.route_allowed(ROUTE)
    assert fence.route_allowed(ROUTE + "/", "chat_completions")
    for base_url, api_mode in [
        ("https://openrouter.ai/api/v1", None),
        ("http://127.0.0.1:9999/v1", None),
        ("http://localhost:43123/v1", None),
        ("http://127.0.0.1:43123/v2", None),
        (ROUTE, "anthropic_messages"),
        (ROUTE, "codex_responses"),
        (None, None),
    ]:
        assert not fence.route_allowed(base_url, api_mode), (base_url, api_mode)


def test_cloud_fence_accepts_only_the_exact_controller_model_broker(monkeypatch):
    route = "http://10.231.0.1:8080/v1"
    monkeypatch.setenv(fence.MODEL_BASE_ENV, route)
    monkeypatch.setenv(fence.ROUTE_ENV, route)

    assert fence.fence_route() == route
    assert fence.route_allowed(route + "/", "chat_completions")
    assert fence.broker_origin("http://10.231.0.1:8080") == "http://10.231.0.1:8080"
    for refused in (
        "http://10.231.0.2:8080/v1",
        "http://10.231.0.1:8081/v1",
        "https://10.231.0.1:8080/v1",
        "http://user:pw@10.231.0.1:8080/v1",
        "http://10.231.0.1:8080/v1/extra",
        "http://10.231.0.1:8080//v1",
        "http://10.231.0.1:8080/v1?query=1",
        "http://10.231.0.1:8080/v1#fragment",
        "http://10.231.0.1/v1",
    ):
        assert not fence.route_allowed(refused), refused
    for refused_origin in (
        "http://10.231.0.2:8080",
        "http://10.231.0.1:8081",
        "https://10.231.0.1:8080",
        "http://user:pw@10.231.0.1:8080",
        "http://10.231.0.1:8080/other",
        "http://10.231.0.1:8080?query=1",
    ):
        assert fence.broker_origin(refused_origin) is None, refused_origin


def test_cloud_route_without_the_controller_model_binding_fails_closed(monkeypatch):
    route = "http://10.231.0.1:8080/v1"
    monkeypatch.setenv(fence.ROUTE_ENV, route)

    assert fence.fence_route() == ""
    assert not fence.route_allowed(route)
    assert fence.broker_origin("http://10.231.0.1:8080") is None


def test_an_unusable_fence_value_refuses_everything(monkeypatch):
    monkeypatch.setenv(fence.ROUTE_ENV, "none")

    assert fence.fence_active()
    assert fence.fence_route() == ""
    assert not fence.route_allowed(ROUTE)


def test_refusal_is_a_non_retryable_client_error_with_a_plain_message(fenced):
    with pytest.raises(fence.GoogleFenceRouteRequired) as refused:
        fence.assert_route("https://api.openai.com/v1")

    assert refused.value.status_code == 400
    assert "Atum's protected model" in str(refused.value)


def test_the_main_loop_refuses_another_provider_before_building_a_request(fenced):
    from run_agent import AIAgent

    for method in (AIAgent._interruptible_api_call, AIAgent._interruptible_streaming_api_call):
        agent = SimpleNamespace(base_url="https://openrouter.ai/api/v1", api_mode="chat_completions")
        with pytest.raises(fence.GoogleFenceRouteRequired):
            method(agent, {"messages": [{"role": "user", "content": "private"}]})


def test_no_client_is_created_for_another_route(fenced):
    from agent.agent_runtime_helpers import create_openai_client

    agent = SimpleNamespace(provider="openrouter", api_mode="chat_completions")
    with pytest.raises(fence.GoogleFenceRouteRequired):
        create_openai_client(agent, {"base_url": "https://openrouter.ai/api/v1", "api_key": "k"}, reason="t", shared=False)


def test_helper_models_resolve_to_nothing_off_the_route(fenced):
    from agent.auxiliary_client import resolve_provider_client

    client, model = resolve_provider_client(
        "custom", model="helper", explicit_base_url="https://api.example.com/v1", explicit_api_key="k"
    )
    assert client is None and model is None

    client, model = resolve_provider_client("custom", model="helper", explicit_base_url=ROUTE, explicit_api_key="k")
    assert client is not None
    assert str(client.base_url).rstrip("/") == ROUTE


def test_resolved_clients_without_a_route_are_dropped(fenced):
    assert fence.fence_resolved_client((SimpleNamespace(base_url="https://x.test/v1"), "m")) == (None, None)
    assert fence.fence_resolved_client((SimpleNamespace(), "m", "p")) == (None, None, None)
    kept = (SimpleNamespace(base_url=ROUTE + "/"), "m")
    assert fence.fence_resolved_client(kept) is kept
    assert fence.fence_resolved_client((None, None)) == (None, None)


def test_external_memory_providers_do_not_start(fenced):
    from agent.memory_manager import MemoryManager

    assert fence.memory_provider_allowed("builtin")
    assert fence.memory_provider_allowed("atum_awareness")
    assert not fence.memory_provider_allowed("honcho")

    manager = MemoryManager()
    manager.add_provider(SimpleNamespace(name="honcho"))
    assert all(getattr(provider, "name", "") != "honcho" for provider in manager._providers)


EGRESS = [
    "web_search",
    "web_extract",
    "x_search",
    "browser_navigate",
    "browser_type",
    "browser_click",
    "image_generate",
    "text_to_speech",
    "send_message",
    "atum_agents",
    "atum_agent_tasks",
    "kanban_create",
    "kanban_comment",
]
LOCAL = [
    "terminal",
    "read_file",
    "write_file",
    "memory",
    "session_search",
    "delegate_task",
    "vision_analyze",
    "atum_google",
    "kanban_show",
]


def test_every_tool_runs_before_the_process_holds_google_data(fenced):
    # Google tools are offered from launch; nothing is limited before the first result.
    assert not fence.holding_google()
    for name in EGRESS + LOCAL:
        assert fence.egress_refusal(name) is None, name


def test_an_ordinary_install_never_holds_google_data(unfenced, monkeypatch):
    monkeypatch.setenv(fence.LATCHED_ENV, "1")
    fence.mark_holding()

    assert not fence.holding_google()
    assert fence.egress_refusal("web_search") is None


def test_holding_google_data_allows_every_tool(holding):
    for name in EGRESS + LOCAL:
        assert fence.egress_refusal(name) is None, name


@pytest.mark.parametrize("operation", ["list", "read", "update"])
def test_holding_google_data_keeps_self_profile_and_roster_access(holding, operation):
    assert fence.egress_refusal("atum_agents", {"operation": operation}) is None
    assert fence.egress_refusal(
        "atum_agents", {"operation": operation, "target": ""}
    ) is None
    assert fence.egress_refusal(
        "atum_agents", {"operation": operation, "target": None}
    ) is None


@pytest.mark.parametrize(
    "args",
    [
        None,
        "read",
        [],
        {},
        {"operation": []},
        {"operation": {}},
        {"operation": False},
        {"operation": "avatar"},
        {"operation": "unknown"},
        {"operation": "read", "target": 0},
        {"operation": "read", "target": False},
        {"operation": "read", "target": []},
        {"operation": "read", "target": "   "},
        {
            "operation": "read",
            "target": "00000000-0000-4000-8000-bd7662a5eeb4",
        },
        {
            "operation": "update",
            "target": "00000000-0000-4000-8000-bd7662a5eeb4",
        },
    ],
)
def test_holding_google_data_allows_sibling_profile_access(holding, args):
    assert fence.egress_refusal("atum_agents", args) is None


@pytest.mark.parametrize("operation", ["start", "list", "read", "stop", "steer"])
def test_holding_google_data_allows_agent_tasks(holding, operation):
    assert fence.egress_refusal(
        "atum_agent_tasks", {"operation": operation}
    ) is None


def test_the_first_google_result_latches_the_process(fenced):
    fence.mark_holding()

    assert fence.holding_google()
    assert fence.egress_refusal("web_search") is None


def test_every_mcp_servers_tools_are_allowed(holding, monkeypatch):
    from tools.registry import registry

    monkeypatch.setattr(
        registry,
        "get_toolset_for_tool",
        lambda name: {"mcp_notes_create": "mcp-notes", "word_document": "word_document"}.get(name),
    )

    assert fence.egress_refusal("mcp_notes_create") is None
    assert fence.egress_refusal("word_document") is None


def test_holding_google_data_allows_tools_through_plugin_hooks(holding, monkeypatch):
    from hermes_cli import plugins

    seen = []
    monkeypatch.setattr(plugins, "invoke_hook", lambda name, **kwargs: seen.append(kwargs) or [])
    for name in EGRESS + LOCAL:
        assert plugins.resolve_pre_tool_block(name, {}) is None
        assert seen[-1]["tool_name"] == name


@pytest.mark.parametrize("name", EGRESS + ["mcp_notes_create"])
def test_tools_run_while_holding_google_data(holding, monkeypatch, name):
    import model_tools

    seen = []
    def dispatch(tool, args, **kwargs):
        seen.append((tool, args))
        return '{"ok": true}'

    monkeypatch.setattr(model_tools.registry, "dispatch", dispatch)
    args = {"query": "owner-directed request"}
    result = model_tools.handle_function_call(name, args)

    assert seen == [(name, args)]
    assert '"ok": true' in result


@pytest.mark.parametrize("name", EGRESS + ["mcp_notes_create"])
def test_injection_tainted_turn_still_refuses_egress(holding, monkeypatch, name):
    from agent import atum_google_injection as injection
    import model_tools

    monkeypatch.setattr(
        model_tools.registry, "get_toolset_for_tool",
        lambda tool: "mcp-notes" if tool == "mcp_notes_create" else None,
    )
    injection.taint_turn("tainted")
    try:
        assert fence.egress_refusal(name, {}, "tainted") == injection.REFUSAL
        assert fence.egress_refusal(name, {}, "clean") is None
    finally:
        injection.clear_turn("tainted")


@pytest.mark.parametrize("name", EGRESS + LOCAL)
def test_agent_guard_allows_tools_while_holding_google_data(holding, monkeypatch, name):
    from agent.agent_runtime_helpers import _pre_tool_block_message
    from hermes_cli import plugins

    monkeypatch.setattr(plugins, "invoke_hook", lambda *args, **kwargs: [])
    agent = SimpleNamespace(session_id="s", _current_turn_id="turn", _current_api_request_id="")
    args = {"query": "owner-directed request"}
    message, forwarded_args = _pre_tool_block_message(agent, name, args, "clean", "call", [])

    assert message is None
    assert forwarded_args == args
