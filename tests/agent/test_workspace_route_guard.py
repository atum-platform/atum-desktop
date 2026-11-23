"""Regression tests for Atum's account-owned protected-workspace route."""

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest


class _RouteAuthorityHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - stdlib handler API
        state = self.server.route_state
        state["requests"] += 1
        if self.path != "/v1/utilities/route-authority":
            self.send_error(404)
            return
        if state["mode"] == "redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if state["mode"] == "malformed":
            self.wfile.write(b"not-json")
            return
        self.wfile.write(json.dumps({
            "protected": state["protected"],
            "workspaceAlias": "binh-minh",
        }).encode())

    def log_message(self, *_args):
        pass


@pytest.fixture
def broker(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _RouteAuthorityHandler)
    server.route_state = {"protected": True, "mode": "ok", "requests": 0}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address

    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_URL", f"http://{host}:{port}")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_TOKEN", "broker-test-token")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_PROXY_TOKEN", "managed-proxy-token")
    try:
        yield server.route_state
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def _clear_atum_env(monkeypatch):
    for name in (
        "ATUM_FILESYSTEM_CAPABILITY_REQUIRED",
        "ATUM_FILESYSTEM_BROKER_URL",
        "ATUM_FILESYSTEM_BROKER_TOKEN",
        "ATUM_MANAGED_MODEL_BASE_URL",
        "ATUM_MANAGED_MODEL_PROXY_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)


def test_ordinary_hermes_does_not_enter_the_route_guard(monkeypatch):
    from agent.workspace_route_guard import protect_agent_request, protected_workspace_route

    _clear_atum_env(monkeypatch)
    foreign = SimpleNamespace(provider="openrouter", api_mode="chat_completions", base_url="https://openrouter.ai/api/v1")

    assert protected_workspace_route() is None
    assert protect_agent_request(foreign, {"model": "any-model"}) is None


def test_missing_or_offline_atum_broker_fails_closed(monkeypatch):
    from agent.workspace_route_guard import WorkspaceRouteRequired, protected_workspace_route

    _clear_atum_env(monkeypatch)
    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    with pytest.raises(WorkspaceRouteRequired):
        protected_workspace_route()

    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_TOKEN", "broker-test-token")
    with pytest.raises(WorkspaceRouteRequired):
        protected_workspace_route()


@pytest.mark.parametrize("mode", ["malformed", "redirect"])
def test_malformed_or_redirecting_broker_fails_closed(broker, mode):
    from agent.workspace_route_guard import WorkspaceRouteRequired, protected_workspace_route

    broker["mode"] = mode
    with pytest.raises(WorkspaceRouteRequired):
        protected_workspace_route()


def test_protected_status_is_rechecked_without_negative_cache(broker):
    from agent.workspace_route_guard import protected_workspace_route

    broker["protected"] = False
    assert protected_workspace_route() is None
    broker["protected"] = True

    assert protected_workspace_route() == {
        "base_url": "http://127.0.0.1:45678/v1",
        "api_key": "managed-proxy-token",
        "model": "binh-minh",
    }
    assert broker["requests"] == 2


def test_protect_agent_request_rejects_foreign_provider_or_mode(broker):
    from agent.workspace_route_guard import WorkspaceRouteRequired, protect_agent_request

    for agent in (
        SimpleNamespace(provider="openrouter", api_mode="chat_completions", base_url="https://openrouter.ai/api/v1"),
        SimpleNamespace(provider="atum-managed", api_mode="codex_responses", base_url="http://127.0.0.1:45678/v1"),
        SimpleNamespace(provider="atum-managed", api_mode="chat_completions", base_url="http://127.0.0.1:9999/v1"),
    ):
        with pytest.raises(WorkspaceRouteRequired):
            protect_agent_request(agent, {"model": "foreign"})


def test_protect_agent_request_routes_binh_without_rewriting_context(broker):
    from agent.workspace_route_guard import protect_agent_request

    messages = [{"role": "user", "content": "Calendar data stays intact."}]
    tools = [{"type": "function", "function": {"name": "calendar_list", "parameters": {}}}]
    request = {"model": "nguyet-thuc", "messages": messages, "tools": tools}
    agent = SimpleNamespace(
        provider="atum-managed",
        api_mode="chat_completions",
        base_url="http://127.0.0.1:45678/v1",
    )

    protect_agent_request(agent, request)

    assert request["model"] == "binh-minh"
    assert request["messages"] is messages
    assert request["tools"] is tools


class _SyncOpenAI:
    instances = []

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.requests = []
        self.failure = None
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.__class__.instances.append(self)

    def create(self, **kwargs):
        self.requests.append(kwargs)
        if self.failure:
            raise self.failure
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="protected"))])

    def close(self):
        pass


