"""Validated, owner-private skill content bundles for Atum sync.

The transport stores a skill's immutable bytes by the same tree digest used by
``atum_portability``.  This module only turns a local skill directory into that
small wire representation, and installs a verified representation in an
account-local cache.  Profile materialization remains the caller's job.
"""

from __future__ import annotations

import base64
import ctypes
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

from hermes_cli.atum_portability import UnsupportedLocalDefinition, _skill_tree_hash, _unsafe_portable_path_component


SCHEMA_VERSION = 1
MAX_RAW_BYTES = 2 * 1024 * 1024
MAX_JSON_BYTES = 3 * 1024 * 1024
MAX_FILES = 512
MAX_PATH_LENGTH = 300
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


class SkillBundleError(ValueError):
    """A received skill bundle is malformed or cannot be safely installed."""


class PublicationUnsupported(OSError):
    """This filesystem cannot move a directory into place without replacing."""


_RENAME_EXCL = 0x4  # macOS <sys/stdio.h>
_RENAME_NOREPLACE = 0x1  # Linux <linux/fs.h>
_AT_FDCWD = -100
_UNSUPPORTED_RENAME = {errno.EINVAL, errno.ENOSYS, getattr(errno, "ENOTSUP", errno.EINVAL), errno.EOPNOTSUPP}
_exclusive_rename = None


def _exclusive_rename_function():
    """The kernel's exclusive rename, or ``None`` where it does not exist."""
    global _exclusive_rename
    if _exclusive_rename is None:
        function = False
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            if sys.platform == "darwin":
                function = libc.renamex_np
                function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            elif sys.platform.startswith("linux"):
                function = libc.renameat2
                function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            if function:
                function.restype = ctypes.c_int
        except (AttributeError, OSError):
            function = False
        _exclusive_rename = function
    return _exclusive_rename or None


def rename_no_replace(source: Path, destination: Path) -> None:
    """Move *source* to *destination* atomically, never replacing what is there.

    ``os.rename`` silently replaces an empty destination directory on POSIX,
    and checking for absence first leaves a window for a racing writer.  The
    kernel's exclusive rename is the one publication that cannot clobber
    anything: it fails with ``FileExistsError`` if *destination* exists, even
    as an empty directory.  A filesystem without it raises
    :class:`PublicationUnsupported` rather than falling back to a replace.
    """
    if sys.platform == "win32":
        os.rename(source, destination)  # never replaces an existing path on Windows
        return
    function = _exclusive_rename_function()
    if function is None:
        raise PublicationUnsupported(errno.ENOTSUP, "exclusive rename is unavailable", str(destination))
    old, new = os.fsencode(os.fspath(source)), os.fsencode(os.fspath(destination))
    result = (function(old, new, _RENAME_EXCL) if sys.platform == "darwin"
              else function(_AT_FDCWD, old, _AT_FDCWD, new, _RENAME_NOREPLACE))
    if result == 0:
        return
    code = ctypes.get_errno()
    if code == errno.EEXIST:
        raise FileExistsError(code, os.strerror(code), str(destination))
    if code in _UNSUPPORTED_RENAME:
        raise PublicationUnsupported(code, os.strerror(code), str(destination))
    raise OSError(code, os.strerror(code), str(destination))


def _validate_path(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_PATH_LENGTH
        or "\\" in value
        or any(ord(character) < 32 or 0x7f <= ord(character) <= 0x9f for character in value)
    ):
        raise SkillBundleError("skill bundle path must be a short relative POSIX path")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise SkillBundleError("skill bundle path must be valid UTF-8") from exc
    if len(encoded) > MAX_PATH_LENGTH:
        raise SkillBundleError("skill bundle path exceeds the UTF-8 byte limit")
    if b"\0" in encoded:
        raise SkillBundleError("skill bundle path may not contain NUL")

    parts = value.split("/")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} or _unsafe_portable_path_component(part) for part in parts):
        raise SkillBundleError("skill bundle path must be a relative POSIX path")
    for part in parts:
        lower = part.lower()
        if lower in {".git", ".ssh", ".env", "auth.json", "credentials.json"} or lower.startswith(".env."):
            raise SkillBundleError("skill bundle contains an unsafe secret-bearing path")
        if lower.endswith((".pem", ".key")):
            raise SkillBundleError("skill bundle contains an unsafe secret-bearing path")
    return value


def _hash_entries(entries: list[tuple[str, bytes]]) -> str:
    digest = hashlib.sha256()
    for relative, raw in sorted(entries, key=lambda entry: entry[0].encode("utf-8")):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(raw)
        digest.update(b"\0")
    return digest.hexdigest()


