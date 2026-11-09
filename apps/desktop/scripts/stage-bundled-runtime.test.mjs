import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import {
  pythonInstallNameCommands,
  assertCleanPackageSource,
  assertLockedBrowserDependencies,
  assertRuntimeBaselineInRepo,
  assertSafeRuntimeTarget,
  BUNDLED_PYTHON_VERSION,
  browserRuntimeConfig,
  mirroredArchiveUrl,
  compileRelocatableBytecode,
  ensureRuntimeBaselineHistory,
  excludeRestrictedStagedSkills,
  removeBytecodeCaches,
  RESTRICTED_RUNTIME_SOURCE_PATHS,
  rewriteInternalAbsoluteSymlinks,
  runtimeToolsConfig,
  stageNodeRuntime,
  stageRuntimeToolchain,
  stageRuntimeTools,
  targetConfig,
  validateBrowserRuntime,
  validateRuntimeBaseline,
  validateRuntimeTools
} from './stage-bundled-runtime.mjs'

import RUNTIME_BASELINE from '../runtime-baseline.json' with { type: 'json' }
import BROWSER_RUNTIME from '../browser-runtime.json' with { type: 'json' }
import RUNTIME_TOOLS from '../runtime-tools.json' with { type: 'json' }

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)

  return String(result.stdout || '').trim()
}

test('shallow staging hydrates the canonical history ref before verifying ancestry', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-shallow-history-'))
  const source = path.join(scratch, 'source')
  const shallow = path.join(scratch, 'shallow')
  const missingShallow = path.join(scratch, 'missing-shallow')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'README.md'), 'baseline\n')
  runGit(source, ['init', '--initial-branch', 'atum-main'])
  runGit(source, ['config', 'user.name', 'Atum Test'])
  runGit(source, ['config', 'user.email', 'atum-test@example.invalid'])
  runGit(source, ['add', 'README.md'])
  runGit(source, ['commit', '-m', 'baseline'])
  const upstreamCommit = runGit(source, ['rev-parse', 'HEAD'])
  fs.appendFileSync(path.join(source, 'README.md'), 'runtime\n')
  runGit(source, ['commit', '-am', 'runtime'])
  const overlayCommit = runGit(source, ['rev-parse', 'HEAD'])
  const overlayTree = runGit(source, ['rev-parse', 'HEAD^{tree}'])
  runGit(scratch, ['clone', '--quiet', '--depth', '1', '--branch', 'atum-main', `file://${source}`, shallow])
  runGit(scratch, ['clone', '--quiet', '--depth', '1', '--branch', 'atum-main', `file://${source}`, missingShallow])

  const baseline = {
    ...RUNTIME_BASELINE,
    upstreamHermesCommit: upstreamCommit,
    atumOverlayCommit: overlayCommit,
    atumOverlayTree: overlayTree
  }

  assert.equal(ensureRuntimeBaselineHistory(shallow, baseline), true)
  assert.equal(ensureRuntimeBaselineHistory(shallow, baseline), false)
  assert.deepEqual(assertRuntimeBaselineInRepo(shallow, baseline), baseline)
  assert.throws(
    () =>
      ensureRuntimeBaselineHistory(missingShallow, {
        ...baseline,
        upstreamHermesCommit: 'f'.repeat(40),
        atumOverlayCommit: 'e'.repeat(40)
      }),
    /absent after hydrating atum-main from origin/
  )
  assert.throws(
    () =>
      ensureRuntimeBaselineHistory(source, {
        ...RUNTIME_BASELINE,
        upstreamHermesCommit: 'f'.repeat(40),
        atumOverlayCommit: 'e'.repeat(40)
      }),
    /missing from a non-shallow package checkout/
  )
  fs.rmSync(scratch, { recursive: true })
  // Four git repos, two file:// clones and a dozen git subprocesses. Two
  // seconds on an idle machine, but the default 5s is not enough under a full
  // parallel suite run, which made this the flakiest test in the repo.
}, 30_000)

