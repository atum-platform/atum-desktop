#!/usr/bin/env node
// Local native acceptance of the real overlay module/preload/renderer in an
// ad-hoc signed, isolated app. This does not claim a production release audit.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { createPackage } from '@electron/asar'
import { build } from 'esbuild'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(repo, 'apps/desktop')
const desktopRequire = createRequire(path.join(desktop, 'package.json'))
const { _electron } = desktopRequire('playwright-core')
const dist = path.join(desktop, 'dist-matrix')
const out = path.join(desktop, 'build/plan3-pet-overlay-proof')
assert.equal(process.platform, 'darwin')
assert.equal(existsSync(path.join(dist, 'matrix-pet.html')), true, 'Build the Matrix candidate first')
const stamp = JSON.parse(readFileSync(path.join(dist, 'matrix-build-stamp.json')))
assert.equal(stamp.dirty, false, 'Use a clean committed candidate build')
assert.match(stamp.commit, /^[a-f0-9]{40}$/u)
mkdirSync(out, { recursive: true, mode: 0o700 })
const input = path.join(out, 'input')
rmSync(input, { recursive: true, force: true })
mkdirSync(input)
for (const name of ['matrix-pet.html', 'matrix-pet-preload.js', 'matrix-pet-modules.json', 'matrix-pet-preload-modules.json', 'assets', 'fonts']) {
  cpSync(path.join(dist, name), path.join(input, name), { recursive: true, mode: 2,
    filter: file => !/\.(?:map|wasm)$/u.test(file) })
}
const python = process.env.PET_PROOF_PYTHON ?? path.join(repo, '.venv/bin/python')
const sprite = JSON.parse(execFileSync(python, ['-B', '-m', 'hermes_cli.atum_pet_sprite', '--root', path.join(desktop, 'assets/pets'), '--slug', 'gigi', '--scale', '1'], {
  cwd: repo, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, PYTHONPATH: repo, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
}))
assert.equal(sprite.enabled, true)
writeFileSync(path.join(input, 'sprite.json'), JSON.stringify(sprite))
writeFileSync(path.join(input, 'package.json'), JSON.stringify({ name: 'atum-pet-native-proof', version: '1.0.0', main: 'proof.cjs' }))
const main = `
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MatrixPetOverlayService } from './apps/desktop/electron/matrix/pet-overlay-service';
import { MatrixPetDisplay } from './apps/desktop/electron/matrix/pet-overlay-preferences';
app.setPath('userData', process.env.PET_PROOF_HOME);
await app.whenReady();
const root = app.getAppPath();
const sprite = JSON.parse(readFileSync(path.join(root, 'sprite.json'), 'utf8'));
const values = new Map();
let context = { accountKey: 'synthetic-native-account', scope: 'synthetic-native-scope', locale: 'en', reducedMotion: true, snapshot: { roomId: '!synthetic-private-room', rooms: [], messages: [] } };
const target = { scope: context.scope, agent: 'synthetic-agent' };
const submitted = [], actions = [], windows = [];
const service = new MatrixPetOverlayService({
 context: () => context,
 read: async () => ({ sprite, freshness: 'current', selection: { owner: 'synthetic-owner', agent: target.agent, pet: null, access: 'owned', revision: 1, provenance: null, visitEndsAt: null, serverTime: new Date().toISOString() } }),
 room: agent => context && agent === target.agent ? '!synthetic-private-room' : undefined,
 send: async (roomId, text) => { submitted.push({roomId, text}); },
 action: async (target, action) => { actions.push({target, action}); }
}, new MatrixPetDisplay({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }), {
 createWindow: options => { const window = new BrowserWindow(options); const record = { window, options, ignores: [] }; const ignore = window.setIgnoreMouseEvents.bind(window); window.setIgnoreMouseEvents = (...args) => { record.ignores.push(args[0]); return ignore(...args); }; windows.push(record); return window; },
 ipc: ipcMain, screen,
 preload: path.join(root, 'matrix-pet-preload.js'),
 url: pathToFileURL(path.join(root, 'matrix-pet.html')).href,
 signed: app.isPackaged
});
globalThis.petProof = { service, windows, submitted, actions, target, signOut: () => { context = undefined; service.clear(); } };
app.on('before-quit', () => service.dispose());
await service.open(target);
`
await build({ stdin: { contents: main.replace('await app.whenReady();', '(async () => { await app.whenReady();') + '\n})().catch(e => { console.error(e); app.exit(1); });', resolveDir: repo, sourcefile: 'pet-proof-main.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(input, 'proof.cjs') })
const electronRoot = path.dirname(desktopRequire.resolve('electron/package.json'))
const electronPackage = JSON.parse(readFileSync(path.join(electronRoot, 'package.json')))
const electronApp = path.join(electronRoot, 'dist/Electron.app')
const appRoot = path.join(out, 'Pet Overlay Proof.app')
rmSync(appRoot, { recursive: true, force: true })
execFileSync('/bin/cp', ['-cR', electronApp, appRoot])
const executable = path.join(appRoot, 'Contents/MacOS/Pet Overlay Proof')
renameSync(path.join(appRoot, 'Contents/MacOS/Electron'), executable)
execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleExecutable Pet Overlay Proof', path.join(appRoot, 'Contents/Info.plist')])
execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.atum.pet-overlay-proof', path.join(appRoot, 'Contents/Info.plist')])
const resources = path.join(appRoot, 'Contents/Resources')
rmSync(path.join(resources, 'default_app.asar'), { force: true })
await createPackage(input, path.join(resources, 'app.asar'))
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appRoot], { stdio: 'pipe' })
execFileSync('codesign', ['--verify', '--deep', '--strict', appRoot], { stdio: 'pipe' })
const userData = path.join(out, 'isolated-user-data')
mkdirSync(userData, { recursive: true, mode: 0o700 })
const nativeHelper = path.join(out, 'native-helper')
writeFileSync(path.join(out, 'native-helper.swift'), `
import CoreGraphics
import Foundation
let args = CommandLine.arguments
if args[1] == "move" {
  let error = CGWarpMouseCursorPosition(CGPoint(x: Double(args[2])!, y: Double(args[3])!))
  if error != .success { exit(1) }
} else {
  let target = Int(args[2])!
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
  let rows = windows.enumerated().compactMap { index, row -> [String: Any]? in
    guard let pid = row[kCGWindowOwnerPID as String] as? Int,
      let owner = row[kCGWindowOwnerName as String] as? String,
      pid == target || owner == "Finder" else { return nil }
    return ["index": index, "pid": pid, "owner": owner, "id": row[kCGWindowNumber as String]!, "layer": row[kCGWindowLayer as String]!]
  }
  print(String(data: try! JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!)
}
`)
execFileSync('xcrun', ['swiftc', '-module-cache-path', path.join(out, 'swift-module-cache'), path.join(out, 'native-helper.swift'), '-o', nativeHelper], { stdio: 'pipe' })
const appInstance = await _electron.launch({ executablePath: executable, args: [], env: { ...process.env, PET_PROOF_HOME: userData }, timeout: 30_000 })
const evidence = { schema: 'atum.pets.pt9.native-proof/1', sourceCommit: stamp.commit, electronVersion: electronPackage.version, scope: 'isolated ad-hoc signed native overlay app; no Matrix account, release or production claim', checks: [] }
let finderWindow
const originalCursor = await appInstance.evaluate(({ screen }) => screen.getCursorScreenPoint())
try {
  const page = await appInstance.firstWindow()
  await page.locator('canvas').waitFor()
  await page.waitForFunction(() => { const canvas = document.querySelector('canvas'); return canvas && [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data].some((v, i) => i % 4 === 3 && v > 0) })
  const native = await appInstance.evaluate(({ app }) => {
    const record = globalThis.petProof.windows[0], window = record.window;
    return { packaged: app.isPackaged, alwaysOnTop: window.isAlwaysOnTop(), allWorkspaces: window.isVisibleOnAllWorkspaces(), preferences: window.webContents.getLastWebPreferences(), options: record.options, bounds: window.getBounds(), initiallyIgnores: record.ignores[0] };
  })
  assert.equal(native.packaged, true)
  assert.equal(native.alwaysOnTop, true)
  assert.equal(native.allWorkspaces, true)
  assert.equal(native.initiallyIgnores, true)
  assert.equal(native.preferences.sandbox, true)
  assert.equal(native.preferences.contextIsolation, true)
  assert.equal(native.preferences.nodeIntegration, false)
  assert.equal(native.options.webPreferences.devTools, false)
  assert.equal(await appInstance.evaluate(() => { const wc = globalThis.petProof.windows[0].window.webContents; wc.openDevTools(); return wc.isDevToolsOpened(); }), false)
  evidence.checks.push('real packaged sandboxed floating native window; default click-through; workspaces')
  execFileSync(nativeHelper, ['move', String(native.bounds.x + 2), String(native.bounds.y + 2)])
  await page.waitForTimeout(200)
  assert.equal(await appInstance.evaluate(() => globalThis.petProof.windows[0].ignores.at(-1)), true)
  const hit = await page.locator('.matrix-pet-overlay-hit').boundingBox()
  assert.ok(hit)
  execFileSync(nativeHelper, ['move', String(native.bounds.x + hit.x + hit.width / 2), String(native.bounds.y + hit.y + hit.height / 2)])
  await page.waitForTimeout(200)
  assert.equal(await appInstance.evaluate(() => globalThis.petProof.windows[0].ignores.at(-1)), false)
  evidence.checks.push('real native cursor leaves blank glass click-through and makes the sprite interactive')
  finderWindow = Number(execFileSync('osascript', ['-e', 'tell application "Finder"', '-e', 'set proofWindow to make new Finder window', '-e', 'set target of proofWindow to POSIX file ' + JSON.stringify(out), '-e', 'activate', '-e', 'return id of proofWindow', '-e', 'end tell'], { encoding: 'utf8' }).trim())
  assert.ok(Number.isSafeInteger(finderWindow))
  await page.waitForTimeout(500)
  const pid = await appInstance.evaluate(() => process.pid)
  const layers = JSON.parse(execFileSync(nativeHelper, ['layers', String(pid)], { encoding: 'utf8' }))
  const overlayLayer = layers.find(row => row.pid === pid)
  const finderLayer = layers.find(row => row.owner === 'Finder' && row.layer === 0)
  assert.ok(overlayLayer && finderLayer)
  assert.ok(overlayLayer.index < finderLayer.index && overlayLayer.layer > finderLayer.layer)
  evidence.checks.push('macOS compositor reports the real pet window above the activated Finder app')
  const boundary = await page.evaluate(() => ({ keys: Object.keys(window.atumMatrixPetOverlay).sort(), require: typeof window.require, services: typeof window.atumMatrix, sdk: typeof window.atumMatrixSdk }))
  assert.deepEqual(boundary.keys, ['click', 'drag', 'menu', 'onSnapshot', 'popIn', 'setInteractive', 'submit'].sort())
  assert.equal(boundary.require, 'undefined')
  assert.equal(boundary.services, 'undefined')
  assert.equal(boundary.sdk, 'undefined')
  evidence.checks.push('actual isolated preload has only seven closed bridge methods; no SDK or desktop services')
  assert.equal(await page.evaluate(async () => { try { await window.atumMatrixPetOverlay.submit({ roomId: '!foreign', text: 'wrong' }); return false } catch { return true } }), true)
  assert.equal(await page.evaluate(async () => { try { await window.atumMatrixPetOverlay.menu('generalRpc'); return false } catch { return true } }), true)
  evidence.checks.push('real IPC rejects target-bearing submit and unknown menu intent')
  await page.evaluate(() => window.atumMatrixPetOverlay.click())
  await page.getByRole('textbox').fill('native overlay proof')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await appInstance.evaluate(() => globalThis.petProof.submitted.length === 1 || Promise.reject(new Error('submit not received')))
  const submitted = await appInstance.evaluate(() => globalThis.petProof.submitted)
  assert.deepEqual(submitted, [{ roomId: '!synthetic-private-room', text: 'native overlay proof' }])
  evidence.checks.push('actual renderer form and native service resolve plain text to the registered synthetic private room')
  await page.screenshot({ path: path.join(out, 'native-chat.png') })
  await appInstance.evaluate(() => globalThis.petProof.signOut())
  assert.equal(await appInstance.evaluate(() => globalThis.petProof.windows.every(record => record.window.isDestroyed())), true)
  evidence.checks.push('native sign-out service clear destroys the real window and timers')
  evidence.result = 'pass'
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
} finally {
  execFileSync(nativeHelper, ['move', String(originalCursor.x), String(originalCursor.y)])
  if (finderWindow) execFileSync('osascript', ['-e', 'tell application "Finder" to close window id ' + finderWindow])
  await appInstance.close()
}
