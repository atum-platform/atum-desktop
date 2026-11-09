"""Atum gives each account on a Mac its own Codex (ChatGPT plan) sign-in.

The desktop launcher sets ``HERMES_CODEX_SHARED_AUTH_DIR`` to a folder owned by
one Atum account and ``CODEX_HOME`` to an empty Atum-owned folder
(apps/desktop/electron/matrix/hermes-runtime.ts ``matrixAccountCodexScope``).
These tests run the real token store against that environment: a second
account never sees the first one's sign-in, the person's own Codex CLI login in
``~/.codex`` is never adopted, and sign-out's profile cleanup forgets the
profile's copy.
"""

import base64
import json
import time

import pytest

from hermes_cli import auth


def _jwt(exp_offset: int = 3600) -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none'})}.{part({'exp': int(time.time()) + exp_offset})}.sig"


def _account(monkeypatch, tmp_path, name: str):
    root = tmp_path / "profiles"
    home = root / f"home-{name}"
    home.mkdir(parents=True, exist_ok=True)
    account = root / "accounts" / name
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_CODEX_SHARED_AUTH_DIR", str(account / "codex-auth"))
    monkeypatch.setenv("CODEX_HOME", str(account / "codex-home"))
    return home, account


def _codex_cli_login(tmp_path, monkeypatch):
    """A real-looking login in the person's own ~/.codex."""
    person = tmp_path / "person"
    (person / ".codex").mkdir(parents=True)
    (person / ".codex" / "auth.json").write_text(
        json.dumps({"tokens": {"access_token": _jwt(), "refresh_token": "cli-refresh"}})
    )
    monkeypatch.setenv("HOME", str(person))
    return person


def test_second_account_on_the_mac_does_not_see_the_first_ones_chatgpt(monkeypatch, tmp_path):
    _account(monkeypatch, tmp_path, "a")
    auth._save_codex_tokens({"access_token": _jwt(), "refresh_token": "a-refresh"})
    assert auth._read_codex_tokens()["tokens"]["refresh_token"] == "a-refresh"

    _account(monkeypatch, tmp_path, "b")
    with pytest.raises(auth.AuthError):
        auth._read_codex_tokens()


def test_never_adopts_the_persons_codex_cli_login(monkeypatch, tmp_path):
    _codex_cli_login(tmp_path, monkeypatch)
    _account(monkeypatch, tmp_path, "a")
    # Atum's CODEX_HOME is its own empty folder: nothing to import, nothing adopted.
    assert auth._import_codex_cli_tokens() is None
    with pytest.raises(auth.AuthError):
        auth._read_codex_tokens()

    # Proof the guard is what stops it: without Atum's folder the CLI login is read.
    monkeypatch.delenv("CODEX_HOME")
    assert auth._import_codex_cli_tokens()["refresh_token"] == "cli-refresh"


def test_sign_out_cleanup_forgets_the_profiles_copy(monkeypatch, tmp_path):
    _home, _account_dir = _account(monkeypatch, tmp_path, "a")
    auth._save_codex_tokens({"access_token": _jwt(), "refresh_token": "a-refresh"})

    # Native Hermes stores the sign-in in this profile's auth.json; clearing the
    # provider is sufficient and does not depend on a second shared store.
    auth.clear_provider_auth("openai-codex")
    with pytest.raises(auth.AuthError):
        auth._read_codex_tokens()


def test_account_scoped_login_is_visible_to_native_status_and_runtime(monkeypatch, tmp_path):
    """The desktop's compact flow lands in the same native Hermes store the runtime reads."""
    _account(monkeypatch, tmp_path, "a")
    auth._save_codex_tokens({"access_token": _jwt(), "refresh_token": "account-refresh"})

    from hermes_cli.web_routers.oauth import _resolve_provider_status
    from hermes_cli.runtime_provider import resolve_runtime_provider

    status = _resolve_provider_status("openai-codex", None)
    runtime = resolve_runtime_provider(requested="openai-codex")

    assert status["logged_in"] is True
    assert status["source"]
    assert runtime["provider"] == "openai-codex"
    assert runtime["api_mode"] == "codex_responses"
    assert runtime["api_key"]
