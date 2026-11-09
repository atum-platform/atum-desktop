"""Managed inventory gates the native ticker before local recurrence advancement."""
import json
from unittest.mock import patch

from hermes_cli.web_server import _desktop_cron_can_dispatch_job


def test_inventory_is_reloaded_and_unmanaged_is_unchanged(tmp_path):
    marker = tmp_path / 'hold'
    gate = _desktop_cron_can_dispatch_job({'HERMES_DESKTOP_CRON_HOLD': str(marker)})
    assert gate('managed') and gate('personal')
    inventory = tmp_path / 'hold.managed'
    inventory.write_text(json.dumps({'profile': 'atum.mac-job-hold/1', 'jobIds': ['managed']}))
    assert not gate('managed')
    assert gate('personal')
    # Restart uses the same disk inventory, not in-memory selection.
    restarted = _desktop_cron_can_dispatch_job({'HERMES_DESKTOP_CRON_HOLD': str(marker)})
    assert not restarted('managed') and restarted('personal')
    inventory.write_text('{')
    assert not gate('personal')
    inventory.unlink()
    assert gate('managed')


def test_tick_never_advances_or_runs_managed_jobs(tmp_path):
    from cron.scheduler import tick
    jobs = [{'id': 'managed'}, {'id': 'personal'}]
    with patch('cron.scheduler._get_lock_paths', return_value=(tmp_path, tmp_path / 'lock')), \
         patch('cron.scheduler.get_due_jobs', return_value=jobs), \
         patch('cron.scheduler.advance_next_runs') as advance, \
         patch('cron.scheduler._submit_with_guard', return_value=None) as submit:
        assert tick(can_dispatch_job=lambda job_id: job_id != 'managed') == 0
    advance.assert_called_once_with(['personal'])
    assert [call.args[0]['id'] for call in submit.call_args_list] == ['personal']


def test_provider_without_per_job_gate_holds_the_profile_once_inventory_exists(tmp_path):
    import threading
    from hermes_cli import web_server

    seen = {}

    class LegacyProvider:
        name = "legacy"

        def start(self, stop_event, interval=60, adapters=None, loop=None, can_dispatch=None):
            seen["can_dispatch"] = can_dispatch

    marker = tmp_path / "hold"
    env = {"HERMES_DESKTOP_CRON_HOLD": str(marker)}
    with patch.dict("os.environ", env), \
         patch("cron.scheduler_provider.resolve_cron_scheduler", return_value=LegacyProvider()), \
         patch.object(web_server, "_desktop_cron_delivery", return_value=({}, None, {}, lambda: None)):
        web_server._start_desktop_cron_ticker(threading.Event(), interval=60)
    gate = seen["can_dispatch"]
    # Unselected (no inventory): exactly today's whole-profile hold.
    assert gate()
    marker.write_text("")
    assert not gate()
    marker.unlink()
    # Selected: this provider cannot skip only the managed jobs, so nothing fires.
    (tmp_path / "hold.managed").write_text(json.dumps({"profile": "atum.mac-job-hold/1", "jobIds": ["managed"]}))
    assert not gate()
