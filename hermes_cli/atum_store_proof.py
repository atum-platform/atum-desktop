'Verification of the platform-signed Atum Store entitlement envelope.\n\nPlan  decisions 7 and 8, amended by the\nimplementation review ():\nthe platform signs a version-3 Ed25519 envelope {v, account_id, issued_at,\nexpires_at, key_id, entitlements, catalog_owned, signature} and the desktop\nstores it verbatim at <hermes state root>/atum-store/entitlement-proof.json\n(mode 0600).  There is exactly one store file: catalog-owned.json is gone —\n"is this item paid?" comes only from the envelope\'s signed catalog_owned,\nwhich lists every catalog item in every state (listed, delisted, draft), so a\ndelisting never makes an item free and a refund never reactivates one.\n\nHermes pins the platform\'s public key, verifies the signature over the\ncanonical JSON of the envelope without its signature field, and enforces\nthe result at every activation chokepoint through :func:`enforce_catalog_item`\n(pet install/select, do_install and every skill-install path above it, and\ndefinition materialisation).  The decision, stated once (contract C3):\n\n1. No envelope file at all -> pre-store behaviour: allow.\n2. Envelope present but unusable (bad signature, unknown key_id,\n   v != 2, expired, malformed) -> every item named in its catalog_owned\n   is unavailable (entitlement_unavailable_offline).  When the file cannot\n   be parsed at all, the last valid envelope seen for the same path still\n   names the catalog items; with neither, fall back to rule 1.\n3. Envelope valid but account_id is not the current account ->\n   catalog items are refused with entitlement_unavailable_offline.  The\n   account check runs at every chokepoint: callers that hold a main-issued\n   account id pass it explicitly (portability tickets); the others are bound\n   by location — the account-scoped Hermes root is\n   <accounts>/<accountKey>/hermes where accountKey is the desktop\'s\n   accountKeyFor(account_id) digest, so an envelope planted from another\n   account fails the digest comparison.\n4. Envelope valid and correct account: an identifier absent from\n   catalog_owned is free; otherwise the entitlement for the matched\n   item\'s (kind, id) decides — active installs, revoked refuses\n   with entitlement_revoked, absent refuses with purchase_required.\n\nCanonicalisation is owned by the platform route\n(apps/shell/.../api/desktop/v1/_lib/store-entitlement-proof.ts); for the\nvalue types the envelope carries (ASCII keys; strings, integers, and\narrays/objects of those) json.dumps(payload, sort_keys=True,\nseparators=(",", ":"), ensure_ascii=False).encode("utf-8") reproduces the\nsigned bytes exactly.\n\nNothing in this module ever logs the envelope, the signature, or key material.\n'

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# W5.3 typed refusal codes ().
PURCHASE_REQUIRED = "purchase_required"
ENTITLEMENT_UNAVAILABLE_OFFLINE = "entitlement_unavailable_offline"
ENTITLEMENT_REVOKED = "entitlement_revoked"
ASSET_UNAVAILABLE_OFFLINE = "asset_unavailable_offline"
UNSUPPORTED_PRICE = "unsupported_price"

# Why a stored envelope is unusable.  Callers map every one of these to
# ENTITLEMENT_UNAVAILABLE_OFFLINE at a chokepoint: the item is unavailable,
# never free (plan decision 8).
PROOF_MISSING = "missing"
PROOF_UNREADABLE = "unreadable"
PROOF_MALFORMED = "malformed"
PROOF_UNSUPPORTED_VERSION = "unsupported_version"
PROOF_EXPIRED = "expired"
PROOF_ACCOUNT_MISMATCH = "account_mismatch"
PROOF_UNKNOWN_KEY = "unknown_key"
PROOF_BAD_SIGNATURE = "bad_signature"

# The only envelope version this gateway accepts.
ENVELOPE_VERSION = 3


class StoreEntitlementError(RuntimeError):
    """A catalog-owned item may not be activated; ``code`` is a W5.3 typed error."""

    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        super().__init__(f"{code}: {message}" if message else code)


