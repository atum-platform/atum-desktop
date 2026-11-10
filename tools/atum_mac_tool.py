"""Consent-gated, read-only knowledge sources on the owner's live Atum Mac."""

from __future__ import annotations

import json
import re
from datetime import datetime
from urllib.parse import parse_qsl, unquote, urlsplit

from tools import desktop_ui
from tools.atum_source_policy import source_enabled
from tools.registry import registry, tool_error

_HOST_TIMEOUT_SECONDS = 60
_MAX_RESPONSE_BYTES = 96 * 1024
_MESSAGE_USAGE = (
    "paraphrase only; never quote; never store others' words or private details"
)
_OPS = frozenset(
    {
        "messages.conversations",
        "messages.read",
        "browser.history",
        "location.current",
    }
)
_ERROR_CODES = frozenset({"disabled", "invalid", "permission_needed", "unavailable"})
_PERMISSIONS = frozenset({"full_disk", "location"})
_BROWSERS = frozenset({"safari", "chrome", "all"})
_MODES = frozenset({"recent", "top"})
_PRECISIONS = frozenset({"city", "precise"})
_ID = re.compile(r"^\d{1,18}$")
_DOMAIN = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$"
)
_SENSITIVE_URL = re.compile(
    r"(?:^|[._~:/?&#=-])(?:access[_-]?token|auth|authorization|bearer|code|confirm(?:ation)?|credential|invite|jwt|key|magic|oauth|pass(?:word|wd)?|recover(?:y)?|redeem|reset|secret|session|share|sid|signature|signed[_-]?headers|token|unsubscribe(?:[_-]?token)?|verif(?:y|ication))(?:$|[._~:/?&#=-])",
    re.IGNORECASE,
)
_SENSITIVE_TITLE = re.compile(
    r"\b(?:access token|auth(?:entication|orization)? code|confirmation code|credential|invite (?:code|link|token)|login code|magic link|one[- ]time (?:code|password|passcode)|password|passcode|recovery code|reset (?:code|link|password)|security code|session (?:key|token)|sign[- ]?in code|unsubscribe (?:code|link|token)|verification code)\b|\b(?:confirm|recover|redeem|reset|verify)\s+(?:your\s+)?(?:access|account|email|identity|login|password)\b",
    re.IGNORECASE,
)
_OPAQUE_TOKEN_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{24,}$")
_JWT_SEGMENT = re.compile(
    r"^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$"
)
_OTP_CONTEXT = re.compile(
    r"\b(?:otp|one[- ]?time|verification|verify|security|login|sign[- ]?in|passcode|m[aã]\s+x[aá]c\s+minh|x[aá]c\s+thực|验证码|驗證碼|認証コード)\b",
    re.IGNORECASE,
)
_SHORT_CODE = re.compile(r"(?<!\d)\d{4,8}(?!\d)")
_ONLY_CODE = re.compile(r"^\s*(?:\D{0,12})?\d{4,8}(?:\D{0,12})?\s*$")
_INTRA_DIGIT_SEPARATOR = re.compile(
    r"(?<=\d)[ \t\u00a0\u2007\u202f\-\u2010-\u2015]+(?=\d)"
)
_EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_PHONE = re.compile(
    r"(?<!\w)(?:\+\d{1,3}[\d ()./-]{6,}\d|\(\d{2,4}\)[\d ./-]{5,}\d|\d[\d ()./-]{7,}\d)(?!\w)"
)
_URL_TEXT = re.compile(r"https?://[^\s<>()]+", re.IGNORECASE)
_MALFORMED_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")


def _is_otp_like(text: str) -> bool:
    normalized = _INTRA_DIGIT_SEPARATOR.sub("", text)
    return bool(
        (_OTP_CONTEXT.search(normalized) and _SHORT_CODE.search(normalized))
        or _ONLY_CODE.fullmatch(normalized)
    )


def _sensitive_path(path: str) -> bool:
    if _MALFORMED_PERCENT.search(path):
        return True
    try:
        decoded = unquote(path, errors="strict")
    except (UnicodeDecodeError, ValueError):
        return True
    return bool(
        _SENSITIVE_URL.search(decoded)
        or any(
            _OPAQUE_TOKEN_SEGMENT.fullmatch(segment)
            or _JWT_SEGMENT.fullmatch(segment)
            for segment in decoded.split("/")
            if segment
        )
    )


