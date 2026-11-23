"""Run a managed ACP handshake and scoped MCP discovery through the real SDKs."""
import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

from gateway.session_local_mcp import attach_editor_mcp, editor_mcp_scope, rebind_editor_mcp
from gateway.session_policy import LocalSessionPolicy
from tests.acp_adapter.test_gateway_sessions import ACPPeer

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_initialize_against_locked_home_never_provisions_gateway(tmp_path):
    home = tmp_path / 'profile'
    home.mkdir(mode=0o700)
    config = home / 'config.yaml'
    config.write_text('model: {provider: custom, default: fixture}\n')
    config.chmod(0o400)
    home.chmod(0o500)
    user = tmp_path / 'user'
    user.mkdir()
    env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'TEMP') if key in os.environ}
    env.update(HOME=str(user), USERPROFILE=str(user), HERMES_HOME=str(home),
               PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE='1')
    proc = await asyncio.create_subprocess_exec(sys.executable, '-m', 'acp_adapter.managed',
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE)
    peer = ACPPeer(proc)
    try:
        initial = await peer.rpc('initialize', protocolVersion=1, clientCapabilities={})
        assert initial['result']['agentCapabilities']['loadSession']
        assert not initial['result'].get('authMethods')
        refusal = await peer.rpc('session/new', cwd=str(tmp_path), mcpServers=[])
        assert refusal['error']['data']['reason'] == 'managed_gateway_not_ready'
        assert list(home.iterdir()) == [config]
        assert config.read_text() == 'model: {provider: custom, default: fixture}\n'
        assert list(user.iterdir()) == []
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except TimeoutError:
            proc.kill()
            await proc.wait()
        await peer.reader
        home.chmod(0o700)


@pytest.mark.parametrize('invalid', [False, True])
def test_delegated_profile_limits_real_stdio_registration(tmp_path, invalid):
    import hermes_yaml
    from tools.registry import registry

    home = tmp_path / 'profile'
    home.mkdir(mode=0o700)
    overlay = hermes_yaml.safe_load((ROOT / 'acp_adapter/profiles/delegated.yaml').read_text())
    if invalid:
        overlay['editor_mcp_tools']['t3-code'] = ['t3_thread_*']
    (home / 'config.yaml').write_text(json.dumps(overlay))
    script = tmp_path / 'mcp_fixture.py'
    script.write_text("""from mcp.server.mcpserver import MCPServer
server = MCPServer('fixture')

@server.tool()
def t3_thread_read() -> str:
    return 'read'

@server.tool()
def t3_thread_send() -> str:
    return 'write'

server.run()
""")
    # A different editor server would make a local marker on spawn.
    marker = tmp_path / 'unexpected'
    unknown = {
        'name': 'another-editor-service', 'command': sys.executable, 'env': [],
        'args': ['-c', f'from pathlib import Path; Path({str(marker)!r}).touch()'],
    }
    servers = [{'name': 't3-code', 'command': sys.executable, 'args': [str(script)], 'env': []}, unknown]
    authority = SimpleNamespace(profile_id=str(home), sessions={})
    policy = LocalSessionPolicy(source='acp', platform='acp', cwd=str(tmp_path), model=None,
                                toolsets=(), config_json='{}', request_json='{}', terminal_json='{}')
    restricted, changed = rebind_editor_mcp(authority, 'delegated', policy, servers)
    manifest = json.loads(restricted.editor_mcp_json)
    if invalid:
        assert not manifest['schemas']
    else:
        assert changed
        (read_name,) = manifest['schemas']
        assert read_name.endswith('__t3_thread_read')
        attach_editor_mcp(authority, restricted, servers)
        with editor_mcp_scope(authority, restricted):
            assert registry.get_schema(read_name) == manifest['schemas'][read_name]
            assert registry.get_schema(read_name.replace('__t3_thread_read', '__t3_thread_send')) is None
    assert not marker.exists()


def test_profile_disables_connections_and_title_inference_before_a_turn(tmp_path):
    import hermes_yaml

    from agent.title_generator import _auto_title_enabled
    from hermes_cli.tools_config import _get_platform_tools
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools.approval import check_all_command_guards
    from toolsets import resolve_toolset

    profile = ROOT / 'acp_adapter/profiles'
    cfg = hermes_yaml.safe_load((profile / 'self-work.yaml').read_text())
    selected = _get_platform_tools(cfg, 'acp')
    names = {tool for toolset in selected for tool in resolve_toolset(toolset)}
    disabled = {tool for toolset in cfg['agent']['disabled_toolsets'] for tool in resolve_toolset(toolset)}
    surface = names - disabled
    assert {'terminal', 'read_file', 'write_file', 'browser_exec'} <= surface
    assert 'manage_connections' not in surface
    assert 'computer_use' not in surface

    cfg.update(hermes_yaml.safe_load((profile / 'delegated.yaml').read_text()))
    assert cfg['approvals']['mode'] == 'manual'
    cfg['approvals']['mode'] = 'off'  # the deny floor still applies
    (tmp_path / 'config.yaml').write_text(json.dumps(cfg))
    token = set_hermes_home_override(tmp_path)
    try:
        assert not _auto_title_enabled()
        assert check_all_command_guards('t3 thread list', 'local')['user_deny']
        assert check_all_command_guards('t3 acp-mcp-call fixture {}', 'local')['user_deny']
    finally:
        reset_hermes_home_override(token)
