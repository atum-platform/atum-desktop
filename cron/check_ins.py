'Atum check-ins: the default assistant\'s sealed local heartbeat.\n\nPlan:  §2 (design) and §5 item 4\n(build). Product copy calls this "check-ins"; "heartbeat" stays an internal name.\n\nOne scheduled job lives in the default assistant\'s Hermes home. The desktop app seeds it\n(ensure_job, reached through the heartbeat.ensure RPC) once per home. It runs\nprepare → model → finish through native Hermes cron while retaining the app\'s\noccurrence gate and a hard zero-tool execution seal.\n\n1. **The app decides** (heartbeat.gate.request to the host app). It owns everything\n   that must agree across the owner\'s Macs: on or off, 08:00–22:00 local, whether a check\n   or the morning brief is due (missed checks coalesce into one), the daily caps, an owner\n   who is mid-conversation, an empty Proton balance, and the assistant\'s answering lease.\n   Only the Mac that holds (or takes) the lease claims a check in the owner\'s synced\n   ledger, so two Macs never run the same one. No host connected means no run.\n2. **A cheap pre-check** reads what changed since the last check: the assistant\'s memory\n   and the folders the app names (today Atum\'s own folder, which macOS does not guard).\n   Nothing new means no model call at all. Google signals plug in at signals once the\n   assistant can use Google (G2-08); the app sends none today.\n3. **One model call with no tools.** The turn can only read the context it is given: it\n   is built with an empty toolset, its tool list is cleared again after construction, and\n   the agent loop refuses any tool name it does not hold. So a check-in can never send,\n   post, buy, delete or take any other outward action, whatever its prompt or context\n   says. The app pins it to the default assistant\'s active model (Atum\'s everyday model or\n   the person\'s connected model), with a small fixed context and a capped answer.\n4. **Silence by default.** The answer is [SILENT] or one JSON nudge (one line, its\n   source, one offered action). Anything else is silence. A muted kind or an item already\n   mentioned is dropped here, and the app checks again before it posts.\n\nA failed check is never delivered as an error message (the out-of-Protons notice and the\napp\'s own state cover those cases).\n\nThe owner\'s setting in the app is the one control. When the owner asks their assistant to\nstop check-ins in words the app does not catch itself, the assistant\'s cron tool, aimed at\nthis job, asks the app to turn them off (manage_from_tool); it never edits the job.\n'

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Contract with the desktop app (apps/desktop/electron/matrix/check-ins.ts).
# ---------------------------------------------------------------------------

#: The one check-in job's fixed ID: every Mac's copy has it, so the app recognises its posts.
CHECK_IN_JOB_ID = "a7c4ec4e0001"
#: Atum's check-in model alias (apps/desktop/shared/matrix-models.ts,
#: MATRIX_CHECK_IN_MODEL_ALIAS): the app's proxy sends it to the everyday model.
CHECK_IN_MODEL = "atum-check-in"
#: How often the job asks the app whether a check is due. The app decides; this is only
#: how promptly a due check (or the morning brief) starts.
CHECK_IN_SCHEDULE = "every 15m"
#: Hard ceiling on model runs per local day, kept on this Mac too (the app keeps the
#: shared one), so a misbehaving app cannot spend more.
DAILY_RUN_CAP = 20
#: The fixed context's budget, and the answer's.
CONTEXT_MAX_CHARS = 6000
ANSWER_MAX_TOKENS = 1000

GATE_EVENT = "heartbeat.gate.request"
SETTLED_EVENT = "heartbeat.settled"
GATE_TIMEOUT_SECONDS = 30.0

KINDS = ("meeting", "waiting", "conflict", "deadline", "brief")
SOURCES = ("files", "memory", "calendar", "mail")
ACTIONS = ("draft", "prepare", "review")
SLOTS = ("check", "brief")

#: What a check-in turn may use: nothing. Shared with the scheduler so the empty list
#: is passed explicitly (``None`` would mean "every tool").
CHECK_IN_TOOLSETS: List[str] = []

