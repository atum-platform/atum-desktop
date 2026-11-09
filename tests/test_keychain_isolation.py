"""Tests must never read the developer's macOS Keychain.

``_isolate_macos_keychain`` in ``tests/conftest.py`` answers real ``security``
secret lookups as "item not found". Every test here stays safe even if that
guard regresses: the unit tests drive it with a spy in place of the real
``subprocess.run``, the installation checks probe a service no Keychain holds,
and the end-to-end check refuses to call the real reader unless the guard
answers.
"""

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from tests.conftest import (
    _KEYCHAIN_NOT_FOUND_STATUS,
    _is_keychain_secret_read,
    _keychain_isolated_run,
)


class _SpyRun:
    def __init__(self):
        self.calls = []

    def __call__(self, args, *popenargs, **kwargs):
        self.calls.append((args, popenargs, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout="spy", stderr="")


class TestKeychainSecretReadDetection:
    @pytest.mark.parametrize(
        "args",
        [
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            ["/usr/bin/security", "find-internet-password", "-s", "example.com", "-g"],
            [Path("/usr/bin/security"), "dump-keychain", "-d"],
            "security find-generic-password -s 'Claude Code-credentials' -w",
            b"security export -k login.keychain",
            ["env", "security", "find-generic-password", "-w"],
            ["sudo", "/usr/bin/security", "dump-keychain"],
            ["bash", "-c", "security find-generic-password -s 'Claude Code-credentials' -w | head -1"],
            ["security", "find-generic-password", "-l", "Bob's key", "-w"],
            "security find-generic-password -l Bob's -w",
        ],
    )
    def test_secret_reads_are_detected(self, args):
        assert _is_keychain_secret_read(args)

    @pytest.mark.parametrize(
        "args",
        [
            ["security", "list-keychains"],
            ["security"],
            ["git", "find-generic-password"],
            ["bash", "-c", "security list-keychains"],
            ["grep", "-r", "security-find-generic-password", "."],
            "unterminated 'quote",
            [object()],
        ],
    )
    def test_other_commands_pass_through(self, args):
        assert not _is_keychain_secret_read(args)


class TestKeychainIsolatedRun:
    def test_secret_read_never_reaches_the_real_run(self):
        spy = _SpyRun()
        run = _keychain_isolated_run(spy)

        result = run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True,
            text=True,
            timeout=5,
        )

        assert spy.calls == []
        assert result.returncode == _KEYCHAIN_NOT_FOUND_STATUS
        assert result.stdout == ""
        assert "could not be found" in result.stderr

    def test_bytes_output_without_text_mode(self):
        result = _keychain_isolated_run(_SpyRun())(
            ["security", "find-generic-password", "-w"], capture_output=True,
        )
        assert result.stdout == b""
        assert isinstance(result.stderr, bytes)

    def test_uncaptured_streams_stay_none(self):
        result = _keychain_isolated_run(_SpyRun())(["security", "dump-keychain"])
        assert result.stdout is None and result.stderr is None

    def test_check_raises_like_a_missing_item(self):
        run = _keychain_isolated_run(_SpyRun())
        with pytest.raises(subprocess.CalledProcessError) as excinfo:
            run(["security", "find-generic-password", "-w"], capture_output=True, check=True)
        assert excinfo.value.returncode == _KEYCHAIN_NOT_FOUND_STATUS

    def test_other_commands_reach_the_real_run_unchanged(self):
        spy = _SpyRun()
        run = _keychain_isolated_run(spy)

        result = run(["git", "status"], "positional", capture_output=True, text=True)

        assert spy.calls == [(["git", "status"], ("positional",), {"capture_output": True, "text": True})]
        assert result.stdout == "spy"


# A service name no Keychain holds: if the guard is ever missing, probing with
# it reaches the real ``security`` binary but can only come back "not found".
_ABSENT_SERVICE = "hermes-tests-keychain-guard-probe-absent"


def _guard_answers_keychain_reads() -> bool:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", _ABSENT_SERVICE, "-w"],
        capture_output=True, text=True,
    )
    return getattr(result, "hermes_keychain_isolated", False)


class TestAutouseGuardIsInstalled:
    def test_real_subprocess_run_is_answered_by_the_guard(self):
        assert _guard_answers_keychain_reads()

    def test_check_output_is_covered_through_run(self):
        with pytest.raises(subprocess.CalledProcessError) as excinfo:
            subprocess.check_output(["security", "find-generic-password", "-s", _ABSENT_SERVICE, "-w"])
        assert excinfo.value.returncode == _KEYCHAIN_NOT_FOUND_STATUS
        assert getattr(excinfo.value, "hermes_keychain_isolated", False)

    @pytest.mark.allow_macos_keychain
    def test_keychain_simulation_by_patching_run_still_works(self):
        """Tests that fake ``security`` output keep layering over the guard."""
        from agent.anthropic_credentials import _read_claude_code_credentials_from_keychain

        fake = subprocess.CompletedProcess(
            [], 0, stdout=(
                '{"claudeAiOauth": {'
                '"accessToken": "sk-ant-oat-fake", '
                '"refreshToken": "refresh-fake", '
                '"expiresAt": 9999999999999}}'
            ), stderr="",
        )
        with patch("agent.anthropic_credentials.platform.system", return_value="Darwin"), \
             patch("agent.anthropic_credentials.subprocess.run", return_value=fake):
            creds = _read_claude_code_credentials_from_keychain()
        assert creds is not None
        assert creds["accessToken"] == "sk-ant-oat-fake"

    def test_logged_in_mac_is_invisible_to_claude_code_credential_reads(self, tmp_path, monkeypatch):
        """End to end: on a Mac whose Keychain holds a Claude Code login, the
        reader must come back empty. It refuses to run at all unless the guard
        is answering, and asserts on a bool, so a regression can neither read
        nor print a real credential."""
        if not _guard_answers_keychain_reads():
            pytest.fail("Keychain guard is not installed; refusing to call the real credential reader")
        from agent import anthropic_credentials

        monkeypatch.setattr(anthropic_credentials.Path, "home", lambda: tmp_path)
        with patch("agent.anthropic_credentials.platform.system", return_value="Darwin"):
            found_credentials = anthropic_credentials.read_claude_code_credentials() is not None
        assert not found_credentials
