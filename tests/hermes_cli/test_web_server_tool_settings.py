"""Real config/picker seams behind the selected-agent tool settings."""
import pytest
import yaml

@pytest.fixture
def tool_home(monkeypatch, _isolate_hermes_home):
    from hermes_cli import profiles
    from hermes_constants import get_hermes_home
    home=get_hermes_home()
    other=home/"profiles"/"worker_beta"
    other.mkdir(parents=True)
    (other/"config.yaml").write_text("terminal:\n  backend: local\n",encoding="utf-8")
    (home/"config.yaml").write_text("{}\n",encoding="utf-8")
    monkeypatch.setattr(profiles,"_get_default_hermes_home",lambda:home)
    monkeypatch.setattr(profiles,"_get_profiles_root",lambda:home/"profiles")
    return home,other

@pytest.fixture
def tool_client(monkeypatch,tool_home):
    import hermes_state
    from starlette.testclient import TestClient
    from hermes_cli.web_server import app,_SESSION_HEADER_NAME,_SESSION_TOKEN
    monkeypatch.setattr(hermes_state,"DEFAULT_DB_PATH",tool_home[0]/"state.db")
    client=TestClient(app)
    client.headers[_SESSION_HEADER_NAME]=_SESSION_TOKEN
    return client

@pytest.mark.parametrize("overlay", [None, False, True])
def test_three_tool_leaves_round_trip_without_changing_siblings_or_other_homes(tool_client,tool_home,overlay):
    home,other=tool_home
    before={
        "model":{"provider":"openrouter","default":"main","api_key":"fixture-key","base_url":"https://fixture.invalid"},
        "custom_providers":[{"name":"fixture","api_key":"fixture-key","base_url":"https://fixture.invalid"}],
        "terminal":{"backend":"local","docker_volumes":["fixture:/fixture"],"env_passthrough":["FIXTURE"],"cwd":"fixture/path","lifetime_seconds":123},
        "computer_use":{"max_image_dimension":1456,"capture_after_mode":"som","cua_telemetry":False,"no_overlay":overlay},
    }
    (home/"config.yaml").write_text(yaml.safe_dump(before),encoding="utf-8")
    (home/".env").write_text("FIXTURE_TOKEN=fixture-key\n",encoding="utf-8")
    env_before=(home/".env").read_bytes()
    other_before=(other/"config.yaml").read_bytes()
    schema=tool_client.get("/api/config/schema?profile=default")
    assert schema.status_code==200
    assert schema.json()["fields"]["computer_use.max_image_dimension"]["type"]=="number"
    assert schema.json()["fields"]["computer_use.capture_after_mode"]["type"] in {"string", "select"}
    catalog=tool_client.get("/api/tools/terminal/backends?profile=default").json()
    assert any(row["name"]=="docker" for row in catalog["backends"])
    result=tool_client.put("/api/tools/terminal/backend?profile=default",json={"backend":"docker"})
    assert result.status_code==200
    assert result.json()=={"ok":True,"backend":"docker"}
    for patch in ({"max_image_dimension":512},{"capture_after_mode":"ax"}):
        result=tool_client.put("/api/config?profile=default",json={"config":{"computer_use":patch}})
        assert result.status_code==200 and result.json()["ok"] is True
    saved=yaml.safe_load((home/"config.yaml").read_text(encoding="utf-8"))
    assert saved["terminal"]=={**before["terminal"],"backend":"docker"}
    assert saved["computer_use"]["max_image_dimension"] == 512
    assert saved["computer_use"]["capture_after_mode"] == "ax"
    assert saved["computer_use"]["cua_telemetry"] is False
    # Existing save_config may omit a None default; omission retains automatic overlay semantics.
    assert saved["computer_use"].get("no_overlay") is overlay
    for key in ("model","custom_providers"):
        assert saved[key]==before[key]
    assert (home/".env").read_bytes()==env_before
    assert (other/"config.yaml").read_bytes()==other_before
    readback=tool_client.get("/api/config?profile=default").json()
    assert readback["terminal"]["backend"]=="docker"
    assert readback["computer_use"]["capture_after_mode"]=="ax"

def test_saved_backend_requires_new_env_and_preserves_explicit_overrides(tool_client,tool_home):
    from hermes_cli.config import apply_terminal_config_to_env
    assert tool_client.put("/api/tools/terminal/backend?profile=default",json={"backend":"docker"}).status_code==200
    existing={"TERMINAL_ENV":"local"}
    apply_terminal_config_to_env(env=existing,override=False)
    assert existing["TERMINAL_ENV"]=="local"
    fresh={}
    apply_terminal_config_to_env(env=fresh,override=False)
    assert fresh["TERMINAL_ENV"]=="docker"

def test_capture_mode_reloads_but_size_cap_is_read_for_session_start(tool_client,tool_home):
    from tools.computer_use.tool import _capture_after_mode
    from tools.computer_use.cua_backend import _computer_use_max_image_dimension
    for dimension,mode in ((0,"ax"),(512,"vision"),(1456,"som")):
        result=tool_client.put("/api/config?profile=default",json={"config":{"computer_use":{"max_image_dimension":dimension,"capture_after_mode":mode}}})
        assert result.status_code==200
        assert _capture_after_mode()==mode
        assert _computer_use_max_image_dimension()==(dimension or None)
