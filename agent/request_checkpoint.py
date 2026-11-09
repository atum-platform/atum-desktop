"""Durable ownership at an idempotent request / effect-consumption boundary.

The adapter supplies public JSON continuation data and a current authority scope.
This module knows nothing about model providers, training, billing, or surfaces.
It reuses SessionDB's atomic metadata operations rather than another state store.

Only ``pending`` is replayable. Reclaiming it changes the owner; an older worker
cannot consume the result afterward. ``consuming`` is written BEFORE any response
hook or tool effect and is never replayed. Process death needs no expiring lease:
replaying the pending operation is safe by the adapter's idempotency contract,
and compare-and-swap gives exactly one worker permission to consume its result.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Protocol

VERSION = 1
MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024


class AtomicMetadata(Protocol):
    def get_meta(self, key: str) -> str | None: ...
    def claim_meta(self, key: str, value: str) -> tuple[bool, str]: ...
    def compare_meta(self, key: str, expected: str, value: str) -> bool: ...


class CheckpointUnavailable(RuntimeError):
    """No safe automatic continuation exists; retain the task for inspection."""


class CheckpointSuperseded(CheckpointUnavailable):
    """Another worker or cancellation won. The caller must perform no effects."""


def _encode(value: dict) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) > MAX_CHECKPOINT_BYTES:
        raise CheckpointUnavailable("task_checkpoint_too_large")
    return encoded


def checkpoint_key(execution_id: str) -> str:
    if not isinstance(execution_id, str) or not execution_id:
        raise CheckpointUnavailable("task_checkpoint_identity_missing")
    return "execution.request.v1:" + hashlib.sha256(execution_id.encode()).hexdigest()


def read_checkpoint(db: AtomicMetadata, execution_id: str) -> dict | None:
    raw = db.get_meta(checkpoint_key(execution_id))
    if raw is None:
        return None
    try:
        value = json.loads(raw)
        if (not isinstance(value, dict) or value.get("version") != VERSION
                or value.get("execution_id") != execution_id
                or value.get("phase") not in {"preparing", "pending", "consuming", "completed", "paused", "cancelled"}
                or not isinstance(value.get("owner"), str)
                or not isinstance(value.get("scope"), dict)):
            raise ValueError("invalid checkpoint")
        _encode(value)
        return value
    except (ValueError, TypeError) as exc:
        raise CheckpointUnavailable("task_checkpoint_invalid") from exc


class RequestCheckpoint:
    """One fenced writer. Create fresh or reclaim one exact pending request."""

    def __init__(self, db: AtomicMetadata, execution_id: str, scope: dict, *, recover: bool = False):
        self.db = db
        self.key = checkpoint_key(execution_id)
        self.value = {"version": VERSION, "execution_id": execution_id,
                      "scope": scope, "owner": str(uuid.uuid4()), "phase": "preparing"}
        if recover:
            previous = read_checkpoint(db, execution_id)
            if (previous is None or previous["phase"] != "pending"
                    or previous["scope"] != scope or not isinstance(previous.get("payload"), dict)
                    or previous.get("recoveries", 0) != 0):
                raise CheckpointUnavailable("task_checkpoint_not_recoverable")
            # The returned payload is frozen JSON, never a shared runtime object.
            self.value = {**previous, "owner": self.value["owner"], "recoveries": 1}
            self.raw = _encode(self.value)
            if not db.compare_meta(self.key, _encode(previous), self.raw):
                raise CheckpointSuperseded("task_checkpoint_superseded")
        else:
            self.raw = _encode(self.value)
            claimed, _ = db.claim_meta(self.key, self.raw)
            if not claimed:
                raise CheckpointUnavailable("task_checkpoint_already_exists")

    def _replace(self, value: dict) -> None:
        raw = _encode(value)
        if not self.db.compare_meta(self.key, self.raw, raw):
            raise CheckpointSuperseded("task_checkpoint_superseded")
        self.value, self.raw = json.loads(raw), raw

    def pending(self, payload: dict, *, replace_unstarted: bool = False) -> None:
        """Replace pending data only with the adapter's non-dispatch evidence.

        Merely being a fresh worker is not evidence that a failed request was
        unbilled. Reclaimed operations always retain their exact payload.
        """
        if self.value["phase"] not in {"preparing", "consuming", "pending"}:
            raise CheckpointUnavailable("task_checkpoint_closed")
        if self.value["phase"] == "pending" and self.value.get("payload") != payload:
            if not replace_unstarted or self.value.get("recoveries", 0) != 0:
                raise CheckpointUnavailable("task_checkpoint_request_changed")
        recoveries = self.value.get("recoveries", 0) if self.value["phase"] == "pending" else 0
        self._replace({**self.value, "phase": "pending", "payload": payload, "recoveries": recoveries})

    def consume(self) -> None:
        if self.value["phase"] != "pending":
            raise CheckpointUnavailable("task_checkpoint_not_pending")
        self._replace({key: value for key, value in {**self.value, "phase": "consuming"}.items()
                       if key != "payload"})

    def finish(self, *, completed: bool) -> None:
        self._replace({key: value for key, value in {
            **self.value, "phase": "completed" if completed else "paused",
        }.items() if key != "payload"})

    def assert_current(self) -> None:
        if self.db.get_meta(self.key) != self.raw:
            raise CheckpointSuperseded("task_checkpoint_superseded")


def cancel_checkpoint(db: AtomicMetadata, execution_id: str) -> None:
    """Fence a pending worker without relying on process or transport liveness."""
    previous = read_checkpoint(db, execution_id)
    if previous is None or previous["phase"] in {"completed", "paused", "cancelled"}:
        return
    value = {key: item for key, item in {**previous, "phase": "cancelled"}.items() if key != "payload"}
    if not db.compare_meta(checkpoint_key(execution_id), _encode(previous), _encode(value)):
        raise CheckpointSuperseded("task_checkpoint_superseded")
