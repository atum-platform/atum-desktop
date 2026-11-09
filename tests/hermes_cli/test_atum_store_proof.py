'The signed store entitlement envelope (v3) and its enforcement chokepoints.\n\nPlan  decisions 5-8, amended by\n: the platform\nsigns a version-3 Ed25519 envelope whose signed catalog_owned lists every\ncatalog item in every state, the desktop stores it verbatim at\n<hermes state root>/atum-store/entitlement-proof.json, and Hermes enforces\nit at every install path through enforce_catalog_item: pet.select\n(agent.pet.store.install_pet), do_install (which the CLI, /skills\nslash, JSON-RPC skills.manage, cli.exec and the hub/profile HTTP\nroutes all converge on), and definition materialisation.  Test keys are\ngenerated here with cryptography; no key material is committed.\n'

from __future__ import annotations

import base64
import hashlib
import json
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from hermes_cli import atum_portability as portability
from hermes_cli import atum_store_proof as proof

ACCOUNT = "account-a"
OTHER_ACCOUNT = "account-b"
SKILL_ID = "official/writing/example"
IDENTITY = "00000000-0000-4000-8000-303617b97302"


# ---------------------------------------------------------------------------
# Key / envelope helpers
# ---------------------------------------------------------------------------


def _public_b64(private: Ed25519PrivateKey) -> str:
    raw = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _sign_envelope(
    private: Ed25519PrivateKey,
    *,
    account_id: str = ACCOUNT,
    entitlements: list[dict] | None = None,
    catalog_owned: list[dict] | None = None,
    key_id: str = "k1",
    issued_at: int | None = None,
    ttl: int = 7 * 24 * 3600,
    v: int | None = 3,
) -> dict:
    """Sign exactly as the platform route does: canonical JSON minus signature."""
    issued = int(time.time()) if issued_at is None else issued_at
    envelope = {
        "account_id": account_id,
        "catalog_owned": [{"delivery": "local", **e} for e in (catalog_owned or [])],
        "entitlements": [{
            "assistant_id": "00000000-0000-4000-8000-00f765af1c54" if e["kind"] == "skill" else None,
            "assistant_identity_id": IDENTITY if e["kind"] == "skill" else None,
            **e,
        } for e in (entitlements or [])],
        "expires_at": issued + ttl,
        "issued_at": issued,
        "key_id": key_id,
    }
    if v is not None:
        envelope["v"] = v
    payload = json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    envelope["signature"] = base64.urlsafe_b64encode(private.sign(payload)).decode("ascii").rstrip("=")
    return envelope


def _owned_skill(
    identifier: str = SKILL_ID,
    item_id: str | None = None,
    hashes: list[str] | None = None,
) -> dict:
    return {
        "kind": "skill",
        "delivery": "local",
        "id": item_id if item_id is not None else identifier,
        "identifier": identifier,
        "hashes": hashes if hashes is not None else [],
    }


def _owned_pet(slug: str, item_id: str | None = None, hashes: list[str] | None = None) -> dict:
    return {
        "kind": "pet",
        "delivery": "local",
        "id": item_id if item_id is not None else slug,
        "identifier": slug,
        "hashes": hashes if hashes is not None else [],
    }


def _account_key(account_id: str) -> str:
    """The desktop's ``accountKeyFor`` (account-roots.ts)."""
    return hashlib.sha256(b"atum-account-root-v1\x00" + account_id.encode("utf-8")).hexdigest()


def _desktop_home(base: Path, account_id: str = ACCOUNT) -> Path:
    """An account-scoped Hermes home in the desktop layout: <accounts>/<key>/hermes."""
    home = base / "accounts" / _account_key(account_id) / "hermes"
    home.mkdir(parents=True, exist_ok=True)
    return home


@pytest.fixture(autouse=True)
def _reset_proof_caches(monkeypatch, tmp_path):
    # The dev override is a legitimate escape hatch in production, but a
    # developer's shell must never leak it into these tests.
    monkeypatch.delenv("ATUM_STORE_DEV_ENTITLEMENT_PUBLIC_KEY", raising=False)
    from hermes_cli.profiles import adopt_profile_identity
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    adopt_profile_identity(tmp_path, IDENTITY)
    proof._reset_caches()
    yield
    proof._reset_caches()


@pytest.fixture
def signing_key(monkeypatch) -> Ed25519PrivateKey:
    private = Ed25519PrivateKey.generate()
    monkeypatch.setitem(proof.PINNED_PUBLIC_KEYS, "k1", _public_b64(private))
    return private


def _write_store(root: Path, *, envelope: dict | None = None, raw: str | None = None) -> Path:
    store = root / "atum-store"
    store.mkdir(parents=True, exist_ok=True)
    if envelope is not None:
        (store / "entitlement-proof.json").write_text(json.dumps(envelope), encoding="utf-8")
    if raw is not None:
        (store / "entitlement-proof.json").write_text(raw, encoding="utf-8")
    return store


# ---------------------------------------------------------------------------
# Envelope verification
# ---------------------------------------------------------------------------


def test_v3_envelope_verifies_and_grants(tmp_path, signing_key):
    envelope = _sign_envelope(
        signing_key,
        entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
        catalog_owned=[_owned_skill()],
    )
    _write_store(tmp_path, envelope=envelope)

    assert proof.proof_error(account_root=tmp_path) is None
    assert proof.entitlement_state(ACCOUNT, "skill", SKILL_ID, account_root=tmp_path) == "active"
    assert proof.entitlement_state(ACCOUNT, "skill", "official/other", account_root=tmp_path) is None
    assert proof.entitlement_state(ACCOUNT, "pet", SKILL_ID, account_root=tmp_path) is None
    proof.enforce_catalog_item("skill", SKILL_ID, account_id=ACCOUNT, account_root=tmp_path)


@pytest.mark.parametrize("version", [None, 1, 2, "3"])
def test_any_version_but_three_is_refused(tmp_path, signing_key, version):
    envelope = _sign_envelope(
        signing_key,
        entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
        catalog_owned=[_owned_skill()],
        v=version,
    )
    _write_store(tmp_path, envelope=envelope)

    assert proof.proof_error(account_root=tmp_path) in {proof.PROOF_UNSUPPORTED_VERSION, proof.PROOF_MALFORMED}
    # A refused envelope never grants an entitlement, and the catalog items it
    # names fail closed.
    assert proof.entitlement_state(ACCOUNT, "skill", SKILL_ID, account_root=tmp_path) is None
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_root=tmp_path)
    assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE


def test_v1_shaped_envelope_grants_nothing_and_gates_nothing(tmp_path, signing_key):
    """A pre-v2 envelope has no catalog_owned to fail closed on: it grants no
    entitlement, and installs fall back to pre-store behaviour (C3 rule 2's
    final fallback)."""
    issued = int(time.time())
    envelope = {
        "account_id": ACCOUNT,
        "entitlements": [{"kind": "skill", "id": SKILL_ID, "state": "active"}],
        "expires_at": issued + 3600,
        "issued_at": issued,
        "key_id": "k1",
    }
    payload = json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    envelope["signature"] = base64.urlsafe_b64encode(signing_key.sign(payload)).decode("ascii").rstrip("=")
    _write_store(tmp_path, envelope=envelope)

    assert proof.proof_error(account_root=tmp_path) in {proof.PROOF_UNSUPPORTED_VERSION, proof.PROOF_MALFORMED}
    assert proof.entitlement_state(ACCOUNT, "skill", SKILL_ID, account_root=tmp_path) is None
    proof.enforce_catalog_item("skill", SKILL_ID, account_root=tmp_path)  # nothing known to gate


