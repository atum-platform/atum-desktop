"""Host-owned config keys never appear in the dashboard config editor."""

from hermes_cli.config import DEFAULT_CONFIG
from hermes_cli.web_server_config import _build_schema_from_config


def test_host_owned_agent_keys_are_hidden_from_the_dashboard_schema():
    # Both keys exist in the defaults (the host projects them) but a user must not toggle
    # them: a flip would rebuild the stored prompt at the next restore boundary.
    assert "atum_instructions" in DEFAULT_CONFIG["agent"]
    assert "atum_full_power" in DEFAULT_CONFIG["agent"]
    schema = _build_schema_from_config(DEFAULT_CONFIG)
    assert "agent.atum_instructions" not in schema
    assert "agent.atum_full_power" not in schema
    # Ordinary agent preferences are still editable.
    assert any(key.startswith("agent.") for key in schema)
