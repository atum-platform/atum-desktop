"""Private assistant portability's local definition boundary.

This module deliberately handles a very small, credential-free projection of a
Hermes profile.  The desktop main process remains the account authority: it
writes a short-lived ticket into an account-scoped Hermes home, while this
module only consumes that ticket and creates the deterministic local profile.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

from utils import atomic_yaml_write


SCHEMA_VERSION = 1
MANAGED_PROVIDER = "atum-managed"
MODEL_ALIASES = frozenset({"binh-minh", "nguyet-thuc", "nhat-thuc"})
REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})
_UUID4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_TICKET_ID_RE = _UUID4_RE


class PortabilityError(ValueError):
    """A local definition or materialization request is invalid."""


class UnsupportedLocalDefinition(PortabilityError):
    """The local profile cannot be expressed by the v1 allow-list."""


class TicketError(PortabilityError):
    """A ticket is absent, expired, malformed, or already consumed."""


class ProfileConflict(PortabilityError):
    """The deterministic target belongs to some other local profile."""


def _read_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    if path.is_symlink() or not path.is_file():
        raise UnsupportedLocalDefinition(f"{path.name} must be a regular file")
    try:
        parsed = yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as exc:
        raise UnsupportedLocalDefinition(f"Could not read {path.name}") from exc
    if not isinstance(parsed, dict):
        raise UnsupportedLocalDefinition(f"{path.name} must contain a mapping")
    return parsed


def _unsafe_portable_path_component(part: str) -> bool:
    # Win32 normalizes trailing dots/spaces and recognizes device names even
    # with extensions. A drive/stream separator can escape a staging root.
    return (
        part.endswith((".", " "))
        or any(char in '<>:"|?*' for char in part)
        or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?", part, re.IGNORECASE) is not None
    )


def _validate_skill_name(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 200
        or "\\" in value
        or any(ord(char) < 32 or char == "\x7f" for char in value)
    ):
        raise PortabilityError("skill name must be a relative slash-separated path")
    # Do not let PurePosixPath normalize a//b or a/./b into a different name.
    parts = value.split("/")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} or _unsafe_portable_path_component(part) for part in parts):
        raise PortabilityError("skill name must be a relative slash-separated path")
    return value


def _skill_tree_hash(skill_dir: Path) -> str:
    """Hash a skill's regular files in the contract's canonical order."""
    if skill_dir.is_symlink() or not skill_dir.is_dir():
        raise UnsupportedLocalDefinition(f"Skill {skill_dir.name!r} is not a regular directory")

    entries: list[tuple[str, Path]] = []
    for root, dirs, files in os.walk(skill_dir, followlinks=False):
        root_path = Path(root)
        for directory in dirs:
            path = root_path / directory
            if path.is_symlink():
                raise UnsupportedLocalDefinition(f"Skill {skill_dir.name!r} contains a symlink")
        for filename in files:
            path = root_path / filename
            if path.is_symlink() or not path.is_file():
                raise UnsupportedLocalDefinition(f"Skill {skill_dir.name!r} contains a non-regular file")
            entries.append((path.relative_to(skill_dir).as_posix(), path))

    digest = hashlib.sha256()
    for relative, path in sorted(entries):
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise UnsupportedLocalDefinition(f"Could not read skill {skill_dir.name!r}") from exc
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(raw)
        digest.update(b"\0")
    return digest.hexdigest()


def _definition_skills(skills_root: Path) -> list[dict[str, str]]:
    if not skills_root.exists():
        return []
    if skills_root.is_symlink() or not skills_root.is_dir():
        raise UnsupportedLocalDefinition("skills must be a regular directory")

    found: list[dict[str, str]] = []
    for marker in sorted(skills_root.rglob("SKILL.md")):
        if marker.is_symlink() or not marker.is_file():
            raise UnsupportedLocalDefinition("skills may not contain symlinks")
        skill_dir = marker.parent
        name = _validate_skill_name(skill_dir.relative_to(skills_root).as_posix())
        found.append({"name": name, "sha256": _skill_tree_hash(skill_dir)})
    if len(found) > 512:
        raise UnsupportedLocalDefinition("portable definitions may reference at most 512 skills")
    return found


def _definition_reasoning(config: dict[str, Any], model_alias: str) -> dict[str, Any] | None:
    from hermes_constants import resolve_reasoning_config

    reasoning = resolve_reasoning_config(config, model_alias)
    if reasoning is None:
        return None
    if reasoning.get("enabled") is False:
        return {"enabled": False, "effort": None}
    effort = reasoning.get("effort")
    if effort not in REASONING_EFFORTS - {"none"}:
        raise UnsupportedLocalDefinition("profile has an unsupported reasoning setting")
    return {"enabled": True, "effort": effort}


def export_portable_definition(profile_dir: Path) -> dict[str, Any]:
    """Return only the v1 definition allow-list for a local profile.

    The model is intentionally accepted only when it is an existing Atum
    managed alias. An Atum-created profile without a saved model uses the
    desktop's managed launch default, just as the gateway does. Explicit
    external/local assignments must never be replaced with that default.
    """
    profile_dir = Path(profile_dir)
    if profile_dir.is_symlink() or not profile_dir.is_dir():
        raise UnsupportedLocalDefinition("profile does not exist")
    soul_path = profile_dir / "SOUL.md"
    if soul_path.is_symlink() or not soul_path.is_file():
        raise UnsupportedLocalDefinition("SOUL.md must be a regular file")
    try:
        soul = soul_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise UnsupportedLocalDefinition("Could not read SOUL.md") from exc
    if len(soul.encode("utf-8")) > 65536:
        raise UnsupportedLocalDefinition("SOUL.md exceeds the 65536-byte portability limit")

    config = _read_yaml_mapping(profile_dir / "config.yaml")
    model = config.get("model")
    if "model" not in config:
        metadata = _read_yaml_mapping(profile_dir / "profile.yaml")
        launch_default = os.environ.get("ATUM_MANAGED_MODEL_DEFAULT", "").strip()
        launch_model = (
            os.environ.get("HERMES_MODEL", "")
            or os.environ.get("HERMES_INFERENCE_MODEL", "")
        ).strip()
        launch_provider = (
            os.environ.get("HERMES_TUI_PROVIDER", "")
            or os.environ.get("HERMES_INFERENCE_PROVIDER", "")
        ).strip()
        if (
            metadata.get("managed_by") == "atum"
            and launch_default in MODEL_ALIASES
            and launch_model in {"", launch_default}
            and launch_provider in {"", MANAGED_PROVIDER}
        ):
            model = {"provider": MANAGED_PROVIDER, "default": launch_default}
    if not isinstance(model, dict):
        raise UnsupportedLocalDefinition("profile does not have a managed model assignment")
    provider = model.get("provider")
    alias = model.get("default") or model.get("model")
    if provider != MANAGED_PROVIDER or alias not in MODEL_ALIASES:
        raise UnsupportedLocalDefinition("profile does not have a supported managed model assignment")

    try:
        skills = _definition_skills(profile_dir / "skills")
    except PortabilityError as exc:
        raise UnsupportedLocalDefinition(str(exc)) from exc
    return {
        "schema_version": SCHEMA_VERSION,
        "soul": soul,
        "model_alias": alias,
        "reasoning": _definition_reasoning(config, alias),
        "skills": skills,
    }


def _validate_definition(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"schema_version", "soul", "model_alias", "reasoning", "skills"}:
        raise TicketError("ticket definition must contain exactly the v1 portability fields")
    if value.get("schema_version") != SCHEMA_VERSION:
        raise TicketError("unsupported portability definition schema")
    soul = value.get("soul")
    if not isinstance(soul, str) or len(soul.encode("utf-8")) > 65536:
        raise TicketError("invalid portable soul")
    alias = value.get("model_alias")
    if alias not in MODEL_ALIASES:
        raise TicketError("invalid managed model alias")
    reasoning = value.get("reasoning")
    if reasoning is not None:
        if not isinstance(reasoning, dict) or set(reasoning) != {"enabled", "effort"} or type(reasoning.get("enabled")) is not bool:
            raise TicketError("invalid portable reasoning")
        effort = reasoning.get("effort")
        if reasoning["enabled"] and effort not in REASONING_EFFORTS - {"none"}:
            raise TicketError("invalid portable reasoning")
        if not reasoning["enabled"] and effort is not None:
            raise TicketError("invalid portable reasoning effort")
    skills = value.get("skills")
    if not isinstance(skills, list) or len(skills) > 512:
        raise TicketError("invalid portable skills")
    names: set[str] = set()
    validated_skills: list[dict[str, str]] = []
    for skill in skills:
        if not isinstance(skill, dict) or set(skill) != {"name", "sha256"}:
            raise TicketError("invalid portable skill")
        name = _validate_skill_name(skill.get("name"))
        digest = skill.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise TicketError("invalid portable skill hash")
        if name in names:
            raise TicketError("portable skill names must be unique")
        names.add(name)
        validated_skills.append({"name": name, "sha256": digest})
    return {"schema_version": SCHEMA_VERSION, "soul": soul, "model_alias": alias, "reasoning": reasoning, "skills": validated_skills}


def _validate_ticket(value: Any, now: float) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TicketError("ticket must be a JSON object")
    required = {"account_id", "expires_at", "assistant", "definition", "definition_revision", "identity_revision"}
    if not required.issubset(value) or not isinstance(value.get("account_id"), str) or not value["account_id"].strip():
        raise TicketError("ticket is missing its account authority")
    try:
        expires_at = float(value["expires_at"])
    except (TypeError, ValueError) as exc:
        raise TicketError("ticket has an invalid expiry") from exc
    if not math.isfinite(expires_at) or expires_at <= now or expires_at > now + 300:
        raise TicketError("ticket has expired")
    assistant = value.get("assistant")
    if not isinstance(assistant, dict):
        raise TicketError("ticket is missing its assistant identity")
    identity = str(assistant.get("identity_id") or "").lower()
    if not _UUID4_RE.fullmatch(identity):
        raise TicketError("ticket has an invalid assistant identity")
    is_default = assistant.get("is_default", False)
    if type(is_default) is not bool:
        raise TicketError("ticket is_default must be a boolean")
    display_name = assistant.get("display_name", "")
    avatar = assistant.get("avatar", "")
    if not isinstance(display_name, str) or not isinstance(avatar, str):
        raise TicketError("ticket has invalid assistant presentation")
    if (
        len(display_name) > 64
        or len(avatar) > 16
        or any(ord(char) < 32 or char == "\x7f" for char in display_name + avatar)
        or avatar.startswith(".")
        or any(char in "/\\:" for char in avatar)
    ):
        raise TicketError("ticket has invalid assistant presentation")
    try:
        definition_revision = int(value["definition_revision"])
        identity_revision = int(value["identity_revision"])
    except (TypeError, ValueError) as exc:
        raise TicketError("ticket has invalid revisions") from exc
    if definition_revision < 1 or identity_revision < 1:
        raise TicketError("ticket has invalid revisions")
    apply_existing = value.get("apply_existing", False)
    if type(apply_existing) is not bool:
        raise TicketError("ticket apply_existing must be a boolean")
    legacy_home = value.get("legacy_home")
    if legacy_home is not None and (
        not isinstance(legacy_home, str)
        or not Path(legacy_home).is_absolute()
        or Path(legacy_home).is_symlink()
    ):
        raise TicketError("invalid legacy source home")
    return {
        "account_id": value["account_id"],
        "assistant": {"identity_id": identity, "display_name": display_name, "avatar": avatar, "is_default": is_default},
        "definition": _validate_definition(value.get("definition")),
        "definition_revision": definition_revision,
        "identity_revision": identity_revision,
        "apply_existing": apply_existing,
        "legacy_home": legacy_home,
        "expected_local_definition": _validate_definition(value["expected_local_definition"]) if "expected_local_definition" in value else None,
    }


def ticket_directory_from_environment() -> Path:
    """Read Electron main's current-account marker on every POST.

    Each backend is scoped to one account, and a live marker additionally
    prevents an outgoing process from consuming a ticket after revocation.  Electron
    atomically replaces this marker only after its account-root commit and
    removes it on revoke.  The renderer never supplies either path.
    """
    raw_marker = os.environ.get("ATUM_PORTABILITY_TICKETS_ROOT_MARKER", "").strip()
    if raw_marker:
        marker = Path(raw_marker)
    else:
        from hermes_constants import get_process_hermes_home
        marker = get_process_hermes_home() / "atum-portability-tickets-root"
    if marker.is_symlink() or not marker.is_file():
        raise TicketError("account-scoped portability ticket root is unavailable")
    try:
        raw = marker.read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise TicketError("account-scoped portability ticket root is unavailable") from exc
    path = Path(raw)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        raise TicketError("account-scoped portability ticket root is invalid")
    from hermes_constants import get_default_hermes_root
    if path.parent.parent.resolve() != get_default_hermes_root().resolve():
        raise TicketError("account-scoped portability ticket root does not match this backend home")
    return path


def _ticket_path(ticket_dir: Path, ticket_id: str) -> Path:
    if not isinstance(ticket_id, str) or not _TICKET_ID_RE.fullmatch(ticket_id.lower()):
        raise TicketError("ticket_id must be a UUID")
    return ticket_dir / f"{ticket_id.lower()}.json"


def _consume_ticket(ticket_dir: Path, ticket_id: str, now: float, validator=_validate_ticket) -> tuple[dict[str, Any], Path]:
    path = _ticket_path(ticket_dir, ticket_id)
    # An atomic rename claims the one-use ticket before any profile write.
    # A crash after this point is safe: the claimed ticket is retried only by
    # the same id, and installation itself is deterministic and idempotent.
    claimed = path.with_suffix(".claimed")
    try:
        os.replace(path, claimed)
    except FileNotFoundError:
        if claimed.with_suffix(".consumed").is_file():
            raise TicketError("ticket was already consumed")
        if not claimed.is_file():
            raise TicketError("ticket was not found or was already consumed")
    try:
        raw = json.loads(claimed.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TicketError("ticket is not valid JSON") from exc
    return validator(raw, now), claimed


def _validate_legacy_ticket(value: Any, now: float) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"operation", "account_id", "expires_at", "assistant", "legacy_home"}:
        raise TicketError("invalid legacy export ticket")
    if value.get("operation") != "export_legacy" or not isinstance(value.get("account_id"), str) or not value["account_id"]:
        raise TicketError("invalid legacy export authority")
    expiry = value.get("expires_at")
    if type(expiry) not in (int, float) or not math.isfinite(expiry) or not now < expiry <= now + 300:
        raise TicketError("legacy export ticket expired")
    assistant = value.get("assistant")
    if not isinstance(assistant, dict) or not isinstance(assistant.get("identity_id"), str) or not _UUID4_RE.fullmatch(assistant["identity_id"]):
        raise TicketError("invalid legacy export identity")
    home = value.get("legacy_home")
    if not isinstance(home, str) or not Path(home).is_absolute() or Path(home).is_symlink():
        raise TicketError("invalid legacy source home")
    return value


def export_legacy_ticket(ticket_dir: Path, ticket_id: str, *, now: float | None = None) -> dict[str, Any]:
    """Main has verified this exact cloud identity belongs to the active owner.

    No arbitrary UUID, source name or path is accepted from the renderer. The
    global legacy home remains unclaimed; only this matching managed profile's
    portable allowlist is read. Personal history and credentials stay in place.
    """
    ticket, claimed = _consume_ticket(Path(ticket_dir), ticket_id, time.time() if now is None else now, _validate_legacy_ticket)
    try:
        match = _legacy_profile(Path(ticket["legacy_home"]), ticket["assistant"]["identity_id"])
        if match is None:
            return {"ok": False, "status": "legacy_source_absent"}
        profile, metadata = match
        return {"ok": True, "status": "exported", "definition": export_portable_definition(profile),
                "assistant": {"identity_id": metadata["identity_id"], "display_name": metadata.get("display_name") or ticket["assistant"].get("display_name", ""),
                              "avatar": metadata.get("avatar", "")}}
    finally:
        _finalize_ticket(claimed)


def _legacy_profile(home: Path, identity: str) -> tuple[Path, dict[str, Any]] | None:
    """Find only the exact owner-authorized identity, never a name match."""
    legacy = home / "profiles"
    if home.is_symlink() or legacy.is_symlink() or not legacy.is_dir():
        return None
    matches = []
    for profile in legacy.iterdir():
        if not profile.is_dir() or profile.is_symlink():
            continue
        try:
            meta = _read_yaml_mapping(profile / "profile.yaml")
        except UnsupportedLocalDefinition:
            # An unreadable sibling cannot prove the requested identity and
            # must not block another assistant's recovery.
            continue
        if meta.get("identity_id") == identity and meta.get("managed_by") == "atum":
            matches.append((profile, meta))
    if len(matches) > 1:
        raise ProfileConflict("multiple local profiles claim this legacy identity")
    return matches[0] if matches else None


def _finalize_ticket(claimed: Path) -> None:
    """Make a completed ticket unavailable for a second setup request."""
    try:
        os.replace(claimed, claimed.with_suffix(".consumed"))
    except FileNotFoundError:
        # Another request can only have finalized this same claimed ticket;
        # the deterministic profile result remains safe to return.
        pass


def _skill_sources(hermes_root: Path) -> list[Path]:
    sources = [hermes_root / "skills"]
    profiles_root = hermes_root / "profiles"
    if profiles_root.is_dir():
        sources.extend(
            entry / "skills"
            for entry in sorted(profiles_root.iterdir())
            if entry.is_dir() and not entry.is_symlink()
        )
    return sources


def _optional_skills_root() -> Path | None:
    """The shipped ``optional-skills/`` tree, resolved exactly as the hub does.

    Mirrors ``tools/skills_hub.py``'s ``OptionalSkillSource`` directory pick so
    a shipped skill never needs a download to materialise on a second device.
    """
    from hermes_constants import get_optional_skills_dir

    root = get_optional_skills_dir(Path(__file__).resolve().parent.parent / "optional-skills")
    if root.is_symlink() or not root.is_dir():
        return None
    return root


def _catalog_skill_item_id(name: str) -> str:
    """The catalog id of a shipped optional skill is its hub identifier."""
    return f"official/{name}"


# Slice-2 seam: main's entitlement-gated catalog fetch does not exist yet.
# When it lands it is installed here as ``(reference, account_root) -> Path``.
_catalog_skill_fetcher = None


def _catalog_skill_fetch(hermes_root: Path, reference: dict[str, str], *, account_id: str | None = None) -> Path:
    """Resolve a catalog-owned skill's bytes through the brokered catalog fetch.

    Plan decision 6, slice 2 groundwork: gated on the signed proof, and it
    fails cleanly and loudly rather than silently resolving to nothing while
    the desktop broker is unbuilt.  An unusable proof means the item is
    unavailable (contract C3 rule 2); a usable proof without the slice-2
    fetch channel means the asset cannot be fetched offline.
    """
    from hermes_cli import atum_store_proof as store_proof

    if store_proof.proof_error(account_id=account_id, account_root=hermes_root) is not None:
        raise store_proof.StoreEntitlementError(
            store_proof.ENTITLEMENT_UNAVAILABLE_OFFLINE,
            f"catalog skill '{reference['name']}' is not on this device and there is no usable signed entitlement proof",
        )
    fetcher = _catalog_skill_fetcher
    if fetcher is None:
        raise store_proof.StoreEntitlementError(
            store_proof.ASSET_UNAVAILABLE_OFFLINE,
            f"catalog skill '{reference['name']}' is not on this device and the catalog fetch channel is unavailable",
        )
    return fetcher(reference, hermes_root)


def _enforce_catalog_skill_entitlements(
    hermes_root: Path,
    account_id: str | None,
    skills: list[dict[str, str]],
) -> None:
    """Refuse to put catalog-owned skill bytes into a profile without entitlement.

    Materialisation is a store chokepoint (plan decision 5): it copytrees
    resolved skills into a profile without passing the hub install route, so
    the signed proof is verified here before any byte is staged.  The gate is
    a no-op for skills the signed ``catalog_owned`` does not name, and for
    everything when no envelope exists at all (contract C3 rule 1).
    """
    from hermes_cli import atum_store_proof as store_proof

    for reference in skills:
        store_proof.enforce_catalog_item(
            "skill",
            _catalog_skill_item_id(reference["name"]),
            account_id=account_id,
            sha256=reference["sha256"],
            account_root=hermes_root,
        )


def _find_skill_by_name(sources: list[Path], name: str) -> Path | None:
    """The first source directory holding a skill named *name*, whatever its hash."""
    for root in sources:
        if root.is_symlink():
            continue
        parts = PurePosixPath(name).parts
        candidate = root.joinpath(*parts)
        if any(root.joinpath(*parts[:index]).is_symlink() for index in range(1, len(parts))):
            continue
        if candidate.is_dir() and not candidate.is_symlink():
            return candidate
    return None


def _definition_with_resolved_hashes(definition: dict[str, Any], mismatches: list[dict[str, str]]) -> dict[str, Any]:
    """The definition as actually applied when shipped-tree bytes were used.

    A catalog skill resolved from this device's tree under an active
    entitlement carries this device's hash, not the cloud definition's; the
    staged-export comparison must expect the bytes that were really staged.
    """
    if not mismatches:
        return definition
    actual = {mismatch["name"]: mismatch["actual_sha256"] for mismatch in mismatches}
    skills = [
        {**skill, "sha256": actual[skill["name"]]} if skill["name"] in actual else dict(skill)
        for skill in definition["skills"]
    ]
    return {**definition, "skills": skills}


def _find_skills(
    hermes_root: Path,
    skills: list[dict[str, str]],
    *,
    legacy_profile: Path | None = None,
    account_id: str | None = None,
    mismatches: list[dict[str, str]] | None = None,
) -> tuple[dict[str, Path], list[dict[str, str]]]:
    from hermes_cli import atum_store_proof as store_proof

    available: dict[str, Path] = {}
    missing: list[dict[str, str]] = []
    sources = _skill_sources(hermes_root)
    if legacy_profile is not None:
        sources.append(legacy_profile / "skills")
    optional_root = _optional_skills_root()
    if optional_root is not None:
        sources.append(optional_root)
    catalog_items = store_proof.catalog_owned_items(account_root=hermes_root)
    for reference in skills:
        match = None
        cache_root = hermes_root / ".atum-portability" / "skill-cache"
        cached = cache_root / reference["sha256"] / "skill"
        if not any(part.is_symlink() for part in (cache_root.parent, cache_root, cached.parent, cached)) and cached.is_dir():
            try:
                if _skill_tree_hash(cached) == reference["sha256"]:
                    available[reference["name"]] = cached
                    continue
            except UnsupportedLocalDefinition:
                pass
        for root in sources:
            if root.is_symlink():
                continue
            parts = PurePosixPath(reference["name"]).parts
            candidate = root.joinpath(*parts)
            if any(root.joinpath(*parts[:index]).is_symlink() for index in range(1, len(parts))):
                continue
            if candidate.is_dir() and not candidate.is_symlink():
                try:
                    if _skill_tree_hash(candidate) == reference["sha256"]:
                        match = candidate
                        break
                except UnsupportedLocalDefinition:
                    continue
        if match is None:
            entry = store_proof.match_catalog_item(
                catalog_items, "skill", _catalog_skill_item_id(reference["name"]), reference["sha256"]
            )
            if entry is not None:
                local = _find_skill_by_name(sources, reference["name"])
                local_hash = None
                if local is not None:
                    try:
                        local_hash = _skill_tree_hash(local)
                    except UnsupportedLocalDefinition:
                        local = None
                if (
                    local is not None
                    and store_proof.entitlement_state(account_id, "skill", entry["id"], account_root=hermes_root)
                    == "active"
                ):
                    # The shipped optional-skills tree on this device carries a
                    # different build of an entitled catalog skill.  Resolve it
                    # locally and report the drift instead of dead-ending into
                    # the unbuilt catalog-fetch seam (review H5).
                    match = local
                    if mismatches is not None:
                        mismatches.append(
                            {
                                "name": reference["name"],
                                "expected_sha256": reference["sha256"],
                                "actual_sha256": local_hash,
                            }
                        )
                else:
                    # A catalog-owned hash that is nowhere local comes only
                    # through the entitlement-gated catalog fetch — which fails
                    # loudly, never silently.
                    match = _catalog_skill_fetch(hermes_root, reference, account_id=account_id)
        if match is None:
            missing.append(dict(reference))
        else:
            available[reference["name"]] = match
    return available, missing


def _profile_result(profile_dir: Path, assistant: dict[str, str], status: str) -> dict[str, Any]:
    return {"ok": True, "status": status, "profile": {"name": profile_dir.name, **{key: assistant[key] for key in ("identity_id", "display_name", "avatar")}, "managed_by": "atum"}}


def _existing_profile_result(target: Path, assistant: dict[str, str]) -> dict[str, Any] | None:
    try:
        metadata = _read_yaml_mapping(target / "profile.yaml")
    except UnsupportedLocalDefinition:
        raise ProfileConflict("the deterministic profile has unreadable metadata")
    if metadata.get("identity_id") == assistant["identity_id"] and metadata.get("managed_by") == "atum":
        return _profile_result(target, assistant, "reused")
    raise ProfileConflict("the deterministic profile belongs to another local agent")


def _assert_regular_tree(path: Path, label: str) -> None:
    """Reject symlinks before an apply can read or replace a profile path."""
    if path.is_symlink():
        raise ProfileConflict(f"{label} may not be a symlink")
    if not path.exists():
        return
    if not path.is_dir():
        raise ProfileConflict(f"{label} must be a directory")
    for root, dirs, files in os.walk(path, followlinks=False):
        root_path = Path(root)
        for name in [*dirs, *files]:
            if (root_path / name).is_symlink():
                raise ProfileConflict(f"{label} may not contain symlinks")


def _assert_regular_file_or_absent(path: Path, label: str) -> None:
    if path.is_symlink():
        raise ProfileConflict(f"{label} may not be a symlink")
    if path.exists() and not path.is_file():
        raise ProfileConflict(f"{label} must be a regular file")


def _set_definition_config(config: dict[str, Any], definition: dict[str, Any]) -> dict[str, Any]:
    """Merge the v1-owned settings without replacing unrelated profile config."""
    updated = dict(config)
    model = updated.get("model")
    model = dict(model) if isinstance(model, dict) else {}
    model["provider"] = MANAGED_PROVIDER
    model["default"] = definition["model_alias"]
    updated["model"] = model

    agent = updated.get("agent")
    agent = dict(agent) if isinstance(agent, dict) else {}
    overrides = agent.get("reasoning_overrides")
    if isinstance(overrides, dict):
        overrides = dict(overrides)
        # The selected managed alias must not be shadowed by a local override.
        overrides.pop(definition["model_alias"], None)
        if overrides:
            agent["reasoning_overrides"] = overrides
        else:
            agent.pop("reasoning_overrides", None)

    reasoning = definition["reasoning"]
    if reasoning is None:
        agent.pop("reasoning_effort", None)
    elif reasoning["enabled"] is False:
        agent["reasoning_effort"] = False
    else:
        # This is the profile editing representation used by normal Hermes
        # model/reasoning changes.  The staged export check below rejects a
        # wire setting that this representation cannot faithfully preserve.
        agent["reasoning_effort"] = reasoning["effort"]
    if agent:
        updated["agent"] = agent
    else:
        updated.pop("agent", None)
    return updated


def _recovery_backup(hermes_root: Path, profile_dir: Path, identity: str) -> Path:
    """Snapshot exactly the files an apply can change under account-local state."""
    portability_root = hermes_root / ".atum-portability"
    if portability_root.is_symlink() or (portability_root.exists() and not portability_root.is_dir()):
        raise ProfileConflict("account portability state is not a regular directory")
    portability_root.mkdir(mode=0o700, exist_ok=True)
    os.chmod(portability_root, 0o700)
    recovery_root = portability_root / "recovery"
    if recovery_root.is_symlink() or (recovery_root.exists() and not recovery_root.is_dir()):
        raise ProfileConflict("account portability recovery state is invalid")
    recovery_root.mkdir(mode=0o700, exist_ok=True)
    os.chmod(recovery_root, 0o700)
    backup = recovery_root / f"{identity}-{time.time_ns()}-{uuid.uuid4().hex}"
    backup.mkdir(mode=0o700)

    present: dict[str, bool] = {}
    for name in ("SOUL.md", "config.yaml", "profile.yaml"):
        source = profile_dir / name
        _assert_regular_file_or_absent(source, name)
        present[name] = source.exists()
        if source.exists():
            shutil.copy2(source, backup / name)
    skills = profile_dir / "skills"
    _assert_regular_tree(skills, "skills")
    present["skills"] = skills.exists()
    if skills.exists():
        shutil.copytree(skills, backup / "skills", symlinks=False)
    manifest = backup / "manifest.json"
    manifest.write_text(json.dumps({"profile": profile_dir.name, "present": present}, sort_keys=True), encoding="utf-8")
    os.chmod(manifest, 0o600)
    return backup


def _restore_recovery_backup(profile_dir: Path, backup: Path) -> None:
    """Restore changed profile paths after an interrupted apply write."""
    manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8-sig"))
    present = manifest["present"]
    for name in ("SOUL.md", "config.yaml", "profile.yaml"):
        destination = profile_dir / name
        if present.get(name):
            restore = backup / name
            temp = destination.with_name(f".{destination.name}.restore-{uuid.uuid4().hex}")
            shutil.copy2(restore, temp)
            os.replace(temp, destination)
        elif destination.exists():
            destination.unlink()
    skills = profile_dir / "skills"
    if skills.exists():
        shutil.rmtree(skills)
    if present.get("skills"):
        shutil.copytree(backup / "skills", skills, symlinks=False)


def _apply_existing_profile(
    hermes_root: Path,
    profile_dir: Path,
    assistant: dict[str, str],
    definition: dict[str, Any],
    expected_local_definition: dict[str, Any] | None = None,
    require_empty_default: bool = False,
    account_id: str | None = None,
) -> dict[str, Any]:
    """Apply a cloud definition to its same-identity local profile atomically enough to recover."""
    if profile_dir.is_symlink() or not profile_dir.is_dir():
        raise ProfileConflict("matched local profile is not a regular directory")
    identity = assistant["identity_id"]
    # Share Hermes's metadata transaction lock with CLI edits, identity writes
    # and shared-persona approval. A separate cloud-only lock would allow a
    # normal profile edit to race this read/replace and lose either update.
    from hermes_cli.atum_profile_identity import profile_meta_lock

    with profile_meta_lock(profile_dir):
        metadata = _read_yaml_mapping(profile_dir / "profile.yaml")
        if metadata.get("identity_id") != identity or metadata.get("managed_by") != "atum":
            raise ProfileConflict("matched local profile identity changed during apply")
        for name in ("SOUL.md", "config.yaml", "profile.yaml"):
            _assert_regular_file_or_absent(profile_dir / name, name)
        _assert_regular_tree(profile_dir / "skills", "skills")
        if require_empty_default:
            model = _read_yaml_mapping(profile_dir / "config.yaml").get("model", {})
            skills_dir = profile_dir / "skills"
            soul_path = profile_dir / "SOUL.md"
            seeded_soul = False
            if soul_path.exists():
                try:
                    soul = soul_path.read_text(encoding="utf-8-sig")
                except (OSError, UnicodeDecodeError) as exc:
                    raise ProfileConflict("default profile changed before initial cloud restore") from exc
                from hermes_cli.default_soul import DEFAULT_SOUL_MD, is_legacy_template_soul

                # Hermes seeds this file while the default profile is being
                # adopted.  The canonical/legacy templates carry no user
                # intent, so they remain an empty root for the first cloud
                # restore.  Any edited persona still fails closed below.
                seeded_soul = soul.strip() == DEFAULT_SOUL_MD.strip() or is_legacy_template_soul(soul)
            if (
                (soul_path.exists() and not seeded_soul)
                or (skills_dir.exists() and any(skills_dir.iterdir()))
                or not isinstance(model, dict)
                or model.get("provider") != MANAGED_PROVIDER
                or model.get("default") not in MODEL_ALIASES
            ):
                raise ProfileConflict("default profile changed before initial cloud restore")
        hash_mismatches: list[dict[str, str]] = []
        available_skills, missing_skills = _find_skills(
            hermes_root, definition["skills"], account_id=account_id, mismatches=hash_mismatches
        )
        if missing_skills:
            return {"ok": False, "status": "missing_skills", "missing_skills": missing_skills}

        current_definition: dict[str, Any] | None
        try:
            current_definition = export_portable_definition(profile_dir)
        except UnsupportedLocalDefinition:
            current_definition = None
        if expected_local_definition is not None and current_definition != expected_local_definition:
            raise ProfileConflict("local definition changed during synchronization")
        presentation_matches = (
            metadata.get("display_name", "") == assistant["display_name"]
            and metadata.get("avatar", "") == assistant["avatar"]
        )
        if current_definition == definition and presentation_matches:
            return _profile_result(profile_dir, assistant, "applied")

        # Store chokepoint three (plan decision 5): this apply is about to
        # stage catalog-owned bytes into the profile, so the signed proof is
        # verified before anything is written.  Only skills being newly
        # applied are gated: re-verifying bytes already in the profile would
        # let a refund — or a skill installed before the store existed —
        # freeze every later definition sync of this assistant (review H5).
        current_skill_keys = (
            {(skill["name"], skill["sha256"]) for skill in current_definition["skills"]}
            if current_definition is not None
            else set()
        )
        newly_applied = [
            skill for skill in definition["skills"] if (skill["name"], skill["sha256"]) not in current_skill_keys
        ]
        if newly_applied:
            _enforce_catalog_skill_entitlements(hermes_root, account_id, newly_applied)

        stage = Path(tempfile.mkdtemp(prefix=f".{profile_dir.name}.apply-", suffix=".stage", dir=profile_dir.parent))
        try:
            (stage / "SOUL.md").write_text(definition["soul"], encoding="utf-8")
            atomic_yaml_write(stage / "config.yaml", _set_definition_config(_read_yaml_mapping(profile_dir / "config.yaml"), definition), sort_keys=False)
            next_metadata = dict(metadata)
            next_metadata["display_name"] = assistant["display_name"]
            next_metadata["avatar"] = assistant["avatar"]
            atomic_yaml_write(stage / "profile.yaml", next_metadata, sort_keys=False)
            staged_skills = stage / "skills"
            staged_skills.mkdir()
            for name, source in available_skills.items():
                destination = staged_skills / Path(*PurePosixPath(name).parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(source, destination, symlinks=False)
            if export_portable_definition(stage) != _definition_with_resolved_hashes(definition, hash_mismatches):
                raise TicketError("portable reasoning cannot be represented by this local profile")

            if expected_local_definition is not None and export_portable_definition(profile_dir) != expected_local_definition:
                raise ProfileConflict("local definition changed during synchronization")
            backup = _recovery_backup(hermes_root, profile_dir, identity)
            try:
                for name in ("SOUL.md", "config.yaml", "profile.yaml"):
                    os.replace(stage / name, profile_dir / name)
                old_skills = stage / "previous-skills"
                skills = profile_dir / "skills"
                if skills.exists():
                    os.replace(skills, old_skills)
                os.replace(staged_skills, skills)
            except Exception as exc:
                try:
                    _restore_recovery_backup(profile_dir, backup)
                except Exception as restore_exc:
                    raise PortabilityError("cloud apply failed; recovery backup was retained") from restore_exc
                raise PortabilityError("cloud apply failed and was rolled back") from exc
            result = _profile_result(profile_dir, assistant, "applied")
            if hash_mismatches:
                result["skill_hash_mismatches"] = hash_mismatches
            return result
        finally:
            shutil.rmtree(stage, ignore_errors=True)


def _managed_default_metadata(root: Path, identity: str) -> dict[str, Any]:
    """Recognize an adopted account root through Hermes' metadata transaction."""
    from hermes_cli.atum_profile_identity import profile_meta_lock
    with profile_meta_lock(root):
        metadata = _read_yaml_mapping(root / "profile.yaml")
        if metadata.get("identity_id") != identity:
            raise ProfileConflict("default assistant identity adoption is pending")
        if metadata.get("managed_by") not in {None, "", "atum"}:
            raise ProfileConflict("default assistant belongs to another manager")
        if metadata.get("managed_by") != "atum":
            metadata["managed_by"] = "atum"
            atomic_yaml_write(root / "profile.yaml", metadata, sort_keys=False)
        return metadata


