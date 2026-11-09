"""Selected-home MCP endpoints with real storage/probe/OAuth plumbing.

Only the network/process MCP connector is fake. All homes, credentials and
catalog manifests are disposable; no loopback server or external auth starts.
"""

import asyncio
import threading
from types import SimpleNamespace

import pytest
import yaml


@pytest.fixture
def homes(tmp_path, monkeypatch):
    from hermes_cli import profiles

    default = tmp_path / "hermes"
    profiles_root = default / "profiles"
    owned = profiles_root / "owned"
    other = profiles_root / "other"
    for home in (default, owned, other):
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")
        (home / ".env").write_text("", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(default))
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    return {"default": default, "owned": owned, "other": other}


@pytest.fixture
def client(homes, monkeypatch):
    from starlette.testclient import TestClient
    from hermes_cli import web_server, web_server_mcp

    web_server_mcp._mcp_oauth_flows.clear()
    web_server_mcp._mcp_oauth_transactions.clear()
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    with TestClient(web_server.app) as connection:
        connection.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
        yield connection
    for flow in web_server_mcp._mcp_oauth_flows.values():
        flow.mark_error("test cleanup")
        assert flow._worker_done.wait(5), "MCP OAuth test worker must retire"


@pytest.fixture
def connector(monkeypatch):
    from tools import mcp_tool
    from tools import mcp_tool_discovery
    from tools import mcp_tool_lifecycle
    from hermes_constants import get_hermes_home

    seen = []
    shutdowns = []

    class FakeServer:
        _tools = [SimpleNamespace(name="demo-tool", description="Demonstration")]
        initialize_result = SimpleNamespace(capabilities=SimpleNamespace(prompts=None, resources=None))

        async def shutdown(self):
            shutdowns.append(str(get_hermes_home()))

    async def connect(name, config):
        seen.append((name, str(get_hermes_home()), config))
        return FakeServer()

    monkeypatch.setattr(mcp_tool_discovery, "_connect_server", connect)
    yield seen
    mcp_tool_lifecycle._stop_mcp_loop_if_idle()
    assert len(shutdowns) == len(seen)


def cfg(home):
    return yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}


def add(client, name="demo", profile="owned", **inputs):
    response = client.post("/api/mcp/servers", params={"profile": profile}, json={"name": name, **inputs})
    assert response.status_code == 200
    return response


def test_add_list_toggle_remove_use_only_selected_home(client, homes):
    add(client, url="https://mcp.example/mcp", auth="header", bearer_token="disposable-bearer")
    saved = cfg(homes["owned"])["mcp_servers"]["demo"]
    assert saved["headers"] == {"Authorization": "Bearer ${MCP_DEMO_API_KEY}"}
    assert "disposable-bearer" in (homes["owned"] / ".env").read_text()
    assert not cfg(homes["default"]).get("mcp_servers")
    assert not cfg(homes["other"]).get("mcp_servers")
    listing = client.get("/api/mcp/servers", params={"profile": "owned"})
    assert listing.status_code == 200
    assert listing.json()["servers"][0]["name"] == "demo"
    assert "disposable-bearer" not in listing.text
    toggle = client.put("/api/mcp/servers/demo/enabled", params={"profile": "owned"}, json={"enabled": False})
    assert toggle.status_code == 200
    assert cfg(homes["owned"])["mcp_servers"]["demo"]["enabled"] is False
    assert client.delete("/api/mcp/servers/demo", params={"profile": "other"}).status_code == 404
    assert client.delete("/api/mcp/servers/demo", params={"profile": "owned"}).status_code == 200
    assert not cfg(homes["owned"]).get("mcp_servers")


def test_actual_probe_resolves_selected_home_secret_not_process_default(client, homes, connector, monkeypatch):
    monkeypatch.setenv("MCP_MATRIX_KEY", "process-default")
    monkeypatch.setenv("MCP_MATRIX_DEFAULT_ONLY", "must-not-leak")
    (homes["default"] / ".env").write_text("MCP_MATRIX_KEY=default-file\n", encoding="utf-8")
    (homes["owned"] / ".env").write_text("MCP_MATRIX_KEY=owned-file\n", encoding="utf-8")
    add(client, command="example-mcp", args=[], env={"API_KEY": "${MCP_MATRIX_KEY}", "MISSING": "${MCP_MATRIX_DEFAULT_ONLY}"})
    response = client.post("/api/mcp/servers/demo/test", params={"profile": "owned"})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert connector[0][1] == str(homes["owned"])
    assert connector[0][2]["env"]["API_KEY"] == "owned-file"
    assert connector[0][2]["env"]["MISSING"] == "${MCP_MATRIX_DEFAULT_ONLY}"
    assert cfg(homes["owned"])["mcp_servers"]["demo"]["env"]["API_KEY"] == "${MCP_MATRIX_KEY}"


