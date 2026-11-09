"""Real filesystem contracts for Atum's portable pet bytes."""

from __future__ import annotations

import json
import base64
from pathlib import Path

import pytest
from PIL import Image

from hermes_cli.atum_pet_bundles import PetBundleError, export_pet_bundle, install_pet_bundle, validate_pet_bundle


def _pet(root: Path, slug: str = "moss", *, name: str = "Moss", description: str = "first") -> Path:
    directory = root / slug
    directory.mkdir(parents=True)
    Image.new("RGBA", (192, 208), (30, 120, 70, 255)).save(directory / "spritesheet.webp", format="WEBP")
    (directory / "pet.json").write_text(json.dumps({"id": slug, "displayName": name, "description": description, "spritesheetPath": "spritesheet.webp", "createdBy": "generator"}), encoding="utf-8")
    return directory


def test_bundle_hash_ignores_cosmetic_rename_and_canonicalizes_spec(tmp_path):
    pet = _pet(tmp_path)
    (pet / "spec.json").write_text('{ "z": 2, "a": 1 }', encoding="utf-8")
    first = export_pet_bundle(pet)
    (pet / "pet.json").write_text(json.dumps({"id": "renamed", "displayName": "Elsewhere", "description": "changed", "spritesheetPath": "spritesheet.webp", "createdBy": "generator"}), encoding="utf-8")
    second = export_pet_bundle(pet)

    assert second["sha256"] == first["sha256"]
    validated = validate_pet_bundle(second)
    wire_fixture = tmp_path / "platform-pet-bundle-v1.json"
    wire_fixture.write_text(json.dumps(validated, separators=(",", ":")), encoding="utf-8")
    assert validate_pet_bundle(json.loads(wire_fixture.read_text())) == validated
    spec = next(item for item in validated["files"] if item["path"] == "spec.json")
    assert spec["content_base64"] == "eyJhIjoxLCJ6IjoyfQ=="
    noncanonical = json.loads(json.dumps(validated))
    next(item for item in noncanonical["files"] if item["path"] == "spec.json")["content_base64"] = base64.b64encode(b'{ "a": 1, "z": 2 }').decode("ascii")
    with pytest.raises(PetBundleError, match="canonical"):
        validate_pet_bundle(noncanonical)


def test_bundle_rejects_noncanonical_paths_symlinks_and_installs_without_overwrite(tmp_path):
    source = _pet(tmp_path / "source")
    (source / ".cache").write_text("skip", encoding="utf-8")
    bundle = export_pet_bundle(source)
    first = install_pet_bundle(tmp_path / "home" / "pets", bundle, "moss", metadata={"display_name": "Moss", "description": "first"})
    second = install_pet_bundle(tmp_path / "home" / "pets", bundle, "moss", metadata={"display_name": "Moss", "description": "second"})
    assert first.name == "moss"
    assert second.name == "moss-2"
    assert json.loads((first / "pet.json").read_text())["description"] == "first"

    invalid = {**bundle, "files": [{"path": "../pet.json", "content_base64": "e30="}]}
    with pytest.raises(PetBundleError):
        validate_pet_bundle(invalid)
    linked = _pet(tmp_path / "linked")
    (linked / "spec.json").unlink(missing_ok=True)
    (linked / "unexpected").symlink_to(linked / "pet.json")
    with pytest.raises(PetBundleError, match="regular files"):
        export_pet_bundle(linked)


def test_platform_wire_fixture_and_maximum_slug_collision_are_portable(tmp_path):
    fixture = Path(__file__).parents[1] / "fixtures" / "atum-pet-bundle-v1.json"
    assert validate_pet_bundle(json.loads(fixture.read_text(encoding="utf-8")))["sha256"] == "1f52c61f7478dd9e77e7379fb2b3e0fdfd572f0652fbc2bfddb4c0923d423107"

    slug = "m" * 80
    source = _pet(tmp_path / "source", slug)
    bundle = export_pet_bundle(source)
    first = install_pet_bundle(tmp_path / "home" / "pets", bundle, slug)
    second = install_pet_bundle(tmp_path / "home" / "pets", bundle, slug)
    assert first.name == slug
    assert second.name == f"{'m' * 78}-2"
