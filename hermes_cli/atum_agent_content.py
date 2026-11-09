'One Matrix agent\'s portable skills, materialized in its own Hermes home.\n\nElectron main owns the account, the grant, the agent\'s identity and the cloud\ntransport.  It gives this helper only the agent\'s dedicated home (a path main\nchose itself), the definition\'s skill references and, to install, the bundles\nit downloaded.  The helper never sees a credential, starts Hermes, runs jobs or\nwrites outside that home.\n\nCloud skills are additive ():\n\n- a missing owner-private skill is installed, byte for byte, under the same\n  writer lock as the bundled-skill seeding, with a publication that cannot\n  replace anything;\n- an existing local skill is never replaced, and a skill this Mac ships keeps\n  this Mac\'s version: the bundled seeding (tools/skills_sync.py) owns it;\n- a skill removed here after it arrived stays removed;\n- every declared skill gets a truthful state, never a silent "complete".\n\nThe receipt .atum-agent-content/skills.json records which cloud bytes this\nhome has held at each path.  It is the only memory of a removal, so a later\nslice keeps curated memory\'s revisions and tombstones beside it.\n'

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
from contextlib import contextmanager
from itertools import chain
from pathlib import Path
from typing import Any, Iterator

from hermes_cli.atum_portability import PortabilityError, UnsupportedLocalDefinition, _skill_tree_hash, _validate_skill_name
from hermes_cli.atum_skill_bundles import (
    SkillBundleError,
    canonical_skill_bundle,
    rename_no_replace,
    validate_skill_bundle,
    write_skill_bundle,
)

SCHEMA_VERSION = 1
CONTENT_DIR = ".atum-agent-content"
RECEIPT = "skills.json"
MEMORY_RECEIPT = "memory.json"
STAGE = "stage"
MEMORY_STAGE = "memory-stage"
MAX_REFERENCES = 512
MAX_BUNDLES = 512
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_RECEIPT_BYTES = 1024 * 1024
MAX_MEMORY_RECEIPT_BYTES = 256 * 1024
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_ARCHIVE_TIMESTAMP = r"-\d{14}"

#: Every state a declared skill can be in, and what each detail may say.
STATES: dict[str, frozenset[str | None]] = {
    # Here with exactly the account's bytes ("new": published by this call).
    "installed": frozenset({None, "new"}),
    # A skill this Mac ships, with the account's bytes / at this Mac's version.
    "bundled": frozenset({None}),
    "bundled_version": frozenset({None}),
    # Other bytes are here and are kept: edited here, or changed in the account.
    "different": frozenset({"local_edit", "account_changed", "not_a_skill", "unreadable"}),
    # Removed or archived here after it arrived, or a shipped skill turned off here.
    "suppressed": frozenset({"removed", "archived", "bundled_opt_out", "bundled_suppressed", "bundled_removed"}),
    # Its skill name is already another skill's here; not installed.
    "collision": frozenset({"bundled", "external", "local"}),
    # Its path is inside another skill, crosses a link or a file; not installed.
    "blocked": frozenset({"bundled", "inside_skill", "not_a_directory", "symlink"}),
    # Not here, and no bundle was given for it.
    "missing": frozenset({None}),
    # Refused whole: a name, a bundle or a path this Mac cannot hold exactly.
    "unsupported": frozenset({"name", "bundle", "filesystem"}),
}


class AgentContentError(ValueError):
    """This agent's request cannot be served.  The code never echoes content."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _invalid() -> AgentContentError:
    return AgentContentError("agent_content_invalid")


def _result(reference: dict[str, str], state: str, detail: str | None = None) -> dict[str, str]:
    result = {"name": reference["name"], "sha256": reference["sha256"], "state": state}
    if detail is not None:
        result["detail"] = detail
    return result


def _references(value: Any) -> list[tuple[dict[str, str], str | None]]:
    """Validated references, each with a per-skill refusal (``None`` when usable).

    A malformed request refuses the call.  A name this Mac cannot hold refuses
    only that skill, so one unusual name never holds up the others.
    """
    if not isinstance(value, list) or len(value) > MAX_REFERENCES:
        raise _invalid()
    seen: set[str] = set()
    result: list[tuple[dict[str, str], str | None]] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"name", "sha256"}:
            raise _invalid()
        name, digest = item["name"], item["sha256"]
        if not isinstance(name, str) or not isinstance(digest, str) or not _SHA256.fullmatch(digest) or name in seen:
            raise _invalid()
        seen.add(name)
        try:
            _validate_skill_name(name)
            refusal = None if _ordinary_name(name) else "name"
            name.encode("utf-8")
        except (PortabilityError, UnicodeEncodeError):
            refusal = "name"
        result.append(({"name": name, "sha256": digest}, refusal))
    return sorted(result, key=lambda entry: entry[0]["name"].encode("utf-8", "surrogatepass"))


def _ordinary_name(name: str) -> bool:
    """A cloud skill never lands in Hermes's own state (``.archive``, ``.hub``) or a dependency tree."""
    from agent.skill_utils import EXCLUDED_SKILL_DIRS

    return not any(part.startswith(".") or part in EXCLUDED_SKILL_DIRS for part in name.split("/"))


