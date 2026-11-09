import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { REQUIRED_SETUP_RPC_METHODS } from '../shared/setup-methods.ts'
import {
  NON_RUNTIME_KEEP,
  NON_RUNTIME_SOURCE_PATHS,
  isPreviewDiscoveryDocument,
  isolatedProbeCommand,
  pruneGooglePreviewDiscoveryDocuments,
  pruneNonRuntimeSource,
  runIsolatedImportProbe
} from './slim-runtime.mjs'
import { requiredSetupMethods } from './stage-bundled-runtime.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const scratch = []

const tempDir = prefix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))

  scratch.push(dir)

  return dir
}

const touch = (root, relativePath, body = 'x') => {
  const file = path.join(root, relativePath)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pruning removes tests, docs, app sources and website generator but keeps runtime code and the kept assets', () => {
  const root = tempDir('slim-source-')

  for (const file of [
    'hermes_cli/config.py',
    'tui_gateway/server.py',
    'pm/__init__.py',
    'skills/AGENTS.md',
    'LICENSE',
    'pyproject.toml',
    'tests/agent/test_x.py',
    'tests-js/a.test.ts',
    'docs/plans/p.md',
    'apps/desktop/src/main.ts',
    'apps/desktop/assets/pets/mochi/pet.json',
    'apps/desktop/assets/icon.png',
    'apps/shared/index.ts',
    'packages/device-protocol/index.ts',
    'website/docs/user-guide/features/x.md',
    'website/static/api/model-catalog.json',
    'website/static/img/big.png',
    'website/i18n/vi/x.md',
    'website/package.json',
    'contributors/emails/a',
    '.github/workflows/ci.yml',
    'sqlite_leak_fix.png'
  ]) {
    touch(root, file)
  }

  const result = pruneNonRuntimeSource(root)
  const exists = file => fs.existsSync(path.join(root, file))

  for (const kept of [
    'hermes_cli/config.py',
    'tui_gateway/server.py',
    'pm/__init__.py',
    'skills/AGENTS.md',
    'LICENSE',
    'pyproject.toml',
    'apps/desktop/assets/pets/mochi/pet.json',
    'website/docs/user-guide/features/x.md',
    'website/static/api/model-catalog.json'
  ]) {
    assert.ok(exists(kept), `${kept} must survive pruning`)
  }

  for (const gone of [
    'tests',
    'tests-js',
    'docs',
    'apps/desktop/src',
    'apps/desktop/assets/icon.png',
    'apps/shared',
    'packages',
    'website/static/img',
    'website/i18n',
    'website/package.json',
    'contributors',
    '.github',
    'sqlite_leak_fix.png'
  ]) {
    assert.ok(!exists(gone), `${gone} must be pruned`)
  }

  assert.ok(result.removed.includes('tests'))
  assert.deepEqual(result.kept, [...NON_RUNTIME_KEEP])
})

test('pruning tolerates a source tree that already lacks some of the paths', () => {
  const root = tempDir('slim-source-')

  touch(root, 'hermes_cli/config.py')

  const result = pruneNonRuntimeSource(root)

  assert.deepEqual(result.removed, [])
  assert.ok(fs.existsSync(path.join(root, 'hermes_cli/config.py')))
})

test('pruning refuses a path that escapes the source root', () => {
  const root = tempDir('slim-source-')
  const outside = tempDir('slim-outside-')

  touch(outside, 'keep.txt')

  assert.throws(
    () => pruneNonRuntimeSource(root, { paths: [path.relative(root, outside)], keep: [] }),
    /escapes source root/u
  )
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')))
})

test('the keep list sits under pruned paths, so no entry is dead config', () => {
  for (const kept of NON_RUNTIME_KEEP) {
    assert.ok(
      NON_RUNTIME_SOURCE_PATHS.some(pruned => kept === pruned || kept.startsWith(`${pruned}/`)),
      `${kept} is not under a pruned path, so listing it is dead config`
    )
  }
})

test('the staging probe reads the setup RPC catalog the desktop actually calls', () => {
  const methods = requiredSetupMethods()

  assert.ok(methods.length > 0)
  assert.deepEqual(methods.slice().sort(), [...REQUIRED_SETUP_RPC_METHODS].sort())

  const empty = path.join(tempDir('slim-setup-'), 'setup-methods.ts')

  fs.writeFileSync(empty, 'export const none = {}\n')
  assert.throws(() => requiredSetupMethods(empty), /no setup RPC methods/u)
})

