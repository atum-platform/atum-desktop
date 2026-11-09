"""Preserve recovery, isolation and completion behavior across failures."""

from __future__ import annotations

import threading
import time

import hermes_state_guard
from hermes_state import SessionDB

# Deliberate cross-test handoff: test_leaked_instance_* leaks an instance;
# the later test (pytest runs file order deterministically without a
# randomizer plugin, and the sanctioned runner executes whole files in one
# process) asserts the autouse teardown sweep closed it.
_leaked: list[SessionDB] = []


def test_constructed_sessiondb_is_registered(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        assert db in hermes_state_guard._test_instance_registry
    finally:
        db.close()
    # close() must fully release the writer connection…
    assert db._conn is None
    # …and be idempotent: a second close (the suite sweep will call it
    # again at teardown) must not raise.
    db.close()


def test_leaked_instance_stays_open_within_the_test(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="leak-probe", source="cli", model="m")
    # Intentionally NOT closed — the suite-level sweep owns cleanup.
    assert db._conn is not None
    _leaked.append(db)


def test_previously_leaked_instance_was_closed_by_the_sweep():
    assert _leaked, "expected the previous test to have leaked an instance"
    db = _leaked.pop()
    # The autouse _close_leaked_session_dbs teardown between the two tests
    # must have closed the leaked instance (writer conn released), which is
    # what bounds fd/RSS growth in single-process runs.
    assert db._conn is None


# Same handoff shape for the auto-title upgrade thread a turn leaves behind: it holds the
# turn's SessionDB, so the sweep must join it before closing stores (else the daemon thread
# reopens the closed store and races interpreter finalization — the SIGSEGV shape of #113186).
_upgrade_thread: list[threading.Thread] = []


def test_slow_title_upgrade_thread_is_left_running_within_the_test():
    from agent.title_generator import _UPGRADE_THREADS

    thread = threading.Thread(target=time.sleep, args=(1.5,), name="auto-title", daemon=True)
    _UPGRADE_THREADS.add(thread)
    thread.start()
    assert thread.is_alive()
    _upgrade_thread.append(thread)


def test_title_upgrade_thread_was_joined_before_the_sweep_closed_stores():
    assert _upgrade_thread, "expected the previous test to have started an upgrade thread"
    assert not _upgrade_thread.pop().is_alive()
