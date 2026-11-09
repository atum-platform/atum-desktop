"""The company Chief of Staff's domain tools (COS-FULL-POWER, C1a bootstrap).

Footprint rung 4: a bundled plugin enabled only by the configuration the Atum cloud controller
writes for a company turn (``plugins.enabled: [atum-company]``), like ``atum-device`` for the
device tools. Every other Hermes surface, and every personal agent, is unchanged.

The plugin owns no tool of its own. It registers the domain modules named in
``ACCEPTED_MODULES`` -- the Python half of the controller's ``accepted-adapters.ts`` table -- in
that order, each as one tool with ``override=False`` (it can never replace a native tool). A module
exports ``TOOL_NAME``, ``TOOLSET``, ``SCHEMA`` and ``handle(arguments)`` and does NOT register
itself at import. A domain that is not yet accepted is simply absent from the tuple: it is never
imported, so an unbuilt module cannot block the native baseline. The tuple starts empty, so this
plugin registers nothing until C7 adds an entry after that domain's real-boundary acceptance.

Duplicate module or tool names are refused here, before the first agent snapshot, because a
silently shadowed tool would change the cached tool schema.
"""

from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from types import ModuleType
from typing import Optional
from collections.abc import Callable, Sequence

logger = logging.getLogger(__name__)

# Deterministic order (T0 startup step 4): board, files, brain, people. C7 adds names here only.
ACCEPTED_MODULES: Sequence[str] = ()
KNOWN_MODULES = ("board", "files", "brain", "people")
_REQUIRED = ("TOOL_NAME", "TOOLSET", "SCHEMA", "handle")


def _always() -> bool:
    # Presence of the plugin IS the company capability: the controller enables it for company turns only.
    return True


def _load(name: str, root: Path) -> ModuleType:
    path = root / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"atum_company_{name}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"atum-company module {name!r} cannot be loaded from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def accepted_modules(
    names: Optional[Sequence[str]] = None,
    loader: Optional[Callable[[str], ModuleType]] = None,
) -> dict[str, ModuleType]:
    """Load the accepted domain modules in order, refusing an unknown, duplicate or incomplete one."""
    names = ACCEPTED_MODULES if names is None else names
    load = loader or (lambda name: _load(name, Path(__file__).parent))
    seen_modules: set = set()
    seen_tools: set = set()
    loaded: dict[str, ModuleType] = {}
    for name in names:
        if name not in KNOWN_MODULES:
            raise ValueError(f"atum-company: unknown module {name!r}")
        if name in seen_modules:
            raise ValueError(f"atum-company: duplicate module {name!r}")
        seen_modules.add(name)
        module = load(name)
        missing = [attr for attr in _REQUIRED if not hasattr(module, attr)]
        if missing:
            raise ValueError(f"atum-company: module {name!r} lacks {', '.join(missing)}")
        if module.TOOL_NAME in seen_tools:
            raise ValueError(f"atum-company: duplicate tool {module.TOOL_NAME!r}")
        seen_tools.add(module.TOOL_NAME)
        loaded[name] = module
    return loaded


def register(ctx) -> None:
    for module in accepted_modules().values():
        ctx.register_tool(
            name=module.TOOL_NAME,
            toolset=module.TOOLSET,
            schema=module.SCHEMA,
            handler=module.handle,
            check_fn=_always,
            override=False,
        )