test('committed browser runtime pins the accepted arm64 Node, agent-browser, and Chromium payload', () => {
  assert.deepEqual(validateBrowserRuntime(), BROWSER_RUNTIME)
  assert.deepEqual(browserRuntimeConfig('darwin', 'arm64'), BROWSER_RUNTIME)
  assert.equal(browserRuntimeConfig('darwin', 'x64'), null)
  assert.equal(browserRuntimeConfig('linux', 'arm64'), null)
  assert.throws(
    () => validateBrowserRuntime({ ...BROWSER_RUNTIME, chromium: { ...BROWSER_RUNTIME.chromium, revision: 'latest' } }),
    /invalid committed browser runtime lock/
  )
})

test('installed browser dependencies match the committed runtime and npm locks', () => {
  const resolved = assertLockedBrowserDependencies(REPO_ROOT)

  assert.equal(resolved.locked.agentBrowser.version, BROWSER_RUNTIME.agentBrowser.version)
  assert.match(resolved.agentBrowserSource, /agent-browser-darwin-arm64$/u)
})

test('browser dependency lock resolution accepts hoisting and preserves nearest-package version checks', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-browser-lock-resolution-'))
  const packageLock = {
    packages: {
      '': { dependencies: { 'agent-browser': BROWSER_RUNTIME.agentBrowser.version } },
      'node_modules/agent-browser': {
        version: BROWSER_RUNTIME.agentBrowser.version,
        integrity: BROWSER_RUNTIME.agentBrowser.packageIntegrity
      },
      'node_modules/playwright-core': { version: BROWSER_RUNTIME.chromium.playwrightVersion }
    }
  }
  const saveLock = () => fs.writeFileSync(path.join(scratch, 'package-lock.json'), JSON.stringify(packageLock))

  try {
    fs.mkdirSync(path.join(scratch, 'node_modules'))
    fs.symlinkSync(
      fs.realpathSync(path.join(REPO_ROOT, 'node_modules', 'agent-browser')),
      path.join(scratch, 'node_modules', 'agent-browser'),
      'dir'
    )
    saveLock()
    assertLockedBrowserDependencies(scratch)

    packageLock.packages['node_modules/playwright-core'].version = '0.0.0'
    packageLock.packages['apps/desktop/node_modules/playwright-core'] = { version: BROWSER_RUNTIME.chromium.playwrightVersion }
    saveLock()
    assertLockedBrowserDependencies(scratch)

    packageLock.packages['node_modules/playwright-core'].version = BROWSER_RUNTIME.chromium.playwrightVersion
    packageLock.packages['apps/desktop/node_modules/playwright-core'].version = '0.0.0'
    saveLock()
    assert.throws(() => assertLockedBrowserDependencies(scratch), /browser runtime lock does not match/)

    delete packageLock.packages['apps/desktop/node_modules/playwright-core']
    packageLock.packages['node_modules/playwright-core'].version = '0.0.0'
    saveLock()
    assert.throws(() => assertLockedBrowserDependencies(scratch), /browser runtime lock does not match/)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('Node staging copies the pinned host, its license, and npm/npx from the same archive', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-browser-node-stage-'))
  const extractedRoot = path.join(scratch, 'extract')
  const browserRoot = path.join(scratch, 'browser')
  const sourceRoot = path.join(extractedRoot, BROWSER_RUNTIME.node.root)
  const npmSource = path.join(sourceRoot, 'lib', 'node_modules', 'npm')

  fs.mkdirSync(path.join(sourceRoot, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(npmSource, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(sourceRoot, 'include'), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'bin', 'node'), 'pinned node')
  fs.chmodSync(path.join(sourceRoot, 'bin', 'node'), 0o755)
  fs.writeFileSync(path.join(sourceRoot, 'LICENSE'), 'node license')
  fs.writeFileSync(path.join(sourceRoot, 'include', 'node.h'), 'headers stay out')
  fs.writeFileSync(path.join(npmSource, 'package.json'), '{"name":"npm"}')
  fs.writeFileSync(path.join(npmSource, 'LICENSE'), 'npm license')
  fs.writeFileSync(path.join(npmSource, 'bin', 'npm-cli.js'), '#!/usr/bin/env node')
  fs.writeFileSync(path.join(npmSource, 'bin', 'npx-cli.js'), '#!/usr/bin/env node')
  fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(sourceRoot, 'bin', 'npm'))

  const node = stageNodeRuntime({ extractedRoot, browserRoot, config: BROWSER_RUNTIME })
  const nodeRoot = path.join(browserRoot, 'node')

  assert.equal(fs.readFileSync(node, 'utf8'), 'pinned node')
  assert.equal(fs.statSync(node).mode & 0o111, 0o111)
  assert.equal(fs.readFileSync(path.join(nodeRoot, 'LICENSE'), 'utf8'), 'node license')
  assert.equal(fs.readFileSync(path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'LICENSE'), 'utf8'), 'npm license')
  // npm and npx are relative links inside the runtime, so the bundle stays relocatable.
  for (const [name, script] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) {
    assert.equal(fs.readlinkSync(path.join(nodeRoot, 'bin', name)), `../lib/node_modules/npm/bin/${script}`)
    assert.equal(fs.readFileSync(path.join(nodeRoot, 'bin', name), 'utf8'), '#!/usr/bin/env node')
  }
  assert.equal(fs.existsSync(path.join(nodeRoot, 'include')), false)
  fs.rmSync(scratch, { recursive: true })
})