_SEED_MARKER = "check_ins.seeded"
_RUNS_FILE = "check_ins.runs.json"
_TEXT_SUFFIXES = {".md", ".markdown", ".txt", ".text", ".csv", ".tsv", ".json", ".yaml", ".yml", ".org", ".rst"}
_SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "Library", "dist", "build"}
_SCAN_LIMIT = 2000
_FILES_SHOWN = 8
_EXCERPT_CHARS = 360
_MEMORY_CHARS = 1500
_TEXT_MAX = 280
_KEY_MAX = 64
_REF_MAX = 80
_LANGUAGES = {
    "vi": "Vietnamese",
    "en": "English",
    "ja": "Japanese",
    "zh": "Simplified Chinese",
    "zh-hant": "Traditional Chinese",
}


def is_check_in_job(job: Any) -> bool:
    """The default assistant's check-in job, by its fixed ID (never by a stored field the
    agent's own cron tool could edit)."""
    return isinstance(job, dict) and job.get("id") == CHECK_IN_JOB_ID


# ---------------------------------------------------------------------------
# Seeding (heartbeat.ensure)
# ---------------------------------------------------------------------------

CHECK_IN_NAME = "Check-ins"
CHECK_IN_DESCRIPTION = (
    "Atum checks in on its own: a short morning brief, and a one-line nudge only when "
    "something needs you. It only reads, and never acts for you. Turn it off or change "
    "the brief's time in Settings, Assistant."
)


def _cron_dir() -> Path:
    from cron.jobs import _current_cron_store

    return _current_cron_store().cron_dir


def _job_record() -> Dict[str, Any]:
    from cron.jobs import compute_next_run, parse_schedule
    from hermes_time import now as hermes_now

    schedule = parse_schedule(CHECK_IN_SCHEDULE)

    return {
        "id": CHECK_IN_JOB_ID,
        "name": CHECK_IN_NAME,
        "prompt": CHECK_IN_DESCRIPTION,
        "skills": [],
        "skill": None,
        "model": CHECK_IN_MODEL,
        "provider": None,
        # The app supplies the active model for each claimed run. The seeded alias is only
        # the safe default when Atum's managed model is active.
        "provider_snapshot": None,
        "model_snapshot": None,
        "base_url": None,
        "script": None,
        "no_agent": False,
        "context_from": None,
        "schedule": schedule,
        "schedule_display": schedule.get("display", CHECK_IN_SCHEDULE),
        "repeat": {"times": None, "completed": 0},
        "enabled": True,
        "state": "scheduled",
        "paused_at": None,
        "paused_reason": None,
        "created_at": hermes_now().isoformat(),
        "next_run_at": compute_next_run(schedule),
        "last_run_at": None,
        "last_status": None,
        "last_error": None,
        "last_delivery_error": None,
        # The assistant's own chat with its owner: the app's home room for this agent.
        "deliver": "matrix",
        "origin": None,
        "enabled_toolsets": None,
        "workdir": None,
        "atum": {"kind": "check-ins", "v": 1},
    }


def ensure_job(force: bool = False) -> Dict[str, Any]:
    """Add the check-in job to this home once.

    Idempotent: a present job is left alone. A home that had the job and lost it is not
    seeded again unless ``force``. The desktop app passes ``force`` while check-ins are on:
    the owner's setting is the one control, so a missing ticker comes back. The assistant's
    own cron tool never removes it (``manage_from_tool`` turns check-ins off instead).
    """
    from cron.jobs import _jobs_lock, get_job, load_jobs, save_jobs

    if get_job(CHECK_IN_JOB_ID):
        return {"job_id": CHECK_IN_JOB_ID, "state": "present"}

    marker = _cron_dir() / _SEED_MARKER

    if marker.exists() and not force:
        return {"job_id": None, "state": "removed"}

    with _jobs_lock():
        jobs = load_jobs()

        if not any(isinstance(job, dict) and job.get("id") == CHECK_IN_JOB_ID for job in jobs):
            jobs.append(_job_record())
            save_jobs(jobs)

    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"v": 1, "at": int(time.time())}), encoding="utf-8")

    return {"job_id": CHECK_IN_JOB_ID, "state": "created"}


# ---------------------------------------------------------------------------
# The app's decision
# ---------------------------------------------------------------------------


