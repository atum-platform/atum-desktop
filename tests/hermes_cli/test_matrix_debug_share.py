"""Real isolated capture + selected-profile HTTP + local uploader proof."""
import hashlib
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


@pytest.fixture
def fixture(monkeypatch, tmp_path, _isolate_hermes_home):
    from hermes_cli import matrix_debug_share as share, profiles, web_server
    from starlette.testclient import TestClient

    root = tmp_path / "agent"
    other = root / "profiles" / "worker_beta"
    other.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-parent-must-not-leak")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: root)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: root / "profiles")
    monkeypatch.setattr(share, "_previews", {})
    monkeypatch.setattr(share, "_operations", {})
    for home, text in ((root, "ROOT_ONLY"), (other, "WORKER_ONLY")):
        (home / "logs").mkdir()
        (home / "config.yaml").write_text("model:\n  default: fixture-model\n  provider: fixture\nfallback_providers:\n  - api_key: opaque-config-secret\n    provider: fixture\n")
        (home / ".env").write_text("FIXTURE_SECRET=non-public-test-value\n")
        (home / "logs" / "agent.log").write_text(text + " café\nAuthorization: Bearer non-public-test-value\nhttps://user:non-public-test-value@example.test/?access_token=non-public-test-value\nfixture@example.test\n")
    # These hand-built homes must pass through the same native initialization
    # as real dashboard profiles before the read-only capture contract begins.
    from hermes_cli.config import load_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    for profile in ("default", "worker_beta"):
        with _config_profile_scope(profile):
            load_config()
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return client, root, other, share


@pytest.mark.parametrize("profile,expected,absent", [("default", "ROOT_ONLY", "WORKER_ONLY"), ("worker_beta", "WORKER_ONLY", "ROOT_ONLY")])
def test_real_capture_is_selected_readonly_and_parent_stdout_env_unchanged(fixture, profile, expected, absent):
    client, root, other, share = fixture
    before_env = dict(os.environ)
    before_stdout = sys.stdout
    before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
    response = client.post("/api/debug-share/preview", params={"profile": profile})
    assert response.status_code == 200, response.text
    files = response.json()["files"]
    assert expected in files[0]["text"] and absent not in str(files)
    assert "opaque-config-secret" not in str(files)
    assert "non-public-test-value" not in str(files)
    assert "fixture@example.test" not in str(files)
    assert "openai               not set" in files[0]["text"]
    assert dict(os.environ) == before_env and sys.stdout is before_stdout
    assert {p: p.read_bytes() for p in root.rglob("*") if p.is_file()} == before
    for file in files:
        raw = file["text"].encode("utf8")
        assert file["bytes"] == len(raw) and file["digest"] == hashlib.sha256(raw).hexdigest()
    assert client.get("/api/debug-share/status?profile=" + profile).json()["state"] == "unknown"


def _finished(client, profile):
    deadline = time.monotonic() + 5
    while True:
        value = client.get("/api/debug-share/status", params={"profile": profile}).json()
        if value["state"] != "running":
            return value
        assert time.monotonic() < deadline
        time.sleep(0.01)