test('Node staging refuses an archive without npm', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-browser-node-stage-'))
  const sourceRoot = path.join(scratch, 'extract', BROWSER_RUNTIME.node.root)

  fs.mkdirSync(path.join(sourceRoot, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'bin', 'node'), 'pinned node')
  fs.writeFileSync(path.join(sourceRoot, 'LICENSE'), 'node license')
  assert.throws(
    () => stageNodeRuntime({ extractedRoot: path.join(scratch, 'extract'), browserRoot: path.join(scratch, 'browser'), config: BROWSER_RUNTIME }),
    /does not carry npm/
  )
  fs.rmSync(scratch, { recursive: true })
})

test('committed runtime tools pin arm64 uv/uvx by digest, with their licence texts', () => {
  assert.deepEqual(validateRuntimeTools(), RUNTIME_TOOLS)
  assert.deepEqual(runtimeToolsConfig('darwin', 'arm64'), RUNTIME_TOOLS)
  assert.equal(runtimeToolsConfig('darwin', 'x64'), null)
  // tirith is AGPL-3.0: Hermes downloads it on first use instead of the bundle carrying it.
  assert.equal(RUNTIME_TOOLS.tirith, undefined)
  for (const broken of [
    { ...RUNTIME_TOOLS, uv: { ...RUNTIME_TOOLS.uv, url: 'https://example.com/uv.tar.gz' } },
    { ...RUNTIME_TOOLS, uv: { ...RUNTIME_TOOLS.uv, sha256: 'latest' } },
    { ...RUNTIME_TOOLS, uv: { ...RUNTIME_TOOLS.uv, version: 'latest' } },
    { ...RUNTIME_TOOLS, uv: { ...RUNTIME_TOOLS.uv, licenses: [] } },
    { ...RUNTIME_TOOLS, uv: { ...RUNTIME_TOOLS.uv, executables: [{ name: '../uv', sha256: 'a'.repeat(64) }] } }
  ]) {
    assert.throws(() => validateRuntimeTools(broken), /invalid committed runtime tools lock/)
  }
})

