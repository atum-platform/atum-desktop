"""Atum-specific contracts around upstream's desktop speech stream."""

from __future__ import annotations

from urllib.parse import urlencode

import pytest
from starlette.testclient import TestClient

from hermes_cli import web_server
from hermes_cli import web_server_gateway


@pytest.fixture
def stream_client(_isolate_hermes_home):
    previous_auth_required = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = False
    client = TestClient(web_server.app)
    try:
        yield client
    finally:
        client.close()
        if previous_auth_required is None:
            if hasattr(web_server.app.state, "auth_required"):
                delattr(web_server.app.state, "auth_required")
        else:
            web_server.app.state.auth_required = previous_auth_required


def _url() -> str:
    query = urlencode({"token": web_server._SESSION_TOKEN})
    return f"/api/audio/speak-stream?{query}"


class _FakeStreamer:
    sample_rate = 24000
    channels = 1

    def __init__(self):
        self.requests: list[str] = []

    def stream(self, text):
        self.requests.append(text)
        yield b"\x01\x02"


def _patch_provider(monkeypatch, streamer):
    monkeypatch.setattr(
        "tools.tts_streaming.resolve_streaming_provider", lambda cfg: streamer
    )
    monkeypatch.setattr("tools.tts_tool._load_tts_config", dict)
    monkeypatch.setattr("tools.tts_tool._get_provider", lambda cfg: "fake")
    monkeypatch.setattr(
        "tools.tts_tool._resolve_max_text_length", lambda provider, cfg: 4000
    )


def test_split_text_hard_splits_oversized_sentence():
    pieces = web_server_gateway._split_text_for_speak_stream("x" * 100, 30)
    assert all(len(piece) <= 30 for piece in pieces)
    assert sum(len(piece) for piece in pieces) == 100


@pytest.mark.parametrize("provider", ["edge", "piper"])
def test_holding_google_data_allows_cloud_and_local_speech(
    stream_client, monkeypatch, tmp_path, provider
):
    from agent import atum_google_fence

    monkeypatch.setenv(
        atum_google_fence.ROUTE_ENV, "http://127.0.0.1:43123/v1"
    )
    monkeypatch.setenv(atum_google_fence.LATCHED_ENV, "1")
    streamer = _FakeStreamer()
    _patch_provider(monkeypatch, streamer)

    monkeypatch.setattr("tools.tts_tool._get_provider", lambda cfg: provider)
    text = "Lan is waiting on the quote."
    with stream_client.websocket_connect(_url()) as conn:
        conn.send_json({"text": text, "done": True})
        assert conn.receive_json() == {"type": "start", "sample_rate": 24000, "channels": 1}
        assert conn.receive_bytes() == b"\x01\x02"
        assert conn.receive_json() == {"type": "end"}
    assert streamer.requests == [text]

    import tools.tts_tool as tts_tool

    spoken = []
    audio = tmp_path / "speech.mp3"
    audio.write_bytes(b"fake audio")

    def synthesize(text):
        spoken.append(text)
        return {"success": True, "file_path": str(audio), "provider": provider}

    monkeypatch.setattr(tts_tool, "text_to_speech_tool", synthesize)
    response = stream_client.post(
        "/api/audio/speak",
        json={"text": text},
        headers={web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["provider"] == provider
    assert spoken == [text]
