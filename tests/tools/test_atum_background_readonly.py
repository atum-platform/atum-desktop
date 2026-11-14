"""Background source posture never grants mutations, including durable memory."""

from toolsets import get_toolset, resolve_toolset


def test_background_posture_is_first_learning_without_memory():
    learning = set(resolve_toolset("atum_first_learning"))
    background = set(resolve_toolset("atum_background_readonly"))
    assert background == learning - {"memory"}
    assert get_toolset("atum_background_readonly")["posture"] is True
    # Closed read-only surface, not just a blacklist of today's write tools.
    assert background <= {
        "read_file", "search_files", "session_search", "skills_list", "skill_view",
        "atum_chats", "atum_mac", "atum_google_readonly",
    }
    assert "memory" in learning
