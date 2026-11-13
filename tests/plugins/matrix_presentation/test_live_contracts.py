"""Offline contracts at the real mautrix HTTP boundary and native home persistence."""
import ast
import inspect
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from mautrix.api import HTTPAPI
from mautrix.client import Client
from mautrix.types import UserID

from gateway.config import Platform, PlatformConfig, GatewayConfig
from gateway.platforms.base import BasePlatformAdapter
from gateway.platforms.event import MessageEvent
from gateway.session import SessionSource
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from plugins.platforms.matrix.adapter import MatrixAdapter
from plugins.platforms.matrix import presentation as p


def test_real_mautrix_keyword_contracts():
    """**kwargs is HTTP forwarding, not permission to invent method keywords."""
    root = Path(__file__).resolve().parents[3]
    failures = []
    for path in [* (root / 'plugins/platforms/matrix').glob('*.py'), * (root / 'gateway').glob('*.py')]:
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            receiver = ast.unparse(node.func.value)
            if receiver not in ('self._client', 'client'):
                continue
            method = getattr(Client, node.func.attr, None)
            if method is None:  # local wrappers and version-gated compatibility methods
                continue
            # Client encryption wrappers forward to ClientAPI; follow that real MRO.
            declared = set()
            for cls in Client.__mro__:
                implementation = cls.__dict__.get(node.func.attr)
                if implementation is not None:
                    declared.update(inspect.signature(implementation).parameters)
            for kw in node.keywords:
                if kw.arg and kw.arg not in declared:
                    failures.append(f'{path.relative_to(root)}:{node.lineno}: {node.func.attr}({kw.arg}=)')
    assert not failures, '\n'.join(failures)


@pytest.mark.asyncio
@pytest.mark.parametrize('cleanup_fails', [False, True])
async def test_completion_real_client_http_boundary(tmp_path, cleanup_fails):
    writes = []
    api = HTTPAPI(base_url='https://matrix.invalid', token='fixture', client_session=SimpleNamespace())
    async def request(method, path, *args, **kwargs):
        # Validate even the stub against HTTPAPI's real declared arguments.
        inspect.signature(HTTPAPI.request).bind(api, method, path, *args, **kwargs)
        writes.append((str(path), args[0] if args else kwargs.get('content')))
        if '/redact/' in str(path) and cleanup_fails:
            raise RuntimeError('cleanup unavailable')
        return {'event_id': '$effect' + str(len(writes))}
    api.request = request
    client = Client(mxid=UserID('@bot:example.org'), api=api)
    class Base:
        async def _send_room_message(self, room, content, *, txn_id=None):
            return await self._client.send_message_event(room, 'm.room.message', content, txn_id=txn_id)
        async def send(self, chat_id, content, **kwargs):
            return await self._send_room_message(chat_id, {'msgtype': 'm.text', 'body': content}, txn_id='final')
        async def send_final_ledgered(self, event):
            return await self.send(event.source.chat_id, 'answer')
    a = p.adapter_class(Base)()
    a._client = client
    a._presentation_box = p.Outbox(tmp_path / 'outbox.db')
    a._presentation_turns = {}
    event = MessageEvent(text='hi', message_id='$source', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room:example.org', chat_type='dm', user_id='@owner:example.org'))
    try:
        async with a.admission_presentation_scope(event, 'session', 'admission'):
            turn = p._current.get()
            root = turn.root
            result = await a.send_final_ledgered(event)
        assert result
        assert writes[1][1]['body'] == 'answer'  # final BEFORE cleanup
        redactions = [w for w in writes if '/redact/' in w[0]]
        assert redactions
        from mautrix.api import Path as APIPath
        assert redactions[0] == (str(APIPath.v3.rooms[event.source.chat_id].redact[root][p.redaction_transaction(root)]), {'reason': 'Turn ended'})
        if cleanup_fails:
            assert a._presentation_box.db.execute('SELECT COUNT(*) FROM effects WHERE target IS NOT NULL AND event IS NULL').fetchone()[0] == 1
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('enabled,user,chat_type,expected', [
    (True, '@owner:example.org', 'dm', True),
    (False, '@owner:example.org', 'dm', False),
    (True, '@other:example.org', 'dm', False),
    (True, '@owner:example.org', 'group', False),
])
async def test_owner_dm_home_persists_and_suppresses_prompt(tmp_path, monkeypatch, enabled, user, chat_type, expected):
    from gateway.run_turn_prepare import GatewayTurnPrepareMixin
    from gateway.config import load_gateway_config
    token = set_hermes_home_override(str(tmp_path))
    monkeypatch.delenv('MATRIX_HOME_ROOM', raising=False)
    cfg = PlatformConfig.from_dict({'enabled': True, 'auto_home_owner_dm': enabled,
        'allowed_users': '@owner:example.org', 'homeserver': 'https://matrix.invalid', 'user_id': '@bot:example.org'})
    a = MatrixAdapter(cfg)
    gateway_cfg = GatewayConfig(platforms={Platform.MATRIX: cfg})
    a.gateway_runner = SimpleNamespace(config=gateway_cfg)
    source = SessionSource(platform=Platform.MATRIX, chat_id='!owner:example.org', chat_type=chat_type, user_id=user)
    event = MessageEvent(text='hi', message_id='$hi', source=source)
    try:
        with patch.object(BasePlatformAdapter, 'handle_message', new=AsyncMock()):
            await a.handle_message(event)
        assert bool(gateway_cfg.get_home_channel(Platform.MATRIX)) is expected
        if expected:
            restarted = load_gateway_config()
            assert restarted.get_home_channel(Platform.MATRIX).chat_id == source.chat_id
            notices = AsyncMock()
            runner = SimpleNamespace(config=restarted, _deliver_platform_notice=notices,
                async_session_store=SimpleNamespace(has_any_sessions=AsyncMock(return_value=True)))
            await GatewayTurnPrepareMixin._hmwa_first_contact_notes(runner, source, [], [])
            notices.assert_not_awaited()
            # A later owner DM must not replace the first durable home.
            source.chat_id = '!second:example.org'
            with patch.object(BasePlatformAdapter, 'handle_message', new=AsyncMock()):
                await a.handle_message(event)
            assert load_gateway_config().get_home_channel(Platform.MATRIX).chat_id == '!owner:example.org'
    finally:
        reset_hermes_home_override(token)