test('runtime tools stage verified executables and licences', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-tools-'))
  const digest = text => createHash('sha256').update(text).digest('hex')
  const bytes = {}
  const executables = {}

  // Fixture content whose digests stand in for the pinned ones.
  const lock = structuredClone(RUNTIME_TOOLS)
  for (const executable of lock.uv.executables) {
    executables[executable.name] = `binary:${executable.name}`
    executable.sha256 = digest(executables[executable.name])
  }
  for (const license of lock.uv.licenses) {
    bytes[license.url] = `license:${license.name}`
    license.sha256 = digest(bytes[license.url])
  }

  const downloads = []
  const download = ({ url, sha256, destination }) => {
    downloads.push(url)
    const body = bytes[url] ?? `archive:${url}`
    if (bytes[url] !== undefined && digest(body) !== sha256) throw new Error('digest mismatch')
    fs.writeFileSync(destination, body)
  }
  const extract = (_archive, destination) => {
    const root = path.join(destination, lock.uv.root)
    fs.mkdirSync(root, { recursive: true })
    for (const executable of lock.uv.executables) fs.writeFileSync(path.join(root, executable.name), executables[executable.name])
  }

  const staged = stageRuntimeTools({ scratchRoot: scratch, platform: 'darwin', arch: 'arm64', download, extract, probe: () => {}, config: lock })

  for (const name of ['uv', 'uvx']) {
    assert.equal(fs.readFileSync(path.join(scratch, 'tools', 'uv', 'bin', name), 'utf8'), executables[name])
    assert.equal(fs.statSync(path.join(scratch, 'tools', 'uv', 'bin', name)).mode & 0o111, 0o111)
  }
  assert.equal(fs.readFileSync(path.join(scratch, 'tools', 'uv', 'LICENSE-MIT'), 'utf8'), 'license:LICENSE-MIT')
  assert.equal(fs.readFileSync(path.join(scratch, 'tools', 'uv', 'LICENSE-APACHE'), 'utf8'), 'license:LICENSE-APACHE')
  assert.deepEqual(fs.readdirSync(path.join(scratch, 'tools')), ['uv'])
  assert.equal(fs.existsSync(path.join(scratch, '.tools-downloads')), false)
  assert.deepEqual(Object.keys(staged), ['schemaVersion', 'uv'])
  assert.equal(staged.uv.license, RUNTIME_TOOLS.uv.license)
  assert.deepEqual(staged.uv.executables.map(executable => executable.path), ['tools/uv/bin/uv', 'tools/uv/bin/uvx'])
  assert.ok(downloads.includes(lock.uv.url))

  // A binary that is not the pinned one never reaches the bundle.
  executables.uvx = 'tampered'
  const again = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-tools-'))
  assert.throws(
    () => stageRuntimeTools({ scratchRoot: again, platform: 'darwin', arch: 'arm64', download, extract, probe: () => {}, config: lock }),
    /does not match the committed runtime tools lock/
  )
  assert.equal(stageRuntimeTools({ scratchRoot: again, platform: 'darwin', arch: 'x64', download, extract, probe: () => {}, config: lock }), null)
  fs.rmSync(scratch, { recursive: true })
  fs.rmSync(again, { recursive: true })
})

test('runtime staging builds with the verified bundled uv unless UV overrides it', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-toolchain-'))
  const stagedTools = { schemaVersion: 1, uv: { version: RUNTIME_TOOLS.uv.version } }
  const calls = []
  const stage = options => {
    calls.push(options)
    const executable = path.join(options.scratchRoot, 'tools', 'uv', 'bin', 'uv')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, 'verified uv')
    return stagedTools
  }

  const pinned = stageRuntimeToolchain({
    scratchRoot: scratch,
    platform: 'darwin',
    arch: 'arm64',
    uvOverride: undefined,
    stage
  })
  assert.equal(pinned.uv, path.join(scratch, 'tools', 'uv', 'bin', 'uv'))
  assert.equal(fs.readFileSync(pinned.uv, 'utf8'), 'verified uv')
  assert.equal(pinned.tools, stagedTools)

  const overridden = stageRuntimeToolchain({
    scratchRoot: scratch,
    platform: 'darwin',
    arch: 'arm64',
    uvOverride: '/operator/uv',
    stage
  })
  assert.equal(overridden.uv, '/operator/uv')
  assert.equal(overridden.tools, stagedTools)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { scratchRoot: scratch, platform: 'darwin', arch: 'arm64' })
  fs.rmSync(scratch, { recursive: true })
})

test('runtime target matrix pins CPython 3.14 for both supported Mac architectures', () => {
  assert.deepEqual(targetConfig('darwin', 'arm64'), {
    pythonInstallKey: `cpython-${BUNDLED_PYTHON_VERSION}-macos-aarch64-none`,
    pythonPlatform: 'aarch64-apple-darwin'
  })
  assert.deepEqual(targetConfig('darwin', 'x64'), {
    pythonInstallKey: `cpython-${BUNDLED_PYTHON_VERSION}-macos-x86_64-none`,
    pythonPlatform: 'x86_64-apple-darwin'
  })
})

test('unsupported platform or architecture fails closed before staging', () => {
  assert.throws(() => targetConfig('linux', 'x64'), /supports macOS only/)
  assert.throws(() => targetConfig('darwin', 'universal'), /unsupported macOS/)
})

