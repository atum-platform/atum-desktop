"""Upgrade fixtures copy user state without copying an N-1 gateway's Unix sockets."""

import socket

import pytest

from tests.e2e.core.upgrade._install_helpers import copy_home


@pytest.mark.platforms("posix")
def test_snapshot_preserves_files_and_symlinks_but_omits_control_sockets(tmp_path, monkeypatch):
    source = tmp_path / "home"
    source.mkdir()
    (source / "config.yaml").write_text("# user settings\n")
    (source / "config-link").symlink_to("config.yaml")
    monkeypatch.chdir(source)
    with socket.socket(socket.AF_UNIX) as control:
        control.bind("gateway.sock")
        copy_home(source, tmp_path / "snapshot")
    snapshot = tmp_path / "snapshot"
    assert (snapshot / "config.yaml").read_bytes() == (source / "config.yaml").read_bytes()
    assert (snapshot / "config-link").is_symlink()
    assert not (snapshot / "gateway.sock").exists()
