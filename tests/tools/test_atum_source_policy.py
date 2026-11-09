import importlib.util
import os
import json
from pathlib import Path

import pytest

from tools import atum_chats_tool, atum_google_tool
from tools.atum_source_policy import POLICY_ENV, source_enabled


def test_source_policy_defaults_on_outside_atum_desktop(monkeypatch):
    monkeypatch.delenv(POLICY_ENV, raising=False)

    assert source_enabled("folders") is True
    assert source_enabled("not-a-source") is False


def test_source_policy_rechecks_atomic_file_every_call(tmp_path, monkeypatch):
    policy = tmp_path / "policy.json"
    enabled = {
        "version": 1,
        "google": True,
        "folders": True,
        "messages": True,
        "browser": True,
        "location": True,
        "team_spaces": True,
    }
    policy.write_text(json.dumps(enabled), encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))

    assert source_enabled("google") is True
    policy.write_text(json.dumps({**enabled, "google": False}), encoding="utf-8")
    assert source_enabled("google") is False


def test_descriptor_gate_can_be_added_as_data_without_a_python_source_enum(tmp_path, monkeypatch):
    policy = tmp_path / "policy.json"
    enabled = {
        "version": 1,
        "google": True,
        "folders": True,
        "messages": True,
        "browser": True,
        "location": True,
        "team_spaces": True,
        "future_gate": True,
    }
    policy.write_text(json.dumps(enabled), encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))

    assert source_enabled("future_gate") is True


def test_desktop_policy_fails_closed_when_missing_or_malformed(tmp_path, monkeypatch):
    policy = tmp_path / "policy.json"
    monkeypatch.setenv(POLICY_ENV, str(policy))
    assert source_enabled("folders") is False

    policy.write_text('{"version":1,"folders":true}', encoding="utf-8")
    assert source_enabled("folders") is False


def test_source_handlers_stop_before_any_read_when_switched_off(tmp_path, monkeypatch):
    policy = tmp_path / "policy.json"
    policy.write_text(
        json.dumps({
            "version": 1,
            "google": False,
            "folders": False,
            "messages": True,
            "browser": True,
            "location": True,
            "team_spaces": False,
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv(POLICY_ENV, str(policy))

    # The folders gate is Hermes's native pre_tool_call seam (plugins/atum-filesystem-capability):
    # the block happens before dispatch, so read_file/search_files never run.
    plugin = Path(__file__).parents[2] / "plugins" / "atum-filesystem-capability" / "__init__.py"
    spec = importlib.util.spec_from_file_location("atum_filesystem_capability_policy", plugin)
    capability = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capability)
    for tool, args in (("read_file", {"path": "/never/read"}), ("search_files", {"pattern": "never"})):
        verdict = capability._on_pre_tool_call(tool_name=tool, args=args, tool_call_id="call-1")
        assert verdict["action"] == "block" and verdict["message"].startswith("SOURCE_DISABLED"), verdict
    assert json.loads(atum_chats_tool._handle_atum_chats({"op": "list"})) == {"error": "disabled"}
    assert json.loads(atum_google_tool.atum_google_readonly({"action": "status"})) == {"error": "disabled"}


def _folder_choices(tmp_path, monkeypatch, blocked):
    policy = tmp_path / "acct.json"
    policy.write_text("{}", encoding="utf-8")
    (tmp_path / "acct.folders.json").write_text(
        json.dumps({"version": 1, "blocked": blocked, "shared": []}), encoding="utf-8"
    )
    monkeypatch.setenv(POLICY_ENV, str(policy))


def test_closed_folder_refuses_paths_inside_a_folder_the_owner_kept_closed(tmp_path, monkeypatch):
    from tools.atum_source_policy import closed_folder

    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    _folder_choices(tmp_path, monkeypatch, [str(home / "Desktop")])

    assert closed_folder("~/Desktop") == "Desktop"
    assert closed_folder("~/desktop/notes/plan.md") == "Desktop"
    assert closed_folder(str(home / "Desktop" / ".." / "Desktop" / "a.txt")) == "Desktop"
    # A sibling whose name only starts with the closed folder's name stays open.
    assert closed_folder("~/Desktop Archive/a.txt") is None
    assert closed_folder("~/Documents/a.txt") is None


def test_closed_folder_names_icloud_drive_by_its_product_name(tmp_path, monkeypatch):
    from tools.atum_source_policy import closed_folder

    cloud = tmp_path / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    _folder_choices(tmp_path, monkeypatch, [str(cloud)])

    assert closed_folder(str(cloud / "Taxes")) == "iCloud Drive"


def test_without_atum_desktop_no_folder_is_managed(tmp_path, monkeypatch):
    """Plain Hermes, and Atum Desktop off macOS (which writes no folder choices)."""
    from tools.atum_source_policy import closed_folder, folder_refusal

    monkeypatch.delenv(POLICY_ENV, raising=False)
    assert closed_folder("~/Desktop") is None

    policy = tmp_path / "acct.json"
    policy.write_text("{}", encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))
    monkeypatch.setattr("sys.platform", "linux")
    assert folder_refusal("~/Desktop") is None


def test_missing_choices_on_a_mac_pause_every_read(tmp_path, monkeypatch):
    """Desktop writes the choices (all shared for a new account) before Hermes starts, so a
    missing file is lost state, not a new install: nothing reopens, not even an added folder."""
    from tools.atum_source_policy import folder_refusal

    policy = tmp_path / "acct.json"
    policy.write_text("{}", encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))
    monkeypatch.setattr("sys.platform", "darwin")
    for path in ("~/Desktop/a.txt", str(tmp_path / "Removed Client" / "a.txt"), str(tmp_path)):
        assert "couldn't read the owner's folder choices" in folder_refusal(path), path


