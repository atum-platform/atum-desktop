#!/usr/bin/env python3
"""Switch-only access to the first-party Atum app catalog in Desktop."""

import json
import unicodedata
from typing import Any

from tools import desktop_ui
from tools.registry import registry, tool_error

_OPERATIONS = ("list", "open")


def _catalog() -> tuple[list[dict[str, Any]], str | None]:
    """Ask the foreground desktop for its account-authorized direct catalog.

    The runtime is deliberately not an authority: its startup environment can
    predate sign-in or an account swap. This uses the existing bounded desktop
    request bridge on every list/open invocation.
    """
    receipt = desktop_ui.request("atum.apps.list.request", {}, timeout=30)
    if receipt is None:
        return [], "App switching is only available in the Atum desktop app."
    if not receipt:
        return [], "The Atum window did not answer the app catalog request."
    try:
        value = json.loads(receipt)
    except (TypeError, ValueError):
        return [], "The Atum window returned an invalid app catalog."
    if not isinstance(value, dict):
        return [], "The Atum window returned an invalid app catalog."
    if value.get("error"):
        return [], str(value["error"])
    apps = value.get("apps")
    if not isinstance(apps, list) or not all(isinstance(app, dict) for app in apps):
        return [], "The Atum window returned an invalid app catalog."
    public_fields = {"id", "appId", "version", "name", "description", "availability", "supportedModes",
                     "connection", "destination", "listingLink"}
    return [{key: value for key, value in app.items() if key in public_fields} for app in apps], None


def _available() -> bool:
    return desktop_ui.available()


def atum_apps(operation: str, app_id: str = "", query: str = "") -> str:
    op = operation.strip().lower() if isinstance(operation, str) else ""
    if op not in _OPERATIONS:
        return tool_error(f"operation must be one of: {', '.join(_OPERATIONS)}.")
    if not isinstance(query, str) or len(query) > 200:
        return tool_error("query must be a string of at most 200 characters.")
    apps, catalog_error = _catalog()

    if op == "list":
        if catalog_error:
            return tool_error(catalog_error)
        def normalized(value):
            return " ".join("".join(c for c in unicodedata.normalize("NFD", value.casefold().replace("đ", "d"))
                                    if not unicodedata.combining(c)).split())
        filtered = [app for app in apps if normalized(query) in normalized(json.dumps(app, ensure_ascii=False))]
        return json.dumps({"apps": filtered}, ensure_ascii=False)

    if catalog_error:
        return tool_error(catalog_error)

    requested = app_id.strip().lower() if isinstance(app_id, str) else ""
    app = next((item for item in apps if item.get("id") == requested), None)
    if app is None:
        valid = ", ".join(str(item.get("id")) for item in apps)
        return tool_error(f"Unknown app id '{requested}'. Available apps: {valid}.")

    receipt = desktop_ui.request("atum.apps.open.request", {"app_id": requested}, timeout=30)
    if receipt is None:
        return tool_error("App switching is only available in the Atum desktop app.")
    if not receipt:
        return tool_error("The app switch was not confirmed by the active Atum window.")

    try:
        result = json.loads(receipt)
    except (TypeError, ValueError):
        return tool_error("The Atum window returned an invalid switch confirmation.")
    if isinstance(result, dict) and result.get("switched") is False and isinstance(result.get("destination"), dict) and not result.get("error"):
        return json.dumps(result, ensure_ascii=False)
    if not isinstance(result, dict) or result.get("switched") is not True:
        return tool_error(str(result.get("error") if isinstance(result, dict) else "App switch failed."))

    return json.dumps(
        {"switched": True, "app": {"id": requested, "name": app.get("name", requested)}},
        ensure_ascii=False,
    )


ATUM_APPS_SCHEMA = {
    "name": "atum_apps",
    "description": (
        "List/search the current Atum apps, or open one in the desktop. In the cloud open returns a destination, not an opened receipt. "
        "Use this instead of web search when the user asks about an app listed by this tool, "
        "or asks to open/take them to one. This tool never reads app conversations or content."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "operation": {"type": "string", "enum": list(_OPERATIONS)},
            "app_id": {
                "type": "string",
                "description": "Stable app id from list; required for open.",
            },
            "query": {"type": "string", "description": "Optional listing-text filter for list, at most 200 characters."},
        },
        "required": ["operation"],
    },
}


registry.register(
    name="atum_apps",
    toolset="atum_apps",
    schema=ATUM_APPS_SCHEMA,
    handler=lambda args, **_kw: atum_apps(
        operation=args.get("operation", ""), app_id=args.get("app_id", ""), query=args.get("query", "")
    ),
    check_fn=_available,
    emoji="↗",
)
