"""Per-account, live source switches supplied by Atum Desktop.

The file path is fixed when the local Hermes process starts, but its tiny JSON
record is replaced atomically whenever Settings changes. Reading it per tool
call preserves prompt caching while making revocation immediate.
"""

from __future__ import annotations

import json
import os
import re
import stat
import unicodedata
from pathlib import Path

POLICY_ENV = "ATUM_SOURCE_POLICY_FILE"
_BUILTIN_GATES = frozenset({
    "google",
    "folders",
    "messages",
    "browser",
    "location",
    "team_spaces",
})
_GATE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def source_enabled(source: str) -> bool:
    """Return the live choice; an absent desktop policy preserves Hermes defaults."""
    if not isinstance(source, str) or _GATE.fullmatch(source) is None:
        return False

    filename = os.environ.get(POLICY_ENV)
    if not filename:
        return source in _BUILTIN_GATES

    try:
        path = Path(filename)
        if not path.is_absolute():
            return False
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError):
        # Main promised a policy file for this desktop process. If it disappears
        # or cannot be read, never resurrect a source the owner may have disabled.
        return False

    if (
        not isinstance(value, dict)
        or type(value.get("version")) is not int
        or value.get("version") != 1
        or not _BUILTIN_GATES <= set(value)
        or any(
            key != "version"
            and (
                not isinstance(key, str)
                or _GATE.fullmatch(key) is None
                or not isinstance(enabled, bool)
            )
            for key, enabled in value.items()
        )
    ):
        return False

    return value.get(source) is True


def _folder_choices_file() -> Path | None:
    """Atum Desktop writes the owner's folder choices beside the source policy."""
    filename = os.environ.get(POLICY_ENV)
    if not filename or not filename.endswith(".json"):
        return None
    return Path(filename[: -len(".json")] + ".folders.json")


_ICLOUD = "com~apple~CloudDocs"
# Bookmark data at the start of a Finder alias file. The file tools do not follow aliases, so its
# target can't be checked; when any folder is closed, such a file is refused instead of guessed at.
_ALIAS_MAGIC = b"book\x00\x00\x00\x00mark\x00\x00\x00\x00"
# The Data volume's firmlinks: ``/System/Volumes/Data/Users`` is the same file as ``/Users``.
_DATA_VOLUME = "/System/Volumes/Data"


class _FolderPolicy:
    __slots__ = ("blocked", "shared")

    def __init__(self, blocked: list[str], shared: list[str]):
        self.blocked = blocked
        self.shared = shared


# The owner's choices exist but can't be read: every file read is refused until Desktop rewrites them.
_UNAVAILABLE = _FolderPolicy([], [])


def _managed_mac() -> bool:
    """Atum Desktop on macOS always writes the choices file before Hermes starts."""
    import sys

    return sys.platform == "darwin"


def _folder_policy() -> _FolderPolicy | None:
    """The owner's folder choices, ``_UNAVAILABLE``, or None when no folder is managed.

    - No ``ATUM_SOURCE_POLICY_FILE`` (plain Hermes, not Atum Desktop): None, no folder checks.
    - Atum Desktop: the file is written (all shared for a new account) at every launch before
      Hermes starts and replaced atomically on every change, so a missing, unreadable, damaged or
      ``unavailable`` file means the owner's choices are unknown: ``_UNAVAILABLE``. Nothing older
      or more open is guessed at; reads resume when Desktop writes the choices again.
    - Off macOS Desktop writes no folder choices: a missing file is None.
    """
    choices = _folder_choices_file()
    if choices is None:
        return None
    try:
        text = choices.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return _UNAVAILABLE if _managed_mac() else None
    except (OSError, UnicodeError):
        return _UNAVAILABLE

    try:
        value = json.loads(text)
    except ValueError:
        return _UNAVAILABLE

    def folders(name: str) -> list[str] | None:
        items = value.get(name, [])
        if not isinstance(items, list) or any(not isinstance(item, str) or not os.path.isabs(item) for item in items):
            return None
        return items

    if not isinstance(value, dict) or value.get("version") != 1 or "blocked" not in value or value.get("unavailable"):
        return _UNAVAILABLE
    blocked, shared = folders("blocked"), folders("shared")
    if blocked is None or shared is None:
        return _UNAVAILABLE
    return _FolderPolicy(blocked, shared)


def _key(path: str) -> str:
    """How APFS compares names: case- and Unicode-normalisation-insensitive, Data-volume aliases
    folded onto their firmlinked spelling."""
    path = unicodedata.normalize("NFD", unicodedata.normalize("NFD", os.path.normpath(path)).casefold())
    if path == _DATA_VOLUME.casefold() or path.startswith(_DATA_VOLUME.casefold() + "/"):
        path = path[len(_DATA_VOLUME):] or "/"
    return path


def _spellings(folder: str) -> set[str]:
    """A folder as written and as it really is on disk, compared the way APFS compares names."""
    written = os.path.normpath(folder)
    spellings = {_key(written)}
    try:
        spellings.add(_key(os.path.realpath(written)))
    except (OSError, ValueError, RuntimeError):
        pass
    return spellings


def _scope(folder: str) -> list[str]:
    """iCloud Drive in Finder also shows each app's own iCloud folder (``Mobile Documents/<app>``)."""
    folder = os.path.normpath(folder)
    return [folder, os.path.dirname(folder)] if os.path.basename(folder) == _ICLOUD else [folder]


def _within(target: str, folder: str) -> bool:
    return target == folder or target.startswith(folder.rstrip(os.sep) + os.sep)


