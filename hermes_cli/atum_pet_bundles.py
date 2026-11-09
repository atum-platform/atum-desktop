"""Bounded, cosmetic-neutral pet bundles for Atum's private content sync."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

from agent.pet import store
from hermes_cli.atum_skill_bundles import _hash_entries


SCHEMA_VERSION = 1
MAX_RAW_BYTES = 3 * 1024 * 1024
MAX_JSON_BYTES = 4_300_000
MAX_SPEC_BYTES = 256 * 1024
MAX_PET_JSON_BYTES = 16 * 1024
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
_ALLOWED = frozenset({"pet.json", "spritesheet.webp", "spritesheet.png", "spec.json"})


class PetBundleError(ValueError):
    """A pet bundle is unsafe, malformed, or cannot be installed."""


def _path(value: Any) -> str:
    if not isinstance(value, str) or value not in _ALLOWED or value.startswith("."):
        raise PetBundleError("pet bundle has an invalid path")
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) != 1 or "\\" in value:
        raise PetBundleError("pet bundle paths must be root regular files")
    return value


def _canonical_pet_json(raw: bytes, sprite_name: str) -> bytes:
    if len(raw) > MAX_PET_JSON_BYTES:
        raise PetBundleError("pet.json exceeds the 16 KiB limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PetBundleError("pet.json must be valid JSON") from exc
    if not isinstance(value, dict):
        raise PetBundleError("pet.json must be an object")
    # These are the only keys consumed by the runtime parser. IDs and cosmetics
    # are record metadata, not portable asset bytes; unknown keys could carry
    # arbitrary local paths or secrets and must not cross the account boundary.
    canonical: dict[str, Any] = {"spritesheetPath": sprite_name}
    created_by = value.get("createdBy")
    if isinstance(created_by, str) and len(created_by.encode("utf-8")) <= 256:
        canonical["createdBy"] = created_by
    # Preserve the declared geometry/provenance written by Hermes voxel hatch.
    # These bounded known fields are portable, unlike arbitrary custom metadata.
    for key in ("generator", "lookOrigin"):
        item = value.get(key)
        if isinstance(item, str) and len(item.encode("utf-8")) <= 64:
            canonical[key] = item
    for key in ("spriteVersionNumber", "lookYawSteps", "lookPitchSteps"):
        item = value.get(key)
        if isinstance(item, int) and not isinstance(item, bool) and 1 <= item <= 32:
            canonical[key] = item
    # Voxel pets declare their draw scale and optional animation rows.  They
    # are not cosmetic names: omitting them makes a valid v4 sheet import as a
    # default v3 pet on another device.
    size = value.get("size")
    if isinstance(size, (int, float)) and not isinstance(size, bool) and 0.5 <= float(size) <= 2.0:
        canonical["size"] = float(size)
    from agent.pet.constants import parse_extra_rows
    extra_rows = list(parse_extra_rows(value.get("extraRows")))
    if extra_rows:
        canonical["extraRows"] = extra_rows
    # Carry only bounded v5 presentation fields, never arbitrary metadata.
    from agent.pet.constants import LOCOMOTIONS, parse_anchor, parse_bounds, parse_size_class
    for key, parser in (("sizeClass", parse_size_class), ("anchor", parse_anchor), ("bounds", parse_bounds)):
        if key in value:
            parsed = parser(value[key])
            if parsed is None:
                raise PetBundleError(f"invalid pet {key}")
            canonical[key] = parsed
    if "locomotion" in value:
        if not isinstance(value["locomotion"], str) or value["locomotion"] not in LOCOMOTIONS:
            raise PetBundleError("invalid pet locomotion")
        canonical["locomotion"] = value["locomotion"]
    return json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _check_entries(entries: list[tuple[str, bytes]], *, canonicalize: bool) -> tuple[list[tuple[str, bytes]], str]:
    paths = {path for path, _ in entries}
    sprites = paths & {"spritesheet.webp", "spritesheet.png"}
    if "pet.json" not in paths or len(sprites) != 1 or paths - _ALLOWED:
        raise PetBundleError("pet bundle requires pet.json and exactly one spritesheet")
    if len(entries) != len(paths):
        raise PetBundleError("pet bundle paths must be unique")
    sprite_name = next(iter(sprites))
    normalized: list[tuple[str, bytes]] = []
    total = 0
    for path, raw in entries:
        _path(path)
        if not isinstance(raw, bytes):
            raise PetBundleError("pet bundle content must be bytes")
        normalized_raw = raw
        if path == "spec.json":
            if len(raw) > MAX_SPEC_BYTES:
                raise PetBundleError("pet spec exceeds the 256 KiB limit")
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PetBundleError("spec.json must be valid JSON") from exc
            normalized_raw = json.dumps(parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        elif path == "pet.json":
            normalized_raw = _canonical_pet_json(raw, sprite_name)
        elif path == sprite_name:
            store._assert_sheet_bytes(raw)
        if not canonicalize and raw != normalized_raw:
            raise PetBundleError("pet bundle JSON must already be canonical")
        raw = normalized_raw if canonicalize else raw
        total += len(raw)
        if total > MAX_RAW_BYTES:
            raise PetBundleError("pet bundle exceeds the 3 MiB limit")
        normalized.append((path, raw))
    return normalized, sprite_name


def _json_limit(value: dict[str, Any]) -> None:
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_JSON_BYTES:
        raise PetBundleError("pet bundle exceeds the 4,300,000 byte JSON limit")


def validate_pet_bundle(bundle: Any) -> dict[str, Any]:
    """Return canonical validated v1 wire bytes without touching disk."""
    if not isinstance(bundle, dict) or set(bundle) != {"schema_version", "sha256", "files"}:
        raise PetBundleError("pet bundle fields are invalid")
    if bundle.get("schema_version") != SCHEMA_VERSION:
        raise PetBundleError("unsupported pet bundle schema")
    digest = bundle.get("sha256")
    if not isinstance(digest, str) or not _DIGEST_RE.fullmatch(digest):
        raise PetBundleError("pet bundle sha256 is invalid")
    files = bundle.get("files")
    if not isinstance(files, list) or not 2 <= len(files) <= 3:
        raise PetBundleError("pet bundle files are invalid")
    entries: list[tuple[str, bytes]] = []
    previous: bytes | None = None
    encoded_limit = 4 * ((MAX_RAW_BYTES + 2) // 3)
    raw_total = 0
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "content_base64"}:
            raise PetBundleError("pet bundle file fields are invalid")
        path = _path(item.get("path"))
        encoded = item.get("content_base64")
        if not isinstance(encoded, str) or not encoded.isascii() or len(encoded) > encoded_limit:
            raise PetBundleError("pet bundle content must be canonical base64")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, UnicodeEncodeError) as exc:
            raise PetBundleError("pet bundle content is invalid base64") from exc
        if base64.b64encode(raw).decode("ascii") != encoded:
            raise PetBundleError("pet bundle content must be canonical base64")
        raw_total += len(raw)
        if raw_total > MAX_RAW_BYTES:
            raise PetBundleError("pet bundle exceeds the 3 MiB limit")
        encoded_path = path.encode("utf-8")
        if previous is not None and encoded_path <= previous:
            raise PetBundleError("pet bundle paths must be canonically ordered")
        previous = encoded_path
        entries.append((path, raw))
    normalized, _ = _check_entries(entries, canonicalize=False)
    if _hash_entries(normalized) != digest:
        raise PetBundleError("pet bundle sha256 does not match files")
    result = {"schema_version": SCHEMA_VERSION, "sha256": digest,
              "files": [{"path": path, "content_base64": base64.b64encode(raw).decode("ascii")}
                        for path, raw in sorted(normalized, key=lambda item: item[0].encode("utf-8"))]}
    _json_limit(result)
    return result


def export_pet_bundle(pet_dir: Path, expected_sha256: str | None = None) -> dict[str, Any]:
    """Export one installed pet's portable immutable content."""
    source = Path(pet_dir)
    if source.is_symlink() or not source.is_dir():
        raise PetBundleError("pet bundle source must be a regular directory")
    entries: list[tuple[str, bytes]] = []
    source_total = 0
    try:
        for child in source.iterdir():
            if child.name.startswith("."):
                continue
            child_stat = child.lstat()
            if child.is_symlink() or not stat.S_ISREG(child_stat.st_mode):
                raise PetBundleError("pet bundle source may only contain regular files")
            if child.name not in _ALLOWED:
                # A pet directory may have local thumbnails/cache files; they are
                # deliberately not transportable. Non-dot arbitrary content is not.
                raise PetBundleError("pet bundle source has unsupported content")
            if child_stat.st_size > MAX_RAW_BYTES or (child.name == "pet.json" and child_stat.st_size > MAX_PET_JSON_BYTES) or (child.name == "spec.json" and child_stat.st_size > MAX_SPEC_BYTES):
                raise PetBundleError("pet bundle source file exceeds its byte limit")
            source_total += child_stat.st_size
            if source_total > MAX_RAW_BYTES:
                raise PetBundleError("pet bundle source exceeds the 3 MiB limit")
            entries.append((child.name, child.read_bytes()))
    except OSError as exc:
        raise PetBundleError("could not read pet bundle source") from exc
    normalized, _ = _check_entries(entries, canonicalize=True)
    digest = _hash_entries(normalized)
    if expected_sha256 is not None and digest != expected_sha256:
        raise PetBundleError("pet bundle sha256 does not match expected content")
    result = {"schema_version": SCHEMA_VERSION, "sha256": digest,
              "files": [{"path": path, "content_base64": base64.b64encode(raw).decode("ascii")}
                        for path, raw in sorted(normalized, key=lambda item: item[0].encode("utf-8"))]}
    _json_limit(result)
    return result


