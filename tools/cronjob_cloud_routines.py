'The `cronjob` tool inside an Atum cloud sandbox: a client of the agent\'s one routines list.\n\nOutside the cloud `cronjob` keeps Hermes\'s local scheduler untouched. Inside a cloud task sandbox the\nagent\'s schedules are platform routines , so a\nreminder set in chat appears on the agent card and an edit made there is what the agent sees. Handler\nbehaviour only: the tool\'s schema and description are unchanged.\n\nBridge: `desktop_ui.request("atum.routines.request", command)` -> tui_gateway (turn-bound, closed fields)\n-> the controller -> the platform\'s executor command route. The sandbox holds no platform authority and\nno credential; the controller supplies identity and the mutation request ID. The command bodies here are\nthe atum.agent-routine-command/1 variants WITHOUT identity or request ID.\n\nOnly a call this module cannot own returns None, which sends it down the local path: a job id that names\nan old job in this home (the check-in marker guard lives there).\n'

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from cron.routines_mapper import (
    INSTRUCTION_MAX,
    build_title,
    describe_schedule,
    map_parsed_schedule,
    repeat_problem,
    unsupported_fields,
)
from tools import desktop_ui
from tools.registry import tool_error

COMMAND_EVENT = "atum.routines.request"
PROFILE = "atum.agent-routine-command/1"
RESULT_PROFILE = "atum.agent-routine-command-result/1"
#: A list plus a mutation is two platform round trips; the gateway caps one request at this budget.
HOST_TIMEOUT_SECONDS = 60

_UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
_RUN_ACTIONS = {"run", "run_now", "trigger"}
_ACTIONS = {"create", "list", "update", "pause", "resume", "remove", "run", "run_now", "trigger"}

#: What the model is told for each refusal the platform can return (closed set, atum.agent-routine-command-result/1).
_REFUSALS = {
    "legacy_schedules_present": (
        "This agent still has older scheduled jobs from before the move to the schedule list, so new tasks cannot be "
        "added yet. Tell the owner; they are being moved across."
    ),
    "unsupported_schedule": (
        "The schedule list does not run that kind of schedule yet. Pick a daily, weekly, monthly or one-time schedule."
    ),
    "quota": "The schedule list is full (64 tasks). Remove one before adding another.",
    "not_found": "That scheduled task no longer exists. List the tasks again.",
    "denied": "Scheduling is not allowed for this agent right now.",
    "request_conflict": "That exact request was already made differently. List the tasks and try again.",
    "revision_conflict": (
        "The task was changed (probably by the owner on the agent card) after it was read. Nothing was changed. "
        "List the tasks again, then repeat the change on what is there now."
    ),
}
_ERRORS = {
    "invalid": "The schedule list rejected that task as invalid. Check the instruction, title and schedule.",
    "unavailable": (
        "The schedule list did not return a usable result. If this was a change, list the tasks before retrying so "
        "an unconfirmed change is not repeated."
    ),
}
_HOST_ERRORS = {
    ("invalid", "request_invalid"): (
        "The agent could not form a valid schedule request. Nothing was changed. Retry once; if it repeats, tell the "
        "owner this agent's scheduling bridge needs repair."
    ),
    ("invalid", "platform_invalid"): (
        "The schedule service rejected the request shape. Nothing was changed. Check the task fields, then retry once."
    ),
    ("refused", "access_denied"): "This agent is not allowed to use the schedule list. Nothing was changed; tell the owner.",
    ("unavailable", "route_not_found"): (
        "This controller does not have the schedule command route. Nothing was changed; tell the owner an update is required."
    ),
    ("unavailable", "rate_limited"): "The schedule service is busy. Nothing was changed; wait briefly, then retry.",
    ("unavailable", "store_unavailable"): (
        "The schedule store did not return a usable result. If this was a change, list the tasks before retrying."
    ),
    ("unavailable", "outcome_unknown"): (
        "The schedule service did not confirm the result. List the tasks first; if the change is absent, retry the exact request."
    ),
    ("unavailable", "response_invalid"): (
        "The schedule service returned an invalid result. If this was a change, list the tasks before retrying; if it repeats, "
        "tell the owner."
    ),
    ("unavailable", "provider_unavailable"): (
        "The schedule service is unavailable. If this was a change, list the tasks before retrying."
    ),
    ("unavailable", "provider_refused"): (
        "The schedule service refused the request without a usable reason. Nothing is confirmed; list the tasks before retrying."
    ),
    ("unavailable", "rotation_in_progress"): (
        "The controller is rotating its platform session. Nothing was sent; wait briefly, then retry."
    ),
    ("unavailable", "handler_missing"): (
        "Scheduling is not installed in this controller build. Nothing was changed; tell the owner an update is required."
    ),
    ("unavailable", "handler_empty"): (
        "The controller returned no schedule result. Nothing is confirmed; list the tasks before retrying."
    ),
    ("unavailable", "handler_failed"): (
        "The controller could not finish the schedule request. Nothing is confirmed; list the tasks before retrying."
    ),
    ("unavailable", "local_error"): (
        "The controller failed before it could confirm the schedule request. List the tasks before retrying."
    ),
}