def _tree_hash(path: Path) -> str | None:
    try:
        return _skill_tree_hash(path)
    except (UnsupportedLocalDefinition, OSError):
        return None


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _private_directory(path: Path) -> Path:
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise AgentContentError("agent_content_home")
    path.mkdir(mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _read_receipt(home: Path) -> tuple[dict[str, str], str]:
    """This home's receipt; an unreadable one is set aside, never trusted or fatal.

    Losing it forgets removals of skills that were hard-deleted (archived ones
    are still recognized by their bytes), which is the fresh-home behaviour.
    """
    path = home / CONTENT_DIR / RECEIPT
    if not os.path.lexists(path):
        return {}, "ok"
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RECEIPT_BYTES:
            raise ValueError("receipt is not a regular file")
        data = json.loads(path.read_bytes().decode("utf-8"))
        if (not isinstance(data, dict) or set(data) != {"schema_version", "skills"}
                or data["schema_version"] != SCHEMA_VERSION or not isinstance(data["skills"], dict)):
            raise ValueError("receipt shape")
        skills: dict[str, str] = {}
        for name, digest in data["skills"].items():
            _validate_skill_name(name)
            if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
                raise ValueError("receipt digest")
            skills[name] = digest
        return skills, "ok"
    except (OSError, ValueError, UnicodeDecodeError):
        quarantine = path.with_name(f"{RECEIPT}.corrupt-{time.time_ns()}")
        try:
            os.replace(path, quarantine)
        except OSError as exc:
            raise AgentContentError("agent_content_receipt") from exc
        return {}, "reset"


def _write_receipt(home: Path, skills: dict[str, str]) -> None:
    directory = _private_directory(home / CONTENT_DIR)
    payload = json.dumps(
        {"schema_version": SCHEMA_VERSION, "skills": dict(sorted(skills.items()))},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    # Staged beside the skills, so a write cut short is cleared with them.
    descriptor, temporary = tempfile.mkstemp(prefix="receipt-", suffix=".tmp", dir=_private_directory(directory / STAGE))
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, directory / RECEIPT)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    _fsync_directory(directory)


def _read_memory_receipt(home: Path) -> dict[str, Any] | None:
    """The last portable snapshot accepted by both this home and the account.

    An unreadable receipt is set aside and treated as no base. That makes the next
    three-way comparison conservative (a conflict), never last-write-wins.
    """
    directory = home / CONTENT_DIR
    path = directory / MEMORY_RECEIPT
    if not os.path.lexists(path):
        return None
    if directory.is_symlink() or not directory.is_dir():
        raise AgentContentError("agent_content_receipt")
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MEMORY_RECEIPT_BYTES:
            raise ValueError("memory receipt is not a regular file")
        data = json.loads(path.read_bytes().decode("utf-8"))
        if (not isinstance(data, dict) or set(data) != {"schema_version", "revision", "snapshot"}
                or data["schema_version"] != SCHEMA_VERSION or not isinstance(data["revision"], int)
                or isinstance(data["revision"], bool) or data["revision"] < 1):
            raise ValueError("memory receipt shape")
        from hermes_cli.atum_memory_sync import _validate_snapshot

        return {
            "revision": data["revision"],
            "snapshot": _validate_snapshot(data["snapshot"], name="receipt", permit_local=False),
        }
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        quarantine = path.with_name(f"{MEMORY_RECEIPT}.corrupt-{time.time_ns()}")
        try:
            os.replace(path, quarantine)
        except OSError as exc:
            raise AgentContentError("agent_content_receipt") from exc
        return None


def _write_memory_receipt(home: Path, revision: int, snapshot: Any) -> None:
    from hermes_cli.atum_memory_sync import _validate_snapshot

    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise _invalid()
    normalized = _validate_snapshot(snapshot, name="receipt", permit_local=False)
    directory = _private_directory(home / CONTENT_DIR)
    payload = json.dumps(
        {"schema_version": SCHEMA_VERSION, "revision": revision, "snapshot": normalized},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    stage = _private_directory(directory / MEMORY_STAGE)
    for stale in stage.glob("memory-*.tmp"):
        stale.unlink(missing_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="memory-", suffix=".tmp", dir=stage)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, directory / MEMORY_RECEIPT)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    _fsync_directory(directory)


class _Bundled:
    """The skills this Mac ships, by path under ``skills/`` and by skill name."""

    def __init__(self, bundled_dir: Path):
        from tools.skills_sync import _discover_bundled_skills

        self.by_path: dict[str, tuple[str, Path]] = {}
        self.by_name: dict[str, str] = {}
        for skill_name, directory in _discover_bundled_skills(bundled_dir):
            try:
                relative = directory.relative_to(bundled_dir).as_posix()
            except ValueError:
                continue
            self.by_path[relative] = (skill_name, directory)
            self.by_name.setdefault(skill_name, relative)

    def overlaps(self, name: str) -> bool:
        """A path inside a shipped skill, or holding one, would change that skill's tree."""
        return any(name.startswith(f"{path}/") or path.startswith(f"{name}/") for path in self.by_path)


class _Context:
    """One locked operation on one home."""

    def __init__(self, home: Path, bundled_dir: Path | None):
        from tools.skill_usage import read_suppressed_names
        from tools.skills_sync import NO_BUNDLED_SKILLS_MARKER, _get_bundled_dir, _read_manifest

        self.home = home
        self.skills = home / "skills"
        self.bundled = _Bundled(bundled_dir if bundled_dir is not None else _get_bundled_dir())
        self.manifest = _read_manifest(self.skills / ".bundled_manifest")
        # The curator's own record for THIS home (the operation scopes get_hermes_home to it).
        # No fallback to a launch-bound global: a failure refuses the call instead.
        self.suppressed = read_suppressed_names()
        self.opted_out = os.path.lexists(home / NO_BUNDLED_SKILLS_MARKER)
        self.receipt, self.receipt_state = _read_receipt(home)
        self.stage = _private_directory(_private_directory(home / CONTENT_DIR) / STAGE)
        self._names: dict[str, set[str]] | None = None
        self._external: set[str] | None = None
        self._archived: list[Path] | None = None

    def destination(self, name: str) -> Path:
        return self.skills.joinpath(*name.split("/"))

    def clear_stage(self) -> None:
        """Only this lock holder stages here, so anything left is from a crash."""
        for entry in self.stage.iterdir():
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)

    def local_names(self) -> dict[str, set[str]]:
        """Skill name -> paths of every local skill, held ones included (they keep their names)."""
        if self._names is None:
            from agent.skill_utils import iter_held_skill_index_files, iter_skill_index_files
            from tools.skill_usage import read_skill_name as _read_skill_name

            names: dict[str, set[str]] = {}
            if self.skills.is_dir() and not self.skills.is_symlink():
                for skill_md in chain(iter_skill_index_files(self.skills, "SKILL.md"),
                                      (path for path, _reason in iter_held_skill_index_files(self.skills))):
                    try:
                        relative = skill_md.parent.relative_to(self.skills).as_posix()
                    except ValueError:
                        continue
                    names.setdefault(_read_skill_name(skill_md, skill_md.parent.name), set()).add(relative)
            self._names = names
        return self._names

    def external_names(self) -> set[str]:
        if self._external is None:
            from tools.skills_sync import _build_external_skill_index

            self._external = _build_external_skill_index()
        return self._external

    def archived(self, name: str, digest: str) -> bool:
        """An archived copy of exactly these bytes (the curator's flat ``.archive/<leaf>``)."""
        if self._archived is None:
            root = self.skills / ".archive"
            found: list[Path] = []
            if root.is_dir() and not root.is_symlink():
                for base, directories, _files in os.walk(root, followlinks=False):
                    found.extend(Path(base) / directory for directory in directories)
            self._archived = found
        leaf = name.split("/")[-1]
        # The curator archives flat, as "<leaf>", or "<leaf>-YYYYMMDDHHMMSS" beside an older copy.
        copy = re.compile(re.escape(leaf) + _ARCHIVE_TIMESTAMP)
        return any(
            (candidate.name == leaf or copy.fullmatch(candidate.name)) and _tree_hash(candidate) == digest
            for candidate in self._archived
        )


