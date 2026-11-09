"Hermes `cronjob` words <-> Atum agent-routines schedules (atum.agent-routines/1.1).\n\nIn Atum's cloud the agent's schedules are rows of the platform's one routines list, not entries in the\nsandbox's jobs.json . Hermes still parses the\nwords the model writes (cron.jobs.parse_schedule); this module is the pure second step that turns that\nparsed form into the contract's structured schedule, and says plainly why when it cannot. Nothing here\ntouches the clock, the disk or the network, so every supported form and every refusal is a unit test.\n\nThis file is the only Python place that knows the routine wire shapes, so the vendored contract pack can\nreplace it in one move. No raw cron expression ever crosses the boundary (v1.1 forbids it).\n"

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Mapping, Optional, Sequence

#: The contract's closed bounds (spec/agent-routines/v1.1 contract.json).
TITLE_MAX = 120
INSTRUCTION_MAX = 20000
INTERVAL_HOURS_MIN = 1
INTERVAL_HOURS_MAX = 8760
MONTH_DAY_MAX = 28

#: `interval` rows are accepted by the platform contract, but a phone build that predates the compatible
#: decoder fails the owner's whole list on an unknown kind. The plan (routines-ui-plan.md, order for the owner's
#: agents) keeps emission off until that decoder is in the wild; flipping this one constant turns it on.
INTERVAL_EMISSION_ENABLED = False

_WEEKDAY_NAMES = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}
_PLAIN_INT = re.compile(r"^\d{1,2}$")


@dataclass(frozen=True)
class Mapped:
    """A structured routine schedule, or the reason there is none. Exactly one of the two is set."""

    schedule: Optional[dict[str, Any]] = None
    refusal: Optional[str] = None


def _refuse(reason: str) -> Mapped:
    return Mapped(refusal=reason)


def _once(parsed: Mapping[str, Any]) -> Mapped:
    run_at = parsed.get("run_at")
    if not isinstance(run_at, str) or not run_at:
        return _refuse("The one-time schedule has no run time.")
    try:
        moment = datetime.fromisoformat(run_at)
    except ValueError:
        return _refuse("The one-time schedule's run time could not be read.")
    if moment.tzinfo is None:
        # parse_schedule always anchors a naive time to Hermes's zone; one that reaches here is not safe to guess.
        return _refuse("The one-time schedule needs a time with its own UTC offset.")
    return Mapped(schedule={"kind": "once", "runAt": moment.replace(microsecond=0).isoformat()})


def _interval(parsed: Mapping[str, Any]) -> Mapped:
    minutes = parsed.get("minutes")
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes <= 0:
        return _refuse("The repeat interval could not be read.")
    if minutes < 60:
        return _refuse(
            "Atum's cloud does not run a schedule more often than once an hour. Choose an hourly or slower "
            "cadence, or a daily, weekly or monthly time."
        )
    if minutes % 60:
        return _refuse("Repeat intervals must be a whole number of hours (for example every 2 hours).")
    hours = minutes // 60
    if hours > INTERVAL_HOURS_MAX:
        return _refuse("Repeat intervals can be at most one year; use a monthly or one-time schedule instead.")
    if not INTERVAL_EMISSION_ENABLED:
        return _refuse(
            "Repeating every N hours is not available in the schedule list yet. Use a daily, weekly or monthly "
            "time (for example daily at 09:00), or a one-time schedule."
        )
    return Mapped(schedule={"kind": "interval", "everyHours": hours})


def _plain_int(field: str, low: int, high: int) -> Optional[int]:
    if not _PLAIN_INT.match(field):
        return None
    value = int(field)
    return value if low <= value <= high else None


def _weekdays(field: str) -> Optional[Sequence[int]]:
    """ISO weekdays (1 Monday .. 7 Sunday) from a cron day-of-week list or range; None when not plain."""
    days = set()
    for part in field.split(","):
        bounds = part.split("-")
        if len(bounds) > 2 or any(not _PLAIN_INT.match(bound) for bound in bounds):
            return None
        start = int(bounds[0])
        end = int(bounds[-1])
        if start > 7 or end > 7 or start > end:
            return None
        days.update(range(start, end + 1))
    iso = sorted({7 if day in (0, 7) else day for day in days})
    return iso or None


def _cron(parsed: Mapping[str, Any]) -> Mapped:
    expression = parsed.get("expr")
    fields = expression.split() if isinstance(expression, str) else []
    if len(fields) != 5:
        return _refuse("Only five-field cron expressions (minute hour day month weekday) are supported.")
    minute_field, hour_field, day_field, month_field, weekday_field = fields
    minute = _plain_int(minute_field, 0, 59)
    hour = _plain_int(hour_field, 0, 23)
    if minute is None or hour is None:
        return _refuse(
            "The schedule repeats within the day (a wildcard, range or step in the minute or hour). Atum's cloud "
            "runs a schedule at one time of day: use 'M H * * *' for daily, weekly with weekdays, or a day of the month."
        )
    if month_field != "*":
        return _refuse("A schedule limited to certain months is not supported. Use a monthly day or a one-time schedule.")
    if day_field == "*" and weekday_field == "*":
        return Mapped(schedule={"kind": "daily", "hour": hour, "minute": minute})
    if day_field == "*":
        days = _weekdays(weekday_field)
        if days is None:
            return _refuse("The weekdays must be plain numbers, lists or ranges (for example 1-5 or 1,3,5).")
        return Mapped(schedule={"kind": "weekly", "hour": hour, "minute": minute, "weekdays": list(days)})
    if weekday_field != "*":
        return _refuse("A schedule on both a day of the month and a weekday is not supported; choose one.")
    day = _plain_int(day_field, 1, 31)
    if day is None:
        return _refuse("The day of the month must be one number (lists, ranges and steps are not supported).")
    if day > MONTH_DAY_MAX:
        return _refuse(f"Monthly schedules run on days 1 to {MONTH_DAY_MAX}, so every month has the day.")
    return Mapped(schedule={"kind": "monthly", "day": day, "hour": hour, "minute": minute})


