"""Seeded session creation persists the supplied transcript eagerly and once."""

import threading

import pytest


@pytest.fixture()
def gateway(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    import tui_gateway.server as server

    db = SessionDB(db_path=tmp_path / "state.db")
    server._sessions.clear()
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    monkeypatch.setattr(
        server, "_claim_active_session_slot", lambda *_args, **_kwargs: (None, None))
    monkeypatch.setattr(server, "_resolve_model", lambda: "test/model")
    yield server, db
    server._sessions.clear()
    db.close()


def _create_seeded(server, messages):
    response = server.handle_request({
        "id": "create",
        "method": "session.create",
        "params": {"messages": messages},
    })
    assert "error" not in response, response
    sid = response["result"]["session_id"]
    return sid, response["result"]["stored_session_id"], server._sessions[sid]


def test_seeded_create_persists_immediately_and_cold_resume_keeps_history(gateway):
    server, db = gateway
    seed = [
        {"role": "user", "text": "previous question"},
        {"role": "assistant", "text": "previous answer"},
    ]
    sid, key, session = _create_seeded(server, seed)
    assert session["seeded"] is True
    assert session["_branch_seed_persisted"] is True
    assert [(row["role"], row["content"]) for row in db.get_messages_as_conversation(key)] == [
        ("user", "previous question"),
        ("assistant", "previous answer"),
    ]

    server._sessions.pop(sid)
    resumed = server.handle_request({
        "id": "resume", "method": "session.resume", "params": {"session_id": key},
    })
    assert "error" not in resumed, resumed
    assert [
        {"role": message["role"], "text": message["text"]}
        for message in resumed["result"]["messages"]
    ] == seed


def test_seed_persistence_is_idempotent(gateway):
    server, db = gateway
    _sid, key, session = _create_seeded(server, [
        {"role": "user", "content": "seed one"},
        {"role": "assistant", "content": "seed two"},
    ])
    server._persist_branch_seed(session)
    server._persist_branch_seed(session)
    assert [(row["role"], row["content"]) for row in db.get_messages_as_conversation(key)] == [
        ("user", "seed one"),
        ("assistant", "seed two"),
    ]


def test_unseeded_and_resumed_sessions_do_not_append_live_history(gateway):
    server, db = gateway
    db.create_session("unseeded", source="tui")
    unseeded = {
        "session_key": "unseeded",
        "seeded": False,
        "history": [{"role": "user", "content": "draft"}],
        "history_lock": threading.Lock(),
    }
    server._persist_branch_seed(unseeded)
    assert db.get_messages_as_conversation("unseeded") == []

    db.create_session("resumed", source="tui")
    db.append_message(session_id="resumed", role="user", content="already durable")
    resumed = {
        "session_key": "resumed",
        "seeded": False,
        "history": [{"role": "user", "content": "already durable"}],
        "history_lock": threading.Lock(),
    }
    server._persist_branch_seed(resumed)
    assert len(db.get_messages_as_conversation("resumed")) == 1
