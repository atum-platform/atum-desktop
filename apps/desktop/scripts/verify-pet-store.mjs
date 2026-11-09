#!/usr/bin/env node
/**
 * Prove the Pet Store on a real Electron with a real gateway: the store opens
 * from the account menu and from Discover, its shelves come alive from
 * `pet.sheet` (bundled pets, no petdex round-trip), the Meet stage performs on
 * command, and adopting from the stage hatches the pet for the assistant in
 * front — after which the shelf says who has it.
 *
 *   npm run build && node scripts/bundle-electron-main.mjs --dev && node scripts/verify-pet-store.mjs [outDir]
 *
 * Same sandboxing as verify-two-pets.mjs (isolated HERMES_HOME + userData, dev
 * main bundle so the checkout's backend runs). Every step has a hard budget.
 *
 * With OPENROUTER_API_KEY in the shell the run also hatches a voxel bird for
 * real (Kimi K3 through the pet_hatch task) and grades it — every draft card
 * must name a bird kind, so a dog in disguise fails; without a key that step
 * reports SKIP(no credential) and the setup card is checked instead.
 *
 * Packaged run — the bundled pets resolved from the app's own Resources, the
 * staged runtime, no checkout on the path:
 *
 *   ATUM_PUBLIC_HOSTED_BASE_URL=… ATUM_PUBLIC_SUPABASE_URL=… ATUM_PUBLIC_SUPABASE_ANON_KEY=… npm run pack
 *   ATUM_PACKAGED_APP=1 node scripts/verify-pet-store.mjs [outDir]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const OUT = path.resolve(process.argv[2] ?? path.join(DESKTOP_ROOT, 'build', 'pet-store-out'))
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
setTimeout(() => { log('HARD BUDGET HIT — exiting'); process.exit(3) }, 420_000).unref()

const L = { more: /^(More|Thêm)$/u, adopt: /^(Adopt|Nhận nuôi)$/u, done: /^(Done|Xong)$/u }

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-pet-store-'))
const env = {}
for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD/iu.test(k)) env[k] = v
delete env.HERMES_DESKTOP_DEV_SERVER
// The hatch step needs a model. With an OpenRouter key in the shell it runs
// for real (Kimi K3, the owner's pick) and is graded; without one the step is
// SKIP, never PASS — the switch, the status and the setup card are still
// exercised. The key is the one secret forwarded, and only for this.
const HATCH_KEY = process.env.OPENROUTER_API_KEY || ''
if (HATCH_KEY) env.OPENROUTER_API_KEY = HATCH_KEY
Object.assign(env, {
  HERMES_HOME: path.join(sandbox, 'hermes-home'),
  HERMES_DESKTOP_USER_DATA_DIR: path.join(sandbox, 'user-data'),
  HERMES_DESKTOP_IGNORE_EXISTING: '1',
  HERMES_DESKTOP_APP_NAME: `AtumPetStore-${Date.now()}`
})
// Pin the hatch task the way a developer would: OpenRouter, Kimi K3.
fs.mkdirSync(env.HERMES_HOME, { recursive: true })
fs.writeFileSync(path.join(env.HERMES_HOME, 'config.yaml'), 'auxiliary:\n  pet_hatch:\n    provider: openrouter\n    model: moonshotai/kimi-k3\n')
if (PACKAGED) {
  // The packaged app must find everything — backend, bundled pets — inside
  // its own bundle. Nothing from the checkout may leak in through the env.
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
page.on('console', m => { if (/pet|sheet|gateway|error/iu.test(m.text()) && !/DevTools|Security Warning/u.test(m.text())) log('  renderer:', m.text().slice(0, 160)) })
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {})
const bodyText = () => page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1400)).catch(() => '')

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

/** The account menu's Pet submenu → "Pet Store…" opens Discover on the Pets
 *  shelf. Discover IS the store now (the storefront plan, W3): the rail lights
 *  up on Discover and the Pets shelf is selected — no workspace page opens. */
