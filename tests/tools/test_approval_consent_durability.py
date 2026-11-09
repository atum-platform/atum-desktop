"""Durable one-time consent through Hermes's own approval machinery.

Covers the contract the Atum desktop relies on: a stable ``rule_key`` becomes
one ``plugin_rule:*`` entry in ``command_allowlist`` that survives a restart,
every bypass source silences the gate the same way, and revocation forgets the
key everywhere (disk, in-memory permanent set, and every live session cache)
so the very next call asks again.

It also pins the security contract the owner accepted: the terminal hardline
blocklist is unconditional, while ``execute_code`` is a whole-script approval
and NOT a hardline sandbox.
"""

import pytest
import yaml

import tools.approval as approval
import tools.approval_context as approval_context
from tools.approval import (
    _run_approval_gate,
    check_all_command_guards,
    detect_hardline_command,
    list_permanent_approvals,
    request_tool_approval,
    revoke_approval,
)


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    """A private HERMES_HOME with an empty config and clean approval state."""
    home = tmp_path / "hermes"
    home.mkdir()
    (home / "config.yaml").write_text("command_allowlist: []\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    import hermes_cli.config as config_module

    monkeypatch.setattr(config_module, "_LAST_EXPANDED_CONFIG_BY_PATH", {}, raising=False)
    approval.reset_permanent_approvals()
    with approval._lock:
        approval._session_approved.clear()
        approval._session_yolo.clear()
    monkeypatch.setattr(approval, "get_current_session_key", lambda default="default": "desk-1")
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False, raising=False)
    monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
    monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
    # The prompt transport reads the split owner (tools/approval_prompt.py).
    monkeypatch.setattr(approval_context, "_is_gateway_approval_context", lambda: False)
    monkeypatch.setattr("tools.terminal_tool._get_approval_callback", lambda: None, raising=False)
    yield home
    approval.reset_permanent_approvals()
    with approval._lock:
        approval._session_approved.clear()
        approval._session_yolo.clear()


def _allowlist(home):
    return (yaml.safe_load((home / "config.yaml").read_text()) or {}).get("command_allowlist", [])


RULE = "atum:0123abcd:computer.observe"
KEY = f"plugin_rule:{RULE}"


def test_always_persists_the_stable_key_and_a_restart_reloads_it(isolated_home, monkeypatch):
    answers = iter(["always"])
    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: next(answers))

    assert request_tool_approval("computer_use", "Observe Safari", rule_key=RULE) == {"approved": True, "message": None}
    assert _allowlist(isolated_home) == [KEY]
    assert list_permanent_approvals("plugin_rule:atum:") == [KEY]
    assert list_permanent_approvals("plugin_rule:other:") == []

    # Simulate a gateway restart: in-memory state is gone, config is reloaded
    # at session start the way tui_gateway does it.
    approval.reset_permanent_approvals()
    with approval._lock:
        approval._session_approved.clear()
    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: pytest.fail("must not prompt after reload"))
    approval.load_permanent_allowlist()

    assert request_tool_approval("computer_use", "Observe Safari", rule_key=RULE) == {"approved": True, "message": None}
    # Other operations under the same consent share it; a different consent does not.
    assert request_tool_approval("computer_use", "Observe Notes", rule_key=RULE)["approved"] is True
    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "deny")
    assert request_tool_approval("computer_use", "Click Save", rule_key="atum:0123abcd:computer.control")["approved"] is False


def test_revoke_forgets_the_key_on_disk_in_memory_and_in_every_session(isolated_home, monkeypatch):
    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "always")
    (isolated_home / "config.yaml").write_text("command_allowlist:\n- recursive delete\n")
    approval.load_permanent_allowlist()
    request_tool_approval("computer_use", "Observe Safari", rule_key=RULE)
    approval.approve_session("desk-2", KEY)
    assert sorted(_allowlist(isolated_home)) == [KEY, "recursive delete"]

    assert revoke_approval(KEY) is True

    assert _allowlist(isolated_home) == ["recursive delete"], "unrelated entries survive"
    assert approval.is_approved("desk-1", KEY) is False
    assert approval.is_approved("desk-2", KEY) is False
    assert approval.is_approved("desk-1", "recursive delete") is True

    prompts = []

    def prompt(*a, **k):
        prompts.append(k.get("description") or a)
        return "deny"

    monkeypatch.setattr(approval, "prompt_dangerous_approval", prompt)
    assert request_tool_approval("computer_use", "Observe Safari", rule_key=RULE)["approved"] is False
    assert len(prompts) == 1, "the very next call in the same session asks again"
    assert revoke_approval(KEY) is False, "revoking twice reports nothing removed"
    assert revoke_approval("plugin_rule:never-granted") is False


