"""A schedule occurrence's sandbox moves its Hermes job to the next run before Hermes starts
(packages/cloud-sandbox/entrypoint/home_hydrate.py with Hermes's own cron/jobs.py), so the home
exported after the turn names the following occurrence. Real files, a real job, a temp HERMES_HOME.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

REPO = Path(__file__).resolve().parents[2]


def test_cloud_task_timezone_reads_tomorrow_at_eight_as_0100z(tmp_path):
    """The task executor's TZ value is enough for Hermes cron's server-local fallback."""
    env = os.environ.copy()
    env["TZ"] = "Asia/Ho_Chi_Minh"
    env["HERMES_HOME"] = str(tmp_path / "home")
    env.pop("HERMES_TIMEZONE", None)
    code = """
import json
from datetime import datetime, timedelta, timezone
from cron.jobs import parse_schedule
from hermes_time import now

tomorrow = (now() + timedelta(days=1)).date().isoformat()
parsed = parse_schedule(f"{tomorrow}T08:00:00")
print(json.dumps({"tomorrow": tomorrow, "utc": datetime.fromisoformat(parsed["run_at"]).astimezone(timezone.utc).isoformat()}))
"""
    output = subprocess.check_output([sys.executable, "-c", code], cwd=REPO, env=env, text=True)
    result = json.loads(output)
    assert result["utc"] == f'{result["tomorrow"]}T01:00:00+00:00'


def _helper(name: str):
    if not (REPO / "packages/cloud-sandbox/entrypoint" / f"{name}.py").is_file():
        pytest.skip("Private cloud-sandbox differential helper is excluded from public client source")
    spec = importlib.util.spec_from_file_location(f"{name}_under_test", REPO / "packages/cloud-sandbox/entrypoint" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_due_job_moves_to_its_next_run_before_hermes_starts(tmp_path, monkeypatch):
    from cron import jobs as cron_jobs

    job = cron_jobs.create_job(prompt="Brief me on the news.", schedule="every 1h", name="brief")
    created = Path(os.environ["HERMES_HOME"]) / "cron" / "jobs.json"
    data = created.read_bytes()
    # The sandbox's home is a fresh directory: hydrate the job into it with the advance flag.
    root = tmp_path / "hermes-home"
    sentinel = tmp_path / ".atum-hydrated"
    header = {"v": 1, "config": {}, "advanceSchedules": [job["id"]],
              "files": [{"path": "cron/jobs.json", "size": len(data), "mode": 384, "sha256": hashlib.sha256(data).hexdigest()}]}
    archive = json.dumps(header).encode() + b"\n" + data
    monkeypatch.setenv("HERMES_HOME", str(root))
    out = io.StringIO()
    assert _helper("home_hydrate").main(stdin=io.BytesIO(archive), stdout=out, root=str(root), sentinel=str(sentinel)) == 0
    assert json.loads(out.getvalue())["advanced"] == 1
    hydrated = json.loads((root / "cron" / "jobs.json").read_text())
    jobs = hydrated if isinstance(hydrated, list) else hydrated["jobs"]
    moved = datetime.fromisoformat(jobs[0]["next_run_at"])
    assert moved > datetime.fromisoformat(job["next_run_at"]) or moved > datetime.now(timezone.utc)
    # And the export summarizes the following occurrence from it.
    summaries = _helper("home_export").schedule_summaries(jobs)
    assert summaries and summaries[0]["scheduleId"] == job["id"]
    assert summaries[0]["nextOccurrenceAt"] == int(moved.timestamp() * 1000)


def _hydrate(tmp_path, monkeypatch, job_id: str, name: str = "sandbox-home", config: dict | None = None) -> dict:
    """Hydrate the current HERMES_HOME's jobs into a fresh sandbox home, asking to advance ``job_id``."""
    data = (Path(os.environ["HERMES_HOME"]) / "cron" / "jobs.json").read_bytes()
    root = tmp_path / name
    header = {"v": 1, "config": config or {}, "advanceSchedules": [job_id],
              "files": [{"path": "cron/jobs.json", "size": len(data), "mode": 384, "sha256": hashlib.sha256(data).hexdigest()}]}
    monkeypatch.setenv("HERMES_HOME", str(root))
    out = io.StringIO()
    archive = json.dumps(header).encode() + b"\n" + data
    assert _helper("home_hydrate").main(stdin=io.BytesIO(archive), stdout=out, root=str(root), sentinel=str(tmp_path / ".hydrated")) == 0
    return json.loads(out.getvalue())


