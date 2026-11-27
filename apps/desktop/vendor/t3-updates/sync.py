#!/usr/bin/env python3
"""Verify or regenerate the pinned update sources from a local Work checkout."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent


def git(repo, *args):
    return subprocess.check_output(["git", "-C", repo, *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("work_checkout", type=Path)
    parser.add_argument("--write", action="store_true", help="restore missing files; refuse changed files")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text())
    pin = manifest["pin"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin):
        raise SystemExit("Expected an immutable Work commit")
    pending = []
    with tempfile.TemporaryDirectory(prefix="atum-updates-sync-") as scratch:
        for entry in manifest["files"]:
            key = f"{pin}:{unquote(entry['source'])}"
            if git(args.work_checkout, "rev-parse", key).decode().strip() != entry["blob"]:
                raise SystemExit(f"Work blob differs from pin for {entry['source']}")
            contents = git(args.work_checkout, "show", key)
            changes = entry.get("changes", [])
            if changes:
                lines = contents.decode().splitlines(keepends=True)
                for start, end, replacement in reversed(changes):
                    lines[start:end] = replacement
                contents = "".join(lines).encode()
            if digest(contents) != entry["sha256"]:
                raise SystemExit(f"Overlay differs for {entry['destination']}")
            sample = Path(scratch) / entry["destination"]
            sample.parent.mkdir(parents=True, exist_ok=True)
            sample.write_bytes(contents)
            target = ROOT / entry["destination"]
            if target.is_file() and target.read_bytes() != contents:
                raise SystemExit(f"Refusing to overwrite changed vendor file {entry['destination']}")
            if not target.is_file():
                pending.append((sample, target))
        if pending and not args.write:
            raise SystemExit(f"Missing {len(pending)} vendored files (run again with --write)")
        for sample, target in pending:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(sample.read_bytes())
    print(f"Verified {len(manifest['files'])} updater files at {pin}")


if __name__ == "__main__":
    main()
