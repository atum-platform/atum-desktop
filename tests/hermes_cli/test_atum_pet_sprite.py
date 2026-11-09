"""Cold pet rendering uses Hermes geometry without modifying any profile."""

import json
from pathlib import Path

import pytest
from PIL import Image

from hermes_cli.atum_pet_sprite import BUNDLED, read_bundled_sprite


@pytest.fixture
def bundle(tmp_path):
    root = tmp_path / "bundle"
    pet = root / "gigi"
    pet.mkdir(parents=True)
    (pet / "pet.json").write_text(
        json.dumps({
            "displayName": "Gigi",
            "spritesheetPath": "spritesheet.webp",
            "size": 0.8,
        })
    )
    Image.new("RGBA", (192 * 8, 208 * 9), (120, 20, 40, 255)).save(
        pet / "spritesheet.webp"
    )
    return root


def test_bundled_sprite_reuses_geometry_and_never_touches_same_slug_personal_pet(
    bundle, monkeypatch, tmp_path
):
    home = tmp_path / "personal"
    pet = home / "pets" / "gigi"
    pet.mkdir(parents=True)
    (pet / "spritesheet.webp").write_bytes(b"original-custom-pet")
    (home / "config.yaml").write_text(
        "display:\n  pet:\n    enabled: false\n    slug: gigi\n"
    )
    before = {
        p.relative_to(home): p.read_bytes() for p in home.rglob("*") if p.is_file()
    }
    monkeypatch.setenv("HERMES_HOME", str(home))
    result = read_bundled_sprite(bundle, "gigi", 0.33)
    assert result["enabled"] is True
    assert result["scale"] == 0.33
    assert result["size"] == 0.8
    assert result["frameW"] == 192
    assert result["stateRows"][1] == "running-right"
    assert result["framesByRow"]["running-right"] == 8
    assert result["spritesheetBase64"]
    assert {
        p.relative_to(home): p.read_bytes() for p in home.rglob("*") if p.is_file()
    } == before


@pytest.mark.parametrize(
    "slug,scale", [("../gigi", 1), ("personal", 1), ("gigi", float("nan")), ("gigi", 4)]
)
def test_rejects_non_bundled_or_invalid_scale(bundle, slug, scale):
    with pytest.raises(ValueError):
        read_bundled_sprite(bundle, slug, scale)


def test_rejects_manifest_escape_and_symlink(bundle, tmp_path):
    outside = tmp_path / "outside.webp"
    Image.new("RGBA", (192, 208), "red").save(outside)
    manifest = bundle / "gigi" / "pet.json"
    manifest.write_text(json.dumps({"spritesheetPath": str(outside)}))
    with pytest.raises(ValueError):
        read_bundled_sprite(bundle, "gigi", 1)
    manifest.write_text(json.dumps({"spritesheetPath": "link.webp"}))
    (bundle / "gigi" / "link.webp").symlink_to(outside)
    with pytest.raises(ValueError):
        read_bundled_sprite(bundle, "gigi", 1)


def test_actual_repository_bundle_decodes_without_a_home(tmp_path, monkeypatch):
    home = tmp_path / "absent-home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    root = Path(__file__).resolve().parents[2] / "apps" / "desktop" / "assets" / "pets"
    assert set(BUNDLED) == {entry.name for entry in root.iterdir() if entry.is_dir()}
    for slug in BUNDLED:
        assert read_bundled_sprite(root, slug, 0.33)["slug"] == slug
    assert not home.exists()


def test_sprite_payload_caller_cannot_mutate_cached_lists(bundle):
    first = read_bundled_sprite(bundle, "gigi", 1)
    first["extraRows"].append("fake-row")
    first["stateRows"].clear()
    second = read_bundled_sprite(bundle, "gigi", 1)
    assert second["extraRows"] == []
    assert second["stateRows"]


@pytest.mark.parametrize("kind", ["manifest", "sheet", "dimensions"])
def test_rejects_oversize_or_invalid_bundle_geometry(bundle, kind):
    if kind == "manifest":
        (bundle / "gigi" / "pet.json").write_text(" " * 32769, encoding="utf-8")
    elif kind == "sheet":
        (bundle / "gigi" / "spritesheet.webp").write_bytes(b"x" * (4 * 1024 * 1024 + 1))
    else:
        Image.new("RGBA", (191, 208), "red").save(bundle / "gigi" / "spritesheet.webp")
    with pytest.raises(ValueError):
        read_bundled_sprite(bundle, "gigi", 1)
