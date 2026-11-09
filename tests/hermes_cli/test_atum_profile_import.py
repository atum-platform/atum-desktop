"""Offline import rehearsal: real files, no account or live provider access."""

import json
import os
from pathlib import Path
import stat

import pytest
import yaml

from cron.jobs import get_due_jobs, load_jobs, use_cron_store
from hermes_cli import atum_profile_import as importer
from hermes_cli import atum_profile_install as installer
from hermes_cli.atum_portability import _skill_tree_hash, _validate_definition
from tools.memory_tool import ENTRY_DELIMITER, MemoryStore


ROOM = "!agent-proof:atum.example"


def put(root, relative, content):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode())
    return path


@pytest.fixture
def profile(tmp_path):
    root = tmp_path / "source"
    put(root, "config.yaml", yaml.safe_dump({
        "model": {"provider": "openai-codex", "default": "owner-model", "api_key": "do-not-copy"},
        "memory": {"memory_enabled": True, "memory_char_limit": 9000},
        "plugins": {"disabled": ["atum-platform"], "enabled": ["legacy"],
                    "entries": {"legacy": {"api_key": "secret-config"}}},
        "skills": {"disabled": ["unused"]}, "timezone": "Asia/Ho_Chi_Minh",
        "mcp_servers": {"custom": {"command": "never-start-me"}},
    }))
    put(root, "SOUL.md", "I am the source agent.")
    put(root, "AGENTS.md", "Keep the intended role.")
    put(root, "memories/MEMORY.md", ENTRY_DELIMITER.join(["Likes concise answers", "[local] Keep here", "/Users/fixture/private"]))
    put(root, "memories/USER.md", "Uses Vietnamese")
    put(root, "skills/research/SKILL.md", "---\nname: research\n---\nResearch well.")
    put(root, "skills/research/references/example.md", "Supporting data")
    put(root, "skills/research/scripts/query.sh", "#!/bin/sh\nexit 0\n").chmod(0o755)
    put(root, "skills/research/.git/config", "Never included")
    put(root, "skills/research/__pycache__/unused.pyc", b"cache")
    put(root, "scripts/report.sh", "#!/bin/sh\necho no-side-effects\n").chmod(0o755)
    put(root, "cron/jobs.json", json.dumps({"jobs": [{
        "id": "job1", "name": "Source job", "prompt": "Describe today",
        "schedule": {"kind": "cron", "expr": "0 9 * * *"},
        "repeat": {"times": None, "completed": 7}, "script": "report.sh",
        "provider": "openai-codex", "model": "owner-model",
        "created_at": "2026-01-01T00:00:00Z", "no_agent": True,
        "context_from": ["earlier-job"], "enabled_toolsets": ["terminal"],
        "base_url": "https://example.test/v1",
        "enabled": True, "state": "scheduled", "next_run_at": "2000-01-01T00:00:00Z",
        "profile": "source", "fire_claim": "old-claim", "session_id": "old-session",
        "deliver": "telegram:123", "origin": {"platform": "telegram", "chat_id": "123"},
        "attach_to_session": True, "workdir": "/local/same-machine/project",
    }]}))
    # These are intentionally unreadable to the importer, not just absent fixtures.
    for name in (".env", "auth.json", "state.db", "sessions/old.json", "logs/agent.log"):
        put(root, name, "DO NOT READ OR COPY").chmod(0)
    return root


def snapshot(root):
    return {str(p.relative_to(root)): (p.stat().st_mode, p.read_bytes() if p.stat().st_mode & 0o400 else None)
            for p in root.rglob("*") if p.is_file()}


def stage(profile, destination, **kwargs):
    plan = importer.inspect_profile(profile, ROOM, **kwargs)
    importer.stage_profile(profile, destination, ROOM, expected_sha256=plan.manifest["sha256"], **kwargs)
    return destination / "prepared", plan