def test_every_bypass_source_silences_a_plugin_consent_the_same_way(isolated_home, monkeypatch):
    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: pytest.fail("bypass must not prompt"))

    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "off")
    assert request_tool_approval("web_search", "Search the public web", rule_key="atum:a:browser") == {"approved": True, "message": None}

    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "smart")
    approval.enable_session_yolo("desk-1")
    assert request_tool_approval("web_search", "Search the public web", rule_key="atum:a:browser") == {"approved": True, "message": None}
    approval.disable_session_yolo("desk-1")

    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", True, raising=False)
    assert request_tool_approval("web_search", "Search the public web", rule_key="atum:a:browser") == {"approved": True, "message": None}
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False, raising=False)

    # A native authority that opts out is still asked under every bypass.
    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "deny")
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "off")
    assert request_tool_approval("web_search", "x", rule_key="atum:a:browser", allow_yolo_bypass=False)["approved"] is False
    approval.enable_session_yolo("desk-1")
    assert request_tool_approval("web_search", "x", rule_key="atum:a:browser", allow_yolo_bypass=False)["approved"] is False
    approval.disable_session_yolo("desk-1")

    # An invalid choice outside the declared set still fails closed.
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "smart")
    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "always")
    assert _run_approval_gate(
        pattern_key="plugin_rule:x",
        description="x",
        display_target="<x>",
        cron_deny_message="cron",
        autoapprove_log_prefix="test",
        choices=("once", "deny"),
    )["approved"] is False


def test_terminal_hardline_is_unconditional_and_execute_code_is_not_a_sandbox(isolated_home, monkeypatch):
    """The owner-accepted contract: terminal hardline survives every bypass and
    a permanent allow; ``execute_code`` is gated as a whole script only."""
    hardline, description = detect_hardline_command("rm -rf /")
    assert hardline and description

    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: pytest.fail("hardline never prompts"))
    for bypass in ["mode_off", "session_yolo", "process_yolo", "permanent_allow"]:
        if bypass == "mode_off":
            monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "off")
        elif bypass == "session_yolo":
            monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "smart")
            approval.enable_session_yolo("desk-1")
        elif bypass == "process_yolo":
            approval.disable_session_yolo("desk-1")
            monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", True, raising=False)
        else:
            monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False, raising=False)
            approval.load_permanent({description, "rm -rf /"})
        result = check_all_command_guards("rm -rf /", "local")
        assert result["approved"] is False, bypass
        assert "hardline" in result["message"].lower() or "blocked" in result["message"].lower()

    # execute_code: documented limitation — arbitrary Python is approved as a
    # whole script (once/session/always) and bypasses under yolo/mode off.
    # There is no hardline pass on Python text; this test exists so the
    # documentation cannot drift into claiming otherwise.
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False, raising=False)
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "off")
    from tools.approval import check_execute_code_guard

    assert check_execute_code_guard("import os; os.system('rm -rf /')", "local")["approved"] is True


