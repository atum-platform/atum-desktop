"""Offline behavior contract for the one-shot ChatGPT relay helper."""

from __future__ import annotations

import io
import json
from types import SimpleNamespace

from pydantic import BaseModel

from hermes_cli import chatgpt_relay


def _invoke(monkeypatch, answer: object) -> tuple[int, bytes]:
    payload = json.dumps({
        "model": "gpt-5.6-luna",
        "effort": "medium",
        "request": {"messages": [{"role": "user", "content": "offline fixture"}]},
    }).encode()
    stdin = SimpleNamespace(buffer=io.BytesIO(payload))
    output = io.BytesIO()
    stdout = SimpleNamespace(buffer=output)
    monkeypatch.setattr(chatgpt_relay, "call_llm", lambda **_kwargs: answer)
    monkeypatch.setattr(chatgpt_relay.sys, "stdin", stdin)
    monkeypatch.setattr(chatgpt_relay.sys, "stdout", stdout)
    return chatgpt_relay._main(), output.getvalue()


def test_namespace_plain_answer_is_valid_json(monkeypatch):
    answer = SimpleNamespace(
        choices=[SimpleNamespace(
            index=0,
            message=SimpleNamespace(role="assistant", content="fixture", tool_calls=None),
            finish_reason="stop",
        )],
        model="gpt-5.6-luna",
        usage=SimpleNamespace(prompt_tokens=4, completion_tokens=2, total_tokens=6),
    )

    exit_code, raw = _invoke(monkeypatch, answer)

    assert exit_code == 0
    assert json.loads(raw) == {
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "fixture", "tool_calls": None},
            "finish_reason": "stop",
        }],
        "model": "gpt-5.6-luna",
        "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6},
    }


def test_namespace_tool_calls_and_cached_usage_are_preserved(monkeypatch):
    answer = SimpleNamespace(
        choices=[SimpleNamespace(
            index=0,
            message=SimpleNamespace(
                role="assistant",
                content=None,
                tool_calls=[SimpleNamespace(
                    id="call_fixture",
                    type="function",
                    function=SimpleNamespace(name="lookup", arguments='{"q":"fixture"}'),
                )],
            ),
            finish_reason="tool_calls",
        )],
        model="gpt-5.6-luna",
        usage=SimpleNamespace(
            prompt_tokens=10,
            completion_tokens=3,
            total_tokens=13,
            prompt_tokens_details=SimpleNamespace(cached_tokens=7),
        ),
    )

    exit_code, raw = _invoke(monkeypatch, answer)
    payload = json.loads(raw)

    assert exit_code == 0
    assert payload["choices"][0]["message"]["tool_calls"] == [{
        "id": "call_fixture",
        "type": "function",
        "function": {"name": "lookup", "arguments": '{"q":"fixture"}'},
    }]
    assert payload["choices"][0]["finish_reason"] == "tool_calls"
    assert payload["usage"]["prompt_tokens_details"] == {"cached_tokens": 7}


def test_pydantic_chat_completion_keeps_model_dump_path(monkeypatch):
    class Message(BaseModel):
        role: str
        content: str

    class Choice(BaseModel):
        index: int
        message: Message
        finish_reason: str

    class Completion(BaseModel):
        choices: list[Choice]
        model: str

    answer = Completion(
        choices=[Choice(
            index=0,
            message=Message(role="assistant", content="pydantic fixture"),
            finish_reason="stop",
        )],
        model="gpt-5.6-luna",
    )

    exit_code, raw = _invoke(monkeypatch, answer)

    assert exit_code == 0
    assert json.loads(raw)["choices"][0]["message"]["content"] == "pydantic fixture"


def test_unknown_response_type_fails_closed_with_structural_code(monkeypatch):
    exit_code, raw = _invoke(monkeypatch, object())

    assert exit_code == 4
    assert json.loads(raw) == {
        "error": {"stage": "response_encode", "code": "response_not_serializable"}
    }


def test_namespace_refusal_survives_so_the_controller_can_fall_back(monkeypatch):
    # subscription-fallback.ts treats choice.message.refusal as a failed subscription answer.
    answer = SimpleNamespace(
        choices=[SimpleNamespace(
            index=0,
            message=SimpleNamespace(role="assistant", content=None, tool_calls=None, refusal="fixture refusal"),
            finish_reason="stop",
        )],
        model="gpt-5.6-luna",
        usage=None,
    )

    exit_code, raw = _invoke(monkeypatch, answer)

    assert exit_code == 0
    message = json.loads(raw)["choices"][0]["message"]
    assert message["refusal"] == "fixture refusal"
    assert message["content"] is None


def _native_relay_answer(output):
    from agent.auxiliary_client import _CodexCompletionsAdapter

    final = SimpleNamespace(status="completed", output=output, usage=None)
    client = SimpleNamespace(
        base_url="", responses=SimpleNamespace(create=lambda **_kwargs: final)
    )
    return _CodexCompletionsAdapter(client, "gpt-5.6-luna").create(
        messages=[{"role": "user", "content": "offline fixture"}]
    )


def _phase(text, phase):
    return SimpleNamespace(
        type="message", role="assistant", phase=phase, status="completed",
        content=[SimpleNamespace(type="output_text", text=text)],
    )


def _tool():
    return SimpleNamespace(
        type="function_call", status="completed", call_id="call_fixture",
        name="lookup", arguments='{"q":"fixture"}',
    )


def test_native_commentary_survives_relay_and_reaches_interim_once(monkeypatch, tmp_path):
    from agent.stream_delivery import StreamDeliveryMixin
    from agent.agent_runtime_helpers import strip_think_blocks

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    answer = _native_relay_answer([
        _phase("private analysis", "analysis"),
        _phase("Checking now. <think>hidden</think>", "commentary"),
        _phase("Checking now. <think>hidden</think>", "commentary"),
        _tool(),
    ])
    code, raw = _invoke(monkeypatch, answer)
    message = json.loads(raw)["choices"][0]["message"]
    assert code == 0
    assert message["content"] == "Checking now."
    assert message["tool_calls"][0]["function"]["name"] == "lookup"
    assert "private analysis" not in raw.decode()
    assert "codex_message_items" not in message
    assert "reasoning" not in message

    delivered = []

    class Delivery(StreamDeliveryMixin):
        interim_assistant_callback = staticmethod(lambda text, **_kw: delivered.append(text))
        _strip_think_blocks = staticmethod(lambda text: strip_think_blocks(None, text))

    delivery = Delivery()
    delivery._emit_interim_assistant_message(message)
    delivery._emit_interim_assistant_message(message)
    assert delivered == ["Checking now."]


def test_native_tool_only_and_final_answer_keep_their_content(monkeypatch):
    for output, expected in [
        ([_phase("private analysis", "analysis"), _tool()], None),
        ([_phase("Checking.", "commentary"), _phase("Final answer.", "final_answer")], "Final answer."),
        ([_tool()], None),
    ]:
        code, raw = _invoke(monkeypatch, _native_relay_answer(output))
        assert code == 0
        assert json.loads(raw)["choices"][0]["message"]["content"] == expected
        assert "private analysis" not in raw.decode()


def test_relay_uses_native_secret_redaction(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    secret = "sk-" + "a" * 48
    code, raw = _invoke(monkeypatch, _native_relay_answer([
        _phase(f"Checking {secret}", "commentary"), _tool(),
    ]))
    assert code == 0
    assert secret not in raw.decode()
    assert "Checking" in json.loads(raw)["choices"][0]["message"]["content"]