def _read_skill_files(skill_dir: Path) -> list[tuple[str, bytes]]:
    skill_dir = Path(skill_dir)
    if skill_dir.is_symlink() or not skill_dir.is_dir():
        raise UnsupportedLocalDefinition("skill bundle source must be a regular directory")

    entries: list[tuple[str, bytes]] = []
    total = 0
    try:
        for root, directories, filenames in os.walk(skill_dir, followlinks=False):
            root_path = Path(root)
            for name in directories:
                directory_path = root_path / name
                if directory_path.is_symlink():
                    raise UnsupportedLocalDefinition("skill bundle source may not contain symlinks")
                _validate_path(directory_path.relative_to(skill_dir).as_posix())
            for name in filenames:
                file_path = root_path / name
                if file_path.is_symlink():
                    raise UnsupportedLocalDefinition("skill bundle source may not contain symlinks")
                if not stat.S_ISREG(file_path.stat().st_mode):
                    raise UnsupportedLocalDefinition("skill bundle source may only contain regular files")
                relative = _validate_path(file_path.relative_to(skill_dir).as_posix())
                raw = file_path.read_bytes()
                total += len(raw)
                if total > MAX_RAW_BYTES:
                    raise UnsupportedLocalDefinition("skill bundle source exceeds the 2 MiB limit")
                entries.append((relative, raw))
                if len(entries) > MAX_FILES:
                    raise UnsupportedLocalDefinition("skill bundle source contains more than 512 files")
    except OSError as exc:
        raise UnsupportedLocalDefinition("could not read skill bundle source") from exc
    except SkillBundleError as exc:
        raise UnsupportedLocalDefinition(str(exc)) from exc

    if "SKILL.md" not in {relative for relative, _ in entries}:
        raise UnsupportedLocalDefinition("skill bundle source must include root SKILL.md")
    return entries


def validate_skill_bundle(bundle: Any) -> dict[str, Any]:
    """Validate and return a canonical v1 skill bundle without touching disk."""
    if not isinstance(bundle, dict) or set(bundle) != {"schema_version", "sha256", "files"}:
        raise SkillBundleError("skill bundle must contain exactly schema_version, sha256, and files")
    if bundle.get("schema_version") != SCHEMA_VERSION:
        raise SkillBundleError("unsupported skill bundle schema")
    digest = bundle.get("sha256")
    if not isinstance(digest, str) or not _DIGEST_RE.fullmatch(digest):
        raise SkillBundleError("skill bundle sha256 must be 64 lowercase hexadecimal characters")
    files = bundle.get("files")
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise SkillBundleError("skill bundle has too many files")

    entries: list[tuple[str, bytes]] = []
    total = 0
    previous: bytes | None = None
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "content_base64"}:
            raise SkillBundleError("each skill bundle file must contain path and content_base64")
        relative = _validate_path(item.get("path"))
        encoded = item.get("content_base64")
        if not isinstance(encoded, str) or not encoded.isascii():
            raise SkillBundleError("skill bundle file content must be canonical base64")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, UnicodeEncodeError) as exc:
            raise SkillBundleError("skill bundle file content must be valid base64") from exc
        if base64.b64encode(raw).decode("ascii") != encoded:
            raise SkillBundleError("skill bundle file content must be canonical base64")
        path_bytes = relative.encode("utf-8")
        if previous is not None and path_bytes <= previous:
            raise SkillBundleError("skill bundle files must have unique canonical path order")
        previous = path_bytes
        total += len(raw)
        if total > MAX_RAW_BYTES:
            raise SkillBundleError("skill bundle exceeds the 2 MiB limit")
        entries.append((relative, raw))

    if "SKILL.md" not in {relative for relative, _ in entries}:
        raise SkillBundleError("skill bundle must include root SKILL.md")
    if _hash_entries(entries) != digest:
        raise SkillBundleError("skill bundle sha256 does not match its files")
    result = {
        "schema_version": SCHEMA_VERSION,
        "sha256": digest,
        "files": [
            {"path": relative, "content_base64": base64.b64encode(raw).decode("ascii")}
            for relative, raw in entries
        ],
    }
    _check_json_size(result)
    return result


