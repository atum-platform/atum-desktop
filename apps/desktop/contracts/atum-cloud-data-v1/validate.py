#!/usr/bin/env python3
"""Standard-library validation for the atum.cloud-data/1 Wave 0 pack."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parent
PIN = ROOT / "PINNED-SHA256"


class Reject(ValueError):
    """A fixture or pack invariant is invalid."""


def reject(message: str) -> NoReturn:
    raise Reject(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        reject(message)


def load(relative: str) -> dict:
    with (ROOT / relative).open(encoding="utf-8") as handle:
        value = json.load(handle)
    require(isinstance(value, dict), f"{relative}: expected object")
    return value


def pack_digest(contract: dict) -> str:
    """Hash only the contract-declared manifest, never ambient local files."""
    files = contract["pack_files"]
    require(files == sorted(files), "pack_files must be sorted")
    require(len(files) == len(set(files)), "pack_files must be unique")
    digest = hashlib.sha256()
    for relative_text in files:
        relative = Path(relative_text)
        require(not relative.is_absolute() and ".." not in relative.parts, "unsafe pack path")
        path = ROOT / relative
        require(path.is_file(), f"missing pack file: {relative_text}")
        encoded = relative.as_posix().encode()
        body = path.read_bytes()
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(len(body).to_bytes(8, "big"))
        digest.update(body)
    return digest.hexdigest()


def validate_record(record: dict, contract: dict) -> None:
    require(record["record_kind"] in contract["record_kinds"], "unknown record kind")
    require(record["scope"]["kind"] in contract["scope_kinds"], "unknown scope kind")
    require(record["revision"] >= 1 and record["generation"] >= 1, "invalid revision")
    require(record["lifecycle"] == "active", "upserts must be active")
    require(record["untrusted_input"] is True, "stored content must be untrusted")
    require(isinstance(record["provenance"], dict) and bool(record["provenance"]), "missing provenance")
    require(bool(record["occurred_at"]) and bool(record["recorded_at"]), "missing timestamps")


def assert_no_forbidden_keys(value: object, forbidden: set[str], path: str = "$") -> None:
    if isinstance(value, dict):
        overlap = forbidden.intersection(value)
        require(not overlap, f"{path}: forbidden authority fields: {sorted(overlap)}")
        for key, child in value.items():
            assert_no_forbidden_keys(child, forbidden, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_forbidden_keys(child, forbidden, f"{path}[{index}]")


def validate_bundle(bundle: dict, contract: dict) -> None:
    rules = contract["retrieval"]
    require(bundle["fresh"] is True, "fresh=false makes the entire bundle unusable")
    require("next_cursor" not in bundle, "v1 retrieval has no continuation cursor")
    require(bundle["scope"]["kind"] in contract["scope_kinds"], "unknown bundle scope")
    require(len(bundle["items"]) <= rules["max_items"], "bundle item limit exceeded")
    actual_bytes = sum(len(item["content"].encode("utf-8")) for item in bundle["items"])
    require(bundle["content_utf8_bytes"] == actual_bytes, "bundle byte count mismatch")
    require(actual_bytes <= rules["max_content_utf8_bytes"], "bundle byte limit exceeded")
    excluded = set(rules["excluded_lifecycle_states"])
    for item in bundle["items"]:
        source = item["source"]
        require(item["untrusted_input"] is True, "bundle content must be untrusted")
        require(source["lifecycle"] in contract["lifecycle_states"], "missing source lifecycle")
        require(source["lifecycle"] not in excluded, "excluded lifecycle in bundle")
        require(bool(source["occurred_at"]), "missing source occurred_at")
        require(source["revision"] >= 1 and source["generation"] >= 1, "invalid source version")
        if source["record_kind"] == "memory_fact":
            refs = source["source_refs"]
            require(0 < len(refs) <= rules["max_sources_per_derived_item"], "derived source fan-in invalid")


def validate_sync_fixture(fixture: dict, contract: dict) -> None:
    changes = fixture["changes"]
    require(bool(changes), "sync fixture must contain changes")
    ids = [change["change_id"] for change in changes]
    require(all(isinstance(change_id, int) and change_id >= 1 for change_id in ids), "change_id must be a positive JSON integer")
    require(ids == sorted(ids) and len(ids) == len(set(ids)), "change_id ordering or uniqueness invalid")
    for change in changes:
        operation = change["operation"]
        require(operation in contract["change_operations"], "unknown change operation")
        body = change.get("record") or change.get("tombstone") or change.get("invalidation")
        require(isinstance(body, dict), "change body missing")
        if body["record_kind"] == "memory_fact":
            require(operation in contract["sync"]["memory_fact_operations"], "memory_fact content is retrieval-only")
        if operation == "upsert":
            require(set(change) == {"change_id", "operation", "record"}, "invalid upsert envelope")
            validate_record(change["record"], contract)
        elif operation == "tombstone":
            tombstone = change["tombstone"]
            require(set(change) == {"change_id", "operation", "tombstone"}, "invalid tombstone envelope")
            require(set(tombstone) == set(contract["sync"]["tombstone_allowed_fields"]), "invalid tombstone fields")
            require("payload" not in tombstone, "tombstone must not contain payload")
            require(tombstone["lifecycle"] == "deleted", "tombstone must be deleted")
        else:
            invalidation = change["invalidation"]
            require(set(change) == {"change_id", "operation", "invalidation"}, "invalid invalidation envelope")
            require(set(invalidation) == set(contract["sync"]["invalidation_allowed_fields"]), "invalid invalidation fields")
            require("payload" not in invalidation, "invalidation must not contain payload")
            require(invalidation["lifecycle"] == "invalidated", "invalid invalidation lifecycle")
            require(invalidation["generation"] >= 1 and bool(invalidation["reason"]), "invalid invalidation metadata")


def expect_reject(callback, message: str) -> None:
    try:
        callback()
    except Reject:
        return
    reject(message)


def main() -> None:
    contract = load("contract.json")
    require(contract["contract_id"] == "atum.cloud-data", "wrong contract id")
    require(contract["version"] == 1 and contract["status"] == "frozen", "wrong contract version/status")
    require(contract["sync"]["change_id_type"] == "json_integer", "change_id type is not pinned")
    require(contract["sync"]["reset_error_code"] == "SYNC_CURSOR_EXPIRED", "cursor reset code drifted")
    require(contract["retrieval"]["one_scope_per_request"] is True, "retrieval must be single-scope")
    require(contract["retrieval"]["max_items"] == 50, "retrieval item limit drifted")
    require(contract["retrieval"]["max_content_utf8_bytes"] == 65536, "retrieval byte limit drifted")
    require(contract["retrieval"]["max_sources_per_derived_item"] == 16, "source fan-in limit drifted")
    require(set(contract["app_history_ingest"]["server_derived"]) <= set(contract["server_owned_fields"]), "server-derived fields are not server-owned")

    declared_fixtures = contract["fixtures"]["positive"] + contract["fixtures"]["adversarial"]
    require(set(declared_fixtures) == {path for path in contract["pack_files"] if path.startswith("fixtures/")}, "fixture manifest mismatch")
    for relative in ("fixtures/p2p-sync.response.json", "fixtures/app-history-sync.response.json", "fixtures/derived-invalidation-sync.response.json"):
        validate_sync_fixture(load(relative), contract)

    reset = load("fixtures/sync-cursor-expired.response.json")["error"]
    require(reset["code"] == contract["sync"]["reset_error_code"], "cursor reset code mismatch")
    require(reset["reset"] == contract["sync"]["reset"], "cursor reset signal mismatch")

    app_ingest = load("fixtures/app-history-ingest.request.json")
    require(set(app_ingest) <= set(contract["app_history_ingest"]["allowed_request_fields"]), "unknown app-history request field")
    assert_no_forbidden_keys(app_ingest, set(contract["server_owned_fields"]))
    for artifact in app_ingest["artifacts"]:
        require(set(artifact) <= set(contract["app_history_ingest"]["artifact_allowed_request_fields"]), "unknown artifact request field")
        require(artifact["requested_copy_mode"] in contract["artifact_copy_modes"], "invalid requested copy mode")
    ack = load("fixtures/app-history-ingest.response.json")
    require(ack["durability"] == "committed", "ingest ack preceded durable commit")
    for artifact in ack["artifacts"]:
        require(artifact["effective_copy_mode"] in contract["app_history_ingest"]["acknowledgement"]["allowed_copy_modes"], "invalid effective copy mode")
        if artifact["requested_copy_mode"] != artifact["effective_copy_mode"]:
            require(bool(artifact["copy_decision"]), "copy-mode downgrade missing reason")
    forged_ingest = load("fixtures/app-history-forged-authority.request.json")
    expect_reject(lambda: assert_no_forbidden_keys(forged_ingest, set(contract["server_owned_fields"])), "forged app-history authority was accepted")

    request = load("fixtures/retrieval-thread.request.json")
    retrieval = contract["retrieval"]
    require(set(request) <= set(retrieval["allowed_request_fields"]), "unknown retrieval request field")
    require(request["scope"]["kind"] in contract["scope_kinds"], "unknown retrieval scope")
    require(0 < request["max_items"] <= retrieval["max_items"], "invalid requested item limit")
    require(0 < request["max_content_utf8_bytes"] <= retrieval["max_content_utf8_bytes"], "invalid requested byte limit")
    assert_no_forbidden_keys(request, set(retrieval["forbidden_request_fields"]))

    validate_bundle(load("fixtures/retrieval-thread.response.json"), contract)
    forged = load("fixtures/retrieval-forged-authority.request.json")
    expect_reject(lambda: assert_no_forbidden_keys(forged, set(retrieval["forbidden_request_fields"])), "forged retrieval authority was accepted")
    invalidated = load("fixtures/retrieval-invalidated-source.response.json")
    expect_reject(lambda: validate_bundle(invalidated, contract), "invalidated retrieval source was accepted")

    expected = PIN.read_text(encoding="utf-8").strip()
    actual = pack_digest(contract)
    require(expected == actual, f"pack checksum mismatch: expected {expected}, got {actual}")
    print(f"CLOUD_DATA_V1_OK fixtures={len(declared_fixtures)} sha256={actual}")


if __name__ == "__main__":
    main()
