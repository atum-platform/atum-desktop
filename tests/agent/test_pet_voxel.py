"""The design service: one call, one repair, typed failures, bounded input.

Every case runs against a fake ``call``; nothing here talks to a model.
"""

from __future__ import annotations

import io
import json
from types import SimpleNamespace

import pytest

pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

from agent.pet.generate import voxel as V  # noqa: E402
from scripts.pets.spec import COOKIE_SPEC, GIGI_SPEC  # noqa: E402


def _reply(text: str, *, prompt_tokens: int = 100, completion_tokens: int = 50, model: str = "moonshotai/kimi-k3"):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=SimpleNamespace(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens),
        model=model,
    )


def _pets(*specs) -> str:
    return json.dumps({"pets": [s.to_dict() for s in specs]})


class Fake:
    """A scripted model: each call pops the next reply or raises the next error."""

    def __init__(self, *replies) -> None:
        self.replies = list(replies)
        self.calls: list[dict] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        item = self.replies.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def test_one_call_no_response_format_and_the_specs_come_back() -> None:
    fake = Fake(_reply(_pets(GIGI_SPEC, COOKIE_SPEC, GIGI_SPEC, COOKIE_SPEC)))

    design = V.design_pets("a scruffy grey terrier", count=4, call=fake)

    assert [s.name for s in design.specs] == ["Gigi", "Cookie", "Gigi", "Cookie"]
    assert design.repairs == 0 and design.usage == {"prompt_tokens": 100, "completion_tokens": 50, "calls": 1}
    assert design.model == "moonshotai/kimi-k3"
    req = fake.calls[0]
    assert req["task"] == "pet_hatch"
    assert "extra_body" not in req and "response_format" not in json.dumps(req["messages"])
    assert req["timeout"] == V.TIMEOUT_SECONDS and req["max_tokens"] == V.MAX_TOKENS
    assert "a scruffy grey terrier" in req["messages"][1]["content"][0]["text"]
    assert "cookie:" in req["messages"][0]["content"], "the shipped dogs are the examples"


def test_a_photo_reaches_the_request_as_one_image_part_re_encoded_and_bounded() -> None:
    raw = io.BytesIO()
    Image.new("RGB", (2000, 1500), (200, 120, 60)).save(raw, format="PNG")
    fake = Fake(_reply(_pets(GIGI_SPEC)))

    V.design_pets("", count=1, reference_image=raw.getvalue(), call=fake)

    content = fake.calls[0]["messages"][1]["content"]
    assert [part["type"] for part in content] == ["text", "image_url"]
    url = content[1]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,")
    sent = Image.open(io.BytesIO(__import__("base64").b64decode(url.split(",", 1)[1])))
    assert max(sent.size) <= V.REFERENCE_SEND_SIDE and sent.format == "JPEG"


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"", "empty"),
        (b"GIF89a" + b"\x00" * 40, "could not be read"),
        (b"x" * (V.MAX_REFERENCE_BYTES + 1), "over 4 MB"),
    ],
)
def test_a_bad_photo_is_unsupported_input_before_any_call(data: bytes, message: str) -> None:
    fake = Fake()
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", reference_image=data, call=fake)
    assert caught.value.kind == "unsupported_input" and message in str(caught.value)
    assert fake.calls == []


def test_a_gif_and_a_huge_image_are_refused() -> None:
    gif = io.BytesIO()
    Image.new("RGB", (8, 8)).save(gif, format="GIF")
    with pytest.raises(V.VoxelDesignError, match="PNG, JPEG or WebP"):
        V.reference_data_url(gif.getvalue())
    huge = io.BytesIO()
    Image.new("1", (V.MAX_REFERENCE_SIDE + 1, 1)).save(huge, format="PNG")
    with pytest.raises(V.VoxelDesignError, match="at most 4096px"):
        V.reference_data_url(huge.getvalue())


def test_an_invalid_reply_is_repaired_once_with_the_parsers_words() -> None:
    fake = Fake(_reply("```json\n{\"pets\": [{\"plan\": \"dog\", \"name\": \"Bob\", \"ears\": \"floppy\", \"palette\": {}}]}\n```"), _reply(_pets(GIGI_SPEC, COOKIE_SPEC)))

    design = V.design_pets("x", count=2, call=fake)

    assert design.repairs == 1 and design.usage["calls"] == 2
    assert len(design.specs) == 2
    repair_turns = fake.calls[1]["messages"]
    assert repair_turns[-2]["role"] == "assistant"
    assert "palette.coat is required" in repair_turns[-1]["content"], "the parser's words are the instruction"
    assert "not json at all" not in repair_turns[-1]["content"]


