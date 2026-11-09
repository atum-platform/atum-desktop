"""Real atlas/store/bundle behavior for additive v5 presentation metadata."""

import base64
from dataclasses import replace
import json
from pathlib import Path
import shutil

import pytest

pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from agent.pet import constants, payload, store  # noqa: E402
from hermes_cli.atum_pet_bundles import PetBundleError, export_pet_bundle, install_pet_bundle, validate_pet_bundle  # noqa: E402

SHIPPED = Path(__file__).resolve().parents[2] / "apps/desktop/assets/pets/gigi"
V5 = {
    "sizeClass": {"naturalHeightPt": 210},
    "anchor": {"footY": 195, "centerX": 95.5},
    "bounds": {"idle": {"x": 26, "y": 76, "width": 139, "height": 119}},
    "locomotion": "hop",
}


def pet_directory(tmp_path, metadata=None):
    directory = tmp_path / "gigi"
    shutil.copytree(SHIPPED, directory)
    meta = json.loads((directory / "pet.json").read_text())
    meta.update(metadata or {})
    (directory / "pet.json").write_text(json.dumps(meta))
    return directory


def test_real_atlas_derives_idle_anchor_and_row_unions(tmp_path):
    pet = store._pet_in("gigi", pet_directory(tmp_path))
    result = payload._pet_sprite_payload(pet, scale=0.33)
    assert "sizeClass" not in result  # Never infer a size that changes an old pet.
    assert result["locomotion"] == "walk"
    with Image.open(pet.spritesheet) as opened:
        image = opened.convert("RGBA")
    idle = image.crop((0, 0, constants.FRAME_W, constants.FRAME_H)).getchannel("A").getbbox()
    assert result["anchor"] == {"footY": idle[3], "centerX": (idle[0] + idle[2]) / 2}
    rows = [*constants.V3_STATE_ROWS, *constants.LOOK_ROW_NAMES, *pet.extra_rows]
    for row_index, row in enumerate(rows):
        mask = Image.new("L", (constants.FRAME_W, constants.FRAME_H))
        from PIL import ImageChops
        for col in range(image.width // constants.FRAME_W):
            x, y = col * constants.FRAME_W, row_index * constants.FRAME_H
            alpha = image.crop((x, y, x + constants.FRAME_W, y + constants.FRAME_H)).getchannel("A")
            mask = ImageChops.lighter(mask, alpha)
        x, y, right, bottom = mask.getbbox()
        assert result["bounds"][row] == {"x": x, "y": y, "width": right - x, "height": bottom - y}


def test_store_bundle_and_payload_keep_fields_and_do_not_share_mutable_cache(tmp_path):
    directory = pet_directory(tmp_path, {**V5, "unrelatedLocalSecret": "not portable"})
    pet = store._pet_in("gigi", directory)
    first = payload._pet_sprite_payload(pet, scale=1)
    assert {key: first[key] for key in V5} == V5
    first["sizeClass"]["naturalHeightPt"] = 40
    first["anchor"]["footY"] = 0
    first["bounds"]["idle"]["width"] = 1
    assert {key: payload._pet_sprite_payload(pet, scale=1)[key] for key in V5} == V5
    changed = replace(pet, size_class={"naturalHeightPt": 100})
    assert payload._pet_sprite_payload(changed, scale=1)["sizeClass"] == {"naturalHeightPt": 100}
    bundle = export_pet_bundle(directory)
    assert validate_pet_bundle(bundle) == bundle
    meta = json.loads(base64.b64decode(next(f["content_base64"] for f in bundle["files"] if f["path"] == "pet.json")))
    assert {key: meta[key] for key in V5} == V5
    assert "unrelatedLocalSecret" not in meta
    installed = install_pet_bundle(tmp_path / "installed", bundle, "gigi")
    restored = store._pet_in("gigi", installed)
    assert restored.size_class == pet.size_class
    assert restored.anchor == pet.anchor
    assert restored.bounds == pet.bounds
    assert restored.locomotion == "hop"
    assert export_pet_bundle(installed)["sha256"] == bundle["sha256"]


@pytest.mark.parametrize("bad", [39, 301, True, float("nan"), float("inf"), "210", 1 << 4096])
def test_size_class_rejects_invalid_values(bad):
    assert constants.parse_size_class({"naturalHeightPt": bad}) is None


@pytest.mark.parametrize("bad", [
    {"anchor": {"footY": 209, "centerX": 96}},
    {"bounds": {"idle": {"x": 190, "y": 0, "width": 3, "height": 208}}},
    {"bounds": {"__proto__": {"x": 0, "y": 0, "width": 192, "height": 208}}},
    {"locomotion": "teleport"},
])
def test_portable_bundle_rejects_invalid_v5_metadata(tmp_path, bad):
    with pytest.raises(PetBundleError, match="invalid pet"):
        export_pet_bundle(pet_directory(tmp_path, bad))


def test_legacy_size_and_row_parsing_ignore_v5_metadata():
    legacy = {"size": 3, "extraRows": ["sleep", "carried"]}
    meta = {**legacy, **V5}
    assert constants.parse_size(meta["size"]) == constants.parse_size(legacy["size"])
    assert constants.parse_extra_rows(meta["extraRows"]) == constants.parse_extra_rows(legacy["extraRows"])


def test_profile_loader_and_manifest_only_change_invalidate_payload_cache(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    root = tmp_path / "pets"
    root.mkdir()
    directory = pet_directory(root, V5)
    before = payload._pet_sprite_payload(store.load_pet("gigi"), scale=1)
    assert before["sizeClass"] == V5["sizeClass"]
    meta = json.loads((directory / "pet.json").read_text())
    meta["sizeClass"]["naturalHeightPt"] = 100
    (directory / "pet.json").write_text(json.dumps(meta))
    after = payload._pet_sprite_payload(store.load_pet("gigi"), scale=1)
    assert before["spritesheetRevision"] == after["spritesheetRevision"]
    assert after["sizeClass"] == {"naturalHeightPt": 100}