@pytest.fixture
def owner_zone():
    """Give this test's home the owner's IANA zone, as the controller's `cloudConfig` writes it."""
    from hermes_time import reset_cache

    def set_zone(zone: str) -> None:
        root = Path(os.environ["HERMES_HOME"])
        root.mkdir(parents=True, exist_ok=True)
        (root / "config.yaml").write_text(f"timezone: {zone}\n", encoding="utf-8")
        reset_cache()

    yield set_zone
    (Path(os.environ["HERMES_HOME"]) / "config.yaml").unlink(missing_ok=True)
    reset_cache()


def test_eight_oclock_local_stays_eight_local_after_a_cloud_run(tmp_path, monkeypatch, owner_zone):
    """Plan §3.7a: a routine set for 08:00 is still 08:00 where the owner lives after the
    occurrence's sandbox advances it. The zone comes from the controller's configuration, never
    from the server's clock, and never from a literal in the image."""
    from cron import jobs as cron_jobs

    zone = ZoneInfo("Asia/Ho_Chi_Minh")
    owner_zone("Asia/Ho_Chi_Minh")
    job = cron_jobs.create_job(prompt="Morning brief.", schedule="0 8 * * *", name="brief")
    # The run this occurrence is (the sandbox is told to advance it): yesterday's 08:00 local.
    due = datetime.now(zone).replace(hour=8, minute=0, second=0, microsecond=0) - timedelta(days=1)
    _set_next_run(job["id"], due)
    [job] = [j for j in cron_jobs.load_jobs() if j["id"] == job["id"]]
    assert datetime.fromisoformat(job["next_run_at"]).astimezone(zone).strftime("%H:%M") == "08:00"

    # The sandbox hydrates with the controller's configuration (the only place the zone is set)
    # and advances the job with Hermes's own cron/jobs.py.
    assert _hydrate(tmp_path, monkeypatch, job["id"], config={"timezone": "Asia/Ho_Chi_Minh"})["advanced"] == 1
    [moved] = [j for j in cron_jobs.load_jobs() if j["id"] == job["id"]]
    when = datetime.fromisoformat(moved["next_run_at"]).astimezone(zone)
    assert (when.hour, when.minute) == (8, 0), when.isoformat()
    # The following occurrence, on the owner's clock: no later than tomorrow's 08:00 local.
    now = datetime.now(zone)
    assert now - timedelta(minutes=1) < when <= now + timedelta(days=1)


def test_the_owner_zone_in_the_config_decides_the_clock_even_when_the_image_is_utc(tmp_path):
    """Hermes reads `timezone` from the hydrated config.yaml (`hermes_time.py`); its server-local
    fallback is the image's UTC, so this proves the config, not the host, is the owner's clock."""
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text("timezone: Asia/Ho_Chi_Minh\n", encoding="utf-8")
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    env["TZ"] = "UTC"
    env.pop("HERMES_TIMEZONE", None)
    code = """
import json
from datetime import datetime, timedelta, timezone
from cron.jobs import parse_schedule
from hermes_time import now

tomorrow = (now() + timedelta(days=1)).date().isoformat()
parsed = parse_schedule(f"{tomorrow}T08:00:00")
print(json.dumps({"tomorrow": tomorrow, "utc": datetime.fromisoformat(parsed["run_at"]).astimezone(timezone.utc).isoformat()}))
"""
    result = json.loads(subprocess.check_output([sys.executable, "-c", code], cwd=REPO, env=env, text=True))
    # 08:00 in Vietnam is 01:00Z: the owner's clock, not the UTC host's.
    assert result["utc"] == f'{result["tomorrow"]}T01:00:00+00:00'


