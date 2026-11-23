"""Native SDK/outbox script delivery; no external accounts or model calls."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.config import PlatformConfig
from plugins.platforms.matrix.adapter import MatrixAdapter
from plugins.platforms.matrix import presentation as p


CONTENT = {'msgtype': 'm.text', 'body': 'Welcome\nhttps://example.org/#board/card',
           'm.mentions': {'user_ids': ['@owner:example.org']},
           'm.relates_to': {'rel_type': 'm.thread', 'event_id': '$thread',
                            'm.in_reply_to': {'event_id': '$thread'}, 'is_falling_back': True},
           'org.example.link': {'v': 1, 'target': 'board/card'}}


def adapter(path):
    a = p.adapter_class(MatrixAdapter)(PlatformConfig(enabled=True, token='fixture', extra={
        'homeserver': 'https://matrix.example.org', 'user_id': '@bot:example.org'}))
    a._presentation_box = p.Outbox(path)
    a._client = SimpleNamespace(mxid='@bot:example.org', device_id='DEVICE',
        api=SimpleNamespace(token='fixture', request=AsyncMock(return_value={'chunk': []})), send_message_event=AsyncMock(return_value='$observed'))
    return a


@pytest.mark.asyncio
async def test_lost_ack_reopens_receipt_without_resending_or_reauthorizing(tmp_path):
    path = tmp_path / 'presentation.sqlite3'
    a = adapter(path)
    fresh = AsyncMock(return_value=True)
    ack = AsyncMock(side_effect=ConnectionError('platform ACK lost'))
    try:
        with pytest.raises(ConnectionError):
            await a.send_structured_delivery('!room:example.org', CONTENT, 'platform-intent-1',
                revalidate=fresh, acknowledge=ack)
        a._client.send_message_event.assert_awaited_once()
        args, kwargs = a._client.send_message_event.call_args
        assert str(args[0]) == '!room:example.org' and args[2] == CONTENT
        assert kwargs['txn_id'] == 'platform-intent-1'
        ack.assert_awaited_once_with('$observed')
    finally:
        a._presentation_box.db.close()
    a = adapter(path)
    ack = AsyncMock()
    try:
        result = await a.send_structured_delivery('!room:example.org', CONTENT, 'platform-intent-1',
            revalidate=AsyncMock(side_effect=AssertionError('must not resend')), acknowledge=ack)
        assert result.success and result.message_id == '$observed'
        a._client.send_message_event.assert_not_awaited()
        ack.assert_awaited_once_with('$observed')
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_ambiguous_send_retries_exact_frozen_wire_after_freshness_check(tmp_path):
    a = adapter(tmp_path / 'box.sqlite3')
    writes, events = [], {}
    async def send(room, event_type, content, *, txn_id):
        writes.append((str(room), content, txn_id))
        events.setdefault(txn_id, '$observed')
        if len(writes) == 1:
            raise ConnectionError('Matrix accepted, response lost')
        return events[txn_id]
    a._client.send_message_event.side_effect = send
    ack, fresh = AsyncMock(), AsyncMock(return_value=True)
    try:
        with pytest.raises(ConnectionError):
            await a.send_structured_delivery('!room:example.org', CONTENT, 'external-txn',
                revalidate=fresh, acknowledge=ack)
        ack.assert_not_awaited()
        # Boot cleanup cannot replay a possibly stale scheduled original.
        await a._presentation_box.recover(a._presentation_send)
        assert len(writes) == 1
        with pytest.raises(ValueError, match='no longer authorized'):
            await a.send_structured_delivery('!room:example.org', CONTENT, 'external-txn',
                revalidate=AsyncMock(return_value=False), acknowledge=ack)
        assert len(writes) == 1
        await a.send_structured_delivery('!room:example.org', CONTENT, 'external-txn',
            revalidate=fresh, acknowledge=ack)
        assert writes[0] == writes[1] and len(events) == 1
        assert fresh.await_count == 2
        ack.assert_awaited_once_with('$observed')
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_room_search_recovers_lost_send_without_another_put(tmp_path):
    a = adapter(tmp_path / 'box.sqlite3')
    a._client.send_message_event.side_effect = ConnectionError('accepted but reply lost')
    fresh, ack = AsyncMock(return_value=True), AsyncMock()
    room = '!room:example.org'
    try:
        with pytest.raises(ConnectionError):
            await a.send_structured_delivery(room, CONTENT, 'receipt', revalidate=fresh, acknowledge=ack)
        a._client.api.request.return_value = {'chunk': [
            {'sender': '@other:example.org', 'event_id': '$other',
             'unsigned': {'transaction_id': 'receipt'}},
            {'sender': str(a._client.mxid), 'event_id': '$accepted',
             'unsigned': {'transaction_id': 'receipt'}},
        ]}
        result = await a.send_structured_delivery(room, CONTENT, 'receipt', revalidate=fresh, acknowledge=ack)
        assert result.message_id == '$accepted'
        a._client.send_message_event.assert_awaited_once()
        a._client.api.request.assert_awaited_once()
        ack.assert_awaited_once_with('$accepted')
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_encrypted_retry_shares_keys_and_keeps_wire_transaction(tmp_path):
    a = adapter(tmp_path / 'box.sqlite3')
    a._encryption = True
    a._client.crypto = SimpleNamespace(share_keys=AsyncMock())
    a._client.send_message_event.side_effect = [ConnectionError('needs key share'), '$observed']
    try:
        result = await a.send_structured_delivery('!room:example.org', CONTENT, 'encrypted-txn',
            revalidate=AsyncMock(return_value=True), acknowledge=AsyncMock())
        assert result.message_id == '$observed'
        a._client.crypto.share_keys.assert_awaited_once()
        first, second = a._client.send_message_event.await_args_list
        assert first == second
        assert first.kwargs['txn_id'] == 'encrypted-txn'
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_one_event_limit_checks_utf8_and_formatting(tmp_path):
    a = adapter(tmp_path / 'box.sqlite3')
    try:
        with pytest.raises(ValueError, match='byte budget'):
            await a.send_structured_delivery('!room:example.org',
                {**CONTENT, 'formatted_body': '現' * 20_000}, 'too-large',
                revalidate=AsyncMock(return_value=True), acknowledge=AsyncMock())
        a._client.send_message_event.assert_not_awaited()
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['body', 'room', 'device', 'token', 'sender'])
async def test_identity_collision_requires_reconciliation(tmp_path, change):
    a = adapter(tmp_path / 'box.sqlite3')
    kwargs = {'revalidate': AsyncMock(return_value=True), 'acknowledge': AsyncMock()}
    try:
        await a.send_structured_delivery('!room:example.org', CONTENT, 'same-txn', **kwargs)
        body, room = dict(CONTENT), '!room:example.org'
        if change == 'body':
            body['body'] = 'Changed'
        elif change == 'room':
            room = '!different:example.org'
        elif change == 'device':
            a._client.device_id = 'NEW_DEVICE'
        elif change == 'token':
            a._client.api.token = 'rotated'
        else:
            a._client.mxid = '@other:example.org'
        with pytest.raises(ValueError, match='reconcile'):
            await a.send_structured_delivery(room, body, 'same-txn', **kwargs)
        assert a._client.send_message_event.await_count == 1
        assert kwargs['acknowledge'].await_count == 1
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_cancelled_before_send_and_cosmetic_payload_never_ack(tmp_path):
    a = adapter(tmp_path / 'box.sqlite3')
    ack = AsyncMock()
    try:
        with pytest.raises(ValueError, match='no longer authorized'):
            await a.send_structured_delivery('!room:example.org', CONTENT, 'cancelled',
                revalidate=AsyncMock(return_value=False), acknowledge=ack)
        with pytest.raises(ValueError, match='structured text'):
            await a.send_structured_delivery('!room:example.org',
                {**CONTENT, 'io.atum.pet': {'v': 1, 'intents': [{'action': 'wave'}]}}, 'cron-pet',
                revalidate=AsyncMock(return_value=True), acknowledge=ack)
        await a._presentation_box.recover(a._presentation_send)
        a._client.send_message_event.assert_not_awaited()
        ack.assert_not_awaited()
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_rotation_while_revalidating_cannot_dispatch_on_new_session(tmp_path):
    a = adapter(tmp_path / 'box.sqlite3')
    ack = AsyncMock()
    async def revalidate():
        a._client.api.token = 'rotated-during-check'
        return True
    try:
        with pytest.raises(ValueError, match='reconcile'):
            await a.send_structured_delivery('!room:example.org', CONTENT, 'rotate',
                revalidate=revalidate, acknowledge=ack)
        a._client.send_message_event.assert_not_awaited()
        ack.assert_not_awaited()
    finally:
        a._presentation_box.db.close()


def test_native_script_job_delivery_ack_round_trip(tmp_path, monkeypatch):
    """The actual no_agent subprocess imports and uses the native adapter/outbox.

    Fixture script stands in for a private plugin consumer; no public company API.
    Its own delivery uses deliver=local so cron never sends stdout a second time.
    """
    from cron.scheduler import run_job
    from hermes_constants import get_hermes_home
    scripts = get_hermes_home() / 'scripts'
    scripts.mkdir(parents=True, exist_ok=True)
    output = tmp_path / 'receipt.json'
    script = scripts / 'structured_fixture.py'
    root = str(Path(__file__).resolve().parents[3])
    script.write_text(f'''import sys
sys.path.insert(0, {root!r})
import asyncio, json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from gateway.config import PlatformConfig
from plugins.platforms.matrix.adapter import MatrixAdapter
from plugins.platforms.matrix.presentation import Outbox, adapter_class
async def main():
    a = adapter_class(MatrixAdapter)(PlatformConfig(enabled=True, token='fixture', extra={{
        'homeserver': 'https://matrix.example.org', 'user_id': '@bot:example.org'}}))
    a._presentation_box = Outbox({str(tmp_path / 'script-box.sqlite3')!r})
    a._client = SimpleNamespace(mxid='@bot:example.org', device_id='D',
        api=SimpleNamespace(token='fixture'), send_message_event=AsyncMock(return_value='$script'))
    async def ack(event):
        with open({str(output)!r}, 'w') as f:
            json.dump({{'event_id': event, 'txn': a._client.send_message_event.call_args.kwargs['txn_id'],
                       'content': a._client.send_message_event.call_args.args[2]}}, f)
    try:
        await a.send_structured_delivery('!room:example.org', {CONTENT!r}, 'script-work-1',
            revalidate=AsyncMock(return_value=True), acknowledge=ack)
    finally:
        a._presentation_box.db.close()
asyncio.run(main())
''')
    success, _doc, text, error = run_job({'id': 'script', 'name': 'Fixture', 'no_agent': True,
        'script': str(script), 'deliver': 'local', 'interpreter': sys.executable})
    assert success, error
    assert output.exists(), text
    assert json.loads(output.read_text()) == {'event_id': '$script', 'txn': 'script-work-1', 'content': CONTENT}


@pytest.mark.asyncio
async def test_native_sdk_keeps_device_and_recovers_event_after_reconnect(tmp_path):
    """The token's whoami device and transaction path come from the real Matrix SDK."""
    from aiohttp import web
    from mautrix.api import HTTPAPI
    from mautrix.client import Client

    transactions = []
    async def whoami(request):
        assert request.headers['Authorization'] == 'Bearer fixture'
        return web.json_response({'user_id': '@bot:example.org', 'device_id': 'STABLE'})

    async def put(request):
        transactions.append(request.match_info['txn'])
        assert await request.json() == CONTENT
        return web.json_response({'event_id': '$wire'})

    async def messages(request):
        return web.json_response({'chunk': [
            {'sender': '@bot:example.org', 'event_id': '$wire',
             'unsigned': {'transaction_id': 'same-on-wire'}},
        ]})

    app = web.Application()
    app.router.add_get('/_matrix/client/v3/account/whoami', whoami)
    app.router.add_put('/_matrix/client/v3/rooms/{room}/send/{event_type}/{txn}', put)
    app.router.add_get('/_matrix/client/v3/rooms/{room}/messages', messages)
    runner = web.AppRunner(app)
    await runner.setup()
    try:
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        [(host, port)] = runner.addresses
        path = tmp_path / 'outbox.sqlite3'
        for restart in (False, True):
            a = adapter(path)
            api = HTTPAPI(f'http://{host}:{port}', default_retry_count=0)
            try:
                a._client = Client(api=api)
                assert await a._connect_authenticate(a._client, api)
                assert a._client.device_id == 'STABLE'
                ack = AsyncMock()
                result = await a.send_structured_delivery('!room:example.org', CONTENT, 'same-on-wire',
                    revalidate=AsyncMock(return_value=True), acknowledge=ack)
                assert result.message_id == '$wire'
                ack.assert_awaited_once_with('$wire')
                if not restart:
                    # Simulate a crash after the homeserver accepted the write but before the
                    # event ID committed, then reopen the same outbox with a fresh SDK client.
                    a._presentation_box.db.execute('UPDATE effects SET event=NULL')
                    a._presentation_box.db.commit()
            finally:
                await api.session.close()
                a._presentation_box.db.close()
    finally:
        await runner.cleanup()
    assert transactions == ['same-on-wire']