# ---------------------------------------------------------------------------
# Pinned platform public keys (plan decision 7).
#
# Maps ``key_id`` -> base64url of the raw 32-byte Ed25519 public key.  A
# release updates this mapping.  Rotation: pin the incoming key beside the
# outgoing one so envelopes signed by either verify during the overlap window,
# switch the platform to the new ``key_id``, then drop the old entry in a
# later release.  Without a pinned key every envelope reports
# PROOF_UNKNOWN_KEY and catalog items stay unavailable.
PINNED_PUBLIC_KEYS: dict[str, str] = {
    # atum-prod, provisioned 2026-09-12 ().
    "k1": "5dbLjCPWI0M9kpSLN6d7xtqHdCv8Wwb8xiB-BlS4PLE",
}

# Development-only escape hatch, never set by a shipped build:
# ``ATUM_STORE_DEV_ENTITLEMENT_PUBLIC_KEY="<key_id>:<base64url raw public key>"``.
_DEV_KEY_ENV = "ATUM_STORE_DEV_ENTITLEMENT_PUBLIC_KEY"

_KEY_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,32}\Z")
_B64URL_RE = re.compile(r"[A-Za-z0-9_-]+\Z")
_HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
_ACCOUNT_KEY_RE = re.compile(r"[0-9a-f]{64}\Z")
_MAX_ENTITLEMENTS = 4096
_MAX_CATALOG_ITEMS = 65536
_MAX_ITEM_HASHES = 1024

# The desktop's AccountRootAuthority names each account root
# ``sha256("atum-account-root-v1\0" + account_id)`` and puts the account-scoped
# Hermes home at ``<accounts>/<accountKey>/hermes``
# (apps/desktop/electron/atum-messaging/account-roots.ts).  A backend scoped to
# that home can therefore verify — without ever being told the account id —
# that a stored envelope belongs to the account whose root it sits in.
_ACCOUNT_KEY_DOMAIN = b"atum-account-root-v1\x00"


def store_dir(account_root: Path | None = None) -> Path:
    """``<hermes state root>/atum-store`` — the one location of the proof file.

    The state root is the account-scoped Hermes home the desktop passes as
    ``HERMES_HOME`` (the same root portability tickets live under).
    Portability callers hold it and pass it explicitly; everything else
    resolves this backend's root.
    """
    if account_root is None:
        from hermes_constants import get_default_hermes_root

        account_root = get_default_hermes_root()
    return Path(account_root) / "atum-store"


def _b64url_decode(encoded: str) -> bytes | None:
    if not _B64URL_RE.fullmatch(encoded):
        return None
    try:
        return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except (binascii.Error, ValueError):
        return None


def _verification_key(key_id: str) -> Ed25519PublicKey | None:
    encoded = PINNED_PUBLIC_KEYS.get(key_id, "")
    # The dev override exists for the window before any key is pinned. Once a
    # build pins keys, an envelope naming a key_id that is NOT pinned must be
    # unknown — never resolved through an environment variable. Otherwise any
    # process on the machine can mint a key, set the variable, and forge
    # *active* entitlements (which also flips the sync's catalog classification),
    # which is a grant, not the "use your own bytes" power decision 7 accepts.
    if not encoded and PINNED_PUBLIC_KEYS:
        return None
    if not encoded:
        override = os.environ.get(_DEV_KEY_ENV, "").strip()
        dev_id, separator, dev_key = override.partition(":")
        if not separator or dev_id != key_id:
            return None
        encoded = dev_key.strip()
    raw = _b64url_decode(encoded)
    if raw is None or len(raw) != 32:
        return None
    try:
        return Ed25519PublicKey.from_public_bytes(raw)
    except ValueError:
        return None


def _validate_catalog_owned(value: Any) -> list[dict[str, Any]] | None:
    """Shape-validate the signed ``catalog_owned`` list, preserving order.

    List order and hash order are part of the signed bytes, so validated
    entries keep the parsed arrays verbatim.
    """
    if not isinstance(value, list) or len(value) > _MAX_CATALOG_ITEMS:
        return None
    entries: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"kind", "id", "identifier", "hashes", "delivery"}:
            return None
        kind, item_id, identifier, hashes = item["kind"], item["id"], item["identifier"], item["hashes"]
        if item["delivery"] not in ("cloud", "local") or (kind != "skill" and item["delivery"] != "local"):
            return None
        if not isinstance(kind, str) or not kind or len(kind) > 32:
            return None
        if not isinstance(item_id, str) or not item_id or len(item_id) > 256:
            return None
        if not isinstance(identifier, str) or not identifier or len(identifier) > 256:
            return None
        if not isinstance(hashes, list) or len(hashes) > _MAX_ITEM_HASHES:
            return None
        for digest in hashes:
            if not isinstance(digest, str) or not _HASH_RE.fullmatch(digest):
                return None
        entries.append({"kind": kind, "id": item_id, "identifier": identifier, "hashes": list(hashes), "delivery": item["delivery"]})
    return entries


