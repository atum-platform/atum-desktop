"""Per-profile identity metadata: display name, avatar, and provenance.

`profile.yaml` is the file Hermes already owns for metadata ABOUT a profile.
These fields let a product show a profile as something a person recognises
without forcing that name through the filesystem-safe id rules, and let a
product tell its own profiles apart from ones a person made with the CLI.
"""

from pathlib import Path

import multiprocessing as mp
import pytest
import time
import yaml

import re
import threading

from hermes_cli import profiles
from hermes_cli import atum_profile_identity as identity
from hermes_cli.profiles import assign_profile_identity, read_profile_meta, write_profile_meta


def _wait_for_path(path: Path, timeout_seconds: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert path.exists(), f"timed out waiting for {path}"


def _write_description_after_delayed_atomic_replace(
    profile_dir_text: str,
    entered_text: str,
    release_text: str,
) -> None:
    """Hold a writer after its read and before its atomic replace.

    With only a process-local lock, a second process can finish an identity
    adoption during this pause and have that update overwritten when this
    delayed writer resumes.  A metadata sidecar lock instead makes the second
    writer wait until this process has replaced the file.
    """
    from hermes_cli import profiles as child_profiles
    import utils

    entered = Path(entered_text)
    release = Path(release_text)
    original_atomic_write = utils.atomic_yaml_write

    def delayed_atomic_write(path, data, **kwargs):
        entered.write_text("1", encoding="utf-8")
        _wait_for_path(release)
        original_atomic_write(path, data, **kwargs)

    utils.atomic_yaml_write = delayed_atomic_write
    child_profiles.write_profile_meta(Path(profile_dir_text), description="Written by CLI")


def _adopt_identity_in_a_second_process(
    profile_dir_text: str,
    identity_id: str,
    started_text: str,
    finished_text: str,
) -> None:
    from hermes_cli import atum_profile_identity as child_identity
    from hermes_cli import profiles as child_profiles

    profile_dir = Path(profile_dir_text)
    child_profiles._get_default_hermes_home = lambda: profile_dir
    Path(started_text).write_text("1", encoding="utf-8")
    child_identity.adopt_profile_identity(profile_dir, identity_id)
    Path(finished_text).write_text("1", encoding="utf-8")


def _hold_profile_metadata_lock(
    profile_dir_text: str,
    entered_text: str,
    release_text: str,
) -> None:
    from hermes_cli import atum_profile_identity as child_identity

    with child_identity.profile_meta_lock(Path(profile_dir_text)):
        Path(entered_text).write_text("1", encoding="utf-8")
        _wait_for_path(Path(release_text))


@pytest.fixture
def profile_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "agent"
    directory.mkdir()
    return directory


def _yaml(profile_dir: Path) -> dict:
    return yaml.safe_load((profile_dir / "profile.yaml").read_text()) or {}


def test_a_profile_without_metadata_reads_as_empty_never_as_an_error(tmp_path, profile_dir):
    assert read_profile_meta(profile_dir) == {
        "description": "",
        "description_auto": False,
        "display_name": "",
        "bot_title": "",
        "previous_names": [],
        "avatar": "",
        "managed_by": "",
        "identity_id": "",
        "lifecycle_revision": 0,
    }
    # A missing directory, a corrupt file, and a non-mapping file all read the
    # same way: `hermes profile list` must never break on one bad profile.
    assert read_profile_meta(tmp_path / "does-not-exist")["display_name"] == ""
    (profile_dir / "profile.yaml").write_text("{{{ not yaml")
    assert read_profile_meta(profile_dir)["display_name"] == ""
    (profile_dir / "profile.yaml").write_text("- a list, not a mapping\n")
    assert read_profile_meta(profile_dir)["avatar"] == ""


def test_identity_round_trips_and_each_field_is_independent(profile_dir):
    write_profile_meta(profile_dir, display_name="Trợ lý Marketing", avatar="📣", managed_by="atum")

    meta = read_profile_meta(profile_dir)
    assert meta["display_name"] == "Trợ lý Marketing"
    assert meta["avatar"] == "📣"
    assert meta["managed_by"] == "atum"

    # Writing one field leaves the others alone.
    write_profile_meta(profile_dir, description="Runs the campaign calendar.")
    meta = read_profile_meta(profile_dir)
    assert meta["display_name"] == "Trợ lý Marketing"
    assert meta["avatar"] == "📣"
    assert meta["description"] == "Runs the campaign calendar."

    # An empty string clears a field so callers fall back to the profile name.
    write_profile_meta(profile_dir, display_name="")
    assert read_profile_meta(profile_dir)["display_name"] == ""
    assert read_profile_meta(profile_dir)["avatar"] == "📣"


def test_unknown_keys_written_by_another_version_survive_a_write(profile_dir):
    (profile_dir / "profile.yaml").write_text(
        yaml.safe_dump({"description": "kept", "future_field": {"nested": [1, 2]}})
    )

    write_profile_meta(profile_dir, display_name="Alfred")

    stored = _yaml(profile_dir)
    assert stored["future_field"] == {"nested": [1, 2]}
    assert stored["description"] == "kept"
    assert stored["display_name"] == "Alfred"


@pytest.mark.parametrize(
    ("field", "value", "expected"),
    [
        ("display_name", "  Padded  ", "Padded"),
        ("display_name", "Two\nlines", "Two lines"),
        ("display_name", "x" * 200, "x" * 64),
        ("display_name", "tab\tsep", "tab sep"),
        ("avatar", "  📣  ", "📣"),
        ("avatar", "x" * 40, "x" * 16),
        ("avatar", "bell", "bell"),
    ],
)
def test_identity_text_is_one_bounded_line_without_control_characters(profile_dir, field, value, expected):
    write_profile_meta(profile_dir, **{field: value})
    assert read_profile_meta(profile_dir)[field] == expected


@pytest.mark.parametrize(
    "value",
    ["/home/example/secret/keys.pem", "../../etc/passwd", "https://example.com/a.png", ".hidden", "C:\\keys.pem"],
)
def test_an_avatar_is_symbolic_and_can_never_smuggle_a_location(profile_dir, value):
    # A length cap alone is not enough: truncating "/home/example/secret/keys.pem"
    # still leaves an absolute path. Anything location-shaped is refused.
    with pytest.raises(ValueError):
        write_profile_meta(profile_dir, avatar=value)

    # And a location already on disk reads as no avatar at all.
    (profile_dir / "profile.yaml").write_text(yaml.safe_dump({"avatar": value}))
    assert read_profile_meta(profile_dir)["avatar"] == ""


@pytest.mark.parametrize("value", ["Atum", "atum-desktop", "atum_2", "a"])
def test_managed_by_accepts_a_product_slug_case_insensitively(profile_dir, value):
    write_profile_meta(profile_dir, managed_by=value)
    assert read_profile_meta(profile_dir)["managed_by"] == value.lower()


@pytest.mark.parametrize("value", ["-leading", "has space", "../escape", "sym*bol"])
def test_managed_by_rejects_anything_that_is_not_a_slug(profile_dir, value):
    with pytest.raises(ValueError):
        write_profile_meta(profile_dir, managed_by=value)

    # And a bad value already on disk reads as unowned rather than as itself,
    # so a product never treats a hand-edited profile as one it manages.
    (profile_dir / "profile.yaml").write_text(yaml.safe_dump({"managed_by": "../escape"}))
    assert read_profile_meta(profile_dir)["managed_by"] == ""


def test_writing_to_a_missing_profile_directory_fails_loudly(tmp_path):
    with pytest.raises(FileNotFoundError):
        write_profile_meta(tmp_path / "nope", display_name="x")


@pytest.mark.parametrize("contents", [b"{{{ not yaml", b"- a list, not a mapping\n"])
def test_metadata_writers_fail_closed_and_preserve_unreadable_bytes(profile_dir, monkeypatch, contents):
    """A lazy identity mint must not "repair" a file it cannot understand."""
    path = profile_dir / "profile.yaml"
    path.write_bytes(contents)
    plane_identity = "00000000-0000-4000-8000-303617b97302"
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: profile_dir)

    with pytest.raises(ValueError):
        write_profile_meta(profile_dir, display_name="Marketing")
    assert path.read_bytes() == contents

    with pytest.raises(ValueError):
        assign_profile_identity(profile_dir)
    assert path.read_bytes() == contents

    with pytest.raises(ValueError):
        profiles.adopt_profile_identity(profile_dir, plane_identity)
    assert path.read_bytes() == contents


UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def test_identity_is_minted_once_and_then_preserved(profile_dir):
    # The profile NAME is a directory: renamed, cloned, and identical across
    # machines. The identity is the thing that is none of those.
    first = assign_profile_identity(profile_dir)
    assert UUID4.match(first)
    assert assign_profile_identity(profile_dir) == first
    assert read_profile_meta(profile_dir)["identity_id"] == first
    assert read_profile_meta(profile_dir)["lifecycle_revision"] == 1


def test_existing_identity_is_read_without_creating_a_metadata_lock(profile_dir, monkeypatch):
    """Read-only listings do not need a writable sidecar for a known id."""
    identity_id = "00000000-0000-4000-8000-303617b97302"
    (profile_dir / "profile.yaml").write_text(f"identity_id: {identity_id}\n")

    def unexpected_lock(_profile_dir):
        pytest.fail("existing identity should not acquire the metadata lock")

    monkeypatch.setattr(identity, "profile_meta_lock", unexpected_lock)
    assert assign_profile_identity(profile_dir) == identity_id
    assert not (profile_dir / "profile.yaml.lock").exists()


def test_a_regenerated_identity_is_new_because_a_clone_is_a_new_agent(profile_dir):
    first = assign_profile_identity(profile_dir)
    second = assign_profile_identity(profile_dir, regenerate=True)
    assert second != first and UUID4.match(second)
    assert read_profile_meta(profile_dir)["lifecycle_revision"] == 1