class _Failure(Exception):
    """A refusal the model should read, already worded."""


def _iso(millis: Any) -> Optional[str]:
    if isinstance(millis, bool) or not isinstance(millis, int):
        return None
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _format(routine: Mapping[str, Any]) -> Dict[str, Any]:
    """One routine as the model reads it. `job_id` is the routine id: the same id the owner's list uses."""
    instruction = str(routine.get("instruction") or "")
    enabled = routine.get("enabled") is not False
    result: Dict[str, Any] = {
        "job_id": routine.get("id"),
        "name": routine.get("title"),
        "prompt_preview": instruction[:100] + "..." if len(instruction) > 100 else instruction,
        "schedule": describe_schedule(routine.get("schedule") or {}),
        "timezone": routine.get("timezone"),
        "enabled": enabled,
        "state": "scheduled" if enabled else "paused",
        "next_run_at": _iso(routine.get("nextRunAt")) if enabled else None,
        "notifications": routine.get("notifications") is not False,
        "revision": routine.get("revision"),
    }
    last = routine.get("lastRun")
    if isinstance(last, Mapping):
        result["last_run"] = {
            "scheduled_at": _iso(last.get("scheduledAt")),
            "state": last.get("state"),
            **({"outcome": last["outcome"]} if last.get("outcome") else {}),
            **({"skip_reason": last["skipReason"]} if last.get("skipReason") else {}),
        }
    return result


def _call(command: Dict[str, Any]) -> Dict[str, Any]:
    """One command through the host; the closed result, or `_Failure` with the words for the model.

    The bridge adds identity and the mutation request ID. `list` deliberately carries no request
    ID while every mutation does; the controller enforces that split in
    `packages/cloud-controller/src/provider/client.ts` (`isRoutineCommand`).
    """
    receipt = desktop_ui.request(COMMAND_EVENT, {**command, "profile": PROFILE}, timeout=HOST_TIMEOUT_SECONDS)
    if receipt is None:
        raise _Failure("Scheduling is available only inside a live Atum agent turn.")
    if not receipt:
        raise _Failure("The Atum host did not confirm the schedule request. Nothing is known to have changed; list the tasks to check.")
    try:
        result = json.loads(receipt)
    except (TypeError, ValueError):
        raise _Failure("The Atum host returned an invalid schedule response.")
    if not isinstance(result, dict):
        raise _Failure("The Atum host returned an invalid schedule response.")
    if result.get("error"):
        raise _Failure(_host_error(str(result["error"]), result.get("reason")))
    if result.get("profile") != RESULT_PROFILE or result.get("operation") != command.get("operation"):
        raise _Failure("The Atum host returned an invalid schedule response.")
    outcome = result.get("outcome")
    if outcome == "refused":
        reason = str(result.get("reason") or "")
        text = _REFUSALS.get(reason, f"The schedule list refused that ({reason or 'no reason given'}).")
        if reason == "revision_conflict" and isinstance(result.get("revision"), int):
            text += f" (Current revision: {result['revision']}.)"
        raise _Failure(text)
    if outcome == "error":
        raise _Failure(_ERRORS.get(str(result.get("reason") or ""), _ERRORS["unavailable"]))
    return result