@dataclass
class Gate:
    slot: str
    claimed_at: int
    since: int
    day: str
    locale: str
    now_local: str
    model: str
    sent: List[Dict[str, str]] = field(default_factory=list)
    muted: List[str] = field(default_factory=list)
    nudges_left: int = 0
    watched: List[str] = field(default_factory=list)
    signals: List[str] = field(default_factory=list)


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def parse_gate(raw: Any) -> Optional[Gate]:
    """The app's answer, validated. Anything unreadable, or ``run`` not true, is no run."""
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return None

    if not isinstance(value, dict) or value.get("run") is not True:
        return None

    slot = value.get("slot")
    claimed_at = value.get("claimed_at")
    since = value.get("since", 0)
    day = value.get("day")
    model = _text(value.get("model"), 1024)

    if (
        slot not in SLOTS
        or not isinstance(claimed_at, int)
        or isinstance(claimed_at, bool)
        or claimed_at <= 0
        or not isinstance(since, int)
        or isinstance(since, bool)
        or since < 0
        or not isinstance(day, str)
        or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)
        or not model
        or model.startswith("-")
        or bool(re.search(r"[\s\x00-\x1f\x7f]", model))
    ):
        return None

    sent = []
    for item in value.get("sent") or []:
        if isinstance(item, dict) and isinstance(item.get("key"), str):
            sent.append({"key": _text(item.get("key"), _KEY_MAX), "text": _text(item.get("text"), _TEXT_MAX)})

    nudges_left = value.get("nudges_left", 0)

    return Gate(
        slot=slot,
        claimed_at=claimed_at,
        since=since,
        day=day,
        locale=value.get("locale") if value.get("locale") in _LANGUAGES else "vi",
        now_local=_text(value.get("now_local"), 64),
        model=model,
        sent=sent[:20],
        muted=[kind for kind in value.get("muted") or [] if kind in KINDS],
        nudges_left=nudges_left if isinstance(nudges_left, int) and not isinstance(nudges_left, bool) else 0,
        watched=[path for path in value.get("watched") or [] if isinstance(path, str) and os.path.isabs(path)][:4],
        signals=[_text(item, 300) for item in value.get("signals") or [] if isinstance(item, str)][:10],
    )


def _host_request(event: str, payload: dict, timeout: float) -> str:
    """Ask the connected desktop through Hermes's native server-request registry."""
    if event not in {GATE_EVENT, OFF_EVENT}:
        return ""
    try:
        from tui_gateway import server_requests

        return server_requests.request_host(event, payload, timeout=timeout)
    except Exception:
        logger.debug("check-in host request failed", exc_info=True)
        return ""


def ask_gate(job: dict, request: Optional[Callable[[str, dict, float], str]] = None) -> Optional[Gate]:
    """Ask the app whether this tick runs. No app (a plain ``hermes`` backend), no answer
    in time, or a refusal: no run."""
    try:
        raw = (request or _host_request)(GATE_EVENT, {"job_id": str(job.get("id") or "")}, GATE_TIMEOUT_SECONDS)
    except Exception:
        logger.debug("check-in gate unavailable", exc_info=True)
        return None

    return parse_gate(raw) if raw else None


def settle(gate: Optional[Gate], outcome: str, emit: Optional[Callable[[str, dict], None]] = None) -> None:
    """Tell the app how a claimed check ended (``skipped``, ``silent``, ``nudge``,
    ``failed``), so it can let go of the check at once. Best effort."""
    if gate is None:
        return

    try:
        if emit is None:
            from tui_gateway.server import _broadcast_global_event as emit
        emit(SETTLED_EVENT, {"claimed_at": gate.claimed_at, "slot": gate.slot, "outcome": outcome})
    except Exception:
        logger.debug("check-in settle not sent", exc_info=True)


# ---------------------------------------------------------------------------
# The assistant's own cron tool, aimed at the check-in job
# ---------------------------------------------------------------------------

OFF_EVENT = "heartbeat.off.request"
OFF_TIMEOUT_SECONDS = 20.0

_APP_OWNED = (
    "This job is Atum's check-ins, and the owner controls them in Atum, not here: "
    "Settings, Assistant, Check-ins turns them on or off and sets the morning brief's "
    "time, on all their Macs at once."
)