def _altered(envelope: dict, field: str) -> dict:
    mutated = json.loads(json.dumps(envelope))
    if field == "account_id":
        mutated["account_id"] = "z" + mutated["account_id"][1:]
    elif field == "issued_at":
        mutated["issued_at"] += 1
    elif field == "expires_at":
        mutated["expires_at"] += 1
    elif field == "key_id":
        mutated["key_id"] = "k9"
    elif field == "entitlements":
        mutated["entitlements"][0]["id"] = "official/writing/other"
    elif field == "catalog_owned":
        mutated["catalog_owned"][0]["identifier"] = "official/writing/other"
    elif field == "v":
        mutated["v"] = 2
    elif field == "signature":
        first = mutated["signature"][0]
        mutated["signature"] = ("A" if first != "A" else "B") + mutated["signature"][1:]
    return mutated


@pytest.mark.parametrize(
    "field,reason",
    [
        ("account_id", proof.PROOF_BAD_SIGNATURE),
        ("issued_at", proof.PROOF_BAD_SIGNATURE),
        ("expires_at", proof.PROOF_BAD_SIGNATURE),
        ("key_id", proof.PROOF_UNKNOWN_KEY),
        ("entitlements", proof.PROOF_BAD_SIGNATURE),
        ("catalog_owned", proof.PROOF_BAD_SIGNATURE),
        ("v", proof.PROOF_UNSUPPORTED_VERSION),
        ("signature", proof.PROOF_BAD_SIGNATURE),
    ],
)
def test_one_byte_alteration_of_any_field_fails(tmp_path, signing_key, field, reason):
    envelope = _sign_envelope(
        signing_key,
        entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
        catalog_owned=[_owned_skill()],
    )
    _write_store(tmp_path, envelope=_altered(envelope, field))

    assert proof.proof_error(account_root=tmp_path) == reason
    assert proof.entitlement_state(ACCOUNT, "skill", SKILL_ID, account_root=tmp_path) is None


def test_expired_envelope_is_unavailable_not_absent(tmp_path, signing_key):
    envelope = _sign_envelope(
        signing_key,
        entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
        catalog_owned=[_owned_skill()],
        issued_at=int(time.time()) - 8 * 24 * 3600,
    )
    _write_store(tmp_path, envelope=envelope)

    assert proof.proof_error(account_root=tmp_path) == proof.PROOF_EXPIRED
    assert proof.entitlement_state(ACCOUNT, "skill", SKILL_ID, account_root=tmp_path) is None
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_id=ACCOUNT, account_root=tmp_path)
    assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
    # An item the expired envelope does not name stays free.
    proof.enforce_catalog_item("skill", "official/other/free", account_root=tmp_path)


def test_wrong_account_envelope_fails(tmp_path, signing_key):
    envelope = _sign_envelope(
        signing_key,
        account_id=OTHER_ACCOUNT,
        entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
        catalog_owned=[_owned_skill()],
    )
    _write_store(tmp_path, envelope=envelope)

    assert proof.proof_error(account_root=tmp_path) is None  # valid, but someone else's
    assert proof.proof_error(account_id=ACCOUNT, account_root=tmp_path) == proof.PROOF_ACCOUNT_MISMATCH
    assert proof.entitlement_state(ACCOUNT, "skill", SKILL_ID, account_root=tmp_path) is None
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_id=ACCOUNT, account_root=tmp_path)
    assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
    # Items the foreign envelope does not name are unaffected.
    proof.enforce_catalog_item("skill", "official/other/free", account_id=ACCOUNT, account_root=tmp_path)


def test_foreign_account_envelope_fails_the_location_binding(tmp_path, signing_key, monkeypatch):
    """No account id is passed at the pet/hub chokepoints; the desktop account
    layout binds them anyway — an envelope whose account_id does not digest to
    the account key in the root's path is unusable there."""
    home = _desktop_home(tmp_path, ACCOUNT)
    envelope = _sign_envelope(
        signing_key,
        account_id=OTHER_ACCOUNT,
        entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
        catalog_owned=[_owned_skill()],
    )
    _write_store(home, envelope=envelope)

    assert proof.proof_error(account_root=home) == proof.PROOF_ACCOUNT_MISMATCH
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_root=home)
    assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE

    # Control: the same root with its own account's envelope verifies.
    proof._reset_caches()
    _write_store(
        home,
        envelope=_sign_envelope(
            signing_key,
            entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
            catalog_owned=[_owned_skill()],
        ),
    )
    assert proof.proof_error(account_root=home) is None
    proof.enforce_catalog_item("skill", SKILL_ID, account_root=home)


def test_unknown_key_id_fails_closed_and_gates_named_items(tmp_path, signing_key):
    envelope = _sign_envelope(signing_key, key_id="k9", catalog_owned=[_owned_skill()])
    _write_store(tmp_path, envelope=envelope)

    assert proof.proof_error(account_root=tmp_path) == proof.PROOF_UNKNOWN_KEY
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_root=tmp_path)
    assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE


def test_rotation_window_keys_both_verify(tmp_path, signing_key, monkeypatch):
    incoming = Ed25519PrivateKey.generate()
    monkeypatch.setitem(proof.PINNED_PUBLIC_KEYS, "k2", _public_b64(incoming))

    old_envelope = _sign_envelope(signing_key, key_id="k1")
    new_envelope = _sign_envelope(incoming, key_id="k2")
    _write_store(tmp_path, envelope=new_envelope)
    assert proof.proof_error(account_root=tmp_path) is None

    other = tmp_path / "old"
    _write_store(other, envelope=old_envelope)
    assert proof.proof_error(account_root=other) is None


def test_development_key_override_is_explicit_and_scoped(tmp_path, monkeypatch):
    # The override is honoured only while nothing is pinned (a shipped build
    # pins k1); this test exercises that pre-pin window.
    monkeypatch.setattr(proof, "PINNED_PUBLIC_KEYS", {})
    dev_key = Ed25519PrivateKey.generate()
    monkeypatch.setenv("ATUM_STORE_DEV_ENTITLEMENT_PUBLIC_KEY", f"kdev:{_public_b64(dev_key)}")

    _write_store(tmp_path, envelope=_sign_envelope(dev_key, key_id="kdev"))
    assert proof.proof_error(account_root=tmp_path) is None

    other = tmp_path / "other"
    _write_store(other, envelope=_sign_envelope(dev_key, key_id="k1"))
    assert proof.proof_error(account_root=other) == proof.PROOF_UNKNOWN_KEY


@pytest.mark.parametrize("contents", [None, "{not json", '{"account_id": 1}', "[]"])
def test_missing_or_malformed_envelope(tmp_path, signing_key, contents):
    if contents is not None:
        _write_store(tmp_path, raw=contents)
    assert proof.proof_error(account_root=tmp_path) in {proof.PROOF_MISSING, proof.PROOF_MALFORMED}


