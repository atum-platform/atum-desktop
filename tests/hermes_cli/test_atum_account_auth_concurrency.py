"""The account sign-in home under concurrency (review of PR #868).

Assistants borrow ONE ChatGPT grant from the account home (``ATUM_ACCOUNT_AUTH_HOME``). Codex refresh
tokens are single-use: two borrowers POSTing the same one revoke the whole family. These tests drive
real ``CredentialPool`` refreshes and real ``clear_provider_auth`` against temporary homes; the token
endpoint is a local stub that accepts each refresh token once. Every credential is synthetic.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from hermes_cli import auth
from hermes_cli.auth_constants import AuthError

REPO = Path(__file__).resolve().parents[2]


def _jwt(exp: float) -> str:
    def part(payload: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{part({'alg': 'none'})}.{part({'exp': int(exp), 'sub': 'synthetic'})}.sig"


def _write(path: Path, store: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store), encoding="utf-8")


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _account_store(refresh: str, access: str) -> dict:
    return {
        "version": 1,
        "active_provider": "openai-codex",
        "providers": {"openai-codex": {
            "auth_mode": "chatgpt", "last_refresh": "2026-11-06T00:00:00Z",
            "tokens": {"access_token": access, "refresh_token": refresh}}},
        "credential_pool": {"openai-codex": [{
            "id": "acct-row", "provider": "openai-codex", "label": "device_code", "source": "device_code",
            "auth_type": "oauth", "priority": 0, "access_token": access, "refresh_token": refresh,
            "last_refresh": "2026-11-06T00:00:00Z"}]},
    }


@pytest.fixture
def homes(tmp_path, monkeypatch):
    profiles = tmp_path / "userData" / "hermes"
    account = profiles / "acct"
    first, second = profiles / "a1", profiles / "a2"
    for home in (account, first, second):
        home.mkdir(parents=True)
    for home in (first, second):
        _write(home / "auth.json", {"version": 1, "providers": {}})
    monkeypatch.setenv(auth.ACCOUNT_AUTH_HOME_ENV, str(account))
    monkeypatch.setenv("HERMES_HOME", str(first))
    return account, first, second


_CHILD = textwrap.dedent('''
    import base64, fcntl, json, os, sys, time
    from hermes_cli import auth as auth_mod
    from hermes_cli.auth_constants import AuthError

    LEDGER = os.environ["FAKE_LEDGER"]

    def jwt(exp):
        part = lambda p: base64.urlsafe_b64encode(json.dumps(p).encode()).decode().rstrip("=")
        return part({"alg": "none"}) + "." + part({"exp": int(exp), "sub": "synthetic"}) + ".sig"

    def endpoint(access_token, refresh_token, **_):
        """Accepts each refresh token once; a replay is the provider's family revocation."""
        with open(LEDGER, "a+") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            fh.seek(0)
            replay = refresh_token in fh.read().split()
            fh.write(("REPLAY:" if replay else "") + refresh_token + "\\n")
            fh.flush()
        time.sleep(0.6)  # hold the "POST" open so an unserialized peer overlaps it
        if replay:
            raise AuthError("refresh_token_reused", provider="openai-codex",
                            code="refresh_token_reused", relogin_required=True)
        return {"access_token": jwt(time.time() + 3600), "refresh_token": refresh_token + ".next",
                "last_refresh": "2026-11-06T01:00:00Z"}

    auth_mod.refresh_codex_oauth_pure = endpoint
    from agent.credential_pool import load_pool

    pool = load_pool("openai-codex")
    entry = next(e for e in pool._entries if e.refresh_token == "acct-rt")
    open(os.environ["FAKE_READY"], "w").write("ready")  # both hold the same generation now
    while not os.path.exists(os.environ["FAKE_GO"]):
        time.sleep(0.005)
    result = pool._refresh_entry(entry, force=True)
    print(json.dumps({"ok": result is not None,
                      "rotated": bool(result) and result.refresh_token == "acct-rt.next"}))