def test_catalog_install_uses_real_selected_config_secret_and_probe(client, homes, connector, tmp_path, monkeypatch):
    catalog_root = tmp_path / "catalog"
    entry_dir = catalog_root / "catalog-demo"
    entry_dir.mkdir(parents=True)
    (entry_dir / "manifest.yaml").write_text(yaml.safe_dump({
        "manifest_version": 1, "name": "catalog-demo", "description": "Disposable example", "source": "https://example.com",
        "transport": {"type": "stdio", "command": "example-mcp", "args": [], "env": {"API_KEY": "${MCP_MATRIX_KEY}"}},
        "auth": {"type": "api_key", "env": [{"name": "MCP_MATRIX_KEY", "prompt": "Example key", "required": True}]},
    }), encoding="utf-8")
    monkeypatch.setenv("HERMES_OPTIONAL_MCPS", str(catalog_root))
    monkeypatch.setenv("MCP_MATRIX_KEY", "process-default")
    listing = client.get("/api/mcp/catalog", params={"profile": "owned"})
    assert listing.status_code == 200
    assert listing.json()["entries"][0]["installed"] is False
    installed = client.post("/api/mcp/catalog/install", params={"profile": "owned"}, json={"name": "catalog-demo", "env": {"MCP_MATRIX_KEY": "catalog-owned"}, "enable": True})
    assert installed.status_code == 200
    assert installed.json()["background"] is False
    assert connector[0][1] == str(homes["owned"])
    assert connector[0][2]["env"]["API_KEY"] == "catalog-owned"
    assert "catalog-owned" in (homes["owned"] / ".env").read_text()
    assert "catalog-demo" in cfg(homes["owned"])["mcp_servers"]
    assert "catalog-demo" not in cfg(homes["default"]).get("mcp_servers", {})
    assert client.get("/api/mcp/catalog", params={"profile": "owned"}).json()["entries"][0]["installed"] is True


def test_real_oauth_worker_callback_and_tokens_remain_in_original_home(client, homes, monkeypatch):
    from tools import mcp_tool
    from tools import mcp_tool_discovery
    from tools import mcp_tool_lifecycle
    from tools.mcp_dashboard_oauth import get_dashboard_oauth_flow
    from tools.mcp_oauth import HermesTokenStorage, _sdk_class
    from hermes_cli import web_server_mcp
    from hermes_constants import get_hermes_home

    seen = []
    completed = threading.Event()

    class FakeServer:
        _tools = [SimpleNamespace(name="demo-tool", description="Demonstration")]

        async def shutdown(self):
            completed.set()

    async def connect(name, config):
        flow = get_dashboard_oauth_flow()
        assert flow is not None
        seen.append((name, str(get_hermes_home()), flow.hermes_home, config["url"]))
        await flow.publish_authorization_url("https://idp.example/authorize?state=disposable-state")
        code, state, _issuer = await flow.wait_for_callback(timeout=5)
        assert code == "disposable-code" and state == "disposable-state"
        OAuthToken = _sdk_class("OAuthToken")
        await HermesTokenStorage(name).set_tokens(
            OAuthToken(access_token="disposable-token", token_type="Bearer", expires_in=3600)
        )
        return FakeServer()

    monkeypatch.setattr(mcp_tool_discovery, "_connect_server", connect)
    monkeypatch.setenv("MCP_MATRIX_KEY", "process-default")
    monkeypatch.setenv("MCP_MATRIX_DEFAULT_ONLY", "must-not-leak")
    (homes["owned"] / ".env").write_text("MCP_MATRIX_KEY=owned-file\n", encoding="utf-8")
    add(client, url="https://mcp.example/${MCP_MATRIX_KEY}?missing=${MCP_MATRIX_DEFAULT_ONLY}", auth="oauth")
    started = client.post("/api/mcp/servers/demo/auth", params={"profile": "owned"})
    assert started.status_code == 200
    flow = web_server_mcp._mcp_oauth_flows[started.json()["flow_id"]]
    assert flow.hermes_home == str(homes["owned"])
    assert flow.reconnect_live is False
    assert client.get("/api/mcp/oauth/callback/demo?code=wrong&state=wrong").status_code == 404
    assert client.get("/api/mcp/oauth/callback/demo?code=disposable-code&state=disposable-state").status_code == 200
    assert flow._worker_done.wait(5)
    status = client.get(f"/api/mcp/oauth/flows/{flow.flow_id}", params={"profile": "other"})
    assert status.json()["status"] == "approved", status.json()
    # The upstream status endpoint ignores profile: the native adapter must
    # retain the exact flow identity, and it cannot retarget this worker.
    assert seen == [("demo", str(homes["owned"]), str(homes["owned"]), "https://mcp.example/owned-file?missing=${MCP_MATRIX_DEFAULT_ONLY}")]
    assert (homes["owned"] / "mcp-tokens" / "demo.json").exists()
    assert not (homes["other"] / "mcp-tokens").exists()
    assert not (homes["default"] / "mcp-tokens").exists()
    assert "disposable-code" not in status.text
    assert "disposable-token" not in status.text
    mcp_tool_lifecycle._stop_mcp_loop_if_idle()