def test_malformed_envelope_still_gates_what_the_last_valid_one_named(tmp_path, signing_key):
    """Contract C3 rule 2: an unparseable replacement cannot switch
    enforcement off while the last valid envelope is still known."""
    _write_store(tmp_path, envelope=_sign_envelope(signing_key, catalog_owned=[_owned_skill()]))
    assert proof.proof_error(account_root=tmp_path) is None  # populate last-valid

    _write_store(tmp_path, raw="{corrupted")
    assert proof.proof_error(account_root=tmp_path) == proof.PROOF_MALFORMED
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_root=tmp_path)
    assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
    # An item no valid envelope ever named falls back to pre-store behaviour.
    proof.enforce_catalog_item("skill", "official/other/free", account_root=tmp_path)


def test_unusable_envelope_without_history_falls_back_to_pre_store(tmp_path, signing_key):
    """A malformed envelope that names nothing readable gates nothing."""
    _write_store(tmp_path, raw="{corrupted")
    proof.enforce_catalog_item("skill", SKILL_ID, account_root=tmp_path)


def test_valid_proof_without_the_item_is_purchase_required(tmp_path, signing_key):
    _write_store(tmp_path, envelope=_sign_envelope(signing_key, catalog_owned=[_owned_skill()]))
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_id=ACCOUNT, account_root=tmp_path)
    assert excinfo.value.code == proof.PURCHASE_REQUIRED


def test_free_items_never_need_a_proof(tmp_path, signing_key):
    # No envelope at all: nothing is catalog-owned, everything is pre-store.
    proof.enforce_catalog_item("skill", "official/anything", account_root=tmp_path)
    proof.enforce_catalog_item("pet", "boba", account_root=tmp_path)
    assert proof.catalog_owned_items(account_root=tmp_path) is None
    # A valid envelope that does not name the item leaves it free.
    _write_store(tmp_path, envelope=_sign_envelope(signing_key, catalog_owned=[_owned_skill()]))
    proof.enforce_catalog_item("pet", "boba", account_root=tmp_path)


def test_revoked_item_is_refused_not_reactivated(tmp_path, signing_key):
    """A refund reactivates nothing: the revoked entry sits beside the item in
    the same signed envelope (delisting never removes it — review B5)."""
    envelope = _sign_envelope(
        signing_key,
        entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "revoked"}],
        catalog_owned=[_owned_skill()],
    )
    _write_store(tmp_path, envelope=envelope)

    assert proof.entitlement_state(ACCOUNT, "skill", SKILL_ID, account_root=tmp_path) == "revoked"
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_id=ACCOUNT, account_root=tmp_path)
    assert excinfo.value.code == proof.ENTITLEMENT_REVOKED


def test_catalog_item_id_may_differ_from_install_identifier(tmp_path, signing_key):
    """The gate matches what is installed (``identifier``) and looks the
    entitlement up by the matched item's ``(kind, id)``."""
    entry = _owned_skill(identifier=SKILL_ID, item_id="items/0001")
    _write_store(tmp_path, envelope=_sign_envelope(signing_key, catalog_owned=[entry]))
    with pytest.raises(proof.StoreEntitlementError) as excinfo:
        proof.enforce_catalog_item("skill", SKILL_ID, account_root=tmp_path)
    assert excinfo.value.code == proof.PURCHASE_REQUIRED

    proof._reset_caches()
    _write_store(
        tmp_path,
        envelope=_sign_envelope(
            signing_key,
            entitlements=[{"kind": "skill", "id": "items/0001", "state": "active"}],
            catalog_owned=[entry],
        ),
    )
    proof.enforce_catalog_item("skill", SKILL_ID, account_root=tmp_path)


# ---------------------------------------------------------------------------
# Chokepoint 1: pet.select (agent.pet.store.install_pet)
# ---------------------------------------------------------------------------


