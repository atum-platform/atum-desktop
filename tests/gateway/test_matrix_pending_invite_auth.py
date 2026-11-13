"""Tests for the inviter allowlist gate on pending-invite reconciliation.

``_on_invite`` only auto-joins when the inviter is allow-listed, but the
reconcile pass over sync's ``rooms.invite`` runs after event dispatch and
sees every pending invite — including ones ``_on_invite`` just rejected,
and ones that arrived while the gateway was down. An unconditional join
there re-admitted rejected live invites milliseconds later and auto-joined
arbitrary federated invites on restart. ``_schedule_pending_invite_joins``
must apply the same gate, reading the inviter from the stripped invite
state.
"""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import PlatformConfig


def _make_adapter():
    """Create a MatrixAdapter with mocked config and a one-user allowlist."""
    from plugins.platforms.matrix.adapter import MatrixAdapter

    config = PlatformConfig(
        enabled=True,
        token="syt_test_token",
        extra={
            "homeserver": "https://matrix.example.org",
            "user_id": "@hermes:example.org",
        },
    )
    adapter = MatrixAdapter(config)
    adapter._allowed_user_ids = {"@alice:example.org"}
    adapter._join_room_by_id = AsyncMock(return_value=True)
    adapter._record_dm_room = AsyncMock()
    adapter._client = MagicMock(leave_room=AsyncMock(), join_room=AsyncMock())
    return adapter


def _member_invite_event(
    state_key="@hermes:example.org",
    sender="@alice:example.org",
    is_direct=True,
    membership="invite",
):
    """Create a stripped m.room.member event as found in invite_state."""
    return {
        "type": "m.room.member",
        "state_key": state_key,
        "sender": sender,
        "content": {"membership": membership, "is_direct": is_direct},
    }


def _invite_sync_data(room_id="!pending_room:example.org", invite_state=None):
    """Create a sync payload with one pending invite room."""
    room = {} if invite_state is None else {"invite_state": invite_state}
    return {"rooms": {"invite": {room_id: room}}, "next_batch": "s1"}


async def _drain_invite_tasks(adapter):
    """Await any tasks _schedule_invite_join spawned."""
    for task in list(adapter._invite_join_tasks.values()):
        await task


class TestPendingInviteAuthorization:
    """_schedule_pending_invite_joins applies _on_invite's inviter gate.

    Rejection mirrors _on_invite: leave the invite without joining or
    recording anything in m.direct.
    """

    @pytest.mark.asyncio
    async def test_allowed_inviter_is_joined(self):
        adapter = _make_adapter()

        sync_data = _invite_sync_data(invite_state={"events": [_member_invite_event()]})
        adapter._schedule_pending_invite_joins(sync_data)
        await _drain_invite_tasks(adapter)

        adapter._join_room_by_id.assert_awaited_once_with("!pending_room:example.org")
        adapter._record_dm_room.assert_awaited_once_with(
            "!pending_room:example.org", "@alice:example.org"
        )

    @pytest.mark.parametrize(
        "invite_state",
        [
            pytest.param(
                {"events": [_member_invite_event(sender="@mallory:evil.example")]},
                id="non-allowed-inviter",
            ),
            pytest.param(None, id="no-invite-state"),
            pytest.param({"events": []}, id="empty-events"),
            pytest.param(
                {"events": [_member_invite_event(state_key="@other:example.org")]},
                id="member-event-for-other-user",
            ),
            pytest.param(
                {"events": [_member_invite_event(sender="")]},
                id="missing-inviter",
            ),
        ],
    )
    @pytest.mark.asyncio
    async def test_unauthorized_or_unknown_inviter_is_not_joined(self, invite_state):
        """An inviter outside the allowlist, or one that cannot be read
        from the stripped invite state at all, fails closed like
        _on_invite: no join is scheduled and nothing is recorded."""
        adapter = _make_adapter()

        sync_data = _invite_sync_data(invite_state=invite_state)
        adapter._schedule_pending_invite_joins(sync_data)
        await _drain_invite_tasks(adapter)

        adapter._join_room_by_id.assert_not_awaited()
        adapter._record_dm_room.assert_not_awaited()
        assert adapter._invite_join_tasks == {}
        if invite_state and invite_state.get('events') and invite_state['events'][0].get('sender') == '@mallory:evil.example':
            adapter._client.leave_room.assert_awaited_once_with("!pending_room:example.org")
        else:
            adapter._client.leave_room.assert_not_awaited()


