"""Auto-resume restart-loop breaker (defense-3).

Defenses 1-2 (``_HERMES_GATEWAY`` guard on ``hermes gateway stop|restart`` /
``terminal_tool``, cron lifecycle filter) stop the agent scheduling its own restart
but not every SIGTERM source: the supervisor respawns, the gateway auto-resumes the
restart-interrupted session, whose next turn re-runs the offending logic.  Boots are
persisted to ``<HERMES_HOME>/gateway/restart_loop.json`` and CHAIN while gaps stay
within ``max_gap_seconds`` (a ~150s watchdog-kill cycle trips like a ~10s loop).
Tripped → caller SKIPS auto-resume. Legacy boot tracking fails open on I/O errors.
Admission-scoped budgets fail closed so storage loss cannot authorize more spend.
"""

from __future__ import annotations

import contextlib
import json
import logging
import time
from typing import List, Optional

from hermes_constants import get_hermes_home

logger = logging.getLogger("gateway.run")

# A legitimate operator restart (or two) never trips; a ~10s respawn loop does
# within a few cycles.
DEFAULT_MAX_RESTARTS = 3
DEFAULT_WINDOW_SECONDS = 60
# Longest gap between consecutive restart-interrupted boots still counted as the
# SAME loop.  A fixed-window prune only sees cycles faster than the window (a slower
# loop drops its history every boot and never trips); chaining on the inter-boot
# gap is period-agnostic, and real quiet resets it.
DEFAULT_MAX_GAP_SECONDS = 300
# Only the newest ``max_restarts`` entries can change a verdict; the rest are forensics.
_MAX_STORED_BOOTS = 50


def _state_path(scope=None):
    if scope is not None:
        import hashlib
        return get_hermes_home() / "gateway" / "restart_loops" / (hashlib.sha256(scope.encode()).hexdigest() + ".json")
    return get_hermes_home() / "gateway" / "restart_loop.json"


def _load_boots(scope=None) -> list[float]:
    try:
        # utf-8-sig: our BOM-tolerant read fix for the persisted boot log.
        raw = _state_path(scope).read_text(encoding="utf-8-sig")
        data = json.loads(raw)
        boots = data.get("boots", [])
        return [float(t) for t in boots if isinstance(t, (int, float))]
    except FileNotFoundError:
        return []
    except (OSError, ValueError, TypeError):
        if scope is not None:
            raise
        return []


def _save_boots(boots: list[float], scope=None) -> None:
    try:
        path = _state_path(scope)
        path.parent.mkdir(parents=True, exist_ok=True)
        from utils import atomic_write_text
        atomic_write_text(path, json.dumps({"boots": boots}), fsync_dir=True)
    except (OSError, ImportError):
        if scope is not None:
            raise


def _chain_gap(window_seconds: int, max_gap_seconds: int) -> float:
    """Inter-boot gap that still links two boots; floored by ``window_seconds`` so
    widening the window never makes the breaker *less* sensitive."""
    return float(max(1, window_seconds, max_gap_seconds))


def _chain_ending_at(boots: list[float], ts: float, gap: float) -> list[float]:
    """Unbroken chain of boots leading up to ``ts`` (oldest first): walks backwards
    while each gap stays within ``gap``; the first wider gap ends the chain (older
    boots are a resolved episode).  Empty when nothing is recent — how a healthy
    gateway forgets a loop."""
    chain: list[float] = []
    prev = ts
    for t in sorted(boots, reverse=True):
        if t > ts:  # clock moved backwards (NTP step, restored file): future entry is adjacent, not a break
            chain.append(t)
            continue
        if prev - t > gap:
            break
        chain.append(t)
        prev = t
    return chain[::-1]


def record_restart_interrupted_boot(
    window_seconds: int = DEFAULT_WINDOW_SECONDS, *, now: Optional[float] = None,
    max_gap_seconds: int = DEFAULT_MAX_GAP_SECONDS, scope=None,
) -> list[float]:
    """Record a restart-interrupted boot; return the pruned chain + now (most recent
    last).  A persistence failure returns the in-memory list without raising."""
    ts = time.time() if now is None else now
    boots = _chain_ending_at(_load_boots(scope), ts, _chain_gap(window_seconds, max_gap_seconds)) + [ts]
    _save_boots(boots[-_MAX_STORED_BOOTS:], scope)
    return boots


def clear() -> None:
    """Remove the persisted boot log (used on clean shutdown / by tests)."""
    with contextlib.suppress(OSError):
        _state_path().unlink(missing_ok=True)


def check_and_record(
    max_restarts: int = DEFAULT_MAX_RESTARTS, window_seconds: int = DEFAULT_WINDOW_SECONDS, *,
    now: Optional[float] = None, max_gap_seconds: int = DEFAULT_MAX_GAP_SECONDS, scope=None,
) -> bool:
    """Gateway entry point: record this boot; True when the chain reached
    ``max_restarts`` and auto-resume should be SKIPPED."""
    boots = record_restart_interrupted_boot(window_seconds, now=now, max_gap_seconds=max_gap_seconds, scope=scope)
    tripped = max_restarts > 0 and len(boots) >= max_restarts
    if tripped:
        logger.warning(
            "Restart-loop breaker TRIPPED: %d chained restart-interrupted gateway boots (no gap wider than %ss; "
            "threshold %d). Skipping auto-resume to break a suspected SIGTERM-respawn loop (#30719, #81642). "
            "Restart-interrupted sessions stay resume-pending and will continue on the next real user message. "
            "If this is a false positive, delete %s.",
            len(boots), _chain_gap(window_seconds, max_gap_seconds), max_restarts, _state_path(),
        )
    return tripped
