#!/usr/bin/env node
/**
 * Prove the two multi-agent pet claims on a real Electron with a real gateway:
 * two pets popped out at once, and a submit from pet B's composer landing in
 * B's thread while A is in front.
 *
 *   npm run build && node scripts/bundle-electron-main.mjs --dev && node scripts/verify-two-pets.mjs [outDir]
 *
 * The dev main bundle matters: `npm run build` bakes HERMES_DESKTOP_IS_PACKAGED
 * into the production bundle, which makes any dist/ launch demand a staged
 * bundled runtime and fail with BundledRuntimeIdentityError. The dev bundle
 * resolves the backend from the checkout instead (HERMES_DESKTOP_HERMES_ROOT),
 * which needs a `.venv` at the repo root — a worktree can symlink the main
 * checkout's.
 *
 * Isolated HERMES_HOME + userData with a unique app name, so the installed app
 * can stay open. A sandbox home is never seeded with the default pet, so both
 * assistants are created through the app's own sheet and given a pet there —
 * which makes this also an end-to-end run of the picker on a live gateway.
 * Every step has a hard budget; selectors are bilingual because the product
 * defaults to Vietnamese.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const OUT = path.resolve(process.argv[2] ?? path.join(DESKTOP_ROOT, 'build', 'two-pets-out'))
fs.mkdirSync(OUT, { recursive: true })
const require = createRequire(path.join(DESKTOP_ROOT, 'package.json'))
const { _electron } = require('@playwright/test')
const electronPath = require('electron')

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)
const fail = (msg) => { log('FAIL', msg); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
setTimeout(() => { log('HARD BUDGET HIT — exiting'); process.exit(3) }, 480_000).unref()

const L = {
  more: /^(More|Thêm)$/u, edit: /^(Edit|Chỉnh sửa)$/u, save: /^(Save|Lưu)$/u,
  createRow: /Create a new assistant|Tạo trợ lý mới/u, createTitle: /New assistant|Trợ lý mới/u,
  name: /^(Name|Tên)$/u, createBtn: /^(Create|Tạo)( trợ lý)?$/u, newChat: /^(New chat|Trò chuyện mới)$/u,
  pickPet: /Choose a pet|Change pet|Chọn thú cưng|Đổi thú cưng/u, cancel: /^(Cancel|Hủy|Huỷ)$/u
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-two-pets-'))
const env = {}
for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD/iu.test(k)) env[k] = v
delete env.HERMES_DESKTOP_DEV_SERVER
Object.assign(env, {
  HERMES_HOME: path.join(sandbox, 'hermes-home'),
  HERMES_DESKTOP_USER_DATA_DIR: path.join(sandbox, 'user-data'),
  HERMES_DESKTOP_IGNORE_EXISTING: '1',
  HERMES_DESKTOP_HERMES_ROOT: REPO_ROOT,
  HERMES_DESKTOP_APP_NAME: `AtumTwoPets-${Date.now()}`
})

const app = await _electron.launch({ executablePath: electronPath, args: [DESKTOP_ROOT, '--no-sandbox'], env, cwd: DESKTOP_ROOT })
const mainErr = []
app.process().stderr?.on('data', d => { for (const line of String(d).split('\n')) if (/error|fail|fatal|boot|gateway|python|venv|spawn|ENOENT|EACCES|Traceback/iu.test(line)) mainErr.push(line.slice(0, 200)) })
const page = await app.firstWindow()
page.on('console', m => { if (/pet|overlay|boot|gateway|secondary|connect|ws:|socket|token|beta|gamma|closed|reconnect/iu.test(m.text()) && !/DevTools|Security Warning/u.test(m.text())) log('  renderer:', m.text().slice(0, 160)) })

const overlays = () => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().map(w => w.webContents.getURL()).filter(u => u.includes('win=overlay')))
const overlayPage = (petId) => app.windows().find(w => w.url().includes('win=overlay') && w.url().includes(`pet=${petId}`))
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {})
const chatTitle = () => page.locator('[data-atum-chat-title]').first().textContent().catch(() => null)
const bodyText = () => page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1400)).catch(() => '')

async function waitBoot() {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (await page.locator('[data-testid="boot-failure-overlay"]').count()) {
      const text = await page.locator('[data-testid="boot-failure-overlay"]').first().innerText().catch(() => '')
      throw new Error(`BOOT FAILED: ${text.replace(/\s+/g, ' ').slice(0, 900)}`)
    }
    // Booted = roster footer present and the master row's "More" is clickable.
    if (await page.locator('[data-atum-roster-footer]').count() && await page.getByRole('button', { name: L.more }).count()) return
    await sleep(1500)
  }
  throw new Error('boot: neither shell nor failure overlay within 240s')
}

async function pickAnyPet(scope) {
  await scope.getByRole('button', { name: L.pickPet }).click()
  const field = scope.locator('[data-atum-agent-pet-field]')
  // First catalog entry: the buttons after the toggle itself.
  const entry = field.getByRole('button').filter({ hasNotText: L.cancel }).filter({ hasNotText: L.pickPet }).first()
  await entry.waitFor({ state: 'visible', timeout: 90_000 })
  const name = (await entry.textContent())?.trim()
  await entry.click()
  return name
}

async function popOutActive() {
  await page.locator('[data-atum-account-trigger]').click()
  const sub = page.locator('[data-atum-menu-pet]')
  await sub.waitFor({ state: 'visible', timeout: 10_000 })
  await sub.hover(); await sleep(300); await sub.click().catch(() => {})
  const place = page.locator('[data-atum-menu-pet-place]')
  await place.waitFor({ state: 'visible', timeout: 10_000 })
  log(`  Pet submenu → "${(await place.textContent())?.trim()}" disabled=${(await place.getAttribute('data-disabled')) !== null}`)
  await place.click()
  await page.keyboard.press('Escape').catch(() => {})
}

try {
  log('waiting for boot…')
  await waitBoot()
  log('shell up; chat title =', JSON.stringify(await chatTitle()))
  await shot('01-shell')
  log('  overlays at boot:', await overlays(), '(expect [] — in-window default)')

  // Two created assistants, each given a pet in the create sheet. (The master's
  // own sheet cannot save signed-out: its name comes from the hosted directory,
  // and the pet is applied after the identity write. Recorded as a finding.)
  const inFront = (name) => page.waitForFunction(n => (document.querySelector('[data-atum-chat-title]')?.textContent || '').includes(n), name, { timeout: 60_000 })
  // The account menu acts on $activeGatewayProfile, which only flips once that
  // profile's gateway is connected — later than the chat header. Wait for it.
  const connected = async (name) => {
    // The swap overlay keeps its label in the DOM at opacity-0 after the swap
    // ends, so text presence proves nothing; the class does.
    await page.waitForFunction(() => {
      const el = Array.from(document.querySelectorAll('div[aria-hidden]')).find(d => /Connecting to|Đang kết nối/u.test(d.textContent || ''))
      return !el || el.classList.contains('opacity-0')
    }, null, { timeout: 90_000 })
    log(`  gateway connected for ${name}`)
  }
  async function createWithPet(name) {
    await page.getByText(L.createRow).click()
    const sheet = page.getByRole('dialog').filter({ hasText: L.createTitle })
    await sheet.waitFor({ state: 'visible', timeout: 10_000 })
    await sheet.getByLabel(L.name).fill(name)
    log(`  ${name} gets:`, await pickAnyPet(sheet))
    await sheet.getByRole('button', { name: L.createBtn }).click()
    await sheet.waitFor({ state: 'hidden', timeout: 120_000 })
    await inFront(name)
    await connected(name)
    log(`${name} created and in front (adoptPetFor on a live gateway)`)
  }
  await createWithPet('Beta')
  await shot('02-beta')
  await createWithPet('Gamma')

  // Gamma is in front: pop it out. Then bring Beta to the front and pop it out.
  await popOutActive(); await sleep(4000)
  log('  overlays after Gamma pop-out:', await overlays())
  await page.getByRole('button', { name: /^Beta$/u }).first().click().catch(async () => page.getByText(/^Beta$/u).first().click())
  await inFront('Beta')
  await connected('Beta')
  log('Beta in front; title =', JSON.stringify(await chatTitle()))
  await popOutActive(); await sleep(4000)
  const urls = await overlays()
  const ids = urls.map(u => new URL(u).searchParams.get('pet'))
  log('  overlays after both:', ids)
  if (ids.length === 2 && new Set(ids).size === 2) log('PASS two overlays at once:', ids)
  else fail(`expected two distinct overlays, got ${JSON.stringify(ids)}`)
  await shot('03-two-out')

  // Submit from Gamma's pet while Beta is in front.
  const gammaId = ids.find(i => /gamma/iu.test(i)) ?? ids.find(i => !/beta/iu.test(i))
  const gamma = overlayPage(gammaId)
  if (!gamma) throw new Error(`no overlay page for ${gammaId}`)
  const marker = `XAGENT-${Date.now()}`
  await gamma.evaluate(text => window.hermesDesktop.petOverlay.control({ type: 'submit', text }), marker)
  log('submitted from Gamma overlay while Beta was in front:', marker)
  await inFront('Gamma')
  await page.waitForFunction(m => (document.body.textContent || '').includes(m), marker, { timeout: 60_000 })
  log('PASS cross-agent submit: title =', JSON.stringify(await chatTitle()), '; marker present in Gamma thread')
  await shot('04-after-submit')
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
