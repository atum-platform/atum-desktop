"""Real filesystem coverage for the private portable-assistant boundary."""

import json
import time
from pathlib import Path

import pytest
import yaml

from hermes_cli import atum_portability as portability


IDENTITY = "00000000-0000-4000-8000-303617b97302"


def _definition(*, skills=None):
    return {
        "schema_version": 1,
        "soul": "# Focus\nOnly portable instructions.",
        "model_alias": "binh-minh",
        "reasoning": {"enabled": True, "effort": "medium"},
        "skills": skills or [],
    }


def _ticket(ticket_id: str, *, definition=None, expiry=None, apply_existing=False):
    ticket = {
        "account_id": "account-a",
        "expires_at": time.time() + 60 if expiry is None else expiry,
        "assistant": {"identity_id": IDENTITY, "display_name": "Focus", "avatar": "✨"},
        "definition": definition or _definition(),
        "definition_revision": 1,
        "identity_revision": 1,
    }
    if apply_existing is not False:
        ticket["apply_existing"] = apply_existing
    return ticket


def _write_ticket(root: Path, ticket_id: str, data: dict):
    ticket_dir = root / ".atum-portability" / "tickets"
    ticket_dir.mkdir(parents=True, exist_ok=True)
    (ticket_dir / f"{ticket_id}.json").write_text(json.dumps(data), encoding="utf-8")
    return ticket_dir


def _write_skill(root: Path, name="writing/example") -> tuple[Path, dict[str, str]]:
    skill = root / "skills" / name
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Writing\n", encoding="utf-8")
    (skill / "reference.txt").write_text("canonical bytes", encoding="utf-8")
    return skill, {"name": name, "sha256": portability._skill_tree_hash(skill)}


def _source_profile(root: Path) -> Path:
    profile = root / "profiles" / "source"
    profile.mkdir(parents=True)
    (profile / "SOUL.md").write_text("# Focus\nOnly portable instructions.", encoding="utf-8")
    (profile / "config.yaml").write_text(
        "model:\n  provider: atum-managed\n  default: binh-minh\nagent:\n  reasoning_effort: medium\nsecret: should-not-export\n",
        encoding="utf-8",
    )
    (profile / ".env").write_text("API_KEY=do-not-copy\n", encoding="utf-8")
    return profile


def test_export_is_exact_allowlist_and_never_reads_credentials(tmp_path):
    profile = _source_profile(tmp_path)
    skill, expected = _write_skill(profile)
    definition = portability.export_portable_definition(profile)

    assert definition == _definition(skills=[expected])
    assert "API_KEY" not in json.dumps(definition)
    assert "secret" not in json.dumps(definition)
    assert skill.exists()


def test_export_refuses_non_managed_model_instead_of_falling_back(tmp_path):
    profile = _source_profile(tmp_path)
    (profile / "config.yaml").write_text("model:\n  provider: openai\n  default: gpt-5\n", encoding="utf-8")
    with pytest.raises(portability.UnsupportedLocalDefinition, match="managed model"):
        portability.export_portable_definition(profile)


@pytest.mark.parametrize("environment", [{}, {"HERMES_MODEL": "binh-minh"}, {"HERMES_TUI_PROVIDER": "atum-managed"}])
def test_export_uses_managed_launch_default_for_atum_profile_without_model(tmp_path, monkeypatch, environment):
    profile = _source_profile(tmp_path)
    original = "agent:\n  reasoning_effort: medium\n"
    (profile / "config.yaml").write_text(original, encoding="utf-8")
    (profile / "profile.yaml").write_text("managed_by: atum\n", encoding="utf-8")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_DEFAULT", "binh-minh")
    for key, value in environment.items():
        monkeypatch.setenv(key, value)

    assert portability.export_portable_definition(profile) == _definition()
    assert (profile / "config.yaml").read_text() == original


