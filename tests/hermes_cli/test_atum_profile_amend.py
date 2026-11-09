import json
import stat
import sys
from pathlib import Path

import pytest
import yaml

from hermes_cli.atum_profile_amend import (
    AMEND_DIR,
    AmendmentRefused,
    apply_amendment,
    inspect_amendment,
    rollback_amendment,
)
from hermes_cli.atum_profile_import import inspect_profile, stage_profile

ROOM = "!local-amendment:matrix.example"


def _write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)


def _profile(root: Path, *, script: str = "echo old\n", memory: str = "", config: dict | None = None) -> None:
    config = config or {
        "model": {"provider": "openai-codex", "default": "gpt-source"},
        "memory": {"memory_enabled": True},
        "skills": {"disabled": ["legacy"]},
        "timezone": "Asia/Ho_Chi_Minh",
        "conversation": {"compact": True},
    }
    _write(root / "config.yaml", yaml.safe_dump(config, sort_keys=False))
    _write(root / "SOUL.md", "A local persona.\n")
    _write(root / "memories/MEMORY.md", memory)
    _write(root / "memories/USER.md", "")
    _write(root / "scripts/task.sh", script, 0o700)
    _write(root / "cron/jobs.json", json.dumps({"jobs": [{
        "id": "task", "name": "task", "prompt": "run", "schedule": {"kind": "cron", "expr": "0 0 * * *"},
        "script": "task.sh", "enabled": False,
    }]}))


def _imported_destination(root: Path, *, receipt_sha: str = "a" * 64, script: str | None = None) -> None:
    root.mkdir()
    _write(root / ".atum-profile-import.json", json.dumps({"schema_version": 1, "sha256": receipt_sha, "room": ROOM}))
    _write(root / "config.yaml", yaml.safe_dump({"model": {"provider": "atum-managed", "default": "keep-me"}, "other": {"keep": True}}, sort_keys=False))
    _write(root / "memories/MEMORY.md", "")
    _write(root / "memories/USER.md", "")
    if script is not None:
        _write(root / "scripts/task.sh", script, 0o700)
    _write(root / ".env", "KEEP_SECRET=destination\n")
    _write(root / "auth.json", '{"identity":"destination"}\n')
    _write(root / "state.db", "state")
    _write(root / "cron/jobs.json", '{"jobs":[{"id":"keep-running-state"}]}\n')
    _write(root / "skills/local/SKILL.md", "---\nname: local\n---\n")


def _marker(tmp_path: Path, home: Path) -> Path:
    marker = tmp_path / "stopped.json"
    marker.write_text(json.dumps({"state": "stopped", "home": str(home.resolve())}), encoding="utf-8")
    return marker


def test_inspect_is_hash_only_and_apply_preserves_unselected_destination_content(tmp_path: Path):
    source, home = tmp_path / "source", tmp_path / "home"
    executable = Path(sys.executable)
    _profile(source, memory="remember source", config={
        "model": {"provider": "openai-codex", "default": "source-model"},
        "memory": {"memory_enabled": True}, "toolsets": ["terminal"],
        "skills": {"disabled": ["old"], "external_dirs": [str(tmp_path)]},
        "timezone": "Asia/Ho_Chi_Minh", "mcp_servers": {"local": {"command": str(executable), "args": ["-V"]}},
    })
    _imported_destination(home)
    before = {name: (home / name).read_bytes() for name in (
        ".env", "auth.json", "state.db", "cron/jobs.json", "skills/local/SKILL.md",
    )}

    report = inspect_amendment(source, home, ROOM, scripts=["task.sh"])
    encoded = json.dumps(report)
    assert "remember source" not in encoded
    assert "destination" not in encoded
    assert report["config_keys"] == ["mcp_servers", "memory", "skills", "timezone", "toolsets"]
    assert not (home / AMEND_DIR).exists()

    result = apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"],
                             stopped_marker=_marker(tmp_path, home), scripts=["task.sh"])
    assert result["status"] == "applied"
    config = yaml.safe_load((home / "config.yaml").read_text())
    assert config["model"]["default"] == "keep-me"
    assert config["other"] == {"keep": True}
    assert config["memory"] == {"memory_enabled": True}
    assert config["skills"] == {"external_dirs": [str(tmp_path)]}
    assert config["mcp_servers"]["local"]["command"] == str(executable)
    assert (home / "memories/MEMORY.md").read_text() == "remember source"
    assert (home / "scripts/task.sh").read_text() == "echo old\n"
    assert stat.S_IMODE((home / "scripts/task.sh").stat().st_mode) == 0o700
    assert {name: (home / name).read_bytes() for name in before} == before

    receipt = home / AMEND_DIR / "receipts" / result["receipt"]
    rolled_back = rollback_amendment(home, receipt=receipt, stopped_marker=_marker(tmp_path, home))
    assert rolled_back["status"] == "rolled_back"
    config = yaml.safe_load((home / "config.yaml").read_text())
    assert config == {"model": {"provider": "atum-managed", "default": "keep-me"}, "other": {"keep": True}}
    assert not (home / "scripts/task.sh").exists()


