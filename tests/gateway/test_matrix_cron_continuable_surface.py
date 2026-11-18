"""Cron delivery and Matrix replies must converge on the same native session."""

import asyncio
from threading import Event, Thread
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cron.scheduler_delivery import _deliver_result
from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.session import SessionStore, build_session_key
from hermes_constants import get_hermes_home
from plugins.platforms.matrix.adapter import MatrixAdapter

ROOM = "!brief:example.org"
OWNER = "@owner:example.org"
BRIEF = "There are three appointments today."


@pytest.fixture
def delivery(tmp_path, monkeypatch):
    import hermes_state
    import hermes_state_registry

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    loop = asyncio.new_event_loop()
    ready = Event()
    loop.call_soon(ready.set)
    thread = Thread(target=loop.run_forever)
    thread.start()
    assert ready.wait(timeout=10)
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join()
    loop.close()
    hermes_state_registry.close_all_under(tmp_path)


def _setup(monkeypatch, *, surface, is_dm, extra=None):
    settings = {"user_id": "@hermes:example.org", "require_mention": False}
    settings.update(extra or {})
    if surface is not None:
        settings["cron_continuable_surface"] = surface
    pconfig = PlatformConfig(enabled=True, extra=settings)
    config = GatewayConfig(platforms={Platform.MATRIX: pconfig})
    adapter = MatrixAdapter(pconfig)
    adapter._client = object()  # connected; only the transport is replaced
    adapter._dm_rooms[ROOM] = is_dm
    adapter._resolve_room_identity = AsyncMock(return_value=SimpleNamespace(
        display_name="Brief room", room_topic=None, server_name="example.org",
        chat_type="dm" if is_dm else "room"))
    adapter._get_display_name = AsyncMock(return_value="Owner")
    adapter._background_read_receipt = lambda *args: None
    adapter._send_room_message = AsyncMock(side_effect=["$brief", "$body"])
    adapter.set_session_store(SessionStore(
        sessions_dir=get_hermes_home() / "sessions", config=config))
    monkeypatch.setattr("gateway.config.load_gateway_config", lambda: config)
    monkeypatch.setattr("cron.scheduler.load_config", lambda: {"cron": {"wrap_response": False}})
    return adapter


def _deliver(adapter, loop, *, is_dm, origin_thread=None, attach=True):
    job = {
        "id": "morning-brief", "name": "Hoi tham", "deliver": "origin",
        "attach_to_session": attach,
        "origin": {"platform": "matrix", "chat_id": ROOM, "user_id": OWNER,
                   "chat_type": "dm" if is_dm else "group", "thread_id": origin_thread},
    }
    assert _deliver_result(job, BRIEF, adapters={Platform.MATRIX: adapter}, loop=loop) is None
    return [call.args[1] for call in adapter._send_room_message.await_args_list]


def _reply(adapter, loop, *, thread_id=None, sender=OWNER):
    async def receive():
        adapter.handle_message = AsyncMock()
        adapter._text_batch_delay_seconds = 0
        relation = {"rel_type": "m.thread", "event_id": thread_id} if thread_id else {}
        await adapter._handle_text_message(
            ROOM, sender, "$reply", 0, {"body": "Tell me about those appointments"}, relation)
        adapter.handle_message.assert_awaited_once()
        return adapter.handle_message.await_args.args[0].source
    return asyncio.run_coroutine_threadsafe(receive(), loop).result(timeout=10)


def _assert_continues(adapter, source):
    store = adapter._session_store
    entry = store.get_or_create_session(source)
    transcript = store.load_transcript(entry.session_id)
    assert any(BRIEF in message["content"] for message in transcript)
    return entry


@pytest.mark.parametrize("is_dm", [True, False], ids=["dm", "group"])
@pytest.mark.parametrize("attach", [True, False], ids=["attached", "unattached"])
@pytest.mark.parametrize("origin_thread", [None, "$old"])
def test_inchannel_brief_and_plain_reply_share_session(
        delivery, monkeypatch, is_dm, attach, origin_thread):
    adapter = _setup(monkeypatch, surface="in_channel", is_dm=is_dm)
    messages = _deliver(adapter, delivery, is_dm=is_dm, origin_thread=origin_thread, attach=attach)
    assert len(messages) == 1
    assert messages[0]["body"] == BRIEF
    assert not messages[0].get("m.relates_to")
    source = _reply(adapter, delivery)
    assert source.chat_type == ("dm" if is_dm else "group")
    assert source.thread_id is None
    entry = _assert_continues(adapter, source)
    if not is_dm:
        other = _reply(adapter, delivery, sender="@other:example.org")
        assert build_session_key(other) != build_session_key(source)
        assert adapter._session_store.get_or_create_session(other).session_id != entry.session_id
    # Explicit replies to the brief still use the companion thread seed.
    threaded = _reply(adapter, delivery, thread_id="$brief")
    assert threaded.thread_id == "$brief"
    _assert_continues(adapter, threaded)


@pytest.mark.parametrize("surface", [None, "thread", "invalid"])
@pytest.mark.parametrize("is_dm", [True, False], ids=["dm", "group"])
def test_default_thread_delivery_remains_continuable(delivery, monkeypatch, surface, is_dm):
    adapter = _setup(monkeypatch, surface=surface, is_dm=is_dm)
    messages = _deliver(adapter, delivery, is_dm=is_dm)
    assert messages[0]["body"] == "Hermes — Hoi tham"
    assert messages[1]["body"] == BRIEF
    assert messages[1]["m.relates_to"]["event_id"] == "$brief"
    _assert_continues(adapter, _reply(adapter, delivery, thread_id="$brief"))
    plain = _reply(adapter, delivery)
    assert plain.thread_id == (None if is_dm else "$reply")


def test_inchannel_overrides_synthetic_dm_threads(delivery, monkeypatch):
    monkeypatch.setenv("MATRIX_DM_AUTO_THREAD", "true")
    adapter = _setup(monkeypatch, surface="in_channel", is_dm=True,
                     extra={"dm_mention_threads": True})
    _deliver(adapter, delivery, is_dm=True)
    source = _reply(adapter, delivery)
    assert source.thread_id is None
    _assert_continues(adapter, source)
