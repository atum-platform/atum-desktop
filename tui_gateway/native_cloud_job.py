"""One platform-claimed Hermes job run for Atum's cloud controller.

This is an execution adapter, not a scheduler: the platform already claimed the occurrence and
funded its model grant. The sandbox has no local ticker. A sandbox-only ``cron/jobs.json``
projection is hydrated before this is called; this module loads that exact job and invokes the
native ``run_one_job`` body. Matrix delivery uses Hermes's existing host adapter, which the
controller intercepts and commits through its durable outbox.
"""

from __future__ import annotations

import os
import re
from typing import Any

from cron.scheduler_provider import CronScheduler

JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
UUID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
ROOM_ID = re.compile(r"^![!-~]{1,1023}$")


class AtumCronScheduler(CronScheduler):
    """Platform-claimed adapter over Hermes's additive CronScheduler fire seam.

    The controller/platform own arm, reconcile and claim. This sandbox adapter owns only the
    already-claimed native fire and intentionally has no local ticker or built-in fallback.
    """

    @property
    def name(self) -> str:
        return "atum"

    def start(self, stop_event, *, adapters=None, loop=None, interval=60) -> None:
        raise RuntimeError("atum_scheduler_is_platform_owned")

    def fire_claimed(self, claimed_job: dict[str, Any], *, adapters: Any = None, loop: Any = None,
                     sweep_gate: str | None = None) -> bool:
        # The platform owns failure diagnostics. A native failure summary must never
        # enter the successful-answer outbox or survive recovery as an answered turn.
        # Managed pre-run scripts are evidence gates. N5 routine projections
        # contain no script; ordinary standalone cron never uses this provider.
        return super().fire_claimed(
            claimed_job, adapters=adapters, loop=loop, deliver_failures=False,
            require_script_gate=sweep_gate is not None or bool(claimed_job.get("script")),
            native_claimed=True,
            **({"native_sweep_gate": sweep_gate} if sweep_gate is not None else {}),
        )


def run_claimed_native_job(params: dict[str, Any]) -> dict[str, Any]:
    """Invoke native Hermes execution once for an already-claimed platform occurrence."""
    if os.environ.get("ATUM_TASK_WORKSPACE") != "/task/workspace" or not re.fullmatch(
        r"[A-Za-z0-9_-]{40,64}", os.environ.get("ATUM_MODEL_KEY", "")
    ):
        raise RuntimeError("native_cloud_runtime_required")
    from tui_gateway.desktop_ui_bridge import wire

    wire()  # Cron constructs its agent without the interactive _agent_cbs hook.
    return _run_claimed_job(params)


def run_claimed_desktop_job(params: dict[str, Any]) -> dict[str, Any]:
    """Desktop occurrence child only; never expose this on the interactive gateway.

    The host creates a private occurrence home and an occurrence-scoped loopback model
    credential. Process isolation is mandatory: native cron mutates process-global config.
    This entry has no due scan, owns no timer, and cannot use interactive model credentials.
    """
    from pathlib import Path
    from urllib.parse import urlsplit
    from hermes_cli.web_server import _desktop_cron_enabled

    execution_id = params.get("execution_id")
    home = Path(os.environ.get("HERMES_HOME", ""))
    base = urlsplit(os.environ.get("ATUM_MANAGED_MODEL_BASE_URL", ""))
    if (not isinstance(execution_id, str) or not UUID.fullmatch(execution_id)
            or os.environ.get("ATUM_DESKTOP_JOB_EXECUTION") != execution_id
            or not home.is_absolute() or home.name != execution_id
            or os.environ.get("HERMES_DESKTOP_CRON") != "0"
            or _desktop_cron_enabled(os.environ)
            or base.scheme != "http" or base.hostname != "127.0.0.1"
            or base.path != "/v1" or base.username or base.password
            or not re.fullmatch(r"[A-Za-z0-9_-]{43}", os.environ.get("ATUM_MODEL_KEY", ""))):
        raise RuntimeError("native_desktop_occurrence_required")
    result = _run_claimed_job(params)
    from cron.jobs import get_job
    after = get_job(params["job_id"])
    delivery_error = after.get("last_delivery_error") if isinstance(after, dict) else None
    if delivery_error:
        result["status"] = "error"
        result["reason"] = ("durable_delivery_unavailable" if "durable_delivery_unavailable" in delivery_error
                            else "managed_delivery_pending")
    return result


