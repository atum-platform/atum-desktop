"""Latched ChatGPT helpers keep the host relay; media keeps guarded OpenRouter."""
import json
from types import SimpleNamespace

import httpx
import pytest
from openai import OpenAI

from agent import atum_google_fence as fence
from agent.auxiliary_client import resolve_provider_client

BROKER = "http://host.test:4100/v1"
OPENROUTER = "https://openrouter.ai/api/v1"
IDENTITY = "00000000-0000-4000-8000-bd7662a5eeb4"


@pytest.fixture
def selection(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_MANAGED_DIR", raising=False)
    monkeypatch.delenv(fence.ROUTE_ENV, raising=False)
    monkeypatch.setenv(fence.MODEL_BASE_ENV, BROKER)
    selected = dict(provider="openai-codex", model="fixture", google_latched=True,
                    chatgpt_relay=dict(connection_id=IDENTITY, revision=2),
                    chatgpt_google=dict(current=True, wording_version="chatgpt-google-v1",
                                        connection_id=IDENTITY, revision=3))

    def stage(**changes):
        selected.update(changes)
        monkeypatch.setenv("ATUM_NATIVE_MODEL_CONFIG", json.dumps(selected))
    stage()
    return stage


def test_certified_relay_routes_helpers_and_guarded_media(selection):
    assert not fence.native_protected()
    assert fence.route_allowed(BROKER)
    assert fence.client_allowed(SimpleNamespace(base_url=BROKER))
    assert fence.route_allowed(OPENROUTER)
    assert fence.client_allowed(SimpleNamespace(base_url=OPENROUTER, _atum_native_guard_provider="openrouter"))
    assert not fence.client_allowed(SimpleNamespace(base_url=OPENROUTER))
    for url in ("http://other.test:4100/v1", "https://api.openai.com/v1", BROKER + "?redirect=1"):
        assert not fence.route_allowed(url)
        assert not fence.client_allowed(SimpleNamespace(base_url=url))
    assert not fence.route_allowed(BROKER, "codex_responses")


@pytest.mark.parametrize("changes", [dict(chatgpt_relay=None), dict(chatgpt_google=None),
                                      dict(chatgpt_google={"current": False}), dict(provider="opencode-go")])
def test_uncertified_relay_refuses_all_routes(selection, changes):
    selection(**changes)
    for url in (BROKER, OPENROUTER):
        assert not fence.route_allowed(url)
        assert not fence.client_allowed(SimpleNamespace(base_url=url))
    assert resolve_provider_client("atum-cloud", model="fixture") == (None, None)


def test_native_protected_still_requires_guarded_openrouter(selection):
    selection(provider="openrouter", native_protected=True)
    assert fence.native_protected()
    assert not fence.route_allowed(BROKER)
    assert fence.route_allowed(OPENROUTER)
    assert not fence.client_allowed(SimpleNamespace(base_url=OPENROUTER))
    assert resolve_provider_client("atum-cloud", model="fixture") == (None, None)


def test_unlatched_route_unchanged(selection):
    selection(google_latched=False, chatgpt_google=None)
    assert not fence.native_protected()
    assert fence.route_allowed("https://ordinary.test/v1", "codex_responses")
    assert fence.client_allowed(SimpleNamespace(base_url="https://ordinary.test/v1"))


@pytest.mark.parametrize("provider,is_vision", [("atum-cloud", False), ("openrouter", True)])
def test_relay_aux_resolution_uses_existing_provider_factory(selection, monkeypatch, provider, is_vision):
    import providers
    from hermes_cli import auth
    from providers.base import ProviderProfile
    from hermes_cli.auth_plugin_providers import register_plugin_provider
    from agent import secret_scope

    seen = []
    def respond(request):
        seen.append(str(request.url))
        return httpx.Response(200, json={"id": "fixture", "choices": [{"index": 0,
            "message": {"role": "assistant", "content": "compressed"}, "finish_reason": "stop"}]})

    endpoint = OPENROUTER if is_vision else BROKER

    class RelayProfile(ProviderProfile):
        def create_client(self, **kwargs):
            previous_http = kwargs.pop("http_client", None)
            if previous_http is not None:
                previous_http.close()
            client = OpenAI(**kwargs, http_client=httpx.Client(transport=httpx.MockTransport(respond)))
            if is_vision:
                client._atum_native_guard_provider = "openrouter"
            return client

    providers._discover_providers()
    monkeypatch.setattr(providers, "_REGISTRY", dict(providers._REGISTRY))
    monkeypatch.setattr(providers, "_ALIASES", dict(providers._ALIASES))
    monkeypatch.setattr(providers, "_PROVIDER_LIST_CACHE", None)
    monkeypatch.setattr(auth, "PROVIDER_REGISTRY", dict(auth.PROVIDER_REGISTRY))
    profile = RelayProfile(name=provider, auth_type="api_key", env_vars=("RELAY_TEST_KEY",), base_url=endpoint)
    providers.register_provider(profile)
    register_plugin_provider(profile)
    token = secret_scope.set_secret_scope({"RELAY_TEST_KEY": "fixture-key"})
    try:
        client, model = resolve_provider_client(provider, model="fixture", task="vision" if is_vision else "compression",
                                                is_vision=is_vision, explicit_api_key="fixture-key")
        assert client is not None
        try:
            answer = client.chat.completions.create(model=model, messages=[{"role": "user", "content": "Summarize"}])
            assert answer.choices[0].message.content == "compressed"
            assert seen == [endpoint + "/chat/completions"]
        finally:
            client.close()
    finally:
        secret_scope.reset_secret_scope(token)
