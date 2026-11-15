"""Typed approvals accept canonical Unicode equivalents as whole replies."""

import asyncio
import unicodedata
from unittest.mock import AsyncMock

import pytest

from agent import i18n
from gateway.platforms.event import MessageEvent
from gateway.run_busy import GatewayBusySessionMixin, approval_input_words
from gateway.run_inbound import GatewayInboundMixin


@pytest.fixture(autouse=True)
def vietnamese(monkeypatch):
    monkeypatch.setenv("HERMES_LANGUAGE", "vi")
    i18n.reset_language_cache()
    yield
    i18n.reset_language_cache()


@pytest.mark.parametrize("reply, verb, args", [
    ("đồng ý", "approve", ""), ("không", "deny", ""),
    ("hủy", "deny", ""), ("huỷ", "deny", ""),
    ("luôn", "approve", "always"), ("phiên", "approve", "session"),
    ("YES", "approve", ""), ("deny", "deny", ""),
    ("always", "approve", "always"), ("session", "approve", "session"),
])
def test_busy_reply_routes_nfd_whole_message(monkeypatch, reply, verb, args):
    runner = GatewayBusySessionMixin()
    monkeypatch.setattr("tools.approval.has_blocking_approval", lambda _: True)
    runner._handle_approve_command = AsyncMock(return_value=None)
    runner._handle_deny_command = AsyncMock(return_value=None)
    runner._delivery_adapter_for = lambda _: None
    event = MessageEvent(text="  " + unicodedata.normalize("NFD", reply) + "  ")

    assert asyncio.run(runner._route_plaintext_approval_while_busy(event, "session"))
    handler = runner._handle_approve_command if verb == "approve" else runner._handle_deny_command
    handler.assert_awaited_once_with(event)
    assert event.text == f"/{verb} {args}".rstrip()


def test_busy_sentence_does_not_act(monkeypatch):
    runner = GatewayBusySessionMixin()
    monkeypatch.setattr("tools.approval.has_blocking_approval", lambda _: True)
    event = MessageEvent(text=unicodedata.normalize("NFD", "tôi không đồng ý"))
    assert not asyncio.run(runner._route_plaintext_approval_while_busy(event, "session"))
    assert event.text == unicodedata.normalize("NFD", "tôi không đồng ý")


@pytest.mark.parametrize("reply, choice", [
    ("đồng ý", "once"), ("không", "cancel"), ("hủy", "cancel"),
    ("huỷ", "cancel"), ("!luôn", "always"), ("/confirm", "once"),
    ("YES", "once"), ("no", "cancel"), ("always", "always"),
    ("tôi không đồng ý", None), ("/ đồng ý", None),
])
def test_slash_confirm_nfd_reply(monkeypatch, reply, choice):
    from tools import slash_confirm

    monkeypatch.setattr(slash_confirm, "get_pending", lambda _: {"confirm_id": "id"})
    monkeypatch.setattr("tools.approval.has_blocking_approval", lambda _: False)
    resolve = AsyncMock(return_value="resolved")
    monkeypatch.setattr(slash_confirm, "resolve", resolve)
    monkeypatch.setattr(slash_confirm, "clear_if_stale", lambda _: None)
    event = MessageEvent(text=unicodedata.normalize("NFD", reply))
    result = asyncio.run(GatewayInboundMixin()._hm_slash_confirm_reply(event, "session"))
    if choice is None:
        assert result is None
        resolve.assert_not_awaited()
    else:
        assert result == "resolved"
        resolve.assert_awaited_once_with("session", "id", choice)


def test_catalog_words_are_normalized_and_deduplicated(monkeypatch):
    reply = "đồng ý"
    decomposed = unicodedata.normalize("NFD", reply.upper())
    monkeypatch.setattr("gateway.run_busy.t", lambda *a, **kw: f" {decomposed} ,{reply}")
    assert approval_input_words("approve") == (reply,)