def _bundle(root: Path, slug: str) -> Path:
    directory = root / slug
    directory.mkdir(parents=True)
    (directory / "pet.json").write_text(
        json.dumps({"id": slug, "displayName": slug.title(), "description": "", "spritesheetPath": "spritesheet.webp"}),
        encoding="utf-8",
    )
    (directory / "spritesheet.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
    return directory


def _refuse_network(monkeypatch):
    from agent.pet import manifest

    def refuse(*_args, **_kwargs):
        raise AssertionError("a bundled or gated pet must never touch petdex")

    monkeypatch.setattr(manifest, "find_entry", refuse)


class TestPetSelectChokepoint:
    # The catalog id differs from the slug on purpose (review B4: the
    # platform's own fixture uses id "bundled/mocha" for slug "mocha").
    OWNED = [_owned_pet("mochi", item_id="bundled/mochi")]

    def test_catalog_pet_refused_with_unusable_proof(self, tmp_path, monkeypatch, signing_key):
        from agent.pet import store

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        # Signed by an unpinned key: present, names the pet, unusable.
        stranger = Ed25519PrivateKey.generate()
        _write_store(tmp_path, envelope=_sign_envelope(stranger, catalog_owned=self.OWNED))
        _refuse_network(monkeypatch)

        with pytest.raises(store.PetEntitlementError) as excinfo:
            store.install_pet("mochi")
        assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
        assert str(excinfo.value).startswith(proof.ENTITLEMENT_UNAVAILABLE_OFFLINE)
        assert store.load_pet("mochi") is None

    def test_catalog_pet_refused_with_wrong_proof_states(self, tmp_path, monkeypatch, signing_key):
        from agent.pet import store

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        _refuse_network(monkeypatch)

        _write_store(tmp_path, envelope=_sign_envelope(signing_key, catalog_owned=self.OWNED))
        with pytest.raises(store.PetEntitlementError) as excinfo:
            store.install_pet("mochi")
        assert excinfo.value.code == proof.PURCHASE_REQUIRED

        proof._reset_caches()
        envelope = _sign_envelope(
            signing_key,
            entitlements=[{"kind": "pet", "id": "bundled/mochi", "state": "revoked"}],
            catalog_owned=self.OWNED,
        )
        _write_store(tmp_path, envelope=envelope)
        with pytest.raises(store.PetEntitlementError) as excinfo:
            store.install_pet("mochi")
        assert excinfo.value.code == proof.ENTITLEMENT_REVOKED

    def test_catalog_pet_installs_with_active_entitlement(self, tmp_path, monkeypatch, signing_key):
        from agent.pet import store

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        bundle = tmp_path / "bundle"
        _bundle(bundle, "mochi")
        monkeypatch.setenv("ATUM_BUNDLED_PETS_DIR", str(bundle))
        _refuse_network(monkeypatch)
        envelope = _sign_envelope(
            signing_key,
            entitlements=[{"kind": "pet", "id": "bundled/mochi", "state": "active"}],
            catalog_owned=self.OWNED,
        )
        _write_store(tmp_path, envelope=envelope)

        pet = store.install_pet("mochi")
        assert pet.exists
        # A re-select hits install_pet's early return and is still gated (and granted).
        assert store.install_pet("mochi").slug == "mochi"

    def test_pet_gate_checks_the_account_by_location(self, tmp_path, monkeypatch, signing_key):
        """A proof signed for another account must not unlock a pet at this
        chokepoint either (review: completeness critic)."""
        from agent.pet import store

        home = _desktop_home(tmp_path, ACCOUNT)
        monkeypatch.setenv("HERMES_HOME", str(home))
        bundle = tmp_path / "bundle"
        _bundle(bundle, "mochi")
        monkeypatch.setenv("ATUM_BUNDLED_PETS_DIR", str(bundle))
        _refuse_network(monkeypatch)
        _write_store(
            home,
            envelope=_sign_envelope(
                signing_key,
                account_id=OTHER_ACCOUNT,
                entitlements=[{"kind": "pet", "id": "bundled/mochi", "state": "active"}],
                catalog_owned=self.OWNED,
            ),
        )

        with pytest.raises(store.PetEntitlementError) as excinfo:
            store.install_pet("mochi")
        assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
        assert store.load_pet("mochi") is None

    def test_bundled_pet_installs_with_no_store_files_at_all(self, tmp_path, monkeypatch):
        from agent.pet import store

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        bundle = tmp_path / "bundle"
        _bundle(bundle, "gigi")
        monkeypatch.setenv("ATUM_BUNDLED_PETS_DIR", str(bundle))
        _refuse_network(monkeypatch)

        assert store.install_pet("gigi").exists

    def test_petdex_pet_installs_with_no_store_files_at_all(self, tmp_path, monkeypatch):
        from agent.pet import manifest
        from agent.pet import store

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        entry = manifest.ManifestEntry(
            slug="boba",
            display_name="Boba",
            kind="pet",
            submitted_by="someone",
            spritesheet_url="https://petdex.dev/sheets/boba.webp",
            pet_json_url="",
            zip_url="",
        )
        monkeypatch.setattr(manifest, "find_entry", lambda slug, timeout=None: entry)
        monkeypatch.setattr(store, "_download", lambda url, dest, timeout=None: dest.write_bytes(b"sheet"))

        pet = store.install_pet("boba")
        assert pet.exists


# ---------------------------------------------------------------------------
# Chokepoint 2: the skills hub install route (alias-resolved)
# ---------------------------------------------------------------------------


def _write_optional_skill(root: Path, relative: str = "creative/pixel-art") -> Path:
    skill_dir = root / relative
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text("# Pixel Art\n", encoding="utf-8")
    return skill_dir


class TestSkillsHubChokepoint:
    OWNED = [_owned_skill("official/creative/pixel-art")]

    @pytest.fixture
    def client(self, monkeypatch):
        try:
            from starlette.testclient import TestClient
        except ImportError:
            pytest.skip("fastapi/starlette not installed")

        import hermes_state
        from hermes_constants import get_hermes_home
        from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
        client = TestClient(app)
        client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        return client

    @pytest.fixture
    def spawn(self, monkeypatch):
        from hermes_cli import web_server_gateway

        calls = []

        class _FakeProc:
            pid = 4242

        monkeypatch.setattr(
            web_server_gateway, "_spawn_hermes_action", lambda args, name: calls.append(list(args)) or _FakeProc()
        )
        return calls

    def _account_root(self) -> Path:
        from hermes_constants import get_default_hermes_root

        return get_default_hermes_root()

    def test_catalog_skill_refused_with_unusable_proof(self, client, spawn, signing_key):
        root = self._account_root()
        # Well-shaped but self-signed by an unknown key: unusable, names the skill.
        stranger = Ed25519PrivateKey.generate()
        _write_store(root, envelope=_sign_envelope(stranger, catalog_owned=self.OWNED))

        resp = client.post("/api/skills/hub/install", json={"identifier": "official/creative/pixel-art"})
        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
        assert spawn == []

    def test_catalog_skill_purchase_required_with_bare_proof(self, client, spawn, signing_key):
        root = self._account_root()
        _write_store(root, envelope=_sign_envelope(signing_key, catalog_owned=self.OWNED))

        resp = client.post("/api/skills/hub/install", json={"identifier": "official/creative/pixel-art"})
        assert resp.status_code == 402
        assert resp.json()["detail"]["code"] == proof.PURCHASE_REQUIRED
        assert spawn == []

    def test_catalog_skill_installs_with_active_entitlement(self, client, spawn, signing_key):
        root = self._account_root()
        envelope = _sign_envelope(
            signing_key,
            entitlements=[{"kind": "skill", "id": "official/creative/pixel-art", "state": "active"}],
            catalog_owned=self.OWNED,
        )
        _write_store(root, envelope=envelope)

        resp = client.post("/api/skills/hub/install", json={"identifier": "official/creative/pixel-art"})
        assert resp.status_code == 200
        assert spawn == [["skills", "install", "official/creative/pixel-art", "--yes"]]

    def test_uncatalogued_skill_installs_with_no_store_files(self, client, spawn):
        resp = client.post("/api/skills/hub/install", json={"identifier": "official/creative/pixel-art"})
        assert resp.status_code == 200
        assert spawn == [["skills", "install", "official/creative/pixel-art", "--yes"]]

    @pytest.mark.parametrize(
        "alias",
        ["official/pixel-art", "official/creative/pixel-art/", "official/creative/./pixel-art"],
    )
    def test_hub_alias_is_resolved_before_the_gate(self, client, spawn, signing_key, monkeypatch, tmp_path, alias):
        """Review B3: every alias spelling of a paid skill is gated as the
        canonical identifier it resolves to."""
        root = self._account_root()
        optional = tmp_path / "optional-skills"
        _write_optional_skill(optional)
        monkeypatch.setenv("HERMES_OPTIONAL_SKILLS", str(optional))
        _write_store(root, envelope=_sign_envelope(signing_key, catalog_owned=self.OWNED))

        resp = client.post("/api/skills/hub/install", json={"identifier": alias})
        assert resp.status_code == 402
        assert resp.json()["detail"]["code"] == proof.PURCHASE_REQUIRED
        assert spawn == []

    def test_hub_gate_checks_the_account_by_location(self, monkeypatch, spawn, signing_key, tmp_path):
        try:
            from starlette.testclient import TestClient
        except ImportError:
            pytest.skip("fastapi/starlette not installed")

        home = _desktop_home(tmp_path, ACCOUNT)
        monkeypatch.setenv("HERMES_HOME", str(home))
        _write_store(
            home,
            envelope=_sign_envelope(
                signing_key,
                account_id=OTHER_ACCOUNT,
                entitlements=[{"kind": "skill", "id": "official/creative/pixel-art", "state": "active"}],
                catalog_owned=self.OWNED,
            ),
        )

        import hermes_state
        from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", home / "state.db")
        client = TestClient(app)
        client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN

        resp = client.post("/api/skills/hub/install", json={"identifier": "official/creative/pixel-art"})
        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
        assert spawn == []


# ---------------------------------------------------------------------------
# Chokepoint 2, continued: every path that converges on do_install
# ---------------------------------------------------------------------------


def _fake_official_source(identifier: str = "official/creative/pixel-art"):
    """A source adapter that resolves any alias to the canonical identifier."""

    class _OfficialSource:
        def source_id(self):
            return "official"

        def inspect(self, _identifier):
            return None

        def fetch(self, _identifier):
            return type(
                "Bundle",
                (),
                {
                    "name": "pixel-art",
                    "files": {"SKILL.md": "# Pixel Art"},
                    "source": "official",
                    "identifier": identifier,
                    "trust_level": "builtin",
                    "metadata": {},
                },
            )()

    return _OfficialSource()


@pytest.fixture
def hub_source(monkeypatch):
    """Route do_install's source resolution to the fake official source."""
    import tools.skills_hub as tools_hub
    import tools.skills_hub_search as hub_search

    monkeypatch.setattr(tools_hub, "ensure_hub_dirs", lambda: None)
    monkeypatch.setattr(hub_search, "create_source_router", lambda auth=None: [_fake_official_source()])
    return tools_hub


class TestDoInstallGate:
    OWNED = [_owned_skill("official/creative/pixel-art")]

    def test_do_install_gates_the_canonical_identifier(self, signing_key, hub_source):
        from hermes_cli.skills_hub import do_install
        from hermes_constants import get_default_hermes_root

        _write_store(get_default_hermes_root(), envelope=_sign_envelope(signing_key, catalog_owned=self.OWNED))

        import io
        from rich.console import Console

        console = Console(file=io.StringIO(), force_terminal=False)
        # The raw alias must be gated as the canonical identifier (review B3).
        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            do_install("official/pixel-art", skip_confirm=True, console=console)
        assert excinfo.value.code == proof.PURCHASE_REQUIRED

    def test_do_install_allows_free_skill_with_no_envelope(self, hub_source, monkeypatch):
        from hermes_cli import skills_hub
        import tools.skills_hub_install as hub_install

        quarantined = []

        def _quarantine(bundle):
            quarantined.append(bundle.identifier)
            raise RuntimeError("stop after the gate")

        monkeypatch.setattr(hub_install, "quarantine_bundle", _quarantine)
        monkeypatch.setattr(
            hub_source, "HubLockFile", lambda: type("Lock", (), {"get_installed": lambda self, name: None})()
        )

        import io
        from rich.console import Console

        console = Console(file=io.StringIO(), force_terminal=False)
        with pytest.raises(RuntimeError, match="stop after the gate"):
            skills_hub.do_install("official/pixel-art", skip_confirm=True, console=console)
        assert quarantined == ["official/creative/pixel-art"]

    def test_skills_manage_install_is_gated(self, signing_key, hub_source):
        """Review B2: JSON-RPC skills.manage reaches do_install directly."""
        from tui_gateway import server as gateway
        from hermes_constants import get_default_hermes_root

        _write_store(get_default_hermes_root(), envelope=_sign_envelope(signing_key, catalog_owned=self.OWNED))

        result = gateway._methods["skills.manage"](1, {"action": "install", "query": "official/creative/pixel-art"})
        assert "error" in result
        assert proof.PURCHASE_REQUIRED in result["error"]["message"]
        assert not (get_default_hermes_root() / "skills" / "creative" / "pixel-art").exists()

    def test_slash_install_is_gated(self, tmp_path, signing_key, hub_source):
        """Review B2: slash.exec routes /skills install to handle_skills_slash."""
        import io

        from rich.console import Console

        from hermes_cli import skills_hub
        from hermes_constants import get_default_hermes_root

        _write_store(get_default_hermes_root(), envelope=_sign_envelope(signing_key, catalog_owned=self.OWNED))

        sink = io.StringIO()
        skills_hub.handle_skills_slash(
            "/skills install official/pixel-art", console=Console(file=sink, force_terminal=False)
        )
        assert proof.PURCHASE_REQUIRED in sink.getvalue()
        assert not (get_default_hermes_root() / "skills" / "creative" / "pixel-art").exists()

    def test_cli_install_is_gated(self, tmp_path, signing_key, hub_source, monkeypatch):
        """Review B2: cli.exec runs `hermes skills install`, which lands here."""
        import io
        from argparse import Namespace

        from rich.console import Console

        from hermes_cli import skills_hub
        from hermes_constants import get_default_hermes_root

        _write_store(get_default_hermes_root(), envelope=_sign_envelope(signing_key, catalog_owned=self.OWNED))

        sink = io.StringIO()
        monkeypatch.setattr(skills_hub, "_console", Console(file=sink, force_terminal=False))
        skills_hub.skills_command(
            Namespace(skills_action="install", identifier="official/pixel-art", category="", force=False, yes=True, name=None)
        )
        assert proof.PURCHASE_REQUIRED in sink.getvalue()
        assert not (get_default_hermes_root() / "skills" / "creative" / "pixel-art").exists()


# ---------------------------------------------------------------------------
# Chokepoint 3: definition materialisation
# ---------------------------------------------------------------------------


def _definition(*, skills=None, soul="# Focus\nOnly portable instructions."):
    return {
        "schema_version": 1,
        "soul": soul,
        "model_alias": "binh-minh",
        "reasoning": {"enabled": True, "effort": "medium"},
        "skills": skills or [],
    }


def _ticket(ticket_id: str, *, definition=None, apply_existing=False, account_id=ACCOUNT):
    return {
        "account_id": account_id,
        "expires_at": time.time() + 60,
        "assistant": {"identity_id": IDENTITY, "display_name": "Focus", "avatar": "✨"},
        "definition": definition or _definition(),
        "definition_revision": 1,
        "identity_revision": 1,
        "apply_existing": apply_existing,
    }


def _write_ticket(root: Path, ticket_id: str, data: dict) -> Path:
    ticket_dir = root / ".atum-portability" / "tickets"
    ticket_dir.mkdir(parents=True, exist_ok=True)
    (ticket_dir / f"{ticket_id}.json").write_text(json.dumps(data), encoding="utf-8")
    return ticket_dir


def _write_skill(root: Path, name: str = "writing/example") -> dict[str, str]:
    skill = root / "skills" / name
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Writing\n", encoding="utf-8")
    (skill / "reference.txt").write_text("canonical bytes", encoding="utf-8")
    return {"name": name, "sha256": portability._skill_tree_hash(skill)}


class TestMaterializationChokepoint:
    TICKET_ID = "00000000-0000-4000-8000-bd7662a5eeb4"

    def _owned(self, reference: dict[str, str]) -> list[dict]:
        return [_owned_skill(hashes=[reference["sha256"]])]

    def _setup(self, root: Path) -> dict[str, str]:
        reference = _write_skill(root)  # catalog bytes already on this device
        _write_ticket(root, self.TICKET_ID, _ticket(self.TICKET_ID, definition=_definition(skills=[reference])))
        return reference

    def test_catalog_skill_materializes_with_no_envelope(self, tmp_path):
        """Contract C3 rule 1: no envelope file at all keeps pre-store behaviour."""
        self._setup(tmp_path)
        result = portability.materialize_ticket(tmp_path / ".atum-portability" / "tickets", self.TICKET_ID)
        assert result["status"] == "materialized"

    def test_catalog_skill_refused_with_unusable_envelope(self, tmp_path, signing_key):
        reference = self._setup(tmp_path)
        # Signed by an unpinned key: present, names the skill, unusable.
        stranger = Ed25519PrivateKey.generate()
        _write_store(tmp_path, envelope=_sign_envelope(stranger, catalog_owned=self._owned(reference)))
        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            portability.materialize_ticket(tmp_path / ".atum-portability" / "tickets", self.TICKET_ID)
        assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
        assert not (tmp_path / "profiles" / f"agent-{IDENTITY}").exists()

    def test_catalog_skill_purchase_required_with_bare_proof(self, tmp_path, signing_key):
        reference = self._setup(tmp_path)
        _write_store(tmp_path, envelope=_sign_envelope(signing_key, catalog_owned=self._owned(reference)))
        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            portability.materialize_ticket(tmp_path / ".atum-portability" / "tickets", self.TICKET_ID)
        assert excinfo.value.code == proof.PURCHASE_REQUIRED

    def test_catalog_skill_refused_with_wrong_account_proof(self, tmp_path, signing_key):
        reference = self._setup(tmp_path)
        _write_store(
            tmp_path,
            envelope=_sign_envelope(
                signing_key,
                account_id=OTHER_ACCOUNT,
                entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
                catalog_owned=self._owned(reference),
            ),
        )
        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            portability.materialize_ticket(tmp_path / ".atum-portability" / "tickets", self.TICKET_ID)
        assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE
        assert not (tmp_path / "profiles" / f"agent-{IDENTITY}").exists()

    def test_catalog_skill_materializes_with_active_entitlement(self, tmp_path, signing_key):
        reference = self._setup(tmp_path)
        envelope = _sign_envelope(
            signing_key,
            entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
            catalog_owned=self._owned(reference),
        )
        _write_store(tmp_path, envelope=envelope)

        result = portability.materialize_ticket(tmp_path / ".atum-portability" / "tickets", self.TICKET_ID)
        assert result["status"] == "materialized"
        profile = tmp_path / "profiles" / f"agent-{IDENTITY}"
        assert portability._skill_tree_hash(profile / "skills" / "writing" / "example") == reference["sha256"]

    def _existing_profile_with_skill(self, root: Path, reference: dict[str, str]) -> Path:
        profile = root / "profiles" / f"agent-{IDENTITY}"
        skill = profile / "skills" / "writing" / "example"
        skill.mkdir(parents=True)
        source = root / "skills" / "writing" / "example"
        for file in ("SKILL.md", "reference.txt"):
            (skill / file).write_bytes((source / file).read_bytes())
        (profile / "SOUL.md").write_text(_definition()["soul"], encoding="utf-8")
        (profile / "config.yaml").write_text(
            "model:\n  provider: atum-managed\n  default: binh-minh\nagent:\n  reasoning_effort: medium\n",
            encoding="utf-8",
        )
        (profile / "profile.yaml").write_text(
            "identity_id: 00000000-0000-4000-8000-303617b97302\nmanaged_by: atum\n", encoding="utf-8"
        )
        return profile

    def test_apply_with_already_present_skill_is_not_frozen(self, tmp_path, signing_key):
        """Review H5: the apply gate must not re-verify bytes already in the
        profile — a refund (or a pre-store install) must not freeze every
        later definition sync of this assistant."""
        reference = _write_skill(tmp_path)
        profile = self._existing_profile_with_skill(tmp_path, reference)
        owned = self._owned(reference)

        # Case 1: refunded (revoked) — the skill stays, the soul syncs.
        _write_store(
            tmp_path,
            envelope=_sign_envelope(
                signing_key,
                entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "revoked"}],
                catalog_owned=owned,
            ),
        )
        definition = _definition(skills=[reference], soul="# Focus\nUpdated portable instructions.")
        tickets = _write_ticket(tmp_path, self.TICKET_ID, _ticket(self.TICKET_ID, definition=definition, apply_existing=True))
        result = portability.materialize_ticket(tickets, self.TICKET_ID)
        assert result["status"] == "applied"
        assert (profile / "SOUL.md").read_text(encoding="utf-8") == "# Focus\nUpdated portable instructions."

        # Case 2: pre-store install — a valid proof that simply never lists the
        # item must not freeze later syncs either.
        proof._reset_caches()
        _write_store(tmp_path, envelope=_sign_envelope(signing_key, catalog_owned=owned))
        second_id = "00000000-0000-4000-8000-b454f82c5857"
        definition = _definition(skills=[reference], soul="# Focus\nSecond update.")
        _write_ticket(tmp_path, second_id, _ticket(second_id, definition=definition, apply_existing=True))
        result = portability.materialize_ticket(tickets, second_id)
        assert result["status"] == "applied"

    def test_apply_with_new_catalog_skill_is_gated(self, tmp_path, signing_key):
        """Bytes newly entering the profile are gated even on a sync apply."""
        reference = _write_skill(tmp_path)
        self._existing_profile_with_skill(tmp_path, reference)
        extra = {"name": "writing/other", "sha256": portability._skill_tree_hash(_skill_dir(tmp_path, "writing/other"))}
        owned = self._owned(reference) + [_owned_skill("official/writing/other", hashes=[extra["sha256"]])]
        _write_store(tmp_path, envelope=_sign_envelope(signing_key, catalog_owned=owned))
        definition = _definition(skills=[reference, extra])
        tickets = _write_ticket(tmp_path, self.TICKET_ID, _ticket(self.TICKET_ID, definition=definition, apply_existing=True))

        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            portability.materialize_ticket(tickets, self.TICKET_ID)
        assert excinfo.value.code == proof.PURCHASE_REQUIRED

    def test_uncatalogued_skill_materializes_with_no_store_files(self, tmp_path):
        reference = _write_skill(tmp_path)
        _write_ticket(tmp_path, self.TICKET_ID, _ticket(self.TICKET_ID, definition=_definition(skills=[reference])))
        result = portability.materialize_ticket(tmp_path / ".atum-portability" / "tickets", self.TICKET_ID)
        assert result["status"] == "materialized"


