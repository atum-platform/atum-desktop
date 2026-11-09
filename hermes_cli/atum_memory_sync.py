"""Safe, profile-scoped snapshots for Atum account memory sync.

This module deliberately operates only on Hermes' two curated memory files.
It never reads profile credentials, session databases, or authentication state.
The helpers create a fresh :class:`~tools.memory_tool.MemoryStore` under a
context-local profile override.  That is important: a live agent keeps its
already-rendered memory prompt frozen for the whole conversation, while a sync
may safely update the next session's on-disk state.

Snapshots contain only portable entries.  Users may prefix a memory with
``[local]`` to keep it on this machine; common absolute machine-home path forms
are also kept local conservatively.  Those entries remain in the local files
when a remote snapshot is applied, but are never exported.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import re
from typing import Any, Dict, Iterator, List, Mapping

from agent.redact import redact_sensitive_text
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools.memory_tool import ENTRY_DELIMITER, MemoryStore, _scan_memory_content


SNAPSHOT_TARGETS = ("memory", "user")
MAX_ENTRIES_PER_TARGET = 512
MAX_SNAPSHOT_BYTES = 64 * 1024
LOCAL_ONLY_PREFIX = "[local]"

# These deliberately recognise only familiar machine-home forms.  They are a
# privacy backstop for pre-existing entries, not a claim that arbitrary prose
# can be classified reliably.
_MACHINE_HOME_PATH = re.compile(
    r"(?:^|[\s'\"`(=:])(?:/Users/|/home/|[A-Za-z]:[\\/])",
)


@contextmanager
def _profile_scope(profile_dir: str | Path) -> Iterator[Path]:
    """Scope Hermes path resolution to *profile_dir* without changing env vars."""
    profile = Path(profile_dir).absolute()
    _assert_safe_memory_paths(profile)
    token = set_hermes_home_override(profile)
    try:
        yield profile
    finally:
        reset_hermes_home_override(token)


def _assert_safe_memory_paths(profile: Path) -> None:
    """Reject symlinked profile/memory paths before MemoryStore can follow one.

    We inspect the profile and every MemoryStore path directly.  We do not
    reject platform-owned ancestors such as macOS's ``/var`` compatibility
    link: callers commonly receive temp/profile paths through those aliases.
    """
    memories = profile / "memories"
    checked = (
        profile,
        memories,
        memories / "MEMORY.md",
        memories / "USER.md",
        memories / "MEMORY.md.lock",
        memories / "USER.md.lock",
    )
    if any(path.is_symlink() for path in checked):
        raise ValueError("Refusing a symlinked Hermes profile or memory path.")


def _is_local_only(entry: str) -> bool:
    """Return whether an entry must stay on this machine.

    ``[local]`` is the explicit, user-controlled convention.  The path check
    covers common existing entries that name a host home directory; it is kept
    intentionally narrow to avoid pretending to infer locality from prose.
    """
    return (
        entry.startswith(LOCAL_ONLY_PREFIX)
        or bool(_MACHINE_HOME_PATH.search(entry))
        # Reuse Hermes' existing detector at this account egress boundary. Keep
        # the complete entry locally instead of uploading even a masked secret.
        or redact_sensitive_text(entry, force=True, redact_url_credentials=True) != entry
    )


def _portable_entries(entries: list[str]) -> list[str]:
    return [entry for entry in entries if not _is_local_only(entry)]


def _snapshot_byte_size(snapshot: Mapping[str, list[str]]) -> int:
    """Return UTF-8 payload bytes, including Hermes' entry delimiters."""
    return sum(
        len(ENTRY_DELIMITER.join(snapshot[target]).encode("utf-8"))
        for target in SNAPSHOT_TARGETS
    )