def _message_url_ok(raw: str) -> bool:
    try:
        parsed = urlsplit(raw)
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
    except ValueError:
        return False
    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or username
        or password
        or _sensitive_path(parsed.path)
        or _MALFORMED_PERCENT.search(parsed.query)
        or _MALFORMED_PERCENT.search(parsed.fragment)
        or _SENSITIVE_URL.search(parsed.fragment)
    ):
        return False
    try:
        query = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=False)
    except ValueError:
        return False
    return not any(
        _SENSITIVE_URL.search(key)
        or _SENSITIVE_URL.search(value)
        or _OPAQUE_TOKEN_SEGMENT.fullmatch(value)
        or _JWT_SEGMENT.fullmatch(value)
        for key, value in query
    )


def available() -> bool:
    """The tool schema is stable when the live desktop bridge is present."""
    return desktop_ui.available()


def _closed_error(code: str) -> str:
    return tool_error(code)


def _strict_keys(
    value: object, required: set[str], optional: set[str] | None = None
) -> bool:
    if not isinstance(value, dict):
        return False
    keys = set(value)
    allowed = required | (optional or set())
    return required <= keys <= allowed


def _bounded_string(value: object, maximum: int, *, minimum: int = 0) -> bool:
    return isinstance(value, str) and minimum <= len(value) <= maximum


def _bounded_int(value: object, low: int, high: int) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int)
        and low <= value <= high
    )


def _bounded_number(value: object, low: float, high: float) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and low <= float(value) <= high
    )


def _iso_timestamp(value: object) -> bool:
    if not _bounded_string(value, 40, minimum=20):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _error_ok(result: object) -> bool:
    if not isinstance(result, dict):
        return False
    error = result.get("error")
    if not isinstance(error, str) or error not in _ERROR_CODES:
        return False
    if error == "permission_needed":
        permission = result.get("permission")
        return (
            set(result) == {"error", "permission"}
            and isinstance(permission, str)
            and permission in _PERMISSIONS
        )
    return set(result) == {"error"}


def _participant_ok(value: object) -> bool:
    return (
        _strict_keys(value, set(), {"name", "handle"})
        and len(value) == 1
        and all(_bounded_string(item, 120, minimum=1) for item in value.values())
    )


def _conversation_ok(value: object) -> bool:
    required = {
        "id",
        "title",
        "participants",
        "isGroup",
        "lastActivity",
        "messageCount",
        "fromMeShare",
    }
    return (
        _strict_keys(value, required)
        and isinstance(value["id"], str)
        and bool(_ID.fullmatch(value["id"]))
        and _bounded_string(value["title"], 120, minimum=1)
        and isinstance(value["participants"], list)
        and len(value["participants"]) <= 20
        and all(_participant_ok(item) for item in value["participants"])
        and isinstance(value["isGroup"], bool)
        and _iso_timestamp(value["lastActivity"])
        and _bounded_int(value["messageCount"], 0, 1_000_000)
        and _bounded_number(value["fromMeShare"], 0, 1)
    )


def _conversations_ok(result: object) -> bool:
    return (
        _strict_keys(result, {"conversations", "usage"})
        and result["usage"] == _MESSAGE_USAGE
        and isinstance(result["conversations"], list)
        and len(result["conversations"]) <= 40
        and all(_conversation_ok(item) for item in result["conversations"])
    )


def _message_ok(value: object) -> bool:
    if not _strict_keys(value, {"fromMe", "sender", "at", "text"}):
        return False
    text = value["text"]
    if not _bounded_string(text, 500, minimum=1):
        return False
    if (
        _is_otp_like(text)
        or _EMAIL.search(text)
        or _PHONE.search(text)
        or any(not _message_url_ok(url) for url in _URL_TEXT.findall(text))
    ):
        return False
    return (
        isinstance(value["fromMe"], bool)
        and _bounded_string(value["sender"], 120, minimum=1)
        and _iso_timestamp(value["at"])
    )


def _messages_ok(result: object) -> bool:
    return (
        _strict_keys(
            result, {"messages", "usage", "omittedAttributedBodies"}
        )
        and result["usage"] == _MESSAGE_USAGE
        and isinstance(result["messages"], list)
        and len(result["messages"]) <= 60
        and all(_message_ok(item) for item in result["messages"])
        and _bounded_int(result["omittedAttributedBodies"], 0, 1_000_000)
    )