async function openStoreFromFooter() {
  await page.locator('[data-atum-account-trigger]').click()
  const sub = page.locator('[data-atum-menu-pet]')
  await sub.waitFor({ state: 'visible', timeout: 10_000 })
  await sub.hover(); await sleep(300); await sub.click().catch(() => {})
  const item = page.locator('[data-atum-menu-pet-store]')
  await item.waitFor({ state: 'visible', timeout: 10_000 })
  await item.click()
  await page.locator('[data-atum-nav-discover][aria-current="page"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-atum-shelf="pets"][aria-current="page"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-atum-pet-store]').waitFor({ state: 'visible', timeout: 20_000 })
}

const store = () => page.locator('[data-atum-pet-store]')
const liveCards = () => page.locator('[data-pet-card][data-pet-live="true"]')
const cardSlugs = (shelf) => page.locator(`[data-testid="${shelf}"] [data-pet-card]`).evaluateAll(els => els.map(el => el.getAttribute('data-pet-card')))
/** Two frames of a live card's canvas, apart in time: a moving sprite differs. */
async function canvasMoves(slug) {
  const canvas = page.locator(`[data-pet-card="${slug}"] canvas`).first()
  const a = await canvas.evaluate(c => c.toDataURL())
  await sleep(700)
  const b = await canvas.evaluate(c => c.toDataURL())
  return a !== b && a.length > 200
}

