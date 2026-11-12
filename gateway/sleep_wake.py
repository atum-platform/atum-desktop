"""Host-neutral stopped-runtime policy. No message intake or schedule execution.

Facts must be fresh, complete, and read under the runtime admission exclusion.
Unknown probes stay awake. Epoch deadlines survive host restarts. A wake hint is
not an accepted event: the existing Matrix journal resumes from its saved cursor.
"""
from dataclasses import dataclass
import math
from typing import Protocol

from gateway.scale_to_zero import is_idle


@dataclass(frozen=True)
class Policy:
    idle_seconds: float = 600
    wake_ahead_seconds: float = 120

    def __post_init__(self):
        if any(not math.isfinite(v) or v <= 0 for v in
               (self.idle_seconds, self.wake_ahead_seconds)):
            raise ValueError('invalid sleep policy')


@dataclass(frozen=True)
class Facts:
    now: float
    last_activity: float
    active_work: int
    background_work: bool
    open_operations: int
    pending_intake: bool
    next_due: float | None
    probes_complete: bool = True
    wake_coverage: bool = False


@dataclass(frozen=True)
class Decision:
    sleep: bool
    wake_at: float | None
    reason: str


def decide(policy: Policy, facts: Facts) -> Decision:
    numeric = (facts.now, facts.last_activity, facts.active_work, facts.open_operations)
    if (not facts.probes_complete or not all(math.isfinite(v) for v in numeric)
            or facts.active_work < 0 or facts.open_operations < 0
            or (facts.next_due is not None and not math.isfinite(facts.next_due))):
        return Decision(False, None, 'unknown')
    wake_at = None if facts.next_due is None else facts.next_due - policy.wake_ahead_seconds
    if not facts.wake_coverage:
        return Decision(False, wake_at, 'no_waker')
    if facts.open_operations or facts.pending_intake:
        return Decision(False, wake_at, 'pending_work')
    if wake_at is not None and facts.now >= wake_at:
        return Decision(False, wake_at, 'schedule')
    idle = is_idle(active_work_count=facts.active_work,
                   seconds_since_last_inbound=facts.now - facts.last_activity,
                   idle_timeout_seconds=policy.idle_seconds,
                   has_live_background_work=facts.background_work)
    return Decision(idle, wake_at, 'idle' if idle else 'busy')


class WakeRequests(Protocol):
    """Small waker service port; called by an authenticated host-side hint route.

    key is the authoritative owner/computer/agent/audience/generation identity,
    resolved by the host, never trusted from an arbitrary push body. Duplicate
    requests coalesce durably. Stop is a latch; only an explicit authorized start
    may release it. The host owns serialization with lifecycle reconciliation.
    """
    def hint(self, key: str) -> None: ...
    def stop(self, key: str) -> None: ...
    def resume(self, key: str) -> None: ...


def next_native_schedule(home) -> float | None:
    """Read Hermes's next occurrence; never execute or advance a job here.

    Failure (including an enabled job without a resolved instant) is unknown,
    not an empty schedule. Host publishes changes and re-reads before stopping.
    Native scheduler remains the sole occurrence/claim owner.
    """
    from datetime import datetime
    from cron.jobs import load_jobs, use_cron_store, is_job_runnable, is_terminal_job
    with use_cron_store(home):
        jobs = load_jobs()
    deadlines = []
    for job in jobs:
        if not is_job_runnable(job):
            continue
        if job.get('pending_slot'):
            raise ValueError('unclaimed schedule occurrence needs native recovery')
        if job.get('state') == 'error':
            raise ValueError('schedule needs native recovery')
        if is_terminal_job(job):
            continue
        instant = datetime.fromisoformat(job['next_run_at'])
        if instant.tzinfo is None:
            raise ValueError('schedule instant must have timezone')
        deadlines.append(instant.timestamp())
    return min(deadlines, default=None)
