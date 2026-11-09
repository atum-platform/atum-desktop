"""The Python schedule mapper against the vectors the controller's TypeScript twin (routines-import.ts
``mapHermesSchedule``) is tested with: the two must give the same schedule or the same words for every input."""

import json
from pathlib import Path

import pytest

from cron.routines_mapper import map_parsed_schedule

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "routine-schedule-vectors.json").read_text(
        encoding="utf-8"
    )
)


def test_vectors_cover_every_supported_kind_and_refusal():
    kinds = {entry["schedule"]["kind"] for entry in VECTORS if "schedule" in entry}
    assert {"once", "daily", "weekly", "monthly"} <= kinds
    assert sum(1 for entry in VECTORS if "refusal" in entry) >= 10


@pytest.mark.parametrize("entry", VECTORS, ids=[entry["name"] for entry in VECTORS])
def test_mapper_matches_the_shared_vector(entry):
    mapped = map_parsed_schedule(entry["parsed"])
    assert mapped.schedule == entry.get("schedule")
    assert mapped.refusal == entry.get("refusal")