def _validate_snapshot(snapshot: Any, *, name: str, permit_local: bool) -> dict[str, list[str]]:
    """Validate the narrow wire format before any profile file is touched."""
    if not isinstance(snapshot, Mapping):
        raise ValueError(f"{name} snapshot must be an object.")
    if set(snapshot) != set(SNAPSHOT_TARGETS):
        raise ValueError(f"{name} snapshot must contain exactly memory and user arrays.")

    normalized: dict[str, list[str]] = {}
    for target in SNAPSHOT_TARGETS:
        entries = snapshot[target]
        if not isinstance(entries, list):
            raise ValueError(f"{name}.{target} must be an array.")
        if len(entries) > MAX_ENTRIES_PER_TARGET:
            raise ValueError(f"{name}.{target} exceeds {MAX_ENTRIES_PER_TARGET} entries.")
        if not all(isinstance(entry, str) and entry and entry == entry.strip() for entry in entries):
            raise ValueError(f"{name}.{target} entries must be non-empty trimmed strings.")
        if len(entries) != len(set(entries)):
            raise ValueError(f"{name}.{target} contains duplicate entries.")
        if not permit_local and any(_is_local_only(entry) for entry in entries):
            raise ValueError(f"{name}.{target} contains a local-only entry.")
        for entry in entries:
            scan_error = _scan_memory_content(entry)
            if scan_error:
                raise ValueError(f"{name}.{target}: {scan_error}")
        normalized[target] = list(entries)

    if _snapshot_byte_size(normalized) > MAX_SNAPSHOT_BYTES:
        raise ValueError(f"{name} snapshot exceeds {MAX_SNAPSHOT_BYTES} UTF-8 bytes.")
    return normalized


def _current_snapshot_or_none(profile_dir: str | Path) -> dict[str, list[str]] | None:
    """Best-effort result-state payload for rejected requests."""
    try:
        return read_memory_snapshot(profile_dir)
    except (OSError, ValueError):
        return None


def read_memory_snapshot(profile_dir: str | Path) -> dict[str, list[str]]:
    """Read a bounded portable snapshot from one Hermes profile.

    Only ``memories/MEMORY.md`` and ``memories/USER.md`` are read through
    ``MemoryStore``.  Credential, auth, and session files are outside this
    helper's capability and therefore cannot become sync payloads.
    """
    with _profile_scope(profile_dir):
        # Keep the same configured per-target budgets as regular on-disk memory
        # operations.  This is a fresh store, so active agents retain their
        # existing frozen snapshots.
        from tools.memory_tool import load_on_disk_store

        store = load_on_disk_store()
        paths = [store._path_for(target) for target in SNAPSHOT_TARGETS]
        # Take the two normal file locks in a fixed order and refresh under the
        # locks.  Atomic writes already protect readers from torn files; this
        # additionally avoids exporting one target before a concurrent regular
        # memory operation finishes its own read-modify-write cycle.
        with store._file_lock(paths[0]), store._file_lock(paths[1]):
            for target in SNAPSHOT_TARGETS:
                raw, readable = store._read_raw_checked(store._path_for(target))
                if not readable:
                    raise ValueError("The memory snapshot could not be read safely.")
                store._set_entries(target, list(dict.fromkeys(store._parse_entries(raw))))
        snapshot = {
            "memory": _portable_entries(store.memory_entries),
            "user": _portable_entries(store.user_entries),
        }
    return _validate_snapshot(snapshot, name="local", permit_local=False)


def _validate_candidate_with_memory_store(
    store: MemoryStore, target: str, current: list[str], desired: list[str],
) -> str | None:
    """Keep the existing exact-snapshot rules at the native mutation boundary."""
    if any(not isinstance(e, str) or not e or e != e.strip() for e in desired):
        return "Entries must be non-empty trimmed strings."
    raw = ENTRY_DELIMITER.join(desired)
    if [e.strip() for e in raw.split(ENTRY_DELIMITER) if e.strip()] != desired or len(set(desired)) != len(desired):
        return "Entries must round-trip without splitting or deduplication."
    for entry in desired:
        if error := _scan_memory_content(entry):
            return error
    if len(raw) > store._char_limit(target):
        return "Snapshot exceeds the configured memory budget."
    return None


