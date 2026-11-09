"""Process host handshake: off cannot offer or falsely execute a pet action."""

import json
from unittest.mock import Mock

import pytest

from tools.pet_tool import ACTIONS, check_pet_requirements, pet_tool


@pytest.mark.parametrize("action", ACTIONS)
def test_off_is_honest_even_with_a_callback(monkeypatch, action):
    monkeypatch.setenv("ATUM_PET_INTENTS", "off")
    callback = Mock()
    result = json.loads(pet_tool(action, "left", callback))
    assert result["ok"] is False
    assert result["reason"] == "no_pet_surface"
    callback.assert_not_called()


@pytest.mark.parametrize("action", ACTIONS)
def test_unset_preserves_legacy_dispatch(monkeypatch, action):
    monkeypatch.delenv("ATUM_PET_INTENTS", raising=False)
    callback = Mock()
    result = json.loads(pet_tool(action, "left", callback))
    expected = {"action": action, **({"place": "left"} if action == "go" else {})}
    assert result == {"ok": True, **expected}
    callback.assert_called_once_with(expected)


def test_requirements_and_real_tool_discovery(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import model_tools
    from tools.registry import invalidate_check_fn_cache

    # Clear test-only caches between simulated processes. Production hosts keep
    # this handshake fixed for a process/conversation; no live toolset switching.
    for mode, offered in [("off", False), (None, True)]:
        if mode is None:
            monkeypatch.delenv("ATUM_PET_INTENTS", raising=False)
        else:
            monkeypatch.setenv("ATUM_PET_INTENTS", mode)
        invalidate_check_fn_cache()
        model_tools._clear_tool_defs_cache()
        assert check_pet_requirements() is offered
        definitions = model_tools.get_tool_definitions(enabled_toolsets=["pet"], quiet_mode=True)
        assert any(item["function"]["name"] == "pet" for item in definitions) is offered

    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()


@pytest.mark.parametrize("alias", ("centre", "middle"))
def test_reply_mode_canonicalizes_alias_and_reports_queued_honestly(monkeypatch, alias):
    monkeypatch.setenv("ATUM_PET_INTENTS", "reply")
    callback = Mock(return_value={"ok": True, "queued": True})

    result = json.loads(pet_tool("go", alias, callback))

    assert result == {
        "ok": True,
        "queued": True,
        "message": "queued for your reply; shows on devices where your pet is out",
        "action": "go",
        "place": "center",
    }
    callback.assert_called_once_with({"action": "go", "place": "center"})


@pytest.mark.parametrize("callback_result", [None, True, {}, {"ok": True}, {"queued": True}])
def test_reply_mode_never_claims_queued_for_malformed_callback_result(monkeypatch, callback_result):
    monkeypatch.setenv("ATUM_PET_INTENTS", "reply")

    result = json.loads(pet_tool("wave", callback=Mock(return_value=callback_result)))

    assert result == {
        "ok": False,
        "reason": "pet_intent_not_queued",
        "message": "The pet action could not be queued for this reply.",
    }


def test_reply_mode_reports_intent_limit(monkeypatch):
    monkeypatch.setenv("ATUM_PET_INTENTS", "reply")

    result = json.loads(pet_tool("wave", callback=Mock(return_value={"ok": False, "reason": "intent_limit"})))

    assert result == {
        "ok": False,
        "reason": "intent_limit",
        "message": "This reply already has the maximum of 3 pet intents.",
    }


def test_limit_message_matches_the_real_collector_capacity(monkeypatch):
    from tui_gateway.pet_intents import PetIntentBuffer

    monkeypatch.setenv("ATUM_PET_INTENTS", "reply")
    callback = PetIntentBuffer().begin("limit")
    accepted = 0
    for action in ACTIONS:
        result = json.loads(pet_tool(action, "left", callback))
        if result["ok"]:
            accepted += 1
        else:
            assert result["reason"] == "intent_limit"
            assert f"maximum of {accepted} pet intents" in result["message"]
            break
    else:
        pytest.fail("collector did not reach its advertised limit")


def test_legacy_callback_none_remains_success_outside_reply_mode(monkeypatch):
    monkeypatch.delenv("ATUM_PET_INTENTS", raising=False)

    assert json.loads(pet_tool("wave", callback=Mock(return_value=None))) == {
        "ok": True,
        "action": "wave",
    }


def test_off_with_no_callback_remains_no_pet_surface(monkeypatch):
    monkeypatch.setenv("ATUM_PET_INTENTS", "off")

    assert json.loads(pet_tool("wave")) == {
        "ok": False,
        "reason": "no_pet_surface",
        "message": "There is no pet on this surface, so nothing moved.",
    }
