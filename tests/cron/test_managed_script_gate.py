"""Managed collection failures cannot reach a model or a delivery adapter."""
import json
from pathlib import Path

import pytest


@pytest.mark.parametrize(('body', 'reason'), [
    ('raise SystemExit(3)', 'managed_script_collection_failed'),
    ('print(\'{"wakeAgent": false}\'); raise SystemExit(3)', 'managed_script_collection_failed'),
    ('print("not json")', 'managed_script_gate_invalid'),
    ('pass', 'managed_script_gate_invalid'),
    ('print("[]")', 'managed_script_gate_invalid'),
    ('print(\'{"wakeAgent": "false"}\')', 'managed_script_gate_invalid'),
    ('print(\'{"wakeAgent": 0}\')', 'managed_script_gate_invalid'),
    ('print(\'{"evidence": []}\')', 'managed_script_gate_invalid'),
    ('print(\'{"wakeAgent": false}\')', None),
])
def test_managed_script_native_fire_fails_closed(tmp_path: Path, monkeypatch, body, reason):
    from cron import jobs, scheduler
    from tui_gateway.native_cloud_job import AtumCronScheduler

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(scheduler, '_hermes_home', tmp_path)
    scripts = tmp_path / 'scripts'
    scripts.mkdir()
    (scripts / 'collect.py').write_text(body)

    # Fail if even agent construction or delivery is attempted. The script,
    # native execution journal and cron store are real, isolated in temp home.
    import run_agent
    def forbidden(*args, **kwargs):
        pytest.fail('gate failure/skip must not construct an agent or publish')
    monkeypatch.setattr(run_agent, 'AIAgent', forbidden)
    monkeypatch.setattr(scheduler, '_deliver_result', forbidden)
    with jobs.use_cron_store(tmp_path):
        job = jobs.create_job(prompt='Use collected evidence', schedule='every 1h', script='collect.py')
        assert AtumCronScheduler().fire_claimed(job)
        saved = jobs.get_job(job['id'])
    assert saved['last_status'] == ('error' if reason else 'ok')
    assert saved.get('last_error') == reason


def test_required_script_cannot_be_removed(monkeypatch):
    from cron.scheduler import run_job
    assert run_job({'id': 'missing'}, require_script_gate=True, native_claimed=True) == (
        False, '', '', 'managed_script_gate_missing')


def test_collection_exception_is_bounded(monkeypatch):
    from cron import scheduler
    def broken(*args):
        raise RuntimeError('private source payload')
    monkeypatch.setattr(scheduler, '_run_job_script_with_claim_heartbeat', broken)
    result = scheduler.run_job(
        {'id': 'broken', 'script': 'collect.py'},
        require_script_gate=True,
        native_claimed=True,
    )
    assert result == (False, '', '', 'managed_script_collection_exception')


def test_ordinary_gate_retains_best_effort_semantics():
    from cron.scheduler import _parse_wake_gate
    assert _parse_wake_gate('not json') is True
    assert _parse_wake_gate(json.dumps({'wakeAgent': 'false'})) is True
    assert _parse_wake_gate(json.dumps({'wakeAgent': False})) is False


@pytest.mark.parametrize('managed', [True, False, 'sweep'])
def test_successful_gate_runs_script_once_and_ordinary_failure_still_wakes(tmp_path, monkeypatch, managed):
    from unittest.mock import MagicMock
    from cron import scheduler
    import run_agent

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(scheduler, '_hermes_home', tmp_path)
    scripts = tmp_path / 'scripts'
    scripts.mkdir()
    counter = scripts / 'count'
    (scripts / 'collect.py').write_text(
        f'from pathlib import Path\np = Path({str(counter)!r})\n'
        'p.write_text(p.read_text() + "x" if p.exists() else "x")\n'
        + ('print(\'{"wakeAgent": true}\')\n' if managed else 'raise SystemExit(3)\n'))
    if managed == 'sweep':
        gate = {'profile': 'atum.sweep-pre-run/1', 'wakeAgent': True, 'prompt': 'Exact legacy payload\nwith unicode: café'}
        script = scripts / 'collect.py'
        script.write_text(script.read_text().rsplit('print(', 1)[0] + f'print({json.dumps(gate)!r})\n')
    agent = MagicMock()
    agent.run_conversation.return_value = {'final_response': 'validated later'}
    monkeypatch.setattr(run_agent, 'AIAgent', MagicMock(return_value=agent))
    monkeypatch.setattr('hermes_cli.env_loader.load_hermes_dotenv', lambda **kw: None)
    monkeypatch.setattr('hermes_cli.runtime_provider.resolve_runtime_provider', lambda **kw: {
        'api_key': 'test-key', 'base_url': 'https://example.invalid/v1',
        'provider': 'openrouter', 'api_mode': 'chat_completions',
    })
    result = scheduler.run_job({'id': 'gate', 'prompt': 'Summarize evidence', 'script': 'collect.py'},
                               require_script_gate=managed, native_claimed=True)
    assert result[0] is True
    assert result[2] == 'validated later'
    assert counter.read_text() == 'x'
    agent.run_conversation.assert_called_once()
    if managed == 'sweep':
        assert agent.run_conversation.call_args.args[0] == gate['prompt']


