// Fault injection only into fresh, owned disposable profiles. No existing crypto store
// is cleared. Private fixture values never become output or external review context.
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { browserTools } from './browser-tools.mjs'

export function faultRecords(active) {
  if (active?.kind !== 'session' || active.phase !== 'active') throw new Error('active_fixture_required')
  return [
    ['malformed-key', { ...active, storageKey: 'not-a-key' }],
    ['foreign-issuer', { ...active, issuer: 'https://wrong-issuer.invalid/' }],
    ['wrong-device-scope', { ...active, deviceId: active.deviceId + '_wrong' }],
    ['uncertain-rotation', { ...active, phase: 'refreshing' }],
    ['missing-crypto-stores', { ...active }]
  ]
}

async function run() {
  const runtime = join(dirname(fileURLToPath(import.meta.url)), '.runtime')
  if (!lstatSync(runtime).isDirectory() || lstatSync(runtime).isSymbolicLink() || JSON.parse(readFileSync(join(runtime, 'owner.json'), 'utf8')).project !== 'atum-cx-browser-proof') throw new Error('owned_runtime_required')
  const active = JSON.parse(readFileSync(join(runtime, 'fault-fixture.json'), 'utf8'))
  if (active.issuer !== 'https://localhost:22981/' || active.baseUrl !== 'https://localhost:22909' || active.redirectUri !== 'http://localhost:4317/callback') throw new Error('owned_fixture_required')
  const { chromium, executablePath } = browserTools()
  const certificate = new X509Certificate(readFileSync(join(runtime, 'tls/server.pem')))
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  let passed = true
  for (const [name, injected] of faultRecords(active)) {
    const profile = join(runtime, 'storage-fault-profile-' + name)
    if (existsSync(profile)) throw new Error('fault_profile_already_exists:preserve_failed_state')
    mkdirSync(profile, { mode: 0o700 })
    let context
    const result = { fault: name, recoveryNotice: false, replacementLoginDisabled: false, originalInjectedRecordPreserved: false, noCryptoDeviceCreated: false, noTokenExchange: false }
    try {
      context = await chromium.launchPersistentContext(profile, { headless: true, executablePath, args: [`--ignore-certificate-errors-spki-list=${spki}`] })
      let tokenRequests = 0
      context.on('request', request => { if (new URL(request.url()).origin + new URL(request.url()).pathname === 'https://localhost:22981/oauth2/token') tokenRequests++ })
      const page = await context.newPage()
      await page.goto('http://localhost:4317', { waitUntil: 'domcontentloaded' })
      await page.locator('#login:enabled').waitFor()
      await page.evaluate(record => new Promise((resolve, reject) => {
        const request = indexedDB.open('atum-browser-first-device-v1')
        request.onerror = () => reject(new Error('private_store_unavailable'))
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('bound-device', 'readwrite')
          tx.objectStore('bound-device').put(record, 'human')
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onabort = tx.onerror = () => { db.close(); reject(new Error('private_store_unavailable')) }
        }
      }), injected)
      await page.reload()
      await page.locator('#notice').filter({ hasText: 'This saved device needs recovery.' }).waitFor()
      result.recoveryNotice = true
      result.replacementLoginDisabled = await page.locator('#login').isDisabled()
      result.originalInjectedRecordPreserved = await page.evaluate(record => new Promise((resolve, reject) => {
        const request = indexedDB.open('atum-browser-first-device-v1')
        request.onerror = () => reject(new Error('private_store_unavailable'))
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('bound-device', 'readonly')
          const value = tx.objectStore('bound-device').get('human')
          tx.oncomplete = () => { db.close(); resolve(JSON.stringify(value.result) === JSON.stringify(record)) }
          tx.onabort = tx.onerror = () => { db.close(); reject(new Error('private_store_unavailable')) }
        }
      }), injected)
      result.noCryptoDeviceCreated = await page.evaluate(async () => !(await indexedDB.databases()).some(db => db.name?.includes('matrix-sdk-crypto')))
      result.noTokenExchange = tokenRequests === 0
    } catch {
      // Never dump private browser errors, request/response bodies, URLs or records.
    } finally { await context?.close() }
    const ok = Object.entries(result).filter(([key]) => key !== 'fault').every(([, value]) => value === true)
    passed &&= ok
    console.log(JSON.stringify({ ...result, status: ok ? 'passed' : 'failed', ownedFaultStatePreserved: true }))
  }
  if (!passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run()
