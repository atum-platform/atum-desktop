import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// Actual PM layout, facts and leases. No installer/network or owner data.
function run(body: string) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-churn-'))
  const source = path.resolve(import.meta.dirname, '../../..')

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
  it('reuses a source checkout selection while preserving checkout isolation', () => run(`
a = bundle('checkout-a')
state, environment = installed(a)
from pm.install import venv_is_current, _commit_selection
from pm.packages import Venv
package = Venv(a)
record = state / 'facts.json'
before = record.read_bytes()
with patch('pm.packages.Venv.expected_stamp', return_value='stamp'), patch.object(package, 'apply', side_effect=AssertionError('unexpected rebuild')):
    assert venv_is_current(project_root=a)
    _commit_selection(package, Facts(record), None, enabled=[], stamp='stamp',
                      inputs={'plugin_dirs': []}, current=True, repair=False, explicit=True)
assert selected_venv(a) == environment.resolve()
assert record.read_bytes() == before
assert install_key(root / 'dev-a') != install_key(root / 'dev-b')
`))

  it('collects deleted worker checkouts after a successful setup and keeps live checkouts', () => run(`
import shutil
from pm.desktop_runtime import cleanup_desktop_installs
from pm.install_states import collect_orphan_install_states
parent = root / 'repository' / 'worker-checkouts'
gone = parent / 'gone-worker'
live = parent / 'live-worker'
gone.mkdir(parents=True)
live.mkdir()
sg, _ = installed(gone)
sl, _ = installed(live)
assert collect_orphan_install_states(sg.parent) == []
shutil.rmtree(gone)
cleanup_desktop_installs(live)
assert not sg.exists() and sl.exists()
`))

  it('protects deleted worker installs while native readers or writers use them', () => run(`
import shutil
from pm.install_states import collect_orphan_install_states
from hermes_cli.runtime_state import lease_generation
from pm.filesystem import lock_fd
parent = root / 'worktrees'
reader = parent / 'reader'
writer = parent / 'writer'
reader.mkdir(parents=True)
writer.mkdir()
sr, er = installed(reader)
sw, _ = installed(writer)
release = lease_generation(er)
shutil.rmtree(reader)
shutil.rmtree(writer)
with (sw / '.install.lock').open('a+b') as lock:
    assert lock_fd(lock.fileno(), wait=False)
    assert collect_orphan_install_states(sr.parent) == []
    assert sr.exists() and sw.exists()
release()
assert set(collect_orphan_install_states(sr.parent)) == {sr, sw}
`))

  it('bootstraps test dependencies only when an explicit pytest interpreter is absent', () => run(`
import shutil, subprocess
fixture = root / 'test-runner'
scripts = fixture / 'scripts'
scripts.mkdir(parents=True)
for name in ['run_tests.sh', '_activation.sh']:
    shutil.copyfile(Path(sys.argv[1]) / 'scripts' / name, scripts / name)
bootstrap = scripts / 'run-in-hermes-env'
bootstrap.write_text('#!/bin/bash\\nexit 87\\n'.replace('\\n', chr(10)))
bootstrap.chmod(0o700)
python = fixture / 'python'
python.write_text('#!/bin/bash\\nprintf "%s" "$*" >> "$HOME/python-calls"\\nexit 0\\n'.replace('\\n', chr(10)))
python.chmod(0o700)
env = dict(os.environ)
for name in ['__HERMES_ACTIVATED', '__HERMES_TESTS_REEXEC', 'HERMES_PYTHON']:
    env.pop(name, None)
command = ['bash', str(scripts / 'run_tests.sh'), 'tests/fixture.py']
assert subprocess.run(command, env=env, capture_output=True).returncode == 87
env['HERMES_PYTHON'] = str(python)
result = subprocess.run(command, env=env, capture_output=True)
assert result.returncode == 0, result.stderr
assert 'run_tests_parallel.py' in (root / 'python-calls').read_text()
`))

  it('retains inconclusive missing mounts and retries partially deleted worker state', () => run(`
import shutil
from pm.install_states import collect_orphan_install_states
missing_mount = root / 'unmounted' / 'checkout'
unknown, _ = installed(missing_mount)
parent = root / 'worktrees'
source = parent / 'deleted'
source.mkdir(parents=True)
state, environment = installed(source)
shutil.rmtree(source)
environment.chmod(0o500)
try:
    assert collect_orphan_install_states(state.parent) == []
    assert (state / 'inputs' / '.project-root').exists()
finally:
    environment.chmod(0o700)
assert collect_orphan_install_states(state.parent) == [state]
assert unknown.exists()
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
assert sa == legacy_a and sb == legacy_b
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
