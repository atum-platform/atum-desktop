"""Small, read-only capability probes for the curated Office app routes.

Skill prose is not an automation adapter. Only the three shipped, unmodified
Office skills have declared operation chains here. Remote targets remain
unverified until a probe can run in that actual environment without creating it.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import threading
import time

from hermes_constants import get_hermes_home

LAUNCH_HOME = get_hermes_home().resolve()
OFFICE = ("docx", "xlsx", "powerpoint")
OPERATIONS = ("read", "edit", "validate", "render-qa", "create", "file-visible")
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _shipped_skill_matches(source: Path, installed: Path) -> bool:
    """Executing shipped helpers can create bytecode, not a modified skill."""
    def content(root: Path) -> dict[str, bytes]:
        output = {}
        for path in root.rglob("*"):
            relative = path.relative_to(root)
            if path.is_symlink():
                raise ValueError("symlink in skill")
            if "__pycache__" in relative.parts or path.name == ".DS_Store":
                continue
            if path.is_file():
                output[relative.as_posix()] = path.read_bytes()
        return output
    try:
        return installed.is_dir() and not installed.is_symlink() and content(source) == content(installed)
    except (OSError, ValueError):
        return False


def execution_target(config: dict, home: Path, cwd: str = "") -> dict:
    """Decode the selected profile's bridge without mutating os.environ.

    A process-level runtime override belongs only to its launch profile. If an
    alternate profile conflicts with that already-selected runtime, report the
    ambiguity instead of green-lighting packages on the host.
    """
    from hermes_cli.config import apply_terminal_config_to_env
    env = apply_terminal_config_to_env(env={}, config=config, override=True)
    kind = env.get("TERMINAL_ENV", "local").strip().lower() or "local"
    launched = os.environ.get("TERMINAL_ENV", "").strip().lower()
    mismatch = bool(launched and launched != kind)
    if home.resolve() == LAUNCH_HOME and launched:
        kind = launched
        mismatch = False
    working_dir = cwd or env.get("TERMINAL_CWD") or str(Path.home())
    # Hash private runtime settings for invalidation; never return their values.
    stamp = json.dumps([str(home.resolve()), env, config, kind, working_dir, os.environ.get("PATH", "")], sort_keys=True, default=str)
    return {"kind": kind, "generation": hashlib.sha256(stamp.encode()).hexdigest()[:20],
            "cwd": working_dir, "mismatch": mismatch}


def _local_dependencies(cwd: str) -> dict[str, bool]:
    """Fixed read-only probe through the actual local terminal shell lifecycle.

    Login initialization and subprocess environment filtering can change Python
    and Node resolution. Probing the web server process alone is not evidence
    about the terminal. This private short-lived snapshot never touches a live
    agent session, installs packages, or provisions a remote environment.
    """
    import shlex
    from tools.environments.local import LocalEnvironment

    class ProbeEnvironment(LocalEnvironment):
        _snapshot_timeout = 4

    modules = ("openpyxl", "markitdown", "pptx", "PIL", "lxml", "defusedxml")
    executables = ("pandoc", "soffice", "pdftoppm", "zip", "unzip")
    facts = dict.fromkeys(modules + executables + ("pptxgenjs", "docx"), False)
    script = (
        # sys is builtin: remove Python -c's implicit cwd before importing any
        # shadowable module. Unlike -P, this also supports terminal Python 3.9/3.10.
        "import sys; sys.path[:] = [p for p in sys.path if p != '']; "
        "import importlib.util,json,shutil,subprocess; "
        f"facts={{n:importlib.util.find_spec(n) is not None for n in {modules!r}}}; "
        f"facts.update({{n:bool(shutil.which(n)) for n in {executables!r}}}); "
        "node=shutil.which('node'); "
        "facts.update({n:bool(node) and subprocess.run([node,'-e',"
        "\"try {require.resolve(process.argv[1]);process.exit(0)} catch {process.exit(1)}\",n],"
        "capture_output=True,timeout=3).returncode==0 for n in ('pptxgenjs','docx')}); "
        "print('ATUM_APP_PROBE='+json.dumps(facts))"
    )
    environment = None
    try:
        environment = ProbeEnvironment(cwd=cwd, timeout=10)
        result = environment.execute(
            "if command -v python >/dev/null 2>&1; then python -c " + shlex.quote(script) +
            "; else python3 -c " + shlex.quote(script) + "; fi",
            timeout=10, bounded_capture=True,
        )
        if result.get("returncode") == 0:
            for line in result.get("output", "").splitlines():
                if line.startswith("ATUM_APP_PROBE="):
                    values = json.loads(line.removeprefix("ATUM_APP_PROBE="))
                    facts.update({key: value is True for key, value in values.items() if key in facts})
    except (OSError, ValueError, RuntimeError):
        pass
    finally:
        if environment is not None:
            environment.cleanup()
    return facts


def _operation(facts: dict[str, bool], requires: tuple[str, ...], extra: tuple[str, ...] = ()) -> dict:
    reasons = ["missing-tool:" + key for key in requires if not facts.get(key)] + list(extra)
    state = "needs-setup" if any(reason.startswith("missing-tool:") for reason in reasons) else "unknown" if reasons else "ready"
    return {"state": state, "reasons": reasons}


def operation_readiness(target: dict, *, vision: bool | None = None) -> dict:
    if target["kind"] != "local" or target["mismatch"]:
        reason = "runtime-mismatch" if target["mismatch"] else "remote-runtime-unprobed"
        return {name: {"operations": {op: {"state": "unknown", "reasons": ["file-not-visible" if op == "file-visible" else reason]}
                                       for op in OPERATIONS}} for name in OFFICE}
    cwd = target["cwd"]
    if not Path(cwd).is_dir():
        return {name: {"operations": {op: {"state": "needs-setup", "reasons": ["file-not-visible"]} for op in OPERATIONS}} for name in OFFICE}
    with _lock:
        cached = _cache.get(target["generation"])
        if cached and time.monotonic() - cached[0] < 60:
            facts = cached[1]
        else:
            facts = _local_dependencies(cwd)
            if len(_cache) > 32:
                _cache.clear()
            _cache[target["generation"]] = (time.monotonic(), facts)
    visual = () if vision is True else ("missing-tool:vision",) if vision is False else ("visual-qa-unverified",)
    xml = ("lxml", "defusedxml", "zip", "unzip")
    render = ("soffice", "pdftoppm")
    chains = {
        "docx": {"read": ("pandoc",), "edit": xml + render, "validate": xml,
                 "render-qa": render, "create": ("docx",) + xml + render},
        "powerpoint": {"read": ("markitdown", "pptx"), "edit": xml + render,
                       "validate": xml, "render-qa": render + ("PIL",),
                       "create": ("pptxgenjs",) + xml + render + ("PIL",)},
        "xlsx": {"read": ("openpyxl",), "edit": ("openpyxl", "soffice"),
                 "validate": ("openpyxl", "soffice"), "render-qa": render,
                 "create": ("openpyxl", "soffice")},
    }
    output = {}
    for name, chain in chains.items():
        operations = {op: _operation(facts, deps, visual if op == "render-qa" or (name != "xlsx" and op in {"edit", "create"}) else ())
                      for op, deps in chain.items()}
        # Files captured by the desktop are staged on this same local backend.
        # This is the transport route, not a claim that an app's buffer is read.
        operations["file-visible"] = {"state": "ready", "reasons": []}
        output[name] = {"operations": operations}
    return output


def app_readiness(cwd: str = "", refresh: bool = False) -> dict:
    """Caller binds the already-validated profile using config contextvars."""
    from agent.skill_commands import get_skill_commands
    from hermes_cli.config import load_config_readonly
    from tools.skills_sync import _get_bundled_dir, _discover_bundled_skills, _compute_relative_dest, _find_local_name_collision
    from tools.skills_tool import _parse_frontmatter

    home = get_hermes_home()
    root = _get_bundled_dir()
    bundled = []
    verified = []
    for name, source in _discover_bundled_skills(root):
        if name not in OFFICE:
            continue
        front, _ = _parse_frontmatter((source / "SKILL.md").read_text(encoding="utf-8-sig"))
        bundled.append({"name": name, "description": str(front.get("description", "")), "category": "productivity"})
        destination = _compute_relative_dest(source, root, home / "skills")
        # Listing and slash registration deduplicate names. A pristine copy at
        # the expected path alone cannot prove which same-name skill will run.
        if _shipped_skill_matches(source, destination) and _find_local_name_collision(home / "skills", name, destination) is None:
            verified.append(name)
    bundled_names = {entry["name"] for entry in bundled}
    commands = {str(info["name"]): command for command, info in get_skill_commands().items()}
    config = load_config_readonly()
    target = execution_target(config, home, cwd)
    if refresh:
        with _lock:
            _cache.pop(target["generation"], None)
    # Operation chains belong only to skills this runtime actually ships. A
    # package may intentionally omit an upstream Office skill tree; returning
    # its otherwise successful probe would make the native launcher advertise
    # an unavailable capability.
    routes = {name: route for name, route in operation_readiness(target).items() if name in bundled_names}
    # The config-only tool selection is cheap and does not instantiate tools or
    # mutate a live session's prompt. Explicit launch pins apply only at home.
    # Auxiliary vision resolution may refresh OAuth/network state, so it is not
    # invoked by opening a drawer. Its session-specific readiness stays unknown.
    from hermes_cli.tools_config import _get_platform_tools
    from toolsets import resolve_toolset
    try:
        selected = _get_platform_tools(config, "cli", include_default_mcp_servers=False)
        pinned = os.environ.get("HERMES_TUI_TOOLSETS", "") if home.resolve() == LAUNCH_HOME else ""
        if pinned:
            selected = set(pinned.split(","))
        available = ({tool for name in selected for tool in resolve_toolset(name)}
                     if selected else None)
        if available is not None and "terminal" not in available:
            for route in routes.values():
                for op, value in route["operations"].items():
                    if op != "file-visible":
                        value["state"] = "needs-setup"
                        value["reasons"].append("missing-tool:terminal")
    except (ValueError, TypeError, ImportError):
        for route in routes.values():
            for value in route["operations"].values():
                value["state"] = "unknown"
                value["reasons"].append("tool-selection-unverified")
    return {"runtime": {key: target[key] for key in ("kind", "generation")}, "commands": commands,
            "bundled": bundled, "verified_bundled": verified, "routes": routes}
