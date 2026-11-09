import json

import pytest

from tools import desktop_ui
from tools.atum_mac_tool import ATUM_MAC_SCHEMA, atum_mac, available
from tools.atum_source_policy import POLICY_ENV
from tools.registry import registry
from toolsets import get_toolset

USAGE = "paraphrase only; never quote; never store others' words or private details"


def _host(monkeypatch, receipt):
    calls = []
    monkeypatch.setattr(
        desktop_ui,
        "request",
        lambda event, payload, timeout: (
            calls.append((event, payload, timeout)) or receipt
        ),
    )
    return calls


def test_conversations_uses_exact_bounded_host_request(monkeypatch):
    response = {
        "conversations": [
            {
                "id": "1",
                "title": "Family plans",
                "participants": [{"handle": "Contact 12ab34"}],
                "isGroup": False,
                "lastActivity": "2026-10-27T12:00:00.000Z",
                "messageCount": 8,
                "fromMeShare": 0.5,
            }
        ],
        "usage": USAGE,
    }
    calls = _host(monkeypatch, json.dumps(response))

    assert json.loads(atum_mac("messages.conversations", days=365, limit=40)) == response
    assert calls == [
        (
            "atum.mac.request",
            {"op": "messages.conversations", "days": 365, "limit": 40},
            60,
        )
    ]


def test_message_read_requires_usage_and_rejects_otp_output(monkeypatch):
    response = {
        "messages": [
            {
                "fromMe": False,
                "sender": "Contact 12ab34",
                "at": "2026-10-27T12:00:00.000Z",
                "text": "Dinner is usually on Sunday.",
            }
        ],
        "usage": USAGE,
        "omittedAttributedBodies": 2,
    }
    _host(monkeypatch, json.dumps(response))
    assert json.loads(atum_mac("messages.read", conversation_id="1")) == response

    response["messages"][0]["text"] = "Your verification code is 123456"
    _host(monkeypatch, json.dumps(response))
    assert json.loads(atum_mac("messages.read", conversation_id="1")) == {
        "error": "unavailable"
    }


@pytest.mark.parametrize(
    "text",
    [
        "G-123456",
        "123 456",
        "123-456",
        "Mã OTP của bạn là 123456",
        "Your code: 4 8 2 9 1 7",
        "Email friend@example.test",
        "Call 090.123.4567",
        "Call +84 90 123 4567",
        "Call (028) 3823 4567",
        "Call 090/123/4567",
        "Open https://id.example.test/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW5oIn0.xQqN3LJd7f0fBgKx5Qs2gQ",
        "Open https://id.example.test/invite/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
        "Open https://id.example.test/reset/ZyXwVuTsRqPoNmLkJiHgFeDcBa987654",
        "Open https://files.example.test/share/abc123def456abc123def456abc123",
        "Open https://files.example.test/download/0123456789abcdef0123456789abcdef",
        "Open https://id.example.test/p/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW5oIn0.xQqN3LJd7f0fBgKx5Qs2gQ",
        "Open https://bucket.s3.example.test/report.pdf?X-Amz-Credential=private&X-Amz-Signature=0123456789abcdef0123456789abcdef",
        "Open https://app.example.test/callback#access_token=private",
        "Open https://app.example.test/callback?code=private",
    ],
)
def test_message_host_boundary_rejects_otp_pii_and_private_links(monkeypatch, text):
    response = {
        "messages": [
            {
                "fromMe": False,
                "sender": "Contact 12ab34",
                "at": "2026-10-27T12:00:00.000Z",
                "text": text,
            }
        ],
        "usage": USAGE,
        "omittedAttributedBodies": 0,
    }
    _host(monkeypatch, json.dumps(response))

    assert json.loads(atum_mac("messages.read", conversation_id="1")) == {
        "error": "unavailable"
    }


def test_browser_output_never_accepts_full_or_sensitive_urls(monkeypatch):
    response = {
        "history": [
            {
                "browser": "chrome",
                "title": "Work tools",
                "domain": "work.example.test",
                "path": "/tools",
                "lastVisit": "2026-10-27T12:00:00.000Z",
                "visits": 15,
            }
        ]
    }
    _host(monkeypatch, json.dumps(response))
    assert json.loads(
        atum_mac("browser.history", browser="all", days=30, limit=100, mode="top")
    ) == response

    for bad_path in ("/tools?query=secret", "/oauth/token"):
        response["history"][0]["path"] = bad_path
        _host(monkeypatch, json.dumps(response))
        assert json.loads(atum_mac("browser.history")) == {"error": "unavailable"}


@pytest.mark.parametrize(
    "bad_path",
    [
        "/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW5oIn0.xQqN3LJd7f0fBgKx5Qs2gQ",
        "/invite/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
        "/reset/ZyXwVuTsRqPoNmLkJiHgFeDcBa987654",
        "/share/abc123def456abc123def456abc123",
        "/download/0123456789abcdef0123456789abcdef",
        "/p/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW5oIn0.xQqN3LJd7f0fBgKx5Qs2gQ",
        "/report.pdf?X-Amz-Credential=private&X-Amz-Signature=0123456789abcdef0123456789abcdef",
        "/callback#access_token=private",
        "/callback?code=private",
    ],
)
def test_browser_host_boundary_rejects_hostile_paths(monkeypatch, bad_path):
    response = {
        "history": [
            {
                "browser": "chrome",
                "title": "Page",
                "domain": "work.example.test",
                "path": bad_path,
                "lastVisit": "2026-10-27T12:00:00.000Z",
                "visits": 1,
            }
        ]
    }
    _host(monkeypatch, json.dumps(response))

    assert json.loads(atum_mac("browser.history")) == {"error": "unavailable"}


