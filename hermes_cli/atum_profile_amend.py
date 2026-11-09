"""Safely amend one stopped, locally imported Atum profile.

This is intentionally a small, receipt-bound migration tool.  It never creates
profiles, starts Hermes, enables schedules, copies credentials, or replaces a
skills tree.  `inspect` is read-only; `apply` requires both a reviewed plan
hash and an explicit stopped-home marker; `rollback` is compare-and-restore.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from agent.redact import redact_sensitive_text
from hermes_cli.atum_profile_import import ImportRefused, _mapping, _relative
from hermes_cli.atum_profile_install import RECEIPT, read_prepared
from hermes_cli.auth import _auth_lock_holder_for, _file_lock
from tools.memory_tool import ENTRY_DELIMITER

MAX_BYTES = 1024 * 1024
AMEND_DIR = ".atum-profile-amend"
CONTENT_RECEIPT = ".atum-agent-content/skills.json"
_ALLOWED_CONFIG = {
    "skills": {"external_dirs"},
    "toolsets": None,
    "memory": None,
    "approvals": None,
    "cron": None,
    "timezone": None,
    "conversation": None,
}
_MODEL_KEYS = {"provider", "default", "context_length", "reasoning_effort"}
_SECRET_WORDS = {"api_key", "apikey", "secret", "token", "password", "credential", "authorization", "cookie"}
_MEMORY_FILES = ("memories/MEMORY.md", "memories/USER.md")


class AmendmentRefused(ValueError):
    """The requested local amendment cannot prove it will be safe."""


@dataclass(frozen=True)
class _Write:
    path: str
    raw: bytes
    mode: int
    kind: str
    before: str | None


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def _regular(path: Path, *, required: bool = True, limit: int = MAX_BYTES) -> bytes | None:
    """Read one bounded, non-linked, single-link regular file without following it."""
    if path.is_symlink():
        raise AmendmentRefused("Symlinked amendment input is refused")
    if not path.exists():
        if required:
            raise AmendmentRefused("Required amendment input is missing")
        return None
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise AmendmentRefused("Amendment input must be a bounded regular file")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                raise AmendmentRefused("Amendment input changed while reading")
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise AmendmentRefused("Amendment input exceeds its byte limit")
        return raw
    except OSError as exc:
        raise AmendmentRefused("Cannot read amendment input") from exc


def _home(path: Path, label: str) -> Path:
    value = Path(path).absolute()
    if value.is_symlink() or not value.is_dir():
        raise AmendmentRefused(f"{label} must be a regular existing home")
    return value


def _child(root: Path, relative: str) -> Path:
    try:
        rel = _relative(relative)
    except ImportRefused as exc:
        raise AmendmentRefused("Unsafe amendment path") from exc
    result = root / rel
    try:
        result.relative_to(root)
    except ValueError as exc:
        raise AmendmentRefused("Unsafe amendment path") from exc
    current = root
    for part in Path(rel).parts:
        current /= part
        if current.is_symlink():
            raise AmendmentRefused("Symlinked amendment path is refused")
    return result


def _amend_target(relative: str) -> str:
    """Constrain mutable targets to the deliberately small amendment surface."""
    relative = _relative(relative)
    if relative in {"config.yaml", "SOUL.md"} or relative in _MEMORY_FILES or relative.startswith("scripts/"):
        return relative
    raise AmendmentRefused("Receipt names an unsupported amendment target")


def _target_receipt(home: Path, room: str, *, provisioned_target: bool) -> dict[str, str]:
    """Prove either an imported home or an already provisioned cloud home.

    The content receipt deliberately is not converted into an import receipt:
    it is only an attribution proof for a home Electron already provisioned.
    """
    if not re.fullmatch(r"![^\s:]+:[^\s]+", room) or room.endswith(":atum.invalid"):
        raise AmendmentRefused("A real enrolled Matrix room is required")
    if provisioned_target:
        raw = _regular(_child(home, CONTENT_RECEIPT), limit=MAX_BYTES)
        try:
            value = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise AmendmentRefused("Provisioned-home content receipt is invalid") from exc
        def valid_skill(name: Any, digest: Any) -> bool:
            if not isinstance(name, str) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                return False
            try:
                _relative(name)
            except ImportRefused:
                return False
            return True
        if (not isinstance(value, dict) or set(value) != {"schema_version", "skills"}
                or value.get("schema_version") != 1 or not isinstance(value.get("skills"), dict)
                or not all(valid_skill(name, digest) for name, digest in value["skills"].items())):
            raise AmendmentRefused("Provisioned-home content receipt is invalid")
        return {"kind": "provisioned", "digest": _digest(raw)}
    raw = _regular(_child(home, RECEIPT), limit=4096)
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise AmendmentRefused("Imported-home receipt is invalid") from exc
    if (not isinstance(value, dict) or value.get("schema_version") != 1
            or value.get("room") != room or not isinstance(value.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"])):
        raise AmendmentRefused("Imported-home receipt does not match this room")
    return {"kind": "imported", "digest": _digest(raw), "sha256": value["sha256"]}


def _yaml(raw: bytes, label: str) -> dict[str, Any]:
    try:
        return _mapping(raw, label)
    except ImportRefused as exc:
        raise AmendmentRefused("Invalid amendment configuration") from exc


def _has_secret(value: Any) -> bool:
    if isinstance(value, dict):
        return any(any(word in str(key).lower() for word in _SECRET_WORDS) or _has_secret(item)
                   for key, item in value.items())
    if isinstance(value, list):
        return any(_has_secret(item) for item in value)
    if isinstance(value, str):
        return redact_sensitive_text(value, force=True, redact_url_credentials=True) != value
    return False


def _same_machine_dir(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    path = Path(value).expanduser()
    return path.is_absolute() and path.exists() and path.is_dir() and not path.is_symlink()


def _executable(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        # A managed virtualenv commonly exposes its Python executable as a
        # symlink to the host interpreter.  This reference is validated, never
        # copied, so accepting that ordinary local executable is safe.
        return candidate.is_file() and os.access(candidate, os.X_OK)
    return shutil.which(value) is not None


def _mcp_servers(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AmendmentRefused("MCP servers must be a mapping")
    approved: dict[str, Any] = {}
    for name, server in value.items():
        # Copy only the portable stdio shape.  In particular, do not carry a
        # remote transport, headers, inherited environment, or arbitrary
        # provider-specific options whose credential semantics we cannot prove.
        if (not isinstance(name, str) or not isinstance(server, dict) or _has_secret(server)
                or not set(server).issubset({"command", "args", "enabled", "disabled", "tools"})
                or not _executable(server.get("command"))
                or ("args" in server and (not isinstance(server["args"], list)
                                           or not all(isinstance(item, str) for item in server["args"])))
                or ("enabled" in server and type(server["enabled"]) is not bool)
                or ("disabled" in server and type(server["disabled"]) is not bool)
                or ("tools" in server and (not isinstance(server["tools"], list)
                                            or not all(isinstance(item, str) for item in server["tools"])) )):
            # Old-machine executables are common in a copied profile.  They
            # are simply not part of the selected local behavior on this Mac.
            continue
        approved[name] = copy.deepcopy(server)
    return approved


def _selected_config(source: dict[str, Any], *, source_model: bool) -> tuple[dict[str, Any], list[str]]:
    selected: dict[str, Any] = {}
    for key, allowed in _ALLOWED_CONFIG.items():
        if key not in source:
            continue
        value = source[key]
        if allowed is None:
            selected[key] = copy.deepcopy(value)
        elif isinstance(value, dict):
            section = {name: copy.deepcopy(item) for name, item in value.items() if name in allowed}
            if "external_dirs" in section:
                dirs = section["external_dirs"]
                if not isinstance(dirs, list):
                    raise AmendmentRefused("skills.external_dirs must be a list")
                local_dirs = [item for item in dirs if _same_machine_dir(item)]
                if local_dirs:
                    section["external_dirs"] = local_dirs
                else:
                    section.pop("external_dirs")
            if section:
                selected[key] = section
    if "mcp_servers" in source:
        servers = _mcp_servers(source["mcp_servers"])
        if servers:
            selected["mcp_servers"] = servers
    if source_model and "model" in source:
        model = source["model"]
        if not isinstance(model, dict):
            raise AmendmentRefused("Source model configuration is invalid")
        selected["model"] = {key: copy.deepcopy(value) for key, value in model.items() if key in _MODEL_KEYS}
    if _has_secret(selected):
        raise AmendmentRefused("Allowlisted configuration contains a credential")
    return selected, sorted(selected)


def _config_write(source: Path, home: Path, *, source_model: bool) -> tuple[_Write | None, list[str]]:
    source_raw = _regular(_child(source, "config.yaml"), required=False)
    if source_raw is None:
        return None, []
    src = _yaml(source_raw, "source config")
    selected, names = _selected_config(src, source_model=source_model)
    destination = _child(home, "config.yaml")
    dest_raw = _regular(destination, required=False)
    if dest_raw is None and not selected:
        return None, names
    dest = _yaml(dest_raw, "destination config") if dest_raw is not None else {}
    output = copy.deepcopy(dest)
    # Imported agents use the full capability surface while retaining custom toolset definitions.
    # Do not propagate source-machine enable lists or disabled-skill masks to the destination.
    if output.pop("platform_toolsets", None) is not None:
        names.append("platform_toolsets")
    if isinstance(output.get("skills"), dict) and "disabled" in output["skills"]:
        output["skills"].pop("disabled")
        names.append("skills.disabled")
        if not output["skills"]:
            output.pop("skills")
    for name, value in selected.items():
        if name == "mcp_servers" and isinstance(output.get("mcp_servers"), dict):
            # An operator may already have repaired this Mac's interpreter or
            # environment binding. Preserve that proven local connection.
            output[name] = {**value, **output[name]}
        elif name == "skills" and isinstance(output.get("skills"), dict):
            merged = copy.deepcopy(output["skills"])
            merged.update(value)
            output[name] = merged
        else:
            output[name] = value
    raw = yaml.safe_dump(output, allow_unicode=True, sort_keys=False).encode("utf-8")
    if raw == dest_raw:
        return None, names
    mode = stat.S_IMODE(destination.stat().st_mode) if dest_raw is not None else 0o600
    return _Write("config.yaml", raw, mode, "config", _digest(dest_raw) if dest_raw is not None else None), sorted(set(names))


def _memory_writes(source: Path, home: Path, *, concat: bool) -> list[_Write]:
    writes: list[_Write] = []
    for relative in _MEMORY_FILES:
        source_raw = _regular(_child(source, relative), required=False, limit=MAX_BYTES)
        dest_path = _child(home, relative)
        dest_raw = _regular(dest_path, required=False, limit=MAX_BYTES)
        if source_raw is None or not source_raw.strip() or source_raw == dest_raw:
            continue
        if dest_raw and dest_raw.strip():
            if not concat:
                raise AmendmentRefused("Differing nonempty local memory requires --concat-memories")
            raw = dest_raw.rstrip() + ENTRY_DELIMITER.encode() + source_raw.lstrip()
        else:
            raw = source_raw
        mode = stat.S_IMODE(dest_path.stat().st_mode) if dest_raw is not None else 0o600
        writes.append(_Write(relative, raw, mode, "memory", _digest(dest_raw) if dest_raw is not None else None))
    return writes


def _persona_write(source: Path, home: Path, *, selected: bool) -> _Write | None:
    if not selected:
        return None
    raw = _regular(_child(source, "SOUL.md"), limit=65536)
    if raw is None or not raw.strip():
        raise AmendmentRefused("Source persona is empty")
    destination = _child(home, "SOUL.md")
    before = _regular(destination, required=False, limit=65536)
    if raw == before:
        return None
    mode = stat.S_IMODE(destination.stat().st_mode) if before is not None else 0o600
    return _Write("SOUL.md", raw, mode, "persona", _digest(before) if before is not None else None)


def _old_script_matches(prepared: Path | None, receipt: dict[str, str], relative: str, destination: bytes) -> bool:
    if prepared is None or receipt.get("kind") != "imported":
        return False
    try:
        plan = read_prepared(prepared, receipt["sha256"])
    except (ImportRefused, OSError, ValueError):
        return False
    old = plan.files.get(f"profile/scripts/{relative}")
    return old is not None and _digest(old) == _digest(destination)


def _script_writes(source: Path, home: Path, scripts: list[str], prepared: Path | None,
                   receipt: dict[str, str]) -> list[_Write]:
    writes: list[_Write] = []
    for requested in scripts:
        relative = _relative(requested)
        source_path = _child(source, f"scripts/{relative}")
        source_raw = _regular(source_path, limit=MAX_BYTES)
        destination_relative = _amend_target(f"scripts/{relative}")
        dest_path = _child(home, destination_relative)
        dest_raw = _regular(dest_path, required=False, limit=MAX_BYTES)
        if dest_raw == source_raw:
            continue
        if dest_raw is not None and not _old_script_matches(prepared, receipt, relative, dest_raw):
            raise AmendmentRefused("Existing script is not the exact prior imported version")
        source_mode = stat.S_IMODE(source_path.stat().st_mode)
        mode = stat.S_IMODE(dest_path.stat().st_mode) if dest_raw is not None else source_mode
        writes.append(_Write(destination_relative, source_raw, mode, "script",
                             _digest(dest_raw) if dest_raw is not None else None))
    return writes


def _plan(source: Path, home: Path, room: str, *, scripts: list[str], source_model: bool,
          source_persona: bool, concat_memories: bool, prepared: Path | None,
          provisioned_target: bool) -> tuple[dict[str, Any], list[_Write]]:
    source = _home(source, "Source")
    home = _home(home, "Destination")
    if source.resolve() == home.resolve():
        raise AmendmentRefused("Source and destination homes must differ")
    receipt = _target_receipt(home, room, provisioned_target=provisioned_target)
    config, keys = _config_write(source, home, source_model=source_model)
    persona = _persona_write(source, home, selected=source_persona)
    writes = ([] if config is None else [config]) + ([] if persona is None else [persona])
    writes += _memory_writes(source, home, concat=concat_memories)
    writes += _script_writes(source, home, scripts, prepared, receipt)
    if len({write.path for write in writes}) != len(writes):
        raise AmendmentRefused("An amendment path was selected twice")
    rows = [{"path": write.path, "kind": write.kind, "before_sha256": write.before,
             "after_sha256": _digest(write.raw), "bytes": len(write.raw)} for write in sorted(writes, key=lambda item: item.path)]
    # Keep the report safe to hand to an operator: it binds the selected files
    # by digest, but deliberately contains no profile paths or configuration
    # values (which can disclose personal machine layout or private text).
    binding = _digest(_canonical({"source": str(source.resolve()), "destination": str(home.resolve()),
                                  "room": room, "receipt": receipt}))
    basis = {"schema_version": 1, "target_kind": receipt["kind"], "binding_sha256": binding,
             "receipt_digest_sha256": receipt["digest"],
             "config_keys": keys,
             "writes": rows, "source_model": source_model, "source_persona": source_persona,
             "concat_memories": concat_memories}
    return {**basis, "plan_sha256": _digest(_canonical(basis))}, writes


def inspect_amendment(source: Path, home: Path, room: str, *, scripts: list[str] | None = None,
                      source_model: bool = False, source_persona: bool = False,
                      concat_memories: bool = False,
                      prepared: Path | None = None, provisioned_target: bool = False) -> dict[str, Any]:
    """Build a content-free plan.  This function performs no writes."""
    report, _ = _plan(source, home, room, scripts=scripts or [], source_model=source_model,
                      source_persona=source_persona,
                      concat_memories=concat_memories, prepared=prepared, provisioned_target=provisioned_target)
    return report


def _stopped(marker: Path, home: Path) -> None:
    raw = _regular(Path(marker).absolute(), limit=4096)
    try:
        value = json.loads(raw)
        marked_home = Path(value["home"]).expanduser().resolve(strict=True)
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError) as exc:
        raise AmendmentRefused("Stopped-home marker is invalid") from exc
    if value.get("state") != "stopped" or marked_home != home.resolve(strict=True):
        raise AmendmentRefused("Stopped-home marker does not prove this home is stopped")


def _atomic(path: Path, raw: bytes, mode: int) -> None:
    if path.is_symlink() or path.exists() and not stat.S_ISREG(path.lstat().st_mode):
        raise AmendmentRefused("Amendment destination is not a regular file")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink():
        raise AmendmentRefused("Amendment parent may not be a symlink")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _snapshot(home: Path, writes: list[_Write], plan: dict[str, Any]) -> tuple[Path, list[dict[str, Any]]]:
    root = _child(home, f"{AMEND_DIR}/backups/{uuid.uuid4().hex}")
    root.mkdir(parents=True, mode=0o700)
    entries: list[dict[str, Any]] = []
    for write in writes:
        path = _child(home, write.path)
        before = _regular(path, required=False)
        entry: dict[str, Any] = {"path": write.path, "before_sha256": write.before,
                                 "after_sha256": _digest(write.raw), "mode": write.mode,
                                 "existed": before is not None}
        if before is not None:
            saved = _child(root, write.path)
            saved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            _atomic(saved, before, write.mode)
        entries.append(entry)
    _atomic(root / "manifest.json", _canonical({"plan_sha256": plan["plan_sha256"], "files": entries}), 0o600)
    return root, entries


def _apply_writes(home: Path, writes: list[_Write]) -> None:
    for write in writes:
        current = _regular(_child(home, write.path), required=False)
        if (current is None and write.before is not None) or (current is not None and _digest(current) != write.before):
            raise AmendmentRefused("Destination changed since amendment plan")
    for write in writes:
        _atomic(_child(home, write.path), write.raw, write.mode)


def apply_amendment(source: Path, home: Path, room: str, *, expected_plan_sha256: str,
                    stopped_marker: Path, scripts: list[str] | None = None, source_model: bool = False,
                    source_persona: bool = False, concat_memories: bool = False, prepared: Path | None = None,
                    provisioned_target: bool = False) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_plan_sha256):
        raise AmendmentRefused("A reviewed amendment plan hash is required")
    home = _home(home, "Destination")
    _stopped(stopped_marker, home)
    lock = _child(home, f"{AMEND_DIR}/amend.lock")
    with _file_lock(lock, _auth_lock_holder_for(lock), 5, "Profile amendment is already running"):
        _stopped(stopped_marker, home)
        plan, writes = _plan(source, home, room, scripts=scripts or [], source_model=source_model,
                             source_persona=source_persona,
                             concat_memories=concat_memories, prepared=prepared,
                             provisioned_target=provisioned_target)
        if plan["plan_sha256"] != expected_plan_sha256:
            raise AmendmentRefused("Source or destination changed; inspect a new plan")
        if not writes:
            return {"status": "unchanged", "plan_sha256": plan["plan_sha256"], "writes": 0}
        snapshot, entries = _snapshot(home, writes, plan)
        try:
            _apply_writes(home, writes)
        except Exception:
            for entry in reversed(entries):
                path = _child(home, entry["path"])
                saved = _child(snapshot, entry["path"])
                if entry["existed"]:
                    _atomic(path, _regular(saved), int(entry["mode"]))
                elif path.exists():
                    path.unlink()
            raise
        receipt_id = f"{uuid.uuid4().hex}.json"
        receipt = {"schema_version": 1, "plan_sha256": plan["plan_sha256"],
                   "backup": str(snapshot.relative_to(home)), "files": entries}
        receipts = _child(home, f"{AMEND_DIR}/receipts")
        receipts.mkdir(parents=True, exist_ok=True, mode=0o700)
        _atomic(receipts / receipt_id, _canonical(receipt), 0o600)
        return {"status": "applied", "plan_sha256": plan["plan_sha256"], "receipt": receipt_id,
                "writes": len(entries)}


def rollback_amendment(home: Path, *, receipt: Path, stopped_marker: Path) -> dict[str, Any]:
    home = _home(home, "Destination")
    _stopped(stopped_marker, home)
    receipt_path = Path(receipt).absolute()
    allowed = home / AMEND_DIR / "receipts"
    try:
        receipt_path.relative_to(allowed)
    except ValueError as exc:
        raise AmendmentRefused("Rollback receipt must be inside this home") from exc
    raw = _regular(receipt_path, limit=MAX_BYTES)
    try:
        value = json.loads(raw)
        rows = value["files"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise AmendmentRefused("Rollback receipt is invalid") from exc
    if value.get("schema_version") != 1 or not isinstance(rows, list) or not rows:
        raise AmendmentRefused("Rollback receipt is invalid")
    lock = _child(home, f"{AMEND_DIR}/amend.lock")
    with _file_lock(lock, _auth_lock_holder_for(lock), 5, "Profile amendment is already running"):
        _stopped(stopped_marker, home)
        backup_name = value.get("backup")
        if not isinstance(backup_name, str) or not backup_name.startswith(f"{AMEND_DIR}/backups/"):
            raise AmendmentRefused("Rollback snapshot is unavailable")
        backup = _child(home, backup_name)
        if not backup.is_dir() or backup.is_symlink():
            raise AmendmentRefused("Rollback snapshot is unavailable")
        restored: dict[str, bytes] = {}
        for row in rows:
            if (not isinstance(row, dict) or not isinstance(row.get("path"), str)
                    or not isinstance(row.get("after_sha256"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", row["after_sha256"])
                    or type(row.get("existed")) is not bool or not isinstance(row.get("mode"), int)):
                raise AmendmentRefused("Rollback receipt is invalid")
            target = _amend_target(row["path"])
            current = _regular(_child(home, target), required=False)
            if current is None or _digest(current) != row.get("after_sha256"):
                raise AmendmentRefused("Refusing rollback because an amended file changed")
            if row["existed"]:
                saved = _regular(_child(backup, target))
                if _digest(saved) != row.get("before_sha256"):
                    raise AmendmentRefused("Rollback snapshot changed")
                restored[target] = saved
        for row in reversed(rows):
            target = _child(home, _amend_target(row["path"]))
            if row.get("existed"):
                _atomic(target, restored[row["path"]], int(row["mode"]))
            else:
                target.unlink()
        return {"status": "rolled_back", "plan_sha256": value.get("plan_sha256"), "writes": len(rows)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("inspect", "apply", "rollback"))
    parser.add_argument("--source", type=Path)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--room")
    parser.add_argument("--script", action="append", default=[])
    parser.add_argument("--prepared", type=Path)
    parser.add_argument("--source-model", action="store_true")
    parser.add_argument("--source-persona", action="store_true")
    parser.add_argument("--provisioned-target", action="store_true")
    parser.add_argument("--concat-memories", action="store_true")
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--stopped-marker", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.operation == "inspect":
            if args.source is None or args.room is None:
                parser.error("inspect requires --source and --room")
            result = inspect_amendment(args.source, args.home, args.room, scripts=args.script,
                                      source_model=args.source_model, source_persona=args.source_persona,
                                      concat_memories=args.concat_memories,
                                      prepared=args.prepared, provisioned_target=args.provisioned_target)
        elif args.operation == "apply":
            if args.source is None or args.room is None or args.stopped_marker is None:
                parser.error("apply requires --source, --room and --stopped-marker")
            result = apply_amendment(args.source, args.home, args.room,
                                     expected_plan_sha256=args.expected_plan_sha256 or "",
                                     stopped_marker=args.stopped_marker, scripts=args.script,
                                     source_model=args.source_model, source_persona=args.source_persona,
                                     concat_memories=args.concat_memories,
                                     prepared=args.prepared, provisioned_target=args.provisioned_target)
        else:
            if args.receipt is None or args.stopped_marker is None:
                parser.error("rollback requires --receipt and --stopped-marker")
            result = rollback_amendment(args.home, receipt=args.receipt, stopped_marker=args.stopped_marker)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (AmendmentRefused, ImportRefused, OSError, TypeError, ValueError):
        print(json.dumps({"error": "local_profile_amendment_refused"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
