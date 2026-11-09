"""Live runtime HTTP lifecycle boundaries, with no provider inference."""
import asyncio
import json

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


@pytest.mark.asyncio
async def test_runtime_preserves_browser_ticket_gate(tmp_path):
    from gateway.config import GatewayConfig
    from gateway.run import GatewayRunner
    from gateway.run_runtime import (initialize_gateway_runtime, start_gateway_runtime_api,
                                     publish_gateway_runtime_ready)
    from gateway.runtime_ownership import process_ownership
    from hermes_constants import get_hermes_home
    from hermes_cli.dashboard_auth import register_provider, clear_providers
    from hermes_cli.dashboard_auth.ws_tickets import mint_ticket
    from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider

    home = get_hermes_home()
    (home / 'config.yaml').write_text('dashboard:\n  public_url: https://gateway.example.test\n')
    register_provider(StubAuthProvider())
    process_ownership.reserve([home])
    runner = GatewayRunner(GatewayConfig())
    try:
        await initialize_gateway_runtime(runner)
        from gateway.control_socket import GatewayControlServer
        runner.session_control_server = GatewayControlServer()
        assert await runner.session_control_server.start()
        await start_gateway_runtime_api(runner)
        assert await runner.start()
        publish_gateway_runtime_ready(runner)
        url = runner.session_api.api_origin.replace('http:', 'ws:') + '/api/ws'
        # Public-origin admission never bypasses credentials, and an arbitrary
        # page cannot use even a valid ticket to reach this loopback listener.
        for origin, credential in (
                ('https://hostile.example.test', None),
                ('https://hostile.example.test', 'valid'),
                ('https://gateway.example.test', None),
                ('https://gateway.example.test', 'invalid-ticket'),
                ('https://gateway.example.test:444', 'valid'),
                ('http://gateway.example.test', 'valid')):
            if credential == 'valid':
                credential = mint_ticket(user_id='browser-owner', provider='stub')
            protocols = ['hermes-gateway-v1']
            if credential:
                protocols.append('hermes-gateway-ticket.' + credential)
            with pytest.raises(InvalidStatus) as rejected:
                async with connect(url, origin=origin, subprotocols=protocols):
                    pytest.fail('unauthorized browser reached the gateway')
            assert rejected.value.response.status_code == 403
        ticket = mint_ticket(user_id='browser-owner', provider='stub')
        async with connect(url, origin='https://gateway.example.test', subprotocols=[
                'hermes-gateway-v1', 'hermes-gateway-ticket.' + ticket]) as ws:
            await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'gateway.ping'}))
            while True:
                reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
                if reply.get('id') == 1:
                    break
            assert reply['result']['ok'] is True
        # Ticket authentication remains single-use, including via the proxy.
        with pytest.raises(InvalidStatus) as replay:
            async with connect(url, origin='https://gateway.example.test', subprotocols=[
                    'hermes-gateway-v1', 'hermes-gateway-ticket.' + ticket]):
                pytest.fail('browser ticket was reusable')
        assert replay.value.response.status_code == 403
    finally:
        await runner.stop()
        await runner.session_control_server.stop()
        process_ownership.close()
        clear_providers()


@pytest.mark.asyncio
async def test_drain_withdraws_native_admission_before_listener_close(tmp_path):
    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.platforms.base import BasePlatformAdapter, SendResult
    from gateway.platforms.event import MessageEvent
    from gateway.run import GatewayRunner
    from gateway.run_runtime import initialize_gateway_runtime, drain_gateway_runtime
    from gateway.runtime_ownership import process_ownership
    from gateway.session import SessionSource
    from hermes_constants import get_hermes_home

    class LocalAdapter(BasePlatformAdapter):
        async def connect(self, *, is_reconnect=False):
            return True

        async def disconnect(self):
            pass

        async def get_chat_info(self, chat_id):
            return {'id': chat_id}

        async def send(self, *args, **kwargs):
            return SendResult(success=True)

    home = get_hermes_home()
    process_ownership.reserve([home])
    runner = GatewayRunner(GatewayConfig())
    adapter = LocalAdapter(PlatformConfig(enabled=True), Platform.TELEGRAM)
    handled = asyncio.Event()

    async def handler(event):
        handled.set()
        return 'local control'

    adapter.set_message_handler(handler)
    runner.adapters[Platform.TELEGRAM] = adapter
    source = SessionSource(platform=Platform.TELEGRAM, chat_id='owned', user_id='owned')
    try:
        await initialize_gateway_runtime(runner)
        first = MessageEvent(text='/status', source=source)
        await adapter.handle_message(first)
        await asyncio.wait_for(handled.wait(), 5)
        assert first._gateway_accepted
        await drain_gateway_runtime(runner)
        assert runner.session_runtime_descriptor['state'] == 'draining'
        later = MessageEvent(text='/status', source=SessionSource(
            platform=Platform.TELEGRAM, chat_id='another-owned-route', user_id='owned'))
        await adapter.handle_message(later)
        assert not later._gateway_accepted
    finally:
        await runner.stop()
        process_ownership.close()


@pytest.mark.asyncio
async def test_idle_retirement_after_ticket_mint_refuses_upgrade_with_http_403():
    """Force the discovery-to-upgrade race without scheduling sleeps or a provider call."""
    from gateway.config import GatewayConfig
    from gateway.run import GatewayRunner
    from gateway.run_runtime import (initialize_gateway_runtime, start_gateway_runtime_api,
                                     publish_gateway_runtime_ready)
    from gateway.runtime_ownership import process_ownership
    from hermes_constants import get_hermes_home
    from hermes_cli.gateway_client import gateway_ws_target
    from types import SimpleNamespace

    home = get_hermes_home()
    process_ownership.reserve([home])
    runner = GatewayRunner(GatewayConfig())
    try:
        await initialize_gateway_runtime(runner)
        from gateway.control_socket import GatewayControlServer
        runner.session_control_server = GatewayControlServer()
        assert await runner.session_control_server.start()
        await start_gateway_runtime_api(runner)
        assert await runner.start()
        publish_gateway_runtime_ready(runner)
        ticket = runner.session_ticket_store.mint(
            profile_id=str(home), subject='local-test', purpose='interactive')
        url, protocols = gateway_ws_target(SimpleNamespace(api_origin=runner.session_api.api_origin), ticket)
        # Idle retirement withdraws admission before closing its listener. Discovery already
        # returned ready and the ticket was minted: neither is a lease on future admission.
        runner.session_runtime_descriptor.update(state='draining', drain_reason='idle_exit')
        runner._draining = True
        with pytest.raises(InvalidStatus) as rejected:
            async with connect(url, subprotocols=protocols, proxy=None):
                pytest.fail('retiring gateway accepted a new interactive viewer')
        assert rejected.value.response.status_code == 403
    finally:
        await runner.stop()
        await runner.session_control_server.stop()
        process_ownership.close()
