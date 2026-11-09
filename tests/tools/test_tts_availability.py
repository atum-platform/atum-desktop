"""Tool discovery cannot install optional SDKs on the session-build thread.

Ported onto the v0.22.5 package manager seam: ``pm.ensure_import`` installs an extra on first use,
``pm.extras.available`` answers "is it installed", and ``pm.install.lazy_installs_allowed`` is the
``security.allow_lazy_installs`` gate. The retired ``tools.lazy_deps`` installer (and its durable
``HERMES_LAZY_INSTALL_TARGET``) no longer exists; upstream's narrower contract lives in
``test_tts_requirements_passive.py`` and ``test_tts_importers.py``. These cases keep the Atum
coverage on top: every on-demand provider, unrelated credentials, the NeuTTS fallback, the real
registry caller, and the first speech request end to end.
"""

import importlib
import json
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock

import pytest

import pm
from tools import tts_tool
from tools.registry import ToolRegistry


PROVIDERS = [
    ("edge", "edge_tts", None, "_import_edge_tts", None, "edge-tts"),
    ("elevenlabs", "elevenlabs.client", "ElevenLabs", "_import_elevenlabs", "ELEVENLABS_API_KEY", "tts-premium"),
    ("mistral", "mistralai.client", "Mistral", "_import_mistral_client", "MISTRAL_API_KEY", "mistral"),
]


def _lazy_installs(monkeypatch, allowed: bool) -> None:
    monkeypatch.setattr(importlib.import_module("pm.install"), "lazy_installs_allowed", lambda: allowed)


@pytest.fixture
def no_installer(monkeypatch):
    install = Mock(side_effect=AssertionError("discovery tried to install an SDK"))
    monkeypatch.setattr(pm, "ensure_import", install)
    _lazy_installs(monkeypatch, False)
    monkeypatch.setattr(tts_tool, "_check_neutts_available", lambda: False)
    monkeypatch.setattr(tts_tool, "_resolve_command_provider_config", lambda *a, **k: None)
    return install


def sdk(monkeypatch, name, attribute, extra, installed):
    """Model the SDK as installed or absent, for both the import and pm's availability answer."""
    module = ModuleType(name)
    if attribute:
        setattr(module, attribute, object())
    monkeypatch.setitem(sys.modules, name, module if installed else None)
    extras = importlib.import_module("pm.extras")
    real_available = extras.available
    monkeypatch.setattr(extras, "available", lambda e: installed if e == extra else real_available(e))
    return getattr(module, attribute) if attribute else module


@pytest.mark.parametrize("provider,module,attribute,helper,key,extra", PROVIDERS)
@pytest.mark.parametrize("installed", [False, True])
def test_discovery_uses_only_installed_sdk(
    monkeypatch, no_installer, provider, module, attribute, helper, key, extra, installed
):
    sdk(monkeypatch, module, attribute, extra, installed)
    monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": provider})
    monkeypatch.setattr(tts_tool, "_resolve_provider_key", lambda *a, **k: "fixture-key")

    assert tts_tool.check_tts_requirements() is installed
    no_installer.assert_not_called()


@pytest.mark.parametrize("provider,module,attribute,helper,key,extra", PROVIDERS[1:])
def test_installed_sdk_still_requires_selected_provider_key(
    monkeypatch, no_installer, provider, module, attribute, helper, key, extra
):
    sdk(monkeypatch, module, attribute, extra, True)
    monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": provider})
    # An unrelated credential must not make the selected provider available.
    monkeypatch.setattr(tts_tool, "_resolve_provider_key", lambda name, *a, **k: "" if name == key else "unrelated")

    assert tts_tool.check_tts_requirements() is False
    no_installer.assert_not_called()


def test_missing_edge_preserves_installed_neutts_fallback(monkeypatch, no_installer):
    sdk(monkeypatch, "edge_tts", None, "edge-tts", False)
    monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": "edge"})
    monkeypatch.setattr(tts_tool, "_check_neutts_available", lambda: True)

    assert tts_tool.check_tts_requirements() is True
    no_installer.assert_not_called()