@pytest.mark.parametrize("path", ["live", "pending"])
@pytest.mark.parametrize("is_direct", [True, False], ids=["dm", "group"])
@pytest.mark.parametrize("inviter", ["owner", "allowed", "stranger"])
@pytest.mark.asyncio
async def test_invite_membership_follows_existing_allowlist(path, is_direct, inviter, caplog):
    adapter = _make_adapter()
    owner = "@alice:example.org"
    allowed = "@bob:example.org"
    stranger = "@mallory:evil.example"
    adapter._allowed_user_ids = {owner, allowed}
    sender = {"owner": owner, "allowed": allowed, "stranger": stranger}[inviter]
    # Exercise the real join path with the existing Matrix transport double.
    del adapter._join_room_by_id
    adapter._refresh_dm_cache = AsyncMock()
    room_id = "!pending_room:example.org"
    with caplog.at_level(logging.INFO):
        if path == "live":
            await adapter._on_invite(SimpleNamespace(
                room_id=room_id, sender=sender,
                content=SimpleNamespace(is_direct=is_direct, body="private invite content"),
            ))
        else:
            adapter._schedule_pending_invite_joins(_invite_sync_data(invite_state={
                "events": [_member_invite_event(sender=sender, is_direct=is_direct)],
            }))
        await _drain_invite_tasks(adapter)

    if inviter == "stranger":
        adapter._client.leave_room.assert_awaited_once_with(room_id)
        adapter._client.join_room.assert_not_awaited()
        adapter._refresh_dm_cache.assert_not_awaited()
        adapter._record_dm_room.assert_not_awaited()
        records = [r for r in caplog.records if "invite" in r.getMessage()]
        assert len(records) == 1
        assert records[0].levelno == logging.INFO
        assert "private invite content" not in caplog.text
        assert sender not in caplog.text
    else:
        adapter._client.join_room.assert_awaited_once_with(room_id)
        adapter._client.leave_room.assert_not_awaited()
        if is_direct:
            adapter._record_dm_room.assert_awaited_once_with(room_id, sender)
        else:
            adapter._record_dm_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_live_and_pending_rejection_share_one_leave(caplog):
    adapter = _make_adapter()
    sender = "@mallory:evil.example"
    room_id = "!pending_room:example.org"
    with caplog.at_level(logging.INFO):
        await adapter._on_invite(SimpleNamespace(
            room_id=room_id, sender=sender, content=SimpleNamespace(is_direct=True),
        ))
        adapter._schedule_pending_invite_joins(_invite_sync_data(invite_state={
            "events": [_member_invite_event(sender=sender)],
        }))
        await _drain_invite_tasks(adapter)

    adapter._client.leave_room.assert_awaited_once_with(room_id)
    adapter._join_room_by_id.assert_not_awaited()
    assert len([r for r in caplog.records if "invite" in r.getMessage()]) == 1


@pytest.mark.parametrize('path', ['live', 'pending'])
@pytest.mark.parametrize('authorization', ['error', 'unknown', 'denied'])
@pytest.mark.asyncio
async def test_invite_declines_only_on_explicit_authorization_no(path, authorization, caplog):
    a = _make_adapter()
    def check(*args, **kwargs):
        if authorization == 'error':
            raise ConnectionError('authorization store unavailable')
        return False if authorization == 'denied' else None
    a._authorization_check = check
    with caplog.at_level(logging.WARNING):
        if path == 'live':
            await a._on_invite(SimpleNamespace(room_id='!pending_room:example.org', sender='@alice:example.org',
                content=SimpleNamespace(is_direct=True)))
        else:
            a._schedule_pending_invite_joins(_invite_sync_data(invite_state={'events': [_member_invite_event()]}))
        await _drain_invite_tasks(a)
    a._join_room_by_id.assert_not_awaited()
    a._record_dm_room.assert_not_awaited()
    if authorization == 'denied':
        a._client.leave_room.assert_awaited_once_with('!pending_room:example.org')
    else:
        a._client.leave_room.assert_not_awaited()
        assert 'pending' in caplog.text.lower()
