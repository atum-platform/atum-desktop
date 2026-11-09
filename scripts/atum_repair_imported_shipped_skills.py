#!/usr/bin/env python3
"""Repair provenance for pristine bundled skills in imported Atum homes.

This is deliberately narrower than profile import or amendment.  A prior
import could copy a source runtime's bundled skill into a destination home
without adding it to the destination's ``.bundled_manifest``.  Hermes then
correctly treats that copy as local and cannot update it.

The default mode is read-only.  ``--apply`` records only a verified origin
hash under Hermes's existing bundled-skills writer lock; it never changes a
skill file.  The next normal bundled seeding performs any update.  A copy that
does not exactly match the source origin remains local content.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


RECEIPT = ".atum-profile-import.json"
MANIFEST = ".bundled_manifest"
SOURCE_MANIFEST = "skills/.bundled_manifest"
_SHA256 = re.compile(r"[a-f0-9]{64}")


def _canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def _load_runtime(runtime: Path):
    """Import skill syncing from the exact runtime that will consume the repair."""
    runtime = Path(runtime).resolve()
    if not (runtime / "tools" / "skills_sync.py").is_file():
        raise SystemExit(json.dumps({"error": "runtime_not_found"}))
    if str(runtime) not in sys.path:
        sys.path.insert(0, str(runtime))
    import tools.skills_sync as sync

    if Path(sync.__file__).resolve().parent.parent != runtime:
        raise SystemExit(json.dumps({"error": "runtime_mismatch"}))
    return sync


def _read_json(path: Path, limit: int = 4 * 1024 * 1024) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError(path.name)
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(path.name)
    return value


def _prepared_manifest(path: Path) -> dict[str, Any]:
    value = _read_json(path)
    digest = value.get("sha256")
    unsigned = {key: item for key, item in value.items() if key != "sha256"}
    if (
        value.get("schema_version") != 1
        or value.get("rehearsal_only") is not True
        or not isinstance(digest, str)
        or not _SHA256.fullmatch(digest)
        or hashlib.sha256(_canonical_json(unsigned)).hexdigest() != digest
    ):
        raise ValueError("prepared_manifest")
    inputs = value.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("prepared_inputs")
    source_manifest_hash = inputs.get(SOURCE_MANIFEST)
    if not isinstance(source_manifest_hash, str) or not _SHA256.fullmatch(source_manifest_hash):
        # A preparation without a v2 bundled-manifest input cannot establish
        # provenance for an installed copy.  It is not safe to infer it.
        raise ValueError("prepared_provenance_absent")
    source = value.get("source")
    if not isinstance(source, str) or not source:
        raise ValueError("prepared_source")
    return {
        "sha256": digest,
        "source": source,
        "source_manifest_sha256": source_manifest_hash,
        "prepared": str(path.parent),
    }


def prepared_sources(roots: list[Path]) -> dict[str, dict[str, str]]:
    """Map a completed import receipt digest to its validated preparation."""
    found: dict[str, dict[str, str]] = {}
    for root in roots:
        for manifest in sorted(Path(root).glob("*/prepared/manifest.json")):
            try:
                prepared = _prepared_manifest(manifest)
            except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            # Two sources for one receipt are ambiguous, even if their content
            # happens to agree. Leave the home unmatched rather than guessing.
            digest = prepared["sha256"]
            if digest in found and found[digest] != prepared:
                found.pop(digest)
                continue
            found[digest] = prepared
    return found


def imported_homes(root: Path) -> list[Path]:
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise SystemExit(json.dumps({"error": "homes_not_found"}))
    return sorted(
        home for home in root.iterdir()
        if home.is_dir() and not home.is_symlink()
        and (home / RECEIPT).is_file() and not (home / RECEIPT).is_symlink()
    )


def _receipt_digest(home: Path) -> str:
    value = _read_json(home / RECEIPT, limit=4096)
    digest = value.get("sha256")
    if value.get("schema_version") != 1 or not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        raise ValueError("receipt")
    return digest


def _source_origins(sync, prepared: dict[str, str]) -> dict[str, str]:
    """Read only the source provenance record and require its frozen hash."""
    source = Path(prepared["source"])
    path = source / SOURCE_MANIFEST
    if source.is_symlink() or not source.is_dir() or path.is_symlink() or not path.is_file():
        raise ValueError("source_missing")
    before = path.stat()
    if before.st_size > 1024 * 1024:
        raise ValueError("source_manifest_invalid")
    raw = path.read_bytes()
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("source_changed")
    if hashlib.sha256(raw).hexdigest() != prepared["source_manifest_sha256"]:
        raise ValueError("source_changed")
    return {name: digest for name, digest in sync._read_manifest(path).items() if digest}


def _local_paths(sync, skills: Path) -> dict[str, list[str]]:
    """Skill name to local paths, for reporting only; no bodies are read."""
    from agent.skill_utils import is_excluded_skill_path

    names: dict[str, list[str]] = {}
    if skills.is_dir() and not skills.is_symlink():
        for skill_md in sorted(skills.rglob("SKILL.md")):
            if skill_md.is_symlink() or is_excluded_skill_path(skill_md.relative_to(skills)):
                continue
            name = sync.read_skill_name(skill_md, skill_md.parent.name)
            names.setdefault(name, []).append(skill_md.parent.relative_to(skills).as_posix())
    return names


def inspect_home(sync, home: Path, prepared: dict[str, str], bundled_dir: Path) -> dict[str, Any]:
    """Classify a home without mutation, refusing changed source provenance."""
    origins = _source_origins(sync, prepared)
    skills = home / "skills"
    recorded = sync._read_manifest(skills / MANIFEST)
    shipped = sync._discover_bundled_skills(bundled_dir)
    local = _local_paths(sync, skills)
    result: dict[str, Any] = {
        "shipped_here": len(shipped), "recorded_here": len(recorded), "repair": {}, "current": [],
        "kept": {"differs": [], "untracked": [], "not_a_directory": []}, "elsewhere": [],
    }
    for skill_name, bundled in sorted(shipped, key=lambda item: item[0]):
        if skill_name in recorded:
            continue
        destination = sync._compute_relative_dest(bundled, bundled_dir, skills)
        path = destination.relative_to(skills).as_posix()
        if not os.path.lexists(destination):
            elsewhere = [item for item in local.get(skill_name, []) if item != path]
            if elsewhere:
                result["elsewhere"].append({"skill": skill_name, "shipped_at": path, "found_at": elsewhere})
            continue
        if destination.is_symlink() or not destination.is_dir():
            result["kept"]["not_a_directory"].append(skill_name)
            continue
        current = sync.dir_hash(destination)
        if current == sync.dir_hash(bundled):
            result["current"].append(skill_name)
        elif skill_name not in origins:
            result["kept"]["untracked"].append(skill_name)
        elif current == origins[skill_name]:
            result["repair"][skill_name] = origins[skill_name]
        else:
            result["kept"]["differs"].append(skill_name)
    return result


def apply_home(sync, home: Path, prepared: dict[str, str], bundled_dir: Path) -> dict[str, Any]:
    """Recheck receipt and source provenance before atomically recording origins."""
    manifest = home / "skills" / MANIFEST
    with sync._bundled_skills_write_lock(home, home / "skills"):
        if _receipt_digest(home) != prepared["sha256"]:
            raise ValueError("receipt_changed")
        result = inspect_home(sync, home, prepared, bundled_dir)
        if result["repair"]:
            entries = sync._read_manifest(manifest)
            entries.update(result["repair"])
            if not sync._write_manifest(entries, manifest):
                raise OSError("manifest_not_written")
            written = sync._read_manifest(manifest)
            if any(written.get(name) != digest for name, digest in result["repair"].items()):
                raise OSError("manifest_not_confirmed")
    return result


def run(runtime: Path, homes: Path, prepared: list[Path], apply: bool = False) -> tuple[dict[str, Any], bool]:
    sync = _load_runtime(runtime)
    bundled_dir = sync._get_bundled_dir()
    sources = prepared_sources(prepared)
    report: dict[str, Any] = {
        "mode": "apply" if apply else "dry-run", "runtime": str(Path(runtime).resolve()),
        "bundled": str(bundled_dir), "homes": [], "unmatched": [],
    }
    ok = True
    for home in imported_homes(homes):
        try:
            digest = _receipt_digest(home)
            match = sources[digest]
        except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
            report["unmatched"].append({"home": home.name, "reason": "no_valid_preparation_for_receipt"})
            ok = False
            continue
        row: dict[str, Any] = {"home": home.name, "profile": Path(match["source"]).name, "receipt": digest}
        try:
            result = (
                apply_home(sync, home, match, bundled_dir)
                if apply else inspect_home(sync, home, match, bundled_dir)
            )
            row.update(result)
            row["applied"] = apply
        except (OSError, TimeoutError, ValueError) as exc:
            row.update({"applied": False, "error": str(exc)[:200] or type(exc).__name__})
            ok = False
        report["homes"].append(row)
    report["totals"] = {
        "homes": len(report["homes"]),
        "repair": sum(len(row.get("repair", {})) for row in report["homes"]),
        "current": sum(len(row.get("current", [])) for row in report["homes"]),
        "kept": sum(sum(len(value) for value in row.get("kept", {}).values()) for row in report["homes"]),
        "elsewhere": sum(len(row.get("elsewhere", [])) for row in report["homes"]),
    }
    return report, ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--homes", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, action="append", required=True)
    parser.add_argument("--apply", action="store_true", help="record verified origins; default is read-only")
    args = parser.parse_args(argv)
    os.environ.setdefault("HERMES_HOME", str(args.homes))
    report, ok = run(args.runtime, args.homes, args.prepared, apply=args.apply)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