def _check_json_size(bundle: dict[str, Any]) -> None:
    if len(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_JSON_BYTES:
        raise SkillBundleError("skill bundle exceeds the 3 MiB JSON limit")


def export_skill_bundle(skill_dir: Path, expected_sha256: str | None = None) -> dict[str, Any]:
    """Export one safe skill directory using the existing portability digest."""
    if expected_sha256 is not None and (not isinstance(expected_sha256, str) or not _DIGEST_RE.fullmatch(expected_sha256)):
        raise UnsupportedLocalDefinition("expected skill bundle sha256 is invalid")
    entries = _read_skill_files(Path(skill_dir))
    calculated = _hash_entries(entries)
    # Keep this wire format precisely aligned with existing portability skill
    # references, and catch a source changing while it was read.
    try:
        existing_hash = _skill_tree_hash(Path(skill_dir))
    except UnsupportedLocalDefinition:
        raise
    if existing_hash != calculated:
        raise UnsupportedLocalDefinition("skill bundle source changed while it was being exported")
    if expected_sha256 is not None and calculated != expected_sha256:
        raise UnsupportedLocalDefinition("skill bundle sha256 does not match the expected reference")
    result = {
        "schema_version": SCHEMA_VERSION,
        "sha256": calculated,
        "files": [
            {"path": relative, "content_base64": base64.b64encode(raw).decode("ascii")}
            for relative, raw in sorted(entries, key=lambda entry: entry[0].encode("utf-8"))
        ],
    }
    try:
        _check_json_size(result)
    except SkillBundleError as exc:
        raise UnsupportedLocalDefinition(str(exc)) from exc
    return result


def canonical_skill_bundle(bundle: Any) -> Any:
    """The same bundle with its files in canonical path order.

    Order is not part of a bundle's identity (its digest sorts the files), and
    a stored bundle may predate the server sorting them.  Anything that is not
    bundle-shaped is returned unchanged for :func:`validate_skill_bundle` to
    refuse.
    """
    if not isinstance(bundle, dict) or not isinstance(bundle.get("files"), list):
        return bundle
    files = bundle["files"]
    if not all(isinstance(item, dict) and isinstance(item.get("path"), str) for item in files):
        return bundle
    try:
        ordered = sorted(files, key=lambda item: item["path"].encode("utf-8"))
    except UnicodeEncodeError:
        return bundle
    return {**bundle, "files": ordered}


def write_skill_bundle(directory: Path, bundle: Any) -> Path:
    """Write a verified bundle into the new *directory*, then re-verify the bytes.

    The directory must not exist.  Nothing is stripped: a file that cannot be
    written exactly (a name too long for this filesystem, two names it folds
    together) fails the whole bundle.
    """
    validated = validate_skill_bundle(bundle)
    directory = Path(directory)
    directory.mkdir(mode=0o700)
    for item in validated["files"]:
        destination = directory.joinpath(*PurePosixPath(item["path"]).parts)
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with destination.open("xb") as stream:
            stream.write(base64.b64decode(item["content_base64"], validate=True))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(destination, 0o644)
    try:
        written = _skill_tree_hash(directory)
    except UnsupportedLocalDefinition as exc:
        raise SkillBundleError("skill bundle could not be read back after writing") from exc
    if written != validated["sha256"]:
        # A normalizing filesystem renamed a path; never publish other bytes.
        raise SkillBundleError("skill bundle changed while it was written to this filesystem")
    return directory


def _existing_cache_skill(path: Path, digest: str) -> Path:
    if path.is_symlink() or not path.is_dir():
        raise SkillBundleError("existing skill cache entry is not a regular directory")
    try:
        export_skill_bundle(path, expected_sha256=digest)
    except UnsupportedLocalDefinition as exc:
        raise SkillBundleError("existing skill cache entry is corrupt") from exc
    return path


def install_skill_bundle(cache_root: Path, bundle: Any) -> Path:
    """Atomically install a verified bundle at ``cache_root/<sha256>/skill``."""
    validated = validate_skill_bundle(bundle)
    digest = validated["sha256"]
    cache_root = Path(cache_root)
    if cache_root.is_symlink() or (cache_root.exists() and not cache_root.is_dir()):
        raise SkillBundleError("skill cache root must be a regular directory")
    try:
        cache_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        digest_dir = cache_root / digest
        if digest_dir.is_symlink() or (digest_dir.exists() and not digest_dir.is_dir()):
            raise SkillBundleError("skill cache digest directory is invalid")
        digest_dir.mkdir(mode=0o700, exist_ok=True)
        target = digest_dir / "skill"
        if target.exists() or target.is_symlink():
            return _existing_cache_skill(target, digest)

        stage = Path(tempfile.mkdtemp(prefix=".skill-", suffix=".stage", dir=digest_dir))
        try:
            staged_skill = stage / "skill"
            staged_skill.mkdir(mode=0o700)
            for item in validated["files"]:
                destination = staged_skill.joinpath(*PurePosixPath(item["path"]).parts)
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                destination.write_bytes(base64.b64decode(item["content_base64"], validate=True))
                os.chmod(destination, 0o644)
            # Verify the bytes as written before making them visible.
            _existing_cache_skill(staged_skill, digest)
            try:
                os.replace(staged_skill, target)
            except FileExistsError:
                return _existing_cache_skill(target, digest)
            return _existing_cache_skill(target, digest)
        finally:
            # After the rename this is only the empty staging parent.
            if stage.exists() and not stage.is_symlink():
                shutil.rmtree(stage)
    except OSError as exc:
        raise SkillBundleError("could not install skill bundle into the local cache") from exc
