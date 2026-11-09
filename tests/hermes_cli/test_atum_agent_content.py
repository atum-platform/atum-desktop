"""Two isolated Hermes homes stand in for two Macs sharing one agent (G1-09).

The "source Mac" exports its skills as the account's content-addressed bundles,
is then deleted, and the "second Mac" materializes them from those bundles
alone.  Every case runs the real filesystem, the real bundled-skill seeding and
the real writer lock; nothing here reaches a network or a real profile.
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from hermes_cli import atum_agent_content as content
from hermes_cli.atum_agent_content import AgentContentError, apply_memory, check_skills, install_skills, read_memory
from tools.memory_tool import ENTRY_DELIMITER, MemoryStore
from hermes_cli.atum_portability import _skill_tree_hash
from hermes_cli.atum_skill_bundles import (
    PublicationUnsupported,
    _hash_entries,
    export_skill_bundle,
    rename_no_replace,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def _write_skill(directory: Path, name: str, body: str = "Do the thing.\n", extra: dict | None = None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {name} skill.\n---\n{body}", encoding="utf-8")
    for relative, raw in (extra or {}).items():
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    return directory


def _bundle(files: dict[str, bytes]) -> dict:
    """A bundle straight from bytes, for contents no local tree could export."""
    entries = sorted(files.items(), key=lambda item: item[0].encode("utf-8"))
    return {
        "schema_version": 1,
        "sha256": _hash_entries(entries),
        "files": [{"path": path, "content_base64": base64.b64encode(raw).decode("ascii")} for path, raw in entries],
    }


def _ref(name: str, bundle: dict) -> dict:
    return {"name": name, "sha256": bundle["sha256"]}


def _states(result: dict) -> dict[str, tuple[str, str | None]]:
    assert result["ok"] is True
    return {row["name"]: (row["state"], row.get("detail")) for row in result["skills"]}


@pytest.fixture
def bundled(tmp_path, monkeypatch):
    """What this Mac ships: two skills, one under a category, as the repo's skills/ is."""
    root = tmp_path / "shipped-skills"
    _write_skill(root / "productivity" / "notes", "notes", "Current shipped notes.\n")
    _write_skill(root / "research" / "arxiv", "arxiv", "Current shipped arxiv.\n")
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(root))
    return root


def _mac(tmp_path: Path, label: str) -> Path:
    """A dedicated agent home with the files content sync must never touch."""
    home = tmp_path / label / "home"
    (home / "cron").mkdir(parents=True)
    (home / "config.yaml").write_text("model:\n  provider: my-own\n  default: local-model\n", encoding="utf-8")
    (home / "cron" / "jobs.json").write_text('{"jobs":[{"id":"j1","enabled":false}]}', encoding="utf-8")
    (home / ".env").write_text("OWN_PROVIDER_KEY=not-a-real-key\n", encoding="utf-8")
    (home / "auth.json").write_text('{"credential":"local-only"}', encoding="utf-8")
    (home / "SOUL.md").write_text("Local persona.\n", encoding="utf-8")
    return home


def _seed_bundled(home: Path, bundled_root: Path) -> None:
    """Hermes's own first-start seeding of what this Mac ships."""
    from tools.skills_sync import add_bundled_skill

    for name in ("notes", "arxiv"):
        assert add_bundled_skill(name, home=home)["action"] in {"added", "already_present"}


def _untouched(home: Path) -> dict[str, bytes]:
    return {name: (home / name).read_bytes() for name in ("config.yaml", "cron/jobs.json", ".env", "auth.json", "SOUL.md")}


def _memories(home: Path, memory: list[str], user: list[str]) -> None:
    directory = home / "memories"
    directory.mkdir(exist_ok=True)
    (directory / "MEMORY.md").write_text(ENTRY_DELIMITER.join(memory), encoding="utf-8")
    (directory / "USER.md").write_text(ENTRY_DELIMITER.join(user), encoding="utf-8")


