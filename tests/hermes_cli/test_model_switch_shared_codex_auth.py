"""The /model picker agrees with the profile-local native Codex store."""

import base64
import json
import time

from hermes_cli.auth import _save_codex_tokens, get_auth_status
from hermes_cli import model_switch, models


def _jwt_with_exp(exp_epoch: int) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp_epoch}).encode()).rstrip(b"=").decode()
    return f"h.{payload}.s"


def _profile_sign_in(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))
    monkeypatch.setenv("HERMES_HOME", str(profile))
    _save_codex_tokens(
        {"access_token": _jwt_with_exp(int(time.time()) + 3600), "refresh_token": "profile-rt"})
    # The live catalog read is the only network call; the list it returns is not under test.
    monkeypatch.setattr(models, "cached_provider_model_ids", lambda slug, *a, **k: ["gpt-5.6-luna"])


def test_a_profile_chatgpt_plan_sign_in_is_listed(tmp_path, monkeypatch):
    _profile_sign_in(tmp_path, monkeypatch)

    assert get_auth_status("openai-codex")["logged_in"] is True
    slugs = [row["slug"] for row in model_switch.list_authenticated_providers(current_provider="openai-codex")]

    assert "openai-codex" in slugs


def test_listing_never_refreshes_an_expiring_profile_sign_in(tmp_path, monkeypatch):
    _profile_sign_in(tmp_path, monkeypatch)
    _save_codex_tokens(
        {"access_token": _jwt_with_exp(int(time.time()) - 60), "refresh_token": "profile-rt"})
    from hermes_cli import auth

    def no_network(*args, **kwargs):
        raise AssertionError("the picker's catalog must not refresh tokens")

    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", no_network)
    monkeypatch.setattr(auth, "resolve_codex_runtime_credentials", no_network)

    slugs = [row["slug"] for row in model_switch.list_authenticated_providers(current_provider="openai-codex")]

    assert "openai-codex" in slugs


def test_no_sign_in_anywhere_stays_unlisted(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))
    monkeypatch.setenv("HERMES_HOME", str(profile))
    monkeypatch.setattr(models, "cached_provider_model_ids", lambda slug, *a, **k: ["gpt-5.6-luna"])

    assert get_auth_status("openai-codex")["logged_in"] is False
    slugs = [row["slug"] for row in model_switch.list_authenticated_providers(current_provider="openai-codex")]

    assert "openai-codex" not in slugs