def _validate_envelope(value: Any) -> dict[str, Any] | None:
    """Shape-validate an agent-scoped v3 envelope without legacy grants."""
    if not isinstance(value, dict) or set(value) != {
        "v",
        "account_id",
        "issued_at",
        "expires_at",
        "key_id",
        "entitlements",
        "catalog_owned",
        "signature",
    }:
        return None
    if type(value["v"]) is not int or value["v"] != ENVELOPE_VERSION:
        return None
    account_id = value["account_id"]
    if not isinstance(account_id, str) or not account_id.strip():
        return None
    issued_at, expires_at = value["issued_at"], value["expires_at"]
    if type(issued_at) is not int or type(expires_at) is not int or issued_at < 0 or expires_at < 0:
        return None
    key_id = value["key_id"]
    if not isinstance(key_id, str) or not _KEY_ID_RE.fullmatch(key_id):
        return None
    signature = value["signature"]
    if not isinstance(signature, str):
        return None
    raw_signature = _b64url_decode(signature)
    if raw_signature is None or len(raw_signature) != 64:
        return None
    entitlements = value["entitlements"]
    if not isinstance(entitlements, list) or len(entitlements) > _MAX_ENTITLEMENTS:
        return None
    entries: list[dict[str, Any]] = []
    for entry in entitlements:
        if not isinstance(entry, dict) or set(entry) != {
            "kind", "id", "state", "assistant_id", "assistant_identity_id"
        }:
            return None
        kind, item_id, state = entry["kind"], entry["id"], entry["state"]
        if not isinstance(kind, str) or not isinstance(item_id, str) or state not in ("active", "revoked"):
            return None
        if not kind or not item_id or len(kind) > 32 or len(item_id) > 256:
            return None
        assistant_id, identity_id = entry["assistant_id"], entry["assistant_identity_id"]
        for identifier in (assistant_id, identity_id):
            if identifier is not None and (not isinstance(identifier, str) or not re.fullmatch(
                r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", identifier
            )):
                return None
        if kind == "skill" and (assistant_id is None or identity_id is None):
            return None
        if kind == "pet" and (assistant_id is not None or identity_id is not None):
            return None
        entries.append(dict(entry))
    catalog_owned = _validate_catalog_owned(value["catalog_owned"])
    if catalog_owned is None:
        return None
    return {
        "v": ENVELOPE_VERSION,
        "account_id": account_id,
        "issued_at": issued_at,
        "expires_at": expires_at,
        "key_id": key_id,
        "entitlements": entries,
        "catalog_owned": catalog_owned,
        "signature": signature,
    }


def _canonical_payload(envelope: dict[str, Any]) -> bytes:
    """The exact signed bytes: canonical JSON of the envelope minus ``signature``."""
    payload = {field: envelope[field] for field in envelope if field != "signature"}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _verify_envelope_file(path: Path) -> tuple[dict[str, Any] | None, str]:
    """Verify everything but expiry/account: ``(envelope, "")`` or ``(None, reason)``."""
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return None, PROOF_UNREADABLE
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None, PROOF_MALFORMED
    if isinstance(parsed, dict) and "v" in parsed and parsed["v"] != ENVELOPE_VERSION:
        return None, PROOF_UNSUPPORTED_VERSION
    envelope = _validate_envelope(parsed)
    if envelope is None:
        return None, PROOF_MALFORMED
    key = _verification_key(envelope["key_id"])
    if key is None:
        return None, PROOF_UNKNOWN_KEY
    signature = _b64url_decode(envelope["signature"])
    if signature is None:
        return None, PROOF_MALFORMED
    try:
        key.verify(signature, _canonical_payload(envelope))
    except InvalidSignature:
        return None, PROOF_BAD_SIGNATURE
    return envelope, ""


