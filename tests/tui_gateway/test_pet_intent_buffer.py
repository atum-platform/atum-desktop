"""Direct contract tests for the turn-bound reply pet collector."""

from tui_gateway.pet_intents import PetIntentBuffer


def test_cap_dedupes_and_preserves_order():
    buffer = PetIntentBuffer()
    queue = buffer.begin("turn-a")

    assert queue({"action": "wave"}) == {"ok": True, "queued": True}
    assert queue({"action": "wave"}) == {"ok": True, "queued": True}
    assert queue({"action": "go", "place": "left"}) == {"ok": True, "queued": True}
    assert queue({"action": "sit"}) == {"ok": True, "queued": True}
    assert queue({"action": "lounge"}) == {"ok": False, "reason": "intent_limit"}

    assert buffer.finish(queue) == [
        {"action": "wave"},
        {"action": "go", "place": "left"},
        {"action": "sit"},
    ]


def test_collector_fails_closed_for_noncanonical_commands():
    buffer = PetIntentBuffer()
    queue = buffer.begin("turn-a")

    assert queue({"action": "go", "place": "centre"}) == {
        "ok": False,
        "reason": "invalid_pet_intent",
    }
    assert queue({"action": "wave", "place": "left"}) == {
        "ok": False,
        "reason": "invalid_pet_intent",
    }
    assert queue({"action": ["wave"]}) == {
        "ok": False,
        "reason": "invalid_pet_intent",
    }
    assert buffer.finish(queue) == []


def test_stale_callback_cannot_revive_reused_turn_id_or_drain_new_turn():
    buffer = PetIntentBuffer()
    first = buffer.begin("reused-turn")
    second = buffer.begin("reused-turn")

    assert first({"action": "wave"}) == {"ok": False, "reason": "no_active_pet_turn"}
    assert second({"action": "jump"}) == {"ok": True, "queued": True}
    assert buffer.finish(first) == []
    assert buffer.finish(second) == [{"action": "jump"}]
    assert second({"action": "sit"}) == {"ok": False, "reason": "no_active_pet_turn"}


def test_failed_turn_discards_intents_and_invalidates_callback():
    buffer = PetIntentBuffer()
    queue = buffer.begin("turn-a")
    assert queue({"action": "wave"}) == {"ok": True, "queued": True}

    assert buffer.finish(queue, success=False) == []
    assert queue({"action": "jump"}) == {"ok": False, "reason": "no_active_pet_turn"}
    assert buffer.finish(queue) == []


def test_separate_collectors_do_not_share_turn_data():
    left = PetIntentBuffer()
    right = PetIntentBuffer()
    left_queue = left.begin("same-turn")
    right_queue = right.begin("same-turn")

    assert left_queue({"action": "wave"}) == {"ok": True, "queued": True}
    assert right_queue({"action": "sit"}) == {"ok": True, "queued": True}

    assert left.finish(left_queue) == [{"action": "wave"}]
    assert right.finish(right_queue) == [{"action": "sit"}]
