"""cron.manage add for a paid Store assistant's jobs (apps/desktop/electron/matrix/store-schedules.ts).

The desktop app adds each job with the assistant's own room as its delivery (``matrix``, the
backend's home room) and the Store run model alias its loopback proxy binds to the Store. The
real cron store under the test's temporary HERMES_HOME is used, not a mock.
"""

import importlib

import pytest


@pytest.fixture()
def server():
    return importlib.import_module("tui_gateway.server")


def _call(server, params):
    return server.handle_request({"id": "cron", "method": "cron.manage", "params": params})


def test_add_keeps_delivery_and_model_and_is_listed_by_name(server):
    added = _call(
        server,
        {
            "action": "add",
            "name": "atum-store/atum/agents/researcher/weekly-digest",
            "schedule": "0 8 * * 1",
            "prompt": "Write this week's topic digest with the atum-weekly-digest skill.",
            "deliver": "matrix",
            "model": "atum-store-run",
        },
    )

    assert "error" not in added
    assert added["result"]["success"] is True

    from cron.jobs import get_job

    job = get_job(added["result"]["job_id"])
    assert job["deliver"] == "matrix"
    assert job["model"] == "atum-store-run"
    # A pinned model carries no model snapshot, so the drift guard cannot skip a paid run
    # because the assistant's everyday model changed.
    assert not job.get("model_snapshot")

    listed = _call(server, {"action": "list"})["result"]["jobs"]
    assert [j["name"] for j in listed].count("atum-store/atum/agents/researcher/weekly-digest") == 1

    removed = _call(server, {"action": "remove", "name": added["result"]["job_id"]})
    assert removed["result"]["success"] is True
    assert _call(server, {"action": "list"})["result"]["jobs"] == []


def test_add_without_delivery_or_model_is_unchanged(server):
    added = _call(server, {"action": "add", "name": "plain", "schedule": "30m", "prompt": "Say hello."})

    from cron.jobs import get_job

    job = get_job(added["result"]["job_id"])
    assert job["model"] is None
    assert job["deliver"] != "matrix"


def test_non_string_delivery_and_model_are_ignored(server):
    added = _call(
        server,
        {"action": "add", "name": "odd", "schedule": "30m", "prompt": "Say hello.", "deliver": ["matrix"], "model": 7},
    )

    from cron.jobs import get_job

    job = get_job(added["result"]["job_id"])
    assert job["model"] is None
    assert job["deliver"] != "matrix"


def test_list_shows_paused_jobs_only_when_asked(server):
    added = _call(server, {"action": "add", "name": "paused", "schedule": "30m", "prompt": "Say hello."})
    job_id = added["result"]["job_id"]
    assert _call(server, {"action": "pause", "name": job_id})["result"]["success"] is True

    assert [j["job_id"] for j in _call(server, {"action": "list"})["result"]["jobs"]] == []
    listed = _call(server, {"action": "list", "include_disabled": True})["result"]["jobs"]
    assert [j["job_id"] for j in listed] == [job_id]
