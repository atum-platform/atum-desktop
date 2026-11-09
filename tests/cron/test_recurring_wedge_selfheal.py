"""Preserve recovery, isolation and completion behavior across failures."""
from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone, UTC
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))


@pytest.fixture
def cron_env(tmp_path, monkeypatch):
    """Isolated cron env + a recurring no_agent interval job, due NOW."""
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
    now = datetime.now(UTC)
    jobs_mod.update_job(job["id"], {"next_run_at": (now - timedelta(minutes=1)).isoformat()})

    script = hermes_home / "scripts" / "probe.py"
    script.write_text("print('ok')\n")

    return {"home": hermes_home, "job_id": job["id"]}


class TestStaleInflightSelfHeal:
    def _setup(self, cron_env, monkeypatch):
        from cron import scheduler as S
        from cron import executions as E

        env = cron_env
        monkeypatch.setattr(E, "EXECUTIONS_FILE", env["home"] / "cron" / "executions.db")
        monkeypatch.setattr(S, "_hermes_home", env["home"])
        return S, E, env

    def test_stale_claim_self_heals_and_redispatches(self, cron_env, monkeypatch):
        """GREEN contract: a leaked in-flight claim is force-released by the
        next tick and the wedged job re-fires without a force-run."""
        S, E, env = self._setup(cron_env, monkeypatch)
        job_id = env["job_id"]
        import cron.jobs as J


        # Preserve state, recovery and failure handling across interrupted operations.
        S._running_job_ids.clear()
        S._running_since.clear()
        S._running_futures.clear()
        S._running_job_ids.add(S._inflight_key(job_id))
        S._running_since[S._inflight_key(job_id)] = time.time() - 6 * 60 * 60

        # get_due_jobs is called inside tick BEFORE the sweep; we patch it to
        # return the wedged job as due so the in-cycle sweep releases the claim
        # and the dispatch loop re-fires it.
        job = J.get_job(job_id)
        with mock.patch("cron.jobs.load_jobs", return_value=[job]):
            S.tick(verbose=False, sync=True)

        latest = E.latest_execution(job_id)
        assert job_id not in S.get_running_job_ids(), "stale claim must be released"
        assert latest is not None, "wedged job must create an execution"
        assert latest["status"] == "completed", (
            "wedged job must fire again without force-run"
        )


    def test_guard_stats_reported(self, cron_env, monkeypatch):
        """The guard must surface a countable forced-release signal."""
        S, _E, env = self._setup(cron_env, monkeypatch)
        import cron.jobs as J

        S._running_job_ids.clear()
        S._running_since.clear()
        S._running_futures.clear()
        S._running_job_ids.add(S._inflight_key(env["job_id"]))
        S._running_since[S._inflight_key(env["job_id"])] = time.time() - 6 * 60 * 60
        S.sweep_stale_inflight([J.get_job(env["job_id"])])
        stats = S.get_inflight_guard_stats()
        assert stats["forced_releases"] >= 1
        assert env["job_id"] not in S.get_running_job_ids()


class TestEAGAINCreateExecutionLeak:
    """The 12:50 mechanism: EAGAIN/thread-exhaustion strikes BETWEEN the
    in-flight claim and execution creation (create_execution / pool.submit).
    The claim must be released immediately so the next tick re-dispatches."""


    def test_pool_submit_eagain_releases_claim_and_redispatches(self, cron_env, monkeypatch, tmp_path):
        from cron import scheduler as S
        from cron import executions as E
        import cron.jobs as J

        env = cron_env
        monkeypatch.setattr(E, "EXECUTIONS_FILE", env["home"] / "cron" / "executions.db")
        monkeypatch.setattr(S, "_hermes_home", env["home"])
        job_id = env["job_id"]
        job = J.get_job(job_id)

        S._running_job_ids.clear()
        S._running_since.clear()
        S._running_futures.clear()

        # First tick: pool.submit raises EAGAIN (thread exhaustion). The claim
        # is released and the run recorded as failed.
        real_submit = S.concurrent.futures.ThreadPoolExecutor.submit
        state = {"n": 0}
        def flaky(self, *a, **k):
            state["n"] += 1
            if state["n"] == 1:
                raise OSError(11, "Resource temporarily unavailable")
            return real_submit(self, *a, **k)
        monkeypatch.setattr(S.concurrent.futures.ThreadPoolExecutor, "submit", flaky)

        with mock.patch("cron.jobs.load_jobs", return_value=[job]):
            S.tick(verbose=False, sync=True)

        # Claim released; job still scheduled.
        assert job_id not in S.get_running_job_ids()

        # Second tick (substrate recovered): job re-dispatches and completes.
        now = datetime.now(UTC)
        J.update_job(job_id, {"next_run_at": (now - timedelta(minutes=1)).isoformat()})
        with mock.patch("cron.jobs.load_jobs", return_value=[J.get_job(job_id)]):
            S.tick(verbose=False, sync=True)

        latest = E.latest_execution(job_id)
        assert latest is not None and latest["status"] == "completed", (
            "job must re-dispatch on the next tick after EAGAIN recovery"
        )
