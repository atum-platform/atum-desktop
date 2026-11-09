"""Filesystem contracts for owner-authorized Atum content tickets."""

from __future__ import annotations

import json
import sys
import time
import types
from pathlib import Path

import pytest
from PIL import Image
import yaml

from hermes_cli import atum_portability as portability
from hermes_cli.atum_content_sync import content_ticket
from hermes_cli.atum_skill_bundles import export_skill_bundle


def _pet(profile: Path, slug: str = "moss") -> Path:
    directory = profile / "pets" / slug
    directory.mkdir(parents=True)
    Image.new("RGBA", (192, 208), (30, 120, 70, 255)).save(directory / "spritesheet.webp", format="WEBP")
    (directory / "pet.json").write_text(
        json.dumps({"id": slug, "displayName": "Moss", "description": "local", "spritesheetPath": "spritesheet.webp", "createdBy": "generator"}),
        encoding="utf-8",
    )
    return directory


def _enable_pet(profile: Path, slug: str = "moss") -> None:
    config = yaml.safe_load((profile / "config.yaml").read_text(encoding="utf-8"))
    config.setdefault("display", {})["pet"] = {"enabled": True, "slug": slug, "scale": 0.33}
    (profile / "config.yaml").write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")


IDENTITY = "00000000-0000-4000-8000-303617b97302"


def _profile(root: Path, *, nested: bool = True) -> Path:
    profile = root / "profiles" / "writing" if nested else root
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "profile.yaml").write_text(
        f"identity_id: {IDENTITY}\nmanaged_by: atum\ndisplay_name: Writing\navatar: ✍️\n",
        encoding="utf-8",
    )
    (profile / "SOUL.md").write_text("# Writing\n", encoding="utf-8")
    (profile / "config.yaml").write_text(
        "model:\n  provider: atum-managed\n  default: binh-minh\nagent:\n  reasoning_effort: medium\n",
        encoding="utf-8",
    )
    skill = profile / "skills" / "writing" / "example"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Example\n", encoding="utf-8")
    (skill / "ref.bin").write_bytes(b"\x00bundle")
    return profile


def _write_ticket(root: Path, ticket_id: str, body: dict) -> Path:
    tickets = root / ".atum-portability" / "tickets"
    tickets.mkdir(parents=True, exist_ok=True)
    (tickets / f"{ticket_id}.json").write_text(json.dumps(body), encoding="utf-8")
    return tickets


def _ticket(operation: str, **extra):
    return {
        "operation": operation,
        "account_id": "owner-a",
        "expires_at": time.time() + 60,
        "identity_id": IDENTITY,
        **extra,
    }


def test_inspect_uses_exact_managed_profile_and_consumes_ticket(tmp_path):
    profile = _profile(tmp_path)
    ticket_id = "00000000-0000-4000-8000-bd7662a5eeb4"
    tickets = _write_ticket(tmp_path, ticket_id, _ticket("inspect"))

    result = content_ticket(tickets, ticket_id)

    assert result["ok"] is True
    assert result["profile"] == {
        "name": profile.name,
        "identity_id": IDENTITY,
        "display_name": "Writing",
        "avatar": "✍️",
    }
    assert result["definition"]["skills"] == [{
        "name": "writing/example",
        "sha256": portability._skill_tree_hash(profile / "skills" / "writing" / "example"),
    }]
    with pytest.raises(portability.TicketError, match="consumed"):
        content_ticket(tickets, ticket_id)


def test_inspect_supports_only_exact_managed_default_profile(tmp_path):
    _profile(tmp_path, nested=False)
    ticket_id = "00000000-0000-4000-8000-b454f82c5857"

    result = content_ticket(_write_ticket(tmp_path, ticket_id, _ticket("inspect")), ticket_id)

    assert result["ok"] is True
    assert result["profile"]["name"] == tmp_path.name