def test_amendment_clears_legacy_capability_masks_and_can_carry_the_reviewed_persona(tmp_path: Path):
    source, home = tmp_path / "current-home", tmp_path / "stranded-home"
    _profile(source, config={
        "model": {"provider": "atum-managed", "default": "nguyet-thuc", "context_length": 75000},
        "platform_toolsets": {"cli": ["file"]},
        "skills": {"disabled": ["source-mask"]},
    })
    _imported_destination(home)
    _write(home / "SOUL.md", "Historical persona.\n")
    original_persona = (home / "SOUL.md").read_bytes()
    _write(home / "config.yaml", yaml.safe_dump({
        "model": {"provider": "openai-codex", "default": "keep-unless-selected"},
        "platform_toolsets": {"cli": ["web", "terminal"]},
        "skills": {"disabled": ["legacy-a", "legacy-b"], "external_dirs": [str(tmp_path)]},
        "mcp_servers": {"local": {"command": sys.executable}},
    }, sort_keys=False))

    report = inspect_amendment(source, home, ROOM, source_model=True, source_persona=True)
    assert {"platform_toolsets", "skills.disabled", "model"} <= set(report["config_keys"])
    assert {row["path"] for row in report["writes"]} == {"SOUL.md", "config.yaml"}
    result = apply_amendment(
        source,
        home,
        ROOM,
        expected_plan_sha256=report["plan_sha256"],
        stopped_marker=_marker(tmp_path, home),
        source_model=True,
        source_persona=True,
    )
    config = yaml.safe_load((home / "config.yaml").read_text())
    assert "platform_toolsets" not in config
    assert config["skills"] == {"external_dirs": [str(tmp_path)]}
    assert config["model"] == {"provider": "atum-managed", "default": "nguyet-thuc", "context_length": 75000}
    assert config["mcp_servers"] == {"local": {"command": sys.executable}}
    assert (home / "SOUL.md").read_bytes() == (source / "SOUL.md").read_bytes()

    receipt = home / AMEND_DIR / "receipts" / result["receipt"]
    rollback_amendment(home, receipt=receipt, stopped_marker=_marker(tmp_path, home))
    assert (home / "SOUL.md").read_bytes() == original_persona


def test_amendment_removes_legacy_masks_even_when_no_source_config_field_is_selected(tmp_path: Path):
    source, home = tmp_path / "source", tmp_path / "home"
    _profile(source, config={"model": {"provider": "openai-codex", "default": "source-only"}})
    _imported_destination(home)
    _write(home / "config.yaml", yaml.safe_dump({
        "model": {"provider": "atum-managed", "default": "keep-me"},
        "platform_toolsets": {"cli": ["file"]},
        "skills": {"disabled": ["legacy"]},
    }, sort_keys=False))

    report = inspect_amendment(source, home, ROOM)
    assert set(report["config_keys"]) == {"platform_toolsets", "skills.disabled"}
    apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"],
                    stopped_marker=_marker(tmp_path, home))
    assert yaml.safe_load((home / "config.yaml").read_text()) == {
        "model": {"provider": "atum-managed", "default": "keep-me"},
    }


def test_conflicting_memory_requires_explicit_concat_and_rollback_requires_expected_post_hash(tmp_path: Path):
    source, home = tmp_path / "source", tmp_path / "home"
    _profile(source, memory="source memory")
    _imported_destination(home)
    _write(home / "memories/MEMORY.md", "destination memory")
    with pytest.raises(AmendmentRefused, match="concat"):
        inspect_amendment(source, home, ROOM)
    report = inspect_amendment(source, home, ROOM, concat_memories=True)
    result = apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"],
                             stopped_marker=_marker(tmp_path, home), concat_memories=True)
    memory = home / "memories/MEMORY.md"
    assert "destination memory" in memory.read_text() and "source memory" in memory.read_text()
    memory.write_text("user changed this", encoding="utf-8")
    with pytest.raises(AmendmentRefused, match="changed"):
        rollback_amendment(home, receipt=home / AMEND_DIR / "receipts" / result["receipt"],
                           stopped_marker=_marker(tmp_path, home))


