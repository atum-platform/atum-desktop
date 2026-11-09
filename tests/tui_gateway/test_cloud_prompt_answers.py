"""Cloud prompt defaults settle native server requests without hanging a turn.

The shared gateway client projects native sudo/secret/clarify peer requests
into the compatibility ``*.request`` events consumed by Atum's cloud controller.
These tests keep the Python half honest: the controller's default answer is
represented by a native response frame, and the real tool callback returns
immediately with the same value the cloud agent sees.
"""

from __future__ import annotations

import json

import pytest

import tui_gateway.server as srv

CLARIFY = (
    "Nobody can answer questions while this task runs in Atum's cloud. Continue with your best "
    "judgment, and state the assumptions you made in your answer."
)
SID = "cloud-session"


@pytest.fixture
def controller(monkeypatch):
    """Answer native peer requests as the cloud controller's shared client does."""
    from tui_gateway import server_requests

    frames: list[dict] = []
    server_requests.reset_for_tests()
    monkeypatch.setattr(server_requests, "_answerable", lambda _sid: True)

    def answer(frame: dict) -> bool:
        frames.append(frame)
        if frame["method"] == "clarify":
            questions = frame["params"]["questions"]
            result = {
                "answers": {question["qid"]: CLARIFY for question in questions},
                "outcome": "submitted",
            }
        else:
            # Empty sudo password means run the command as written; an empty
            # secret means the skill setup was deliberately skipped.
            result = {"value": ""}
        assert server_requests.resolve_response({"jsonrpc": "2.0", "id": frame["id"], "result": result})
        return True

    monkeypatch.setattr(server_requests, "_write", answer)
    yield frames
    server_requests.reset_for_tests()


def test_sudo_runs_the_command_as_written(controller, monkeypatch):
    from tools import terminal_tool
    from tools import terminal_tool_sudo as sudo

    monkeypatch.setenv("HERMES_INTERACTIVE", "1")
    monkeypatch.delenv("SUDO_PASSWORD", raising=False)
    sudo._reset_cached_sudo_passwords()
    terminal_tool.set_sudo_password_callback(
        lambda: srv._ask("sudo", SID, {"command": "sudo apt-get"}, timeout=5)
    )
    try:
        command, stdin = sudo._transform_sudo_command(
            "sudo apt-get install -y ffmpeg", sudo_nopasswd_check=lambda: False
        )
    finally:
        terminal_tool.set_sudo_password_callback(None)
        sudo._reset_cached_sudo_passwords()

    assert (command, stdin) == ("sudo apt-get install -y ffmpeg", None)
    assert [frame["method"] for frame in controller] == ["sudo"]


def test_a_skill_secret_is_unavailable_and_its_setup_reported_skipped(controller, monkeypatch):
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools import project_tools, skills_tool, terminal_tool

    monkeypatch.setenv("HERMES_INTERACTIVE", "1")
    monkeypatch.delenv("HERMES_GATEWAY_SESSION", raising=False)
    srv._sessions[SID] = {"agent": object()}
    tokens = set_session_vars(ui_session_id=SID)
    srv._wire_callbacks(SID)
    try:
        result = skills_tool._capture_required_environment_variables(
            "notion", [{"name": "NOTION_API_KEY", "prompt": "Notion integration token"}]
        )
    finally:
        clear_session_vars(tokens)
        srv._sessions.pop(SID, None)
        skills_tool.set_secret_capture_callback(None)
        terminal_tool.set_sudo_password_callback(None)
        project_tools.set_project_workspace_callback(None)

    assert result["setup_skipped"] is True
    assert result["missing_names"] == ["NOTION_API_KEY"]
    assert [frame["method"] for frame in controller] == ["secret"]


def test_a_question_gets_the_controllers_answer_and_the_tool_returns_it(controller):
    from tools.clarify_tool import clarify_tool

    result = json.loads(
        clarify_tool(
            [{
                "question": "Which folder should the report go in?",
                "choices": ["Reports", "Desktop"],
                "multi_select": False,
            }],
            callback=lambda questions: srv._clarify_block(SID, questions),
        )
    )

    assert result["responses"][0]["user_response"] == CLARIFY
    assert result["outcome"] == "submitted"
    assert [frame["method"] for frame in controller] == ["clarify"]
