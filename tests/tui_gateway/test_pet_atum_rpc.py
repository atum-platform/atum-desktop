"""Atum's pet adapters over the real dispatch path (params admission + strict result contracts):
the desktop's and the Matrix paid hatch's exact params, the Store hold, and the pet's own size.

``test_pet_voxel_rpc.py`` proves the voxel lane's behaviour handler-by-handler; these prove the
same calls survive ``handle_request`` — an unknown param answers ``4000`` and, under test
isolation, a result outside its contract raises — and that the illustrated lane still reaches the
native Hermes handler.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("PIL")

from PIL import Image

from agent.pet import store
from scripts.pets.spec import COOKIE_SPEC
from tui_gateway import server

OPERATION = "00000000-0000-4000-8000-b8f7645d837f"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("ATUM_BUNDLED_PETS_DIR", raising=False)
    return tmp_path / "home"


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict]]:
    captured: list[tuple[str, dict]] = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: captured.append((event, payload or {})))
    return captured


def _rpc(method: str, params: dict) -> dict:
    return server.handle_request({"jsonrpc": "2.0", "id": method, "method": method, "params": params})


def _scripted_model(monkeypatch: pytest.MonkeyPatch, *specs) -> list[dict]:
    calls: list[dict] = []

    def fake_call_llm(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"pets": [s.to_dict() for s in specs]})))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5),
            model="scripted",
        )

    import agent.auxiliary_client as aux

    monkeypatch.setattr(aux, "call_llm", fake_call_llm)
    return calls


def _sheet(path: Path, rows: int = 9) -> Path:
    Image.new("RGBA", (192 * 8, 208 * rows), (120, 80, 40, 255)).save(path, format="WEBP", lossless=True)
    return path


def test_paid_hatch_round_trip_survives_dispatch(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    """apps/desktop/electron/matrix/main.ts: generate (managed, voxel) -> hatch (opId) -> export_bundle."""
    calls = _scripted_model(monkeypatch, COOKIE_SPEC)
    managed = {"baseUrl": "http://127.0.0.1:9911/v1", "apiKey": "k" * 32, "operationId": OPERATION}

    generated = _rpc("pet.generate", {"style": "voxel", "prompt": "a yorkie", "count": 1, "opId": OPERATION,
                                      "managedHatch": managed})
    assert "error" not in generated, generated
    assert generated["result"]["opId"] == OPERATION and generated["result"]["kind"] == "voxel"
    assert calls[0]["model"] == "hatch" and calls[0]["extra_headers"] == {"X-Atum-Pet-Operation": OPERATION}

    hatched = _rpc("pet.hatch", {"token": generated["result"]["token"], "index": 0, "name": "Pepper",
                                 "description": "", "style": "voxel", "opId": OPERATION, "cancelToken": OPERATION})
    assert "error" not in hatched, hatched
    assert hatched["result"]["opId"] == OPERATION and hatched["result"]["slug"] == "pepper"
    assert hatched["result"]["pet"]["extraRows"] == ["sleep", "carried"]

    exported = _rpc("pet.export_bundle", {"slug": "pepper", "operationId": OPERATION})
    assert exported["result"]["ok"] is True
    paths = {item["path"] for item in exported["result"]["bundle"]["files"]}
    assert {"pet.json", "spec.json", "spritesheet.webp"} <= paths
    assert "error" in _rpc("pet.export_bundle", {"slug": "pepper", "operationId": "someone-else"})


def test_a_managed_hatch_that_is_not_loopback_is_refused_before_the_model(home: Path, events, monkeypatch) -> None:
    calls = _scripted_model(monkeypatch, COOKIE_SPEC)
    refused = _rpc("pet.generate", {"style": "voxel", "prompt": "x", "opId": OPERATION,
                                    "managedHatch": {"baseUrl": "https://gateway.example/v1", "apiKey": "k" * 32,
                                                     "operationId": OPERATION}})
    assert refused["error"]["code"] == 4004 and calls == []
    assert not [d for d in (home / "cache" / "pet-gen").iterdir() if d.is_dir()]


def test_the_desktop_voxel_round_and_remix_params_are_admitted(home: Path, events, monkeypatch) -> None:
    """apps/desktop/src/store/pet-generate.ts sends opId always and remix fields on a remix."""
    _scripted_model(monkeypatch, COOKIE_SPEC)
    first = _rpc("pet.generate", {"prompt": "x", "opId": "op-1", "style": "voxel", "count": 1})["result"]
    remix = _rpc("pet.generate", {"prompt": "x", "opId": "op-2", "style": "voxel", "count": 1,
                                  "remixToken": first["token"], "remixDraftId": "0", "note": "rounder ears"})
    assert "error" not in remix, remix
    assert remix["result"]["drafts"][0]["draftId"] == "0"


def test_the_illustrated_lane_still_reaches_the_native_handler(home: Path, events, monkeypatch) -> None:
    import agent.pet.generate as gen

    draft = Image.new("RGBA", (64, 64), (200, 80, 80, 255))

    def fake_drafts(concept, *, n, style, reference_images, provider, on_draft, is_cancelled):
        path = home / "fake-draft.png"
        draft.save(path)
        on_draft(0, path)

    monkeypatch.setattr(gen, "generate_base_drafts", fake_drafts)

    resp = _rpc("pet.generate", {"prompt": "a fox", "opId": "op-3", "style": "auto", "count": 1})

    assert "error" not in resp, resp
    assert resp["result"]["drafts"][0]["index"] == 0 and "kind" not in resp["result"]["drafts"][0]
    stage = home / "cache" / "pet-gen" / resp["result"]["token"]
    assert (stage / "draft-0.png").is_file() and not list(stage.glob("spec-*.json"))


def test_status_reports_both_lanes_through_dispatch(home: Path, monkeypatch) -> None:
    from agent.pet.generate import voxel

    monkeypatch.setattr(voxel, "voxel_availability", lambda: {"available": True, "mode": "managed", "reason": ""})

    result = _rpc("pet.generate.status", {"profile": "default"})["result"]

    assert result["voxel"] == {"available": True, "mode": "managed", "reason": ""}
    assert result["illustrated"] == {"available": result["available"], "providers": result["providers"]}


def _install_active(home: Path, slug: str, *, size: float | None = None) -> None:
    pet = store.register_local_pet(_sheet(home.parent / f"{slug}.webp"), slug=slug, display_name=slug.title())
    if size is not None:
        meta = json.loads((pet.directory / "pet.json").read_text())
        (pet.directory / "pet.json").write_text(json.dumps({**meta, "size": size}))
    from hermes_cli.pets import _set_active

    _set_active(slug)


def test_info_meta_carries_the_pets_own_size(home: Path) -> None:
    _install_active(home, "biscuit", size=1.4)

    meta = _rpc("pet.info.meta", {})["result"]
    info = _rpc("pet.info", {})["result"]

    assert meta["enabled"] is True and meta["size"] == 1.4
    assert info["size"] == meta["size"], "the desktop refetches the sheet whenever these differ"
    assert info["spritesheetRevision"] == meta["spritesheetRevision"]


def test_a_store_held_pet_is_named_and_explained_never_swapped(home: Path, monkeypatch) -> None:
    _install_active(home, "mocha")
    _install_active(home, "latte")  # another, unheld pet on disk
    from hermes_cli.pets import _set_active

    _set_active("mocha")
    monkeypatch.setattr(store, "_hold_reason", lambda directory: "purchase_required" if directory.name == "mocha" else None)

    info = _rpc("pet.info", {})["result"]
    meta = _rpc("pet.info.meta", {})["result"]
    gallery = _rpc("pet.gallery", {"localOnly": True})["result"]

    held = {"slug": "mocha", "displayName": "Mocha", "reason": "purchase_required"}
    assert info == {"enabled": True, "held": held}, "no sheet, and never the other pet"
    assert meta == {"enabled": True, "held": held}
    by_slug = {entry["slug"]: entry for entry in gallery["pets"]}
    assert by_slug["mocha"]["held"] == "purchase_required" and by_slug["latte"]["held"] is None


def test_a_disabled_display_reports_off_not_held(home: Path, monkeypatch) -> None:
    _install_active(home, "mocha")
    from hermes_cli.pets import _set_enabled

    _set_enabled(False)
    monkeypatch.setattr(store, "_hold_reason", lambda directory: "purchase_required")

    assert _rpc("pet.info", {})["result"] == {"enabled": False}
    assert _rpc("pet.info.meta", {})["result"] == {"enabled": False}


def test_a_wire_token_never_names_a_path_outside_the_stage(home: Path, events) -> None:
    outside = home / "cache" / "spec-0.json"
    outside.parent.mkdir(parents=True, exist_ok=True)
    outside.write_text(json.dumps(COOKIE_SPEC.to_dict()))

    resp = _rpc("pet.hatch", {"token": "..", "index": 0, "name": "Escape"})

    assert "error" in resp and store.installed_pets() == []
