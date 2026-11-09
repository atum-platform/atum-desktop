"""Ticket-authorized skill and memory content operations for Atum sync.

Electron main writes short-lived, account-scoped tickets.  This module accepts
only those tickets from the account Hermes root and never receives a profile or
filesystem path from the renderer.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

from hermes_cli import atum_portability as portability
from hermes_cli.atum_skill_bundles import (
    SkillBundleError,
    export_skill_bundle,
    install_skill_bundle,
    validate_skill_bundle,
)
from hermes_cli.atum_pet_bundles import (
    PetBundleError,
    export_pet_bundle,
    install_pet_bundle,
    validate_pet_bundle,
)


_OPERATIONS = frozenset({
    "inspect", "export_skill", "install_skill", "read_memory", "apply_memory",
    "read_pets", "export_pet", "install_pet_bundle", "claim_pet", "apply_pet_binding",
})
_COMMON_TICKET_FIELDS = frozenset({"operation", "account_id", "expires_at", "identity_id"})
_PET_SIDECAR = ".atum-pet.json"


def _account_key(account_id: str) -> str:
    """Match Electron's ``accountKeyFor`` without making account ids paths."""
    return hashlib.sha256(b"atum-account-root-v1\0" + account_id.encode("utf-8")).hexdigest()


def _strict_slug(value: Any) -> str:
    from agent.pet.store import _safe_slug

    result = _safe_slug(value) if isinstance(value, str) else ""
    if not result:
        raise portability.TicketError("pet slug is invalid")
    return result


def _ref(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("kind"), str):
        raise portability.TicketError("pet reference is invalid")
    kind = value["kind"]
    if kind == "personal" and set(value) == {"kind", "pet_id"}:
        pet_id = value.get("pet_id")
        if isinstance(pet_id, str) and portability._UUID4_RE.fullmatch(pet_id.lower()):
            return {"kind": kind, "pet_id": pet_id.lower()}
    if kind in {"bundled", "petdex"} and set(value) == {"kind", "slug"}:
        return {"kind": kind, "slug": _strict_slug(value.get("slug"))}
    if kind == "catalog" and set(value) == {"kind", "item_id"}:
        return {"kind": kind, "item_id": _strict_slug(value.get("item_id"))}
    raise portability.TicketError("pet reference is invalid")


def _pet_record(value: Any, *, full: bool) -> dict[str, Any]:
    required = ({"slug", "display_name", "description", "ref", "content_sha256", "byte_size", "published_revision"}
                if full else {"slug", "content_sha256"})
    if not isinstance(value, dict) or set(value) != required:
        raise portability.TicketError("pet record fields are invalid")
    slug = _strict_slug(value.get("slug"))
    content = value.get("content_sha256")
    if not isinstance(content, str) or not re.fullmatch(r"[0-9a-f]{64}", content):
        raise portability.TicketError("pet content hash is invalid")
    result: dict[str, Any] = {"slug": slug, "content_sha256": content}
    if full:
        display_name, description = value.get("display_name"), value.get("description")
        if (not isinstance(display_name, str) or not isinstance(description, str)
                or not display_name.strip() or len(display_name) > 100 or len(description) > 2000
                or len(display_name.encode("utf-8")) > 400 or len(description.encode("utf-8")) > 8000):
            raise portability.TicketError("pet record cosmetics are invalid")
        if type(value.get("byte_size")) is not int or not 0 < value["byte_size"] <= 4_300_000:
            raise portability.TicketError("pet record byte size is invalid")
        revision = value.get("published_revision")
        if type(revision) is not int or revision < 0:
            raise portability.TicketError("pet record revision is invalid")
        result.update({"display_name": display_name, "description": description, "ref": _ref(value.get("ref")),
                       "byte_size": value["byte_size"], "published_revision": revision})
    return result