def manage_from_tool(action: str, request: Optional[Callable[[str, dict, float], str]] = None) -> Dict[str, Any]:
    """What the assistant's cron tool does with the check-in job.

    The job is only check-ins' ticker; the owner's setting in the app decides. Removing or
    pausing it (the owner asked their assistant to stop them, in whatever words) asks the
    app to turn check-ins off on every Mac, and the job itself stays. Any other change is
    the owner's to make in Settings, and nothing here can turn check-ins on.
    """
    if action not in ("remove", "pause"):
        return {"success": False, "error": _APP_OWNED}

    try:
        raw = (request or _host_request)(OFF_EVENT, {"job_id": CHECK_IN_JOB_ID}, OFF_TIMEOUT_SECONDS)
        answer = json.loads(raw) if raw else None
    except Exception:
        logger.debug("check-ins not turned off from the cron tool", exc_info=True)
        answer = None

    if isinstance(answer, dict) and answer.get("off") is True:
        return {
            "success": True,
            "message": (
                "Check-ins are now off on all of the owner's Macs. They can turn them back "
                "on in Settings, Assistant, Check-ins."
            ),
        }

    return {"success": False, "error": _APP_OWNED + " They could not be turned off from here just now."}


# ---------------------------------------------------------------------------
# This Mac's own daily ceiling
# ---------------------------------------------------------------------------


def _runs_path() -> Path:
    return _cron_dir() / _RUNS_FILE


def take_local_run(day: str) -> bool:
    """Count one model run for ``day`` on this Mac; False once the day's cap is reached."""
    path = _runs_path()

    try:
        record = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        record = {}

    runs = record.get("runs") if isinstance(record, dict) and record.get("day") == day else 0
    runs = runs if isinstance(runs, int) and runs >= 0 else DAILY_RUN_CAP

    if runs >= DAILY_RUN_CAP:
        return False

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"day": day, "runs": runs + 1}), encoding="utf-8")
    except OSError:
        # A count that cannot be kept is a run that cannot be bounded: refuse it.
        return False

    return True


# ---------------------------------------------------------------------------
# The pre-check: what changed, cheaply
# ---------------------------------------------------------------------------


@dataclass
class Precheck:
    wake: bool
    context: str
    reason: str


def _read(path: Path, limit: int) -> str:
    try:
        with open(path, "r", encoding="utf-8-sig", errors="ignore") as handle:
            return handle.read(limit)
    except OSError:
        return ""


def _mtime_ms(path: Path) -> int:
    try:
        return int(path.stat().st_mtime * 1000)
    except OSError:
        return 0


def _clean(value: str) -> str:
    # Control characters out, whitespace collapsed: context is data, never formatting.
    value = "".join(ch for ch in value if unicodedata.category(ch)[0] != "C" or ch in "\n\t")
    return re.sub(r"[ \t]+", " ", value).strip()


def _walk(folder: Path, limit: int = _SCAN_LIMIT, depth: int = 3) -> Iterable[Path]:
    seen = 0
    stack = [(folder, 0)]

    while stack and seen < limit:
        current, level = stack.pop()

        try:
            entries = list(os.scandir(current))
        except OSError:
            continue

        for entry in entries:
            if seen >= limit:
                return

            name = entry.name

            if name.startswith(".") or name.startswith("~$"):
                continue

            try:
                if entry.is_dir(follow_symlinks=False):
                    if level + 1 < depth and name not in _SKIP_DIRS:
                        stack.append((Path(entry.path), level + 1))
                    continue

                if entry.is_file(follow_symlinks=False):
                    seen += 1
                    yield Path(entry.path)
            except OSError:
                continue


def _changed_files(watched: List[str], since: int, now_ms: int) -> List[tuple]:
    files = []

    for folder in watched:
        root = Path(folder)

        if not root.is_dir():
            continue

        for path in _walk(root):
            mtime = _mtime_ms(path)

            if since < mtime <= now_ms + 60_000:
                files.append((mtime, root, path))

    files.sort(key=lambda item: item[0], reverse=True)

    return files[:_FILES_SHOWN]


