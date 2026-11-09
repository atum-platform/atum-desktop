"""On-disk pet store — install / list / resolve pets.

Pets live under ``get_hermes_home()/pets/<slug>/`` so every profile gets its
own set (we deliberately do **not** reuse petdex's ``~/.codex/pets`` default —
that's owned by the petdex npm CLI and isn't profile-aware).  Each installed
pet directory holds:

    pets/<slug>/
        pet.json            # {id, displayName, description, spritesheetPath}
        spritesheet.webp    # (or .png)

The active pet is resolved from the caller-supplied ``display.pet.slug`` config
value (falling back to the first installed pet), so this module stays free of
the config loader.
"""

from __future__ import annotations

import json
import os
import shutil
import logging
import re
import tempfile
import threading
import uuid
from dataclasses import dataclass, replace as _dc_replace

from agent.pet import provenance as _prov
from pathlib import Path

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

_DOWNLOAD_TIMEOUT = 60.0


class PetStoreError(RuntimeError):
    """Raised on install/IO failures."""


class PetEntitlementError(PetStoreError):
    """A catalog-owned pet may not be installed or selected without entitlement.

    ``code`` is one of the W5.3 typed store errors (``purchase_required``,
    ``entitlement_unavailable_offline``, ``entitlement_revoked``, ...); the
    message always leads with it so ``pet.select`` surfaces the typed refusal.
    """

    def __init__(self, code: str, slug: str, message: str = "") -> None:
        self.code = code
        self.slug = slug
        super().__init__(message or f"{code}: pet '{slug}' is not available")


def _enforce_catalog_pet(slug: str) -> None:
    """Store chokepoint one (plan decision 5): pet.select installs+activates.

    The slug being installed is matched against the signed envelope's
    ``catalog_owned[].identifier``; the entitlement is then looked up by the
    matched item's ``(kind, id)`` — which may differ from the slug (the
    platform's own fixture uses id ``bundled/mocha`` for slug ``mocha``).
    Bundled, petdex and generated pets are free by *source class* — never by a
    price a manifest carries — and a machine with no envelope at all behaves
    exactly as before the store existed (contract C3 rule 1).
    """
    from hermes_cli import atum_store_proof as store_proof

    try:
        store_proof.enforce_catalog_item("pet", slug)
    except store_proof.StoreEntitlementError as exc:
        raise PetEntitlementError(exc.code, slug, str(exc)) from exc


@dataclass(frozen=True)
class InstalledPet:
    """A pet present on disk.

    ``held`` is the Store's typed reason this pet may not be rendered
    (``purchase_required`` | ``entitlement_revoked`` |
    ``entitlement_unavailable_offline``), or ``None``. The loaders MARK it;
    the render verbs — :func:`resolve_active_pet`, ``pet.info``, ``pet.cells``,
    :func:`sheet_for`, :func:`export_pet` — refuse on it. One type, so every
    list consumer keeps working; a held pet still has a directory.
    """

    slug: str
    display_name: str
    description: str
    directory: Path
    spritesheet: Path
    created_by: str = ""  # "generator" for pets hatched locally; "" for petdex installs
    held: str | None = None
    # Drawn at the user's scale x this; from pet.json (constants.parse_size).
    size: float = 1.0
    # v4 optional rows the sheet carries, in sheet order; from pet.json
    # `extraRows` (constants.parse_extra_rows). Never inferred from height.
    extra_rows: tuple[str, ...] = ()
    # v5 is optional; absent sizes preserve every saved legacy draw scale.
    size_class: dict | None = None
    anchor: dict | None = None
    bounds: dict | None = None
    locomotion: str = "walk"

    @property
    def exists(self) -> bool:
        return self.spritesheet.is_file()

    @property
    def generated(self) -> bool:
        return self.created_by == "generator"


def pets_dir() -> Path:
    """Return the profile-scoped pets directory (created on demand)."""
    path = get_hermes_home() / "pets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def bundled_pets_dir() -> Path | None:
    """Pets that ship with the desktop app, adoptable by every profile.

    The desktop names the directory (``ATUM_BUNDLED_PETS_DIR``) because only it
    knows where its bundle lives; a bare CLI has none and gets ``None``. Nothing
    here is specific to any one pet: every ``<slug>/pet.json`` plus spritesheet
    under it is a pet, and :func:`install_pet` copies from here before it ever
    asks petdex — so what ships with the app is adoptable wherever petdex pets
    are, for any profile, without a rule naming it.
    """
    raw = os.environ.get("ATUM_BUNDLED_PETS_DIR", "").strip()
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_dir() else None


