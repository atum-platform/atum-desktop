"""An agent's portable Hermes home: export, validate, hydrate and reconcile.

This is the one implementation of ``atum.agent-home/1.5``'s hydration allowlist and home
archive (S1 build plan §3.5). The cloud sandbox's helpers
(``packages/cloud-sandbox/entrypoint/home_export.py`` and ``home_hydrate.py``) call into it,
and the desktop's migration runs it as ``python -m hermes_cli.atum_home``. Standard library
only (croniter is read only when a cron schedule's period is), and import-safe: nothing runs
at import. It also holds the one rule for which schedules Atum's cloud runs.

The home is the agent's durable state, relative to ``HERMES_HOME``: its session database and
the other Hermes data stores, ``SOUL.md``, ``memories/``, its own ``skills/`` and
``cron/jobs.json``. Everything else is denied, deny rules first:

This is a filesystem/archive contract, not an entitlement classifier. Every regular file already
present under ``skills/`` is eligible. User-authored/open skills and catalog assets explicitly
licensed for local installation may therefore travel. A seller-private ``delivery=cloud`` body must
never be materialized into a general Hermes home in the first place; the trusted caller carries an
authorized reference and re-resolves it at the destination. A hidden directory or Drive exclusion
would not provide that boundary.

- path rules (absolute, ``..``, empty or dot segments, control characters, over 512 bytes);
- anything that is not a regular file with one link (symlinks, hardlinks, devices, sockets,
  FIFOs);
- SQLite sidecars (``*-wal``, ``*-shm``, ``*-journal``): a database travels as one consistent
  ``sqlite3`` backup, never as a live file plus a stale journal;
- dependency and cache trees (``.venv``, ``node_modules``, ...);
- settings (``config.yaml``, ``auth.json``, ``.env``): the controller writes the sandbox's own
  configuration, and a home never carries a credential;
- ``plugins/``: a home plugin would win a name collision with the image's bundled plugins;
- runtime state (pid and lock files, the process registry).

One thing crosses the ``config.yaml`` denial, and only as data: the agent-managed ``mcp_servers``
section. A cloud export distils it, with every credential left out (``sanitize_mcp_servers``), into
``skills/.atum/mcp_servers.json`` (an allowlisted path, so the frozen allowlist contract is
unchanged), and hydration merges those servers back into the config the controller writes for the
next turn. Nothing else of ``config.yaml`` travels. The agent can write that file too, so an
export never carries it as found: it is written only from the sanitized config, and left out when
the config cannot be read, the file would not fit the home's caps, or the agent's own files occupy
its path.

Subcommands::

    python -m hermes_cli.atum_home export --home DIR --out FILE
    python -m hermes_cli.atum_home validate --home DIR
    python -m hermes_cli.atum_home hydrate --home DIR --archive FILE
    python -m hermes_cli.atum_home reconcile HOME_A HOME_B --out DIR

``reconcile`` is an explicit owner-visible comparison tool for two exported homes of the same
agent (one per Mac), not the default restore or rollback operation. It produces the union of
sessions, an entry-level union of memories without duplicates, both copies of a skill that differs
(``name`` and ``name.<b-label>``), and a ``report.json`` of everything one-sided for the owner to
decide (the comparison output keeps it).
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass, field
from typing import IO, Callable, Iterable, Iterator

logger = logging.getLogger(__name__)

ARCHIVE_VERSION = 1
MAX_HOME_BYTES = 2_147_483_648
MAX_HOME_FILES = 20_000
MAX_PATH_BYTES = 512
# A manifest path carries the ``hermes/`` prefix and must stay within 512 characters.
MAX_EXPORT_PATH_BYTES = MAX_PATH_BYTES - len("hermes/")
MAX_HEADER_BYTES = 8 * 1024 * 1024
FILE_MODE = 0o600
DIR_MODE = 0o700

SQLITE_DATABASES = frozenset({"state.db", "kanban.db", "projects.db"})
# A turn's own credential files (full-power Google): written once at the root of ``HERMES_HOME`` from the
# controller's hydrate header, never part of a home. ``hydration_decision`` denies both names, so a
# turn's export never carries them back.
CREDENTIAL_FILES = ("google_token.json", "google_client_secret.json")
MAX_CREDENTIAL_BYTES = 16 * 1024
# The agent's own MCP servers, credential-free (see ``sanitize_mcp_servers``). It lives in the
# ``skills/`` tree, which the allowlist already admits, so persisting servers needs no contract change.
# The agent can write it, so an export never carries it as found (``snapshot_home``).
MCP_SERVERS_PATH = "skills/.atum/mcp_servers.json"
MCP_SERVERS_DIR = MCP_SERVERS_PATH.rpartition("/")[0]
MAX_MCP_BYTES = 32 * 1024
MAX_RECONCILE_REPLACED = 16
DEPENDENCY_TREES = frozenset({
    ".venv", "venv", "site-packages", "node_modules", "__pycache__", ".git", ".cache", ".tox", ".nox",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
})
NON_REGULAR = frozenset({"symlink", "hardlink", "device", "socket", "fifo"})
TOP_LEVEL_TREES = ("memories", "skills", "cron")


class HomeError(Exception):
    """A closed reason code; never a path, a value or exception text from the home."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# ── The allowlist ────────────────────────────────────────────────────────────


def hydration_decision(path: str, entry: str) -> tuple[str, str]:
    """``(decision, rule)`` for one path relative to ``HERMES_HOME``. Matches the pack's
    ``hydration.vectors`` and ``packages/cloud-controller/src/agent/contract.ts``."""
    segments = path.split("/")
    if (
        not path
        or path.startswith("/")
        or "\\" in path
        or "\0" in path
        or len(path.encode("utf-8", "surrogatepass")) > MAX_PATH_BYTES
        or any(segment in ("", ".", "..") for segment in segments)
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in path)
    ):
        return "deny", "deny:path"
    if entry in NON_REGULAR:
        return "deny", "deny:non_regular"
    name = segments[-1]
    if name.endswith(("-wal", "-shm", "-journal")):
        return "deny", "deny:sqlite_sidecar"
    if any(segment in DEPENDENCY_TREES for segment in segments[:-1]):
        return "deny", "deny:dependency_tree"
    if (len(segments) == 1 and name in ("config.yaml", "auth.json")) or name == ".env" or name.startswith(".env."):
        return "deny", "deny:settings"
    if segments[0] == "plugins":
        return "deny", "deny:plugins"
    if len(segments) == 1 and (name.endswith((".pid", ".lock")) or name in ("processes.json", "gateway_state.json")):
        return "deny", "deny:runtime_state"
    if entry == "file":
        if len(segments) == 1 and name in SQLITE_DATABASES:
            return "hydrate", "allow:sqlite"
        if path == "SOUL.md":
            return "hydrate", "allow:soul"
        if segments[0] == "memories" and len(segments) > 1:
            return "hydrate", "allow:memories"
        if segments[0] == "skills" and len(segments) > 1:
            return "hydrate", "allow:skills"
        if path == "cron/jobs.json":
            return "hydrate", "allow:cron"
    return "deny", "deny:not_allowlisted"


def entry_kind(st: os.stat_result) -> str:
    """The pack's entry kind for an ``lstat`` result."""
    mode = st.st_mode
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISREG(mode):
        return "hardlink" if st.st_nlink > 1 else "file"
    if stat.S_ISCHR(mode) or stat.S_ISBLK(mode):
        return "device"
    if stat.S_ISSOCK(mode):
        return "socket"
    if stat.S_ISFIFO(mode):
        return "fifo"
    return "device"