def test_identity_writes_bump_the_revision_but_never_touch_the_id(profile_dir):
    ident = assign_profile_identity(profile_dir)
    write_profile_meta(profile_dir, display_name="Marketing")
    write_profile_meta(profile_dir, avatar="📣")
    write_profile_meta(profile_dir, description="unchanged identity")  # not an identity write
    meta = read_profile_meta(profile_dir)
    assert meta["identity_id"] == ident
    assert meta["lifecycle_revision"] == 3


def test_an_invalid_stored_identity_reads_as_empty_and_is_replaced(profile_dir):
    (profile_dir / "profile.yaml").write_text("identity_id: not-a-uuid\nlifecycle_revision: -4\n")
    assert read_profile_meta(profile_dir)["identity_id"] == ""
    assert read_profile_meta(profile_dir)["lifecycle_revision"] == 0
    assert UUID4.match(assign_profile_identity(profile_dir))


def test_concurrent_first_reads_agree_on_one_identity(profile_dir):
    results = []
    barrier = threading.Barrier(8)

    def worker():
        barrier.wait()
        results.append(assign_profile_identity(profile_dir))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(results)) == 1
    assert results[0] == read_profile_meta(profile_dir)["identity_id"]


def test_concurrent_identity_and_metadata_writes_keep_both_updates(profile_dir):
    """Writers serialize the whole read-modify-write cycle, not just output."""
    start = threading.Barrier(2)
    errors = []

    def mint_identity():
        try:
            start.wait()
            assign_profile_identity(profile_dir)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    def update_metadata():
        try:
            start.wait()
            write_profile_meta(profile_dir, display_name="Marketing")
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    threads = [threading.Thread(target=mint_identity), threading.Thread(target=update_metadata)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)

    assert not any(thread.is_alive() for thread in threads)
    assert not errors
    meta = read_profile_meta(profile_dir)
    assert UUID4.match(meta["identity_id"])
    assert meta["display_name"] == "Marketing"


