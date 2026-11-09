"""Selected-home real reads behind Matrix's Command center projection."""
import json
import pytest

@pytest.fixture
def command_client(monkeypatch,_isolate_hermes_home):
    import hermes_state
    from hermes_cli import profiles,web_server
    from hermes_constants import get_hermes_home
    from starlette.testclient import TestClient
    home=get_hermes_home()
    other=home/"profiles"/"worker_beta"
    other.mkdir(parents=True)
    (home/"config.yaml").write_text("curator:\n  enabled: false\n  interval_hours: 24\n",encoding="utf-8")
    (other/"config.yaml").write_text("curator:\n  enabled: true\n",encoding="utf-8")
    (home/".env").write_text("FIXTURE_TOKEN=fixture\n",encoding="utf-8")
    (home/"skills").mkdir(exist_ok=True)
    (home/"skills"/".curator_state").write_text(json.dumps({"paused":True,"last_run_at":"2026-10-01T00:00:00+00:00"}),encoding="utf-8")
    (home/"logs").mkdir(exist_ok=True)
    (home/"logs"/"agent.log").write_text("2026-10-02 00:00:00 INFO selected-home\n2026-10-02 00:00:01 ERROR selected-error\n",encoding="utf-8")
    monkeypatch.setattr(profiles,"_get_default_hermes_home",lambda:home)
    monkeypatch.setattr(profiles,"_get_profiles_root",lambda:home/"profiles")
    monkeypatch.setattr(hermes_state,"DEFAULT_DB_PATH",home/"state.db")
    monkeypatch.setattr("gateway.status.get_running_pid_cached", lambda: None)
    monkeypatch.setattr(web_server,"_GATEWAY_HEALTH_URL","")
    db=hermes_state.SessionDB(db_path=home/"state.db")
    db.create_session("fixture-command-center","cli",model="fixture-model")
    db._conn.execute("UPDATE sessions SET input_tokens=17, output_tokens=4, api_call_count=2 WHERE id='fixture-command-center'")
    db._conn.commit();db.close()
    client=TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME]=web_server._SESSION_TOKEN
    return client,home,other

@pytest.mark.parametrize("days",[7,30,90])
def test_four_real_reads_use_selected_home_without_mutating_configuration_or_curator(command_client,days):
    client,home,other=command_client
    tracked=[home/"config.yaml",home/".env",home/"skills"/".curator_state",other/"config.yaml"]
    before={path:path.read_bytes() for path in tracked}
    status=client.get("/api/status?profile=default")
    assert status.status_code==200 and isinstance(status.json()["version"],str)
    logs=client.get("/api/logs?file=agent&level=ALL&lines=200&profile=default")
    assert logs.status_code==200 and any("selected-home" in line for line in logs.json()["lines"])
    absent=client.get("/api/logs?file=desktop&level=ALL&lines=200&profile=default")
    assert absent.status_code==200 and absent.json()=={"file":"desktop","lines":[]}
    usage=client.get(f"/api/analytics/usage?days={days}&profile=default")
    assert usage.status_code==200 and usage.json()["period_days"]==days
    assert usage.json()["totals"]["total_input"]==17
    assert usage.json()["totals"]["total_output"]==4
    assert usage.json()["totals"]["total_api_calls"]==2
    assert usage.json()["by_model"][0]["model"]=="fixture-model"
    curator=client.get("/api/curator?profile=default")
    assert curator.status_code==200
    assert curator.json()["enabled"] is False and curator.json()["paused"] is True
    assert curator.json()["last_run_at"]=="2026-10-01T00:00:00+00:00"
    assert {path:path.read_bytes() for path in tracked}==before
