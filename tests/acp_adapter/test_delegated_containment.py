"""B-0 (self-work slice B, gate 4b): direct calls for the paths from INSIDE a delegated thread to a plan provider.

A delegated thread runs on the Atum model in its own Hermes profile (``self-work.yaml`` + ``delegated.yaml``). What it can reach on the Mac
is what T3 hands an ACP agent (the ``t3-code`` MCP server) and what its tools can do as the same macOS user. These tests call the real
floors, not mocks: the editor MCP scope and the ``approvals.deny`` rules, with the approvals mode turned OFF so only the floors speak.

A deny rule is a floor, not a sandbox (docs/work-subscriptions.md): the strict ``xfail`` rows below are the paths it does NOT close, kept
as failing-by-design tests so closing one later shows up as a pass that has to be reviewed.
"""
import json

import pytest

import hermes_yaml
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROFILES = ROOT / 'acp_adapter' / 'profiles'


def _delegated_config():
    cfg = hermes_yaml.safe_load((PROFILES / 'self-work.yaml').read_text())
    cfg.update(hermes_yaml.safe_load((PROFILES / 'delegated.yaml').read_text()))
    cfg['approvals']['mode'] = 'off'  # the deny floor still applies: that is the point
    return cfg


@pytest.fixture
def delegated_home(tmp_path):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    (tmp_path / 'config.yaml').write_text(json.dumps(_delegated_config()))
    token = set_hermes_home_override(tmp_path)
    try:
        yield tmp_path
    finally:
        reset_hermes_home_override(token)


def _blocked(command: str) -> bool:
    from tools.approval import check_all_command_guards

    return bool(check_all_command_guards(command, 'local').get('user_deny'))


# Every spelling of "talk to T3 from the shell" that the floor must stop: T3's own thread tools, its auth control plane (a pairing
# credential or a session is a way to anything, a plan thread included), its environment links, and the plan makers' own clients.
BLOCKED = [
    't3 thread list',
    't3 thread send --thread abc --message hi',
    '/Applications/Atum.app/Contents/Resources/work-runtime/t3 thread launch --model codex',
    'env T3CODE_HOME=/x t3 thread list',
    'cd /tmp && t3 thread list',
    'echo go; t3 thread list',
    '(t3 thread list)',
    'sh -c "t3 thread list"',
    "bash -c 't3 thread list'",
    't""3 thread list',
    'T3 THREAD LIST',
    't3 acp-mcp-call fixture {}',
    't3-orchestrator thread list',
    't3 auth pairing create --json',
    't3 auth session list',
    't3 pair',
    't3 environment link https://example.org',
    't3 project list',
    't3 serve --base-dir /tmp/other',
    't3 --base-dir /tmp/other',
    't3 service restart',
    't3 up',
    't3 doctor',
    't3 update',
    '/Applications/Atum.app/Contents/Resources/work-runtime/t3 auth pairing create',
    't3',
    'codex exec "do it"',
    'codex',
    'npx @openai/codex login',
    '/usr/local/bin/codex login',
    'claude -p "do it"',
    'claude',
    'antigravity chat',
    'cat ~/.codex/auth.json',
    'cd ~/.codex && ls',
    'cp -r $HOME/.codex /tmp/x',
    'tar czf /tmp/x.tgz ~/.codex',
]


@pytest.mark.parametrize('command', BLOCKED)
def test_the_floor_blocks_every_shell_path_to_t3_and_the_plan_clients(delegated_home, command):
    assert _blocked(command), command


# Ordinary work must keep working: the rules name T3's and the makers' clients, not every word that happens to contain them.
ALLOWED = [
    'ls',
    'git status',
    'python3 -m pytest tests/test_report.py',
    'cat Reports/index.txt',
    'grep -rn "format" src',
    'echo about3 things',
    'node build.mjs --target web',
    'make test',
]


@pytest.mark.parametrize('command', ALLOWED)
def test_the_floor_does_not_get_in_the_way_of_ordinary_commands(delegated_home, command):
    assert not _blocked(command), command


# The deny rules hold with approvals OFF and with yolo ("never, even under yolo"): they are a floor under the mode.
def test_the_floor_holds_under_every_approvals_mode(tmp_path):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    for mode in ('manual', 'smart', 'off'):
        cfg = _delegated_config()
        cfg['approvals']['mode'] = mode
        (tmp_path / 'config.yaml').write_text(json.dumps(cfg))
        token = set_hermes_home_override(tmp_path)
        try:
            assert _blocked('t3 auth pairing create'), mode
            assert _blocked('codex exec x'), mode
        finally:
            reset_hermes_home_override(token)


# What a deny rule cannot close: the same macOS user. These are the gaps named in docs/work-subscriptions.md (B-0).
@pytest.mark.xfail(strict=True, reason='gap: a command assembled at run time is not a string the floor can match')
def test_gap_a_command_built_at_run_time(delegated_home):
    assert _blocked("python3 -c \"import os; os.system(chr(116)+chr(51)+' auth pairing create')\"")


@pytest.mark.xfail(strict=True, reason='gap: the file tools read any path the macOS user can; no rule covers the plan login store')
def test_gap_file_tools_can_read_the_plan_login_store(delegated_home, tmp_path):
    from tools.file_tools import read_file_tool

    store = tmp_path / 'os-home' / '.codex' / 'auth.json'
    store.parent.mkdir(parents=True)
    store.write_text('{"tokens": {"access_token": "MARKER-NOT-A-REAL-TOKEN"}}\n')

    assert 'MARKER-NOT-A-REAL-TOKEN' in store.read_text()  # the premise: it is an ordinary file the user can read
    assert 'MARKER-NOT-A-REAL-TOKEN' not in read_file_tool(str(store))