def test_install_into_new_home_rebinds_jobs_without_running_them(profile, tmp_path):
    before = snapshot(profile)
    prepared, plan = stage(profile, tmp_path / "prepared-copy")
    home = tmp_path / "new-executor"
    payload = installer.payload(installer.read_prepared(prepared))
    assert payload["definition"] == json.loads((prepared / "definition.json").read_text())
    assert len(payload["bundles"]) == len(payload["definition"]["skills"])
    room = "!actual:atum.example"
    result = installer.install_prepared(prepared, home, room, expected_sha256=plan.manifest["sha256"])
    assert result["status"] == "installed"
    assert snapshot(profile) == before
    assert yaml.safe_load((home / "config.yaml").read_text())["model"]["provider"] == "openai-codex"
    assert _skill_tree_hash(home / "skills/research") == payload["bundles"][0]["sha256"]
    jobs = json.loads((home / "cron/jobs.json").read_text())["jobs"]
    assert jobs[0]["deliver"] == f"matrix:{room}"
    assert jobs[0]["origin"] == {"platform": "matrix", "chat_id": room}
    assert jobs[0]["enabled"] is False and jobs[0]["state"] == "paused"
    assert jobs[0]["next_run_at"] is None
    with use_cron_store(home):
        assert get_due_jobs() == []
    assert stat.S_IMODE((home / "scripts/report.sh").stat().st_mode) == 0o700
    assert stat.S_IMODE((home / "SOUL.md").stat().st_mode) == 0o600
    assert stat.S_IMODE(home.stat().st_mode) == 0o700
    assert not (home / "auth.json").exists()


def test_install_receipt_recovers_without_replacing_runtime_edits(profile, tmp_path):
    prepared, plan = stage(profile, tmp_path / "prepared-copy")
    home = tmp_path / "executor"
    digest = plan.manifest["sha256"]
    first = installer.install_prepared(prepared, home, ROOM, expected_sha256=digest)
    (home / "SOUL.md").write_text("Changed after startup")
    assert installer.install_prepared(prepared, home, ROOM, expected_sha256=digest) == first
    assert (home / "SOUL.md").read_text() == "Changed after startup"
    with pytest.raises(importer.ImportRefused):
        installer.install_prepared(prepared, home, "!other:atum.example", expected_sha256=digest)
    with pytest.raises(importer.ImportRefused):
        installer.install_prepared(prepared, home, ROOM, expected_sha256="a" * 64)


@pytest.mark.parametrize("kind", ["empty", "existing", "symlink"])
def test_install_never_replaces_existing_home(profile, tmp_path, kind):
    prepared, plan = stage(profile, tmp_path / "prepared-copy")
    home = tmp_path / "executor"
    if kind == "symlink":
        home.symlink_to(profile, target_is_directory=True)
    else:
        home.mkdir()
        if kind == "existing":
            (home / "SOUL.md").write_text("My agent")
    before = snapshot(profile)
    with pytest.raises(importer.ImportRefused):
        installer.install_prepared(prepared, home, ROOM, expected_sha256=plan.manifest["sha256"])
    assert snapshot(profile) == before
    assert home.exists()


@pytest.mark.parametrize("tamper", ["content", "manifest", "extra", "symlink", "stale", "missing"])
def test_import_rejects_changed_or_incomplete_preparation(profile, tmp_path, tamper):
    prepared, plan = stage(profile, tmp_path / "prepared-copy")
    digest = plan.manifest["sha256"]
    if tamper == "content":
        (prepared / "profile/SOUL.md").write_text("Changed")
    elif tamper == "manifest":
        manifest = json.loads((prepared / "manifest.json").read_text())
        manifest["room"] = "!changed:test"
        (prepared / "manifest.json").write_text(json.dumps(manifest))
    elif tamper == "extra":
        (prepared / "profile/auth.json").write_text("Do not read me")
    elif tamper == "symlink":
        (prepared / "profile/SOUL.md").unlink()
        (prepared / "profile/SOUL.md").symlink_to(profile / "SOUL.md")
    elif tamper == "missing":
        (prepared / "profile/SOUL.md").unlink()
    else:
        digest = "0" * 64
    with pytest.raises((importer.ImportRefused, OSError)):
        installer.read_prepared(prepared, digest)
    assert not (tmp_path / "executor").exists()