test('preview Google API descriptions are recognised by version, GA ones are kept', () => {
  for (const preview of [
    'aiplatform.v1beta1.json',
    'compute.alpha.json',
    'discoveryengine.v1alpha.json',
    'securitycenter.v1beta2.json'
  ]) {
    assert.equal(isPreviewDiscoveryDocument(preview), true, preview)
  }

  for (const stable of [
    'gmail.v1.json',
    'calendar.v3.json',
    'drive.v3.json',
    'dfareporting.v3.4.json',
    'alphabetical.v1.json',
    'betastore.v2.json',
    'README.md'
  ]) {
    assert.equal(isPreviewDiscoveryDocument(stable), false, stable)
  }
})

test('pruning Google preview descriptions only touches the discovery documents directory', () => {
  const pythonRoot = tempDir('slim-python-')
  const site = 'lib/python3.14/site-packages'
  const documents = `${site}/googleapiclient/discovery_cache/documents`

  touch(pythonRoot, `${documents}/gmail.v1.json`)
  touch(pythonRoot, `${documents}/drive.v3.json`)
  touch(pythonRoot, `${documents}/compute.beta.json`)
  touch(pythonRoot, `${documents}/aiplatform.v1beta1.json`)
  touch(pythonRoot, `${site}/other/thing.beta.json`)

  assert.equal(pruneGooglePreviewDiscoveryDocuments(pythonRoot), 2)
  assert.deepEqual(fs.readdirSync(path.join(pythonRoot, documents)).sort(), ['drive.v3.json', 'gmail.v1.json'])
  assert.ok(fs.existsSync(path.join(pythonRoot, `${site}/other/thing.beta.json`)))
  assert.equal(pruneGooglePreviewDiscoveryDocuments(path.join(pythonRoot, 'missing')), 0)
})

// --- symlink safety: the prune walkers must never follow a link out of the staged tree -----------

const symlinkFixture = () => {
  const root = tempDir('slim-source-')
  const outside = tempDir('slim-outside-')

  touch(outside, 'sentinel.txt')
  touch(outside, 'desktop/assets/pets/p.json')
  touch(outside, 'desktop/assets/icon.png')
  touch(outside, 'assets/pets/p.json')
  touch(outside, 'assets/icon.png')
  touch(outside, 'static/api/model-catalog.json')
  touch(outside, 'static/img/big.png')

  return { root, outside }
}

const outsideIntact = outside => {
  for (const file of [
    'sentinel.txt',
    'desktop/assets/pets/p.json',
    'desktop/assets/icon.png',
    'assets/pets/p.json',
    'assets/icon.png',
    'static/api/model-catalog.json',
    'static/img/big.png'
  ]) {
    assert.ok(fs.existsSync(path.join(outside, file)), `${file} outside the staged tree must survive`)
  }
}

for (const [label, link, target] of [
  ['apps', 'apps', ''],
  ['apps/desktop', 'apps/desktop', 'desktop'],
  ['apps/desktop/assets', 'apps/desktop/assets', 'assets'],
  ['website/static', 'website/static', 'static']
]) {
  test(`pruning refuses to traverse a symlinked ${label} on the way to a kept path`, () => {
    const { root, outside } = symlinkFixture()
    const linkPath = path.join(root, link)

    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.symlinkSync(path.join(outside, target), linkPath)
    touch(root, 'hermes_cli/config.py')

    assert.throws(() => pruneNonRuntimeSource(root), /symlink/u)
    outsideIntact(outside)
    assert.ok(fs.existsSync(path.join(root, 'hermes_cli/config.py')))
  })
}

test('a symlinked pruned directory is unlinked without touching its target', () => {
  const { root, outside } = symlinkFixture()

  fs.symlinkSync(outside, path.join(root, 'docs'))
  fs.mkdirSync(path.join(root, 'tests'))
  fs.symlinkSync(outside, path.join(root, 'tests/linked'))
  touch(root, 'tests/real.py')

  const result = pruneNonRuntimeSource(root)

  assert.ok(result.removed.includes('docs') && result.removed.includes('tests'))
  assert.equal(fs.lstatSync(path.join(root, 'docs'), { throwIfNoEntry: false }), undefined)
  assert.equal(fs.lstatSync(path.join(root, 'tests'), { throwIfNoEntry: false }), undefined)
  outsideIntact(outside)
})

