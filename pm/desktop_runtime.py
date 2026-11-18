"""Identity and bounded retention for the desktop's bundled dependency overrides.

The bundle can be probed from an update staging directory before it moves to
Applications. Its immutable inputs, rather than that temporary path, own PM state.
Developer checkouts retain their existing per-checkout isolation.
"""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil


def bundle_key(project: Path) -> str | None:
    project = project.resolve()
    # uv's installed console scripts can enter the core source snapshot. That
    # snapshot belongs to its enclosing install, rather than another checkout.
    if project.name == "workspace" and project.parent.parent.name == "environments":
        state = project.parent.parent.parent
        if state.parent.name == "installs" and _desktop_state(state):
            return state.name
    if project.name != "hermes-agent" or project.parent.name != "runtime":
        return None
    try:
        manifest = json.loads((project.parent / "runtime-manifest.json").read_bytes())
        tree = manifest["identity"]["runtimeTree"]
        if manifest["schemaVersion"] != 3 or not re.fullmatch(r"[a-f0-9]{40}", tree):
            return None
        digest = hashlib.sha256(b"desktop-runtime-v1\0")
        digest.update(json.dumps({"tree": tree, "python": manifest["python"],
                                  "target": manifest["target"]}, sort_keys=True).encode())
        for name in ("uv.lock", "pyproject.toml", "pm/lock.json"):
            digest.update(name.encode() + b"\0" + (project / name).read_bytes() + b"\0")
        return digest.hexdigest()[:16]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _desktop_state(state: Path) -> bool:
    if state.is_symlink() or not state.is_dir() or not re.fullmatch(r"[a-f0-9]{16}", state.name):
        return False
    if (state / "desktop-runtime.json").is_file():
        return True
    # Legacy path-keyed states have no desktop receipt. Limit migration to
    # recorded bundled app sources, leaving CLI and developer installations alone.
    try:
        source = Path((state / "inputs" / ".project-root").read_text().strip())
    except OSError:
        return False
    return (
        source.name == "hermes-agent" and source.parent.name == "runtime"
        and source.parent.parent.name == "Resources" and source.parent.parent.parent.name == "Contents"
        and source.parent.parent.parent.parent.suffix == ".app")


def _collect_desktop_installs(project: Path, *, verified_bundle: bool) -> list[Path]:
    """Publish only verified state, then keep current + previous and every live lease.

    Called after selection succeeds, including a successful no-op launch. A failed
    build never reaches here. Native PM locks/leases protect CLI and desktop readers.
    """
    from pm.environments import install_state_dir, installs_root, selected_venv
    from pm.filesystem import durable_write_bytes, lock_fd
    from pm.install import venv_is_current
    from hermes_cli.runtime_state import leases_held

    if bundle_key(project) is None:
        return []
    current = install_state_dir(project)
    if (current / "facts.json").exists() or not verified_bundle:
        if not venv_is_current(project_root=project):
            return []
        environment = selected_venv(project)
        if not (environment / "pyvenv.cfg").is_file():
            return []
    current.mkdir(parents=True, exist_ok=True)
    receipt = current / "desktop-runtime.json"
    if not receipt.exists():
        durable_write_bytes(receipt, json.dumps({"source": str(project.resolve())}).encode())
    candidates = sorted((state for state in installs_root().iterdir()
                         if state != current and _desktop_state(state)),
                        key=lambda state: (state / "facts.json").stat().st_mtime
                        if (state / "facts.json").is_file() else 0, reverse=True)
    marker = installs_root() / ".desktop-active.json"
    previous = candidates[0].name if candidates else None
    if marker.exists():
        active = json.loads(marker.read_bytes())
        if not isinstance(active, dict) or not re.fullmatch(r"[a-f0-9]{16}", str(active.get("current", ""))):
            raise ValueError("invalid desktop retention marker")
        if active.get("previous") is not None and not re.fullmatch(r"[a-f0-9]{16}", str(active["previous"])):
            raise ValueError("invalid desktop rollback marker")
        previous = active.get("previous") if active.get("current") == current.name else active.get("current")
    durable_write_bytes(marker, json.dumps({"current": current.name, "previous": previous}).encode())
    # Older console-script launches may have made another state whose source
    # still lives inside an earlier snapshot. Retain that source until its
    # dependent state is retired, including states whose provenance is unknown.
    referenced_sources = []
    for sibling in installs_root().iterdir():
        try:
            referenced_sources.append(Path((sibling / "inputs" / ".project-root").read_text().strip()).resolve())
        except OSError:
            continue
    removed = []
    for state in candidates:
        if any(source.is_relative_to(state.resolve()) for source in referenced_sources):
            continue
        if state.name == previous:
            continue
        # Keep the native install lock through deletion, so a boot cannot select
        # this state's environment between the lease check and removal.
        with ExitStack() as locks:
            install_lock = locks.enter_context((state / ".install.lock").open("a+b"))
            if not lock_fd(install_lock.fileno(), wait=False):
                continue
            runtime = state / "pm-runtime"
            if runtime.is_dir():
                prepare_lock = locks.enter_context((runtime / ".prepare.lock").open("a+b"))
                if not lock_fd(prepare_lock.fileno(), wait=False):
                    continue
            generations = [*(state / "environments").glob("*"),
                           *(state / "pm-runtime" / "generations").glob("*")]
            if any(generation.is_symlink() or not (generation / ".lease-managed").is_file()
                   or leases_held(generation) for generation in generations if generation.is_dir()):
                continue
            # Preserve provenance until last for retry after interrupted deletion.
            for child in state.iterdir():
                if child.name in ("inputs", "desktop-runtime.json", ".install.lock", "pm-runtime"):
                    continue
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            if runtime.is_dir():
                shutil.rmtree(runtime)
            shutil.rmtree(state)
            removed.append(state)
    return removed


def collect_desktop_installs(project: Path, *, verified_bundle: bool = False) -> list[Path]:
    from pm.environments import installs_root
    from pm.filesystem import lock_fd

    if bundle_key(project) is None or not installs_root().is_dir():
        return []
    fd = os.open(installs_root() / ".desktop-retention.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        return _collect_desktop_installs(project, verified_bundle=verified_bundle) if lock_fd(fd, wait=False) else []
    finally:
        os.close(fd)


def cleanup_desktop_installs(project: Path, *, verified_bundle: bool = False) -> None:
    try:
        collect_desktop_installs(project, verified_bundle=verified_bundle)
    except (OSError, ValueError, RuntimeError) as exc:
        logging.getLogger(__name__).warning("desktop dependency cleanup skipped: %s", exc)