@pytest.mark.parametrize("provider,module,attribute,helper,key,extra", PROVIDERS)
@pytest.mark.parametrize("key_present", [False, True])
def test_missing_sdk_is_selectable_for_permitted_first_use(
    monkeypatch, no_installer, provider, module, attribute, helper, key, extra, key_present
):
    sdk(monkeypatch, module, attribute, extra, False)
    _lazy_installs(monkeypatch, True)
    monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": provider})
    monkeypatch.setattr(tts_tool, "_resolve_provider_key", lambda *a, **k: "fixture" if key_present else "")

    assert tts_tool.check_tts_requirements() is (key is None or key_present)
    no_installer.assert_not_called()


@pytest.mark.parametrize("provider,module,attribute,helper,key,extra", PROVIDERS)
def test_actual_use_keeps_on_demand_installation(
    monkeypatch, provider, module, attribute, helper, key, extra
):
    expected = sdk(monkeypatch, module, attribute, extra, True)
    install = Mock()
    monkeypatch.setattr(pm, "ensure_import", install)

    assert getattr(tts_tool, helper)() is expected
    install.assert_called_once_with(extra)


@pytest.mark.parametrize("allow_install", [False, True])
def test_cold_registry_discovery_does_not_install_tts(monkeypatch, no_installer, allow_install):
    """Exercise the actual caller that previously stalled agent construction."""
    import tools.registry as registry_module

    monkeypatch.setattr(registry_module, "_check_fn_cache", {})
    monkeypatch.setattr(registry_module, "_check_fn_last_good", {})
    _lazy_installs(monkeypatch, allow_install)
    monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": "edge"})
    sdk(monkeypatch, "edge_tts", None, "edge-tts", False)
    registry = ToolRegistry()
    registry.register(name="text_to_speech", toolset="tts", schema=tts_tool.TTS_SCHEMA,
                      handler=lambda args: "unused", check_fn=tts_tool.check_tts_requirements)

    definitions = registry.get_definitions({"text_to_speech"}, quiet=True)
    assert [d["function"]["name"] for d in definitions] == (["text_to_speech"] if allow_install else [])
    # Registry catches check exceptions; explicitly assert to prevent false green.
    no_installer.assert_not_called()


def test_first_speech_request_installs_after_side_effect_free_discovery(monkeypatch, tmp_path):
    """Keep the real discovery -> tool -> SDK path reachable on a fresh profile."""
    sdk(monkeypatch, "edge_tts", None, "edge-tts", False)
    monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": "edge"})
    monkeypatch.setattr(tts_tool, "_resolve_command_provider_config", lambda *a, **k: None)
    monkeypatch.setattr(tts_tool, "_check_neutts_available", lambda: False)
    _lazy_installs(monkeypatch, True)

    class Communicate:
        def __init__(self, text, **kwargs):
            assert text == "hello"

        async def save(self, path):
            Path(path).write_bytes(b"fixture-audio")

    module = ModuleType("edge_tts")
    module.Communicate = Communicate

    def install(extra):
        assert extra == "edge-tts"
        monkeypatch.setitem(sys.modules, "edge_tts", module)

    ensure = Mock(side_effect=install)
    monkeypatch.setattr(pm, "ensure_import", ensure)
    monkeypatch.setattr("gateway.session_context.get_session_env", lambda name, default=None: "cli" if name == "HERMES_SESSION_PLATFORM" else default)
    assert tts_tool.check_tts_requirements() is True
    ensure.assert_not_called()
    result = json.loads(tts_tool.text_to_speech_tool("hello", output_path=str(tmp_path / "speech.mp3")))
    assert result["success"] is True, result
    assert Path(result["file_path"]).read_bytes() == b"fixture-audio"
    assert ensure.called