@pytest.mark.parametrize('gate,reason', [
    ({'profile': 'atum.sweep-pre-run/1', 'wakeAgent': False, 'reason': 'google_mail:unavailable'},
     'managed_sweep_collection_failed:google_mail:unavailable'),
    ({'profile': 'atum.sweep-pre-run/1', 'wakeAgent': True}, 'managed_script_gate_invalid'),
])
def test_typed_sweep_gate_failures(monkeypatch, gate, reason):
    from cron import scheduler
    monkeypatch.setattr(scheduler, '_run_job_script_with_claim_heartbeat', lambda *a: (True, json.dumps(gate)))
    assert scheduler.run_job(
        {'id': 'typed', 'script': 'collect.py'},
        require_script_gate=True,
        native_claimed=True,
    ) == (
        False, '', '', reason)


@pytest.mark.parametrize('gate', ['', '{}', '{"wakeAgent":true}', '{"profile":"atum.sweep-pre-run/1","wakeAgent":true}'])
def test_native_sweep_cannot_drop_or_replace_typed_gate(gate):
    from cron.scheduler import run_job
    assert run_job(
        {'id': 'native'}, native_sweep_gate=gate, native_claimed=True
    )[3] == 'managed_script_gate_invalid'


@pytest.mark.parametrize('failed', [False, True])
def test_native_sweep_real_agent_has_no_tools_and_exact_prompt(tmp_path, monkeypatch, failed):
    from cron import jobs, scheduler
    import run_agent
    from tui_gateway import server
    from tui_gateway.native_cloud_job import AtumCronScheduler

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(scheduler, '_hermes_home', tmp_path)
    cfg = {'atum_followup_sweep': True, 'plugins': {'enabled': []}, 'platform_toolsets': {'cli': []}}
    (tmp_path / 'config.yaml').write_text('model:\n  context_length: 8000\natum_followup_sweep: true\nplugins:\n  enabled: []\nplatform_toolsets:\n  cli: []\n')
    monkeypatch.setattr(server, '_load_cfg', lambda: cfg)
    assert server._load_enabled_toolsets() == []
    shown = server._methods['tools.show']('preflight', {})
    assert shown['result']['total'] == 0
    assert shown['result']['sections'] == []
    from model_tools import get_tool_definitions
    assert get_tool_definitions(enabled_toolsets=server._load_enabled_toolsets(), quiet_mode=True) == []
    monkeypatch.setattr('hermes_cli.env_loader.load_hermes_dotenv', lambda **kw: None)
    monkeypatch.setattr('hermes_cli.runtime_provider.resolve_runtime_provider', lambda **kw: {
        'api_key': 'test-key', 'base_url': 'http://127.0.0.1:1/v1',
        'provider': 'custom', 'api_mode': 'chat_completions',
    })
    calls = []
    def paid_body(self, prompt, *args, **kwargs):
        calls.append(prompt)
        assert self.tools == []
        assert self.enabled_toolsets == []
        return {'failed': failed, 'final_response': '{"profile":"atum.followup-sweep-result/1","decision":"silent"}'}
    monkeypatch.setattr(run_agent.AIAgent, 'run_conversation', paid_body)
    monkeypatch.setattr(scheduler, '_deliver_result', lambda *args, **kwargs: None)
    gate = json.dumps({'profile': 'atum.sweep-pre-run/1', 'wakeAgent': True, 'prompt': 'Exact evidence café'})
    with jobs.use_cron_store(tmp_path):
        job = jobs.create_job(prompt='must not replace evidence', schedule='every 1h', enabled_toolsets=['terminal'])
        assert AtumCronScheduler().fire_claimed(job, sweep_gate=gate)
        assert jobs.get_job(job['id'])['last_status'] == ('error' if failed else 'ok')
        if failed:
            assert jobs.get_job(job['id'])['last_error'] == 'native_sweep_model_failed'
    assert calls == ['Exact evidence café']


@pytest.mark.parametrize("sweep,iterations", [(False, 1), (True, 2)])
def test_small_context_tool_free_profiles_do_not_require_the_sweep_shape(tmp_path, monkeypatch, sweep, iterations):
    import run_agent
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        f"model:\n  context_length: 8000\natum_followup_sweep: {str(sweep).lower()}\n"
        "plugins:\n  enabled: []\nplatform_toolsets:\n  cli: []\n"
    )
    agent = run_agent.AIAgent(model="fixture", api_key="fixture", provider="custom",
                              base_url="http://127.0.0.1:1/v1", enabled_toolsets=[],
                              max_iterations=iterations, quiet_mode=True, skip_memory=True,
                              skip_context_files=True)
    try:
        assert agent.tools == []
    finally:
        agent.close()


def test_small_context_tool_enabled_profile_is_still_rejected(tmp_path, monkeypatch):
    import run_agent
    from agent.model_metadata import ContextWindowTooSmallError

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text("model:\n  context_length: 8000\n")
    with pytest.raises(ContextWindowTooSmallError, match="below the minimum"):
        run_agent.AIAgent(model="fixture", api_key="fixture", provider="custom",
                         base_url="http://127.0.0.1:1/v1", enabled_toolsets=["file"],
                         max_iterations=1, quiet_mode=True, skip_memory=True,
                         skip_context_files=True)
