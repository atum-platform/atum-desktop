"""Offline native intake/admission presentation regressions; no external service."""
import asyncio
import hashlib
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.event import MessageEvent
from gateway.session import SessionSource
from gateway.config import Platform
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from plugins.platforms.matrix.adapter import MatrixAdapter
from plugins.platforms.matrix.intake import MatrixIntakeStore
from plugins.platforms.matrix import presentation as p


@pytest.mark.asyncio
async def test_native_connect_pending_and_downtime(tmp_path):
    token = set_hermes_home_override(str(tmp_path))
    answered, roots = [], []
    class Adapter(p.adapter_class(MatrixAdapter)):
        async def _presentation_send(self, room, content, txn, target):
            if 'io.atum.progress' in content and 'm.new_content' not in content:
                roots.append(content['m.relates_to']['m.in_reply_to']['event_id'])
            return '$effect-' + txn
    a = Adapter(PlatformConfig(enabled=True, token='fixture', extra={
        'homeserver': 'https://matrix.example.org', 'user_id': '@bot:example.org',
        'allowed_users': '@alice:example.org'}))
    def batch(*ids, token):
        return {'next_batch': token, 'rooms': {'join': {'!room:example.org': {
            'timeline': {'events': [{'event_id': i} for i in ids]}}}}}
    identity = json.dumps(['https://matrix.example.org', '@bot:example.org'])
    store = MatrixIntakeStore(tmp_path / ('intake-' + hashlib.sha256(identity.encode()).hexdigest() + '.sqlite3'))
    store.accept(batch('$pending', token='kept'))
    store.close()
    a._resolve_store_dir = lambda: tmp_path
    a._store_dir = tmp_path
    a._connect_authenticate = AsyncMock(return_value=True)
    a._acquire_platform_lock = MagicMock(return_value=True)
    a._release_platform_lock = MagicMock()
    a._encryption = False
    a._refresh_dm_cache = AsyncMock()
    a._warn_encrypted_drops = MagicMock()
    a._schedule_pending_invite_joins = MagicMock()
    a._sync_loop = AsyncMock()
    a._mark_connected = MagicMock()
    a._wire_plugin_handlers = MagicMock()
    a.gateway_runner = SimpleNamespace(session_authority=True)
    async def handler(event):
        event._on_transport_commit(SimpleNamespace(admission_id=event.message_id))
        # This is the native admission's execution seam; the initial RED must first
        # get past the real connect/intake/background-task readiness dependency.
        async with a.admission_presentation_scope(event, a._event_session_key(event), event.message_id):
            answered.append(event.message_id)
        return None
    a._message_handler = handler
    async def dispatch(data):
        for raw in data['rooms']['join']['!room:example.org']['timeline']['events']:
            e = MessageEvent(text='hello', message_id=raw['event_id'], source=SessionSource(
                platform=Platform.MATRIX, chat_id='!room:example.org', chat_type='dm', user_id='@alice:example.org'))
            await a.handle_message(e)
            tasks = list(a._session_tasks.values())
            if tasks:
                await asyncio.gather(*tasks)
    a._dispatch_sync = dispatch
    client = MagicMock()
    client.sync = AsyncMock(return_value=batch('$down1', '$down2', token='next'))
    client.api.session.close = AsyncMock()
    api = ModuleType('mautrix.api'); api.HTTPAPI = lambda **kw: client.api
    clients = ModuleType('mautrix.client'); clients.Client = lambda **kw: client
    clients.InternalEventType = SimpleNamespace(INVITE='invite')
    dispatcher = ModuleType('mautrix.client.dispatcher'); dispatcher.MembershipEventDispatcher = object
    state = ModuleType('mautrix.client.state_store'); state.MemoryStateStore = MagicMock; state.MemorySyncStore = MagicMock
    try:
        with patch.dict(sys.modules, {'mautrix.api': api, 'mautrix.client': clients,
                'mautrix.client.state_store': state, 'mautrix.client.dispatcher': dispatcher}), patch(
                'plugins.platforms.matrix.adapter._create_matrix_session', return_value=MagicMock()):
            assert await asyncio.wait_for(a.connect(), timeout=2)
        assert answered == ['$pending', '$down1', '$down2']
        assert roots == answered
    finally:
        await a.disconnect()
        if hasattr(a, '_presentation_box'):
            a._presentation_box.db.close()
        reset_hermes_home_override(token)