def _skill_dir(root: Path, name: str) -> Path:
    skill = root / "skills" / name
    skill.mkdir(parents=True, exist_ok=True)
    (skill / "SKILL.md").write_text(f"# {name}\n", encoding="utf-8")
    return skill


# ---------------------------------------------------------------------------
# Resolver sources: optional-skills, hash drift, and the catalog fetch seam
# ---------------------------------------------------------------------------


class TestResolverSources:
    def test_find_skills_resolves_from_shipped_optional_skills(self, tmp_path, monkeypatch):
        optional = tmp_path / "optional-skills"
        skill_dir = _write_optional_skill(optional)
        monkeypatch.setenv("HERMES_OPTIONAL_SKILLS", str(optional))

        root = tmp_path / "account"
        root.mkdir()
        reference = {"name": "creative/pixel-art", "sha256": portability._skill_tree_hash(skill_dir)}
        available, missing = portability._find_skills(root, [reference])
        assert missing == []
        assert available == {"creative/pixel-art": skill_dir}

    def test_hash_mismatched_shipped_skill_resolves_locally_when_entitled(
        self, tmp_path, monkeypatch, signing_key
    ):
        """Review H5: a hermes_optional skill whose hash differs from this
        device's optional-skills tree must not dead-end in the unbuilt
        catalog-fetch seam when the entitlement is active."""
        optional = tmp_path / "optional-skills"
        skill_dir = _write_optional_skill(optional)
        monkeypatch.setenv("HERMES_OPTIONAL_SKILLS", str(optional))

        root = tmp_path / "account"
        root.mkdir()
        local_hash = portability._skill_tree_hash(skill_dir)
        cloud_hash = "0" * 64
        assert cloud_hash != local_hash
        reference = {"name": "creative/pixel-art", "sha256": cloud_hash}
        owned = [_owned_skill("official/creative/pixel-art", hashes=[cloud_hash])]
        _write_store(
            root,
            envelope=_sign_envelope(
                signing_key,
                entitlements=[{"kind": "skill", "id": "official/creative/pixel-art", "state": "active"}],
                catalog_owned=owned,
            ),
        )

        mismatches: list[dict] = []
        available, missing = portability._find_skills(root, [reference], account_id=ACCOUNT, mismatches=mismatches)
        assert missing == []
        assert available == {"creative/pixel-art": skill_dir}
        assert mismatches == [
            {"name": "creative/pixel-art", "expected_sha256": cloud_hash, "actual_sha256": local_hash}
        ]

    def test_hash_mismatched_materialization_reports_drift_and_installs_local_bytes(
        self, tmp_path, monkeypatch, signing_key
    ):
        optional = tmp_path / "optional-skills"
        skill_dir = _write_optional_skill(optional)
        monkeypatch.setenv("HERMES_OPTIONAL_SKILLS", str(optional))

        root = tmp_path / "account"
        root.mkdir()
        local_hash = portability._skill_tree_hash(skill_dir)
        cloud_hash = "0" * 64
        reference = {"name": "creative/pixel-art", "sha256": cloud_hash}
        owned = [_owned_skill("official/creative/pixel-art", hashes=[cloud_hash])]
        _write_store(
            root,
            envelope=_sign_envelope(
                signing_key,
                entitlements=[{"kind": "skill", "id": "official/creative/pixel-art", "state": "active"}],
                catalog_owned=owned,
            ),
        )
        ticket_id = "00000000-0000-4000-8000-f6222a1106ee"
        tickets = _write_ticket(root, ticket_id, _ticket(ticket_id, definition=_definition(skills=[reference])))

        result = portability.materialize_ticket(tickets, ticket_id)
        assert result["status"] == "materialized"
        assert result["skill_hash_mismatches"] == [
            {"name": "creative/pixel-art", "expected_sha256": cloud_hash, "actual_sha256": local_hash}
        ]
        profile = root / "profiles" / f"agent-{IDENTITY}"
        assert portability._skill_tree_hash(profile / "skills" / "creative" / "pixel-art") == local_hash

    def test_hash_mismatch_without_entitlement_fails_loudly(self, tmp_path, monkeypatch, signing_key):
        optional = tmp_path / "optional-skills"
        _write_optional_skill(optional)
        monkeypatch.setenv("HERMES_OPTIONAL_SKILLS", str(optional))

        root = tmp_path / "account"
        root.mkdir()
        cloud_hash = "0" * 64
        reference = {"name": "creative/pixel-art", "sha256": cloud_hash}
        owned = [_owned_skill("official/creative/pixel-art", hashes=[cloud_hash])]
        # A valid proof that does not entitle the item: the fetch channel is
        # the only remaining source, and it fails loudly, never silently.
        _write_store(root, envelope=_sign_envelope(signing_key, catalog_owned=owned))
        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            portability._find_skills(root, [reference], account_id=ACCOUNT)
        assert excinfo.value.code == proof.ASSET_UNAVAILABLE_OFFLINE

        # An unusable proof naming the item: unavailable, per contract C3 rule 2.
        proof._reset_caches()
        stranger = Ed25519PrivateKey.generate()
        _write_store(root, envelope=_sign_envelope(stranger, catalog_owned=owned))
        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            portability._find_skills(root, [reference], account_id=ACCOUNT)
        assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE

    def test_catalog_seam_reports_missing_fetcher_as_offline(self, tmp_path, signing_key):
        root = tmp_path / "account"
        root.mkdir()
        sha = "a" * 64
        # A valid proof names the item, but the slice-2 desktop broker does not exist.
        _write_store(
            root,
            envelope=_sign_envelope(
                signing_key,
                entitlements=[{"kind": "skill", "id": "official/catalog/only", "state": "active"}],
                catalog_owned=[_owned_skill("official/catalog/only", hashes=[sha])],
            ),
        )

        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            portability._find_skills(root, [{"name": "catalog/only", "sha256": sha}], account_id=ACCOUNT)
        assert excinfo.value.code == proof.ASSET_UNAVAILABLE_OFFLINE

    def test_uncatalogued_missing_skill_is_reported_not_raised(self, tmp_path, signing_key):
        root = tmp_path / "account"
        root.mkdir()
        reference = {"name": "catalog/only", "sha256": "a" * 64}
        # No envelope at all: pre-store behaviour — simply missing.
        assert portability._find_skills(root, [reference]) == ({}, [reference])

        # An envelope that does not name the skill changes nothing.
        _write_store(
            root,
            envelope=_sign_envelope(signing_key, catalog_owned=[_owned_skill("official/other", hashes=["b" * 64])]),
        )
        assert portability._find_skills(root, [reference]) == ({}, [reference])


