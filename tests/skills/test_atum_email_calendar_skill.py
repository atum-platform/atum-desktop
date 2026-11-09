"""atum-email-calendar is offered only to an agent that holds the ``atum_google`` tool.

The skill used to drive a broker script that needed the old desktop's filesystem broker,
which the Matrix app withholds from every agent, so each call failed. It now teaches the
``atum_google`` tool, and the skill index must hide it wherever that tool is absent (every
agent but Atum's default assistant, and every agent outside Atum).
"""

from __future__ import annotations

import json
import re

import pytest

SKILL = "atum-email-calendar"


@pytest.fixture
def profile_home(tmp_path, monkeypatch):
    """A fresh profile with the shipped skill installed through the real bundled-add path."""
    from agent.prompt_builder import clear_skills_system_prompt_cache
    from tools.skills_sync import add_bundled_skill

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    assert add_bundled_skill(SKILL, home=home)["action"] == "added"
    # An unconditional neighbour, so a hidden skill is told apart from an empty index.
    neighbour = home / "skills" / "note-taking" / "field-journal"
    neighbour.mkdir(parents=True)
    (neighbour / "SKILL.md").write_text("---\nname: field-journal\ndescription: Keep a field journal.\n---\n")
    clear_skills_system_prompt_cache(clear_snapshot=True)
    yield home
    clear_skills_system_prompt_cache(clear_snapshot=True)


def _index(tools: set[str], toolsets: set[str]) -> str:
    from agent.prompt_builder import build_skills_system_prompt

    return build_skills_system_prompt(available_tools=tools, available_toolsets=toolsets)


def test_offered_to_an_agent_with_atum_google(profile_home):
    index = _index({"atum_google", "terminal", "read_file"}, {"atum_google", "terminal", "file"})

    assert SKILL in index
    assert "field-journal" in index


def test_hidden_from_an_agent_without_atum_google(profile_home):
    index = _index({"terminal", "read_file", "web_search"}, {"terminal", "file", "web"})

    assert "field-journal" in index
    assert SKILL not in index


def test_every_call_it_teaches_is_one_the_tool_accepts(profile_home):
    from tools.atum_google_tool import _FIELDS, ATUM_GOOGLE_SCHEMA

    accepted = set(ATUM_GOOGLE_SCHEMA["parameters"]["properties"]["action"]["enum"])
    skill_dir = profile_home / "skills" / "productivity" / SKILL
    text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")

    examples = [json.loads(line) for line in text.splitlines() if line.startswith('{"action"')]
    table = re.findall(r"^\| `([a-z_]+)` \|", text, re.MULTILINE)
    taught = {example["action"] for example in examples} | set(table)

    assert examples and table, "the skill shows the calls it teaches"
    assert taught <= accepted, taught - accepted
    # The tool forwards only each action's own fields and drops the rest without a word,
    # so a misnamed field in an example would reach the broker as a missing one.
    for example in examples:
        extra = set(example) - {"action"} - set(_FIELDS[example["action"]])
        assert not extra, (example["action"], extra)
    # Every helper it points the agent at ships with it.
    for helper in re.findall(r"\b(?:scripts|references|templates)/[\w./-]+", text):
        assert (skill_dir / helper).is_file(), helper


def test_an_agent_without_the_tool_is_told_google_is_not_connected_and_never_sent_to_a_token_file(profile_home):
    """Atum never puts a Google token in a sandbox (the controller's broker keeps it), so there is no token
    file to point at: without the tool the agent says where the owner connects Google and carries on."""
    text = (profile_home / "skills" / "productivity" / SKILL / "SKILL.md").read_text(encoding="utf-8")

    assert "google_token.json" not in text
    assert "Settings › Account › Google" in text
    assert "carry on without it" in text
    assert "do not try another way" not in text


def test_teaches_every_action_the_tool_offers_and_nothing_it_does_not():
    """Desktop and cloud agents get one accurate capability list: the skill names each tool action."""
    from pathlib import Path

    from tools.atum_google_tool import _ACTIONS, _MAILBOX_OPERATIONS

    text = (Path(__file__).resolve().parents[2] / "skills" / "productivity" / SKILL / "SKILL.md").read_text()

    for action in _ACTIONS:
        assert f"`{action}`" in text, action
    for operation in _MAILBOX_OPERATIONS:
        assert operation in text, operation
    # Honest about what a grant without the mailbox scope can do, and what is still missing.
    assert "scope_missing" in text and "owner_turn_required" in text
    # Outgoing mail: the skill teaches exactly the fields the tool forwards for a send, and its limits.
    from tools.atum_google_tool import _FIELDS

    for field in ("cc", "bcc", "reply", "forward", "attachments"):
        assert field in _FIELDS["send_email"] and field in _FIELDS["create_draft"], field
        assert f"`{field}`" in text or f"**`{field}`**" in text, field
    assert "message_too_large" in text and "25 MB" in text
    assert "CC, BCC, reply-all, forward" not in text, "the old 'not available yet' line is gone"
