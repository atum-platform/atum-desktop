"""The point-of-use gate (plan 2026-09-12-store-enforcement-architecture).

Identity is intrinsic — a provenance stamp written by the installer, then the
bytes, never the directory name — and the gate sits on the verb that yields a
usable object: the pet loaders mark, the render verbs refuse; the skill walker
and every skill body reader consult one ``skill_hold``.

Every check here is the acceptance list from the plan, as it was reviewed.
Test keys are generated with ``cryptography``; no key material is committed.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from agent.pet import provenance as prov
from agent.pet import store
from hermes_cli import atum_store_proof as proof
from tests.hermes_cli.test_atum_store_proof import (
    IDENTITY,
    _desktop_home,
    _owned_pet,
    _owned_skill,
    _sign_envelope,
    _write_store,
    signing_key,  # noqa: F401 - fixture re-export
)



def _png(color: tuple[int, int, int, int]) -> bytes:
    """A real, tiny image: the store validates sheets with PIL."""
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGBA", (16, 16), color).save(buf, format="PNG")
    return buf.getvalue()


MOCHA_SHEET = _png((120, 80, 40, 255))
OTHER_SHEET = _png((40, 160, 80, 255))


def _bundled_pet(root: Path, slug: str, sheet: bytes) -> Path:
    d = root / slug
    d.mkdir(parents=True)
    (d / "pet.json").write_text(json.dumps({"id": slug, "displayName": slug.title(), "description": ""}))
    (d / "spritesheet.png").write_bytes(sheet)
    return d


@pytest.fixture
def homes(tmp_path, monkeypatch):
    """A desktop-layout Hermes home, a pets dir inside it, and a bundle beside it."""
    root = _desktop_home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(root))
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    _bundled_pet(bundle, "mocha", MOCHA_SHEET)
    pets = root / "pets"
    pets.mkdir()
    monkeypatch.setattr(store, "pets_dir", lambda: pets)
    monkeypatch.setattr(store, "bundled_pets_dir", lambda: bundle)
    proof._reset_caches()
    return root, pets, bundle


def _envelope_without_mocha(signing_key):
    return _sign_envelope(signing_key, catalog_owned=[_owned_pet("mocha", "bundled/mocha")])


def _envelope_with_mocha(signing_key):
    return _sign_envelope(
        signing_key,
        catalog_owned=[_owned_pet("mocha", "bundled/mocha")],
        entitlements=[{"kind": "pet", "id": "bundled/mocha", "state": "active"}],
    )


# ---------------------------------------------------------------------------
# D1: the installer stamps, the publisher refuses an unstamped directory
# ---------------------------------------------------------------------------


class TestProvenanceStamp:
    def test_install_pet_stamps_a_bundled_pet_and_the_hash_ignores_the_stamp(self, homes, signing_key):
        root, pets, bundle = homes
        _write_store(root, envelope=_envelope_with_mocha(signing_key))
        pet = store.install_pet("mocha")
        stamp = prov.read_stamp(pet.directory)
        assert stamp is not None and (stamp.source, stamp.identifier) == ("bundled", "mocha")
        from hermes_cli.atum_pet_bundles import export_pet_bundle

        assert stamp.tree_sha256 == export_pet_bundle(bundle / "mocha")["sha256"]
        # The stamp is a dotfile the bundle exporter skips: hashing the
        # installed copy gives the bundle's hash, not a new one.
        assert export_pet_bundle(pet.directory)["sha256"] == stamp.tree_sha256

    def test_the_publisher_refuses_a_staging_directory_without_a_stamp(self, homes):
        root, pets, _ = homes
        staging = pets / ".staging-nostamp"
        staging.mkdir()
        (staging / "pet.json").write_text(json.dumps({"id": "x", "displayName": "X"}))
        (staging / "spritesheet.png").write_bytes(OTHER_SHEET)
        with pytest.raises(store.PetStoreError, match="provenance stamp"):
            store._publish_pet_dir(staging, pets / "x")

    def test_register_local_pet_stamps_personal(self, homes):
        root, pets, _ = homes
        pet = store.register_local_pet(OTHER_SHEET, slug="frog", display_name="Frog")
        stamp = prov.read_stamp(pet.directory)
        assert stamp is not None and stamp.source == "personal" and stamp.catalog_identifier is None

    def test_an_unstamped_copy_is_identified_by_its_bytes_offline(self, homes):
        """No envelope at all: the first load still stamps, from local truth."""
        root, pets, bundle = homes
        shutil.copytree(bundle / "mocha", pets / "zz")
        assert prov.read_stamp(pets / "zz") is None
        pet = store.load_pet("zz")
        assert pet is not None and pet.held is None  # rule 1: no envelope, no hold
        stamp = prov.read_stamp(pets / "zz")
        assert stamp is not None and (stamp.source, stamp.identifier) == ("bundled", "mocha")

    def test_an_unstamped_copy_of_unknown_bytes_is_personal(self, homes):
        root, pets, _ = homes
        d = pets / "frog"
        d.mkdir()
        (d / "pet.json").write_text(json.dumps({"id": "frog", "displayName": "Frog"}))
        (d / "spritesheet.png").write_bytes(OTHER_SHEET)
        store.load_pet("frog")
        stamp = prov.read_stamp(d)
        assert stamp is not None and stamp.source == "personal"


# ---------------------------------------------------------------------------
# D2/D3: loaders mark, render verbs refuse, and the name is never identity
# ---------------------------------------------------------------------------


class TestPointOfUseGate:
    def test_a_copied_paid_pet_under_another_name_is_held(self, homes, signing_key):
        root, pets, bundle = homes
        _write_store(root, envelope=_envelope_without_mocha(signing_key))
        shutil.copytree(bundle / "mocha", pets / "latte")
        pet = store.load_pet("latte")
        assert pet is not None and pet.held == proof.PURCHASE_REQUIRED
        assert store.resolve_active_pet("latte") is None
        assert store.active_pet_hold("latte").slug == "latte"
        assert store.sheet_for("latte") is None
        with pytest.raises(store.PetStoreError, match=proof.PURCHASE_REQUIRED):
            store.export_pet("latte")

    def test_rename_does_not_change_the_answer(self, homes, signing_key):
        root, pets, bundle = homes
        _write_store(root, envelope=_envelope_with_mocha(signing_key))
        store.install_pet("mocha")
        new_slug = store.rename_pet("mocha", "Latte")
        assert new_slug == "latte"
        # Owned: still usable under the new name.
        assert store.load_pet("latte").held is None
        # Revoked: held under the new name — the stamp, not the name, is identity.
        _write_store(root, envelope=_sign_envelope(
            signing_key,
            catalog_owned=[_owned_pet("mocha", "bundled/mocha")],
            entitlements=[{"kind": "pet", "id": "bundled/mocha", "state": "revoked"}],
        ))
        proof._reset_caches()
        assert store.load_pet("latte").held == proof.ENTITLEMENT_REVOKED

    def test_a_held_configured_pet_is_never_swapped_for_another(self, homes, signing_key):
        root, pets, bundle = homes
        _write_store(root, envelope=_envelope_without_mocha(signing_key))
        shutil.copytree(bundle / "mocha", pets / "mocha")
        store.register_local_pet(OTHER_SHEET, slug="frog", display_name="Frog")
        # The configured slug is held: no fallback to the alphabetical first pet.
        assert store.resolve_active_pet("mocha") is None
        # Nothing configured: the first USABLE pet.
        assert store.resolve_active_pet("").slug == "frog"

    def test_one_byte_of_drift_escapes_the_hash_lane_by_design(self, homes, signing_key):
        """Decision 7, documented: a person can edit their own bytes."""
        root, pets, bundle = homes
        _write_store(root, envelope=_envelope_without_mocha(signing_key))
        shutil.copytree(bundle / "mocha", pets / "zz")
        (pets / "zz" / "spritesheet.png").write_bytes(MOCHA_SHEET + b"!")
        assert store.load_pet("zz").held is None

    def test_an_envelope_change_takes_effect_on_the_next_load_without_a_restart(self, homes, signing_key):
        root, pets, bundle = homes
        shutil.copytree(bundle / "mocha", pets / "mocha")
        assert store.load_pet("mocha").held is None
        _write_store(root, envelope=_envelope_without_mocha(signing_key))
        assert store.load_pet("mocha").held == proof.PURCHASE_REQUIRED
        _write_store(root, envelope=_envelope_with_mocha(signing_key))
        assert store.load_pet("mocha").held is None

    def test_the_render_verbs_depend_on_the_loader_and_on_nothing_else(self, homes, signing_key, monkeypatch):
        """What "structural" means: neutralise the one hold and the pet renders;
        the acquisition-time courtesy gate is not what protects the render."""
        root, pets, bundle = homes
        _write_store(root, envelope=_envelope_without_mocha(signing_key))
        shutil.copytree(bundle / "mocha", pets / "mocha")
        monkeypatch.setattr(store, "_enforce_catalog_pet", lambda slug: None)  # courtesy gate off
        assert store.resolve_active_pet("mocha") is None  # still refused
        monkeypatch.setattr(store, "_hold_reason", lambda directory: None)  # the loader's hold off
        assert store.resolve_active_pet("mocha").slug == "mocha"  # now it renders

    def test_steady_state_neither_verifies_nor_hashes(self, homes, signing_key, monkeypatch):
        root, pets, bundle = homes
        _write_store(root, envelope=_envelope_with_mocha(signing_key))
        store.install_pet("mocha")
        store.load_pet("mocha")  # warm
        import hermes_cli.atum_pet_bundles as bundles

        hashes = {"n": 0}
        real = bundles.export_pet_bundle
        monkeypatch.setattr(bundles, "export_pet_bundle", lambda *a, **k: hashes.__setitem__("n", hashes["n"] + 1) or real(*a, **k))
        verifies = {"n": 0}
        real_verify = proof._verify_envelope_file
        monkeypatch.setattr(proof, "_verify_envelope_file", lambda *a, **k: verifies.__setitem__("n", verifies["n"] + 1) or real_verify(*a, **k))
        for _ in range(100):
            assert store.resolve_active_pet("mocha").slug == "mocha"
        assert hashes["n"] == 0 and verifies["n"] == 0


# ---------------------------------------------------------------------------
# Skills: one hold, applied by the walker and by every body reader
# ---------------------------------------------------------------------------


@pytest.fixture
def skills_home(tmp_path, monkeypatch):
    root = _desktop_home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(root))
    # Training ownership now belongs to the persistent profile identity in the
    # signed fixture. An account root without that identity is not licensed.
    from hermes_cli.profiles import adopt_profile_identity

    adopt_profile_identity(root, IDENTITY)
    optional = tmp_path / "optional-skills"
    paid = optional / "creative" / "pixel-art"
    paid.mkdir(parents=True)
    (paid / "SKILL.md").write_text("---\nname: pixel-art\ndescription: paid\n---\n# Pixel art\n")
    skills = root / "skills"
    skills.mkdir()
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_optional_skills_dir", lambda *a, **k: optional)
    from agent import skill_utils

    monkeypatch.setattr(skill_utils, "get_skills_dir", lambda: skills)
    monkeypatch.setattr(skill_utils, "get_external_skills_dirs", lambda: [])
    skill_utils._HOLD_CACHE.clear()
    proof._reset_caches()
    proof._reference_hash_cache.clear()
    return root, skills, optional


class TestSkillHold:
    def test_a_hand_copied_paid_skill_is_held_by_its_bytes(self, skills_home, signing_key):
        root, skills, optional = skills_home
        _write_store(root, envelope=_sign_envelope(signing_key, catalog_owned=[_owned_skill("official/creative/pixel-art")]))
        shutil.copytree(optional / "creative" / "pixel-art", skills / "creative" / "Pixel-Art")
        from agent.skill_utils import iter_held_skill_index_files, iter_skill_index_files, skill_hold

        assert skill_hold(skills / "creative" / "Pixel-Art") == proof.PURCHASE_REQUIRED
        assert list(iter_skill_index_files(skills, "SKILL.md")) == []
        assert [r for _, r in iter_held_skill_index_files(skills)] == [proof.PURCHASE_REQUIRED]

    def test_an_entitled_skill_is_listed(self, skills_home, signing_key):
        root, skills, optional = skills_home
        _write_store(root, envelope=_sign_envelope(
            signing_key,
            catalog_owned=[_owned_skill("official/creative/pixel-art")],
            entitlements=[{"kind": "skill", "id": "official/creative/pixel-art", "state": "active"}],
        ))
        shutil.copytree(optional / "creative" / "pixel-art", skills / "creative" / "pixel-art")
        from agent.skill_utils import iter_skill_index_files

        assert [p.parent.name for p in iter_skill_index_files(skills, "SKILL.md")] == ["pixel-art"]

    def test_no_envelope_means_no_hold_and_no_hashing(self, skills_home, monkeypatch):
        root, skills, optional = skills_home
        shutil.copytree(optional / "creative" / "pixel-art", skills / "creative" / "pixel-art")
        import hermes_cli.atum_portability as portability

        monkeypatch.setattr(portability, "_skill_tree_hash", lambda d: (_ for _ in ()).throw(AssertionError("hashed without an envelope")))
        from agent.skill_utils import iter_skill_index_files

        assert [p.parent.name for p in iter_skill_index_files(skills, "SKILL.md")] == ["pixel-art"]

    def test_the_epoch_invalidates_the_hold_cache(self, skills_home, signing_key):
        root, skills, optional = skills_home
        shutil.copytree(optional / "creative" / "pixel-art", skills / "creative" / "pixel-art")
        from agent.skill_utils import skill_hold

        _write_store(root, envelope=_sign_envelope(signing_key, catalog_owned=[_owned_skill("official/creative/pixel-art")]))
        assert skill_hold(skills / "creative" / "pixel-art") == proof.PURCHASE_REQUIRED
        _write_store(root, envelope=_sign_envelope(
            signing_key,
            catalog_owned=[_owned_skill("official/creative/pixel-art")],
            entitlements=[{"kind": "skill", "id": "official/creative/pixel-art", "state": "active"}],
        ))
        assert skill_hold(skills / "creative" / "pixel-art") is None