''')


def test_two_assistants_refreshing_the_account_grant_post_it_once(homes, tmp_path):
    """BLOCK: distinct assistant homes, one account home, a forced refresh racing in two processes.
    Exactly one POST; the waiter adopts the rotated pair instead of replaying the consumed token."""
    account, first, second = homes
    _write(account / "auth.json", _account_store("acct-rt", _jwt(time.time() + 3600)))
    ledger, go = tmp_path / "ledger.txt", tmp_path / "go"
    script = tmp_path / "child.py"
    script.write_text(_CHILD, encoding="utf-8")

    children, ready = [], []
    for index, home in enumerate((first, second)):
        ready.append(tmp_path / f"ready-{index}")
        env = dict(os.environ, HERMES_HOME=str(home), FAKE_LEDGER=str(ledger), FAKE_GO=str(go),
                   FAKE_READY=str(ready[-1]),
                   PYTHONPATH=str(REPO) + os.pathsep + os.environ.get("PYTHONPATH", ""))
        children.append(subprocess.Popen([sys.executable, str(script)], cwd=str(REPO), env=env,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
    # Start line: both children loaded their pools with the same generation before either refreshes.
    deadline = time.time() + 90
    while not all(each.exists() for each in ready):
        assert all(child.poll() is None for child in children), [c.communicate()[1][-2000:] for c in children]
        assert time.time() < deadline
        time.sleep(0.01)
    go.write_text("go", encoding="utf-8")
    outputs = [child.communicate(timeout=120) for child in children]

    for child, (out, err) in zip(children, outputs):
        assert child.returncode == 0, err[-2000:]
        assert json.loads(out.strip().splitlines()[-1]) == {"ok": True, "rotated": True}
    posts = ledger.read_text(encoding="utf-8").split()
    assert posts == ["acct-rt"], posts  # one POST, no replay
    stored = _read(account / "auth.json")
    assert stored["providers"]["openai-codex"]["tokens"]["refresh_token"] == "acct-rt.next"
    assert stored["credential_pool"]["openai-codex"][0]["refresh_token"] == "acct-rt.next"
    for home in (first, second):  # no assistant forked its own copy
        assert "openai-codex" not in _read(home / "auth.json").get("providers", {})


def _terminal(*_args, **_kwargs):
    raise AuthError("invalid_grant", provider="openai-codex", code="invalid_grant", relogin_required=True)


def test_terminal_rejection_marks_the_account_copy_dead_for_every_reader(homes, monkeypatch):
    """HIGH: the real refresh path, not the helper alone. After invalid_grant the account singleton is
    quarantined AND its pool row is DEAD in the same store, so no fresh assistant reloads the rejected
    pair and the status the desktop reads says "needs sign-in"."""
    account, first, _ = homes
    _write(account / "auth.json", _account_store("acct-rt", _jwt(time.time() + 3600)))
    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", _terminal)
    from agent.credential_pool import STATUS_DEAD, load_pool

    pool = load_pool("openai-codex")
    entry = next(e for e in pool._entries if e.refresh_token == "acct-rt")
    assert pool._refresh_entry(entry, force=True) is None

    stored = _read(account / "auth.json")
    state = stored["providers"]["openai-codex"]
    assert "refresh_token" not in state["tokens"] and state["last_auth_error"]["relogin_required"] is True
    [row] = stored["credential_pool"]["openai-codex"]
    assert row["last_status"] == STATUS_DEAD
    assert stored["active_provider"] == "openai-codex"  # a borrower never rewrites root's choice
    assert "openai-codex" not in _read(first / "auth.json").get("providers", {})
    assert not (_read(first / "auth.json").get("credential_pool") or {}).get("openai-codex")

    fresh = load_pool("openai-codex")
    assert fresh.select() is None  # the rejected pair never re-enters rotation
    assert auth.get_codex_auth_status()["logged_in"] is False

    # Reconnect at the account home (the sign-in host saving a fresh login) reaches the borrower again.
    monkeypatch.setenv("HERMES_HOME", str(account))
    auth._save_codex_tokens({"access_token": _jwt(time.time() + 3600), "refresh_token": "fresh-rt"})
    monkeypatch.setenv("HERMES_HOME", str(first))
    revived = load_pool("openai-codex").select()
    assert revived is not None and revived.refresh_token == "fresh-rt"


def test_late_rejection_never_quarantines_a_peer_rotation_or_an_independent_account(homes, monkeypatch):
    """A failure reported for an old generation, after a peer already rotated, changes nothing in the
    account store; an independent manual login's row is never touched."""
    account, _, _ = homes
    store = _account_store("acct-rt.next", _jwt(time.time() + 3600))
    store["credential_pool"]["openai-codex"].append({
        "id": "manual-row", "provider": "openai-codex", "label": "work", "source": "manual:device_code",
        "auth_type": "oauth", "priority": 1, "access_token": _jwt(time.time() + 3600),
        "refresh_token": "manual-rt"})
    _write(account / "auth.json", store)
    from agent.credential_pool import load_pool

    pool = load_pool("openai-codex")
    before = _read(account / "auth.json")  # after load_pool's own normalising write
    stale = next(e for e in pool._entries if e.id == "acct-row")
    from dataclasses import replace
    stale = replace(stale, refresh_token="acct-rt")  # the generation the late failure was about
    pool._clear_terminal_tokens_state(stale, AuthError("invalid_grant", code="invalid_grant"))

    assert _read(account / "auth.json") == before


_ROTATOR = textwrap.dedent('''
    import json, os, sys, time
    from pathlib import Path
    from hermes_cli import auth

    # Another provider's refresh in the account home: hold the store lock, rotate, write.
    with auth._auth_store_lock():
        Path(os.environ["ROTATOR_HELD"]).write_text("held")
        time.sleep(0.8)
        store = auth._load_auth_store()
        store["providers"]["xai-oauth"]["tokens"] = {"access_token": "xai-at-2", "refresh_token": "xai-rt-2"}
        auth._save_auth_store(store)
