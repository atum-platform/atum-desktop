"""Atum identity metadata layered on Hermes's native profile directory.

This owns only the product fields in ``profile.yaml``. Profile lifecycle,
configuration, clone routing and canonical gateway ownership remain upstream.
"""

from __future__ import annotations

import contextlib
import hashlib
import re
import threading
import uuid
from pathlib import Path

_IDENTITY = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_LOCKS: dict[str, threading.local] = {}
_LOCKS_GUARD = threading.Lock()
_PROFILE_META_LOCK_TIMEOUT_SECONDS = 10.0


def _holder(path: Path) -> threading.local:
    key = str(path.resolve(strict=False))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.local())


@contextlib.contextmanager
def profile_meta_lock(profile_dir: Path):
    from hermes_cli.auth import _file_lock
    lock_path = profile_dir / ".profile.yaml.lock"
    with _file_lock(lock_path, _holder(lock_path), _PROFILE_META_LOCK_TIMEOUT_SECONDS,
                    f"Timed out waiting for profile metadata lock: {lock_path}"):
        yield


def _raw(profile_dir: Path) -> dict:
    import hermes_yaml as yaml
    path = profile_dir / "profile.yaml"
    if not path.is_file():
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}
    except (yaml.YAMLError, OSError, UnicodeError) as exc:
        raise ValueError(f"profile metadata is unreadable: {path}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"profile metadata must be a mapping: {path}")
    return data


def _write(profile_dir: Path, data: dict) -> None:
    from utils import atomic_yaml_write
    atomic_yaml_write(profile_dir / "profile.yaml", data, sort_keys=False)


def clean_identity(value) -> str:
    text = str(value or "").strip().lower()
    return text if _IDENTITY.fullmatch(text) else ""


def assign_profile_identity(profile_dir: Path, *, regenerate: bool = False) -> str:
    if not profile_dir.is_dir():
        raise FileNotFoundError(f"profile directory does not exist: {profile_dir}")
    if not regenerate:
        current = clean_identity(_raw(profile_dir).get("identity_id"))
        if current:
            return current
    with profile_meta_lock(profile_dir):
        data = _raw(profile_dir)
        current = clean_identity(data.get("identity_id"))
        if current and not regenerate:
            return current
        current = str(uuid.uuid4())
        data["identity_id"] = current
        data["lifecycle_revision"] = 1
        # A clone cannot inherit the source identity's persona approval.
        data.pop("shared_persona_approval", None)
        _write(profile_dir, data)
        return current


def adopt_profile_identity(profile_dir: Path, identity_id: str) -> str:
    from hermes_cli.profiles import _get_default_hermes_home
    if profile_dir.resolve() != _get_default_hermes_home().resolve():
        raise ValueError("only the default profile adopts an identity from the plane")
    cleaned = clean_identity(identity_id)
    if not cleaned:
        raise ValueError("invalid identity_id")
    with profile_meta_lock(profile_dir):
        data = _raw(profile_dir)
        if clean_identity(data.get("identity_id")) == cleaned:
            return cleaned
        data["identity_id"] = cleaned
        data["lifecycle_revision"] = max(0, int(data.get("lifecycle_revision") or 0)) + 1
        data.pop("shared_persona_approval", None)
        _write(profile_dir, data)
    return cleaned


def _snapshot(profile_dir: Path, data: dict) -> dict:
    identity = clean_identity(data.get("identity_id"))
    if not identity:
        identity = str(uuid.uuid4())
        data["identity_id"] = identity
        data["lifecycle_revision"] = 1
    raw = (profile_dir / "SOUL.md").read_bytes()
    if len(raw) > 64 * 1024:
        raise ValueError("SOUL.md is too large to approve")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("SOUL.md must be UTF-8 text") from exc
    digest = hashlib.sha256(raw).hexdigest()
    approval = data.get("shared_persona_approval")
    valid = (approval if isinstance(approval, dict)
             and clean_identity(approval.get("identity_id")) == identity
             and _SHA256.fullmatch(str(approval.get("digest") or "")) else None)
    return {"content": content, "digest": digest, "identity_id": identity,
            "approval": valid, "approved": bool(valid and valid["digest"] == digest)}


def read_shared_persona(profile_dir: Path) -> dict:
    with profile_meta_lock(profile_dir):
        data = _raw(profile_dir)
        had_identity = bool(clean_identity(data.get("identity_id")))
        result = _snapshot(profile_dir, data)
        if not had_identity:
            _write(profile_dir, data)
        return result


def approve_shared_persona(profile_dir: Path, expected_digest: str) -> dict:
    if not _SHA256.fullmatch(str(expected_digest or "")):
        raise ValueError("expected_digest must be a SHA-256 digest")
    with profile_meta_lock(profile_dir):
        data = _raw(profile_dir)
        result = _snapshot(profile_dir, data)
        if result["digest"] != expected_digest:
            raise ValueError("SOUL.md changed; refresh before approving")
        previous = data.get("shared_persona_approval")
        revision = max(0, int(previous.get("revision") or 0)) + 1 if isinstance(previous, dict) else 1
        approval = {"digest": result["digest"], "revision": revision,
                    "identity_id": result["identity_id"]}
        data["shared_persona_approval"] = approval
        _write(profile_dir, data)
        return {**result, "approval": approval, "approved": True}


def revoke_shared_persona_approval(profile_dir: Path) -> int:
    with profile_meta_lock(profile_dir):
        data = _raw(profile_dir)
        identity = clean_identity(data.get("identity_id")) or str(uuid.uuid4())
        data.setdefault("identity_id", identity)
        data.setdefault("lifecycle_revision", 1)
        previous = data.get("shared_persona_approval")
        revision = max(0, int(previous.get("revision") or 0)) + 1 if isinstance(previous, dict) else 1
        data["shared_persona_approval"] = {"digest": "", "revision": revision, "identity_id": identity}
        _write(profile_dir, data)
        return revision