def _source_mac(tmp_path: Path, bundled_root: Path) -> tuple[list[dict], dict[str, dict]]:
    """The Mac the agent was imported on: shipped skills plus its own, one at an older shipped version."""
    source = _mac(tmp_path, "source")
    skills = source / "skills"
    shutil.copytree(bundled_root / "research" / "arxiv", skills / "research" / "arxiv")
    _write_skill(skills / "productivity" / "notes", "notes", "An older shipped notes.\n")
    _write_skill(skills / "writing" / "brief", "brief", "Write briefs.\n", {"templates/brief.md": b"# Brief\n"})
    _write_skill(skills / "tiếng-việt" / "ghi-chú", "ghi-chu", "Ghi chú.\n", {"tài-liệu/ảnh.bin": b"\x00\xff\x10binary"})
    _write_skill(skills / "ops" / "deploy", "deploy", "Deploy.\n", {"scripts/run.sh": b"#!/bin/sh\necho ok\n"})
    cloud: dict[str, dict] = {}
    references = []
    for name in ("productivity/notes", "research/arxiv", "writing/brief", "tiếng-việt/ghi-chú", "ops/deploy"):
        bundle = export_skill_bundle(skills.joinpath(*name.split("/")))
        cloud[bundle["sha256"]] = bundle
        references.append(_ref(name, bundle))
    # The source computer goes offline for good: only the account's bytes remain.
    shutil.rmtree(source.parent)
    return references, cloud


def test_second_mac_installs_missing_skills_from_the_account_with_the_source_offline(tmp_path, bundled):
    references, cloud = _source_mac(tmp_path, bundled)
    target = _mac(tmp_path, "second")
    _seed_bundled(target, bundled)
    before = _untouched(target)

    checked = _states(check_skills(target, references))
    assert checked == {
        "productivity/notes": ("bundled_version", None),
        "research/arxiv": ("bundled", None),
        "writing/brief": ("missing", None),
        "tiếng-việt/ghi-chú": ("missing", None),
        "ops/deploy": ("missing", None),
    }

    result = install_skills(target, references, list(cloud.values()))
    assert _states(result) == {**checked, "writing/brief": ("installed", "new"),
                               "tiếng-việt/ghi-chú": ("installed", "new"), "ops/deploy": ("installed", "new")}
    for reference in references[2:]:
        installed = target / "skills" / Path(*reference["name"].split("/"))
        assert _skill_tree_hash(installed) == reference["sha256"]
    # This Mac's shipped version is kept, never replaced by the source Mac's older copy.
    assert "Current shipped notes." in (target / "skills" / "productivity" / "notes" / "SKILL.md").read_text()
    assert _untouched(target) == before
    assert not list((target / ".atum-agent-content" / "stage").iterdir())
    receipt = json.loads((target / ".atum-agent-content" / "skills.json").read_text())
    assert receipt == {"schema_version": 1, "skills": {r["name"]: r["sha256"] for r in references[2:]}}
    assert (target / ".atum-agent-content" / "skills.json").stat().st_mode & 0o777 == 0o600

    # Idempotent: a second pass installs nothing and reports the same truth.
    again = install_skills(target, references, list(cloud.values()))
    assert {name: state for name, (state, _) in _states(again).items()} == {
        "productivity/notes": "bundled_version", "research/arxiv": "bundled",
        "writing/brief": "installed", "tiếng-việt/ghi-chú": "installed", "ops/deploy": "installed",
    }
    assert all(detail is None for _, detail in _states(again).values())


def test_hermes_first_start_seeding_after_materialization_keeps_both(tmp_path, bundled):
    references, cloud = _source_mac(tmp_path, bundled)
    fresh = _mac(tmp_path, "fresh")  # set up before Hermes ever ran in this home

    result = _states(install_skills(fresh, references, list(cloud.values())))
    assert result["research/arxiv"] == ("bundled", None)
    assert result["productivity/notes"] == ("bundled_version", None)
    assert not (fresh / "skills" / "productivity" / "notes").exists()  # the seeding owns it
    _seed_bundled(fresh, bundled)
    assert "Current shipped notes." in (fresh / "skills" / "productivity" / "notes" / "SKILL.md").read_text()
    assert _states(check_skills(fresh, references))["writing/brief"] == ("installed", None)


