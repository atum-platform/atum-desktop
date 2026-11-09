"""Real Matrix skill publication into a warm Hermes process (G1-09).

No model/network calls or real homes: the installer, skill tools, process LRU
and SQLite conversation restoration operate on disposable byte fixtures.
"""

import json
import shutil
from types import SimpleNamespace

import pytest

from agent import prompt_builder
from agent.conversation_loop import _restore_or_build_system_prompt
from hermes_cli.atum_agent_content import install_skills
from hermes_cli.atum_skill_bundles import export_skill_bundle
from hermes_state import SessionDB
from tools import skills_tool


def _skill(directory, name, description, body):
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n{body}\n",
        encoding="utf-8",
    )


def _agent(db, session_id):
    return SimpleNamespace(
        session_id=session_id,
        model="test-model",
        provider="test-provider",
        platform="cli",
        _cached_system_prompt=None,
        _session_db=db,
        _build_system_prompt=lambda _: prompt_builder.build_skills_system_prompt(),
    )


def test_real_install_is_discoverable_now_and_indexed_in_new_chats_in_two_warm_homes(
    monkeypatch, tmp_path
):
    shipped = tmp_path / "shipped"
    shipped.mkdir()
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(shipped))
    source = tmp_path / "source" / "portable"
    _skill(source, "portable", "Portable installed capability", "Use these exact instructions.")
    bundle = export_skill_bundle(source)
    reference = {"name": "writing/portable", "sha256": bundle["sha256"]}
    original_bytes = (source / "SKILL.md").read_bytes()
    shutil.rmtree(source.parent)  # Source is offline; only exported bytes remain.

    prompt_builder.clear_skills_system_prompt_cache()
    homes = [tmp_path / "alpha", tmp_path / "beta"]
    databases = []
    retained = []
    untouched = []
    try:
        # Prime both process cache entries before any real publication.
        for index, home in enumerate(homes):
            monkeypatch.setenv("HERMES_HOME", str(home))
            _skill(home / "skills" / f"original-{index}", f"original-{index}", f"Home {index} capability", "Keep me.")
            (home / "config.yaml").write_text("model:\n  provider: my-own\n")
            (home / "cron").mkdir()
            (home / "cron" / "jobs.json").write_text('{"jobs":[{"enabled":false}]}')
            untouched.append({name: (home / name).read_bytes() for name in ("config.yaml", "cron/jobs.json")})
            db = SessionDB(home / "state.db")
            databases.append(db)
            db.create_session("retained", "cli")
            agent = _agent(db, "retained")
            _restore_or_build_system_prompt(agent, None, [])
            retained.append(agent._cached_system_prompt)
            assert "Portable installed capability" not in retained[-1]
            assert "portable" not in skills_tool.skills_list()

        for index, (home, db, prefix) in enumerate(zip(homes, databases, retained)):
            monkeypatch.setenv("HERMES_HOME", str(home))
            result = install_skills(home, [reference], [bundle], bundled_dir=shipped)
            assert result["skills"] == [{**reference, "state": "installed", "detail": "new"}]
            assert (home / "skills" / "writing" / "portable" / "SKILL.md").read_bytes() == original_bytes

            # Existing tool discovery is warm, metadata-fenced and immediately useful.
            assert "portable" in skills_tool.skills_list()
            viewed = json.loads(skills_tool.skill_view("portable"))
            assert "Use these exact instructions." in viewed["content"]

            continuation = _agent(db, "retained")
            _restore_or_build_system_prompt(continuation, None, [{"role": "user", "content": "continue"}])
            assert continuation._cached_system_prompt.encode() == prefix.encode()
            assert db.get_session("retained")["system_prompt"] == prefix

            db.create_session("fresh", "cli")
            fresh = _agent(db, "fresh")
            _restore_or_build_system_prompt(fresh, None, [])
            assert "Portable installed capability" in fresh._cached_system_prompt
            assert f"Home {index} capability" in fresh._cached_system_prompt
            assert f"Home {1 - index} capability" not in fresh._cached_system_prompt
            assert db.get_session("fresh")["system_prompt"] == fresh._cached_system_prompt
            assert db.get_session("retained")["system_prompt"] == prefix
            assert {name: (home / name).read_bytes() for name in untouched[index]} == untouched[index]

            # No replayed install or invented backend restart is needed.
            again = install_skills(home, [reference], [bundle], bundled_dir=shipped)
            assert again["skills"] == [{**reference, "state": "installed"}]
    finally:
        for db in databases:
            db.close()
        prompt_builder.clear_skills_system_prompt_cache()
        skills_tool._SKILLS_CACHE.clear()


@pytest.mark.parametrize("change", ["local_edit", "removed", "archived"])
def test_warm_index_keeps_local_edit_and_removal_intent_after_a_real_install(
    monkeypatch, tmp_path, change
):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    shipped = tmp_path / "shipped"
    shipped.mkdir()
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(shipped))
    source = tmp_path / "source" / "portable"
    _skill(source, "portable", "Account capability", "Account instructions.")
    bundle = export_skill_bundle(source)
    reference = {"name": "writing/portable", "sha256": bundle["sha256"]}
    installed = home / "skills" / "writing" / "portable"
    prompt_builder.clear_skills_system_prompt_cache()
    try:
        assert install_skills(home, [reference], [bundle], bundled_dir=shipped)["skills"] == [
            {**reference, "state": "installed", "detail": "new"}
        ]
        assert "Account capability" in prompt_builder.build_skills_system_prompt()
        if change == "local_edit":
            (installed / "SKILL.md").write_text(
                "---\nname: portable\ndescription: Kept local capability\n---\nLocal instructions.\n"
            )
            expected = {**reference, "state": "different", "detail": "local_edit"}
        elif change == "archived":
            archive = home / "skills" / ".archive"
            archive.mkdir()
            installed.rename(archive / "portable-20261001000000")
            # The receipt takes precedence when present; without it, the
            # curator's archived bytes still preserve the removal intent.
            (home / ".atum-agent-content" / "skills.json").unlink()
            expected = {**reference, "state": "suppressed", "detail": "archived"}
        else:
            shutil.rmtree(installed)
            expected = {**reference, "state": "suppressed", "detail": "removed"}

        # Receipt intent, not the process cache, controls whether bytes return.
        assert install_skills(home, [reference], [bundle], bundled_dir=shipped)["skills"] == [expected]
        current = prompt_builder.build_skills_system_prompt()
        assert "Account capability" not in current
        if change == "local_edit":
            assert "Kept local capability" in current
            assert "Local instructions." in json.loads(skills_tool.skill_view("portable"))["content"]
        else:
            assert "portable" not in current
            assert "portable" not in skills_tool.skills_list()
            assert not installed.exists()
    finally:
        prompt_builder.clear_skills_system_prompt_cache()
        skills_tool._SKILLS_CACHE.clear()
