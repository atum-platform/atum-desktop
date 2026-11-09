"""Host-delivered cron platforms: the desktop app posts to its own Matrix rooms.

The desktop backend runs no messaging gateway, so Matrix has no gateway config
and no credentials there. The host app holds the agent's room keys and posts on
its behalf through ``DesktopMatrixDelivery``. These tests drive the real
``_deliver_result`` path on a real event loop, with the real gateway config.
"""

import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import cron.scheduler as s
from cron.scheduler import _deliver_result
from gateway.config import Platform
from tui_gateway.host_delivery import DesktopMatrixDelivery

# A real run identity, as cron.executions mints it (uuid4().hex).
RUN = "9f1c2d3e4b5a46c7a8b9c0d1e2f3a4b5"
JOB = {
    "id": "brief",
    "name": "Morning brief",
    "deliver": "matrix:!room:atum.example",
    "execution_id": RUN,
}


@pytest.fixture
def running_loop():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


def _host(receipt):
    calls = []

    def request(event, payload, timeout):
        calls.append((event, payload, timeout))
        return receipt

    return DesktopMatrixDelivery(request=request), calls


def test_host_delivery_needs_no_gateway_config(running_loop):
    adapter, calls = _host(json.dumps({"status": "delivered", "event_id": "$posted"}))
    with patch("tools.send_message_tool._send_to_platform") as standalone:
        error = _deliver_result(JOB, "Good morning", adapters={Platform.MATRIX: adapter}, loop=running_loop)
    assert error is None
    standalone.assert_not_called()
    [(event, payload, timeout)] = calls
    assert event == "cron.delivery.request"
    assert payload["room_id"] == "!room:atum.example"
    assert payload["job_id"] == "brief"
    assert payload["execution_id"] == RUN, "the host keys at-most-once posting on the run"
    assert "Good morning" in payload["text"]
    assert timeout < 60, "the host answers before the scheduler's own 60 s wait"


def test_a_host_failure_is_the_delivery_error_with_no_standalone_send(running_loop):
    adapter, _ = _host(json.dumps({"status": "failed", "error": "the agent is not in this room"}))
    with patch("tools.send_message_tool._send_to_platform") as standalone:
        error = _deliver_result(JOB, "Good morning", adapters={Platform.MATRIX: adapter}, loop=running_loop)
    standalone.assert_not_called()
    assert "the agent is not in this room" in error


def test_an_absent_host_is_a_delivery_error(running_loop):
    adapter, _ = _host("")
    with patch("tools.send_message_tool._send_to_platform") as standalone:
        error = _deliver_result(JOB, "Good morning", adapters={Platform.MATRIX: adapter}, loop=running_loop)
    standalone.assert_not_called()
    assert "did not answer" in error


def test_host_delivery_without_a_running_loop_never_falls_back():
    adapter, calls = _host(json.dumps({"status": "delivered"}))
    with patch("tools.send_message_tool._send_to_platform") as standalone:
        error = _deliver_result(JOB, "Good morning", adapters={Platform.MATRIX: adapter}, loop=None)
    standalone.assert_not_called()
    assert calls == []
    assert "host delivery to matrix:!room:atum.example is unavailable" in error


def test_without_a_run_identity_the_app_is_never_asked(running_loop):
    adapter, calls = _host(json.dumps({"status": "delivered"}))
    job = {k: v for k, v in JOB.items() if k != "execution_id"}
    error = _deliver_result(job, "Good morning", adapters={Platform.MATRIX: adapter}, loop=running_loop)
    assert calls == []
    assert "no run identity" in error


def test_live_native_adapter_authorizes_an_absent_platform_block(running_loop):
    adapter = AsyncMock()
    job = dict(JOB, deliver="telegram:555")
    error = _deliver_result(job, "Good morning", adapters={Platform.TELEGRAM: adapter}, loop=running_loop)
    assert error is None
    adapter.send.assert_awaited_once()


def test_a_directly_fired_run_carries_its_execution_to_delivery(monkeypatch):
    delivered = []
    monkeypatch.setattr(s, "run_job", lambda job, **_kwargs: (True, "out", "final", None))
    monkeypatch.setattr(s, "save_job_output", lambda jid, out: f"/tmp/{jid}.txt")
    monkeypatch.setattr(s, "mark_job_run", lambda *a, **k: None)
    monkeypatch.setattr(s, "_deliver_result", lambda job, content, adapters=None, loop=None, **_kwargs: delivered.append(job))

    assert s.run_one_job({"id": "direct", "name": "t", "deliver": "matrix:!direct:atum.example"}) is True
    assert s.drain_delivery_queue({}, None) == 1
    [job] = delivered
    assert job.get("execution_id"), "an external provider's fire gets the same run identity as a tick"


