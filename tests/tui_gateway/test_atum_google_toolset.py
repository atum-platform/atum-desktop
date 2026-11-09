"""The desktop resolver adds Google only to a launch Atum gave the broker to."""

from tui_gateway import server


def test_google_folds_in_only_with_the_atum_launch_environment(monkeypatch):
    monkeypatch.delenv("HERMES_TUI_TOOLSETS", raising=False)

    import agent.coding_context as cc

    monkeypatch.setattr(cc, "coding_selection", lambda **_: ["coding"])

    monkeypatch.delenv("ATUM_GOOGLE_TOOLS_URL", raising=False)
    monkeypatch.delenv("ATUM_GOOGLE_TOOLS_TOKEN", raising=False)
    assert "atum_google" not in server._load_enabled_toolsets()

    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_URL", "http://127.0.0.1:50000")
    assert "atum_google" not in server._load_enabled_toolsets()
    monkeypatch.setenv("ATUM_GOOGLE_TOOLS_TOKEN", "g" * 43)
    assert "atum_google" in server._load_enabled_toolsets()


def test_the_google_toolset_resolves_to_the_atum_google_tool():
    import toolsets

    assert toolsets.validate_toolset("atum_google")
    assert "atum_google" in toolsets.resolve_toolset("atum_google")


def test_first_learning_resolves_only_approved_reads_and_memory():
    import toolsets

    assert toolsets.validate_toolset("atum_first_learning")
    assert set(toolsets.resolve_toolset("atum_first_learning")) == {
        "read_file",
        "search_files",
        "memory",
        "session_search",
        "skills_list",
        "skill_view",
        "atum_chats",
        "atum_mac",
        "atum_google_readonly",
    }
