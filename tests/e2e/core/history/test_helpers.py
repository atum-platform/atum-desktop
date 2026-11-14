"""Lifecycle and failure-reporting contracts for the real-process ledger harness."""
from __future__ import annotations

import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest

from tests.e2e.core.history._helpers import InProcessSession, Spawned, run_oneshot


def test_close_drains_title_writer_before_closing_db(tmp_path, monkeypatch):
    from agent import title_generator as titles
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="pending-title", source="cli", model="fake-model")
    pending, release, closing = threading.Event(), threading.Event(), threading.Event()
    order, errors = [], []
    original_close = db.close
    original_wait = titles.wait_for_title_upgrades

    def write_title():
        pending.set()
        try:
            assert release.wait(10), "test never released the title writer"
            db.set_auto_title("pending-title", "Delayed title", source="llm")
            order.append("title")
        except BaseException as exc:
            errors.append(exc)

    def close_db():
        order.append("close")
        original_close()
        closing.set()

    def wait_titles(*args, **kwargs):
        closing.set()
        original_wait(*args, **kwargs)

    monkeypatch.setattr(db, "close", close_db)
    monkeypatch.setattr(titles, "wait_for_title_upgrades", wait_titles)
    session = InProcessSession.__new__(InProcessSession)
    session.db, session.agent = db, SimpleNamespace(close=lambda: None)
    upgrade = threading.Thread(target=write_title)
    titles.start_title_upgrade(upgrade)
    closer = threading.Thread(target=session.close)
    try:
        assert pending.wait(10)
        closer.start()
        assert closing.wait(10)
        release.set()
        closer.join(10)
        upgrade.join(10)
        assert not closer.is_alive() and not upgrade.is_alive()
        assert not errors
        assert order == ["title", "close"], "closing first lets the title writer reopen the DB"
        assert db._conn is None, "a background write reopened the supposedly closed session"
    finally:
        release.set()
        upgrade.join(10)
        if closer.ident is not None:
            closer.join(10)
        original_close()


def test_oneshot_failure_includes_stdout_and_exit_status(tmp_path, monkeypatch):
    original_popen = subprocess.Popen

    def failed_child(_cmd, **kwargs):
        return original_popen([sys.executable, "-c",
                               "print('Error: injected resume refusal'); raise SystemExit(1)"], **kwargs)

    monkeypatch.setattr(subprocess, "Popen", failed_child)
    with pytest.raises(AssertionError) as exc:
        run_oneshot({}, tmp_path, "unused", Spawned(), resume="pending-title")
    assert "exit status 1" in str(exc.value)
    assert "stdout tail: Error: injected resume refusal" in str(exc.value)
    assert "stderr tail:" in str(exc.value)