def _run_claimed_job(params: dict[str, Any]) -> dict[str, Any]:
    """Shared native body after the surface-specific process guard."""
    if set(params) not in ({"job_id", "execution_id", "room_id"}, {"job_id", "execution_id", "room_id", "sweep_gate"}):
        raise ValueError("native_cloud_job_invalid")
    job_id = params.get("job_id")
    execution_id = params.get("execution_id")
    room_id = params.get("room_id")
    if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
        raise ValueError("native_cloud_job_invalid")
    if not isinstance(execution_id, str) or not UUID.fullmatch(execution_id):
        raise ValueError("native_cloud_job_invalid")
    if not isinstance(room_id, str) or not ROOM_ID.fullmatch(room_id):
        raise ValueError("native_cloud_job_invalid")

    from tui_gateway.server import _load_cfg
    cfg = _load_cfg()
    sweep_gate = params.get("sweep_gate")
    if cfg.get("atum_followup_sweep") is True and "sweep_gate" not in params:
        # Missing transport cannot downgrade a sweep into an ordinary routine.
        sweep_gate = ""
    if sweep_gate is not None or "sweep_gate" in params:
        if not isinstance(sweep_gate, str) or cfg.get("atum_followup_sweep") is not True or cfg.get("plugins", {}).get("enabled") != []:
            raise ValueError("native_sweep_profile_invalid")

    from cron.executions import create_execution, get_execution
    from cron.jobs import get_job
    from hermes_cli.web_server import _desktop_cron_delivery, _desktop_cron_enabled

    # Defense in depth: a claimed cloud sandbox must never also own an autonomous clock.
    if _desktop_cron_enabled(os.environ):
        raise RuntimeError("native_cloud_ticker_enabled")
    stored = get_job(job_id)
    if stored is None:
        raise RuntimeError("native_cloud_job_missing")
    execution = get_execution(execution_id)
    if execution is None:
        create_execution(job_id, source="atum", execution_id=execution_id)
    elif execution.get("job_id") != job_id or execution.get("status") != "claimed":
        raise RuntimeError("native_cloud_execution_unavailable")

    # Audience authority is the platform occurrence, not the definition's provenance-only
    # ``origin:{platform:'atum'}``. Rebind only the native delivery seam and use the occurrence as
    # Hermes's idempotency identity; all definition-bearing execution fields stay untouched.
    job = {
        **stored,
        "deliver": "origin",
        "origin": {"platform": "matrix", "chat_id": room_id},
        "attach_to_session": False,
        "execution_id": execution_id,
    }
    if sweep_gate is not None:
        # Host-owned classifier profile: mutable projected job fields cannot widen it.
        job.update(prompt="", skills=[], skill=None, model=None, provider=None, base_url=None,
                   script=None, no_agent=False, monitor_script=None, monitor_url=None,
                   context_from=None, enabled_toolsets=[], workdir=None)
    adapters, loop, _profile_adapters, stop_delivery = _desktop_cron_delivery()
    try:
        processed = bool(AtumCronScheduler().fire_claimed(job, adapters=adapters, loop=loop,
            **({"sweep_gate": sweep_gate} if sweep_gate is not None else {})))
    finally:
        stop_delivery()

    after = get_job(job_id)
    status = after.get("last_status") if isinstance(after, dict) else None
    delivery_error = after.get("last_delivery_error") if isinstance(after, dict) else None
    delivery_reason = (
        "durable_delivery_unavailable"
        if delivery_error and "durable_delivery_unavailable" in delivery_error
        else "managed_delivery_pending" if delivery_error else None
    )
    return {
        "job_id": job_id,
        "execution_id": execution_id,
        "processed": processed,
        **(
            {"reason": delivery_reason}
            if delivery_reason is not None
            else {
                "reason": (
                    after.get("last_error")
                    if isinstance(after, dict)
                    and re.fullmatch(
                        r"[a-zA-Z0-9_.:/-]{1,200}", str(after.get("last_error", ""))
                    )
                    else "native_execution_error"
                )
            }
            if sweep_gate is not None
            else {}
        ),
        "status": (
            "error"
            if delivery_reason is not None
            else status if status in {"ok", "error"}
            else "ok" if processed
            else "error"
        ),
    }