class _AsyncOpenAI(_SyncOpenAI):
    async def create(self, **kwargs):
        self.requests.append(kwargs)
        if self.failure:
            raise self.failure
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="protected"))])


def test_call_llm_forces_managed_proxy_and_cannot_fallback(monkeypatch, broker):
    import openai
    from agent import auxiliary_client

    _SyncOpenAI.instances = []
    monkeypatch.setattr(openai, "OpenAI", _SyncOpenAI)
    monkeypatch.setattr(auxiliary_client, "_get_cached_client", lambda *_args, **_kwargs: pytest.fail("foreign resolution"))
    monkeypatch.setattr(auxiliary_client, "_try_payment_fallback", lambda *_args, **_kwargs: pytest.fail("fallback"))

    messages = [{"role": "user", "content": "Protected calendar summary"}]
    response = auxiliary_client.call_llm(
        task="title_generation",
        provider="openrouter",
        model="foreign-model",
        messages=messages,
        max_tokens=128,
    )

    assert response.choices[0].message.content == "protected"
    assert len(_SyncOpenAI.instances) == 1
    client = _SyncOpenAI.instances[0]
    assert client.init_kwargs == {
        "base_url": "http://127.0.0.1:45678/v1",
        "api_key": "managed-proxy-token",
        "max_retries": 0,
    }
    request = client.requests[0]
    assert request["model"] == "binh-minh"
    assert request["messages"] is messages
    assert request["extra_body"] == {"thinking": {"type": "enabled"}}
    assert request["reasoning_effort"] == "low"
    assert request["extra_headers"]["x-atum-session-id"].startswith("aux:")


def test_call_llm_managed_failure_does_not_fallback(monkeypatch, broker):
    import openai
    from agent import auxiliary_client

    class FailingOpenAI(_SyncOpenAI):
        def create(self, **kwargs):
            self.requests.append(kwargs)
            raise RuntimeError("managed proxy failed")

    monkeypatch.setattr(openai, "OpenAI", FailingOpenAI)
    monkeypatch.setattr(auxiliary_client, "_try_payment_fallback", lambda *_args, **_kwargs: pytest.fail("fallback"))

    with pytest.raises(RuntimeError, match="managed proxy failed"):
        auxiliary_client.call_llm(
            provider="foreign",
            model="foreign-model",
            messages=[{"role": "user", "content": "protected"}],
        )


@pytest.mark.asyncio
async def test_async_call_llm_forces_managed_proxy_and_cannot_fallback(monkeypatch, broker):
    import openai
    from agent import auxiliary_client

    _AsyncOpenAI.instances = []
    monkeypatch.setattr(openai, "AsyncOpenAI", _AsyncOpenAI)
    monkeypatch.setattr(auxiliary_client, "_get_cached_client", lambda *_args, **_kwargs: pytest.fail("foreign resolution"))
    monkeypatch.setattr(auxiliary_client, "_try_payment_fallback", lambda *_args, **_kwargs: pytest.fail("fallback"))

    messages = [{"role": "user", "content": "Protected calendar summary"}]
    response = await auxiliary_client.async_call_llm(
        task="compression",
        provider="openrouter",
        model="foreign-model",
        messages=messages,
        max_tokens=128,
    )

    assert response.choices[0].message.content == "protected"
    assert len(_AsyncOpenAI.instances) == 1
    request = _AsyncOpenAI.instances[0].requests[0]
    assert request["model"] == "binh-minh"
    assert request["messages"] is messages


