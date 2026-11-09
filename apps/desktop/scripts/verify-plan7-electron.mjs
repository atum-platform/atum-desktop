#!/usr/bin/env node
/**
 * Electron SDK producer proof for P7-3.
 *
 * This is intentionally narrower than full application-main acceptance.  It
 * starts a disposable native Electron main harness with the production SDK
 * preload and browser bundle, authenticates every SDK IPC event against the
 * exact hidden webContents/origin, and drives the production MatrixSdkHost
 * queue against the producer's already-live synthetic Synapse fixture.
 *
 * It never starts product Matrix main, touches safeStorage/Keychain, accepts a
 * provider/model, or contacts a non-loopback origin.  The producer owns the
 * synthetic users, tokens, rooms, stack lifecycle, and calls this exported
 * function after its Node engine exits but before it tears the fixture down.
 */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { spawn } from 'node:child_process'

import { build } from 'esbuild'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(desktop, 'package.json'))
const EXPECTED_CHECKS = Object.freeze([
  'electron-sdk-preload-authenticated',
  'electron-sdk-for-turn-main-admitted',
  'electron-sdk-for-turn-earlier-refused',
  'electron-sdk-for-turn-stray-refused',
  'electron-sdk-display-earlier-admitted',
  'electron-sdk-marker-projection-closed'
])

function fail(code) {
  throw new Error(code)
}

function loopbackBase(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) ? url : undefined
  } catch {
    return undefined
  }
}

function validFixture(fixture) {
  const rooms = fixture?.rooms
  const matrix = fixture?.matrix

  return Boolean(
    loopbackBase(matrix?.baseUrl) &&
      typeof matrix?.userId === 'string' && matrix.userId.startsWith('@') &&
      typeof matrix.deviceId === 'string' && matrix.deviceId &&
      typeof matrix.accessToken === 'string' && matrix.accessToken &&
      typeof matrix.storageKey === 'string' && matrix.storageKey &&
      typeof fixture.ownerId === 'string' && fixture.ownerId.startsWith('@') &&
      typeof fixture.agentId === 'string' && fixture.agentId.startsWith('@') &&
      typeof fixture.ownerDeviceId === 'string' && fixture.ownerDeviceId &&
      matrix.userId === fixture.ownerId &&
      matrix.deviceId === fixture.ownerDeviceId &&
      [rooms?.main, rooms?.earlier, rooms?.stray].every(value => typeof value === 'string' && value.startsWith('!')) &&
      typeof fixture.workspace === 'string' && path.isAbsolute(fixture.workspace)
  )
}

function safeFailure(error) {
  const code = error instanceof Error ? error.message : ''

  return /^electron_(?:sdk_producer_failed|proof_(?:fixture_invalid|fixture_permissions|argument_invalid|origin_refused|asset_invalid|timeout|failed_(?:build|binary|child|fixture|ready|load|main|earlier|stray|display|marker)_(?:preload|startup|operation)))$/.test(code)
    ? code
    : 'electron_sdk_producer_failed'
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  return directory
}

