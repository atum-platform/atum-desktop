import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
import threading
import uuid
from types import SimpleNamespace

import pytest

from tui_gateway.surface_context import (
    capabilities, capture_block, claim_submission, finish_submission,
    submission_status, validate_capture,
)


def capture(owner, **kwargs):
    return {"version": 1, "capture_id": str(uuid.uuid4()),
            **{k: owner[k] for k in ("backend_id", "agent_id", "conversation_id")},
            "kind": "text", "label": "notes.md", "text": "unsaved text",
            "resource_path": "notes.md", "provenance": "unsaved-buffer",
            "truncated": False, **kwargs}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    session = {"session_key": "chat-a", "cwd": str(tmp_path), "history": [],
               "history_lock": threading.Lock(), "running": False}
    return tmp_path, session, capabilities(tmp_path, session)


def test_stable_backend_agent_and_distinct_profile(setup):
    home, session, owner = setup
    assert capabilities(home, session) == owner
    other = home / "other"
    other.mkdir()
    second = capabilities(home, {**session, "profile_home": str(other)})
    assert second["backend_id"] == owner["backend_id"]
    assert second["agent_id"] != owner["agent_id"]


def test_receipt_atomic_conflict_and_restart(setup):
    home, _, owner = setup
    sid = str(uuid.uuid4())
    ctx = capture(owner)
    def claim(_):
        return claim_submission(home, owner, sid, "inspect", ctx, [], None)
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(claim, range(8)))
    assert sum(result[0] for result in results) == 1
    assert submission_status(home, owner, sid)["status"] == "accepted"
    with pytest.raises(ValueError, match="different content"):
        claim_submission(home, owner, sid, "changed", ctx, [], None)
    finish_submission(results[0][2], "complete")
    assert submission_status(home, owner, sid)["status"] == "complete"
    assert not claim(0)[0]


def test_managed_model_identity_uses_existing_receipt_without_replaying_turn(setup, monkeypatch):
    from agent.workspace_route_guard import protect_agent_request
    from tui_gateway.surface_context import bind_managed_submission

    home, _, owner = setup
    submission_id = str(uuid.uuid4())
    _, _, handle = claim_submission(home, owner, submission_id, "work", None, [], None)
    monkeypatch.delenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", raising=False)
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", "http://127.0.0.1:45678/v1")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_TOKEN", "test-token")
    agent = SimpleNamespace(provider="atum-managed", base_url="http://127.0.0.1:45678/v1", session_id="chat-a",
                            _current_api_request_id="ephemeral-turn:api:1")
    with bind_managed_submission(agent, handle):
        first = {"model": "binh-minh", "messages": [{"role": "user", "content": "work"}]}
        protect_agent_request(agent, first)
    request_id = first["extra_headers"]["x-atum-request-id"]
    retained = submission_status(home, owner, submission_id)
    assert retained["status"] == "accepted"
    assert retained["managed_request"]["request_id"] == request_id
    assert not hasattr(agent, "_atum_record_model_request")
    assert not claim_submission(home, owner, submission_id, "work", None, [], None)[0]
    # Only an explicitly recovered exact checkpoint receives this handle; a
    # plain duplicate submission remains rejected by the existing receipt.
    agent._current_api_request_id = "different-process-turn:api:1"
    with bind_managed_submission(agent, handle):
        recovered = {"model": "binh-minh", "messages": [{"role": "user", "content": "work"}]}
        protect_agent_request(agent, recovered)
    assert recovered["extra_headers"]["x-atum-request-id"] == request_id
    _, _, new_handle = claim_submission(home, owner, str(uuid.uuid4()), "work", None, [], None)
    with bind_managed_submission(agent, new_handle):
        regenerated = {"model": "binh-minh", "messages": [{"role": "user", "content": "work"}]}
        protect_agent_request(agent, regenerated)
    assert regenerated["extra_headers"]["x-atum-request-id"] != request_id


