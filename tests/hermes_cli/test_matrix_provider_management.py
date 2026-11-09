"""Real provider routes against disposable homes; no external provider auth."""

import json
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from hermes_cli import web_server as ws
from hermes_cli.web_routers import oauth as oauth_router


@pytest.fixture
def homes(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    selected = root / "profiles" / "selected"
    other = root / "profiles" / "other"
    selected.mkdir(parents=True)
    other.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    for home in (root, selected, other):
        (home / "config.yaml").write_text(yaml.safe_dump({
            "model": {"provider": "openrouter", "default": "old-model"},
            "auxiliary": {"vision": {"provider": "openrouter", "model": "vision-model"}},
            "model_catalog": {"enabled": False},
        }))
    return root, selected, other


@pytest.fixture
def client():
    return TestClient(ws.app, headers={"X-Hermes-Session-Token": ws._SESSION_TOKEN})


def cfg(home):
    return yaml.safe_load((home / "config.yaml").read_text())


def endpoint(name="Local model", **overrides):
    return {"id": "local-model", "name": name, "base_url": "http://127.0.0.1:11434/v1",
            "model": "local-default", "api_key": "synthetic-key", "make_default": False,
            "discover_models": False, **overrides}


def test_endpoint_add_list_activate_delete_stay_in_selected_home(homes, client):
    root, selected, other = homes
    root_before, other_before = cfg(root), cfg(other)
    response = client.post("/api/providers/custom-endpoints?profile=selected", json=endpoint())
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "local-model" in cfg(selected)["providers"]
    assert cfg(selected)["model"]["provider"] == "openrouter"
    assert cfg(root) == root_before
    assert cfg(other) == other_before
    assert client.get("/api/providers/custom-endpoints?profile=other").json()["endpoints"] == []
    assert client.get("/api/providers/custom-endpoints?profile=selected").json()["endpoints"][0]["id"] == "local-model"

    activated = client.post("/api/providers/custom-endpoints/local-model/activate?profile=selected")
    assert activated.status_code == 200
    assert cfg(selected)["model"]["provider"] == "local-model"
    assert "synthetic-key" in (selected / ".env").read_text()
    assert "api_key" not in cfg(selected)["providers"]["local-model"]
    assert cfg(selected)["auxiliary"]["vision"] == root_before["auxiliary"]["vision"]
    assert cfg(root) == root_before
    assert cfg(other) == other_before

    deleted = client.delete("/api/providers/custom-endpoints/local-model?profile=selected")
    assert deleted.status_code == 200
    assert "local-model" not in cfg(selected).get("providers", {})
    assert "api_key" not in cfg(selected)["model"]
    assert cfg(root) == root_before
    assert cfg(other) == other_before


def test_key_lifecycle_write_is_scoped_and_picker_reads_same_home(homes, client):
    root, selected, other = homes
    response = client.put("/api/env?profile=selected", json={"key": "OPENROUTER_API_KEY", "value": "synthetic-provider-key"})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "synthetic-provider-key" in (selected / ".env").read_text()
    assert not (root / ".env").exists()
    assert not (other / ".env").exists()
    rows = client.get("/api/model/options?profile=selected&read_only=1&explicit_only=1").json()["providers"]
    ready = next(row for row in rows if row["slug"] == "openrouter")
    assert ready["authenticated"] is True
    assert ready["models"]
    other_env = client.get("/api/env?profile=other").json()
    assert other_env["OPENROUTER_API_KEY"]["is_set"] is False
    # save_env_value also updates process env, intentionally visible to ambient
    # auth resolution in this same server. Matrix pins one backend/home per
    # agent and never offers arbitrary other-profile queries; disk separation,
    # not general same-process ambient credential isolation, is asserted here.


def test_custom_model_assignment_uses_stored_credentials_and_preserves_aux(homes, client, monkeypatch):
    from hermes_cli import model_cost_guard
    monkeypatch.setattr(model_cost_guard, "expensive_model_warning", lambda *args, **kwargs: None)
    root, selected, other = homes
    before = cfg(selected)
    client.post("/api/providers/custom-endpoints?profile=selected", json=endpoint())
    response = client.post("/api/model/set?profile=selected", json={"scope": "main", "provider": "local-model", "model": "local-default"})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    after = cfg(selected)
    assert after["model"]["provider"] == "local-model"
    assert "synthetic-key" in (selected / ".env").read_text()
    assert "api_key" not in after["providers"]["local-model"]
    assert after["model"]["base_url"] == "http://127.0.0.1:11434/v1"
    assert after["auxiliary"] == before["auxiliary"]
    assert cfg(root)["model"]["provider"] == "openrouter"
    assert cfg(other)["model"]["provider"] == "openrouter"
    catalog = client.get("/api/model/options?profile=selected&read_only=1&explicit_only=1").json()
    row = next(row for row in catalog["providers"] if row["slug"] == "local-model")
    assert row["is_current"] is True
    assert "local-default" in row["models"]


@pytest.mark.parametrize("route", [
    ("GET", "/api/providers/custom-endpoints"),
    ("POST", "/api/providers/custom-endpoints"),
    ("POST", "/api/providers/custom-endpoints/local-model/activate"),
    ("DELETE", "/api/providers/custom-endpoints/local-model"),
])
def test_unknown_profile_never_falls_back_to_current_home(homes, client, route):
    before = [cfg(home) for home in homes]
    method, path = route
    kwargs = {"json": endpoint()} if path.endswith("custom-endpoints") and method == "POST" else {}
    response = client.request(method, path + "?profile=missing", **kwargs)
    assert response.status_code in (400, 404)
    assert [cfg(home) for home in homes] == before


class TokenReply:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps({"access_token": "synthetic-access", "refresh_token": "synthetic-refresh", "expires_in": 3600}).encode()


def test_retained_device_session_cannot_publish_after_cancellation(homes, client, monkeypatch):
    from hermes_cli import auth
    session, retained = oauth_router._new_oauth_session("minimax-oauth", "device_code", profile="selected")
    retained.update({"portal_base_url": "https://api.minimax.io", "client_id": "synthetic", "user_code": "CODE", "code_verifier": "verifier", "expired_in_raw": 600})

    def approved(*args, **kwargs):
        client.delete(f"/api/providers/oauth/sessions/{session}?profile=selected")
        return {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh", "expired_in": 600}

    monkeypatch.setattr(auth, "_minimax_poll_token", approved)
    oauth_router._minimax_poller(session)
    assert all(not (home / "auth.json").exists() for home in homes)
    assert retained["status"] == "cancelled"