@pytest.mark.parametrize("model_config,managed,environment", [
    ("", False, {"ATUM_MANAGED_MODEL_DEFAULT": "binh-minh"}),
    ("", True, {}),
    ("", True, {"ATUM_MANAGED_MODEL_DEFAULT": "unknown"}),
    ("", True, {"ATUM_MANAGED_MODEL_DEFAULT": "binh-minh", "HERMES_MODEL": "gpt-5"}),
    ("", True, {"ATUM_MANAGED_MODEL_DEFAULT": "binh-minh", "HERMES_INFERENCE_PROVIDER": "openai"}),
    ("model: {}\n", True, {"ATUM_MANAGED_MODEL_DEFAULT": "binh-minh"}),
    ("model: null\n", True, {"ATUM_MANAGED_MODEL_DEFAULT": "binh-minh"}),
    ("model:\n  provider: openai\n  default: gpt-5\n", True, {"ATUM_MANAGED_MODEL_DEFAULT": "binh-minh"}),
])
def test_launch_default_does_not_reinterpret_other_model_assignments(tmp_path, monkeypatch, model_config, managed, environment):
    profile = _source_profile(tmp_path)
    (profile / "config.yaml").write_text(model_config, encoding="utf-8")
    if managed:
        (profile / "profile.yaml").write_text("managed_by: atum\n", encoding="utf-8")
    for key, value in environment.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(portability.UnsupportedLocalDefinition, match="managed model"):
        portability.export_portable_definition(profile)


@pytest.mark.parametrize("matching_identity", [True, False])
def test_legacy_recovery_preserves_default_model_and_exact_source_skills(tmp_path, monkeypatch, matching_identity):
    legacy = tmp_path / "legacy"
    source = _source_profile(legacy)
    (source / "config.yaml").write_text("agent:\n  reasoning_effort: medium\n", encoding="utf-8")
    (source / "profile.yaml").write_text(yaml.safe_dump({
        "managed_by": "atum", "identity_id": IDENTITY if matching_identity else "00000000-0000-4000-8000-00f765af1c54",
    }))
    _, skill = _write_skill(source)
    broken = legacy / "profiles" / "broken-sibling"
    broken.mkdir()
    (broken / "profile.yaml").write_text("[invalid", encoding="utf-8")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_DEFAULT", "binh-minh")
    definition = portability.export_portable_definition(source)
    account = tmp_path / "account"
    ticket_id = "00000000-0000-4000-8000-bd7662a5eeb4"
    directory = _write_ticket(account, ticket_id, {**_ticket(ticket_id, definition=definition), "legacy_home": str(legacy)})
    result = portability.materialize_ticket(directory, ticket_id)
    target = account / "profiles" / f"agent-{IDENTITY}"

    if not matching_identity:
        assert result == {"ok": False, "status": "missing_skills", "missing_skills": [skill]}
        assert not target.exists()
        return

    assert result["status"] == "materialized"
    assert portability.export_portable_definition(target) == definition
    assert (source / ".env").read_text() == "API_KEY=do-not-copy\n"
    assert not (target / ".env").exists()
    assert "model" not in yaml.safe_load((source / "config.yaml").read_text())


def test_skill_search_refuses_symlinked_category_even_when_hash_matches(tmp_path):
    outside = tmp_path / "outside"
    _, skill = _write_skill(outside)
    root = tmp_path / "account"
    (root / "skills").mkdir(parents=True)
    (root / "skills" / "writing").symlink_to(outside / "skills" / "writing", target_is_directory=True)
    assert portability._find_skills(root, [skill]) == ({}, [skill])


@pytest.mark.parametrize("legacy_home", [123, "relative/path", "symlink"])
def test_materialization_rejects_invalid_legacy_home(tmp_path, legacy_home):
    if legacy_home == "symlink":
        link = tmp_path / "link"
        target = tmp_path / "real"
        target.mkdir()
        link.symlink_to(target, target_is_directory=True)
        legacy_home = str(link)
    ticket_id = "00000000-0000-4000-8000-bd7662a5eeb4"
    ticket = {**_ticket(ticket_id), "legacy_home": legacy_home}
    with pytest.raises(portability.TicketError, match="legacy source home"):
        portability._validate_ticket(ticket, time.time())


def test_materialization_does_not_consult_legacy_when_account_has_skills(tmp_path, monkeypatch):
    _, skill = _write_skill(tmp_path)
    def unexpected(*args):
        raise AssertionError("no legacy read needed")
    monkeypatch.setattr(portability, "_legacy_profile", unexpected)
    ticket_id = "00000000-0000-4000-8000-bd7662a5eeb4"
    ticket = {**_ticket(ticket_id, definition=_definition(skills=[skill])), "legacy_home": str(tmp_path / "legacy")}
    directory = _write_ticket(tmp_path, ticket_id, ticket)
    assert portability.materialize_ticket(directory, ticket_id)["status"] == "materialized"


