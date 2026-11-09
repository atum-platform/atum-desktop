"""Behavioral tests for one-profile bundled skill additions."""

import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import pytest


def _write_bundled_skill(bundled: Path, relative_dir: str, name: str) -> Path:
    source = bundled / relative_dir
    source.mkdir(parents=True, exist_ok=True)
    (source / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} skill\n---\n\nUse it.\n",
        encoding="utf-8",
    )
    (source / "reference.txt").write_text(name, encoding="utf-8")
    return source


def test_add_bundled_skill_respects_opt_out_and_clears_only_its_suppression(tmp_path):
    from tools.skills_sync import add_bundled_skill, dir_hash

    bundled = tmp_path / "bundled"
    source = _write_bundled_skill(bundled, "productivity/docx", "docx")
    home = tmp_path / "profile"
    home.mkdir()
    (home / ".no-bundled-skills").write_text("opted out\n", encoding="utf-8")
    skills = home / "skills"
    skills.mkdir()
    (skills / ".curator_suppressed").write_text(
        "docx\nother-pruned\n", encoding="utf-8"
    )

    with patch("tools.skills_sync._get_bundled_dir", return_value=bundled):
        result = add_bundled_skill("docx", home)

    assert result == {"action": "added", "name": "docx"}
    assert (home / ".no-bundled-skills").exists()
    installed = skills / "productivity" / "docx"
    assert (installed / "SKILL.md").exists()
    assert (installed / "reference.txt").read_text() == (
        source / "reference.txt"
    ).read_text()
    assert "docx" not in (skills / ".curator_suppressed").read_text()
    assert "other-pruned" in (skills / ".curator_suppressed").read_text()
    assert (skills / ".bundled_manifest").read_text() == f"docx:{dir_hash(source)}\n"


def test_add_bundled_skill_preserves_manifest_and_recovers_after_manifest_write_failure(tmp_path):
    import tools.skills_sync as sync

    bundled = tmp_path / "bundled"
    _write_bundled_skill(bundled, "productivity/xlsx", "xlsx")
    home = tmp_path / "profile"
    skills = home / "skills"
    skills.mkdir(parents=True)
    manifest = skills / ".bundled_manifest"
    manifest.write_text("unrelated:keep-this-hash\n", encoding="utf-8")

    with patch("tools.skills_sync._get_bundled_dir", return_value=bundled):
        with patch.object(sync, "_write_manifest", return_value=False):
            interrupted = sync.add_bundled_skill("xlsx", home)

        assert interrupted == {"action": "recovery_needed", "name": "xlsx"}
        assert (skills / "productivity" / "xlsx" / "SKILL.md").exists()
        assert manifest.read_text() == "unrelated:keep-this-hash\n"

        recovered = sync.add_bundled_skill("xlsx", home)

    assert recovered == {"action": "already_present", "name": "xlsx"}
    manifest_entries = manifest.read_text()
    assert "unrelated:keep-this-hash" in manifest_entries
    assert "xlsx:" in manifest_entries


def test_add_bundled_skill_verifies_suppression_removal_and_can_retry(tmp_path):
    import tools.skill_usage as skill_usage
    from tools.skills_sync import add_bundled_skill

    bundled = tmp_path / "bundled"
    _write_bundled_skill(bundled, "productivity/docx", "docx")
    home = tmp_path / "profile"
    skills = home / "skills"
    skills.mkdir(parents=True)
    suppression = skills / ".curator_suppressed"
    suppression.write_text("docx\nkeep-me\n", encoding="utf-8")

    with patch("tools.skills_sync._get_bundled_dir", return_value=bundled):
        with patch.object(skill_usage, "_toggle_suppressed_name", return_value=None):
            partial = add_bundled_skill("docx", home)
        recovered = add_bundled_skill("docx", home)

    assert partial == {"action": "recovery_needed", "name": "docx"}
    assert recovered == {"action": "already_present", "name": "docx"}
    assert suppression.read_text() == "keep-me\n"