def test_export_skill_requires_current_definition_reference(tmp_path):
    profile = _profile(tmp_path)
    skill = profile / "skills" / "writing" / "example"
    reference = {"name": "writing/example", "sha256": portability._skill_tree_hash(skill)}
    ticket_id = "00000000-0000-4000-8000-f6222a1106ee"

    result = content_ticket(_write_ticket(tmp_path, ticket_id, _ticket("export_skill", skill=reference)), ticket_id)

    assert result == {"ok": True, "bundle": export_skill_bundle(skill, reference["sha256"])}

    bad_id = "00000000-0000-4000-8000-f1d11edf5c5c"
    with pytest.raises(portability.PortabilityError, match="not part"):
        content_ticket(
            _write_ticket(tmp_path, bad_id, _ticket("export_skill", skill={"name": "other", "sha256": "a" * 64})),
            bad_id,
        )


def test_install_skill_is_recovery_safe_without_a_local_profile(tmp_path):
    source = _profile(tmp_path / "source") / "skills" / "writing" / "example"
    bundle = export_skill_bundle(source)
    account = tmp_path / "account"
    ticket_id = "00000000-0000-4000-8000-fbfe405ca65f"

    result = content_ticket(_write_ticket(account, ticket_id, _ticket("install_skill", bundle=bundle)), ticket_id)

    assert result == {"ok": True, "sha256": bundle["sha256"]}
    installed = account / ".atum-portability" / "skill-cache" / bundle["sha256"] / "skill"
    assert portability._skill_tree_hash(installed) == bundle["sha256"]
    assert not (account / "profiles").exists()


def test_read_and_apply_memory_use_only_the_ticket_identity_profile(tmp_path):
    profile = _profile(tmp_path)
    ticket_id = "00000000-0000-4000-8000-a9703d75e616"
    assert content_ticket(_write_ticket(tmp_path, ticket_id, _ticket("read_memory")), ticket_id) == {
        "ok": True,
        "snapshot": {"memory": [], "user": []},
    }

    apply_id = "00000000-0000-4000-8000-f2da1f9533d4"
    applied = content_ticket(
        _write_ticket(
            tmp_path,
            apply_id,
            _ticket(
                "apply_memory",
                expected_snapshot={"memory": [], "user": []},
                snapshot={"memory": ["portable fact"], "user": ["concise"]},
            ),
        ),
        apply_id,
    )
    assert applied["ok"] is True
    assert applied["result"]["success"] is True
    assert applied["result"]["snapshot"] == {"memory": ["portable fact"], "user": ["concise"]}
    assert (profile / "memories" / "MEMORY.md").exists()


@pytest.mark.parametrize("mutate", [
    lambda ticket: ticket.update({"profile_path": "/tmp/arbitrary"}),
    lambda ticket: ticket.update({"identity_id": "not-a-uuid"}),
    lambda ticket: ticket.update({"expires_at": time.time() + 301}),
])
def test_ticket_rejects_arbitrary_paths_identity_and_expiry(tmp_path, mutate):
    _profile(tmp_path)
    ticket_id = "00000000-0000-4000-8000-c8f367a876b2"
    ticket = _ticket("inspect")
    mutate(ticket)
    tickets = _write_ticket(tmp_path, ticket_id, ticket)

    with pytest.raises(portability.TicketError):
        content_ticket(tickets, ticket_id)
    assert (tickets / f"{ticket_id}.claimed").exists()


def test_profile_and_ticket_symlinks_are_refused(tmp_path):
    _profile(tmp_path)
    ticket_id = "00000000-0000-4000-8000-e8d95748107a"
    tickets = _write_ticket(tmp_path, ticket_id, _ticket("inspect"))
    outside = tmp_path / "outside"
    outside.mkdir()
    tickets.rename(outside / "tickets")
    tickets.symlink_to(outside / "tickets", target_is_directory=True)

    with pytest.raises(portability.TicketError, match="ticket root"):
        content_ticket(tickets, ticket_id)


