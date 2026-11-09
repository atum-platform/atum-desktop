"""Atum model-selection persistence uses the native atomic writer."""

def test_persist_model_switch_preserves_sibling_model_keys(tmp_path, monkeypatch):
    """#48305: switching models from the TUI must NOT destroy sibling keys under
    `model:` (model_slots, model_fallback, etc.). _persist_model_switch now uses
    targeted save_config_value writes instead of rewriting the whole block."""
    import types
    import yaml

    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        "model:\n"
        "  default: old-model\n"
        "  provider: openai\n"
        "  model_slots:\n"
        "    fast: gpt-5-mini\n"
        "  model_fallback:\n"
        "    - claude-haiku\n"
        "agent:\n"
        "  system_prompt: keepme\n"
    )
    # The native writer targets this explicit profile path atomically.

    result = types.SimpleNamespace(
        new_model="new-model", target_provider="anthropic", base_url=None
    )
    from hermes_cli.model_switch import ModelSwitchResult, persist_model_selection
    persist_model_selection(ModelSwitchResult(success=True, **vars(result)), config_path=cfg_path)
    saved = yaml.safe_load(cfg_path.read_text())

    # The switched fields updated...
    assert saved["model"]["default"] == "new-model"
    assert saved["model"]["provider"] == "anthropic"
    # ...and the sibling keys SURVIVED (the bug was that they got wiped).
    assert saved["model"]["model_slots"] == {"fast": "gpt-5-mini"}
    assert saved["model"]["model_fallback"] == ["claude-haiku"]
    assert saved["agent"]["system_prompt"] == "keepme"


def test_persist_model_switch_clears_stale_base_url(tmp_path, monkeypatch):
    """#48305: switching from a custom endpoint (which set model.base_url) to a
    provider with no base_url must CLEAR the stale base_url, not leave it
    pointing at the old host."""
    import types
    import yaml

    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        "model:\n"
        "  default: local-model\n"
        "  provider: custom:mylocal\n"
        "  base_url: http://localhost:1234/v1\n"
    )

    # Switch to a native provider with no base_url.
    result = types.SimpleNamespace(
        new_model="claude-haiku", target_provider="anthropic", base_url=None
    )
    from hermes_cli.model_switch import ModelSwitchResult, persist_model_selection
    persist_model_selection(ModelSwitchResult(success=True, **vars(result)), config_path=cfg_path)
    saved = yaml.safe_load(cfg_path.read_text())

    assert saved["model"]["default"] == "claude-haiku"
    assert saved["model"]["provider"] == "anthropic"
    # Stale custom base_url must be cleared (null coalesces to absent on read).
    assert not saved["model"].get("base_url"), saved["model"].get("base_url")

