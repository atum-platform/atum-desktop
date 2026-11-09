"""A slug is an item's identity: one bare segment, or nothing at all.

Canonicalising (``x/boba`` → ``boba``) would let a request for one thing be
answered with another, and would make the cache and pets directory keyed on
a value the caller never sent. So the store rejects, and never rewrites.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.pet import store


@pytest.mark.parametrize(
    "bad",
    [
        "",
        " ",
        ".",
        "..",
        "../boba",
        "/abs/boba",
        "x/boba",
        "x\\boba",
        "boba/",
        ".sheets",
        ".staging-boba-1",
        "a..b",
        "Boba",
        "bo ba",
        "bo\x00ba",
        "bóba",
        "bo\nba",
        "a" * 81,
        # Win32 strips a trailing period from every path segment, so "mocha."
        # would open the bundled "mocha" while carrying an identity the
        # Preserve the recovery and user-visible behavior covered by this path.
        "mocha.",
        "boba..",
        "boba.",
    ],
)
def test_anything_but_one_bare_segment_is_rejected(bad: str) -> None:
    assert store._safe_slug(bad) == ""


@pytest.mark.parametrize("good", ["boba", "codex-frog", "nukey_2", "v1.2", "a", "0", "a" * 80])
def test_a_bare_segment_passes_through_unchanged(good: str) -> None:
    assert store._safe_slug(good) == good


def test_surrounding_whitespace_is_the_one_thing_forgiven() -> None:
    # The RPC layer strips too; a slug is never *made* of whitespace.
    assert store._safe_slug(" boba\n") == "boba"


def test_a_path_shaped_slug_cannot_alias_an_installed_pet(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("ATUM_BUNDLED_PETS_DIR", raising=False)
    directory = store.pets_dir() / "boba"
    directory.mkdir()
    (directory / "pet.json").write_text(json.dumps({"id": "boba", "displayName": "Boba", "spritesheetPath": "spritesheet.webp"}))
    (directory / "spritesheet.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBP")

    assert store.load_pet("boba") is not None
    assert store.load_pet("x/boba") is None
    assert store.load_pet("../boba") is None
    assert store.sheet_for("x/boba") is None
    assert store.remove_pet("x/boba") is False
    assert store.load_pet("boba") is not None, "the real pet is untouched"
    with pytest.raises(store.PetStoreError, match="invalid pet slug"):
        store.install_pet("x/boba")


def test_dotdirs_beside_the_pets_are_never_pets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    for name in (".staging-boba-abc", ".old-boba-abc", ".sheets"):
        directory = store.pets_dir() / name
        directory.mkdir()
        (directory / "pet.json").write_text(json.dumps({"id": "boba", "spritesheetPath": "spritesheet.webp"}))
        (directory / "spritesheet.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBP")

    assert store.installed_pets() == []


def test_a_thumbnail_slug_is_validated_before_it_names_a_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("PIL")
    from PIL import Image

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("ATUM_BUNDLED_PETS_DIR", raising=False)
    directory = store.pets_dir() / "boba"
    directory.mkdir()
    (directory / "pet.json").write_text(json.dumps({"id": "boba", "displayName": "Boba", "spritesheetPath": "spritesheet.webp"}))
    Image.new("RGBA", (192, 208), (255, 0, 0, 255)).save(directory / "spritesheet.webp", format="WEBP")
    monkeypatch.setattr(store, "_fetch_bytes", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")))
    before = sorted(p.name for p in tmp_path.rglob("*.png"))

    assert store.thumbnail_png("boba") is not None
    for bad in ("../boba", "/tmp/evil", "x/boba", "..", ".sheets"):
        assert store.thumbnail_png(bad, source_url="https://petdex.dev/pets/boba/spritesheet.webp") is None

    written = sorted(p.name for p in tmp_path.rglob("*.png"))
    assert written == sorted([*before, "boba.png"]), "only the real pet's thumb was written, and only under .thumbs"
    assert (store.pets_dir() / ".thumbs" / "boba.png").is_file()


def test_the_thumb_rpc_rejects_a_path_shaped_slug(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from tui_gateway import server

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(store, "_fetch_bytes", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")))

    for bad in ("../../evil", "/abs/evil", "x/boba"):
        resp = server._methods["pet.thumb"]("r1", {"slug": bad, "url": "https://petdex.dev/pets/boba/spritesheet.webp"})
        assert resp["result"] == {"ok": False, "slug": bad}

    assert not list((tmp_path / "home").rglob("*.png"))


def test_a_generated_pet_never_takes_a_bundled_pet_s_slug(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bundled slug is a Store identity.

    The entitlement gate matches a pet by slug, so a locally generated pet
    handed the slug of a catalog pet would be refused as that pet
    (re-review 2026-09-12).
    """
    pets = tmp_path / "pets"
    pets.mkdir()
    bundled = tmp_path / "bundled"
    (bundled / "mocha").mkdir(parents=True)
    (bundled / "mocha" / "pet.json").write_text(json.dumps({"displayName": "Mocha"}))
    (bundled / "mocha" / "spritesheet.webp").write_bytes(b"webp")
    monkeypatch.setattr(store, "pets_dir", lambda: pets)
    monkeypatch.setattr(store, "bundled_pets_dir", lambda: bundled)

    assert store.unique_slug("Mocha") == "mocha-2"
    assert store.unique_slug("Boba") == "boba"
    # reserve_unique_slug is the one the hatch and generate paths actually
    # publish through, so the guard has to be there too — it was not, and a
    # generated pet could still take a catalog pet's slug and be refused as it.
    assert store.reserve_unique_slug("Mocha") == "mocha-2"
    store.release_slug("mocha-2")
    assert store.reserve_unique_slug("Boba") == "boba"
    store.release_slug("boba")