def test_identity_mismatch_and_profile_symlink_cannot_select_another_profile(tmp_path):
    profile = _profile(tmp_path)
    (profile / "profile.yaml").write_text(
        "identity_id: 00000000-0000-4000-8000-00f765af1c54\nmanaged_by: atum\n",
        encoding="utf-8",
    )
    ticket_id = "00000000-0000-4000-8000-feaccd25ce86"
    tickets = _write_ticket(tmp_path, ticket_id, _ticket("inspect"))
    with pytest.raises(portability.PortabilityError, match="unavailable"):
        content_ticket(tickets, ticket_id)

    profile = _profile(tmp_path / "linked")
    linked_id = "00000000-0000-4000-8000-0d23e78bd190"
    linked_tickets = _write_ticket(tmp_path / "linked", linked_id, _ticket("inspect"))
    outside = tmp_path / "outside-profile"
    profile.rename(outside)
    profile.symlink_to(outside, target_is_directory=True)
    with pytest.raises(portability.PortabilityError, match="unavailable"):
        content_ticket(linked_tickets, linked_id)


def test_default_content_waits_for_adoption_then_marks_managed(tmp_path):
    import yaml
    _profile(tmp_path, nested=False)
    (tmp_path / "profile.yaml").write_text("managed_by: ''\n")
    first = "00000000-0000-4000-8000-bd7662a5eeb4"
    with pytest.raises(portability.ProfileConflict, match="adoption"):
        content_ticket(_write_ticket(tmp_path, first, _ticket("inspect", is_default=True)), first)
    (tmp_path / "profile.yaml").write_text(f"identity_id: {IDENTITY}\nmanaged_by: ''\n")
    second = "00000000-0000-4000-8000-b454f82c5857"
    result = content_ticket(_write_ticket(tmp_path, second, _ticket("inspect", is_default=True)), second)
    assert result["ok"]
    assert yaml.safe_load((tmp_path / "profile.yaml").read_text())["managed_by"] == "atum"
    assert not (tmp_path / "profiles" / f"agent-{IDENTITY}").exists()


def test_named_content_survives_corrupt_root_metadata(tmp_path):
    _profile(tmp_path)
    (tmp_path / "profile.yaml").write_text("[invalid yaml")
    ticket_id = "00000000-0000-4000-8000-bd7662a5eeb4"
    assert content_ticket(_write_ticket(tmp_path, ticket_id, _ticket("inspect")), ticket_id)["ok"]


def test_read_pets_mints_one_owner_fenced_personal_identity_and_export_is_stable(tmp_path):
    profile = _profile(tmp_path)
    pet = _pet(profile)
    first_id = "00000000-0000-4000-8000-dfe0e0b1cc74"
    first = content_ticket(_write_ticket(tmp_path, first_id, _ticket("read_pets")), first_id)
    assert first["ok"] and first["explicit"] is False
    record = first["pets"] == [] and None or first["pets"][0]
    assert record["ref"]["kind"] == "personal"
    sidecar = json.loads((pet / ".atum-pet.json").read_text())
    assert (pet / ".atum-pet.json").stat().st_mode & 0o777 == 0o600

    export_id = "00000000-0000-4000-8000-093af09c4d2f"
    result = content_ticket(_write_ticket(tmp_path, export_id, _ticket("export_pet", pet={"slug": "moss", "content_sha256": record["content_sha256"]})), export_id)
    assert result["pet"]["ref"] == record["ref"]
    assert result["bundle"]["sha256"] == record["content_sha256"]
    assert json.loads((pet / ".atum-pet.json").read_text())["ref"] == sidecar["ref"]