''')


def test_disconnect_clear_waits_for_and_keeps_another_providers_rotation(homes, tmp_path, monkeypatch):
    """HIGH: Disconnect's cleanup is Hermes's own clear_provider_auth in the account home (what
    clearMatrixAccountChatGpt runs). It takes the store lock and re-reads, so a concurrent rotation of
    another provider survives and only ChatGPT goes."""
    account, _, _ = homes
    store = _account_store("acct-rt", _jwt(time.time() + 3600))
    store["providers"]["xai-oauth"] = {"tokens": {"access_token": "xai-at-1", "refresh_token": "xai-rt-1"}}
    _write(account / "auth.json", store)
    held = tmp_path / "held"
    script = tmp_path / "rotator.py"
    script.write_text(_ROTATOR, encoding="utf-8")
    env = dict(os.environ, HERMES_HOME=str(account), ROTATOR_HELD=str(held),
               PYTHONPATH=str(REPO) + os.pathsep + os.environ.get("PYTHONPATH", ""))
    rotator = subprocess.Popen([sys.executable, str(script)], cwd=str(REPO), env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    deadline = time.time() + 60
    while not held.exists():
        assert rotator.poll() is None and time.time() < deadline, rotator.communicate()[1][-2000:]
        time.sleep(0.01)

    monkeypatch.setenv("HERMES_HOME", str(account))
    assert auth.clear_provider_auth("openai-codex") is True  # blocks until the rotator releases
    _, err = rotator.communicate(timeout=60)
    assert rotator.returncode == 0, err[-2000:]

    final = _read(account / "auth.json")
    assert final["providers"]["xai-oauth"]["tokens"] == {"access_token": "xai-at-2", "refresh_token": "xai-rt-2"}
    assert "openai-codex" not in final["providers"]
    assert "openai-codex" not in (final.get("credential_pool") or {})
    assert final.get("active_provider") is None


@pytest.fixture
def no_network(monkeypatch):
    import socket

    def forbidden(*args, **kwargs):
        pytest.fail("network access forbidden in synthetic refresh regression")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)


@pytest.mark.parametrize("path", ["singleton", "pool"])
def test_selected_refresh_waiting_across_disconnect_cannot_restore_grant(
    homes, monkeypatch, no_network, path,
):
    """F1: select first, pause at transaction acquisition, clear, then let refresh run."""
    import contextlib
    import concurrent.futures
    import threading
    from agent.credential_pool import load_pool
    from hermes_cli import auth_codex

    account, first, second = homes
    _write(account / "auth.json", _account_store("acct-rt", _jwt(time.time() + 3600)))
    tokens = dict(auth._read_codex_tokens()["tokens"])
    pool = load_pool("openai-codex")
    entry = next(e for e in pool._entries if e.refresh_token == "acct-rt")
    selected, proceed = threading.Event(), threading.Event()
    posts = []

    def endpoint(*args, **kwargs):
        posts.append(True)
        return {"access_token": _jwt(time.time() + 3600), "refresh_token": "rotated-rt"}

    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", endpoint)
    original = auth._provider_state_transaction if path == "singleton" else pool._root_refresh_lock

    @contextlib.contextmanager
    def waiting(*args, **kwargs):
        selected.set()
        assert proceed.wait(10)
        with original(*args, **kwargs) as value:
            yield value

    if path == "singleton":
        monkeypatch.setattr(auth, "_provider_state_transaction", waiting)
    else:
        monkeypatch.setattr(pool, "_root_refresh_lock", waiting)

    def refresh():
        try:
            if path == "singleton":
                return auth_codex._refresh_codex_auth_tokens(tokens, 1)
            return pool._refresh_entry(entry, force=True)
        except AuthError as exc:
            assert exc.code == "codex_auth_missing"
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(refresh)
        try:
            assert selected.wait(10)
            monkeypatch.setenv("HERMES_HOME", str(account))
            assert auth.clear_provider_auth("openai-codex")
        finally:
            monkeypatch.setenv("HERMES_HOME", str(first))
            proceed.set()
        assert pending.result(timeout=15) is None
    assert posts == []
    # Even a stale write-through save must never create a new assistant-local grant.
    with pytest.raises(AuthError, match="No Codex credentials"):
        auth._save_codex_tokens(tokens, write_through=True)
    for home in (account, first, second):
        store = _read(home / "auth.json")
        assert "openai-codex" not in store.get("providers", {})
        assert not store.get("credential_pool", {}).get("openai-codex")
    monkeypatch.setenv("HERMES_HOME", str(second))
    assert load_pool("openai-codex").select() is None
    assert auth.get_codex_auth_status()["logged_in"] is False


@pytest.mark.parametrize("provider,refresh_fn", [
    ("openai-codex", "refresh_codex_oauth_pure"),
    ("xai-oauth", "refresh_xai_oauth_pure"),
])
def test_loaded_waiter_honors_terminal_verdict_before_post(
    homes, monkeypatch, no_network, provider, refresh_fn,
):
    """F2: both pools load before the first terminal POST; the waiter must not replay it."""
    from agent.credential_pool import STATUS_DEAD, load_pool

    account, first, second = homes
    store = _account_store("acct-rt", _jwt(time.time() + 3600))
    if provider != "openai-codex":
        store = json.loads(json.dumps(store).replace("openai-codex", provider))
    _write(account / "auth.json", store)
    pools = []
    for home in (first, second):
        monkeypatch.setenv("HERMES_HOME", str(home))
        pool = load_pool(provider)
        pools.append((home, pool, next(e for e in pool._entries if e.refresh_token == "acct-rt")))
    posts = []

    def terminal(*args, **kwargs):
        posts.append(True)
        code = "xai_refresh_failed" if provider == "xai-oauth" else "invalid_grant"
        raise AuthError("invalid_grant", provider=provider, code=code, relogin_required=True)

    monkeypatch.setattr(auth, refresh_fn, terminal)
    for home, pool, entry in pools:
        monkeypatch.setenv("HERMES_HOME", str(home))
        assert pool._refresh_entry(entry, force=True) is None
        assert len(posts) == 1
        assert _read(account / "auth.json")["credential_pool"][provider][0]["last_status"] == STATUS_DEAD
    # Reusing even the original captured object cannot bypass the durable verdict.
    assert pools[-1][1]._refresh_entry(pools[-1][2], force=True) is None
    assert len(posts) == 1
