import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// The supervisor's child ownership, run for real with Python: a helper that detaches (new session, reparented to
// launchd) is still found by its owner token and stopped with the rest.

const python = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(candidate => {
  try {
    execFileSync(candidate, ['-c', ''])

    return true
  } catch {
    return false
  }
})

const supervisor = join(__dirname, 'supervisor.py')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(!python || process.platform !== 'darwin')('supervisor child ownership', () => {
  it('passes the private Node channel only to the ordinary Work server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-ipc-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'hermes_cli'))
    writeFileSync(join(dir, 'hermes_cli', 'main.py'), `
import os, time
assert 'NODE_CHANNEL_FD' not in os.environ
with open('gateway-ready', 'w'): pass
time.sleep(60)
`)
    const sidecar = join(dir, 'work-fixture')
    writeFileSync(sidecar, `#!${process.execPath}
const assert = require('node:assert/strict')
assert.equal(process.env.T3_SERVICE_LAUNCHER_CONTEXT, undefined)
process.on('message', message => process.send({ ...message, accepted: true }))
process.send({ type: 'work-deliverable-pin' })
`, { mode: 0o700 })

    const child = spawn(python!, ['-I', '-B', '-c', `
import importlib.util, json, os, sys
module = importlib.util.spec_from_file_location("supervisor", sys.argv[1])
supervisor = importlib.util.module_from_spec(module)
module.loader.exec_module(supervisor)
spec = json.loads(sys.stdin.buffer.readline(262144))
channel = {name: os.environ.pop(name) for name in
           ("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE")}
children = supervisor.Children()
try:
    supervisor.run(spec, children, channel)
finally:
    children.stop()
`, supervisor], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] })

    const exit = once(child, 'close')
    child.stdin.write(JSON.stringify({ cwd: dir, executable: sidecar, gateway: { PYTHONPATH: dir }, environment: {} }) + '\n')

    try {
      const options = { signal: AbortSignal.timeout(8_000) }
      expect((await once(child, 'message', options))[0]).toEqual({ type: 'work-deliverable-pin' })
      const response = once(child, 'message', options)
      child.send({ type: 'work-deliverable-pinned' })
      expect((await response)[0]).toEqual({ type: 'work-deliverable-pinned', accepted: true })
      await vi.waitFor(() => expect(existsSync(join(dir, 'gateway-ready'))).toBe(true))
    } finally {
      child.stdin.end()
      await exit
    }
  }, 15_000)

  it('finds and kills a helper that detached and was reparented, which a walk down the process tree cannot see', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-sup-'))
    dirs.push(dir)
    const script = join(dir, 'drive.py')

    writeFileSync(
      script,
      `
import importlib.util, os, subprocess, sys, time
spec = importlib.util.spec_from_file_location("supervisor", sys.argv[1])
sup = importlib.util.module_from_spec(spec); spec.loader.exec_module(sup)

children = sup.Children()
# the leader starts a helper in its own session and exits at once: the helper is reparented to launchd
leader = children.start([sys.executable, "-c", "import subprocess, sys; p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], start_new_session=True); print(p.pid, flush=True)"],
                        dict(os.environ), os.getcwd(), stdout=subprocess.PIPE)
helper = int(leader.stdout.readline())
leader.wait()
time.sleep(0.3)
table = sup.processes()
assert table[helper][0] == 1, "the helper must have been reparented away from the leader"
children.scan(force=True)
assert helper in children.seen, "the helper is owned"
children.stop()
time.sleep(0.3)
try:
    os.kill(helper, 0)
    print("ALIVE")
except ProcessLookupError:
    print("DEAD")
`
    )

    const result = spawnSync(python!, ['-I', script, supervisor], { encoding: 'utf8', timeout: 30_000 })

    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('DEAD')
  })

  it('keeps children alive through slow process-health scans and observes them afterwards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-sup-'))
    dirs.push(dir)
    const script = join(dir, 'drive.py')
    writeFileSync(script, `
import importlib.util, os, subprocess, sys
spec = importlib.util.spec_from_file_location("supervisor", sys.argv[1])
sup = importlib.util.module_from_spec(spec); spec.loader.exec_module(sup)
children = sup.Children()
child = children.start([sys.executable, "-c", "import time; time.sleep(120)"], dict(os.environ), os.getcwd())
real = sup.processes
try:
    children.scan(force=True)
    observed, rss = dict(children.seen), children.rss
    def slow():
        raise subprocess.TimeoutExpired("ps", 5)
    sup.processes = slow
    for _ in range(3):
        assert children.scan(force=True) == rss
        assert children.seen == observed
        assert child.poll() is None
    sup.processes = real
    children.scan(force=True)
    assert child.pid in children.seen
    print("RECOVERED")
finally:
    sup.processes = real
    children.stop()
`)
    const result = spawnSync(python!, ['-I', script, supervisor], { encoding: 'utf8', timeout: 30_000 })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('RECOVERED')
  })

  it('returns when the server exits unexpectedly so Electron can recover the whole incarnation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-sup-'))
    dirs.push(dir)
    const script = join(dir, 'drive.py')
    const server = join(dir, 'server')
    writeFileSync(server, '#!/bin/sh\nsleep 0.1\nexit 7\n', { mode: 0o700 })
    writeFileSync(script, `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("supervisor", sys.argv[1])
sup = importlib.util.module_from_spec(spec); spec.loader.exec_module(sup)
# Keep Electron's control pipe open: this must be a child exit, not stdin EOF.
r, w = os.pipe()
os.dup2(r, 0)
class Children(sup.Children):
    def start(self, argv, *args):
        if argv[-2:] == ["gateway", "run"]:
            argv = [sys.executable, "-c", "import time; time.sleep(120)"]
        return super().start(argv, *args)
children = Children()
try:
    sup.run(dict(settingsPath=os.path.join(os.getcwd(), "fixture-settings.json"), gateway=dict(os.environ), environment=dict(os.environ), executable=sys.argv[2], cwd=os.getcwd()), children, {})
    children.leaders[-1].wait(timeout=5)
    assert children.leaders[-1].returncode == 7
    print("SERVER_EXITED")
finally:
    children.stop()
    os.close(w)
`)
    const result = spawnSync(python!, ['-I', script, supervisor, server], { encoding: 'utf8', timeout: 30_000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('SERVER_EXITED')
  })

  it('does not own an unrelated process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-sup-'))
    dirs.push(dir)
    const script = join(dir, 'drive.py')

    writeFileSync(
      script,
      `
import importlib.util, subprocess, sys
spec = importlib.util.spec_from_file_location("supervisor", sys.argv[1])
sup = importlib.util.module_from_spec(spec); spec.loader.exec_module(sup)
bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
children = sup.Children()
children.scan(force=True)
print("OWNED" if bystander.pid in children.seen else "NOT_OWNED")
bystander.kill()
`
    )

    const result = spawnSync(python!, ['-I', script, supervisor], { encoding: 'utf8', timeout: 30_000 })

    expect(result.stdout.trim()).toBe('NOT_OWNED')
  })
})


it.skipIf(!python)('starts the native server alongside only the owner gateway', () => {
  const result = execFileSync(python!, ['-I', '-c', `
import importlib.util, io, os, sys
module = importlib.util.spec_from_file_location("supervisor", sys.argv[1])
sup = importlib.util.module_from_spec(module); module.loader.exec_module(sup)
class Child:
    pid = 123
    stdout = io.BytesIO()
    def poll(self): return None
class Children:
    leaders = []
    seen = {}
    calls = []
    def start(self, argv, *args):
        self.calls.append(argv)
        return Child()
    def scan(self): return 0
children = Children()
sup.publish = lambda *args, **kw: None
sup.select.select = lambda *args: ([0], [], [])
sup.run(dict(settingsPath=os.path.join(os.getcwd(), "fixture-settings.json"), gateway={}, environment={}, executable="t3", cwd=os.getcwd()), children, {})
assert len(children.calls) == 2
assert children.calls[0][-3:] == ["hermes_cli.main", "gateway", "run"]
assert children.calls[-1][0] == "t3"
print("ok")
`, supervisor], { encoding: 'utf8' })

  expect(result.trim()).toBe('ok')
})
