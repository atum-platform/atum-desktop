"""An unattended run refuses every existing Google mutation before host I/O."""
import json

import pytest

from tools import atum_google_tool as google
from tools.atum_source_transport import bind_source_transport


@pytest.mark.parametrize("action", [
    "create_event", "update_event", "send_email", "mailbox", "create_label",
    "create_draft", "update_draft", "download_attachment",
])
@pytest.mark.parametrize("background", ["cron", "kanban"])
def test_background_mutations_are_refused_before_transport(monkeypatch, action, background):
    from gateway.session_context import set_session_vars

    set_session_vars(session_id="background-fixture", cron_session="1" if background == "cron" else "")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "fixture" if background == "kanban" else "")
    with bind_source_transport(lambda *_: pytest.fail("background write reached host")):
        result = json.loads(google.atum_google({"action": action}))
    assert result["error"] == "owner_turn_required"
    assert len(result["hint"]) <= 140 and "\n" not in result["hint"]


@pytest.mark.parametrize("action", ["create_event", "update_event"])
def test_owner_turn_still_reaches_calendar_confirmation(monkeypatch, action):
    from gateway.session_context import set_session_vars

    set_session_vars(session_id="owner-fixture", cron_session="")
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    with bind_source_transport(lambda *_: {"confirmationRequired": True, "operationId": "fixture"}):
        result = json.loads(google.atum_google({"action": action}))
    assert result["code"] == "confirmationRequired"
    assert result["operationId"] == "fixture"