def _host_error(error: str, reason: Any) -> str:
    if error == "refused" and reason == "scheduled_run":
        return (
            "A scheduled run cannot create or change scheduled tasks. Tell the owner what you would schedule and let "
            "them ask for it in the chat."
        )
    bounded_reason = str(reason) if isinstance(reason, str) and re.fullmatch(r"[a-z_]{1,64}", reason) else "unknown"
    known = _HOST_ERRORS.get((error, bounded_reason))
    if known:
        return known
    if error == "invalid":
        return f"The schedule request was rejected ({bounded_reason}). Nothing was changed. Check the task fields and retry once."
    if error == "refused":
        return f"The schedule request was refused ({bounded_reason}). Nothing was changed; tell the owner if this persists."
    return f"The schedule request was not confirmed ({bounded_reason}). List the tasks before retrying."


def _list() -> Tuple[List[Dict[str, Any]], str]:
    result = _call({"operation": "list"})
    routines = result.get("routines")
    if not isinstance(routines, list):
        raise _Failure("The Atum host returned an invalid schedule response.")
    return [r for r in routines if isinstance(r, dict)], str(result.get("legacyState") or "unknown")


def _resolve(ref: str, routines: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """A routine by exact id, a unique id prefix (8+ characters), or an exact title (case-insensitive)."""
    wanted = ref.strip().lower()
    exact = [r for r in routines if str(r.get("id", "")).lower() == wanted]
    if exact:
        return exact[0]
    matches = [r for r in routines if len(wanted) >= 8 and str(r.get("id", "")).lower().startswith(wanted)]
    matches += [r for r in routines if str(r.get("title", "")).strip().lower() == wanted and r not in matches]
    if len(matches) > 1:
        raise _Failure(
            "More than one scheduled task matches that reference: "
            + "; ".join(f"{m.get('id')} ({m.get('title')})" for m in matches)
            + ". Use the exact job_id from the list."
        )
    return matches[0] if matches else None


def _replacement(routine: Mapping[str, Any], **changes: Any) -> Dict[str, Any]:
    """The full-replacement update body (the contract has no partial update) from a routine and its changes."""
    body = {
        "title": routine.get("title"),
        "instruction": routine.get("instruction"),
        "schedule": routine.get("schedule"),
        "timezone": routine.get("timezone"),
        "enabled": routine.get("enabled") is not False,
        "notifications": routine.get("notifications") is not False,
    }
    body.update({key: value for key, value in changes.items() if value is not None})
    return body


def _map_schedule(text: str) -> Dict[str, Any]:
    try:
        from cron.jobs import parse_schedule

        parsed = parse_schedule(text)
    except ValueError as exc:
        raise _Failure(str(exc))
    mapped = map_parsed_schedule(parsed)
    if mapped.refusal:
        raise _Failure(f"Not scheduled: {mapped.refusal}")
    return mapped.schedule  # type: ignore[return-value]


def _zone_name() -> str:
    """The owner's zone as the sandbox knows it (Hermes's configured timezone); UTC when none is set."""
    try:
        from hermes_time import get_timezone

        return getattr(get_timezone(), "key", None) or "UTC"
    except Exception:
        return "UTC"


def _created_message(routine: Mapping[str, Any]) -> str:
    first = _iso(routine.get("nextRunAt"))
    text = (
        f"Scheduled task '{routine.get('title')}' created in the owner's schedule list "
        f"({describe_schedule(routine.get('schedule') or {})}, {routine.get('timezone')}). "
        "It runs on its own, even when no conversation is open, and each result is posted in this chat; "
        "the owner can see, pause or change it on the agent card."
    )
    return f"{text} First run: {first}." if first else text


def maybe_dispatch(
    action: str,
    arguments: Mapping[str, Any],
    *,
    scan_prompt: Callable[[str], str],
) -> Optional[str]:
    """Route a cloud-sandbox call to Atum routines, else preserve native cron.

    This adapter owns all Atum detection and legacy-job lookup so Hermes's
    native scheduler needs only one narrow override point in its tool handler.
    """
    try:
        from hermes_cli.atum_runtime_environment import in_cloud_sandbox

        if not in_cloud_sandbox():
            return None
    except Exception:
        return None

    from cron.jobs import AmbiguousJobReference, resolve_job_ref

    def has_home_job(ref: str) -> bool:
        try:
            return resolve_job_ref(ref) is not None
        except AmbiguousJobReference:
            return True
        except Exception:
            return False

    def imported_routine(ref: str) -> Optional[str]:
        try:
            job = resolve_job_ref(ref)
        except Exception:
            return None
        marker = (job or {}).get("atum_import")
        routine_id = marker.get("routineId") if isinstance(marker, dict) else None
        return routine_id if isinstance(routine_id, str) and routine_id else None

    return dispatch(
        action,
        arguments,
        scan_prompt=scan_prompt,
        has_home_job=has_home_job,
        imported_routine=imported_routine,
    )


def dispatch(
    action: str,
    arguments: Mapping[str, Any],
    *,
    scan_prompt: Callable[[str], str],
    has_home_job: Callable[[str], bool],
    imported_routine: Callable[[str], Optional[str]] = lambda _ref: None,
) -> Optional[str]:
    """The JSON the `cronjob` tool returns for one cloud call, or None to let the local path handle it.

    `arguments` carries every `cronjob` parameter by name. `scan_prompt` is the tool's own injection scan.
    `has_home_job(ref)` says whether a job reference names an old job in this home (the local path owns those).
    `imported_routine(ref)` is the routine id an old job was moved to (its `atum_import` marker), so the agent can
    keep naming a job by the id or name it always knew and reach the routine the owner sees.
    """
    normalized = (action or "").strip().lower()
    if normalized not in _ACTIONS:
        return None
    try:
        if normalized == "create":
            return _create(arguments, scan_prompt)
        if normalized == "list":
            return _list_all(arguments)
        job_ref = arguments.get("job_id")
        if not job_ref:
            return tool_error(f"job_id is required for action '{normalized}'", success=False)
        routines, _legacy = _list()
        routine = _resolve(str(job_ref), routines)
        if routine is None:
            moved_to = imported_routine(str(job_ref))
            if moved_to:
                routine = _resolve(moved_to, routines)
        if routine is None:
            if has_home_job(str(job_ref)):
                return None
            return json.dumps(
                {"success": False, "error": f"Job with ID or name '{job_ref}' not found. Use cronjob(action='list') to inspect jobs."},
                indent=2,
            )
        return _act(normalized, routine, arguments, scan_prompt)
    except _Failure as failure:
        return tool_error(str(failure), success=False)


def _create(arguments: Mapping[str, Any], scan_prompt: Callable[[str], str]) -> str:
    refusal = unsupported_fields(arguments)
    if refusal:
        raise _Failure(f"Not scheduled: {refusal}")
    prompt = arguments.get("prompt")
    schedule_text = arguments.get("schedule")
    if not schedule_text:
        raise _Failure("schedule is required for create")
    if not isinstance(prompt, str) or not prompt.strip():
        raise _Failure("create requires a prompt (the instruction the task runs)")
    if len(prompt) > INSTRUCTION_MAX:
        raise _Failure(f"The prompt is too long for a scheduled task (at most {INSTRUCTION_MAX} characters).")
    scan_error = scan_prompt(prompt)
    if scan_error:
        raise _Failure(scan_error)
    schedule = _map_schedule(str(schedule_text))
    repeat = repeat_problem(arguments.get("repeat"), schedule)
    if repeat:
        raise _Failure(f"Not scheduled: {repeat}")
    result = _call({
        "operation": "create",
        "title": build_title(arguments.get("name"), prompt),
        "instruction": prompt,
        "schedule": schedule,
        "timezone": _zone_name(),
        "enabled": True,
        "notifications": True,
    })
    routine = result.get("routine")
    if not isinstance(routine, dict):
        raise _Failure("The Atum host returned an invalid schedule response.")
    formatted = _format(routine)
    return json.dumps(
        {
            "success": True,
            "job_id": routine.get("id"),
            "name": routine.get("title"),
            "schedule": formatted["schedule"],
            "next_run_at": formatted["next_run_at"],
            "job": formatted,
            "message": _created_message(routine),
        },
        indent=2,
    )


def _list_all(arguments: Mapping[str, Any]) -> str:
    routines, legacy = _list()
    include_disabled = bool(arguments.get("include_disabled"))
    jobs = [_format(r) for r in routines if include_disabled or r.get("enabled") is not False]
    out: Dict[str, Any] = {"success": True, "count": len(jobs), "jobs": jobs}
    if legacy != "clear":
        # Old home jobs the list is still waiting to take over: show them honestly, marked, from the local store.
        try:
            from cron.jobs import list_jobs
            from tools.cronjob_tools import _format_job

            # A job already moved into the list (its `atum_import` marker) is the routine above, not a second task.
            legacy_jobs = []
            for job in list_jobs(include_disabled=include_disabled):
                if isinstance(job.get("atum_import"), dict):
                    continue
                formatted = {**_format_job(job), "legacy_home_job": True}
                if job.get("enabled") is not False and job.get("state") in (None, "scheduled"):
                    from hermes_cli.atum_home import cloud_schedule_problem
                    formatted["cloud_warning"] = cloud_schedule_problem(job) or (
                        "Atum's cloud will not run this legacy home job until it is imported "
                        "into the owner's schedule list."
                    )
                legacy_jobs.append(formatted)
        except Exception:
            legacy_jobs = []
        if legacy_jobs:
            out["jobs"] = jobs + legacy_jobs
            out["count"] = len(out["jobs"])
            out["note"] = "Jobs marked legacy_home_job are older tasks not yet in the owner's schedule list."
    return json.dumps(out, indent=2)


def _act(action: str, routine: Dict[str, Any], arguments: Mapping[str, Any], scan_prompt: Callable[[str], str]) -> str:
    routine_id = routine.get("id")
    revision = routine.get("revision")
    if action == "remove":
        _call({"operation": "delete", "routineId": routine_id, "expectedRevision": revision})
        return json.dumps(
            {
                "success": True,
                "message": f"Scheduled task '{routine.get('title')}' removed.",
                "removed_job": {
                    "id": routine_id,
                    "name": routine.get("title"),
                    "schedule": describe_schedule(routine.get("schedule") or {}),
                },
            },
            indent=2,
        )
    if action in _RUN_ACTIONS:
        result = _call({"operation": "run", "routineId": routine_id, "expectedRevision": revision})
        run = result.get("routine")
        return json.dumps(
            {
                "success": True,
                "job": _format(run if isinstance(run, dict) else routine),
                "executed": True,
                "message": "The task is queued to run now; its result will be posted in this chat.",
            },
            indent=2,
        )
    if action in {"pause", "resume"}:
        changed = _update(routine, _replacement(routine, enabled=(action == "resume")))
        return json.dumps({"success": True, "job": _format(changed)}, indent=2)
    return _update_fields(routine, arguments, scan_prompt)


def _update(routine: Mapping[str, Any], body: Dict[str, Any]) -> Dict[str, Any]:
    result = _call({"operation": "update", "routineId": routine.get("id"), "expectedRevision": routine.get("revision"), **body})
    changed = result.get("routine")
    if not isinstance(changed, dict):
        raise _Failure("The Atum host returned an invalid schedule response.")
    return changed


def _update_fields(routine: Dict[str, Any], arguments: Mapping[str, Any], scan_prompt: Callable[[str], str]) -> str:
    refusal = unsupported_fields(arguments)
    if refusal:
        raise _Failure(f"Not changed: {refusal}")
    changes: Dict[str, Any] = {}
    prompt = arguments.get("prompt")
    if prompt is not None:
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > INSTRUCTION_MAX:
            raise _Failure(f"The prompt must be from 1 to {INSTRUCTION_MAX} characters.")
        scan_error = scan_prompt(prompt)
        if scan_error:
            raise _Failure(scan_error)
        changes["instruction"] = prompt
    if arguments.get("name") is not None:
        changes["title"] = build_title(arguments.get("name"), str(routine.get("instruction") or ""))
    schedule_text = arguments.get("schedule")
    effective_schedule = routine.get("schedule") or {}
    if schedule_text is not None:
        effective_schedule = _map_schedule(str(schedule_text))
        changes["schedule"] = effective_schedule
        changes["timezone"] = _zone_name()
    if arguments.get("repeat") is not None:
        repeat = repeat_problem(arguments.get("repeat"), effective_schedule)
        if repeat:
            raise _Failure(f"Not changed: {repeat}")
    if not changes:
        raise _Failure("No updates provided.")
    changed = _update(routine, _replacement(routine, **changes))
    return json.dumps({"success": True, "job": _format(changed)}, indent=2)
