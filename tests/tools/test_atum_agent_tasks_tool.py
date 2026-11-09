import json

import pytest

from tools import desktop_ui
from tools.atum_agent_tasks_tool import ATUM_AGENT_TASKS_SCHEMA, atum_agent_tasks
from tools.registry import registry


TARGET = "00000000-0000-4000-8000-bd7662a5eeb4"
TASK = "00000000-0000-4000-8000-b454f82c5857"


def test_start_and_steer_use_the_host_without_authority_claims(monkeypatch):
    calls = []
    receipt = {
        "originPrincipal": TARGET,
        "originIsMain": False,
        "task": {
            "taskId": TASK,
            "targetPrincipal": TARGET,
            "targetName": "Researcher",
            "state": "pending",
            "createdAt": 1,
            "expiresAt": 2,
            "updatedAt": 1,
        },
    }
    monkeypatch.setattr(
        desktop_ui,
        "request",
        lambda event, payload, timeout: calls.append((event, payload, timeout)) or json.dumps(receipt),
    )

    assert json.loads(atum_agent_tasks("start", target=TARGET, prompt="Research this.", timeout_minutes=15)) == receipt
    assert json.loads(atum_agent_tasks("steer", task_id=TASK, text="Use primary sources.")) == receipt
    assert calls == [
        (
            "atum.agent_tasks.request",
            {"operation": "start", "target": TARGET, "prompt": "Research this.", "timeoutMinutes": 15},
            90,
        ),
        (
            "atum.agent_tasks.request",
            {"operation": "steer", "taskId": TASK, "text": "Use primary sources."},
            90,
        ),
    ]
    assert "role" not in ATUM_AGENT_TASKS_SCHEMA["parameters"]["properties"]
    assert "owner" not in ATUM_AGENT_TASKS_SCHEMA["parameters"]["properties"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"operation": "other"},
        {"operation": "start", "target": "not-a-principal", "prompt": "Do it"},
        {"operation": "start", "target": TARGET, "prompt": ""},
        {"operation": "list", "target": TARGET},
        {"operation": "read", "task_id": "not-a-task"},
        {"operation": "stop", "task_id": TASK, "text": "extra"},
        {"operation": "steer", "task_id": TASK, "text": ""},
    ],
)
def test_invalid_request_never_contacts_host(monkeypatch, kwargs):
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: pytest.fail("host contacted"))
    assert "error" in json.loads(atum_agent_tasks(**kwargs))


def test_host_failure_is_not_reported_as_an_empty_task_list(monkeypatch):
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: None)
    assert "error" in json.loads(atum_agent_tasks("list"))


def test_registry_list_drops_irrelevant_all_fields_values(monkeypatch):
    calls = []
    monkeypatch.setattr(
        desktop_ui,
        "request",
        lambda event, payload, timeout: calls.append((event, payload, timeout))
        or '{"tasks":[]}',
    )

    result = registry.dispatch(
        "atum_agent_tasks",
        {
            "operation": "list",
            "target": TARGET,
            "task_id": TASK,
            "prompt": "placeholder",
            "text": "placeholder",
            "timeout_minutes": 1,
        },
    )

    assert json.loads(result) == {"tasks": []}
    assert calls == [("atum.agent_tasks.request", {"operation": "list"}, 90)]
