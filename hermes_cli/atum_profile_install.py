"""Native Atum import of an explicitly selected offline rehearsal.

The Electron lifecycle owns accounts, grants, enrollment and stopping runtimes.
This helper only validates a frozen payload or installs it into a NEW home. It
never reads the original profile, opens credentials, starts Hermes or runs jobs.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import tempfile

from hermes_cli.atum_portability import _validate_definition
from hermes_cli.atum_profile_import import (
    ImportRefused, MAX_FILES, Rehearsal, _Source, _hash, _jobs, _json,
    _local_config, _mapping, _relative,
)
from hermes_cli.atum_skill_bundles import validate_skill_bundle

RECEIPT = ".atum-profile-import.json"
_FIXED = {
    "definition.json", "memory.json", "profile/SOUL.md", "profile/config.yaml",
    "profile/memories/MEMORY.md", "profile/memories/USER.md", "profile/cron/jobs.json",
}


def read_prepared(prepared: Path, expected_sha256: str | None = None, *,
                  bundled_dir: Path | None = None) -> Rehearsal:
    prepared = Path(prepared).absolute()
    if prepared.is_symlink() or not prepared.is_dir():
        raise ImportRefused("Select a regular prepared directory")
    source = _Source(prepared)
    manifest = json.loads(source.read("manifest.json", limit=4 * 1024 * 1024))
    if not isinstance(manifest, dict):
        raise ImportRefused("Invalid import manifest")
    digest = manifest.get("sha256")
    unsigned = {key: value for key, value in manifest.items() if key != "sha256"}
    if (manifest.get("schema_version") != 1 or manifest.get("rehearsal_only") is not True
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or _hash(_json(unsigned)) != digest
            or (expected_sha256 is not None and digest != expected_sha256)):
        raise ImportRefused("Prepared profile changed since selection")
    rows = manifest.get("files")
    if not isinstance(rows, list) or len(rows) > MAX_FILES:
        raise ImportRefused("Invalid import file inventory")
    files: dict[str, bytes] = {}
    executable: set[str] = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("path"), str):
            raise ImportRefused("Invalid import file record")
        name = _relative(row["path"])
        if (name in files or (name not in _FIXED and not name.startswith(("profile/skills/", "profile/scripts/")))
                or type(row.get("executable")) is not bool):
            raise ImportRefused("Unexpected import artifact")
        raw = source.read(name)
        if len(raw) != row.get("bytes") or _hash(raw) != row.get("sha256"):
            raise ImportRefused("Prepared file does not match its manifest")
        files[name] = raw
        if row["executable"]:
            executable.add(name)
    if not _FIXED.issubset(files):
        raise ImportRefused("Incomplete prepared profile")
    # No unrecorded code, credentials or symlinks can hitch a ride in a selection.
    actual: set[str] = set()
    for base, dirs, names in os.walk(prepared, followlinks=False):
        for name in dirs + names:
            item = Path(base) / name
            if item.is_symlink():
                raise ImportRefused("Prepared profile may not contain symlinks")
        actual.update((Path(base) / name).relative_to(prepared).as_posix() for name in names)
    if actual != set(files) | {"manifest.json"}:
        raise ImportRefused("Prepared profile contains unrecorded files")
    definition = _validate_definition(json.loads(files["definition.json"]))
    if files["profile/SOUL.md"].decode() != definition["soul"]:
        raise ImportRefused("Local persona differs from the portable definition")
    config = _mapping(files["profile/config.yaml"], "prepared config")
    selected, omitted = _local_config(config)
    if omitted or selected != config:
        raise ImportRefused("Prepared configuration contains unapproved fields")
    plan = Rehearsal(manifest, files, executable)
    # Use the existing bundle contract, including content digest and bounded paths.
    payload(plan, bundled_dir=bundled_dir)
    return plan


def _shipped(plan: Rehearsal) -> list[dict[str, str]]:
    """Validate provenance records; old rehearsals legitimately have none."""
    rows = plan.manifest.get("shipped", [])
    names = {skill.get("name") for skill in plan.manifest.get("skills", []) if isinstance(skill, dict)}
    if (not isinstance(rows, list) or len(rows) > 512
            or any(not isinstance(row, dict) or set(row) != {"name", "skill"}
                   or not all(isinstance(row[key], str) and row[key] for key in ("name", "skill"))
                   or row["name"] not in names for row in rows)
            or len({row["name"] for row in rows}) != len(rows)):
        raise ImportRefused("Invalid shipped skill record")
    return rows


def left_to_seeding(plan: Rehearsal, bundled_dir: Path | None = None) -> set[str]:
    """Return source-pristine packages the destination runtime itself ships."""
    rows = _shipped(plan)
    if not rows:
        return set()
    from tools.skills_sync import _discover_bundled_skills, _get_bundled_dir

    destination_names = {
        skill_name for skill_name, _ in _discover_bundled_skills(
            bundled_dir if bundled_dir is not None else _get_bundled_dir())
    }
    return {row["name"] for row in rows if row["skill"] in destination_names}


def _in_packages(name: str, packages: set[str]) -> bool:
    return any(name.startswith(f"profile/skills/{package}/") for package in packages)


def payload(plan: Rehearsal, *, bundled_dir: Path | None = None) -> dict:
    definition = _validate_definition(json.loads(plan.files["definition.json"]))
    left = left_to_seeding(plan, bundled_dir)
    if left:
        definition = _validate_definition({
            **definition,
            "skills": [skill for skill in definition["skills"] if skill["name"] not in left],
        })
    bundles = []
    claimed: set[str] = set()
    for skill in definition["skills"]:
        prefix = f"profile/skills/{skill['name']}/"
        entries = [(name, raw) for name, raw in plan.files.items() if name.startswith(prefix)]
        if any(name in claimed for name, _ in entries):
            raise ImportRefused("Overlapping skill packages")
        claimed.update(name for name, _ in entries)
        bundles.append(validate_skill_bundle({
            "schema_version": 1, "sha256": skill["sha256"],
            "files": [{"path": name.removeprefix(prefix), "content_base64": base64.b64encode(raw).decode()}
                      for name, raw in sorted(entries, key=lambda entry: entry[0].encode())],
        }))
    if claimed != {
        name for name in plan.files
        if name.startswith("profile/skills/") and not _in_packages(name, left)
    }:
        raise ImportRefused("Unreferenced skill files")
    return {"sha256": plan.manifest["sha256"], "definition": definition, "bundles": bundles}


def install_prepared(prepared: Path, destination: Path, room: str, *, expected_sha256: str,
                     bundled_dir: Path | None = None) -> dict:
    if not re.fullmatch(r"![^\s:]+:[^\s]+", room) or len(room) > 1024 or room.endswith(":atum.invalid"):
        raise ImportRefused("A real enrolled Matrix room is required")
    destination = Path(destination).absolute()
    receipt = {"schema_version": 1, "sha256": expected_sha256, "room": room}
    if destination.is_symlink():
        raise ImportRefused("Destination must not be a symlink")
    if destination.exists():
        # Only acknowledge our exact completed installation; never overwrite a home.
        existing = _Source(destination).read(RECEIPT, limit=4096, optional=True)
        if existing and json.loads(existing) == receipt:
            return {"status": "installed", **receipt}
        raise ImportRefused("Destination already exists without this import receipt")
    plan = read_prepared(prepared, expected_sha256, bundled_dir=bundled_dir)
    if not destination.parent.is_dir() or destination.parent.resolve().is_relative_to(Path(prepared).resolve()):
        raise ImportRefused("Destination must have an existing parent outside the prepared profile")
    # Reuse Hermes's import projection to remove all claims and bind delivery to
    # this enrolled room, never the rehearsal's placeholder room.
    jobs, _ = _jobs(_Source(Path(prepared) / "profile"), room, {}, set())
    left = left_to_seeding(plan, bundled_dir)
    files = {
        name.removeprefix("profile/"): raw for name, raw in plan.files.items()
        if name.startswith("profile/") and not _in_packages(name, left)
    }
    files["cron/jobs.json"] = _json({"jobs": jobs})
    files[RECEIPT] = _json(receipt)
    with tempfile.TemporaryDirectory(prefix=".atum-install-", dir=destination.parent) as temporary:
        stage = Path(temporary) / "home"
        stage.mkdir(mode=0o700)
        for name, raw in files.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            target.chmod(0o700 if f"profile/{name}" in plan.executable else 0o600)
        # Freeze the source revision across the read and job rebinding.
        read_prepared(prepared, expected_sha256, bundled_dir=bundled_dir)
        destination.mkdir(mode=0o700)  # exclusive reservation; existing data is never replaced
        try:
            stage.rename(destination)  # replaces only our empty reservation
        except BaseException:
            destination.rmdir()  # only the empty directory we just reserved
            raise
    return {"status": "installed", **receipt}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("payload", "install"))
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--expected-sha256")
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--room")
    args = parser.parse_args(argv)
    try:
        if args.operation == "payload":
            result = payload(read_prepared(args.prepared, args.expected_sha256))
        else:
            if not args.expected_sha256 or args.destination is None or args.room is None:
                parser.error("install requires --expected-sha256, --destination and --room")
            result = install_prepared(args.prepared, args.destination, args.room, expected_sha256=args.expected_sha256)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, OSError, TypeError, KeyError):
        # Native UI translates a failure code. Never echo config, persona or parser input.
        print(json.dumps({"error": "matrix_profile_import_invalid"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
