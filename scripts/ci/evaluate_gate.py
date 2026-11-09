#!/usr/bin/env python3
"""Evaluate the CI aggregate gate without accepting a vacuous run."""

from __future__ import annotations

import json
import os
import sys
from typing import Any


_BLOCKING_RESULTS = {"failure", "cancelled", "timed_out"}


def evaluate(needs: dict[str, dict[str, Any]]) -> tuple[dict[str, str], list[str]]:
    """Return the compact result map and dependency names that block the gate."""
    compact = {
        name: str(info.get("result", ""))
        for name, info in needs.items()
    }
    blocked = {
        name for name, result in compact.items() if result in _BLOCKING_RESULTS
    }
    if compact.get("detect") != "success":
        blocked.add("detect")
    return compact, sorted(blocked)


def main() -> int:
    try:
        needs = json.loads(os.environ.get("NEEDS", "{}"))
    except json.JSONDecodeError as exc:
        print(f"::error::Invalid NEEDS JSON: {exc}")
        return 1
    if not isinstance(needs, dict):
        print("::error::NEEDS must be a JSON object")
        return 1

    compact, blocked = evaluate(needs)
    output = f"needs-json={json.dumps(compact)}"
    print(output)
    if github_output := os.environ.get("GITHUB_OUTPUT"):
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(output + "\n")

    for name, result in sorted(compact.items()):
        icon = "✅" if result in {"success", "skipped"} else "❌"
        print(f"{icon} {name}: {result}")

    if blocked:
        print(f"::error::{len(blocked)} job(s) blocked the gate: {', '.join(blocked)}")
        return 1
    print("All required checks passed; lane-gated jobs may be skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
