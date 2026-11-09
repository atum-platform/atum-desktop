"""Real HTTP/config contracts used by the narrow Matrix voice editor."""

import pytest
import yaml


@pytest.fixture
def voice_home(monkeypatch, _isolate_hermes_home):
    from hermes_cli import profiles
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    other = home / "profiles" / "worker_beta"
    other.mkdir(parents=True)
    (home / "config.yaml").write_text("{}\n", encoding="utf-8")
    (other / "config.yaml").write_text("stt:\n  enabled: true\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: home / "profiles")
    return home, other


@pytest.fixture
def voice_client(monkeypatch, voice_home):
    from starlette.testclient import TestClient
    import hermes_state
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", voice_home[0] / "state.db")
    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return client


def test_single_voice_field_round_trip_preserves_siblings_credentials_and_other_home(voice_client, voice_home):
    home, other = voice_home
    before = {
        "model": {"provider": "openrouter", "default": "main-model", "context_length": 12345},
        "auxiliary": {"vision": {"provider": "openrouter", "model": "keep"}},
        "stt": {"enabled": True, "provider": "local", "local": {"model": "base", "language": "vi"}},
        "tts": {"provider": "openai", "openai": {"voice": "alloy", "model": "tts-1", "api_key": "fixture-key"}, "providers": {"office": {"command": ["fixture-command"]}}},
        "voice": {"max_recording_seconds": 120, "record_key": "ctrl+b", "auto_tts": True},
        "custom_providers": [{"name": "fixture", "base_url": "https://fixture.invalid", "api_key": "fixture-key"}],
    }
    (home / "config.yaml").write_text(yaml.safe_dump(before), encoding="utf-8")
    other_before = (other / "config.yaml").read_bytes()
    schema = voice_client.get("/api/config/schema?profile=default")
    assert schema.status_code == 200
    assert schema.json()["fields"]["stt.enabled"]["type"] == "boolean"
    assert schema.json()["fields"]["tts.provider"]["type"] == "select"
    for patch in ({"tts": {"openai": {"voice": "nova"}}}, {"stt": {"enabled": False}}, {"voice": {"max_recording_seconds": 30}}):
        result = voice_client.put("/api/config?profile=default", json={"config": patch})
        assert result.status_code == 200
        assert result.json() == {"ok": True}
    saved = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    assert saved["tts"] == {**before["tts"], "openai": {**before["tts"]["openai"], "voice": "nova"}}
    assert saved["stt"] == {**before["stt"], "enabled": False}
    assert saved["voice"] == {**before["voice"], "max_recording_seconds": 30}
    for key in ("model", "auxiliary", "custom_providers"):
        assert saved[key] == before[key]
    assert (other / "config.yaml").read_bytes() == other_before
    readback = voice_client.get("/api/config?profile=default").json()
    assert readback["tts"]["openai"]["voice"] == "nova"
    assert readback["stt"]["enabled"] is False
    assert readback["voice"]["max_recording_seconds"] == 30


def test_speech_loaders_read_saved_changes_and_disabled_dictation_calls_no_provider(voice_client, voice_home):
    from tools.transcription_tools import _load_stt_config
    from tools.tts_tool import _load_tts_config

    # Real loaders and HTTP endpoint; disabled STT returns before provider or model installation.
    response = voice_client.put("/api/config?profile=default", json={"config": {"stt": {"enabled": False, "provider": "openai"}, "tts": {"openai": {"voice": "nova"}}}})
    assert response.status_code == 200
    assert _load_stt_config()["enabled"] is False
    assert _load_stt_config()["provider"] == "openai"
    assert _load_tts_config()["openai"]["voice"] == "nova"
    disabled = voice_client.post("/api/audio/transcribe", json={"data_url": "data:audio/webm;base64,YXVkaW8="})
    assert disabled.status_code == 400
    assert "disabled" in disabled.json()["detail"].lower()
    response = voice_client.put("/api/config?profile=default", json={"config": {"tts": {"openai": {"voice": "echo"}}}})
    assert response.status_code == 200
    assert _load_tts_config()["openai"]["voice"] == "echo"
