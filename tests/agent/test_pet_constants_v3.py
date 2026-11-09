"""The v3 row taxonomy: one more pose, and sheets that tell their version by height."""

from __future__ import annotations

from agent.pet import constants
from agent.pet.constants import PetState


def test_row_counts_are_unambiguous() -> None:
    # Look rows only come in pairs, so every count maps to exactly one taxonomy.
    assert constants.state_rows_for_grid(8) == constants.LEGACY_STATE_ROWS
    assert constants.state_rows_for_grid(9) == constants.CODEX_STATE_ROWS
    assert constants.state_rows_for_grid(10) == constants.V3_STATE_ROWS
    assert constants.state_rows_for_grid(11) == constants.CODEX_STATE_ROWS
    assert constants.state_rows_for_grid(12) == constants.V3_STATE_ROWS


def test_look_rows_follow_whichever_taxonomy_the_sheet_carries() -> None:
    assert constants.look_row_start(9) is None
    assert constants.look_row_start(10) is None
    assert constants.look_row_start(11) == 9
    assert constants.look_row_start(12) == 10


def test_lounging_falls_back_to_sitting_on_a_sheet_without_the_row() -> None:
    assert constants.state_row_index(PetState.LOUNGING, 12) == 9
    # A Codex sheet has no lounging row: the nearest honest pose is waiting.
    assert constants.state_row_index(PetState.LOUNGING, 9) == constants.CODEX_STATE_ROWS.index("waiting")
