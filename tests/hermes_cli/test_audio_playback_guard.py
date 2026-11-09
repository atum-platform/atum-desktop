"""Preserve recovery, isolation and completion behavior across failures."""

import os
import sys
import types

from tui_gateway import server

def test_voice_toggle_still_leaks_the_env_var_but_speech_is_stubbed(monkeypatch):
    """Preserve recovery, isolation and completion behavior across failures."""
    monkeypatch.setattr(server, "_load_cfg", lambda: {"voice": {}})
    monkeypatch.setitem(
        sys.modules,
        "tools.voice_mode",
        types.SimpleNamespace(
            check_voice_requirements=lambda: {"available": True, "details": ""}
        ),
    )
    monkeypatch.setenv("HERMES_VOICE", "1")

    resp = server.handle_request(
        {"id": "tts", "method": "voice.toggle", "params": {"action": "tts"}}
    )

    # The handler mutates the real process environment. This is the leak;
    # it is upstream behaviour we are guarding against, not asserting away.
    assert resp["result"]["tts"] is True
    assert os.environ.get("HERMES_VOICE_TTS") == "1"
    assert server._voice_tts_enabled() is True

    # Any call into the TTS backend from here on would be real synthesis and
    # real playback. Stand a recorder in front of it — a *recorder*, not a
    # raising stub, because ``speak_text`` wraps its whole body in
    # ``except Exception`` and would swallow an AssertionError, quietly
    # turning this test green whether or not the guard is doing anything.
    from tools import tts_tool

    calls = []
    monkeypatch.setattr(
        tts_tool,
        "text_to_speech_tool",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    # Called exactly as tui_gateway/server.py's prompt.submit completion path
    # calls it (a late `from hermes_cli.voice import speak_text`), with the
    # exact fixture string that came out of the speakers.
    from hermes_cli.voice import speak_text

    assert speak_text("partial answer complete") is None
    assert calls == [], (
        "audio guard breached: speak_text reached the TTS backend — on an "
        "unguarded run this is real synthesis through the keyless 'edge' "
        "provider, played through the speakers"
    )

def test_voice_env_does_not_leak_into_the_next_test():
    """Second defence: the flag the previous test set must not have survived.

    Ordering matters — this test only means anything because it runs after the
    one above, in the same process, which left ``HERMES_VOICE_TTS=1`` set.
    Before ``HERMES_VOICE``/``HERMES_VOICE_TTS`` were added to
    ``_HERMES_BEHAVIORAL_VARS``, this assertion failed.
    """
    assert "HERMES_VOICE_TTS" not in os.environ
    assert "HERMES_VOICE" not in os.environ
    assert server._voice_tts_enabled() is False
    assert server._voice_mode_enabled() is False
