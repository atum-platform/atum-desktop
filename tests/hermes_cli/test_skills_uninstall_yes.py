"""``hermes skills uninstall --yes`` must parse and skip the prompt.

The dashboard/desktop hub REST spawns ``hermes [-p <profile>] skills uninstall
<name> --yes`` from a non-TTY action process (``web_server.uninstall_skill_hub``).
Before the flag existed argparse rejected the call ("unrecognized arguments:
--yes"), so every UI-driven uninstall failed while the CLI prompt path still
worked. Mirrors ``test_skills_install_flags.py`` for the install side.
"""

import sys
from types import SimpleNamespace

def _run_cli(monkeypatch, argv):
    from hermes_cli.main import main

    captured = {}

    def fake_skills_command(args):
        captured["name"] = args.name
        captured["yes"] = args.yes

    monkeypatch.setattr("hermes_cli.skills_hub.skills_command", fake_skills_command)
    monkeypatch.setattr(sys, "argv", ["hermes", "skills", "uninstall", *argv])
    main()
    return captured


def test_cli_skills_uninstall_yes_parses(monkeypatch):
    captured = _run_cli(monkeypatch, ["creative-ideation", "--yes"])

    assert captured["name"] == "creative-ideation"
    assert captured["yes"] is True


def test_cli_skills_uninstall_y_alias(monkeypatch):
    captured = _run_cli(monkeypatch, ["creative-ideation", "-y"])

    assert captured["yes"] is True


def test_cli_skills_uninstall_defaults_to_prompting(monkeypatch):
    captured = _run_cli(monkeypatch, ["creative-ideation"])

    assert captured["yes"] is False


def test_skills_command_passes_skip_confirm_through(monkeypatch):
    """The router forwards --yes as skip_confirm so no input() runs in an
    action subprocess whose stdin is /dev/null."""
    from hermes_cli import skills_hub

    calls = []
    monkeypatch.setattr(
        skills_hub, "do_uninstall", lambda name, **kwargs: calls.append((name, kwargs))
    )

    skills_hub.skills_command(SimpleNamespace(skills_action="uninstall", name="stocks", yes=True))
    skills_hub.skills_command(SimpleNamespace(skills_action="uninstall", name="stocks", yes=False))

    assert calls == [
        ("stocks", {"skip_confirm": True, "archive": False}),
        ("stocks", {"skip_confirm": False, "archive": False}),
    ]


def test_skills_command_archive_refusal_is_nonzero(monkeypatch):
    """An action subprocess needs an exit status because its Rich output is not UI state."""
    from hermes_cli import skills_hub

    monkeypatch.setattr(skills_hub, "do_uninstall", lambda *_args, **_kwargs: False)

    assert skills_hub.skills_command(
        SimpleNamespace(skills_action="uninstall", name="stocks", yes=True)
    ) == 1
