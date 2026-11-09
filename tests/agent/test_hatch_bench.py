"""The hatch bench drives the real pipeline end to end with a stub image
provider, counts rolls from the pipeline's own log lines, and prices the run.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

pytest.importorskip("PIL")

from PIL import Image, ImageDraw  # noqa: E402

from agent.pet.generate.imagegen import SpriteProvider  # noqa: E402
from scripts.pets import hatch_bench  # noqa: E402


class _StubProvider:
    """Draws what a good image model would: one blob, or N blobs with gutters.

    The first row roll (the first landscape call) comes back unreadable — an
    empty file, the way a provider that returned garbage would — so the
    pipeline's retry path runs and the bench has exactly one retry to count.
    Rows are generated on four threads, so the counters are locked.
    """

    name = "stub"

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.calls = 0
        self.row_rolls = 0
        self._lock = threading.Lock()

    def is_available(self) -> bool:
        return True

    def generate(self, prompt: str, **kwargs):
        wide = kwargs.get("aspect_ratio") == "landscape"
        with self._lock:
            self.calls += 1
            call = self.calls
            garbage = wide and self.row_rolls == 0
            if wide:
                self.row_rolls += 1
        path = self.tmp / f"gen-{call}.png"
        if garbage:
            path.write_bytes(b"")
            return {"success": True, "image": str(path)}
        n = 1
        if "horizontal strip of" in prompt:
            n = int(prompt.split("horizontal strip of", 1)[1].split()[0])
        w, h = (1536, 864) if wide else (1024, 1024)
        img = Image.new("RGBA", (w, h), (255, 255, 255, 255))
        d = ImageDraw.Draw(img)
        slot = w / n
        for i in range(n):
            x0 = int(i * slot + slot * 0.2)
            x1 = int(i * slot + slot * 0.8)
            d.ellipse((x0, int(h * 0.25), x1, int(h * 0.75)), fill=(200, 60, 60, 255))
            d.rectangle(
                (x0 + 10, int(h * 0.45), x0 + 40, int(h * 0.55)),
                fill=(20, 20, 20, 255),
            )
        img.save(path)
        return {"success": True, "image": str(path)}


def test_bench_runs_the_pipeline_counts_rolls_and_prices(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    stub = _StubProvider(tmp_path)
    sprite = SpriteProvider(name="stub", provider=stub, supports_references=True)

    report = hatch_bench.run_one(
        "google/gemini-3.1-flash-image",
        "a round red bird",
        provider="openrouter",
        out=tmp_path / "out",
        sprite=sprite,
    )

    assert report.error == ""
    assert report.drafts_ok == 4
    # 8 generated rows (running-left is mirrored), one of them re-rolled once.
    assert report.rows_generated == 8
    assert "running-left" in report.rows_usable
    assert report.row_retries == 1
    assert report.row_attempts == 9
    assert report.images == 4 + 9
    assert report.cost_usd == pytest.approx(0.067 * 13, abs=0.001)
    assert stub.calls == 4 + 9

    run = json.loads(
        (
            tmp_path
            / "out"
            / "google-gemini-3-1-flash-image"
            / "a-round-red-bird"
            / "run.json"
        ).read_text()
    )
    assert run["rows_usable"] == report.rows_usable
    assert Path(report.sheet).is_file()
    assert (
        tmp_path
        / "out"
        / "google-gemini-3-1-flash-image"
        / "a-round-red-bird"
        / "draft-0.png"
    ).is_file()


def test_bench_reports_a_failed_hatch_instead_of_raising(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))

    class Broken:
        name = "broken"

        def is_available(self) -> bool:
            return True

        def generate(self, prompt: str, **kwargs):
            return {"success": False, "error": "quota exhausted"}

    sprite = SpriteProvider(name="broken", provider=Broken(), supports_references=True)
    report = hatch_bench.run_one(
        "x/y", "anything", provider="openrouter", out=tmp_path / "out", sprite=sprite
    )

    assert report.error.startswith("drafts:")
    assert "quota exhausted" in report.error
    assert report.cost_usd is None
    assert "x/y" in hatch_bench.table([report])


def test_a_bench_pet_is_removed_even_when_the_run_fails_after_hatching(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent.pet import store

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    stub = _StubProvider(tmp_path)
    sprite = SpriteProvider(name="stub", provider=stub, supports_references=True)
    registered: list[str] = []
    real_register = store.register_local_pet

    def spy(*args, **kwargs):
        pet = real_register(*args, **kwargs)
        registered.append(pet.slug)
        return pet

    monkeypatch.setattr(store, "register_local_pet", spy)
    # The sheet copy after a successful hatch is where this run dies.
    real_copy = hatch_bench.shutil.copy

    def copy_dies_on_sheet(src, dst, *a, **k):
        if str(dst).endswith("sheet.png"):
            raise OSError("out of space")
        return real_copy(src, dst, *a, **k)

    monkeypatch.setattr(hatch_bench.shutil, "copy", copy_dies_on_sheet)

    with pytest.raises(OSError, match="out of space"):
        hatch_bench.run_one(
            "x/y",
            "a round red bird",
            provider="openrouter",
            out=tmp_path / "out",
            sprite=sprite,
        )

    assert len(registered) == 1 and registered[0].startswith("bench-")
    assert store.load_pet(registered[0]) is None, "the bench never leaves a pet behind"
    assert store.installed_pets() == []


def test_a_kept_bench_pet_stays_and_runs_do_not_collide(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent.pet import store

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    sprite = SpriteProvider(
        name="stub", provider=_StubProvider(tmp_path), supports_references=True
    )

    hatch_bench.run_one(
        "x/y",
        "a round red bird",
        provider="openrouter",
        out=tmp_path / "out",
        sprite=sprite,
        keep=True,
    )
    hatch_bench.run_one(
        "x/y",
        "a round red bird",
        provider="openrouter",
        out=tmp_path / "out",
        sprite=sprite,
        keep=True,
    )

    slugs = [pet.slug for pet in store.installed_pets()]
    assert len(slugs) == 2 and len(set(slugs)) == 2, "each run is its own pet"
