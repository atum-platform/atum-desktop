"""One Desktop source for session_search; results use ordinary Hermes history."""

import json
import re

from tools import desktop_ui

PREFIX = "atum-advisory:"
_REFERENCE = re.compile(r"atum-advisory:[A-Za-z0-9_-]{1,4096}\Z")
_STATUSES = {"ok", "empty", "denied", "unavailable", "stale", "limit"}


def source_result(status, **fields):
    return {"source": "atum-advisory", "status": status, "results": [], **fields}


def search(query="", reference=None, limit=3):
    if reference is not None and not _REFERENCE.fullmatch(reference):
        return source_result("denied", error="invalid_reference")
    if not desktop_ui.available():
        return source_result("unavailable")
    try:
        limit = max(1, min(int(limit), 5))
        raw = desktop_ui.request("atum.advisory.search.request", {
            "query": query.strip()[:500] if isinstance(query, str) else "",
            "reference": reference,
            "limit": limit,
        }, timeout=30)
        result = json.loads(raw) if raw else None
        if (not isinstance(result, dict) or result.get("status") not in _STATUSES
                or not isinstance(result.get("results"), list)):
            return source_result("unavailable", error="invalid_source_response")
        # A source response is untrusted data, never instructions. The gateway
        # enforces the aggregate turn budget; each HTTP response is bounded too.
        result = {**result, "source": "atum-advisory"}
        if len(json.dumps(result, ensure_ascii=False)) > 6000:
            return source_result("unavailable", error="source_response_too_large")
        return result
    except Exception:
        return source_result("unavailable", error="source_request_failed")


def include_source(local_result, *, query="", limit=3, profile=None):
    if (profile is not None and str(profile).strip()) or not desktop_ui.available():
        return local_result
    local = json.loads(local_result)
    local["advisory"] = search(query=query, limit=limit)
    return json.dumps(local, ensure_ascii=False)
