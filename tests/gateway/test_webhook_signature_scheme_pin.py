import hashlib
import hmac
import time
from types import SimpleNamespace

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.webhook import WebhookAdapter


def adapter(route):
    return WebhookAdapter(PlatformConfig(enabled=True, extra={"routes": {"canary": route}}))


def request(headers):
    return SimpleNamespace(headers=headers, match_info={"route_name": "canary"})


@pytest.mark.parametrize("header,prefix", [("X-Webhook-Signature", ""), ("linear-signature", ""), ("X-Hub-Signature-256", "sha256=")])
def test_body_only_rejects_timestamp_envelope(header, prefix):
    body = b'1700000000.{"canary":true}'
    sig = hmac.new(b"canary", body, hashlib.sha256).hexdigest()
    assert not adapter({"signature": "v1" if header == "X-Webhook-Signature" else "auto"})._validate_signature(request({header: prefix + sig}), body, "canary")


def test_v1_requires_opt_in_and_pin_refuses_other_schemes():
    body = b'{"canary":true}'
    sig = hmac.new(b"canary", body, hashlib.sha256).hexdigest()
    req = request({"X-Webhook-Signature": sig})
    assert not adapter({})._validate_signature(req, body, "canary")
    assert adapter({"signature": "v1"})._validate_signature(req, body, "canary")
    assert not adapter({"signature": "v2"})._validate_signature(req, body, "canary")
    ts = str(int(time.time()))
    v2 = hmac.new(b"canary", ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    assert adapter({"signature": "v2"})._validate_signature(request({"X-Webhook-Signature-V2": v2, "X-Webhook-Timestamp": ts}), body, "canary")


@pytest.mark.parametrize("scheme,header,prefix", [("github", "X-Hub-Signature-256", "sha256="), ("linear", "linear-signature", "")])
def test_pinned_provider_still_accepts_original_sender_key(scheme, header, prefix):
    body = b'{"canary":true}'
    sig = hmac.new(b"canary", body, hashlib.sha256).hexdigest()
    route = adapter({"signature": scheme})
    assert route._validate_signature(request({header: prefix + sig}), body, "canary")
    assert not route._validate_signature(request({header: prefix + sig, "X-Webhook-Signature": sig}), body, "canary")


def test_unknown_signature_pin_fails_closed():
    assert not adapter({"signature": "typo"})._validate_signature(request({"X-Gitlab-Token": "canary"}), b"{}", "canary")


@pytest.mark.parametrize("pin", ["typo", None, [], 42])
def test_startup_rejects_invalid_pin(pin):
    instance = adapter({"signature": pin, "secret": "canary"})
    with pytest.raises(ValueError, match="invalid signature pin"):
        instance._validate_route("canary", instance._routes["canary"])
    assert not instance._dynamic_route_allowed("canary", instance._routes["canary"])


def test_unpinned_v1_warns_once_without_signature_or_secret(caplog):
    instance = adapter({})
    for _ in range(3):
        assert not instance._validate_signature(request({"X-Webhook-Signature": "private-signature"}), b"{}", "private-secret")
    warnings = [r.message for r in caplog.records if "refused legacy V1" in r.message]
    assert len(warnings) == 1
    assert "private" not in warnings[0]