@pytest.mark.asyncio
async def test_async_call_llm_managed_failure_does_not_fallback(monkeypatch, broker):
    import openai
    from agent import auxiliary_client

    class FailingAsyncOpenAI(_AsyncOpenAI):
        async def create(self, **kwargs):
            self.requests.append(kwargs)
            raise RuntimeError("managed async proxy failed")

    monkeypatch.setattr(openai, "AsyncOpenAI", FailingAsyncOpenAI)
    monkeypatch.setattr(auxiliary_client, "_try_payment_fallback", lambda *_args, **_kwargs: pytest.fail("fallback"))

    with pytest.raises(RuntimeError, match="managed async proxy failed"):
        await auxiliary_client.async_call_llm(
            provider="foreign",
            model="foreign-model",
            messages=[{"role": "user", "content": "protected"}],
        )


def test_client_created_before_google_connection_rechecks_at_dispatch(monkeypatch, broker):
    import openai
    from agent.workspace_route_guard import guard_auxiliary_resolution, WorkspaceRouteRequired

    _SyncOpenAI.instances = []
    monkeypatch.setattr(openai, "OpenAI", _SyncOpenAI)
    foreign_calls = []
    foreign = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
        create=lambda **request: foreign_calls.append(request) or "ordinary")))

    @guard_auxiliary_resolution
    def resolve(async_mode=False):
        return foreign, "foreign-model"

    broker["protected"] = False
    cached, model = resolve()
    assert cached.chat.completions.create(model=model, messages=[]) == "ordinary"
    broker["protected"] = True
    response = cached.chat.completions.create(model=model, messages=[{"role": "user", "content": "Google-derived memory"}])
    assert response.choices[0].message.content == "protected"
    assert len(foreign_calls) == 1
    assert _SyncOpenAI.instances[0].requests[0]["model"] == "binh-minh"
    broker["mode"] = "malformed"
    with pytest.raises(WorkspaceRouteRequired):
        cached.chat.completions.create(model=model, messages=[])
    assert len(foreign_calls) == 1


@pytest.mark.parametrize("provider", ["auto", "openrouter", "anthropic", "custom"])
def test_vision_resolution_cannot_bypass_protected_route(monkeypatch, broker, provider):
    import openai
    from agent import auxiliary_client

    _SyncOpenAI.instances = []
    monkeypatch.setattr(openai, "OpenAI", _SyncOpenAI)
    monkeypatch.setattr(auxiliary_client, "_resolve_strict_vision_backend", lambda *_args: pytest.fail("foreign vision"))
    resolved, client, model = auxiliary_client.resolve_vision_provider_client(provider=provider, model="foreign")
    assert (resolved, model) == ("atum-managed", "binh-minh")
    client.chat.completions.create(model=model, messages=[{"role": "user", "content": "derived visual data"}])
    assert _SyncOpenAI.instances[-1].init_kwargs["base_url"] == "http://127.0.0.1:45678/v1"


@pytest.mark.asyncio
async def test_protected_async_vision_uses_async_client_without_sdk_conversion(monkeypatch, broker):
    import openai
    from agent import auxiliary_client

    _AsyncOpenAI.instances = []
    monkeypatch.setattr(openai, "AsyncOpenAI", _AsyncOpenAI)
    monkeypatch.setattr(auxiliary_client, "_to_async_client", lambda *_args, **_kwargs: pytest.fail("unexpected SDK conversion"))
    provider, client, model = auxiliary_client.resolve_vision_provider_client(provider="openrouter", async_mode=True)
    response = await client.chat.completions.create(model=model, messages=[])
    assert provider == "atum-managed"
    assert response.choices[0].message.content == "protected"


