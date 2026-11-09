"""Behavioral coverage for non-mutating skill-command enumeration."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override


def _write_skill(
    skills_dir: Path,
    directory: str,
    name: str,
    *,
    extra_frontmatter: str = "",
) -> Path:
    skill_dir = skills_dir / directory
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        f"name: {json.dumps(name)}\n"
        f"description: Description for {name}.\n"
        f"{extra_frontmatter}"
        "---\n\n"
        "Use this skill.\n",
        encoding="utf-8",
    )
    return skill_dir


def test_enumeration_uses_profile_filters_normalization_and_precedence(tmp_path):
    """Enumeration keeps the existing registration rules without caching them."""
    from agent.skill_commands import get_skill_commands

    home = tmp_path / "profile"
    local_skills = home / "skills"
    external_skills = home / "external"
    home.mkdir()
    (home / "config.yaml").write_text(
        "skills:\n"
        "  disabled: [Disabled Skill]\n"
        "  external_dirs: [external]\n",
        encoding="utf-8",
    )

    local_winner = _write_skill(local_skills, "local-winner", "git_helper")
    _write_skill(
        local_skills,
        "mixed-name",
        "Upper Case_skill + punctuation!",
    )
    _write_skill(local_skills, "disabled", "Disabled Skill")
    _write_skill(local_skills, "core-command", "skills")
    _write_skill(local_skills, "core-alias", "bg")
    _write_skill(local_skills, "punctuation-only", "!!!")
    _write_skill(
        local_skills,
        "mac-only",
        "Mac only",
        extra_frontmatter="platforms: [macos]\n",
    )
    _write_skill(external_skills, "external-loser", "git-helper")
    _write_skill(external_skills, "external-only", "External Only")

    token = set_hermes_home_override(home)
    try:
        with patch("agent.skill_utils.sys") as mock_sys:
            mock_sys.platform = "linux"
            commands = get_skill_commands()
    finally:
        reset_hermes_home_override(token)

    assert commands["/upper-case-skill-punctuation"]["name"] == (
        "Upper Case_skill + punctuation!"
    )
    assert commands["/git-helper"]["name"] == "git_helper"
    assert commands["/git-helper"]["skill_dir"] == str(local_winner)
    assert "/external-only" in commands
    assert "/disabled-skill" not in commands
    assert "/skills" not in commands
    assert "/bg" not in commands
    assert "/" not in commands
    assert "/mac-only" not in commands


def test_enumerating_another_profile_does_not_mutate_dispatch_cache(tmp_path):
    """A metadata read for profile B cannot replace profile A's live commands."""
    import agent.skill_commands as skill_commands

    home_a = tmp_path / "profile-a"
    home_b = tmp_path / "profile-b"
    _write_skill(home_a / "skills", "alpha", "Alpha Skill")
    _write_skill(home_b / "skills", "bravo", "Bravo Skill")

    with (
        patch.object(skill_commands, "_skill_commands_by_key", {}),
        patch.object(skill_commands, "_skill_commands_sig_by_key", {}),
        patch.object(skill_commands, "_last_interactive_skill_commands_by_key", {}),
    ):
        token_a = set_hermes_home_override(home_a)
        try:
            commands_a = dict(skill_commands.get_skill_commands())
        finally:
            reset_hermes_home_override(token_a)

        token_b = set_hermes_home_override(home_b)
        try:
            metadata_b = skill_commands.get_skill_commands()
            assert "/bravo-skill" in metadata_b
            assert commands_a in skill_commands._skill_commands_by_key.values()

            # The cache identity includes the profile home, so B's normal
            # dispatch view also cannot reuse A's still-live cache.
            commands_b = skill_commands.get_skill_commands()
            assert "/bravo-skill" in commands_b
            assert "/alpha-skill" not in commands_b
        finally:
            reset_hermes_home_override(token_b)


def test_catalog_scopes_another_profile_without_poisoning_dispatch(tmp_path, monkeypatch):
    import agent.skill_commands as skill_commands
    from hermes_cli import profiles
    from tui_gateway import server

    home_a = tmp_path / 'alpha'
    home_b = tmp_path / 'bravo'
    _write_skill(home_a / 'skills', 'alpha', 'Alpha Skill')
    _write_skill(home_b / 'skills', 'bravo', 'Bravo Skill')
    monkeypatch.setattr(profiles, 'get_profile_dir', lambda name: tmp_path / name)
    monkeypatch.setattr(server, '_hermes_home', home_a)
    monkeypatch.setattr(server, '_load_cfg', lambda: {})
    for key, value in [('_skill_commands_by_key', {}), ('_skill_commands_sig_by_key', {}),
                       ('_last_interactive_skill_commands_by_key', {})]:
        monkeypatch.setattr(skill_commands, key, value)
    token = set_hermes_home_override(home_a)
    try:
        cached = dict(skill_commands.get_skill_commands())
        result = server._methods['commands.catalog']('catalog-b', {'profile': 'bravo'})
        assert set(result['result']['skills']) == {'/bravo-skill'}
        assert cached in skill_commands._skill_commands_by_key.values()
        assert '/alpha-skill' in skill_commands.get_skill_commands()
        with pytest.raises(server.ProfileUnavailableError):
            server._methods['commands.catalog']('missing', {'profile': 'missing'})
        with pytest.raises(server.ProfileUnavailableError):
            server._methods['commands.catalog']('invalid', {'profile': '../alpha'})
    finally:
        reset_hermes_home_override(token)
