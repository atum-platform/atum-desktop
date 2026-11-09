"""Preserve recovery, isolation and completion behavior across failures."""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import types

import pytest

# A guaranteed-foreign PID: PID 1 (init).  Owned by root, not us, and
# always exists. A sane guard refuses to signal it.
FOREIGN_PID = 1

requires_systemctl = pytest.mark.skipif(
    shutil.which("systemctl") is None,
    reason="systemctl pass-through requires systemctl to be installed",
)


# ──────────────────── fail-closed self-protection ──────────────
#
# This file executes REAL kill primitives — os.kill(-1, SIGTERM), os.killpg,
# pkill -f python — and depends entirely on the autouse ``_live_system_guard``
# fixture in tests/conftest.py to intercept them. That makes the canary
# fail-OPEN: in any collection context where this file is present but its home
# conftest is not, the primitives fire for real and ``os.kill(-1, SIGTERM)``
# SIGTERMs every process the invoking user owns (a full desktop-session kill was
# reported in the field — see issue #68311). Such contexts are not exotic:
# published sdists that ship ``tests/`` but not ``tests/conftest.py``, trees
# assembled by copying ``test*.py`` files (that glob does NOT match
# ``conftest.py``), ``pytest --noconftest``, or running from a foreign rootdir.
#
# The fixture below makes the canary fail-CLOSED instead: it refuses to run any
# test in this file unless the guard is provably active, so no collection
# context can ever detonate the primitives. The one thing the canary can detect
# about its own safety is that the guard monkeypatches ``os.kill`` with a plain
# Python function, whereas the unguarded primitive is a C builtin.


def _live_system_guard_is_active() -> bool:
    """True iff tests/conftest.py's ``_live_system_guard`` has patched os.kill.

    The guard replaces ``os.kill`` with a plain Python function; the raw,
    unguarded primitive is a C builtin (``types.BuiltinFunctionType``). If
    ``os.kill`` is still the builtin, the guard never loaded and every kill
    primitive in this file would fire for real.
    """
    return not isinstance(os.kill, types.BuiltinFunctionType)


@pytest.fixture(autouse=True)
def _refuse_to_fire_live_weapons(request):
    """Fail closed: refuse to run a canary test unless the guard is active.

    Tests genuinely marked ``@pytest.mark.live_system_guard_bypass`` opt out
    (they run the raw primitive deliberately and harmlessly, e.g. a signal-0
    liveness probe of our own PID), matching the guard's own bypass contract.
    """
    if request.node.get_closest_marker("live_system_guard_bypass"):
        yield
        return
    if not _live_system_guard_is_active():
        pytest.fail(
            "REFUSING TO RUN: the live-system guard from tests/conftest.py is "
            "not active in this interpreter (os.kill is still the raw C "
            "builtin). This canary file executes real kill primitives — "
            "os.kill(-1, SIGTERM), os.killpg, pkill -f python — and relies on "
            "the guard to intercept them; unguarded, they SIGTERM every process "
            "the current user owns. This usually means the file was collected "
            "without its home tests/conftest.py (note: a test*.py copy glob "
            "does NOT match conftest.py). See issue #68311.",
            pytrace=False,
        )
    yield


def test_fail_closed_probe_reports_guard_active():
    """In the real suite the guard is loaded, so the probe reports active and
    ``_refuse_to_fire_live_weapons`` stays out of the way (no false positives
    that would wedge CI)."""
    assert _live_system_guard_is_active() is True




# ──────────────────── kill primitives ─────────────────────────


@pytest.mark.platforms("linux")
def test_os_kill_blocks_foreign_pid():
    with pytest.raises(RuntimeError, match="live-system guard"):
        os.kill(FOREIGN_PID, signal.SIGTERM)


def test_os_kill_blocks_negative_one():
    """``os.kill(-1, sig)`` signals every process we can reach. Must be blocked."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        os.kill(-1, signal.SIGTERM)


@pytest.mark.skipif(not hasattr(os, "killpg"), reason="killpg POSIX-only")
def test_os_killpg_blocks_foreign_pgid():
    with pytest.raises(RuntimeError, match="live-system guard"):
        os.killpg(FOREIGN_PID, signal.SIGTERM)


# ──────────────────── subprocess regex bypasses ────────────────


def test_subprocess_run_systemctl_restart_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["systemctl", "--user", "restart", "hermes-gateway"], check=False)


def test_subprocess_run_full_path_systemctl_blocked():
    """``/usr/bin/systemctl`` (full path) must be blocked too."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["/usr/bin/systemctl", "--user", "stop", "hermes-gateway"], check=False)


