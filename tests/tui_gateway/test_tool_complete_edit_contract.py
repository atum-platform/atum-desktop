"""``tool.complete`` carries the Atum edit preview (``tool_progress._build_edit_payload``) inside its
declared contract: under ``HERMES_TEST_ISOLATION`` a field the contract does not declare raises."""

import json

import pytest

from tui_gateway import server
from tui_gateway.contracts import registry


def _complete_payload(tmp_path, *, existed: bool) -> dict:
    target = tmp_path / "notes.md"
    if existed:
        target.write_text("before\n", encoding="utf-8")
    session = {"cwd": str(tmp_path), "agent": None, "active_turn_id": "turn-1",
               "edit_targets": {"call-1": {"exists": existed}}, "edit_snapshots": {}}
    args = {"path": str(target), "content": "after\n"}
    target.write_text("after\n", encoding="utf-8")
    result = json.dumps({"success": True, "bytes_written": 6})
    server._sessions["sid"] = session
    try:
        metadata = server._prepare_tool_result_metadata("sid", "call-1", "write_file", args, result)["tool_result_metadata"]
    finally:
        server._sessions.pop("sid", None)
    # The fields _on_tool_complete always sets, then the prepared metadata, as it merges them.
    return {"tool_id": "call-1", "name": "write_file", "args": args, **metadata, "result": json.loads(result)}


@pytest.mark.parametrize("existed", [False, True])
def test_an_edit_preview_is_inside_the_tool_complete_contract(tmp_path, existed):
    assert registry.STRICT
    payload = _complete_payload(tmp_path, existed=existed)
    assert payload["edit"]["files"][0]["kind"] == ("modified" if existed else "created")
    registry.check_payload("tool.complete", payload)  # raises ContractViolation when undeclared


def test_a_malformed_edit_preview_still_violates_it(tmp_path):
    payload = _complete_payload(tmp_path, existed=False)
    payload["edit"]["files"][0]["kind"] = "renamed"
    with pytest.raises(registry.ContractViolation):
        registry.check_payload("tool.complete", payload)
