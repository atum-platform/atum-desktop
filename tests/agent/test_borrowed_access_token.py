"""Access-only grants are refreshed by an external supervisor, never Hermes."""
import json
import time
from unittest.mock import Mock

from agent.credential_pool import load_pool
from agent.client_lifecycle import ClientLifecycleMixin


def test_external_replacement_is_revision_and_connection_scoped(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    row = dict(id="borrowed", source="external", auth_type="oauth", borrowed=True,
               connection_id="login-a", revision=1, access_token="access-one",
               expires_at_ms=int((time.time() + 100) * 1000), lifetime_seconds=3600)
    path = tmp_path / "auth.json"
    def write(**updates):
        row.update(updates)
        path.write_text(json.dumps({"credential_pool": {"openai-codex": [row]}}))
    write()
    pool = load_pool("openai-codex")
    original = pool.select()
    assert original is not None
    before = path.read_bytes()
    assert pool.try_refresh_current().access_token == "access-one"
    pool._persist = Mock(side_effect=AssertionError("reader must not write"))
    assert path.read_bytes() == before
    write(revision=2, access_token="access-two")
    adopted = pool.try_refresh_current()
    assert adopted.revision == 2 and adopted.access_token == "access-two"
    recovered = pool.mark_exhausted_and_rotate(status_code=401, credential_id="borrowed", api_key_hint="access-one")
    assert recovered is None or recovered.revision == 2
    assert pool.entries()[0].revision == 2 and pool.entries()[0].last_status != "exhausted"
    write(revision=1, access_token="rollback")
    assert pool.try_refresh_current() is None
    write(revision=3, connection_id="other-login")
    assert pool.try_refresh_current() is None
    path.write_text('{"credential_pool": {"openai-codex": []}}')
    assert pool.select() is None


def test_running_client_adopts_only_newer_borrowed_revision(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    row = dict(id="borrowed", source="external", auth_type="oauth", borrowed=True,
               connection_id="login-a", revision=1, access_token="old",
               expires_at_ms=int((time.time() + 100) * 1000))
    path = tmp_path / "auth.json"
    def write():
        path.write_text(json.dumps({"credential_pool": {"openai-codex": [row]}}))
    write()
    class Agent(ClientLifecycleMixin):
        provider = "openai-codex"
        api_mode = "codex_responses"
        _credential_pool_entry_id = "borrowed"
        _swap_credential = Mock(return_value=True)
    agent = Agent()
    agent._credential_pool = load_pool("openai-codex")
    assert agent._try_refresh_codex_client_credentials() is False
    row.update(revision=2, access_token="new")
    write()
    assert agent._try_refresh_codex_client_credentials() is True
    assert agent._swap_credential.call_args.args[0].access_token == "new"