def test_a_skill_the_mac_ships_under_another_path_is_a_collision_not_a_second_copy(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    _seed_bundled(target, bundled)
    moved = _bundle({"SKILL.md": b"---\nname: notes\n---\nThe notes skill before upstream moved it.\n"})
    local_twin = _bundle({"SKILL.md": b"---\nname: brief\n---\nAnother brief.\n"})
    _write_skill(target / "skills" / "mine" / "brief", "brief", "My own brief.\n")
    references = [_ref("old-category/notes", moved), _ref("theirs/brief", local_twin)]

    assert _states(check_skills(target, references)) == {
        "old-category/notes": ("missing", None), "theirs/brief": ("missing", None)}
    result = _states(install_skills(target, references, [moved, local_twin]))
    assert result == {"old-category/notes": ("collision", "bundled"), "theirs/brief": ("collision", "local")}
    assert not (target / "skills" / "old-category").exists()
    assert not (target / "skills" / "theirs").exists()


def test_local_edits_and_account_changes_are_reported_and_never_replaced(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    first = _bundle({"SKILL.md": b"---\nname: brief\n---\nVersion one.\n"})
    reference = _ref("writing/brief", first)
    assert _states(install_skills(target, [reference], [first]))["writing/brief"] == ("installed", "new")
    skill = target / "skills" / "writing" / "brief" / "SKILL.md"

    skill.write_bytes(b"---\nname: brief\n---\nEdited on this Mac.\n")
    assert _states(check_skills(target, [reference]))["writing/brief"] == ("different", "local_edit")

    skill.write_bytes(b"---\nname: brief\n---\nVersion one.\n")
    second = _bundle({"SKILL.md": b"---\nname: brief\n---\nVersion two, from the other Mac.\n"})
    changed = _ref("writing/brief", second)
    assert _states(install_skills(target, [changed], [second]))["writing/brief"] == ("different", "account_changed")
    assert skill.read_bytes() == b"---\nname: brief\n---\nVersion one.\n"


def test_a_skill_removed_or_archived_here_stays_removed(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    removed = _bundle({"SKILL.md": b"---\nname: gone\n---\nRemove me.\n"})
    archived = _bundle({"SKILL.md": b"---\nname: shelved\n---\nArchive me.\n"})
    references = [_ref("tools/gone", removed), _ref("tools/shelved", archived)]
    install_skills(target, references, [removed, archived])

    shutil.rmtree(target / "skills" / "tools" / "gone")
    (target / "skills" / ".archive").mkdir()
    # The curator's archive layout: flat, by the skill directory's own name.
    (target / "skills" / "tools" / "shelved").rename(target / "skills" / ".archive" / "shelved")
    # Even with the receipt lost, an archived copy of the same bytes is a removal.
    receipt = target / ".atum-agent-content" / "skills.json"
    kept = json.loads(receipt.read_text())
    receipt.write_text(json.dumps({"schema_version": 1, "skills": {"tools/gone": kept["skills"]["tools/gone"]}}))

    result = _states(install_skills(target, references, [removed, archived]))
    assert result == {"tools/gone": ("suppressed", "removed"), "tools/shelved": ("suppressed", "archived")}
    assert not (target / "skills" / "tools" / "gone").exists()
    assert not (target / "skills" / "tools" / "shelved").exists()


def test_the_curators_real_archive_is_respected(tmp_path, bundled, monkeypatch):
    target = _mac(tmp_path, "second")
    bundle = _bundle({"SKILL.md": b"---\nname: shelved\n---\nArchive me.\n"})
    reference = _ref("tools/shelved", bundle)
    install_skills(target, [reference], [bundle])
    monkeypatch.setenv("HERMES_HOME", str(target))
    from tools.skill_usage import archive_skill

    ok, _message = archive_skill("shelved")
    assert ok
    assert _states(install_skills(target, [reference], [bundle]))["tools/shelved"] == ("suppressed", "removed")


def test_a_crash_between_publication_and_receipt_adopts_the_exact_bytes(tmp_path, bundled, monkeypatch):
    target = _mac(tmp_path, "second")
    bundle = _bundle({"SKILL.md": b"---\nname: brief\n---\nBrief.\n"})
    reference = _ref("writing/brief", bundle)
    real = content._write_receipt

    def crash(home, skills):
        raise OSError("power lost after the rename")

    monkeypatch.setattr(content, "_write_receipt", crash)
    with pytest.raises(OSError):
        install_skills(target, [reference], [bundle])
    assert (target / "skills" / "writing" / "brief" / "SKILL.md").exists()

    monkeypatch.setattr(content, "_write_receipt", real)
    assert _states(check_skills(target, [reference]))["writing/brief"] == ("installed", None)
    shutil.rmtree(target / "skills" / "writing" / "brief")
    # Adopted on that check, so its removal now sticks.
    assert _states(install_skills(target, [reference], [bundle]))["writing/brief"] == ("suppressed", "removed")


def test_a_crash_while_staging_leaves_nothing_visible_and_is_cleared(tmp_path, bundled):
    from agent.skill_utils import iter_skill_index_files

    target = _mac(tmp_path, "second")
    leftover = target / ".atum-agent-content" / "stage" / "skill-crashed" / "skill"
    _write_skill(leftover, "half", "Half written.\n")
    (target / "skills").mkdir()
    assert list(iter_skill_index_files(target / "skills", "SKILL.md")) == []

    bundle = _bundle({"SKILL.md": b"---\nname: brief\n---\nBrief.\n"})
    assert _states(install_skills(target, [_ref("writing/brief", bundle)], [bundle]))["writing/brief"] == ("installed", "new")
    assert not list((target / ".atum-agent-content" / "stage").iterdir())
    assert [p.parent.name for p in iter_skill_index_files(target / "skills", "SKILL.md")] == ["brief"]


def test_publication_never_replaces_an_existing_directory_even_an_empty_one(tmp_path, bundled, monkeypatch):
    source, empty = tmp_path / "staged", tmp_path / "empty"
    source.mkdir()
    (source / "SKILL.md").write_text("x")
    empty.mkdir()
    with pytest.raises(FileExistsError):
        rename_no_replace(source, empty)
    assert list(empty.iterdir()) == [] and (source / "SKILL.md").exists()

    target = _mac(tmp_path, "second")
    bundle = _bundle({"SKILL.md": b"---\nname: brief\n---\nBrief.\n"})
    reference = _ref("writing/brief", bundle)
    (target / "skills" / "writing" / "brief").mkdir(parents=True)  # someone's empty directory
    assert _states(install_skills(target, [reference], [bundle]))["writing/brief"] == ("different", "local_edit")
    assert list((target / "skills" / "writing" / "brief").iterdir()) == []

    # A writer that lands between our last check and the rename keeps its bytes.
    shutil.rmtree(target / "skills" / "writing" / "brief")
    real = content.rename_no_replace

    def racing(staged, destination):
        _write_skill(destination, "brief", "The racing writer's brief.\n")
        real(staged, destination)

    monkeypatch.setattr(content, "rename_no_replace", racing)
    assert _states(install_skills(target, [reference], [bundle]))["writing/brief"] == ("different", "local_edit")
    assert "racing writer" in (target / "skills" / "writing" / "brief" / "SKILL.md").read_text()


def test_a_filesystem_without_exclusive_rename_refuses_rather_than_replaces(tmp_path, bundled, monkeypatch):
    target = _mac(tmp_path, "second")
    bundle = _bundle({"SKILL.md": b"---\nname: brief\n---\nBrief.\n"})

    def unsupported(staged, destination):
        raise PublicationUnsupported(45, "not supported", str(destination))

    monkeypatch.setattr(content, "rename_no_replace", unsupported)
    result = _states(install_skills(target, [_ref("writing/brief", bundle)], [bundle]))
    assert result["writing/brief"] == ("unsupported", "filesystem")
    assert not (target / "skills" / "writing" / "brief").exists()


def test_two_installers_racing_on_one_home_publish_each_skill_once(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    bundles = [_bundle({"SKILL.md": f"---\nname: s{i}\n---\nSkill {i}.\n".encode(), "data.bin": os.urandom(4096)})
               for i in range(8)]
    references = [_ref(f"batch/s{i}", bundle) for i, bundle in enumerate(bundles)]
    request = json.dumps({"skills": references, "bundles": bundles}).encode()
    env = {**os.environ, "PYTHONPATH": str(REPO_ROOT)}
    processes = [
        subprocess.Popen([sys.executable, "-B", "-m", "hermes_cli.atum_agent_content", "skills-install", "--home", str(target)],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=REPO_ROOT, env=env)
        for _ in range(2)
    ]
    outputs = [json.loads(process.communicate(request, timeout=120)[0]) for process in processes]

    fresh = [row["name"] for output in outputs for row in output["skills"] if row.get("detail") == "new"]
    assert sorted(fresh) == sorted(r["name"] for r in references)  # exactly one publisher per skill
    assert all(row["state"] == "installed" for output in outputs for row in output["skills"])
    for reference in references:
        assert _skill_tree_hash(target / "skills" / "batch" / reference["name"].split("/")[1]) == reference["sha256"]


def test_the_writer_lock_is_the_bundled_seedings_own(tmp_path, bundled):
    from tools.skills_sync import _bundled_skills_write_lock

    target = _mac(tmp_path, "second")
    bundle = _bundle({"SKILL.md": b"---\nname: brief\n---\nBrief.\n"})
    released = threading.Event()
    held = threading.Event()

    def seeding():
        with _bundled_skills_write_lock(target, target / "skills"):
            held.set()
            time.sleep(0.6)
            released.set()

    thread = threading.Thread(target=seeding)
    thread.start()
    held.wait(5)
    result = install_skills(target, [_ref("writing/brief", bundle)], [bundle])
    assert released.is_set()  # waited for the seeding to finish
    assert _states(result)["writing/brief"] == ("installed", "new")
    thread.join()


def test_an_unsupported_bundle_is_refused_whole_and_the_others_still_install(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    good = _bundle({"SKILL.md": b"---\nname: good\n---\nGood.\n"})
    secret = _bundle({"SKILL.md": b"---\nname: leaky\n---\nx\n", ".env": b"TOKEN=1\n"})
    # Claims a digest its files do not have.
    mismatched = {**_bundle({"SKILL.md": b"---\nname: m\n---\nm\n"}), "sha256": "0" * 64}
    mismatched_ref = {"name": "bad/mismatched", "sha256": "0" * 64}
    noncanonical = _bundle({"SKILL.md": b"---\nname: n\n---\nn\n"})
    noncanonical["files"][0]["content_base64"] += "\n"
    file_and_folder = _bundle({"SKILL.md": b"---\nname: ff\n---\nff\n", "a": b"file", "a/b": b"nested"})
    references = [_ref("ok/good", good), _ref("bad/leaky", secret), mismatched_ref,
                  _ref("bad/noncanonical", noncanonical), _ref("bad/file-and-folder", file_and_folder)]

    result = _states(install_skills(target, references, [good, secret, mismatched, noncanonical, file_and_folder]))
    assert result == {
        "ok/good": ("installed", "new"),
        "bad/leaky": ("unsupported", "bundle"),
        "bad/mismatched": ("unsupported", "bundle"),
        "bad/noncanonical": ("unsupported", "bundle"),
        "bad/file-and-folder": ("unsupported", "filesystem"),
    }
    assert not (target / "skills" / "bad").exists()  # nothing stripped and half-installed


def test_non_ascii_paths_at_the_byte_limits_and_the_size_caps(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    # 300 UTF-8 bytes exactly (104 characters), in two components each within a 255-byte file name.
    file_at_limit = f"{'ả' * 50}/{'ệ' * 48}xy.md"
    assert len(file_at_limit.encode()) == 300 and len(file_at_limit) == 104
    at_limit = _bundle({"SKILL.md": b"---\nname: limit\n---\nx\n", file_at_limit: b"at the limit"})
    over_limit = _bundle({"SKILL.md": b"---\nname: over\n---\nx\n", file_at_limit + "y": b"over"})
    # Within the 300-byte contract, but a file name longer than the filesystem allows (APFS:
    # 255 characters; ext4: 255 bytes).
    long_name = _bundle({"SKILL.md": b"---\nname: long\n---\nx\n", "n" * 256: b"256-character name"})
    # The 2 MiB raw cap exactly, and one byte over.  The largest bundle's JSON stays within 3 MiB.
    big_md, bigger_md = b"---\nname: big\n---\nx\n", b"---\nname: bigger\n---\nx\n"
    raw_limit = _bundle({"SKILL.md": big_md, "data.bin": b"\0" * (2 * 1024 * 1024 - len(big_md))})
    raw_over = _bundle({"SKILL.md": bigger_md, "data.bin": b"\0" * (2 * 1024 * 1024 - len(bigger_md) + 1)})
    assert sum(len(base64.b64decode(f["content_base64"])) for f in raw_limit["files"]) == 2 * 1024 * 1024
    assert len(json.dumps(raw_limit, ensure_ascii=False, separators=(",", ":")).encode()) <= 3 * 1024 * 1024
    references = [_ref("tiếng-việt/giới-hạn", at_limit), _ref("tiếng-việt/quá", over_limit),
                  _ref("tiếng-việt/dài", long_name), _ref("big/limit", raw_limit), _ref("big/over", raw_over)]

    result = _states(install_skills(target, references, [at_limit, over_limit, long_name, raw_limit, raw_over]))
    assert result["tiếng-việt/giới-hạn"] == ("installed", "new")
    assert result["tiếng-việt/quá"] == ("unsupported", "bundle")
    assert result["tiếng-việt/dài"] == ("unsupported", "filesystem")
    assert result["big/limit"] == ("installed", "new")
    assert result["big/over"] == ("unsupported", "bundle")
    assert (target / "skills" / "tiếng-việt" / "giới-hạn" / Path(file_at_limit)).read_bytes() == b"at the limit"


def test_a_corrupt_receipt_or_skill_does_not_block_recovery(tmp_path, bundled):
    first, second = _mac(tmp_path, "agent-one"), _mac(tmp_path, "agent-two")
    one = _bundle({"SKILL.md": b"---\nname: one\n---\n1\n"})
    two = _bundle({"SKILL.md": b"---\nname: two\n---\n2\n"})
    references = [_ref("a/one", one), _ref("a/two", two)]
    install_skills(first, references, [one, two])

    (first / ".atum-agent-content" / "skills.json").write_bytes(b"\x00{not json")
    os.symlink(first / "config.yaml", first / "skills" / "a" / "one" / "linked.yaml")
    result = check_skills(first, references)
    assert result["receipt"] == "reset"
    assert _states(result) == {"a/one": ("different", "unreadable"), "a/two": ("installed", None)}
    assert list((first / ".atum-agent-content").glob("skills.json.corrupt-*"))

    # Another agent's home recovers regardless.
    assert _states(install_skills(second, references, [one, two])) == {
        "a/one": ("installed", "new"), "a/two": ("installed", "new")}


def test_paths_that_would_change_another_tree_are_blocked(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    _seed_bundled(target, bundled)
    _write_skill(target / "skills" / "writing" / "brief", "brief")
    (target / "skills" / "flat").write_text("a file, not a folder")
    (target / "outside").mkdir()
    os.symlink(target / "outside", target / "skills" / "linked")
    bundle = _bundle({"SKILL.md": b"---\nname: nested\n---\nx\n"})
    references = [
        {"name": "writing/brief/nested", "sha256": bundle["sha256"]},
        {"name": "flat/nested", "sha256": bundle["sha256"]},
        {"name": "linked/nested", "sha256": bundle["sha256"]},
        {"name": "productivity", "sha256": bundle["sha256"]},
        {"name": "research/arxiv/extra", "sha256": bundle["sha256"]},
    ]
    assert _states(install_skills(target, references, [bundle])) == {
        "writing/brief/nested": ("blocked", "inside_skill"),
        "flat/nested": ("blocked", "not_a_directory"),
        "linked/nested": ("blocked", "symlink"),
        "productivity": ("blocked", "bundled"),
        "research/arxiv/extra": ("blocked", "bundled"),
    }
    assert list((target / "outside").iterdir()) == []


def test_names_hermes_reserves_are_refused_per_skill_and_malformed_requests_whole(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    good = _bundle({"SKILL.md": b"---\nname: good\n---\nx\n"})
    references = [{"name": name, "sha256": good["sha256"]}
                  for name in (".archive/x", "tools/.hub", "deps/node_modules/x", "win/con", "bad:name", "ok/good")]
    result = _states(install_skills(target, references, [good]))
    assert result.pop("ok/good") == ("installed", "new")
    assert set(result.values()) == {("unsupported", "name")}

    for malformed in ([{"name": "a", "sha256": "A" * 64}], [{"name": "a", "sha256": good["sha256"]}] * 2,
                      [{"name": "a"}], "not a list", [{"name": "a", "sha256": good["sha256"]}] * 513):
        with pytest.raises(AgentContentError, match="agent_content_invalid"):
            check_skills(target, malformed)
    with pytest.raises(AgentContentError, match="agent_content_home"):
        check_skills(tmp_path / "no-such-home", [])


def test_shipped_skills_turned_off_here_stay_off(tmp_path, bundled):
    from tools.skills_sync import _read_manifest

    notes = export_skill_bundle(bundled / "productivity" / "notes")
    arxiv = export_skill_bundle(bundled / "research" / "arxiv")
    references = [_ref("productivity/notes", notes), _ref("research/arxiv", arxiv)]

    opted_out = _mac(tmp_path, "opted-out")
    (opted_out / ".no-bundled-skills").write_text("")
    assert set(_states(check_skills(opted_out, references)).values()) == {("suppressed", "bundled_opt_out")}

    pruned = _mac(tmp_path, "pruned")
    _seed_bundled(pruned, bundled)
    shutil.rmtree(pruned / "skills" / "research" / "arxiv")
    (pruned / "skills" / ".curator_suppressed").write_text("notes\n")
    assert "arxiv" in _read_manifest(pruned / "skills" / ".bundled_manifest")
    result = _states(install_skills(pruned, references, [notes, arxiv]))
    assert result == {"productivity/notes": ("suppressed", "bundled_suppressed"),
                      "research/arxiv": ("suppressed", "bundled_removed")}
    assert not (pruned / "skills" / "research" / "arxiv").exists()


def _cli(home: Path, operation: str, stdin: bytes) -> tuple[int, dict]:
    completed = subprocess.run(
        [sys.executable, "-B", "-m", "hermes_cli.atum_agent_content", operation, "--home", str(home)],
        input=stdin, capture_output=True, cwd=REPO_ROOT, env={**os.environ, "PYTHONPATH": str(REPO_ROOT)}, timeout=120,
    )
    return completed.returncode, json.loads(completed.stdout)


def test_memory_receipt_advances_only_after_a_full_cas_apply(tmp_path, bundled):
    target = _mac(tmp_path, "memory")
    _memories(target, ["Original", "[local] Only on this Mac"], ["Owner one"])
    before = _untouched(target)

    assert not (target / ".atum-agent-content").exists()
    first = read_memory(target)
    assert first == {"ok": True, "snapshot": {"memory": ["Original"], "user": ["Owner one"]}, "receipt": None}
    assert not (target / ".atum-agent-content").exists()

    accepted = {"memory": ["From the other Mac"], "user": ["Owner one", "Owner two"]}
    result = apply_memory(target, {
        "expected_snapshot": first["snapshot"], "snapshot": accepted, "revision": 4,
    })
    assert result["result"]["success"] is True
    assert read_memory(target) == {
        "ok": True,
        "snapshot": accepted,
        "receipt": {"revision": 4, "snapshot": accepted},
    }
    assert MemoryStore._read_file(target / "memories" / "MEMORY.md") == [
        "[local] Only on this Mac", "From the other Mac",
    ]
    assert _untouched(target) == before
    receipt = target / ".atum-agent-content" / "memory.json"
    assert receipt.stat().st_mode & 0o777 == 0o600

    # A local edit after that base makes the stale apply a conflict. It changes neither
    # memory nor the last accepted base, so the caller cannot silently win the race.
    _memories(target, ["Edited here", "[local] Only on this Mac"], accepted["user"])
    refused = apply_memory(target, {
        "expected_snapshot": accepted,
        "snapshot": {"memory": ["Cloud edit"], "user": accepted["user"]},
        "revision": 5,
    })
    assert refused["result"]["success"] is False
    assert read_memory(target)["receipt"] == {"revision": 4, "snapshot": accepted}
    assert MemoryStore._read_file(target / "memories" / "MEMORY.md") == [
        "Edited here", "[local] Only on this Mac",
    ]


def test_corrupt_memory_receipt_becomes_no_base_instead_of_overwrite_authority(tmp_path, bundled):
    target = _mac(tmp_path, "memory-corrupt")
    _memories(target, ["Keep me"], [])
    directory = target / ".atum-agent-content"
    directory.mkdir()
    (directory / "memory.json").write_text("{torn", encoding="utf-8")

    result = read_memory(target)
    assert result["snapshot"] == {"memory": ["Keep me"], "user": []}
    assert result["receipt"] is None
    assert list(directory.glob("memory.json.corrupt-*"))


def test_the_cli_speaks_json_over_stdin_and_never_echoes_content(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    bundle = _bundle({"SKILL.md": b"---\nname: secretive\n---\nSECRET-PERSONA-TEXT\n"})
    reference = _ref("writing/secretive", bundle)

    code, output = _cli(target, "skills-check", json.dumps({"skills": [reference]}).encode())
    assert code == 0 and _states(output) == {"writing/secretive": ("missing", None)}
    code, output = _cli(target, "skills-install", json.dumps({"skills": [reference], "bundles": [bundle]}).encode())
    assert code == 0 and _states(output) == {"writing/secretive": ("installed", "new")}

    _memories(target, ["Portable memory"], [])
    code, output = _cli(target, "memory-read", b"{}")
    assert code == 0 and output["snapshot"] == {"memory": ["Portable memory"], "user": []}
    code, output = _cli(target, "memory-apply", json.dumps({
        "expected_snapshot": output["snapshot"],
        "snapshot": {"memory": ["Accepted memory"], "user": []},
        "revision": 1,
    }).encode())
    assert code == 0 and output["result"]["success"] is True

    for operation, stdin in (("skills-check", b"{not json SECRET-PERSONA-TEXT"),
                             ("skills-check", json.dumps({"skills": [reference], "extra": 1}).encode()),
                             ("skills-install", json.dumps({"skills": [reference], "bundles": [{"sha256": "SECRET"}]}).encode()),
                             ("memory-read", b'{"extra":"SECRET-PERSONA-TEXT"}'),
                             ("memory-apply", b'{"snapshot":"SECRET-PERSONA-TEXT"}')):
        code, output = _cli(target, operation, stdin)
        assert code == 1 and output == {"ok": False, "error": "agent_content_invalid"}
    code, output = _cli(tmp_path / "missing-home", "skills-check", b'{"skills": []}')
    assert code == 1 and output == {"ok": False, "error": "agent_content_home"}


def test_two_cloud_skills_sharing_a_name_install_once_and_external_names_are_taken(tmp_path, bundled):
    target = _mac(tmp_path, "second")
    external = tmp_path / "external-skills"
    _write_skill(external / "ext", "ext-skill", "From an external directory.\n")
    (target / "config.yaml").write_text(f"skills:\n  external_dirs:\n    - {external}\n", encoding="utf-8")
    first = _bundle({"SKILL.md": b"---\nname: shared\n---\nOne.\n"})
    second = _bundle({"SKILL.md": b"---\nname: shared\n---\nTwo.\n"})
    shadow = _bundle({"SKILL.md": b"---\nname: ext-skill\n---\nA local shadow.\n"})
    references = [_ref("a/shared-one", first), _ref("b/shared-two", second), _ref("c/ext", shadow)]

    assert _states(install_skills(target, references, [first, second, shadow])) == {
        "a/shared-one": ("installed", "new"),
        "b/shared-two": ("collision", "local"),
        "c/ext": ("collision", "external"),
    }
    assert not (target / "skills" / "b").exists() and not (target / "skills" / "c").exists()


def test_a_link_or_unreadable_copy_at_a_shipped_path_is_reported_as_it_is(tmp_path, bundled):
    notes = export_skill_bundle(bundled / "productivity" / "notes")
    arxiv = export_skill_bundle(bundled / "research" / "arxiv")
    references = [_ref("productivity/notes", notes), _ref("research/arxiv", arxiv)]
    target = _mac(tmp_path, "second")
    _seed_bundled(target, bundled)
    shutil.rmtree(target / "skills" / "productivity" / "notes")
    os.symlink(bundled / "productivity" / "notes", target / "skills" / "productivity" / "notes")
    os.symlink(target / "config.yaml", target / "skills" / "research" / "arxiv" / "linked.yaml")

    assert _states(check_skills(target, references)) == {
        "productivity/notes": ("different", "not_a_skill"),
        "research/arxiv": ("different", "unreadable"),
    }


def test_request_and_home_limits_refuse_the_call(tmp_path, bundled, monkeypatch):
    target = _mac(tmp_path, "second")
    good = _bundle({"SKILL.md": b"---\nname: good\n---\nx\n"})
    with pytest.raises(AgentContentError, match="agent_content_invalid"):
        install_skills(target, [_ref("a/good", good)], [good] * 513)

    (target / "skills").write_text("a file where the skills folder belongs")
    with pytest.raises(AgentContentError, match="agent_content_home"):
        check_skills(target, [])
    (target / "skills").unlink()
    os.symlink(tmp_path, target / "skills")
    with pytest.raises(AgentContentError, match="agent_content_home"):
        check_skills(target, [])
    (target / "skills").unlink()
    os.symlink(target, tmp_path / "linked-home")
    with pytest.raises(AgentContentError, match="agent_content_home"):
        check_skills(tmp_path / "linked-home", [])

    # A receipt that can neither be read nor set aside refuses this agent's call only.
    content_dir = target / ".atum-agent-content"
    content_dir.mkdir()
    (content_dir / "skills.json").write_text("{torn")
    content_dir.chmod(0o500)
    try:
        with pytest.raises(AgentContentError, match="agent_content_receipt"):
            check_skills(target, [])
    finally:
        content_dir.chmod(0o700)


def test_the_cli_refuses_input_over_its_cap(tmp_path, bundled, monkeypatch, capsys):
    import io

    target = _mac(tmp_path, "second")
    monkeypatch.setattr(content, "MAX_INPUT_BYTES", 32)

    class Stdin:
        buffer = io.BytesIO(b'{"skills": []}' + b" " * 64)

    monkeypatch.setattr(sys, "stdin", Stdin())
    assert content.main(["skills-check", "--home", str(target)]) == 1
    assert json.loads(capsys.readouterr().out) == {"ok": False, "error": "agent_content_invalid"}