# Verified envelopes are cached by (path, mtime, size) so a chokepoint never
# re-verifies Ed25519 on every call; expiry and account checks are per-call.
_envelope_cache: dict[tuple[str, int, int], tuple[dict[str, Any] | None, str]] = {}
# The last envelope that verified at each path.  When the current file cannot
# be parsed at all, this still names the catalog items that must fail closed
# (contract C3 rule 2); it is never used to *grant* anything.
_last_valid_envelope: dict[str, dict[str, Any]] = {}
# Best-effort catalog sets extracted from unusable envelope files.
_unusable_catalog_cache: dict[tuple[str, int, int], list[dict[str, Any]]] = {}
_cache_lock = threading.Lock()


def _reset_caches() -> None:
    """Drop cached verification results (tests; account changes rewrite the file)."""
    with _cache_lock:
        _envelope_cache.clear()
        _last_valid_envelope.clear()
        _unusable_catalog_cache.clear()


def _verified_envelope(store: Path) -> tuple[dict[str, Any] | None, str]:
    path = store / "entitlement-proof.json"
    try:
        if path.is_symlink() or not path.is_file():
            return None, PROOF_MISSING
        stat = path.stat()
    except OSError:
        return None, PROOF_UNREADABLE
    cache_key = (str(path), stat.st_mtime_ns, stat.st_size)
    with _cache_lock:
        cached = _envelope_cache.get(cache_key)
    if cached is None:
        cached = _verify_envelope_file(path)
        with _cache_lock:
            _envelope_cache[cache_key] = cached
            if cached[0] is not None:
                _last_valid_envelope[str(path)] = cached[0]
    return cached


def _lenient_catalog_items(parsed: Any) -> list[dict[str, Any]]:
    """Best-effort ``catalog_owned`` extraction from an unverifiable envelope.

    Used only to fail *closed*: items named here are treated as unavailable.
    Nothing here can grant an install.  Bad entries are skipped rather than
    poisoning the whole list.
    """
    if not isinstance(parsed, dict):
        return []
    raw = parsed.get("catalog_owned")
    if not isinstance(raw, list):
        return []
    items: list[dict[str, Any]] = []
    for entry in raw[:_MAX_CATALOG_ITEMS]:
        if not isinstance(entry, dict):
            continue
        kind, item_id, identifier = entry.get("kind"), entry.get("id"), entry.get("identifier")
        if not (isinstance(kind, str) and kind and isinstance(item_id, str) and item_id):
            continue
        if not (isinstance(identifier, str) and identifier):
            continue
        raw_hashes = entry.get("hashes")
        hashes = (
            [d for d in raw_hashes if isinstance(d, str) and _HASH_RE.fullmatch(d)]
            if isinstance(raw_hashes, list)
            else []
        )
        items.append({"kind": kind, "id": item_id, "identifier": identifier, "hashes": hashes})
    return items


