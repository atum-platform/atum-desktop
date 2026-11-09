"""Every owner dial (viewer, worker RPC, A2A forward, bot delivery, Ink bootstrap) builds the same target."""
import asyncio
import json
from http import HTTPStatus
from types import SimpleNamespace

import pytest
from websockets.asyncio.server import serve

from hermes_cli.gateway_client import GATEWAY_WS_PROTOCOL, gateway_ws_target


def test_gateway_ws_target_maps_scheme_and_carries_one_ticket_protocol():
    assert gateway_ws_target(SimpleNamespace(api_origin='http://127.0.0.1:9'), 't1') == (
        'ws://127.0.0.1:9/api/ws', [GATEWAY_WS_PROTOCOL, 'hermes-gateway-ticket.t1'])
    url, protocols = gateway_ws_target(SimpleNamespace(api_origin='https://owner.local'), 't2')
    assert url == 'wss://owner.local/api/ws' and protocols[0] == 'hermes-gateway-v1'


@pytest.mark.asyncio
@pytest.mark.parametrize('status,retirement,recover,retire_again', [
    (403, 'idle_exit', True, False), (403, 'operator_stop', False, False),
    (500, 'idle_exit', False, False), (403, 'idle_exit', False, True),
])
async def test_upgrade_recovers_only_confirmed_idle_retirement(monkeypatch, status, retirement, recover, retire_again):
    """Real refused TCP upgrades; a replacement is dialed before any application RPC is sent."""
    from hermes_cli import gateway_client, gateway_runtime
    from hermes_cli.gateway_client import GatewayClientError

    requests = []
    ensures = []

    async def refuse(connection, request):
        return connection.respond(HTTPStatus(status), 'private remote diagnostics')

    async def owner(ws):
        async for raw in ws:
            frame = json.loads(raw)
            requests.append(frame)
            await ws.send(json.dumps({'id': frame['id'], 'result': {'ok': True}}))

    async with serve(owner, '127.0.0.1', 0, process_request=refuse) as old:
        async with serve(owner, '127.0.0.1', 0, subprotocols=[GATEWAY_WS_PROTOCOL]) as new:
            endpoints = [SimpleNamespace(api_origin=f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}')
                         for server in (old, new)]

            if retire_again:
                endpoints[1] = endpoints[0]

            def ensure(*args, **kwargs):
                ensures.append(True)
                return SimpleNamespace(state='ready', endpoint=endpoints[min(len(ensures) - 1, 1)])

            monkeypatch.setattr(gateway_runtime, 'ensure_gateway_runtime', ensure)
            monkeypatch.setattr(gateway_runtime, 'attachable', lambda result: result.state == 'ready')
            monkeypatch.setattr(gateway_runtime, 'discover_gateway_endpoint', lambda home: SimpleNamespace(
                state='draining', reason_code=retirement))
            monkeypatch.setattr(gateway_client, '_session_ticket', lambda *args, **kwargs: 'private-ticket')

            async def dial():
                async with gateway_client.connect_gateway() as client:
                    return await client.rpc('ping')

            if recover:
                assert await asyncio.wait_for(dial(), 10) == {'ok': True}
                assert len(ensures) == 2
                assert [frame['method'] for frame in requests] == ['ping']
            else:
                with pytest.raises(GatewayClientError, match=f'HTTP {status}') as caught:
                    await asyncio.wait_for(dial(), 10)
                assert 'private' not in str(caught.value)
                assert len(ensures) == (2 if retire_again else 1) and requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize('pinned', [False, True])
async def test_refused_explicit_target_never_starts_local_owner(monkeypatch, pinned):
    from hermes_cli import gateway_client, gateway_runtime

    async def refuse(connection, request):
        return connection.respond(HTTPStatus.FORBIDDEN, 'private diagnostics')

    def forbidden(*args, **kwargs):
        pytest.fail('explicit target invoked local lifecycle or retirement discovery')

    monkeypatch.setattr(gateway_runtime, 'ensure_gateway_runtime', forbidden)
    monkeypatch.setattr(gateway_runtime, 'discover_gateway_endpoint', forbidden)
    monkeypatch.setattr(gateway_client, '_session_ticket', lambda *args, **kwargs: 'private-ticket')
    async with serve(lambda ws: None, '127.0.0.1', 0, process_request=refuse) as server:
        origin = f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}'
        endpoint = SimpleNamespace(api_origin=origin) if pinned else None
        if not pinned:
            monkeypatch.setenv('HERMES_TUI_GATEWAY_URL', origin.replace('http:', 'ws:') + '/api/ws')
        with pytest.raises(gateway_client.GatewayClientError, match='HTTP 403'):
            async with gateway_client.connect_gateway(endpoint):
                pytest.fail('refused upgrade yielded a client')
