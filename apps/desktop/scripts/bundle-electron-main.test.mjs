import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { test } from 'vitest'

import { bundleElectronMain } from '../scripts/bundle-electron-main.mjs'
import PACKAGE_JSON from '../package.json' with { type: 'json' }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Count how many times the bundle declares a top-level binding literally named
 * `createRequire`. A renamed import such as `createRequire as createNodeRequire`
 * does not count, because its runtime binding is `createNodeRequire` and will not
 * collide with the banner's `createRequire`.
 */
function countCreateRequireBindings(source) {
  // Matches exactly `import { createRequire } from 'module'` (with optional
  // whitespace) and the `node:module` specifier variant.
  const importRe = /import\s+\{\s*createRequire\s*\}\s+from\s+['"](?:node:)?module['"]/g
  return (source.match(importRe) ?? []).length
}

test('bundled electron-main does not declare createRequire more than once', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bundle-electron-main-'))
  try {
    await bundleElectronMain({ root, distDir, dev: true, silent: true })

    const mainBundle = fs.readFileSync(path.join(distDir, 'electron-main.mjs'), 'utf8')
    const bindingCount = countCreateRequireBindings(mainBundle)

    assert.equal(
      bindingCount,
      1,
      `expected exactly one createRequire binding in electron-main.mjs, found ${bindingCount}`
    )
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true })
  }
})

test('bundled electron-main still loads the atum-vibrancy native bridge', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bundle-electron-main-'))
  try {
    await bundleElectronMain({ root, distDir, dev: true, silent: true })

    const mainBundle = fs.readFileSync(path.join(distDir, 'electron-main.mjs'), 'utf8')

    assert.match(
      mainBundle,
      /atum_vibrancy\.node/,
      'expected electron-main.mjs to contain atum_vibrancy.node candidate paths'
    )
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true })
  }
})

test('realtime coordinator is self-contained when started from a clean package directory', async () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-realtime-clean-package-'))
  const bundlePath = path.join(packageDir, 'sync-coordinator.mjs')
  const originalWebSocket = globalThis.WebSocket

  try {
    assert.match(
      PACKAGE_JSON.dependencies['@supabase/realtime-js'],
      /^=\d+\.\d+\.\d+$/,
      'desktop must declare an exact @supabase/realtime-js version'
    )
    await build({
      entryPoints: [path.join(root, 'electron', 'atum-messaging', 'sync-coordinator.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: bundlePath,
      logLevel: 'silent'
    })

    const source = fs.readFileSync(bundlePath, 'utf8')
    assert.doesNotMatch(
      source,
      /['"]@supabase\/realtime-js['"]/,
      'clean package bundle must not retain a bare @supabase/realtime-js import'
    )
    assert.match(source, /RealtimeClient/, 'clean package bundle must contain the pinned realtime client')

    class FakeWebSocket {
      readyState = 0
      onopen = null
      onmessage = null
      onclose = null
      onerror = null
      close() {
        this.readyState = 3
      }
      send() {}
    }

    globalThis.WebSocket = FakeWebSocket
    const { MessagingSyncCoordinator } = await import(pathToFileURL(bundlePath).href)
    const logs = []
    const account = {
      baseUrl: 'https://atum.test',
      user: { id: 'account-a', displayName: null, handle: null },
      tokens: { accessToken: 'access-token', refreshToken: null, expiresAt: null }
    }
    const coordinator = new MessagingSyncCoordinator({
      realtimeUrl: 'https://atum.test',
      anonKey: 'anon-key',
      tokens: { current: () => account, refresh: async () => null },
      advertisement: async () => ({ topic: 'private:unused', event: 'cursor_hint' }),
      sync: async () => ({ cursor: null }),
      status: async () => ({ cursor: null }),
      log: message => logs.push(message)
    })

    await coordinator.start()
    assert.deepEqual(coordinator.status(), { accountId: 'account-a', healthy: false, state: 'connecting' })
    assert.deepEqual(logs, [])
    coordinator.stop()
  } finally {
    globalThis.WebSocket = originalWebSocket
    fs.rmSync(packageDir, { recursive: true, force: true })
  }
})
