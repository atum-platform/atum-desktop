"""The spec path over the real RPC handlers: design → previews → hatch →
an installed v3 pet, with a scripted model and no network.

The voxel lane is Atum's (``tui_gateway/methods_atum_pets.py``) and sits beside
Hermes' native illustrated path in ``methods_session``; the dispatch-level
contract checks live in ``test_pet_atum_rpc.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

from agent.pet import store  # noqa: E402
from scripts.pets.spec import BAILEY_SPEC, COOKIE_SPEC, GIGI_SPEC, MOCHI_SPEC  # noqa: E402
from tui_gateway import server  # noqa: E402


def _reply(text: str):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5),
        model="moonshotai/kimi-k3",
    )


def _pets(*specs) -> str:
    return json.dumps({"pets": [s.to_dict() for s in specs]})


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


def _model(monkeypatch: pytest.MonkeyPatch, *replies):
    queue = list(replies)
    calls: list[dict] = []

    def fake_call_llm(**kwargs):
        calls.append(kwargs)
        item = queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    import agent.auxiliary_client as aux

    monkeypatch.setattr(aux, "call_llm", fake_call_llm)
    return calls


def _generate(params: dict) -> dict:
    return server._methods["pet.generate"]("g1", {"style": "voxel", **params})


def test_generate_designs_four_previews_and_stages_the_specs(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _model(monkeypatch, _reply(_pets(GIGI_SPEC, COOKIE_SPEC, MOCHI_SPEC, BAILEY_SPEC)))

    resp = _generate({"prompt": "four very different dogs"})
    result = resp["result"]

    assert result["ok"] is True and result["kind"] == "voxel"
    assert [d["draftId"] for d in result["drafts"]] == ["0", "1", "2", "3"]
    assert all(d["dataUri"].startswith("data:image/png;base64,") and d["kind"] == "voxel" for d in result["drafts"])
    assert result["drafts"][1]["summary"].startswith("Cookie:")
    stage = home / "cache" / "pet-gen" / result["token"]
    assert sorted(p.name for p in stage.iterdir()) == sorted([*(f"draft-{i}.png" for i in range(4)), *(f"spec-{i}.json" for i in range(4))])
    assert json.loads((stage / "spec-1.json").read_text())["name"] == "Cookie"
    # One model call, no response_format, the concept in the request.
    assert len(calls) == 1 and "extra_body" not in calls[0]
    assert "four very different dogs" in json.dumps(calls[0]["messages"])
    # Phases on the wire, then one event per draft with the same fields as the result.
    phases = [p.get("phase") for e, p in events if e == "pet.generate.progress" and "phase" in p]
    assert phases == ["designing", "rendering_previews", "ready"]
    streamed = [p for e, p in events if e == "pet.generate.progress" and "draftId" in p]
    assert [p["draftId"] for p in streamed] == ["0", "1", "2", "3"] and streamed[0]["token"] == result["token"]
    assert store.installed_pets() == [], "designing installs nothing"


def test_hatch_renders_publishes_once_with_provenance_and_the_pet_renders(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    _model(monkeypatch, _reply(_pets(COOKIE_SPEC)))
    token = _generate({"prompt": "a yorkie", "count": 1})["result"]["token"]

    resp = server._methods["pet.hatch"]("h1", {"token": token, "index": 0, "name": "Pepper"})
    result = resp["result"]

    assert result["ok"] is True and result["kind"] == "voxel" and result["slug"] == "pepper" and result["displayName"] == "Pepper"
    assert result["pet"]["frameW"] == 192 and result["pet"]["spritesheetBase64"]
    assert "lounging" in result["pet"]["stateRows"], "a v3 sheet: the store's pet can lounge"
    directory = store.pets_dir() / "pepper"
    # Non-dot files only: the installer's provenance stamp is a dotfile the
    # bundle exporter skips (plan 2026-09-12, D1), and it is asserted on its own.
    assert sorted(p.name for p in directory.iterdir() if not p.name.startswith(".")) == ["pet.json", "spec.json", "spritesheet.webp"]
    from agent.pet import provenance as _prov

    assert _prov.read_stamp(directory) is not None and _prov.read_stamp(directory).source == "personal"
    with Image.open(directory / "spritesheet.webp") as sheet:
        assert sheet.size == (1536, 2912)
    meta = json.loads((directory / "pet.json").read_text())
    assert meta["extraRows"] == ["sleep", "carried"] and result["pet"]["stateRows"][12:] == ["sleep", "carried"]
    assert result["pet"]["framesByState"]["sleep"] == 6 and result["pet"]["framesByState"]["carried"] == 4
    assert meta["spriteVersionNumber"] == 3 and meta["lookYawSteps"] and meta["createdBy"] == "generator" and meta["generator"] == "voxel-spec"
    # `build` is the on-screen size (plan 2026-09-13, decision 1); Cookie's spec is a small build.
    assert meta["size"] == 0.85 and result["pet"]["size"] == 0.85
    prov = json.loads((directory / "spec.json").read_text())
    assert prov["spec"]["name"] == "Cookie" and prov["specVersion"] == 2 and prov["rendererVersion"] == "voxel-2"
    assert prov["operationId"] == token and prov["draftId"] == "0" and prov["referenceUsed"] is False
    assert "photo" not in json.dumps(prov) and "messages" not in prov
    exported = server._methods["pet.export_bundle"]("e1", {"slug": "pepper", "operationId": token})["result"]
    bundle_pet = next(item for item in exported["bundle"]["files"] if item["path"] == "pet.json")
    bundle_meta = json.loads(__import__("base64").b64decode(bundle_pet["content_base64"]))
    assert exported["ok"] is True and bundle_meta["size"] == 0.85 and bundle_meta["extraRows"] == ["sleep", "carried"]
    assert "error" in server._methods["pet.export_bundle"]("e2", {"slug": "pepper", "operationId": "other"})
    phases = [p["phase"] for e, p in events if e == "pet.hatch.progress"]
    assert phases == ["rendering", "validating", "publishing", "complete"]
    assert not [p for p in store.pets_dir().iterdir() if p.name.startswith(".staging")]
    # It is a real pet now: adoptable, removable.
    assert server._methods["pet.remove"]("r1", {"slug": "pepper"})["result"]["ok"] is True


def test_the_name_comes_from_the_user_else_the_model_never_the_wire(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    _model(monkeypatch, _reply(_pets(GIGI_SPEC)))
    token = _generate({"prompt": "x", "count": 1})["result"]["token"]

    resp = server._methods["pet.hatch"]("h1", {"token": token, "index": 0, "name": "../../Evil Slug", "slug": "/tmp/evil"})

    assert resp["result"]["slug"] == "evil-slug"
    assert (store.pets_dir() / "evil-slug").is_dir()


def test_two_hatches_of_one_name_are_two_pets(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    _model(monkeypatch, _reply(_pets(GIGI_SPEC, MOCHI_SPEC)))
    token = _generate({"prompt": "x", "count": 2})["result"]["token"]

    first = server._methods["pet.hatch"]("h1", {"token": token, "index": 0, "name": "Snow"})["result"]["slug"]
    second = server._methods["pet.hatch"]("h2", {"token": token, "index": 1, "name": "Snow"})["result"]["slug"]

    assert {first, second} == {"snow", "snow-2"}
    assert {p.slug for p in store.installed_pets()} == {"snow", "snow-2"}


def test_a_failure_after_staging_leaves_no_pet_and_no_staging(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    _model(monkeypatch, _reply(_pets(GIGI_SPEC)))
    token = _generate({"prompt": "x", "count": 1})["result"]["token"]
    monkeypatch.setattr(store, "_publish_pet_dir", lambda staging, dest: (_ for _ in ()).throw(OSError("disk full")))

    resp = server._methods["pet.hatch"]("h1", {"token": token, "index": 0, "name": "Ghost"})

    assert "error" in resp
    assert store.installed_pets() == []
    assert not [p for p in store.pets_dir().iterdir() if p.name.startswith(".staging")]


def test_a_cancel_before_publish_leaves_no_pet(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    _model(monkeypatch, _reply(_pets(GIGI_SPEC)))
    token = _generate({"prompt": "x", "count": 1})["result"]["token"]
    from scripts.pets import spec as petspec

    real = petspec.render_sheet

    def render_then_cancel(spec, *, slug):
        server._pet_cancel_request("cancel-1")
        return real(spec, slug=slug)

    monkeypatch.setattr(petspec, "render_sheet", render_then_cancel)

    resp = server._methods["pet.hatch"]("h1", {"token": token, "cancelToken": "cancel-1", "index": 0, "name": "Gone"})

    assert resp["error"]["message"] == "generation cancelled"
    assert store.installed_pets() == []
    assert not [p for p in store.pets_dir().iterdir() if p.name.startswith(".staging")]


def test_typed_failures_reach_the_wire_as_codes(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    # A cat is a quadruped now; a spider is what no plan draws.
    _model(monkeypatch, _reply(json.dumps({"pets": [{"plan": "spider", "name": "Tom", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}}]})))
    resp = _generate({"prompt": "a spider"})
    assert resp["error"]["code"] == 4405 and "spider" in resp["error"]["message"]


def test_a_bird_hatches_through_its_own_plan(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    from scripts.pets.spec import PIP_SPEC

    _model(monkeypatch, _reply(_pets(PIP_SPEC)))
    generated = _generate({"prompt": "a chick", "count": 1})["result"]
    assert generated["drafts"][0]["summary"].startswith("Pip: chick, small, short beak, folded wings"), "the card leads with the kind and the plan's own knobs"

    result = server._methods["pet.hatch"]("h2", {"token": generated["token"], "index": 0, "name": "Pip"})["result"]

    assert result["ok"] is True and result["slug"] == "pip"
    meta = json.loads((store.pets_dir() / "pip" / "pet.json").read_text())
    assert meta["size"] == 0.7 and result["pet"]["size"] == 0.7, "a chick is drawn at the bird plan's small"
    with Image.open(store.pets_dir() / "pip" / "spritesheet.webp") as sheet:
        assert sheet.size == (1536, 2912)
    prov = json.loads((store.pets_dir() / "pip" / "spec.json").read_text())
    assert prov["spec"]["plan"] == "chick" and prov["spec"]["beak"] == "short" and "ears" not in prov["spec"]

    class APITimeoutError(Exception):
        pass

    _model(monkeypatch, APITimeoutError("slow"))
    assert _generate({"prompt": "x"})["error"]["code"] == 5032

    _model(monkeypatch, _reply("nonsense"), _reply("still nonsense"))
    assert _generate({"prompt": "x"})["error"]["code"] == 5034


def test_a_cancel_during_design_is_reported_and_stages_nothing(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    def cancel_during(**kwargs):
        token = [p["token"] for e, p in events if e == "pet.generate.progress"][0]
        server._pet_cancel_request(token)
        return _reply(_pets(GIGI_SPEC))

    import agent.auxiliary_client as aux

    monkeypatch.setattr(aux, "call_llm", cancel_during)

    resp = _generate({"prompt": "x", "count": 1})

    assert resp["error"]["message"] == "generation cancelled"
    assert not [d for d in (home / "cache" / "pet-gen").iterdir() if d.is_dir()], "a cancelled round leaves no stage"


def test_a_round_whose_previews_all_fail_leaves_no_stage(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    _model(monkeypatch, _reply(_pets(GIGI_SPEC, MOCHI_SPEC)))
    from scripts.pets import spec as petspec

    monkeypatch.setattr(petspec, "render_preview", lambda spec: (_ for _ in ()).throw(RuntimeError("no canvas")))

    resp = _generate({"prompt": "x", "count": 2})

    assert resp["error"]["code"] == 5034
    assert not [d for d in (home / "cache" / "pet-gen").iterdir() if d.is_dir()]


def test_a_slug_taken_by_another_process_is_never_overwritten(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    """The in-process reservation cannot see another gateway on the same home;
    the filesystem can. A pet that appeared under our slug between reservation
    and publish keeps its directory; we take the next name."""
    _model(monkeypatch, _reply(_pets(GIGI_SPEC)))
    token = _generate({"prompt": "x", "count": 1})["result"]["token"]
    from scripts.pets import spec as petspec

    real = petspec.render_sheet

    def another_process_publishes_first(spec, *, slug):
        other = store.pets_dir() / slug
        other.mkdir()
        (other / "pet.json").write_text(json.dumps({"id": slug, "displayName": "Theirs", "spritesheetPath": "spritesheet.webp"}))
        (other / "spritesheet.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBP")
        return real(spec, slug=slug)

    monkeypatch.setattr(petspec, "render_sheet", another_process_publishes_first)

    resp = server._methods["pet.hatch"]("h1", {"token": token, "index": 0, "name": "Snow"})

    assert resp["result"]["slug"] == "snow-2"
    assert (store.pets_dir() / "snow" / "spritesheet.webp").read_bytes() == b"RIFF\x00\x00\x00\x00WEBP", "theirs is untouched"
    assert json.loads((store.pets_dir() / "snow-2" / "pet.json").read_text())["id"] == "snow-2"
    assert not [p for p in store.pets_dir().iterdir() if p.name.startswith((".staging", ".old"))]


def test_remix_sends_the_chosen_spec_back_with_the_note(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _model(monkeypatch, _reply(_pets(GIGI_SPEC, COOKIE_SPEC)), _reply(_pets(MOCHI_SPEC)))
    token = _generate({"prompt": "x", "count": 2})["result"]["token"]

    resp = _generate({"prompt": "x", "count": 1, "remixToken": token, "remixDraftId": "1", "note": "make the ears round"})

    assert resp["result"]["drafts"][0]["summary"].startswith("Mochi:")
    text = json.dumps(calls[1]["messages"])
    assert "Cookie" in text and "make the ears round" in text
    assert _generate({"prompt": "x", "remixToken": "nope", "remixDraftId": "0"})["error"]["code"] == 4004


def test_a_photo_goes_to_the_model_and_is_recorded_only_as_a_flag(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    import base64
    import io

    calls = _model(monkeypatch, _reply(_pets(BAILEY_SPEC)))
    raw = io.BytesIO()
    Image.new("RGB", (300, 200), (150, 96, 52)).save(raw, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(raw.getvalue()).decode("ascii")

    token = _generate({"prompt": "my dog", "count": 1, "referenceImage": data_url})["result"]["token"]
    content = calls[0]["messages"][1]["content"]
    assert content[1]["type"] == "image_url" and content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    stage = home / "cache" / "pet-gen" / token
    assert sorted(p.name for p in stage.iterdir()) == [".reference-used", "draft-0.png", "spec-0.json"], "the photo remains memory-only"

    slug = server._methods["pet.hatch"]("h1", {"token": token, "index": 0, "name": "Bailey Two"})["result"]["slug"]
    prov = json.loads((store.pets_dir() / slug / "spec.json").read_text())
    assert prov["referenceUsed"] is True
    assert "base64" not in json.dumps(prov), "the photo never lands beside the pet"


def test_status_reports_both_lanes(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import agent.pet.generate.voxel as voxel

    monkeypatch.setattr(voxel, "voxel_availability", lambda: {"available": True, "mode": "byok", "reason": ""})
    result = server._methods["pet.generate.status"]("s1", {})["result"]

    assert result["voxel"] == {"available": True, "mode": "byok", "reason": ""}
    assert set(result["illustrated"]) == {"available", "providers"}
    assert "available" in result and "providers" in result, "older clients keep their fields"


def test_the_illustrated_path_is_untouched_by_a_voxel_token(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    # A token with an image draft and no spec goes down the image path (which
    # needs a provider) exactly as before: it never sees the voxel branch.
    stage = server._pet_gen_root() / "abc123"
    stage.mkdir(parents=True)
    Image.new("RGBA", (64, 64), (200, 80, 80, 255)).save(stage / "draft-0.png")
    from agent.pet.generate import imagegen

    monkeypatch.setattr(imagegen, "resolve_provider", lambda **k: (_ for _ in ()).throw(imagegen.GenerationError("no image backend")))

    resp = server._methods["pet.hatch"]("h1", {"token": "abc123", "index": 0, "name": "Old", "provider": "openai"})

    assert "error" in resp and "no image backend" in resp["error"]["message"]


def test_events_echo_the_operation_id_and_the_cancel_token(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    _model(monkeypatch, _reply(_pets(GIGI_SPEC)))

    result = _generate({"prompt": "x", "count": 1, "opId": "op-123"})["result"]
    gen_events = [p for e, p in events if e == "pet.generate.progress"]

    assert result["opId"] == "op-123"
    assert gen_events and all(p.get("opId") == "op-123" for p in gen_events)
    assert [p.get("phase") for p in gen_events if "phase" in p] == ["designing", "rendering_previews", "ready"]

    server._methods["pet.hatch"]("h1", {"token": result["token"], "cancelToken": "cancel-xyz", "index": 0, "name": "Echo"})
    hatch_events = [p for e, p in events if e == "pet.hatch.progress"]
    assert hatch_events and all(p.get("cancelToken") == "cancel-xyz" for p in hatch_events)


def test_managed_hatch_is_a_one_round_loopback_override(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _model(monkeypatch, _reply(_pets(GIGI_SPEC)))
    operation = "00000000-0000-4000-8000-306da8aef02e"
    result = _generate({"prompt": "x", "count": 1, "style": "voxel", "opId": operation,
                        "managedHatch": {"baseUrl": "http://127.0.0.1:9911/v1", "apiKey": "x" * 32,
                                         "operationId": operation}})["result"]
    assert result["opId"] == operation
    request = calls[0]
    assert request["provider"] == "custom" and request["model"] == "hatch"
    assert request["base_url"] == "http://127.0.0.1:9911/v1"
    assert request["extra_headers"] == {"X-Atum-Pet-Operation": operation}
    refused = _generate({"prompt": "x", "style": "voxel", "opId": operation,
                         "managedHatch": {"baseUrl": "https://gateway.example/v1", "apiKey": "x" * 32,
                                          "operationId": operation}})
    assert "error" in refused


def test_a_failed_round_leaves_no_stage_behind(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    import base64

    cache = home / "cache" / "pet-gen"
    # A bad photo: refused before the model, and its bytes do not linger.
    resp = _generate({"prompt": "x", "referenceImage": "data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode()})
    assert "error" in resp
    assert not [d for d in cache.iterdir() if d.is_dir()] if cache.exists() else True

    class APIConnectionError(Exception):
        pass

    _model(monkeypatch, APIConnectionError("down"))
    resp = _generate({"prompt": "x"})
    assert resp["error"]["code"] == 5033
    assert not [d for d in cache.iterdir() if d.is_dir()]

    _model(monkeypatch, _reply("nonsense"), _reply("nonsense"))
    assert _generate({"prompt": "x"})["error"]["code"] == 5034
    assert not [d for d in cache.iterdir() if d.is_dir()]


def test_a_billing_failure_is_its_own_answer(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    class PaymentRequired(Exception):
        status_code = 402

    _model(monkeypatch, PaymentRequired("Insufficient credits"))

    resp = _generate({"prompt": "x"})

    assert resp["error"]["code"] == 4402 and "credit" in resp["error"]["message"]


def test_two_simultaneous_hatches_of_one_name_are_two_pets(home: Path, events, monkeypatch: pytest.MonkeyPatch) -> None:
    import threading

    _model(monkeypatch, _reply(_pets(GIGI_SPEC, MOCHI_SPEC)))
    token = _generate({"prompt": "x", "count": 2})["result"]["token"]
    from scripts.pets import spec as petspec

    # Both hatches get through slug choice before either publishes.
    gate = threading.Barrier(2, timeout=30)
    real = petspec.render_sheet

    def render_after_both_chose(spec, *, slug):
        gate.wait()
        return real(spec, slug=slug)

    monkeypatch.setattr(petspec, "render_sheet", render_after_both_chose)
    results: dict[int, dict] = {}

    def hatch(i: int) -> None:
        results[i] = server._methods["pet.hatch"](f"h{i}", {"token": token, "cancelToken": f"c{i}", "index": i, "name": "Snow"})

    threads = [threading.Thread(target=hatch, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)

    slugs = sorted(r["result"]["slug"] for r in results.values())
    assert slugs == ["snow", "snow-2"], results
    for slug in slugs:
        pet = store.load_pet(slug)
        assert pet is not None and pet.exists
    assert not [p for p in store.pets_dir().iterdir() if p.name.startswith((".staging", ".old"))]