def test_design_and_its_one_repair_share_one_wall_clock_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    monkeypatch.setattr(V, "TIMEOUT_SECONDS", 0.12)
    seen: list[float] = []

    def slow_then_valid(**kwargs):
        seen.append(kwargs["timeout"])
        if len(seen) == 1:
            time.sleep(0.08)
            return _reply("not json")
        return _reply(_pets(GIGI_SPEC))

    design = V.design_pets("x", count=1, call=slow_then_valid)
    assert design.repairs == 1 and len(seen) == 2
    assert 0 < seen[1] < seen[0] - 0.04, "the repair gets only the round's remaining time"


def test_two_invalid_replies_are_an_invalid_spec_error_and_no_third_call() -> None:
    fake = Fake(_reply("not json at all"), _reply("{\"pets\": []}"))

    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", count=2, call=fake)

    assert caught.value.kind == "invalid_spec"
    assert len(fake.calls) == 2


def test_a_partial_reply_keeps_what_was_valid_after_the_repair() -> None:
    half = json.dumps({"pets": [GIGI_SPEC.to_dict(), {"plan": "dog", "name": "x", "palette": {}}]})
    fake = Fake(_reply(half), _reply(half))

    design = V.design_pets("x", count=2, call=fake)

    assert [s.name for s in design.specs] == ["Gigi"] and design.repairs == 1


def test_an_unsupported_animal_is_an_honest_answer_not_a_repair() -> None:
    # A cat is a quadruped now (plan 2026-09-13, decision 4); a spider is what no plan draws.
    fake = Fake(_reply(json.dumps({"pets": [{"plan": "spider", "name": "Tom", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}}]})))

    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("a spider", count=1, call=fake)

    assert caught.value.kind == "unsupported_body_plan" and caught.value.plan == "spider"
    assert len(fake.calls) == 1


def test_a_cat_is_designed_not_refused() -> None:
    fake = Fake(_reply(json.dumps({"pets": [{"plan": "cat", "name": "Tom", "palette": {"coat": "#888888", "coat_deep": "#555555", "muzzle": "#eeeeee"}}]})))

    design = V.design_pets("a grey cat", count=1, call=fake)

    assert [s.plan for s in design.specs] == ["cat"] and design.specs[0].ears == "pointed"


def test_the_prompt_names_every_kind_and_knob_the_parser_accepts() -> None:
    from scripts.pets import spec as S
    from scripts.pets.plans import kinds

    prompt = V.system_prompt(4)
    for kind in kinds():
        assert kind in prompt
    for option in (*S.EARS, *S.TAILS, *S.MUZZLES, *S.DEPTHS, *S.EAR_SIZES):
        assert json.dumps(option) in prompt, option
    assert '"body_depth"' in prompt and '"ear_size"' in prompt and f'"spec_version": {S.SPEC_VERSION}' in prompt
    assert "miso:" in prompt, "the cat example is in front of the model"
    # Decision 15: variety is in the shape, the colour is the user's — and so is the kind.
    assert "do not invent a different colour" in prompt
    assert "All 4 pets must be the same kind of animal" in prompt
    # Decision 13: an original in the spirit of a named character, never a copy.
    assert "not a copy of that character" in prompt


def test_the_deadline_is_wall_clock_and_a_late_reply_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    import time

    monkeypatch.setattr(V, "TIMEOUT_SECONDS", 0.05)
    finished = threading.Event()

    def slow(**kwargs):
        time.sleep(0.3)
        finished.set()
        return _reply(_pets(GIGI_SPEC))

    started = time.monotonic()
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", count=1, call=slow)
    elapsed = time.monotonic() - started

    assert caught.value.kind == "timeout" and elapsed < 0.25, "the deadline, not the transport, ended the wait"
    assert caught.value.usage["calls"] == 0, "a reply that arrives after the deadline is not counted"
    assert finished.wait(1.0), "the call was left to finish on its own thread"


def test_cancellation_checkpoints() -> None:
    # Before the call: nothing is spent.
    fake = Fake(_reply(_pets(GIGI_SPEC)))
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", count=1, is_cancelled=lambda: True, call=fake)
    assert caught.value.kind == "cancelled" and fake.calls == []

    # In flight: the call happens, its result is dropped, no repair follows.
    flag = {"cancelled": False}

    def cancel_during(**kwargs):
        flag["cancelled"] = True
        return _reply("garbage")

    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", count=1, is_cancelled=lambda: flag["cancelled"], call=cancel_during)
    assert caught.value.kind == "cancelled"