def precheck(gate: Gate, home: Optional[Path] = None, now_ms: Optional[int] = None) -> Precheck:
    """Read what changed since the last check: memory and the watched folders.

    A check with nothing new does not wake the model. The brief wakes it when there is
    anything to brief from (notes, or files from the last day).
    """
    home = home or get_hermes_home()
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    # Never checked: "new" means the last day.
    since = gate.since or (now_ms - 24 * 60 * 60_000)
    memories = home / "memories"
    notes = [(name, memories / name) for name in ("USER.md", "MEMORY.md")]
    memory_text = {name: _clean(_read(path, _MEMORY_CHARS)) for name, path in notes}
    memory_changed = any(memory_text[name] and _mtime_ms(path) > since for name, path in notes)
    # The brief looks back a whole day even when a check ran an hour ago.
    window = since if gate.slot == "check" else min(since, now_ms - 24 * 60 * 60_000)
    files = _changed_files(gate.watched, window, now_ms)

    if gate.slot == "check":
        wake = bool(memory_changed or files or gate.signals)
        reason = "changed" if wake else "nothing_new"
    else:
        wake = bool(any(memory_text.values()) or files or gate.signals)
        reason = "brief" if wake else "nothing_to_brief"

    sections = []

    if gate.signals:
        sections.append("## New from the owner's accounts\n" + "\n".join(f"- {item}" for item in gate.signals))

    if files:
        lines = []

        for mtime, root, path in files:
            label = f"{root.name}/{path.relative_to(root)}"
            stamp = time.strftime("%a %H:%M", time.localtime(mtime / 1000))
            line = f"- {label} (changed {stamp})"

            if path.suffix.lower() in _TEXT_SUFFIXES:
                excerpt = _clean(_read(path, _EXCERPT_CHARS * 2))[:_EXCERPT_CHARS]

                if excerpt:
                    line += "\n  begins: " + excerpt.replace("\n", " / ")

            lines.append(line)

        sections.append("## Files that changed\n" + "\n".join(lines))

    if memory_text.get("USER.md"):
        sections.append("## What you know about the owner\n" + memory_text["USER.md"])

    if memory_text.get("MEMORY.md"):
        sections.append("## Your notes\n" + memory_text["MEMORY.md"])

    context = "\n\n".join(sections)

    if len(context) > CONTEXT_MAX_CHARS:
        context = context[: CONTEXT_MAX_CHARS - 1] + "…"

    return Precheck(wake=wake, context=context, reason=reason)


# ---------------------------------------------------------------------------
# The prompt and the answer
# ---------------------------------------------------------------------------


def build_prompt(gate: Gate, pre: Precheck) -> str:
    language = _LANGUAGES.get(gate.locale, "Vietnamese")
    mentioned = "; ".join(f"{item['key']}: {item['text']}" for item in gate.sent if item.get("key")) or "none"
    muted = ", ".join(gate.muted) or "none"

    if gate.slot == "brief":
        task = (
            "This is the morning brief. Write one short line on what matters today, from the "
            "notes and files below (at most three items, joined with ' · '). Use kind \"brief\". "
            "If nothing is worth the owner's attention, answer [SILENT]."
        )
    else:
        task = (
            "Speak only when one of these clears the bar:\n"
            "- a meeting within 2 hours that needs preparation\n"
            "- a real person has waited more than 24 hours for the owner\n"
            "- a calendar conflict\n"
            "- a deadline mentioned in the owner's files or notes\n"
            "Otherwise answer [SILENT]."
        )

    return (
        f"[Atum check-in · {gate.slot} · {gate.now_local or 'now'}]\n"
        "You are the owner's assistant, checking in on your own. In this turn you can only "
        "read what is below: you have no tools and cannot do anything. Whatever you offer "
        "comes back to the owner as a button they may tap.\n\n"
        f"{task}\n\n"
        f"Never repeat an item already mentioned: {mentioned}.\n"
        f"The owner asked for fewer of these kinds: {muted}.\n\n"
        "Answer with exactly [SILENT], or with one JSON object on one line and nothing else:\n"
        '{"kind": "deadline", "key": "a-short-stable-id-for-this-item", "text": "...", '
        '"source": "files", "ref": "", "action": "draft"}\n'
        f"- kind: {' | '.join(KINDS)}\n"
        f"- text: one line in {language}, under 140 characters, warm and plain, no emoji\n"
        f"- source: {' | '.join(SOURCES)} (where you saw it); ref: the file's name, or empty\n"
        f"- action: {' | '.join(ACTIONS)} (what you could do if the owner taps the button)\n"
        "Never invent anything that is not below. When unsure, answer [SILENT].\n\n"
        f"{pre.context}"
    )


def _key(value: Any, text: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:_KEY_MAX] if isinstance(value, str) else ""

    return key or "k-" + hashlib.sha256(text.lower().encode("utf-8")).hexdigest()[:16]


