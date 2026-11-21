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