test('staging cleanup is constrained to an explicitly named runtime build directory', () => {
  const target = path.join(os.tmpdir(), 'Atum.app', 'Contents', 'Resources', 'runtime')
  assert.equal(assertSafeRuntimeTarget(target), path.resolve(target))
  assert.throws(() => assertSafeRuntimeTarget('/'), /refusing unsafe/)
  assert.throws(() => assertSafeRuntimeTarget(os.tmpdir()), /refusing unsafe/)
})

test('packaging refuses tracked dirty state unless the development override is explicit', () => {
  assert.equal(assertCleanPackageSource('', false), false)
  assert.throws(
    () => assertCleanPackageSource(' M apps/desktop/electron/main.ts', false),
    /split renderer\/backend tree/
  )
  assert.equal(assertCleanPackageSource(' M apps/desktop/electron/main.ts', true), true)
})

test('copied Python aliases are rewritten from staging absolutes to relocatable links', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-links-'))
  const installedRoot = path.join(scratch, 'python-install', 'cpython-test')
  const bundledRoot = path.join(scratch, 'runtime-test')
  fs.mkdirSync(path.join(installedRoot, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(bundledRoot, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(installedRoot, 'bin', 'python3.14'), 'python')
  fs.copyFileSync(path.join(installedRoot, 'bin', 'python3.14'), path.join(bundledRoot, 'bin', 'python3.14'))
  fs.symlinkSync(path.join(installedRoot, 'bin', 'python3.14'), path.join(bundledRoot, 'bin', 'python3'))

  assert.equal(rewriteInternalAbsoluteSymlinks(bundledRoot, installedRoot), 1)
  assert.equal(fs.readlinkSync(path.join(bundledRoot, 'bin', 'python3')), 'python3.14')
  fs.rmSync(path.join(scratch, 'python-install'), { recursive: true })
  assert.equal(
    fs.realpathSync(path.join(bundledRoot, 'bin', 'python3')),
    fs.realpathSync(path.join(bundledRoot, 'bin', 'python3.14'))
  )
  fs.rmSync(scratch, { recursive: true })
})

test('packaged runtime removes relocatable bytecode caches before signing', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-bytecode-'))
  fs.mkdirSync(path.join(scratch, 'lib', '__pycache__'), { recursive: true })
  fs.mkdirSync(path.join(scratch, 'site-packages'), { recursive: true })
  fs.writeFileSync(path.join(scratch, 'lib', '__pycache__', 'argparse.cpython-311.pyc'), 'compiled')
  fs.writeFileSync(path.join(scratch, 'site-packages', 'legacy.pyo'), 'compiled')
  fs.writeFileSync(path.join(scratch, 'site-packages', 'module.py'), 'source')

  assert.equal(removeBytecodeCaches(scratch), 2)
  assert.equal(fs.existsSync(path.join(scratch, 'lib', '__pycache__')), false)
  assert.equal(fs.existsSync(path.join(scratch, 'site-packages', 'legacy.pyo')), false)
  assert.equal(fs.readFileSync(path.join(scratch, 'site-packages', 'module.py'), 'utf8'), 'source')
  fs.rmSync(scratch, { recursive: true })
})

test('staging excludes only known restricted source and generated-skill copies', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-restricted-skills-stage-'))
  const sourceRoot = path.join(scratch, 'hermes-agent')
  const restrictedFiles = RESTRICTED_RUNTIME_SOURCE_PATHS.map(sourcePath =>
    sourcePath.startsWith('skills/')
      ? path.join(sourceRoot, sourcePath, 'LICENSE.txt')
      : path.join(sourceRoot, sourcePath)
  )
  const preservedFiles = [
    path.join(sourceRoot, 'skills', 'productivity', 'word', 'SKILL.md'),
    path.join(sourceRoot, 'skills', 'research', 'SKILL.md'),
    path.join(sourceRoot, 'tools', 'word_processor.py')
  ]

  for (const file of [...restrictedFiles, ...preservedFiles]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, file)
  }

  const excluded = excludeRestrictedStagedSkills(sourceRoot)

  assert.deepEqual(excluded, RESTRICTED_RUNTIME_SOURCE_PATHS)
  for (const file of restrictedFiles) assert.equal(fs.existsSync(file), false)
  for (const file of preservedFiles) assert.equal(fs.readFileSync(file, 'utf8'), file)
  fs.rmSync(scratch, { recursive: true })
})