@pytest.mark.parametrize("damage", ["not json", "{}", '{"version": 2, "blocked": []}',
                                    '{"version": 1, "blocked": "Desktop"}', '{"version": 1, "blocked": ["Desktop"]}',
                                    '{"version": 1, "blocked": [], "shared": [], "unavailable": true}'])
def test_damaged_or_unavailable_choices_pause_every_read(tmp_path, monkeypatch, damage):
    from tools.atum_source_policy import closed_folders_below, folder_refusal

    policy = tmp_path / "damaged.json"
    policy.write_text("{}", encoding="utf-8")
    (tmp_path / "damaged.folders.json").write_text(damage, encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))

    for path in ("~/Desktop/a.txt", str(tmp_path / "Projects" / "a.txt")):
        assert "couldn't read the owner's folder choices" in folder_refusal(path), path
    assert closed_folders_below(str(tmp_path)) == []  # the refusal above already covers searches


def test_choices_that_vanish_or_break_never_reopen_a_folder(tmp_path, monkeypatch):
    from tools.atum_source_policy import closed_folder, folder_refusal

    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr("sys.platform", "darwin")
    _folder_choices(tmp_path, monkeypatch, [str(home / "Documents")])
    choices = tmp_path / "acct.folders.json"
    assert closed_folder("~/Documents/tax.pdf") == "Documents"

    choices.unlink()
    assert "couldn't read" in folder_refusal("~/Documents/tax.pdf")
    choices.write_text("{broken", encoding="utf-8")
    assert "couldn't read" in folder_refusal("~/Desktop/a.txt")

    # Valid choices written again are honoured at once.
    choices.write_text(json.dumps({"version": 1, "blocked": [], "shared": []}), encoding="utf-8")
    assert folder_refusal("~/Documents/tax.pdf") is None


@pytest.fixture
def closed_desktop(tmp_path, monkeypatch):
    home = Path(os.path.realpath(tmp_path)) / "home"
    (home / "Desktop" / "notes").mkdir(parents=True)
    (home / "Desktop" / "notes" / "plan.md").write_text("secret", encoding="utf-8")
    (home / "Projects").mkdir()
    monkeypatch.setenv("HOME", str(home))
    _folder_choices(tmp_path, monkeypatch, [str(home / "Desktop")])
    return home


