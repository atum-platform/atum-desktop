"""Behavior of the 2.1 portable checkpoint (hermes_cli/atum_home_portable.py, atum.agent-home/2.1).

Real files, a real WAL database written while the capture runs, real symlinks and FIFOs, in a temporary
directory. The vendored pack (apps/desktop/contracts/atum-agent-home-v2.1, platform PR652) is the
decision table for the path grammar and the manifest, and a digest pinned on both sides keeps this
module's canonical JSON byte-identical to the desktop's.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows: the cron ticker's lock does not exist there
    fcntl = None  # type: ignore[assignment]

import pytest

from hermes_cli import atum_home
from hermes_cli import atum_home_portable as portable
from hermes_cli.atum_home import HomeError

REPO = Path(__file__).resolve().parents[2]
PACK = REPO / "apps/desktop/contracts/atum-agent-home-v2.1"
HOME_ID = "00000000-0000-4000-8000-e8d95748107a"

# The digest of the pack's own fixtures/checkpoint.manifest.json under both canonical JSON implementations;
# electron/matrix/agent-home-placement/contract.test.ts pins the same value for the TypeScript one.
CROSS_LANGUAGE_MANIFEST_DIGEST = "1c28b6b21f025c1f0b22319b388f92d3affd6c969ef90b0a106a1531bc3a3c7e"


def _pack_json(name: str):
    return json.loads((PACK / name).read_text(encoding="utf-8"))


def _fixtures(message: str):
    index = _pack_json("contract.json")["fixtures"]
    return [item for item in index if item.get("message") == message]


# ── The grammar and the manifest, as the pack states them ────────────────────


@pytest.mark.parametrize("item", _fixtures("home.checkpoint.manifest"), ids=lambda item: Path(item["file"]).name)
def test_every_pack_manifest_fixture_is_decided_as_the_pack_says(item):
    manifest = _pack_json(item["file"])
    if item["expect"] == "accept":
        assert portable.validate_manifest(manifest) is manifest
    else:
        with pytest.raises(HomeError) as raised:
            portable.validate_manifest(manifest)
        assert raised.value.code == "home_manifest_invalid"


def test_names_that_merely_sound_sensitive_are_ordinary_files():
    for category, path in [
        ("memory", "memory/ghi-chú hôm nay.md"),
        ("memory", "memory/secret-santa.md"),
        ("skills", "skills/token-counter/SKILL.md"),
        ("skills", "skills/calendar/package.json"),
        ("skills", "skills/calendar/pnpm-lock.yaml"),
        ("non_secret_config", "config/profiles/personal.json"),
    ]:
        assert portable.classify_portable_path(category, path) == ("included", path)


def test_the_grammar_skips_what_the_contract_names():
    expected = {
        ("memory", "memory/state.db"): "database_or_sidecar",
        ("memory", "memory/a.db-wal"): "database_or_sidecar",
        ("memory", "memory/a.sqlite3"): "database_or_sidecar",
        ("non_secret_config", "config/auth.json"): "credential_or_key_material",
        ("non_secret_config", "config/.env.local"): "credential_or_key_material",
        ("non_secret_config", "config/ID_RSA"): "credential_or_key_material",
        ("non_secret_config", "config/x.PEM"): "credential_or_key_material",
        ("non_secret_config", "config/.ssh/config"): "credential_or_key_material",
        ("portable_app_data", "apps/portable/Chrome/Default/Cookies"): "browser_profile",
        ("portable_app_data", "apps/portable/workspace/a.txt"): "machine_workspace",
        ("skills", "skills/x/node_modules/y.js"): "package_tree",
        ("memory", "skills/a.md"): "outside_category",
        ("memory", "/memory/a.md"): "invalid_relative_path",
        ("memory", "memory/../auth.json"): "invalid_relative_path",
        ("memory", "memory/" + "e" + chr(0x301) + ".md"): "invalid_relative_path",
    }
    for (category, path), reason in expected.items():
        assert portable.classify_portable_path(category, path) == ("skipped", reason), (category, path)


def test_the_canonical_manifest_digest_is_the_desktops():
    manifest = _pack_json("fixtures/checkpoint.manifest.json")
    digest = portable.manifest_digest(manifest)
    assert digest == portable.manifest_digest({**manifest, "manifestSha256": "0" * 64})
    assert digest == portable.manifest_digest(dict(reversed(list(manifest.items()))))
    assert digest == CROSS_LANGUAGE_MANIFEST_DIGEST


def test_canonical_json_matches_the_device_protocols_rules():
    assert portable.canonical_json({"b": 1, "a": [True, None, "x"]}) == '{"a":[true,null,"x"],"b":1}'
    # Strings and keys are NFC; keys sort by UTF-16 code unit, not code point.
    decomposed = "e" + chr(0x301)
    assert portable.canonical_json({decomposed: decomposed}) == json.dumps(
        {unicodedata.normalize("NFC", decomposed): unicodedata.normalize("NFC", decomposed)}, ensure_ascii=False, separators=(",", ":")
    )
    astral = chr(0x1F600)
    private_use = chr(0xE000)
    assert portable.canonical_json({private_use: 1, astral: 2}).index(astral) < portable.canonical_json({private_use: 1, astral: 2}).index(private_use)
    for bad in (1.5, 2**53, float("nan"), {1: 2}, object()):
        with pytest.raises(HomeError):
            portable.canonical_json(bad)


# ── A realistic home ─────────────────────────────────────────────────────────


def _make_state_db(path: Path, marker: str = "lotus") -> None:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL)")
    conn.execute("INSERT INTO messages (content) VALUES (?)", (marker,))
    conn.commit()
    conn.close()


def _home(root: Path, name: str = "mac-a") -> Path:
    home = root / name / "hermes-home"
    for relative in (
        "memories",
        "skills/notes/scripts",
        "skills/notes/node_modules/dep",
        "skills/notes/.venv/bin",
        "cron/output",
        "plugins/atum-device",
        "logs",
        "sessions",
        "workspace/project",
        "browser/Default",
    ):
        (home / relative).mkdir(parents=True)
    _make_state_db(home / "state.db")
    (home / "memories" / "MEMORY.md").write_text("The demo code word is lotus.", encoding="utf-8")
    (home / "memories" / "USER.md").write_text("Prefers short answers.", encoding="utf-8")
    (home / "memories" / "ghi-chú hôm nay.md").write_text("note", encoding="utf-8")
    (home / "memories" / "MEMORY.md.lock").write_text("", encoding="utf-8")
    (home / "memories" / ".mem_abc.tmp").write_text("half", encoding="utf-8")
    (home / "SOUL.md").write_text("You are Test.", encoding="utf-8")
    (home / "skills" / "notes" / "SKILL.md").write_text("# Notes", encoding="utf-8")
    (home / "skills" / "notes" / "scripts" / "run.py").write_text("print('x')", encoding="utf-8")
    (home / "skills" / "notes" / "secret-santa.md").write_text("fine", encoding="utf-8")
    (home / "skills" / "notes" / "id_rsa").write_text("PRIVATE KEY MATERIAL", encoding="utf-8")
    (home / "skills" / "notes" / "node_modules" / "dep" / "index.js").write_text("module", encoding="utf-8")
    (home / "skills" / "notes" / ".venv" / "bin" / "python").write_text("binary", encoding="utf-8")
    (home / "cron" / "jobs.json").write_text(
        json.dumps({"jobs": [{"id": "j1", "prompt": "hi", "workdir": f"{home}/projects", "script": f"{Path.home()}/bin/run.sh"}]}),
        encoding="utf-8",
    )
    (home / "cron" / "output" / "run.txt").write_text("old run", encoding="utf-8")
    (home / "config.yaml").write_text("model: secret-model\n", encoding="utf-8")
    (home / ".env").write_text("OPENAI_API_KEY=sk-test-do-not-leak", encoding="utf-8")
    (home / "auth.json").write_text('{"token":"tok-do-not-leak"}', encoding="utf-8")
    (home / "sessions" / "s1.json").write_text("transcript", encoding="utf-8")
    (home / "workspace" / "project" / "main.py").write_text("WORKSPACE-FILE-BODY", encoding="utf-8")
    (home / "browser" / "Default" / "Cookies").write_text("cookie jar", encoding="utf-8")
    (home / "plugins" / "atum-device" / "x.py").write_text("plugin", encoding="utf-8")
    return home


def _capture(home: Path, out: Path, *, generation: int = 2, parent: int = 1, epoch: int = 3) -> dict:
    with open(out, "wb") as handle:
        return portable.capture(str(home), handle, home_id=HOME_ID, generation=generation, parent_generation=parent, home_epoch=epoch)


def _entries(result: dict) -> dict[str, dict]:
    return {entry["path"]: entry for entry in result["manifest"]["entries"]}


def _tree(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file() and not path.is_symlink()
    }


# ── What a capture carries and what it leaves out ────────────────────────────


def test_a_capture_carries_exactly_the_portable_part(tmp_path):
    home = _home(tmp_path)
    result = _capture(home, tmp_path / "a.archive")
    paths = sorted(_entries(result))
    assert paths == [
        "config/SOUL.md",
        "config/atum-home.json",
        "memory/MEMORY.md",
        "memory/USER.md",
        "memory/ghi-chú hôm nay.md",
        "routines/jobs.json",
        "skills/notes/SKILL.md",
        "skills/notes/scripts/run.py",
        "skills/notes/secret-santa.md",
    ]
    portable.validate_manifest(result["manifest"])
    assert result["manifest"]["generation"] == 2 and result["manifest"]["parentGeneration"] == 1
    assert result["manifest"]["producingHomeEpoch"] == 3
    assert result["manifest"]["manifestSha256"] == portable.manifest_digest(result["manifest"])
    assert result["includedFiles"] == len(paths)


def test_the_archive_holds_no_database_credential_session_or_workspace_byte(tmp_path):
    home = _home(tmp_path)
    out = tmp_path / "a.archive"
    _capture(home, out)
    raw = out.read_bytes()
    for forbidden in (
        b"SQLite format 3",
        b"sk-test-do-not-leak",
        b"tok-do-not-leak",
        b"PRIVATE KEY MATERIAL",
        b"cookie jar",
        b"transcript",
        b"WORKSPACE-FILE-BODY",
        b"secret-model",
        b"binary",
        b"module",
        b"half",
        b"old run",
        b"plugin",
    ):
        assert forbidden not in raw, forbidden


def test_skipped_candidates_are_counted_by_category_and_reason_and_hashed_never_named(tmp_path):
    home = _home(tmp_path)
    out = tmp_path / "a.archive"
    result = _capture(home, out)
    rows = {(row["category"], row["reasonCode"]): row for row in result["skipped"]}
    assert set(rows) == {
        ("memory", "database_or_sidecar"),
        ("memory", "outside_category"),
        ("non_secret_config", "credential_or_key_material"),
        ("portable_app_data", "browser_profile"),
        ("portable_app_data", "machine_workspace"),
        ("skills", "credential_or_key_material"),
        ("skills", "package_tree"),
    }
    assert rows[("skills", "package_tree")]["count"] == 2  # node_modules and .venv, each named once
    assert rows[("skills", "credential_or_key_material")]["count"] == 1
    expected = hashlib.sha256("\n".join(sorted(["skills/notes/.venv", "skills/notes/node_modules"])).encode()).hexdigest()
    assert rows[("skills", "package_tree")]["pathSha256"] == expected
    header_text = out.read_bytes().split(b"\n", 1)[0].decode("utf-8")
    for name in ("state.db", "auth.json", ".env", "id_rsa", "Cookies", "node_modules", "main.py", "s1.json", "MEMORY.md.lock"):
        assert name not in header_text, name
    for row in result["skipped"]:
        assert set(row) == {"category", "reasonCode", "count", "pathSha256"}


def test_locks_and_temp_files_are_not_state_and_not_listed(tmp_path):
    home = _home(tmp_path)
    with_noise = _capture(home, tmp_path / "a.archive")
    assert not any(path.endswith((".lock", ".tmp")) for path in _entries(with_noise))
    (home / "memories" / "MEMORY.md.lock").unlink()
    (home / "memories" / ".mem_abc.tmp").unlink()
    without_noise = _capture(home, tmp_path / "b.archive")
    assert with_noise["skipped"] == without_noise["skipped"]
    # state.db; sessions/; .env and auth.json; browser/; workspace/; id_rsa; node_modules and .venv.
    assert sum(row["count"] for row in with_noise["skipped"]) == 1 + 1 + 2 + 1 + 1 + 1 + 2


def test_a_symlink_a_fifo_and_a_hardlink_inside_the_portable_part_are_skipped_not_followed(tmp_path):
    home = _home(tmp_path)
    secret = tmp_path / "outside.txt"
    secret.write_text("OUTSIDE-SECRET", encoding="utf-8")
    os.symlink(secret, home / "memories" / "link.md")
    os.symlink(tmp_path, home / "skills" / "dirlink")
    os.mkfifo(home / "memories" / "pipe")
    os.link(home / "memories" / "USER.md", home / "memories" / "USER-again.md")
    out = tmp_path / "a.archive"
    result = _capture(home, out)
    rows = {(row["category"], row["reasonCode"]): row["count"] for row in result["skipped"]}
    assert rows[("memory", "symlink_escape")] == 1
    assert rows[("skills", "symlink_escape")] == 1
    assert rows[("memory", "non_regular_file")] == 3  # the fifo and both names of the hardlinked file
    assert b"OUTSIDE-SECRET" not in out.read_bytes()
    assert "memory/USER.md" not in _entries(result)


def test_a_home_with_nothing_else_still_checkpoints_through_its_provenance_record(tmp_path):
    home = tmp_path / "empty"
    home.mkdir()
    result = _capture(home, tmp_path / "a.archive")
    assert list(_entries(result)) == ["config/atum-home.json"]
    portable.validate_manifest(result["manifest"])


def test_an_unchanged_home_keeps_its_content_digest_across_generations(tmp_path):
    home = _home(tmp_path)
    first = _capture(home, tmp_path / "1.archive", generation=2, parent=1)
    second = _capture(home, tmp_path / "2.archive", generation=3, parent=2)
    assert first["contentSha256"] == second["contentSha256"]
    assert first["manifestSha256"] != second["manifestSha256"]
    (home / "memories" / "MEMORY.md").write_text("changed", encoding="utf-8")
    assert _capture(home, tmp_path / "3.archive", generation=4, parent=3)["contentSha256"] != first["contentSha256"]


def test_a_capture_with_inconsistent_generations_is_refused(tmp_path):
    home = _home(tmp_path)
    for kwargs in ({"generation": 2, "parent": 2}, {"generation": 1, "parent": 1}, {"generation": 3, "parent": 0}, {"epoch": 0}):
        with pytest.raises(HomeError) as raised:
            _capture(home, tmp_path / "x.archive", **kwargs)
        assert raised.value.code == "home_capture_invalid"
    with pytest.raises(HomeError):
        with open(tmp_path / "y.archive", "wb") as handle:
            portable.capture(str(home), handle, home_id="not-a-uuid", generation=2, parent_generation=1, home_epoch=1)


# ── Consistency while the home is being written ──────────────────────────────


def test_a_database_written_throughout_the_capture_neither_leaks_nor_breaks(tmp_path):
    home = _home(tmp_path)
    stop = threading.Event()
    failures: list[str] = []

    def writer() -> None:
        conn = sqlite3.connect(home / "state.db", timeout=5)
        count = 0
        try:
            while not stop.is_set():
                conn.execute("INSERT INTO messages (content) VALUES (?)", (f"secret-session-{count}",))
                conn.commit()
                count += 1
        except sqlite3.Error as error:  # pragma: no cover - the capture must never lock the writer out
            failures.append(str(error))
        finally:
            conn.close()

    thread = threading.Thread(target=writer)
    thread.start()
    try:
        time.sleep(0.05)
        results = [_capture(home, tmp_path / f"{index}.archive", generation=index + 2, parent=index + 1) for index in range(5)]
    finally:
        stop.set()
        thread.join(timeout=10)
    assert not failures
    for index, result in enumerate(results):
        raw = (tmp_path / f"{index}.archive").read_bytes()
        assert b"secret-session-" not in raw and b"SQLite format 3" not in raw
        assert ("memory", "database_or_sidecar") in {(row["category"], row["reasonCode"]) for row in result["skipped"]}
    check = sqlite3.connect(home / "state.db")
    assert check.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    check.close()


def test_a_file_replaced_atomically_during_the_capture_is_captured_whole(tmp_path):
    home = _home(tmp_path)
    target = home / "memories" / "MEMORY.md"
    # What the file holds before the writer's first replace is one whole version as well: a capture can beat the thread to it.
    versions = [target.read_bytes(), ("A" * 4096).encode(), ("B" * 8192).encode()]
    stop = threading.Event()

    def writer() -> None:
        index = 0
        while not stop.is_set():
            temporary = target.with_name(".mem_swap.tmp")
            temporary.write_bytes(versions[1 + index % 2])
            os.replace(temporary, target)
            index += 1

    thread = threading.Thread(target=writer)
    thread.start()
    try:
        for index in range(20):
            out = tmp_path / f"{index}.archive"
            result = _capture(home, out, generation=index + 2, parent=index + 1)
            entry = _entries(result)["memory/MEMORY.md"]
            body = out.read_bytes().split(b"\n", 1)[1]
            offset = 0
            for candidate in result["manifest"]["entries"]:
                if candidate["path"] == "memory/MEMORY.md":
                    data = body[offset : offset + candidate["bytes"]]
                    assert data in versions
                    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
                offset += candidate["bytes"]
    finally:
        stop.set()
        thread.join(timeout=10)


def test_a_file_that_will_not_hold_still_fails_the_capture_rather_than_being_skipped(tmp_path, monkeypatch):
    home = _home(tmp_path)
    real = atum_home._read_stable
    calls = {"count": 0}

    def unsteady(dir_fd, name, limit):
        if name == "MEMORY.md":
            calls["count"] += 1
            raise HomeError("home_file_changed")
        return real(dir_fd, name, limit)

    monkeypatch.setattr(atum_home, "_read_stable", unsteady)
    monkeypatch.setattr(portable, "STABLE_WAIT_SECONDS", 0)
    with pytest.raises(HomeError) as raised:
        _capture(home, tmp_path / "a.archive")
    assert raised.value.code == "home_file_changed"
    assert calls["count"] == portable.STABLE_ATTEMPTS


def test_a_file_replaced_between_the_walk_and_the_read_is_retried_never_skipped(tmp_path, monkeypatch):
    # Hermes replaces its files atomically: the file opened a moment ago then has no link left, which
    # _read_stable reports as home_file_invalid. That once dropped the file from the checkpoint as a
    # "non regular file", and a restore of that checkpoint would have deleted it.
    home = _home(tmp_path)
    real = atum_home._read_stable
    calls = {"count": 0}

    def replaced_once(dir_fd, name, limit):
        if name == "MEMORY.md":
            calls["count"] += 1
            if calls["count"] == 1:
                raise HomeError("home_file_invalid")
        return real(dir_fd, name, limit)

    monkeypatch.setattr(atum_home, "_read_stable", replaced_once)
    monkeypatch.setattr(portable, "STABLE_WAIT_SECONDS", 0)
    result = _capture(home, tmp_path / "a.archive")
    assert "memory/MEMORY.md" in _entries(result)
    assert ("memory", "non_regular_file") not in {(row["category"], row["reasonCode"]) for row in result["skipped"]}


def test_a_file_that_keeps_moving_fails_the_capture_instead_of_dropping_the_file(tmp_path, monkeypatch):
    home = _home(tmp_path)

    def always_replaced(dir_fd, name, limit):
        if name == "MEMORY.md":
            raise HomeError("home_file_invalid")
        return real(dir_fd, name, limit)

    real = atum_home._read_stable
    monkeypatch.setattr(atum_home, "_read_stable", always_replaced)
    monkeypatch.setattr(portable, "STABLE_WAIT_SECONDS", 0)
    with pytest.raises(HomeError) as raised:
        _capture(home, tmp_path / "a.archive")
    assert raised.value.code == "home_file_changed"


def test_a_file_removed_after_the_walk_is_simply_not_part_of_the_home(tmp_path, monkeypatch):
    home = _home(tmp_path)
    real = atum_home._read_stable

    def vanished(dir_fd, name, limit):
        if name == "USER.md":
            raise FileNotFoundError(name)
        return real(dir_fd, name, limit)

    monkeypatch.setattr(atum_home, "_read_stable", vanished)
    with_gap = _capture(home, tmp_path / "a.archive")
    assert "memory/USER.md" not in _entries(with_gap)
    assert all(row["reasonCode"] != "non_regular_file" for row in with_gap["skipped"])


def test_a_file_larger_than_the_remaining_budget_fails_the_capture_as_too_large(tmp_path, monkeypatch):
    home = _home(tmp_path)
    monkeypatch.setattr(atum_home, "MAX_HOME_BYTES", 8)
    with pytest.raises(HomeError) as raised:
        _capture(home, tmp_path / "a.archive")
    assert raised.value.code == "home_too_large"


def test_a_file_that_settles_within_the_retries_is_captured(tmp_path, monkeypatch):
    home = _home(tmp_path)
    real = atum_home._read_stable
    calls = {"count": 0}

    def settling(dir_fd, name, limit):
        if name == "MEMORY.md":
            calls["count"] += 1
            if calls["count"] < 3:
                raise HomeError("home_file_changed")
        return real(dir_fd, name, limit)

    monkeypatch.setattr(atum_home, "_read_stable", settling)
    monkeypatch.setattr(portable, "STABLE_WAIT_SECONDS", 0)
    assert "memory/MEMORY.md" in _entries(_capture(home, tmp_path / "a.archive"))
    assert calls["count"] == 3


def test_the_quarantine_copy_is_the_v15_export_with_a_consistent_database(tmp_path):
    home = _home(tmp_path)
    stop = threading.Event()

    def writer() -> None:
        conn = sqlite3.connect(home / "state.db", timeout=5)
        while not stop.is_set():
            conn.execute("INSERT INTO messages (content) VALUES ('newer')")
            conn.commit()
        conn.close()

    thread = threading.Thread(target=writer)
    thread.start()
    try:
        out = io.BytesIO()
        header = atum_home.export_home(str(home), out)
    finally:
        stop.set()
        thread.join(timeout=10)
    assert "state.db" in [entry["path"] for entry in header["files"]]
    restored = tmp_path / "restored"
    atum_home.hydrate_home(str(restored), io.BytesIO(out.getvalue()))
    check = sqlite3.connect(restored / "state.db")
    assert check.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    check.close()


# ── Restore ──────────────────────────────────────────────────────────────────


def _restore(home: Path, archive: Path, backups: Path, **kwargs) -> dict:
    with open(archive, "rb") as handle:
        return portable.restore(str(home), handle, backups=str(backups), **kwargs)


def test_a_restore_makes_the_portable_part_the_checkpoint_and_leaves_the_rest_of_the_home_alone(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    _capture(source, archive)

    target = _home(tmp_path, "mac-b")
    (target / "memories" / "MEMORY.md").write_text("Mac B's older memory", encoding="utf-8")
    (target / "memories" / "only-on-b.md").write_text("learned on B", encoding="utf-8")
    (target / "config.yaml").write_text("model: b-model\n", encoding="utf-8")
    (target / ".env").write_text("OPENAI_API_KEY=b-own-key", encoding="utf-8")
    (target / "auth.json").write_text('{"token":"b-token"}', encoding="utf-8")
    _make_state_db(target / "state.db", marker="b-history")
    own = {name: (target / name).read_bytes() for name in ("config.yaml", ".env", "auth.json", "state.db")}

    backups = tmp_path / "backups"
    result = _restore(target, archive, backups)

    assert (target / "memories" / "MEMORY.md").read_text() == "The demo code word is lotus."
    assert (target / "SOUL.md").read_text() == "You are Test."
    assert (target / "skills" / "notes" / "SKILL.md").read_text() == "# Notes"
    assert not (target / "memories" / "only-on-b.md").exists()
    assert result["removed"] >= 1 and result["backedUp"] >= 2
    # What was replaced or removed is saved first, under the checkpoint's generation.
    assert (backups / "2" / "memories" / "MEMORY.md").read_text() == "Mac B's older memory"
    assert (backups / "2" / "memories" / "only-on-b.md").read_text() == "learned on B"
    # This Mac's settings, credentials and session history stay exactly as they were.
    for name, content in own.items():
        assert (target / name).read_bytes() == content
    # Nothing the checkpoint never carried appears.
    assert not (target / "config" / "atum-home.json").exists()
    history = sqlite3.connect(target / "state.db")
    assert "b-history" in [row[0] for row in history.execute("SELECT content FROM messages").fetchall()]
    history.close()


def test_a_restore_is_idempotent_and_a_second_run_changes_nothing(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    _capture(source, archive)
    target = tmp_path / "mac-b" / "hermes-home"
    first = _restore(target, archive, tmp_path / "backups")
    before = _tree(target)
    second = _restore(target, archive, tmp_path / "backups")
    assert first["written"] > 0 and second["written"] == 0 and second["removed"] == 0 and second["backedUp"] == 0
    assert _tree(target) == before


def test_a_restore_leaves_what_the_grammar_would_never_carry_in_place(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    _capture(source, archive)
    target = _home(tmp_path, "mac-b")
    (target / "skills" / "notes" / "node_modules" / "dep" / "local.js").write_text("b's install", encoding="utf-8")
    _restore(target, archive, tmp_path / "backups")
    assert (target / "skills" / "notes" / "node_modules" / "dep" / "local.js").read_text() == "b's install"
    assert (target / "skills" / "notes" / "id_rsa").exists()  # an excluded name is not this restore's to remove


def test_routine_definitions_are_rebound_to_this_macs_paths(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    _capture(source, archive)
    target = tmp_path / "mac-b" / "hermes-home"
    result = _restore(target, archive, tmp_path / "backups")
    jobs = json.loads((target / "cron" / "jobs.json").read_text())
    job = jobs["jobs"][0]
    assert job["workdir"] == f"{os.path.realpath(target)}/projects"
    assert job["prompt"] == "hi" and job["id"] == "j1"
    # The user folder is the same Mac account in this test, so that path is already right.
    assert Path(job["script"]).resolve() == (Path.home() / "bin/run.sh").resolve()
    assert result["rebound"] >= 1


def test_rebinding_touches_only_strings_that_are_the_source_or_inside_it():
    data = json.dumps([{"workdir": "/home/example/home/x", "script": "/home/example/homework", "note": "/home/example/home", "n": 3}]).encode()
    rebound, count = portable.rebind_routines(data, [("/home/example/home", "/home/example/h")])
    value = json.loads(rebound)[0]
    assert value == {"workdir": "/home/example/h/x", "script": "/home/example/homework", "note": "/home/example/h", "n": 3}
    assert count == 2
    assert portable.rebind_routines(b"not json", [("/a", "/b")]) == (b"not json", 0)
    assert portable.rebind_routines(data, [("/home/example/home", "/home/example/home")]) == (data, 0)


def test_a_damaged_archive_changes_nothing(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    _capture(source, archive)
    target = _home(tmp_path, "mac-b")
    before = _tree(target)
    raw = archive.read_bytes()

    flipped = bytearray(raw)
    flipped[-3] ^= 0xFF
    cases = {
        "home_file_digest_mismatch": bytes(flipped),
        "home_archive_truncated": raw[:-5],
        "home_archive_trailing": raw + b"x",
    }
    for code, damaged in cases.items():
        path = tmp_path / f"{code}.archive"
        path.write_bytes(damaged)
        with pytest.raises(HomeError) as raised:
            _restore(target, path, tmp_path / "backups")
        assert raised.value.code == code
        assert _tree(target) == before
    assert not (tmp_path / "backups").exists()


def test_a_manifest_that_lists_an_excluded_path_or_lies_about_its_digest_is_refused(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    _capture(source, archive)
    head, body = archive.read_bytes().split(b"\n", 1)
    header = json.loads(head)
    target = _home(tmp_path, "mac-b")
    before = _tree(target)

    def refused(mutate, code):
        copy = json.loads(json.dumps(header))
        mutate(copy)
        path = tmp_path / "bad.archive"
        path.write_bytes(json.dumps(copy, separators=(",", ":"), sort_keys=True).encode() + b"\n" + body)
        with pytest.raises(HomeError) as raised:
            _restore(target, path, tmp_path / "backups")
        assert raised.value.code == code
        assert _tree(target) == before

    refused(lambda h: h["manifest"]["entries"][0].update(path="config/auth.json"), "home_manifest_invalid")
    refused(lambda h: h["manifest"]["entries"][0].update(path="../escape.md", category="memory"), "home_manifest_invalid")
    refused(lambda h: h["manifest"]["encryption"].update(credentialMaterialIncluded=True), "home_manifest_invalid")
    refused(lambda h: h["manifest"].update(parentGeneration=h["manifest"]["generation"]), "home_manifest_invalid")
    refused(lambda h: h["manifest"].update(generation=h["manifest"]["generation"] + 5), "home_manifest_digest_mismatch")
    refused(lambda h: h.update(profile="atum.agent-home/2"), "home_archive_invalid")


def test_a_restore_can_insist_on_the_manifest_and_home_the_platform_selected(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    result = _capture(source, archive)
    target = tmp_path / "mac-b" / "hermes-home"
    for kwargs in ({"expected_manifest_sha256": "1" * 64}, {"expected_home_id": "00000000-0000-4000-8000-bd7662a5eeb4"}):
        with pytest.raises(HomeError) as raised:
            _restore(target, archive, tmp_path / "backups", **kwargs)
        assert raised.value.code == "home_manifest_mismatch"
    assert not target.exists()
    _restore(target, archive, tmp_path / "backups", expected_manifest_sha256=result["manifestSha256"], expected_home_id=HOME_ID)
    assert (target / "SOUL.md").exists()


def test_a_verify_only_restore_proves_the_archive_is_readable_and_writes_nothing(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    result = _capture(source, archive, generation=5, parent=4)
    target = _home(tmp_path, "mac-b")
    before = _tree(target)

    proof = _restore(target, archive, tmp_path / "backups", verify_only=True, expected_manifest_sha256=result["manifestSha256"], expected_home_id=HOME_ID)

    assert proof["written"] == proof["removed"] == proof["backedUp"] == proof["rebound"] == 0
    assert proof["generation"] == 5 and proof["entries"] == len(result["manifest"]["entries"])
    assert _tree(target) == before
    assert not (tmp_path / "backups").exists()

    # It still refuses everything a real restore refuses.
    damaged = tmp_path / "damaged.archive"
    raw = bytearray(archive.read_bytes())
    raw[-3] ^= 0xFF
    damaged.write_bytes(bytes(raw))
    with pytest.raises(HomeError) as raised:
        _restore(target, damaged, tmp_path / "backups", verify_only=True)
    assert raised.value.code == "home_file_digest_mismatch"
    with pytest.raises(HomeError) as mismatch:
        _restore(target, archive, tmp_path / "backups", verify_only=True, expected_manifest_sha256="1" * 64)
    assert mismatch.value.code == "home_manifest_mismatch"


def test_a_restore_never_writes_through_a_link_in_the_destination(tmp_path):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    _capture(source, archive)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    target = tmp_path / "mac-b" / "hermes-home"
    target.mkdir(parents=True)
    os.symlink(elsewhere, target / "memories")
    with pytest.raises(OSError):
        _restore(target, archive, tmp_path / "backups")
    assert list(elsewhere.iterdir()) == []


# ── The command line the desktop runs ────────────────────────────────────────


def test_the_cli_round_trips_a_checkpoint_and_names_only_digests_on_stdout(tmp_path, capsys):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    code = atum_home.main(
        ["portable-capture", "--home", str(source), "--out", str(archive), "--home-id", HOME_ID, "--generation", "2",
         "--parent-generation", "1", "--home-epoch", "3"]
    )
    assert code == 0
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert set(summary) == {
        "ok", "manifestSha256", "contentSha256", "fingerprintSha256", "includedFiles", "bytes", "archiveSha256", "archiveBytes", "skippedRows", "skippedPaths",
        "stagedBy"
    }
    assert summary["stagedBy"] == "stable_read"
    assert summary["archiveSha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()
    assert summary["archiveBytes"] == archive.stat().st_size

    code = atum_home.main(["portable-inspect", "--archive", str(archive)])
    inspected = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and inspected["manifestSha256"] == summary["manifestSha256"]

    target = tmp_path / "mac-b" / "hermes-home"
    code = atum_home.main(
        ["portable-restore", "--home", str(target), "--archive", str(archive), "--backups", str(tmp_path / "backups"),
         "--expect-manifest-sha256", summary["manifestSha256"], "--expect-home-id", HOME_ID]
    )
    restored = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and restored["written"] > 0 and (target / "memories" / "MEMORY.md").exists()


def test_the_cli_reports_a_closed_code_and_never_overwrites_an_archive(tmp_path, capsys):
    source = _home(tmp_path, "mac-a")
    archive = tmp_path / "a.archive"
    archive.write_bytes(b"existing")
    code = atum_home.main(
        ["portable-capture", "--home", str(source), "--out", str(archive), "--home-id", HOME_ID, "--generation", "2",
         "--parent-generation", "1", "--home-epoch", "3"]
    )
    assert code == 2 and json.loads(capsys.readouterr().err.strip())["error"] == "export_out_exists"
    assert archive.read_bytes() == b"existing"


# ── Names: NFC in the checkpoint, whatever form the home spells them in ──────


def _nfd(text: str) -> str:
    return unicodedata.normalize("NFD", text)


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def _stored_names(directory: Path) -> list[str]:
    """The names as the disk stores them (APFS and HFS+ keep the spelling a file was created with)."""
    return sorted(os.listdir(directory))


def test_a_name_the_home_spells_in_nfd_is_carried_under_its_nfc_spelling(tmp_path):
    home = tmp_path / "hermes-home"
    (home / "memories").mkdir(parents=True)
    # Files a Finder, a keyboard or a tool made in decomposed form, Vietnamese included.
    (home / "memories" / _nfd("café.md")).write_text("coffee", encoding="utf-8")
    (home / "memories" / _nfd("Phở bò hôm nay.md")).write_text("noodles", encoding="utf-8")
    (home / "skills" / _nfd("Thư mục")).mkdir(parents=True)
    (home / "skills" / _nfd("Thư mục") / _nfd("Kỹ năng.md")).write_text("skill", encoding="utf-8")
    assert _nfd("café.md") in _stored_names(home / "memories")  # the disk really holds the decomposed spelling

    result = _capture(home, tmp_path / "a.archive")
    paths = sorted(_entries(result))

    assert "memory/café.md" in paths and "memory/Phở bò hôm nay.md" in paths and "skills/Thư mục/Kỹ năng.md" in paths
    assert all(path == _nfc(path) for path in paths)
    # Nothing was left out for its spelling, and the manifest is the contract's own.
    assert not any(row["reasonCode"] == "invalid_relative_path" for row in result["skipped"])
    portable.validate_manifest(result["manifest"])
    entries = _entries(result)
    assert entries["memory/café.md"]["sha256"] == hashlib.sha256(b"coffee").hexdigest()
    assert entries["skills/Thư mục/Kỹ năng.md"]["sha256"] == hashlib.sha256(b"skill").hexdigest()


def test_the_spelling_does_not_change_the_checkpoint(tmp_path):
    composed = tmp_path / "composed" / "hermes-home"
    decomposed = tmp_path / "decomposed" / "hermes-home"
    for home, spell in ((composed, _nfc), (decomposed, _nfd)):
        (home / "memories").mkdir(parents=True)
        (home / "memories" / spell("Phở.md")).write_text("same", encoding="utf-8")

    one = _capture(composed, tmp_path / "a.archive")
    other = _capture(decomposed, tmp_path / "b.archive")

    assert [e["path"] for e in one["manifest"]["entries"] if e["path"].startswith("memory/")] == ["memory/Phở.md"]
    # The provenance record names the folder, so the whole-checkpoint digest differs between the two homes; the file does not.
    assert _entries(one)["memory/Phở.md"] == _entries(other)["memory/Phở.md"]


def _two_spellings_of_one_name(tmp_path: Path):
    """A home that holds `café.md` twice, once in each form: only a disk that tells the forms apart can."""
    home = tmp_path / "hermes-home"
    (home / "memories").mkdir(parents=True)
    (home / "memories" / _nfc("café.md")).write_text("composed", encoding="utf-8")
    (home / "memories" / _nfd("café.md")).write_text("decomposed", encoding="utf-8")
    (home / "memories" / "plain.md").write_text("fine", encoding="utf-8")

    if len(os.listdir(home / "memories")) != 3:
        pytest.skip("this disk folds the two spellings into one file, so they cannot collide here")

    return home


def test_two_names_that_are_one_name_once_normalized_are_carried_neither_and_listed(tmp_path):
    home = _two_spellings_of_one_name(tmp_path)
    result = _capture(home, tmp_path / "a.archive")

    assert "memory/café.md" not in _entries(result)
    assert "memory/plain.md" in _entries(result)
    rows = {(row["category"], row["reasonCode"]): row for row in result["skipped"]}
    assert rows[("memory", "invalid_relative_path")]["count"] == 2
    expected = hashlib.sha256("\n".join(sorted([_nfc("memories/café.md"), _nfd("memories/café.md")])).encode()).hexdigest()
    assert rows[("memory", "invalid_relative_path")]["pathSha256"] == expected
    # Neither body travels, and the header never names the file.
    raw = (tmp_path / "a.archive").read_bytes()
    assert b"composed" not in raw and b"decomposed" not in raw
    portable.validate_manifest(result["manifest"])


def test_a_collision_is_decided_on_the_whole_path_not_on_the_directory_name(tmp_path, monkeypatch):
    # Two directories that are one directory once normalized, each holding the same file name: the files collide.
    home = tmp_path / "hermes-home"
    (home / "memories").mkdir(parents=True)
    one = home / "memories" / "one.md"
    two = home / "memories" / "two.md"
    one.write_text("1", encoding="utf-8")
    two.write_text("2", encoding="utf-8")
    real_walk = portable._walk

    def walk(root_fd, rel, prefix, category, skips, *rest):
        # `one.md` and `two.md` are reported under the same portable path, as two spellings of it would be.
        for home_rel, _portable, st in real_walk(root_fd, rel, prefix, category, skips, *rest):
            yield home_rel, f"{prefix}/same.md", st

    monkeypatch.setattr(portable, "_walk", walk)
    result = _capture(home, tmp_path / "a.archive")

    assert "memory/same.md" not in _entries(result)
    rows = {(row["category"], row["reasonCode"]): row["count"] for row in result["skipped"]}
    assert rows[("memory", "invalid_relative_path")] == 2


def test_a_restore_writes_nfc_names_and_leaves_none_of_the_old_spelling_behind(tmp_path):
    source = tmp_path / "mac-a" / "hermes-home"
    (source / "memories").mkdir(parents=True)
    (source / "memories" / _nfd("café.md")).write_text("new coffee", encoding="utf-8")
    archive = tmp_path / "a.archive"
    _capture(source, archive)

    # Mac B holds an older copy of the same file, spelled the other way.
    target = tmp_path / "mac-b" / "hermes-home"
    (target / "memories").mkdir(parents=True)
    (target / "memories" / _nfd("café.md")).write_text("old coffee", encoding="utf-8")
    backups = tmp_path / "backups"

    result = _restore(target, archive, backups)
    stored = _stored_names(target / "memories")

    # One file, spelled NFC, with the checkpoint's content: the file just written is not the one removed as stale.
    assert stored == [_nfc("café.md")]
    assert (target / "memories" / _nfc("café.md")).read_text(encoding="utf-8") == "new coffee"
    assert result["written"] >= 1
    # The older copy was saved before it was replaced.
    saved = [path.read_text(encoding="utf-8") for path in (backups / "2").rglob("*") if path.is_file()]
    assert "old coffee" in saved
    # And a second restore finds nothing to do.
    again = _restore(target, archive, backups)
    assert again["written"] == 0 and again["removed"] == 0 and again["backedUp"] == 0
    assert _stored_names(target / "memories") == [_nfc("café.md")]


def test_a_restore_normalizes_a_file_whose_content_already_matches(tmp_path):
    source = tmp_path / "mac-a" / "hermes-home"
    (source / "memories").mkdir(parents=True)
    (source / "memories" / "Phở.md").write_text("same", encoding="utf-8")
    archive = tmp_path / "a.archive"
    _capture(source, archive)
    target = tmp_path / "mac-b" / "hermes-home"
    (target / "memories").mkdir(parents=True)
    (target / "memories" / _nfd("Phở.md")).write_text("same", encoding="utf-8")

    _restore(target, archive, tmp_path / "backups")

    assert _stored_names(target / "memories") == [_nfc("Phở.md")]
    assert (target / "memories" / _nfc("Phở.md")).read_text(encoding="utf-8") == "same"


def test_a_restore_keeps_the_files_of_a_directory_the_home_spells_the_other_way(tmp_path):
    source = tmp_path / "mac-a" / "hermes-home"
    (source / "skills" / "Thư mục").mkdir(parents=True)
    (source / "skills" / "Thư mục" / "a.md").write_text("new skill", encoding="utf-8")
    archive = tmp_path / "a.archive"
    _capture(source, archive)
    target = tmp_path / "mac-b" / "hermes-home"
    (target / "skills" / _nfd("Thư mục")).mkdir(parents=True)
    (target / "skills" / _nfd("Thư mục") / "a.md").write_text("old skill", encoding="utf-8")

    _restore(target, archive, tmp_path / "backups")

    # Found by its NFC path, with the checkpoint's content, whichever way the disk spells the folder.
    assert (target / "skills" / _nfc("Thư mục") / "a.md").read_text(encoding="utf-8") == "new skill"
    # And no copy of the old content is left in a folder of the other spelling.
    leftovers = [path for path in (target / "skills").rglob("a.md") if path.read_text(encoding="utf-8") != "new skill"]
    assert leftovers == []


# ── The change fingerprint: cheap, and about exactly what a capture carries ──


def _fingerprint(home: Path) -> str:
    return portable.fingerprint(str(home))["fingerprintSha256"]


def test_a_capture_reports_the_fingerprint_the_home_has_just_after(tmp_path):
    home = _home(tmp_path)
    result = _capture(home, tmp_path / "a.archive")

    assert result["fingerprintSha256"] == _fingerprint(home)
    assert portable.fingerprint(str(home))["files"] == result["includedFiles"] - 1  # the provenance record is not a file of the home


def test_the_fingerprint_changes_with_what_a_capture_carries_and_with_nothing_else(tmp_path):
    home = _home(tmp_path)
    before = _fingerprint(home)

    # Never carried: history, settings, credentials, locks, workspaces, outputs.
    _make_state_db(home / "state.db", marker="more history")
    (home / "config.yaml").write_text("model: other\n", encoding="utf-8")
    (home / "auth.json").write_text('{"token":"new"}', encoding="utf-8")
    (home / "memories" / "MEMORY.md.lock").write_text("held", encoding="utf-8")
    (home / "workspace" / "project" / "main.py").write_text("edited", encoding="utf-8")
    (home / "cron" / "output" / "run.txt").write_text("newer run", encoding="utf-8")
    assert _fingerprint(home) == before

    # Carried: a memory rewritten, one added, a skill removed, the routines.
    memory = home / "memories" / "MEMORY.md"
    memory.write_text("The demo code word is now jasmine.", encoding="utf-8")
    after_rewrite = _fingerprint(home)
    assert after_rewrite != before

    (home / "memories" / "new.md").write_text("hi", encoding="utf-8")
    after_add = _fingerprint(home)
    assert after_add not in (before, after_rewrite)

    (home / "skills" / "notes" / "SKILL.md").unlink()
    after_remove = _fingerprint(home)
    assert after_remove not in (before, after_rewrite, after_add)

    (home / "cron" / "jobs.json").write_text("{}", encoding="utf-8")
    assert _fingerprint(home) != after_remove


def test_a_file_touched_again_with_the_same_size_still_changes_the_fingerprint(tmp_path):
    home = _home(tmp_path)
    memory = home / "memories" / "USER.md"
    before = _fingerprint(home)
    stat = memory.stat()
    memory.write_text("Prefers SHORT answers.", encoding="utf-8")  # the same length as "Prefers short answers."
    os.utime(memory, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))

    assert memory.stat().st_size == stat.st_size
    assert _fingerprint(home) != before


# ── A capture beside a running agent is proved by its fingerprint ────────────
#
# A background checkpoint stops nothing. It captures, asks for the fingerprint again, and keeps the archive only
# when the two are equal: nobody wrote a carried file between the end of the walk and the last read. These tests
# are that claim, against a writer that really does move files while the capture reads them.


def _bare_home(root: Path) -> Path:
    home = root / "bare" / "hermes-home"
    (home / "memories").mkdir(parents=True)
    return home


def _version(generation: int) -> bytes:
    """One whole version of a file: one letter, repeated, and as long as its generation says. A mixture of two
    versions, or a cut-off one, cannot be mistaken for a version."""
    return bytes([65 + generation % 26]) * (4096 + generation)


def _is_whole_version(data: bytes) -> bool:
    generation = len(data) - 4096
    return generation >= 0 and data == _version(generation)


def _replace(path: Path, data: bytes) -> None:
    """How Hermes writes a file: a temporary beside it, then an atomic replace."""
    temporary = path.with_name(f".mem_{path.name}.tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def _bodies(archive: Path, result: dict) -> dict[str, bytes]:
    body = archive.read_bytes().split(b"\n", 1)[1]
    bodies, offset = {}, 0
    for entry in result["manifest"]["entries"]:
        bodies[entry["path"]] = body[offset : offset + entry["bytes"]]
        offset += entry["bytes"]
    return bodies


def test_a_capture_reports_the_home_as_the_walk_found_it_not_as_it_read_it(tmp_path, monkeypatch):
    home = _home(tmp_path)
    before = _fingerprint(home)
    real = portable._read_held_still
    rewritten = {"done": False}

    def a_turn_writes_after_the_walk(root_fd, home_rel, limit):
        if home_rel.endswith("MEMORY.md") and not rewritten["done"]:
            rewritten["done"] = True
            _replace(home / "memories" / "MEMORY.md", b"The code word is now jasmine, said after the walk.")
        return real(root_fd, home_rel, limit)

    monkeypatch.setattr(portable, "_read_held_still", a_turn_writes_after_the_walk)
    out = tmp_path / "a.archive"
    result = _capture(home, out)
    monkeypatch.setattr(portable, "_read_held_still", real)

    # The archive holds what was read (the newer bytes), but the capture reports the home it WALKED: the one before the
    # write. So the caller's second question, "what is the fingerprint now?", gets a different answer: a writer got in.
    assert b"jasmine" in out.read_bytes()
    assert result["fingerprintSha256"] == before
    assert _fingerprint(home) != result["fingerprintSha256"]


def test_a_capture_of_a_home_nobody_wrote_is_proved_by_an_equal_fingerprint(tmp_path):
    home = _home(tmp_path)
    result = _capture(home, tmp_path / "a.archive")

    assert _fingerprint(home) == result["fingerprintSha256"]


def test_what_the_capture_does_not_carry_may_change_meanwhile_without_spoiling_it(tmp_path, monkeypatch):
    home = _home(tmp_path)
    real = portable._read_held_still
    reads = []

    def history_and_settings_move(root_fd, home_rel, limit):
        reads.append(home_rel)
        if len(reads) == 1:
            _make_state_db(home / "state.db", marker="a turn's history")
            (home / "config.yaml").write_text("model: another\n", encoding="utf-8")
            (home / "memories" / "MEMORY.md.lock").write_text("held", encoding="utf-8")
        return real(root_fd, home_rel, limit)

    monkeypatch.setattr(portable, "_read_held_still", history_and_settings_move)
    result = _capture(home, tmp_path / "a.archive")
    monkeypatch.setattr(portable, "_read_held_still", real)

    assert _fingerprint(home) == result["fingerprintSha256"]


def test_a_capture_is_one_moment_of_the_home_exactly_when_its_fingerprint_is_unchanged(tmp_path, monkeypatch):
    # A turn rewrites six files, one after another (so any real moment shows the newer ones first, then the older
    # ones). The capture has read the first file when the whole turn's writing lands, then reads the other five.
    home = _bare_home(tmp_path)
    paths = [home / "memories" / f"f{index}.md" for index in range(6)]
    for path in paths:
        _replace(path, _version(0))

    def versions(archive: Path, result: dict) -> list[int]:
        bodies = _bodies(archive, result)
        return [len(bodies[f"memory/f{index}.md"]) - 4096 for index in range(6)]

    def is_a_real_moment(seen: list[int]) -> bool:
        """The newer files come first: [1, 1, 0, 0, 0, 0] was a moment; [0, 1, 1, 1, 1, 1] never was."""
        return seen == sorted(seen, reverse=True)

    # Nobody writes: one moment, and the fingerprints agree.
    quiet = tmp_path / "quiet.archive"
    quiet_result = _capture(home, quiet, generation=2, parent=1)
    assert versions(quiet, quiet_result) == [0] * 6
    assert _fingerprint(home) == quiet_result["fingerprintSha256"]

    real = portable._read_held_still
    reads = []

    def the_turn_lands_after_the_first_read(root_fd, home_rel, limit):
        data = real(root_fd, home_rel, limit)
        reads.append(home_rel)
        if len(reads) == 1:
            for path in paths:
                _replace(path, _version(1))
        return data

    monkeypatch.setattr(portable, "_read_held_still", the_turn_lands_after_the_first_read)
    mixed = tmp_path / "mixed.archive"
    mixed_result = _capture(home, mixed, generation=3, parent=2)
    monkeypatch.setattr(portable, "_read_held_still", real)

    seen = versions(mixed, mixed_result)
    # The archive is a mixture of two moments, which no reader of the home would ever have seen ...
    assert seen == [0, 1, 1, 1, 1, 1]
    assert not is_a_real_moment(seen)
    # ... and the fingerprint is what says so: it differs, so the caller throws this archive away.
    assert _fingerprint(home) != mixed_result["fingerprintSha256"]


def test_files_replaced_all_through_a_capture_are_each_captured_whole(tmp_path):
    # The Hermes way of writing (a temporary, then an atomic replace), as fast as a thread can, over many files, with
    # files appearing and disappearing. Whatever else a capture does, no file in it is half of one version and half of
    # another, and the archive reads back as the manifest says.
    home = _bare_home(tmp_path)
    paths = [home / "memories" / f"f{index}.md" for index in range(10)]
    for path in paths:
        _replace(path, _version(0))
    stop = threading.Event()
    failures: list[BaseException] = []

    def writer() -> None:
        generation = 1
        try:
            while not stop.is_set():
                for path in paths:
                    _replace(path, _version(generation))
                _replace(home / "memories" / f"churn-{generation % 3}.md", _version(generation))
                (home / "memories" / f"churn-{(generation + 1) % 3}.md").unlink(missing_ok=True)
                generation += 1
                time.sleep(0.0005)
        except BaseException as error:  # pragma: no cover - the writer itself must never fail
            failures.append(error)

    thread = threading.Thread(target=writer)
    thread.start()
    captured = 0
    try:
        for index in range(25):
            out = tmp_path / f"{index}.archive"
            try:
                result = _capture(home, out, generation=index + 2, parent=index + 1)
            except HomeError as error:
                # A file that will not hold still fails the capture; it is never captured torn, and never skipped.
                assert error.code == "home_file_changed"
                continue
            captured += 1
            for path, data in _bodies(out, result).items():
                if path.startswith("memory/"):
                    assert _is_whole_version(data), path
                assert hashlib.sha256(data).hexdigest() == _entries(result)[path]["sha256"]
            assert portable.inspect_archive(str(out))["manifestSha256"] == result["manifestSha256"]
    finally:
        stop.set()
        thread.join(timeout=10)
    assert not failures
    assert captured >= 5


def test_the_fingerprint_opens_no_file_of_the_home(tmp_path, monkeypatch):
    home = _home(tmp_path)

    def refuse(*args, **kwargs):
        raise AssertionError("the fingerprint read a file")

    monkeypatch.setattr(atum_home, "_read_stable", refuse)
    assert len(_fingerprint(home)) == 64


def test_the_fingerprint_does_not_depend_on_how_a_name_is_spelled(tmp_path):
    composed = tmp_path / "composed" / "hermes-home"
    decomposed = tmp_path / "decomposed" / "hermes-home"
    for home, spell in ((composed, _nfc), (decomposed, _nfd)):
        (home / "memories").mkdir(parents=True)
        file = home / "memories" / spell("Phở.md")
        file.write_text("same", encoding="utf-8")
        os.utime(file, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

    assert _fingerprint(composed) == _fingerprint(decomposed)


def test_the_cli_prints_the_fingerprint_and_names_nothing_else(tmp_path, capsys):
    home = _home(tmp_path)
    code = atum_home.main(["portable-fingerprint", "--home", str(home)])
    printed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])

    assert code == 0
    assert set(printed) == {"ok", "fingerprintSha256", "files"}
    assert printed["fingerprintSha256"] == _fingerprint(home) and printed["ok"] is True


# ── A staged copy of the home: all a checkpoint beside a running agent ever reads ─────────────────────────────────
#
# The caller holds the home's writers still for the moment a snapshot takes (briefly: it admits no new write and finds
# none in flight), the snapshot copies exactly what a capture carries into a private folder, and the capture is then made
# from that immutable copy while the agent goes on. So the archive is the home as it was at one instant of writers held
# still, not a reading of files a writer may be changing, and what is recorded about its consistency is how it was made.


def _snapshot(home: Path, dest: Path, **kwargs) -> dict:
    return portable.snapshot(str(home), str(dest), **kwargs)


def _capture_snapshot(home: Path, snapshot: Path, out: Path, *, generation: int = 2, parent: int = 1, epoch: int = 3) -> dict:
    with open(out, "wb") as handle:
        return portable.capture(
            str(home), handle, home_id=HOME_ID, generation=generation, parent_generation=parent, home_epoch=epoch, snapshot=str(snapshot)
        )


def _header(archive: Path) -> dict:
    return json.loads(archive.read_bytes().split(b"\n", 1)[0])


def test_a_capture_from_a_snapshot_is_the_capture_of_the_home_it_was_taken_of(tmp_path):
    home = _home(tmp_path)
    direct = _capture(home, tmp_path / "direct.archive")
    staged = _snapshot(home, tmp_path / "snap")
    from_snapshot = _capture_snapshot(home, tmp_path / "snap", tmp_path / "from-snapshot.archive")

    for key in ("manifestSha256", "contentSha256", "fingerprintSha256", "includedFiles", "bytes", "skipped"):
        assert from_snapshot[key] == direct[key], key

    # Entry for entry the same bytes, in the same order.
    assert _bodies(tmp_path / "from-snapshot.archive", from_snapshot) == _bodies(tmp_path / "direct.archive", direct)
    assert staged["fingerprintSha256"] == direct["fingerprintSha256"] == _fingerprint(home)
    assert staged["files"] == len(direct["manifest"]["entries"]) - 1  # all but the provenance record, which is made at capture


def test_writes_after_the_snapshot_do_not_reach_the_archive(tmp_path):
    home = _home(tmp_path)
    before = _capture(home, tmp_path / "before.archive")
    _snapshot(home, tmp_path / "snap")

    # The agent goes on: a file replaced the way Hermes does it, a file written in place, a new one, one removed.
    _replace(home / "memories" / "MEMORY.md", b"The code word is now jasmine.")

    with open(home / "memories" / "USER.md", "r+b") as handle:
        handle.write(b"Prefers long answers, written in place.")

    (home / "memories" / "new.md").write_text("learned after the snapshot", encoding="utf-8")
    (home / "memories" / "ghi-chú hôm nay.md").unlink()

    after = _capture_snapshot(home, tmp_path / "snap", tmp_path / "after.archive")
    body = (tmp_path / "after.archive").read_bytes()

    assert after["manifestSha256"] == before["manifestSha256"]
    assert after["contentSha256"] == before["contentSha256"]
    assert b"jasmine" not in body and b"long answers" not in body and b"learned after" not in body
    assert b"lotus" in body and b"Prefers short answers." in body
    # And the staged files themselves are untouched by a write in place: a clone shares no data, a copy shares nothing.
    assert (tmp_path / "snap" / "files" / "memories" / "USER.md").read_bytes() == b"Prefers short answers."
    assert _fingerprint(home) != before["fingerprintSha256"]


def test_a_snapshot_stages_exactly_what_a_capture_carries_and_nothing_else(tmp_path):
    home = _home(tmp_path)
    _snapshot(home, tmp_path / "snap")
    staged = sorted(str(path.relative_to(tmp_path / "snap" / "files")) for path in (tmp_path / "snap" / "files").rglob("*") if path.is_file())

    assert staged == [
        "SOUL.md",
        "cron/jobs.json",
        "memories/MEMORY.md",
        "memories/USER.md",
        "memories/ghi-chú hôm nay.md",
        "skills/notes/SKILL.md",
        "skills/notes/scripts/run.py",
        "skills/notes/secret-santa.md",
    ]

    everything = b"".join(path.read_bytes() for path in (tmp_path / "snap").rglob("*") if path.is_file())

    for secret in (b"SQLite format 3", b"sk-test-do-not-leak", b"tok-do-not-leak", b"PRIVATE KEY MATERIAL", b"WORKSPACE-FILE-BODY", b"cookie jar", b"transcript"):
        assert secret not in everything


def test_a_snapshot_is_private_and_is_never_made_over_an_existing_folder(tmp_path):
    home = _home(tmp_path)
    _snapshot(home, tmp_path / "snap")

    assert oct((tmp_path / "snap").stat().st_mode & 0o777) == "0o700"
    assert oct((tmp_path / "snap" / "snapshot.json").stat().st_mode & 0o777) == "0o600"

    with pytest.raises(HomeError) as raised:
        _snapshot(home, tmp_path / "snap")
    assert raised.value.code == "home_snapshot_exists"

    (tmp_path / "taken").mkdir()
    (tmp_path / "taken" / "keep.txt").write_text("mine", encoding="utf-8")

    with pytest.raises(HomeError):
        _snapshot(home, tmp_path / "taken")
    assert (tmp_path / "taken" / "keep.txt").read_text(encoding="utf-8") == "mine"


def test_how_the_consistency_was_obtained_is_recorded_in_the_archive_and_is_true(tmp_path):
    home = _home(tmp_path)
    direct = _capture(home, tmp_path / "direct.archive")
    cloned = _snapshot(home, tmp_path / "clone")
    copied = _snapshot(home, tmp_path / "copy", clone=False)
    _capture_snapshot(home, tmp_path / "clone", tmp_path / "clone.archive")
    _capture_snapshot(home, tmp_path / "copy", tmp_path / "copy.archive")

    assert copied["method"] == "copy"
    assert cloned["method"] in ("apfs_clone", "copy")  # a clone where the volume can; a copy where it cannot

    contract = {"writersQuiesced": True, "sqliteMethod": "sqlite_backup", "stableFilesStaged": True}

    for archive in ("clone", "copy", "direct"):
        assert _header(tmp_path / f"{archive}.archive")["capture"]["consistency"] == contract

    assert _header(tmp_path / "clone.archive")["capture"]["stagedBy"] == f"snapshot_{cloned['method']}"
    assert _header(tmp_path / "copy.archive")["capture"]["stagedBy"] == "snapshot_copy"
    assert _header(tmp_path / "direct.archive")["capture"]["stagedBy"] == "stable_read"
    assert _header(tmp_path / "clone.archive")["capture"]["writers"] == "barrier"
    assert _header(tmp_path / "direct.archive")["capture"]["writers"] == "stopped"
    assert direct["stagedBy"] == "stable_read"
    assert _capture_snapshot(home, tmp_path / "copy", tmp_path / "again.archive")["stagedBy"] == "snapshot_copy"


def test_a_write_that_goes_on_while_the_snapshot_is_made_is_caught_and_leaves_no_snapshot(tmp_path, monkeypatch):
    home = _home(tmp_path)
    real, real_plan = portable._stage_file, portable._plan_snapshot
    staged = {"count": 0}

    def a_writer_slips_in(*args, **kwargs):
        result = real(*args, **kwargs)
        staged["count"] += 1

        # At the same point of every walk: the second one does not get away from a writer that is still at it.
        if staged["count"] == 2:
            _replace(home / "memories" / "MEMORY.md", b"The code word is now jasmine, said while the snapshot was made, at some length.")
        return result

    def walk_again(*args, **kwargs):
        staged["count"] = 0

        return real_plan(*args, **kwargs)

    monkeypatch.setattr(portable, "_stage_file", a_writer_slips_in)
    monkeypatch.setattr(portable, "_plan_snapshot", walk_again)

    with pytest.raises(HomeError) as raised:
        _snapshot(home, tmp_path / "snap")

    assert raised.value.code == "home_changed_during_snapshot"
    # No half-made snapshot is left lying about to be captured by mistake.
    assert not (tmp_path / "snap").exists()


def test_a_writer_that_changes_nothing_a_capture_carries_does_not_spoil_a_snapshot(tmp_path, monkeypatch):
    home = _home(tmp_path)
    real = portable._stage_file

    def history_grows(*args, **kwargs):
        (home / "state.db-wal").write_bytes(os.urandom(64))
        (home / "logs" / "agent.log").write_text("one more line", encoding="utf-8")
        (home / "config.yaml").write_text("model: another\n", encoding="utf-8")
        return real(*args, **kwargs)

    monkeypatch.setattr(portable, "_stage_file", history_grows)
    assert _snapshot(home, tmp_path / "snap")["files"] > 0


def test_a_link_swapped_in_after_the_walk_is_never_followed_into_the_snapshot(tmp_path, monkeypatch):
    home = _home(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("OUTSIDE-THE-HOME", encoding="utf-8")
    real = portable._included

    def swapped_after_the_walk(root_fd, skips, *rest):
        included = real(root_fd, skips, *rest)
        (home / "memories" / "MEMORY.md").unlink()
        (home / "memories" / "MEMORY.md").symlink_to(outside)
        return included

    monkeypatch.setattr(portable, "_included", swapped_after_the_walk)
    result = _snapshot(home, tmp_path / "snap")

    # The first staging met a link where the walk had seen a file, and did not follow it. The walk made again under the hold
    # sees a link, which is never carried, and the snapshot is the home without it.
    assert result["attempts"] == 2
    staged = [path for path in (tmp_path / "snap").rglob("*") if path.is_file()]

    assert not (tmp_path / "snap" / "files" / "memories" / "MEMORY.md").exists()
    assert all(b"OUTSIDE-THE-HOME" not in path.read_bytes() for path in staged)


@pytest.mark.skipif(fcntl is None, reason="the cron ticker's lock is an fcntl lock")
def test_a_cron_tick_in_progress_stops_the_snapshot_and_a_snapshot_holds_new_ticks_off(tmp_path, monkeypatch):
    home = _home(tmp_path)
    lock = home / "cron" / ".tick.lock"
    lock.write_text("", encoding="utf-8")

    # What Hermes's scheduler does at the start of a tick: an exclusive, non-blocking lock on this file.
    def try_tick() -> bool:
        with open(lock, "w", encoding="utf-8") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return False
            fcntl.flock(handle, fcntl.LOCK_UN)
            return True

    ticking = open(lock, "w", encoding="utf-8")
    fcntl.flock(ticking, fcntl.LOCK_EX | fcntl.LOCK_NB)

    with pytest.raises(HomeError) as raised:
        _snapshot(home, tmp_path / "busy")

    assert raised.value.code == "home_writers_busy"
    assert not (tmp_path / "busy").exists()
    fcntl.flock(ticking, fcntl.LOCK_UN)
    ticking.close()

    # While the snapshot is made no tick can start (it would skip, as Hermes's does), and afterwards one can.
    real = portable._stage_file
    seen = []

    def a_tick_tries_during_the_snapshot(*args, **kwargs):
        seen.append(try_tick())
        return real(*args, **kwargs)

    monkeypatch.setattr(portable, "_stage_file", a_tick_tries_during_the_snapshot)
    _snapshot(home, tmp_path / "snap")
    monkeypatch.setattr(portable, "_stage_file", real)

    assert seen and not any(seen)
    assert try_tick()


def test_a_database_in_the_carried_part_goes_through_the_backup_api_never_as_raw_bytes(tmp_path):
    home = _home(tmp_path)
    store = home / "skills" / "notes" / "store.dat"  # a database under a name the grammar does not recognise as one
    writer = sqlite3.connect(store)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.execute("CREATE TABLE facts (id INTEGER PRIMARY KEY, body TEXT)")
    writer.commit()

    for number in range(50):
        writer.execute("INSERT INTO facts (body) VALUES (?)", (f"fact {number}",))
        writer.commit()

    try:
        # The rows are in the write-ahead log, not in the main file: copying the file's bytes loses them.
        raw = tmp_path / "raw-copy.dat"
        raw.write_bytes(store.read_bytes())
        raw_rows = sqlite3.connect(raw).execute("SELECT count(*) FROM sqlite_master WHERE name='facts'").fetchone()[0]
        lost = 0 if raw_rows == 0 else sqlite3.connect(raw).execute("SELECT count(*) FROM facts").fetchone()[0]
        assert lost < 50

        result = _snapshot(home, tmp_path / "snap")
    finally:
        writer.close()

    staged = tmp_path / "snap" / "files" / "skills" / "notes" / "store.dat"
    assert sqlite3.connect(staged).execute("SELECT count(*) FROM facts").fetchone()[0] == 50
    assert not (tmp_path / "snap" / "files" / "skills" / "notes" / "store.dat-wal").exists()
    assert result["sqliteDatabases"] == 1


def test_a_snapshot_respects_the_caps_a_capture_does(tmp_path, monkeypatch):
    home = _home(tmp_path)
    monkeypatch.setattr(atum_home, "MAX_HOME_FILES", 2)

    with pytest.raises(HomeError) as raised:
        _snapshot(home, tmp_path / "many")
    assert raised.value.code == "home_too_many_files" and not (tmp_path / "many").exists()

    monkeypatch.setattr(atum_home, "MAX_HOME_FILES", 20_000)
    monkeypatch.setattr(atum_home, "MAX_HOME_BYTES", 10)

    with pytest.raises(HomeError) as raised:
        _snapshot(home, tmp_path / "large")
    assert raised.value.code == "home_too_large" and not (tmp_path / "large").exists()


def test_a_capture_from_a_snapshot_trusts_nothing_the_snapshot_folder_could_have_been_made_to_say(tmp_path):
    home = _home(tmp_path)
    _snapshot(home, tmp_path / "snap")
    record = json.loads((tmp_path / "snap" / "snapshot.json").read_text(encoding="utf-8"))

    # A path that climbs out of the staged files, a staged file whose length is not the recorded one, a staged file gone.
    for change in (
        lambda files: files[0].update(rel="../../etc/hosts"),
        lambda files: files[0].update(bytes=files[0]["bytes"] + 1),
        lambda files: files[0].update(rel="memories/never-staged.md"),
    ):
        damaged = json.loads(json.dumps(record))
        change(damaged["files"])
        (tmp_path / "snap" / "snapshot.json").write_text(json.dumps(damaged), encoding="utf-8")

        with pytest.raises(HomeError):
            _capture_snapshot(home, tmp_path / "snap", tmp_path / "never.archive")

        # Nothing was written to the archive: it is made only once everything in it has been read and checked.
        assert (tmp_path / "never.archive").stat().st_size == 0


def test_every_snapshot_that_is_kept_beside_a_busy_writer_is_one_real_instant_of_the_home(tmp_path):
    home = _bare_home(tmp_path)
    names = [f"storm-{index}.md" for index in range(8)]

    for name in names:
        _replace(home / "memories" / name, _version(0))

    running = threading.Event()
    running.set()
    generation = [0]

    def writer():
        # The way Hermes writes, a file after a file, in bursts with pauses between: some snapshots land inside a burst
        # (and are refused), some between two (and are kept).
        while running.is_set():
            burst_end = time.monotonic() + 0.01

            while time.monotonic() < burst_end and running.is_set():
                generation[0] += 1

                for name in names:
                    _replace(home / "memories" / name, _version(generation[0]))
            time.sleep(0.05)

    thread = threading.Thread(target=writer)
    thread.start()
    kept = 0
    refused = 0

    try:
        for attempt in range(25):
            dest = tmp_path / f"snap-{attempt}"

            try:
                _snapshot(home, dest)
            except HomeError as error:
                assert error.code in ("home_changed_during_snapshot", "home_file_changed", "home_file_invalid")
                assert not dest.exists()
                refused += 1
                continue

            # The writer replaces storm-0 .. storm-7 in turn, so at any one instant the newer generation is on the lower
            # numbers and the older on the higher ones, and the generations never differ by more than one.
            versions = []

            for name in names:
                data = (dest / "files" / "memories" / name).read_bytes()
                assert _is_whole_version(data)
                versions.append(len(data) - 4096)

            assert versions == sorted(versions, reverse=True), versions
            assert max(versions) - min(versions) <= 1
            kept += 1
            time.sleep(0.02)
    finally:
        running.clear()
        thread.join()

    assert kept >= 1


def test_the_window_holds_only_the_staging_and_the_second_look(tmp_path, monkeypatch):
    home = _home(tmp_path)
    events: list[str] = []
    real_plan, real_stage, real_look = portable._plan_snapshot, portable._stage_file, portable._still_as_planned

    @contextlib.contextmanager
    def window():
        events.append("hold")
        yield
        events.append("release")
        events.append("record-written" if (tmp_path / "snap" / "snapshot.json").exists() else "record-not-yet")

    def plan(*args, **kwargs):
        events.append("plan")
        return real_plan(*args, **kwargs)

    def stage(*args, **kwargs):
        events.append("stage")
        return real_stage(*args, **kwargs)

    def look(*args, **kwargs):
        events.append("look")
        return real_look(*args, **kwargs)

    monkeypatch.setattr(portable, "_plan_snapshot", plan)
    monkeypatch.setattr(portable, "_stage_file", stage)
    monkeypatch.setattr(portable, "_still_as_planned", look)
    result = _snapshot(home, tmp_path / "snap", window=window)

    # The walk, the grammar and the check for databases are done before the writers are held; the hold covers the staging
    # and the second look and nothing else; the record is written after the writers have been let go.
    assert events[0] == "plan" and events[1] == "hold"
    assert events[2 : 2 + result["files"]] == ["stage"] * result["files"]
    assert events[2 + result["files"] :] == ["look", "release", "record-not-yet"]
    assert (tmp_path / "snap" / "snapshot.json").exists()


def test_a_write_between_the_walk_and_the_hold_is_walked_again_under_the_hold(tmp_path):
    home = _home(tmp_path)
    window_entered = []

    @contextlib.contextmanager
    def window():
        # The caller took its time getting the writers held, and a writer finished its work in between.
        window_entered.append(True)
        _replace(home / "memories" / "MEMORY.md", b"The code word is now jasmine, said before the hold.")
        yield

    result = _snapshot(home, tmp_path / "snap", window=window)

    # The home was walked once more, under the hold, and what is staged is the home as it is when the writers were held.
    assert result["attempts"] == 2
    assert (tmp_path / "snap" / "files" / "memories" / "MEMORY.md").read_bytes() == b"The code word is now jasmine, said before the hold."
    assert result["fingerprintSha256"] == _fingerprint(home)
    _capture_snapshot(home, tmp_path / "snap", tmp_path / "a.archive")
    assert b"jasmine" in (tmp_path / "a.archive").read_bytes() and b"lotus" not in (tmp_path / "a.archive").read_bytes()


def test_an_undisturbed_window_walks_the_home_once(tmp_path):
    home = _home(tmp_path)

    assert _snapshot(home, tmp_path / "snap")["attempts"] == 1


def test_the_second_walk_is_made_under_the_hold_and_checked_like_the_first(tmp_path, monkeypatch):
    home = _home(tmp_path)
    events: list[str] = []
    real_plan, real_look = portable._plan_snapshot, portable._still_as_planned
    first_look = {"seen": False}

    @contextlib.contextmanager
    def window():
        events.append("hold")
        yield
        events.append("release")

    def plan(*args, **kwargs):
        events.append("plan")
        return real_plan(*args, **kwargs)

    def look(*args, **kwargs):
        events.append("look")

        if not first_look["seen"]:
            first_look["seen"] = True
            # A write finished after the walk, before the hold: the first look says the home moved.
            _replace(home / "memories" / "MEMORY.md", b"changed after the first walk")

        return real_look(*args, **kwargs)

    monkeypatch.setattr(portable, "_plan_snapshot", plan)
    monkeypatch.setattr(portable, "_still_as_planned", look)
    result = _snapshot(home, tmp_path / "snap", window=window)

    assert result["attempts"] == 2
    assert [event for event in events if event != "look"] == ["plan", "hold", "plan", "release"]
    assert events.count("look") == 2


@pytest.mark.parametrize("how", ["made", "removed", "renamed"])
def test_a_file_made_removed_or_renamed_all_through_the_window_refuses_the_snapshot(tmp_path, monkeypatch, how):
    home = _home(tmp_path)
    real_stage, real_plan = portable._stage_file, portable._plan_snapshot
    plans = []
    calls = {"n": 0}
    names = {"current": "USER.md"}

    def a_writer(*args, **kwargs):
        calls["n"] += 1

        if how == "made":
            (home / "memories" / f"another-{calls['n']}.md").write_text("new", encoding="utf-8")
        elif how == "removed":
            victims = sorted(path for path in (home / "memories").iterdir() if path.is_file())
            victims[0].unlink()
        else:
            target = f"RENAMED-{calls['n']}.md"
            (home / "memories" / names["current"]).rename(home / "memories" / target)
            names["current"] = target

        return real_stage(*args, **kwargs)

    def counting_plan(*args, **kwargs):
        plans.append(True)

        return real_plan(*args, **kwargs)

    monkeypatch.setattr(portable, "_stage_file", a_writer)
    monkeypatch.setattr(portable, "_plan_snapshot", counting_plan)

    with pytest.raises(HomeError) as raised:
        _snapshot(home, tmp_path / "snap")

    # A writer that is still at it when the home is walked again is refused, after one more walk and no more.
    assert raised.value.code == "home_changed_during_snapshot", how
    assert len(plans) == portable.SNAPSHOT_ATTEMPTS == 2
    assert not (tmp_path / "snap").exists()


@pytest.mark.parametrize("how", ["made", "removed", "renamed"])
def test_a_file_made_removed_or_renamed_once_inside_the_window_is_absorbed_by_the_second_walk(tmp_path, monkeypatch, how):
    home = _home(tmp_path)
    real_stage = portable._stage_file
    done = {"yes": False}

    def a_writer(*args, **kwargs):
        if not done["yes"]:
            done["yes"] = True
            {
                "made": lambda: (home / "memories" / "another.md").write_text("new", encoding="utf-8"),
                "removed": lambda: (home / "memories" / "USER.md").unlink(),
                "renamed": lambda: (home / "memories" / "USER.md").rename(home / "memories" / "RENAMED.md"),
            }[how]()

        return real_stage(*args, **kwargs)

    monkeypatch.setattr(portable, "_stage_file", a_writer)
    result = _snapshot(home, tmp_path / "snap")

    assert result["attempts"] == 2
    assert result["fingerprintSha256"] == _fingerprint(home)
    staged = {path.name for path in (tmp_path / "snap" / "files" / "memories").iterdir()}

    # What is staged is the home as the second walk found it.
    assert ("another.md" in staged) == (how == "made")
    assert ("RENAMED.md" in staged) == (how == "renamed")
    assert ("USER.md" in staged) == (how == "made")


def _hold_process(home: Path, dest: Path) -> subprocess.Popen:
    env = {**os.environ, "PYTHONPATH": str(REPO), "PYTHONNOUSERSITE": "1"}

    return subprocess.Popen(
        [sys.executable, "-s", "-P", "-B", "-m", "hermes_cli.atum_home", "portable-snapshot", "--home", str(home), "--dest", str(dest), "--hold"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        cwd=REPO,
    )


def test_a_closed_code_reaches_stderr_when_the_tool_is_run_the_way_the_desktop_runs_it(tmp_path):
    # `python -m hermes_cli.atum_home` runs this module as __main__, a second copy of the one the portable tool takes
    # `HomeError` from; a main() that caught only its own copy's class let the tool's closed codes out as a traceback
    # (exit 1), and the desktop could then only say the tool failed. The code is what the cadence decides on.
    home = _home(tmp_path)
    (tmp_path / "existing.archive").write_bytes(b"existing")
    env = {**os.environ, "PYTHONPATH": str(REPO), "PYTHONNOUSERSITE": "1"}

    run = subprocess.run(
        [sys.executable, "-s", "-P", "-B", "-m", "hermes_cli.atum_home", "portable-capture", "--home", str(home), "--out", str(tmp_path / "existing.archive"),
         "--home-id", HOME_ID, "--generation", "2", "--parent-generation", "1", "--home-epoch", "3"],
        capture_output=True, text=True, env=env, cwd=REPO, timeout=60,
    )

    assert run.returncode == 2
    assert json.loads(run.stderr.strip().splitlines()[-1]) == {"error": "export_out_exists"}
    assert (tmp_path / "existing.archive").read_bytes() == b"existing"


def test_the_command_says_ready_waits_for_go_and_says_staged_when_the_window_ends(tmp_path):
    home = _home(tmp_path)
    process = _hold_process(home, tmp_path / "snap")

    try:
        assert json.loads(process.stdout.readline()) == {"ok": True, "phase": "ready"}
        # Nothing has been staged while it waits for the caller to hold the writers.
        assert not (tmp_path / "snap" / "snapshot.json").exists()
        process.stdin.write("go\n")
        process.stdin.flush()
        assert json.loads(process.stdout.readline()) == {"ok": True, "phase": "staged"}
        final = json.loads(process.stdout.readline())
        assert process.wait(timeout=30) == 0
    finally:
        process.kill()

    assert final["ok"] is True and final["fingerprintSha256"] == _fingerprint(home)
    assert (tmp_path / "snap" / "snapshot.json").exists()


@pytest.mark.parametrize("answer", ["stop\n", ""], ids=["anything but go", "the caller goes away"])
def test_the_command_is_cancelled_by_anything_but_go_and_leaves_nothing(tmp_path, answer):
    home = _home(tmp_path)
    process = _hold_process(home, tmp_path / "snap")

    try:
        assert json.loads(process.stdout.readline())["phase"] == "ready"
        process.stdin.write(answer)
        process.stdin.close()
        err = process.stderr.read()
        process.wait(timeout=30)
    finally:
        process.kill()

    assert process.returncode == 2 and json.loads(err.strip().splitlines()[-1])["error"] == "home_snapshot_cancelled"
    assert not (tmp_path / "snap").exists()


def test_a_write_while_the_command_waits_for_go_is_walked_again_once_go_comes(tmp_path):
    home = _home(tmp_path)
    process = _hold_process(home, tmp_path / "snap")

    try:
        assert json.loads(process.stdout.readline())["phase"] == "ready"
        _replace(home / "memories" / "MEMORY.md", b"The code word is now jasmine, said before go.")
        process.stdin.write("go\n")
        process.stdin.flush()
        assert json.loads(process.stdout.readline()) == {"ok": True, "phase": "staged"}
        final = json.loads(process.stdout.readline())
        assert process.wait(timeout=30) == 0
    finally:
        process.kill()

    # The writers were held by then, so the home was walked again under the hold and is what was staged.
    assert final["attempts"] == 2 and final["fingerprintSha256"] == _fingerprint(home)
    assert (tmp_path / "snap" / "files" / "memories" / "MEMORY.md").read_bytes() == b"The code word is now jasmine, said before go."


def test_the_cli_makes_a_snapshot_and_captures_from_it_and_prints_only_digests(tmp_path, capsys):
    home = _home(tmp_path)
    code = atum_home.main(["portable-snapshot", "--home", str(home), "--dest", str(tmp_path / "snap")])
    made = json.loads(capsys.readouterr().out.strip().splitlines()[-1])

    assert code == 0
    assert set(made) == {"ok", "fingerprintSha256", "files", "bytes", "method", "sqliteDatabases", "heldMs", "attempts"}
    assert made["fingerprintSha256"] == _fingerprint(home) and made["method"] in ("apfs_clone", "copy")
    assert str(home) not in json.dumps(made)

    archive = tmp_path / "a.archive"
    code = atum_home.main(
        ["portable-capture", "--home", str(home), "--snapshot", str(tmp_path / "snap"), "--out", str(archive), "--home-id", HOME_ID,
         "--generation", "2", "--parent-generation", "1", "--home-epoch", "3"]
    )
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])

    assert code == 0 and summary["fingerprintSha256"] == made["fingerprintSha256"]
    assert summary["stagedBy"] == f"snapshot_{made['method']}"
    assert summary["archiveSha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()

    code = atum_home.main(["portable-snapshot", "--home", str(home), "--dest", str(tmp_path / "snap")])
    assert code == 2 and json.loads(capsys.readouterr().err.strip())["error"] == "home_snapshot_exists"