function privateFile(file, value) {
  writeFileSync(file, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

async function buildHarness(output) {
  const assets = privateDirectory(path.join(output, 'assets'))
  await build({
    entryPoints: [path.join(desktop, 'scripts', 'plan7-electron-bootstrap.ts')],
    outfile: path.join(output, 'main.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'silent'
  })
  await build({
    entryPoints: [path.join(desktop, 'electron', 'matrix', 'sdk-preload.ts')],
    outfile: path.join(assets, 'matrix-sdk-preload.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    logLevel: 'silent'
  })
  await build({
    entryPoints: [path.join(desktop, 'src', 'matrix', 'sdk-entry.ts')],
    outfile: path.join(assets, 'matrix-sdk.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome140',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent'
  })
  mkdirSync(path.join(assets, 'pkg'), { recursive: true, mode: 0o700 })
  copyFileSync(path.join(desktop, 'matrix-sdk.html'), path.join(assets, 'matrix-sdk.html'))
  const wasm = path.join(path.dirname(require.resolve('@matrix-org/matrix-sdk-crypto-wasm')), 'pkg', 'matrix_sdk_crypto_wasm_bg.wasm')
  copyFileSync(wasm, path.join(assets, 'pkg', 'matrix_sdk_crypto_wasm_bg.wasm'))

  return assets
}

function electronBinary() {
  const binary = require('electron')

  if (typeof binary !== 'string' || !binary) fail('electron_sdk_producer_failed')

  return binary
}

function childEnvironment(workspace) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: privateDirectory(path.join(workspace, 'home')),
    TMPDIR: privateDirectory(path.join(workspace, 'tmp')),
    LANG: 'C',
    LC_ALL: 'C'
  }
}

/**
 * Run the standalone native Electron SDK producer proof.
 *
 * `fixture` is supplied by verify-plan7-producer after it has stopped its
 * Node engine and before it revokes synthetic credentials or tears down its
 * loopback stack. Its credential-bearing values are placed in a mode-0600
 * temporary file solely for the spawned Electron process, then deleted.
 *
 * @param {{ matrix: { baseUrl: string, userId: string, deviceId: string, accessToken: string, storageKey: string }, ownerId: string, agentId: string, rooms: { main: string, earlier: string, stray: string }, ownerDeviceId: string, workspace: string }} fixture
 * @returns {Promise<{checks: string[], evidence: {kind: string, sha256: string}}>} names and digest only
 */
export async function runElectronProof(fixture) {
  if (!validFixture(fixture)) fail('electron_proof_fixture_invalid')

  const suppliedWorkspace = privateDirectory(fixture.workspace)
  if ((statSync(suppliedWorkspace).mode & 0o077) !== 0) fail('electron_proof_fixture_permissions')
  const output = mkdtempSync(path.join(suppliedWorkspace, 'electron-sdk-proof-'))
  chmodSync(output, 0o700)
  const fixtureFile = path.join(output, 'fixture.json')
  let child
  let stopTimer
  let phase = 'build'

  try {
    privateFile(fixtureFile, fixture)
    const assets = await buildHarness(output)
    phase = 'binary'
    const binary = electronBinary()
    phase = 'child'
    child = spawn(binary, [path.join(output, 'main.mjs'), `--fixture=${fixtureFile}`, `--assets=${assets}`], {
      cwd: desktop,
      env: childEnvironment(output),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    let result
    let childError

    child.on('message', message => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'plan7-electron-proof' && Array.isArray(message.checks)) result = message
      if (message.type === 'plan7-electron-proof-failed' && typeof message.code === 'string') childError = message.code
    })
    const exited = once(child, 'exit').catch(() => [undefined])
    const spawnFailed = once(child, 'error').then(() => [undefined])
    stopTimer = setTimeout(() => {
      child?.kill('SIGTERM')
      setTimeout(() => child?.kill('SIGKILL'), 5_000).unref()
    }, 240_000)
    const [exitCode] = await Promise.race([exited, spawnFailed])
    clearTimeout(stopTimer)
    stopTimer = undefined

    if (exitCode !== 0 || childError || !result || result.checks.join('\n') !== EXPECTED_CHECKS.join('\n')) {
      fail(typeof childError === 'string' ? childError : `electron_proof_failed_${phase}_operation`)
    }

    const checks = [...result.checks]
    return {
      checks,
      evidence: {
        kind: 'electron-sdk-producer-proof/v1',
        sha256: createHash('sha256').update(JSON.stringify({ kind: 'electron-sdk-producer-proof/v1', checks })).digest('hex'),
        artifacts: Object.fromEntries([
          ['nativeHarness', path.join(output, 'main.mjs')],
          ['sdkPreload', path.join(assets, 'matrix-sdk-preload.js')],
          ['sdkEntry', path.join(assets, 'matrix-sdk.js')],
          ['cryptoWasm', path.join(assets, 'pkg', 'matrix_sdk_crypto_wasm_bg.wasm')]
        ].map(([name, file]) => [name, createHash('sha256').update(readFileSync(file)).digest('hex')])),
        electronVersion: require('electron/package.json').version
      }
    }
  } catch (error) {
    const failure = safeFailure(error)
    fail(failure === 'electron_sdk_producer_failed' ? `electron_proof_failed_${phase}_operation` : failure)
  } finally {
    clearTimeout(stopTimer)
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        once(child, 'exit').catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5_000))
      ])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    rmSync(output, { recursive: true, force: true, maxRetries: 3 })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error('verify-plan7-electron.mjs is invoked by verify-plan7-producer.mjs with its live synthetic fixture.')
  process.exitCode = 2
}
