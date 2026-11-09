from hermes_cli.auth import resolve_provider
from providers import get_provider_profile


def test_atum_managed_profile_is_discovered_and_routes_from_launch_env(monkeypatch):
    monkeypatch.setenv("ATUM_MANAGED_MODEL_PROXY_TOKEN", "ephemeral-loopback-token")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")

    profile = get_provider_profile("atum-managed")

    assert profile is not None
    assert profile.display_name == "Atum"
    assert profile.fallback_models == ("binh-minh", "nguyet-thuc", "nhat-thuc")
    assert resolve_provider("auto") == "atum-managed"


def test_atum_managed_proxy_credentials_are_blocked_from_tool_subprocesses():
    from tools.environments.local import _HERMES_PROVIDER_ENV_BLOCKLIST

    assert "ATUM_MANAGED_MODEL_PROXY_TOKEN" in _HERMES_PROVIDER_ENV_BLOCKLIST
    assert "ATUM_MANAGED_MODEL_BASE_URL" in _HERMES_PROVIDER_ENV_BLOCKLIST


def test_atum_managed_picker_lists_the_whole_public_catalog(monkeypatch):
    """The runtime-supplied base URL must not empty the model picker.

    The profile registers no static ``base_url`` because its endpoint is the
    desktop's random loopback proxy. Before the fix the curated-catalog return
    lived inside a branch gated on a static base URL, so this provider resolved
    to ``[]`` and the picker fell back to showing only the active model.
    """
    from hermes_cli.models import provider_model_ids

    monkeypatch.setenv("ATUM_MANAGED_MODEL_PROXY_TOKEN", "ephemeral-loopback-token")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")

    profile = get_provider_profile("atum-managed")
    assert profile is not None and not profile.base_url

    assert provider_model_ids("atum-managed") == [
        "binh-minh",
        "nguyet-thuc",
        "nhat-thuc",
    ]


def test_atum_managed_picker_payload_offers_every_alias(monkeypatch):
    """The GUI picker payload, not just the raw resolver, must carry all three."""
    from hermes_cli.inventory import ConfigContext, build_models_payload

    monkeypatch.setenv("ATUM_MANAGED_MODEL_PROXY_TOKEN", "ephemeral-loopback-token")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")

    payload = build_models_payload(
        ConfigContext(
            current_provider="atum-managed",
            current_model="binh-minh",
            current_base_url="",
            user_providers={},
            custom_providers={},
            excluded_providers=[],
        ),
        explicit_only=True,
        picker_hints=True,
        canonical_order=True,
        probe_custom_providers=False,
    )

    row = next(r for r in payload["providers"] if r["slug"] == "atum-managed")

    assert row["models"] == ["binh-minh", "nguyet-thuc", "nhat-thuc"]
    assert row["total_models"] == 3


def test_atum_managed_resolves_as_an_explicit_provider(monkeypatch):
    """`--provider atum-managed` must resolve, or no model switch is possible.

    The provider appears in no static catalog on purpose: its endpoint is a
    loopback proxy whose URL only exists at runtime. Before the fix the
    built-in / models.dev / user-config chain returned None and every explicit
    switch failed with "Unknown provider 'atum-managed'".
    """
    from hermes_cli.auth import PROVIDER_REGISTRY
    from hermes_cli.providers import resolve_provider_full

    monkeypatch.setenv("ATUM_MANAGED_MODEL_PROXY_TOKEN", "ephemeral-loopback-token")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")

    resolved = resolve_provider_full("atum-managed")

    assert resolved is not None
    assert resolved.id == "atum-managed"
    assert resolved.source == "plugin-profile"
    assert resolved.base_url_env_var == "ATUM_MANAGED_MODEL_BASE_URL"

    from hermes_cli.runtime_provider import resolve_runtime_provider

    runtime = resolve_runtime_provider(requested="atum-managed")
    assert runtime["base_url"] == "http://127.0.0.1:45678/v1"
    # Only the token carries a credential; the base-URL env var must not be
    # mistaken for one.
    assert resolved.api_key_env_vars == ("ATUM_MANAGED_MODEL_PROXY_TOKEN",)


def test_plugin_fallback_does_not_capture_catalog_providers(monkeypatch):
    """The new branch is last and must not shadow an ordinary provider."""
    from hermes_cli.auth import PROVIDER_REGISTRY
    from hermes_cli.providers import resolve_provider_full

    monkeypatch.setenv("ATUM_MANAGED_MODEL_PROXY_TOKEN", "ephemeral-loopback-token")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")

    for slug in ("gmi", "stepfun", "zai"):
        resolved = resolve_provider_full(slug)
        assert resolved is not None, slug
        assert resolved.source != "plugin", slug


def test_switching_between_included_models_succeeds(monkeypatch):
    """Every alias in the public catalog must be reachable by an explicit switch."""
    from hermes_cli.auth import PROVIDER_REGISTRY
    from hermes_cli.model_switch import switch_model

    monkeypatch.setenv("ATUM_MANAGED_MODEL_PROXY_TOKEN", "ephemeral-loopback-token")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")

    for target in ("nguyet-thuc", "nhat-thuc", "binh-minh"):
        result = switch_model(
            raw_input=target,
            current_provider="atum-managed",
            current_model="binh-minh",
            current_base_url="http://127.0.0.1:45678/v1",
            current_api_key="ephemeral-loopback-token",
            is_global=False,
            explicit_provider="atum-managed",
            user_providers=None,
            custom_providers=None,
        )

        assert result.success, f"{target}: {result.error_message}"
        assert result.new_model == target
        assert result.target_provider == "atum-managed"
        assert result.base_url == "http://127.0.0.1:45678/v1"
