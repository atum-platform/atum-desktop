"""One-off, offline rehearsal of a Hermes profile → Atum agent import.

No networking, runtime, account operations or credential-file import. Run on the source Mac.
`inspect` prints a content-free manifest; `stage` writes a NEW rehearsal directory,
not a running Hermes home. Schedule transfer is deliberately a separate operation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from agent.redact import redact_sensitive_text
from agent.skill_utils import EXCLUDED_SKILL_DIRS, is_excluded_skill_path
from hermes_cli.atum_memory_sync import _portable_entries, _validate_snapshot
from hermes_cli.atum_portability import MODEL_ALIASES, _skill_tree_hash, _validate_skill_name
from hermes_cli.atum_skill_bundles import (
    MAX_FILES as BUNDLE_MAX_FILES,
    MAX_RAW_BYTES as BUNDLE_MAX_BYTES,
    SkillBundleError,
    _hash_entries,
    _validate_path as validate_bundle_path,
)
from tools.memory_tool import ENTRY_DELIMITER
from tools.skills_sync import dir_hash
from tools.skill_usage import read_skill_name as _read_skill_name


MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_FILES = 10_000
CONFIG_FIELDS = {
    "model": ("provider", "default", "context_length", "reasoning_effort"),
    "memory": ("memory_enabled", "user_profile_enabled", "memory_char_limit", "user_char_limit"),
    "plugins": ("disabled",),
}
# ``tools/skills_sync.py`` records each skill this Hermes installation seeded.
SHIPPED_MANIFEST = "skills/.bundled_manifest"
JOB_FIELDS = {
    "id", "name", "prompt", "schedule", "schedule_display", "repeat", "created_at",
    "skill", "skills", "model", "provider", "model_snapshot", "provider_snapshot",
    "base_url", "script", "no_agent", "context_from", "enabled_toolsets", "workdir",
}


class ImportRefused(ValueError):
    """A rehearsal cannot preserve the intended data safely."""


def _json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def _hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _credential_name(name: str) -> bool:
    value = name.lower()
    return (
        value == ".env" or (value.startswith(".env.") and value not in {".env.example", ".env.sample"})
        or value in {"auth.json", "credentials.json", "id_rsa", "id_ed25519"}
        or value.endswith((".pem", ".key", ".p12", ".pfx"))
    )


def _relative(value: str) -> str:
    try:
        return _validate_skill_name(value)
    except ValueError as exc:
        raise ImportRefused("Unsafe relative artifact path") from exc


def _redact(text: str) -> str:
    return redact_sensitive_text(text, force=True, redact_url_credentials=True)


def _walk_error(_error: OSError) -> None:
    raise ImportRefused("Cannot enumerate a complete skill package")


def _resolve_link(path: Path) -> Path:
    try:
        return path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ImportRefused("Missing, unreadable or cyclic link target") from exc


@dataclass
class Rehearsal:
    manifest: dict[str, Any]
    files: dict[str, bytes]
    executable: set[str]


class _Source:
    def __init__(self, root: Path):
        self.root = root
        self.inputs: dict[str, str] = {}
        self.total = 0

    def read(self, relative: str, *, root: Path | None = None, label: str | None = None,
             optional: bool = False, limit: int = MAX_FILE_BYTES) -> bytes:
        relative = _relative(relative)
        if any(_credential_name(part) or part == ".ssh" for part in Path(relative).parts):
            raise ImportRefused(f"Credential-named artifact refused: {label or relative}")
        base = root or self.root
        current = base
        for part in Path(relative).parts:
            current /= part
            if current.is_symlink():
                raise ImportRefused(f"Symlink not approved: {label or relative}")
        if not current.exists() and optional:
            return b""
        try:
            info = current.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ImportRefused(f"Not a single regular file: {label or relative}")
            if info.st_size > limit:
                raise ImportRefused(f"Artifact exceeds byte limit: {label or relative}")
            # NOFOLLOW also refuses replacement of the final file by a symlink.
            fd = os.open(current, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                    raise ImportRefused("Artifact changed while reading")
                raw = stream.read(limit + 1)
            if len(raw) > limit:
                raise ImportRefused(f"Artifact exceeds byte limit: {label or relative}")
        except OSError as exc:
            raise ImportRefused(f"Cannot read artifact: {label or relative}") from exc
        self.total += len(raw)
        self.inputs[label or relative] = _hash(raw)
        if self.total > MAX_TOTAL_BYTES or len(self.inputs) > MAX_FILES:
            raise ImportRefused("Profile exceeds rehearsal size limit")
        return raw


def _mapping(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = yaml.safe_load(raw) or {}
        if not isinstance(value, dict) or not all(isinstance(k, str) for k in value):
            raise ValueError()
        # Reject YAML's dates/custom types and non-finite values before persisting.
        json.dumps(value, allow_nan=False)
        return value
    except (ValueError, TypeError, yaml.YAMLError) as exc:
        raise ImportRefused(f"Invalid {label}") from exc


def _local_config(config: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    selected: dict[str, Any] = {}
    omitted: list[str] = []
    for section, value in config.items():
        if section == "timezone" and isinstance(value, str):
            selected[section] = value
        elif section in CONFIG_FIELDS and isinstance(value, dict):
            selected[section] = {k: v for k, v in value.items() if k in CONFIG_FIELDS[section]}
            omitted.extend(f"{section}.{k}" for k in value if k not in CONFIG_FIELDS[section])
        elif section != "_config_version":
            omitted.append(section)
    model = selected.get("model", {})
    if not all(isinstance(model.get(k), str) and model[k].strip() for k in ("provider", "default")):
        raise ImportRefused("Source must declare its provider and model")
    if _redact(_json(selected).decode()) != _json(selected).decode():
        raise ImportRefused("Allowlisted configuration contains a credential")
    return selected, sorted(omitted)


def _memory(source: _Source) -> tuple[dict[str, list[str]], dict[str, int]]:
    snapshot: dict[str, list[str]] = {}
    excluded: dict[str, int] = {}
    for target, filename in (("memory", "MEMORY.md"), ("user", "USER.md")):
        raw = source.read(f"memories/{filename}", optional=True, limit=65536).decode("utf-8")
        entries = list(dict.fromkeys(e.strip() for e in raw.split(ENTRY_DELIMITER) if e.strip()))
        snapshot[target] = _portable_entries(entries)
        excluded[target] = len(entries) - len(snapshot[target])
    return _validate_snapshot(snapshot, name="import", permit_local=False), excluded


def _shipped_origins(source: _Source) -> dict[str, str]:
    """Return the source bundled-skill manifest's verified v2 origins.

    A v1 entry has no baseline hash and therefore cannot prove that a local
    copy is pristine.  It remains ordinary imported content.
    """
    raw = source.read(SHIPPED_MANIFEST, optional=True, limit=1024 * 1024)
    origins: dict[str, str] = {}
    for line in raw.decode("utf-8", errors="replace").splitlines():
        name, separator, digest = line.strip().partition(":")
        if separator and name.strip() and re.fullmatch(r"[0-9a-f]{32}", digest.strip()):
            origins[name.strip()] = digest.strip()
    return origins


def _skills(source: _Source, allowed: set[Path], files: dict[str, bytes], executable: set[str],
            shipped: list[dict[str, str]]) -> list[dict[str, str]]:
    """Stage skills and identify source-pristine bundled packages.

    Packages are still staged whole.  The installed runtime decides which
    matching shipped packages to leave to its own bundled seeding.
    """
    root = source.root / "skills"
    if root.is_symlink():
        raise ImportRefused("The skills root must not be a symlink")
    if not root.exists():
        return []
    if not root.is_dir():
        raise ImportRefused("The skills root must be a directory")
    origins = _shipped_origins(source)
    packages: dict[str, Path] = {}
    for base, dirs, names in os.walk(root, followlinks=False, onerror=_walk_error):
        directory = Path(base)
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_SKILL_DIRS)
        # A dangling directory link is reported among filenames by os.walk.
        if any((directory / name).is_symlink() for name in names):
            raise ImportRefused("Symlinked skill file or broken package link")
        for name in list(dirs):
            linked = directory / name
            if linked.is_symlink():
                target = _resolve_link(linked)
                if directory != root or target not in allowed or not (target / "SKILL.md").is_file():
                    raise ImportRefused(f"Skill link needs exact approval: {linked.relative_to(root)}")
                packages[_relative(name)] = target
                dirs.remove(name)
        if "SKILL.md" in names and not is_excluded_skill_path(directory / "SKILL.md"):
            packages[_relative(directory.relative_to(root).as_posix())] = directory
            dirs[:] = []  # Supporting files are part of this package, not new skills.
    if len(packages) > 512:
        raise ImportRefused("Too many skill packages")
    skills = []
    for name, package in sorted(packages.items()):
        entries: dict[str, bytes] = {}
        for base, dirs, names in os.walk(package, followlinks=False, onerror=_walk_error):
            directory = Path(base)
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_SKILL_DIRS)
            if any((directory / d).is_symlink() for d in dirs):
                raise ImportRefused(f"Nested skill link refused: {name}")
            for filename in sorted(names):
                relative = _relative((directory / filename).relative_to(package).as_posix())
                if _credential_name(filename):
                    raise ImportRefused(f"Credential-named skill file refused: {name}/{relative}")
                raw = source.read(relative, root=package, label=f"skills/{name}/{relative}")
                entries[relative] = raw
                output = f"profile/skills/{name}/{relative}"
                files[output] = raw
                if (directory / filename).stat().st_mode & 0o111:
                    executable.add(output)
        skills.append({"name": name, "sha256": _hash_entries(list(entries.items()))})
        # Only a package contained in the source profile can be one of its
        # seeded copies. An explicitly approved linked package is user-owned.
        if origins and package.parent.is_relative_to(root) and not (root / name).is_symlink():
            skill_name = _read_skill_name(package / "SKILL.md", package.name)
            if origins.get(skill_name) in (dir_hash(package), dir_hash(package, include_runtime_cache=True)):
                shipped.append({"name": name, "skill": skill_name})
    return skills


def _jobs(source: _Source, room: str, files: dict[str, bytes], executable: set[str]) -> tuple[list[dict], list[dict]]:
    raw = source.read("cron/jobs.json", optional=True, limit=2 * 1024 * 1024)
    try:
        value = json.loads(raw) if raw else {"jobs": []}
        rows = value.get("jobs") if isinstance(value, dict) else value
        if not isinstance(rows, list) or len(rows) > 1000 or any(not isinstance(j, dict) for j in rows):
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise ImportRefused("Invalid cron/jobs.json") from exc
    prepared, report = [], []
    ids: set[str] = set()
    for old in rows:
        job_id = old.get("id")
        if not isinstance(job_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", job_id) or job_id in ids:
            raise ImportRefused("Invalid or repeated cron job ID")
        ids.add(job_id)
        if not isinstance(old.get("schedule"), dict):
            raise ImportRefused(f"Job has no structured schedule: {job_id}")
        job = {k: v for k, v in old.items() if k in JOB_FIELDS}
        script = job.get("script")
        if script:
            if not isinstance(script, str):
                raise ImportRefused("Invalid cron script")
            relative = _relative(script)
            raw_script = source.read(f"scripts/{relative}", limit=1024 * 1024)
            output = f"profile/scripts/{relative}"
            files[output] = raw_script
            if (source.root / "scripts" / relative).stat().st_mode & 0o111:
                executable.add(output)
        job.update({
            "enabled": False, "state": "paused", "paused_reason": "atum_import_rehearsal",
            "next_run_at": None, "last_run_at": None, "last_status": None,
            "last_error": None, "last_delivery_error": None,
            "deliver": f"matrix:{room}", "origin": {"platform": "matrix", "chat_id": room},
            "attach_to_session": False,
        })
        prepared.append(job)
        report.append({"id": job_id, "source_enabled": old.get("enabled", True) is True,
                       "source_state": old.get("state"), "has_script": bool(script),
                       "had_session_attachment": bool(old.get("attach_to_session"))})
    return prepared, report


def inspect_profile(source_dir: Path, room: str, *, model_alias: str = "binh-minh",
                    allow_skill_links: tuple[Path, ...] = (),
                    allow_instruction_links: tuple[Path, ...] = ()) -> Rehearsal:
    root = Path(source_dir).absolute()
    if root.is_symlink() or not root.is_dir():
        raise ImportRefused("Source must be a regular profile directory")
    if (root / "plugins").is_symlink():
        raise ImportRefused("Plugin inventory must not follow a symlink")
    if not re.fullmatch(r"![^\s:]+:[^\s]+", room) or len(room) > 1024 or model_alias not in MODEL_ALIASES:
        raise ImportRefused("Invalid target room or managed model alias")
    source = _Source(root)
    config = _mapping(source.read("config.yaml", limit=1024 * 1024), "config.yaml")
    local_config, omitted = _local_config(config)
    instruction_links = {_resolve_link(Path(p)) for p in allow_instruction_links}

    def instruction(name: str, optional: bool = False) -> str:
        file = root / name
        if file.is_symlink():
            target = _resolve_link(file)
            if target not in instruction_links:
                raise ImportRefused(f"Instruction link needs exact approval: {name}")
            return source.read(target.name, root=target.parent, label=name, limit=65536).decode("utf-8")
        return source.read(name, optional=optional, limit=65536).decode("utf-8")

    soul = instruction("SOUL.md")
    role = instruction("AGENTS.md", optional=True)
    persona = _redact(soul + ("\n\n## Role\n\n" + role if role.strip() else ""))
    if len(persona.encode()) > 65536:
        raise ImportRefused("Combined persona exceeds definition byte limit")
    memory, filtered = _memory(source)
    files = {"profile/SOUL.md": persona.encode(),
             "profile/config.yaml": yaml.safe_dump(local_config, allow_unicode=True).encode(),
             "memory.json": _json(memory)}
    executable: set[str] = set()
    allowed = {_resolve_link(Path(p)) for p in allow_skill_links}
    shipped: list[dict[str, str]] = []
    skills = _skills(source, allowed, files, executable, shipped)
    cloud_skill_blockers = []
    for skill in skills:
        prefix = f"profile/skills/{skill['name']}/"
        entries = [(name.removeprefix(prefix), raw) for name, raw in files.items() if name.startswith(prefix)]
        reasons = []
        if len(entries) > BUNDLE_MAX_FILES or sum(len(raw) for _, raw in entries) > BUNDLE_MAX_BYTES:
            reasons.append("bundle_size")
        try:
            for name, _ in entries:
                validate_bundle_path(name)
        except SkillBundleError:
            reasons.append("bundle_path")
        if reasons:
            cloud_skill_blockers.append({"name": skill["name"], "reasons": reasons})
    for target, name in (("memory", "MEMORY.md"), ("user", "USER.md")):
        files[f"profile/memories/{name}"] = ENTRY_DELIMITER.join(memory[target]).encode()
    jobs, job_report = _jobs(source, room, files, executable)
    files["profile/cron/jobs.json"] = _json({"jobs": jobs})
    files["definition.json"] = _json({"schema_version": 1, "soul": persona,
                                     "model_alias": model_alias, "reasoning": None, "skills": skills})
    manifest = {
        "schema_version": 1, "rehearsal_only": True, "source": str(root), "room": room,
        "model": local_config["model"], "definition_model_alias": model_alias,
        "allow_skill_links": sorted(map(str, allowed)),
        "allow_instruction_links": sorted(map(str, instruction_links)),
        "skills": skills, "shipped": shipped, "jobs": job_report, "filtered_memory_entries": filtered,
        "cloud_skill_blockers": cloud_skill_blockers,
        "omitted_config": omitted,
        "plugin_directories": sorted(p.name for p in (root / "plugins").iterdir()) if (root / "plugins").is_dir() else [],
        "inputs": source.inputs,
        "files": [{"path": name, "sha256": _hash(raw), "bytes": len(raw), "executable": name in executable}
                  for name, raw in sorted(files.items())],
    }
    manifest["sha256"] = _hash(_json(manifest))
    return Rehearsal(manifest, files, executable)


def stage_profile(source: Path, destination: Path, room: str, *, expected_sha256: str,
                  model_alias: str = "binh-minh", allow_skill_links: tuple[Path, ...] = (),
                  allow_instruction_links: tuple[Path, ...] = ()) -> dict:
    """Publish a complete fresh rehearsal; never merge into an existing directory."""
    destination = Path(destination).absolute()
    root = Path(source).resolve(strict=True)
    if destination.exists() or destination.is_symlink():
        raise ImportRefused("Destination already exists")
    if not destination.parent.is_dir() or destination.parent.resolve().is_relative_to(root):
        raise ImportRefused("Destination must have an existing parent outside the source")
    options = {"model_alias": model_alias, "allow_skill_links": allow_skill_links,
               "allow_instruction_links": allow_instruction_links}
    plan = inspect_profile(source, room, **options)
    if plan.manifest["sha256"] != expected_sha256:
        raise ImportRefused("Source or options changed since inspection")
    # A local private staging directory is removed on failure; no user data lives in it.
    with tempfile.TemporaryDirectory(prefix=".atum-import-", dir=destination.parent) as temporary:
        stage = Path(temporary) / "rehearsal"
        stage.mkdir(mode=0o700)
        for relative, raw in plan.files.items():
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            target.chmod(0o700 if relative in plan.executable else 0o600)
        for skill in plan.manifest["skills"]:
            if _skill_tree_hash(stage / "profile/skills" / skill["name"]) != skill["sha256"]:
                raise ImportRefused("Staged skill hash does not match")
        fresh = inspect_profile(source, room, **options)
        if fresh.manifest != plan.manifest:
            raise ImportRefused("Source changed during rehearsal")
        manifest_path = stage / "manifest.json"
        manifest_path.write_bytes(_json(plan.manifest))
        manifest_path.chmod(0o600)
        # Reserve with mkdir rather than rename-overwrite: even an empty pre-existing
        # destination belongs to the user. The complete payload moves into our reservation.
        destination.mkdir(mode=0o700)
        try:
            stage.rename(destination / "prepared")
        except BaseException:
            destination.rmdir()  # our empty reservation only; refuses if another writer used it
            raise
    return plan.manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("inspect", "stage"))
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--room", required=True)
    parser.add_argument("--model-alias", choices=sorted(MODEL_ALIASES), default="binh-minh")
    parser.add_argument("--allow-skill-link", action="append", type=Path, default=[])
    parser.add_argument("--allow-instruction-link", action="append", type=Path, default=[])
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--expected-sha256")
    args = parser.parse_args(argv)
    options = {"model_alias": args.model_alias, "allow_skill_links": tuple(args.allow_skill_link),
               "allow_instruction_links": tuple(args.allow_instruction_link)}
    try:
        if args.operation == "stage":
            if args.destination is None or not args.expected_sha256:
                parser.error("stage requires --destination and --expected-sha256")
            result = stage_profile(args.source, args.destination, args.room,
                                   expected_sha256=args.expected_sha256, **options)
        else:
            result = inspect_profile(args.source, args.room, **options).manifest
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (ImportRefused, OSError, ValueError) as exc:
        # Never echo parser input or file contents (YAML and Unicode exceptions do).
        print(json.dumps({"error": str(exc) if isinstance(exc, ImportRefused) else "Invalid or unreadable profile artifact"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