test('a symlinked sibling inside a kept directory is unlinked, not followed', () => {
  const { root, outside } = symlinkFixture()

  touch(root, 'apps/desktop/assets/pets/mochi/pet.json')
  fs.symlinkSync(outside, path.join(root, 'apps/desktop/assets/linked'))
  fs.symlinkSync(outside, path.join(root, 'apps/linked'))

  pruneNonRuntimeSource(root)

  assert.ok(fs.existsSync(path.join(root, 'apps/desktop/assets/pets/mochi/pet.json')))
  assert.equal(fs.lstatSync(path.join(root, 'apps/desktop/assets/linked'), { throwIfNoEntry: false }), undefined)
  assert.equal(fs.lstatSync(path.join(root, 'apps/linked'), { throwIfNoEntry: false }), undefined)
  outsideIntact(outside)
})

test('a prune path behind a symlinked ancestor is refused, even when the path itself is gone', () => {
  const { root, outside } = symlinkFixture()

  fs.symlinkSync(outside, path.join(root, 'link'))

  assert.throws(() => pruneNonRuntimeSource(root, { paths: ['link/desktop'], keep: [] }), /symlink/u)
  assert.throws(() => pruneNonRuntimeSource(root, { paths: ['link/missing'], keep: [] }), /symlink/u)
  outsideIntact(outside)
})

test('a kept path that escapes the source root is refused before anything is deleted', () => {
  const root = tempDir('slim-source-')
  const outside = tempDir('slim-outside-')

  touch(root, 'docs/a.md')
  touch(outside, 'keep.txt')

  assert.throws(
    () => pruneNonRuntimeSource(root, { paths: ['docs'], keep: [path.relative(root, outside)] }),
    /kept runtime path escapes/u
  )
  assert.ok(fs.existsSync(path.join(root, 'docs/a.md')))
})

test('Google preview pruning refuses symlinked components and unlinks a symlinked document without following it', () => {
  const site = 'lib/python3.14/site-packages'
  const documents = `${site}/googleapiclient/discovery_cache/documents`

  for (const link of [`${site}`, `${site}/googleapiclient`, documents]) {
    const pythonRoot = tempDir('slim-python-')
    const outside = tempDir('slim-outside-')

    touch(outside, 'googleapiclient/discovery_cache/documents/compute.beta.json')
    touch(outside, 'discovery_cache/documents/compute.beta.json')
    touch(outside, 'compute.beta.json')
    touch(outside, 'documents/compute.beta.json')
    fs.mkdirSync(path.dirname(path.join(pythonRoot, link)), { recursive: true })

    const target = link === site ? outside : link.endsWith('googleapiclient') ? path.join(outside, 'googleapiclient') : outside

    fs.symlinkSync(target, path.join(pythonRoot, link))
    assert.throws(() => pruneGooglePreviewDiscoveryDocuments(pythonRoot), /not a real directory/u, link)

    for (const file of [
      'googleapiclient/discovery_cache/documents/compute.beta.json',
      'discovery_cache/documents/compute.beta.json',
      'compute.beta.json',
      'documents/compute.beta.json'
    ]) {
      assert.ok(fs.existsSync(path.join(outside, file)), `${file} outside must survive (${link})`)
    }
  }

  const pythonRoot = tempDir('slim-python-')
  const outside = tempDir('slim-outside-')

  touch(outside, 'compute.beta.json')
  touch(pythonRoot, `${documents}/gmail.v1.json`)
  fs.symlinkSync(path.join(outside, 'compute.beta.json'), path.join(pythonRoot, `${documents}/compute.beta.json`))

  assert.equal(pruneGooglePreviewDiscoveryDocuments(pythonRoot), 1)
  assert.ok(fs.existsSync(path.join(outside, 'compute.beta.json')))
  assert.ok(fs.existsSync(path.join(pythonRoot, `${documents}/gmail.v1.json`)))
})

// --- isolated staging probe -----------------------------------------------------------------------
// Uses the interpreter running these tests' host python (stdlib only) with fake first-party
// packages, so it runs everywhere without the locked dependencies.

const hostPython = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(candidate =>
  fs.existsSync(candidate)
)

const probeFixture = ({ withConfig = true } = {}) => {
  const checkout = tempDir('probe-checkout-')
  const staged = tempDir('probe-staged-')

  // The "full checkout" has everything; the pruned staged tree may lack a runtime file.
  touch(checkout, 'hermes_cli/__init__.py', '')
  touch(checkout, 'hermes_cli/config.py', 'FROM = "checkout"\n')
  touch(staged, 'hermes_cli/__init__.py', '')

  if (withConfig) {
    touch(staged, 'hermes_cli/config.py', 'FROM = "staged"\n')
  }

  return { checkout, staged }
}

/** Simulates the pre-fix invocation: inherited PYTHONPATH and a cwd inside the checkout. */
const hostileSpawn = checkout => (command, args, options) =>
  spawnSync(command, args, { ...options, cwd: checkout, env: { ...options.env, PYTHONPATH: checkout } })