def test_import_refuses_placeholder_room_and_mismatched_skill_definition(profile, tmp_path):
    prepared, plan = stage(profile, tmp_path / "prepared-copy")
    with pytest.raises(importer.ImportRefused):
        installer.install_prepared(prepared, tmp_path / "executor", "!fake:atum.invalid",
                                   expected_sha256=plan.manifest["sha256"])
    definition = json.loads(plan.files["definition.json"])
    definition["skills"] = []
    plan.files["definition.json"] = json.dumps(definition).encode()
    with pytest.raises(importer.ImportRefused, match="Unreferenced"):
        installer.payload(plan)


def test_three_profiles_are_independent_and_sources_untouched(profile, tmp_path):
    before = snapshot(profile)
    staged = []
    for index in range(3):
        root, plan = stage(profile, tmp_path / f"agent-{index}")
        staged.append(root)
        definition = json.loads((root / "definition.json").read_text())
        _validate_definition(definition)
        assert definition["soul"] == "I am the source agent.\n\n## Role\n\nKeep the intended role."
        assert definition["model_alias"] == "binh-minh"
        config = yaml.safe_load((root / "profile/config.yaml").read_text())
        assert config["model"] == {"default": "owner-model", "provider": "openai-codex"}
        assert config["plugins"] == {"disabled": ["atum-platform"]}
        assert config["memory"] == {"memory_enabled": True, "memory_char_limit": 9000}
        assert "skills" not in config
        assert config["timezone"] == "Asia/Ho_Chi_Minh"
        assert "mcp_servers" not in config
        assert "mcp_servers" in plan.manifest["omitted_config"]
        assert "skills" in plan.manifest["omitted_config"]
        assert "plugins.entries" in plan.manifest["omitted_config"]
        assert MemoryStore._read_file(root / "profile/memories/MEMORY.md") == ["Likes concise answers"]
        assert plan.manifest["filtered_memory_entries"] == {"memory": 2, "user": 0}
        assert _skill_tree_hash(root / "profile/skills/research") == definition["skills"][0]["sha256"]
        assert not (root / "profile/skills/research/.git").exists()
        with use_cron_store(root / "profile"):
            jobs = load_jobs()
            assert get_due_jobs() == []
        assert len(jobs) == 1
        job = jobs[0]
        assert (job["enabled"], job["state"], job["next_run_at"]) == (False, "paused", None)
        assert job["deliver"] == f"matrix:{ROOM}"
        assert job["origin"] == {"platform": "matrix", "chat_id": ROOM}
        assert job["provider"] == "openai-codex"
        assert job["repeat"]["completed"] == 7
        assert job["workdir"] == "/local/same-machine/project"
        assert not {"profile", "fire_claim", "session_id"} & job.keys()
        assert job["attach_to_session"] is False
        assert job["paused_reason"] == "atum_import_rehearsal"
        assert all(job[key] is None for key in ("last_run_at", "last_status", "last_error", "last_delivery_error"))
        source_job = json.loads((profile / "cron/jobs.json").read_bytes())["jobs"][0]
        for key in ("schedule", "created_at", "no_agent", "context_from", "enabled_toolsets", "base_url"):
            assert job[key] == source_job[key]
        assert (root / "profile/scripts/report.sh").read_bytes() == (profile / "scripts/report.sh").read_bytes()
        assert stat.S_IMODE((root / "profile/scripts/report.sh").stat().st_mode) == 0o700
        assert stat.S_IMODE((root / "profile/skills/research/scripts/query.sh").stat().st_mode) == 0o700
        assert stat.S_IMODE((root / "definition.json").stat().st_mode) == 0o600
        assert stat.S_IMODE(root.stat().st_mode) == 0o700
        for name in (".env", "auth.json", "state.db", "sessions", "logs"):
            assert not (root / "profile" / name).exists()
    put(staged[0], "profile/SOUL.md", "Change only the first")
    assert (staged[1] / "profile/SOUL.md").read_bytes() == (staged[2] / "profile/SOUL.md").read_bytes()
    assert snapshot(profile) == before