def _prune_dir(rel: str) -> bool:
    """Directories never worth walking: denied wholesale, or outside every allowed tree."""
    segments = rel.split("/")
    if segments[-1] in DEPENDENCY_TREES or segments[0] == "plugins":
        return True
    return len(segments) == 1 and segments[0] not in TOP_LEVEL_TREES


@dataclass
class Candidate:
    path: str
    entry: str
    decision: str
    rule: str


def scan_home(root: str) -> Iterator[Candidate]:
    """Every entry under ``root``, classified, without following a symlink anywhere."""
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        yield from _scan_dir(root_fd, "")
    finally:
        os.close(root_fd)


def _scan_dir(dir_fd: int, prefix: str) -> Iterator[Candidate]:
    try:
        names = sorted(os.listdir(dir_fd))
    except OSError:
        return
    for name in names:
        rel = f"{prefix}{name}"
        try:
            st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except OSError:
            continue
        kind = entry_kind(st)
        if kind == "dir":
            if _prune_dir(rel):
                decision, rule = hydration_decision(f"{rel}/x", "file")
                if decision == "deny" and rule != "deny:not_allowlisted":
                    yield Candidate(rel, "dir", decision, rule)
                continue
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
            except OSError:
                continue
            try:
                yield from _scan_dir(child, f"{rel}/")
            finally:
                os.close(child)
            continue
        decision, rule = hydration_decision(rel, kind)
        yield Candidate(rel, kind, decision, rule)


# ── Export ───────────────────────────────────────────────────────────────────


@dataclass
class ExportFile:
    path: str
    size: int
    mode: int
    sha256: str
    kind: str
    # Exactly one of these holds the bytes: in memory, or a snapshot file of its own.
    data: bytes | None = None
    source: str | None = None


@dataclass
class Snapshot:
    files: list[ExportFile] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    hermes: dict = field(default_factory=dict)
    schedules: list[dict] = field(default_factory=list)


def _read_stable(dir_fd: int, name: str, limit: int) -> tuple[bytes, int]:
    """A regular file's bytes, refused if it is not one, is linked, grows past ``limit`` or
    changes while it is read."""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise HomeError("home_file_invalid")
        chunks = []
        remaining = before.st_size + 1
        while remaining > 0:
            chunk = os.read(fd, min(remaining, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(fd)
        if len(data) != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns
        ):
            raise HomeError("home_file_changed")
        return data, stat.S_IMODE(before.st_mode)
    finally:
        os.close(fd)


def _open_parent(root_fd: int, rel: str) -> tuple[int, str]:
    """A directory fd for ``rel``'s parent, walked segment by segment with ``O_NOFOLLOW``."""
    segments = rel.split("/")
    fd = os.dup(root_fd)
    try:
        for segment in segments[:-1]:
            child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    return fd, segments[-1]


def backup_sqlite(source: str, target: str) -> int:
    """A consistent snapshot of a live database (WAL included) through SQLite's backup API on
    a read-only connection, as ``hermes_cli/backup.py`` takes it. Returns its user_version."""
    try:
        src = sqlite3.connect(f"file:{urllib.parse.quote(source)}?mode=ro", uri=True)
        src.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except sqlite3.OperationalError:
        # A stopped profile's WAL database without its -shm file cannot open read-only; nobody
        # else is writing it then, so a plain connection reads it (and may checkpoint it).
        src = sqlite3.connect(source)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
            dst.execute("PRAGMA journal_mode=DELETE")
            version = int(dst.execute("PRAGMA user_version").fetchone()[0])
            ok = dst.execute("PRAGMA quick_check").fetchone()[0]
            if ok != "ok":
                raise HomeError("home_database_invalid")
            return version
        finally:
            dst.close()
    finally:
        src.close()


def snapshot_home(root: str, scratch: str, *, mcp_from_config: bool = False,
                  file_filter: Callable[[str], bool] | None = None) -> Snapshot:
    """Read the home once, consistently: databases through the backup API into ``scratch``,
    other files with a stability check. Caps are enforced as it goes. With ``mcp_from_config`` the
    agent's MCP servers are read from the live ``config.yaml`` (credentials left out) and written as
    ``MCP_SERVERS_PATH``. That path is the agent's to write, so the file found in the home is never
    exported: it is the generated one or none, and none when the config cannot be read, the
    generated file would pass a cap, or the agent's own files occupy its path (the export then
    still succeeds, without the servers: never an archive that hydration would refuse).

    ``file_filter`` can further restrict scanned paths before any file read or SQLite
    backup. It cannot widen the hydration allowlist and omitted paths are not added
    to the skipped-file report. Generated MCP server data is handled separately.
    """
    snap = Snapshot()
    total = 0
    mcp_body = _mcp_export_body(root) if mcp_from_config else None
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for candidate in scan_home(root):
            if file_filter is not None and not file_filter(candidate.path):
                continue
            if candidate.path == MCP_SERVERS_PATH:
                continue
            if candidate.decision != "hydrate":
                if len(snap.skipped) < 64:
                    snap.skipped.append({"path": candidate.path, "rule": candidate.rule})
                continue
            if len(candidate.path.encode("utf-8")) > MAX_EXPORT_PATH_BYTES:
                if len(snap.skipped) < 64:
                    snap.skipped.append({"path": candidate.path[:120], "rule": "deny:path"})
                continue
            if len(snap.files) >= MAX_HOME_FILES:
                raise HomeError("home_too_many_files")
            parent, name = _open_parent(root_fd, candidate.path)
            try:
                if candidate.path in SQLITE_DATABASES:
                    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if entry_kind(current) != "file":
                        raise HomeError("home_file_invalid")
                    target = os.path.join(scratch, f"{len(snap.files)}.db")
                    version = backup_sqlite(os.path.join(root, candidate.path), target)
                    if candidate.path == "state.db":
                        snap.hermes["stateDbUserVersion"] = version
                    size, digest = _hash_file(target)
                    entry = ExportFile(candidate.path, size, FILE_MODE, digest, "sqlite", source=target)
                else:
                    data, _mode = _read_stable(parent, name, MAX_HOME_BYTES - total)
                    entry = ExportFile(candidate.path, len(data), FILE_MODE, hashlib.sha256(data).hexdigest(), "file", data=data)
            finally:
                os.close(parent)
            total += entry.size
            if total > MAX_HOME_BYTES:
                raise HomeError("home_too_large")
            snap.files.append(entry)
        if mcp_body:
            # Counted like any file, against the caps ``read_header`` holds hydration to. Past one, the
            # servers are dropped for this turn rather than the archive being refused whole.
            if len(snap.files) >= MAX_HOME_FILES or total + len(mcp_body) > MAX_HOME_BYTES:
                logger.warning("home export: the MCP servers file was left out because the home is at its size or file-count cap")
            # The one path that is not a real file of the home: if the agent's own files occupy it (a file where
            # its directory goes, or a directory where it goes), hydration could not write both and the next turn
            # would not start. The agent's files win; the servers are dropped for this turn.
            elif any(f.path == MCP_SERVERS_DIR or f.path.startswith(MCP_SERVERS_PATH + "/") for f in snap.files):
                logger.warning("home export: the MCP servers file was left out because the agent's own files occupy its path")
            else:
                snap.files.append(ExportFile(MCP_SERVERS_PATH, len(mcp_body), FILE_MODE, hashlib.sha256(mcp_body).hexdigest(),
                                             "file", data=mcp_body))
    finally:
        os.close(root_fd)
    snap.hermes.setdefault("stateDbUserVersion", 0)
    snap.hermes["version"] = _hermes_version()
    return snap


def _hash_file(path: str) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _hermes_version() -> str:
    try:
        from hermes_cli import __version__

        return str(__version__)[:64] or "unknown"
    except Exception:
        return "unknown"


def write_archive(out: IO[bytes], header: dict, files: Iterable[ExportFile]) -> None:
    """The home archive: one JSON header line, then each file's bytes in header order."""
    encoded = json.dumps(header, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_HEADER_BYTES:
        raise HomeError("home_header_too_large")
    out.write(encoded + b"\n")
    for item in files:
        if item.data is not None:
            out.write(item.data)
        else:
            with open(item.source, "rb") as handle:  # type: ignore[arg-type]
                copied = 0
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    out.write(chunk)
                    copied += len(chunk)
            if copied != item.size:
                raise HomeError("home_file_changed")
    out.flush()


def export_header(snap: Snapshot) -> dict:
    return {
        "v": ARCHIVE_VERSION,
        "hermes": {"version": snap.hermes["version"], "stateDbUserVersion": snap.hermes["stateDbUserVersion"]},
        "schedules": snap.schedules,
        "skipped": snap.skipped,
        "files": [
            {"path": f.path, "size": f.size, "mode": f.mode, "sha256": f.sha256, "kind": f.kind} for f in snap.files
        ],
    }


def export_home(root: str, out: IO[bytes], schedules: list[dict] | None = None, *, mcp_from_config: bool = False,
                file_filter: Callable[[str], bool] | None = None) -> dict:
    """Snapshot ``root`` and write its archive to ``out``. Returns the header.

    ``file_filter`` is an optional predicate on home-relative paths, applied before
    capture by :func:`snapshot_home`. With no predicate the full allowlisted home
    is exported as before.
    """
    with tempfile.TemporaryDirectory(prefix="atum-home-export-") as scratch:
        os.chmod(scratch, DIR_MODE)
        snap = snapshot_home(root, scratch, mcp_from_config=mcp_from_config, file_filter=file_filter)
        snap.schedules = list(schedules or [])
        header = export_header(snap)
        write_archive(out, header, snap.files)
        return header


# ── Archive reading and hydration ────────────────────────────────────────────


def _read_line(source: IO[bytes], limit: int) -> bytes:
    line = source.readline(limit + 1)
    if not line.endswith(b"\n") or len(line) > limit:
        raise HomeError("home_archive_invalid")
    return line


def read_header(source: IO[bytes]) -> dict:
    try:
        header = json.loads(_read_line(source, MAX_HEADER_BYTES).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HomeError("home_archive_invalid") from exc
    if not isinstance(header, dict) or header.get("v") != ARCHIVE_VERSION or not isinstance(header.get("files"), list):
        raise HomeError("home_archive_invalid")
    files = header["files"]
    if len(files) > MAX_HOME_FILES:
        raise HomeError("home_too_many_files")
    total = 0
    seen = set()
    for item in files:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("path"), str)
            or type(item.get("size")) is not int
            or not 0 <= item["size"] <= MAX_HOME_BYTES
            or not isinstance(item.get("sha256"), str)
            or len(item["sha256"]) != 64
            or any(c not in "0123456789abcdef" for c in item["sha256"])
            or item["path"] in seen
        ):
            raise HomeError("home_archive_invalid")
        seen.add(item["path"])
        total += item["size"]
    if total > MAX_HOME_BYTES:
        raise HomeError("home_too_large")
    return header


def _ensure_dirs(root_fd: int, rel: str) -> int:
    """Create ``rel``'s parent directories (0700) without following any symlink; returns a fd."""
    fd = os.dup(root_fd)
    try:
        for segment in rel.split("/")[:-1]:
            try:
                os.mkdir(segment, DIR_MODE, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    return fd


def _write_new(dir_fd: int, name: str, data_source: IO[bytes], size: int, digest_expected: str) -> None:
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE, dir_fd=dir_fd)
    digest = hashlib.sha256()
    try:
        remaining = size
        while remaining > 0:
            chunk = data_source.read(min(remaining, 1 << 20))
            if not chunk:
                raise HomeError("home_archive_truncated")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            remaining -= len(chunk)
        if digest.hexdigest() != digest_expected:
            raise HomeError("home_file_digest_mismatch")
    except BaseException:
        os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(name, dir_fd=dir_fd)
        raise
    os.close(fd)


def _skip(source: IO[bytes], size: int) -> None:
    remaining = size
    while remaining > 0:
        chunk = source.read(min(remaining, 1 << 20))
        if not chunk:
            raise HomeError("home_archive_truncated")
        remaining -= len(chunk)


def _credential_bodies(header: dict) -> list[tuple[str, bytes]]:
    """The header's credential files as ``(name, bytes)``, in the fixed order of ``CREDENTIAL_FILES``.
    Only those names, each a JSON object within ``MAX_CREDENTIAL_BYTES``; anything else is skipped,
    never written. A credential is optional for a turn, so a bad one costs the turn that file only."""
    raw = header.get("credentials")
    if not isinstance(raw, dict):
        return []
    bodies = []
    for name in CREDENTIAL_FILES:
        value = raw.get(name)
        if not isinstance(value, dict):
            continue
        try:
            body = json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError):
            continue
        if len(body) <= MAX_CREDENTIAL_BYTES:
            bodies.append((name, body))
    return bodies


