"""An agent's portable checkpoint: ``atum.agent-home/2.1`` as a Mac executor takes and restores it.

``atum_home.py`` is the one implementation of the v1.5 home archive (the cloud sandbox's export and
hydration allowlist, which still carries ``state.db``). This module adds the 2.1 *portable* shape on top
of its primitives (``_read_stable``, ``_open_parent``, ``_ensure_dirs``, ``_write_new``, ``HomeError``,
``entry_kind``) and does not fork them:

- a checkpoint carries memory, skills, non-secret config, routine definitions and portable app data
  under the contract's closed, category-specific relative path grammar (``classify_portable_path`` is a
  port of the platform's ``classifyAgentHomePortablePath``; ``contract.test.ts`` and this module's tests
  run the same vendored fixtures through both);
- the portable namespace is NFC: a name the home spells in another normalization form (macOS, a keyboard or a
  tool may have made it NFD) is carried under its NFC spelling and restored as NFC. Two names that are one
  name once normalized are ambiguous: neither is carried, and both are listed as ``invalid_relative_path``;
- ``state.db`` (session history), every database and sidecar, credentials and key material, browser
  profiles, package trees and the machine workspace never travel. A skipped candidate is listed by
  category, reason code, count and a digest of its paths, never by name;
- a restore verifies the whole archive before it touches the home, backs up every local file it would
  replace or remove, never touches ``config.yaml``, ``.env``, ``auth.json`` or any credential (the
  destination keeps its own), and rebinds absolute paths in routine definitions.

The caller keeps the home still, one of two ways. A move (and the owner's own checkpoint) stops the agent's writers
before it calls ``portable-capture`` on the home; the archive then says ``writers: stopped``. A background checkpoint
(the cadence) stops nothing: it holds the agent's writers still only for the moment ``portable-snapshot`` takes, which
stages exactly what a capture carries into a private folder, and makes the capture from that folder
(``portable-capture --snapshot``); the archive then says ``writers: barrier``. Either way this module reads every file
with a stability check and fails the capture, never skips the file, when a file will not hold still: a failed capture
keeps the previous checkpoint selected.

Standard library only, import-safe, and nothing here talks to the network::

    python -m hermes_cli.atum_home portable-snapshot --home DIR --dest DIR [--hold] [--no-clone]
    python -m hermes_cli.atum_home portable-capture --home DIR --out FILE --home-id U --generation N \\
        --parent-generation N --home-epoch N [--snapshot DIR]
    python -m hermes_cli.atum_home portable-inspect --archive FILE
    python -m hermes_cli.atum_home portable-restore --home DIR --archive FILE --backups DIR
    python -m hermes_cli.atum_home portable-fingerprint --home DIR

``portable-fingerprint`` is the cheap "has anything changed?" question the desktop's checkpoint cadence asks: a
digest of the paths, sizes and modification times of exactly the files a capture would carry, with no file
opened. Equal fingerprints mean the home looks as it did at the last checkpoint; a different one is a reason to
take a new checkpoint, never a proof of what changed.

A fingerprint does not show that the home was at a consistent point: a writer that has updated one file and not yet
the next leaves every fingerprint equal. That is why a background checkpoint is made from a snapshot taken while its
writers are held still, and why the archive records how its consistency was obtained (``capture.writers``,
``capture.stagedBy``) beside the contract's constant words. ``portable-snapshot --hold`` is a conversation: it says
``ready`` when the work that does not need the writers held is done, waits for the caller's ``go``, stages (a
copy-on-write clone of each file on APFS, a database through SQLite's backup API), looks at the home once more, and
says ``staged`` the moment the window ends so that the caller lets the writers go.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import stat
import sys
import time
import unicodedata
from collections import defaultdict
from collections.abc import Callable
from typing import IO, Iterator

try:
    import fcntl
except ImportError:  # Windows: Hermes's cron ticker has no lock to hold there
    fcntl = None  # type: ignore[assignment]

from hermes_cli import atum_home as home_archive
from hermes_cli.atum_home import DIR_MODE, FILE_MODE, HomeError

PROFILE = "atum.agent-home/2.1"
ARCHIVE_VERSION = 2
MAX_PATH_BYTES = 512
MAX_ENTRIES = 100_000
SKIPPED_ROW_LIMIT = 100_000
# A file that will not hold still is retried this many times before the capture fails.
STABLE_ATTEMPTS = 4
STABLE_WAIT_SECONDS = 0.05

PORTABLE_PATH_ROOTS = {
    "memory": "memory/",
    "skills": "skills/",
    "non_secret_config": "config/",
    "routine_definitions": "routines/",
    "portable_app_data": "apps/portable/",
}

PORTABLE_CONTENT_POLICY = {
    "memory": "included",
    "skills": "included",
    "nonSecretConfig": "included",
    "routineDefinitions": "included",
    "portableAppData": "included",
    "sessionHistoryStateDb": "excluded",
    "packages": "excluded",
    "browserSessions": "excluded",
    "machineWorkspace": "excluded",
    "credentials": "excluded_all",
}

PORTABLE_ENCRYPTION = {"encrypted": True, "keyScope": "owner_agent_home", "credentialMaterialIncluded": False}

# Where each Hermes-home source lands in the portable namespace, and back.
HOME_TREES = (("memories", "memory", "memory"), ("skills", "skills", "skills"), ("apps/portable", "portable_app_data", "apps/portable"))
HOME_FILES = (
    ("SOUL.md", "non_secret_config", "config/SOUL.md"),
    ("cron/jobs.json", "routine_definitions", "routines/jobs.json"),
)
# Provenance the restore reads to rebind absolute paths; it has no home destination.
METADATA_PATH = "config/atum-home.json"
METADATA_VERSION = 1

_PACKAGE_DIRECTORIES = frozenset({"node_modules", "site-packages", "venv", ".venv", "package", "packages"})
_BROWSER_DIRECTORIES = frozenset(
    {"browser", "browsers", "chrome", "chromium", "firefox", "safari", "user data", ".mozilla", "google-chrome", "default"}
)
_CREDENTIAL_DIRECTORIES = frozenset({".ssh", ".gnupg", ".aws", ".kube"})
_CREDENTIAL_NAMES = frozenset({".netrc", ".npmrc", ".pypirc", ".git-credentials"})
_CREDENTIAL_PREFIXES = ("id_rsa", "id_ed25519", "id_ecdsa")
_CREDENTIAL_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
_CONTROL = frozenset(chr(code) for code in (*range(0x20), *range(0x7F, 0xA0)))
# A lock, a pid or an interrupted temp file is not state: it is left out without a row.
_TRANSIENT_SUFFIXES = (".lock", ".pid", ".tmp")

SKIP_REASONS = frozenset(
    {
        "invalid_relative_path",
        "outside_category",
        "credential_or_key_material",
        "browser_profile",
        "database_or_sidecar",
        "package_tree",
        "machine_workspace",
        "non_regular_file",
        "symlink_escape",
    }
)


# ── The path grammar (a port of classifyAgentHomePortablePath) ───────────────


def _file_skip_reason(file_name: str) -> str | None:
    name = file_name.lower()
    if name.startswith("cookies") or name.startswith("login data") or name == "local state" or name.startswith("web data"):
        return "browser_profile"
    if (
        name == "auth.json"
        or (name.startswith("credentials") and name.endswith(".json"))
        or name.startswith(".env")
        or name in _CREDENTIAL_NAMES
        or ".keychain" in name
        or name.startswith(_CREDENTIAL_PREFIXES)
        or name.endswith(_CREDENTIAL_SUFFIXES)
    ):
        return "credential_or_key_material"
    if name.endswith(".db") or ".sqlite" in name or name.endswith(("-wal", "-shm", "-journal")):
        return "database_or_sidecar"
    return None


def classify_portable_path(category: str, path: str) -> tuple[str, str]:
    """``("included", path)`` or ``("skipped", reason)`` for one portable relative path."""
    if (
        path != unicodedata.normalize("NFC", path)
        or path.startswith("/")
        or "\\" in path
        or any(char in _CONTROL for char in path)
    ):
        return "skipped", "invalid_relative_path"
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return "skipped", "invalid_relative_path"
    root_parts = PORTABLE_PATH_ROOTS[category][:-1].split("/")
    if len(parts) <= len(root_parts) or parts[: len(root_parts)] != root_parts:
        return "skipped", "outside_category"
    lower = [part.lower() for part in parts]
    if any(part in _PACKAGE_DIRECTORIES for part in lower):
        return "skipped", "package_tree"
    if any(part == "workspace" for part in lower):
        return "skipped", "machine_workspace"
    if any(part in _BROWSER_DIRECTORIES or part.startswith("profile ") for part in lower):
        return "skipped", "browser_profile"
    if any(part in _CREDENTIAL_DIRECTORIES for part in lower) or any(
        part == ".config" and index + 1 < len(lower) and lower[index + 1] == "gcloud" for index, part in enumerate(lower)
    ):
        return "skipped", "credential_or_key_material"
    reason = _file_skip_reason(parts[-1])
    return ("included", path) if reason is None else ("skipped", reason)


# ── Canonical JSON (byte-compatible with the device protocol's canonicalJson) ─


def canonical_json(value: object) -> str:
    """NFC strings and keys, keys sorted by UTF-16 code unit, no whitespace, safe integers only."""
    return _encode(_normalise(value))


def _normalise(value: object) -> object:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise HomeError("home_manifest_invalid") from exc
        return unicodedata.normalize("NFC", value)
    if isinstance(value, int):
        if abs(value) > 2**53 - 1:
            raise HomeError("home_manifest_invalid")
        return value
    if isinstance(value, (list, tuple)):
        return [_normalise(item) for item in value]
    if isinstance(value, dict):
        out: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise HomeError("home_manifest_invalid")
            normal = _normalise(key)
            if normal in out:
                raise HomeError("home_manifest_invalid")
            out[normal] = _normalise(item)  # type: ignore[index]
        return out
    raise HomeError("home_manifest_invalid")


def _encode(value: object) -> str:
    if value is None or isinstance(value, (bool, int, str)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_encode(item) for item in value) + "]"
    assert isinstance(value, dict)
    keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
    return "{" + ",".join(f"{json.dumps(key, ensure_ascii=False)}:{_encode(value[key])}" for key in keys) + "}"


def manifest_digest(manifest: dict) -> str:
    """The digest a checkpoint commits as ``manifestSha256``: the canonical manifest without that field."""
    rest = {key: value for key, value in manifest.items() if key != "manifestSha256"}
    return hashlib.sha256(canonical_json(rest).encode("utf-8")).hexdigest()


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def _is_uuid(value: object) -> bool:
    if not isinstance(value, str) or len(value) != 36:
        return False
    parts = value.split("-")
    return [len(part) for part in parts] == [8, 4, 4, 4, 12] and all(
        char in "0123456789abcdef" for part in parts for char in part
    )


def validate_manifest(manifest: object) -> dict:
    """The manifest as the contract states it, or ``HomeError('home_manifest_invalid')``."""
    if not isinstance(manifest, dict) or set(manifest) != {
        "homeId",
        "generation",
        "parentGeneration",
        "producingHomeEpoch",
        "manifestSha256",
        "entries",
        "encryption",
        "contentPolicy",
    }:
        raise HomeError("home_manifest_invalid")
    for key in ("generation", "parentGeneration", "producingHomeEpoch"):
        if type(manifest[key]) is not int or manifest[key] < 1:
            raise HomeError("home_manifest_invalid")
    entries = manifest["entries"]
    if (
        not _is_uuid(manifest["homeId"])
        or manifest["parentGeneration"] >= manifest["generation"]
        or not _is_sha256(manifest["manifestSha256"])
        or manifest["encryption"] != PORTABLE_ENCRYPTION
        or manifest["contentPolicy"] != PORTABLE_CONTENT_POLICY
        or not isinstance(entries, list)
        or not 1 <= len(entries) <= MAX_ENTRIES
    ):
        raise HomeError("home_manifest_invalid")
    seen = set()
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"category", "path", "sha256", "bytes", "stable", "fileType", "symlinkTraversal"}
            or entry["category"] not in PORTABLE_PATH_ROOTS
            or not isinstance(entry["path"], str)
            or not 1 <= len(entry["path"]) <= 4096
            or not _is_sha256(entry["sha256"])
            or type(entry["bytes"]) is not int
            or entry["bytes"] < 0
            or entry["stable"] is not True
            or entry["fileType"] != "regular_file"
            or entry["symlinkTraversal"] != "none"
            or entry["path"] in seen
            or classify_portable_path(entry["category"], entry["path"])[0] != "included"
        ):
            raise HomeError("home_manifest_invalid")
        seen.add(entry["path"])
    return manifest


# ── Capture ──────────────────────────────────────────────────────────────────


class _Skips:
    """What a capture left out: only category, reason, count and a digest of the paths."""

    def __init__(self) -> None:
        self._paths: dict[tuple[str, str], list[str]] = defaultdict(list)

    def add(self, category: str, reason: str, path: str) -> None:
        self._paths[(category, reason)].append(path)

    def rows(self) -> list[dict]:
        rows = []
        for (category, reason), paths in sorted(self._paths.items()):
            digest = hashlib.sha256("\n".join(sorted(paths)).encode("utf-8", "surrogateescape")).hexdigest()
            rows.append({"category": category, "reasonCode": reason, "count": len(paths), "pathSha256": digest})
        return rows[:SKIPPED_ROW_LIMIT]


def _transient(name: str) -> bool:
    return name.endswith(_TRANSIENT_SUFFIXES) or name.startswith(".mem_")


def _portable_name_ok(name: str) -> bool:
    try:
        name.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def _walk(
    root_fd: int, rel: str, prefix: str, category: str, skips: _Skips, listings: dict[str, tuple[str, ...]] | None = None
) -> Iterator[tuple[str, str, os.stat_result]]:
    """``(home-relative path, portable path, lstat)`` of every regular file under a tree, never following a link.
    The home-relative path is the name as the home spells it (it is how the file is opened); the portable path
    is NFC, which is the only spelling the grammar admits.
    A package, browser, workspace or credential directory is not entered: one skipped row names it."""
    try:
        names = sorted(os.listdir(root_fd))
    except OSError:
        return
    if listings is not None:
        listings[rel] = tuple(names)
    for name in names:
        home_rel = f"{rel}/{name}" if rel else name
        if not _portable_name_ok(name):
            skips.add(category, "invalid_relative_path", home_rel.encode("utf-8", "surrogateescape").hex())
            continue
        portable = f"{prefix}/{_nfc(name)}"
        try:
            st = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except OSError:
            continue
        kind = home_archive.entry_kind(st)
        if kind == "symlink":
            skips.add(category, "symlink_escape", home_rel)
        elif kind == "dir":
            probe = classify_portable_path(category, f"{portable}/x")
            if probe[0] == "skipped" and probe[1] in ("package_tree", "machine_workspace", "browser_profile", "credential_or_key_material"):
                skips.add(category, probe[1], home_rel)
                continue
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            except OSError:
                skips.add(category, "symlink_escape", home_rel)
                continue
            try:
                yield from _walk(child, home_rel, portable, category, skips, listings)
            finally:
                os.close(child)
        elif kind == "file":
            if not _transient(name):
                yield home_rel, portable, st
        else:
            skips.add(category, "non_regular_file", home_rel)


def _survey_excluded(root_fd: int, consumed: frozenset[str], skips: _Skips) -> None:
    """The top-level things a checkpoint promises never to carry, listed as skipped when present."""
    try:
        names = sorted(os.listdir(root_fd))
    except OSError:
        return
    for name in names:
        if name in consumed:
            continue
        try:
            st = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except OSError:
            continue
        kind = home_archive.entry_kind(st)
        lower = name.lower()
        if kind == "dir":
            if lower == "workspace":
                skips.add("portable_app_data", "machine_workspace", name)
            elif lower in _BROWSER_DIRECTORIES or lower.startswith("profile "):
                skips.add("portable_app_data", "browser_profile", name)
            elif lower in _PACKAGE_DIRECTORIES:
                skips.add("skills", "package_tree", name)
            elif lower in _CREDENTIAL_DIRECTORIES:
                skips.add("non_secret_config", "credential_or_key_material", name)
            elif lower == "sessions":
                skips.add("memory", "outside_category", name)
        elif kind in ("file", "hardlink"):
            reason = _file_skip_reason(name)
            if reason == "database_or_sidecar":
                skips.add("memory", reason, name)
            elif reason == "credential_or_key_material":
                skips.add("non_secret_config", reason, name)
            elif reason == "browser_profile":
                skips.add("portable_app_data", reason, name)


def _read_held_still(root_fd: int, home_rel: str, limit: int) -> bytes | None:
    """A file's bytes once it holds still, or None when it is gone.

    The walk has already established that the path is a regular file with one link, so anything
    ``_read_stable`` refuses afterwards means the file moved under the reader: Hermes replaces its
    files atomically, and the old file (opened a moment ago) then has no link left. That is retried,
    and a file that will not settle fails the capture (``home_file_changed``): it is never skipped, so
    a checkpoint cannot silently lose a file, and a restore of it cannot then delete that file."""
    for attempt in range(STABLE_ATTEMPTS):
        try:
            parent, name = home_archive._open_parent(root_fd, home_rel)
        except FileNotFoundError:
            return None
        except OSError:
            parent = None
        if parent is not None:
            try:
                try:
                    st = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return None
                if home_archive.entry_kind(st) == "file" and st.st_size > limit:
                    raise HomeError("home_too_large")
                try:
                    data, _mode = home_archive._read_stable(parent, name, limit)
                    return data
                except HomeError as error:
                    if error.code not in ("home_file_changed", "home_file_invalid"):
                        raise
                except FileNotFoundError:
                    return None
                except OSError:
                    pass
            finally:
                os.close(parent)
        time.sleep(STABLE_WAIT_SECONDS * (attempt + 1))
    raise HomeError("home_file_changed")


def _hermes_version() -> str:
    return home_archive._hermes_version()


def capture(
    home: str,
    out: IO[bytes],
    *,
    home_id: str,
    generation: int,
    parent_generation: int,
    home_epoch: int,
    now_ms: int | None = None,
    snapshot: str | None = None,
) -> dict:
    """Read the portable part of ``home`` once and write its plaintext archive to ``out``.

    Returns the manifest, what was skipped, and the digests the caller commits and seals. The archive is
    one JSON header line (``v``, ``profile``, ``manifest``, ``capture``) followed by each entry's bytes in
    manifest order; sealing it is the caller's job.

    ``fingerprintSha256`` is made from the files as the walk found them, before any file is read (never from what
    was read), so comparing it with a fresh ``fingerprint`` of the home says whether anything moved meanwhile.

    With ``snapshot`` (a folder ``snapshot()`` made) nothing live is read: the walk, the skipped rows and every byte come from
    that folder, and ``home`` only names where the provenance record says the home was. The archive says how its
    consistency was obtained (``capture.writers`` and ``capture.stagedBy``): the writers were held still while a snapshot was
    made (``barrier``, staged by ``snapshot_apfs_clone`` or ``snapshot_copy``), or the caller held them stopped for the whole
    read (``stopped``, staged by ``stable_read``)."""
    if not _is_uuid(home_id) or parent_generation >= generation or min(generation, parent_generation, home_epoch) < 1:
        raise HomeError("home_capture_invalid")
    skips = _Skips()
    files: list[tuple[str, str, str, bytes]] = []  # (category, portable path, home-relative path, data)
    seen: list[tuple[str, os.stat_result]] = []  # what the fingerprint is made of: (portable path, lstat)
    total = 0
    if snapshot is not None:
        record, files = _load_snapshot(snapshot)
        total = sum(len(data) for _c, _p, _r, data in files)
        skipped = record["skipped"]
        walked_fingerprint = record["fingerprintSha256"]
        staged_by = f"snapshot_{record['method']}"
        writers = "barrier"
    else:
        root_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            included = _included(root_fd, skips)
            consumed = frozenset({tree.split("/")[0] for tree, _c, _p in HOME_TREES} | {rel.split("/")[0] for rel, _c, _p in HOME_FILES})
            _survey_excluded(root_fd, consumed, skips)

            for category, portable, rel, st in included:
                if len(files) >= home_archive.MAX_HOME_FILES:
                    raise HomeError("home_too_many_files")
                data = _read_held_still(root_fd, rel, home_archive.MAX_HOME_BYTES - total)
                if data is None:
                    continue  # removed since the walk: it is no longer part of the home
                total += len(data)
                if total > home_archive.MAX_HOME_BYTES:
                    raise HomeError("home_too_large")
                files.append((category, portable, rel, data))
                seen.append((portable, st))
        finally:
            os.close(root_fd)
        skipped = skips.rows()
        walked_fingerprint = _fingerprint_of(seen)
        staged_by = "stable_read"
        writers = "stopped"

    metadata = json.dumps(
        {
            "v": METADATA_VERSION,
            "profile": PROFILE,
            # The folders as this Mac names them, plain and resolved: a routine written with either form
            # is rebound on the Mac that restores it.
            "sourceHomeDirs": _path_forms(home),
            "sourceUserHomes": _path_forms(os.path.expanduser("~")),
            "hermesVersion": _hermes_version(),
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    files.append(("non_secret_config", METADATA_PATH, "", metadata))
    files.sort(key=lambda item: item[1])
    entries = [
        {
            "category": category,
            "path": portable,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "stable": True,
            "fileType": "regular_file",
            "symlinkTraversal": "none",
        }
        for category, portable, _rel, data in files
    ]
    manifest = {
        "homeId": home_id,
        "generation": generation,
        "parentGeneration": parent_generation,
        "producingHomeEpoch": home_epoch,
        "entries": entries,
        "encryption": dict(PORTABLE_ENCRYPTION),
        "contentPolicy": dict(PORTABLE_CONTENT_POLICY),
    }
    manifest["manifestSha256"] = manifest_digest(manifest)
    validate_manifest(manifest)
    header = {
        "v": ARCHIVE_VERSION,
        "profile": PROFILE,
        "manifest": manifest,
        "capture": {
            "capturedAt": int(now_ms if now_ms is not None else time.time() * 1000),
            "includedFiles": len(entries),
            "skipped": skipped,
            # The contract's three words, true because of how this archive was made (``writers``, ``stagedBy``): the writers
            # were held still, the files are a staged copy or were read until they held still, and a database is only
            # ever read through SQLite's backup API (none is carried by name; one under another name is backed up).
            "consistency": {"writersQuiesced": True, "sqliteMethod": "sqlite_backup", "stableFilesStaged": True},
            "writers": writers,
            "stagedBy": staged_by,
            "hermesVersion": _hermes_version(),
        },
    }
    encoded = json.dumps(header, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")
    if len(encoded) > home_archive.MAX_HEADER_BYTES:
        raise HomeError("home_header_too_large")
    digest = hashlib.sha256()
    written = 0
    for chunk in (encoded + b"\n", *(data for _c, _p, _r, data in files)):
        out.write(chunk)
        digest.update(chunk)
        written += len(chunk)
    out.flush()
    return {
        "manifest": manifest,
        "manifestSha256": manifest["manifestSha256"],
        "contentSha256": hashlib.sha256(canonical_json(entries).encode("utf-8")).hexdigest(),
        "fingerprintSha256": walked_fingerprint,
        "stagedBy": staged_by,
        "includedFiles": len(entries),
        "bytes": total,
        "skipped": skipped,
        "archiveSha256": digest.hexdigest(),
        "archiveBytes": written,
    }


def _path_forms(path: str) -> list[str]:
    forms = [os.path.abspath(path), os.path.realpath(path)]
    return [form for index, form in enumerate(forms) if form not in forms[:index]]


def _open_dir(root_fd: int, rel: str) -> int | None:
    fd = os.dup(root_fd)
    try:
        for segment in rel.split("/"):
            child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
    except OSError:
        os.close(fd)
        return None
    return fd


def _lstat(root_fd: int, rel: str) -> os.stat_result | None:
    """``lstat`` of ``rel``, or None when nothing is there or a parent is a link."""
    try:
        parent, name = home_archive._open_parent(root_fd, rel)
    except OSError:
        return None
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except OSError:
        return None
    finally:
        os.close(parent)


def _kind(root_fd: int, rel: str) -> str | None:
    """What ``rel`` is (``entry_kind``), or None when nothing is there or a parent is a link."""
    st = _lstat(root_fd, rel)
    return None if st is None else home_archive.entry_kind(st)


def _is_regular(root_fd: int, rel: str) -> bool:
    return _kind(root_fd, rel) == "file"


def _included(root_fd: int, skips: _Skips, listings: dict[str, tuple[str, ...]] | None = None) -> list[tuple[str, str, str, os.stat_result]]:
    """Every file a capture would carry, by portable path: ``(category, portable path, home-relative path, lstat)``.

    The portable path is NFC. Two names that are one name once normalized (``cafe`` + U+0301 beside U+00E9, which a
    case- and normalization-sensitive disk allows) cannot both be restored under one spelling and nothing says which
    is the real one, so neither is carried: both are listed as ``invalid_relative_path`` (the grammar's only word for
    a name it will not take). A name that is merely spelled in another form travels under its NFC spelling."""
    candidates: list[tuple[str, str, str, os.stat_result]] = []
    for tree, category, prefix in HOME_TREES:
        tree_fd = _open_dir(root_fd, tree)
        if tree_fd is None:
            continue
        try:
            candidates.extend((category, portable, rel, st) for rel, portable, st in _walk(tree_fd, tree, prefix, category, skips, listings))
        finally:
            os.close(tree_fd)
    for rel, category, portable in HOME_FILES:
        st = _lstat(root_fd, rel)
        kind = None if st is None else home_archive.entry_kind(st)
        if kind == "file":
            candidates.append((category, portable, rel, st))  # type: ignore[arg-type]
        elif kind == "symlink":
            skips.add(category, "symlink_escape", rel)
        elif kind is not None:
            skips.add(category, "non_regular_file", rel)
    kept: list[tuple[str, str, str, os.stat_result]] = []
    for category, portable, rel, st in sorted(candidates, key=lambda item: item[1]):
        decision, detail = classify_portable_path(category, portable)
        if decision != "included":
            skips.add(category, detail, rel)
        elif len(portable.encode("utf-8")) > MAX_PATH_BYTES:
            skips.add(category, "invalid_relative_path", rel)
        else:
            kept.append((category, portable, rel, st))
    groups: dict[str, list[tuple[str, str, str, os.stat_result]]] = defaultdict(list)
    for item in kept:
        groups[item[1]].append(item)
    unique: list[tuple[str, str, str, os.stat_result]] = []
    for items in groups.values():
        if len(items) == 1:
            unique.append(items[0])
        else:
            for category, _portable, rel, _st in items:
                skips.add(category, "invalid_relative_path", rel)
    return sorted(unique, key=lambda item: item[1])


def _fingerprint_of(seen: list[tuple[str, os.stat_result]]) -> str:
    """A digest of the paths, sizes and modification times of the files in ``seen``. Nothing is opened to make it."""
    digest = hashlib.sha256(b"atum.agent-home/2.1 fingerprint\n")
    for portable, st in sorted(seen, key=lambda item: item[0]):
        digest.update(f"{portable}\0{st.st_size}\0{st.st_mtime_ns}\n".encode("utf-8"))
    return digest.hexdigest()


def fingerprint(home: str) -> dict:
    """The cheap change check for ``home``: the fingerprint a capture of it would report right now."""
    skips = _Skips()
    root_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        included = _included(root_fd, skips)
    finally:
        os.close(root_fd)
    return {"fingerprintSha256": _fingerprint_of([(portable, st) for _c, portable, _r, st in included]), "files": len(included)}


# ── A staged copy of the home ────────────────────────────────────────────────
#
# A checkpoint taken beside a running agent reads nothing live. The caller holds the home's writers still for the moment
# ``snapshot`` takes (it admits no new write and finds none in flight: the desktop's turn lock and Hermes's own word that
# its review of the last answer is over), ``snapshot`` copies exactly what a capture carries into a private folder, and
# the caller lets the agent go on. The capture is then made from that folder, which nothing writes to. The archive is
# the home as it was while its writers were held still, not a reading of files a writer may be changing, and
# ``capture.writers`` and ``capture.stagedBy`` say so because of how the archive was made, not because a field is always
# written. What a held lock cannot reach (a Hermes cron job already running, the owner's editor) is caught by the second
# look at the home that ends the window: a carried file written, made, removed or replaced inside it refuses the snapshot.
#
# The writers are held only as long as that window, so everything that does not need them held happens before it: the walk,
# the grammar, the check that tells a database from a file, and the process's own start. The window is the cloning and the
# second look. A walk can straddle a write whose writer finishes before the hold is granted; the second look then says the
# home moved, and since the writers are held by then the home is walked and staged again, once, inside the same window.

_SQLITE_MAGIC = b"SQLite format 3\x00"
SNAPSHOT_VERSION = 1
STAGING_CHUNK = 1 << 20
# A caller that never says "go" does not keep the process, or the folder it made, for ever.
HOLD_WAIT_SECONDS = 15
# The walk is made before the writers are held; if the home has moved by the time they are, it is walked again, once, under the hold.
SNAPSHOT_ATTEMPTS = 2
_libc = None


def _clone_into(src_fd: int, directory_fd: int, name: str) -> bool:
    """An APFS copy-on-write clone of an open file as ``name`` in the directory ``directory_fd``, or False when this
    platform or volume cannot make one (the caller then copies the bytes). A clone shares no data with its source once
    either is written, so a write in place to the home never reaches the snapshot."""
    global _libc
    if sys.platform != "darwin":
        return False
    try:
        import ctypes

        if _libc is None:
            _libc = ctypes.CDLL(None, use_errno=True)
            _libc.fclonefileat.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            _libc.fclonefileat.restype = ctypes.c_int
        return _libc.fclonefileat(src_fd, directory_fd, os.fsencode(name), 0) == 0
    except (OSError, AttributeError, ValueError):
        return False


@contextlib.contextmanager
def _cron_tick_lock(home: str) -> Iterator[str]:
    """Hold Hermes's cron tick lock (``cron/.tick.lock``, an exclusive non-blocking ``flock`` its scheduler takes at the start
    of every tick, skipping the tick when it cannot) for as long as the block runs: no new tick dispatches a job meanwhile. A
    tick in progress holds it, so the snapshot then reports the writers busy. Yields ``"held"``, ``"absent"`` (the home has no
    cron folder: nothing has ever ticked there) or ``"unavailable"`` (no ``fcntl``, or the file cannot be had)."""
    folder = os.path.join(home, "cron")
    if fcntl is None:
        yield "unavailable"
        return
    if not os.path.isdir(folder):
        yield "absent"
        return
    try:
        fd = os.open(os.path.join(folder, ".tick.lock"), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, FILE_MODE)
    except OSError:
        yield "unavailable"
        return
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise HomeError("home_writers_busy") from exc
        try:
            yield "held"
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


class _SnapshotPlan:
    """What the walk found, before the writers are held: the files to stage (with the stat the walk saw and whether each is a
    database), what was skipped, the fingerprint of it all, and the names in every directory it entered (for the second look)."""

    def __init__(self) -> None:
        self.skips = _Skips()
        self.files: list[tuple[str, str, str, os.stat_result, bool]] = []
        self.fingerprint = ""
        self.listings: dict[str, tuple[str, ...]] = {}
        self.roots_absent: list[str] = []


def _is_database(root_fd: int, rel: str) -> bool:
    """Whether the file starts like a SQLite database, whatever it is called (a live one keeps rows in its write-ahead log that
    its main file does not have, so its bytes must never be copied as they are)."""
    try:
        parent, name = home_archive._open_parent(root_fd, rel)
    except OSError:
        return False
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except OSError:
        return False
    finally:
        os.close(parent)
    try:
        return os.pread(fd, len(_SQLITE_MAGIC), 0) == _SQLITE_MAGIC
    except OSError:
        return False
    finally:
        os.close(fd)


def _plan_snapshot(root_fd: int) -> _SnapshotPlan:
    plan = _SnapshotPlan()
    included = _included(root_fd, plan.skips, plan.listings)
    consumed = frozenset({tree.split("/")[0] for tree, _c, _p in HOME_TREES} | {rel.split("/")[0] for rel, _c, _p in HOME_FILES})
    _survey_excluded(root_fd, consumed, plan.skips)
    plan.fingerprint = _fingerprint_of([(portable, st) for _c, portable, _r, st in included])
    plan.files = [(category, portable, rel, st, _is_database(root_fd, rel)) for category, portable, rel, st in included]
    plan.roots_absent = [rel for rel, _c, _p in HOME_FILES if _lstat(root_fd, rel) is None] + [tree for tree, _c, _p in HOME_TREES if tree not in plan.listings]
    return plan


def _still_as_planned(root_fd: int, plan: _SnapshotPlan) -> bool:
    """The second look, cheap: every directory the walk entered holds the names it held, every file it carried is the very
    file (inode, size, modification time) it was, and nothing it found missing has appeared. A write, a new file, a removal or
    an atomic replace inside the window changes one of these; stat and listing are all it takes, nothing is opened but the
    directories, each once."""
    by_folder: dict[str, list[tuple[str, os.stat_result]]] = defaultdict(list)
    for _category, _portable, rel, planned, _db in plan.files:
        folder, _, name = rel.rpartition("/")
        by_folder[folder].append((name, planned))
    for rel, names in plan.listings.items():
        fd = _open_dir(root_fd, rel)
        if fd is None:
            return False
        try:
            if tuple(sorted(os.listdir(fd))) != names:
                return False
            for name, planned in by_folder.pop(rel, ()):
                now = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if (now.st_ino, now.st_size, now.st_mtime_ns) != (planned.st_ino, planned.st_size, planned.st_mtime_ns):
                    return False
        except OSError:
            return False
        finally:
            os.close(fd)
    # Carried files that sit outside the trees the walk lists (the persona, the routine definitions): by path.
    for folder, entries in by_folder.items():
        for name, planned in entries:
            now = _lstat(root_fd, f"{folder}/{name}" if folder else name)
            if now is None or (now.st_ino, now.st_size, now.st_mtime_ns) != (planned.st_ino, planned.st_size, planned.st_mtime_ns):
                return False
    return all(_lstat(root_fd, rel) is None for rel in plan.roots_absent)


class _StageDirs:
    """Directory descriptors for the folders being staged from and to, kept open between files of one folder."""

    def __init__(self, root_fd: int, files_dir: str) -> None:
        self.root_fd = root_fd
        self.files_dir = files_dir
        self.source: dict[str, int] = {}
        self.target: dict[str, int] = {}

    def of(self, folder: str) -> tuple[int, int]:
        if folder not in self.source:
            parent, _name = home_archive._open_parent(self.root_fd, f"{folder}/x" if folder else "x")
            try:
                destination = os.path.join(self.files_dir, *folder.split("/")) if folder else self.files_dir
                os.makedirs(destination, mode=DIR_MODE, exist_ok=True)
                target = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
            except BaseException:
                os.close(parent)
                raise
            self.source[folder] = parent
            self.target[folder] = target
        return self.source[folder], self.target[folder]

    def close(self) -> None:
        for fd in (*self.source.values(), *self.target.values()):
            with contextlib.suppress(OSError):
                os.close(fd)


def _stage_file(home: str, dirs: _StageDirs, rel: str, walked: os.stat_result, is_database: bool, *, clone: bool, limit: int) -> tuple[str, int]:
    """Copy one carried file to its place in the snapshot and say how: ``("clone" | "copy" | "sqlite", bytes)``.

    The file is opened the way the walk reached it (every segment ``O_NOFOLLOW``) and must still be the very file the walk
    saw (same inode, size and modification time), a regular file with one link, and must not have moved by the time it has
    been copied: anything else means a writer got in, and the snapshot is refused. A database is never copied as bytes: it
    goes through SQLite's backup API."""
    folder, _, name = rel.rpartition("/")
    try:
        source_dir, target_dir = dirs.of(folder)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_dir)
    except OSError as exc:
        raise HomeError("home_changed_during_snapshot") from exc
    try:
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or (before.st_dev, before.st_ino) != (walked.st_dev, walked.st_ino)
            or (before.st_size, before.st_mtime_ns) != (walked.st_size, walked.st_mtime_ns)
        ):
            raise HomeError("home_changed_during_snapshot")
        if before.st_size > limit:
            raise HomeError("home_too_large")
        if is_database:
            target = os.path.join(dirs.files_dir, *rel.split("/"))
            try:
                home_archive.backup_sqlite(os.path.join(home, *rel.split("/")), target)
            except (OSError, sqlite3.Error) as exc:
                raise HomeError("home_database_invalid") from exc
            return "sqlite", os.stat(target).st_size
        if clone and _clone_into(fd, target_dir, name):
            method = "clone"
        else:
            method = "copy"
            out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE, dir_fd=target_dir)
            try:
                copied = 0
                while True:
                    chunk = os.read(fd, STAGING_CHUNK)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > before.st_size:
                        raise HomeError("home_changed_during_snapshot")
                    view = memoryview(chunk)
                    while view:
                        view = view[os.write(out, view) :]
            finally:
                os.close(out)
            if copied != before.st_size:
                raise HomeError("home_changed_during_snapshot")
        after = os.fstat(fd)
        if (after.st_size, after.st_mtime_ns, after.st_ino) != (before.st_size, before.st_mtime_ns, before.st_ino):
            raise HomeError("home_changed_during_snapshot")
        return method, before.st_size
    finally:
        os.close(fd)