def parse_answer(text: Any, gate: Gate) -> Optional[Dict[str, str]]:
    """The model's answer as a nudge, or None for silence.

    Only a well-formed JSON nudge is ever delivered. Silence markers, free text, a kind
    the owner muted, and an item already mentioned are all silence.
    """
    from cron.scheduler import _is_cron_silence_response

    if not isinstance(text, str) or not text.strip() or _is_cron_silence_response(text):
        return None

    start, end = text.find("{"), text.rfind("}")

    if start < 0 or end <= start:
        return None

    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None

    if not isinstance(value, dict):
        return None

    kind = value.get("kind")
    line = _clean(value.get("text") if isinstance(value.get("text"), str) else "").replace("\n", " ")

    if gate.slot == "brief":
        kind = "brief"

    if kind not in KINDS or (gate.slot == "check" and kind == "brief") or not line:
        return None

    if kind in gate.muted:
        return None

    if len(line) > _TEXT_MAX:
        line = line[: _TEXT_MAX - 1].rstrip() + "…"

    key = _key(value.get("key"), line)

    if any(item.get("key") == key for item in gate.sent) or any(
        item.get("text") and item["text"].strip().lower() == line.lower() for item in gate.sent
    ):
        return None

    ref = os.path.basename(_clean(value.get("ref") if isinstance(value.get("ref"), str) else ""))[:_REF_MAX]
    source = value.get("source") if value.get("source") in SOURCES else ("files" if ref else "memory")
    action = value.get("action") if value.get("action") in ACTIONS else "review"

    return {"kind": kind, "key": key, "text": line, "source": source, "ref": ref, "action": action}


def envelope(nudge: Dict[str, str], gate: Gate) -> str:
    """What is delivered to the app: the nudge and the check it belongs to, as JSON."""
    return json.dumps(
        {"v": 1, "check_in": {**nudge, "slot": gate.slot, "claimed_at": gate.claimed_at}},
        ensure_ascii=False,
        separators=(",", ":"),
    )


# ---------------------------------------------------------------------------
# The scheduler's entry points
# ---------------------------------------------------------------------------


@dataclass
class PreparedRun:
    """A check the app claimed, with nothing new or worth the model, or ready to run."""

    skip: bool
    reason: str
    gate: Optional[Gate] = None
    prompt: str = ""

    def doc(self, job_name: str, job_id: str) -> str:
        from hermes_time import now as hermes_now

        return (
            f"# Cron Job: {job_name}\n\n"
            f"**Job ID:** {job_id}\n"
            f"**Run Time:** {hermes_now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"**Status:** check-in skipped ({self.reason}); no model call\n"
        )


def prepare(job: dict, request: Optional[Callable[[str, dict, float], str]] = None,
            home: Optional[Path] = None, now_ms: Optional[int] = None) -> PreparedRun:
    """Everything before the model: the app's decision, this Mac's ceiling, the pre-check.

    The built-in ticker asks the app before it records an execution and hands the answer
    over (``_check_in_gate``); any other caller (a manual run, an external provider) asks
    here. A manual run the app has not claimed does not run.
    """
    handed = job.get("_check_in_gate")
    gate = handed if isinstance(handed, Gate) else ask_gate(job, request)

    if gate is None:
        return PreparedRun(skip=True, reason="not_due")

    pre = precheck(gate, home=home, now_ms=now_ms)

    if not pre.wake:
        settle(gate, "skipped")

        return PreparedRun(skip=True, reason=pre.reason, gate=gate)

    if not take_local_run(gate.day):
        settle(gate, "skipped")

        return PreparedRun(skip=True, reason="daily_cap", gate=gate)

    return PreparedRun(skip=False, reason=pre.reason, gate=gate, prompt=build_prompt(gate, pre))


def seal_agent(agent: Any) -> None:
    """A check-in agent holds no tools, whatever its construction pulled in. The agent loop
    refuses any tool name it does not hold, so an empty list is the outward-action block."""
    agent.tools = []
    agent.valid_tool_names = set()
    # The per-turn MCP refresh rebuilds the tool list from the live registry; a check-in
    # never takes part in it, whatever the backend has connected for the owner's chats.
    agent._skip_mcp_refresh = True

    names = getattr(agent, "_context_engine_tool_names", None)

    if isinstance(names, set):
        names.clear()

    agent._atum_check_in = True


def finish(prepared: PreparedRun, final_response: Any) -> str:
    """The model's answer as what the scheduler delivers: a nudge envelope, or silence."""
    from cron.scheduler import SILENT_MARKER

    gate = prepared.gate
    nudge = parse_answer(final_response, gate) if gate else None

    if nudge is None:
        settle(gate, "silent")

        return SILENT_MARKER

    settle(gate, "nudge")

    return envelope(nudge, gate)