def test_a_symlink_into_a_closed_folder_is_refused(closed_desktop):
    from tools.atum_source_policy import closed_folder

    link = closed_desktop / "Projects" / "plan-link.md"
    link.symlink_to(closed_desktop / "Desktop" / "notes" / "plan.md")
    folder_link = closed_desktop / "Projects" / "desk"
    folder_link.symlink_to(closed_desktop / "Desktop")

    assert closed_folder(str(link)) == "Desktop"
    assert closed_folder(str(folder_link)) == "Desktop"
    # A symlink followed by ``..`` lands where the link points, not where the spelling suggests.
    (closed_desktop / "Desktop" / "notes" / "deep").mkdir()
    (closed_desktop / "Projects" / "deep-link").symlink_to(closed_desktop / "Desktop" / "notes" / "deep")
    assert closed_folder(str(closed_desktop / "Projects" / "deep-link" / ".." / "plan.md")) == "Desktop"


def test_relative_and_omitted_paths_resolve_against_the_task_cwd(closed_desktop, monkeypatch):
    from tools import terminal_tool
    from tools.atum_source_policy import closed_folder, folder_refusal

    monkeypatch.chdir(closed_desktop / "Projects")
    terminal_tool.register_task_env_overrides("task-desk", {"env_type": "local", "cwd": str(closed_desktop / "Desktop" / "notes")})
    try:
        assert closed_folder("plan.md", "task-desk") == "Desktop"
        assert closed_folder(None, "task-desk") == "Desktop"  # search_files with no path
        assert folder_refusal("", "task-desk").startswith("The owner kept their Desktop folder closed")
        # The same relative name from a task working elsewhere is open.
        assert closed_folder("plan.md", "task-other") is None
    finally:
        terminal_tool.clear_task_env_overrides("task-desk")


def test_case_and_system_aliases_of_a_closed_folder_are_refused(closed_desktop, tmp_path, monkeypatch):
    from tools.atum_source_policy import closed_folder

    assert closed_folder(str(closed_desktop / "DESKTOP" / "notes")) == "Desktop"

    # macOS spells temporary and system folders two ways (/var and /private/var): both are refused.
    real = os.path.realpath(closed_desktop)
    if real.startswith("/private/"):
        alias = real[len("/private"):]
        if os.path.exists(alias) and os.path.samefile(alias, real):
            assert closed_folder(os.path.join(alias, "Desktop", "notes", "plan.md")) == "Desktop"
            _folder_choices(tmp_path, monkeypatch, [os.path.join(alias, "Desktop")])
            assert closed_folder(os.path.join(real, "Desktop", "notes", "plan.md")) == "Desktop"


def test_a_finder_alias_is_refused_while_folders_are_closed(closed_desktop):
    from tools.atum_source_policy import folder_refusal

    alias = closed_desktop / "Projects" / "plan alias"
    alias.write_bytes(b"book\x00\x00\x00\x00mark\x00\x00\x00\x00" + b"\x00" * 32)
    assert "Finder alias" in folder_refusal(str(alias))
    assert folder_refusal(str(closed_desktop / "Projects")) is None


def test_a_path_that_cannot_be_resolved_is_refused(closed_desktop, monkeypatch):
    from tools import file_tools_paths
    from tools.atum_source_policy import folder_refusal

    def broken(*_args, **_kwargs):
        raise RuntimeError("symlink loop")

    monkeypatch.setattr(file_tools_paths, "_resolve_path_for_task", broken)
    assert "couldn't tell" in folder_refusal(str(closed_desktop / "Projects" / "x"))


def test_the_most_specific_folder_decides(tmp_path, monkeypatch):
    """An added folder inside a closed one is shared; a removed folder inside a shared one is closed."""
    from tools.atum_source_policy import closed_folder

    home = Path(os.path.realpath(tmp_path)) / "home"
    monkeypatch.setenv("HOME", str(home))
    policy = tmp_path / "acct.json"
    policy.write_text("{}", encoding="utf-8")
    (tmp_path / "acct.folders.json").write_text(json.dumps({
        "version": 1,
        "blocked": [str(home / "Desktop"), str(home / "Documents" / "Old Client")],
        "shared": [str(home / "Desktop" / "Shared Work"), str(home / "Documents")],
    }), encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))

    assert closed_folder(str(home / "Desktop" / "Shared Work" / "a.txt")) is None
    assert closed_folder(str(home / "Desktop" / "Private" / "a.txt")) == "Desktop"
    assert closed_folder(str(home / "Documents" / "Old Client" / "a.txt")) == "Old Client"
    assert closed_folder(str(home / "Documents" / "a.txt")) is None