def pet_tree_sha256(directory: Path) -> str:
    """The identity hash of a pet directory.

    The content sync's canonical bundle hash when the pet is exportable — so a
    stamp on catalog or bundled content equals the hash the platform and the
    bundle carry — and otherwise a plain digest of the regular, non-dot files
    in name order. An unexportable pet (a sheet the bundle format does not
    take, an extra file) still has an identity; it just can never equal a
    catalog hash, which is right: the catalog only ships exportable pets.
    """
    import hashlib

    try:
        from hermes_cli.atum_pet_bundles import export_pet_bundle

        return export_pet_bundle(directory)["sha256"]
    except Exception:
        pass
    digest = hashlib.sha256()
    for child in sorted(directory.iterdir()):
        if child.name.startswith(".") or not child.is_file():
            continue
        digest.update(child.name.encode("utf-8") + b"\0")
        digest.update(child.read_bytes() + b"\0")
    return digest.hexdigest()


def _stamp_for(directory: Path) -> _prov.Stamp | None:
    """The pet's provenance stamp, written lazily for an unstamped directory.

    A directory with no stamp was not published by one of the four writers
    (a hand copy, or a directory this build never installed). It is identified
    by its bytes alone: equal to a shipped bundled pet -> stamped ``bundled``
    with that slug; otherwise ``personal``. Idempotent; the dotfile is the
    "done" marker, so this hashes once per directory, ever. Never consults the
    envelope: provenance says what a thing IS, the decision says whether it
    may be used — which is what lets a machine stamp offline (plan D5).
    """
    stamp = _prov.read_stamp(directory)
    if stamp is not None:
        return stamp
    try:
        digest = pet_tree_sha256(directory)
    except OSError:
        return None
    source, identifier = "personal", directory.name
    root = bundled_pets_dir()
    if root is not None and root.is_dir():
        for child in sorted(root.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            try:
                if pet_tree_sha256(child) == digest:
                    source, identifier = "bundled", child.name
                    break
            except OSError:
                continue
    stamp = _prov.make_stamp(kind="pet", source=source, identifier=identifier, tree_sha256=digest)
    try:
        _prov.write_stamp(directory, stamp)
    except OSError:
        pass  # read-only tree: decide from the in-memory stamp this time
    return stamp


# Last hold seen per directory, so a hold is logged when it CHANGES — never on
# the 3 s poll (plan D4, observability).
_last_hold: dict[str, str | None] = {}


def _hold_reason(directory: Path) -> str | None:
    """Why this pet may not be rendered, or ``None`` (plan D2/D3)."""
    from hermes_cli import atum_store_proof as store_proof

    stamp = _stamp_for(directory)
    if stamp is None or store_proof.store_epoch() is None:
        reason = None  # no envelope at all: pre-store behaviour (contract C3 rule 1)
    else:
        reason = store_proof.hold_reason("pet", stamp.catalog_identifier, sha256=stamp.tree_sha256)
    key = str(directory)
    previous = _last_hold.get(key, "unseen")
    if previous != reason:
        _last_hold[key] = reason
        if reason is not None:
            logger.info(
                "pet held: %s (%s via %s %s) -> %s",
                directory.name, stamp.identifier if stamp else "?", stamp.source if stamp else "?",
                "stamp" if stamp and stamp.catalog_identifier else "bytes", reason,
            )
        elif previous != "unseen":
            logger.info("pet released: %s", directory.name)
    return reason


def stamp_pet_staging(staging: Path, *, source: str, identifier: str) -> None:
    """Stamp a staging directory before :func:`_publish_pet_dir` — the one
    thing every writer must do, and the thing the publisher checks for."""
    digest = pet_tree_sha256(staging)
    _prov.write_stamp(staging, _prov.make_stamp(kind="pet", source=source, identifier=identifier, tree_sha256=digest))


def _pet_in(slug: str, directory: Path) -> InstalledPet | None:
    """Describe the pet in *directory*, or ``None`` if there is no sheet."""
    if not directory.is_dir():
        return None
    from agent.pet.constants import parse_anchor, parse_bounds, parse_extra_rows, parse_locomotion, parse_size, parse_size_class

    meta = _read_pet_json(directory)
    pet = InstalledPet(
        slug=slug,
        display_name=str(meta.get("displayName", "") or slug),
        description=str(meta.get("description", "") or ""),
        directory=directory,
        spritesheet=_resolve_spritesheet(directory, meta),
        created_by=str(meta.get("createdBy", "") or ""),
        size=parse_size(meta.get("size")),
        extra_rows=parse_extra_rows(meta.get("extraRows")),
        size_class=parse_size_class(meta.get("sizeClass")),
        anchor=parse_anchor(meta.get("anchor")),
        bounds=parse_bounds(meta.get("bounds")),
        locomotion=parse_locomotion(meta.get("locomotion")),
    )
    return pet if pet.exists else None


def _marked(pet: InstalledPet | None) -> InstalledPet | None:
    """The pet with its Store hold applied — the only way a profile pet leaves
    the loaders. ``installed_pets`` goes through ``load_pet``, so marking here
    covers every list consumer too."""
    if pet is None:
        return None
    held = _hold_reason(pet.directory)
    return pet if held is None else _dc_replace(pet, held=held)


def load_bundled_pet(slug: str) -> InstalledPet | None:
    """The bundled pet for *slug*, or ``None`` — never touches the pets dir."""
    root = bundled_pets_dir()
    slug = _safe_slug(slug)
    if root is None or not slug:
        return None
    return _pet_in(slug, root / slug)


def bundled_pets() -> list[InstalledPet]:
    """Every pet in the bundle, sorted by slug. Empty without a bundle."""
    root = bundled_pets_dir()
    if root is None:
        return []
    found = []
    for child in sorted(root.iterdir()):
        if child.is_dir() and not child.name.startswith("."):
            pet = _pet_in(child.name, child)
            if pet is not None:
                found.append(pet)
    return found


def _read_pet_json(directory: Path) -> dict:
    pet_json = directory / "pet.json"
    if not pet_json.is_file():
        return {}
    try:
        return json.loads(pet_json.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        logger.debug("unreadable pet.json in %s: %s", directory, exc)
        return {}


def _resolve_spritesheet(directory: Path, meta: dict) -> Path:
    """Find the spritesheet for a pet dir.

    Honors ``spritesheetPath`` from pet.json, else probes the conventional
    filenames (``spritesheet.{webp,png}`` and petdex R2's ``sprite.webp``).
    """
    declared = str(meta.get("spritesheetPath", "") or "").strip()
    if declared:
        candidate = directory / declared
        if candidate.is_file():
            return candidate
    for name in ("spritesheet.webp", "spritesheet.png", "sprite.webp", "sprite.png"):
        candidate = directory / name
        if candidate.is_file():
            return candidate
    # Default expectation even if missing, so callers get a stable path.
    return directory / "spritesheet.webp"


# One bare, lowercase path segment: what a pet directory and a cache entry are
# named. No leading dot (dotdirs under pets/ — .sheets, .thumbs, staging — are
# ours), no separators, nothing that needs normalising — and no *trailing* dot,
# because Win32 strips one from every path segment, so "mocha." would open the
# bundled "mocha" while carrying an identity the entitlement gate does not
# match.
_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,78}[a-z0-9_-]|[a-z0-9]")


def _safe_slug(slug: str) -> str:
    """Return *slug* if it already names one safe path segment, else ``""``.

    Pet slugs index into ``pets_dir()/<slug>/`` and into the thumb and sheet
    caches, so the slug *is* the item's identity. A value that is not already a
    bare segment is rejected rather than canonicalised: ``x/boba`` must not
    quietly become — and return — ``boba``, and ``..`` must not leave the pets
    directory. Case is significant (Linux is), so ``Boba`` is not ``boba``.
    """
    value = str(slug or "").strip()
    if not _SLUG_RE.fullmatch(value) or ".." in value:
        return ""
    return value


def load_pet(slug: str) -> InstalledPet | None:
    """Return the :class:`InstalledPet` for *slug*, or ``None`` if absent."""
    slug = _safe_slug(slug)
    if not slug:
        return None
    from agent.pet.constants import parse_anchor, parse_bounds, parse_extra_rows, parse_locomotion, parse_size, parse_size_class

    directory = pets_dir() / slug
    if not directory.is_dir():
        return None
    meta = _read_pet_json(directory)
    return _marked(InstalledPet(
        slug=slug,
        display_name=str(meta.get("displayName", "") or slug),
        description=str(meta.get("description", "") or ""),
        directory=directory,
        spritesheet=_resolve_spritesheet(directory, meta),
        created_by=str(meta.get("createdBy", "") or ""),
        size=parse_size(meta.get("size")),
        extra_rows=parse_extra_rows(meta.get("extraRows")),
        size_class=parse_size_class(meta.get("sizeClass")),
        anchor=parse_anchor(meta.get("anchor")),
        bounds=parse_bounds(meta.get("bounds")),
        locomotion=parse_locomotion(meta.get("locomotion")),
    ))


def installed_pets() -> list[InstalledPet]:
    """Return every installed pet (dirs containing a usable spritesheet)."""
    out: list[InstalledPet] = []
    for child in sorted(pets_dir().iterdir()):
        if not child.is_dir():
            continue
        pet = load_pet(child.name)
        if pet and pet.exists:
            out.append(pet)
    return out


def resolve_active_pet(configured_slug: str | None = None) -> InstalledPet | None:
    """Resolve which pet to display.

    Precedence: the configured slug (``display.pet.slug``) if it's installed,
    otherwise the first installed pet alphabetically, otherwise ``None``.
    """
    if configured_slug:
        pet = load_pet(configured_slug.strip())
        if pet and pet.exists:
            # A held pet is never swapped for a different one with no
            # explanation: the configured slug stays the answer, and it is
            # `None` here while `active_pet_hold` says why.
            return None if pet.held else pet
    pets = [p for p in installed_pets() if p.held is None]
    return pets[0] if pets else None


def active_pet_hold(configured_slug: str | None = None) -> InstalledPet | None:
    """The configured pet when — and only when — the Store holds it."""
    if not configured_slug:
        return None
    pet = load_pet(configured_slug.strip())
    return pet if pet and pet.exists and pet.held else None


def install_pet(slug: str, *, force: bool = False, timeout: float = _DOWNLOAD_TIMEOUT) -> InstalledPet:
    """Download *slug* from the manifest into the pets directory.

    Idempotent: a fully-installed pet is returned as-is unless *force*.  Raises
    :class:`PetStoreError` / :class:`~agent.pet.manifest.ManifestError` on
    failure.
    """
    from agent.pet.manifest import find_entry

    slug = _safe_slug(slug)
    if not slug:
        raise PetStoreError("invalid pet slug")
    # Gate every select of a catalog-owned pet — including one already on
    # disk, since install_pet's early return is also pet.select's activation.
    _enforce_catalog_pet(slug)
    existing = load_pet(slug)
    if existing and existing.exists and not force:
        return existing

    # An install is built in a staging directory beside the pets, checked there,
    # and only then made the pet — one rename, so the profile never holds a
    # half-copied pet or a new pet.json over an old sheet. One installer per
    # slug per profile: a second request for the same pet waits, then finds it.
    with _install_lock(slug):
        existing = load_pet(slug)
        if existing and existing.exists and not force:
            return existing
        staging = _staging_dir(slug)
        try:
            # What ships with the app is installed by copying, before the
            # network is ever consulted: the same one call that adopts a petdex
            # pet adopts a bundled one, for whichever profile is asking.
            bundled = load_bundled_pet(slug)
            if bundled is not None:
                shutil.copytree(bundled.directory, staging, dirs_exist_ok=True)
                if not _staged_pet_ok(slug, staging):
                    raise PetStoreError(f"install of bundled '{slug}' did not produce a spritesheet")
                stamp_pet_staging(staging, source="bundled", identifier=slug)
            else:
                entry = find_entry(slug, timeout=timeout)
                if entry is None:
                    raise PetStoreError(f"pet '{slug}' is not in the petdex manifest")

                # Host-pin every asset URL to petdex. The manifest is trusted
                # (HTTPS from petdex.dev), but pin the asset hosts too so a
                # compromised/spoofed manifest can't redirect the download at
                # an arbitrary host. Matches thumbnail_png and sheet_for.
                if not _is_petdex_host(entry.spritesheet_url):
                    raise PetStoreError(f"refusing non-petdex spritesheet host for '{slug}'")

                staging.mkdir(parents=True, exist_ok=True)
                sprite_ext = ".png" if entry.spritesheet_url.lower().split("?")[0].endswith(".png") else ".webp"
                sprite_path = staging / f"spritesheet{sprite_ext}"
                _download(entry.spritesheet_url, sprite_path, timeout=timeout)

                # Fetch the upstream pet.json if present; otherwise synthesize a
                # minimal one so the local layout is self-describing.
                meta: dict = {}
                if entry.pet_json_url and _is_petdex_host(entry.pet_json_url):
                    try:
                        meta = _download_json(entry.pet_json_url, timeout=timeout)
                    except Exception as exc:
                        logger.debug("pet.json fetch failed for %s: %s", slug, exc)
                if not isinstance(meta, dict) or not meta:
                    meta = {"id": slug, "displayName": entry.display_name, "description": ""}
                meta["spritesheetPath"] = sprite_path.name
                meta.setdefault("id", slug)
                meta.setdefault("displayName", entry.display_name)
                (staging / "pet.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                if not _staged_pet_ok(slug, staging):
                    raise PetStoreError(f"install of '{slug}' did not produce a spritesheet")

            if _prov.read_stamp(staging) is None:
                stamp_pet_staging(staging, source="petdex", identifier=slug)
            _publish_pet_dir(staging, pets_dir() / slug)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    pet = load_pet(slug)
    if pet is None or not pet.exists:
        raise PetStoreError(f"install of '{slug}' did not produce a spritesheet")
    return pet


_install_locks: dict[str, threading.Lock] = {}
_install_locks_guard = threading.Lock()


def _install_lock(slug: str) -> threading.Lock:
    """The one lock for installing *slug* into this profile's pets dir."""
    key = f"{pets_dir()}::{slug}"
    with _install_locks_guard:
        lock = _install_locks.get(key)
        if lock is None:
            lock = _install_locks[key] = threading.Lock()
        return lock


def _staging_dir(slug: str) -> Path:
    """A fresh, private build directory beside the pets. A dotdir: never a pet."""
    return pets_dir() / f".staging-{slug}-{uuid.uuid4().hex}"


def _staged_pet_ok(slug: str, staging: Path) -> bool:
    """True when *staging* holds a pet that would load: metadata plus a sheet.

    Bytes from the network were already checked as an image by ``_download``;
    a bundled sheet ships with the app and is copied, never decoded, here.
    """
    pet = _pet_in(slug, staging)
    return pet is not None and pet.exists


def sweep_stale_staging(*, max_age_s: float = 86400.0) -> int:
    """Remove `.staging-*` / `.old-*` directories older than *max_age_s*.

    A crash between staging and publish leaves one behind; nothing ever lists
    them as pets, but they are disk. Returns how many were removed."""
    import time

    removed = 0
    try:
        now = time.time()
        for child in pets_dir().iterdir():
            if child.is_dir() and child.name.startswith((".staging-", ".old-")) and now - child.stat().st_mtime > max_age_s:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
    except OSError as exc:
        logger.debug("staging sweep failed: %s", exc)
    return removed


class SlugTakenError(PetStoreError):
    """The destination already holds a pet and the caller did not mean to
    replace it — another process got there first. Pick the next slug."""


def _publish_pet_dir(staging: Path, dest: Path, *, replace: bool = True) -> None:
    """Make *staging* the pet at *dest* in one rename.

    With *replace* (an install or a forced reinstall), an existing *dest* is
    moved aside first and removed only once the new directory is in place; if
    the rename fails, it is put back, so a failed replacement never costs the
    pet that was there. Without it (a hatch, which owns a *new* slug), an
    occupied *dest* is refused as :class:`SlugTakenError` — the rename onto
    an existing directory fails atomically at the filesystem, so two
    processes sharing one pets directory cannot publish over each other even
    though the in-process reservation cannot see the other process.
    """
    if _prov.read_stamp(staging) is None:
        # API shape, not convention: no writer can publish a pet the gate
        # cannot identify. Stamp with :func:`stamp_pet_staging` first.
        raise PetStoreError(f"refusing to publish {dest.name}: staging directory has no provenance stamp")
    old: Path | None = None
    if dest.exists():
        if not replace:
            raise SlugTakenError(f"a pet already lives at {dest.name}")
        old = dest.with_name(f".old-{dest.name}-{uuid.uuid4().hex}")
        dest.rename(old)
    try:
        staging.rename(dest)
    except OSError as exc:
        if old is not None:
            old.rename(dest)
            raise
        if not replace and (dest.exists() or getattr(exc, "errno", None) in (17, 39, 66)):  # EEXIST, ENOTEMPTY, (BSD) ENOTEMPTY
            raise SlugTakenError(f"a pet already lives at {dest.name}") from exc
        raise
    if old is not None:
        shutil.rmtree(old, ignore_errors=True)


def slugify(name: str) -> str:
    """Lowercase, hyphenate, and strip a display name into a filesystem slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    return slug or "pet"


def unique_slug(name: str) -> str:
    """A :func:`slugify` result that doesn't collide with an existing pet dir.

    A snapshot, not a claim: two callers can be handed the same slug. A path
    that publishes should :func:`reserve_unique_slug` instead."""
    base = slugify(name)
    slug = base
    counter = 2
    reserved = _store_reserved_slugs()
    while (pets_dir() / slug).exists() or slug in reserved or _slug_is_reserved(slug):
        slug = f"{base}-{counter}"
        counter += 1
    return slug


def _store_reserved_slugs() -> set[str]:
    """Slugs a locally generated pet must not take.

    A bundled slug is a Store identity: the entitlement gate matches a pet by
    slug, so a generated pet handed one would be refused as the catalog's pet.
    Both slug choosers consult this — :func:`unique_slug` and, more importantly,
    :func:`reserve_unique_slug`, which is what the hatch and generate paths
    actually publish through.
    """
    return {pet.slug for pet in bundled_pets()}


_slug_guard = threading.Lock()
_reserved_slugs: set[str] = set()


def _slug_key(slug: str) -> str:
    return f"{pets_dir()}::{slug}"


def _slug_is_reserved(slug: str) -> bool:
    with _slug_guard:
        return _slug_key(slug) in _reserved_slugs


def reserve_unique_slug(name: str) -> str:
    """A slug no pet has *and* nobody else is about to publish.

    Two simultaneous hatches of "Snow" get ``snow`` and ``snow-2``, not the
    same slug and a silent replacement. Held until :func:`release_slug`."""
    base = slugify(name)
    reserved = _store_reserved_slugs()
    with _slug_guard:
        slug = base
        counter = 2
        while (pets_dir() / slug).exists() or slug in reserved or _slug_key(slug) in _reserved_slugs:
            slug = f"{base}-{counter}"
            counter += 1
        _reserved_slugs.add(_slug_key(slug))
        return slug


def release_slug(slug: str) -> None:
    with _slug_guard:
        _reserved_slugs.discard(_slug_key(slug))


def _write_spritesheet(source, dest: Path) -> None:
    """Write *source* (PIL image, bytes, or path) as a lossless WebP at *dest*."""
    if isinstance(source, (bytes, bytearray)):
        dest.write_bytes(bytes(source))
        return

    from PIL import Image

    if isinstance(source, (str, Path)):
        with Image.open(source) as opened:
            image = opened.convert("RGBA")
    else:
        image = source.convert("RGBA")
    image.save(dest, format="WEBP", lossless=True, quality=100, method=6, exact=True)


def register_local_pet(
    spritesheet,
    *,
    slug: str,
    display_name: str = "",
    description: str = "",
    replace: bool = True,
) -> InstalledPet:
    """Write a locally-generated pet into the store and return it.

    *spritesheet* may be a PIL image, raw WebP/PNG bytes, or a path. The pet
    appears in :func:`installed_pets` immediately, and because :func:`install_pet`
    returns an already-on-disk pet before consulting the manifest, it can be
    adopted (``pet.select`` / ``/pet <slug>``) without a manifest entry.

    Staged beside the pets and published by one rename. With ``replace=False``
    (a hatch that owns a new slug) an occupied slug is :class:`SlugTakenError`
    and nothing is overwritten.
    """
    slug = slugify(slug)
    directory = pets_dir() / slug
    staging = _staging_dir(slug)
    staging.mkdir(parents=True, exist_ok=True)
    sprite_path = staging / "spritesheet.webp"
    try:
        try:
            _write_spritesheet(spritesheet, sprite_path)
        except Exception as exc:
            raise PetStoreError(f"could not write spritesheet for '{slug}': {exc}") from exc

        meta = {
            "id": slug,
            "displayName": display_name or slug,
            "description": description or "",
            "spritesheetPath": sprite_path.name,
            "createdBy": "generator",
        }
        (staging / "pet.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        stamp_pet_staging(staging, source="personal", identifier=slug)
        _publish_pet_dir(staging, directory, replace=replace)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    pet = load_pet(slug)
    if pet is None or not pet.exists:
        raise PetStoreError(f"register of generated pet '{slug}' did not produce a spritesheet")
    return pet


def export_pet(slug: str) -> tuple[str, bytes]:
    """Zip an installed pet's folder (pet.json + spritesheet) → (filename, bytes).

    Dotfiles (cached thumbs, backups) are skipped so the archive is a clean,
    re-importable pet package. Raises :class:`PetStoreError` if not installed.
    """
    import io
    import zipfile

    root = pets_dir()
    directory = root / slug.strip()
    # Guard against traversal: the target must be a direct child of pets_dir.
    if directory.resolve().parent != root.resolve() or not directory.is_dir():
        raise PetStoreError(f"pet '{slug}' is not installed")
    held = _hold_reason(directory)
    if held is not None:
        raise PetStoreError(f"{held}: '{slug}' is a Store pet this account has not acquired")

    name = directory.name
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.iterdir()):
            if path.is_file() and not path.name.startswith("."):
                archive.write(path, f"{name}/{path.name}")
    return f"{name}.zip", buf.getvalue()


_THUMB_FRAME_W = 192
_THUMB_FRAME_H = 208
_THUMB_W = 96  # rendered ~40px; 2x+ keeps it crisp on HiDPI


def _thumbs_dir() -> Path:
    path = pets_dir() / ".thumbs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sheets_dir() -> Path:
    """Spritesheets fetched for pets this profile has *not* installed, so the
    store can animate a card before anyone adopts. A cache, not an install:
    ``installed_pets`` never lists these, and ``pets_dir`` dotdirs are skipped."""
    path = pets_dir() / ".sheets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def sheet_for(slug: str, *, source_url: str = "", timeout: float = 30.0) -> InstalledPet | None:
    """A renderable pet for *slug* without installing it.

    Source preference: installed here, then bundled with the app, then a petdex
    sheet fetched once into the sheet cache — and only from petdex, the same
    host pin ``thumbnail_png`` applies, so the gateway never fetches an
    arbitrary client-supplied URL. ``None`` when nothing usable exists.
    """
    slug = _safe_slug(slug)
    if not slug:
        return None
    pet = load_pet(slug)
    if pet is not None and pet.held:
        return None
    if pet and pet.exists:
        return pet
    bundled = load_bundled_pet(slug)
    if bundled is not None:
        return bundled
    if not source_url or not _is_petdex_host(source_url):
        return None
    ext = ".png" if source_url.lower().split("?")[0].endswith(".png") else ".webp"
    cached = _sheets_dir() / f"{slug}{ext}"
    if not cached.is_file():
        try:
            _download(source_url, cached, timeout=timeout)
        except Exception as exc:
            logger.debug("sheet fetch failed for %s: %s", slug, exc)
            return None
    return InstalledPet(slug=slug, display_name=slug, description="", directory=_sheets_dir(), spritesheet=cached)


def _is_petdex_host(url: str) -> bool:
    """True only for petdex.dev hosts — bounds server-side fetch (anti-SSRF)."""
    from urllib.parse import urlparse

    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "petdex.dev" or host.endswith(".petdex.dev")


def thumbnail_png(slug: str, *, source_url: str = "", timeout: float = 30.0) -> bytes | None:
    """Return a small idle-frame PNG for *slug*, cached on disk.

    Crops the top-left (idle, frame 0) cell of the spritesheet and downsamples
    it to a thumbnail. Source preference: an installed spritesheet on disk, else
    *source_url* — but only when it points at petdex (so the gateway never
    fetches an arbitrary client-supplied URL). Returns ``None`` when there's no
    usable source or Pillow/network fails; callers render a placeholder.

    Doing this server-side sidesteps the renderer's CSP / R2 hotlink limits that
    break a direct ``<img src=cdn>`` and lets the result ride the authenticated
    gateway as a same-origin data URL.
    """
    # The slug names the cache file: one bare segment or nothing, like every
    # other place a slug touches the disk.
    slug = _safe_slug(slug)
    if not slug:
        return None

    cache = _thumbs_dir() / f"{slug}.png"
    if cache.is_file():
        try:
            return cache.read_bytes()
        except OSError:
            pass

    sheet_bytes: bytes | None = None
    pet = load_pet(slug)
    if pet and pet.exists:
        try:
            sheet_bytes = pet.spritesheet.read_bytes()
        except OSError:
            sheet_bytes = None

    if sheet_bytes is None:
        # Not installed for this profile yet, but shipped with the app: the
        # catalog can still show its face.
        bundled = load_bundled_pet(slug)
        if bundled is not None:
            try:
                sheet_bytes = bundled.spritesheet.read_bytes()
            except OSError:
                sheet_bytes = None

    if sheet_bytes is None and source_url and _is_petdex_host(source_url):
        try:
            sheet_bytes = _fetch_bytes(source_url, timeout=timeout)
            _assert_sheet_bytes(sheet_bytes)
        except Exception as exc:
            logger.debug("thumb fetch failed for %s: %s", slug, exc)
            sheet_bytes = None

    if not sheet_bytes:
        return None

    try:
        import io

        from PIL import Image

        with Image.open(io.BytesIO(sheet_bytes)) as im:
            frame = im.convert("RGBA").crop(
                (0, 0, min(_THUMB_FRAME_W, im.width), min(_THUMB_FRAME_H, im.height))
            )
            height = round(_THUMB_W * _THUMB_FRAME_H / _THUMB_FRAME_W)
            frame = frame.resize((_THUMB_W, height), Image.NEAREST)
            buf = io.BytesIO()
            frame.save(buf, format="PNG")
            data = buf.getvalue()
    except Exception as exc:
        logger.debug("thumb crop failed for %s: %s", slug, exc)
        return None

    try:
        cache.write_bytes(data)
    except OSError:
        pass
    return data


def remove_pet(slug: str) -> bool:
    """Delete an installed pet directory.  Returns True if anything was removed."""
    import shutil

    slug = _safe_slug(slug)
    if not slug:
        return False

    # The cached thumbnail lives in pets/.thumbs/<slug>.png — OUTSIDE the pet
    # dir, so rmtree won't catch it. Drop it too, or a later pet that reuses this
    # slug renders this one's stale thumbnail.
    try:
        (_thumbs_dir() / f"{slug}.png").unlink(missing_ok=True)
    except OSError:
        pass

    directory = pets_dir() / slug
    if not directory.is_dir():
        return False
    shutil.rmtree(directory, ignore_errors=True)
    return not directory.exists()


def rename_pet(slug: str, display_name: str) -> str | None:
    """Rename a pet's ``displayName`` AND realign its slug/dir to match.

    Generated pets are hatched under a provisional, prompt-derived slug; when
    the user names the pet on the reveal screen we make that name the real
    identity so lists/subtitles show what they typed, not the prompt. The dir is
    renamed to ``slugify(name)`` (and the cached thumbnail moved alongside it)
    whenever that yields a free, different slug — otherwise the slug is left as
    is. Returns the resulting slug on success, or ``None`` on failure.
    """
    slug = _safe_slug(slug)
    display_name = (display_name or "").strip()
    if not slug or not display_name:
        return None
    directory = pets_dir() / slug
    pet_json = directory / "pet.json"
    if not pet_json.is_file():
        return None
    try:
        meta = json.loads(pet_json.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    meta["displayName"] = display_name

    new_slug = slug
    desired = slugify(display_name)
    if desired and desired != slug and not (pets_dir() / desired).exists():
        try:
            directory.rename(pets_dir() / desired)
            try:
                (_thumbs_dir() / f"{slug}.png").rename(_thumbs_dir() / f"{desired}.png")
            except OSError:
                pass
            directory = pets_dir() / desired
            pet_json = directory / "pet.json"
            new_slug = desired
            meta["id"] = new_slug
        except OSError:
            new_slug = slug  # keep the provisional slug if the move fails

    try:
        pet_json.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    except OSError:
        return None
    return new_slug


# What the gateway will fetch on a client's or a manifest's say-so: petdex over
# HTTPS, every hop, a bounded body, and a file that decodes as a sheet. The
# host pin is only a boundary if a redirect cannot step over it.
_MAX_SHEET_BYTES = 16 * 1024 * 1024
_MAX_JSON_BYTES = 1024 * 1024
_MAX_MANIFEST_BYTES = 16 * 1024 * 1024
_MAX_REDIRECTS = 5
_MAX_SHEET_SIDE = 8192
_USER_AGENT = {"User-Agent": "hermes-agent-petdex"}
# Tests hand in an ``httpx.MockTransport``; production leaves it ``None``.
_http_transport = None


def _assert_pinned(url: str) -> None:
    from urllib.parse import urlparse

    if urlparse(url).scheme != "https" or not _is_petdex_host(url):
        raise PetStoreError(f"refusing to fetch outside petdex over HTTPS: {url}")


def _fetch_bytes(url: str, *, timeout: float, limit: int = _MAX_SHEET_BYTES) -> bytes:
    """GET *url* with every redirect hop pinned to petdex and the body capped."""
    import httpx

    with httpx.Client(timeout=timeout, follow_redirects=False, headers=_USER_AGENT, transport=_http_transport) as client:
        for _hop in range(_MAX_REDIRECTS + 1):
            _assert_pinned(url)
            with client.stream("GET", url) as resp:
                if resp.is_redirect:
                    location = resp.headers.get("location", "")
                    if not location:
                        raise PetStoreError(f"redirect without a location from {url}")
                    url = str(resp.url.join(location))
                    continue
                resp.raise_for_status()
                declared = resp.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > limit:
                    raise PetStoreError(f"response too large from {url}: {declared} bytes")
                body = bytearray()
                for chunk in resp.iter_bytes():
                    body += chunk
                    if len(body) > limit:
                        raise PetStoreError(f"response too large from {url}: over {limit} bytes")
                return bytes(body)
    raise PetStoreError(f"too many redirects from {url}")


def _assert_sheet_bytes(data: bytes) -> None:
    """*data* must decode as a PNG or WebP of sane dimensions."""
    import io

    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt = (im.format or "").upper()
            width, height = im.size
    except Exception as exc:
        raise PetStoreError(f"not a spritesheet: {exc}") from exc
    if fmt not in ("PNG", "WEBP"):
        raise PetStoreError(f"not a spritesheet: {fmt or 'unknown'} format")
    if width < 1 or height < 1 or width > _MAX_SHEET_SIDE or height > _MAX_SHEET_SIDE:
        raise PetStoreError(f"not a spritesheet: {width}x{height}")


def _download(url: str, dest: Path, *, timeout: float) -> None:
    """Fetch a spritesheet to *dest*: checked before it exists, written in one move."""
    try:
        data = _fetch_bytes(url, timeout=timeout)
        _assert_sheet_bytes(data)
    except PetStoreError:
        raise
    except Exception as exc:
        raise PetStoreError(f"download failed for {url}: {exc}") from exc
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{dest.name}.", dir=dest.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, dest)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise PetStoreError(f"could not write {dest}: {exc}") from exc


def _download_json(url: str, *, timeout: float) -> dict:
    data = json.loads(_fetch_bytes(url, timeout=timeout, limit=_MAX_JSON_BYTES).decode("utf-8"))
    return data if isinstance(data, dict) else {}
