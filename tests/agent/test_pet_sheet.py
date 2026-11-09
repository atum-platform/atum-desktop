"""A sheet for any pet, without installing it — what lets a store card move.

Source preference is installed, then bundled, then a petdex sheet cached on
disk; anything else is refused, the same host pin ``thumbnail_png`` applies.
A cached sheet is never an install.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.pet import store


def _pet_dir(root: Path, slug: str, name: str) -> Path:
    directory = root / slug
    directory.mkdir(parents=True)
    (directory / "pet.json").write_text(json.dumps({"id": slug, "displayName": name, "spritesheetPath": "spritesheet.webp"}), encoding="utf-8")
    (directory / "spritesheet.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
    return directory


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ATUM_BUNDLED_PETS_DIR", str(tmp_path / "bundle"))
    _pet_dir(tmp_path / "bundle", "gigi", "Gigi")
    return tmp_path


def test_prefers_an_installed_pet_over_the_bundle(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import agent.pet.manifest as manifest

    monkeypatch.setattr(manifest, "find_entry", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no network")))
    store.install_pet("gigi")

    pet = store.sheet_for("gigi")

    assert pet is not None and pet.directory == store.pets_dir() / "gigi"


def test_a_bundled_pet_renders_before_it_is_installed(home: Path) -> None:
    pet = store.sheet_for("gigi")

    assert pet is not None and pet.exists
    assert pet.directory == home / "bundle" / "gigi"
    assert store.load_pet("gigi") is None, "a sheet is not an install"


def test_a_petdex_sheet_is_fetched_once_into_the_cache(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_download(url: str, dest: Path, *, timeout: float) -> None:
        calls.append(url)
        dest.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")

    monkeypatch.setattr(store, "_download", fake_download)
    url = "https://petdex.dev/pets/boba/spritesheet.webp"

    first = store.sheet_for("boba", source_url=url)
    second = store.sheet_for("boba", source_url=url)

    assert first is not None and first.spritesheet == store.pets_dir() / ".sheets" / "boba.webp"
    assert second is not None and calls == [url], "fetched exactly once"
    assert store.installed_pets() == [], "the cache is never listed as installed"


def test_refuses_to_fetch_from_anywhere_but_petdex(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store, "_download", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")))

    assert store.sheet_for("evil", source_url="https://example.com/sheet.webp") is None
    assert store.sheet_for("nothing") is None


def test_the_rpc_returns_a_full_payload_for_a_bundled_pet(home: Path) -> None:
    pytest.importorskip("PIL")
    from PIL import Image

    from tui_gateway import server

    # A real 9-row sheet so the geometry helpers can read it.
    sheet = home / "bundle" / "gigi" / "spritesheet.webp"
    Image.new("RGBA", (192 * 8, 208 * 9), (0, 0, 0, 0)).save(sheet, format="WEBP")

    resp = server._methods["pet.sheet"]("r1", {"slug": "gigi", "displayName": "Gigi"})
    result = resp["result"]

    assert result["ok"] is True
    assert result["slug"] == "gigi" and result["displayName"] == "Gigi"
    assert result["spritesheetBase64"] and result["frameW"] == 192
    assert result["stateRows"][0] == "idle"
    assert store.load_pet("gigi") is None, "the RPC did not install anything"


def test_the_rpc_fails_open(home: Path) -> None:
    from tui_gateway import server

    assert server._methods["pet.sheet"]("r2", {"slug": "nothing"})["result"] == {"ok": False, "slug": "nothing"}
    assert server._methods["pet.sheet"]("r3", {})["error"]["code"] == 4004
