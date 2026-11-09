from types import SimpleNamespace

import pytest

from tui_gateway.background_sweep import BackgroundSweepError, classify_background_sweep


def params(**overrides):
    value = {
        "authorizationId": "00000000-0000-4000-8000-463bfa64f08a",
        "prompt": "Return the strict follow-up JSON for this bounded evidence.",
        "model": "atum-followup-sweep",
        "effort": "medium",
    }
    value.update(overrides)
    return value


def test_one_tool_free_call_without_retry_or_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    calls = []

    def invoke(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"profile":"atum.followup-sweep-result/1","decision":"silent"}'))],
            usage=SimpleNamespace(prompt_tokens=321, completion_tokens=18, model_micro_protons=45),
        )

    clock = iter([10.0, 11.2])
    result = classify_background_sweep(params(), invoke=invoke, now=lambda: next(clock))

    assert len(calls) == 1
    assert calls[0]["tools"] == []
    assert calls[0]["retry_policy"] == "none"
    assert calls[0]["max_tokens"] == 1_000
    assert calls[0]["reasoning_config"] == {"effort": "medium"}
    assert result["usage"] == {
        "computeSeconds": 2,
        "modelAttempts": 1,
        "inputTokens": 321,
        "outputTokens": 18,
        "modelMicroProtons": 45,
    }


@pytest.mark.parametrize(
    "change",
    [
        {"prompt": "x" * 5_001},
        {"model": "bad model"},
        {"effort": "max"},
        {"authorizationId": "not-a-uuid"},
        {"extra": True},
    ],
)
def test_refuses_unbounded_or_open_inputs(change):
    with pytest.raises(BackgroundSweepError, match="background_sweep_invalid"):
        classify_background_sweep(params(**change), invoke=lambda **_kwargs: None)


def test_provider_failure_is_closed_and_does_not_echo_evidence():
    def failed(**_kwargs):
        raise RuntimeError("private evidence")

    with pytest.raises(BackgroundSweepError) as caught:
        classify_background_sweep(params(prompt="private evidence"), invoke=failed)

    assert str(caught.value) == "background_sweep_model_failed"
    assert "private evidence" not in str(caught.value)
