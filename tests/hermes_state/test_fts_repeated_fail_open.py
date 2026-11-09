"""FTS trigger state is shared across handles; a local disabled flag is not authoritative."""
import sqlite3
import threading
import time
from types import SimpleNamespace

import pytest

from hermes_state import SessionDB
import hermes_state
import hermes_state_fts


def _fts_error():
    error = sqlite3.DatabaseError('fts5: corrupt structure record for table "messages_fts"')
    error.sqlite_errorcode = sqlite3.SQLITE_CORRUPT_VTAB
    return error


def test_writer_can_detach_corrupt_fts_again_after_sibling_reinstalls_triggers(tmp_path):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    try:
        if not db._fts_enabled:
            pytest.skip("FTS5 unavailable")
        db.create_session("s", "test")
        for i in range(80):
            db.append_message("s", "user", f"seed message {i}")
        with sqlite3.connect(path) as sibling:
            triggers = sibling.execute(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_fts_%'"
            ).fetchall()
            sibling.execute("UPDATE messages_fts_data SET block = X'DEADBEEFDEADBEEFDEADBEEFDEADBEEF'")
        with pytest.raises(sqlite3.DatabaseError) as caught:
            db._conn.execute("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'seed'").fetchall()
        assert db._enter_fts_fail_open(caught.value)
        assert db._fts_enabled is False
        # A concurrent/older handle can publish triggers without updating this
        # writer's Python flags. The real SQL engine must still fail open.
        with sqlite3.connect(path) as sibling:
            for (ddl,) in triggers:
                sibling.execute(ddl)
        row_id = db.append_message("s", "user", "durable after a second FTS failure")
        with sqlite3.connect(path) as reader:
            assert reader.execute("SELECT content FROM messages WHERE id=?", (row_id,)).fetchone() == (
                "durable after a second FTS failure",)
            assert reader.execute("SELECT count(*) FROM messages WHERE session_id='s'").fetchone()[0] == 81
            assert reader.execute("PRAGMA integrity_check(messages)").fetchall() == [("ok",)]
        assert not db._db_corrupt
    finally:
        db.close()
    # Fail-open preserves canonical data first; reopening rebuilds the derived index.
    recovered = SessionDB(db_path=path)
    try:
        with sqlite3.connect(path) as reader:
            assert reader.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
            assert reader.execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'durable'").fetchone()[0] == 1
    finally:
        recovered.close()


def test_expired_recovery_budget_does_not_detach_a_healthy_index(tmp_path):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    try:
        if not db._fts_enabled:
            pytest.skip("FTS5 unavailable")
        db.create_session("s", "test")
        error = sqlite3.DatabaseError('fts5: corrupt structure record for table "messages_fts"')
        error.sqlite_errorcode = sqlite3.SQLITE_CORRUPT_VTAB
        assert not db._enter_fts_fail_open(error, deadline=time.monotonic() - 1)
        row = db.append_message("s", "user", "budgetproof")
        with sqlite3.connect(path) as reader:
            assert reader.execute(
                "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'budgetproof'"
            ).fetchall() == [(row,)]
    finally:
        db.close()


def test_persistent_fts_error_has_one_recovery_per_write(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        if not db._fts_enabled:
            pytest.skip("FTS5 unavailable")
        calls = 0

        def always_fails(conn):
            nonlocal calls
            calls += 1
            conn.execute("INSERT INTO state_meta (key, value) VALUES ('rolled_back', '1')")
            raise _fts_error()

        # Short patience keeps the unfixed reproduction bounded; assertions use
        # attempts and durable effects, not a load-sensitive timing threshold.
        with pytest.raises(sqlite3.DatabaseError, match="fts5: corrupt structure"):
            db._execute_write(always_fails, patience_s=0.25)
        assert calls == 2
        assert not db._db_corrupt
        assert db._conn.execute("SELECT value FROM state_meta WHERE key='rolled_back'").fetchone() is None
        db.create_session("after", "test")
        db.append_message("after", "user", "healthy after refusing persistent FTS failure")
    finally:
        db.close()


@pytest.mark.parametrize("barrier", ["close", "deadline"])
def test_recovery_rechecks_lifetime_and_budget_after_taking_lock(tmp_path, monkeypatch, barrier):
    db = SessionDB(db_path=tmp_path / "state.db")
    clock = SimpleNamespace(now=time.monotonic())
    monkeypatch.setattr(hermes_state_fts, "time", SimpleNamespace(monotonic=lambda: clock.now))
    lock = db._lock

    class BarrierLock:
        def __enter__(self):
            # Execute the real close, or consume the budget, between the
            # helper's initial admission and acquisition of its writer lock.
            if barrier == "close":
                db._lock = lock
                db.close()
            else:
                clock.now += 10
            lock.acquire()

        def __exit__(self, *args):
            lock.release()

    db._lock = BarrierLock()
    try:
        assert not db._enter_fts_fail_open(_fts_error(), deadline=clock.now + 5)
        if barrier == "close":
            assert db._conn is None
        else:
            assert db._conn.execute("SELECT value FROM state_meta WHERE key='fts_stale'").fetchone() is None
    finally:
        db._lock = lock
        db.close()


def test_recovery_does_not_reopen_a_closed_handle(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.close()
    try:
        assert not db._enter_fts_fail_open(_fts_error())
        assert db._conn is None
    finally:
        db.close()


def test_recovery_does_not_run_after_close_starts(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    closing, release = threading.Event(), threading.Event()
    errors = []

    def pause_before_writer_close():
        closing.set()
        assert release.wait(10), "close was not released"
        return False

    def closer():
        try:
            db.close()
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=closer)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(db, "_evict_one_idle_read_conn", pause_before_writer_close)
            thread.start()
            try:
                assert closing.wait(10), "close did not reach the barrier"
                # The writer is still open, but teardown has begun.
                assert db._conn is not None
                assert not db._enter_fts_fail_open(_fts_error())
                assert db._conn.execute("SELECT value FROM state_meta WHERE key='fts_stale'").fetchone() is None
            finally:
                release.set()
                thread.join(10)
            assert not thread.is_alive()
            assert not errors, errors
    finally:
        release.set()
        if thread.ident is not None:
            thread.join(10)
        db.close()


@pytest.mark.parametrize("barrier", ["close", "deadline"])
def test_canonical_replay_stops_when_lifetime_or_budget_ends(tmp_path, monkeypatch, barrier):
    db = SessionDB(db_path=tmp_path / "state.db")
    clock = SimpleNamespace(now=time.monotonic())
    monkeypatch.setattr(hermes_state, "time", SimpleNamespace(monotonic=lambda: clock.now))
    recover = db._enter_fts_fail_open
    calls = 0

    def fail(conn):
        nonlocal calls
        calls += 1
        raise _fts_error()

    def recover_then_end_lifetime_or_budget(*args, **kwargs):
        accepted = recover(*args, **kwargs)
        assert accepted
        if barrier == "close":
            db.close()
        else:
            clock.now = kwargs["deadline"]
        return accepted

    monkeypatch.setattr(db, "_enter_fts_fail_open", recover_then_end_lifetime_or_budget)
    try:
        with pytest.raises(sqlite3.DatabaseError, match="fts5: corrupt structure"):
            db._execute_write(fail)
        assert calls == 1
        assert not db._db_corrupt
        if barrier == "close":
            assert db._conn is None
    finally:
        db.close()
