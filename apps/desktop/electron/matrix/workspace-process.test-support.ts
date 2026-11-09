import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface WorkspaceProcessProof {
  python: string
  home: string
  processes?: readonly number[]
  unreadable?: boolean
}

/**
 * Linux CI has unrelated same-user processes whose cwd can be unreadable. Keep
 * production's complete /proc scan fail-closed; only this test interpreter limits
 * enumeration to the real fixture processes. Their uid/cwd and all filesystem,
 * rename, journal, lock and child-process operations still use the real OS.
 * macOS proofs use the unchanged interpreter and complete native process view.
 */
export function workspaceProcessProofPython(input: WorkspaceProcessProof): string {
  if (process.platform !== 'linux') {
    return input.python
  }

  const directory = path.join(input.home, 'process-proof')
  const interpreter = path.join(directory, 'python')
  const script = path.join(directory, 'inventory.py')
  const inventory = path.join(directory, 'processes.json')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(inventory, JSON.stringify({
    processes: [process.pid, ...(input.processes ?? [])],
    unreadable: input.unreadable ?? false
  }), { mode: 0o600 })
  writeFileSync(script, `import errno, json, os, sys
with open(sys.argv[1], encoding='utf-8') as source:
    fixture = json.load(source)
original_listdir = os.listdir
original_readlink = os.readlink
def listdir(value):
    if value == '/proc':
        return [str(pid) for pid in fixture['processes']] + [str(os.getpid())]
    return original_listdir(value)
def readlink(value, *args, **kwargs):
    if fixture['unreadable'] and value == '/proc/' + str(fixture['processes'][0]) + '/cwd':
        raise PermissionError(errno.EACCES, 'fixture process is unreadable')
    return original_readlink(value, *args, **kwargs)
os.listdir = listdir
os.readlink = readlink
exec(compile(sys.argv[-1], '<workspace-native-proof>', 'exec'), {'__name__': '__main__'})
`, { mode: 0o600 })
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(interpreter, `#!/bin/sh\nexec ${quote(input.python)} -I -B -S ${quote(script)} ${quote(inventory)} "$@"\n`, {
    mode: 0o700
  })

  return interpreter
}