@pytest.mark.parametrize("linked_part", ["profiles", "skills"])
def test_materialization_cannot_source_legacy_skills_through_links(tmp_path, linked_part):
    legacy = tmp_path / "legacy"
    source = _source_profile(legacy)
    (source / "profile.yaml").write_text(yaml.safe_dump({"managed_by": "atum", "identity_id": IDENTITY}))
    _, skill = _write_skill(source)
    linked = legacy / "profiles" if linked_part == "profiles" else source / "skills"
    outside = tmp_path / "outside"
    linked.rename(outside)
    linked.symlink_to(outside, target_is_directory=True)
    ticket_id = "00000000-0000-4000-8000-bd7662a5eeb4"
    account = tmp_path / "account"
    ticket = {**_ticket(ticket_id, definition=_definition(skills=[skill])), "legacy_home": str(legacy)}
    directory = _write_ticket(account, ticket_id, ticket)
    assert portability.materialize_ticket(directory, ticket_id)["status"] == "missing_skills"


@pytest.mark.parametrize("reasoning", [
    {"enabled": True, "effort": "medium"},
    {"enabled": False, "effort": None},
])
def test_wire_reasoning_allows_only_the_persistable_local_shapes(reasoning):
    definition = _definition()
    definition["reasoning"] = reasoning
    assert portability._validate_definition(definition)["reasoning"] == reasoning


@pytest.mark.parametrize("reasoning", [
    {"enabled": True, "effort": None},
    {"enabled": True, "effort": "none"},
    {"enabled": False, "effort": "max"},
])
def test_wire_reasoning_rejects_shapes_that_cannot_round_trip_to_hermes_config(reasoning):
    definition = _definition()
    definition["reasoning"] = reasoning
    with pytest.raises(portability.TicketError, match="reasoning"):
        portability._validate_definition(definition)


@pytest.mark.parametrize("name", ["writing//example", "writing/./example", "writing/../example", "writing/\x01example"])
def test_wire_skill_names_are_validated_before_path_normalization(name):
    definition = _definition(skills=[{"name": name, "sha256": "a" * 64}])
    with pytest.raises(portability.PortabilityError):
        portability._validate_definition(definition)


def test_materialization_is_deterministic_atomic_and_idempotent_across_new_tickets(tmp_path):
    _, skill = _write_skill(tmp_path)
    first_id = "00000000-0000-4000-8000-bd7662a5eeb4"
    tickets = _write_ticket(tmp_path, first_id, _ticket(first_id, definition=_definition(skills=[skill])))

    first = portability.materialize_ticket(tickets, first_id)
    target = tmp_path / "profiles" / f"agent-{IDENTITY}"
    assert first == {
        "ok": True,
        "status": "materialized",
        "profile": {"name": target.name, "identity_id": IDENTITY, "display_name": "Focus", "avatar": "✨", "managed_by": "atum"},
    }
    assert (target / "SOUL.md").read_text(encoding="utf-8") == _definition()["soul"]
    assert not (target / ".env").exists()
    assert yaml.safe_load((target / "config.yaml").read_text()) == {
        "model": {"provider": "atum-managed", "default": "binh-minh"},
        "agent": {"reasoning_effort": "medium"},
    }
    assert portability._skill_tree_hash(target / "skills" / "writing" / "example") == skill["sha256"]

    second_id = "00000000-0000-4000-8000-b454f82c5857"
    _write_ticket(tmp_path, second_id, _ticket(second_id, definition=_definition(skills=[skill])))
    assert portability.materialize_ticket(tickets, second_id)["status"] == "reused"
    with pytest.raises(portability.TicketError, match="consumed"):
        portability.materialize_ticket(tickets, first_id)


def test_materialization_reports_exact_missing_skill_and_consumes_ticket(tmp_path):
    required = {"name": "writing/example", "sha256": "a" * 64}
    ticket_id = "00000000-0000-4000-8000-f6222a1106ee"
    tickets = _write_ticket(tmp_path, ticket_id, _ticket(ticket_id, definition=_definition(skills=[required])))

    assert portability.materialize_ticket(tickets, ticket_id) == {
        "ok": False,
        "status": "missing_skills",
        "missing_skills": [required],
    }
    assert not (tmp_path / "profiles" / f"agent-{IDENTITY}").exists()
    with pytest.raises(portability.TicketError, match="consumed"):
        portability.materialize_ticket(tickets, ticket_id)