def test_binding_a_profile_replaces_the_in_memory_permanent_set(isolated_home, monkeypatch, tmp_path):
    """Profile A's loaded keys never authorize profile B, and an entry deleted
    from config.yaml stops authorizing on the next load."""
    (isolated_home / "config.yaml").write_text(
        "command_allowlist:\n- plugin_rule:atum:aaaa:browser\n- recursive delete\n"
    )
    assert approval.load_permanent_allowlist() == {"plugin_rule:atum:aaaa:browser", "recursive delete"}
    assert approval.is_approved("desk-1", "plugin_rule:atum:aaaa:browser") is True

    # The user deletes a line from config.yaml by hand; the next bind drops it.
    (isolated_home / "config.yaml").write_text("command_allowlist:\n- recursive delete\n")
    approval.load_permanent_allowlist()
    assert approval.is_approved("desk-1", "plugin_rule:atum:aaaa:browser") is False
    assert approval.is_approved("desk-1", "recursive delete") is True

    # Another profile home is bound: nothing from profile A survives.
    home_b = tmp_path / "hermes-b"
    home_b.mkdir()
    (home_b / "config.yaml").write_text("command_allowlist:\n- plugin_rule:atum:bbbb:browser\n")
    monkeypatch.setenv("HERMES_HOME", str(home_b))
    assert approval.load_permanent_allowlist() == {"plugin_rule:atum:bbbb:browser"}
    assert approval.is_approved("desk-1", "recursive delete") is False
    assert approval.is_approved("desk-1", "plugin_rule:atum:aaaa:browser") is False
    assert approval.is_approved("desk-1", "plugin_rule:atum:bbbb:browser") is True
    assert list_permanent_approvals() == ["plugin_rule:atum:bbbb:browser"]

    # A config read failure leaves the in-memory set alone rather than emptying it, and never
    # adds anything: the reader is upstream's ``load_config_readonly`` (tools/approval.py
    # ``_read_permanent_allowlist``), used by both the explicit load and the per-check sync.
    monkeypatch.setattr(
        "hermes_cli.config.load_config_readonly", lambda *a, **k: (_ for _ in ()).throw(OSError("disk"))
    )
    assert approval.load_permanent_allowlist() == set()
    assert approval.is_approved("desk-1", "plugin_rule:atum:bbbb:browser") is True
    assert approval.is_approved("desk-1", "recursive delete") is False

    # Fail closed: a profile home whose config cannot be read grants nothing it was not
    # already granted in this process.
    home_c = tmp_path / "hermes-c"
    home_c.mkdir()
    (home_c / "config.yaml").write_text("command_allowlist:\n- plugin_rule:atum:cccc:browser\n")
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(home_c))
    try:
        assert approval.load_permanent_allowlist() == set()
        assert approval.is_approved("desk-c", "plugin_rule:atum:cccc:browser") is False
        assert approval.is_approved("desk-c", "plugin_rule:atum:bbbb:browser") is False
    finally:
        reset_hermes_home_override(token)


def test_revoke_is_durable_first_and_reports_persistence_failure(isolated_home, monkeypatch):
    monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "always")
    request_tool_approval("computer_use", "Observe Safari", rule_key=RULE)
    assert _allowlist(isolated_home) == [KEY]

    with pytest.MonkeyPatch.context() as failing_disk:
        failing_disk.setattr(
            "hermes_cli.config.save_config", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only disk"))
        )

        with pytest.raises(OSError):
            revoke_approval(KEY)

        # Nothing was forgotten in memory, so the gate and the UI cannot
        # disagree with what would come back after a restart.
        assert approval.is_approved("desk-1", KEY) is True
        assert _allowlist(isolated_home) == [KEY]

    assert revoke_approval(KEY) is True
    assert approval.is_approved("desk-1", KEY) is False
    assert _allowlist(isolated_home) == []


def test_permanent_approvals_are_kept_per_profile_home_even_when_bound_concurrently(isolated_home, monkeypatch, tmp_path):
    """One gateway process can serve two profile homes at once; each turn binds
    its own home. A's "always" never authorizes B, and binding B never drops
    A's approvals — the sets are keyed by the bound home, not process-global."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home_b = tmp_path / "hermes-b"
    home_b.mkdir()
    (home_b / "config.yaml").write_text("command_allowlist:\n- plugin_rule:atum:bbbb:browser\n- recursive delete\n")
    (isolated_home / "config.yaml").write_text("command_allowlist:\n- plugin_rule:atum:aaaa:browser\n")

    approval.load_permanent_allowlist()  # profile A (HERMES_HOME)

    token = set_hermes_home_override(str(home_b))
    try:
        approval.load_permanent_allowlist()  # profile B, bound for this turn
        assert approval.is_approved("desk-b", "plugin_rule:atum:bbbb:browser") is True
        assert approval.is_approved("desk-b", "recursive delete") is True
        assert approval.is_approved("desk-b", "plugin_rule:atum:aaaa:browser") is False
    finally:
        reset_hermes_home_override(token)

    # Back on A's turn: A's approvals survived B's bind, and B's never leaked in.
    assert approval.is_approved("desk-a", "plugin_rule:atum:aaaa:browser") is True
    assert approval.is_approved("desk-a", "recursive delete") is False
    assert approval.is_approved("desk-a", "plugin_rule:atum:bbbb:browser") is False
    with approval._lock:  # the governing set for A is exactly A's config
        assert set(approval._permanent_set()) == {"plugin_rule:atum:aaaa:browser"}

    # A revocation on B's turn touches only B's set and B's config.
    token = set_hermes_home_override(str(home_b))
    try:
        assert revoke_approval("recursive delete") is True
        assert approval.is_approved("desk-b", "recursive delete") is False
    finally:
        reset_hermes_home_override(token)
    assert "recursive delete" not in (home_b / "config.yaml").read_text()
    assert (isolated_home / "config.yaml").read_text().count("plugin_rule:atum:aaaa:browser") == 1
