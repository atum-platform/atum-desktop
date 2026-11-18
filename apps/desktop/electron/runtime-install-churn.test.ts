import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// Actual PM layout, facts and leases. No installer/network or owner data.
function run(body: string) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-churn-'))
  const source = path.resolve(import.meta.dirname, '../../../..')

  try {
    const result = spawnSync('python3', ['-B', '-c', `
import sys, os, json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
root = Path(sys.argv[2])
from pm.environments import install_key, install_state_dir, selected_venv
from pm.desktop_runtime import collect_desktop_installs
from pm.lock import Facts
from unittest.mock import patch

def bundle(name, lock='same'):
    project = root / name / 'Atum.app/Contents/Resources/runtime/hermes-agent'
    (project / 'pm').mkdir(parents=True)
    (project.parent / 'runtime-manifest.json').write_text(json.dumps({
        'schemaVersion': 3, 'identity': {'runtimeTree': 'a' * 40},
        'python': {'version': '3.14.0'}, 'target': {'platform': 'darwin', 'arch': 'arm64'}}))
    for name, text in [('uv.lock', lock), ('pyproject.toml', '[project]'), ('pm/lock.json', '{}')]:
        (project / name).write_text(text)
    return project

def installed(project):
    state = install_state_dir(project)
    environment = state / 'environments' / 'generation' / 'venv'
    environment.mkdir(parents=True)
    (environment / 'pyvenv.cfg').write_text('home = fixture')
    (environment.parent / '.lease-managed').touch()
    Facts(state / 'facts.json').record_state('venv', 'stamp', [], environment=environment,
                                           resolved_lock=environment.parent / 'workspace/uv.lock')
    inputs = state / 'inputs'
    inputs.mkdir()
    (inputs / '.project-root').write_text(str(project))
    return state, environment

${body}
`, source, scratch], { encoding: 'utf8', env: { ...process.env, HOME: scratch, HERMES_HOME: path.join(scratch, 'home'), PYTHONDONTWRITEBYTECODE: '1' } })

    expect(result.stderr, result.stdout).toBe('')
    expect(result.status, result.stderr).toBe(0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe('desktop runtime PM state', () => {
  it('reuses the committed environment across staging paths and separates changed inputs', () => run(`
a = bundle('stage-a')
b = bundle('stage-b')
state, environment = installed(a)
assert install_key(a) == install_key(b)
assert selected_venv(b) == environment.resolve()
assert install_key(bundle('changed', 'new-lock')) != install_key(a)
assert install_key(root / 'dev-a') != install_key(root / 'dev-b')
`))

  it('keeps active plus immediately previous, including after relaunch', () => run(`
a, b, c = [bundle(name, name) for name in ['a', 'b', 'c']]
sa, _ = installed(a)
with patch('pm.packages.Venv.expected_stamp', return_value='stamp'):
    collect_desktop_installs(a)
    sb, _ = installed(b)
    collect_desktop_installs(b)
    sc, _ = installed(c)
    collect_desktop_installs(c)
    collect_desktop_installs(c)
assert not sa.exists()
assert sb.exists() and sc.exists()
`))

  it('preserves a running process lease, then collects after release', () => run(`
a, b, c = [bundle(name, name) for name in ['a', 'b', 'c']]
sa, ea = installed(a)
from hermes_cli.runtime_state import lease_generation
release = lease_generation(ea)
with patch('pm.packages.Venv.expected_stamp', return_value='stamp'):
    collect_desktop_installs(a)
    sb, _ = installed(b)
    collect_desktop_installs(b)
    sc, _ = installed(c)
    collect_desktop_installs(c)
    assert sa.exists() and sb.exists() and sc.exists()
    release()
    collect_desktop_installs(c)
assert not sa.exists()
`))

  it('migrates legacy path-keyed bundle installs on the first verified bundled launch', () => run(`
a, b, c = [bundle(name, name) for name in ['a', 'b', 'c']]
sa, _ = installed(a)
sb, _ = installed(b)
# Emulate the old path hash, whose source bundle may already have been removed.
legacy_a = sa.parent / __import__('hashlib').sha256(str(a.resolve()).encode()).hexdigest()[:16]
legacy_b = sb.parent / __import__('hashlib').sha256(str(b.resolve()).encode()).hexdigest()[:16]
sa.rename(legacy_a)
sb.rename(legacy_b)
assert collect_desktop_installs(c, verified_bundle=True) == [legacy_a]
assert legacy_b.exists() and install_state_dir(c).exists()
`))

  it('retains an install while its native installer lock is held', () => run(`
a, b, c = [bundle(name, name) for name in ['a', 'b', 'c']]
sa, _ = installed(a)
from pm.filesystem import lock_fd
with patch('pm.packages.Venv.expected_stamp', return_value='stamp'):
    collect_desktop_installs(a)
    installed(b)
    collect_desktop_installs(b)
    installed(c)
    with (sa / '.install.lock').open('a+b') as lock:
        assert lock_fd(lock.fileno(), wait=False)
        collect_desktop_installs(c)
        assert sa.exists()
    collect_desktop_installs(c)
assert not sa.exists()
`))

  it('keeps uv console-script source snapshots in their owning desktop install', () => run(`
a = bundle('a')
state, environment = installed(a)
with patch('pm.packages.Venv.expected_stamp', return_value='stamp'):
    collect_desktop_installs(a)
snapshot = environment.parent / 'workspace'
snapshot.mkdir()
assert install_key(snapshot) == install_key(a)
assert selected_venv(snapshot) == environment.resolve()
`))

  it('leaves prior installs and active marker intact on failed verification', () => run(`
a, b, c = [bundle(name, name) for name in ['a', 'b', 'c']]
sa, _ = installed(a)
sb, _ = installed(b)
with patch('pm.packages.Venv.expected_stamp', return_value='stamp'):
    collect_desktop_installs(b)
sc, _ = installed(c)
marker = sb.parent / '.desktop-active.json'
before = marker.read_bytes()
with patch('pm.install.venv_is_current', return_value=False):
    assert collect_desktop_installs(c) == []
assert marker.read_bytes() == before
assert sa.exists() and sb.exists() and sc.exists()
`))
})
