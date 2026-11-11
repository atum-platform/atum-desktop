import asyncio
import json
import threading
from pathlib import Path

import pytest


def _delivery(request):
    from gateway.config import Platform
    from tui_gateway.host_delivery import DesktopMatrixDelivery

    loop = asyncio.new_event_loop()
    ready = threading.Event()
    loop.call_soon(ready.set)
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    assert ready.wait(2)

    def stop():
        loop.call_soon_threadsafe(loop.stop)
        thread.join(2)
        loop.close()

    return {Platform.MATRIX: DesktopMatrixDelivery(request=request)}, loop, {}, stop


@pytest.mark.parametrize("delivery_failed", [False, True])
@pytest.mark.parametrize("surface", ["cloud", "desktop"])
@pytest.mark.parametrize("sweep", [False, True])
@pytest.mark.parametrize("succeeded", [True, False])
def test_claimed_cloud_run_uses_native_run_one_job_and_host_delivery(monkeypatch, tmp_path: Path, succeeded, sweep, surface, delivery_failed):
    """Real Hermes imports and run_one_job; only the paid model body is a fixture."""
    from cron import jobs, scheduler
    from hermes_cli import web_server
    from tui_gateway.native_cloud_job import run_claimed_native_job, run_claimed_desktop_job
    from tui_gateway import server

    monkeypatch.setattr(server, '_load_cfg', lambda: {
        'atum_followup_sweep': sweep, 'plugins': {'enabled': []}})
    job_id = "ar_22800000000040008000000000000005"
    occurrence_id = "00000000-0000-4000-8000-4dbb758e437f"
    room_id = "!owner:atum.example"
    if surface == "desktop":
        tmp_path = tmp_path / occurrence_id
        tmp_path.mkdir()
        monkeypatch.setenv("ATUM_DESKTOP_JOB_EXECUTION", occurrence_id)
        monkeypatch.setenv("HERMES_DESKTOP_CRON", "0")
        monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:12345/v1")
        monkeypatch.setenv("ATUM_MODEL_KEY", "d" * 43)
    def desktop_rpc(params):
        result = server.handle_request({'jsonrpc': '2.0', 'id': 1,
                                  'method': 'cron.run_claimed_desktop', 'params': params})
        assert 'error' not in result, result
        return result['result']
    run = desktop_rpc if surface == "desktop" else run_claimed_native_job
    delivered = []
    invocations = []
    heartbeat = []
    job = {
        "id": job_id,
        "name": "Morning brief",
        "prompt": "Summarize my priorities.",
        "skills": [],
        "skill": None,
        "model": None,
        "provider": None,
        "base_url": None,
        "script": None,
        "no_agent": False,
        "monitor_script": None,
        "monitor_url": None,
        "context_from": None,
        "schedule": {"kind": "cron", "expr": "30 9 * * *", "display": "daily at 09:30"},
        "schedule_display": "daily at 09:30",
        "repeat": {"times": None, "completed": 0},
        "deliver": "origin",
        "origin": {"platform": "atum", "kind": "managed_job", "job_id": job_id},
        "enabled_toolsets": [],
        "workdir": None,
        "attach_to_session": False,
        "reasoning_effort": None,
        "failure_deliver": None,
        "interpreter": None,
        "enabled": True,
        "state": "scheduled",
        "next_run_at": "2026-11-01T09:30:00+07:00",
    }

    def request(event, payload, _timeout):
        delivered.append((event, payload))
        if delivery_failed:
            return json.dumps({"status": "failed", "error": "durable_delivery_unavailable"})
        return json.dumps({"status": "delivered", "event_id": "$outbox"})

    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("ATUM_TASK_WORKSPACE", "/task/workspace")
    monkeypatch.setenv("ATUM_MODEL_KEY", "g" * 43)
    if surface == "desktop":
        monkeypatch.delenv("ATUM_TASK_WORKSPACE")
    monkeypatch.setattr(scheduler, "_hermes_home", tmp_path)
    bridge_calls = []
    from tui_gateway import server_requests
    monkeypatch.setattr(server_requests, "request_host", lambda method, payload, **kw:
                        bridge_calls.append((method, payload)) or '{"rooms":[]}')
    def model_body(_job, **kwargs):
        # Cron has no interactive callback installer. Exercise the actual wired tool seam
        # while run_one_job owns the execution ContextVar, with no model/network calls.
        if surface == "cloud" and not sweep:
            from tools import desktop_ui
            assert json.loads(desktop_ui.request("atum.chats", {"op": "list"}, 60)) == {"rooms": []}
        return (succeeded, "# native output", "Native routine answer" if succeeded else "",
                None if succeeded else "fixture_provider_failed")
    monkeypatch.setattr(scheduler, "run_job", model_body)
    native = scheduler.run_one_job

    def observed(*args, **kwargs):
        invocations.append((args, kwargs))
        return native(*args, **kwargs)

    monkeypatch.setattr(scheduler, "run_one_job", observed)
    monkeypatch.setattr(jobs, "record_ticker_heartbeat", lambda *args, **kwargs: heartbeat.append((args, kwargs)))
    monkeypatch.setattr(web_server, "_desktop_cron_delivery", lambda: _delivery(request))

    with jobs.use_cron_store(tmp_path):
        jobs.save_jobs([job])
        gate = json.dumps({'profile': 'atum.sweep-pre-run/1', 'wakeAgent': True, 'prompt': 'Exact evidence'})
        result = run({"job_id": job_id, "execution_id": occurrence_id, "room_id": room_id,
                                         **({'sweep_gate': gate} if sweep else {})})
        saved = jobs.get_job(job_id)

    if surface == "cloud" and not sweep:
        assert bridge_calls == [("atum.chats", {"op": "list", "turn_id": occurrence_id})]
    else:
        assert bridge_calls == []
    if succeeded and delivery_failed:
        assert result.pop("reason") == "durable_delivery_unavailable"
        assert result["status"] == "error"
    elif sweep:
        assert result.pop('reason') == (None if succeeded else 'fixture_provider_failed')
        assert invocations[0][1]['native_sweep_gate'] == gate
        projected = invocations[0][0][0]
        assert projected['enabled_toolsets'] == []
        assert projected['skills'] == []
        assert projected['prompt'] == ''
    assert result == {"job_id": job_id, "execution_id": occurrence_id, "processed": True,
                      "status": "ok" if succeeded and not delivery_failed else "error"}
    assert len(invocations) == 1
    assert heartbeat == []
    assert not (tmp_path / "cron" / "ticker_heartbeat").exists()
    if not succeeded:
        assert delivered == []
        assert saved["last_status"] == "error"
        assert saved["last_error"] == "fixture_provider_failed"
        return
    assert len(delivered) == 1
    event, payload = delivered[0]
    assert event == "cron.delivery.request"
    assert payload["job_id"] == job_id
    assert payload["execution_id"] == occurrence_id
    assert payload["room_id"] == room_id
    assert "Native routine answer" in payload["text"]
    assert saved["last_status"] == ("delivery_failed" if delivery_failed else "ok")


