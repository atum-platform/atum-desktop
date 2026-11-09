#!/usr/bin/env python3
"""Evaluate trusted, fail-closed exact-head verification evidence."""

from __future__ import annotations

import json
import os
import re


_ALLOWED_EVENTS = {"pull_request", "push"}
_PASSING_RESULTS = {"success", "skipped"}
_MUST_SUCCEED = {
    "detect",
    "all-checks-pass",
    "workflow-lint",
    "uv-lockfile",
    "osv-scanner",
}
_REQUIRED_DEPENDENCIES = frozenset(
    {
        "detect",
        "main-smoke",
        "workflow-lint",
        "tests",
        "lint",
        "js-tests",
        "e2e-desktop",
        "docs-site",
        "history-check",
        "contributor-check",
        "uv-lockfile",
        "lockfile-diff",
        "docker-lint",
        "supply-chain",
        "review-labels",
        "osv-scanner",
        "all-checks-pass",
    }
)
_SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
# A shipped version line (release/0.18.3 or release/0.18). Its pushes carry the
# exact commits the desktop publisher's release-branch mode may ship, so they
# publish verification like the default branch. Other branch pushes do not.
_RELEASE_REF_PATTERN = re.compile(r"refs/heads/release/\d+\.\d+(?:\.\d+)?")


def _normalize_needs(gate_needs: object) -> dict[str, str]:
    """Return GitHub's raw needs context as a compact result map."""
    if not isinstance(gate_needs, dict):
        return {}

    compact: dict[str, str] = {}
    for name, evidence in gate_needs.items():
        if not isinstance(name, str):
            continue
        result = evidence.get("result") if isinstance(evidence, dict) else None
        compact[name] = result if isinstance(result, str) else "<invalid>"
    return compact


def decide(
    *,
    event_name: str,
    repository: str,
    head_repo: str,
    head_sha: str,
    pr_head_sha: str,
    git_ref: str,
    default_branch: str,
    gate_needs: object,
) -> tuple[bool, list[str]]:
    """Return whether trusted CI evidence is sufficient, plus block reasons."""
    reasons: list[str] = []

    if event_name not in _ALLOWED_EVENTS:
        reasons.append(f"unsupported event: {event_name or '<empty>'}")
    if not repository:
        reasons.append("repository identity is missing")
    if not _SHA_PATTERN.fullmatch(head_sha):
        reasons.append("head SHA is missing or invalid")

    if event_name == "pull_request":
        if not head_repo:
            reasons.append("pull-request head repository identity is missing")
        elif head_repo != repository:
            reasons.append("fork-origin pull requests cannot publish verification")
        if not _SHA_PATTERN.fullmatch(pr_head_sha):
            reasons.append("pull-request head SHA is missing or invalid")
        elif head_sha != pr_head_sha:
            reasons.append("verification SHA does not match the pull-request head SHA")
    elif event_name == "push":
        if not default_branch:
            reasons.append("default branch identity is missing")
        elif git_ref != f"refs/heads/{default_branch}" and not _RELEASE_REF_PATTERN.fullmatch(
            git_ref
        ):
            reasons.append(
                "push verification is restricted to the default branch and release branches"
            )

    compact = _normalize_needs(gate_needs)
    if not compact:
        reasons.append("aggregate dependency evidence is missing")
        return False, reasons

    missing = sorted(_REQUIRED_DEPENDENCIES - compact.keys())
    if missing:
        reasons.append(f"required dependency evidence is missing: {', '.join(missing)}")

    must_succeed = _MUST_SUCCEED | (
        {"history-check"} if event_name == "pull_request" else set()
    )
    if event_name == "push":
        must_succeed.add("main-smoke")
    for name in sorted(must_succeed & compact.keys()):
        if compact[name] != "success":
            reasons.append(f"dependency {name} must succeed, got {compact[name]!r}")

    for name, result in sorted(compact.items()):
        if name not in must_succeed and result not in _PASSING_RESULTS:
            reasons.append(f"dependency {name} has blocking result {result!r}")

    return not reasons, reasons


def _write_summary(*, head_sha: str, gate_needs: object, reasons: list[str]) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return

    lines = [
        "## Exact-head verification",
        "",
        f"- Head SHA: `{head_sha or '<unknown>'}`",
        f"- Decision: `{'success' if not reasons else 'failure'}`",
        "",
        "### Dependency results",
        "",
        "```json",
        json.dumps(_normalize_needs(gate_needs), indent=2, sort_keys=True),
        "```",
    ]
    if reasons:
        lines.extend(["", "### Block reasons", ""])
        lines.extend(f"- {reason}" for reason in reasons)

    with open(summary_path, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def main() -> int:
    raw_needs = os.environ.get("GATE_NEEDS", "")
    try:
        gate_needs = json.loads(raw_needs)
    except json.JSONDecodeError as exc:
        gate_needs = {}
        ok = False
        reasons = [f"invalid aggregate dependency JSON: {exc}"]
    else:
        ok, reasons = decide(
            event_name=os.environ.get("EVENT_NAME", ""),
            repository=os.environ.get("REPOSITORY", ""),
            head_repo=os.environ.get("HEAD_REPO", ""),
            head_sha=os.environ.get("HEAD_SHA", ""),
            pr_head_sha=os.environ.get("PR_HEAD_SHA", ""),
            git_ref=os.environ.get("GIT_REF", ""),
            default_branch=os.environ.get("DEFAULT_BRANCH", ""),
            gate_needs=gate_needs,
        )

    _write_summary(
        head_sha=os.environ.get("HEAD_SHA", ""),
        gate_needs=gate_needs,
        reasons=reasons,
    )

    if not ok:
        for reason in reasons:
            print(f"::error::{reason}")
        return 1

    print("Exact-head verification policy passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