def test_a_reminder_at_a_future_local_time_is_exported_and_fires_once(tmp_path, monkeypatch, owner_zone):
    """Plan §3.7d: "Nhắc mình 3h chiều mai" is a `once` job at 15:00 local; the cloud exports it
    once, the occurrence's sandbox marks it run, and no later export runs it again."""
    from cron import jobs as cron_jobs

    zone = ZoneInfo("Asia/Ho_Chi_Minh")
    owner_zone("Asia/Ho_Chi_Minh")
    tomorrow = (datetime.now(zone) + timedelta(days=1)).date().isoformat()
    job = cron_jobs.create_job(prompt="Remind me to call Mum.", schedule=f"{tomorrow}T15:00:00", name="call mum")
    assert job["schedule"]["kind"] == "once"
    run_at = datetime.fromisoformat(job["next_run_at"])
    # 15:00 where the owner is, whatever zone the test process runs in.
    assert run_at.astimezone(zone).strftime("%H:%M") == "15:00"

    [summary] = _helper("home_export").schedule_summaries(cron_jobs.load_jobs())
    assert summary["scheduleId"] == job["id"]
    assert summary["nextOccurrenceAt"] == int(run_at.timestamp() * 1000)
    assert summary["catchupWindowMs"] == 7_200_000

    assert _hydrate(tmp_path, monkeypatch, job["id"], config={"timezone": "Asia/Ho_Chi_Minh"})["advanced"] == 1
    # Hermes retains a terminal receipt, while the cloud exporter omits it.
    [completed] = cron_jobs.load_jobs()
    assert completed["state"] == "completed"
    assert _helper("home_export").schedule_summaries(cron_jobs.load_jobs()) == []


def test_a_one_off_reminder_becomes_a_cloud_schedule_and_runs_once(tmp_path, monkeypatch):
    from cron import jobs as cron_jobs

    job = cron_jobs.create_job(prompt="Remind me to call Mum.", schedule="in 2h", name="call mum")
    assert job["schedule"]["kind"] == "once"
    summaries = _helper("home_export").schedule_summaries(cron_jobs.load_jobs())
    assert [s["scheduleId"] for s in summaries] == [job["id"]]
    assert summaries[0]["nextOccurrenceAt"] == int(datetime.fromisoformat(job["next_run_at"]).timestamp() * 1000)
    # Found late (a long turn, a restart), a reminder still runs within DA's widest window.
    assert summaries[0]["catchupWindowMs"] == 7_200_000

    # Its occurrence's sandbox marks it run before Hermes starts: the next export has nothing more to run.
    assert _hydrate(tmp_path, monkeypatch, job["id"])["advanced"] == 1
    assert _helper("home_export").schedule_summaries(cron_jobs.load_jobs()) == []


def test_a_repeating_job_limited_to_two_runs_runs_twice_in_the_cloud_then_stops(tmp_path, monkeypatch):
    from cron import jobs as cron_jobs

    job = cron_jobs.create_job(prompt="Check the build.", schedule="every 1m", name="build", repeat=2)
    export = _helper("home_export").schedule_summaries
    for run in (1, 2):
        assert [s["scheduleId"] for s in export(cron_jobs.load_jobs())] == [job["id"]], run
        # Each occurrence's sandbox marks the run before Hermes starts; its home is the next one's.
        assert _hydrate(tmp_path, monkeypatch, job["id"], name=f"run-{run}")["advanced"] == 1
    # Two runs made: Hermes retains the terminal receipt; the controller has no next run.
    [completed] = cron_jobs.load_jobs()
    assert completed["state"] == "completed"
    assert export(cron_jobs.load_jobs()) == []


def _jobs_from(path: Path) -> list[dict]:
    parsed = json.loads(path.read_text())
    return parsed if isinstance(parsed, list) else parsed["jobs"]


