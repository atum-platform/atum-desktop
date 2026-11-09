#!/usr/bin/env python3
"""Focused executable tests for the H2 source-archive verifier."""

from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("h2-verify-source-archive.py")


class SourceArchiveTest(unittest.TestCase):
    def make_archive(self, root: Path) -> tuple[Path, str]:
        archive = root.parent / "source.tar"
        with tarfile.open(archive, "w") as bundle:
            bundle.add(root / "app", arcname="app", recursive=True)
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

    def verify(self, archive: Path, digest: str, source: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(archive), digest, str(source)],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_refuses_an_unarchived_extracted_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            (root / "app").mkdir(parents=True)
            (root / "app" / "build-input.txt").write_text("pinned\n", encoding="utf-8")
            archive, digest = self.make_archive(root)
            self.assertEqual(self.verify(archive, digest, root).returncode, 0)
            (root / "extra-docker-input").write_text("injected\n", encoding="utf-8")
            result = self.verify(archive, digest, root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unarchived source entry: extra-docker-input", result.stderr)

    def test_refuses_an_unarchived_extracted_symlink_and_executable_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            (root / "app").mkdir(parents=True)
            input_file = root / "app" / "build-input.txt"
            input_file.write_text("pinned\n", encoding="utf-8")
            archive, digest = self.make_archive(root)
            (root / "extra-link").symlink_to("app/build-input.txt")
            result = self.verify(archive, digest, root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unarchived source entry: extra-link", result.stderr)
            (root / "extra-link").unlink()
            input_file.chmod(0o755)
            result = self.verify(archive, digest, root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("archive executable-bit mismatch: app/build-input.txt", result.stderr)


if __name__ == "__main__":
    unittest.main()
