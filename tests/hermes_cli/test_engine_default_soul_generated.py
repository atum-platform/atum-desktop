"""The cloud controller's list of engine-seeded SOUL.md texts is rendered from ``default_soul.py``.

Regenerate with ``.venv/bin/python scripts/gen_engine_default_soul.py``. The JSON is listed in
``scripts/ci/classify_changes.py::_PY_RELEVANT_CONTRACT_FILES`` so a TS-only PR that edits it
still runs this test.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

from hermes_cli.config import _ensure_default_soul_md
from hermes_cli.default_soul import DEFAULT_SOUL_MD, _LEGACY_TEMPLATE_SOULS

REPO = Path(__file__).resolve().parents[2]
GEN = REPO / "scripts" / "gen_engine_default_soul.py"


@pytest.fixture(scope="module")
def gen():
    spec = importlib.util.spec_from_file_location("gen_engine_default_soul", GEN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _controller_digest(raw: str) -> str:
    """The controller's normalisation (``homeInstructions``): BOM, CRLF/CR, outer whitespace."""
    text = raw.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_generated_file_is_current(gen):
    if not gen.OUT.is_file():
        pytest.skip("Private cloud-controller generated-file parity is excluded; public generator/seed tests still run")
    assert gen.OUT.read_text(encoding="utf-8") == gen.render(), "stale: run scripts/gen_engine_default_soul.py"


def test_every_text_hermes_seeds_or_upgrades_is_listed(gen, tmp_path):
    """What Hermes really writes into a fresh home, and every text it upgrades in place, is known."""
    listed = set(json.loads(gen.render())["seededSha256"])

    fresh = tmp_path / "fresh"
    fresh.mkdir()
    _ensure_default_soul_md(fresh)
    seeded = (fresh / "SOUL.md").read_text(encoding="utf-8")
    assert _controller_digest(seeded) in listed

    for index, legacy in enumerate(_LEGACY_TEMPLATE_SOULS):
        home = tmp_path / f"legacy-{index}"
        home.mkdir()
        (home / "SOUL.md").write_text(legacy.replace("\n", "\r\n"), encoding="utf-8")
        assert _controller_digest(legacy) in listed
        _ensure_default_soul_md(home)
        assert _controller_digest((home / "SOUL.md").read_text(encoding="utf-8")) in listed


def test_a_users_own_text_is_not_listed(gen, tmp_path):
    listed = set(json.loads(gen.render())["seededSha256"])
    home = tmp_path / "custom"
    home.mkdir()
    (home / "SOUL.md").write_text(DEFAULT_SOUL_MD + "\nAlways answer in Vietnamese.", encoding="utf-8")
    _ensure_default_soul_md(home)
    assert _controller_digest((home / "SOUL.md").read_text(encoding="utf-8")) not in listed