def _advance_in_fresh_process(home: Path, job_id: str) -> dict:
    """Advance a claimed occurrence the way a fresh sandbox does: a new interpreter, the
    played-forward home as ``HERMES_HOME``, the image's ``TZ=UTC`` and the controller's
    ``config.yaml`` (the only zone source). A fresh process has no clock cached."""
    if not (REPO / "packages/cloud-sandbox/entrypoint/home_hydrate.py").is_file():
        pytest.skip("Private cloud-sandbox differential helper is excluded from public client source")
    code = """
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location(
    "home_hydrate_under_test", "packages/cloud-sandbox/entrypoint/home_hydrate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.advance_schedules({"advanceSchedules": [sys.argv[1]]})))
"""
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    env["TZ"] = "UTC"
    env.pop("HERMES_TIMEZONE", None)
    return json.loads(subprocess.check_output([sys.executable, "-c", code, job_id], cwd=REPO, env=env, text=True))


@pytest.mark.parametrize("zone2", ["Asia/Tokyo", "America/New_York"])
def test_a_zone_change_follows_from_the_next_occurrence_in_both_directions(
        tmp_path, monkeypatch, owner_zone, zone2):
    """A38 D4' (natural follow): the occurrence already scheduled fires at its stored instant
    in the old zone; every later occurrence is computed in the new zone, with no occurrence
    skipped or duplicated. ``Asia/Tokyo`` is east of ``Asia/Ho_Chi_Minh``, New York west.
    The real delivery ledger needs a staging sandbox; this pins the recompute contract."""
    from cron import jobs as cron_jobs

    old, new = ZoneInfo("Asia/Ho_Chi_Minh"), ZoneInfo(zone2)
    owner_zone("Asia/Ho_Chi_Minh")
    job = cron_jobs.create_job(prompt="Morning brief.", schedule="0 8 * * *", name="brief")
    # The transition occurrence: yesterday's 08:00 where the owner was.
    transition = datetime.now(old).replace(hour=8, minute=0, second=0, microsecond=0) - timedelta(days=1)
    cron_jobs.update_job(job["id"], {"next_run_at": transition.isoformat()})
    stored = Path(os.environ["HERMES_HOME"]) / "cron" / "jobs.json"

    # The export before the change names that one occurrence at its stored instant (read at
    # the occurrence's own time, so the stale-run advance does not apply).
    from hermes_cli.atum_home import cloud_schedule_summaries

    [before] = cloud_schedule_summaries(_jobs_from(stored), now_ms=int(transition.timestamp() * 1000) + 60_000)
    assert before["scheduleId"] == job["id"]
    assert before["nextOccurrenceAt"] == int(transition.timestamp() * 1000)
    assert transition.astimezone(old).strftime("%H:%M") == "08:00"

    # The owner's report changes the winning zone; the next sandbox hydrates under Z2.
    home = tmp_path / "after-travel"
    (home / "cron").mkdir(parents=True)
    (home / "cron" / "jobs.json").write_bytes(stored.read_bytes())
    (home / "config.yaml").write_text(f"timezone: {zone2}\n", encoding="utf-8")
    assert _advance_in_fresh_process(home, job["id"]) == {"advanced": 1}

    jobs = _jobs_from(home / "cron" / "jobs.json")
    assert [entry["id"] for entry in jobs] == [job["id"]]  # no duplicate, nothing skipped
    [moved] = jobs
    last = datetime.fromisoformat(moved["last_run_at"])
    when = datetime.fromisoformat(moved["next_run_at"]).astimezone(new)
    # The following occurrence is the first 08:00 in the new zone after this run, and it is
    # strictly after the transition occurrence's stored instant.
    expected = last.astimezone(new).replace(hour=8, minute=0, second=0, microsecond=0)
    if expected <= last:
        expected += timedelta(days=1)
    assert when == expected
    assert (when.hour, when.minute) == (8, 0)
    assert datetime.fromisoformat(moved["next_run_at"]) > transition

    [after] = _helper("home_export").schedule_summaries(jobs)
    assert after["scheduleId"] == job["id"]
    assert after["nextOccurrenceAt"] == int(datetime.fromisoformat(moved["next_run_at"]).timestamp() * 1000)


def _set_next_run(job_id: str, when: datetime) -> list[dict]:
    from cron import jobs as cron_jobs

    cron_jobs.update_job(job_id, {"next_run_at": when.isoformat()})
    return cron_jobs.load_jobs()