def _apply_target(
    store: MemoryStore, target: str, expected: list[str], incoming: list[str], *,
    _validate_only: bool = False,
) -> dict[str, Any]:
    """Use native lock/re-read/drift/atomic-write semantics for the portable CAS."""
    def mutate(entries, _limit):
        current = list(entries)
        portable_current = _portable_entries(current)
        if portable_current == incoming:
            return {"status": "unchanged"}
        if portable_current != expected:
            return {"status": "conflict", "reason": "expected_snapshot_mismatch", "current": portable_current}
        local_entries = [entry for entry in current if _is_local_only(entry)]
        if set(incoming).intersection(local_entries):
            return {"status": "refused", "reason": "incoming_matches_local_only_entry"}
        desired = local_entries + list(incoming)
        error = _validate_candidate_with_memory_store(store, target, current, desired)
        if error:
            return {"status": "refused", "reason": "validation_failed", "error": error}
        if _validate_only:
            return {"status": "ready"}
        return desired, "Portable snapshot applied.", {"entry_count": len(desired)}

    result = store._mutate(target, mutate)
    if "status" in result:
        return result  # Read-only callback outcomes never persist.
    if result.get("success"):
        # Native responses include live entries; never export local-only content.
        return {"status": "applied", "entry_count": result["entry_count"]}
    if result.get("drift_backup"):
        return {"status": "refused", "reason": "external_drift", "drift_backup": result["drift_backup"]}
    return {"status": "refused", "reason": "validation_failed", "error": result.get("error")}


def _preflight_target(
    store: MemoryStore, target: str, expected: list[str], incoming: list[str],
) -> dict[str, Any]:
    """Native dict callback results validate under the lock without writing."""
    return _apply_target(store, target, expected, incoming, _validate_only=True)


def apply_memory_snapshot(
    profile_dir: str | Path,
    expected_snapshot: Mapping[str, list[str]],
    incoming_snapshot: Mapping[str, list[str]],
) -> dict[str, Any]:
    """Conservatively apply an incoming portable snapshot to one profile.

    Both targets are preflighted under their normal independent locks before
    either is changed.  The return value reports each target explicitly.  A
    concurrent local edit can still win after preflight; its second CAS check
    refuses that target instead of overwriting it, and callers retain the
    resulting snapshot/statuses to retry only unresolved work.
    """
    try:
        expected = _validate_snapshot(expected_snapshot, name="expected", permit_local=False)
        incoming = _validate_snapshot(incoming_snapshot, name="incoming", permit_local=False)
    except ValueError as exc:
        return {
            "success": False,
            "error": str(exc),
            "targets": {
                target: {"status": "not_applied", "reason": "snapshot_validation_failed"}
                for target in SNAPSHOT_TARGETS
            },
            "snapshot": _current_snapshot_or_none(profile_dir),
        }

    try:
        with _profile_scope(profile_dir):
            from tools.memory_tool import load_on_disk_store

            store = load_on_disk_store()
            preflight = {
                target: _preflight_target(store, target, expected[target], incoming[target])
                for target in SNAPSHOT_TARGETS
            }
            if all(result["status"] in {"ready", "unchanged"} for result in preflight.values()):
                targets = {
                    target: (
                        {"status": "unchanged"}
                        if preflight[target]["status"] == "unchanged"
                        else _apply_target(store, target, expected[target], incoming[target])
                    )
                    for target in SNAPSHOT_TARGETS
                }
            else:
                targets = {
                    target: (
                        result
                        if result["status"] not in {"ready", "unchanged"}
                        else {"status": "not_applied", "reason": "other_target_preflight_failed"}
                    )
                    for target, result in preflight.items()
                }
            resulting_snapshot = read_memory_snapshot(profile_dir)
    except ValueError as exc:
        return {
            "success": False,
            "error": str(exc),
            "targets": {
                target: {"status": "not_applied", "reason": "unsafe_profile_path"}
                for target in SNAPSHOT_TARGETS
            },
            "snapshot": _current_snapshot_or_none(profile_dir),
        }
    success = all(result["status"] in {"applied", "unchanged"} for result in targets.values())
    return {
        "success": success,
        "partial": not success and any(result["status"] == "applied" for result in targets.values()),
        "targets": targets,
        "snapshot": resulting_snapshot,
    }
