// Pre-auth browser/asset readiness only, not MAS or encrypted-device acceptance.
// Requires an already-running fixed loopback host. Never imports a user profile.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [playwrightModule, chromiumExecutable] = process.argv.slice(2)
if (!playwrightModule || !chromiumExecutable) {
  throw new Error('Usage: node proof/host-readiness.mjs ABSOLUTE_PLAYWRIGHT_MODULE ABSOLUTE_CACHED_CHROMIUM')
}
const { chromium } = createRequire(import.meta.url)(resolve(playwrightModule))
const profile = mkdtempSync(join(tmpdir(), 'atum-browser-host-readiness-'))
let context
const errors = []
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: resolve(chromiumExecutable)
  })
  const first = await context.newPage()
  first.on('pageerror', () => errors.push('pageerror'))
  first.on('console', msg => { if (msg.type() === 'error') errors.push('console_error') })
  await first.goto('http://localhost:4317')
  await first.locator('#notice').filter({ hasText: 'Ready to sign in with a disposable local account.' }).waitFor()
  const capabilities = await first.evaluate(() => ({
    secureContext: isSecureContext, webCrypto: !!crypto.subtle,
    indexedDb: !!indexedDB.databases, webLocks: !!navigator.locks,
    wasm: typeof WebAssembly.compile === 'function'
  }))
  assert.ok(Object.values(capabilities).every(Boolean))
  assert.equal(await first.locator('#identity').innerText(), 'Signed out')
  const assets = await first.evaluate(async () => {
    const paths = ['/crypto/index.mjs', '/crypto/pkg/matrix_sdk_crypto_wasm_bg.js', '/crypto/pkg/matrix_sdk_crypto_wasm_bg.wasm']
    const results = []
    for (const path of paths) {
      const response = await fetch(path)
      if (!response.ok) throw new Error('asset_unavailable')
      if (path.endsWith('.wasm')) await WebAssembly.compile(await response.arrayBuffer())
      results.push({ path, status: response.status, type: response.headers.get('content-type') })
    }
    await import('/crypto/index.mjs')
    return results
  })
  const second = await context.newPage()
  second.on('pageerror', () => errors.push('pageerror'))
  second.on('console', msg => { if (msg.type() === 'error') errors.push('console_error') })
  await second.goto('http://localhost:4317')
  await second.locator('#notice[data-error]').filter({ hasText: 'This device is open in another tab.' }).waitFor()
  assert.equal(await second.locator('#login').isEnabled(), false)
  await first.close()
  await second.reload()
  await second.locator('#notice').filter({ hasText: 'Ready to sign in with a disposable local account.' }).waitFor()
  assert.equal(await second.locator('#login').isEnabled(), true)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ capabilities, assets, preAuthDuplicateTabDenied: true,
    preAuthWriterReleasedOnClose: true, pageErrors: errors, realOAuthOrCryptoAcceptance: false }))
} finally {
  await context?.close()
  // This exact directory was just created above and never used for login.
  rmSync(profile, { recursive: true, force: true })
}