def hydrate_home(
    root: str,
    source: IO[bytes],
    *,
    accept_config: bool = False,
    sentinel: str | None = None,
    before_sentinel: "Callable[[dict], dict] | None" = None,
) -> dict:
    """Write an archive's allowlisted files into an empty ``root``, refusing anything that would
    follow a symlink or replace an existing file. A denied path is skipped, never written.
    With ``accept_config`` (the cloud sandbox, where the controller wrote the archive), the
    header's ``config`` object becomes ``config.yaml``: the controller's own configuration,
    never a home's. The same archive may carry the turn's ``credentials`` (``CREDENTIAL_FILES``): each
    is written at the root, mode 0600, and counted in the result's ``credentials``; an archive
    that carries none reports no such count. ``sentinel`` is written last and atomically, so a
    reader that sees it sees a whole home."""
    os.makedirs(root, mode=DIR_MODE, exist_ok=True)
    header = read_header(source)
    config = header.get("config") if accept_config else None
    credentials = _credential_bodies(header) if accept_config else []
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    written = 0
    skipped = 0
    total = 0
    credentials_written = 0
    try:
        for item in header["files"]:
            decision, _rule = hydration_decision(item["path"], "file")
            if decision != "hydrate":
                _skip(source, item["size"])
                skipped += 1
                continue
            parent = _ensure_dirs(root_fd, item["path"])
            try:
                _write_new(parent, item["path"].split("/")[-1], source, item["size"], item["sha256"])
            finally:
                os.close(parent)
            written += 1
            total += item["size"]
        if source.read(1):
            raise HomeError("home_archive_trailing")
        if config is not None:
            if not isinstance(config, dict) or len(json.dumps(config)) > 65_536:
                raise HomeError("home_config_invalid")
            config = _with_persisted_mcp(root_fd, config)
            body = json.dumps(config, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")
            _write_new(root_fd, "config.yaml", io.BytesIO(body), len(body), hashlib.sha256(body).hexdigest())
        for name, body in credentials:
            try:
                _write_new(root_fd, name, io.BytesIO(body), len(body), hashlib.sha256(body).hexdigest())
            except OSError:
                continue
            credentials_written += 1
    finally:
        os.close(root_fd)
    stats = {"files": written, "skipped": skipped, "bytes": total}
    if accept_config and "credentials" in header:
        stats["credentials"] = credentials_written
    if before_sentinel is not None:
        # The caller's last word on the written home (the sandbox advances a due schedule here),
        # still before anything may open it.
        stats.update(before_sentinel(header) or {})
    if sentinel:
        _write_atomic(sentinel, json.dumps(stats, sort_keys=True).encode("utf-8"))
    return stats


def _write_atomic(path: str, data: bytes) -> None:
    directory, name = os.path.split(path)
    temporary = os.path.join(directory, f".{name}.{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(temporary, path)


# ── The agent's MCP servers ──────────────────────────────────────────────────
#
# A cloud turn's ``config.yaml`` is the controller's own, rewritten before every turn and never
# exported, so an MCP server the agent added (``hermes mcp add``) used to vanish with the sandbox.
# Its server definitions now travel, and nothing else of the config does, as data a restart needs:
# how to start or reach the server. Never a credential, and never anything Hermes would turn into
# one. Hermes resolves a ``${...}`` reference in any string of the config from the turn's own
# environment (the model key and the Google token among it), so a persisted reference would hand
# the next turn's credentials to whatever the entry points at. A persisted entry therefore carries
# no ``env`` and no ``headers``, and a server is dropped whole when a ``$`` could expand anywhere in
# it, when its address has userinfo, a query or a fragment, or when anything in its address path,
# command or arguments looks like a credential: a rewritten copy would not be the server the agent
# configured. The agent adds such a server again in the turn that needs it, with its key; the key
# lives only for that turn, like any other cloud install until the persistent cloud computer ships.
#
# The rules fail closed: they decide on the shape of the text, and what they cannot show to be
# ordinary they drop. They run twice, at export (the file the next turn receives) and at hydration
# (the next sandbox, reading a file the agent could write), so a tampered file buys nothing.
# Running the persisted servers each turn is the owner's accepted residual risk (see the
# agent-power session log): the agent already keeps skills and scripts in its own sandbox.

MCP_NAME = re.compile(r"[A-Za-z0-9_.-]{1,64}")
MCP_TRANSPORT = re.compile(r"[a-z][a-z-]{0,23}")
MCP_MAX_SERVERS = 32
MCP_MAX_ARGS = 64
MCP_MAX_TEXT = 1024
# Percent-decoding that still changes the text after this many rounds is nesting, not an address.
MCP_DECODE_ROUNDS = 4
# A flag, assignment or header whose name says "secret": the value after it is one.
MCP_SECRET_NAME = re.compile(
    r"(token|secret|passw|api[-_]?key|apikey|auth(?!or)|bearer|credential|signature|cookie"
    r"|(?:^|[-_])(?:key|pass|pwd|pat)(?:$|[-_]))",
    re.I,
)
# A known token shape: a vendor prefix at the start of a word, an Authorization scheme, or a private key.
MCP_TOKEN_PREFIX = re.compile(
    r"(?<![A-Za-z0-9])(?:sk-|sk_|rk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abprs]-|xapp-|AKIA|ASIA|AIza|ya29\.|glpat-|npm_|pypi-"
    r"|hf_|gsk_|xai-|shpat_|dop_v1_|eyJ|[Bb]earer\s)"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY"
)
MCP_PERCENT = re.compile(r"%[0-9A-Fa-f]{2}")
# 20 or more letters, digits, underscores or pluses in a row: `/`, `.`, `-` and the like break ordinary
# text into words, so a run this long that mixes letters and digits is not one.
MCP_OPAQUE_RUN = re.compile(r"[A-Za-z0-9_+]{20,}")
# An address that is only a place: http(s), a host, a port and plain path segments, matched whole
# (`fullmatch`: a trailing newline is not part of it). Userinfo (`@`), a query (`?`), a fragment (`#`),
# percent-encoding and `$` all fall outside it.
MCP_URL = re.compile(
    r"https?://(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?((?:/[A-Za-z0-9._~-]*)*)"
)
MCP_ADDRESS = re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*://\S*")
MCP_QUERY = re.compile(r"\?\S*=")
MCP_SCALARS = ("command", "url", "transport")


def mcp_has_interpolation(text: str) -> bool:
    """Whether a ``$`` could expand in ``text``: one as written, or in any percent-decoding of it.
    Hermes expands ``${NAME}`` in every config string (and a shell expands ``$NAME``), so any ``$``
    may be a reference to the turn's credentials, and ``%24%7BNAME%7D`` is one for a decoder."""
    for _ in range(MCP_DECODE_ROUNDS):
        if "$" in text:
            return True
        decoded = urllib.parse.unquote(text)
        if decoded == text:
            return False
        text = decoded
    return True


def mcp_looks_like_credential(text: str) -> bool:
    """Whether ``text``, one URL path segment or one command-line argument, may be a credential:
    anything percent-encoded, a known token prefix, or a run of 20+ characters that mixes letters
    and digits with no ``/``, ``.`` or ``-`` to give it word structure. A package name, a flag or a
    path (``@modelcontextprotocol/server-filesystem``, ``/home/agent/work``) is none of these."""
    if MCP_PERCENT.search(text) or MCP_TOKEN_PREFIX.search(text):
        return True
    return any(
        re.search(r"[A-Za-z]", run) and re.search(r"[0-9]", run) for run in MCP_OPAQUE_RUN.findall(text)
    )


def _mcp_text(value: object) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= MCP_MAX_TEXT and "\0" not in value else None


def _mcp_url_ok(url: str) -> bool:
    """A server address that carries no credential: only a place (``MCP_URL``), whose path has no
    segment that looks like one (a secret URL path is a secret)."""
    match = MCP_URL.fullmatch(url)
    return match is not None and not any(mcp_looks_like_credential(segment) for segment in match.group(1).split("/"))


def _mcp_arg_ok(arg: str) -> bool:
    """Whether one command-line argument (or the command) can be kept: no ``$``, no flag, assignment
    or header whose name says its value is a secret, nothing credential-shaped, and any address in
    it held to the rules for an address."""
    if mcp_has_interpolation(arg):
        return False
    # ``--api-key``, ``--token=...``, ``TOKEN=...``, ``Authorization: ...``.
    name = re.split(r"=|:\s", arg, maxsplit=1)[0]
    if MCP_SECRET_NAME.search(name) and (arg.startswith("-") or name != arg):
        return False
    # A query string is a credential channel in an argument as in an address, scheme or no scheme.
    if MCP_QUERY.search(arg):
        return False
    # An address handed to a stdio bridge (``mcp-remote https://...``) is judged as an address.
    return all(_mcp_url_ok(address) for address in MCP_ADDRESS.findall(arg)) and not mcp_looks_like_credential(
        MCP_ADDRESS.sub(" ", arg)
    )


def _mcp_strings(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _mcp_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _mcp_strings(item)


def _sanitize_mcp_server(server: object) -> dict | None:
    """One server's credential-free definition, or None when it cannot be kept faithfully. Only the
    fields below are ever kept: no ``env`` and no ``headers`` (a reference in either resolves from
    the next turn's environment, and a literal is a credential), and nothing this does not know."""
    if not isinstance(server, dict):
        return None
    clean: dict = {}
    for key in MCP_SCALARS:
        if key in server:
            text = _mcp_text(server[key])
            if text is None:
                return None
            clean[key] = text
    if not (clean.get("command") or clean.get("url")):
        return None
    if "transport" in clean and not MCP_TRANSPORT.fullmatch(clean["transport"]):
        return None
    args = server.get("args")
    if args is not None:
        if not isinstance(args, list) or len(args) > MCP_MAX_ARGS or any(_mcp_text(a) is None for a in args):
            return None
        clean["args"] = list(args)
    for key in ("enabled", "supports_parallel_tool_calls"):
        if isinstance(server.get(key), bool):
            clean[key] = server[key]
    for key in ("timeout", "connect_timeout"):
        value = server.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= 3600:
            clean[key] = value
    tools = server.get("tools")
    if isinstance(tools, dict):
        filtered = {
            key: [t for t in tools[key] if isinstance(t, str) and 0 < len(t) <= 128][:256]
            for key in ("include", "exclude") if isinstance(tools.get(key), list)
        }
        if filtered:
            clean["tools"] = filtered
    if "url" in clean and not _mcp_url_ok(clean["url"]):
        return None
    if "command" in clean and not _mcp_arg_ok(clean["command"]):
        return None
    if not all(_mcp_arg_ok(arg) for arg in clean.get("args", ())):
        return None
    # Hermes expands ``${...}`` in every string of a server's entry, so none may hold a ``$``.
    if any(mcp_has_interpolation(text) for text in _mcp_strings(clean)):
        return None
    return clean


def sanitize_mcp_servers(raw: object) -> dict:
    """The credential-free, bounded form of a config's ``mcp_servers``, or ``{}``. Idempotent."""
    if not isinstance(raw, dict):
        return {}
    kept: dict[str, dict] = {}
    for name, server in raw.items():
        if len(kept) >= MCP_MAX_SERVERS:
            break
        clean = _sanitize_mcp_server(server) if isinstance(name, str) and MCP_NAME.fullmatch(name) else None
        if clean is not None:
            kept[name] = clean
    body = json.dumps(kept, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")
    return kept if len(body) <= MAX_MCP_BYTES else {}


def _mcp_export_body(root: str) -> bytes | None:
    """The file body for the agent's MCP servers, from the live ``config.yaml`` under ``root``;
    ``b""`` when the config has none, and None when the config cannot be read. None means no file:
    the copy the agent may have written to ``MCP_SERVERS_PATH`` is never a substitute."""
    try:
        import yaml

        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except (ImportError, OSError):
        return None
    try:
        data, _mode = _read_stable(root_fd, "config.yaml", 1 << 20)
        config = yaml.safe_load(data)
    except Exception:
        return None
    finally:
        os.close(root_fd)
    if not isinstance(config, dict):
        return None
    servers = sanitize_mcp_servers(config.get("mcp_servers"))
    return json.dumps(servers, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8") if servers else b""


def _with_persisted_mcp(root_fd: int, config: dict) -> dict:
    """``config`` plus the servers a previous turn left in the hydrated home, sanitized again here:
    the file is the agent's to write. The controller's config never names MCP servers, so the
    persisted ones fill the section; any it does name win."""
    try:
        parent, name = _open_parent(root_fd, MCP_SERVERS_PATH)
    except OSError:
        return config
    try:
        data, _mode = _read_stable(parent, name, MAX_MCP_BYTES)
        servers = sanitize_mcp_servers(json.loads(data.decode("utf-8")))
    except (OSError, HomeError, ValueError, RecursionError):
        # A file that cannot be read costs the servers, never the turn (deep nesting raises RecursionError).
        return config
    finally:
        os.close(parent)
    if not servers:
        return config
    existing = config.get("mcp_servers")
    return {**config, "mcp_servers": {**servers, **(existing if isinstance(existing, dict) else {})}}


# ── Validate ─────────────────────────────────────────────────────────────────


def validate_home(root: str) -> dict:
    """What an export of ``root`` would carry and refuse, without reading file contents."""
    included = []
    denied: dict[str, int] = {}
    total = 0
    for candidate in scan_home(root):
        if candidate.path == MCP_SERVERS_PATH:
            continue  # an export never carries the agent's copy (``snapshot_home``)
        if candidate.decision == "hydrate":
            try:
                size = os.lstat(os.path.join(root, candidate.path)).st_size
            except OSError:
                continue
            included.append(candidate.path)
            total += size
        else:
            denied[candidate.rule] = denied.get(candidate.rule, 0) + 1
    return {
        "files": len(included),
        "bytes": total,
        "withinCaps": len(included) <= MAX_HOME_FILES and total <= MAX_HOME_BYTES,
        "denied": dict(sorted(denied.items())),
    }


# ── Cloud schedules (atum.cloud-execution/1 §9) ──────────────────────────────
#
# In Atum's cloud no Hermes runs between turns: the controller runs an agent's schedules from the
# summaries its home's export carries (packages/cloud-sandbox/entrypoint/home_export.py), each
# occurrence as a turn with the job's prompt. This is the one rule for which jobs that covers,
# shared by the export and by the ``cronjob`` tool, so a job the cloud will not run is refused
# when it is made, never accepted and then silently left alone (owner 2026-10-10).

CLOUD_MAX_SCHEDULES = 64
CLOUD_MIN_PERIOD_S = 60
# DA's catch-up window bounds (cloud_occurrences.catchup_window_ms).
CLOUD_CATCHUP_MIN_MS = 120_000
CLOUD_CATCHUP_MAX_MS = 7_200_000
# A one-off runs late rather than never: a job made in a long turn is exported only when the turn
# ends, and a controller restart can delay a tick. Up to two hours late, then DA records it missed.
CLOUD_ONE_OFF_CATCHUP_MS = CLOUD_CATCHUP_MAX_MS
# Between an export and the controller's claim come the commit and the next idle assignment poll.
# A repeating job's next run that would be past its catch-up window by then is a run DA would
# record missed (and never replay), which would leave the schedule pointing at it for good; the
# export moves such a job on to its next run it can still make instead, as Hermes's own ticker
# fast-forwards a job past its grace window (cron/jobs.py get_due_jobs).
CLOUD_LATE_MARGIN_MS = 60_000


def in_cloud_sandbox(environ: dict | None = None) -> bool:
    """Whether this Hermes runs in an Atum cloud task sandbox: only the controller sets the task's
    workspace and deadline (atum.cloud-execution/1 ``sandbox.environment``)."""
    env = os.environ if environ is None else environ
    return bool(env.get("ATUM_TASK_WORKSPACE")) and bool(env.get("ATUM_TASK_DEADLINE_MS"))


def schedule_period_seconds(schedule: dict) -> int | None:
    """How often a repeating schedule runs, in seconds; None when it does not repeat or cannot be
    read. Cron expressions use croniter, as Hermes's own ``cron/jobs.py`` does (imported here only
    when a cron schedule is read)."""
    kind = schedule.get("kind")
    if kind == "interval":
        minutes = schedule.get("minutes")
        return int(minutes * 60) if isinstance(minutes, (int, float)) and not isinstance(minutes, bool) and minutes > 0 else None
    if kind == "cron":
        try:
            from datetime import datetime

            from croniter import croniter

            expression = croniter(str(schedule.get("expr")), datetime.now().astimezone())
            first = expression.get_next(datetime)
            return int((expression.get_next(datetime) - first).total_seconds())
        except Exception:
            return None
    return None


def cloud_schedule_problem(job: dict, now_ms: int | None = None) -> str | None:
    """Why Atum's cloud cannot run this job, as a sentence for the agent; None when it can."""
    atum = job.get("atum")
    if isinstance(atum, dict) and atum.get("kind") == "check-ins":
        return ("Atum's cloud will not run the check-in job as an ordinary scheduled prompt until "
                "its bounded check-in gate is available. Keep check-ins on a Mac for now.")
    if job.get("no_agent") or job.get("script"):
        return ("Atum's cloud runs a scheduled job as a prompt for the agent; it cannot run a pre-run script "
                "(script or no_agent). Put the steps in the prompt instead: when the job fires, the agent can run "
                "the script itself with the terminal tool.")
    if job.get("context_from"):
        return ("Atum's cloud cannot feed one job's output into another (context_from). Put what the job needs "
                "in its own prompt, or make the two jobs one.")
    if job.get("workdir"):
        return ("Atum's cloud runs every job in the agent's own cloud workspace, not in another working "
                "directory (workdir). Leave workdir unset and name the folder in the prompt.")
    prompt = job.get("prompt")
    skills = job.get("skills") or ([job["skill"]] if job.get("skill") else [])
    if not (isinstance(prompt, str) and prompt.strip()) and not any(isinstance(name, str) and name.strip() for name in skills):
        return "A scheduled job in Atum's cloud needs a prompt or a skill to run."
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    if schedule.get("kind") == "once":
        if not (schedule.get("run_at") or job.get("next_run_at")):
            return "Atum's cloud cannot tell when this one-off job should run."
        if _cloud_one_off_missed(job, now_ms):
            return ("This one-off job's time passed more than two hours ago while Atum's cloud could not run it, so it "
                    "will not run. Give it a new time, or remove it.")
        return None
    period = schedule_period_seconds(schedule)
    if period is None:
        return "Atum's cloud cannot work out when this schedule runs. Use an interval, a cron expression or a time."
    if period < CLOUD_MIN_PERIOD_S:
        return "Atum's cloud runs a repeating job at most once a minute. Choose an interval of a minute or more."
    return None


def _epoch_ms(value) -> int | None:
    from datetime import datetime

    try:
        return max(0, int(datetime.fromisoformat(str(value)).timestamp() * 1000))
    except (TypeError, ValueError):
        return None


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)


def _cloud_one_off_missed(job: dict, now_ms: int | None = None) -> bool:
    """A one-off not yet run whose time is past DA's widest catch-up window: no claim can run it."""
    if job.get("last_run_at"):
        return False
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    due = _epoch_ms(job.get("next_run_at") or schedule.get("run_at"))
    return due is not None and due + CLOUD_ONE_OFF_CATCHUP_MS <= (_now_ms() if now_ms is None else now_ms)


def _next_makeable_run_ms(schedule: dict, next_ms: int, catchup_ms: int, now_ms: int) -> int | None:
    """The first run of a repeating schedule, on its own grid, that the controller can still claim
    after the commit: run + catch-up window > now + CLOUD_LATE_MARGIN_MS. An interval keeps the
    job's own phase (next_run_at plus whole periods); a cron expression takes its next slot, in
    Hermes's timezone as cron/jobs.py reads it. It can be a run just past, still in its window:
    like Hermes's ticker, the job then runs once now and skips only what it can no longer make."""
    from datetime import datetime

    after_ms = now_ms + CLOUD_LATE_MARGIN_MS - catchup_ms
    kind = schedule.get("kind")
    if kind == "interval":
        period = schedule_period_seconds(schedule)
        if not period:
            return None
        period_ms = period * 1000
        return next_ms + ((max(0, after_ms - next_ms) // period_ms) + 1) * period_ms
    if kind == "cron":
        try:
            from croniter import croniter

            try:
                from hermes_time import now as hermes_now

                zone = hermes_now().tzinfo
            except Exception:
                zone = datetime.now().astimezone().tzinfo
            slot = croniter(str(schedule.get("expr")), datetime.fromtimestamp(after_ms / 1000, zone)).get_next(datetime)
            return int(slot.timestamp() * 1000)
        except Exception:
            return None
    return None


def _cloud_live(job: dict) -> bool:
    """A job the cloud would run next: enabled, scheduled, and a one-off not yet run."""
    if job.get("enabled") is False or job.get("state") not in (None, "scheduled"):
        return False
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    return not (schedule.get("kind") == "once" and job.get("last_run_at"))


def cloud_schedule_refusal(job: dict, others: Iterable[dict]) -> str | None:
    """Why the cloud would not run ``job`` beside ``others`` (all the agent's jobs, in their
    order), or None. The cloud runs the first CLOUD_MAX_SCHEDULES jobs it can run, so only those
    before ``job`` count against it; a new job comes after them all."""
    problem = cloud_schedule_problem(job)
    if problem:
        return problem
    ahead = 0
    for other in others:
        if not isinstance(other, dict):
            continue
        if job.get("id") is not None and other.get("id") == job.get("id"):
            break
        if _cloud_live(other) and cloud_schedule_problem(other) is None:
            ahead += 1
    if ahead >= CLOUD_MAX_SCHEDULES:
        return (f"This agent already has {CLOUD_MAX_SCHEDULES} schedules in Atum's cloud, the most it runs. "
                "Remove or pause one first (cronjob action='list').")
    return None


def cloud_schedule_summaries(jobs: Iterable[dict], now_ms: int | None = None) -> list[dict]:
    """The schedules the controller runs while no sandbox is alive: every job the cloud can run
    (``cloud_schedule_problem``) that is live, repeating or one-off, at most CLOUD_MAX_SCHEDULES,
    in the jobs' own order. Each names its next occurrence, the window DA may still claim it in,
    and a digest of its definition.

    A repeating job's next occurrence is one the controller can still claim: a run it missed (a
    long turn, an occurrence DA skipped, a controller restart) is moved past, so any later commit
    starts the schedule again instead of leaving it on a run DA has recorded missed. A one-off past
    its window is left out (``cloud_schedule_problem`` says why, to the agent that lists it)."""
    from datetime import datetime

    now = _now_ms() if now_ms is None else now_ms
    summaries: list[dict] = []
    for job in jobs:
        if len(summaries) == CLOUD_MAX_SCHEDULES:
            break
        if not isinstance(job, dict) or not isinstance(job.get("id"), str) or not _cloud_live(job) or cloud_schedule_problem(job, now):
            continue
        schedule = job["schedule"]
        one_off = schedule.get("kind") == "once"
        try:
            next_at = datetime.fromisoformat(str(job.get("next_run_at") or (schedule.get("run_at") if one_off else "")))
        except ValueError:
            continue
        job_id = "".join(char for char in job["id"] if char.isalnum() or char in "_-")[:64]
        if not job_id:
            continue
        next_ms = max(0, int(next_at.timestamp() * 1000))
        if one_off:
            catchup = CLOUD_ONE_OFF_CATCHUP_MS
        else:
            period = schedule_period_seconds(schedule) or CLOUD_MIN_PERIOD_S
            catchup = min(CLOUD_CATCHUP_MAX_MS, max(CLOUD_CATCHUP_MIN_MS, (period // 2) * 1000))
            if next_ms + catchup <= now + CLOUD_LATE_MARGIN_MS:
                moved = _next_makeable_run_ms(schedule, next_ms, catchup, now)
                if moved is None:
                    continue
                next_ms = moved
        definition = {
            "prompt": job.get("prompt"),
            "schedule": schedule,
            "skills": job.get("skills") or [],
            "model": job.get("model"),
            "provider": job.get("provider"),
            "enabledToolsets": job.get("enabled_toolsets"),
        }
        digest = hashlib.sha256(json.dumps(definition, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8"))
        summaries.append({
            "scheduleId": job_id,
            "definitionDigest": digest.hexdigest(),
            "nextOccurrenceAt": next_ms,
            "catchupWindowMs": catchup,
        })
    return summaries


# ── Reconcile (migration: one agent's two Mac homes become one) ──────────────


MEMORY_DELIMITER = "\n§\n"  # tools/memory_tool.py ENTRY_DELIMITER


def _memory_entries(text: str) -> list[str]:
    """A Hermes memory file's entries (``tools/memory_tool.py``: ``\n§\n`` between entries)."""
    return [entry.strip() for entry in text.replace("\r\n", "\n").split(MEMORY_DELIMITER) if entry.strip()]


def _merge_memory(a: str, b: str) -> tuple[str, int]:
    """A's entries, then B's that A lacks (whitespace-insensitive), in order."""
    seen = set()
    merged = []
    for entry in _memory_entries(a) + _memory_entries(b):
        key = " ".join(entry.split())
        if key not in seen:
            seen.add(key)
            merged.append(entry)
    return MEMORY_DELIMITER.join(merged), len(merged) - len({" ".join(e.split()) for e in _memory_entries(a)})


def _tree_files(root: str, top: str) -> dict[str, bytes]:
    found = {}
    for candidate in scan_home(root):
        if candidate.decision == "hydrate" and candidate.path.split("/")[0] == top:
            parent_root = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                parent, name = _open_parent(parent_root, candidate.path)
                try:
                    found[candidate.path], _ = _read_stable(parent, name, MAX_HOME_BYTES)
                finally:
                    os.close(parent)
            finally:
                os.close(parent_root)
    return found


def _merge_sessions(target_db: str, other_db: str) -> dict:
    """Copy the other database's sessions (and their messages) that the target lacks. Message
    ids are reassigned in their original order; the database's own triggers keep its search
    index current. Different schema versions are not merged: the report says so."""
    report = {"added": 0, "skipped": 0, "merged": False}
    conn = sqlite3.connect(target_db)
    try:
        # ``other_db`` is reconcile's own scratch backup, never a live home.
        conn.execute("ATTACH DATABASE ? AS other", (other_db,))

        def version(schema: str) -> object:
            try:
                return conn.execute(f"SELECT version FROM {schema}.schema_version").fetchone()
            except sqlite3.Error:
                return None

        if version("main") != version("other"):
            report["reason"] = "schema_differs"
            return report

        def columns(schema: str, table: str) -> list[str]:
            return [row[1] for row in conn.execute(f"PRAGMA {schema}.table_info({table})")]

        session_cols = [c for c in columns("main", "sessions") if c in columns("other", "sessions")]
        message_cols = [c for c in columns("main", "messages") if c in columns("other", "messages") and c != "id"]
        new_ids = [
            row[0]
            for row in conn.execute(
                "SELECT id FROM other.sessions WHERE id NOT IN (SELECT id FROM main.sessions) ORDER BY started_at, id"
            )
        ]
        report["skipped"] = conn.execute(
            "SELECT count(*) FROM other.sessions WHERE id IN (SELECT id FROM main.sessions)"
        ).fetchone()[0]
        quoted_s = ",".join(f'"{c}"' for c in session_cols)
        quoted_m = ",".join(f'"{c}"' for c in message_cols)
        with conn:
            for session_id in new_ids:
                conn.execute(
                    f"INSERT INTO main.sessions ({quoted_s}) SELECT {quoted_s} FROM other.sessions WHERE id = ?",
                    (session_id,),
                )
                conn.execute(
                    f"INSERT INTO main.messages ({quoted_m}) SELECT {quoted_m} FROM other.messages "
                    "WHERE session_id = ? ORDER BY id",
                    (session_id,),
                )
        report["added"] = len(new_ids)
        report["merged"] = True
        return report
    finally:
        conn.close()


def _stable_home_file(root: str, rel: str) -> bytes | None:
    """Return an allowlisted regular file after a stable read, or ``None`` when absent.

    Reconciliation receives hydrated homes, but it still must not follow a replacement
    symlink or compare a file that changes while it is read.
    """
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            parent, name = _open_parent(root_fd, rel)
        except FileNotFoundError:
            return None
        try:
            try:
                st = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return None
            if entry_kind(st) != "file":
                return None
            return _read_stable(parent, name, MAX_HOME_BYTES)[0]
        finally:
            os.close(parent)
    finally:
        os.close(root_fd)


def _sqlite_reconcile_backup(home: str, name: str, scratch: str, side: str) -> str | None:
    """Make reconciliation's private SQLite snapshot, never comparing a live database."""
    source = os.path.join(home, name)
    try:
        st = os.stat(source, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if entry_kind(st) != "file":
        return None
    snapshot = os.path.join(scratch, f"{name}.{side}.sqlite")
    backup_sqlite(source, snapshot)
    return snapshot


def _snapshot_bytes(path: str) -> bytes:
    """Bytes from a private reconciliation snapshot, never a live home file."""
    with open(path, "rb") as handle:
        return handle.read()


def _copy_reconcile_snapshot(snapshot: str, target: str) -> None:
    shutil.copyfile(snapshot, target)
    os.chmod(target, FILE_MODE)


def _record_replaced(report: dict, path: str) -> None:
    report["replaced"].append({"path": path, "kept": "a"})
    if len(report["replaced"]) > MAX_RECONCILE_REPLACED:
        raise HomeError("reconcile_failed")


def _merge_cron_jobs(a: bytes, b: bytes) -> bytes | None:
    """Merge disjoint cron jobs by id, retaining A's on-disk document shape.

    A shared job id with different contents is an unresolved conflict.  Returning
    ``None`` lets the caller keep A and report the path as replaced instead of
    silently dropping the other Mac's version.
    """
    try:
        parsed_a = json.loads(a.decode("utf-8-sig"))
        parsed_b = json.loads(b.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None

    def jobs(document: object) -> list[dict] | None:
        values = document.get("jobs") if isinstance(document, dict) else document
        if not isinstance(values, list) or not all(isinstance(job, dict) for job in values):
            return None
        ids = [job.get("id") for job in values]
        if not all(isinstance(job_id, str) and job_id for job_id in ids) or len(set(ids)) != len(ids):
            return None
        return values

    # Different container metadata is also an owner-visible conflict; merging only
    # the job list must not discard another Mac's format/version or settings.
    metadata_a = {key: value for key, value in parsed_a.items() if key != "jobs"} if isinstance(parsed_a, dict) else {}
    metadata_b = {key: value for key, value in parsed_b.items() if key != "jobs"} if isinstance(parsed_b, dict) else {}
    if metadata_a != metadata_b:
        return None
    jobs_a, jobs_b = jobs(parsed_a), jobs(parsed_b)
    if jobs_a is None or jobs_b is None:
        return None
    by_id_a = {job["id"]: job for job in jobs_a}
    if any(job["id"] in by_id_a and by_id_a[job["id"]] != job for job in jobs_b):
        return None
    merged = jobs_a + [job for job in jobs_b if job["id"] not in by_id_a]
    if isinstance(parsed_a, dict):
        output = dict(parsed_a)
        output["jobs"] = merged
    else:
        output = merged
    return json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def reconcile_homes(home_a: str, home_b: str, out: str, *, label_b: str = "mini") -> dict:
    """Merge two homes of one agent into ``out`` (which must not exist) and write
    ``report.json`` beside the merged ``home/``."""
    if os.path.exists(out):
        raise HomeError("reconcile_out_exists")
    if re.fullmatch(r"[A-Za-z0-9-]{1,24}", label_b) is None:
        raise HomeError("reconcile_label_invalid")
    target = os.path.join(out, "home")
    os.makedirs(target, mode=DIR_MODE)
    report: dict = {
        "sessions": {}, "memories": {}, "skills": {"bothKept": [], "onlyA": [], "onlyB": []},
        "oneSided": [], "replaced": [],
    }

    # Databases are compared only after both have been captured with SQLite's backup API.
    with tempfile.TemporaryDirectory(prefix="atum-reconcile-") as scratch:
        for name in sorted(SQLITE_DATABASES):
            a_snapshot = _sqlite_reconcile_backup(home_a, name, scratch, "a")
            b_snapshot = _sqlite_reconcile_backup(home_b, name, scratch, "b")
            if a_snapshot is None and b_snapshot is None:
                continue
            base = a_snapshot or b_snapshot
            _copy_reconcile_snapshot(base, os.path.join(target, name))
            if a_snapshot is None or b_snapshot is None:
                report["oneSided"].append({"path": name, "side": "a" if a_snapshot else "b", "default": "keep"})
            elif name == "state.db":
                report["sessions"] = _merge_sessions(os.path.join(target, name), b_snapshot)
                if not report["sessions"]["merged"] and _snapshot_bytes(a_snapshot) != _snapshot_bytes(b_snapshot):
                    _record_replaced(report, name)
            elif _snapshot_bytes(a_snapshot) != _snapshot_bytes(b_snapshot):
                _record_replaced(report, name)

    # Memories: entry-level union, duplicates removed.
    a_mem, b_mem = _tree_files(home_a, "memories"), _tree_files(home_b, "memories")
    for rel in sorted(set(a_mem) | set(b_mem)):
        if rel in a_mem and rel in b_mem:
            merged, added = _merge_memory(a_mem[rel].decode("utf-8", "replace"), b_mem[rel].decode("utf-8", "replace"))
            data = merged.encode("utf-8")
            report["memories"][rel] = {"addedFromB": added}
        else:
            data = a_mem.get(rel, b_mem.get(rel))  # type: ignore[assignment]
            report["oneSided"].append({"path": rel, "side": "a" if rel in a_mem else "b", "default": "keep"})
        _place(target, rel, data)

    # Skills: a skill that differs keeps both copies; one-sided skills are kept and reported.
    a_skills, b_skills = _tree_files(home_a, "skills"), _tree_files(home_b, "skills")
    names_a = {rel.split("/")[1] for rel in a_skills if rel.count("/") >= 2}
    names_b = {rel.split("/")[1] for rel in b_skills if rel.count("/") >= 2}
    for rel, data in a_skills.items():
        _place(target, rel, data)
    reserved_skill_names = set(names_a) | set(names_b)
    for skill in sorted(names_b):
        files_b = {rel: data for rel, data in b_skills.items() if rel.split("/")[1:2] == [skill]}
        files_a = {rel: data for rel, data in a_skills.items() if rel.split("/")[1:2] == [skill]}
        if skill not in names_a:
            for rel, data in files_b.items():
                _place(target, rel, data)
            report["skills"]["onlyB"].append(skill)
        elif files_a != files_b:
            renamed = f"{skill}.{label_b}"
            suffix = 2
            while renamed in reserved_skill_names:
                renamed = f"{skill}-{suffix}.{label_b}"
                suffix += 1
            reserved_skill_names.add(renamed)
            for rel, data in files_b.items():
                _place(target, "/".join(["skills", renamed, *rel.split("/")[2:]]), data)
            report["skills"]["bothKept"].append({"a": skill, "b": renamed})
    report["skills"]["onlyA"] = sorted(names_a - names_b)
    for rel, data in a_skills.items():
        if rel.count("/") < 2:
            _place(target, rel, data)

    # The remaining files use stable reads.  Cron may merge by job id; SOUL cannot.
    for rel in ("SOUL.md", "cron/jobs.json"):
        a_data, b_data = _stable_home_file(home_a, rel), _stable_home_file(home_b, rel)
        if a_data is None and b_data is None:
            continue
        if a_data is None or b_data is None:
            _place(target, rel, a_data if a_data is not None else b_data)
            report["oneSided"].append({"path": rel, "side": "a" if a_data is not None else "b", "default": "keep"})
        elif a_data == b_data:
            _place(target, rel, a_data)
        elif rel == "cron/jobs.json":
            merged = _merge_cron_jobs(a_data, b_data)
            if merged is None:
                _place(target, rel, a_data)
                _record_replaced(report, rel)
            else:
                _place(target, rel, merged)
        else:
            _place(target, rel, a_data)
            _record_replaced(report, rel)

    _write_atomic(os.path.join(out, "report.json"), json.dumps(report, indent=2, sort_keys=True).encode("utf-8"))
    return report


def _place(root: str, rel: str, data: bytes) -> None:
    decision, _rule = hydration_decision(rel, "file")
    if decision != "hydrate":
        return
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parent = _ensure_dirs(root_fd, rel)
        try:
            name = rel.split("/")[-1]
            with contextlib.suppress(FileNotFoundError):
                os.unlink(name, dir_fd=parent)
            _write_new(parent, name, io.BytesIO(data), len(data), hashlib.sha256(data).hexdigest())
        finally:
            os.close(parent)
    finally:
        os.close(root_fd)


# ── CLI ──────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m hermes_cli.atum_home", description="An agent's portable Hermes home.")
    sub = parser.add_subparsers(dest="command", required=True)
    p_export = sub.add_parser("export", help="write the home's archive")
    p_export.add_argument("--home", required=True)
    p_export.add_argument("--out", required=True)
    p_validate = sub.add_parser("validate", help="report what an export would carry")
    p_validate.add_argument("--home", required=True)
    p_hydrate = sub.add_parser("hydrate", help="write an archive into an empty home")
    p_hydrate.add_argument("--home", required=True)
    p_hydrate.add_argument("--archive", required=True)
    p_reconcile = sub.add_parser("reconcile", help="merge two homes of one agent")
    p_reconcile.add_argument("home_a")
    p_reconcile.add_argument("home_b")
    p_reconcile.add_argument("--out", required=True)
    p_reconcile.add_argument("--label-b", default="mini")
    # The 2.1 portable checkpoint (atum_home_portable.py builds on this module, so it is imported here).
    from hermes_cli import atum_home_portable

    atum_home_portable.add_arguments(sub)
    args = parser.parse_args(argv)
    try:
        if args.command.startswith("portable-"):
            print(json.dumps(atum_home_portable.run(args), sort_keys=True))
        elif args.command == "export":
            if os.path.exists(args.out):
                raise HomeError("export_out_exists")
            fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, FILE_MODE)
            with os.fdopen(fd, "wb") as handle:
                header = export_home(args.home, handle)
            print(json.dumps({"files": len(header["files"]), "bytes": sum(f["size"] for f in header["files"])}))
        elif args.command == "validate":
            print(json.dumps(validate_home(args.home), sort_keys=True))
        elif args.command == "hydrate":
            with open(args.archive, "rb") as handle:
                print(json.dumps(hydrate_home(args.home, handle), sort_keys=True))
        else:
            report = reconcile_homes(args.home_a, args.home_b, args.out, label_b=args.label_b)
            print(json.dumps({"sessionsAdded": report["sessions"].get("added", 0), "oneSided": len(report["oneSided"])}))
    except HomeError as error:
        print(json.dumps({"error": error.code}), file=sys.stderr)
        return 2
    except (OSError, sqlite3.Error):
        print(json.dumps({"error": "home_io_failed"}), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    # `python -m hermes_cli.atum_home` runs this file as `__main__`, a second copy of the module that `atum_home_portable` takes
    # `HomeError` from, so the `except HomeError` of this copy's `main` would not catch what that module raises and a closed
    # code would leave as a traceback. The canonical copy's `main` catches the canonical class.
    from hermes_cli.atum_home import main as canonical_main

    raise SystemExit(canonical_main())