def test_unicode_spellings_of_a_closed_folder_are_refused(tmp_path, monkeypatch):
    """APFS treats NFC and NFD spellings of a name as one file."""
    import unicodedata

    from tools.atum_source_policy import closed_folder

    root = Path(os.path.realpath(tmp_path))
    nfc = unicodedata.normalize("NFC", "Café")
    nfd = unicodedata.normalize("NFD", "Café")
    (root / nfc).mkdir()
    (root / nfc / "canary.txt").write_text("canary", encoding="utf-8")
    _folder_choices(tmp_path, monkeypatch, [str(root / nfc)])

    assert closed_folder(str(root / nfd / "canary.txt")) == nfc
    assert closed_folder(str(root / nfc.upper() / "canary.txt")) == nfc
    _folder_choices(tmp_path, monkeypatch, [str(root / nfd)])
    assert closed_folder(str(root / nfc / "canary.txt")) == nfd


def test_data_volume_spelling_of_a_closed_folder_is_refused(tmp_path, monkeypatch):
    from tools.atum_source_policy import closed_folder

    home = Path(os.path.realpath(tmp_path)) / "home"
    (home / "Desktop").mkdir(parents=True)
    _folder_choices(tmp_path, monkeypatch, [str(home / "Desktop")])

    assert closed_folder("/System/Volumes/Data" + str(home / "Desktop" / "a.txt")) == "Desktop"
    _folder_choices(tmp_path, monkeypatch, ["/System/Volumes/Data" + str(home / "Desktop")])
    assert closed_folder(str(home / "Desktop" / "a.txt")) == "Desktop"


def test_a_hard_linked_file_is_refused_while_a_folder_is_closed(closed_desktop):
    from tools.atum_source_policy import folder_refusal

    outside = closed_desktop / "Projects" / "outside.md"
    os.link(closed_desktop / "Desktop" / "notes" / "plan.md", outside)
    assert "more than one name" in folder_refusal(str(outside))

    plain = closed_desktop / "Projects" / "plain.md"
    plain.write_text("open", encoding="utf-8")
    assert folder_refusal(str(plain)) is None


def test_a_parent_search_never_reads_a_removed_or_closed_folder(tmp_path, monkeypatch):
    """The real search walker prunes closed folders below a broad root, like macOS-protected ones."""
    import shutil

    from tools.environments.local import LocalEnvironment
    from tools.file_operations import ShellFileOperations

    root = Path(os.path.realpath(tmp_path)) / "root"
    (root / "Removed").mkdir(parents=True)
    (root / "Removed" / "canary.txt").write_text("REVIEW_CANARY removed\n", encoding="utf-8")
    (root / "Shared" / "Closed").mkdir(parents=True)
    (root / "Shared" / "Closed" / "canary.txt").write_text("REVIEW_CANARY nested\n", encoding="utf-8")
    (root / "Shared" / "open.txt").write_text("REVIEW_CANARY open\n", encoding="utf-8")
    policy = tmp_path / "acct.json"
    policy.write_text("{}", encoding="utf-8")
    (tmp_path / "acct.folders.json").write_text(json.dumps({
        "version": 1,
        "blocked": [str(root / "Removed"), str(root / "Shared" / "Closed")],
        "shared": [str(root / "Shared")],
    }), encoding="utf-8")
    monkeypatch.setenv(POLICY_ENV, str(policy))

    ops = ShellFileOperations(LocalEnvironment(cwd=str(root)))
    content = ops.search("REVIEW_CANARY", path=str(root))
    text = json.dumps(content.to_dict() if hasattr(content, "to_dict") else content.__dict__, default=str)
    assert "open.txt" in text
    assert "removed" not in text and "nested" not in text and "Removed/canary" not in text, text

    names = ops.search("canary", path=str(root), target="files")
    listed = json.dumps(names.to_dict() if hasattr(names, "to_dict") else names.__dict__, default=str)
    assert "Removed/canary" not in listed and "Closed/canary" not in listed, listed
    assert shutil.which("rg") or True
