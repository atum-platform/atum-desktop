"""Pets that ship with the desktop app are adoptable by every profile.

The desktop names a bundled pets directory (``ATUM_BUNDLED_PETS_DIR``); the
store installs from it by copying before it ever asks petdex, and the gallery
lists what is there for every profile. Nothing in the path knows any pet by
name — that is the point, and what these tests hold to.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from agent.pet import store


def _bundle(root: Path, slug: str, display_name: str) -> Path:
    directory = root / slug
    directory.mkdir(parents=True)
    (directory / "pet.json").write_text(
        json.dumps({"id": slug, "displayName": display_name, "description": "", "spritesheetPath": "spritesheet.webp"}),
        encoding="utf-8",
    )
    # install_pet copies bytes; it never decodes the sheet.
    (directory / "spritesheet.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
    return directory


@pytest.fixture
def homes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    bundle = tmp_path / "bundle"
    _bundle(bundle, "gigi", "Gigi")
    _bundle(bundle, "nova", "Nova")
    (bundle / ".thumbs").mkdir()  # dotdirs are not pets
    monkeypatch.setenv("ATUM_BUNDLED_PETS_DIR", str(bundle))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home-a"))
    return tmp_path


def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    import agent.pet.manifest as manifest

    def refuse(*_args, **_kwargs):
        raise AssertionError("the bundle must satisfy this without touching petdex")

    monkeypatch.setattr(manifest, "find_entry", refuse)


def test_bundled_pets_are_listed_without_being_installed(homes: Path) -> None:
    assert [pet.slug for pet in store.bundled_pets()] == ["gigi", "nova"]
    assert store.load_pet("gigi") is None
    assert store.installed_pets() == []


def test_install_copies_from_the_bundle_before_asking_petdex(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _no_network(monkeypatch)

    pet = store.install_pet("gigi")

    assert pet.exists
    assert pet.directory == store.pets_dir() / "gigi"
    assert pet.display_name == "Gigi"
    # The bundle itself is untouched — it is a source, not a store.
    assert (Path(homes / "bundle" / "gigi" / "spritesheet.webp")).is_file()
    assert store.load_pet("gigi") is not None


def test_every_profile_gets_its_own_copy(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _no_network(monkeypatch)
    store.install_pet("gigi")

    monkeypatch.setenv("HERMES_HOME", str(homes / "home-b"))
    assert store.load_pet("gigi") is None, "a second profile starts without it"

    store.install_pet("gigi")

    assert (homes / "home-a" / "pets" / "gigi" / "spritesheet.webp").is_file()
    assert (homes / "home-b" / "pets" / "gigi" / "spritesheet.webp").is_file()


def test_gallery_lists_bundled_pets_for_a_profile_that_lacks_them(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from tui_gateway import server

    _no_network(monkeypatch)
    resp = server._methods["pet.gallery"]("r1", {"localOnly": True})
    pets = {pet["slug"]: pet for pet in resp["result"]["pets"]}

    assert pets["gigi"]["bundled"] is True
    assert pets["gigi"]["installed"] is False
    assert pets["gigi"]["price"] == {"kind": "free"}, "every row says what it costs, like a skill"
    assert pets["nova"]["bundled"] is True

    store.install_pet("gigi")
    resp = server._methods["pet.gallery"]("r2", {"localOnly": True})
    listed = [pet for pet in resp["result"]["pets"] if pet["slug"] == "gigi"]

    assert len(listed) == 1, "installed and bundled are one row, not two"
    assert listed[0]["installed"] is True
    assert listed[0]["bundled"] is True


def test_without_a_bundle_nothing_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATUM_BUNDLED_PETS_DIR", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    import agent.pet.manifest as manifest

    monkeypatch.setattr(manifest, "find_entry", lambda *_a, **_k: None)

    assert store.bundled_pets() == []
    with pytest.raises(store.PetStoreError, match="not in the petdex manifest"):
        store.install_pet("gigi")


def test_a_missing_bundle_directory_is_the_same_as_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATUM_BUNDLED_PETS_DIR", str(tmp_path / "does-not-exist"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))

    assert store.bundled_pets_dir() is None
    assert store.bundled_pets() == []


def test_thumbnail_comes_from_the_bundle_before_install(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("PIL")
    from PIL import Image

    # A real sheet this time: one cell wide, so the idle frame is the whole image.
    sheet = homes / "bundle" / "gigi" / "spritesheet.webp"
    Image.new("RGBA", (192, 208), (255, 0, 0, 255)).save(sheet, format="WEBP")
    _no_network(monkeypatch)

    png = store.thumbnail_png("gigi")

    assert png is not None and png[:8] == b"\x89PNG\r\n\x1a\n"
    assert store.load_pet("gigi") is None, "a thumbnail is not an install"


# --- an install is one rename, or nothing ------------------------------------


def _staging_leftovers() -> list[str]:
    return [p.name for p in store.pets_dir().iterdir() if p.name.startswith((".staging-", ".old-"))]


def test_a_copy_that_dies_halfway_leaves_no_pet_and_no_staging(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _no_network(monkeypatch)

    def die_halfway(src, dst, **kwargs):
        Path(dst).mkdir(parents=True, exist_ok=True)
        (Path(dst) / "pet.json").write_text("{}")  # metadata landed, the sheet never did
        raise OSError("disk full")

    monkeypatch.setattr(store.shutil, "copytree", die_halfway)

    with pytest.raises(OSError, match="disk full"):
        store.install_pet("gigi")

    assert store.load_pet("gigi") is None
    assert not (store.pets_dir() / "gigi").exists()
    assert _staging_leftovers() == []


def test_a_copy_that_quietly_drops_the_sheet_never_becomes_a_pet(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _no_network(monkeypatch)

    def copy_only_metadata(src, dst, **kwargs):
        Path(dst).mkdir(parents=True, exist_ok=True)
        shutil.copy(Path(src) / "pet.json", Path(dst) / "pet.json")

    monkeypatch.setattr(store.shutil, "copytree", copy_only_metadata)

    with pytest.raises(store.PetStoreError, match="did not produce a spritesheet"):
        store.install_pet("gigi")

    assert not (store.pets_dir() / "gigi").exists()
    assert _staging_leftovers() == []


def test_force_replaces_the_pet_wholesale(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _no_network(monkeypatch)
    store.install_pet("gigi")
    stale = store.pets_dir() / "gigi" / "leftover-from-an-earlier-gigi.png"
    stale.write_bytes(b"old")

    pet = store.install_pet("gigi", force=True)

    assert pet.exists
    assert not stale.exists(), "a replaced pet is the new directory, not a merge"
    assert _staging_leftovers() == []


def test_a_failed_replacement_keeps_the_pet_that_was_there(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _no_network(monkeypatch)
    store.install_pet("gigi")
    before = (store.pets_dir() / "gigi" / "spritesheet.webp").read_bytes()
    real_rename = Path.rename

    def fail_the_publish(self: Path, target):
        if self.name.startswith(".staging-"):
            raise OSError("rename failed")
        return real_rename(self, target)

    monkeypatch.setattr(Path, "rename", fail_the_publish)

    with pytest.raises(OSError, match="rename failed"):
        store.install_pet("gigi", force=True)

    pet = store.load_pet("gigi")
    assert pet is not None and pet.exists
    assert (store.pets_dir() / "gigi" / "spritesheet.webp").read_bytes() == before
    assert _staging_leftovers() == []


def test_concurrent_installs_of_one_pet_yield_one_pet(homes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from concurrent.futures import ThreadPoolExecutor

    _no_network(monkeypatch)
    with ThreadPoolExecutor(max_workers=4) as pool:
        pets = list(pool.map(lambda _: store.install_pet("gigi"), range(8)))

    assert all(pet.exists for pet in pets)
    assert sorted(p.name for p in store.pets_dir().iterdir()) == ["gigi"]
    assert (store.pets_dir() / "gigi" / "spritesheet.webp").is_file()


def test_a_generated_pet_is_published_by_one_rename_and_never_over_a_neighbour(homes: Path) -> None:
    pytest.importorskip("PIL")
    from PIL import Image

    sheet = Image.new("RGBA", (192, 208), (255, 0, 0, 255))
    first = store.register_local_pet(sheet, slug="pip", display_name="Pip", replace=False)
    assert first.exists and first.slug == "pip"
    assert _staging_leftovers() == []

    with pytest.raises(store.SlugTakenError):
        store.register_local_pet(sheet, slug="pip", display_name="Pip again", replace=False)
    assert store.load_pet("pip").display_name == "Pip", "the first stays"

    # The default keeps the old contract: a re-register replaces.
    again = store.register_local_pet(sheet, slug="pip", display_name="Pip again")
    assert again.display_name == "Pip again"
    assert _staging_leftovers() == []
