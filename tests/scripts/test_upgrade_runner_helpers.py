"""Bounded synthetic probes; no release installs or upgrade scenarios run here."""
import json
import contextlib
import os
import signal
import subprocess
import sys
from unittest.mock import MagicMock
from types import SimpleNamespace

import pytest

from tests.e2e.core.upgrade.git import test_partial_clone as partial
from tests.e2e.core.upgrade.test_fresh_process_entrypoints import _IMPORT_RUNNER, _import_budget


def test_migration_oracle_uses_running_interpreter(tmp_path, monkeypatch):
    from tests.e2e.core.upgrade import test_upgrade_path as upgrade

    leg = SimpleNamespace(root=tmp_path, hermes_home=tmp_path / "home")
    def run(argv, **kwargs):
        assert argv[0] == sys.executable
        return subprocess.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(upgrade.H, "run", run)
    assert upgrade.migrate_oracle(leg, "default", b"# user config\n") == b"# user config\n"


def test_migration_oracle_executes_head_migration_in_disposable_home(tmp_path):
    from hermes_cli.config_defaults import DEFAULT_CONFIG
    from tests.e2e.core.upgrade import test_upgrade_path as upgrade

    leg = SimpleNamespace(root=tmp_path, hermes_home=tmp_path / "home")
    before = upgrade.user_config("http://127.0.0.1:9/v1", DEFAULT_CONFIG["_config_version"] - 1).encode()
    after = upgrade.migrate_oracle(leg, "default", before)
    config = upgrade.yaml.safe_load(after)
    assert config["_config_version"] == DEFAULT_CONFIG["_config_version"]
    assert config["personalities"]["reviewer"] == upgrade.LONG_VALUE
    assert b"# Hand-edited by the user." in after


def test_legacy_shallow_preclone_is_depth_limited(tmp_path):
    from tests.e2e.core.upgrade import _install_helpers as install
    from tests.e2e.core.upgrade.git import _git_world as worlds

    sandbox = install.new_sandbox(tmp_path / "sandbox")
    source = tmp_path / "origin"
    source.mkdir()
    env = sandbox.env
    install.git("init", "-q", "-b", "main", cwd=source, env=env)
    install.git("config", "uploadpack.allowFilter", "true", cwd=source, env=env)
    for n in range(3):
        (source / "content").write_text(str(n))
        install.git("add", ".", cwd=source, env=env)
        install.git("-c", "commit.gpgsign=false", "commit", "-qm", str(n), cwd=source, env=env)
    (sandbox.home / ".gitconfig").write_text(
        f'[url "{source.as_uri()}"]\n  insteadOf = {install.OFFICIAL_HTTPS}\n')
    worlds._preclone(sandbox, ["--depth", "1", "--single-branch"], env)
    assert install.git("rev-parse", "--is-shallow-repository", cwd=sandbox.checkout, env=env) == "true"
    assert install.git("rev-list", "--count", "HEAD", cwd=sandbox.checkout, env=env) == "1"
    # N-1's identity publication deliberately consumes this shallow shape.
    from hermes_cli.gitlock import fetch_full_commit_graph
    assert fetch_full_commit_graph(sandbox.checkout, "main", env=env)
    assert install.git("rev-parse", "--is-shallow-repository", cwd=sandbox.checkout, env=env) == "false"
    assert install.git("config", "--get", "remote.origin.promisor", cwd=sandbox.checkout, env=env) == "true"
    assert install.git("config", "--get", "remote.origin.partialclonefilter", cwd=sandbox.checkout, env=env) == "blob:none"
    assert install.git("rev-list", "--count", "HEAD", cwd=sandbox.checkout, env=env) == install.git(
        "rev-list", "--count", "HEAD", cwd=source, env=env)


def test_import_budget_scales_with_work_and_stays_within_file_envelope():
    assert _import_budget(100, 1, 180) > _import_budget(10, 1, 180)
    assert _import_budget(100, 2, 180) < _import_budget(100, 1, 180)
    assert _import_budget(100_000, 1, 180) == 2700