def test_two_process_writers_preserve_description_and_identity(profile_dir):
    """The CLI and desktop process cannot lose each other's RMW update.

    The first process pauses after reading the old document but before its
    atomic replacement.  That makes a process-local ``threading.Lock`` fail
    deterministically: identity adoption would complete and then be erased by
    the delayed description write.  The sidecar advisory lock keeps adoption
    outside that window, so it re-reads the completed description first.
    """
    from hermes_cli import auth

    if auth.fcntl is None and auth.msvcrt is None:
        pytest.skip("cross-process file locking is unavailable")

    identity_id = "00000000-0000-4000-8000-303617b97302"
    entered = profile_dir / "description_writer_entered"
    release = profile_dir / "description_writer_release"
    adoption_started = profile_dir / "adoption_started"
    adoption_finished = profile_dir / "adoption_finished"
    ctx = mp.get_context("spawn")
    description_writer = ctx.Process(
        target=_write_description_after_delayed_atomic_replace,
        args=(str(profile_dir), str(entered), str(release)),
    )
    identity_writer = ctx.Process(
        target=_adopt_identity_in_a_second_process,
        args=(
            str(profile_dir),
            identity_id,
            str(adoption_started),
            str(adoption_finished),
        ),
    )

    try:
        description_writer.start()
        _wait_for_path(entered)
        identity_writer.start()
        _wait_for_path(adoption_started)
        # The second process has entered adoption, but must still be waiting
        # for the first process's sidecar flock, not completing a stale write.
        time.sleep(0.2)
        assert not adoption_finished.exists()
    finally:
        release.write_text("1", encoding="utf-8")
        for process in (description_writer, identity_writer):
            if process.pid is not None:
                process.join(timeout=15)
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)

    assert description_writer.exitcode == 0
    assert identity_writer.exitcode == 0
    meta = read_profile_meta(profile_dir)
    assert meta["description"] == "Written by CLI"
    assert meta["identity_id"] == identity_id


def test_profile_metadata_lock_timeout_fails_closed(profile_dir, monkeypatch):
    """A wedged external lock raises instead of writing a stale snapshot."""
    from hermes_cli import auth

    if auth.fcntl is None and auth.msvcrt is None:
        pytest.skip("cross-process file locking is unavailable")

    entered = profile_dir / "lock_holder_entered"
    release = profile_dir / "lock_holder_release"
    holder = mp.get_context("spawn").Process(
        target=_hold_profile_metadata_lock,
        args=(str(profile_dir), str(entered), str(release)),
    )
    holder.start()
    try:
        _wait_for_path(entered)
        # The shared helper intentionally applies a one-second minimum, even
        # when a caller requests a shorter deadline.
        monkeypatch.setattr(identity, "_PROFILE_META_LOCK_TIMEOUT_SECONDS", 0)
        started_at = time.monotonic()
        with pytest.raises(TimeoutError, match="profile metadata lock"):
            write_profile_meta(profile_dir, description="must not write")
        assert time.monotonic() - started_at < 2.5
        assert not (profile_dir / "profile.yaml").exists()
    finally:
        release.write_text("1", encoding="utf-8")
        holder.join(timeout=15)
        if holder.is_alive():
            holder.terminate()
            holder.join(timeout=5)

    assert holder.exitcode == 0


def test_all_metadata_writers_use_the_shared_serialized_lock(profile_dir, monkeypatch):
    """Metadata edits, lazy minting, and plane adoption use one RMW lock."""
    class RecordingLock:
        def __init__(self):
            self._lock = threading.Lock()
            self.entries = 0

        def __enter__(self):
            self.entries += 1
            self._lock.acquire()
            return self

        def __exit__(self, exc_type, exc, traceback):
            self._lock.release()

    lock = RecordingLock()
    monkeypatch.setattr(identity, "profile_meta_lock", lambda _profile_dir: lock)
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: profile_dir)

    write_profile_meta(profile_dir, display_name="Marketing")
    assign_profile_identity(profile_dir)
    profiles.adopt_profile_identity(profile_dir, "00000000-0000-4000-8000-303617b97302")

    assert lock.entries == 3


def test_unknown_keys_still_survive_an_identity_mint(profile_dir):
    (profile_dir / "profile.yaml").write_text("future_key: kept\n")
    assign_profile_identity(profile_dir)
    assert _yaml(profile_dir)["future_key"] == "kept"
