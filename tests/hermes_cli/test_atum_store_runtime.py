"""Cloud Store runtime changes stay inside the protected Hermes home."""

from __future__ import annotations

import shutil
import json

import pytest

from hermes_cli.atum_store_runtime import (
    PROFILE,
    StoreRuntimeError,
    reconcile_store_runtime,
    validate_store_runtime_plan,
)
from tools.skills_hub_models import SkillBundle
from tools.skills_hub_official import OptionalSkillSource


ITEM = "agent/english-coach"
IDENTIFIER = "official/productivity/memento-flashcards"
JOB = "atum-store/agent/english-coach/daily-lesson"
OWNER_JOB = "owner-daily-note"


@pytest.fixture(autouse=True)
def _cloud_task_environment(monkeypatch):
    monkeypatch.setenv("ATUM_TASK_WORKSPACE", "/task/workspace")
    monkeypatch.setenv("ATUM_TASK_DEADLINE_MS", "1792314000000")


def _plan(managed=None, *, items=True):
    return {
        "profile": PROFILE,
        "items": ([{
            "itemId": ITEM,
            "skills": [{"identifier": IDENTIFIER, "name": "memento-flashcards"}],
            "jobs": [{
                "name": JOB,
                "schedule": "0 20 * * *",
                "prompt": "Prepare today's lesson.",
                "model": "atum-store-run-english-coach-daily-lesson",
            }],
        }] if items else []),
        "managedSkills": list(managed or []),
    }


def _bundle(identifier: str):
    assert identifier == IDENTIFIER
    return SkillBundle(
        name="memento-flashcards",
        files={"SKILL.md": "---\nname: memento-flashcards\ndescription: Practice cards.\n---\nUse cards."},
        source="official",
        identifier=IDENTIFIER,
        trust_level="builtin",
    )


def test_plan_is_closed_and_rejects_arbitrary_paths_or_jobs():
    assert validate_store_runtime_plan(_plan())["items"][0]["itemId"] == ITEM
    for mutate in (
        lambda value: value["items"][0]["skills"][0].update(identifier="github/private/repo"),
        lambda value: value["items"][0]["jobs"][0].update(name="user-job"),
        lambda value: value["items"][0]["jobs"][0].update(schedule="not a schedule"),
        lambda value: value.update(owner="forged"),
    ):
        value = _plan()
        mutate(value)
        with pytest.raises(StoreRuntimeError):
            validate_store_runtime_plan(value)


def test_plan_caps_total_desired_skills_across_items():
    skills = [
        {"identifier": f"official/productivity/skill-{index}", "name": f"skill-{index}"}
        for index in range(65)
    ]
    value = _plan(items=False)
    value["items"] = [
        {
            "itemId": f"agent/coach-{index}",
            "skills": skills[index * 16:(index + 1) * 16],
            "jobs": [],
        }
        for index in range(5)
    ]

    with pytest.raises(StoreRuntimeError, match="store_runtime_plan_invalid"):
        validate_store_runtime_plan(value)


def test_reconcile_refuses_long_lived_non_cloud_homes(monkeypatch):
    monkeypatch.delenv("ATUM_TASK_WORKSPACE")
    monkeypatch.delenv("ATUM_TASK_DEADLINE_MS")

    with pytest.raises(StoreRuntimeError, match="store_runtime_unavailable"):
        reconcile_store_runtime(_plan(items=False))