def test_unprotected_summary_request_still_has_local_backend_identity(broker):
    from agent.workspace_route_guard import protect_agent_request

    broker["protected"] = False
    request = {"model": "binh-minh", "messages": []}
    agent = SimpleNamespace(provider="atum-managed", api_mode="chat_completions",
                            base_url="http://127.0.0.1:45678/v1", session_id="summary-session")
    protect_agent_request(agent, request)
    assert request["extra_headers"]["x-atum-session-id"] == "summary-session"
    assert request["extra_headers"]["x-atum-backend-token"] == "broker-test-token"
    assert request["extra_headers"]["x-atum-request-id"]


def test_managed_request_identity_stays_stable_only_for_same_logical_call(broker):
    from agent.workspace_route_guard import protect_agent_request

    broker["protected"] = False
    agent = SimpleNamespace(provider="atum-managed", base_url="http://127.0.0.1:45678/v1",
                            session_id="task", _current_api_request_id="turn-1:api:1")
    request = {"model": "binh-minh", "messages": [{"role": "user", "content": "same text"}]}
    retry = {"model": "binh-minh", "messages": [{"role": "user", "content": "same text"}]}
    protect_agent_request(agent, request)
    protect_agent_request(agent, retry)
    first_id = request["extra_headers"]["x-atum-request-id"]
    assert retry["extra_headers"]["x-atum-request-id"] == first_id
    agent._current_api_request_id = "turn-1:api:2"
    protect_agent_request(agent, retry)
    assert retry["extra_headers"]["x-atum-request-id"] != first_id
    agent._current_api_request_id = "regenerate-turn:api:1"
    protect_agent_request(agent, request)
    assert request["extra_headers"]["x-atum-request-id"] != first_id


def test_managed_identity_is_never_sent_to_configurable_remote_endpoint(monkeypatch):
    from agent.workspace_route_guard import protect_agent_request

    _clear_atum_env(monkeypatch)
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")
    agent = SimpleNamespace(provider="atum-managed", base_url="https://untrusted.test/v1",
                            session_id="task", _current_api_request_id="turn-1:api:1")
    request = {"model": "binh-minh", "messages": []}
    protect_agent_request(agent, request)
    assert "extra_headers" not in request


def test_managed_agent_cannot_activate_unmetered_or_different_model_fallback():
    from agent.chat_completion_helpers import try_activate_fallback

    agent = SimpleNamespace(provider="atum-managed", requested_provider="atum-managed")
    assert try_activate_fallback(agent) is False


def test_summary_keeps_account_funding_but_not_main_task_training(monkeypatch, broker):
    from agent.workspace_route_guard import protect_agent_request
    from hermes_cli import atum_training

    identity = "00000000-0000-4000-8000-3fff02fcbe73"
    task_id = "00000000-0000-4000-8000-320ce5ad961c"
    def context(session_id):
        if not session_id:
            return None
        return {"x-atum-assistant-identity-id": identity, "x-atum-conversation-id": session_id,
                **({"x-atum-training-task-id": task_id} if session_id == "main-task" else {})}
    monkeypatch.setattr(atum_training, "training_context", context)
    agent = SimpleNamespace(provider="atum-managed", api_mode="chat_completions", base_url="http://127.0.0.1:45678/v1",
                            session_id="main-task", _current_api_request_id="turn:api:2")
    main = {"model": "binh-minh", "messages": [{"role": "user", "content": "work"}]}
    protect_agent_request(agent, main)
    assert main["extra_headers"]["x-atum-training-task-id"] == task_id
    summary = {"model": "binh-minh", "messages": [{"role": "user", "content": "summarize progress"}],
               "extra_headers": dict(main["extra_headers"])}
    protect_agent_request(agent, summary, purpose="auxiliary")
    assert summary["extra_headers"]["x-atum-conversation-id"].startswith("aux:")
    assert summary["extra_headers"]["x-atum-assistant-identity-id"] == identity
    assert summary["extra_headers"]["x-atum-backend-token"] == "broker-test-token"
    assert "x-atum-training-task-id" not in summary["extra_headers"]
    assert summary["extra_headers"]["x-atum-request-id"] != main["extra_headers"]["x-atum-request-id"]
    protect_agent_request(agent, main)
    assert main["extra_headers"]["x-atum-training-task-id"] == task_id