def test_inspection_is_read_only_and_has_no_private_prose(profile, capsys):
    before = snapshot(profile)
    paths = set(profile.rglob("*"))
    assert importer.main(["inspect", "--source", str(profile), "--room", ROOM]) == 0
    report = capsys.readouterr().out
    assert "I am the source agent" not in report
    assert "Likes concise answers" not in report
    assert "do-not-copy" not in report
    assert "old-claim" not in report
    assert snapshot(profile) == before
    assert set(profile.rglob("*")) == paths


def test_empty_soul_preserves_valid_role_without_inventing_a_persona(profile):
    put(profile, "SOUL.md", "")
    definition = json.loads(importer.inspect_profile(profile, ROOM).files["definition.json"])
    _validate_definition(definition)
    assert definition["soul"] == "\n\n## Role\n\nKeep the intended role."


def test_explicit_disabled_config_is_in_parity_inventory(profile):
    config = yaml.safe_load((profile / "config.yaml").read_text())
    config.update({"checkpoints": False, "max_turns": 0, "mcp_servers": {}})
    config["plugins"]["enabled"] = []
    put(profile, "config.yaml", yaml.safe_dump(config))
    omitted = importer.inspect_profile(profile, ROOM).manifest["omitted_config"]
    assert {"checkpoints", "max_turns", "mcp_servers", "plugins.enabled", "skills"} <= set(omitted)


@pytest.mark.parametrize("bare_list", [False, True])
@pytest.mark.parametrize("bom", [False, True])
def test_cron_byte_parser_accepts_bom_and_legacy_bare_list(profile, bare_list, bom):
    value = json.loads((profile / "cron/jobs.json").read_bytes())
    raw = json.dumps(value["jobs"] if bare_list else value).encode("utf-8-sig" if bom else "utf-8")
    put(profile, "cron/jobs.json", raw)
    plan = importer.inspect_profile(profile, ROOM)
    assert len(plan.manifest["jobs"]) == 1
    assert json.loads(plan.files["profile/cron/jobs.json"])["jobs"][0]["enabled"] is False


@pytest.mark.parametrize("name", ["SOUL.md", "AGENTS.md"])
@pytest.mark.parametrize("cyclic", [False, True])
def test_broken_instruction_links_are_reported_without_tracebacks(profile, capsys, name, cyclic):
    target = profile / name
    target.unlink()
    target.symlink_to(target if cyclic else profile / "missing")
    assert importer.main(["inspect", "--source", str(profile), "--room", ROOM]) == 1
    assert "link target" in json.loads(capsys.readouterr().out)["error"]


@pytest.mark.parametrize("flag", ["--allow-skill-link", "--allow-instruction-link"])
def test_missing_approved_target_is_reported(profile, tmp_path, capsys, flag):
    assert importer.main(["inspect", "--source", str(profile), "--room", ROOM,
                          flag, str(tmp_path / "missing")]) == 1
    assert "link target" in json.loads(capsys.readouterr().out)["error"]


def test_stage_refuses_a_changed_source(profile, tmp_path):
    digest = importer.inspect_profile(profile, ROOM).manifest["sha256"]
    put(profile, "SOUL.md", "New source instruction")
    destination = tmp_path / "output"
    with pytest.raises(importer.ImportRefused, match="changed"):
        importer.stage_profile(profile, destination, ROOM, expected_sha256=digest)
    assert not destination.exists()


