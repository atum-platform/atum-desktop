// One real disposable browser process for the ordinary MAS/recovery UI flow.
// Session cookies stay in that process. Credentials/keys never enter stdin or output.
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { browserTools } from './browser-tools.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const runtime = join(here, '.runtime')
if (!lstatSync(runtime).isDirectory() || lstatSync(runtime).isSymbolicLink() || JSON.parse(readFileSync(join(runtime, 'owner.json'), 'utf8')).project !== 'atum-cx-browser-proof') throw new Error('owned_runtime_required')
const restoreProfile = process.argv[4] === '--restore-profile'
if (process.argv.length > 5 || (process.argv[4] && !restoreProfile)) throw new Error('profile_mode_refused')
const profile = join(runtime, restoreProfile ? 'browser-restore-profile' : 'browser-profile-v2')
const { chromium, executablePath } = browserTools(process.argv.slice(2, 4))
const certificate = new X509Certificate(readFileSync(join(runtime, 'tls/server.pem')))
const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
const accountPath = join(runtime, 'account-v2.json')
if (!existsSync(accountPath)) writeFileSync(accountPath, JSON.stringify({ username: 'browserproof' + randomBytes(5).toString('hex'), password: randomBytes(24).toString('base64url') }), { mode: 0o600, flag: 'wx' })
const account = JSON.parse(readFileSync(accountPath, 'utf8'))
mkdirSync(profile, { recursive: true, mode: 0o700 })
if (lstatSync(profile).isSymbolicLink()) throw new Error('profile_symlink_refused')
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath,
  args: [`--ignore-certificate-errors-spki-list=${spki}`]
})
const page = await context.newPage()
const input = createInterface({ input: process.stdin, terminal: false })
let baseline
let signedIn = false
let recordBaseline
let realEncryptedReadAcceptance = false
const failures = []

async function summary() {
  const value = await page.evaluate(() => ({
    origin: location.origin, pathClass: location.pathname.split('/').slice(0, 2).join('/'),
    headings: Array.from(document.querySelectorAll('h1,h2')).map(node => node.textContent),
    inputs: Array.from(document.querySelectorAll('input')).map(node => ({ name: node.name, type: node.type })),
    buttons: Array.from(document.querySelectorAll('button,a')).map(node => node.textContent?.trim()).filter(Boolean),
    notice: document.querySelector('#notice')?.textContent,
    security: document.querySelector('#security')?.textContent,
    hasIdentity: Boolean(document.querySelector('#identity')?.textContent && document.querySelector('#identity')?.textContent !== 'Signed out'),
    addressScrubbed: !location.search && !location.hash,
    roomCount: Math.max(0, document.querySelectorAll('#rooms option').length - 1)
  }))
  console.log(JSON.stringify(value))
}
async function continueButton() {
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.waitForLoadState('domcontentloaded')
}
function requireMas() { if (new URL(page.url()).origin !== 'https://localhost:22981') throw new Error('not_mas') }
function requireProof() { if (new URL(page.url()).origin !== 'http://localhost:4317') throw new Error('not_proof') }
async function identity() { return page.locator('#identity').innerText() }
async function boundRecord() {
  requireProof()
  // Private values remain in process memory. Only comparisons become receipts.
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('atum-browser-first-device-v1')
    request.onerror = () => reject(new Error('private_record_unavailable'))
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('bound-device', 'readonly')
      const record = tx.objectStore('bound-device').get('human')
      tx.oncomplete = () => { db.close(); resolve(record.result) }
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error('private_record_unavailable')) }
    }
  }))
}
function bindingSame(before, after) {
  return ['issuer', 'baseUrl', 'clientId', 'redirectUri', 'deviceId', 'userId', 'subject', 'storageKey', 'scope'].every(key => before[key] === after[key])
}
async function encryptedRead(which) {
  requireProof()
  await page.locator('#rooms option').filter({ hasText: 'Disposable encrypted browser proof' }).waitFor({ state: 'attached', timeout: 60000 })
  await page.locator('#rooms').selectOption({ label: 'Disposable encrypted browser proof' })
  await page.locator('#messages li').filter({ hasText: `Atum disposable encrypted proof message ${which}` }).waitFor({ timeout: 60000 })
  realEncryptedReadAcceptance = true
  console.log(JSON.stringify({ realEncryptedRead: true, syntheticMessage: which }))
}