def test_expired_ticket_and_unrelated_deterministic_profile_fail_closed(tmp_path):
    expired_id = "00000000-0000-4000-8000-f1d11edf5c5c"
    tickets = _write_ticket(tmp_path, expired_id, _ticket(expired_id, expiry=time.time() - 1))
    with pytest.raises(portability.TicketError, match="expired"):
        portability.materialize_ticket(tickets, expired_id)

    conflict_id = "00000000-0000-4000-8000-fbfe405ca65f"
    _write_ticket(tmp_path, conflict_id, _ticket(conflict_id))
    target = tmp_path / "profiles" / f"agent-{IDENTITY}"
    target.mkdir(parents=True)
    (target / "profile.yaml").write_text("identity_id: 00000000-0000-4000-8000-00f765af1c54\nmanaged_by: atum\n", encoding="utf-8")
    with pytest.raises(portability.ProfileConflict, match="another local agent"):
        portability.materialize_ticket(tickets, conflict_id)


def test_http_seams_use_the_account_aligned_backend_home(tmp_path, monkeypatch):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette unavailable")
    account_home = tmp_path / "account" / "hermes"
    monkeypatch.setenv("HERMES_HOME", str(account_home))
    from hermes_cli import profiles
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    profile = profiles.create_profile("portable-source", no_alias=True, no_skills=True)
    (profile / "SOUL.md").write_text(_definition()["soul"], encoding="utf-8")
    (profile / "config.yaml").write_text(
        "model:\n  provider: atum-managed\n  default: binh-minh\nagent:\n  reasoning_effort: medium\n",
        encoding="utf-8",
    )
    marker = tmp_path / "account-marker"
    ticket_root = account_home / ".atum-portability" / "tickets"
    ticket_root.mkdir(parents=True)
    marker.write_text(str(ticket_root), encoding="utf-8")
    monkeypatch.setenv("ATUM_PORTABILITY_TICKETS_ROOT_MARKER", str(marker))
    client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})

    exported = client.get("/api/profiles/portable-source/portable-definition")
    assert exported.status_code == 200, exported.text
    assert exported.json()["definition"] == _definition()
    assert exported.json()["assistant"]["identity_id"]

    ticket_id = "00000000-0000-4000-8000-a9703d75e616"
    (ticket_root / f"{ticket_id}.json").write_text(json.dumps(_ticket(ticket_id)), encoding="utf-8")
    installed = client.post("/api/profiles/materialize", json={"ticket_id": ticket_id})
    assert installed.status_code == 200, installed.text
    assert installed.json()["status"] == "materialized"
    target = account_home / "profiles" / f"agent-{IDENTITY}"
    assert target.is_dir()
    assert target.name in {profile.name for profile in profiles.list_profiles()}

    # This is the prompt builder used by a real profile-pinned chat child;
    # loading the target home must read the source definition's SOUL, not the
    # global/default profile's identity.
    monkeypatch.setenv("HERMES_HOME", str(target))
    from agent.prompt_builder import load_soul_md
    assert load_soul_md() == _definition()["soul"]


def test_account_marker_rejects_a_different_backend_home(tmp_path, monkeypatch):
    marker = tmp_path / "marker"
    ticket_root = tmp_path / "account-a" / "hermes" / ".atum-portability" / "tickets"
    ticket_root.mkdir(parents=True)
    marker.write_text(str(ticket_root), encoding="utf-8")
    monkeypatch.setenv("ATUM_PORTABILITY_TICKETS_ROOT_MARKER", str(marker))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "account-b" / "hermes"))
    with pytest.raises(portability.TicketError, match="does not match"):
        portability.ticket_directory_from_environment()