@pytest.mark.parametrize(
    "receipt, success, detail",
    [
        ({"status": "delivered", "event_id": "$e"}, True, "$e"),
        ({"status": "delivered"}, True, None),
        ({"status": "failed", "error": "x" * 500}, False, "x" * 200),
        ({"status": "failed"}, False, "the Atum app did not deliver it"),
        ([], False, "the Atum app sent an unreadable receipt"),
    ],
)
def test_receipts_become_send_results(receipt, success, detail):
    adapter, _ = _host(json.dumps(receipt))
    result = asyncio.run(adapter.send("!room:atum.example", "hi", metadata={"job_id": "j", "execution_id": RUN}))
    assert result.success is success
    assert (result.message_id if success else result.error) == detail


def test_an_unreadable_receipt_is_a_failure():
    adapter, _ = _host("not json")
    result = asyncio.run(adapter.send("!room:atum.example", "hi", metadata={"job_id": "j", "execution_id": RUN}))
    assert result.success is False
    assert result.error == "the Atum app sent an unreadable receipt"


class _ConnectedHost:
    """The Atum app on the backend's live connection: posts, then answers."""

    def __init__(self, server, receipt):
        self.server = server
        self.receipt = receipt
        self.requests = []
        from tui_gateway import server_requests
        server_requests.advertise(self, True)

    def write(self, obj):
        params = obj.get("params") or {}
        if obj.get("method") == "cron.delivery.request":
            payload = {**params, "request_id": obj["id"]}
            self.requests.append(payload)
            threading.Thread(target=self._answer, args=(payload["request_id"],), daemon=True).start()
        return True

    def _answer(self, request_id):
        from tui_gateway import server_requests
        server_requests.resolve_response({"jsonrpc": "2.0", "id": request_id,
            "result": {"value": json.dumps(self.receipt)}}, self)

    def close(self):
        pass


def test_a_job_created_in_chat_posts_into_the_agents_room_end_to_end(monkeypatch):
    """The whole Hermes side, with real imports. The agent schedules a job with no
    destination in a turn the Atum app runs for a Matrix room; the desktop ticker's
    adapter asks the connected app to post it there, and its receipt is the record."""
    from cron.jobs import get_job
    from gateway.session_context import clear_session_vars, set_session_vars
    from hermes_cli.web_server import _desktop_cron_delivery
    from tools.cronjob_tools import cronjob
    from tui_gateway import server

    # As _set_session_context binds a turn whose host named its room (prompt.submit).
    tokens = set_session_vars(source="matrix", chat_id="!alfred:atum.example")
    try:
        created = json.loads(cronjob(action="create", prompt="Summarise my inbox", schedule="every 1h", name="Inbox"))
    finally:
        clear_session_vars(tokens)
    assert created.get("success") is not False, created
    job_id = created.get("job_id") or created["job"]["id"]
    job = get_job(job_id)
    assert job["origin"]["platform"] == "matrix" and job["origin"]["chat_id"] == "!alfred:atum.example"
    assert job["deliver"] == "origin"

    host = _ConnectedHost(server, {"status": "delivered", "event_id": "$inbox"})
    server.register_live_transport(host)
    adapters, loop, _profiles, stop = _desktop_cron_delivery()
    monkeypatch.setattr(s, "run_job", lambda job, **_kwargs: (True, "out", "Three new emails.", None))
    try:
        assert s.run_one_job(job, adapters=adapters, loop=loop) is True
        assert s.drain_delivery_queue(adapters, loop) == 1
    finally:
        server.unregister_live_transport(host)
        stop()
    assert loop.is_closed(), "the delivery loop is closed with the ticker"

    [request] = host.requests
    assert request["room_id"] == "!alfred:atum.example"
    assert request["job_id"] == job_id
    assert request["execution_id"], "the run identity reaches the app"
    assert "Three new emails." in request["text"]
    job = get_job(job_id)
    assert job["last_delivery_error"] is None
    assert job["last_status"] == "ok"