def install_pet_bundle(pets_root: Path, bundle: Any, slug: str, *, metadata: dict[str, str] | None = None,
                       source: str = "personal", identifier: str | None = None) -> Path:
    """Atomically materialize immutable content without replacing another slug.

    The caller owns stable-ref comparison.  A collision gets the next free slug;
    callers can then bind that path to the requested cloud record.
    """
    validated = validate_pet_bundle(bundle)
    slug = store._safe_slug(slug)
    if not slug:
        raise PetBundleError("pet installation slug is invalid")
    root = Path(pets_root)
    if root.is_symlink() or (root.exists() and not root.is_dir()):
        raise PetBundleError("pets root is invalid")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".atum-pet-{slug}-", dir=root))
    try:
        for item in validated["files"]:
            (stage / item["path"]).write_bytes(base64.b64decode(item["content_base64"], validate=True))
            os.chmod(stage / item["path"], 0o644)
        raw = json.loads((stage / "pet.json").read_text(encoding="utf-8-sig"))
        if metadata:
            raw.update({"id": slug, "displayName": metadata.get("display_name", slug),
                        "description": metadata.get("description", "")})
        else:
            raw.update({"id": slug, "displayName": slug, "description": ""})
        (stage / "pet.json").write_text(json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        if not store._staged_pet_ok(slug, stage):
            raise PetBundleError("pet bundle did not produce a usable spritesheet")
        chosen = slug
        number = 2
        while (root / chosen).exists():
            suffix = f"-{number}"
            chosen = f"{slug[:80 - len(suffix)]}{suffix}"
            number += 1
        target = root / chosen
        store.stamp_pet_staging(stage, source=source, identifier=identifier or slug)
        store._publish_pet_dir(stage, target, replace=False)
        return target
    except OSError as exc:
        raise PetBundleError("could not install pet bundle") from exc
    finally:
        if stage.exists() and not stage.is_symlink():
            shutil.rmtree(stage, ignore_errors=True)