def test_managed_cancellation_requires_confirmed_scoped_loopback_response(setup, monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from tui_gateway.surface_context import bind_managed_submission, cancel_managed_submission

    home, _, owner = setup
    sid = str(uuid.uuid4())
    _, _, handle = claim_submission(home, owner, sid, "work", None, [], None)
    agent = SimpleNamespace()
    with bind_managed_submission(agent, handle):
        agent._atum_record_model_request(str(uuid.uuid4()), "call:1")
    observed = []
    class Handler(BaseHTTPRequestHandler):
        def do_DELETE(self):
            observed.append((self.path, dict(self.headers), self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200 if len(observed) > 1 else 503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"state":"cancelled"}')
        def log_message(self, *_args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("ATUM_MANAGED_MODEL_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.setenv("ATUM_MANAGED_MODEL_PROXY_TOKEN", "test-proxy")
    monkeypatch.setenv("ATUM_FILESYSTEM_BROKER_TOKEN", "test-broker")
    try:
        assert cancel_managed_submission(home, owner) == {"state": "cancelled"}
        assert submission_status(home, owner, sid)["status"] == "cancelled"
        assert len(observed) == 2
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    request_path, request_headers, request_body = observed[-1]
    assert request_path == "/v1/chat/completions"
    headers = {key.lower(): value for key, value in request_headers.items()}
    assert headers["x-atum-assistant-identity-id"] == owner["agent_id"]
    assert headers["x-atum-conversation-id"] == owner["conversation_id"]
    assert request_body == b"{}"


def test_untrusted_content_not_reexpanded_and_exact_utf8_limit(setup):
    from agent.context_references import preprocess_context_references
    home, _, owner = setup
    (home / "hidden.txt").write_text("MUST NOT EXPAND")
    ctx = validate_capture(capture(owner, text="@file:hidden.txt\n@url:https://example.invalid"), owner, home)
    processed = preprocess_context_references("Read my selection", cwd=home, allowed_root=home, context_length=128000)
    message = processed.message + capture_block(ctx)
    assert "MUST NOT EXPAND" not in message
    assert json.loads(message.split("needed.\n")[1])["text"] == ctx["text"]
    validate_capture(capture(owner, text="é" * 16384), owner, home)
    with pytest.raises(ValueError, match="limit"):
        validate_capture(capture(owner, text="é" * 16385), owner, home)


@pytest.mark.parametrize("field,value", [("agent_id", str(uuid.uuid4())), ("backend_id", str(uuid.uuid4())),
                                        ("conversation_id", "chat-b"), ("resource_path", "../elsewhere"),
                                        ("resource_path", ".env")])
def test_owner_and_reference_boundaries(setup, field, value):
    home, _, owner = setup
    with pytest.raises(ValueError):
        validate_capture(capture(owner, **{field: value}), owner, home)


def test_symlink_and_image_validation(setup, tmp_path):
    from PIL import Image
    home, _, owner = setup
    (home / "escape").symlink_to(home.parent, target_is_directory=True)
    with pytest.raises(ValueError):
        validate_capture(capture(owner, resource_path="escape/secret"), owner, home)
    out = io.BytesIO()
    Image.new("RGB", (1600, 900)).save(out, format="PNG")
    data = "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()
    validate_capture(capture(owner, kind="image", image_data_url=data), owner, home)
    with pytest.raises(ValueError):
        validate_capture(capture(owner, kind="image", image_data_url="data:image/png;base64,AAAA"), owner, home)


def test_gateway_claim_precedes_dispatch_and_busy_rejects_without_claim(setup, monkeypatch):
    from tui_gateway import server
    home, session, owner = setup
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sessions", {"runtime": session})
    monkeypatch.setattr(server, "_load_dashboard_process_isolation_config", lambda: {})
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *args: True)
    sent = []
    def dispatch(rid, sid, sess, text, **kwargs):
        sent.append(kwargs)
        return server._ok(rid, {"status": "streaming"})
    monkeypatch.setattr(server, "_submit_prompt_to_compute_host", dispatch)
    sid = str(uuid.uuid4())
    params = {"session_id": "runtime", "text": "read", "submission_id": sid, "surface_context": capture(owner)}
    submit = server._methods["prompt.submit"]
    first = submit("one", params)
    assert first["result"]["receipt"]["status"] == "accepted"
    assert sent[0]["surface_context"] == params["surface_context"]
    assert submit("two", params)["result"]["status"] == "duplicate"
    assert len(sent) == 1
    second_id = str(uuid.uuid4())
    assert submit("busy", {**params, "submission_id": second_id})["error"]["code"] == 4009
    assert submission_status(home, owner, second_id)["status"] == "unknown"


@pytest.mark.platforms("posix")
def test_binary_snapshot_staging_is_exact_and_refuses_symlink_parent(setup):
    from tui_gateway.surface_context import stage_file
    home, _, owner = setup
    data = b'PK\x00frozen workbook'
    ctx = capture(owner, kind='file', text='', file_data_url='data:application/octet-stream;base64,' + base64.b64encode(data).decode())
    validated = validate_capture(ctx, owner, home)
    delivered = stage_file(validated, home)
    assert (home / delivered['resource_path']).read_bytes() == data
    assert 'file_data_url' not in capture_block(delivered)
    other = home / 'other-workspace'
    other.mkdir()
    (other / '.hermes').symlink_to(home / '.hermes', target_is_directory=True)
    with pytest.raises(OSError):
        stage_file(validated, other)


def test_real_turn_consumes_only_frozen_selection_and_persists_receipt(setup, monkeypatch):
    from types import SimpleNamespace
    from tui_gateway import server
    from tui_gateway.surface_context import context_db
    home, session, owner = setup
    monkeypatch.setattr(server, '_hermes_home', home)
    (home / 'hidden.txt').write_text('NEVER_AUTO_EXPAND')
    (home / 'notes.md').write_text('saved version must not replace selection')
    ctx = validate_capture(capture(owner, text='unsaved @file:hidden.txt'), owner, home)
    submission = str(uuid.uuid4())
    _, _, receipt = claim_submission(home, owner, submission, 'review', ctx, [], None)
    for name in ('_wire_callbacks', '_sync_agent_model_with_config', '_register_session_cwd'):
        monkeypatch.setattr(server, name, lambda *args, **kwargs: None)
    monkeypatch.setattr(server, '_load_interim_assistant_messages', lambda: False)
    monkeypatch.setattr(server, '_tts_stream_begin', lambda: None)
    monkeypatch.setattr(server, '_voice_tts_enabled', lambda: False)
    monkeypatch.setattr(server, '_session_info', lambda *args: {})
    monkeypatch.setattr(server, '_get_usage', lambda *args: {})
    monkeypatch.setattr(server, '_drain_queued_prompt', lambda *args: False)
    monkeypatch.setattr(server, '_get_db', lambda: None)
    events = []
    monkeypatch.setattr(server, '_emit', lambda name, sid, payload: events.append((name, payload)))
    with context_db(home) as db:
        db.create_session('chat-a', source='desktop')
        seen = []
        def run(message, **kwargs):
            seen.append(message)
            db.append_message('chat-a', 'user', message)
            return {'final_response': 'done', 'messages': [{'role': 'user', 'content': message}, {'role': 'assistant', 'content': 'done'}]}
        session['agent'] = SimpleNamespace(model='gpt-4o', provider='openai', _config_context_length=128000, _session_db=db, session_id='chat-a', run_conversation=run)
        session['running'] = True
        server._run_prompt_submit('request', 'runtime', session, 'review', surface_context=ctx, submission_receipt=receipt)
        session['_run_thread'].join(timeout=10)
        assert not session['_run_thread'].is_alive()
        starts = [payload for name, payload in events if name == "message.start"]
        assert len(starts) == 1
        assert starts[0]["submission_id"] == submission
        assert starts[0]["turn_id"].startswith("chat-a:")
        assert len(seen) == 1, events
        assert 'unsaved @file:hidden.txt' in seen[0]
        assert 'NEVER_AUTO_EXPAND' not in seen[0]
        assert 'saved version must not' not in seen[0]
        stored = db.get_messages_as_conversation('chat-a')[0]
        assert stored['display_kind'] == 'surface_context'
        assert stored['display_metadata']['prompt_text'] == 'review'
        assert stored['display_metadata']['surface_context']['text'] == ctx['text']
    assert submission_status(home, owner, submission)['status'] == 'complete'