def test_oauth_probe_without_real_token_cannot_false_green(client, homes, connector):
    add(client, url="https://mcp.example/mcp", auth="oauth")
    response = client.post("/api/mcp/servers/demo/test", params={"profile": "owned"})
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert not (homes["owned"] / "mcp-tokens").exists()
    assert len(connector) == 1


def test_current_process_probe_keeps_deployment_environment_compatibility(client, homes, connector, monkeypatch):
    monkeypatch.setenv("MCP_MATRIX_DEPLOY_KEY", "current-process-only")
    add(client, profile="default", command="example-mcp", args=[], env={"API_KEY": "${MCP_MATRIX_DEPLOY_KEY}"})
    response = client.post("/api/mcp/servers/demo/test", params={"profile": "default"})
    assert response.status_code == 200 and response.json()["ok"] is True
    assert connector[0][1] == str(homes["default"])
    assert connector[0][2]["env"]["API_KEY"] == "current-process-only"


def test_bare_native_reload_rpc_refreshes_all_profile_overlays_after_confirm(homes, monkeypatch):
    import tui_gateway.server as server
    from tools import mcp_tool_agent, mcp_tool_discovery, mcp_tool_lifecycle
    from hermes_cli import web_server_profiles
    from hermes_constants import get_hermes_home

    agent = SimpleNamespace(system_prompt="retained-prefix", tools=["retained-tool"])
    handler = server._methods["reload.mcp"]
    bound = handler.__globals__
    sessions = bound["_sessions"]
    sessions.clear()
    sessions["active-session"] = {"agent": agent, "profile_home": homes["owned"]}
    monkeypatch.setitem(bound, "_mcp_reload_gen", 0)
    monkeypatch.setitem(bound, "_mcp_reload_loaded_rev", "")
    monkeypatch.setitem(bound, "_compute_mcp_rev", lambda: "scoped-revision")
    calls = []
    monkeypatch.setattr(mcp_tool_lifecycle, "shutdown_mcp_servers", lambda: calls.append(("shutdown", get_hermes_home())))
    monkeypatch.setattr(mcp_tool_discovery, "discover_mcp_tools", lambda: calls.append(("discover", get_hermes_home())))

    refreshes = []

    def record_session_refresh(*args, **kwargs):
        refreshes.append((args, kwargs))
        return set()

    monkeypatch.setattr(mcp_tool_agent, "refresh_agent_mcp_tools", record_session_refresh)
    with web_server_profiles._config_profile_scope("owned"):
        response = server._methods["reload.mcp"](1, {"confirm": True})
    assert response["result"]["status"] == "reloaded"
    assert calls == [
        ("shutdown", homes["default"]),
        ("discover", homes["default"]),
        ("discover", homes["owned"]),
    ]
    assert len(refreshes) == 1
    assert agent.system_prompt == "retained-prefix" and agent.tools == ["retained-tool"]
