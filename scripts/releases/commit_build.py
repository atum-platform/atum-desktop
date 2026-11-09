"""Public local build identity utilities; release orchestration is excluded."""

from __future__ import annotations

import json

import os

import re

import shlex

import subprocess

import tomllib

from datetime import datetime, timezone, UTC

from pathlib import Path

def require_commit(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("Commit builds require an exact full 40-character SHA")
    return value

def output(argv: list[str], repo: Path | None = None) -> str:
    return subprocess.check_output(argv, cwd=repo, text=True, encoding="utf-8", timeout=60).strip()

def version_at(repo: Path | None, commit: str, *, run=output) -> str:
    require_commit(commit)
    document = tomllib.loads(run(["git", "show", f"{commit}:pyproject.toml"], repo))
    version = document["project"]["version"]
    if not isinstance(version, str) or not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise ValueError("Commit packaging requires project.version=X.Y.Z")
    return version