def test_pet_tickets_fence_foreign_sidecars_and_compare_binding(tmp_path):
    profile = _profile(tmp_path)
    pet = _pet(profile)
    read_id = "00000000-0000-4000-8000-f47e946ef38c"
    record = content_ticket(_write_ticket(tmp_path, read_id, _ticket("read_pets")), read_id)["pets"][0]
    sidecar = json.loads((pet / ".atum-pet.json").read_text())
    sidecar["account_key"] = "b" * 64
    (pet / ".atum-pet.json").write_text(json.dumps(sidecar), encoding="utf-8")
    foreign_id = "00000000-0000-4000-8000-62aab94360f9"
    with pytest.raises(portability.PortabilityError, match="different account"):
        content_ticket(_write_ticket(tmp_path, foreign_id, _ticket("claim_pet", pet={"slug": "moss", "ref": record["ref"], "content_sha256": record["content_sha256"], "published_revision": 1})), foreign_id)

    # An untrusted renderer cannot omit the expected binding and overwrite a
    # newer local selection while a remote update was in flight.
    bad_id = "00000000-0000-4000-8000-57bf3aa87cab"
    with pytest.raises(portability.TicketError, match="fields"):
        content_ticket(_write_ticket(tmp_path, bad_id, _ticket("apply_pet_binding", binding={"ref": None, "enabled": True, "scale": 0.33})), bad_id)


def test_personal_bundle_moves_between_real_managed_homes_without_slug_overwrite(tmp_path):
    source_root, target_root = tmp_path / "source-home", tmp_path / "target-home"
    source_profile, target_profile = _profile(source_root), _profile(target_root)
    _pet(source_profile, "moss")
    source_read = "00000000-0000-4000-8000-0e59c8cd72f5"
    record = content_ticket(_write_ticket(source_root, source_read, _ticket("read_pets")), source_read)["pets"][0]
    exported_id = "00000000-0000-4000-8000-0f6a5437d44d"
    exported = content_ticket(_write_ticket(source_root, exported_id, _ticket("export_pet", pet={"slug": "moss", "content_sha256": record["content_sha256"]})), exported_id)
    # A different local moss is preserved; the imported owner-private bundle
    # claims moss-2 and carries its original ref into the target profile only.
    _pet(target_profile, "moss")
    install_id = "00000000-0000-4000-8000-b2f65bddd695"
    installed = content_ticket(
        _write_ticket(target_root, install_id, _ticket("install_pet_bundle", pet=exported["pet"], bundle=exported["bundle"])),
        install_id,
    )
    assert installed == {"ok": True, "slug": "moss-2", "status": "installed"}
    assert json.loads((target_profile / "pets" / "moss-2" / ".atum-pet.json").read_text())["ref"] == record["ref"]
    target_read_id = "00000000-0000-4000-8000-ba5aca4031c9"
    existing = content_ticket(_write_ticket(target_root, target_read_id, _ticket("read_pets")), target_read_id)["pets"][1]
    remote = {**exported["pet"], "display_name": "Cloud Moss", "description": "renamed remotely"}
    reuse_id = "00000000-0000-4000-8000-2b287a7fa512"
    reused = content_ticket(
        _write_ticket(target_root, reuse_id, _ticket("install_pet_bundle", pet=remote, bundle=exported["bundle"], expected_metadata={key: existing[key] for key in ("display_name", "description", "content_sha256")})),
        reuse_id,
    )
    assert reused == {"ok": True, "slug": "moss-2", "status": "reused"}
    assert json.loads((target_profile / "pets" / "moss-2" / "pet.json").read_text())["displayName"] == "Cloud Moss"