def _stage_plan(home: str, root_fd: int, plan: _SnapshotPlan, files_dir: str, *, clone: bool) -> tuple[list[dict], set[str], int, int]:
    """Stage every file of the plan into ``files_dir``: the record of each, the ways they were staged, how many were
    databases, and the bytes in all."""
    records: list[dict] = []
    methods: set[str] = set()
    databases = 0
    total = 0
    dirs = _StageDirs(root_fd, files_dir)

    try:
        for category, portable, rel, st, is_database in plan.files:
            if len(records) >= home_archive.MAX_HOME_FILES:
                raise HomeError("home_too_many_files")

            method, size = _stage_file(home, dirs, rel, st, is_database, clone=clone, limit=home_archive.MAX_HOME_BYTES - total)
            total += size

            if total > home_archive.MAX_HOME_BYTES:
                raise HomeError("home_too_large")

            methods.add(method)
            databases += 1 if method == "sqlite" else 0
            records.append({"category": category, "portable": portable, "rel": rel, "bytes": size})
    finally:
        dirs.close()

    return records, methods, databases, total


def snapshot(home: str, dest: str, *, clone: bool = True, window: Callable[[], contextlib.AbstractContextManager] | None = None) -> dict:
    """Stage exactly what a capture of ``home`` would carry into the new private folder ``dest``.

    ``dest`` must not exist. It is made owner-only, with the carried files under ``files/`` at the paths the home spells them
    and ``snapshot.json`` beside them: what was carried, what was skipped (by category, reason, count and a digest of the
    paths, never by name), how it was made, and the fingerprint of the home as the walk found it.

    The work that does not need the home's writers held still is done first. Then ``window`` (if given) is entered: the
    caller holds the writers still for as long as it stays entered, and the staging and the second look at the home happen
    inside it, nothing else. If the second look finds the home moved since the walk (a write that landed after the walk and
    finished before the hold was granted, which is how a walk that straddles a turn ends), the writers are held now: the home
    is walked and staged once more inside the same window, and the second look is made again. A snapshot that cannot be
    completed, or in whose window a carried file is still being written, made, removed or replaced, is refused and leaves
    nothing behind.

    Files are cloned (APFS copy-on-write: no data is read or written, so the window is short however big the home is) where the
    volume can, and copied where it cannot. ``method`` says which: ``apfs_clone`` only when every file that was not a
    database was cloned."""
    started = time.monotonic()
    try:
        os.mkdir(dest, DIR_MODE)
    except FileExistsError as exc:
        raise HomeError("home_snapshot_exists") from exc
    except OSError as exc:
        raise HomeError("home_snapshot_invalid") from exc
    done = False
    try:
        files_dir = os.path.join(dest, "files")
        os.mkdir(files_dir, DIR_MODE)
        root_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            plan = _plan_snapshot(root_fd)
            held_from = time.monotonic()
            with window() if window is not None else contextlib.nullcontext():
                held_from = time.monotonic()
                with _cron_tick_lock(home):
                    for attempt in range(1, SNAPSHOT_ATTEMPTS + 1):
                        try:
                            records, methods, databases, total = _stage_plan(home, root_fd, plan, files_dir, clone=clone)

                            if _still_as_planned(root_fd, plan):
                                break

                            raise HomeError("home_changed_during_snapshot")
                        except HomeError as error:
                            if error.code != "home_changed_during_snapshot" or attempt == SNAPSHOT_ATTEMPTS:
                                raise

                        # The home moved after the walk: before the writers were held (the walk straddled a write, and the
                        # writer finished before the hold was granted) or while they were. They are held now, so walk once
                        # more and stage again; the second walk is checked at the end exactly as the first was, and a write
                        # that is still going on refuses the snapshot.
                        shutil.rmtree(files_dir)
                        os.mkdir(files_dir, DIR_MODE)
                        plan = _plan_snapshot(root_fd)
            held_ms = int((time.monotonic() - held_from) * 1000)
        finally:
            os.close(root_fd)
        staged_by = "apfs_clone" if "clone" in methods and "copy" not in methods else "copy"
        record = {
            "v": SNAPSHOT_VERSION,
            "profile": PROFILE,
            "createdAt": int(time.time() * 1000),
            "method": staged_by,
            "writers": "barrier",
            "fingerprintSha256": plan.fingerprint,
            "sqliteDatabases": databases,
            "files": records,
            "skipped": plan.skips.rows(),
        }
        fd = os.open(os.path.join(dest, "snapshot.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
        done = True
        return {
            "fingerprintSha256": plan.fingerprint,
            "files": len(records),
            "bytes": total,
            "method": staged_by,
            "sqliteDatabases": databases,
            "heldMs": held_ms,
            "attempts": attempt,
            "totalMs": int((time.monotonic() - started) * 1000),
        }
    finally:
        if not done:
            shutil.rmtree(dest, ignore_errors=True)


@contextlib.contextmanager
def _handshake() -> Iterator[None]:
    """The command line's window: say ``ready`` when the work that does not need the writers held is done, wait for the
    caller's ``go`` on stdin (the caller holds the writers still, then says it), and say ``staged`` the moment the window
    ends so that the caller lets them go. A caller that says anything else, goes away, or says nothing for long enough
    cancels the snapshot."""
    import select

    print(json.dumps({"ok": True, "phase": "ready"}), flush=True)
    try:
        readable, _w, _x = select.select([sys.stdin], [], [], HOLD_WAIT_SECONDS)
        line = sys.stdin.readline() if readable else ""
    except (OSError, ValueError):
        line = ""
    if line.strip() != "go":
        raise HomeError("home_snapshot_cancelled")
    yield
    print(json.dumps({"ok": True, "phase": "staged"}), flush=True)


def _staged_path_ok(rel: object) -> bool:
    """A home-relative path as ``snapshot`` writes it: relative, with no empty, ``.`` or ``..`` segment and no NUL."""
    return (
        isinstance(rel, str)
        and 0 < len(rel.encode("utf-8", "surrogateescape")) <= 4096
        and not rel.startswith("/")
        and "\0" not in rel
        and all(segment not in ("", ".", "..") for segment in rel.split("/"))
    )


def _load_snapshot(snapshot_dir: str) -> tuple[dict, list[tuple[str, str, str, bytes]]]:
    """A snapshot folder read back: its record, and the bytes of every staged file, each checked against the record.

    Nothing in the folder is believed. The record must say what ``snapshot`` writes, every path in it must be a path the
    grammar admits and one that stays inside the staged files, every staged file must be a regular file of the recorded
    length reached without following a link, and the totals must be inside the caps a capture has. Anything else is
    ``home_snapshot_invalid``, and no archive is written."""
    try:
        fd = os.open(os.path.join(snapshot_dir, "snapshot.json"), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as handle:
            raw = handle.read(1 << 26)
        record = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HomeError("home_snapshot_invalid") from exc
    if (
        not isinstance(record, dict)
        or record.get("v") != SNAPSHOT_VERSION
        or record.get("profile") != PROFILE
        or record.get("writers") != "barrier"
        or record.get("method") not in ("apfs_clone", "copy")
        or not isinstance(record.get("fingerprintSha256"), str)
        or len(record["fingerprintSha256"]) != 64
        or not isinstance(record.get("files"), list)
        or len(record["files"]) > home_archive.MAX_HOME_FILES
        or not isinstance(record.get("skipped"), list)
        or len(record["skipped"]) > SKIPPED_ROW_LIMIT
    ):
        raise HomeError("home_snapshot_invalid")
    for row in record["skipped"]:
        if (
            not isinstance(row, dict)
            or set(row) != {"category", "reasonCode", "count", "pathSha256"}
            or not isinstance(row["category"], str)
            or not isinstance(row["reasonCode"], str)
            or not isinstance(row["count"], int)
            or isinstance(row["count"], bool)
            or row["count"] < 1
            or not isinstance(row["pathSha256"], str)
            or len(row["pathSha256"]) != 64
        ):
            raise HomeError("home_snapshot_invalid")
    try:
        root_fd = os.open(os.path.join(snapshot_dir, "files"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as exc:
        raise HomeError("home_snapshot_invalid") from exc
    files: list[tuple[str, str, str, bytes]] = []
    seen: set[str] = set()
    total = 0
    try:
        for row in record["files"]:
            if (
                not isinstance(row, dict)
                or set(row) != {"category", "portable", "rel", "bytes"}
                or row["category"] not in PORTABLE_PATH_ROOTS
                or not isinstance(row["portable"], str)
                or row["portable"] in seen
                or classify_portable_path(row["category"], row["portable"])[0] != "included"
                or not _staged_path_ok(row["rel"])
                or not isinstance(row["bytes"], int)
                or isinstance(row["bytes"], bool)
                or row["bytes"] < 0
            ):
                raise HomeError("home_snapshot_invalid")
            seen.add(row["portable"])
            total += row["bytes"]
            if total > home_archive.MAX_HOME_BYTES:
                raise HomeError("home_too_large")
            try:
                parent, name = home_archive._open_parent(root_fd, row["rel"])
            except OSError as exc:
                raise HomeError("home_snapshot_invalid") from exc
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except OSError as exc:
                raise HomeError("home_snapshot_invalid") from exc
            finally:
                os.close(parent)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size != row["bytes"]:
                    raise HomeError("home_snapshot_invalid")
                chunks = []
                remaining = info.st_size
                while remaining > 0:
                    chunk = os.read(fd, min(remaining, STAGING_CHUNK))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                data = b"".join(chunks)
            finally:
                os.close(fd)
            if len(data) != row["bytes"]:
                raise HomeError("home_snapshot_invalid")
            files.append((row["category"], row["portable"], row["rel"], data))
    finally:
        os.close(root_fd)
    return record, files


# ── Reading an archive ───────────────────────────────────────────────────────


def read_portable_header(source: IO[bytes]) -> dict:
    """The header of a portable archive, its manifest checked against the grammar and its own digest."""
    try:
        header = json.loads(home_archive._read_line(source, home_archive.MAX_HEADER_BYTES).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HomeError("home_archive_invalid") from exc
    if (
        not isinstance(header, dict)
        or header.get("v") != ARCHIVE_VERSION
        or header.get("profile") != PROFILE
        or not isinstance(header.get("capture"), dict)
    ):
        raise HomeError("home_archive_invalid")
    manifest = validate_manifest(header.get("manifest"))
    if manifest_digest(manifest) != manifest["manifestSha256"]:
        raise HomeError("home_manifest_digest_mismatch")
    total = sum(entry["bytes"] for entry in manifest["entries"])
    if total > home_archive.MAX_HOME_BYTES or len(manifest["entries"]) > home_archive.MAX_HOME_FILES:
        raise HomeError("home_too_large")
    return header


def inspect_archive(path: str) -> dict:
    with open(path, "rb") as handle:
        header = read_portable_header(handle)
    manifest = header["manifest"]
    return {
        "manifest": manifest,
        "manifestSha256": manifest["manifestSha256"],
        "includedFiles": len(manifest["entries"]),
        "skipped": header["capture"].get("skipped", []),
        "capturedAt": header["capture"].get("capturedAt"),
    }


# ── Restore ──────────────────────────────────────────────────────────────────


def home_path_for(category: str, portable: str) -> str | None:
    """The Hermes-home-relative path a portable path restores to, or None (metadata only)."""
    for rel, cat, destination in HOME_FILES:
        if category == cat and portable == destination:
            return rel
    for tree, cat, prefix in HOME_TREES:
        if category == cat and portable.startswith(prefix + "/"):
            return f"{tree}/{portable[len(prefix) + 1:]}"
    return None


def _keep_backup(backups: str, generation: int, rel: str, data: bytes) -> bool:
    """Save a local file before it is replaced or removed. Content-addressed: the same bytes are kept
    once, a different version goes beside the first, named by its digest."""
    target = os.path.join(backups, str(generation), *rel.split("/"))
    os.makedirs(os.path.dirname(target), mode=DIR_MODE, exist_ok=True)
    name = target
    if os.path.exists(name):
        with open(name, "rb") as handle:
            if handle.read() == data:
                return False
        name = f"{target}.{hashlib.sha256(data).hexdigest()[:12]}"
        if os.path.exists(name):
            return False
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return True


def _local_bytes(root_fd: int, rel: str) -> bytes | None:
    try:
        parent, name = home_archive._open_parent(root_fd, rel)
    except OSError:
        return None
    try:
        data, _mode = home_archive._read_stable(parent, name, home_archive.MAX_HOME_BYTES)
        return data
    except (HomeError, OSError):
        return None
    finally:
        os.close(parent)


def _replace_file(root_fd: int, rel: str, data: bytes) -> None:
    parent = home_archive._ensure_dirs(root_fd, rel)
    try:
        name = rel.split("/")[-1]
        temporary = f".{name}.{secrets.token_hex(6)}.restore"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE, dir_fd=parent)
        try:
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(temporary, dir_fd=parent)
            raise
    finally:
        os.close(parent)


def _other_spellings(root_fd: int, rel: str) -> list[str]:
    """Names stored beside ``rel`` that are its last segment spelled in another Unicode normalization form.

    A disk that tells forms apart (ext4) can hold such a name next to the NFC one; a disk that does not (APFS, HFS+)
    answers an NFC lookup with the file it stored under the other spelling, and keeps that spelling when the file is
    replaced. Either way a restore that means to leave NFC names behind has to take the old spelling out first."""
    name = rel.split("/")[-1]
    try:
        parent, _name = home_archive._open_parent(root_fd, rel)
    except OSError:
        return []
    try:
        wanted = _nfc(name)

        return [stored for stored in os.listdir(parent) if stored != name and _nfc(stored) == wanted]
    except OSError:
        return []
    finally:
        os.close(parent)


def _strings(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _rebind_value(value: object, pairs: list[tuple[str, str]]) -> tuple[object, int]:
    if isinstance(value, str):
        for source, destination in pairs:
            if value == source or value.startswith(source + "/"):
                return destination + value[len(source):], 1
        return value, 0
    if isinstance(value, list):
        count = 0
        out = []
        for item in value:
            item, changed = _rebind_value(item, pairs)
            out.append(item)
            count += changed
        return out, count
    if isinstance(value, dict):
        count = 0
        out = {}
        for key, item in value.items():
            item, changed = _rebind_value(item, pairs)
            out[key] = item
            count += changed
        return out, count
    return value, 0


def rebind_routines(data: bytes, pairs: list[tuple[str, str]]) -> tuple[bytes, int]:
    """Routine definitions carry absolute paths (a job's ``workdir`` or ``script``). Every string that is
    the source Mac's home or user folder, or inside one, now names the same place on this Mac."""
    # The longest source first, so the Hermes home (inside the user folder) is not rebound as the user folder.
    pairs = sorted(
        ((source, destination) for source, destination in pairs if source and destination and source != destination),
        key=lambda pair: -len(pair[0]),
    )
    if not pairs:
        return data, 0
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return data, 0
    value, count = _rebind_value(value, pairs)
    if not count:
        return data, 0
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8"), count


def restore(
    home: str,
    source: IO[bytes],
    *,
    backups: str,
    expected_manifest_sha256: str | None = None,
    expected_home_id: str | None = None,
    verify_only: bool = False,
) -> dict:
    """Make ``home``'s portable part the archive's, after verifying all of the archive first.

    Every entry is read and checked against its digest before the first file is written, so a damaged
    archive changes nothing. Each differing local file, and each local portable file the checkpoint does
    not have, is saved under ``backups`` before it is replaced or removed. Never touches the settings,
    credentials or session history that stay with this Mac.

    With ``verify_only`` nothing is written, backed up or created: the archive is read, checked against its
    own manifest and digests and against the expectations, and its summary is returned with every count
    zero. A target Mac proves it can read the selected generation this way before it commits a move."""
    header = read_portable_header(source)
    manifest = header["manifest"]
    if expected_manifest_sha256 is not None and manifest["manifestSha256"] != expected_manifest_sha256:
        raise HomeError("home_manifest_mismatch")
    if expected_home_id is not None and manifest["homeId"] != expected_home_id:
        raise HomeError("home_manifest_mismatch")

    staged: list[tuple[dict, bytes]] = []
    for entry in manifest["entries"]:
        data = source.read(entry["bytes"])
        if len(data) != entry["bytes"]:
            raise HomeError("home_archive_truncated")
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise HomeError("home_file_digest_mismatch")
        staged.append((entry, data))
    if source.read(1):
        raise HomeError("home_archive_trailing")

    if verify_only:
        return {
            "homeId": manifest["homeId"],
            "generation": manifest["generation"],
            "manifestSha256": manifest["manifestSha256"],
            "written": 0,
            "unchanged": 0,
            "removed": 0,
            "backedUp": 0,
            "rebound": 0,
            "entries": len(manifest["entries"]),
        }

    try:
        metadata = next((json.loads(data) for entry, data in staged if entry["path"] == METADATA_PATH), {})
    except (UnicodeDecodeError, json.JSONDecodeError):
        metadata = {}
    if not isinstance(metadata, dict):
        metadata = {}
    destination_home = os.path.realpath(home)
    destination_user = os.path.realpath(os.path.expanduser("~"))
    pairs = [(str(source), destination_home) for source in _strings(metadata.get("sourceHomeDirs"))]
    pairs += [(str(source), destination_user) for source in _strings(metadata.get("sourceUserHomes"))]

    os.makedirs(home, mode=DIR_MODE, exist_ok=True)
    generation = manifest["generation"]
    written = unchanged = removed = backed_up = rebound = 0
    wanted: set[str] = set()
    # The files the checkpoint put (or found) in this home, by identity: a disk that does not tell Unicode forms apart
    # lists one of them under its old spelling, and that is still the file the checkpoint wants.
    wanted_ids: set[tuple[int, int]] = set()
    root_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for entry, data in staged:
            rel = home_path_for(entry["category"], entry["path"])
            if rel is None:
                continue
            if rel == "cron/jobs.json":
                data, changed = rebind_routines(data, pairs)
                rebound += changed
            wanted.add(rel)
            # NFC is what the checkpoint carries and what is left behind: a file this home spells another way is
            # saved (when it differs) and taken out, then written again under the NFC name.
            for stored in _other_spellings(root_fd, rel):
                other = "/".join([*rel.split("/")[:-1], stored])
                variant = _local_bytes(root_fd, other)
                if variant is not None and variant != data and _keep_backup(backups, generation, other, variant):
                    backed_up += 1
                parent, name = home_archive._open_parent(root_fd, other)
                try:
                    os.unlink(name, dir_fd=parent)
                    removed += 1
                except FileNotFoundError:
                    pass
                finally:
                    os.close(parent)
            current = _local_bytes(root_fd, rel)
            if current == data:
                unchanged += 1
            else:
                if current is not None and _keep_backup(backups, generation, rel, current):
                    backed_up += 1
                _replace_file(root_fd, rel, data)
                written += 1
            placed = _lstat(root_fd, rel)
            if placed is not None:
                wanted_ids.add((placed.st_dev, placed.st_ino))
        # What this Mac has in the portable part and the checkpoint does not: saved, then removed, so the
        # home is exactly the checkpoint and an old copy of a deleted memory does not come back.
        skips = _Skips()
        stale: list[tuple[str, str, str, os.stat_result]] = []
        for tree, category, prefix in HOME_TREES:
            tree_fd = _open_dir(root_fd, tree)
            if tree_fd is None:
                continue
            try:
                stale.extend((rel, category, portable, st) for rel, portable, st in _walk(tree_fd, tree, prefix, category, skips))
            finally:
                os.close(tree_fd)
        for rel, category, portable in HOME_FILES:
            st = _lstat(root_fd, rel)
            if st is not None and home_archive.entry_kind(st) == "file":
                stale.append((rel, category, portable, st))
        for rel, category, portable, st in stale:
            if rel in wanted or (st.st_dev, st.st_ino) in wanted_ids or classify_portable_path(category, portable)[0] != "included":
                continue
            current = _local_bytes(root_fd, rel)
            if current is None:
                continue
            if _keep_backup(backups, generation, rel, current):
                backed_up += 1
            parent, name = home_archive._open_parent(root_fd, rel)
            try:
                os.unlink(name, dir_fd=parent)
                removed += 1
            finally:
                os.close(parent)
    finally:
        os.close(root_fd)
    return {
        "homeId": manifest["homeId"],
        "generation": generation,
        "manifestSha256": manifest["manifestSha256"],
        "written": written,
        "unchanged": unchanged,
        "removed": removed,
        "backedUp": backed_up,
        "rebound": rebound,
    }


# ── CLI (called from hermes_cli.atum_home.main) ──────────────────────────────


def add_arguments(sub) -> None:
    capture_parser = sub.add_parser("portable-capture", help="write the home's 2.1 portable checkpoint archive")
    capture_parser.add_argument("--home", required=True)
    capture_parser.add_argument("--out", required=True)
    capture_parser.add_argument("--home-id", required=True)
    capture_parser.add_argument("--generation", required=True, type=int)
    capture_parser.add_argument("--parent-generation", required=True, type=int)
    capture_parser.add_argument("--home-epoch", required=True, type=int)
    capture_parser.add_argument("--snapshot", help="a folder portable-snapshot made: read it, not the live home")
    snapshot_parser = sub.add_parser("portable-snapshot", help="stage what a capture of the home would carry, while its writers are held still")
    snapshot_parser.add_argument("--home", required=True)
    snapshot_parser.add_argument("--dest", required=True)
    snapshot_parser.add_argument("--no-clone", action="store_true", help="copy the bytes even where the volume could clone them")
    snapshot_parser.add_argument(
        "--hold", action="store_true", help="say ready, wait for go on stdin before staging, and say staged when the window ends"
    )
    inspect_parser = sub.add_parser("portable-inspect", help="read a portable archive's manifest")
    inspect_parser.add_argument("--archive", required=True)
    restore_parser = sub.add_parser("portable-restore", help="make the home's portable part a checkpoint")
    restore_parser.add_argument("--home", required=True)
    restore_parser.add_argument("--archive", required=True)
    restore_parser.add_argument("--backups", required=True)
    restore_parser.add_argument("--expect-manifest-sha256")
    restore_parser.add_argument("--expect-home-id")
    restore_parser.add_argument("--verify-only", action="store_true")
    fingerprint_parser = sub.add_parser("portable-fingerprint", help="a cheap digest of what a capture of the home would carry")
    fingerprint_parser.add_argument("--home", required=True)


def run(args) -> dict:
    if args.command == "portable-capture":
        if os.path.exists(args.out):
            raise HomeError("export_out_exists")
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE)
        try:
            with os.fdopen(fd, "wb") as handle:
                result = capture(
                    args.home,
                    handle,
                    home_id=args.home_id,
                    generation=args.generation,
                    parent_generation=args.parent_generation,
                    home_epoch=args.home_epoch,
                    snapshot=args.snapshot,
                )
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(args.out)
            raise
        # The manifest and the skip rows are the archive's own header line; stdout carries only digests.
        summary = {
            key: result[key]
            for key in ("manifestSha256", "contentSha256", "fingerprintSha256", "stagedBy", "includedFiles", "bytes", "archiveSha256", "archiveBytes")
        }
        summary["skippedRows"] = len(result["skipped"])
        summary["skippedPaths"] = sum(row["count"] for row in result["skipped"])
        return {"ok": True, **summary}
    if args.command == "portable-snapshot":
        result = snapshot(args.home, args.dest, clone=not args.no_clone, window=_handshake if args.hold else None)
        return {"ok": True, **{key: result[key] for key in ("fingerprintSha256", "files", "bytes", "method", "sqliteDatabases", "heldMs", "attempts")}}
    if args.command == "portable-inspect":
        return {"ok": True, **inspect_archive(args.archive)}
    if args.command == "portable-fingerprint":
        return {"ok": True, **fingerprint(args.home)}
    with open(args.archive, "rb") as handle:
        result = restore(
            args.home,
            handle,
            backups=args.backups,
            expected_manifest_sha256=args.expect_manifest_sha256,
            expected_home_id=args.expect_home_id,
            verify_only=args.verify_only,
        )
    return {"ok": True, **result}


__all__ = [
    "PROFILE",
    "capture",
    "classify_portable_path",
    "canonical_json",
    "fingerprint",
    "inspect_archive",
    "manifest_digest",
    "read_portable_header",
    "restore",
    "snapshot",
    "validate_manifest",
]

