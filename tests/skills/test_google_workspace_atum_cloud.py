"""Full-power Google on Atum's cloud: the google-workspace skill with a token the controller wrote.

Each cloud turn the controller writes ``$HERMES_HOME/google_token.json`` (one access token and
placeholders where Hermes' reader needs a refresh token and client) and a placeholder
``google_client_secret.json`` (``packages/cloud-controller/src/google/credentials.ts``). Hermes' own
scripts must work with exactly that file, never try to refresh the placeholders, and tell the agent
what to do when the hour is up. The vectors below are that module's output shape.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "skills/productivity/google-workspace/scripts"

pytest.importorskip("google.oauth2.credentials", reason="the google extra is not installed")

ACCESS = "ya29.TURN_ACCESS_TOKEN_0123456789"
SEVEN_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive.readonly",
]


def _expiry(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def _managed_token(expiry: str, **extra) -> dict:
    """The token file as the controller builds it (googleCredentialFiles)."""
    return {
        "type": "authorized_user",
        "token": ACCESS,
        "expiry": expiry,
        "refresh_token": "atum-cloud-managed",
        "client_id": "atum-cloud-managed",
        "client_secret": "atum-cloud-managed",
        "token_uri": "https://oauth2.googleapis.com/token",
        "scopes": SEVEN_SCOPES,
        **extra,
    }


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"atum_cloud_{name}", SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _no_refresh():
    """Any attempt to refresh (a network call to Google with placeholder credentials) fails the test."""
    from google.oauth2.credentials import Credentials

    def refuse(*_args, **_kwargs):
        raise AssertionError("a managed token must never be refreshed from the sandbox")

    return patch.object(Credentials, "refresh", refuse)


def test_a_fresh_token_file_works_as_it_is_with_no_refresh(home):
    token_path = home / "google_token.json"
    token_path.write_text(json.dumps(_managed_token(_expiry(timedelta(minutes=55)))))
    before = token_path.read_bytes()
    api = _load("google_api")

    with _no_refresh():
        creds = api.get_credentials()

    assert creds.valid and not creds.expired
    assert creds.token == ACCESS
    assert sorted(creds.scopes) == sorted(SEVEN_SCOPES)
    assert token_path.read_bytes() == before


def test_the_check_script_accepts_the_file_and_names_what_the_token_lacks(home, capsys):
    (home / "google_token.json").write_text(json.dumps(_managed_token(_expiry(timedelta(minutes=55)))))
    setup = _load("setup")

    with _no_refresh():
        assert setup.check_auth() is True

    out = capsys.readouterr().out
    assert "AUTHENTICATED" in out
    # Hermes' own list is wider than the platform's seven: the gap is reported, not hidden.
    assert "gmail.modify" in out and "documents" in out


def test_an_expired_token_is_not_refreshed_and_says_to_wait_for_the_next_turn(home, capsys):
    token_path = home / "google_token.json"
    token_path.write_text(json.dumps(_managed_token(_expiry(-timedelta(minutes=5)))))
    before = token_path.read_bytes()
    api = _load("google_api")

    with _no_refresh(), pytest.raises(SystemExit) as exit_info:
        api.get_credentials()

    assert exit_info.value.code == 1
    err = capsys.readouterr().err
    assert "send another message" in err and "setup.py" in err
    assert ACCESS not in err
    assert token_path.read_bytes() == before

    setup = _load("setup")
    with _no_refresh():
        assert setup.check_auth() is False
    assert "TOKEN_EXPIRED" in capsys.readouterr().out


def test_the_gws_bridge_does_not_refresh_an_expired_managed_token_either(home, capsys):
    (home / "google_token.json").write_text(json.dumps(_managed_token(_expiry(-timedelta(minutes=5)))))
    bridge = _load("gws_bridge")

    with patch("urllib.request.urlopen", side_effect=AssertionError("no refresh from the sandbox")), pytest.raises(SystemExit):
        bridge.get_valid_token()

    assert "send another message" in capsys.readouterr().err

    (home / "google_token.json").write_text(json.dumps(_managed_token(_expiry(timedelta(minutes=55)))))
    assert bridge.get_valid_token() == ACCESS


def test_a_token_from_the_skills_own_oauth_flow_still_refreshes(home):
    """The guard is for Atum's placeholder only: a real refresh token is refreshed as Hermes always did."""
    from google.oauth2.credentials import Credentials

    real = _managed_token(_expiry(-timedelta(minutes=5)), refresh_token="1//real-refresh", client_id="123.apps.googleusercontent.com",
                          client_secret="client-secret")
    (home / "google_token.json").write_text(json.dumps(real))
    api = _load("google_api")

    def refreshed(self, _request):
        self.token = "ya29.REFRESHED_TOKEN_0123456789"
        self.expiry = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1)

    with patch.object(Credentials, "refresh", refreshed):
        creds = api.get_credentials()

    assert creds.token == "ya29.REFRESHED_TOKEN_0123456789"
    assert json.loads((home / "google_token.json").read_text())["token"] == "ya29.REFRESHED_TOKEN_0123456789"


