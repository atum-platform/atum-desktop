"""Hold the Work home lock and retire children when Electron's pipe closes."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import resource
import secrets
import select
import signal
import subprocess
import sys
import time


def publish(kind, **values):
    print(json.dumps(dict(kind=kind, **values)), flush=True)


def processes():
    output = subprocess.check_output(
        ["/bin/ps", "-axo", "pid=,ppid=,rss=,lstart="], text=True, timeout=5,
    )
    return {int(pid): (int(parent), int(rss), started) for pid, parent, rss, started in
            (line.split(maxsplit=3) for line in output.splitlines() if line.strip())}


OWNER_VARIABLE = "ATUM_WORK_OWNER"


def tagged(token):
    """Pids whose environment carries this supervisor's owner token.

    A helper that detaches (setsid, a double fork) is reparented to launchd and leaves the leader's process tree, so a
    walk down from the leaders cannot find it. Every child is started with the token in its environment and a
    descendant inherits it, so the token names the helper wherever it went. (Environment of Apple platform binaries is
    hidden from `ps`; none of the shipped helpers is one.)
    """
    output = subprocess.check_output(["/bin/ps", "-axwwE", "-o", "pid=,command="], text=True, timeout=3)
    needle = f"{OWNER_VARIABLE}={token}"
    found = set()
    for line in output.splitlines():
        if needle in line:
            head = line.split(maxsplit=1)[0]
            if head.isdigit():
                found.add(int(head))
    found.discard(os.getpid())
    return found


class Children:
    def __init__(self):
        self.leaders = []
        self.seen = {}
        self.token = secrets.token_hex(16)
        self.tagged_at = 0.0
        self.scanned_at = 0.0
        self.rss = 0

    def start(self, argv, env, cwd, stdout=subprocess.DEVNULL, pass_fds=()):
        env = {**env, OWNER_VARIABLE: self.token}
        child = subprocess.Popen(argv, cwd=cwd, env=env, start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=stdout, stderr=subprocess.DEVNULL,
                                 pass_fds=pass_fds)
        self.leaders.append(child)
        return child

    def scan(self, force=False):
        now = time.monotonic()
        if not force and now - self.scanned_at < 2:
            return self.rss
        self.scanned_at = now
        try:
            table = processes()
        except (OSError, subprocess.SubprocessError):
            # A busy host may not schedule ps before its deadline. Keep the
            # last ownership snapshot; a missed observation is not child death.
            return self.rss
        owned = {child.pid for child in self.leaders if child.returncode is None and child.pid in table}
        owned.update(pid for pid, started in self.seen.items()
                     if pid in table and table[pid][2] == started)
        now = time.monotonic()
        if force or now - self.tagged_at >= 2:
            # Detached helpers, found by the token they inherited (rate limited: it reads every environment).
            self.tagged_at = now
            try:
                owned.update(pid for pid in tagged(self.token) if pid in table)
            except (OSError, subprocess.SubprocessError):
                pass
        while True:
            descendants = {pid for pid, (parent, _, _) in table.items() if parent in owned}
            if descendants <= owned:
                break
            owned.update(descendants)
        self.seen = {pid: table[pid][2] for pid in owned if pid in table}
        self.rss = sum(table[pid][1] for pid in self.seen)
        return self.rss

    def stop(self):
        try:
            self.scan(force=True)
        except (OSError, subprocess.SubprocessError):
            pass
        for child in reversed(self.leaders):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=0.6)
                except subprocess.TimeoutExpired:
                    pass
            # Retire descendants that stayed in this process group as well.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            table = processes()
        except (OSError, subprocess.SubprocessError):
            return
        for pid, started in self.seen.items():
            if pid in table and table[pid][2] == started:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        # A helper that detached while the leaders were stopping: the token still names it.
        try:
            for pid in tagged(self.token):
                if pid in table:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        except (OSError, subprocess.SubprocessError):
            pass


def wait_for_gateway(home, gateway, children):
    from hermes_cli.gateway_runtime import discover_gateway_endpoint

    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if select.select([0], [], [], 0.1)[0] or gateway.poll() is not None:
            raise RuntimeError("gateway_stopped")
        children.scan()
        ready = discover_gateway_endpoint(home, timeout=0.4)
        if ready.state == "ready" and ready.endpoint and ready.endpoint.control_home in (None, home):
            lock = json.loads((Path(home) / "gateway.lock").read_text())
            if lock.get("pid") == gateway.pid:
                return
    raise RuntimeError("gateway_timeout")


def run(spec, children, channel):
    # A per-child file descriptor / core dump bound. The supervisor applies
    # the process-count and RSS budgets to the entire owned tree separately.
    for limit, soft in [(resource.RLIMIT_CORE, 0), (resource.RLIMIT_NOFILE, 2048)]:
        _, hard = resource.getrlimit(limit)
        resource.setrlimit(limit, (soft if hard < 0 else min(soft, hard), hard))
    for env in spec["gateways"]:
        child = children.start([sys.executable, "-P", "-B", "-X", "utf8", "-m",
                                "hermes_cli.main", "gateway", "run"], env, spec["cwd"])
        wait_for_gateway(env["HERMES_HOME"], child, children)
    env = spec["environment"]
    if channel:
        env = {**env, **channel, "T3_SERVICE_LAUNCHER_CONTEXT": json.dumps(spec["trial"])}
    passed = [int(channel["NODE_CHANNEL_FD"])] if channel else []
    token = spec.pop("connectorToken", None)
    try:
        if token:
            read_fd, write_fd = os.pipe()
            passed.append(read_fd)
            try:
                os.write(write_fd, token.encode("ascii"))
            finally:
                os.close(write_fd)
            env = {**env, "ATUM_WORK_CONNECTOR_FD": str(read_fd)}
        sidecar = children.start(
            [spec["executable"], "--mode", "web", "--no-browser", "--host", "127.0.0.1"],
            env, spec["cwd"], subprocess.PIPE, tuple(passed),
        )
    finally:
        for fd in passed:
            os.close(fd)
    publish("spawned", pid=sidecar.pid)
    assert sidecar.stdout is not None
    line_buffer = b""
    while not any(child.poll() is not None for child in children.leaders):
        readable, _, _ = select.select([0, sidecar.stdout], [], [], 0.2)
        if 0 in readable:
            return
        if sidecar.stdout in readable:
            chunk = os.read(sidecar.stdout.fileno(), 4096)
            if not chunk:
                return
            line_buffer += chunk
            while b"\n" in line_buffer:
                line, line_buffer = line_buffer.split(b"\n", 1)
                if line.lstrip().startswith(b"pairingUrl:"):
                    publish("pairing", url=line.strip().removeprefix(b"pairingUrl:").strip().decode("ascii"))
            if len(line_buffer) > 65536:
                raise RuntimeError("work_stdout_limit")
        rss = children.scan()
        if len(children.seen) > 128:
            raise RuntimeError("work_process_limit")
        if rss > 4 * 1024 * 1024:
            raise RuntimeError("work_memory_limit")


def work_provider_instances(saved, defaults, brokers):
    # Replace old blocked stubs once. Real T3 settings belong to the account.
    saved = saved if isinstance(saved, dict) else {}
    instances = dict(brokers)
    for instance_id, default in defaults.items():
        instance = saved.get(instance_id)
        if isinstance(instance, dict) and instance.get("driver") == default["driver"]:
            config = instance.get("config")
            blocked = isinstance(config, dict) and config.get("binaryPath") == "/usr/bin/false"
            if not blocked:
                instances[instance_id] = instance
                continue
        instances[instance_id] = default
    return instances


def main():
    spec = json.loads(sys.stdin.buffer.readline(262144))
    # Electron created the Node IPC channel. Only the T3 trial inherits it.
    # Its native messages travel directly over that channel.
    channel = {name: os.environ.pop(name) for name in
               ("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE") if name in os.environ}
    if bool(channel) != bool(spec.get("trial")):
        raise RuntimeError("work_trial_channel_missing")
    children = Children()
    with Path(spec["lock"]).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            # Settings writes occur after the kernel lock and before any
            # server can open the home, including after an app crash.
            try:
                with Path(spec["settingsPath"]).open(encoding="utf-8") as file:
                    settings = json.load(file)
            except FileNotFoundError:
                settings = {}
            import yaml

            profile_source = Path(spec["profileSource"])
            owner = yaml.safe_load((profile_source / "self-work.yaml").read_text())
            delegated = yaml.safe_load((profile_source / "delegated.yaml").read_text())
            owner["model"] = {"provider": spec["managedProvider"], "default": spec["managedModelAlias"]}
            owner["gateway"] = {"standalone": True}
            owner["plugins"] = {"auto_update_check_hours": 0}
            for env, config in zip(spec["gateways"], (owner, {**owner, **delegated}), strict=True):
                path = Path(env["HERMES_HOME"]) / "config.yaml"
                path.write_text(yaml.safe_dump(config), encoding="utf-8")
                path.chmod(0o600)
            instances = work_provider_instances(
                settings.get("providerInstances", {}), spec["planProviderDefaults"],
                spec["settings"]["providerInstances"],
            )
            settings.update(spec["settings"])
            settings["providerInstances"] = instances
            settings["textGenerators"] = {}
            for override in settings.get("projectSettingsOverrides", {}).values():
                override.pop("textGenerationModelSelection", None)
                override.pop("providerInstances", None)
                if not settings["continueThreadsAfterServerUpdate"] and "continueThreadsAfterServerUpdate" in override:
                    override["continueThreadsAfterServerUpdate"] = False
            temp = Path(spec["settingsPath"] + ".work-next")
            temp.write_text(json.dumps(settings), encoding="utf-8")
            os.chmod(temp, 0o600)
            temp.replace(spec["settingsPath"])
            # The Atum theme (generated from the Kit) is published and set as the default whenever
            # the shipped file differs from the one last set. The same theme is never set twice, so
            # an owner who picks another theme keeps it until the Atum theme itself changes.
            theme_marker = Path(spec["settingsPath"]).with_name(".atum-theme-installed")
            theme = Path(spec["executable"]).with_name("atum.json")
            digest = hashlib.sha256(theme.read_bytes()).hexdigest() if theme.is_file() else None
            installed = theme_marker.read_text(encoding="ascii").strip() if theme_marker.exists() else None
            if digest is not None and installed != digest:
                child = children.start(
                    [spec["executable"], "theme", "set", str(theme)], spec["environment"], spec["cwd"],
                )
                child.wait(timeout=15)
                children.leaders.remove(child)
                if child.returncode:
                    raise RuntimeError("work_theme_failed")
                theme_marker.write_text(digest, encoding="ascii")
                theme_marker.chmod(0o600)
            run(spec, children, channel)
        finally:
            children.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No child output, credentials, paths or spec are forwarded to Electron logs.
        sys.exit(1)
