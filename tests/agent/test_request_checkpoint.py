"""Real SQLite process ownership and effect fences, independent of the adapter."""
import multiprocessing
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from agent.request_checkpoint import (
    CheckpointSuperseded, CheckpointUnavailable, RequestCheckpoint,
    cancel_checkpoint, checkpoint_key, read_checkpoint,
)
from hermes_state import SessionDB


@pytest.fixture
def db(tmp_path):
    database = SessionDB(db_path=tmp_path / "state.db")
    yield database
    database.close()


def test_reclaim_fences_the_original_worker_before_effects(db):
    original = RequestCheckpoint(db, "submission", {"actor": "a"})
    payload = {"operation": "same-request", "messages": [{"role": "user", "content": "hello"}]}
    original.pending(payload)
    payload["messages"][0]["content"] = "mutated afterward"
    fresh = RequestCheckpoint(db, "submission", {"actor": "a"}, recover=True)
    assert fresh.value["payload"]["messages"][0]["content"] == "hello"
    with pytest.raises(CheckpointSuperseded):
        original.consume()
    fresh.consume()
    with pytest.raises(CheckpointUnavailable):
        RequestCheckpoint(db, "submission", {"actor": "a"}, recover=True)
    fresh.finish(completed=True)
    assert read_checkpoint(db, "submission")["phase"] == "completed"
    assert "payload" not in read_checkpoint(db, "submission")


def test_each_new_request_requires_a_consumption_boundary(db):
    worker = RequestCheckpoint(db, "turn", {})
    worker.pending({"request_id": "one"})
    with pytest.raises(CheckpointUnavailable, match="request_changed"):
        worker.pending({"request_id": "two"})
    worker.consume()
    worker.pending({"request_id": "two", "completed_tool_results": ["kept"]})
    resumed = RequestCheckpoint(db, "turn", {}, recover=True)
    assert resumed.value["payload"]["completed_tool_results"] == ["kept"]


def test_explicit_unstarted_replacement_is_never_allowed_on_reclaimed_work(db):
    worker = RequestCheckpoint(db, "rejected", {})
    worker.pending({"request_id": "too-large"})
    worker.pending({"request_id": "compressed"}, replace_unstarted=True)
    resumed = RequestCheckpoint(db, "rejected", {}, recover=True)
    assert resumed.value["payload"]["request_id"] == "compressed"
    with pytest.raises(CheckpointUnavailable):
        resumed.pending({"request_id": "changed"}, replace_unstarted=True)


def test_independent_connections_allow_only_one_recovery_consumer(db):
    worker = RequestCheckpoint(db, "racing", {})
    worker.pending({"request_id": "same"})

    def compete(_index):
        connection = SessionDB(db_path=db.db_path)
        try:
            winner = RequestCheckpoint(connection, "racing", {}, recover=True)
            winner.consume()
            return True
        except CheckpointUnavailable:
            return False
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sum(pool.map(compete, range(4))) == 1
    with pytest.raises(CheckpointSuperseded):
        worker.consume()


def test_cancel_and_identity_changes_cannot_replay(db):
    worker = RequestCheckpoint(db, "turn", {"account": "a"})
    worker.pending({"request_id": "one"})
    with pytest.raises(CheckpointUnavailable):
        RequestCheckpoint(db, "turn", {"account": "b"}, recover=True)
    cancel_checkpoint(db, "turn")
    with pytest.raises(CheckpointSuperseded):
        worker.consume()
    with pytest.raises(CheckpointUnavailable):
        RequestCheckpoint(db, "turn", {"account": "a"}, recover=True)
    assert read_checkpoint(db, "turn")["phase"] == "cancelled"


@pytest.mark.parametrize("raw", ['{', '{"version":2}', '[]'])
def test_corrupt_or_newer_format_is_not_overwritten(db, raw):
    db.set_meta(checkpoint_key("bad"), raw)
    with pytest.raises(CheckpointUnavailable):
        RequestCheckpoint(db, "bad", {}, recover=True)
    assert db.get_meta(checkpoint_key("bad")) == raw
    healthy = RequestCheckpoint(db, "healthy", {})
    healthy.pending({"request_id": "ok"})
    healthy.consume()


def _die_at_boundary(path, consumed, ready):
    db = SessionDB(db_path=Path(path))
    worker = RequestCheckpoint(db, "killed", {})
    worker.pending({"request_id": "retained-operation"})
    if consumed:
        worker.consume()
    ready.set()
    # The parent terminates this real process without closing the DB/writer.
    multiprocessing.Event().wait(30)


@pytest.mark.parametrize("consumed", [False, True])
def test_process_death_resumes_only_before_consumption(tmp_path, consumed):
    ctx = multiprocessing.get_context("spawn")
    ready = ctx.Event()
    path = str(tmp_path / "state.db")
    child = ctx.Process(target=_die_at_boundary, args=(path, consumed, ready))
    child.start()
    try:
        assert ready.wait(10), "child did not reach durable boundary"
        child.terminate()
        child.join(10)
        assert not child.is_alive()
        with_db = SessionDB(db_path=Path(path))
        try:
            if consumed:
                with pytest.raises(CheckpointUnavailable):
                    RequestCheckpoint(with_db, "killed", {}, recover=True)
            else:
                worker = RequestCheckpoint(with_db, "killed", {}, recover=True)
                assert worker.value["payload"]["request_id"] == "retained-operation"
                worker.consume()
        finally:
            with_db.close()
    finally:
        if child.is_alive():
            child.terminate()
        child.join(10)