def _home(value: Path) -> Path:
    home = Path(value)
    if not home.is_absolute() or home.is_symlink() or not home.is_dir():
        raise AgentContentError("agent_content_home")
    skills = home / "skills"
    if skills.is_symlink() or (os.path.lexists(skills) and not skills.is_dir()):
        raise AgentContentError("agent_content_home")
    return home


@contextmanager
def _operation(home: Path, bundled_dir: Path | None) -> Iterator[_Context]:
    """Hold the home's skills writer lock (shared with the bundled seeding) for one call."""
    from tools.skills_sync import _bundled_skills_write_lock, _profile_home_context

    home = _home(home)
    with _profile_home_context(home):
        try:
            lock = _bundled_skills_write_lock(home, home / "skills")
            lock.__enter__()
        except TimeoutError as exc:
            raise AgentContentError("agent_content_busy") from exc
        try:
            context = _Context(home, bundled_dir)
            context.clear_stage()
            yield context
        finally:
            lock.__exit__(None, None, None)


def _path_problem(skills: Path, name: str) -> str | None:
    """Why *name* cannot become a skill directory here without touching another tree."""
    if skills.is_symlink():
        return "symlink"
    parts = name.split("/")
    current = skills
    for index, part in enumerate(parts):
        current = current / part
        if current.is_symlink():
            return "symlink"
        if index == len(parts) - 1:
            return None
        if not os.path.lexists(current):
            return None
        if not current.is_dir():
            return "not_a_directory"
        if os.path.lexists(current / "SKILL.md"):
            return "inside_skill"
    return None