def test_legacy_export_reads_only_the_owned_managed_identity(tmp_path):
    legacy = tmp_path / 'legacy'
    source = _source_profile(legacy)
    (source / 'profile.yaml').write_text(yaml.safe_dump({'identity_id': IDENTITY, 'managed_by': 'atum', 'display_name': 'Offline name', 'avatar': '✨'}))
    ticket_id = '00000000-0000-4000-8000-0bb5de138389'
    ticket = {'operation': 'export_legacy', 'account_id': 'account-a', 'expires_at': time.time()+60,
              'assistant': {'identity_id': IDENTITY, 'display_name': 'Cloud name', 'avatar': ''}, 'legacy_home': str(legacy)}
    directory = _write_ticket(tmp_path / 'account', ticket_id, ticket)
    result = portability.export_legacy_ticket(directory, ticket_id)
    assert result['definition'] == _definition()
    assert result['assistant']['display_name'] == 'Offline name'
    assert (source / '.env').read_text() == 'API_KEY=do-not-copy\n'
    with pytest.raises(portability.TicketError):
        portability.export_legacy_ticket(directory, ticket_id)
    ticket['assistant']['identity_id'] = '00000000-0000-4000-8000-6cc9b1298c8f'
    directory = _write_ticket(tmp_path / 'other-account', ticket_id, ticket)
    assert portability.export_legacy_ticket(directory, ticket_id) == {'ok': False, 'status': 'legacy_source_absent'}


def test_setup_reuses_identity_even_when_local_profile_has_another_slug(tmp_path):
    source = _source_profile(tmp_path)
    (source / 'profile.yaml').write_text(yaml.safe_dump({'identity_id': IDENTITY, 'managed_by': 'atum'}))
    ticket_id = '00000000-0000-4000-8000-0bb5de138389'
    directory = _write_ticket(tmp_path, ticket_id, _ticket(ticket_id))
    result = portability.materialize_ticket(directory, ticket_id)
    assert result['status'] == 'reused'
    assert result['profile']['name'] == 'source'
    assert not (tmp_path / 'profiles' / f'agent-{IDENTITY}').exists()


def _existing_managed_profile(root: Path) -> Path:
    profile = root / "profiles" / f"agent-{IDENTITY}"
    profile.mkdir(parents=True)
    (profile / "SOUL.md").write_text("# Local\nKeep this recoverable.", encoding="utf-8")
    (profile / "config.yaml").write_text(
        "model:\n  provider: atum-managed\n  default: binh-minh\nagent:\n  reasoning_effort: low\ncustom:\n  preserve: yes\n",
        encoding="utf-8",
    )
    (profile / "profile.yaml").write_text(yaml.safe_dump({
        "identity_id": IDENTITY, "managed_by": "atum", "display_name": "Local", "avatar": "🧭",
        "lifecycle_revision": 9, "custom_meta": "preserve",
    }, sort_keys=False), encoding="utf-8")
    (profile / ".env").write_text("API_KEY=local-secret\n", encoding="utf-8")
    (profile / "sessions").mkdir()
    (profile / "sessions" / "history.jsonl").write_text('{"local":true}\n', encoding="utf-8")
    (profile / "memories").mkdir()
    (profile / "memories" / "MEMORY.md").write_text("local memory\n", encoding="utf-8")
    old_skill = profile / "skills" / "local" / "old"
    old_skill.mkdir(parents=True)
    (old_skill / "SKILL.md").write_text("# Local skill\n", encoding="utf-8")
    return profile


