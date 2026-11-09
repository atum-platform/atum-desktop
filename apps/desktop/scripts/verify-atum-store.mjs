#!/usr/bin/env node
/**
 * Prove the storefront contract on a real Electron with a real gateway
 * (plans 2026-09-10-discover-storefront.md W6 and 2026-09-10-atum-store.md V):
 *
 *   1. EVERY storefront entry point lands somewhere visible. Each is driven
 *      from the exact state in which all four old `navigate(PETS_ROUTE)` call
 *      sites showed nothing at all — a CLOSED workspace with the rail on chat —
 *      and for each the script asserts the rail and the shelf it lands on.
 *      That regression is what the storefront plan exists to kill.
 *   2. `/pets` never rests in the address bar after arriving there.
 *   3. The shelves render from the catalog, not a constant: signed out, the
 *      Skills shelf shows the honest signed-out state and ZERO rows (the
 *      deleted ATUM_SKILL_CATALOG constant would have rendered regardless);
 *      the store's own markers (Owned filter, "Manage installed →") are on
 *      the shelf; the Agents shelf is drawn, labelled and `aria-disabled`.
 *   4. Legacy-shell rollback: with `$atumShellEnabled` off (a persisted
 *      localStorage flag, `hermes.desktop.atum.shell` — set here for real and
 *      reloaded, not faked) `/pets` keeps rendering the Pet Store as a page.
 *
 *   npm run build && node scripts/bundle-electron-main.mjs --dev && node scripts/verify-atum-store.mjs [outDir]
 *
 * Same sandboxing as verify-pet-store.mjs (isolated HERMES_HOME + userData, dev
 * main bundle so the checkout's backend runs). Every step has a hard budget.
 * This script reads NO credentials: the environment scrub forwards no
 * KEY/TOKEN/SECRET/PASSWORD, and no step needs one.
 *
 * Packaged run:
 *
 *   ATUM_PUBLIC_HOSTED_BASE_URL=… ATUM_PUBLIC_SUPABASE_URL=… ATUM_PUBLIC_SUPABASE_ANON_KEY=… npm run pack
 *   ATUM_PACKAGED_APP=1 node scripts/verify-atum-store.mjs [outDir]
 *
 * RELEASE GATES this script deliberately does NOT cover — each prints
 * SKIP(platform not deployed): purchases, entitlements and the signed proof
 * need the platform deployed with migrations 0120–0122 and an entitlement
 * signing key, none of which exists locally or in production yet. Stubbing
 * the platform would make those LOOK verified, so nothing here stubs it.
 * Also skipped honestly: the roster's signed-in-only empty-search entry, and
 * signed-in catalog rows (prices, Owned badges) — both need an account.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const OUT = path.resolve(process.argv[2] ?? path.join(DESKTOP_ROOT, 'build', 'atum-store-out'))
fs.mkdirSync(OUT, { recursive: true })
const require = createRequire(path.join(DESKTOP_ROOT, 'package.json'))
const { _electron } = require('@playwright/test')
const PACKAGED = process.env.ATUM_PACKAGED_APP === '1'
const PACKAGE_JSON = require('./package.json')
const packagedApp = () => {
  const productName = PACKAGE_JSON.build?.productName || PACKAGE_JSON.productName
  const executableName = PACKAGE_JSON.build?.executableName || productName
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const exe = path.join(DESKTOP_ROOT, 'release', `mac-${arch}`, `${productName}.app`, 'Contents', 'MacOS', executableName)
  if (!fs.existsSync(exe)) throw new Error(`packaged app not found: ${exe} (npm run pack first)`)
  return exe
}
const electronPath = PACKAGED ? packagedApp() : require('electron')

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)
const fail = (msg) => { log('FAIL', msg); process.exitCode = 1 }
const skip = (msg) => log('SKIP(platform not deployed)', msg)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
setTimeout(() => { log('HARD BUDGET HIT — exiting'); process.exit(3) }, 600_000).unref()

const L = {
  more: /^(More|Thêm)$/u,
  petStore: /^(Pet Store…|Cửa hàng thú cưng…)$/u
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-store-'))
const env = {}
for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD/iu.test(k)) env[k] = v
delete env.HERMES_DESKTOP_DEV_SERVER
Object.assign(env, {
  HERMES_HOME: path.join(sandbox, 'hermes-home'),
  HERMES_DESKTOP_USER_DATA_DIR: path.join(sandbox, 'user-data'),
  HERMES_DESKTOP_IGNORE_EXISTING: '1',
  HERMES_DESKTOP_APP_NAME: `AtumStore-${Date.now()}`
})
if (PACKAGED) {
  // The packaged app must find everything inside its own bundle; nothing from
  // the checkout may leak in through the env.
  delete env.HERMES_DESKTOP_HERMES_ROOT
  delete env.HERMES_DESKTOP_HERMES
  delete env.HERMES_DESKTOP_BOOT_FAKE
  delete env.ATUM_BUNDLED_PETS_DIR
  env.HERMES_DESKTOP_CWD = sandbox
  env.PYTHONDONTWRITEBYTECODE = '1'
} else {
  env.HERMES_DESKTOP_HERMES_ROOT = REPO_ROOT
}

const app = PACKAGED
  ? await _electron.launch({ executablePath: electronPath, args: [], env, cwd: sandbox })
  : await _electron.launch({ executablePath: electronPath, args: [DESKTOP_ROOT, '--no-sandbox'], env, cwd: DESKTOP_ROOT })
const mainErr = []
app.process().stderr?.on('data', d => { for (const line of String(d).split('\n')) if (/error|fail|fatal|boot|gateway|python|Traceback/iu.test(line)) mainErr.push(line.slice(0, 200)) })
const page = await app.firstWindow()
page.on('console', m => { if (/pet|store|shelf|discover|gateway|error/iu.test(m.text()) && !/DevTools|Security Warning/u.test(m.text())) log('  renderer:', m.text().slice(0, 160)) })
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {})
const bodyText = () => page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1400)).catch(() => '')

// ── Markers ─────────────────────────────────────────────────────────────────
// The rail: nav-switch.tsx lights the current destination with aria-current.
const rail = (dest) => page.locator(`[data-atum-nav-${dest}][aria-current="page"]`)
// The shelf switcher: discover-panel.tsx marks the selected shelf the same way.
const shelf = (name) => page.locator(`[data-atum-shelf="${name}"][aria-current="page"]`)
const hash = () => page.evaluate(() => window.location.hash).catch(() => '')

async function waitBoot() {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (await page.locator('[data-testid="boot-failure-overlay"]').count()) {
      const text = await page.locator('[data-testid="boot-failure-overlay"]').first().innerText().catch(() => '')
      throw new Error(`BOOT FAILED: ${text.replace(/\s+/g, ' ').slice(0, 900)}`)
    }
    if (await page.locator('[data-atum-roster-footer]').count() && await page.getByRole('button', { name: L.more }).count()) return
    await sleep(1500)
  }
  throw new Error('boot: neither shell nor failure overlay within 240s')
}

/** The assertion every entry point shares: the rail on Discover, one shelf lit. */
async function assertStorefront(shelfName, label) {
  await rail('discover').waitFor({ state: 'visible', timeout: 20_000 })
  await shelf(shelfName).waitFor({ state: 'visible', timeout: 20_000 })
  log(`PASS ${label} → rail=discover, shelf=${shelfName}`)
  await sleep(300)
}