def test_approved_bytes_reach_local_http_once_and_receipt_is_home_scoped(fixture, monkeypatch):
    import urllib.request
    client, root, other, share = fixture
    received = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"https://paste.rs/fixture123")
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    original = urllib.request.build_opener
    class LocalOpener:
        def open(self, request, timeout):
            assert request.full_url == "https://paste.rs/"
            local = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/", data=request.data, method=request.method, headers=dict(request.headers))
            return original(share._NoRedirect()).open(local, timeout=timeout)
    monkeypatch.setattr(urllib.request, "build_opener", lambda *args: LocalOpener())
    try:
        preview = client.post("/api/debug-share/preview?profile=worker_beta").json()
        approved = next(f["text"] for f in preview["files"] if f["label"] == "report")
        # Change the actual log after preview: only original captured bytes may leave.
        (other / "logs" / "agent.log").write_text("LATER_UNAPPROVED_TEXT")
        body = {"token": preview["token"], "destination": "paste.rs", "labels": ["report"]}
        assert client.post("/api/debug-share/upload?profile=default", json=body).status_code == 409
        assert client.post("/api/debug-share/upload?profile=worker_beta", json=body).status_code == 200
        outcome = _finished(client, "worker_beta")
        assert "token" not in outcome and preview["token"] not in str(outcome)
        assert outcome["state"] == "succeeded" and outcome["urls"] == [{"label": "report", "url": "https://paste.rs/fixture123"}]
        assert client.post("/api/debug-share/upload?profile=worker_beta", json=body).json()["state"] == "succeeded"
        assert received == [approved.encode("utf8")]
        assert client.get("/api/debug-share/status?profile=default").json()["state"] == "unknown"
        assert (other / "pastes" / "pending.json").exists() and not (root / "pastes").exists()
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_uncertain_response_never_falls_back_retries_or_sends_remaining(fixture, monkeypatch):
    client, root, other, share = fixture
    sent = []
    def upload(text, destination):
        sent.append((text, destination))
        raise TimeoutError("private-response-that-must-not-leak")
    monkeypatch.setattr(share, "_upload", upload)
    preview = client.post("/api/debug-share/preview?profile=default").json()
    body = {"token": preview["token"], "destination": "dpaste.com", "labels": ["report", "agent.log"]}
    client.post("/api/debug-share/upload?profile=default", json=body)
    value = _finished(client, "default")
    assert value["state"] == "uncertain" and value["uncertain_label"] == "report"
    client.post("/api/debug-share/upload?profile=default", json=body)
    assert len(sent) == 1 and sent[0][1] == "dpaste.com"
    assert "private-response" not in str(value) and not value["urls"]


def test_expired_unknown_selection_and_forged_authority_are_rejected_before_upload(fixture, monkeypatch):
    client, root, other, share = fixture
    uploads = []
    monkeypatch.setattr(share, "_upload", lambda *args: uploads.append(args))
    captured = client.post("/api/debug-share/preview?profile=default").json()
    body = {"token": captured["token"], "destination": "paste.rs", "labels": ["report"]}
    for patch in ({"destination": "https://attacker.test"}, {"labels": ["/private/file"]}, {"labels": ["report", "report"]}, {"labels": ["agent.log"]}, {"home": str(other)}, {"redact": False}):
        assert client.post("/api/debug-share/upload?profile=default", json={**body, **patch}).status_code in (409, 422)
    share._previews[str(root.resolve())]["expires_at"] = 0
    assert client.post("/api/debug-share/upload?profile=default", json=body).status_code == 409
    assert uploads == []


def test_collection_rejects_cross_home_symlink_and_preview_does_not_sweep(fixture, monkeypatch):
    client, root, other, share = fixture
    from hermes_cli import debug
    monkeypatch.setattr(debug, "_best_effort_sweep_expired_pastes", lambda: pytest.fail("preview must not delete public data"))
    (root / "logs" / "agent.log").unlink()
    (root / "logs" / "agent.log").symlink_to(other / "logs" / "agent.log")
    response = client.post("/api/debug-share/preview?profile=default")
    assert response.status_code == 409 and "WORKER_ONLY" not in response.text


@pytest.mark.parametrize("url", ["http://paste.rs/abc", "https://paste.rs.evil.test/abc", "https://fixture-4ed95f6b8d@example.invalid/abc", "https://paste.rs/abc?token=secret", "https://paste.rs/abc#fragment", "https://paste.rs/a/b", "https://paste.rs/%61", "https://paste.rs:443/abc"])
def test_public_url_custody(url):
    from hermes_cli import matrix_debug_share as share
    assert not share.valid_url(url, "paste.rs")
    assert share.valid_url("https://paste.rs/Abc123", "paste.rs")


@pytest.mark.skipif(os.name != "posix", reason="directory descriptors are POSIX-only")
def test_log_directory_replacement_cannot_redirect_open_file_to_other_home(fixture, monkeypatch):
    client, root, other, share = fixture
    original_open = os.open
    swapped = []

    def replace_after_directory_open(path, flags, *args, **kwargs):
        fd = original_open(path, flags, *args, **kwargs)
        if path == root / "logs" and not swapped:
            (root / "logs").rename(root / "original-logs")
            (root / "logs").symlink_to(other / "logs", target_is_directory=True)
            swapped.append(True)
        return fd

    monkeypatch.setattr(os, "open", replace_after_directory_open)
    snapshot = share._safe_snapshot(root.resolve(), "agent", 200)
    assert swapped and "ROOT_ONLY" in snapshot.full_text
    assert "WORKER_ONLY" not in snapshot.full_text
