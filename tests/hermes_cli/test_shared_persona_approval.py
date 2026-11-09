"""Owner approval for a profile's shareable SOUL bytes."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

import pytest

from hermes_cli import profiles


@pytest.fixture
def profile_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "profile"
    directory.mkdir()
    (directory / "SOUL.md").write_text("A calm, useful assistant.\n", encoding="utf-8")
    return directory


def test_stale_soul_preview_cannot_be_approved(profile_dir: Path) -> None:
    preview = profiles.read_shared_persona(profile_dir)
    (profile_dir / "SOUL.md").write_text("A changed assistant.\n", encoding="utf-8")

    with pytest.raises(ValueError, match="changed; refresh"):
        profiles.approve_shared_persona(profile_dir, preview["digest"])

    current = profiles.read_shared_persona(profile_dir)
    assert current["digest"] != preview["digest"]
    assert current["approved"] is False
    assert current["approval"] is None


def test_approval_survives_unrelated_profile_metadata_update(profile_dir: Path) -> None:
    preview = profiles.read_shared_persona(profile_dir)
    approved = profiles.approve_shared_persona(profile_dir, preview["digest"])
    profiles.write_profile_meta(profile_dir, description="Runs a public discussion.")

    current = profiles.read_shared_persona(profile_dir)
    assert current["approved"] is True
    assert current["approval"] == approved["approval"]
    assert current["identity_id"] == approved["identity_id"]


def test_soul_edit_disables_approval_without_mutating_its_record(profile_dir: Path) -> None:
    approved = profiles.approve_shared_persona(
        profile_dir, profiles.read_shared_persona(profile_dir)["digest"]
    )
    (profile_dir / "SOUL.md").write_text("An edited assistant.\n", encoding="utf-8")

    current = profiles.read_shared_persona(profile_dir)

    assert current["approved"] is False
    assert current["approval"] == approved["approval"]


def test_clone_identity_invalidates_copied_approval(profile_dir: Path, tmp_path: Path) -> None:
    approved = profiles.approve_shared_persona(
        profile_dir, profiles.read_shared_persona(profile_dir)["digest"]
    )
    clone = tmp_path / "clone"
    shutil.copytree(profile_dir, clone)

    clone_identity = profiles.assign_profile_identity(clone, regenerate=True)
    clone_snapshot = profiles.read_shared_persona(clone)

    assert clone_identity != approved["identity_id"]
    assert clone_snapshot["digest"] == approved["digest"]
    assert clone_snapshot["approved"] is False
    assert clone_snapshot["approval"] is None


def test_revoke_and_reapprove_keep_monotonic_revision(profile_dir: Path) -> None:
    first = profiles.approve_shared_persona(profile_dir, profiles.read_shared_persona(profile_dir)["digest"])
    revoked_revision = profiles.revoke_shared_persona_approval(profile_dir)
    revoked = profiles.read_shared_persona(profile_dir)
    second = profiles.approve_shared_persona(profile_dir, revoked["digest"])

    assert first["approval"]["revision"] == 1
    assert revoked_revision == 2
    assert revoked["approved"] is False
    assert revoked["approval"] is None
    assert second["approval"]["revision"] == 3


@pytest.mark.parametrize("metadata", [b"{{{ not yaml", b"- not a mapping\n"])
def test_malformed_metadata_fails_closed_without_replacing_it(profile_dir: Path, metadata: bytes) -> None:
    metadata_path = profile_dir / "profile.yaml"
    metadata_path.write_bytes(metadata)

    with pytest.raises(ValueError, match="metadata"):
        profiles.read_shared_persona(profile_dir)
    with pytest.raises(ValueError, match="metadata"):
        profiles.approve_shared_persona(profile_dir, "a" * 64)
    assert metadata_path.read_bytes() == metadata


def test_symlinked_utf8_soul_is_hashed_as_the_bytes_read(profile_dir: Path, tmp_path: Path) -> None:
    target = tmp_path / "persona-source.md"
    contents = "Trợ lý bình tĩnh 🌊\n".encode("utf-8")
    target.write_bytes(contents)
    soul_path = profile_dir / "SOUL.md"
    soul_path.unlink()
    try:
        soul_path.symlink_to(target)
    except (NotImplementedError, OSError):
        pytest.skip("symlinks are unavailable on this filesystem")

    snapshot = profiles.read_shared_persona(profile_dir)
    approved = profiles.approve_shared_persona(profile_dir, snapshot["digest"])

    assert snapshot["content"] == contents.decode("utf-8")
    assert snapshot["digest"] == hashlib.sha256(contents).hexdigest()
    assert approved["approved"] is True


@pytest.fixture
def api_client(monkeypatch, tmp_path, _isolate_hermes_home):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    default_home = get_hermes_home()
    default_home.mkdir(parents=True, exist_ok=True)
    (default_home / "SOUL.md").write_text("Endpoint persona.\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: default_home / "profiles")
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", default_home / "state.db")
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return client, default_home


def test_shared_persona_http_preview_approve_and_stale_rejection(api_client) -> None:
    client, home = api_client
    preview = client.get("/api/profiles/default/shared-persona")

    assert preview.status_code == 200
    body = preview.json()
    assert body["approved"] is False
    assert body["approval"] is None
    assert len(body["digest"]) == 64

    home.joinpath("SOUL.md").write_text("Endpoint persona changed.\n", encoding="utf-8")
    stale = client.post(
        "/api/profiles/default/shared-persona/approve",
        json={"expected_digest": body["digest"]},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == "SOUL.md changed; refresh before approving"

    current = client.get("/api/profiles/default/shared-persona").json()
    approved = client.post(
        "/api/profiles/default/shared-persona/approve",
        json={"expected_digest": current["digest"]},
    )
    assert approved.status_code == 200
    assert approved.json()["approved"] is True

    revoked = client.delete("/api/profiles/default/shared-persona/approve")
    assert revoked.status_code == 200
    assert revoked.json() == {"ok": True, "approval": None, "approved": False, "revision": 2}