@pytest.mark.parametrize("kind", ["empty", "nonempty", "symlink", "inside-source"])
def test_never_overwrites_or_writes_into_source(profile, tmp_path, kind):
    target = tmp_path / "output"
    if kind in ("empty", "nonempty"):
        target.mkdir()
        if kind == "nonempty":
            put(target, "user.txt", "Important")
    elif kind == "symlink":
        target.symlink_to(profile, target_is_directory=True)
    else:
        target = profile / "output"
    with pytest.raises(importer.ImportRefused):
        stage(profile, target)
    if kind == "nonempty":
        assert (target / "user.txt").read_text() == "Important"


def test_approved_link_is_materialized_and_hash_verified(profile, tmp_path):
    linked = tmp_path / "shared-skill"
    put(linked, "SKILL.md", "Shared skill")
    (profile / "skills/shared").symlink_to(linked, target_is_directory=True)
    with pytest.raises(importer.ImportRefused, match="approval"):
        importer.inspect_profile(profile, ROOM)
    root, plan = stage(profile, tmp_path / "output", allow_skill_links=(linked,))
    assert not (root / "profile/skills/shared").is_symlink()
    assert (root / "profile/skills/shared/SKILL.md").read_text() == "Shared skill"
    assert next(s for s in plan.manifest["skills"] if s["name"] == "shared")["sha256"] == _skill_tree_hash(linked)


def test_explicit_instruction_link_is_read_without_granting_config_access(profile, tmp_path):
    instruction = put(tmp_path, "shared/CLAUDE.md", "Shared role")
    (profile / "AGENTS.md").unlink()
    (profile / "AGENTS.md").symlink_to(instruction)
    with pytest.raises(importer.ImportRefused, match="approval"):
        importer.inspect_profile(profile, ROOM)
    root, _ = stage(profile, tmp_path / "output", allow_instruction_links=(instruction,))
    assert (root / "profile/SOUL.md").read_text().endswith("## Role\n\nShared role")
    config = put(tmp_path, "config.yaml", (profile / "config.yaml").read_bytes())
    (profile / "config.yaml").unlink()
    (profile / "config.yaml").symlink_to(config)
    with pytest.raises(importer.ImportRefused):
        importer.inspect_profile(profile, ROOM, allow_instruction_links=(instruction, config))


@pytest.mark.parametrize("artifact", ["SOUL.md", "config.yaml", "memories/MEMORY.md", "skills/research/SKILL.md", "scripts/report.sh"])
def test_symlinked_input_cannot_read_an_outside_file(profile, tmp_path, artifact):
    outside = put(tmp_path, "private.txt", "not allowed")
    target = profile / artifact
    target.unlink()
    target.symlink_to(outside)
    with pytest.raises(importer.ImportRefused):
        importer.inspect_profile(profile, ROOM)


def test_nested_skill_link_is_not_authorized_by_top_level_approval(profile, tmp_path):
    outside = tmp_path / "outside"
    put(outside, "SKILL.md", "Outside")
    (profile / "skills/research/references/nested").symlink_to(outside, target_is_directory=True)
    with pytest.raises(importer.ImportRefused, match="Nested"):
        importer.inspect_profile(profile, ROOM, allow_skill_links=(outside,))


def test_broken_skill_link_is_not_silently_dropped(profile, tmp_path):
    (profile / "skills/broken").symlink_to(tmp_path / "missing", target_is_directory=True)
    with pytest.raises(importer.ImportRefused):
        importer.inspect_profile(profile, ROOM)


def test_skill_cloud_limits_are_reported_without_truncating_local_package(profile, tmp_path):
    content = b"x" * (2 * 1024 * 1024 + 1)
    put(profile, "skills/research/assets/large.bin", content)
    root, plan = stage(profile, tmp_path / "output")
    assert plan.manifest["cloud_skill_blockers"] == [{"name": "research", "reasons": ["bundle_size"]}]
    assert (root / "profile/skills/research/assets/large.bin").read_bytes() == content