def test_the_agents_room_is_its_matrix_home(monkeypatch):
    """``deliver='matrix'`` and origin-less ``origin`` jobs post to the home room the
    app started the backend with."""
    monkeypatch.setenv("MATRIX_HOME_ROOM", "!alfred:atum.example")
    targets = s._resolve_delivery_targets({"id": "j", "deliver": "matrix"})
    assert [{k: row[k] for k in ("platform", "chat_id", "thread_id")} for row in targets] == [
        {"platform": "matrix", "chat_id": "!alfred:atum.example", "thread_id": None}]


def test_a_chat_without_a_deliverable_platform_is_not_an_origin():
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools.cronjob_tools import _origin_from_env

    for source, chat in (("desktop", "!alfred:atum.example"), ("tui", "!alfred:atum.example"),
                         ("", "!alfred:atum.example"), ("telegram", "555"), ("matrix", "not-a-room"),
                         ("matrix", "!room-without-server")):
        tokens = set_session_vars(source=source, chat_id=chat)
        try:
            assert _origin_from_env() is None, (source, chat)
        finally:
            clear_session_vars(tokens)
    # A gateway's own platform always wins over the source.
    tokens = set_session_vars(platform="telegram", source="matrix", chat_id="555")
    try:
        assert _origin_from_env()["platform"] == "telegram"
    finally:
        clear_session_vars(tokens)


def test_a_matrix_room_is_never_a_yuanbao_target():
    """A hosted Matrix turn binds its room as the session chat without a platform;
    Yuanbao's tools take the session chat only in a Yuanbao session."""
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools.yuanbao_tools import send_sticker

    tokens = set_session_vars(source="matrix", chat_id="!alfred:atum.example")
    try:
        result = json.loads(asyncio.run(send_sticker({"sticker": "278"})))
    finally:
        clear_session_vars(tokens)
    assert result["success"] is False
    assert "chat_id is required" in result["error"]


def test_a_group_dm_never_takes_a_hosted_matrix_chat(monkeypatch):
    """Yuanbao's DM tool reads a group from the session chat only in a Yuanbao
    session, even when a host binds a chat that looks like one."""
    import tools.yuanbao_tools as yb
    from gateway.session_context import clear_session_vars, set_session_vars

    sent = []

    class Adapter:
        async def send_dm(self, user_id, message, *, group_code=""):
            sent.append({"user_id": user_id, "message": message, "group_code": group_code})
            return SimpleNamespace(success=True, error="", message_id="m1")

    monkeypatch.setattr(yb, "_get_active_adapter", lambda: Adapter())
    for platform, expected in (("", ""), ("yuanbao", "12345")):
        sent.clear()
        tokens = set_session_vars(platform=platform, source="matrix", chat_id="group:12345")
        try:
            asyncio.run(yb.send_dm.__wrapped__({"user_id": "u1", "message": "hi"}))
        finally:
            clear_session_vars(tokens)
        assert sent[0]["group_code"] == expected, platform


def test_an_assistant_holding_google_data_posts_only_through_the_desktop(running_loop, monkeypatch):
    from agent import atum_google_fence

    monkeypatch.setenv(atum_google_fence.ROUTE_ENV, "http://127.0.0.1:43123/v1")
    monkeypatch.setenv(atum_google_fence.LATCHED_ENV, "1")

    # Another platform, however it is configured, would take the result off Atum.
    telegram = dict(JOB, deliver="telegram:12345")
    with patch("tools.send_message_tool._send_to_platform") as standalone:
        error = _deliver_result(telegram, "Lan is waiting on the quote", adapters={}, loop=running_loop)
    standalone.assert_not_called()
    assert "holds Google data" in error

    # Its own Atum chat, through the desktop, still works.
    adapter, calls = _host(json.dumps({"status": "delivered", "event_id": "$posted"}))
    assert _deliver_result(JOB, "Good morning", adapters={Platform.MATRIX: adapter}, loop=running_loop) is None
    assert len(calls) == 1


def test_google_holding_also_fences_native_bot_chat_delivery(monkeypatch):
    import cron.scheduler_delivery as delivery
    monkeypatch.setattr("agent.atum_google_fence.holding_google", lambda: True)
    with patch.object(delivery, "_deliver_to_bot_chat") as send:
        error = delivery._deliver_result({"id": "held", "deliver": "bot-chat"}, "private result")
    assert "holds Google data" in error
    send.assert_not_called()