def _history_entry_ok(value: object) -> bool:
    if not _strict_keys(
        value, {"browser", "title", "domain", "path", "lastVisit", "visits"}
    ):
        return False
    path = value["path"]
    return (
        isinstance(value["browser"], str)
        and value["browser"] in {"safari", "chrome"}
        and _bounded_string(value["title"], 240, minimum=1)
        and not _SENSITIVE_TITLE.search(value["title"])
        and _bounded_string(value["domain"], 253, minimum=1)
        and bool(_DOMAIN.fullmatch(value["domain"]))
        and _bounded_string(path, 512, minimum=1)
        and path.startswith("/")
        and "?" not in path
        and "#" not in path
        and not _sensitive_path(path)
        and _iso_timestamp(value["lastVisit"])
        and _bounded_int(value["visits"], 1, 1_000_000)
    )


def _history_ok(result: object) -> bool:
    if not _strict_keys(result, {"history"}, {"permissionNeeded"}):
        return False
    history = result["history"]
    if (
        not isinstance(history, list)
        or len(history) > 100
        or not all(_history_entry_ok(item) for item in history)
    ):
        return False
    return "permissionNeeded" not in result or result["permissionNeeded"] == [
        "full_disk"
    ]


def _location_ok(result: object, precision: str) -> bool:
    required = {"timeZone"}
    optional = {"city", "region", "country"}
    if precision == "precise":
        required |= {"lat", "lon", "accuracyMeters"}
    if not _strict_keys(result, required, optional):
        return False
    if not _bounded_string(result["timeZone"], 64, minimum=1):
        return False
    for field in optional:
        if field in result and not _bounded_string(result[field], 120, minimum=1):
            return False
    return precision != "precise" or (
        _bounded_number(result["lat"], -90, 90)
        and _bounded_number(result["lon"], -180, 180)
        and _bounded_number(result["accuracyMeters"], 0, 100_000)
    )


def _result_ok(op: str, result: object, precision: str) -> bool:
    if (
        _strict_keys(result, {"ok", "reason", "source", "mac"})
        and result["ok"] is False
        and isinstance(result["reason"], str)
        and result["reason"] in {"source_off", "mac_offline", "needs_permission", "update_atum", "not_shared_yet", "no_mac", "stopped", "unavailable"}
        and (result["source"] is None or isinstance(result["source"], str))
        and result["source"] in {None, "messages", "browser", "location", "folders"}
        and (result["mac"] is None or _bounded_string(result["mac"], 64, minimum=1))
    ):
        return True
    if _error_ok(result):
        return True
    if op == "messages.conversations":
        return _conversations_ok(result)
    if op == "messages.read":
        return _messages_ok(result)
    if op == "browser.history":
        return _history_ok(result)
    return _location_ok(result, precision)