# ---------------------------------------------------------------------------
# Preserve the recovery and user-visible behavior covered by this path.
#
# The gate matches an install against the catalog's identifier, so every way
# of naming the same install has to arrive as that identifier. The re-review
# found two that did not: a *containing directory*, which the hub happily
# bundles whole, and a *case variant*, which reaches the same directory on a
# case-insensitive filesystem while carrying the caller's spelling.
# ---------------------------------------------------------------------------


class TestIdentifierSpellings:
    @pytest.mark.parametrize(
        "spelling",
        [
            "official/creative/pixel-art",
            "official/creative/PIXEL-ART",
            "official/CREATIVE/pixel-art",
            "Official/Creative/Pixel-Art",
            "official/creative/pixel-art/",
            "official/creative/./pixel-art",
        ],
    )
    def test_case_and_redundant_segments_still_match_the_paid_item(self, spelling):
        items = [_owned_skill("official/creative/pixel-art")]
        assert proof.match_catalog_item(items, "skill", spelling) is not None

    @pytest.mark.parametrize(
        "container",
        ["official", "official/creative", "official/CREATIVE", "official/creative/."],
    )
    def test_a_directory_containing_a_paid_item_matches_that_item(self, container):
        items = [_owned_skill("official/creative/pixel-art")]
        matched = proof.match_catalog_item(items, "skill", container)
        assert matched is not None and matched["identifier"] == "official/creative/pixel-art"

    def test_a_caller_carrying_a_content_hash_is_never_matched_by_containment(self):
        """The resolver identifies a skill by its bytes, not by a path.

        `atum_portability` asks about `official/<folder name>`, so a local
        skill whose folder happened to be named `creative` would otherwise be
        refused as the catalog's `official/creative/pixel-art`. The install
        paths, which carry no hash, still get the containment rule.
        """
        items = [_owned_skill("official/creative/pixel-art", hashes=["e" * 64])]

        assert proof.match_catalog_item(items, "skill", "official/creative", "f" * 64) is None
        assert proof.match_catalog_item(items, "skill", "official/creative") is not None
        # A hash that does name the item still matches, whatever the string.
        assert proof.match_catalog_item(items, "skill", "something/else", "e" * 64) is not None

    def test_an_unrelated_directory_is_still_free(self):
        items = [_owned_skill("official/creative/pixel-art")]
        assert proof.match_catalog_item(items, "skill", "official/finance") is None
        assert proof.match_catalog_item(items, "skill", "official/creative-extra") is None

    def test_a_pet_slug_is_not_a_path(self):
        items = [_owned_pet("mocha")]
        assert proof.match_catalog_item(items, "pet", "mocha") is not None
        assert proof.match_catalog_item(items, "pet", "MOCHA") is not None
        assert proof.match_catalog_item(items, "pet", "mochaccino") is None

    def test_enforce_refuses_a_case_variant_of_an_unowned_skill(self, tmp_path, signing_key):
        root = _desktop_home(tmp_path)
        _write_store(root, envelope=_sign_envelope(
            signing_key, catalog_owned=[_owned_skill("official/creative/pixel-art")]))
        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            proof.enforce_catalog_item(
                "skill", "official/creative/PIXEL-ART", account_root=root)
        assert excinfo.value.code == proof.PURCHASE_REQUIRED