try {
  await page.goto('http://localhost:4317', { waitUntil: 'domcontentloaded' })
  console.log('Disposable proof controller ready. Commands contain no credentials.')
  for await (const line of input) {
    const command = line.trim()
    try {
      if (command === 'exit') break
      if (command === 'login') {
        requireProof()
        await page.locator('#login:enabled').waitFor()
        await page.locator('#login').click()
        await page.waitForURL(url => url.origin === 'https://localhost:22981')
      } else if (command === 'register') {
        requireMas()
        if (restoreProfile) throw new Error('restore_existing_account_only')
        await page.getByRole('link', { name: 'Create Account', exact: true }).click()
        await page.locator('input[name="username"]').fill(account.username)
        await page.locator('input[name="password"]').fill(account.password)
        await page.locator('input[name="password_confirm"]').fill(account.password)
        await continueButton()
      } else if (command === 'display') {
        requireMas()
        await page.locator('input[name="display_name"]').fill('Disposable browser proof')
        await continueButton()
      } else if (command === 'mas-login') {
        requireMas()
        await page.locator('input[name="username"]').fill(account.username)
        await page.locator('input[name="password"]').fill(account.password)
        await continueButton()
      } else if (command === 'continue') {
        requireMas()
        await continueButton()
      } else if (command === 'allow') {
        requireMas()
        await page.getByRole('button', { name: /^(Allow|Approve|Accept)$/ }).click()
        await page.waitForLoadState('domcontentloaded')
      } else if (command === 'connected') {
        requireProof()
        await page.locator('#notice').filter({ hasText: 'Connected to your saved device.' }).waitFor({ timeout: 60000 })
        baseline = await identity()
        signedIn = true
        console.log(JSON.stringify({ realPublicOAuth: true, matrixDeviceBound: baseline !== 'Signed out', addressScrubbed: new URL(page.url()).search === '' }))
      } else if (command === 'setup') {
        requireProof()
        if (restoreProfile) throw new Error('restore_only_profile')
        await page.locator('#create-key:enabled').click()
        await page.locator('#staged:not([hidden])').waitFor()
        const key = await page.locator('#recovery-key').inputValue()
        if (key.length < 30) throw new Error('recovery_key_absent')
        writeFileSync(join(runtime, 'recovery-key'), key, { mode: 0o600, flag: 'wx' })
        await page.locator('#saved').check()
        await page.locator('#setup:enabled').click()
        await page.locator('#security').filter({ hasText: 'ready' }).waitFor({ timeout: 60000 })
        console.log(JSON.stringify({ standardRecoverySetup: true, recoveryKeyPrivate: true }))
      } else if (command === 'restore') {
        requireProof()
        const key = readFileSync(join(runtime, 'recovery-key'), 'utf8')
        await page.locator('#restore-key').fill(key)
        await page.locator('#restore:enabled').click()
        await page.locator('#security').filter({ hasText: 'ready' }).waitFor({ timeout: 60000 })
        console.log(JSON.stringify({ standardRecoveryRestore: true, freshProfile: restoreProfile }))
      } else if (command === 'fault-fixture') {
        requireProof()
        const record = await boundRecord()
        if (record?.kind !== 'session' || record.phase !== 'active') throw new Error('no_active_record')
        writeFileSync(join(runtime, 'fault-fixture.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' })
        console.log(JSON.stringify({ privateOwnedFaultFixtureCaptured: true }))
      } else if (command === 'signout' || command === 'offline-signout') {
        requireProof()
        const before = await boundRecord()
        if (command === 'offline-signout') await context.route('https://localhost:22981/oauth2/revoke', route => route.abort('internetdisconnected'))
        let revocationConfirmed = false
        const observe = response => {
          if (response.url() === 'https://localhost:22981/oauth2/revoke' && response.status() === 200) revocationConfirmed = true
        }
        page.on('response', observe)
        try {
          await page.locator('#signout:enabled').click()
          await page.locator('#login:disabled').waitFor()
          await page.waitForFunction(() => document.querySelector('#notice')?.textContent !== 'Connected to your saved device.')
          const current = await boundRecord()
          if (current.phase !== 'signed_out' || !bindingSame(before, current)) throw new Error('signout_not_preserved')
          await page.reload()
          await page.locator('#notice').filter({ hasText: 'Signed out.' }).waitFor()
          console.log(JSON.stringify({ localSignoutAdmissionClosed: true, identityAndKeyPreserved: true, reloadRefusesReplacementLogin: await page.locator('#login').isDisabled(), providerOffline: command === 'offline-signout', remoteRevocationConfirmed: revocationConfirmed }))
        } finally { page.off('response', observe); await context.unroute('https://localhost:22981/oauth2/revoke') }
      } else if (command === 'reload') {
        requireProof()
        if (!signedIn) throw new Error('no_live_baseline')
        await page.reload()
        await page.locator('#notice').filter({ hasText: 'Connected to your saved device.' }).waitFor({ timeout: 60000 })
        console.log(JSON.stringify({ reloadConnected: true, sameDevice: await identity() === baseline }))
      } else if (command === 'audit') {
        recordBaseline = await boundRecord()
        if (recordBaseline?.kind !== 'session' || recordBaseline.phase !== 'active') throw new Error('no_active_record')
        const scope = `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${recordBaseline.deviceId}`
        const actual = new Set(recordBaseline.scope.split(' '))
        const names = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))
        console.log(JSON.stringify({ exactCanonicalScope: actual.size === 3 && scope.split(' ').every(value => actual.has(value)), canonicalCryptoStores: ['matrix-sdk-crypto', 'matrix-sdk-crypto-meta'].every(suffix => names.includes(`crypto-${recordBaseline.deviceId}::${suffix}`)), boundRecordActive: true, actualTtlSecondsRemaining: Math.ceil((recordBaseline.expiresAt - Date.now()) / 1000) }))
      } else if (command === 'rotation') {
        if (!recordBaseline) throw new Error('no_record_baseline')
        const limit = Date.now() + 150000
        let current
        do {
          current = await boundRecord()
          if (Date.now() > recordBaseline.expiresAt + 2000 && current.phase === 'active' && current.accessToken !== recordBaseline.accessToken && current.refreshToken !== recordBaseline.refreshToken) break
          await new Promise(resolve => setTimeout(resolve, 1000))
        } while (Date.now() < limit)
        const passed = Date.now() > recordBaseline.expiresAt + 2000 && current.phase === 'active' && current.accessToken !== recordBaseline.accessToken && current.refreshToken !== recordBaseline.refreshToken && current.expiresAt > recordBaseline.expiresAt && bindingSame(recordBaseline, current)
        console.log(JSON.stringify({ actualProviderExpiryElapsed: Date.now() > recordBaseline.expiresAt, realCredentialRotation: passed, sameIdentityKeyScope: bindingSame(recordBaseline, current), durableActivePhase: current.phase === 'active' }))
        if (!passed) throw new Error('real_rotation_unproven')
      } else if (command === 'read-one' || command === 'read-two') {
        await encryptedRead(command === 'read-one' ? 'one' : 'two')
      } else if (command === 'second-tab') {
        requireProof()
        const peer = await context.newPage()
        try {
          await peer.goto('http://localhost:4317', { waitUntil: 'domcontentloaded' })
          await peer.locator('#notice').filter({ hasText: 'This device is open in another tab.' }).waitFor()
          console.log(JSON.stringify({ authenticatedDuplicateTabExcluded: true, replacementLoginDisabled: await peer.locator('#login').isDisabled() }))
        } finally { await peer.close() }
      } else if (command === 'status') {
        // Public UI labels only. Never values, message contents, URLs or browser stores.
      } else throw new Error('unknown_command')
      await summary()
    } catch {
      const step = ['login', 'register', 'display', 'continue', 'mas-login', 'allow', 'connected', 'setup', 'restore', 'fault-fixture', 'signout', 'offline-signout', 'reload', 'audit', 'rotation', 'read-one', 'read-two', 'second-tab', 'status'].includes(command) ? command : 'command_refused'
      failures.push(step)
      console.log(JSON.stringify({ step, status: 'failed', preservedDisposableState: true }))
    }
  }
} finally {
  input.close()
  await context.close()
  console.log(JSON.stringify({ controllerClosed: true, failedSteps: failures, realEncryptedReadAcceptance }))
}