def atum_mac(
    op: str = "",
    *,
    days: int | None = None,
    limit: int | None = None,
    conversation_id: str | None = None,
    browser: str | None = None,
    mode: str | None = None,
    precision: str | None = None,
    transport=None,
) -> str:
    """Read one approved Mac source. Consent and OS permission are checked by the host."""
    if not isinstance(op, str) or op not in _OPS:
        return _closed_error("invalid")

    payload: dict[str, object] = {"op": op}
    if op == "messages.conversations":
        if any(value is not None for value in (conversation_id, browser, mode, precision)):
            return _closed_error("invalid")
        payload["days"] = 90 if days is None else days
        payload["limit"] = 40 if limit is None else limit
        if not _bounded_int(payload["days"], 1, 365) or not _bounded_int(
            payload["limit"], 1, 40
        ):
            return _closed_error("invalid")
    elif op == "messages.read":
        if any(value is not None for value in (browser, mode, precision)):
            return _closed_error("invalid")
        if not isinstance(conversation_id, str) or not _ID.fullmatch(
            conversation_id
        ):
            return _closed_error("invalid")
        payload.update(
            id=conversation_id,
            days=30 if days is None else days,
            limit=60 if limit is None else limit,
        )
        if not _bounded_int(payload["days"], 1, 90) or not _bounded_int(
            payload["limit"], 1, 60
        ):
            return _closed_error("invalid")
    elif op == "browser.history":
        if conversation_id is not None or precision is not None:
            return _closed_error("invalid")
        payload.update(
            browser="all" if browser is None else browser,
            days=30 if days is None else days,
            limit=100 if limit is None else limit,
            mode="recent" if mode is None else mode,
        )
        if (
            not isinstance(payload["browser"], str)
            or payload["browser"] not in _BROWSERS
            or not isinstance(payload["mode"], str)
            or payload["mode"] not in _MODES
            or not _bounded_int(payload["days"], 1, 90)
            or not _bounded_int(payload["limit"], 1, 100)
        ):
            return _closed_error("invalid")
    else:
        if any(
            value is not None
            for value in (days, limit, conversation_id, browser, mode)
        ):
            return _closed_error("invalid")
        payload["precision"] = "city" if precision is None else precision
        if (
            not isinstance(payload["precision"], str)
            or payload["precision"] not in _PRECISIONS
        ):
            return _closed_error("invalid")

    receipt = (transport or desktop_ui.request)(
        "atum.mac.request", payload, timeout=_HOST_TIMEOUT_SECONDS
    )
    if not isinstance(receipt, str) or not receipt:
        return _closed_error("unavailable")
    if len(receipt.encode("utf-8")) > _MAX_RESPONSE_BYTES:
        return _closed_error("unavailable")
    try:
        result = json.loads(receipt)
    except (TypeError, ValueError):
        return _closed_error("unavailable")
    if not _result_ok(op, result, str(payload.get("precision") or "city")):
        return _closed_error("unavailable")
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


ATUM_MAC_SCHEMA = {
    "name": "atum_mac",
    "description": (
        "Read consented knowledge sources on the owner's live Mac. Read-only. "
        "messages.conversations returns who the owner talks to, frequency and timing; "
        "messages.read returns bounded recent text only for deriving themes and user facts. "
        "Message results are paraphrase-only: never quote them and never store other people's "
        "words, phone numbers, addresses or message text. OTP and verification-code messages "
        "are removed before output. browser.history returns title, domain, path without query "
        "or fragment, visit count and timing; credential/session/auth URLs are removed and full "
        "URLs must never be stored. location.current is city-level by default; request precise "
        "only when the owner's current request needs coordinates, such as directions or near me. "
        "A disabled source or missing macOS permission returns a closed error. Background runs "
        "may use Messages metadata but not messages.read, and never cause a permission prompt. "
        "If unavailable, say one short sentence with the fix; do not retry."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": sorted(_OPS)},
            "days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 365,
                "description": "Lookback days; at most 90 except messages.conversations (365).",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "At most 40 conversations, 60 messages, or 100 history rows.",
            },
            "id": {
                "type": "string",
                "maxLength": 18,
                "description": "messages.read only: exact conversation id from messages.conversations.",
            },
            "browser": {"type": "string", "enum": sorted(_BROWSERS)},
            "mode": {"type": "string", "enum": sorted(_MODES)},
            "precision": {"type": "string", "enum": sorted(_PRECISIONS)},
        },
        "required": ["op"],
        "additionalProperties": False,
    },
}


def _handle_atum_mac(args: object, transport=None) -> str:
    allowed = {"op", "days", "limit", "id", "browser", "mode", "precision"}
    if not isinstance(args, dict) or "op" not in args or not set(args) <= allowed:
        return _closed_error("invalid")
    op = args["op"]
    source = (
        "messages"
        if isinstance(op, str) and op.startswith("messages.")
        else "browser"
        if op == "browser.history"
        else "location"
        if op == "location.current"
        else None
    )
    if transport is None and source is not None and not source_enabled(source):
        return _closed_error("disabled")
    if any(value is None for value in args.values()):
        return _closed_error("invalid")
    return atum_mac(
        op=args.get("op"),
        days=args.get("days"),
        limit=args.get("limit"),
        conversation_id=args.get("id"),
        browser=args.get("browser"),
        mode=args.get("mode"),
        precision=args.get("precision"),
        transport=transport,
    )


registry.register(
    name="atum_mac",
    toolset="atum_mac",
    schema=ATUM_MAC_SCHEMA,
    handler=lambda args, **_kw: _handle_atum_mac(args),
    check_fn=available,
    emoji="🍎",
)