# ── B1: the sandbox's Google calls leave only through the egress proxy ───────


def test_the_google_client_built_for_the_sandbox_carries_the_egress_proxy(home, monkeypatch):
    """Inside the sandbox, HTTPS_PROXY is the only route out; the client the skill builds must use it.

    `google_api.build_service` passes no `http`, so googleapiclient builds its own httplib2.Http
    (default `proxy_info=proxy_info_from_environment`). httplib2's `ProxyInfo.isgood()` returns
    falsy unless the `socks` module (PySocks) is importable — without it the proxy is read from
    the environment and then silently dropped. This asserts the object built on the skill's real
    path carries the proxy *and* that it is usable, which is exactly what PySocks restores.
    """
    import socks  # the fix under test: must be importable in the sandbox image's google set

    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")
    (home / "google_token.json").write_text(json.dumps(_managed_token(_expiry(timedelta(minutes=55)))))
    api = _load("google_api")

    with _no_refresh():
        service = api.build_service("gmail", "v1")

    http = service._http.http
    proxy_info = http.proxy_info("https") if callable(http.proxy_info) else http.proxy_info
    assert (proxy_info.proxy_host, proxy_info.proxy_port) == ("proxy.test", 3128)
    assert proxy_info.isgood(), f"httplib2 would ignore the proxy without PySocks (socks={socks})"
    assert proxy_info.applies_to("gmail.googleapis.com")


def test_without_pysocks_the_same_client_ignores_the_proxy(home, monkeypatch):
    """Negative control for the test above.

    `httplib2` itself lands in this state when `import socks` fails (`socks = None`), so patching
    the module attribute is the exact "PySocks not importable" condition. The environment's proxy
    still parses, but `isgood()` goes falsy and httplib2 connects direct — the B1 failure. If this
    test ever starts failing, the positive assertion above has stopped proving PySocks is needed.
    """
    import httplib2

    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")
    (home / "google_token.json").write_text(json.dumps(_managed_token(_expiry(timedelta(minutes=55)))))
    api = _load("google_api")

    with _no_refresh():
        service = api.build_service("gmail", "v1")

    http = service._http.http
    assert httplib2.socks is not None, "the shared venv must have PySocks for this control to be meaningful"
    with patch.object(httplib2, "socks", None):
        proxy_info = http.proxy_info("https") if callable(http.proxy_info) else http.proxy_info
        assert (proxy_info.proxy_host, proxy_info.proxy_port) == ("proxy.test", 3128)
        assert not proxy_info.isgood(), "without PySocks isgood() must go falsy and the proxy is ignored"


# ── The skill as an agent on the cloud loads it ──────────────────────────────


def _view(home: Path, name: str) -> dict:
    from tools.credential_files import clear_credential_files
    from tools.skills_tool import skill_view

    clear_credential_files()
    try:
        with patch("tools.skills_tool.SKILLS_DIR", REPO / "skills"):
            return json.loads(skill_view(name))
    finally:
        clear_credential_files()


def test_google_workspace_is_ready_when_the_turns_files_are_there_and_tells_the_agent_to_use_them(home):
    (home / "google_token.json").write_text(json.dumps(_managed_token(_expiry(timedelta(minutes=55)))))
    (home / "google_client_secret.json").write_text(json.dumps({"installed": {"client_id": "atum-cloud-managed"}}))

    view = _view(home, "google-workspace")

    assert view["success"] is True
    assert view["missing_credential_files"] == [] and view["setup_needed"] is False
    content = view["content"]
    assert "google_token.json" in content
    # It points the agent at the token, not away from Google: the old refusal is gone.
    assert "is not available to you" not in content
    assert "Say so instead of setting up" not in content


def test_google_workspace_reports_the_token_missing_when_google_is_not_connected(home):
    view = _view(home, "google-workspace")

    assert view["success"] is True
    assert "google_token.json" in view["missing_credential_files"]
    assert "Settings › Account › Google" in view["content"]


def test_the_skill_index_offers_google_workspace_on_the_cloud_and_keeps_the_tool_skill_for_atum_google(home, monkeypatch):
    from agent.prompt_builder import build_skills_system_prompt, clear_skills_system_prompt_cache
    from tools.skills_sync import add_bundled_skill

    for name in ("google-workspace", "atum-email-calendar"):
        assert add_bundled_skill(name, home=home)["action"] == "added"
    clear_skills_system_prompt_cache(clear_snapshot=True)
    try:
        cloud = build_skills_system_prompt(available_tools={"terminal", "read_file"}, available_toolsets={"terminal", "file"})
        mac = build_skills_system_prompt(available_tools={"atum_google", "terminal"}, available_toolsets={"atum_google", "terminal"})
    finally:
        clear_skills_system_prompt_cache(clear_snapshot=True)

    assert "google-workspace" in cloud and "atum-email-calendar" not in cloud
    assert "atum-email-calendar" in mac
    # The bundled copy includes the helper the scripts import, so the guard ships with them.
    assert (home / "skills/productivity/google-workspace/scripts/_atum_managed.py").is_file()