def test_clear_binding_unsets_slug_and_readback_never_falls_back_to_disabled_pet(tmp_path):
    profile = _profile(tmp_path)
    _pet(profile)
    read_id = "00000000-0000-4000-8000-b454f82c5857"
    before = content_ticket(_write_ticket(tmp_path, read_id, _ticket("read_pets")), read_id)["active"]
    clear_id = "00000000-0000-4000-8000-dc5d0e283ebc"
    cleared = content_ticket(
        _write_ticket(tmp_path, clear_id, _ticket("apply_pet_binding", binding={"ref": None, "enabled": False, "scale": before["scale"]}, expected_binding=before)),
        clear_id,
    )
    assert cleared["ok"]
    readback_id = "00000000-0000-4000-8000-1f92d0c0c671"
    readback = content_ticket(_write_ticket(tmp_path, readback_id, _ticket("read_pets")), readback_id)
    assert readback["active"] == {"ref": None, "enabled": False, "scale": before["scale"]}
    assert "slug" not in yaml.safe_load((profile / "config.yaml").read_text()).get("display", {}).get("pet", {})


def test_binding_rechecks_cas_after_install_side_effect(tmp_path, monkeypatch):
    profile = _profile(tmp_path)
    _pet(profile)
    _enable_pet(profile)
    read_id = "00000000-0000-4000-8000-4669b42bb67b"
    expected = content_ticket(_write_ticket(tmp_path, read_id, _ticket("read_pets")), read_id)["active"]
    from agent.pet import store

    def late_local_edit(_slug):
        from hermes_cli.config import load_config, save_config
        config = load_config()
        config.setdefault("display", {}).setdefault("pet", {})["enabled"] = False
        save_config(config)
        return store.load_pet("moss")

    monkeypatch.setattr(store, "install_pet", late_local_edit)
    apply_id = "00000000-0000-4000-8000-32bfb2c217d5"
    result = content_ticket(
        _write_ticket(tmp_path, apply_id, _ticket("apply_pet_binding", binding={"ref": {"kind": "petdex", "slug": "moss"}, "enabled": True, "scale": expected["scale"]}, expected_binding=expected)),
        apply_id,
    )
    assert result["ok"] is False and result["status"] == "conflict"


def test_catalog_pet_never_mints_personal_or_activates_without_store_gate(tmp_path, monkeypatch):
    profile = _profile(tmp_path)
    _pet(profile)
    _enable_pet(profile)
    calls: list[tuple] = []

    class Owned:
        def owns(self, kind, item_id, sha256=None):
            return kind == "pet" and item_id == "moss"

    proof = types.ModuleType("hermes_cli.atum_store_proof")
    proof.load_catalog_owned = lambda **_kwargs: Owned()
    proof.enforce_catalog_item = lambda *args, **kwargs: calls.append((args, kwargs))
    monkeypatch.setitem(sys.modules, "hermes_cli.atum_store_proof", proof)
    read_id = "00000000-0000-4000-8000-d1126a4f8e2f"
    state = content_ticket(_write_ticket(tmp_path, read_id, _ticket("read_pets")), read_id)
    assert state["pets"][0]["ref"] == {"kind": "catalog", "item_id": "moss"}
    assert not (profile / "pets" / "moss" / ".atum-pet.json").exists()

    from agent.pet import store
    monkeypatch.setattr(store, "install_pet", lambda slug: store.load_pet(slug))
    apply_id = "00000000-0000-4000-8000-80503df42235"
    result = content_ticket(
        _write_ticket(tmp_path, apply_id, _ticket("apply_pet_binding", binding=state["active"], expected_binding=state["active"])),
        apply_id,
    )
    assert result["ok"] and calls and calls[0][0][:2] == ("pet", "moss")


def test_read_pets_reports_one_unsupported_pet_without_hiding_the_library(tmp_path):
    profile = _profile(tmp_path)
    _pet(profile, "moss")
    broken = _pet(profile, "broken")
    (broken / "untrusted.bin").write_bytes(b"not portable")
    read_id = "00000000-0000-4000-8000-ce2e9b4e2f73"
    result = content_ticket(_write_ticket(tmp_path, read_id, _ticket("read_pets")), read_id)
    assert [pet["slug"] for pet in result["pets"]] == ["moss"]
    assert result["skipped"] == {"count": 1, "status": "partial"}
