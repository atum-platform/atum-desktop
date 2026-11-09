#!/usr/bin/env -S bash -c 'exec "$BASH" "$(dirname "$0")/run-in-hermes-env" python3 "$0" "$@"'
"""Render the SOUL.md texts Hermes seeds on its own into the cloud controller's JSON.

The controller must never write an engine-seeded ``SOUL.md`` back to an agent's card as if the
agent had edited it (``packages/cloud-controller/src/agent/instructions.ts``
``writeBackInstructions``). Hermes seeds ``DEFAULT_SOUL_MD`` into a home without one and upgrades
every ``_LEGACY_TEMPLATE_SOULS`` text to it in place (``hermes_cli/config.py``
``_ensure_default_soul_md``), so the controller needs exactly that set, from this one source.

Each digest is the sha256 of the text as both sides normalise it (``_normalize_soul`` here,
``homeInstructions`` there: line endings unified, BOM and outer whitespace trimmed).

    .venv/bin/python scripts/gen_engine_default_soul.py           # write
    .venv/bin/python scripts/gen_engine_default_soul.py --check   # exit 1 when stale

``tests/hermes_cli/test_engine_default_soul_generated.py`` fails when the committed file is stale.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hermes_cli.default_soul import DEFAULT_SOUL_MD, _LEGACY_TEMPLATE_SOULS, _normalize_soul

OUT = ROOT / "packages" / "cloud-controller" / "src" / "agent" / "engine-default-soul.generated.json"


def render() -> str:
    texts = [DEFAULT_SOUL_MD, *_LEGACY_TEMPLATE_SOULS]
    digests = []
    for text in texts:
        digest = hashlib.sha256(_normalize_soul(text).encode("utf-8")).hexdigest()
        if digest not in digests:
            digests.append(digest)
    document = {
        "generatedBy": "scripts/gen_engine_default_soul.py from hermes_cli/default_soul.py (DO NOT EDIT)",
        "default": _normalize_soul(DEFAULT_SOUL_MD),
        "seededSha256": digests,
    }
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    text = render()
    current = OUT.read_text(encoding="utf-8-sig") if OUT.exists() else None
    if "--check" in argv:
        if current != text:
            print(f"stale: {OUT.relative_to(ROOT)} (run scripts/gen_engine_default_soul.py)", file=sys.stderr)
            return 1
        return 0
    if current != text:
        OUT.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