# ---------------------------------------------------------------------------
# Preserve the recovery and user-visible behavior covered by this path.
# ---------------------------------------------------------------------------


class TestCatalogOwnedCompatibility:
    def test_load_catalog_owned_is_none_without_an_envelope(self, tmp_path):
        assert proof.load_catalog_owned(account_root=_desktop_home(tmp_path)) is None

    def test_owns_answers_by_identifier_and_by_hash(self, tmp_path, signing_key):
        root = _desktop_home(tmp_path)
        _write_store(root, envelope=_sign_envelope(
            signing_key, catalog_owned=[_owned_pet("mocha", "bundled/mocha", hashes=["c" * 64])]))
        owned = proof.load_catalog_owned(account_root=root)
        assert owned is not None
        assert owned.owns("pet", "mocha")
        assert owned.owns("pet", "anything", "c" * 64)
        assert not owned.owns("pet", "boba")
        assert not owned.owns("skill", "mocha")

    def test_atum_content_sync_import_shape(self):
        """PR #288 imports these names under ``except ModuleNotFoundError``.

        A missing *name* raises a plain ``ImportError``, which that guard does
        not catch, so dropping either one takes down every pet-sync ticket the
        moment this branch merges — with the Python files merging cleanly.
        """
        from hermes_cli.atum_store_proof import (
            enforce_catalog_item,
            load_catalog_owned,
        )

        assert callable(load_catalog_owned)
        assert callable(proof.CatalogOwned.owns)