def test_browser_title_check_keeps_normal_code_and_passport_titles(monkeypatch):
    response = {
        "history": [
            {
                "browser": "chrome",
                "title": title,
                "domain": "docs.example.test",
                "path": path,
                "lastVisit": "2026-10-27T12:00:00.000Z",
                "visits": 1,
            }
            for title, path in (("VS Code tips", "/editor"), ("Passport guide", "/travel"))
        ]
    }
    _host(monkeypatch, json.dumps(response))

    assert json.loads(atum_mac("browser.history")) == response

    response["history"][0]["title"] = "Reset password"
    _host(monkeypatch, json.dumps(response))
    assert json.loads(atum_mac("browser.history")) == {"error": "unavailable"}


def test_location_is_city_by_default_and_precise_requires_coordinates(monkeypatch):
    city = {
        "city": "Ho Chi Minh City",
        "region": "Ho Chi Minh",
        "country": "VN",
        "timeZone": "Asia/Ho_Chi_Minh",
    }
    calls = _host(monkeypatch, json.dumps(city))
    assert json.loads(atum_mac("location.current")) == city
    assert calls == [
        ("atum.mac.request", {"op": "location.current", "precision": "city"}, 60)
    ]

    _host(monkeypatch, json.dumps(city))
    assert json.loads(atum_mac("location.current", precision="precise")) == {
        "error": "unavailable"
    }


@pytest.mark.parametrize(
    "response",
    [
        {"error": "disabled"},
        {"error": "unavailable"},
        {"error": "permission_needed", "permission": "full_disk"},
        {"error": "permission_needed", "permission": "location"},
    ],
)
def test_closed_host_errors_are_preserved(monkeypatch, response):
    _host(monkeypatch, json.dumps(response))
    assert json.loads(atum_mac("location.current")) == response


@pytest.mark.parametrize(
    "kwargs",
    [
        {"op": "messages.conversations", "days": 366},
        {"op": "messages.read", "conversation_id": "other"},
        {"op": "messages.read", "conversation_id": "1", "limit": 61},
        {"op": "browser.history", "browser": "firefox"},
        {"op": "browser.history", "browser": ["all"]},
        {"op": "browser.history", "days": 0},
        {"op": "location.current", "precision": "street"},
        {"op": "location.current", "days": 1},
    ],
)
def test_invalid_inputs_fail_before_contacting_the_host(monkeypatch, kwargs):
    calls = _host(monkeypatch, "{}")
    assert json.loads(atum_mac(**kwargs)) == {"error": "invalid"}
    assert calls == []


def test_forged_authority_and_null_fields_never_reach_the_host(monkeypatch):
    calls = _host(monkeypatch, "{}")
    for args in (
        {"op": "location.current", "owner": "other"},
        {"op": "browser.history", "turn_id": "forged"},
        {"op": "messages.conversations", "days": None},
    ):
        assert json.loads(registry.dispatch("atum_mac", args)) == {"error": "invalid"}
    assert calls == []


@pytest.mark.parametrize(
    ("source", "args"),
    [
        ("messages", {"op": "messages.conversations"}),
        ("messages", {"op": "messages.read", "id": "1"}),
        ("browser", {"op": "browser.history"}),
        ("location", {"op": "location.current"}),
    ],
)
def test_each_operation_rechecks_the_live_source_policy(
    tmp_path, monkeypatch, source, args
):
    policy = tmp_path / "policy.json"
    values = {
        "version": 1,
        "google": True,
        "folders": True,
        "messages": True,
        "browser": True,
        "location": True,
        "team_spaces": True,
    }
    values[source] = False
    policy.write_text(json.dumps(values), encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))
    calls = _host(monkeypatch, "{}")

    assert json.loads(registry.dispatch("atum_mac", args)) == {"error": "disabled"}
    assert calls == []


def test_malformed_oversize_or_open_ended_host_answers_fail_closed(monkeypatch):
    for receipt in (
        "not-json",
        json.dumps({"error": "private_detail"}),
        json.dumps({"error": []}),
        json.dumps({"history": [{"browser": [], "title": "x"}]}),
        "x" * (96 * 1024 + 1),
    ):
        _host(monkeypatch, receipt)
        assert json.loads(atum_mac("location.current")) == {"error": "unavailable"}


def test_tool_is_gated_on_the_live_desktop_bridge(monkeypatch):
    monkeypatch.setattr(desktop_ui, "_request", None)
    assert not available()
    monkeypatch.setattr(desktop_ui, "_request", lambda *_args: "")
    assert available()


def test_schema_and_toolset_state_the_privacy_contract():
    # Registry-derived toolset (toolsets.py stays upstream; no static Atum entry).
    assert get_toolset("atum_mac")["tools"] == ["atum_mac"]
    assert set(ATUM_MAC_SCHEMA["parameters"]["properties"]) == {
        "op",
        "days",
        "limit",
        "id",
        "browser",
        "mode",
        "precision",
    }
    description = ATUM_MAC_SCHEMA["description"]
    for phrase in (
        "never quote",
        "OTP",
        "full URLs must never be stored",
        "city-level by default",
        "Background runs",
        "never cause a permission prompt",
    ):
        assert phrase in description