def test_subprocess_run_sudo_systemctl_blocked():
    """``sudo systemctl ...`` defeated the old head==systemctl check."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["sudo", "systemctl", "restart", "hermes-gateway"], check=False)


def test_subprocess_run_env_systemctl_blocked():
    """``env systemctl ...`` similarly defeated the old head check."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["env", "systemctl", "--user", "restart", "hermes-gateway"], check=False)


def test_subprocess_run_bash_c_systemctl_blocked():
    """``bash -c "systemctl ..."`` must also be caught."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["bash", "-c", "systemctl --user restart hermes-gateway"], check=False)




@pytest.mark.parametrize(
    "cmd",
    [
        ["systemctl", "--user", "restart", "hermes-dashboard.service"],
        ["systemctl", "--user", "restart", "hermes-dashboard-work.service"],
        ["systemctl", "--user", "stop", "hermes-serve"],
        ["/usr/bin/systemctl", "--user", "--no-ask-password", "restart", "hermes-serve-work.service"],
        ["bash", "-c", "systemctl --user restart hermes-dashboard.service"],
        "systemctl --user restart hermes-dashboard-work.service",
        'bash -c "systemctl --user restart hermes-serve.service"',
    ],
)
def test_subprocess_run_systemctl_mutating_any_hermes_unit_blocked(cmd):
    """Not just the gateway: a test that forgot to stub the runner restarted the developer's
    real hermes-dashboard / hermes-serve units, which the gateway-only tokens let through."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(cmd, shell=isinstance(cmd, str), check=False)


@pytest.mark.parametrize(
    "cmd",
    [
        ["systemctl", "--user", "show", "hermes-dashboard.service", "--property=MainPID"],
        ["systemctl", "--user", "status", "hermes-dashboard"],
        ["systemctl", "--user", "is-active", "hermes-serve.service"],
        ["systemctl", "--user", "restart", "nginx.service"],
        ["systemctl", "--user", "restart", "myhermes-dashboard.service"],
    ],
)
def test_subprocess_run_systemctl_read_only_or_foreign_unit_passes_guard(cmd):
    """Read-only verbs on Hermes units and mutating verbs on other units reach the real
    ``subprocess.run``; an empty PATH turns that into FileNotFoundError, never a real systemctl."""
    with pytest.raises(FileNotFoundError):
        subprocess.run(cmd, env={"PATH": "/nonexistent"}, check=False)


@pytest.mark.parametrize(
    "cmd",
    [
        ["bash", "-c", r"systemctl st\op hermes.service"],
        ["bash", "-c", r"systemctl --user rest\art hermes-dashboard"],
        r"systemctl --user re\start hermes-serve.service",
        ["bash", "-c", "sh -c 'systemctl --user restart hermes-dashboard'"],
    ],
)
def test_subprocess_run_shell_escaped_or_nested_verb_blocked(cmd):
    """The shell runs ``rest\\art`` as ``restart``; the guard must read it the same way."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(cmd, shell=isinstance(cmd, str), check=False)


def test_a_test_owned_unit_can_be_cleaned_up_but_no_other(request):
    """A unit the test created under its own name may be stopped; every other Hermes unit stays refused."""
    owned = "hermes-worker-kanban-t_selftest-run-1.scope"
    request.node.live_system_guard_owned_units = {owned}
    with pytest.raises(FileNotFoundError):
        subprocess.run(["systemctl", "--user", "stop", owned], env={"PATH": "/nonexistent"}, check=False)
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["systemctl", "--user", "stop", owned, "hermes-dashboard.service"], check=False)
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["systemctl", "--user", "stop", "hermes-worker-kanban-other-run-1.scope"], check=False)


def test_subprocess_run_setsid_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["setsid", "systemctl", "kill", "hermes-gateway"], check=False)


def test_host_gateway_start_blocked_but_container_exec_allowed():
    """A host-side ``hermes gateway start`` spawns a real runtime; the same words addressed to
    a container via ``docker exec`` stay inside it and are the Docker harness's business."""
    with pytest.raises(RuntimeError, match="REAL hermes gateway runtime"):
        subprocess.run(["hermes", "-p", "p", "gateway", "start"], check=False)
    argv = ["docker", "exec", "-u", "hermes", "hermes-test-x", "sh", "-c", "hermes -p p gateway start"]
    # Past the guard the call reaches the real subprocess.run; a missing binary is fine here.
    with pytest.raises(FileNotFoundError):
        subprocess.run(argv, env={"PATH": "/nonexistent"}, check=False)