def _claim_record(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"slug", "ref", "content_sha256", "published_revision"}:
        raise portability.TicketError("pet claim fields are invalid")
    ref = _ref(value.get("ref"))
    if ref is None:
        raise portability.TicketError("pet claim reference is invalid")
    revision = value.get("published_revision")
    if type(revision) is not int or revision < 0:
        raise portability.TicketError("pet claim revision is invalid")
    return {"slug": _strict_slug(value.get("slug")), "ref": ref,
            "content_sha256": _pet_record({"slug": value.get("slug"), "content_sha256": value.get("content_sha256")}, full=False)["content_sha256"],
            "published_revision": revision}


def _binding(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"ref", "enabled", "scale"}:
        raise portability.TicketError("pet binding fields are invalid")
    if type(value.get("enabled")) is not bool:
        raise portability.TicketError("pet binding enabled is invalid")
    scale = value.get("scale")
    if type(scale) not in (int, float) or not math.isfinite(scale):
        raise portability.TicketError("pet binding scale is invalid")
    from agent.pet.constants import clamp_scale

    return {"ref": _ref(value.get("ref")), "enabled": value["enabled"], "scale": clamp_scale(float(scale))}


def _expected_metadata(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"display_name", "description", "content_sha256"}:
        raise portability.TicketError("expected pet metadata is invalid")
    if (not isinstance(value["display_name"], str) or not isinstance(value["description"], str)
            or not isinstance(value["content_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["content_sha256"])):
        raise portability.TicketError("expected pet metadata is invalid")
    return dict(value)


def _validate_content_ticket(value: Any, now: float) -> dict[str, Any]:
    """Validate an exact, main-authored content operation ticket."""
    if not isinstance(value, dict):
        raise portability.TicketError("content ticket must be a JSON object")
    operation = value.get("operation")
    if operation not in _OPERATIONS:
        raise portability.TicketError("content ticket operation is invalid")
    required = _COMMON_TICKET_FIELDS
    if operation == "export_skill":
        required |= {"skill"}
    elif operation == "install_skill":
        required |= {"bundle"}
    elif operation == "apply_memory":
        required |= {"expected_snapshot", "snapshot"}
    elif operation == "export_pet":
        required |= {"pet"}
    elif operation == "install_pet_bundle":
        required |= {"pet", "bundle"}
    elif operation == "claim_pet":
        required |= {"pet"}
    elif operation == "apply_pet_binding":
        required |= {"binding", "expected_binding"}
    optional = {"is_default"}
    if operation == "install_pet_bundle":
        optional.add("expected_metadata")
    if set(value) - optional != required or type(value.get("is_default", False)) is not bool:
        raise portability.TicketError("content ticket fields are invalid for its operation")
    account_id = value.get("account_id")
    if not isinstance(account_id, str) or not account_id.strip():
        raise portability.TicketError("content ticket is missing its account authority")
    expiry = value.get("expires_at")
    if type(expiry) not in (int, float) or not math.isfinite(expiry) or not now < expiry <= now + 300:
        raise portability.TicketError("content ticket has expired")
    identity = value.get("identity_id")
    if not isinstance(identity, str) or not portability._UUID4_RE.fullmatch(identity.lower()):
        raise portability.TicketError("content ticket identity is invalid")

    ticket: dict[str, Any] = {
        "operation": operation,
        "account_id": account_id,
        "identity_id": identity.lower(),
        "is_default": value.get("is_default", False),
    }
    if operation == "export_skill":
        skill = value["skill"]
        if not isinstance(skill, dict) or set(skill) != {"name", "sha256"}:
            raise portability.TicketError("content ticket skill reference is invalid")
        try:
            name = portability._validate_skill_name(skill.get("name"))
        except portability.PortabilityError as exc:
            raise portability.TicketError("content ticket skill name is invalid") from exc
        digest = skill.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise portability.TicketError("content ticket skill hash is invalid")
        ticket["skill"] = {"name": name, "sha256": digest}
    elif operation == "install_skill":
        try:
            ticket["bundle"] = validate_skill_bundle(value["bundle"])
        except SkillBundleError as exc:
            raise portability.TicketError("content ticket skill bundle is invalid") from exc
    elif operation == "apply_memory":
        # The memory worker performs its own complete validation before any
        # target changes. Preserve these objects verbatim for that worker.
        ticket["expected_snapshot"] = value["expected_snapshot"]
        ticket["snapshot"] = value["snapshot"]
    elif operation == "export_pet":
        ticket["pet"] = _pet_record(value["pet"], full=False)
    elif operation == "install_pet_bundle":
        ticket["pet"] = _pet_record(value["pet"], full=True)
        try:
            bundle = validate_pet_bundle(value["bundle"])
        except PetBundleError as exc:
            raise portability.TicketError("content ticket pet bundle is invalid") from exc
        if bundle["sha256"] != ticket["pet"]["content_sha256"]:
            raise portability.TicketError("content ticket pet bundle does not match its record")
        ticket["bundle"] = bundle
        if "expected_metadata" in value:
            ticket["expected_metadata"] = _expected_metadata(value["expected_metadata"])
    elif operation == "claim_pet":
        ticket["pet"] = _claim_record(value["pet"])
    elif operation == "apply_pet_binding":
        ticket["binding"] = _binding(value["binding"])
        ticket["expected_binding"] = _binding(value["expected_binding"])
    return ticket


def _ticket_root(ticket_dir: Path) -> Path:
    """Return the account Hermes root only for the fixed ticket location."""
    ticket_dir = Path(ticket_dir)
    if (
        ticket_dir.name != "tickets"
        or ticket_dir.is_symlink()
        or not ticket_dir.is_dir()
        or ticket_dir.parent.name != ".atum-portability"
        or ticket_dir.parent.is_symlink()
    ):
        raise portability.TicketError("account-scoped content ticket root is invalid")
    root = ticket_dir.parent.parent
    if root.is_symlink() or not root.is_dir():
        raise portability.TicketError("account Hermes root is invalid")
    return root


def _profile_presentation(profile: Path, metadata: dict[str, Any], identity: str) -> dict[str, str]:
    if metadata.get("identity_id") != identity or metadata.get("managed_by") != "atum":
        raise portability.PortabilityError("managed profile identity no longer matches the content ticket")
    display_name = metadata.get("display_name", "")
    avatar = metadata.get("avatar", "")
    if not isinstance(display_name, str) or not isinstance(avatar, str):
        raise portability.PortabilityError("managed profile has invalid presentation")
    return {"name": profile.name, "identity_id": identity, "display_name": display_name, "avatar": avatar}


def _managed_profile(root: Path, identity: str, is_default: bool = False) -> tuple[Path, dict[str, Any]]:
    """Find exactly one managed identity in the root/default or profiles tree."""
    matches: list[tuple[Path, dict[str, Any]]] = []
    try:
        root_metadata = (portability._managed_default_metadata(root, identity) if is_default
                         else portability._read_yaml_mapping(root / "profile.yaml"))
    except portability.UnsupportedLocalDefinition:
        if is_default:
            raise portability.PortabilityError("account default profile metadata is unreadable")
        root_metadata = {}
    if root_metadata.get("identity_id") == identity and root_metadata.get("managed_by") == "atum":
        matches.append((root, root_metadata))

    found = portability._legacy_profile(root, identity)
    if found is not None:
        matches.append(found)
    if not matches:
        raise portability.PortabilityError("managed profile for content ticket is unavailable")
    if len(matches) != 1:
        raise portability.ProfileConflict("multiple local profiles claim this managed identity")
    profile, metadata = matches[0]
    _profile_presentation(profile, metadata, identity)
    return profile, metadata


def _skill_path(profile: Path, reference: dict[str, str]) -> Path:
    skills_root = profile / "skills"
    if skills_root.is_symlink() or not skills_root.is_dir():
        raise portability.PortabilityError("managed profile skill directory is unavailable")
    parts = PurePosixPath(reference["name"]).parts
    if any(skills_root.joinpath(*parts[:index]).is_symlink() for index in range(1, len(parts) + 1)):
        raise portability.PortabilityError("managed profile skill path may not contain symlinks")
    candidate = skills_root.joinpath(*parts)
    if candidate.is_symlink() or not candidate.is_dir():
        raise portability.PortabilityError("managed profile skill is unavailable")
    return candidate


@contextmanager
def _profile_home(profile: Path):
    """Scope store/config calls to the managed profile without mutating env."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(profile)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def _sidecar_path(directory: Path) -> Path:
    return directory / _PET_SIDECAR


def _read_sidecar(directory: Path) -> dict[str, Any] | None:
    path = _sidecar_path(directory)
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise portability.PortabilityError("pet identity sidecar is invalid")
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise portability.PortabilityError("pet identity sidecar is unreadable") from exc
    if not isinstance(data, dict) or set(data) != {"schema_version", "account_key", "ref", "content_sha256", "published_revision"}:
        raise portability.PortabilityError("pet identity sidecar fields are invalid")
    if data.get("schema_version") != 1 or not isinstance(data.get("account_key"), str) or not re.fullmatch(r"[0-9a-f]{64}", data["account_key"]):
        raise portability.PortabilityError("pet identity sidecar authority is invalid")
    ref = _ref(data.get("ref"))
    if ref is None:
        raise portability.PortabilityError("pet identity sidecar reference is invalid")
    digest = data.get("content_sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise portability.PortabilityError("pet identity sidecar content is invalid")
    revision = data.get("published_revision")
    if type(revision) is not int or revision < 0:
        raise portability.PortabilityError("pet identity sidecar revision is invalid")
    return {"schema_version": 1, "account_key": data["account_key"], "ref": ref,
            "content_sha256": digest, "published_revision": revision}


def _write_sidecar(directory: Path, account_key: str, ref: dict[str, str], content_sha256: str,
                   published_revision: str | int = 0) -> None:
    """Atomically persist one local stable identity with owner-only permissions."""
    if directory.is_symlink() or not directory.is_dir():
        raise portability.PortabilityError("pet identity target is invalid")
    payload = {"schema_version": 1, "account_key": account_key, "ref": ref,
               "content_sha256": content_sha256, "published_revision": published_revision}
    path = _sidecar_path(directory)
    fd, temp_name = tempfile.mkstemp(prefix=".atum-pet-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
        os.chmod(path, 0o600)
    except OSError as exc:
        Path(temp_name).unlink(missing_ok=True)
        raise portability.PortabilityError("could not persist pet identity") from exc


def _create_sidecar_once(directory: Path, account_key: str, ref: dict[str, str], content_sha256: str) -> dict[str, Any]:
    """Create a personal identity once, even when two reads race.

    ``link`` is the no-replace publish primitive here: whichever reader wins
    owns the generated UUID; the loser loads that exact winner rather than
    returning a different identity that could be uploaded to the cloud.
    """
    payload = {"schema_version": 1, "account_key": account_key, "ref": ref,
               "content_sha256": content_sha256, "published_revision": 0}
    path = _sidecar_path(directory)
    fd, temp_name = tempfile.mkstemp(prefix=".atum-pet-", suffix=".tmp", dir=directory)
    temporary = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        os.chmod(temporary, 0o600)
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            existing = _read_sidecar(directory)
            if existing is None:
                raise portability.PortabilityError("pet identity appeared without a sidecar")
            return existing
        os.chmod(path, 0o600)
        return payload
    except OSError as exc:
        raise portability.PortabilityError("could not create pet identity") from exc
    finally:
        temporary.unlink(missing_ok=True)


def _bundle_for(directory: Path) -> tuple[dict[str, Any], int]:
    bundle = export_pet_bundle(directory)
    return bundle, sum(len(base64.b64decode(item["content_base64"], validate=True)) for item in bundle["files"])


def _bundled_ref(slug: str, content_sha256: str) -> dict[str, str] | None:
    from agent.pet import store

    bundled = store.load_bundled_pet(slug)
    if bundled is None:
        return None
    try:
        return {"kind": "bundled", "slug": slug} if export_pet_bundle(bundled.directory)["sha256"] == content_sha256 else None
    except PetBundleError:
        return None


def _catalog_ref(pet, content_sha256: str, account_root: Path | None) -> dict[str, str] | None:
    """Classify a Store-owned local asset before it can become personal bytes.

    The installer's provenance stamp answers first (plan D1: one vocabulary
    with this sidecar's ``ref.kind``); the signed catalog set is the check
    that the stamped identity is really the catalog's, and the fallback for a
    directory that has no stamp."""
    try:
        from hermes_cli.atum_store_proof import load_catalog_owned
    except ModuleNotFoundError:
        return None
    try:
        from agent.pet import provenance as _prov

        stamp = _prov.read_stamp(pet.directory)
    except Exception:  # noqa: BLE001
        stamp = None
    owned = load_catalog_owned(account_root=account_root)
    if stamp is not None and stamp.catalog_identifier is not None:
        if owned is not None and owned.owns("pet", stamp.catalog_identifier, stamp.tree_sha256):
            return {"kind": "catalog", "item_id": stamp.catalog_identifier}
        return None
    if owned is not None and owned.owns("pet", pet.slug, content_sha256):
        return {"kind": "catalog", "item_id": pet.slug}
    return None


def _enforce_catalog(reference: dict[str, str], *, account_id: str, account_root: Path) -> bool:
    """Permit catalog activation only through the installed Store authority."""
    if reference["kind"] != "catalog":
        return True
    try:
        from hermes_cli.atum_store_proof import enforce_catalog_item, load_catalog_owned
    except ModuleNotFoundError:
        return False
    owned = load_catalog_owned(account_root=account_root)
    if owned is None or not owned.owns("pet", reference["item_id"]):
        return False
    try:
        enforce_catalog_item("pet", reference["item_id"], account_id=account_id, account_root=account_root)
    except Exception:
        return False
    return True


def _pet_entry(pet, account_key: str, *, mint_personal: bool,
               account_root: Path | None = None) -> dict[str, Any] | None:
    """Return a transportable pet record; never take over another account's pet."""
    try:
        bundle, byte_size = _bundle_for(pet.directory)
    except PetBundleError:
        return None
    try:
        sidecar = _read_sidecar(pet.directory)
    except portability.PortabilityError:
        sidecar = None
    digest = bundle["sha256"]
    catalog = _catalog_ref(pet, digest, account_root)
    # The signed Store registry classifies first. Otherwise a catalog asset
    # copied into this profile could be minted/uploaded as personal content.
    if catalog is not None:
        ref = catalog
        revision = sidecar["published_revision"] if sidecar is not None and sidecar["account_key"] == account_key else 0
    elif sidecar is not None and sidecar["account_key"] != account_key:
        return None
    elif sidecar is not None:
        ref = sidecar["ref"]
        revision = sidecar["published_revision"]
    else:
        ref = _catalog_ref(pet, digest, account_root) or _bundled_ref(pet.slug, digest)
        revision = 0
        if ref is None and mint_personal:
            # The sidecar is the one durable source of a generated/unknown
            # pet's cloud identity. Write it before returning a ref so retries
            # cannot mint different UUIDs.
            ref = {"kind": "personal", "pet_id": str(uuid.uuid4())}
            created = _create_sidecar_once(pet.directory, account_key, ref, digest)
            if created["account_key"] != account_key or created["content_sha256"] != digest:
                return None
            ref, revision = created["ref"], created["published_revision"]
    if ref is None:
        return None
    return {"slug": pet.slug, "display_name": pet.display_name, "description": pet.description,
            "ref": ref, "content_sha256": digest, "byte_size": byte_size,
            "published_revision": revision}


def _write_cosmetics(pet, display_name: str, description: str) -> None:
    """Atomically apply cloud record cosmetics without changing bundle bytes."""
    path = pet.directory / "pet.json"
    if path.is_symlink() or not path.is_file():
        raise portability.PortabilityError("pet metadata target is invalid")
    try:
        metadata = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise portability.PortabilityError("pet metadata target is unreadable") from exc
    if not isinstance(metadata, dict):
        raise portability.PortabilityError("pet metadata target is invalid")
    metadata.update({"id": pet.slug, "displayName": display_name, "description": description})
    from utils import atomic_json_write
    atomic_json_write(path, metadata, sort_keys=True, separators=(",", ":"))


def _library_entry(pet, account_key: str, account_root: Path) -> dict[str, Any] | None:
    """A corrupt pet is skipped; it cannot hide the rest of a library."""
    try:
        return _pet_entry(pet, account_key, mint_personal=True, account_root=account_root)
    except (OSError, PetBundleError, portability.PortabilityError):
        return None


def _read_binding(profile: Path, account_key: str, account_root: Path) -> tuple[dict[str, Any], bool]:
    from agent.pet import store
    from agent.pet.constants import DEFAULT_SCALE, clamp_scale
    from hermes_cli.config import load_config, read_raw_config

    config = load_config()
    display = config.get("display") if isinstance(config.get("display"), dict) else {}
    stored = display.get("pet") if isinstance(display.get("pet"), dict) else {}
    raw_config = read_raw_config()
    raw_display = raw_config.get("display") if isinstance(raw_config.get("display"), dict) else {}
    raw_pet = raw_display.get("pet") if isinstance(raw_display.get("pet"), dict) else {}
    slug = stored.get("slug") if isinstance(stored.get("slug"), str) else ""
    scale_raw = stored.get("scale", DEFAULT_SCALE)
    try:
        scale = clamp_scale(float(scale_raw))
    except (TypeError, ValueError):
        scale = DEFAULT_SCALE
    enabled = bool(stored.get("enabled", True))
    # An explicitly disabled or cleared binding must stay clear in the sync
    # projection; resolve_active_pet's alphabetical fallback is UI-only.
    active = store.load_pet(slug) if slug else (store.resolve_active_pet() if enabled else None)
    record = _library_entry(active, account_key, account_root) if active else None
    # Factory Gigi is enabled by convention; only a non-default selection,
    # disabled state, or explicit scale represents a user binding edit.
    explicit = bool("scale" in raw_pet or raw_pet.get("enabled") is False
                    or (raw_pet.get("slug") and raw_pet.get("slug") != "gigi"))
    return {"ref": record["ref"] if record else None, "enabled": enabled, "scale": scale}, explicit


def _find_ref(profile: Path, account_key: str, reference: dict[str, str] | None, account_root: Path):
    from agent.pet import store

    if reference is None:
        return None
    for pet in store.installed_pets():
        record = _pet_entry(pet, account_key, mint_personal=False, account_root=account_root)
        if record is not None and record["ref"] == reference:
            return pet
    return None


def content_ticket(ticket_dir: Path, ticket_id: str, *, now: float | None = None) -> dict[str, Any]:
    """Consume one owner-authorized content ticket without accepting any paths."""
    ticket_dir = Path(ticket_dir)
    root = _ticket_root(ticket_dir)
    ticket, claimed = portability._consume_ticket(
        ticket_dir,
        ticket_id,
        time.time() if now is None else now,
        _validate_content_ticket,
    )
    try:
        operation = ticket["operation"]
        identity = ticket["identity_id"]
        if operation == "install_skill":
            cache_root = root / ".atum-portability" / "skill-cache"
            installed = install_skill_bundle(cache_root, ticket["bundle"])
            return {"ok": True, "sha256": installed.parent.name}

        profile, metadata = _managed_profile(root, identity, ticket["is_default"])
        presentation = _profile_presentation(profile, metadata, identity)
        if operation == "inspect":
            return {
                "ok": True,
                "profile": presentation,
                "definition": portability.export_portable_definition(profile),
            }
        if operation == "export_skill":
            definition = portability.export_portable_definition(profile)
            reference = ticket["skill"]
            if reference not in definition["skills"]:
                raise portability.PortabilityError("content ticket skill is not part of the managed definition")
            bundle = export_skill_bundle(_skill_path(profile, reference), reference["sha256"])
            return {"ok": True, "bundle": bundle}
        if operation == "read_memory":
            from hermes_cli.atum_memory_sync import read_memory_snapshot

            return {"ok": True, "snapshot": read_memory_snapshot(profile)}
        if operation == "apply_memory":
            from hermes_cli.atum_memory_sync import apply_memory_snapshot

            result = apply_memory_snapshot(profile, ticket["expected_snapshot"], ticket["snapshot"])
            return {"ok": True, "result": result}
        if operation == "read_pets":
            from agent.pet import store

            account_key = _account_key(ticket["account_id"])
            with _profile_home(profile):
                records = [_library_entry(pet, account_key, root) for pet in store.installed_pets()]
                binding, explicit = _read_binding(profile, account_key, root)
            return {"ok": True,
                    "pets": [{key: record[key] for key in ("slug", "display_name", "description", "ref", "content_sha256", "byte_size", "published_revision")}
                             for record in records if record is not None],
                    "active": binding, "explicit": explicit,
                    "skipped": {"count": sum(record is None for record in records),
                                "status": "partial" if any(record is None for record in records) else "complete"}}
        if operation == "export_pet":
            from agent.pet import store

            account_key = _account_key(ticket["account_id"])
            reference = ticket["pet"]
            with _profile_home(profile):
                pet = store.load_pet(reference["slug"])
                if pet is None or not pet.exists:
                    raise portability.PortabilityError("ticket pet is unavailable")
                record = _pet_entry(pet, account_key, mint_personal=False, account_root=root)
                if record is None or record["content_sha256"] != reference["content_sha256"]:
                    raise portability.PortabilityError("ticket pet no longer matches its content reference")
                # Bytes are owner-private only for personal content. Bundled,
                # Petdex, and catalog records are references and stay that way.
                if record["ref"]["kind"] != "personal":
                    return {"ok": True, "pet": {key: record[key] for key in ("slug", "display_name", "description", "ref", "content_sha256", "byte_size", "published_revision")}}
                bundle, _ = _bundle_for(pet.directory)
                return {"ok": True, "pet": {key: record[key] for key in ("slug", "display_name", "description", "ref", "content_sha256", "byte_size", "published_revision")}, "bundle": bundle}
        if operation == "install_pet_bundle":
            from agent.pet import store

            record = ticket["pet"]
            ref = record["ref"]
            account_key = _account_key(ticket["account_id"])
            with _profile_home(profile):
                if ref is None or ref["kind"] == "personal":
                    existing = _find_ref(profile, account_key, ref, root) if ref else None
                    if existing is not None:
                        current = _pet_entry(existing, account_key, mint_personal=False, account_root=root)
                        if current is not None and current["content_sha256"] == record["content_sha256"]:
                            expected = ticket.get("expected_metadata")
                            actual_metadata = {key: current[key] for key in ("display_name", "description", "content_sha256")}
                            if expected is None or actual_metadata != expected:
                                return {"ok": False, "status": "conflict", "current": actual_metadata}
                            _write_cosmetics(existing, record["display_name"], record["description"])
                            return {"ok": True, "slug": existing.slug, "status": "reused"}
                        if current is not None:
                            return {"ok": False, "status": "conflict", "current": {"content_sha256": current["content_sha256"]}}
                    # The stamp records what the bytes ARE (plan D1): catalog
                    # content by its item id, bundled by its slug, else personal.
                    stamp_source, stamp_identifier = "personal", record["slug"]
                    if isinstance(ref, dict) and ref.get("kind") == "catalog" and ref.get("item_id"):
                        stamp_source, stamp_identifier = "catalog", str(ref["item_id"])
                    elif isinstance(ref, dict) and ref.get("kind") in ("bundled", "petdex") and ref.get("slug"):
                        stamp_source, stamp_identifier = str(ref["kind"]), str(ref["slug"])
                    target = install_pet_bundle(store.pets_dir(), ticket["bundle"], record["slug"], metadata=record,
                                                source=stamp_source, identifier=stamp_identifier)
                    _write_sidecar(target, account_key, ref or {"kind": "personal", "pet_id": str(uuid.uuid4())},
                                   record["content_sha256"], record["published_revision"])
                    return {"ok": True, "slug": target.name, "status": "installed"}
                # Store/catalog/petdex installs must use the existing install path,
                # which is where entitlement checks are (or will be) enforced.
                source_slug = ref.get("slug") or ref.get("item_id")
                if ref["kind"] == "catalog" and not _enforce_catalog(ref, account_id=ticket["account_id"], account_root=root):
                    return {"ok": False, "status": "unavailable"}
                try:
                    installed = store.install_pet(source_slug)
                except Exception:
                    return {"ok": False, "status": "unavailable"}
                return {"ok": True, "slug": installed.slug, "status": "installed"}
        if operation == "claim_pet":
            from agent.pet import store

            account_key = _account_key(ticket["account_id"])
            claim = ticket["pet"]
            with _profile_home(profile):
                pet = store.load_pet(claim["slug"])
                if pet is None or not pet.exists:
                    raise portability.PortabilityError("pet claim target is unavailable")
                bundle, _ = _bundle_for(pet.directory)
                if bundle["sha256"] != claim["content_sha256"]:
                    raise portability.PortabilityError("pet claim target no longer matches expected content")
                sidecar = _read_sidecar(pet.directory)
                if sidecar is not None and sidecar["account_key"] != account_key:
                    raise portability.PortabilityError("pet identity belongs to a different account")
                if sidecar is not None and sidecar["ref"] != claim["ref"] and sidecar["content_sha256"] != claim["content_sha256"]:
                    raise portability.PortabilityError("pet identity may not be repointed to other content")
                _write_sidecar(pet.directory, account_key, claim["ref"], claim["content_sha256"], claim["published_revision"])
                return {"ok": True, "slug": pet.slug}
        if operation == "apply_pet_binding":
            from agent.pet import store
            from hermes_cli.config import load_config, save_config

            account_key = _account_key(ticket["account_id"])
            desired, expected = ticket["binding"], ticket["expected_binding"]
            with _profile_home(profile):
                current, _ = _read_binding(profile, account_key, root)
                if current != expected:
                    return {"ok": False, "status": "conflict", "current": current}
                selected = _find_ref(profile, account_key, desired["ref"], root)
                if desired["ref"] is not None:
                    ref = desired["ref"]
                    source_slug = ref.get("slug") or ref.get("item_id")
                    if ref["kind"] == "catalog":
                        if not _enforce_catalog(ref, account_id=ticket["account_id"], account_root=root):
                            return {"ok": False, "status": "unavailable"}
                        try:
                            # Always pass catalog activation through the Store's
                            # established installer, including already-local pets.
                            selected = store.install_pet(source_slug)
                        except Exception:
                            return {"ok": False, "status": "unavailable"}
                    elif selected is None and (ref["kind"] == "personal" or not source_slug):
                        return {"ok": False, "status": "unavailable"}
                    elif selected is None:
                        try:
                            selected = store.install_pet(source_slug)
                        except Exception:
                            return {"ok": False, "status": "unavailable"}
                # An install may have taken a network round-trip. Re-read the
                # profile binding before changing config so a late local edit
                # wins the CAS instead of being silently overwritten.
                current, _ = _read_binding(profile, account_key, root)
                if current != expected:
                    return {"ok": False, "status": "conflict", "current": current}
                config = load_config()
                display = config.setdefault("display", {})
                pet_config = display.setdefault("pet", {})
                pet_config["enabled"] = desired["enabled"]
                pet_config["scale"] = desired["scale"]
                if selected is not None:
                    pet_config["slug"] = selected.slug
                elif desired["ref"] is None:
                    pet_config.pop("slug", None)
                save_config(config)
            return {"ok": True, "binding": desired}
        raise portability.TicketError("content ticket operation is invalid")
    finally:
        portability._finalize_ticket(claimed)