def test_script_conflict_requires_exact_old_prepared_receipt_and_stopped_marker(tmp_path: Path):
    old, source, home, prepared_parent = tmp_path / "old", tmp_path / "source", tmp_path / "home", tmp_path / "prepared"
    _profile(old, script="echo old\n")
    manifest = inspect_profile(old, ROOM).manifest
    stage_profile(old, prepared_parent, ROOM, expected_sha256=manifest["sha256"])
    prepared = prepared_parent / "prepared"
    _profile(source, script="echo new\n")
    _imported_destination(home, receipt_sha=manifest["sha256"], script="echo old\n")
    with pytest.raises(AmendmentRefused, match="exact prior"):
        inspect_amendment(source, home, ROOM, scripts=["task.sh"])
    report = inspect_amendment(source, home, ROOM, scripts=["task.sh"], prepared=prepared)
    with pytest.raises(AmendmentRefused):
        apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"],
                        stopped_marker=tmp_path / "missing", scripts=["task.sh"], prepared=prepared)
    apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"],
                    stopped_marker=_marker(tmp_path, home), scripts=["task.sh"], prepared=prepared)
    assert (home / "scripts/task.sh").read_text() == "echo new\n"


def test_provisioned_air_target_uses_existing_content_receipt_without_creating_import_receipt(tmp_path: Path):
    source, home = tmp_path / "source", tmp_path / "air-home"
    _profile(source, memory="portable memory", config={
        "model": {"provider": "openai-codex", "default": "source"},
        "memory": {"memory_enabled": True},
        # This belongs to the other Mac and must be omitted rather than copied.
        "mcp_servers": {"old-mac": {"command": "/missing/old-mac-tool"}},
    })
    _imported_destination(home)
    (home / ".atum-profile-import.json").unlink()
    _write(home / ".atum-agent-content/skills.json", json.dumps({"schema_version": 1, "skills": {}}))
    with pytest.raises(AmendmentRefused):
        inspect_amendment(source, home, ROOM)
    report = inspect_amendment(source, home, ROOM, provisioned_target=True)
    assert report["target_kind"] == "provisioned"
    assert "mcp_servers" not in report["config_keys"]
    # The content-receipt digest is part of the plan binding, so a changed
    # provisioned target cannot be applied from an old dry-run.
    _write(home / ".atum-agent-content/skills.json", json.dumps({"schema_version": 1, "skills": {"portable": "b" * 64}}))
    with pytest.raises(AmendmentRefused, match="inspect a new plan"):
        apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"],
                        stopped_marker=_marker(tmp_path, home), provisioned_target=True)
    updated = inspect_amendment(source, home, ROOM, provisioned_target=True)
    apply_amendment(source, home, ROOM, expected_plan_sha256=updated["plan_sha256"],
                    stopped_marker=_marker(tmp_path, home), provisioned_target=True)
    assert not (home / ".atum-profile-import.json").exists()
    assert (home / "auth.json").read_text() == '{"identity":"destination"}\n'


def test_existing_repaired_mcp_binding_survives_source_amendment(tmp_path: Path):
    source, home = tmp_path / "source", tmp_path / "home"
    _profile(source, config={"mcp_servers": {"local": {"command": sys.executable, "args": ["old.py"]}}})
    _imported_destination(home)
    repaired = {"command": sys.executable, "args": ["compatible.py"], "env": {"LOCAL_STATE_DIR": str(tmp_path)}}
    _write(home / "config.yaml", yaml.safe_dump({"mcp_servers": {"local": repaired}}))
    report = inspect_amendment(source, home, ROOM)
    apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"], stopped_marker=_marker(tmp_path, home))
    assert yaml.safe_load((home / "config.yaml").read_text())["mcp_servers"]["local"] == repaired


def test_rollback_validates_all_backup_bytes_before_restoring_any_file(tmp_path: Path):
    source, home = tmp_path / "source", tmp_path / "home"
    _profile(source, memory="source memory")
    _imported_destination(home)
    report = inspect_amendment(source, home, ROOM)
    result = apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"], stopped_marker=_marker(tmp_path, home))
    receipt_path = home / AMEND_DIR / "receipts" / result["receipt"]
    receipt = json.loads(receipt_path.read_text())
    before = {row["path"]: (home / row["path"]).read_bytes() for row in receipt["files"]}
    (home / receipt["backup"] / "config.yaml").write_text("corrupted backup")
    with pytest.raises(AmendmentRefused, match="snapshot changed"):
        rollback_amendment(home, receipt=receipt_path, stopped_marker=_marker(tmp_path, home))
    assert {name: (home / name).read_bytes() for name in before} == before


def test_amendment_refuses_a_linked_journal_directory(tmp_path: Path):
    source, home, outside = tmp_path / "source", tmp_path / "home", tmp_path / "outside"
    _profile(source, memory="source memory")
    _imported_destination(home)
    outside.mkdir()
    (home / AMEND_DIR).symlink_to(outside, target_is_directory=True)
    report = inspect_amendment(source, home, ROOM)
    with pytest.raises(AmendmentRefused, match="Symlinked"):
        apply_amendment(source, home, ROOM, expected_plan_sha256=report["plan_sha256"], stopped_marker=_marker(tmp_path, home))
    assert not list(outside.iterdir())