def test_apply_existing_updates_only_allowlist_and_retains_account_recovery(tmp_path):
    profile = _existing_managed_profile(tmp_path)
    _, cloud_skill = _write_skill(tmp_path, "cloud/writing")
    definition = _definition(skills=[cloud_skill])
    definition.update({
        "soul": "# Cloud\nThis definition came from Atum.",
        "model_alias": "nguyet-thuc",
        "reasoning": {"enabled": False, "effort": None},
    })
    ticket_id = "00000000-0000-4000-8000-6cc9b1298c8f"
    tickets = _write_ticket(tmp_path, ticket_id, _ticket(ticket_id, definition=definition, apply_existing=True))

    result = portability.materialize_ticket(tickets, ticket_id)
    assert result["status"] == "applied"
    assert portability.export_portable_definition(profile) == definition
    config = yaml.safe_load((profile / "config.yaml").read_text())
    assert config["custom"] == {"preserve": True}
    assert config["agent"]["reasoning_effort"] is False
    metadata = yaml.safe_load((profile / "profile.yaml").read_text())
    assert metadata["identity_id"] == IDENTITY
    assert metadata["display_name"] == "Focus"
    assert metadata["avatar"] == "✨"
    assert metadata["custom_meta"] == "preserve"
    assert (profile / ".env").read_text() == "API_KEY=local-secret\n"
    assert (profile / "sessions" / "history.jsonl").read_text() == '{"local":true}\n'
    assert (profile / "memories" / "MEMORY.md").read_text() == "local memory\n"
    assert not (profile / "skills" / "local" / "old").exists()
    assert portability._skill_tree_hash(profile / "skills" / "cloud" / "writing") == cloud_skill["sha256"]
    backups = list((tmp_path / ".atum-portability" / "recovery").iterdir())
    assert len(backups) == 1
    backup = backups[0]
    assert (backup / "SOUL.md").read_text() == "# Local\nKeep this recoverable."
    assert yaml.safe_load((backup / "config.yaml").read_text())["custom"] == {"preserve": True}
    assert yaml.safe_load((backup / "profile.yaml").read_text())["identity_id"] == IDENTITY
    assert (backup / "skills" / "local" / "old" / "SKILL.md").exists()
    assert (tmp_path / ".atum-portability").stat().st_mode & 0o777 == 0o700

    repeat_id = "00000000-0000-4000-8000-2dab195ed4f7"
    _write_ticket(tmp_path, repeat_id, _ticket(repeat_id, definition=definition, apply_existing=True))
    assert portability.materialize_ticket(tickets, repeat_id)["status"] == "applied"
    assert len(list((tmp_path / ".atum-portability" / "recovery").iterdir())) == 1


def test_apply_existing_missing_skills_and_write_failure_leave_original_recoverable(tmp_path, monkeypatch):
    profile = _existing_managed_profile(tmp_path)
    original = {name: (profile / name).read_bytes() for name in ("SOUL.md", "config.yaml", "profile.yaml")}
    missing = {"name": "missing/skill", "sha256": "a" * 64}
    missing_id = "00000000-0000-4000-8000-dfe0e0b1cc74"
    tickets = _write_ticket(tmp_path, missing_id, _ticket(missing_id, definition=_definition(skills=[missing]), apply_existing=True))
    assert portability.materialize_ticket(tickets, missing_id) == {
        "ok": False, "status": "missing_skills", "missing_skills": [missing],
    }
    assert {name: (profile / name).read_bytes() for name in original} == original
    assert (profile / "skills" / "local" / "old" / "SKILL.md").exists()

    _, cloud_skill = _write_skill(tmp_path, "cloud/write-failure")
    definition = _definition(skills=[cloud_skill])
    definition["soul"] = "# New cloud soul"
    failed_id = "00000000-0000-4000-8000-093af09c4d2f"
    _write_ticket(tmp_path, failed_id, _ticket(failed_id, definition=definition, apply_existing=True))
    real_replace = portability.os.replace
    failed_once = False

    def fail_config_replace(source, destination):
        nonlocal failed_once
        if Path(destination) == profile / "config.yaml" and not failed_once:
            failed_once = True
            raise OSError("fixture write failure")
        return real_replace(source, destination)

    monkeypatch.setattr(portability.os, "replace", fail_config_replace)
    with pytest.raises(portability.PortabilityError, match="rolled back"):
        portability.materialize_ticket(tickets, failed_id)
    assert {name: (profile / name).read_bytes() for name in original} == original
    assert (profile / "skills" / "local" / "old" / "SKILL.md").exists()
    assert (profile / ".env").read_text() == "API_KEY=local-secret\n"


def test_apply_existing_rejects_non_boolean_ticket_and_profile_symlinks(tmp_path):
    ticket_id = "00000000-0000-4000-8000-f47e946ef38c"
    tickets = _write_ticket(tmp_path, ticket_id, _ticket(ticket_id, apply_existing="true"))
    with pytest.raises(portability.TicketError, match="boolean"):
        portability.materialize_ticket(tickets, ticket_id)

    profile = _existing_managed_profile(tmp_path)
    (profile / "SOUL.md").unlink()
    (profile / "SOUL.md").symlink_to(tmp_path / "outside-soul")
    apply_id = "00000000-0000-4000-8000-62aab94360f9"
    _write_ticket(tmp_path, apply_id, _ticket(apply_id, apply_existing=True))
    with pytest.raises(portability.ProfileConflict, match="symlink"):
        portability.materialize_ticket(tickets, apply_id)