def _classify(context: _Context, reference: dict[str, str], refusal: str | None) -> dict[str, str]:
    name, digest = reference["name"], reference["sha256"]
    if refusal is not None:
        return _result(reference, "unsupported", refusal)
    destination = context.destination(name)
    shipped = context.bundled.by_path.get(name)
    if shipped is not None:
        skill_name, source = shipped
        if context.opted_out:
            return _result(reference, "suppressed", "bundled_opt_out")
        if skill_name in context.suppressed:
            return _result(reference, "suppressed", "bundled_suppressed")
        present = os.path.lexists(destination)
        if not present and skill_name in context.manifest:
            return _result(reference, "suppressed", "bundled_removed")
        if present and (destination.is_symlink() or not destination.is_dir()):
            return _result(reference, "different", "not_a_skill")
        # The bundled seeding places it; until then this Mac's shipped copy is what it gets.
        actual = _tree_hash(destination if present else source)
        if present and actual is None:
            return _result(reference, "different", "unreadable")
        return _result(reference, "bundled" if actual == digest else "bundled_version")
    if context.bundled.overlaps(name):
        return _result(reference, "blocked", "bundled")
    problem = _path_problem(context.skills, name)
    if problem is not None:
        return _result(reference, "blocked", problem)
    if os.path.lexists(destination):
        if destination.is_symlink() or not destination.is_dir():
            return _result(reference, "different", "not_a_skill")
        actual = _tree_hash(destination)
        if actual is None:
            return _result(reference, "different", "unreadable")
        if actual == digest:
            return _result(reference, "installed")
        return _result(reference, "different",
                       "account_changed" if context.receipt.get(name) == actual else "local_edit")
    if name in context.receipt:
        return _result(reference, "suppressed", "removed")
    if context.archived(name, digest):
        return _result(reference, "suppressed", "archived")
    return _result(reference, "missing")


def _classify_all(context: _Context, references: list[tuple[dict[str, str], str | None]]) -> list[dict[str, str]]:
    results = [_classify(context, reference, refusal) for reference, refusal in references]
    # Bytes already here at a declared path are this home's, so removing them
    # later is a removal, not a gap to refill.
    adopted = {result["name"]: result["sha256"] for result in results
               if result["state"] == "installed" and context.receipt.get(result["name"]) != result["sha256"]}
    if adopted:
        context.receipt.update(adopted)
        _write_receipt(context.home, context.receipt)
    return results


def _collision(context: _Context, skill_name: str, name: str) -> str | None:
    shipped = context.bundled.by_name.get(skill_name)
    if shipped is not None and shipped != name:
        return "bundled"
    if skill_name in context.external_names():
        return "external"
    if context.local_names().get(skill_name, {name}) - {name}:
        return "local"
    return None