def materialize_ticket(ticket_dir: Path, ticket_id: str, *, now: float | None = None) -> dict[str, Any]:
    """Consume one account-private ticket and install its deterministic profile."""
    ticket_dir = Path(ticket_dir)
    if ticket_dir.is_symlink() or not ticket_dir.is_dir() or ticket_dir.name != "tickets":
        raise TicketError("account-scoped portability ticket root is invalid")
    now = time.time() if now is None else now
    ticket, claimed = _consume_ticket(ticket_dir, ticket_id, now)
    hermes_root = ticket_dir.parent.parent
    assistant = ticket["assistant"]
    identity = assistant["identity_id"]
    # The default assistant is an existing account-root profile. Never create a
    # second named profile for it, and use the same identity/CAS apply path.
    try:
        root_metadata = _read_yaml_mapping(hermes_root / "profile.yaml")
        if assistant.get("is_default"):
            root_metadata = _managed_default_metadata(hermes_root, identity)
    except UnsupportedLocalDefinition:
        root_metadata = {}
    except ProfileConflict:
        _finalize_ticket(claimed)
        raise
    if assistant.get("is_default") and root_metadata.get("identity_id") != identity:
        _finalize_ticket(claimed)
        raise ProfileConflict("default assistant identity adoption is pending")
    if root_metadata.get("identity_id") == identity and root_metadata.get("managed_by") == "atum":
        try:
            if ticket["apply_existing"]:
                result = _apply_existing_profile(hermes_root, hermes_root, assistant, ticket["definition"], ticket.get("expected_local_definition"), account_id=ticket["account_id"])
            elif assistant.get("is_default"):
                try:
                    current_definition = export_portable_definition(hermes_root)
                except UnsupportedLocalDefinition:
                    current_definition = None
                result = (
                    _profile_result(hermes_root, assistant, "reused")
                    if current_definition == ticket["definition"]
                    else _apply_existing_profile(
                        hermes_root,
                        hermes_root,
                        assistant,
                        ticket["definition"],
                        require_empty_default=True,
                        account_id=ticket["account_id"],
                    )
                )
            else:
                result = _profile_result(hermes_root, assistant, "reused")
            if result.get("ok"):
                result["profile"]["name"] = "default"
            return result
        finally:
            _finalize_ticket(claimed)
    target = hermes_root / "profiles" / f"agent-{identity}"
    if target.is_symlink():
        _finalize_ticket(claimed)
        raise ProfileConflict("the deterministic profile may not be a symlink")
    if target.exists():
        try:
            if ticket["apply_existing"]:
                _existing_profile_result(target, assistant)
                return _apply_existing_profile(hermes_root, target, assistant, ticket["definition"], ticket.get("expected_local_definition"), account_id=ticket["account_id"])
            return _existing_profile_result(target, assistant)
        finally:
            _finalize_ticket(claimed)

    profiles_root = hermes_root / "profiles"
    if profiles_root.is_symlink():
        _finalize_ticket(claimed)
        raise ProfileConflict("profiles may not be a symlink")
    if profiles_root.is_dir():
        for candidate in profiles_root.iterdir():
            if candidate.is_dir() and not candidate.is_symlink() and not candidate.name.startswith("."):
                metadata = _read_yaml_mapping(candidate / "profile.yaml")
                if metadata.get("identity_id") == identity and metadata.get("managed_by") == "atum":
                    try:
                        if ticket["apply_existing"]:
                            return _apply_existing_profile(hermes_root, candidate, assistant, ticket["definition"], ticket.get("expected_local_definition"), account_id=ticket["account_id"])
                        return _profile_result(candidate, assistant, "reused")
                    finally:
                        _finalize_ticket(claimed)

    hash_mismatches: list[dict[str, str]] = []
    available_skills, missing_skills = _find_skills(
        hermes_root, ticket["definition"]["skills"], account_id=ticket["account_id"], mismatches=hash_mismatches
    )
    if missing_skills and ticket["legacy_home"] is not None:
        match = _legacy_profile(Path(ticket["legacy_home"]), identity)
        if match is not None:
            recovered, missing_skills = _find_skills(
                hermes_root,
                missing_skills,
                legacy_profile=match[0],
                account_id=ticket["account_id"],
                mismatches=hash_mismatches,
            )
            available_skills.update(recovered)
    if missing_skills:
        result = {"ok": False, "status": "missing_skills", "missing_skills": missing_skills}
        _finalize_ticket(claimed)
        return result

    # Store chokepoint three (plan decision 5): materialisation copytrees the
    # resolved skills into the profile below without passing the hub install
    # route, so a catalog-owned skill needs an active entitlement first.
    from hermes_cli.atum_store_proof import StoreEntitlementError

    try:
        _enforce_catalog_skill_entitlements(hermes_root, ticket["account_id"], ticket["definition"]["skills"])
    except StoreEntitlementError:
        _finalize_ticket(claimed)
        raise

    profiles_root = target.parent
    profiles_root.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{target.name}.", suffix=".stage", dir=profiles_root))
    try:
        for name in ("memories", "sessions", "skills", "skins", "logs", "plans", "workspace", "cron", "home"):
            (stage / name).mkdir()
        definition = ticket["definition"]
        (stage / "SOUL.md").write_text(definition["soul"], encoding="utf-8")
        atomic_yaml_write(stage / "config.yaml", _set_definition_config({}, definition), sort_keys=False)
        atomic_yaml_write(
            stage / "profile.yaml",
            {
                "identity_id": identity,
                "lifecycle_revision": 1,
                "display_name": assistant["display_name"],
                "avatar": assistant["avatar"],
                "managed_by": "atum",
            },
            sort_keys=False,
        )
        for name, source in available_skills.items():
            destination = stage / "skills" / Path(*PurePosixPath(name).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, destination, symlinks=False)

        if export_portable_definition(stage) != _definition_with_resolved_hashes(definition, hash_mismatches):
            raise PortabilityError("portable source changed during materialization")

        try:
            # A profile directory is never empty after ordinary creation, so
            # POSIX rename cannot replace one.  On Windows this also fails if
            # another process has created the target.  Re-read the winner and
            # only reuse the exact managed identity.
            os.rename(stage, target)
            stage = None  # type: ignore[assignment]
        except FileExistsError:
            if target.exists():
                try:
                    return _existing_profile_result(target, assistant)
                finally:
                    _finalize_ticket(claimed)
            raise
        result = _profile_result(target, assistant, "materialized")
        if hash_mismatches:
            result["skill_hash_mismatches"] = hash_mismatches
        _finalize_ticket(claimed)
        return result
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
