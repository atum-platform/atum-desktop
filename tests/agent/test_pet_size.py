"""Size is a display factor (plan 2026-09-13-pet-plans-rig-and-activities,
decision 1): ``pet.json`` carries it, the loader clamps it, the generator
writes it, and the hatch's ``build`` knob means it.
"""

from __future__ import annotations

import json
import math
from dataclasses import replace
from pathlib import Path

import pytest

from agent.pet import store
from agent.pet.constants import DEFAULT_SIZE, MAX_SIZE, MIN_SIZE, parse_size


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, DEFAULT_SIZE),
        ("", DEFAULT_SIZE),
        ("big", DEFAULT_SIZE),
        (True, DEFAULT_SIZE),
        (math.nan, DEFAULT_SIZE),
        (0.85, 0.85),
        ("1.45", 1.45),
        (0.01, MIN_SIZE),
        (9, MAX_SIZE),
    ],
)
def test_parse_size_defaults_and_clamps(raw: object, expected: float) -> None:
    assert parse_size(raw) == expected


def _pet_dir(root: Path, slug: str, meta: dict) -> Path:
    directory = root / slug
    directory.mkdir()
    (directory / "spritesheet.webp").write_bytes(b"not really a sheet")
    (directory / "pet.json").write_text(json.dumps(meta), encoding="utf-8")
    return directory


def test_load_pet_reads_size_from_the_profile_pets_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # `load_pet` builds its own InstalledPet (it must return a pet whose sheet is
    # missing, unlike `_pet_in`), so it reads size on its own path too.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    store.pets_dir().mkdir(parents=True, exist_ok=True)
    _pet_dir(store.pets_dir(), "big", {"displayName": "Big", "size": 1.45})

    pet = store.load_pet("big")

    assert pet is not None and pet.size == 1.45


def test_loader_reads_size_and_defaults_it(tmp_path: Path) -> None:
    big = store._pet_in("big", _pet_dir(tmp_path, "big", {"displayName": "Big", "size": 1.45}))
    plain = store._pet_in("plain", _pet_dir(tmp_path, "plain", {"displayName": "Plain"}))
    silly = store._pet_in("silly", _pet_dir(tmp_path, "silly", {"displayName": "Silly", "size": 40}))
    assert big is not None and big.size == 1.45
    assert plain is not None and plain.size == 1.0
    assert silly is not None and silly.size == MAX_SIZE


pytest.importorskip("PIL")

from scripts.pets.breeds import BREEDS  # noqa: E402
from scripts.pets.sheet import DEFAULT_OUT, pet_json  # noqa: E402
from scripts.pets.spec import BUILD_SIZE, GIGI_SPEC, breed_from_spec  # noqa: E402


def test_first_party_sizes() -> None:
    # Legacy consumers remain clamped at 2; v5 conveys the visible height.
    assert {slug: breed.size for slug, breed in BREEDS.items()} == {"gigi": 1.0, "mochi": 1.1, "cookie": 0.85, "bailey": 2.0}
    assert BREEDS["mochi"].natural_height_pt == 100
    assert BREEDS["bailey"].natural_height_pt == 210
    assert BREEDS["gigi"].natural_height_pt is None
    assert BREEDS["cookie"].natural_height_pt is None


def test_pet_json_writes_size() -> None:
    assert json.loads(pet_json(BREEDS["bailey"]))["size"] == 2
    assert json.loads(pet_json(BREEDS["gigi"]))["size"] == 1


@pytest.mark.parametrize("slug", sorted(BREEDS))
def test_shipped_pet_json_carries_the_breed_size(slug: str) -> None:
    meta = json.loads((DEFAULT_OUT / slug / "pet.json").read_text(encoding="utf-8"))
    assert meta["size"] == BREEDS[slug].size


def test_build_is_the_size() -> None:
    for build, size in BUILD_SIZE.items():
        assert breed_from_spec(replace(GIGI_SPEC, build=build), slug="x").size == size
    assert BUILD_SIZE["medium"] == 1.0 and BUILD_SIZE["small"] < 1.0 < BUILD_SIZE["large"]
