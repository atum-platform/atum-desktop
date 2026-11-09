"The provenance stamp: what an installed pet *is*, written by its installer.\n\nPlan  D1. Identity\nis intrinsic — the stamp records (source, identifier) and the content hash\n— so a directory's name is never identity: renaming, re-spelling or moving a\npet cannot change what the entitlement gate thinks it is.\n\nThe stamp is a **dotfile**. hermes_cli.atum_pet_bundles.export_pet_bundle\nrefuses any non-dot file it does not know, and skips dotfiles, so the stamp\nneither breaks the content sync nor changes the pet's content hash.\n\nOnly writers stamp (install_pet, register_local_pet, the hatch,\ninstall_pet_bundle); _publish_pet_dir refuses a staging directory\nwithout one. Nothing else touches it.\n"

from __future__ import annotations

import json
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

PROVENANCE_FILE = ".atum-provenance.json"
STAMP_VERSION = 1

# The sync sidecar's ``ref.kind`` vocabulary, so one pet is never classified
# two ways: ``personal`` (generated, hatched, or restored personal content),
# ``bundled`` (copied from the app's bundle), ``petdex`` (downloaded), and
# ``catalog`` (cloud-byte catalog content installed from the account).
SOURCES = frozenset({"personal", "bundled", "petdex", "catalog"})


@dataclass(frozen=True)
class Stamp:
    kind: str
    source: str
    identifier: str
    tree_sha256: str
    stamped_at: int
    v: int = STAMP_VERSION

    @property
    def catalog_identifier(self) -> str | None:
        """The identity the entitlement gate matches on, or ``None`` for
        content the catalog can only recognise by its bytes."""
        return self.identifier if self.source in ("bundled", "catalog") else None


def read_stamp(directory: Path) -> Stamp | None:
    """The stamp in *directory*, or ``None`` when absent or unreadable."""
    path = directory / PROVENANCE_FILE
    try:
        if path.is_symlink() or not path.is_file():
            return None
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("v") != STAMP_VERSION:
        return None
    try:
        source = str(raw["source"])
        identifier = str(raw["identifier"])
        tree_sha256 = str(raw["tree_sha256"])
        kind = str(raw.get("kind", "pet"))
        stamped_at = int(raw.get("stamped_at", 0))
    except (KeyError, TypeError, ValueError):
        return None
    if source not in SOURCES or not identifier or len(tree_sha256) != 64:
        return None
    return Stamp(kind=kind, source=source, identifier=identifier, tree_sha256=tree_sha256, stamped_at=stamped_at)


def write_stamp(directory: Path, stamp: Stamp) -> None:
    """Write the stamp atomically (tempfile + ``os.replace``), mode 0600."""
    payload = {
        "v": stamp.v,
        "kind": stamp.kind,
        "source": stamp.source,
        "identifier": stamp.identifier,
        "tree_sha256": stamp.tree_sha256,
        "stamped_at": stamp.stamped_at,
    }
    fd, tmp = tempfile.mkstemp(prefix=".atum-provenance-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, directory / PROVENANCE_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def make_stamp(*, kind: str, source: str, identifier: str, tree_sha256: str) -> Stamp:
    if source not in SOURCES:
        raise ValueError(f"unknown provenance source {source!r}")
    return Stamp(kind=kind, source=source, identifier=identifier, tree_sha256=tree_sha256, stamped_at=int(time.time()))