@pytest.mark.parametrize("name", [".env", ".env.local", "auth.json", "private.key", "credentials.json"])
def test_credential_named_skill_files_refuse_instead_of_silently_exporting(profile, name):
    put(profile, f"skills/research/{name}", "secret")
    with pytest.raises(importer.ImportRefused, match="Credential-named"):
        importer.inspect_profile(profile, ROOM)


def test_special_file_never_blocks_reading(profile):
    os.mkfifo(profile / "skills/research/fifo")
    with pytest.raises(importer.ImportRefused, match="regular"):
        importer.inspect_profile(profile, ROOM)


def test_unreadable_skill_directory_cannot_look_like_a_complete_copy(profile):
    directory = profile / "skills/research/references"
    directory.chmod(0)
    try:
        with pytest.raises(importer.ImportRefused, match="enumerate"):
            importer.inspect_profile(profile, ROOM)
    finally:
        directory.chmod(0o700)


def test_hardlinked_file_is_not_copied(profile, tmp_path):
    outside = put(tmp_path, "private.txt", "Private data")
    os.link(outside, profile / "skills/research/link.txt")
    with pytest.raises(importer.ImportRefused, match="regular"):
        importer.inspect_profile(profile, ROOM)


def test_script_traversal_rejected(profile):
    jobs = json.loads((profile / "cron/jobs.json").read_text())
    jobs["jobs"][0]["script"] = "../.env"
    put(profile, "cron/jobs.json", json.dumps(jobs))
    with pytest.raises(importer.ImportRefused, match="relative"):
        importer.inspect_profile(profile, ROOM)


def test_source_changed_while_staging_is_not_published(profile, tmp_path, monkeypatch):
    digest = importer.inspect_profile(profile, ROOM).manifest["sha256"]
    original = importer._skill_tree_hash

    def hash_and_change(path):
        result = original(path)
        put(profile, "AGENTS.md", "Changed concurrently")
        return result

    monkeypatch.setattr(importer, "_skill_tree_hash", hash_and_change)
    target = tmp_path / "output"
    with pytest.raises(importer.ImportRefused, match="changed during"):
        importer.stage_profile(profile, target, ROOM, expected_sha256=digest)
    assert not target.exists()
    assert not list(tmp_path.glob(".atum-import-*"))


def test_secret_in_persona_redacted_before_definition(profile):
    token = "sk-ant-api03-" + "q" * 90
    put(profile, "SOUL.md", f"My instructions. API key: {token}")
    plan = importer.inspect_profile(profile, ROOM)
    assert token.encode() not in plan.files["definition.json"]
    assert token.encode() not in plan.files["profile/SOUL.md"]
    assert (profile / "SOUL.md").read_text().endswith(token)


@pytest.mark.parametrize("artifact,data", [
    ("config.yaml", "[]"), ("config.yaml", "model: [broken"),
    ("cron/jobs.json", "null"), ("cron/jobs.json", '{"jobs": [null]}'),
    ("SOUL.md", "x" * 65537), ("SOUL.md", b"\xff"),
])
def test_invalid_input_fails_loudly_without_echoing_contents(profile, capsys, artifact, data):
    put(profile, artifact, data)
    assert importer.main(["inspect", "--source", str(profile), "--room", ROOM]) == 1
    result = json.loads(capsys.readouterr().out)
    assert "error" in result
    assert "model: [broken" not in result["error"]


def test_staged_copy_failure_preserves_source_and_leaves_no_published_result(profile, tmp_path, monkeypatch):
    digest = importer.inspect_profile(profile, ROOM).manifest["sha256"]
    before = snapshot(profile)

    def failed_hash(path):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(importer, "_skill_tree_hash", failed_hash)
    target = tmp_path / "output"
    with pytest.raises(OSError):
        importer.stage_profile(profile, target, ROOM, expected_sha256=digest)
    assert snapshot(profile) == before
    assert not target.exists()
    assert not list(tmp_path.glob(".atum-import-*"))
