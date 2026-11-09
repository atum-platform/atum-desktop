#!/usr/bin/env python3
"""Verify a SHA-256-pinned source tar archive against its extracted H2 source tree."""

from __future__ import annotations

import hashlib
import os
from pathlib import PurePosixPath
import stat
import sys
import tarfile

PROVENANCE_MARKER = ".h2-source-sha256"

def fail(message: str) -> None:
    raise SystemExit(f"h2-archive-inputs: {message}")


def digest_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def digest_stream(stream: object) -> str:
    digest = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


def member_parts(name: str) -> tuple[str, ...]:
    value = PurePosixPath(name)
    if value.is_absolute() or not name or any(part in {"", ".", ".."} for part in value.parts):
        fail("archive member path escapes source root")
    return value.parts


def within(root: str, target: str) -> bool:
    try:
        return os.path.commonpath((root, target)) == root
    except ValueError:
        return False


def local_target(root: str, parts: tuple[str, ...]) -> str:
    current = root
    for component in parts[:-1]:
        current = os.path.join(current, component)
        try:
            mode = os.lstat(current).st_mode
        except FileNotFoundError:
            fail(f"archive member missing from extracted source: {'/'.join(parts)}")
        if not stat.S_ISDIR(mode):
            fail(f"archive member has non-directory parent: {'/'.join(parts)}")
    target = os.path.normpath(os.path.join(root, *parts))
    if not within(root, target):
        fail("archive member path escapes source root")
    return target


def verify_link(root: str, parts: tuple[str, ...], link: str) -> None:
    if PurePosixPath(link).is_absolute():
        fail(f"archive symlink escapes source root: {'/'.join(parts)}")
    resolved = os.path.normpath(os.path.join(root, *parts[:-1], link))
    if not within(root, resolved):
        fail(f"archive symlink escapes source root: {'/'.join(parts)}")


def verify_no_extra_entries(root: str, archived: set[tuple[str, ...]], expected_digest: str) -> None:
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in [*directories, *files]:
            target = os.path.join(directory, name)
            relative = os.path.relpath(target, root).replace(os.sep, "/")
            parts = member_parts(relative)
            mode = os.lstat(target).st_mode
            if stat.S_ISDIR(mode):
                continue
            if parts in archived:
                continue
            if parts == (PROVENANCE_MARKER,) and stat.S_ISREG(mode):
                with open(target, "r", encoding="ascii") as marker:
                    if marker.read() == f"{expected_digest}\n":
                        continue
            fail(f"unarchived source entry: {relative}")


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        fail("usage: h2-verify-source-archive.py ARCHIVE SHA256 EXTRACTED_SOURCE")
    archive, expected, source = argv[1:]
    if not os.path.isfile(archive) or not os.path.isdir(source):
        fail("archive or extracted source is absent")
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
        fail("archive SHA-256 must be lowercase hex")
    if digest_file(archive) != expected:
        fail("archive SHA-256 mismatch")

    root = os.path.realpath(source)
    seen: set[tuple[str, ...]] = set()
    try:
        with tarfile.open(archive, "r:*") as bundle:
            for member in bundle:
                parts = member_parts(member.name)
                if parts in seen:
                    fail(f"duplicate archive member: {member.name}")
                seen.add(parts)
                target = local_target(root, parts)
                mode = os.lstat(target).st_mode
                if member.isdir():
                    if not stat.S_ISDIR(mode):
                        fail(f"archive directory mismatch: {member.name}")
                elif member.isfile():
                    if not stat.S_ISREG(mode) or os.path.getsize(target) != member.size:
                        fail(f"archive file mismatch: {member.name}")
                    if mode & 0o111 != member.mode & 0o111:
                        fail(f"archive executable-bit mismatch: {member.name}")
                    stream = bundle.extractfile(member)
                    if stream is None or digest_stream(stream) != digest_file(target):
                        fail(f"archive file content mismatch: {member.name}")
                elif member.issym():
                    verify_link(root, parts, member.linkname)
                    if not stat.S_ISLNK(mode) or os.readlink(target) != member.linkname:
                        fail(f"archive symlink mismatch: {member.name}")
                else:
                    fail(f"unsupported archive member type: {member.name}")
            verify_no_extra_entries(root, seen, expected)
    except (OSError, tarfile.TarError) as error:
        fail(f"cannot verify archive: {error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
