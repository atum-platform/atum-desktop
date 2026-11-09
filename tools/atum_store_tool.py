"""Read-only Store discovery through Atum's live, turn-bound host bridge."""

import json

from tools import desktop_ui
from tools.registry import registry, tool_error

_MODEL_FIELDS_BY_OPERATION = {
    "search": ("query", "kind", "limit"),
    "inspect": ("item_id",),
}


def atum_store(operation: str = "search", query: str = "", kind: str = "", item_id: str = "", limit: int = 10) -> str:
    if not isinstance(operation, str) or operation not in {"search", "inspect"}:
        return tool_error("operation must be search or inspect.")
    if not isinstance(query, str) or len(query) > 200 or not isinstance(kind, str) or kind not in {"", "skill", "agent", "pet"}:
        return tool_error("Use a query of at most 200 characters and kind skill, agent or pet.")
    if not isinstance(item_id, str) or len(item_id) > 256 or operation == "inspect" and not item_id:
        return tool_error("inspect requires the exact item_id returned by search.")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        return tool_error("limit must be an integer from 1 to 20.")
    payload = (
        {
            "operation": operation,
            "query": query,
            "limit": limit,
            **({"kind": kind} if kind else {}),
        }
        if operation == "search"
        else {"operation": operation, "itemId": item_id}
    )
    receipt = desktop_ui.request("atum.store.request", payload, timeout=30)
    if receipt is None:
        return tool_error("Store discovery is available only through an Atum host.")
    if not receipt:
        return tool_error("The Atum host did not confirm the Store request.")
    try:
        result = json.loads(receipt)
    except (ValueError, TypeError):
        return tool_error("The Atum host returned an invalid Store response.")
    if not isinstance(result, dict):
        return tool_error("The Atum host returned an invalid Store response.")
    if result.get("error"):
        return tool_error(str(result["error"]))
    if not isinstance(result.get("items"), list):
        return tool_error("The Atum host returned an invalid Store response.")
    return json.dumps(result, ensure_ascii=False)


ATUM_STORE_SCHEMA = {
    "name": "atum_store",
    "description": (
        "Search current Atum Store skills, agents to hire, and pets, or inspect an exact listing. "
        "Returns real IDs, current offers/renewal terms, ownership, requirements and a listing destination. "
        "Use these records to recommend; do not invent listings or prices. This never buys, hires, "
        "installs or opens a UI. A destination is not an opened receipt. For Apps use atum_apps."
    ),
    "parameters": {"type": "object", "properties": {
        "operation": {"type": "string", "enum": ["search", "inspect"]},
        "query": {"type": "string", "description": "Listing text filter, at most 200 characters."},
        "kind": {"type": "string", "enum": ["skill", "agent", "pet"]},
        "item_id": {"type": "string", "description": "Exact itemId from search; required for inspect."},
        "limit": {"type": "integer", "minimum": 1, "maximum": 20},
    }, "required": ["operation"]},
}


def _handle_atum_store(args: object) -> str:
    if not isinstance(args, dict):
        return atum_store(operation="")
    operation = args.get("operation", "search")
    fields = (
        _MODEL_FIELDS_BY_OPERATION.get(operation, ())
        if isinstance(operation, str)
        else ()
    )
    selected = {
        field: args[field]
        for field in fields
        if field in args
    }
    return atum_store(
        operation=operation,
        query=selected.get("query", ""),
        kind=selected.get("kind", ""),
        item_id=selected.get("item_id", ""),
        limit=selected.get("limit", 10),
    )


registry.register(
    name="atum_store",
    toolset="atum_store",
    schema=ATUM_STORE_SCHEMA,
    handler=lambda args, **_kw: _handle_atum_store(args),
    check_fn=desktop_ui.available,
    emoji="⌕",
)