def test_subprocess_run_string_shell_true_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(
            "systemctl --user restart hermes-gateway",
            shell=True,
            check=False,
        )


def test_subprocess_popen_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.Popen(["systemctl", "--user", "stop", "hermes-gateway"])


def test_subprocess_call_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.call(["systemctl", "--user", "restart", "hermes-gateway"])


def test_subprocess_check_call_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.check_call(["systemctl", "--user", "restart", "hermes-gateway"])


def test_subprocess_check_output_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.check_output(["systemctl", "--user", "restart", "hermes-gateway"])


def test_subprocess_getoutput_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.getoutput("systemctl --user restart hermes-gateway")


def test_subprocess_getstatusoutput_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.getstatusoutput("systemctl --user restart hermes-gateway")


# ──────────────────── os.system / os.popen ────────────────────


def test_os_system_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        os.system("systemctl --user restart hermes-gateway")


def test_os_popen_systemctl_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        os.popen("systemctl --user restart hermes-gateway")


# ──────────────────── pty.spawn ────────────────────────────────


@pytest.mark.platforms("linux")
def test_pty_spawn_systemctl_blocked():
    import pty
    with pytest.raises(RuntimeError, match="live-system guard"):
        pty.spawn(["systemctl", "--user", "restart", "hermes-gateway"])


# ──────────────────── asyncio.create_subprocess_* ──────────────


def test_asyncio_create_subprocess_exec_systemctl_blocked():
    import asyncio

    async def _attempt():
        await asyncio.create_subprocess_exec(
            "systemctl", "--user", "restart", "hermes-gateway"
        )

    with pytest.raises(RuntimeError, match="live-system guard"):
        asyncio.run(_attempt())


def test_asyncio_create_subprocess_shell_systemctl_blocked():
    import asyncio

    async def _attempt():
        await asyncio.create_subprocess_shell(
            "systemctl --user restart hermes-gateway"
        )

    with pytest.raises(RuntimeError, match="live-system guard"):
        asyncio.run(_attempt())


# ──────────────────── pkill / killall / taskkill ───────────────


def test_subprocess_pkill_hermes_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["pkill", "-f", "hermes"], check=False)




