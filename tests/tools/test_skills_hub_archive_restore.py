"""The Matrix Skills Hub "Archive" never deletes a hub-installed skill.

The desktop labels the action "Archiving…" and posts ``archive: true``; the skill (local
edits included) must land in the curator's restorable archive and come back through
``hermes curator restore``. A plain uninstall stays upstream's explicit delete.
"""

import json

import pytest

from hermes_constants import get_hermes_home


@pytest.fixture
def installed(tmp_path):
    """One hub-installed skill with a local edit, under the test's temp HERMES_HOME."""
    from tools.skills_hub import HubLockFile

    skills = get_hermes_home() / "skills"
    skill_dir = skills / "research" / "demo"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: demo\ndescription: Demo skill.\n---\n\nBody.\n")
    (skill_dir / "notes.md").write_text("my local edit\n")
    HubLockFile().record_install(
        name="demo", source="github", identifier="github/acme/demo", trust_level="community",
        scan_verdict="safe", skill_hash="sha256:0", install_path="research/demo",
        files=["SKILL.md"],
    )
    return skills, skill_dir


def test_archive_keeps_every_file_and_restore_brings_it_back(installed):
    from tools import skill_usage
    from tools.skills_hub import HubLockFile
    from tools.skills_hub_install import archive_hub_skill

    skills, skill_dir = installed
    ok, message = archive_hub_skill("demo")

    assert ok, message
    assert not skill_dir.exists()
    archived = skills / ".archive" / "demo"
    assert (archived / "notes.md").read_text() == "my local edit\n"
    assert (archived / "SKILL.md").is_file()
    assert HubLockFile().get_installed("demo") is None

    ok, message = skill_usage.restore_skill("demo")

    assert ok, message
    assert (skills / "demo" / "notes.md").read_text() == "my local edit\n"
    assert not archived.exists()


def test_archive_refuses_a_skill_that_is_not_hub_installed_and_touches_nothing(installed):
    from tools.skills_hub_install import archive_hub_skill

    skills, _skill_dir = installed
    local = skills / "mine"
    local.mkdir()
    (local / "SKILL.md").write_text("---\nname: mine\ndescription: Mine.\n---\n")

    ok, message = archive_hub_skill("mine")

    assert not ok and "not a hub-installed skill" in message
    assert (local / "SKILL.md").is_file()


def test_a_second_archive_of_the_same_name_keeps_both_copies(installed):
    from tools.skills_hub import HubLockFile
    from tools.skills_hub_install import archive_hub_skill

    skills, skill_dir = installed
    assert archive_hub_skill("demo")[0]
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: demo\ndescription: Demo skill.\n---\n\nv2\n")
    HubLockFile().record_install(
        name="demo", source="github", identifier="github/acme/demo", trust_level="community",
        scan_verdict="safe", skill_hash="sha256:1", install_path="research/demo", files=["SKILL.md"],
    )

    assert archive_hub_skill("demo")[0]

    copies = sorted(p.name for p in (skills / ".archive").iterdir())
    assert len(copies) == 2 and copies[0] == "demo"


def test_a_failed_receipt_update_puts_the_skill_back(installed, monkeypatch):
    from tools.skills_hub import HubLockFile
    from tools.skills_hub_install import archive_hub_skill

    _skills, skill_dir = installed
    monkeypatch.setattr(HubLockFile, "record_uninstall", lambda self, name: (_ for _ in ()).throw(OSError("disk")))

    ok, message = archive_hub_skill("demo")

    assert not ok and "disk" in message
    assert (skill_dir / "notes.md").read_text() == "my local edit\n"


def test_cli_archive_flag_routes_to_the_non_destructive_path(installed):
    from hermes_cli.skills_hub import do_uninstall

    skills, _skill_dir = installed

    assert do_uninstall("demo", skip_confirm=True, invalidate_cache=False, archive=True) is True
    assert (skills / ".archive" / "demo" / "notes.md").is_file()


def test_web_archive_request_spawns_the_archive_command_never_a_delete(monkeypatch):
    import asyncio

    from hermes_cli.web_models import SkillUninstallRequest
    from hermes_cli.web_routers import skills as router

    spawned = []
    monkeypatch.setattr(router, "spawn_profile_action",
                        lambda profile, argv, name, **kw: spawned.append((argv, name)) or {"ok": True, "name": name})

    asyncio.run(router.uninstall_skill_hub(SkillUninstallRequest(name="demo", archive=True)))
    asyncio.run(router.uninstall_skill_hub(SkillUninstallRequest.model_validate(json.loads('{"name": "demo"}'))))

    (archive_argv, archive_name), (plain_argv, _plain_name) = spawned
    assert archive_argv == ["skills", "uninstall", "demo", "--archive", "--yes"]
    assert archive_name.startswith("skills-archive-")
    assert "--archive" not in plain_argv