def map_parsed_schedule(parsed: Mapping[str, Any]) -> Mapped:
    """The structured schedule for one ``cron.jobs.parse_schedule`` result, or the reason it cannot be run.

    ``once`` (a timestamp or 'in 30m'/'in 2h'/'in 1d') -> ``once``; bare durations or ``every Nh`` -> ``interval`` (while emission is
    on); a five-field cron expression of the shape ``M H * * *`` / ``M H * * weekdays`` / ``M H D * *`` -> daily /
    weekly / monthly. Everything else is refused with a reason, never approximated.
    """
    kind = parsed.get("kind") if isinstance(parsed, Mapping) else None
    if kind == "once":
        return _once(parsed)
    if kind == "interval":
        return _interval(parsed)
    if kind == "cron":
        return _cron(parsed)
    return _refuse("That schedule form is not supported.")


#: `cronjob` arguments a routine has no place for. A routine is "run this instruction at this time"; these would
#: change what a run does or where it goes, so each is refused by name, never silently dropped.
_UNSUPPORTED_FIELDS = (
    ("skill", "attached skills"),
    ("skills", "attached skills"),
    ("model", "a model override"),
    ("provider", "a provider override"),
    ("base_url", "a base_url override"),
    ("script", "a pre-run script"),
    ("context_from", "chaining from another job"),
    ("enabled_toolsets", "a toolset restriction"),
    ("workdir", "a working directory"),
)
_DELIVER_OK = {"", "local", "origin"}


def unsupported_fields(arguments: Mapping[str, Any]) -> Optional[str]:
    """The reason a `cronjob` call carries something routines cannot hold; None when it is plain.

    A field counts only when it is set. ``enabled_toolsets=[]`` is the exception: Hermes uses that
    exact empty list as an owner-chosen zero-tool allowlist, so a routine that cannot store it must
    refuse it rather than silently widen the future run.
    """
    named = []
    for field, label in _UNSUPPORTED_FIELDS:
        value = arguments.get(field)
        is_explicit_toolset = field == "enabled_toolsets" and field in arguments and value is not None
        if (is_explicit_toolset or value not in (None, "", [], False)) and label not in named:
            named.append(label)
    if arguments.get("no_agent"):
        named.append("a no-agent script job")
    if arguments.get("attach_to_session"):
        named.append("attaching to a session")
    deliver = arguments.get("deliver")
    if isinstance(deliver, str) and deliver.strip().lower() not in _DELIVER_OK:
        named.append("a delivery target (results always post in this agent's chat)")
    if not named:
        return None
    return (
        "Atum's schedule list cannot hold " + ", ".join(named) + ". A scheduled task is an instruction run at a time, "
        "posted in this agent's chat; put what it needs in the instruction itself."
    )


def repeat_problem(repeat: Any, schedule: Mapping[str, Any]) -> Optional[str]:
    """A repeat count is Hermes's; routines repeat until deleted (once-only schedules run once by nature)."""
    if repeat is None or isinstance(repeat, bool):
        return None
    if isinstance(repeat, int) and repeat <= 0:
        return None
    if isinstance(repeat, int) and repeat == 1 and schedule.get("kind") == "once":
        return None
    return (
        "Atum's schedule list has no repeat count: a recurring schedule repeats until it is paused or removed. "
        "Leave repeat out, or use a one-time schedule."
    )


def build_title(name: Optional[str], prompt: str) -> str:
    """The routine's title: the given name, else the instruction's first words, within the contract's limit."""
    source = (name or "").strip() or " ".join(prompt.split())
    source = " ".join(source.split())
    if len(source) <= TITLE_MAX:
        return source or "Scheduled task"
    return source[: TITLE_MAX - 1].rstrip() + "…"


def describe_schedule(schedule: Mapping[str, Any]) -> str:
    """A short, stable reading of a structured schedule for the model's replies ("weekly Mon,Wed 09:00")."""
    kind = schedule.get("kind")
    if kind == "once":
        return f"once at {schedule.get('runAt')}"
    if kind == "interval":
        return f"every {schedule.get('everyHours')}h"
    clock = f"{int(schedule.get('hour', 0)):02d}:{int(schedule.get('minute', 0)):02d}"
    if kind == "daily":
        return f"daily {clock}"
    if kind == "weekly":
        names = ",".join(_WEEKDAY_NAMES.get(day, str(day)) for day in schedule.get("weekdays") or [])
        return f"weekly {names} {clock}"
    if kind == "monthly":
        return f"monthly day {schedule.get('day')} {clock}"
    return "unsupported schedule"
