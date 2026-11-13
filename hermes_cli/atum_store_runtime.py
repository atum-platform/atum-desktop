"""Reconcile Store-owned runtime additions inside one protected Hermes home.

The cloud controller calls this module through the local JSON-RPC gateway before
opening a conversation.  The controller supplies a closed plan built from the
shipped Store schedule table *after* server-side entitlement and agent binding
have been checked.  This module never reads Store credentials, catalog bodies,
or private training instructions.

Only two existing Hermes surfaces are used:

* official optional skills go through the Skills Hub quarantine, scanner and
  publication path;
* Store routines go through ``cron.jobs`` and use the reserved
  ``atum-store/`` name prefix.

Ownership is not inferred from files in the home.  The caller supplies the
minimal receipt digests retained in the controller-authenticated protected
home state.  A skill is archived on lapse only while its current Hub receipt
still matches that digest.  A user reinstall/update changes the receipt and
therefore transfers ownership away from this reconciler rather than risking
data loss.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any


PROFILE = "atum.cloud-store-runtime/1"
JOB_PREFIX = "atum-store/"
MAX_ITEMS = 64
MAX_SKILLS = 64
MAX_JOBS = 64

_ITEM = re.compile(r"^(?:agent|skill)/[a-z0-9][a-z0-9_/-]{0,119}$")
_IDENTIFIER = re.compile(r"^official/[a-z0-9][a-z0-9_/-]{0,190}$")
_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,127}$")
_MODEL = re.compile(r"^atum-store-run-[a-z0-9-]{1,180}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


class StoreRuntimeError(ValueError):
    """The trusted caller supplied an invalid plan or reconciliation failed."""


def _exact(value: Any, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def _text(value: Any, *, limit: int, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value or len(value) > limit or "\x00" in value:
        raise StoreRuntimeError("store_runtime_plan_invalid")
    if pattern is not None and pattern.fullmatch(value) is None:
        raise StoreRuntimeError("store_runtime_plan_invalid")
    return value


def validate_store_runtime_plan(value: Any) -> dict[str, Any]:
    """Return one canonical closed plan without touching the home."""
    if not _exact(value, {"profile", "items", "managedSkills"}) or value.get("profile") != PROFILE:
        raise StoreRuntimeError("store_runtime_plan_invalid")
    raw_items = value.get("items")
    raw_managed = value.get("managedSkills")
    if not isinstance(raw_items, list) or len(raw_items) > MAX_ITEMS:
        raise StoreRuntimeError("store_runtime_plan_invalid")
    if not isinstance(raw_managed, list) or len(raw_managed) > MAX_SKILLS:
        raise StoreRuntimeError("store_runtime_plan_invalid")

    items: list[dict[str, Any]] = []
    item_ids: set[str] = set()
    skill_specs: dict[str, tuple[str, str]] = {}
    job_names: set[str] = set()
    total_jobs = 0
    for raw in raw_items:
        if not _exact(raw, {"itemId", "skills", "jobs"}):
            raise StoreRuntimeError("store_runtime_plan_invalid")
        item_id = _text(raw.get("itemId"), limit=128, pattern=_ITEM)
        if item_id in item_ids or not item_id.startswith("agent/"):
            raise StoreRuntimeError("store_runtime_plan_invalid")
        item_ids.add(item_id)
        if not isinstance(raw.get("skills"), list) or len(raw["skills"]) > 16:
            raise StoreRuntimeError("store_runtime_plan_invalid")
        if not isinstance(raw.get("jobs"), list) or len(raw["jobs"]) > 16:
            raise StoreRuntimeError("store_runtime_plan_invalid")

        skills: list[dict[str, str]] = []
        local_names: set[str] = set()
        for candidate in raw["skills"]:
            if not _exact(candidate, {"identifier", "name"}):
                raise StoreRuntimeError("store_runtime_plan_invalid")
            identifier = _text(candidate.get("identifier"), limit=200, pattern=_IDENTIFIER)
            name = _text(candidate.get("name"), limit=128, pattern=_NAME)
            if identifier.rsplit("/", 1)[-1] != name or name in local_names:
                raise StoreRuntimeError("store_runtime_plan_invalid")
            local_names.add(name)
            previous = skill_specs.get(name)
            if previous is not None and previous != (identifier, name):
                raise StoreRuntimeError("store_runtime_plan_invalid")
            skill_specs[name] = (identifier, name)
            if len(skill_specs) > MAX_SKILLS:
                raise StoreRuntimeError("store_runtime_plan_invalid")
            skills.append({"identifier": identifier, "name": name})

        jobs: list[dict[str, str]] = []
        for candidate in raw["jobs"]:
            if not _exact(candidate, {"name", "schedule", "prompt", "model"}):
                raise StoreRuntimeError("store_runtime_plan_invalid")
            name = _text(candidate.get("name"), limit=256)
            schedule = _text(candidate.get("schedule"), limit=128)
            prompt = _text(candidate.get("prompt"), limit=65_536)
            model = _text(candidate.get("model"), limit=200, pattern=_MODEL)
            if not name.startswith(f"{JOB_PREFIX}{item_id}/") or name in job_names:
                raise StoreRuntimeError("store_runtime_plan_invalid")
            job_names.add(name)
            total_jobs += 1
            if total_jobs > MAX_JOBS:
                raise StoreRuntimeError("store_runtime_plan_invalid")
            # Parse now so malformed cron never reaches a mutating path.
            from cron.jobs import parse_schedule

            try:
                parsed = parse_schedule(schedule)
            except (TypeError, ValueError) as exc:
                raise StoreRuntimeError("store_runtime_plan_invalid") from exc
            if not isinstance(parsed, dict) or parsed.get("kind") != "cron":
                raise StoreRuntimeError("store_runtime_plan_invalid")
            jobs.append({"name": name, "schedule": schedule, "prompt": prompt, "model": model})
        items.append({"itemId": item_id, "skills": skills, "jobs": jobs})

    managed: list[dict[str, str]] = []
    managed_names: set[str] = set()
    for raw in raw_managed:
        if not _exact(raw, {"name", "identifier", "receiptSha256"}):
            raise StoreRuntimeError("store_runtime_state_invalid")
        name = _text(raw.get("name"), limit=128, pattern=_NAME)
        identifier = _text(raw.get("identifier"), limit=200, pattern=_IDENTIFIER)
        receipt = _text(raw.get("receiptSha256"), limit=64, pattern=_SHA256)
        if identifier.rsplit("/", 1)[-1] != name or name in managed_names:
            raise StoreRuntimeError("store_runtime_state_invalid")
        managed_names.add(name)
        managed.append({"name": name, "identifier": identifier, "receiptSha256": receipt})

    items.sort(key=lambda item: item["itemId"])
    managed.sort(key=lambda item: item["name"])
    return {"profile": PROFILE, "items": items, "managedSkills": managed}


def _receipt_digest(entry: Any) -> str | None:
    if not isinstance(entry, dict):
        return None
    encoded = json.dumps(entry, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _available_skill_names() -> set[str]:
    from hermes_cli.banner import get_available_skills

    result: set[str] = set()
    value = get_available_skills()
    if isinstance(value, dict):
        for names in value.values():
            if isinstance(names, list):
                result.update(name for name in names if isinstance(name, str))
    return result


def _install_official_skill(identifier: str, name: str) -> str:
    """Install one exact shipped optional skill and return its Hub receipt digest."""
    from tools.skills_guard import scan_skill_cached, should_allow_install
    from tools.skills_hub import HUB_DIR, HubLockFile
    from tools.skills_hub_install import install_from_quarantine, quarantine_bundle
    from tools.skills_hub_models import source_url_for_bundle
    from tools.skills_hub_official import OptionalSkillSource

    lock = HubLockFile()
    if lock.get_installed(name) is not None:
        raise StoreRuntimeError("store_runtime_skill_conflict")
    bundle = OptionalSkillSource().fetch(identifier)
    if bundle is None or bundle.identifier != identifier or bundle.name != name or bundle.source != "official":
        raise StoreRuntimeError("store_runtime_skill_unavailable")
    quarantine = quarantine_bundle(bundle)
    try:
        result, provenance = scan_skill_cached(
            quarantine,
            source="official",
            source_url=source_url_for_bundle(bundle),
            cache_dir=HUB_DIR / "scan-cache",
        )
        allowed, _reason = should_allow_install(result, force=False)
        if not allowed:
            raise StoreRuntimeError("store_runtime_skill_scan_refused")
        category = "/".join(identifier.split("/")[1:-1])
        from hermes_constants import get_hermes_home

        target = get_hermes_home() / "skills" / category / name
        if os.path.lexists(target):
            # ``install_from_quarantine`` intentionally replaces an explicit
            # user-requested install target. Automatic Store preparation has
            # no such authority and must never overwrite even a malformed or
            # partially written user path.
            raise StoreRuntimeError("store_runtime_skill_conflict")
        install_from_quarantine(
            quarantine,
            name,
            category,
            bundle,
            result,
            scan_provenance=provenance,
        )
    finally:
        if quarantine.exists():
            shutil.rmtree(quarantine, ignore_errors=True)
    digest = _receipt_digest(lock.get_installed(name))
    if digest is None:
        raise StoreRuntimeError("store_runtime_skill_install_unconfirmed")
    return digest


def _release_managed_skill(skill: dict[str, str]) -> bool:
    """Archive only the unchanged Hub receipt the controller previously recorded."""
    import uuid

    from tools.skills_hub import HubLockFile, SKILLS_DIR
    from tools.skills_hub_install import _resolve_lock_install_path
    from tools.skills_sync import _bundled_skills_write_lock, _profile_home_context
    from hermes_constants import get_hermes_home

    current = HubLockFile().get_installed(skill["name"])
    if _receipt_digest(current) != skill["receiptSha256"]:
        # Missing or changed is no longer ours. Never delete or move a user's
        # replacement merely because it has the same public skill name.
        return False
    home = get_hermes_home()
    skills_dir = Path(SKILLS_DIR)
    with _profile_home_context(home), _bundled_skills_write_lock(home, skills_dir):
        lock = HubLockFile()
        current = lock.get_installed(skill["name"])
        if _receipt_digest(current) != skill["receiptSha256"]:
            return False
        try:
            install_path = _resolve_lock_install_path(
                current.get("install_path", ""), skill["name"]
            )
        except ValueError as exc:
            raise StoreRuntimeError("store_runtime_skill_release_failed") from exc
        archive_root = skills_dir / ".archive"
        archive_root.mkdir(parents=True, exist_ok=True)
        destination = archive_root / f"{skill['name']}-{uuid.uuid4().hex}"
        try:
            install_path.rename(destination)
            lock.record_uninstall(skill["name"])
        except Exception as exc:
            if destination.exists() and not install_path.exists():
                destination.rename(install_path)
            raise StoreRuntimeError("store_runtime_skill_release_failed") from exc
    return True


def _job_matches(job: dict[str, Any], wanted: dict[str, str]) -> bool:
    from cron.jobs import parse_schedule

    # ``enabled`` / ``state`` are deliberately not part of Store ownership:
    # an owner-paused routine stays paused across entitlement reconciliation.
    return (
        job.get("name") == wanted["name"]
        and job.get("schedule") == parse_schedule(wanted["schedule"])
        and job.get("prompt") == wanted["prompt"]
        and job.get("model") == wanted["model"]
        and job.get("deliver") == "matrix"
    )


def _reconcile_jobs(wanted_jobs: list[dict[str, str]]) -> tuple[int, int]:
    from cron.jobs import create_job, load_jobs, remove_job

    wanted = {job["name"]: job for job in wanted_jobs}
    kept: set[str] = set()
    removed = 0
    for job in load_jobs():
        name = job.get("name")
        if not isinstance(name, str) or not name.startswith(JOB_PREFIX):
            continue
        target = wanted.get(name)
        if target is not None and name not in kept and _job_matches(job, target):
            kept.add(name)
            continue
        job_id = job.get("id")
        if not isinstance(job_id, str) or not remove_job(job_id):
            raise StoreRuntimeError("store_runtime_job_remove_failed")
        removed += 1

    added = 0
    for name, job in wanted.items():
        if name in kept:
            continue
        create_job(
            schedule=job["schedule"],
            prompt=job["prompt"],
            name=name,
            deliver="matrix",
            model=job["model"],
        )
        added += 1
    return added, removed


def reconcile_store_runtime(value: Any) -> dict[str, Any]:
    """Apply one entitlement-authorized plan idempotently before session open."""
    from hermes_cli.atum_runtime_environment import in_cloud_sandbox

    if not in_cloud_sandbox():
        # The held path relies on the controller discarding this task home.
        # Keep the mutator unreachable from long-lived Desktop/CLI homes.
        raise StoreRuntimeError("store_runtime_unavailable")
    plan = validate_store_runtime_plan(value)
    previous = {skill["name"]: skill for skill in plan["managedSkills"]}
    desired: dict[str, dict[str, str]] = {}
    required_by_item: dict[str, list[str]] = {}
    for item in plan["items"]:
        required_by_item[item["itemId"]] = []
        for skill in item["skills"]:
            desired[skill["name"]] = skill
            required_by_item[item["itemId"]].append(skill["name"])

    available = _available_skill_names()
    usable: set[str] = set()
    next_managed: dict[str, dict[str, str]] = {}
    installed = 0
    for name, skill in desired.items():
        prior = previous.get(name)
        if name in available:
            from tools.skills_hub import HubLockFile

            receipt = HubLockFile().get_installed(name)
            # Continue ownership only while the exact receipt still matches.
            if prior is not None and _receipt_digest(receipt) == prior["receiptSha256"]:
                next_managed[name] = prior
                usable.add(name)
            # A person may have installed the exact official skill first. It
            # satisfies the hire but remains user-owned and is never removed.
            elif isinstance(receipt, dict) and receipt.get("identifier") == skill["identifier"]:
                usable.add(name)
            # A local/builtin skill that merely reuses the public name is not
            # the optional package this hire requires. Hold rather than run a
            # paid routine under substituted instructions.
            continue
        try:
            receipt = _install_official_skill(skill["identifier"], name)
        except StoreRuntimeError:
            continue
        installed += 1
        usable.add(name)
        next_managed[name] = {**skill, "receiptSha256": receipt}

    held = sorted(
        item_id for item_id, names in required_by_item.items() if any(name not in usable for name in names)
    )
    if held:
        # Do not remove a prior entitlement or rewrite its jobs on a partial
        # preparation. The sandbox is discarded before prompt submission and
        # the previous sealed home remains authoritative.
        return {
            "profile": PROFILE,
            "outcome": "held",
            "installed": installed,
            "released": 0,
            "added": 0,
            "removed": 0,
            "held": held,
            "state": {
                "v": 1,
                "items": sorted(item["itemId"] for item in plan["items"]),
                "managedSkills": sorted(next_managed.values(), key=lambda skill: skill["name"]),
            },
        }

    released = 0
    for name, prior in previous.items():
        if name not in desired:
            released += int(_release_managed_skill(prior))

    jobs = [job for item in plan["items"] for job in item["jobs"]]
    added, removed = _reconcile_jobs(jobs)
    return {
        "profile": PROFILE,
        "outcome": "ok",
        "installed": installed,
        "released": released,
        "added": added,
        "removed": removed,
        "held": [],
        "state": {
            "v": 1,
            "items": sorted(item["itemId"] for item in plan["items"]),
            "managedSkills": sorted(next_managed.values(), key=lambda skill: skill["name"]),
        },
    }