def test_tenancy_children_keep_install_guard_but_scrub_credentials(tmp_path, monkeypatch):
    from tests.e2e.core.tenancy._helpers import hermetic_env

    monkeypatch.setenv("HERMES_DISABLE_LAZY_INSTALLS", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-parent-canary")
    env = hermetic_env(tmp_path)
    assert env["HERMES_DISABLE_LAZY_INSTALLS"] == "1"
    assert "OPENAI_API_KEY" not in env


@pytest.mark.parametrize("shape", partial.SHAPES)
def test_partial_fixture_stages_only_requested_shape_and_retires_it(tmp_path, monkeypatch, shape):
    cm = MagicMock()
    calls = []
    def scenario(root, shape):
        root.mkdir()
        calls.append(shape)
        return {"cm": cm}
    monkeypatch.setattr(partial, "_scenario", scenario)
    fixture = partial.runs.__wrapped__(tmp_path, shape)
    assert set(next(fixture)) == {shape}
    assert calls == [shape]
    with pytest.raises(StopIteration):
        next(fixture)
    cm.__exit__.assert_called_once_with(None, None, None)
    assert not (tmp_path / "git-partial").exists()


@pytest.mark.platforms("posix")
def test_import_diagnostic_names_blocked_module_and_dumps_parent_stack(tmp_path):
    (tmp_path / "blocked.py").write_text("from threading import Event\nEvent().wait()\n")
    spec = {"tree": str(tmp_path), "first_party": ["blocked"], "preload": [], "workers": 1,
            "timeout": 1, "dump_after": 0.1, "out": str(tmp_path / "out.json"),
            "modules": [{"id": "blocked", "kind": "name", "name": "blocked"}]}
    (tmp_path / "spec.json").write_text(json.dumps(spec))
    with subprocess.Popen([sys.executable, "-c", _IMPORT_RUNNER, str(tmp_path / "spec.json")],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True) as proc:
        try:
            out, err = proc.communicate(timeout=10)
        finally:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
        assert proc.returncode == 0, err
    assert "import start blocked" in out and "import timeout blocked" in out
    assert "Timeout" in err and "<string>" in err
    assert json.loads((tmp_path / "out.json").read_text())[0]["type"] == "Timeout"


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("outcome", ["success", "failure", "timeout"])
def test_sandbox_command_retires_descendants(tmp_path, monkeypatch, outcome):
    """An exited launcher and a timeout must both retire a still-listening child."""
    import socket
    from tests.e2e.core.upgrade import _helpers as helpers

    # Exercise process-group cleanup even on Linux hosts that also have bwrap.
    monkeypatch.setattr(helpers, "BWRAP_OK", False)
    endpoint = tmp_path / "endpoint"
    child = (
        "import socket, signal; s=socket.socket(); s.bind(('127.0.0.1', 0)); "
        "s.listen(); print(s.getsockname()[1], flush=True); signal.pause()"
    )
    parent = (
        "import subprocess, sys, pathlib, signal; "
        "p=subprocess.Popen([sys.executable, '-c', sys.argv[1]], "
        "stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True); "
        "pathlib.Path(sys.argv[2]).write_text(p.stdout.readline(), encoding='utf-8'); "
        + ("signal.pause()" if outcome == "timeout" else
           f"sys.exit({1 if outcome == 'failure' else 0})")
    )
    argv = [sys.executable, "-c", parent, child, str(endpoint)]
    kwargs = dict(env=helpers.isolated_env(tmp_path), cwd=tmp_path, writable=[tmp_path], timeout=5)
    if outcome == "timeout":
        with pytest.raises(AssertionError, match="timed out"):
            helpers.run(argv, **kwargs)
    else:
        result = helpers.run(argv, **kwargs)
        assert result.returncode == (1 if outcome == "failure" else 0)
    port = int(endpoint.read_text(encoding="utf-8"))
    from tests.waiting import wait_until

    def stopped():
        with socket.socket() as probe:
            probe.settimeout(2)
            return probe.connect_ex(("127.0.0.1", port)) != 0

    wait_until(stopped, timeout=5, what="descendant listener closed after group kill")


@pytest.mark.live_system_guard_bypass
def test_main_channel_check_uses_local_origin_with_http_unavailable(tmp_path):
    """The lifecycle suite's channel setting survives a fresh production check process."""
    from tests.e2e.core.upgrade import _install_helpers as install

    source = tmp_path / "origin"
    source.mkdir()
    sandbox = install.new_sandbox(tmp_path / "sandbox", source, pythonpath=install.H.WORKTREE)
    env = {**sandbox.env, "HTTPS_PROXY": "http://127.0.0.1:9",
           "HTTP_PROXY": "http://127.0.0.1:9", "NO_PROXY": ""}
    install.git("init", "-q", "-b", "main", cwd=source, env=env)
    install.git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture", "--allow-empty", cwd=source, env=env)
    install.git("clone", "-q", install.OFFICIAL_HTTPS, str(sandbox.checkout), cwd=sandbox.root, env=env)
    # Inject only the install root. The CLI parser, persisted channel selection and
    # update-check implementation run unchanged in two fresh interpreters.
    entry = ("import sys; from pathlib import Path; from hermes_cli import main; "
             "main.PROJECT_ROOT=Path(sys.argv.pop(1)); main.main()")
    argv = [sys.executable, "-c", entry, str(sandbox.checkout), "update"]
    first = sandbox.run([*argv, "--set-channel", "main"], env=env)
    assert first.returncode == 0, install.describe(first)
    second = sandbox.run([*argv, "--check"], env=env)
    assert second.returncode == 0, install.describe(second)
    assert "Already up to date" in second.stdout, install.describe(second)


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("driver", ["pm", "parity"])
def test_gateway_stop_kills_group_after_launcher_exit(monkeypatch, driver):
    from tests.e2e.core.upgrade.pm import _pm

    gateway = object.__new__(_pm.Gateway)
    gateway.proc = SimpleNamespace(pid=123456789, poll=lambda: 0, wait=MagicMock())
    gateway._out = MagicMock()
    signals = []
    monkeypatch.setattr(os, "killpg", lambda pid, sig: signals.append((pid, sig)))
    if driver == "pm":
        gateway.stop()
    else:
        from tests.e2e.core.parity import _drive_gateway
        gateway.proc._parity_log = gateway._out
        _drive_gateway._stop(None, gateway.proc)
    assert signals == [(gateway.proc.pid, signal.SIGKILL)]
    gateway.proc.wait.assert_called_once()
    gateway._out.close.assert_called_once()


def test_host_gateway_start_failure_stops_process(tmp_path, monkeypatch):
    from tests.e2e.core.upgrade.hosts import _hosts

    sb = SimpleNamespace(root=tmp_path, hermes_home=tmp_path, hermes="fixture-hermes", env={})
    gateway = _hosts.Gateway(sb)
    stopped = MagicMock()
    monkeypatch.setattr(gateway, "stop", stopped)
    monkeypatch.setattr(_hosts.subprocess, "Popen", MagicMock(return_value=SimpleNamespace(poll=lambda: 1)))
    with pytest.raises(AssertionError, match="did not reach"):
        gateway.start(timeout=0)
    stopped.assert_called_once()