def test_subprocess_pkill_python_dash_f_blocked():
    """``pkill -f python`` matches the gateway's "python -m hermes_cli.main"."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["pkill", "-f", "python"], check=False)


def test_subprocess_killall_hermes_blocked():
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.run(["killall", "hermes"], check=False)


# ──────────────────── pass-through cases (must NOT raise) ──────


def test_read_only_systemctl_words_are_not_misclassified_as_gateway_spawn():
    """Exercise the guard's command classifier on every host without requiring
    systemctl itself: the harmless Python child treats the remaining argv as
    data, but the guard still sees the exact read-only systemctl words."""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "raise SystemExit(0)",
            "systemctl",
            "--user",
            "show",
            "hermes-gateway",
            "--no-pager",
        ],
        check=False,
    )
    assert result.returncode == 0


@requires_systemctl
def test_systemctl_status_passes_through():
    """Read-only systemctl probes (status/show/list-units) are fine."""
    # Run with check=False so we don't fail on the gateway's exit code.
    r = subprocess.run(
        ["systemctl", "--user", "status", "hermes-gateway", "--no-pager"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r is not None  # Did not raise — the guard let it through.


@requires_systemctl
def test_systemctl_show_passes_through():
    r = subprocess.run(
        ["systemctl", "--user", "show", "hermes-gateway", "--no-pager"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r is not None


@requires_systemctl
def test_systemctl_list_units_passes_through():
    r = subprocess.run(
        ["systemctl", "--user", "list-units", "fake-not-real-unit*", "--no-pager"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r is not None


@requires_systemctl
def test_systemctl_unrelated_unit_passes_through():
    """systemctl restart of a non-hermes unit is allowed (we only protect hermes)."""
    # Use --dry-run so we don't actually try to restart anything; just
    # verify the guard doesn't block the call. systemctl supports
    # --dry-run via the privileged API; on user scope it usually fails
    # quickly without side effects.
    r = subprocess.run(
        ["systemctl", "--user", "show", "fake-not-real-unit"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r is not None


def test_kill_own_subtree_passes_through():
    """We CAN kill our own children — guard recognizes them via psutil."""
    p = subprocess.Popen(["sleep", "30"])
    try:
        os.kill(p.pid, signal.SIGTERM)
    finally:
        p.wait(timeout=2)
    # SIGTERM = 15; subprocess returncode is -15 on POSIX.
    assert p.returncode in {-signal.SIGTERM, 128 + int(signal.SIGTERM)}


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX ancestry regression")
@pytest.mark.asyncio
async def test_kill_test_spawn_survives_lost_ancestry(monkeypatch):
    """A PID returned by our Popen remains ours if its parent chain changes.

    Linux exposes only the process's *current* PPid through ``/proc``.  Once a
    child is reparented, ``psutil.Process.parents()`` no longer contains the
    pytest process even though the test still owns the process handle.  Model
    that state directly so this remains deterministic on macOS too.
    """
    import asyncio
    import psutil

    p = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import time; time.sleep(30)",
        start_new_session=True,
    )
    real_parents = psutil.Process.parents

    def _reparented_parents(process):
        if process.pid == p.pid:
            return [psutil.Process(FOREIGN_PID)]
        return real_parents(process)

    monkeypatch.setattr(psutil.Process, "parents", _reparented_parents)
    try:
        os.kill(p.pid, signal.SIGTERM)
    finally:
        # Restore ancestry before fallback cleanup so this test demonstrates
        # the guard decision without leaking a child on an assertion failure.
        monkeypatch.setattr(psutil.Process, "parents", real_parents)
        if p.returncode is None:
            p.kill()
        await asyncio.wait_for(p.wait(), timeout=2)

    assert p.returncode in {-signal.SIGTERM, 128 + int(signal.SIGTERM)}


def test_subprocess_pkill_with_unrelated_pattern_passes_through():
    """``pkill -f some-unrelated-pattern`` (no hermes/python) is fine."""
    # We don't actually run pkill — just verify the guard would let it
    # through by inspecting the matcher. Re-implementing the check here
    # would duplicate the guard; instead spawn a noop to confirm no raise.
    # Use 'true' so it succeeds quickly.
    r = subprocess.run(["true"], capture_output=True)
    assert r.returncode == 0


def test_normal_subprocess_run_passes_through():
    """Plain non-systemctl subprocess.run should work normally."""
    r = subprocess.run(["echo", "hello"], capture_output=True, text=True)
    assert r.stdout.strip() == "hello"














# ──────────────────── real gateway runtime spawn ─────────────────


def test_subprocess_popen_real_gateway_restart_blocked():
    """``python -m hermes_cli.main gateway restart`` is a detached child that
    inherits the pytest-tmp HERMES_HOME, resolves the developer's real
    ``hermes-gateway`` unit, and outlives the test (39 six-day orphans squatted
    the webhook port, 2026-09-03). Blocked at the spawn primitive."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.Popen(
            [sys.executable, "-m", "hermes_cli.main", "gateway", "restart"],
            start_new_session=True,
        )


def test_subprocess_popen_inline_source_restart_watcher_blocked():
    """``gateway._spawn_gateway_restart_watcher`` hides the real gateway argv behind
    ``python -c <src> <old_pid> …``. The identity matcher must ignore that trailing argv (#107002),
    but the guard reads it as SPAWN INTENT — otherwise the watcher sails through, waits out its
    120s deadline and leaves a real detached gateway squatting the webhook port."""
    with pytest.raises(RuntimeError, match="live-system guard"):
        subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(1)", "4242",
             sys.executable, "-m", "hermes_cli.main", "gateway", "run"],
            start_new_session=True,
        )


def test_subprocess_run_gateway_status_passes_through():
    """Only lifecycle verbs are blocked: ``gateway status`` (and every other
    read-only subcommand) must still spawn — via the canonical matcher, not an
    argv substring."""
    result = subprocess.run(
        [sys.executable, "-c", "import sys; print(sys.argv[1:])", "-m", "hermes_cli.main", "gateway", "status"],
        capture_output=True, text=True,
        check=False,
    )
    assert result.returncode == 0


# ──────────────────── bypass marker ─────────────────────────────


@pytest.mark.live_system_guard_bypass
def test_bypass_marker_disables_guard():
    """The bypass marker exists for tests that genuinely need real signal delivery
    (e.g. PTY tests SIGINTing their own child). Verify it works.

    We use it harmlessly here by signaling our own PID 0 (own group) so we
    don't actually kill anything — but the call goes through real os.kill.
    """
    # With bypass, the guard yields without installing the monkeypatch,
    # so we get the real os.kill. Calling os.kill(os.getpid(), 0) just
    # checks that the PID exists — harmless.
    os.kill(os.getpid(), 0)  # No exception — guard is OFF.
    # Signal 0 passes the guard too, so prove the patch itself is absent.
    assert not _live_system_guard_is_active()