test('the probe command is isolated: -I, an explicit sys.path entry, and no inherited environment', () => {
  const { command, args, env } = isolatedProbeCommand({
    python: '/x/python',
    sourceRoot: '/staged',
    inside: ['hermes_cli'],
    methods: ['a.b'],
    home: '/home'
  })

  assert.equal(command, '/x/python')
  assert.equal(args[0], '-I')
  assert.ok(args.includes('/staged'))
  assert.deepEqual(Object.keys(env).sort(), [
    'HERMES_HOME',
    'HERMES_TEST_ISOLATION',
    'PYTHONDONTWRITEBYTECODE',
    'PYTHON_DOTENV_DISABLED'
  ])
  assert.equal(env.PYTHONPATH, undefined)
})

test.skipIf(!hostPython)('the probe imports from the staged tree and reports module origins inside it', () => {
  const { checkout, staged } = probeFixture()
  const result = runIsolatedImportProbe({
    python: hostPython,
    sourceRoot: staged,
    inside: ['hermes_cli', 'hermes_cli.config'],
    spawn: hostileSpawn(checkout)
  })
  const realStaged = fs.realpathSync(staged)

  for (const origin of Object.values(result.origins)) {
    assert.ok(origin.startsWith(`${realStaged}${path.sep}`), `${origin} must be inside ${realStaged}`)
  }
})

test.skipIf(!hostPython)('a runtime file missing from the staged tree is not masked by the full checkout', () => {
  const { checkout, staged } = probeFixture({ withConfig: false })

  // The checkout is both the cwd and on PYTHONPATH here, and still must not satisfy the import.
  assert.throws(
    () =>
      runIsolatedImportProbe({
        python: hostPython,
        sourceRoot: staged,
        inside: ['hermes_cli', 'hermes_cli.config'],
        spawn: hostileSpawn(checkout)
      }),
    /No module named 'hermes_cli\.config'|ModuleNotFoundError/u
  )
})

test.skipIf(!hostPython)('the probe fails when a module resolves outside the staged tree', () => {
  const { checkout, staged } = probeFixture({ withConfig: false })

  // A staged package that redirects its submodules into the checkout, as a stray .pth or path hook could.
  fs.writeFileSync(
    path.join(staged, 'hermes_cli/__init__.py'),
    `__path__.append(${JSON.stringify(path.join(checkout, 'hermes_cli'))})\n`
  )

  assert.throws(
    () => runIsolatedImportProbe({ python: hostPython, sourceRoot: staged, inside: ['hermes_cli', 'hermes_cli.config'] }),
    /resolved outside the staged tree/u
  )
})

test.skipIf(!hostPython)('the probe rejects an interpreter that is not the staged one', () => {
  const { staged } = probeFixture()
  const otherRoot = tempDir('probe-python-')

  assert.throws(
    () =>
      runIsolatedImportProbe({
        python: hostPython,
        sourceRoot: staged,
        expectedPythonRoot: otherRoot,
        inside: ['hermes_cli']
      }),
    /not the staged interpreter/u
  )
})

// The strong check: archive the real repository the way the staging step does, prune it, and import
// what the packaged probe and the setup-method gate import. It needs a Python with the locked
// dependencies installed (the bundled runtime of an installed Atum, or a venv) and ~700 MB of
// scratch disk, so it runs when ATUM_SLIM_RUNTIME_PYTHON names such an interpreter.
const probePython = process.env.ATUM_SLIM_RUNTIME_PYTHON

test.skipIf(!probePython || !fs.existsSync(probePython))(
  'a pruned git archive still imports hermes_cli.config and tui_gateway.server and registers the setup RPCs',
  { timeout: 300_000 },
  () => {
    const staging = tempDir('slim-archive-')
    const tarball = path.join(staging, 'src.tar')
    const source = path.join(staging, 'hermes-agent')

    fs.mkdirSync(source)
    assert.equal(spawnSync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '--output', tarball, 'HEAD']).status, 0)
    assert.equal(spawnSync('tar', ['-xf', tarball, '-C', source]).status, 0)
    fs.rmSync(tarball)
    pruneNonRuntimeSource(source)

    // Same isolated invocation the staging step runs, so this test cannot drift from production.
    const result = runIsolatedImportProbe({
      python: probePython,
      sourceRoot: source,
      inside: ['hermes_cli', 'hermes_cli.config', 'tui_gateway', 'tui_gateway.server'],
      other: ['yaml', 'dotenv'],
      methods: [...REQUIRED_SETUP_RPC_METHODS]
    })

    assert.ok(String(result.python).startsWith('3.'))
  }
)
