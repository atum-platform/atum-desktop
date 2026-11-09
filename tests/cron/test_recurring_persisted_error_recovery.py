"""Preserve recovery, isolation and completion behavior across failures."""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone, UTC
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))


@pytest.fixture
def cron_env(tmp_path, monkeypatch):
    """Isolated cron env + a recurring no_agent interval job."""
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    (hermes_home / "cron").mkdir()
    (hermes_home / "cron" / "output").mkdir()
    (hermes_home / "scripts").mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    import cron.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "HERMES_DIR", hermes_home)
    monkeypatch.setattr(jobs_mod, "CRON_DIR", hermes_home / "cron")
    monkeypatch.setattr(jobs_mod, "JOBS_FILE", hermes_home / "cron" / "jobs.json")
    monkeypatch.setattr(jobs_mod, "OUTPUT_DIR", hermes_home / "cron" / "output")

    job = jobs_mod.create_job(
        prompt="probe",
        schedule="every 10m",
        no_agent=True,
        script="probe.py",
    )
    script = hermes_home / "scripts" / "probe.py"
    script.write_text("print('ok')\n")
    return {"home": hermes_home, "job_id": job["id"]}


def _setup(cron_env, monkeypatch):
    from cron import scheduler as S
    from cron import executions as E
    import cron.jobs as J

    env = cron_env
    monkeypatch.setattr(E, "EXECUTIONS_FILE", env["home"] / "cron" / "executions.db")
    monkeypatch.setattr(S, "_hermes_home", env["home"])
    return S, E, J, env


def _persist_stale_error(J, job_id, *, error_age_minutes=110):
    """Preserve recovery, isolation and completion behavior across failures."""
    now = datetime.now(UTC)
    J.update_job(
        job_id,
        {
            "next_run_at": (now + timedelta(minutes=5)).isoformat(),
            "last_status": "error",
            "last_error": "EAGAIN [Errno 11] Resource temporarily unavailable",
            "last_run_at": (now - timedelta(minutes=error_age_minutes)).isoformat(),
        },
    )


class TestPersistedStaleErrorRecovery:
    def test_stale_error_recurring_job_redispatches_without_force_run(
        self, cron_env, monkeypatch
    ):
        """GREEN: a recurring job wedged in a persisted stale-error state with
        next_run_at parked in the future is re-armed and re-dispatches on the
        next tick — no force-run, no resume."""
        S, E, J, env = _setup(cron_env, monkeypatch)
        job_id = env["job_id"]

        _persist_stale_error(J, job_id, error_age_minutes=110)

        job = J.get_job(job_id)
        with mock.patch("cron.jobs.load_jobs", return_value=[job]):
            S.tick(verbose=False, sync=True)

        latest = E.latest_execution(job_id)
        assert latest is not None, (
            "wedged stale-error job must be re-dispatched without force-run"
        )
        assert latest["status"] == "completed"
        # The recovery must be countable / probe-visible.
        from cron import jobs as Jmod
        stats = Jmod.get_persisted_error_recovery_stats()
        assert stats["persisted_error_recoveries"] >= 1


    def test_recent_error_within_cadence_not_force_rearmed(self, cron_env, monkeypatch):
        """The discriminator must NOT re-arm a normal transient error whose
        last_run is within a full cadence — that job retries on its own
        schedule and must be left alone (otherwise we'd over-fire healthy
        erroring jobs)."""
        S, E, J, env = _setup(cron_env, monkeypatch)
        job_id = env["job_id"]

        _persist_stale_error(J, job_id, error_age_minutes=5)  # within cadence

        job = J.get_job(job_id)
        with mock.patch("cron.jobs.load_jobs", return_value=[job]):
            S.tick(verbose=False, sync=True)

        latest = E.latest_execution(job_id)
        assert latest is None, (
            "a within-cadence error is a normal retry — must not be "
            "force-re-armed onto an immediate fire"
        )

    def test_live_fire_claim_from_other_process_not_rearmed(self, cron_env, monkeypatch):
        """Preserve recovery, isolation and completion behavior across failures."""
        S, E, J, env = _setup(cron_env, monkeypatch)
        job_id = env["job_id"]

        _persist_stale_error(J, job_id, error_age_minutes=110)
        now = datetime.now(UTC)
        J.update_job(
            job_id,
            {"fire_claim": {"at": now.isoformat(), "by": "other-host:deadbeef"}},
        )

        job = J.get_job(job_id)
        assert not J._job_is_stale_error_recurring(job, job["schedule"], now)

        with mock.patch("cron.jobs.load_jobs", return_value=[job]):
            S.tick(verbose=False, sync=True)
        assert E.latest_execution(job_id) is None, (
            "a job with a live fire_claim held by another process must not be "
            "re-armed by stale-error recovery"
        )

        # Once the foreign claim has expired (owner died), recovery resumes.
        expired = (now - timedelta(seconds=J.FIRE_CLAIM_TTL_SECONDS + 1)).isoformat()
        J.update_job(job_id, {"fire_claim": {"at": expired, "by": "other-host:deadbeef"}})
        assert J._job_is_stale_error_recurring(J.get_job(job_id), job["schedule"], now)