@pytest.mark.parametrize("schedule", ["every 1m", "every 1h", "*/5 * * * *"])
def test_a_repeating_run_the_cloud_missed_is_moved_past_so_the_schedule_goes_on(schedule):
    from cron import jobs as cron_jobs
    from hermes_cli.atum_home import CLOUD_LATE_MARGIN_MS, cloud_schedule_summaries

    job = cron_jobs.create_job(prompt="Check the build.", schedule=schedule, name="build")
    # The stored next run is hours behind: a long turn, a run DA skipped, a controller restart.
    stale = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=3, seconds=17)
    jobs = _set_next_run(job["id"], stale)
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    [summary] = cloud_schedule_summaries(jobs, now_ms=now)
    # A run the controller can still claim after the commit, never one DA would record missed ...
    assert summary["nextOccurrenceAt"] + summary["catchupWindowMs"] > now + CLOUD_LATE_MARGIN_MS
    # ... and the first such run: the one before it could no longer be made.
    assert summary["nextOccurrenceAt"] <= now + CLOUD_LATE_MARGIN_MS + 3_600_000
    # The same run on every export until it is made, so a later commit never pushes it back.
    # A run whose claim window closes inside those 20 s may move on (that is the rule above), so
    # the check holds only while the run is still claimable at the later export.
    later = now + 20_000
    if summary["nextOccurrenceAt"] + summary["catchupWindowMs"] > later + CLOUD_LATE_MARGIN_MS:
        assert cloud_schedule_summaries(jobs, now_ms=later) == [summary]
    else:
        [moved] = cloud_schedule_summaries(jobs, now_ms=later)
        assert moved["nextOccurrenceAt"] > summary["nextOccurrenceAt"]


def test_an_every_minute_run_missed_by_a_long_occurrence_turn_runs_next_on_the_jobs_own_minute():
    from cron import jobs as cron_jobs
    from hermes_cli.atum_home import cloud_schedule_summaries

    job = cron_jobs.create_job(prompt="Check the build.", schedule="every 1m", name="build")
    started = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=10)
    # The occurrence's hydrate set the next run a minute after it started; the turn took four minutes.
    jobs = _set_next_run(job["id"], started + timedelta(minutes=1))
    committed = int((started + timedelta(minutes=4)).timestamp() * 1000)
    [summary] = cloud_schedule_summaries(jobs, now_ms=committed)
    next_ms = summary["nextOccurrenceAt"]
    assert (next_ms - int((started + timedelta(minutes=1)).timestamp() * 1000)) % 60_000 == 0  # the job's own phase
    assert committed - summary["catchupWindowMs"] < next_ms <= committed + 60_000


def test_a_due_repeating_run_still_in_its_window_is_kept():
    from cron import jobs as cron_jobs
    from hermes_cli.atum_home import cloud_schedule_summaries

    job = cron_jobs.create_job(prompt="Brief me.", schedule="every 1h", name="brief")
    due = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=5)
    jobs = _set_next_run(job["id"], due)
    [summary] = cloud_schedule_summaries(jobs)
    assert summary["nextOccurrenceAt"] == int(due.timestamp() * 1000)  # half an hour to catch up: it still runs


def test_a_one_off_past_its_window_is_left_out_and_the_agent_is_told(monkeypatch, legacy_home_host):
    from cron import jobs as cron_jobs
    from hermes_cli.atum_home import cloud_schedule_summaries

    job = cron_jobs.create_job(prompt="Remind me to call Mum.", schedule="in 30m", name="call mum")
    jobs = _set_next_run(job["id"], datetime.now(timezone.utc) - timedelta(hours=3))
    assert cloud_schedule_summaries(jobs) == []
    monkeypatch.setenv("ATUM_TASK_WORKSPACE", "/task/workspace")
    monkeypatch.setenv("ATUM_TASK_DEADLINE_MS", "4102444800000")
    [listed] = _cronjob(action="list")["jobs"]
    assert "will not run" in listed["cloud_warning"] and "new time" in listed["cloud_warning"]


