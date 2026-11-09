"""Public descriptors for server-applied training; never private skill bodies.

Reuse the profile identity and SessionDB compression lineage. This local binding
is a routing hint, not entitlement authority: the hosted edge checks the live
agent grant and its immutable task pin on every request.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import uuid

_SESSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\Z")
_SKILL = re.compile(r"[a-z0-9][a-z0-9/_-]{0,127}\Z")
_FIELDS = {"task_id", "assistant_id", "assistant_identity_id", "conversation_id", "skill_id"}
# Pilot instructions are limited to 16 KiB by platform 0129. Reserving a token
# per UTF-8 byte plus framing is deliberately conservative and needs no private
# content or tokenizer in the client. The existing compressor still reserves
# model output space. This cap must change with the server publication bound.
TRAINING_CONTEXT_RESERVE = 16_384 + 128


def validate_task(task):
    if not isinstance(task, dict) or set(task) != _FIELDS:
        raise ValueError("invalid training descriptor")
    for key in ("task_id", "assistant_id", "assistant_identity_id"):
        if not isinstance(task[key], str) or str(uuid.UUID(task[key])) != task[key].lower():
            raise ValueError("invalid training identity")
    if not isinstance(task["conversation_id"], str) or not _SESSION.fullmatch(task["conversation_id"]):
        raise ValueError("invalid training conversation")
    if task["skill_id"] is not None and (not isinstance(task["skill_id"], str) or not _SKILL.fullmatch(task["skill_id"])):
        raise ValueError("invalid training skill")
    return dict(task)


def _path(home, conversation):
    digest = hashlib.sha256(conversation.encode()).hexdigest()
    return Path(home) / "atum-training" / (digest + ".json")


def bind_task(home, owner, task):
    task = validate_task(task)
    if task["assistant_identity_id"] != owner["agent_id"] or task["conversation_id"] != owner["conversation_id"]:
        raise ValueError("training belongs to another agent or conversation")
    path = _path(home, task["conversation_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if json.loads(path.read_text(encoding="utf-8-sig")) != task:
            raise ValueError("training cannot change within a conversation")
        return task
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".binding-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(task, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        # Atomic create-only publication. Concurrent binds may agree, but
        # never replace a different pin after checking an earlier snapshot.
        try:
            os.link(temporary, path)
        except FileExistsError:
            if json.loads(path.read_text(encoding="utf-8-sig")) != task:
                raise ValueError("training cannot change within a conversation")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return task


def _training_state(session_id, home=None):
    if not isinstance(session_id, str) or not _SESSION.fullmatch(session_id):
        return None
    from hermes_constants import get_hermes_home
    from hermes_cli.profiles import read_profile_meta
    from tui_gateway.surface_context import context_db
    home = Path(home or get_hermes_home())
    identity = read_profile_meta(home).get("identity_id")
    if not identity:
        return None
    conversation, task = session_id, None
    if (home / "state.db").exists():
        with context_db(home) as db:
            lineage = db.get_compression_lineage(session_id) or [session_id]
            conversation = lineage[0]
            # A restored conversation carries only its public binding in the
            # existing message metadata export. Recover once, then read the
            # small local descriptor on subsequent provider calls.
            if not _path(home, conversation).exists():
                for segment in lineage:
                    metadata = db.find_message_display_metadata(segment, "atum_training")
                    if metadata is not None:
                        task = validate_task(metadata["atum_training"])
                        bind_task(home, {"agent_id": identity, "conversation_id": conversation}, task)
                        break
    path = _path(home, conversation)
    if path.exists():
        if path.stat().st_size > 4096:
            raise ValueError("training descriptor unavailable")
        task = validate_task(json.loads(path.read_text(encoding="utf-8-sig")))
        if task["assistant_identity_id"] != identity or task["conversation_id"] != conversation:
            raise ValueError("training descriptor ownership mismatch")
    return identity, conversation, task


def training_context(session_id, home=None):
    state = _training_state(session_id, home)
    if state is None:
        return None
    identity, conversation, task = state
    headers = {"x-atum-assistant-identity-id": identity, "x-atum-conversation-id": conversation}
    return headers if task is None else {
        **headers, "x-atum-training-task-id": task["task_id"], "skill_id": task["skill_id"]}


def apply_training_context_budget(agent, session_id):
    """Budget hidden instruction tokens before the ordinary turn preflight.

    Reuse ContextCompressor.update_model so output reservation, summary/tail
    budgets and user threshold caps remain consistent. Repeated turns do not
    subtract repeatedly; a real model switch adopts the newly resolved window.
    This adjusts compression timing, never historical prompt content.
    """
    compressor = getattr(agent, "context_compressor", None)
    if compressor is None:
        return
    context = training_context(session_id)
    selected = bool(context and context.get("x-atum-training-task-id"))
    current = compressor.context_length
    previous = getattr(compressor, "_atum_training_context_budget", None)
    base = previous[0] if previous and current == previous[1] else current
    if not selected and not previous:
        return
    available = base - TRAINING_CONTEXT_RESERVE if selected else base
    if available <= max(1024, int(compressor.max_tokens or 0)):
        raise ValueError("training_context_unavailable")
    # update_model resets real-usage calibration and anti-thrash state. Keep
    # those across ordinary trained turns when the effective window is stable.
    if current != available:
        compressor.update_model(compressor.model, available, base_url=compressor.base_url,
                                api_key=compressor.api_key, provider=compressor.provider,
                                api_mode=compressor.api_mode)
    compressor._atum_training_context_budget = (base, available) if selected else None


def stamp_training_result(agent, session_id, run_message, result):
    """Preserve a public task pin through ordinary history export/restore.

    Existing display metadata is excluded from model request content. Merge
    rather than replace capture/synthetic provenance; never persist a body.
    """
    state = _training_state(session_id)
    task = state[2] if state else None
    if not task or not isinstance(result, dict):
        return
    for message in reversed(result.get("messages") or []):
        if message.get("role") != "user" or message.get("content") != run_message:
            continue
        metadata = {**(message.get("display_metadata") or {}), "atum_training": task}
        kind = message.get("display_kind") or "atum_training"
        db = getattr(agent, "_session_db", None)
        if db is not None:
            db.set_latest_matching_message_display_kind(
                getattr(agent, "session_id", None) or session_id, role="user", content=run_message,
                display_kind=kind, display_metadata=metadata)
        message["display_kind"], message["display_metadata"] = kind, metadata
        break


def selected_skill(session_id):
    context = training_context(session_id)
    if not context or not context.get("skill_id"):
        return None
    return {"name": context["skill_id"], "category": "Training", "delivery": "cloud",
            "description": "Selected training. Atum verifies access and applies the instructions in the cloud for this task."}


def public_skills(session_id):
    """Discover acquired cloud skills using public proof metadata only."""
    from hermes_cli import atum_store_proof as proof
    selected = selected_skill(session_id)
    entries = [selected] if selected else []
    if proof.proof_error() is not None:
        return entries
    for item in proof.catalog_owned_items() or []:
        if (item["kind"] != "skill" or item.get("delivery") != "cloud"
                or (selected and item["id"] == selected["name"])
                or proof.entitlement_state(None, "skill", item["id"]) != "active"):
            continue
        entries.append({"name": item["id"], "category": "Training", "delivery": "cloud",
                        "description": "Learned training. Choose Use in Atum to start a task with this skill."})
    return entries


def view_selected_skill(name, session_id, file_path=None):
    selected = selected_skill(session_id)
    if selected and name == selected["name"]:
        if file_path:
            return {"success": False, "error": "Private training files are not available for download.",
                    "name": name, "delivery": "cloud"}
        return {"success": True, **selected, "state": "selected",
                "content": "Atum applies this training in the cloud after verifying access. "
                           "Continue the user's task with the available tools. No local skill file is required."}
    from hermes_cli import atum_store_proof as proof
    item = proof.match_catalog_item(proof.catalog_owned_items(), "skill", name)
    if item is None or item.get("delivery") != "cloud":
        return None
    if proof.proof_error() is not None:
        state, message = "unavailable", "Connect to Atum to check this agent's training."
    elif proof.entitlement_state(None, "skill", item["id"]) == "active":
        state, message = "not_selected", "Choose Use for this skill in Atum to start a new task with its training."
    else:
        state, message = "training_required", "Teach this skill to the selected agent in Atum before using it."
    return {"success": False, "name": item["id"], "delivery": "cloud", "state": state, "error": message}
