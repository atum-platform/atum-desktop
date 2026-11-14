"""Recovered host PIDs are only ours inside the instantiation that recorded them.

``processes.json`` survives on the durable volume, so a checkpoint entry outlives the sandbox that
wrote it. ``host_start_time`` (kernel ticks since boot) is boot-relative: a fresh sandbox reuses
both the PID and the tick value, so the start-time guard alone re-adopts a stranger as our
background process — and later polls, reads and kills it. ``host_boot_epoch`` names the
instantiation; an entry that names another one is never adopted, never reported running and never
signalled.
"""

import json
import os

import pytest

from gateway.status import get_process_start_time
from tools.process_registry import ProcessRegistry


@pytest.fixture
def checkpoint(tmp_path, monkeypatch):
    import tools.process_registry as registry_module

    path = tmp_path / "processes.json"
    monkeypatch.setattr(registry_module, "CHECKPOINT_PATH", path)
    return path


def _entry(pid: int, start, epoch=..., **extra) -> dict:
    """One persisted entry; ``epoch=...`` omits the witness entirely (a pre-witness record)."""
    entry = {"session_id": "proc_owner01", "command": "sleep 999", "pid": pid, "pid_scope": "host",
             "host_start_time": start, "started_at": 1234.5, "task_id": "task", "session_key": ""}
    if epoch is not ...:
        entry["host_boot_epoch"] = epoch
    entry.update(extra)
    return entry


def _pin_instantiation(monkeypatch, epoch):
    from gateway import drain_control

    monkeypatch.setattr(drain_control, "current_instantiation_epoch", lambda: epoch)


def _registry() -> ProcessRegistry:
    return ProcessRegistry()


def test_same_pid_and_start_from_another_boot_is_never_adopted(checkpoint, monkeypatch):
    """Our own live PID with exactly the recorded ticks, under another instantiation's witness:
    the entry is pruned, nothing is re-attached, and the live stranger is left alone."""
    _pin_instantiation(monkeypatch, "cafebabe-boot:42")
    pid = os.getpid()
    checkpoint.write_text(json.dumps([_entry(pid, get_process_start_time(pid), "deadbeef-boot:42")]),
                          encoding="utf-8")
    registry = _registry()

    assert registry.recover_from_checkpoint() == 0
    assert registry.get("proc_owner01") is None
    assert registry.pending_watchers == []
    assert json.loads(checkpoint.read_text(encoding="utf-8")) == []
    # The live process the colliding number belongs to is never signalled.
    assert os.getpid() == pid


def test_this_instantiation_entry_is_recovered_with_its_witness(checkpoint, monkeypatch):
    _pin_instantiation(monkeypatch, "cafebabe-boot:42")
    pid = os.getpid()
    checkpoint.write_text(json.dumps([_entry(pid, get_process_start_time(pid), "cafebabe-boot:42",
                                             watcher_interval=5, notify_on_complete=True)]),
                          encoding="utf-8")
    registry = _registry()

    assert registry.recover_from_checkpoint() == 1
    session = registry.get("proc_owner01")
    assert session is not None and session.pid == pid and session.detached
    written = json.loads(checkpoint.read_text(encoding="utf-8"))
    assert [item["host_boot_epoch"] for item in written] == ["cafebabe-boot:42"]


def test_an_entry_without_the_witness_keeps_its_start_time_answer(checkpoint, monkeypatch):
    """Entries written before the witness existed have none to compare: the adapter stamps the
    current instantiation on the rewrite (so the unproven population only shrinks) and the live
    PID is adopted, while a reused PID is still refused."""
    _pin_instantiation(monkeypatch, "cafebabe-boot:42")
    pid = os.getpid()
    checkpoint.write_text(json.dumps([_entry(pid, get_process_start_time(pid))]), encoding="utf-8")
    registry = _registry()

    assert registry.recover_from_checkpoint() == 1
    restored = registry.get("proc_owner01")
    assert restored is not None and restored.pid == pid
    assert restored.host_boot_epoch == "cafebabe-boot:42"
    assert json.loads(checkpoint.read_text(encoding="utf-8"))[0]["host_boot_epoch"] == "cafebabe-boot:42"

    # A recorded tick value that no longer matches the live process is a reused PID: not adopted.
    checkpoint.write_text(json.dumps([_entry(pid, int(get_process_start_time(pid)) - 1_000_000)]),
                          encoding="utf-8")
    assert _registry().recover_from_checkpoint() == 0


def test_a_detached_session_from_another_boot_never_reports_running(checkpoint, monkeypatch):
    """Fate is what poll/list/liveness all read: another instantiation's ``reused`` answer keeps
    the entry from being reported running or signalled later in this process's life."""
    _pin_instantiation(monkeypatch, "cafebabe-boot:42")
    registry = _registry()
    pid = os.getpid()
    start = get_process_start_time(pid)

    assert registry._detached_host_fate(pid, start, "deadbeef-boot:42") == "reused"
    assert registry._detached_host_fate(pid, start, "cafebabe-boot:42") == "running"
    assert registry._detached_host_fate(pid, start) == "running"  # witness-less entry: bounded legacy


def test_the_scratch_reaper_never_counts_another_boots_checkpoint(tmp_path, monkeypatch):
    """The prune's ownership guard reads the same checkpoint: an entry from another instantiation
    must not license the pid it now names, while this boot's entry (and a witness-less legacy
    entry) still does."""
    import hermes_constants_scratch as scratch

    _pin_instantiation(monkeypatch, "cafebabe-boot:42")
    home = tmp_path / "hermes"
    home.mkdir()
    pid, start = os.getpid(), get_process_start_time(os.getpid())

    def recorded(**fields) -> set[int]:
        entry = {"session_id": "proc_scratch01", "pid": pid, "pid_scope": "host",
                 "host_start_time": start, **fields}
        (home / "processes.json").write_text(json.dumps([entry]), encoding="utf-8")
        return scratch._registered_live_pids(home)

    assert recorded(host_boot_epoch="deadbeef-boot:42") == set()
    assert recorded(host_boot_epoch="cafebabe-boot:42") == {pid}
    assert recorded() == {pid}

