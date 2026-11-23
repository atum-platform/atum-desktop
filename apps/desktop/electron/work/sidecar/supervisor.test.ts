import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
children = sup.Children()
try:
    sup.run(dict(gateways=[], environment=dict(os.environ), executable=sys.argv[2], cwd=os.getcwd()), children, {})
    children.leaders[0].wait(timeout=5)
    assert children.leaders[0].returncode == 7
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