def test_provider_failures_are_typed_and_never_retried() -> None:
    class APITimeoutError(Exception):
        pass

    class APIConnectionError(Exception):
        pass

    fake = Fake(APITimeoutError("slow"))
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", call=fake)
    assert caught.value.kind == "timeout" and len(fake.calls) == 1

    fake = Fake(APIConnectionError("down"))
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", call=fake)
    assert caught.value.kind == "provider_unavailable" and len(fake.calls) == 1


def test_remix_sends_the_base_spec_and_the_note() -> None:
    fake = Fake(_reply(_pets(COOKIE_SPEC)))

    V.design_pets("a terrier", count=1, base_spec=GIGI_SPEC, note="make her ears upright", call=fake)

    text = fake.calls[0]["messages"][1]["content"][0]["text"]
    assert '"name":"Gigi"' in text and "make her ears upright" in text and "a terrier" in text


def test_input_is_bounded_and_normalised() -> None:
    fake = Fake(_reply(_pets(GIGI_SPEC)))
    V.design_pets("é" * 500 + "\x00\x07", count=1, call=fake)
    text = fake.calls[0]["messages"][1]["content"][0]["text"]
    assert "\x00" not in text and len(text) < 400

    with pytest.raises(V.VoxelDesignError, match="nothing to design"):
        V.design_pets("   ", call=Fake())


def test_availability_modes(monkeypatch: pytest.MonkeyPatch) -> None:
    import agent.auxiliary_client as aux
    import hermes_cli.runtime_provider as rp

    monkeypatch.setattr(aux, "_get_auxiliary_task_config", lambda task: {"provider": "openrouter", "model": "moonshotai/kimi-k3"})
    monkeypatch.setattr(rp, "resolve_runtime_provider", lambda requested=None: {"provider": "openrouter", "api_key": "sk-or-x"})
    assert V.voxel_availability() == {"available": True, "mode": "byok", "reason": ""}

    monkeypatch.setattr(aux, "_get_auxiliary_task_config", lambda task: {"provider": "auto", "model": ""})
    monkeypatch.setattr(rp, "resolve_runtime_provider", lambda requested=None: {"provider": "atum-managed", "api_key": "token"})
    assert V.voxel_availability()["available"] is False and "alias" in V.voxel_availability()["reason"]

    monkeypatch.setattr(aux, "_get_auxiliary_task_config", lambda task: {"provider": "atum-managed", "model": "hatch"})
    assert V.voxel_availability() == {"available": True, "mode": "managed", "reason": ""}

    monkeypatch.setattr(aux, "_get_auxiliary_task_config", lambda task: {"provider": "openrouter", "model": ""})
    monkeypatch.setattr(rp, "resolve_runtime_provider", lambda requested=None: (_ for _ in ()).throw(ValueError("no key")))
    assert V.voxel_availability()["available"] is False


def test_a_billing_failure_is_typed_and_not_a_connection_problem() -> None:
    class APIStatusError(Exception):
        status_code = 402

    fake = Fake(APIStatusError("Insufficient credits: this request requires more credits"))
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", call=fake)
    assert caught.value.kind == "billing_unavailable" and len(fake.calls) == 1

    class RateLimited(Exception):
        status_code = 429

    fake = Fake(RateLimited("Rate limit exceeded: free-models-per-day"))
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", call=fake)
    assert caught.value.kind == "provider_unavailable", "a plain rate limit is not a billing answer"

    fake = Fake(RateLimited("429 Requests quota exceeded for this minute"))
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", call=fake)
    assert caught.value.kind == "provider_unavailable", "a request quota is pacing, not a bill"

    fake = Fake(RateLimited("Insufficient credits. Add more using https://openrouter.ai/settings/credits"))
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", call=fake)
    assert caught.value.kind == "billing_unavailable", "money words on a 429 are a bill"


def test_a_failure_still_reports_what_was_spent() -> None:
    fake = Fake(_reply("garbage", prompt_tokens=120, completion_tokens=30), _reply("still garbage", prompt_tokens=200, completion_tokens=40))
    with pytest.raises(V.VoxelDesignError) as caught:
        V.design_pets("x", count=1, call=fake)

    assert caught.value.kind == "invalid_spec"
    assert caught.value.usage == {"prompt_tokens": 320, "completion_tokens": 70, "calls": 2}
    assert caught.value.repairs == 1 and caught.value.model == "moonshotai/kimi-k3"


def test_the_call_asks_for_no_transport_retries() -> None:
    fake = Fake(_reply(_pets(GIGI_SPEC)))
    V.design_pets("x", count=1, call=fake)
    assert fake.calls[0]["retry_policy"] == "none"