@pytest.mark.allow_real_home_io
def test_install_replay_restart_and_lapse_are_home_local_and_recoverable(
    tmp_path, monkeypatch, _isolate_hermes_home
):
    from cron.jobs import create_job, load_jobs
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    monkeypatch.setattr(OptionalSkillSource, "fetch", lambda _self, identifier: _bundle(identifier))
    first_home = tmp_path / "first-home"
    token = set_hermes_home_override(str(first_home))
    try:
        create_job(
            prompt="Keep this owner job.",
            schedule="0 7 * * *",
            name=OWNER_JOB,
            deliver="local",
        )
        first = reconcile_store_runtime(_plan())
        assert first["outcome"] == "ok"
        assert (first["installed"], first["added"], first["released"], first["removed"]) == (1, 1, 0, 0)
        assert (first_home / "skills/productivity/memento-flashcards/SKILL.md").is_file()
        assert [job["name"] for job in load_jobs() if job["name"].startswith("atum-store/")] == [JOB]

        replay = reconcile_store_runtime(_plan(first["state"]["managedSkills"]))
        assert (replay["installed"], replay["added"], replay["released"], replay["removed"]) == (0, 0, 0, 0)

        restored_home = tmp_path / "restored-home"
        # Store restart persistence is independent of the retired transfer archive.
        shutil.copytree(first_home, restored_home)
    finally:
        reset_hermes_home_override(token)

    token = set_hermes_home_override(str(restored_home))
    try:
        after_restart = reconcile_store_runtime(_plan(first["state"]["managedSkills"]))
        assert (after_restart["installed"], after_restart["added"]) == (0, 0)
        assert (restored_home / "skills/productivity/memento-flashcards/SKILL.md").is_file()
        assert [job["name"] for job in load_jobs() if job["name"].startswith("atum-store/")] == [JOB]

        lapsed = reconcile_store_runtime(_plan(after_restart["state"]["managedSkills"], items=False))
        assert lapsed["state"] == {"v": 1, "items": [], "managedSkills": []}
        assert (lapsed["installed"], lapsed["added"], lapsed["released"], lapsed["removed"]) == (0, 0, 1, 1)
        assert not (restored_home / "skills/productivity/memento-flashcards").exists()
        assert list((restored_home / "skills/.archive").glob("memento-flashcards*"))
        assert not [job for job in load_jobs() if job["name"].startswith("atum-store/")]
        assert [job["name"] for job in load_jobs() if job["name"] == OWNER_JOB] == [
            OWNER_JOB
        ]
    finally:
        reset_hermes_home_override(token)


def test_lapse_never_archives_a_skill_after_ownership_receipt_changes(monkeypatch):
    previous = {"name": "memento-flashcards", "identifier": IDENTIFIER, "receiptSha256": "a" * 64}
    monkeypatch.setattr("hermes_cli.atum_store_runtime._available_skill_names", lambda: set())
    monkeypatch.setattr("hermes_cli.atum_store_runtime._release_managed_skill", lambda _skill: False)
    monkeypatch.setattr("hermes_cli.atum_store_runtime._reconcile_jobs", lambda _jobs: (0, 0))
    result = reconcile_store_runtime(_plan([previous], items=False))
    assert result["released"] == 0
    assert result["state"]["managedSkills"] == []


def test_automatic_install_never_replaces_an_existing_user_path(tmp_path, monkeypatch, _isolate_hermes_home):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home = tmp_path / "home"
    target = home / "skills/productivity/memento-flashcards"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text(
        "---\nname: memento-flashcards\ndescription: Local collision.\n---\nDo something else.", encoding="utf-8"
    )
    (target / "private-notes.txt").write_text("keep me", encoding="utf-8")
    monkeypatch.setattr(OptionalSkillSource, "fetch", lambda _self, identifier: _bundle(identifier))
    token = set_hermes_home_override(str(home))
    try:
        result = reconcile_store_runtime(_plan())
        assert result["outcome"] == "held"
        assert result["held"] == [ITEM]
        assert (target / "private-notes.txt").read_text(encoding="utf-8") == "keep me"
        assert "Do something else" in (target / "SKILL.md").read_text(encoding="utf-8")
    finally:
        reset_hermes_home_override(token)


def test_gateway_exposes_only_the_closed_store_runtime_result(monkeypatch):
    from hermes_cli import atum_store_runtime as runtime
    from tui_gateway import server

    monkeypatch.setattr(runtime, "reconcile_store_runtime", lambda value: {
        "profile": PROFILE, "outcome": "ok", "installed": 0, "released": 0,
        "added": 0, "removed": 0, "held": [],
        "state": {"v": 1, "items": [], "managedSkills": []},
    })
    result = server._methods["store.runtime.reconcile"]("store-1", _plan(items=False))
    assert result["result"]["profile"] == PROFILE
    assert "store.runtime.reconcile" in server._LONG_HANDLERS

    def refused(_value):
        raise StoreRuntimeError("store_runtime_plan_invalid")

    monkeypatch.setattr(runtime, "reconcile_store_runtime", refused)
    error = server._methods["store.runtime.reconcile"]("store-2", {"secret": "must-not-return"})
    assert error["error"]["message"] == "store_runtime_plan_invalid"
    assert "must-not-return" not in json.dumps(error)

    def unavailable_runtime(_value):
        raise RuntimeError("private /home path")

    monkeypatch.setattr(runtime, "reconcile_store_runtime", unavailable_runtime)
    unavailable = server._methods["store.runtime.reconcile"]("store-3", {})
    assert unavailable["error"]["message"] == "store_runtime_unavailable"
    assert "private" not in json.dumps(unavailable)