def test_unrepresentable_reasoning_ticket_never_creates_or_updates_a_profile(tmp_path):
    ticket_id = "00000000-0000-4000-8000-57bf3aa87cab"
    definition = _definition()
    definition["reasoning"] = {"enabled": True, "effort": None}
    tickets = _write_ticket(tmp_path, ticket_id, _ticket(ticket_id, definition=definition))
    with pytest.raises(portability.TicketError, match="reasoning"):
        portability.materialize_ticket(tickets, ticket_id)
    assert not (tmp_path / "profiles" / f"agent-{IDENTITY}").exists()

    profile = _existing_managed_profile(tmp_path)
    before = (profile / "SOUL.md").read_bytes()
    apply_id = "00000000-0000-4000-8000-0e59c8cd72f5"
    _write_ticket(tmp_path, apply_id, _ticket(apply_id, definition=definition, apply_existing=True))
    with pytest.raises(portability.TicketError, match="reasoning"):
        portability.materialize_ticket(tickets, apply_id)
    assert (profile / "SOUL.md").read_bytes() == before


def test_content_cache_materializes_skill_on_second_computer(tmp_path):
    from hermes_cli.atum_skill_bundles import export_skill_bundle, install_skill_bundle
    source = tmp_path / 'computer-a'
    source.mkdir()
    skill, reference = _write_skill(source)
    target = tmp_path / 'computer-b'
    cache = target / '.atum-portability' / 'skill-cache'
    install_skill_bundle(cache, export_skill_bundle(skill))
    ticket_id = 'b' * 8 + '-bbbb-4bbb-8bbb-' + 'b' * 12
    definition = _definition(skills=[reference])
    tickets = _write_ticket(target, ticket_id, _ticket(ticket_id, definition=definition))
    result = portability.materialize_ticket(tickets, ticket_id)
    profile = target / 'profiles' / result['profile']['name']
    assert portability.export_portable_definition(profile) == definition
    assert (profile / 'skills' / reference['name'] / 'reference.txt').read_bytes() == b'canonical bytes'


def test_background_apply_rejects_stale_local_definition(tmp_path):
    ticket_id = '00000000-0000-4000-8000-00f765af1c54'
    tickets = _write_ticket(tmp_path, ticket_id, _ticket(ticket_id))
    result = portability.materialize_ticket(tickets, ticket_id)
    profile = tmp_path / 'profiles' / result['profile']['name']
    expected = portability.export_portable_definition(profile)
    (profile / 'SOUL.md').write_text('A concurrent local edit')
    new_id = '00000000-0000-4000-8000-50d86b120e98'
    ticket = _ticket(new_id, definition={**expected, 'soul': 'Remote edit'}, apply_existing=True)
    ticket['expected_local_definition'] = expected
    _write_ticket(tmp_path, new_id, ticket)
    with pytest.raises(portability.ProfileConflict, match='changed during'):
        portability.materialize_ticket(tickets, new_id)
    assert (profile / 'SOUL.md').read_text() == 'A concurrent local edit'


def test_default_profile_apply_reuses_account_root(tmp_path):
    profile = _source_profile(tmp_path)
    for name in ['SOUL.md', 'config.yaml']:
        (tmp_path / name).write_bytes((profile / name).read_bytes())
    (tmp_path / 'profile.yaml').write_text(yaml.safe_dump({'identity_id': IDENTITY, 'managed_by': 'atum', 'display_name': 'Focus', 'avatar': '✨'}))
    expected = portability.export_portable_definition(tmp_path)
    desired = {**expected, 'soul': 'The same default on every computer'}
    ticket_id = '00000000-0000-4000-8000-00f765af1c54'
    ticket = _ticket(ticket_id, definition=desired, apply_existing=True)
    ticket['expected_local_definition'] = expected
    tickets = _write_ticket(tmp_path, ticket_id, ticket)
    result = portability.materialize_ticket(tickets, ticket_id)
    assert result['profile']['name'] == 'default'
    assert portability.export_portable_definition(tmp_path) == desired
    assert not (tmp_path / 'profiles' / f'agent-{IDENTITY}').exists()