def test_add_bundled_skill_refuses_custom_and_external_name_collisions(tmp_path):
    from tools.skills_sync import add_bundled_skill

    bundled = tmp_path / "bundled"
    _write_bundled_skill(bundled, "productivity/powerpoint", "powerpoint")
    home = tmp_path / "profile"
    custom_dest = home / "skills" / "productivity" / "powerpoint"
    custom_dest.mkdir(parents=True)
    (custom_dest / "SKILL.md").write_text("customized", encoding="utf-8")

    with patch("tools.skills_sync._get_bundled_dir", return_value=bundled):
        with pytest.raises(FileExistsError, match="differs"):
            add_bundled_skill("powerpoint", home)

    shutil.rmtree(custom_dest)
    external = home / "external"
    _write_bundled_skill(external, "powerpoint", "powerpoint")
    (home / "config.yaml").write_text(
        "skills:\n  external_dirs: [external]\n", encoding="utf-8"
    )
    with patch("tools.skills_sync._get_bundled_dir", return_value=bundled):
        with pytest.raises(FileExistsError, match="external"):
            add_bundled_skill("powerpoint", home)


@pytest.mark.parametrize("held", [False, True])
def test_add_bundled_skill_refuses_same_frontmatter_name_elsewhere_in_profile(tmp_path, held):
    from agent.skill_utils import iter_skill_index_files
    from tools.skills_sync import add_bundled_skill

    bundled = tmp_path / "bundled"
    _write_bundled_skill(bundled, "productivity/docx", "docx")
    home = tmp_path / "profile"
    existing = home / "skills" / "personal" / "my-docx"
    existing.mkdir(parents=True)
    (existing / "SKILL.md").write_text(
        "---\nname: docx\n---\nMy own instructions.\n", encoding="utf-8"
    )

    with (
        patch("tools.skills_sync._get_bundled_dir", return_value=bundled),
        patch("agent.skill_utils.skill_hold", return_value="not_owned" if held else None),
    ):
        visible = list(iter_skill_index_files(home / "skills", "SKILL.md"))
        assert visible == ([] if held else [existing / "SKILL.md"])
        with pytest.raises(FileExistsError, match="already exists locally"):
            add_bundled_skill("docx", home)

    assert not (home / "skills" / "productivity" / "docx").exists()
    assert (existing / "SKILL.md").read_text() == (
        "---\nname: docx\n---\nMy own instructions.\n"
    )


def test_add_bundled_skill_rejects_symlinked_target_paths_and_existing_trees(tmp_path):
    from tools.skills_sync import add_bundled_skill

    bundled = tmp_path / "bundled"
    source = _write_bundled_skill(bundled, "productivity/docx", "docx")
    home = tmp_path / "profile"
    skills = home / "skills"
    skills.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    category_link = skills / "productivity"
    try:
        category_link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlinks unavailable in test environment: {exc}")

    with patch("tools.skills_sync._get_bundled_dir", return_value=bundled):
        with pytest.raises(ValueError, match="symlink"):
            add_bundled_skill("docx", home)

    category_link.unlink()
    installed = skills / "productivity" / "docx"
    installed.parent.mkdir(parents=True)
    shutil.copytree(source, installed)
    (installed / "reference.txt").unlink()
    (installed / "reference.txt").symlink_to(source / "reference.txt")

    with patch("tools.skills_sync._get_bundled_dir", return_value=bundled):
        with pytest.raises(ValueError, match="contains a symlink"):
            add_bundled_skill("docx", home)


def test_add_and_normal_sync_share_a_profile_writer_lock(tmp_path):
    import tools.skills_sync as sync

    bundled = tmp_path / "bundled"
    _write_bundled_skill(bundled, "productivity/docx", "docx")
    _write_bundled_skill(bundled, "productivity/xlsx", "xlsx")
    home = tmp_path / "profile"
    skills = home / "skills"
    manifest = skills / ".bundled_manifest"

    with (
        patch("tools.skills_sync._get_bundled_dir", return_value=bundled),
        patch("tools.skills_sync._get_optional_dir", return_value=tmp_path / "no-optional"),
        patch("tools.skills_sync.HERMES_HOME", home),
        patch("tools.skills_sync.SKILLS_DIR", skills),
        patch("tools.skills_sync.MANIFEST_FILE", manifest),
    ):
        with ThreadPoolExecutor(max_workers=2) as executor:
            added = executor.submit(sync.add_bundled_skill, "docx", home)
            seeded = executor.submit(sync.sync_skills, True)
            added.result()
            seeded.result()

    entries = sync._read_manifest(manifest)
    assert {"docx", "xlsx"}.issubset(entries)
    assert (skills / "productivity" / "docx" / "SKILL.md").exists()
    assert (skills / "productivity" / "xlsx" / "SKILL.md").exists()
