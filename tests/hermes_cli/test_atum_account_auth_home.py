"""Atum's account sign-in home is every assistant's auth root (``ATUM_ACCOUNT_AUTH_HOME``).

Atum keeps each assistant in its own Hermes home, ``<profiles>/<hash>``, outside any
``<root>/profiles/<name>`` tree, so the native profile -> root fallback found no root and a ChatGPT
plan signed in once for the account reached no assistant (owner report 2026-11-06: "Settings says
connected, but no model picker anywhere allows it"). The bridge names the account home as the root:
assistants borrow its grant, a refresh rotates the account's chain (#87503), and a dead grant is
quarantined there rather than as a token-less copy that would shadow a later sign-in.
Token values are synthetic placeholders.
"""

import json
import threading
from pathlib import Path

import pytest

from agent.credential_pool import CredentialPool, PooledCredential
from hermes_cli import auth, auth_codex


def _pair(prefix: str) -> dict:
    return {"access_token": f"{prefix}-at", "refresh_token": f"{prefix}-rt"}


def _write(path: Path, store: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store), encoding="utf-8")


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def atum_layout(tmp_path, monkeypatch):
    """Atum's on-disk shape: sibling hashed homes, the assistant active, no ``profiles`` parent."""
    profiles = tmp_path / "userData" / "hermes"
    assistant = profiles / "a1"
    account = profiles / "acct"
    assistant.mkdir(parents=True)
    account.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(assistant))
    monkeypatch.delenv(auth.ACCOUNT_AUTH_HOME_ENV, raising=False)
    _write(assistant / "auth.json", {"version": 1, "providers": {}})
    _write(account / "auth.json", {
        "version": 1,
        "active_provider": "openai-codex",
        "providers": {"openai-codex": {"auth_mode": "chatgpt", "tokens": _pair("acct")}},
        "credential_pool": {"openai-codex": [
            {"id": "p1", "provider": "openai-codex", "source": "device_code", "auth_type": "oauth",
             **_pair("acct")}]},
    })
    return assistant / "auth.json", account / "auth.json", account


def test_without_the_bridge_an_assistant_sees_no_account_sign_in(atum_layout):
    """The defect: the hashed home is its own root, so the account's grant is unreachable."""
    assert auth._global_auth_file_path() is None
    with pytest.raises(auth.AuthError):
        auth_codex.resolve_codex_runtime_credentials(read_only=True)


def test_assistant_borrows_the_account_grant(atum_layout, monkeypatch):
    assistant_path, account_path, account = atum_layout
    monkeypatch.setenv(auth.ACCOUNT_AUTH_HOME_ENV, str(account))

    assert auth._global_auth_file_path() == account_path
    creds = auth_codex.resolve_codex_runtime_credentials(read_only=True)
    assert creds["provider"] == "openai-codex"
    assert creds["api_key"] == "acct-at"
    assert auth.get_codex_auth_status()["logged_in"] is True
    # Borrowing writes nothing into the assistant's own store.
    assert "openai-codex" not in _read(assistant_path).get("providers", {})


def test_refresh_rotates_the_account_chain_not_a_copy(atum_layout, monkeypatch):
    assistant_path, account_path, account = atum_layout
    monkeypatch.setenv(auth.ACCOUNT_AUTH_HOME_ENV, str(account))

    auth._save_codex_tokens(_pair("new"), last_refresh="2026-11-06T00:00:00Z", write_through=True)

    stored = _read(account_path)
    assert stored["providers"]["openai-codex"]["tokens"] == _pair("new")
    assert stored["credential_pool"]["openai-codex"][0]["refresh_token"] == "new-rt"
    assert "openai-codex" not in _read(assistant_path).get("providers", {})


def test_the_account_home_itself_has_no_root_above_it(atum_layout, monkeypatch):
    """The sign-in host runs with the bridge too: its own store is the account store."""
    _, _, account = atum_layout
    monkeypatch.setenv(auth.ACCOUNT_AUTH_HOME_ENV, str(account))
    monkeypatch.setenv("HERMES_HOME", str(account))

    assert auth._global_auth_file_path() is None
    assert auth_codex.resolve_codex_runtime_credentials(read_only=True)["api_key"] == "acct-at"


def test_dead_borrowed_grant_is_quarantined_at_the_account_home(atum_layout, monkeypatch):
    """A terminal refresh failure marks the ACCOUNT's pair dead. A token-less copy in the assistant's
    store would shadow the account for good, so Reconnect could never reach this assistant again."""
    assistant_path, account_path, account = atum_layout
    monkeypatch.setenv(auth.ACCOUNT_AUTH_HOME_ENV, str(account))
    pool = CredentialPool.__new__(CredentialPool)
    pool._lock = threading.RLock()
    pool.provider = "openai-codex"
    entry = PooledCredential(id="p1", provider="openai-codex", auth_type="oauth", access_token="acct-at",
                             refresh_token="acct-rt", label="p1", source="device_code", priority=0)

    pool._clear_terminal_tokens_state(entry, auth.AuthError("refresh_token_reused", code="invalid_grant"))

    state = _read(account_path)["providers"]["openai-codex"]
    assert "refresh_token" not in state["tokens"] and "access_token" not in state["tokens"]
    assert state["last_auth_error"]["relogin_required"] is True
    assert "openai-codex" not in _read(assistant_path).get("providers", {})

    # A fresh sign-in at the account home reaches the assistant again.
    _write(account_path, {"version": 1, "providers": {
        "openai-codex": {"auth_mode": "chatgpt", "tokens": _pair("again")}}})
    assert auth_codex.resolve_codex_runtime_credentials(read_only=True)["api_key"] == "again-at"


def test_assistant_with_its_own_grant_keeps_it(atum_layout, monkeypatch):
    """Profile state shadows root per provider: an assistant signed in on its own is untouched."""
    assistant_path, _, account = atum_layout
    monkeypatch.setenv(auth.ACCOUNT_AUTH_HOME_ENV, str(account))
    _write(assistant_path, {"version": 1, "providers": {
        "openai-codex": {"auth_mode": "chatgpt", "tokens": _pair("own")}}})

    assert auth_codex.resolve_codex_runtime_credentials(read_only=True)["api_key"] == "own-at"