# ---------------------------------------------------------------------------
# Preserve the recovery and user-visible behavior covered by this path.
# ---------------------------------------------------------------------------


class TestDevKeyOverrideIsPreLaunchOnly:
    def test_override_is_ignored_once_any_key_is_pinned(self, tmp_path, monkeypatch, signing_key):
        """With a pinned key present, an envelope naming an unpinned key_id must be
        UNKNOWN even if the environment offers a matching public key. Otherwise a
        forged envelope with self-chosen key material verifies on a shipped build
        and grants active entitlements."""
        root = _desktop_home(tmp_path)
        rogue = Ed25519PrivateKey.generate()
        monkeypatch.setenv("ATUM_STORE_DEV_ENTITLEMENT_PUBLIC_KEY", f"zz:{_public_b64(rogue)}")
        _write_store(root, envelope=_sign_envelope(
            rogue, key_id="zz",
            entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
            catalog_owned=[_owned_skill()]))
        proof._reset_caches()
        # `signing_key` pinned "k1"; "zz" is not pinned, so the override must not apply.
        with pytest.raises(proof.StoreEntitlementError) as excinfo:
            proof.enforce_catalog_item("skill", SKILL_ID, account_root=root)
        assert excinfo.value.code == proof.ENTITLEMENT_UNAVAILABLE_OFFLINE

    def test_override_still_works_before_any_key_is_pinned(self, tmp_path, monkeypatch):
        root = _desktop_home(tmp_path)
        dev = Ed25519PrivateKey.generate()
        monkeypatch.setattr(proof, "PINNED_PUBLIC_KEYS", {})
        monkeypatch.setenv("ATUM_STORE_DEV_ENTITLEMENT_PUBLIC_KEY", f"kdev:{_public_b64(dev)}")
        _write_store(root, envelope=_sign_envelope(
            dev, key_id="kdev",
            entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}],
            catalog_owned=[_owned_skill()]))
        proof._reset_caches()
        proof.enforce_catalog_item("skill", SKILL_ID, account_root=root)  # entitled: no raise


def _real_skill_boundary(tmp_path, monkeypatch, signing_key):
    from hermes_cli.profiles import adopt_profile_identity
    from tools import skills_tool
    from agent import prompt_builder

    home = _desktop_home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    adopt_profile_identity(home, IDENTITY)
    package = home / "skills" / "paid-probe"
    (package / "references").mkdir(parents=True)
    (package / "SKILL.md").write_text("---\nname: paid-probe\ndescription: Paid probe\n---\nPRIVATE_SKILL_SENTINEL\n")
    (package / "references" / "private.md").write_text("PRIVATE_SUPPORT_SENTINEL")
    digest = portability._skill_tree_hash(package)
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", home / "skills")
    skills_tool.clear_skills_cache()
    prompt_builder.clear_skills_system_prompt_cache(clear_snapshot=True)

    def grant(active):
        return _write_store(home, envelope=_sign_envelope(signing_key,
            entitlements=[{"kind": "skill", "id": SKILL_ID, "state": "active"}] if active else [],
            catalog_owned=[_owned_skill(hashes=[digest])]))

    grant(True)
    assert proof.proof_error() is None
    return home, grant


def test_signed_skill_entitlement_controls_real_loader_and_slash_cache(tmp_path, monkeypatch, signing_key):
    from agent import prompt_builder, skill_commands
    from tools import skills_tool

    _home, grant = _real_skill_boundary(tmp_path, monkeypatch, signing_key)
    for active in (True, False, True):
        grant(active)
        assert ("paid-probe" in skills_tool.skills_list()) is active
        assert ("paid-probe" in prompt_builder.build_skills_system_prompt()) is active
        assert ("/paid-probe" in skill_commands.get_skill_commands()) is active
        message = skill_commands.build_skill_invocation_message("/paid-probe")
        assert ("PRIVATE_SKILL_SENTINEL" in (message or "")) is active
        viewed = skills_tool.skill_view("paid-probe")
        assert ("PRIVATE_SKILL_SENTINEL" in viewed) is active
        support = skills_tool.skill_view("paid-probe", file_path="references/private.md")
        assert ("PRIVATE_SUPPORT_SENTINEL" in support) is active


def test_held_skill_cannot_reenter_through_an_old_raw_prompt_snapshot(tmp_path, monkeypatch, signing_key):
    from agent import prompt_builder

    home, grant = _real_skill_boundary(tmp_path, monkeypatch, signing_key)
    assert "paid-probe" in prompt_builder.build_skills_system_prompt()
    snapshot = home / ".skills_prompt_snapshot.json"
    retained = json.loads(snapshot.read_text())
    grant(False)
    # Simulate the merged unguarded builder's valid, raw catalog snapshot.
    retained["manifest"] = prompt_builder._build_skills_manifest(home / "skills")
    snapshot.write_text(json.dumps(retained))
    prompt_builder.clear_skills_system_prompt_cache(clear_snapshot=False)
    assert "paid-probe" not in prompt_builder.build_skills_system_prompt()