@pytest.mark.parametrize('name', ['C:escape', 'folder/.. /outside', 'AUX.txt', 'path/trailing.'])
def test_skill_reference_names_cannot_change_windows_destination(name):
    with pytest.raises(portability.PortabilityError):
        portability._validate_skill_name(name)


def test_explicit_default_ticket_never_creates_named_profile_before_adoption(tmp_path):
    ticket_id = '00000000-0000-4000-8000-00f765af1c54'
    ticket = _ticket(ticket_id)
    ticket['assistant']['is_default'] = True
    tickets = _write_ticket(tmp_path, ticket_id, ticket)
    with pytest.raises(portability.ProfileConflict, match='adoption'):
        portability.materialize_ticket(tickets, ticket_id)
    assert not (tmp_path / 'profiles').exists()


def test_default_initial_restore_replaces_the_unmodified_hermes_soul_seed(tmp_path):
    from hermes_cli.default_soul import DEFAULT_SOUL_MD

    (tmp_path / 'profile.yaml').write_text(yaml.safe_dump({'identity_id': IDENTITY, 'managed_by': 'atum'}))
    (tmp_path / 'config.yaml').write_text('model:\n  provider: atum-managed\n  default: binh-minh\n')
    (tmp_path / 'SOUL.md').write_text(DEFAULT_SOUL_MD, encoding='utf-8')
    ticket_id = '00000000-0000-4000-8000-00f765af1c54'
    ticket = _ticket(ticket_id)
    ticket['assistant']['is_default'] = True
    tickets = _write_ticket(tmp_path, ticket_id, ticket)

    result = portability.materialize_ticket(tickets, ticket_id)

    assert result['status'] == 'applied'
    assert result['profile']['name'] == 'default'
    assert portability.export_portable_definition(tmp_path) == _definition()


def test_default_initial_restore_reuses_an_already_matching_definition(tmp_path):
    (tmp_path / 'profile.yaml').write_text(yaml.safe_dump({'identity_id': IDENTITY, 'managed_by': 'atum'}))
    (tmp_path / 'SOUL.md').write_text(_definition()['soul'], encoding='utf-8')
    (tmp_path / 'config.yaml').write_text(
        'model:\n  provider: atum-managed\n  default: binh-minh\nagent:\n  reasoning_effort: medium\n',
        encoding='utf-8',
    )
    ticket_id = '00000000-0000-4000-8000-00f765af1c54'
    ticket = _ticket(ticket_id)
    ticket['assistant']['is_default'] = True
    tickets = _write_ticket(tmp_path, ticket_id, ticket)

    result = portability.materialize_ticket(tickets, ticket_id)

    assert result['status'] == 'reused'
    assert result['profile']['name'] == 'default'
    assert portability.export_portable_definition(tmp_path) == _definition()


def test_named_materialization_survives_corrupt_root(tmp_path):
    (tmp_path / 'profile.yaml').write_text('[invalid yaml')
    ticket_id = '00000000-0000-4000-8000-00f765af1c54'
    tickets = _write_ticket(tmp_path, ticket_id, _ticket(ticket_id))
    assert portability.materialize_ticket(tickets, ticket_id)['ok']


@pytest.mark.parametrize('changed', ['soul', 'skill', 'model'])
def test_default_initial_restore_refuses_existing_local_content(tmp_path, changed):
    (tmp_path / 'profile.yaml').write_text(yaml.safe_dump({'identity_id': IDENTITY, 'managed_by': 'atum'}))
    (tmp_path / 'config.yaml').write_text('model:\n  provider: atum-managed\n  default: binh-minh\n')
    if changed == 'soul':
        (tmp_path / 'SOUL.md').write_text('My existing persona')
    elif changed == 'skill':
        (tmp_path / 'skills').mkdir()
        (tmp_path / 'skills' / 'keep.txt').write_text('Keep me')
    else:
        (tmp_path / 'config.yaml').write_text('model:\n  provider: local\n  default: local-model\n')
    before = {str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    with pytest.raises(portability.ProfileConflict, match='before initial'):
        portability._apply_existing_profile(tmp_path, tmp_path, {'identity_id': IDENTITY, 'display_name': 'Default', 'avatar': ''}, _definition(), require_empty_default=True)
    assert all((tmp_path / name).read_bytes() == content for name, content in before.items())