def _decide(targets: list[str], policy: _FolderPolicy) -> str | None:
    """The closed folder holding any target. The most specific folder wins, so a folder the
    owner added inside a closed one stays shared, and a removed one inside a shared one is closed."""
    rules: list[tuple[str, bool, str]] = []
    for folder in policy.blocked:
        for scoped in _scope(folder):
            for spelling in _spellings(scoped):
                rules.append((spelling, True, folder))
    for folder in policy.shared:
        for spelling in _spellings(folder):
            rules.append((spelling, False, folder))

    for target in targets:
        target = _key(target)
        best: tuple[int, bool, str] | None = None
        for spelling, closed, folder in rules:
            if _within(target, spelling) and (best is None or len(spelling) > best[0] or (len(spelling) == best[0] and closed)):
                best = (len(spelling), closed, folder)
        if best and best[1]:
            name = os.path.basename(os.path.normpath(best[2]))
            return "iCloud Drive" if name == _ICLOUD else name
    return None


_UNRESOLVED = "Atum couldn't tell which folder that path is in, so it stays closed."
_CHOICES_UNAVAILABLE = ("Atum couldn't read the owner's folder choices, so file reads are paused. "
                        "The owner can check them in Atum Settings › Connections › Mac folders.")
_HARD_LINK = ("That file has more than one name on disk, so Atum can't tell whether it is in a folder "
              "the owner kept closed. It stays closed.")
_ALIAS = ("That file is a Finder alias. Atum can't tell where it points while the owner keeps some "
          "folders closed, so it stays closed. Open the folder it points to instead.")


def _check(path: object, task_id: str) -> tuple[str, str] | None:
    """``("folder", name)``, ``("unavailable" | "unresolved" | "alias" | "hardlink", "")`` or None."""
    policy = _folder_policy()
    if policy is _UNAVAILABLE:
        return ("unavailable", "")
    if policy is None or not policy.blocked:
        return None

    text = path.strip() if isinstance(path, str) and path.strip() else "."
    task = task_id or "default"
    try:
        from tools import file_tools_paths as paths

        if "\x00" in text:
            return ("unresolved", "")
        expanded = paths._expand_tilde(text)
        if not os.path.isabs(expanded):
            expanded = os.path.join(str(paths._resolve_base_dir(task)), expanded)
        # As written first: no disk access, so a closed folder is never touched (or prompted for).
        closed = _decide([expanded], policy)
        if closed:
            return ("folder", closed)
        real = str(paths._resolve_path_for_task(text, task))
        closed = _decide([real, os.path.realpath(real)], policy)
    except Exception:
        return ("unresolved", "")
    if closed:
        return ("folder", closed)

    try:
        info = os.stat(real)
        if stat.S_ISREG(info.st_mode):
            # A hard link is the same file under another name, possibly inside a closed folder;
            # nothing on disk says which, so it is refused while any folder is closed.
            if info.st_nlink > 1:
                return ("hardlink", "")
            with open(real, "rb") as handle:
                if handle.read(len(_ALIAS_MAGIC)) == _ALIAS_MAGIC:
                    return ("alias", "")
    except OSError:
        pass
    return None


def folder_refusal(path: object, task_id: str = "default") -> str | None:
    """Why a file tool may not open ``path`` for this task, or None.

    ``path`` is resolved the way the file tools resolve it (``tools/file_tools_paths``: the task's
    cwd for a relative or omitted path, the effective subprocess home for ``~``, symlinks followed,
    then ``realpath``), so a symlink, a ``/private`` spelling, ``..`` or letter case cannot reach a
    closed folder. The spelling as written is checked first, without touching the disk, so a path
    that already names a closed folder never raises the macOS prompt the owner declined. When the
    real path can't be established, the read is refused.
    """
    verdict = _check(path, task_id)
    if verdict is None:
        return None
    kind, name = verdict
    if kind == "unavailable":
        return _CHOICES_UNAVAILABLE
    if kind == "hardlink":
        return _HARD_LINK
    if kind == "unresolved":
        return _UNRESOLVED
    if kind == "alias":
        return _ALIAS
    return (f"The owner kept their {name} folder closed to you. "
            "They can share it in Atum Settings › Connections › Mac folders.")


def closed_folder(path: object, task_id: str = "default") -> str | None:
    """Name of the closed folder that holds ``path``, else None (see ``folder_refusal``)."""
    verdict = _check(path, task_id)
    return verdict[1] if verdict and verdict[0] == "folder" else None


def closed_folders_below(root: str) -> list[str]:
    """Closed folders strictly inside the search root ``root`` (absolute), relative to it, so a
    broad search prunes them like macOS-protected folders and never reads what they hold
    (``tools/file_operations_search.py``). A folder shared inside one of them is pruned with it
    during that broad search; searching the shared folder itself works."""
    policy = _folder_policy()
    if policy is None or policy is _UNAVAILABLE or not policy.blocked or not os.path.isabs(root):
        return []
    roots = {os.path.normpath(root)}
    try:
        roots.add(os.path.realpath(root))
    except (OSError, ValueError, RuntimeError):
        pass
    found: list[str] = []
    for folder in policy.blocked:
        for scoped in _scope(folder):
            candidates = {os.path.normpath(scoped)}
            try:
                candidates.add(os.path.realpath(scoped))
            except (OSError, ValueError, RuntimeError):
                pass
            for candidate in candidates:
                for base in roots:
                    base_key, candidate_key = _key(base), _key(candidate)
                    if candidate_key.startswith(base_key.rstrip("/") + "/"):
                        depth = len([part for part in base_key.split("/") if part])
                        relative = "/".join([part for part in candidate.split("/") if part][depth:])
                        if relative and relative not in found:
                            found.append(relative)
    return found