/** Back to the regression state: rail on chat, workspace (still) closed. */
async function goHome() {
  await page.keyboard.press('Escape').catch(() => {})
  await page.locator('[data-atum-nav-home]').click()
  await rail('home').waitFor({ state: 'visible', timeout: 10_000 })
}

/** The account menu, opened; callers pick the row. */
async function openAccountMenu() {
  await page.locator('[data-atum-account-trigger]').click()
  await sleep(300)
}

try {
  log(PACKAGED ? `PACKAGED run: ${electronPath}` : 'dev-bundle run against the checkout')
  log('waiting for boot…')
  await waitBoot()
  log('shell up')

  // The regression state, exactly: a CLOSED workspace with the rail on chat.
  // `$workspaceOpen` is a persisted atom, so close it for real and reload —
  // the wide-window default would otherwise reopen it.
  await page.evaluate(() => localStorage.setItem('hermes.desktop.atum.workspaceOpenV3', 'false'))
  await page.reload()
  await waitBoot()
  await rail('home').waitFor({ state: 'visible', timeout: 20_000 })
  if (await page.locator('[data-atum-workspace]:visible').count()) fail('workspace is not closed — the regression state is not set up')
  log('PASS precondition: closed workspace, rail on chat — the state that showed nothing')
  await shot('01-regression-state')

  // Entry 1 — account menu → Pet → "Pet Store…" (account-footer-menu.tsx).
  await goHome()
  await openAccountMenu()
  const petSub = page.locator('[data-atum-menu-pet]')
  await petSub.waitFor({ state: 'visible', timeout: 10_000 })
  await petSub.hover(); await sleep(300); await petSub.click().catch(() => {})
  const petStoreItem = page.locator('[data-atum-menu-pet-store]')
  await petStoreItem.waitFor({ state: 'visible', timeout: 10_000 })
  await petStoreItem.click()
  await assertStorefront('pets', 'account menu → Pet Store…')
  await page.locator('[data-atum-pet-store]').waitFor({ state: 'visible', timeout: 20_000 })
  await shot('02-entry-account-pet-store')

  // Entry 2 — account menu → "Invite a friend" (account-footer-menu.tsx:164).
  await goHome()
  await openAccountMenu()
  const invite = page.locator('[data-atum-menu-invite]')
  await invite.waitFor({ state: 'visible', timeout: 10_000 })
  await invite.click()
  await assertStorefront('people', 'account menu → Invite')
  await shot('03-entry-invite')

  // Entry 3 — Discover's Featured teaser (discover-pets-section.tsx): the shop
  // window switches shelves in place, never leaving the rail.
  await goHome()
  await page.locator('[data-atum-nav-discover]').click()
  await rail('discover').waitFor({ state: 'visible', timeout: 10_000 })
  const teaser = page.locator('[data-atum-open-pet-store]')
  await teaser.waitFor({ state: 'visible', timeout: 30_000 })
  await teaser.click()
  await assertStorefront('pets', 'Featured teaser → Open the Pet Store')
  await shot('04-entry-teaser')

  // Entry 4 — pet settings' browse link (pet-settings.tsx). Driven the way a
  // person reaches it: account menu → Pet → "Pet settings…". Settings is an
  // overlay; the opener's navigation is how the card gets out of the way.
  // This step used to set `#/settings?tab=appearance` by hand — a tab NO
  // allowlist ever accepted, so the page silently coerced to General and the
  // pet section never appeared. Driving the real menu path is what catches it.
  await goHome()
  await openAccountMenu()
  await petSub.waitFor({ state: 'visible', timeout: 10_000 })
  await petSub.hover(); await sleep(300); await petSub.click().catch(() => {})
  const petSettingsItem = page.locator('[data-atum-menu-pet-settings]')
  await petSettingsItem.waitFor({ state: 'visible', timeout: 10_000 })
  await petSettingsItem.click()
  const petSection = page.locator('[data-atum-pet-settings-section]')
  await petSection.waitFor({ state: 'visible', timeout: 60_000 })
  const settingsHash = await hash()
  if (!settingsHash.includes('/settings?tab=atum:general')) fail(`"Pet settings…" did not land on the consumer General view (hash=${settingsHash})`)
  await sleep(400)
  // The deep link carries the section anchor: the pet section scrolls into
  // view rather than leaving the person at the top of General.
  const anchored = await page.evaluate(() => {
    const el = document.querySelector('[data-atum-pet-settings-section]')

    if (!el) return false

    const rect = el.getBoundingClientRect()

    return rect.top >= 0 && rect.top < window.innerHeight * 0.9
  })
  if (!anchored) fail('the pet section did not scroll into view after the "Pet settings…" deep link')
  const browse = page.locator('[data-atum-browse-pets]')
  await browse.waitFor({ state: 'visible', timeout: 60_000 })
  await browse.click()
  await assertStorefront('pets', 'pet settings → Browse pets in Discover')
  if ((await hash()).includes('/settings')) fail('the Settings overlay did not get out of the way')
  await shot('05-entry-pet-settings')

  // Entry 5 — the roster's start-chat dialog → "Add friends"
  // (roster-panel.tsx). It goes through the one opener now and names the
  // People shelf: it used to flip the rail bare and take whatever the arrival
  // reseed gave it, which is how a button named "Add friends" landed on
  // Featured.
  await goHome()
  await page.locator('[data-atum-create-menu]').click()
  const addFriends = page.locator('[data-testid="atum-start-chat-friends"]')
  await addFriends.waitFor({ state: 'visible', timeout: 10_000 })
  await addFriends.click()
  await assertStorefront('people', 'roster → start chat → Add friends')
  await shot('06-entry-add-friends')

  // Entry 5b — the roster's empty-search "Search Atum" escape hatch
  // (roster-panel.tsx:916) renders only signed in (`dmsAvailable`).
  skip('roster empty-search → Discover needs a signed-in account (dmsAvailable); this sandbox is signed out')

  // Entry 6 — the composer's slash path (`/pet list`, through the one opener;
  // lands on the Pets shelf). Typed into the real rich composer, not dispatched.
  await goHome()
  const composer = page.locator('[data-slot="composer-rich-input"]')
  await composer.waitFor({ state: 'visible', timeout: 20_000 })
  await composer.click()
  await page.keyboard.type('/pet list', { delay: 25 })
  await page.keyboard.press('Enter')
  const slashLanded = await rail('discover').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
  if (!slashLanded) {
    // A trigger popover may have eaten the first Enter — dismiss, submit again.
    log('  slash: first Enter did not land; Escape + Enter retry')
    await page.keyboard.press('Escape').catch(() => {})
    await page.keyboard.press('Enter')
    await rail('discover').waitFor({ state: 'visible', timeout: 15_000 })
  }
  // `/pet list` goes through the one opener and lands on the Pets shelf. It used
  // to flip the rail bare and land on Featured — the review's "store openers
  // bypass the opener" finding, fixed in the renderer round.
  await shelf('pets').waitFor({ state: 'visible', timeout: 20_000 })
  log('PASS composer /pet list → rail=discover, shelf=pets')
  await shot('07-entry-slash')

  // A pet on the desk, for the two pet entry points: adopt one bundled pet off
  // the shelf (the same live flow verify-pet-store.mjs drives).
  await goHome()
  await page.locator('[data-atum-nav-discover]').click()
  await page.locator('[data-atum-shelf="pets"]').click()
  await page.locator('[data-testid="pet-store-atum"] [data-pet-card]').first().waitFor({ state: 'visible', timeout: 90_000 })
  const adoptSlug = await page.locator('[data-testid="pet-store-atum"] [data-pet-card]').first().getAttribute('data-pet-card')
  // The card's sprite button carries aria-label={displayName} — an exact name,
  // unlike a span scrape that can pick up nested owner/badge text.
  const petName = ((await page.locator(`[data-pet-card="${adoptSlug}"] button[aria-label]`).first().getAttribute('aria-label')) || '').trim()
  await page.locator(`[data-atum-adopt="${adoptSlug}"]`).first().click()
  const ask = page.locator('[data-atum-adopt-pet]')
  await ask.waitFor({ state: 'visible', timeout: 10_000 })
  await ask.locator('[data-atum-adopt-pet-confirm]').click()
  const celebration = page.locator('[data-atum-adopt-celebration]')
  await celebration.waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => document.querySelector('[data-atum-adopt-celebration]')?.getAttribute('data-atum-adopt-celebration') === 'hatched', null, { timeout: 15_000 })
  await celebration.waitFor({ state: 'hidden', timeout: 15_000 })
  log(`  adopted ${petName} (${adoptSlug}) for the in-window pet`)
  const deskPet = page.locator(`canvas[aria-label="${petName} pet"]`).first()

  // Entry 7 — the in-window pet's right-click → "Pet Store…"
  // (floating-pet.tsx:504). Home first: with Discover unmounted, the only
  // canvas carrying this label is FloatingPet's (card canvases share it).
  await goHome()
  await deskPet.waitFor({ state: 'visible', timeout: 30_000 })
  await deskPet.click({ button: 'right' })
  const menuStore = page.getByRole('menuitem', { name: L.petStore })
  await menuStore.waitFor({ state: 'visible', timeout: 10_000 })
  await menuStore.click()
  await assertStorefront('pets', 'in-window pet right-click → Pet Store…')
  await shot('08-entry-pet-context')

  // Entry 8 — the POPPED-OUT pet's "Pet Store…" through the real bridge: the
  // overlay is a separate BrowserWindow, so its request arrives as a control
  // message and wiring.tsx:603 runs the opener in the main window.
  await goHome()
  await openAccountMenu()
  await petSub.waitFor({ state: 'visible', timeout: 10_000 })
  await petSub.hover(); await sleep(300); await petSub.click().catch(() => {})
  const place = page.locator('[data-atum-menu-pet-place]')
  await place.waitFor({ state: 'visible', timeout: 10_000 })
  await place.click()
  await page.keyboard.press('Escape').catch(() => {})
  let overlayPage = null
  for (let i = 0; i < 20 && !overlayPage; i++) {
    await sleep(1000)
    overlayPage = app.windows().find(w => w.url().includes('win=overlay'))
  }
  if (!overlayPage) throw new Error('the pet never popped out (no win=overlay window)')
  log('  overlay window:', overlayPage.url().slice(0, 120))
  await overlayPage.waitForFunction(() => Boolean(window.hermesDesktop?.petOverlay), null, { timeout: 30_000 })
  await overlayPage.evaluate(() => window.hermesDesktop.petOverlay.control({ type: 'store' }))
  await assertStorefront('pets', 'popped-out pet → Pet Store… (cross-process bridge)')
  await shot('09-entry-overlay-store')
  await overlayPage.evaluate(() => window.hermesDesktop.petOverlay.control({ type: 'pop-in' })).catch(() => {})

  // The `/pets` deep link: one-shot, never a resting URL.
  await goHome()
  await page.evaluate(() => { window.location.hash = '#/pets' })
  await assertStorefront('pets', '/pets deep link')
  const settled = await hash()
  if (settled.includes('/pets')) fail(`/pets is resting in the address bar: ${settled}`)
  await sleep(1500)
  const later = await hash()
  if (later.includes('/pets')) fail(`/pets came BACK to the address bar: ${later}`)
  log(`PASS /pets never rests — hash settled at ${JSON.stringify(later)}`)
  await shot('10-deep-link')

  // The shelves render from the catalog, not a constant. Signed out there is
  // no catalog, so the honest proof available here: the shelf exists with the
  // store's markers and shows ZERO skill rows — the deleted ATUM_SKILL_CATALOG
  // constant would have rendered seven regardless of account.
  await goHome()
  await page.locator('[data-atum-nav-discover]').click()
  await page.locator('[data-atum-shelf="skills"]').click()
  await shelf('skills').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('[data-testid="discover-skills"]').waitFor({ state: 'visible', timeout: 10_000 })
  if (!(await page.locator('[data-testid="discover-skills"] [data-atum-owned-filter]').count())) fail('Skills shelf: the Owned filter (the store library) is missing')
  if (!(await page.locator('[data-atum-manage-skills]').count())) fail('Skills shelf: the "Manage installed →" link out is missing')
  const skillRows = await page.locator('[data-skill-row]').count()
  if (skillRows !== 0) fail(`Skills shelf shows ${skillRows} rows signed out — a compiled-in constant is back`)
  log('PASS Skills shelf: store markers present, zero rows signed out — the constant is gone, the shelf reads the catalog')
  // Main's side of the store: the bridge the shelves and purchases call.
  const bridgeOk = await page.evaluate(() => {
    const s = window.hermesDesktop?.store
    return Boolean(s) && ['catalog', 'refresh', 'purchase', 'purchaseStatus'].every(k => typeof s[k] === 'function')
  })
  if (bridgeOk) log('PASS hermesDesktop.store bridge is wired in main (catalog/refresh/purchase/purchaseStatus)')
  else fail('hermesDesktop.store bridge missing or incomplete in the renderer')

  // The Agents shelf: drawn, labelled, disabled — never fake-clickable.
  const agentsTab = page.locator('[data-atum-shelf="agents"]')
  await agentsTab.waitFor({ state: 'visible', timeout: 10_000 })
  const agentsDisabled = await agentsTab.getAttribute('aria-disabled')
  const agentsLabel = ((await agentsTab.textContent()) || '').trim()
  if (agentsDisabled === 'true' && agentsLabel) log(`PASS Agents shelf is drawn ("${agentsLabel}") and aria-disabled`)
  else fail(`Agents shelf: aria-disabled=${agentsDisabled}, label=${JSON.stringify(agentsLabel)}`)
  await shot('11-shelves')

  skip('signed-in catalog rows, prices and Owned badges — needs the platform deployed with migrations 0120–0122 and a signed-in account')
  skip('purchase flow (offer_version, idempotency, already_owned) — release gate, needs the deployed platform')
  skip('entitlement envelope and Ed25519 proof — needs the platform signing key; nothing is stubbed here')
  skip('gateway enforcement at pet.select / hub install / materialisation — needs the signed proof above')

  // Legacy-shell rollback: `$atumShellEnabled` is a persisted localStorage atom
  // (`hermes.desktop.atum.shell`, Codecs.bool), not build-time config — set it
  // for real and reload. Under the legacy chrome `/pets` stays a page.
  await page.evaluate(() => localStorage.setItem('hermes.desktop.atum.shell', 'false'))
  await page.reload()
  await page.evaluate(() => { window.location.hash = '#/pets' }).catch(() => {})
  const legacyDeadline = Date.now() + 180_000
  let legacyStore = false
  while (Date.now() < legacyDeadline && !legacyStore) {
    if (await page.locator('[data-testid="boot-failure-overlay"]').count()) {
      const text = await page.locator('[data-testid="boot-failure-overlay"]').first().innerText().catch(() => '')
      throw new Error(`BOOT FAILED (legacy): ${text.replace(/\s+/g, ' ').slice(0, 900)}`)
    }
    await page.evaluate(() => { if (!window.location.hash.includes('/pets')) window.location.hash = '#/pets' }).catch(() => {})
    legacyStore = (await page.locator('[data-atum-pet-store]').count()) > 0
    if (!legacyStore) await sleep(2000)
  }
  if (!legacyStore) fail('legacy shell: /pets did not render the Pet Store page')
  else log('PASS legacy shell: /pets renders the Pet Store as a page')
  if (await page.locator('[data-atum-nav-discover]').count()) fail('legacy shell: the Atum rail rendered — the rollback flag did not apply')
  await sleep(1500)
  const legacyHash = await hash()
  if (!legacyHash.includes('/pets')) fail(`legacy shell: /pets did not REST as a page URL (hash=${legacyHash})`)
  await shot('12-legacy-pets-page')
} catch (e) {
  fail(e.message)
  await shot('99-fail')
  log('  body:', await bodyText())
  log('  hash:', await hash())
  log('  dialogs:', JSON.stringify(await page.locator('[role=dialog]').allTextContents().catch(() => [])).slice(0, 500))
} finally {
  if (mainErr.length) log('  main stderr (filtered):\n    ' + mainErr.slice(-25).join('\n    '))
  await Promise.race([app.close(), sleep(8000)]).catch(() => {})
  try { app.process().kill('SIGKILL') } catch {}
  fs.rmSync(sandbox, { recursive: true, force: true })
  log('done; exitCode =', process.exitCode ?? 0)
  process.exit(process.exitCode ?? 0)
}