try {
  log(PACKAGED ? `PACKAGED run: ${electronPath}` : 'dev-bundle run against the checkout')
  log('waiting for boot…')
  await waitBoot()
  log('shell up')
  await shot('01-shell')

  // Entry 1: the account menu.
  await openStoreFromFooter()
  log('PASS store opens from the account menu')

  // The shelves: what ships with the app, alive from pet.sheet.
  await page.locator('[data-testid="pet-store-atum"] [data-pet-card]').first().waitFor({ state: 'visible', timeout: 60_000 })
  const bundled = await cardSlugs('pet-store-atum')
  log('  From Atum:', bundled)
  if (bundled.length < 4) fail(`expected the four bundled pets on the first shelf, got ${JSON.stringify(bundled)}`)
  await page.waitForFunction(n => document.querySelectorAll('[data-pet-card][data-pet-live="true"]').length >= n, bundled.length, { timeout: 90_000 })
  log(`PASS ${await liveCards().count()} live cards (pet.sheet on a real gateway)`)
  const first = bundled[0]
  if (await canvasMoves(first)) log(`PASS ${first}'s card animates (two canvas frames differ)`)
  else fail(`${first}'s card canvas does not change between frames`)
  // The petdex catalog merges in behind the bundled shelf (phase 2 of the
  // gallery load); a sandbox may be offline, so its absence is a note, not a
  // failure — the bundled shelf is the contract.
  await page.locator('[data-testid="pet-store-popular"] [data-pet-card]').first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {})
  const popular = await cardSlugs('pet-store-popular')
  log(popular.length ? `PASS Popular shelf: ${popular.length} petdex cards` : 'NOTE Popular shelf empty (petdex manifest not merged within 60s — offline?)')
  if (!(await page.locator('[data-testid="pet-store-hatch"]').count())) fail('hatch shelf missing')
  await shot('02-store')

  // The Meet stage: a pet performs on command.
  const meetSlug = bundled[1] ?? first
  await page.locator(`[data-pet-card="${meetSlug}"] button`).first().click()
  const stage = page.locator('[data-atum-meet-stage]')
  await stage.waitFor({ state: 'visible', timeout: 10_000 })
  await stage.locator('[data-atum-meet-action="lounging"]:not([disabled])').waitFor({ state: 'visible', timeout: 30_000 })
  await stage.locator('[data-atum-meet-action="lounging"]').click()
  const pose = await stage.locator('[data-atum-meet-pose]').getAttribute('data-atum-meet-pose')
  if (pose === 'lounging') log(`PASS Meet stage: ${meetSlug} lounges on command`)
  else fail(`Meet stage pose after Lounge = ${pose}`)
  await sleep(400)
  await shot('03-meet-lounge')

  // Adopt from the stage → "for which assistant?" → the hatch.
  await stage.locator('[data-atum-meet-adopt]').click()
  const ask = page.locator('[data-atum-adopt-pet]')
  await ask.waitFor({ state: 'visible', timeout: 10_000 })
  // Read "the assistant in front" from the dialog itself — the radio it
  // preselected — before confirming. The store now lives inside Discover,
  // which swaps the chat column out, so the chat title is not on screen to
  // read afterwards; the preselection is the fact this check is about anyway.
  const owner = await ask.locator('label:has(input[name="atum-adopt-pet-target"]:checked) span.font-medium').first().textContent().then(t => (t || '').trim()).catch(() => '')
  await ask.locator('[data-atum-adopt-pet-confirm]').click()
  const celebration = page.locator('[data-atum-adopt-celebration]')
  await celebration.waitFor({ state: 'visible', timeout: 60_000 })
  log('  celebration phase:', await celebration.getAttribute('data-atum-adopt-celebration'))
  await page.waitForFunction(() => document.querySelector('[data-atum-adopt-celebration]')?.getAttribute('data-atum-adopt-celebration') === 'hatched', null, { timeout: 10_000 })
  await sleep(600)
  await shot('04-hatched')
  log('PASS adopted from the stage; the hatch played (egg → hatched)')
  await celebration.waitFor({ state: 'hidden', timeout: 10_000 })
  if (await page.locator('[role=dialog]').count()) fail('a dialog is still open after the hatch')

  // The shelf now names the assistant that has it — the one that was
  // preselected in the dialog, i.e. the assistant in front — and the pill
  // reads the verb, not the price.
  const card = page.locator(`[data-pet-card="${meetSlug}"]`)
  if (!owner) fail('could not read the assistant the adopt dialog preselected')
  await page.waitForFunction(([slug, name]) => {
    const el = document.querySelector(`[data-pet-card="${slug}"]`)
    const pill = el?.querySelector('[data-atum-adopt]')?.textContent || ''
    return Boolean(el) && /^(Adopt|Nhận nuôi)$/u.test(pill.trim()) && (el.textContent || '').includes(name)
  }, [meetSlug, owner], { timeout: 30_000 }).then(
    () => log(`PASS shelf reflects the adoption: ${meetSlug} is with ${JSON.stringify(owner)}, pill reads the verb`),
    async () => fail(`shelf does not show ${meetSlug} owned by ${JSON.stringify(owner)}: ${JSON.stringify((await card.textContent())?.replace(/\s+/g, ' ').trim().slice(0, 80))}`)
  )
  // …and *that* pet is on the desk, in-window: PetSprite labels its canvas
  // "<name> pet", so the desk canvas must carry the adopted pet's name.
  const petName = (await card.locator('span').first().textContent())?.trim() || ''
  const onDesk = await page.waitForFunction(name => Array.from(document.querySelectorAll(`canvas[aria-label="${name} pet"]`)).some(el => !el.closest('[data-pet-card]') && !el.closest('[data-atum-meet-stage]') && !el.closest('[data-atum-adopt-celebration]')), petName, { timeout: 30_000 }).then(() => true, () => false)
  if (onDesk) log(`PASS ${petName} is drawn in-window outside the store`)
  else fail(`no in-window canvas labelled "${petName} pet" outside the store`)

  // Entry 2: Discover's shop window. Home first — clicking the already-lit
  // rail item is a no-op, and only a fresh arrival reseeds the Featured shelf
  // the teaser lives on.
  await page.locator('[data-atum-nav-home]').click()
  await page.locator('[data-atum-nav-discover]').click()
  const door = page.locator('[data-atum-open-pet-store]')
  await door.waitFor({ state: 'visible', timeout: 20_000 })
  const featured = await page.locator('[data-featured-pet]').evaluateAll(els => els.map(el => el.getAttribute('data-featured-pet')))
  log('  Discover featured strip:', featured)
  await shot('05-discover')
  await door.click()
  // The teaser switches shelves in place: the rail stays lit on Discover and
  // the Pets shelf is selected. No separate store surface appears.
  await page.locator('[data-atum-shelf="pets"][aria-current="page"]').waitFor({ state: 'visible', timeout: 20_000 })
  if (!(await page.locator('[data-atum-nav-discover][aria-current="page"]').count())) fail('the teaser ejected from Discover — the rail must stay lit')
  await store().waitFor({ state: 'visible', timeout: 20_000 })
  log('PASS the teaser opens the Pets shelf without leaving Discover')
  await shot('06-store-again')

  // Hatch your own, on the spec path. The overlay opens from the shelf, the
  // Voxel side is selected by default; then either a real design round with
  // Kimi (a key in the shell) or the honest setup card (no key) — SKIP.
  await page.locator('[data-atum-hatch]').click()
  const overlay = page.getByRole('dialog').filter({ has: page.locator('[data-atum-pet-style]') })
  // With no key the prompt gives way to the setup card, but the switch stays.
  await overlay.waitFor({ state: 'visible', timeout: 20_000 })
  const voxelOn = await overlay.locator('[data-atum-pet-style="voxel"]').getAttribute('aria-checked')
  if (voxelOn === 'true') log('PASS the hatch overlay opens on Voxel')
  else fail(`the hatch overlay did not open on Voxel (aria-checked=${voxelOn})`)
  await shot('07-hatch-overlay')
  if (!HATCH_KEY) {
    await overlay.locator('[data-atum-pet-unavailable="voxel"]').waitFor({ state: 'visible', timeout: 30_000 })
    const switchStillThere = await overlay.locator('[data-atum-pet-style="illustrated"]').count()
    if (!switchStillThere) fail('the setup card hid the style switch — the other lane is unreachable')
    log('SKIP(no credential) voxel hatch: no OPENROUTER_API_KEY in the shell; the setup card is shown, the switch stays')
  } else {
    await overlay.locator('[data-atum-pet-byok]').waitFor({ state: 'visible', timeout: 30_000 })
    log('  byok mode reported by the gateway')
    const promptBox = overlay.getByRole('textbox').first()
    // A bird, not a dog: the hatch draws body plans (quadruped, mascot,
    // bird), and a draft card's title is the gateway's summary, which opens
    // with the plan word the model chose — so the cards say what was made.
    await promptBox.fill('a small round blue bird with a yellow beak and a little crest')
    await promptBox.press('Enter')
    await page.waitForFunction(() => document.querySelectorAll('img.pet-reveal').length >= 4, null, { timeout: 170_000 })
    const summaries = await page.locator('img.pet-reveal').evaluateAll(els => els.map(el => el.getAttribute('title') || ''))
    log('  drafts:', summaries)
    const BIRD = /^[^:]+: (bird|chick|owl|penguin|parrot|duck)\b/u
    if (summaries.length >= 4 && summaries.every(s => BIRD.test(s))) log('PASS four voxel birds designed by Kimi and drawn by Atum — every card names a bird kind')
    else fail(`expected four drafts that each name a bird kind, got ${JSON.stringify(summaries)}`)
    await shot('08-drafts')
    await overlay.getByRole('button', { name: /^(Hatch|Ấp trứng|Ấp)$/u }).first().click()
    // The hatched pet takes over the dialog — the prompt and its style switch
    // are gone — so from here the dialog is the one with the name box in it.
    const hatched = page.getByRole('dialog').filter({ has: page.getByRole('textbox') })
    const nameBox = hatched.getByRole('textbox').first()
    await nameBox.waitFor({ state: 'visible', timeout: 60_000 })
    await nameBox.fill('Pip')
    await shot('09-preview')
    await hatched.getByRole('button', { name: /^(Adopt|Nhận nuôi)$/u }).first().click()
    await page.waitForFunction(() => Array.from(document.querySelectorAll('canvas[aria-label="Pip pet"]')).some(el => !el.closest('[role=dialog]')), null, { timeout: 60_000 })
    log('PASS Pip hatched from a sentence, adopted, and on the desk')
    await shot('10-hatched-on-desk')
  }
} catch (e) {
  fail(e.message)
  await shot('99-fail')
  log('  body:', await bodyText())
  log('  dialogs:', JSON.stringify(await page.locator('[role=dialog]').allTextContents().catch(() => [])).slice(0, 500))
} finally {
  if (mainErr.length) log('  main stderr (filtered):\n    ' + mainErr.slice(-25).join('\n    '))
  await Promise.race([app.close(), sleep(8000)]).catch(() => {})
  try { app.process().kill('SIGKILL') } catch {}
  fs.rmSync(sandbox, { recursive: true, force: true })
  log('done; exitCode =', process.exitCode ?? 0)
  process.exit(process.exitCode ?? 0)
}