def test_atum_provider_uses_the_native_split_fire_seam_without_a_local_clock():
    from cron.scheduler_provider import CronScheduler
    from tui_gateway.native_cloud_job import AtumCronScheduler

    provider = AtumCronScheduler()
    assert isinstance(provider, CronScheduler)
    assert provider.name == "atum"
    with pytest.raises(RuntimeError, match="platform_owned"):
        provider.start(threading.Event())


def test_desktop_entry_refuses_interactive_backend(monkeypatch, tmp_path):
    from tui_gateway.native_cloud_job import run_claimed_desktop_job
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    with pytest.raises(RuntimeError, match="native_desktop_occurrence_required"):
        run_claimed_desktop_job({"job_id": "managed", "execution_id": "00000000-0000-4000-8000-4dbb758e437f",
                                 "room_id": "!owner:atum.example"})


def test_desktop_rpc_refuses_interactive_process(monkeypatch, tmp_path):
    from tui_gateway import server
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.delenv('ATUM_DESKTOP_JOB_EXECUTION', raising=False)
    result = server.handle_request({'jsonrpc': '2.0', 'id': 77, 'method': 'cron.run_claimed_desktop',
                              'params': {'job_id': 'brief', 'execution_id': '00000000-0000-4000-8000-4dbb758e437f',
                                         'room_id': '!owner:atum.example'}})
    assert result['error']['code'] == 5032