def _unusable_catalog_items(store: Path) -> list[dict[str, Any]]:
    """Catalog items named by an envelope we cannot verify (contract C3 rule 2).

    Whatever the current file claims (read leniently, fail-closed) plus
    whatever the last valid envelope at this path named.
    """
    path = store / "entitlement-proof.json"
    items: list[dict[str, Any]] = []
    try:
        stat = path.stat()
        cache_key = (str(path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        cache_key = None
    if cache_key is not None:
        with _cache_lock:
            cached = _unusable_catalog_cache.get(cache_key)
        if cached is None:
            try:
                parsed: Any = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                parsed = None
            cached = _lenient_catalog_items(parsed)
            with _cache_lock:
                _unusable_catalog_cache[cache_key] = cached
        items.extend(cached)
    with _cache_lock:
        last_valid = _last_valid_envelope.get(str(path))
    if last_valid is not None:
        items.extend(last_valid["catalog_owned"])
    return items


def normalised_identifier(identifier: str) -> str:
    """An install identifier reduced to the one spelling the catalog uses.

    A catalog identifier is a hub path (``official/creative/pixel-art``) or a
    pet slug, both lowercase and without redundant segments.  The *caller's*
    spelling is not: the re-review found that ``Path.resolve()`` leaves letter
    case alone on a case-insensitive filesystem (APFS, NTFS), so
    ``official/creative/PIXEL-ART`` reaches the paid directory while carrying a
    spelling no catalog entry equals.  Case-folding and dropping ``.`` and
    empty segments here means the gate cannot be walked past by re-spelling
    the same path.
    """
    parts = [part for part in str(identifier or "").split("/") if part not in ("", ".")]
    return "/".join(parts).casefold()


def match_catalog_item(
    items: list[dict[str, Any]] | None,
    kind: str,
    identifier: str,
    sha256: str | None = None,
) -> dict[str, Any] | None:
    """The catalog item being installed, or ``None`` when the catalog owns neither.

    Matching is against ``identifier`` — what the gateway actually installs
    (a skill's canonical hub identifier after alias resolution; a pet's slug) —
    or against one of the item's signed content hashes.  Entitlements are then
    looked up by the matched item's ``(kind, id)``, never by the identifier.

    Two spellings of the same install match the item: a case variant (above),
    and a *containing directory*.  Installing ``official/creative`` installs
    every skill beneath it, so it is matched against the first catalog item it
    would bring in — otherwise one request for a category, or for the hub root,
    installs every paid skill at once.
    """
    if not items:
        return None
    wanted = normalised_identifier(identifier)
    for entry in items:
        if entry["kind"] != kind:
            continue
        if normalised_identifier(entry["identifier"]) == wanted:
            return entry
        if sha256 is not None and sha256 in entry["hashes"]:
            return entry
    if sha256 is not None or not wanted:
        # A caller that carries content hashes identifies the item by its
        # bytes; the containment rule below is for the install paths that have
        # only a string, and would otherwise let one request for a directory
        # bring in everything paid beneath it.
        return None
    for entry in items:
        if entry["kind"] == kind and normalised_identifier(entry["identifier"]).startswith(f"{wanted}/"):
            return entry
    return None


def _account_key_for(account_id: str) -> str:
    """The desktop's ``accountKeyFor``: sha256 of the domain separator + id."""
    digest = hashlib.sha256()
    digest.update(_ACCOUNT_KEY_DOMAIN)
    digest.update(account_id.encode("utf-8"))
    return digest.hexdigest()


def _scoped_account_key(account_root: Path | None) -> str | None:
    """The account key this Hermes root belongs to, or ``None`` outside the
    desktop account layout (a bare CLI home has no account authority to check
    against — plan decision 7 scopes that out)."""
    if account_root is None:
        from hermes_constants import get_default_hermes_root

        account_root = get_default_hermes_root()
    root = Path(account_root)
    if root.name != "hermes":
        return None
    key = root.parent.name
    return key if _ACCOUNT_KEY_RE.fullmatch(key) else None


def _account_matches(envelope: dict[str, Any], account_id: str | None, account_root: Path | None) -> bool:
    """The mandatory per-chokepoint account check (contract C3 rule 3).

    Two bindings, both must hold when available: the caller-supplied account id
    (a main-issued portability ticket) and the location binding (the envelope
    must sit in the account root its ``account_id`` digests to).
    """
    if account_id is not None and envelope["account_id"] != account_id:
        return False
    key = _scoped_account_key(account_root)
    if key is not None and _account_key_for(envelope["account_id"]) != key:
        return False
    return True


def proof_error(
    *,
    account_id: str | None = None,
    account_root: Path | None = None,
    now: float | None = None,
) -> str | None:
    """Cheap reason the stored proof is unusable, or ``None`` when it verifies.

    ``None`` means a well-formed v3, unexpired envelope for the account (when
    given, and matching the account root's location binding) signed by a pinned
    key sits at the account root.  Otherwise one of the ``PROOF_*`` tokens
    explains why — callers raise the matching typed error without ever seeing
    the envelope itself.
    """
    now = time.time() if now is None else now
    envelope, reason = _verified_envelope(store_dir(account_root))
    if envelope is None:
        return reason
    if envelope["expires_at"] <= now:
        return PROOF_EXPIRED
    if not _account_matches(envelope, account_id, account_root):
        return PROOF_ACCOUNT_MISMATCH
    return None


def _agent_grant_matches(entry: dict[str, Any]) -> bool:
    """A signed training grant belongs to the current persistent profile.

    This local check controls discovery/activation. Protected bodies still
    require a live server grant check; editing a profile never grants them.
    """
    if entry["kind"] != "skill":
        return True
    from hermes_constants import get_hermes_home
    from hermes_cli.profiles import read_profile_meta

    identity = read_profile_meta(get_hermes_home()).get("identity_id")
    return bool(identity and identity == entry.get("assistant_identity_id"))


def entitlement_state(
    account_id: str | None,
    kind: str,
    item_id: str,
    *,
    account_root: Path | None = None,
    now: float | None = None,
) -> str | None:
    """``"active"`` or ``"revoked"`` for the item, or ``None``.

    ``None`` covers every unusable-proof case and "the proof simply does not
    list this item"; use :func:`proof_error` to tell them apart.
    """
    now = time.time() if now is None else now
    envelope, reason = _verified_envelope(store_dir(account_root))
    if envelope is None or envelope["expires_at"] <= now:
        return None
    if not _account_matches(envelope, account_id, account_root):
        return None
    for entry in envelope["entitlements"]:
        if entry["kind"] == kind and entry["id"] == item_id and _agent_grant_matches(entry):
            return entry["state"]
    return None


def catalog_owned_items(*, account_root: Path | None = None) -> list[dict[str, Any]] | None:
    """The catalog-owned set the resolver may consult, or ``None``.

    ``None`` means there is no envelope file at all: nothing is known to be
    catalog-owned and every install path behaves exactly as it did before the
    store existed (contract C3 rule 1).  A verified envelope contributes its
    signed ``catalog_owned`` (expiry is a per-decision check, not a reason to
    forget the set); an unverifiable one contributes the fail-closed
    best-effort set of :func:`_unusable_catalog_items`.
    """
    store = store_dir(account_root)
    envelope, reason = _verified_envelope(store)
    if reason == PROOF_MISSING:
        return None
    if envelope is not None:
        return envelope["catalog_owned"]
    return _unusable_catalog_items(store)


class CatalogOwned:
    """The signed catalog-owned set as a membership test.

    The interface ``hermes_cli.atum_content_sync`` imports (PR #288, which
    classifies a local pet as Store-owned before it can be minted as personal
    bytes).  It is a view over :func:`catalog_owned_items`; the branch that
    introduced the envelope dropped the name, and because #288 guards the
    import with ``except ModuleNotFoundError`` the resulting plain
    ``ImportError`` would have taken down every pet-sync ticket on merge.
    """

    __slots__ = ("items",)

    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items

    def owns(self, kind: str, identifier: str, sha256: str | None = None) -> bool:
        """Whether the signed catalog claims this item, by identifier or hash."""
        return match_catalog_item(self.items, kind, identifier, sha256) is not None


def load_catalog_owned(*, account_root: Path | None = None) -> CatalogOwned | None:
    """The catalog-owned set, or ``None`` when there is no envelope at all."""
    items = catalog_owned_items(account_root=account_root)
    return None if items is None else CatalogOwned(items)


def store_epoch(account_root: Path | None = None) -> tuple[int, int] | None:
    """``(mtime_ns, size)`` of the proof file, or ``None`` when there is none.

    The one fact every cache that lists or loads catalog-gated items must fold
    into its signature: a refund, a purchase or a fresh sign-in rewrites the
    file, and nothing else about the filesystem changes.
    """
    path = store_dir(account_root) / "entitlement-proof.json"
    try:
        if path.is_symlink() or not path.is_file():
            return None
        stat = path.stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


# Reference content hashes derived from the trees shipped with the app, keyed
# by (kind, identifier). The envelope's ``hashes[]`` is empty for every
# ``bundled`` pet and ``hermes_optional`` skill by design (the platform never
# holds those bytes), so "these bytes are the catalog's" is answered here,
# from the shipped tree, release-consistent by construction. Process-lifetime
# cache: shipped trees change only with the app.
_reference_hash_cache: dict[tuple[str, str], frozenset[str]] = {}


def reference_hashes(kind: str, identifier: str) -> frozenset[str]:
    """Content hashes of the shipped tree behind a catalog identifier, if any."""
    key = (kind, normalised_identifier(identifier))
    with _cache_lock:
        cached = _reference_hash_cache.get(key)
    if cached is not None:
        return cached
    hashes: set[str] = set()
    try:
        if kind == "pet":
            from agent.pet import store as pet_store

            root = pet_store.bundled_pets_dir()
            slug = pet_store._safe_slug(identifier)
            if root is not None and slug and (root / slug).is_dir():
                hashes.add(pet_store.pet_tree_sha256(root / slug))
        elif kind == "skill":
            from hermes_cli.atum_portability import _skill_tree_hash
            from hermes_constants import get_optional_skills_dir

            rel = identifier.split("/", 1)[-1] if identifier.startswith("official/") else identifier
            optional = get_optional_skills_dir()
            candidate = (optional / rel) if optional is not None else None
            if candidate is not None and candidate.is_dir() and (candidate / "SKILL.md").is_file():
                hashes.add(_skill_tree_hash(candidate))
    except Exception:  # noqa: BLE001 - a reference that cannot be read is simply absent
        hashes.clear()
    frozen = frozenset(hashes)
    with _cache_lock:
        _reference_hash_cache[key] = frozen
    return frozen


def _match_with_references(
    items: list[dict[str, Any]] | None,
    kind: str,
    identifier: str | None,
    sha256: str | None,
) -> dict[str, Any] | None:
    """:func:`match_catalog_item`, then the locally derived hash lane."""
    matched = match_catalog_item(items, kind, identifier or "", sha256)
    if matched is not None or not items or sha256 is None:
        return matched
    for entry in items:
        if entry["kind"] == kind and not entry["hashes"] and sha256 in reference_hashes(kind, entry["identifier"]):
            return entry
    return None


def hold_reason(
    kind: str,
    identifier: str | None,
    *,
    sha256: str | None = None,
    account_id: str | None = None,
    account_root: Path | None = None,
    now: float | None = None,
) -> str | None:
    """The typed reason this item may not be used, or ``None`` when it may.

    The same decision as :func:`enforce_catalog_item`, as data rather than an
    exception: the loaders MARK with it and the render verbs refuse on it.
    ``identifier`` is the item's stamped identity (never a directory name) or
    ``None`` for an unstamped directory, which then matches only by bytes.
    """
    now = time.time() if now is None else now
    store = store_dir(account_root)
    envelope, reason = _verified_envelope(store)
    if reason == PROOF_MISSING:
        return None
    if envelope is None:
        if _match_with_references(_unusable_catalog_items(store), kind, identifier, sha256) is not None:
            return ENTITLEMENT_UNAVAILABLE_OFFLINE
        return None
    entry = _match_with_references(envelope["catalog_owned"], kind, identifier, sha256)
    if entry is None:
        return None
    if envelope["expires_at"] <= now:
        return ENTITLEMENT_UNAVAILABLE_OFFLINE
    if not _account_matches(envelope, account_id, account_root):
        return ENTITLEMENT_UNAVAILABLE_OFFLINE
    state = next(
        (
            candidate["state"]
            for candidate in envelope["entitlements"]
            if candidate["kind"] == entry["kind"] and candidate["id"] == entry["id"]
            and _agent_grant_matches(candidate)
        ),
        None,
    )
    if state == "active":
        return "cloud_training_required" if entry.get("delivery") == "cloud" else None
    if state == "revoked":
        return ENTITLEMENT_REVOKED
    return PURCHASE_REQUIRED


def enforce_catalog_item(
    kind: str,
    identifier: str,
    *,
    account_id: str | None = None,
    sha256: str | None = None,
    account_root: Path | None = None,
    now: float | None = None,
) -> None:
    """Raise :class:`StoreEntitlementError` unless the item is free or entitled.

    The single store decision every chokepoint calls (contract C3):

    1. No envelope file at all: allow (pre-store behaviour).
    2. Envelope present but unusable: an item it names is unavailable
       (``entitlement_unavailable_offline``); anything else falls back to
       rule 1.
    3. Envelope valid but not this account: catalog items refuse with
       ``entitlement_unavailable_offline``.
    4. Envelope valid for this account: an identifier the signed
       ``catalog_owned`` does not name is free; otherwise the matched item's
       entitlement decides — ``active`` installs, ``revoked`` refuses with
       ``entitlement_revoked``, absent refuses with ``purchase_required``.
    """
    reason = hold_reason(
        kind, identifier, sha256=sha256, account_id=account_id, account_root=account_root, now=now
    )
    if reason is None:
        return
    messages = {
        "cloud_training_required": "Use this training from Atum to start a new task; private training has no local installation.",
        ENTITLEMENT_UNAVAILABLE_OFFLINE: f"no usable signed entitlement proof for {kind} '{identifier}' on this device",
        ENTITLEMENT_REVOKED: f"the entitlement for {kind} '{identifier}' was revoked",
        PURCHASE_REQUIRED: f"{kind} '{identifier}' is a catalog item this account has not acquired",
    }
    raise StoreEntitlementError(reason, messages[reason])
