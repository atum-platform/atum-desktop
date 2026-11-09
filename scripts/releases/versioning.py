"""Public local build identity utilities; release orchestration is excluded."""

from __future__ import annotations

import json

import re

import subprocess

from functools import cmp_to_key

from typing import Any

from hermes_cli.update_channel import STABLE_TAG_RE

from scripts.releases.semver import compare

SEED = "0.21.5"

BUMPS = ("major", "minor", "patch")

def version_from_tag(ref: str) -> str | None:
    """The version a final release tag names, or None for anything else.

    ``-rc`` claims, build-metadata identities and non-``v`` receipt namespaces
    are not final tags, and a 4-digit major is a CalVer label.
    """
    if not isinstance(ref, str) or not STABLE_TAG_RE.fullmatch(ref):
        return None
    return ref[1:]

def tag_record(raw: str) -> Any:
    """Decode the JSON record an annotated release tag carries.

    ``git tag -l --format=%(contents)`` returns the whole message, and git keeps
    a signature *inside* the message body: a signed tag reads as the record
    followed by an armored signature block. The record is everything before the
    armor, so every reader parses through here, never ``json.loads(raw)``.

    Detached signatures (``git tag --detach-sign``) live outside the message and
    leave this unchanged, as does an unsigned tag.
    """
    return json.loads(raw.split("\n-----BEGIN ", 1)[0])

_ATTEMPT_REF_RE = re.compile(r"rc\.(?P<attempt>[1-9][0-9]*)-(?P<tag>v[^/]+)")

_MARKER_PREFIX = "abandoned-"

def parse_attempt_ref(ref: str) -> tuple[str, int] | None:
    """``rc.<N>-vX.Y.Z`` to ``(version, N)``, or None for anything else.

    The attempt comes first so the ref can never read as a SemVer prerelease
    of the version it claims.
    """
    match = _ATTEMPT_REF_RE.fullmatch(ref) if isinstance(ref, str) else None
    if match is None:
        return None
    version = version_from_tag(match.group("tag"))
    return (version, int(match.group("attempt"))) if version else None

def parse_marker_ref(ref: str) -> tuple[str, int] | None:
    """``abandoned-rc.<N>-vX.Y.Z``, the record that clears one attempt."""
    if not isinstance(ref, str) or not ref.startswith(_MARKER_PREFIX):
        return None
    return parse_attempt_ref(ref[len(_MARKER_PREFIX):])

def attempt_ref(version: str, attempt: int) -> str:
    ref = f"rc.{attempt}-v{version}"
    if parse_attempt_ref(ref) != (version, attempt):
        raise ValueError(f"invalid attempt ref: {version!r} attempt {attempt!r}")
    return ref

def marker_ref(version: str, attempt: int) -> str:
    return _MARKER_PREFIX + attempt_ref(version, attempt)
