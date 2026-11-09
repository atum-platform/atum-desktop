"""Shared classification for Atum's consent adapter on Hermes tool dispatch.

Only two classes of tool are mediated by the Atum plugin when a desktop
backend carries the required marker:

* interaction tools (browser, web, and computer control) — Hermes asks for
  consent under a stable, account-scoped rule key, then Electron main binds
  the approved operation to the signed-in account as a one-operation lease;
* ``write_file`` — a write inside the account workspace gets the same Hermes
  consent and is then executed and published by Electron main; a write
  anywhere else runs as plain Hermes ``write_file``.

Everything else (terminal, execute_code, patch, search_files, skill_manage,
read_file, open_preview, vision_analyze, MCP tools, ...) runs exactly as
Hermes ships it, under Hermes's own guards.
"""

from __future__ import annotations

import os
from typing import Any


REQUIRED_ENV = "ATUM_FILESYSTEM_CAPABILITY_REQUIRED"
INTERACTION_TOOLS = {"computer_use", "web_extract", "web_search"}
WORKSPACE_WRITE_TOOLS = {"write_file"}
GUARDED_TOOLS = INTERACTION_TOOLS | WORKSPACE_WRITE_TOOLS


def capability_required() -> bool:
    return os.environ.get(REQUIRED_ENV, "").strip().lower() in {
        "1",
        "on",
        "true",
        "yes",
    }


def is_interaction_tool(tool_name: str) -> bool:
    return tool_name in INTERACTION_TOOLS or tool_name.startswith("browser_")


def requires_filesystem_guard(tool_name: str, args: Any = None) -> bool:
    return is_interaction_tool(tool_name) or tool_name in WORKSPACE_WRITE_TOOLS


def guard_unavailable_message(tool_name: str) -> str:
    surface = "capability" if is_interaction_tool(tool_name) else "filesystem"
    return f"CAPABILITY_DENIED: Atum {surface} guard unavailable"


def broken_guard_block(tool_name: str):
    """Block message for ``handle_function_call`` when the pre_tool_call guard itself raised: fail
    closed under the required marker (the guard could not classify the call), else ``None``."""
    return guard_unavailable_message(tool_name) if capability_required() else None


__all__ = [
    "GUARDED_TOOLS",
    "INTERACTION_TOOLS",
    "WORKSPACE_WRITE_TOOLS",
    "broken_guard_block",
    "capability_required",
    "guard_unavailable_message",
    "is_interaction_tool",
    "requires_filesystem_guard",
]