test('packaged runtime produces relocation-safe unchecked-hash bytecode', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-runtime-hash-bytecode-'))
  const pythonRoot = path.join(scratch, 'runtime-test')
  const sourceRoot = path.join(scratch, 'hermes-agent')
  fs.mkdirSync(path.join(pythonRoot, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(pythonRoot, 'package'), { recursive: true })
  fs.mkdirSync(path.join(sourceRoot, 'agent'), { recursive: true })
  fs.symlinkSync('/usr/bin/python3', path.join(pythonRoot, 'bin', 'python3.14'))
  fs.writeFileSync(path.join(pythonRoot, 'package', 'module.py'), 'value = 1\n')
  fs.writeFileSync(path.join(sourceRoot, 'agent', 'helper.py'), 'value = 2\n')

  compileRelocatableBytecode({ pythonRoot, sourceRoots: [sourceRoot] })

  for (const cache of [
    path.join(pythonRoot, 'package', '__pycache__'),
    path.join(sourceRoot, 'agent', '__pycache__')
  ]) {
    const [actual] = fs.readdirSync(cache).filter(name => name.endsWith('.pyc'))
    assert.ok(actual)
    const bytes = fs.readFileSync(path.join(cache, actual))
    assert.equal(bytes.readUInt32LE(4), 1)
  }
  fs.rmSync(scratch, { recursive: true })
})

// Google answers the Chrome for Testing bucket with
// "this service is not available in your location" in some regions — a hard 403
// on every version, so a contributor there cannot build at all while CI, on US
// runners, never sees it. A mirror is safe here ONLY because the sha256 pin is
// unchanged: it can supply the canonical bytes or fail, nothing else.
test('the Chromium mirror substitutes only where the pinned artifact is served from', () => {
  const canonical = browserRuntimeConfig('darwin', 'arm64').chromium.url
  const mirror = 'https://cdn.npmmirror.com/binaries/chrome-for-testing'

  // Unset or blank leaves the canonical host exactly as pinned.
  assert.equal(mirroredArchiveUrl(canonical, undefined), canonical)
  assert.equal(mirroredArchiveUrl(canonical, ''), canonical)
  assert.equal(mirroredArchiveUrl(canonical, '   '), canonical)

  // The version, platform and filename still come from the pinned config, so
  // the variable cannot be aimed at an unrelated artifact.
  const tail = '145.0.7632.6/mac-arm64/chrome-headless-shell-mac-arm64.zip'
  assert.equal(mirroredArchiveUrl(canonical, mirror), `${mirror}/${tail}`)
  assert.equal(mirroredArchiveUrl(canonical, `${mirror}///`), `${mirror}/${tail}`)

  // A downgrade to plaintext is refused rather than silently accepted.
  assert.throws(() => mirroredArchiveUrl(canonical, 'http://mirror.invalid'), /https/u)
})

// uv names libpython after the build machine's install folder; the staged copy must not carry
// that path into the app. Real tools on a real dylib, on macOS where the runtime is built.
test.skipIf(process.platform !== 'darwin')('names the staged libpython @rpath and keeps it signed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-libpython-name-'))

  try {
    const lib = path.join(root, 'python', 'lib')
    fs.mkdirSync(lib, { recursive: true })
    const source = path.join(root, 'empty.c')
    const library = path.join(lib, 'libpython3.14.dylib')
    const buildPath = path.join(root, 'build-machine', 'python-install', 'lib', 'libpython3.14.dylib')
    fs.writeFileSync(source, 'int atum_libpython_probe(void) { return 1; }\n')
    const built = spawnSync('cc', ['-dynamiclib', '-o', library, `-Wl,-install_name,${buildPath}`, source], { encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)

    for (const [command, args] of pythonInstallNameCommands(path.join(root, 'python'))) {
      const result = spawnSync(command, args, { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }

    const name = spawnSync('otool', ['-D', library], { encoding: 'utf8' })
    assert.equal(name.stdout.trim().split('\n').at(-1), '@rpath/libpython3.14.dylib')
    assert.doesNotMatch(name.stdout, /build-machine/)
    assert.equal(spawnSync('codesign', ['--verify', library]).status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