def test_a_job_every_minute_is_a_cloud_schedule(monkeypatch):
    from cron import jobs as cron_jobs

    job = cron_jobs.create_job(prompt="Check the build.", schedule="every 1m", name="build")
    summaries = _helper("home_export").schedule_summaries(cron_jobs.load_jobs())
    assert [s["scheduleId"] for s in summaries] == [job["id"]]


def test_the_check_in_job_is_not_exported_as_an_ordinary_cloud_prompt():
    from cron.check_ins import _job_record
    from hermes_cli.atum_home import cloud_schedule_problem, cloud_schedule_summaries

    job = _job_record()

    assert cloud_schedule_summaries([job]) == []
    problem = cloud_schedule_problem(job)
    assert problem is not None and "bounded check-in gate" in problem


@pytest.mark.parametrize("atum", [
    {"kind": "check-in", "v": 2},
    {"kind": "CHECK-INS", "v": 1},
    "check-ins",
    None,
])
def test_only_the_exact_current_check_in_marker_is_guarded(atum):
    from hermes_cli.atum_home import cloud_schedule_problem

    job = {
        "id": "ordinary",
        "prompt": "Ordinary scheduled work.",
        "schedule": {"kind": "interval", "minutes": 15},
        "atum": atum,
    }
    assert cloud_schedule_problem(job) is None


@pytest.fixture
def in_cloud(monkeypatch):
    monkeypatch.setenv("ATUM_TASK_WORKSPACE", "/task/workspace")
    monkeypatch.setenv("ATUM_TASK_DEADLINE_MS", "4102444800000")


def _cronjob(**kwargs) -> dict:
    from tools.cronjob_tools import cronjob

    return json.loads(cronjob(**kwargs))


@pytest.fixture
def legacy_home_host(in_cloud):
    """The routines list as a controller reports it for a home that still holds old jobs.json entries."""
    from tools import desktop_ui

    def request(sid, event, payload, timeout):
        assert payload["operation"] == "list"  # nothing here may create or change a routine
        return json.dumps({"profile": "atum.agent-routine-command-result/1", "operation": "list", "serverTime": 1,
                           "legacyState": "present", "routines": []})

    desktop_ui.set_requester(request)
    yield
    desktop_ui.set_requester(None)


# Creating a schedule in the cloud now goes to the routines list (tests/tools/test_cronjob_cloud_routines.py): the
# refusals, the owner's clock, and the limit are the list's, not jobs.json's. What stays here is the old-home-job
# path, for a home that arrives with live jobs.json entries.


def test_the_cronjob_tool_in_the_cloud_explains_the_stored_check_in_guard(legacy_home_host):
    from cron import jobs as cron_jobs
    from cron.check_ins import _job_record

    cron_jobs.save_jobs([_job_record()])
    [listed] = _cronjob(action="list")["jobs"]
    assert "bounded check-in gate" in listed["cloud_warning"]
    assert listed["legacy_home_job"] is True


def test_a_changed_old_job_the_cloud_will_not_run_says_so(legacy_home_host):
    from cron import jobs as cron_jobs

    old = cron_jobs.create_job(prompt="Brief me.", schedule="every 1h", name="brief")
    changed = _cronjob(action="update", job_id=old["id"], workdir=os.environ["HERMES_HOME"])
    assert changed["success"] is True
    assert "workdir" in changed["job"]["cloud_warning"]
    listed = _cronjob(action="list")["jobs"]
    assert "cloud_warning" in listed[0]


def test_outside_the_cloud_the_cronjob_tool_is_unchanged(monkeypatch):
    monkeypatch.delenv("ATUM_TASK_WORKSPACE", raising=False)
    monkeypatch.delenv("ATUM_TASK_DEADLINE_MS", raising=False)
    scripts = Path(os.environ["HERMES_HOME"]) / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    (scripts / "collect.py").write_text("print('data')\n")

    created = _cronjob(action="create", prompt="Summarize the data.", schedule="every 1h", script="collect.py")
    assert created["success"] is True
    assert "cloud_warning" not in _cronjob(action="list")["jobs"][0]
