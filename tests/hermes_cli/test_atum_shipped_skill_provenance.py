"""Bundled-skill provenance across prepared imports and stopped-home repair."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from hermes_cli import atum_profile_import as importer
from hermes_cli import atum_profile_install as installer
from tools.skills_sync import dir_hash as _dir_hash, _read_manifest

import scripts.atum_repair_imported_shipped_skills as repair


REPO = Path(__file__).resolve().parents[2]
ROOM = "!provenance:atum.example"


def put(root: Path, relative: str, contents: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")
    return path


def skill(root: Path, relative: str, name: str, body: str) -> Path:
    return put(root, f"{relative}/SKILL.md", f"---\nname: {name}\n---\n{body}\n")


def seed(home: Path, bundled: Path) -> dict:
    env = {
        **os.environ,
        "HERMES_HOME": str(home),
        "HERMES_BUNDLED_SKILLS": str(bundled),
        "HERMES_OPTIONAL_SKILLS": str(bundled.parent / "optional-none"),
    }
    completed = subprocess.run(
        [sys.executable, "-B", "-c", "import json; from tools.skills_sync import sync_skills; print(json.dumps(sync_skills(quiet=True)))"],
        cwd=REPO, env=env, check=True, capture_output=True, text=True, timeout=120,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path | str]:
    source = tmp_path / "source"
    put(source, "config.yaml", yaml.safe_dump({"model": {"provider": "openai-codex", "default": "owner-model"}}))
    put(source, "SOUL.md", "Imported role.")
    pristine = skill(source / "skills", "productivity/notes", "notes", "source notes v1")
    edited = skill(source / "skills", "tools/edited", "edited", "source edited v1")
    origins = {"notes": _dir_hash(pristine.parent), "edited": _dir_hash(edited.parent)}
    edited.write_text("---\nname: edited\n---\nsource edited locally\n", encoding="utf-8")
    put(source, "skills/.bundled_manifest", "".join(f"{name}:{digest}\n" for name, digest in sorted(origins.items())))

    bundled = tmp_path / "destination-bundled"
    skill(bundled, "productivity/notes", "notes", "destination notes v2")
    skill(bundled, "tools/edited", "edited", "destination edited v2")
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(bundled))

    rehearsal = tmp_path / "rehearsals" / "atum-main"
    rehearsal.parent.mkdir()
    plan = importer.inspect_profile(source, ROOM)
    importer.stage_profile(source, rehearsal, ROOM, expected_sha256=plan.manifest["sha256"])
    return {
        "source": source, "bundled": bundled, "rehearsals": rehearsal.parent,
        "prepared": rehearsal / "prepared", "sha": plan.manifest["sha256"],
        "notes_origin": origins["notes"],
    }


def test_pristine_source_bundle_is_left_to_destination_seeding(world, tmp_path: Path):
    prepared = world["prepared"]
    bundled = world["bundled"]
    assert isinstance(prepared, Path) and isinstance(bundled, Path)
    plan = installer.read_prepared(prepared, bundled_dir=bundled)
    assert plan.manifest["shipped"] == [{"name": "productivity/notes", "skill": "notes"}]
    payload = installer.payload(plan, bundled_dir=bundled)
    assert [item["name"] for item in payload["definition"]["skills"]] == ["tools/edited"]

    home = tmp_path / "fresh-home"
    installer.install_prepared(prepared, home, ROOM, expected_sha256=str(world["sha"]), bundled_dir=bundled)
    assert not (home / "skills/productivity/notes").exists()
    assert (home / "skills/tools/edited/SKILL.md").read_text().endswith("source edited locally\n")
    assert seed(home, bundled)["copied"] == ["notes"]
    assert (home / "skills/productivity/notes/SKILL.md").read_text().endswith("destination notes v2\n")


def test_invalid_shipped_provenance_record_refuses_fresh_install(world):
    prepared = world["prepared"]
    assert isinstance(prepared, Path)
    plan = installer.read_prepared(prepared)
    plan.manifest["shipped"] = [{"name": "productivity/notes"}]
    with pytest.raises(importer.ImportRefused, match="shipped"):
        installer.payload(plan)


def test_repair_is_read_only_then_records_only_a_verified_pristine_origin(world, tmp_path: Path):
    source, bundled, rehearsals = world["source"], world["bundled"], world["rehearsals"]
    assert isinstance(source, Path) and isinstance(bundled, Path) and isinstance(rehearsals, Path)
    homes = tmp_path / "homes"
    home = homes / ("a" * 64)
    (home / "skills/productivity").mkdir(parents=True)
    (home / "skills/tools").mkdir(parents=True)
    shutil.copytree(source / "skills/productivity/notes", home / "skills/productivity/notes")
    shutil.copytree(source / "skills/tools/edited", home / "skills/tools/edited")
    (home / "skills/tools/edited/SKILL.md").write_text("---\nname: edited\n---\nchanged after import\n", encoding="utf-8")
    (home / ".atum-profile-import.json").write_text(json.dumps({"schema_version": 1, "sha256": world["sha"], "room": ROOM}), encoding="utf-8")
    before = {path.relative_to(home): path.read_bytes() for path in home.rglob("*") if path.is_file()}

    report, ok = repair.run(REPO, homes, [rehearsals])
    assert ok
    [row] = report["homes"]
    assert row["repair"] == {"notes": world["notes_origin"]}
    assert row["kept"]["differs"] == ["edited"]
    assert {path.relative_to(home): path.read_bytes() for path in home.rglob("*") if path.is_file()} == before

    applied, ok = repair.run(REPO, homes, [rehearsals], apply=True)
    assert ok and applied["homes"][0]["applied"] is True
    assert _read_manifest(home / "skills/.bundled_manifest")["notes"] == world["notes_origin"]
    assert (home / "skills/productivity/notes/SKILL.md").read_text().endswith("source notes v1\n")
    assert (home / "skills/tools/edited/SKILL.md").read_text().endswith("changed after import\n")
    assert "notes" in seed(home, bundled)["updated"]
    assert (home / "skills/productivity/notes/SKILL.md").read_text().endswith("destination notes v2\n")


def test_repair_refuses_source_manifest_changed_since_preparation(world, tmp_path: Path):
    source, rehearsals = world["source"], world["rehearsals"]
    assert isinstance(source, Path) and isinstance(rehearsals, Path)
    homes = tmp_path / "homes"
    home = homes / ("b" * 64)
    (home / "skills/productivity").mkdir(parents=True)
    shutil.copytree(source / "skills/productivity/notes", home / "skills/productivity/notes")
    (home / ".atum-profile-import.json").write_text(json.dumps({"schema_version": 1, "sha256": world["sha"], "room": ROOM}), encoding="utf-8")
    put(source, "skills/.bundled_manifest", "notes:" + ("0" * 32) + "\n")

    report, ok = repair.run(REPO, homes, [rehearsals], apply=True)
    assert not ok
    assert report["homes"][0]["error"] == "source_changed"
    assert not (home / "skills/.bundled_manifest").exists()