def _install_one(context: _Context, result: dict[str, str], bundle: Any) -> None:
    """Publish one missing skill, or say exactly why not.  Never replaces anything."""
    from tools.skill_usage import read_skill_name as _read_skill_name

    name, digest = result["name"], result["sha256"]
    try:
        bundle = validate_skill_bundle(canonical_skill_bundle(bundle))
    except SkillBundleError:
        result.update(state="unsupported", detail="bundle")
        return
    if bundle["sha256"] != digest:
        result.update(state="unsupported", detail="bundle")
        return
    destination = context.destination(name)
    stage = Path(tempfile.mkdtemp(prefix="skill-", dir=context.stage))
    try:
        staged = stage / "skill"
        try:
            write_skill_bundle(staged, bundle)
        except (OSError, SkillBundleError):
            result.update(state="unsupported", detail="filesystem")
            return
        skill_name = _read_skill_name(staged / "SKILL.md", name.split("/")[-1])
        collision = _collision(context, skill_name, name)
        if collision is not None:
            result.update(state="collision", detail=collision)
            return
        problem = _path_problem(context.skills, name)
        if problem is not None:
            result.update(state="blocked", detail=problem)
            return
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            rename_no_replace(staged, destination)
        except FileExistsError:
            # Another writer got there first: report what is there now, untouched.
            current = _classify(context, {"name": name, "sha256": digest}, None)
            result.clear()
            result.update(current)
            return
        except OSError:
            result.update(state="unsupported", detail="filesystem")
            return
        _fsync_directory(destination.parent)
        context.receipt[name] = digest
        _write_receipt(context.home, context.receipt)
        context.local_names().setdefault(skill_name, set()).add(name)
        result.update(state="installed", detail="new")
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def check_skills(home: Path, references: Any, *, bundled_dir: Path | None = None) -> dict[str, Any]:
    """Each declared skill's state in this home.  Writes only the receipt."""
    parsed = _references(references)
    with _operation(Path(home), bundled_dir) as context:
        return {"ok": True, "receipt": context.receipt_state, "skills": _classify_all(context, parsed)}


def install_skills(home: Path, references: Any, bundles: Any, *, bundled_dir: Path | None = None) -> dict[str, Any]:
    """Install the given bundles for skills missing here, then report every declared skill."""
    parsed = _references(references)
    if not isinstance(bundles, list) or len(bundles) > MAX_BUNDLES:
        raise _invalid()
    by_hash: dict[str, Any] = {}
    for bundle in bundles:
        digest = bundle.get("sha256") if isinstance(bundle, dict) else None
        if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
            raise _invalid()
        by_hash.setdefault(digest, bundle)
    with _operation(Path(home), bundled_dir) as context:
        results = _classify_all(context, parsed)
        for result in results:
            if result["state"] == "missing" and result["sha256"] in by_hash:
                _install_one(context, result, by_hash[result["sha256"]])
        return {"ok": True, "receipt": context.receipt_state, "skills": results}


def read_memory(home: Path) -> dict[str, Any]:
    """Read only the bounded portable MEMORY.md / USER.md snapshot and its local base."""
    from hermes_cli.atum_memory_sync import read_memory_snapshot

    home = _home(home)
    return {"ok": True, "snapshot": read_memory_snapshot(home), "receipt": _read_memory_receipt(home)}


def apply_memory(home: Path, request: Any) -> dict[str, Any]:
    """CAS-apply an accepted account snapshot; advance the base only after full success."""
    if (not isinstance(request, dict)
            or set(request) != {"expected_snapshot", "snapshot", "revision"}):
        raise _invalid()
    revision = request["revision"]
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise _invalid()
    from hermes_cli.atum_memory_sync import apply_memory_snapshot

    home = _home(home)
    result = apply_memory_snapshot(home, request["expected_snapshot"], request["snapshot"])
    if result.get("success") is True:
        _write_memory_receipt(home, revision, result.get("snapshot"))
    return {"ok": True, "result": result}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("skills-check", "skills-install", "memory-read", "memory-apply"))
    parser.add_argument("--home", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise _invalid()
        request = json.loads(raw.decode("utf-8"))
        if args.operation == "skills-check":
            if not isinstance(request, dict) or set(request) != {"skills"}:
                raise _invalid()
            result = check_skills(args.home, request["skills"])
        elif args.operation == "skills-install":
            if not isinstance(request, dict) or set(request) != {"skills", "bundles"}:
                raise _invalid()
            result = install_skills(args.home, request["skills"], request["bundles"])
        elif args.operation == "memory-read":
            if not isinstance(request, dict) or request:
                raise _invalid()
            result = read_memory(args.home)
        else:
            result = apply_memory(args.home, request)
        # ASCII escapes: a name the platform accepted always travels back intact.
        sys.stdout.write(json.dumps(result) + "\n")
        return 0
    except AgentContentError as exc:
        code = exc.code
    except (ValueError, TypeError, KeyError, UnicodeDecodeError):
        code = "agent_content_invalid"
    except OSError:
        code = "agent_content_failed"
    # Native code maps the code to a status; never echo a path, name or byte.
    sys.stdout.write(json.dumps({"ok": False, "error": code}) + "\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