def test_pinned_training_cannot_be_silently_dropped_by_changing_provider(monkeypatch, broker):
    from agent.workspace_route_guard import protect_agent_request, TrainingRouteRequired
    from hermes_cli import atum_training

    broker["protected"] = False
    monkeypatch.setattr(atum_training, "training_context", lambda session_id: {
        "x-atum-training-task-id": "00000000-0000-4000-8000-320ce5ad961c"
    } if session_id == "trained" else None)
    for provider, base_url, api_mode in (
        ("openrouter", "https://untrusted.test/v1", "chat_completions"),
        ("atum-managed", "https://untrusted.test/v1", "chat_completions"),
        ("atum-managed", "http://127.0.0.1:45678/v1", "codex_responses"),
    ):
        agent = SimpleNamespace(provider=provider, base_url=base_url, api_mode=api_mode, session_id="trained")
        request = {"model": "binh-minh", "messages": []}
        with pytest.raises(TrainingRouteRequired, match="training_managed_route_required"):
            protect_agent_request(agent, request)


def test_cached_auxiliary_client_discards_inherited_primary_training_headers(monkeypatch, broker):
    from agent.workspace_route_guard import guard_auxiliary_resolution
    from hermes_cli import atum_training

    broker["protected"] = False
    identity = "00000000-0000-4000-8000-3fff02fcbe73"
    monkeypatch.setattr(atum_training, "training_context", lambda session_id: {
        "x-atum-assistant-identity-id": identity, "x-atum-conversation-id": session_id
    } if session_id else None)
    seen = []
    client = SimpleNamespace(base_url="http://127.0.0.1:45678/v1", chat=SimpleNamespace(
        completions=SimpleNamespace(create=lambda **kwargs: seen.append(kwargs))))
    guarded = guard_auxiliary_resolution(lambda: (client, "binh-minh"))
    cached, model = guarded()
    cached.chat.completions.create(model=model, messages=[], extra_headers={
        "x-atum-training-task-id": "00000000-0000-4000-8000-320ce5ad961c",
        "x-atum-conversation-id": "main-task", "x-atum-assistant-identity-id": identity
    })
    headers = seen[0]["extra_headers"]
    assert headers["x-atum-conversation-id"].startswith("aux:")
    assert headers["x-atum-assistant-identity-id"] == identity
    assert "x-atum-training-task-id" not in headers


@pytest.mark.asyncio
async def test_cached_async_vision_client_is_rechecked_after_google_connection(monkeypatch, broker):
    import openai
    from agent import auxiliary_client

    foreign_calls = []
    async def foreign_create(**request):
        foreign_calls.append(request)
        return "ordinary"
    foreign = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=foreign_create)))
    broker["protected"] = False
    monkeypatch.setattr(openai, "AsyncOpenAI", _AsyncOpenAI)
    monkeypatch.setattr(auxiliary_client, "_resolve_task_provider_model", lambda *_args: ("openrouter", "foreign", None, None, None))
    monkeypatch.setattr(auxiliary_client, "_resolve_strict_vision_backend", lambda *_args: (foreign, "foreign"))
    monkeypatch.setattr(auxiliary_client, "_to_async_client", lambda *_args, **_kwargs: (foreign, "foreign"))
    _, cached, model = auxiliary_client.resolve_vision_provider_client(provider="openrouter", async_mode=True)
    assert await cached.chat.completions.create(model=model, messages=[]) == "ordinary"
    broker["protected"] = True
    assert (await cached.chat.completions.create(model=model, messages=[])).choices[0].message.content == "protected"
    assert len(foreign_calls) == 1
