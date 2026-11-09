"""``approval.allowlist.list`` / ``approval.allowlist.remove`` gateway RPCs.

The desktop Account page reads and revokes the signed-in account's durable
Atum consents (``plugin_rule:atum:<accountKey>:<consent>``) through these,
never by editing config.yaml itself and never through the command-specific
``config.set`` dispatcher.
"""

from __future__ import annotations

import pytest

import tools.approval as approval
import tui_gateway.server as srv


def _call(method: str, params: dict) -> dict:
    return srv._methods[method](1, params)


@pytest.fixture
def allowlist_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir()
    (home / "config.yaml").write_text(
        "command_allowlist:\n"
        "- recursive delete\n"
        "- plugin_rule:atum:aaaa:browser\n"
        "- plugin_rule:atum:aaaa:computer.control\n"
        "- plugin_rule:atum:bbbb:browser\n"
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    import hermes_cli.config as config_module

    monkeypatch.setattr(config_module, "_LAST_EXPANDED_CONFIG_BY_PATH", {}, raising=False)
    approval.reset_permanent_approvals()
    with approval._lock:
        approval._session_approved.clear()
    approval.load_permanent_allowlist()
    yield home
    approval.reset_permanent_approvals()
    with approval._lock:
        approval._session_approved.clear()


def test_list_filters_by_prefix_and_defaults_to_everything(allowlist_home):
    assert _call("approval.allowlist.list", {"prefix": "plugin_rule:atum:aaaa:"})["result"] == {
        "entries": ["plugin_rule:atum:aaaa:browser", "plugin_rule:atum:aaaa:computer.control"]
    }
    assert _call("approval.allowlist.list", {})["result"]["entries"] == [
        "recursive delete",
        "plugin_rule:atum:aaaa:browser",
        "plugin_rule:atum:aaaa:computer.control",
        "plugin_rule:atum:bbbb:browser",
    ]
    assert "error" in _call("approval.allowlist.list", {"prefix": 7})


def test_remove_clears_disk_memory_and_live_sessions_and_reports_honestly(allowlist_home):
    approval.approve_session("desk-1", "plugin_rule:atum:aaaa:browser")
    assert approval.is_approved("desk-1", "plugin_rule:atum:aaaa:browser")

    assert _call("approval.allowlist.remove", {"pattern_key": "plugin_rule:atum:aaaa:browser"})["result"] == {
        "removed": True
    }

    assert approval.is_approved("desk-1", "plugin_rule:atum:aaaa:browser") is False
    assert approval.is_approved("desk-1", "plugin_rule:atum:aaaa:computer.control") is True
    assert (allowlist_home / "config.yaml").read_text().count("plugin_rule:atum:aaaa:browser") == 0
    assert "plugin_rule:atum:bbbb:browser" in (allowlist_home / "config.yaml").read_text()
    assert "recursive delete" in (allowlist_home / "config.yaml").read_text()

    assert _call("approval.allowlist.remove", {"pattern_key": "plugin_rule:atum:aaaa:browser"})["result"] == {
        "removed": False
    }
    assert "error" in _call("approval.allowlist.remove", {"pattern_key": "   "})
    assert "error" in _call("approval.allowlist.remove", {})


def test_generic_config_set_still_does_not_manage_the_allowlist(allowlist_home):
    response = _call("config.set", {"key": "command_allowlist", "value": []})

    assert "error" in response
    assert "recursive delete" in (allowlist_home / "config.yaml").read_text()


def test_remove_reports_a_persistence_failure_as_an_error(allowlist_home, monkeypatch):
    monkeypatch.setattr("hermes_cli.config.save_config", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only disk")))

    response = _call("approval.allowlist.remove", {"pattern_key": "plugin_rule:atum:aaaa:browser"})

    assert "error" in response
    assert approval.is_approved("desk-1", "plugin_rule:atum:aaaa:browser") is True
    assert "plugin_rule:atum:aaaa:browser" in (allowlist_home / "config.yaml").read_text()
