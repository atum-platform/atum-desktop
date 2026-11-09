/* global window, document, requestAnimationFrame */
// Actual built Matrix renderer and bundled Gigi pixels; synthetic bridge, no external requests.
//
// 2026-10-27 (composer-plus lane): the composer's top edge is now her one ground line and her layer
// paints above the glass. This script still scripts the earlier floor-and-perch model (it writes
// against dist-matrix), so its floor/perch assertions are stale; the current rim contract is proven
// by composer-dock.browser-proof.mjs. Keep the lifecycle, focus and gesture coverage here, and
// rebase the floor/perch parts before relying on them again.
//
// Phase A runs on real time and drives the lifecycle the 0.19.3 proof could not see (diagnosis
// §2.3): a resting place saved earlier (the seeded drop point), real window focus and blur (the
// browser's own focus, with another page brought to the front), real room switches through the
// roster, and a reload. An in-page recorder logs her position on every animation frame, so any
// teleport between two frames fails the proof. Phase B installs a virtual clock for the long
// behaviours (composer walk-over and the leap's shape, sleep, work poses, hidden, reduced motion,
// roaming off, resize). A browser cannot be hidden headless, so the hidden step is emulated and
// labelled as such. Browser evidence never closes an owner bug; the installed app does.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { provePetMenuGlass } from './menu-glass.browser-proof.mjs'

import { provePetPopover } from './popover.browser-proof.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const repo = path.resolve(desktop, '../..')
const dist = path.join(desktop, 'dist-matrix')
const output = process.argv[2] ?? '/tmp/plan3-pt2-browser-proof'
mkdirSync(output, { recursive: true })
const slug = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'gigi'
const info = JSON.parse(
  execFileSync(
    path.join(repo, '.venv/bin/python'),
    [
      '-B',
      '-m',
      'hermes_cli.atum_pet_sprite',
      '--root',
      path.join(desktop, 'assets/pets'),
      '--slug',
      slug,
      '--scale',
      '1'
    ],
    {
      cwd: repo,
      env: { PATH: path.join(repo, '.venv/bin'), PYTHONPATH: repo, PYTHONNOUSERSITE: '1' },
      maxBuffer: 6 * 1024 * 1024
    }
  ).toString()
)
const modules = JSON.parse(readFileSync(path.join(dist, 'matrix-renderer-modules.json')))
assert.ok(modules.includes('src/matrix/pet/stage.tsx'))
assert.ok(!modules.some(file => /^src\/store\/(gateway|profile|session|atum-messaging)([./]|$)/.test(file)))

// The owner's 0.19.3 state: a resting place saved by an earlier drop, at the far left.
const SEED_X = 24
const restKey = `atum.matrix.pet-stage-position.v1:${encodeURIComponent(JSON.stringify(['pet-proof', 'agent-a']))}`
// The acceptance window: focused and untouched, she covers a third of the column in this time.
const TRAVERSE_MS = 90_000
// A leap is about 460 ms; a sampled leap longer than this is a lift, not a spring.
const LEAP_MAX_MS = 600

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1120, height: 860 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => {
  if (message.type() === 'error') {
    console.error(message.text())
  }
})
await page.route('**/*', async route => {
  const url = new URL(route.request().url())
  const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname))
  if (url.origin !== 'https://pet-stage.test' || !file.startsWith(dist + path.sep)) {
    return route.abort()
  }
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.png': 'image/png'
  }
  try {
    await route.fulfill({
      body: readFileSync(file),
      contentType: types[path.extname(file)] ?? 'application/octet-stream'
    })
  } catch {
    await route.fulfill({ status: 404, body: '' })
  }
})
await page.addInitScript(
  ({ info, picker, seedX, restKey }) => {
    localStorage.setItem('io.atum.welcome.played', '1')
    // Seeded once per proof: a reload must find whatever she kept since, not the seed again.
    if (!localStorage.getItem('pet-proof.seeded')) {
      localStorage.setItem(restKey, JSON.stringify({ x: seedX, y: 100000 }))
      localStorage.setItem('pet-proof.seeded', '1')
    }
    let seed = 7
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    // No focus override: document.hasFocus() and focus/blur are the browser's own.
    const listeners = new Set()
    let roaming = true
        const diagnostics = []
    let reads = 0
    const chats = []
    let failChat = false
    const room = {
      id: '!pet:test',
      name: 'Gigi stage proof',
      encrypted: true,
      membership: 'join',
      agentPrincipal: 'agent-a',
      roomType: 'io.atum.assistant',
      assistant: true,
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: '@agent:test', membership: 'join' }
      ]
    }
    // A people chat: no companion there, so visiting it unmounts her.
    const people = {
      id: '!people:test',
      name: 'Lan',
      encrypted: true,
      membership: 'join',
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: '@lan:test', membership: 'join' }
      ]
    }
    let snapshot = {
      state: 'ready',
      readiness: { phase: 'ready' },
      apps: { state: 'ready', apps: [] },
      identity: { userId: '@owner:test', deviceId: 'fixture' },
      petScope: 'pet-proof',
      assistant: { userId: '@agent:test', deviceId: 'agent' },
      hermes: 'ready',
      agentRoster: { state: 'ready', since: 0 },
      agents: [
        {
          principal: 'agent-a',
          userId: '@agent:test',
          name: 'Gigi stage proof',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          readiness: { phase: 'ready', since: 0 },
          atumModel: false
        }
      ],
      rooms: [room, people],
      roomId: room.id,
      messages: [],
      error: null,
      displayPreferences: {
        language: { value: 'en', writable: true },
        appearance: { value: 'light', writable: true },
        textSize: { value: 100, writable: true },
        notifications: { value: true, writable: true },
        sound: { value: true, writable: true }
      }
    }
    const catalog = {
      owner: 'owner',
      agent: 'agent-a',
      serverTime: new Date().toISOString(),
      items: [
        {
          ref: { kind: 'bundled', slug: info.slug },
          slug: info.slug,
          name: info.displayName,
          access: 'owned',
          offer: null
        }
      ],
      personal: [],
      visit: { state: 'owned', startedAt: null, endsAt: null },
      hatch: { offer: null, creditEntitlementId: null, roundsLeft: 3 }
    }
    if (picker) {
      catalog.items.push(
        {
          ref: { kind: 'bundled', slug: 'cookie' },
          slug: 'cookie',
          name: 'Cookie',
          access: 'visiting',
          visitEndsAt: new Date(Date.now() + 3600000).toISOString(),
          offer: null
        },
        {
          ref: { kind: 'bundled', slug: 'bailey' },
          slug: 'bailey',
          name: 'Bailey',
          access: 'available',
          offer: {
            id: '11111111-1111-4111-8111-111111111111',
            version: 1,
            priceMicroProtons: 65000000000,
            scope: 'account',
            billingInterval: 'one_time',
            delivery: 'bundled'
          }
        },
        { ref: { kind: 'bundled', slug: 'mochi' }, slug: 'mochi', name: 'Mochi', access: 'owned', offer: null }
      )
    }
    let binding = { ref: { kind: 'bundled', slug: info.slug }, enabled: true, scale: 1 }
    const writes = []
    // Like the real IPC, every read hands back a new object for the same pet.
    const read = () => {
      reads += 1
      return structuredClone({
        freshness: 'current',
        roaming,
        selection: { owner: 'owner', agent: 'agent-a', revision: 1, provenance: 'explicit', pet: binding },
        ...(binding.enabled ? { sprite: { ...info, scale: binding.scale } } : {}),
        catalog
      })
    }
    window.petStageProof = {
      emit(changes) {
        snapshot = { ...snapshot, ...changes }
        listeners.forEach(listener => listener(snapshot))
      },
      roomId: room.id,
      writes,
      chats,
      diagnostics,
      reads: () => reads,
      failChats(value) {
        failChat = value
      },
      setRoaming(value) {
        roaming = value
      },
      hidden: false
    }
    window.atumMatrix = {
      sendTurn: async roomId => ({ turnId: 'fixture-turn', roomId }),
      snapshot: async () => snapshot,
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      connectHermes: async () => {},
      // A roster click asks main to select; main answers with the next snapshot.
      command: async command => {
        if (command?.kind === 'select' && snapshot.rooms.some(value => value.id === command.roomId)) {
          window.petStageProof.emit({ roomId: command.roomId })
        }
        return []
      },
      setWindowMode: async () => {},
      subscribeWindow: () => () => {},
      windowFacts: async () => ({
        platform: 'darwin',
        isFullscreen: false,
        windowButtonPosition: { x: 12, y: 13 },
        overlayWidth: 0
      }),
      pets: {
        read: async () => read(),
        write: async (target, revision, pet) => {
          writes.push({ target, revision, pet })
          binding = pet
          return read()
        },
        catalog: async () => catalog,
        recovery: async () => ({ state: 'none', canDiscard: false }),
        chatHistory: async () => ({
          ok: true,
          history: {
            v: 1,
            pet_key: `bundled:${info.slug}`,
            display_name: info.displayName,
            personality: 'Poised and curious.',
            memory_summary: '',
            recent: [{ role: 'pet', text: `A recent answer from ${info.displayName}`, at: new Date().toISOString() }],
            messages_today: 0,
            daily_cap: 200
          }
        }),
        chat: async input => {
          chats.push({ ref: input.ref, message: input.message, locale: input.locale, messageId: input.message_id })
          if (failChat) {
            return { ok: false, code: 'rate_limited' }
          }
          return {
            ok: true,
            reply: {
              v: 1,
              reply: 'Mình ngồi đây.',
              action: { action: 'sit' },
              recent: [
                { role: 'pet', text: `A recent answer from ${info.displayName}`, at: new Date().toISOString() },
                { role: 'user', text: input.message, at: new Date().toISOString() },
                { role: 'pet', text: 'Mình ngồi đây.', at: new Date().toISOString() }
              ],
              messages_today: 1,
              daily_cap: 200
            }
          }
        },
        onHatchProgress: () => () => {},
        diagnostic: line => diagnostics.push(line)
      }
    }
    // Every animation frame, what the stage painted: a change is recorded with the frame's
    // time and how long that frame took, so motion between any two frames can be bounded.
    window.petTrace = []
    let last = ''
    let frameAt = performance.now()
    const tick = () => {
      const now = performance.now()
      const body = document.querySelector('[data-matrix-pet-stroll] [data-pet-pose]')
      const match = body && /translateX\((-?[\d.]+)px\) translateY\((-?[\d.]+)px\)/.exec(body.style.transform || '')
      const record = !body
        ? { mounted: false }
        : match
          ? {
              mounted: true,
              x: Number(match[1]),
              y: Number(match[2]),
              pose: body.getAttribute('data-pet-pose'),
              walking: body.getAttribute('data-walking') === 'true',
              surface: body.getAttribute('data-pet-surface'),
              shown: body.style.opacity === '1'
            }
          : { mounted: true, placed: false }
      const key = JSON.stringify(record)
      if (key !== last) {
        window.petTrace.push({ ...record, t: now, frame: now - frameAt, focus: document.hasFocus() })
        last = key
      }
      frameAt = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  },
  { info, picker: process.argv.includes('--picker'), seedX: SEED_X, restKey }
)

const stage = page.locator('[data-matrix-pet-stroll]')
const screenshots = []
const capture = async name => {
  const file = path.join(output, `${name}.png`)
  await page.screenshot({ path: file, animations: 'disabled', timeout: 10000 })
  screenshots.push(file)
}
// The last place she was painted at, across every drain of the trace.
let lastPlaced
const drain = async () => {
  const records = await page.evaluate(() => window.petTrace.splice(0))
  for (const record of records) {
    if (record.mounted && record.x !== undefined) {
      lastPlaced = record
    }
  }
  return records
}
const diagnostics = () => page.evaluate(() => window.petStageProof.diagnostics.slice())
const placed = records => records.filter(record => record.mounted && record.x !== undefined)
const pixels = () =>
  page.waitForFunction(
    () => {
      const canvas = document.querySelector('[data-matrix-pet-stroll] canvas')
      return (
        canvas &&
        canvas
          .getContext('2d')
          .getImageData(0, 0, canvas.width, canvas.height)
          .data.some((value, index) => index % 4 === 3 && value > 0)
      )
    },
    undefined,
    { timeout: 10000 }
  )
const untilTrace = async (done, limitMs = 15000) => {
  const records = []
  const end = Date.now() + limitMs
  while (Date.now() < end) {
    records.push(...(await drain()))
    if (done(records)) {
      return records
    }
    await page.waitForTimeout(50)
  }
  throw new Error('trace condition not reached')
}
/** What the stage paints right now, read directly rather than from the change trace. */
const current = () =>
  page.evaluate(() => {
    const body = document.querySelector('[data-matrix-pet-stroll] [data-pet-pose]')
    const match = body && /translateX\((-?[\d.]+)px\) translateY\((-?[\d.]+)px\)/.exec(body.style.transform || '')
    return match
      ? {
          x: Number(match[1]),
          y: Number(match[2]),
          pose: body.getAttribute('data-pet-pose'),
          walking: body.getAttribute('data-walking') === 'true',
          surface: body.getAttribute('data-pet-surface')
        }
      : undefined
  })
const pageNow = () => page.evaluate(() => performance.now())

/** Motion between two consecutive frames is at most one frame of walking or leaping: a snap to an
 * old resting place, a restart at the default entry point or a frozen-then-jumped sprite fails. */
function assertNoTeleport(records, label) {
  const steps = placed(records)
  let worst = { dx: 0, dy: 0 }
  for (let index = 1; index < steps.length; index += 1) {
    const before = steps[index - 1]
    const after = steps[index]
    // A frame never advances the engine more than 64 ms (stage.tsx).
    const frame = Math.min(64, Math.max(after.frame, 16))
    const dx = Math.abs(after.x - before.x)
    const dy = Math.abs(after.y - before.y)
    worst = { dx: Math.max(worst.dx, dx), dy: Math.max(worst.dy, dy) }
    assert.ok(
      dx <= 0.1 * frame + 3 && dy <= 1.8 * frame + 4,
      `${label}: no teleport between frames (${JSON.stringify(before)} -> ${JSON.stringify(after)})`
    )
  }
  return worst
}

/** Each leap onto a ledge or off it: its frames, the run-up that led to it, and where it landed. */
function leapsIn(records) {
  const steps = placed(records)
  const leaps = []
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index].pose === 'jump' && steps[index - 1].pose !== 'jump') {
      let end = index
      while (end < steps.length && steps[end].pose === 'jump') {
        end += 1
      }
      const landing = steps[end]
      const runUp = []
      for (let back = index - 1; back >= 0 && steps[back].walking; back -= 1) {
        runUp.unshift(steps[back])
      }
      leaps.push({ frames: steps.slice(index, end), landing, runUp, before: steps[index - 1] })
      index = end
    }
  }
  // A leap changes level; a jump gesture in place does not.
  return leaps.filter(leap => leap.landing && leap.landing.surface !== leap.before.surface)
}

const result = { result: 'PASS', builtRenderer: true, modules: modules.length, realTime: {}, virtualClock: {} }
const other = await context.newPage()

try {
  // Focus is the browser's own: off this page's emulated focus, onto real window focus.
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await other.setContent('<title>Another app</title><p>Another app the person works in.</p>')
  await page.bringToFront()
  await page.goto('https://pet-stage.test/matrix.html')
  await stage.locator('canvas').waitFor({ state: 'attached', timeout: 10000 })
  await pixels()
  await page.bringToFront()
  assert.equal(await page.evaluate(() => document.hasFocus()), true, 'the chat window has real focus')

  // A0. She starts at the resting place kept earlier, and says so.
  const opening = placed(await untilTrace(records => placed(records).length > 0))
  assert.ok(Math.abs(opening[0].x - SEED_X) <= 1, `starts at the kept resting place (${opening[0].x})`)
  assert.equal(opening[0].surface, 'floor')
  const startedAt = opening[0].t
  const first = (await diagnostics()).filter(line => line.event === 'start')
  assert.deepEqual(
    first.map(line => [line.reason, line.restore, line.window]),
    [['mount', 'saved', 'focused']],
    'one start: mounted, back at the kept place'
  )
  await capture('start-at-kept-place')
  const surfaces = await page.evaluate(() => ({
    stage: document.querySelector('[data-matrix-pet-stroll]').getBoundingClientRect().toJSON(),
    composer: document.querySelector('[data-slot="composer-root"]').getBoundingClientRect().toJSON(),
    stageZ: Number.parseInt(window.getComputedStyle(document.querySelector('[data-matrix-pet-stroll]')).zIndex, 10),
    composerZ: Number.parseInt(window.getComputedStyle(document.querySelector('[data-slot="composer-root"]')).zIndex, 10)
  }))
  assert.ok(surfaces.stageZ > surfaces.composerZ, 'the visible walk-over pet layer is above the composer')
  const petWidth = await stage.locator('[data-pet-pose]').evaluate(element => element.getBoundingClientRect().width)
  const walkable = surfaces.stage.width - petWidth

  // A1. Focused and untouched for 90 seconds of real time: she covers a third of the column.
  const traverse = [...opening]
  while ((await pageNow()) - startedAt < TRAVERSE_MS) {
    await page.waitForTimeout(1000)
    traverse.push(...(await drain()))
  }
  const within = placed(traverse).filter(record => record.t - startedAt <= TRAVERSE_MS)
  const xs = within.map(record => record.x)
  const span = Math.max(...xs) - Math.min(...xs)
  assert.ok(span >= walkable / 3, `walks at least a third of the column in 90 s (${span} of ${walkable})`)
  assert.ok(
    traverse.every(record => record.focus),
    'the window kept real focus throughout'
  )
  const traverseWorst = assertNoTeleport(traverse, 'focused')
  result.realTime.traverse = { spanPx: span, walkablePx: walkable, frames: within.length, worstStep: traverseWorst }

  // A2. Five real blur/focus cycles: another page in front, then back. Visible but unfocused,
  // she keeps going; coming back neither restarts her nor moves her.
  const readsBefore = await page.evaluate(() => window.petStageProof.reads())
  const startsBefore = (await diagnostics()).filter(line => line.event === 'start').length
  const cycles = []
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await other.bringToFront()
    await page.waitForTimeout(4000)
    if (cycle === 0) {
      await capture('unfocused')
    }
    await page.bringToFront()
    await page.waitForTimeout(2000)
    cycles.push(...(await drain()))
  }
  const blurred = placed(cycles).filter(record => !record.focus)
  assert.ok(blurred.length > 0, 'the window really lost focus')
  assert.ok(new Set(blurred.map(record => record.x)).size > 1, 'visible but unfocused, she keeps moving')
  assert.ok(cycles.some(record => record.focus), 'the window really got focus back')
  const cyclesWorst = assertNoTeleport([traverse.at(-1), ...cycles], 'focus cycles')
  const readsAfter = await page.evaluate(() => window.petStageProof.reads())
  assert.ok(readsAfter >= readsBefore + 5, 'every focus re-read the pet (a new object each time)')
  assert.equal(
    (await diagnostics()).filter(line => line.event === 'start').length,
    startsBefore,
    'no focus restarted her engine'
  )
  const unfocusedLines = (await diagnostics()).filter(line => line.event === 'state' && line.window === 'unfocused')
  assert.ok(unfocusedLines.length > 0, 'her diagnostics show her changing what she does while unfocused')
  result.realTime.focusCycles = {
    cycles: 5,
    unfocusedFrames: blurred.length,
    unfocusedPlaces: new Set(blurred.map(record => record.x)).size,
    reReads: readsAfter - readsBefore,
    restarts: 0,
    unfocusedLines: unfocusedLines.map(line => `${line.pose}/${line.surface}`),
    worstStep: cyclesWorst
  }

  // A3. Real room switches through the roster: away to a people chat (no companion there) and
  // back. She comes back where she was, not at the kept drop point and not at the default.
  const switches = []
  for (let trip = 0; trip < 2; trip += 1) {
    await drain()
    const beforeClick = lastPlaced
    await page.locator('[data-matrix-room="!people:test"] [data-roster-row]').first().click()
    const away = await untilTrace(records => records.some(record => !record.mounted))
    // Her last painted place before the chat went away.
    const latest = placed(away.slice(0, away.findIndex(record => !record.mounted))).at(-1) ?? beforeClick
    await page.waitForTimeout(1500)
    await page.locator('[data-matrix-agent="agent-a"] [data-roster-row]').first().click()
    const back = placed(await untilTrace(records => placed(records).length > 0))
    // Same place on the same surface (a surface's height follows the layout, not her). Gone
    // mid-walk, she may have taken a step or two between her last painted frame and the unmount.
    assert.ok(
      Math.abs(back[0].x - latest.x) <= 6 && back[0].surface === latest.surface,
      `room switch ${trip + 1}: back where she was (${JSON.stringify(latest)} -> ${JSON.stringify(back[0])})`
    )
    assert.ok(Math.abs(back[0].x - SEED_X) > 1 || Math.abs(latest.x - SEED_X) <= 1, 'not snapped to the old drop point')
    switches.push({ before: { x: latest.x, y: latest.y }, after: { x: back[0].x, y: back[0].y } })
    await page.waitForTimeout(3000)
    assertNoTeleport([back[0], ...(await drain())], `after room switch ${trip + 1}`)
  }
  // The first return is written at once; a second within the minute is folded into the next
  // line for that reason (`repeats`), so a restart storm stays one line a minute.
  const restarts = (await diagnostics()).filter(line => line.event === 'start').slice(startsBefore)
  assert.deepEqual(
    restarts.map(line => [line.reason, line.restore]),
    [['remount', 'saved']],
    'a return is a remount back at her kept place'
  )
  await capture('after-room-switch')
  result.realTime.roomSwitches = switches

  // A4. A restart (reload): she resumes where she last rested.
  let rest = await current()
  for (let tries = 0; tries < 600 && (!rest || rest.walking || rest.pose === 'jump' || rest.pose === 'run'); tries += 1) {
    await page.waitForTimeout(50)
    rest = await current()
  }
  assert.ok(rest && !rest.walking, 'she came to rest before the restart')
  // Every diagnostics line this page wrote, as main.log would show them (formatted by main).
  result.realTime.diagnosticLines = await diagnostics()
  await page.reload()
  await stage.locator('canvas').waitFor({ state: 'attached', timeout: 10000 })
  await pixels()
  await page.bringToFront()
  const relaunched = placed(await untilTrace(records => placed(records).length > 0))
  assert.ok(
    Math.abs(relaunched[0].x - rest.x) <= 1,
    `after a restart she resumes where she last rested (${rest.x} -> ${relaunched[0].x})`
  )
  assert.deepEqual(
    (await diagnostics()).filter(line => line.event === 'start').map(line => [line.reason, line.restore]),
    [['mount', 'saved']]
  )
  result.realTime.restart = { rested: { x: rest.x, y: rest.y }, resumed: { x: relaunched[0].x, y: relaunched[0].y } }
  result.realTime.diagnosticsAfterRestart = await diagnostics()

  // Phase B: a virtual clock for the long behaviours. A real room switch re-homes every timer
  // onto the installed clock (the stage remounts under it).
  await page.clock.install()
  await page.locator('[data-matrix-room="!people:test"] [data-roster-row]').first().click()
  await untilTrace(records => records.some(record => !record.mounted))
  await page.locator('[data-matrix-agent="agent-a"] [data-roster-row]').first().click()
  await untilTrace(records => placed(records).length > 0)
  const footRatio = (info.anchor?.footY ?? info.frameH) / info.frameH
  const floor = await stage.locator('[data-pet-pose]').evaluate((element, ratio) => {
    const pet = element.getBoundingClientRect()
    return {
      petFeet: pet.top + pet.height * ratio,
      stageBottom: element.closest('[data-matrix-pet-stroll]').getBoundingClientRect().bottom,
      surface: element.getAttribute('data-pet-surface')
    }
  }, footRatio)
  if (floor.surface === 'floor') {
    assert.ok(Math.abs(floor.petFeet - floor.stageBottom) <= 1, 'window-floor feet meet the actual chat-stage bottom')
  }

  // B1. Seeded roaming with a real click in the transcript now and then (she naps after three
  // idle minutes): composer walk-over, a perch, the way down, gestures, and the leap's shape.
  // An empty spot in the transcript, between the greeting and the composer: a real click there
  // is the person being around, and it presses nothing.
  const chatPoint = await page.evaluate(() => {
    const box = document.querySelector('[data-pet-stage]').getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height * 0.62 }
  })
  const roam = []
  const poses = new Set()
  let composerWalkOver = false
  for (let step = 0; step < 750; step += 1) {
    await page.clock.runFor(200)
    if (step % 150 === 0) {
      await page.mouse.click(chatPoint.x, chatPoint.y)
    }
    const look = await page.evaluate(() => {
      const canvas = document.querySelector('[data-matrix-pet-stroll] canvas')
      const body = canvas.closest('[data-pet-pose]')
      const pet = canvas.getBoundingClientRect()
      const composer = document.querySelector('[data-pet-perch="composer"], [data-slot="composer-surface"]')?.getBoundingClientRect()
      const meets = box =>
        box && box.width > 0 && pet.left < box.right && pet.right > box.left && pet.top < box.bottom && pet.bottom > box.top
      const reserved = [...document.querySelector('[data-atum-chat]').querySelectorAll('[data-pet-avoid]')]
      return {
        pose: body.getAttribute('data-pet-pose'),
        surface: body.getAttribute('data-pet-surface'),
        overComposer: body.getAttribute('data-pet-surface') === 'floor' && Boolean(meets(composer)),
        outside: reserved.some(element => !element.closest('[data-pet-perch="composer"]') && meets(element.getBoundingClientRect())),
        records: window.petTrace.splice(0)
      }
    })
    assert.equal(look.outside, false, 'painted pet never covers deliberately reserved furniture')
    poses.add(look.pose)
    composerWalkOver ||= look.overComposer
    roam.push(...look.records)
    if (look.surface.startsWith('composer:') && !screenshots.some(file => file.endsWith('composer-perch.png'))) {
      await capture('composer-perch')
    }
    if (['wave', 'jump', 'lounging', 'review'].includes(look.pose) && !screenshots.some(file => file.endsWith(`${look.pose}.png`))) {
      await capture(look.pose)
    }
  }
  const roamSteps = placed(roam)
  const roamXs = roamSteps.map(record => record.x)
  assert.ok(Math.max(...roamXs) - Math.min(...roamXs) >= walkable / 3, 'window stage traverses the chat floor')
  assert.equal(composerWalkOver, true, 'the visible floor route intentionally crosses the composer material')
  const perchedAt = roamSteps.findIndex(record => record.surface?.startsWith('composer:'))
  assert.ok(perchedAt >= 0, 'reaches the actual composer top edge')
  assert.ok(roamSteps.slice(perchedAt + 1).some(record => record.surface === 'floor'), 'returns from composer to floor')
  assert.ok([...poses].some(pose => ['wave', 'jump', 'waiting', 'lounging', 'review'].includes(pose)), 'seeded idle gesture reached')
  const roamWorst = assertNoTeleport(roam, 'virtual-clock roaming')
  const leaps = leapsIn(roam)
  const climbs = leaps.filter(leap => leap.landing.surface.startsWith('composer:'))
  assert.ok(climbs.length > 0, 'climbs onto the composer at least once')
  for (const leap of leaps) {
    const lasted = leap.landing.t - leap.frames[0].t
    assert.ok(lasted <= LEAP_MAX_MS, `a leap is a short spring, not a lift (${lasted} ms)`)
    assert.ok(leap.frames.every(frame => !frame.walking), 'a leap is drawn with its own jump row')
    assert.ok(leap.runUp.length > 0, 'every leap follows a run-up')
    assert.ok(Math.abs(leap.runUp.at(-1).x - leap.runUp[0].x) > 0, 'the run-up covers ground')
    assert.ok(Math.min(...leap.frames.map(frame => frame.y)) < Math.min(leap.before.y, leap.landing.y), 'a real arc')
  }
  result.virtualClock.roaming = {
    poses: [...poses],
    surfaceTransitions: roamSteps
      .map(record => record.surface)
      .filter((value, index, all) => index === 0 || value !== all[index - 1]),
    composerWalkOver,
    leaps: leaps.map(leap => ({
      to: leap.landing.surface,
      ms: Math.round(leap.landing.t - leap.frames[0].t),
      runUpPx: Math.abs(leap.runUp.at(-1).x - leap.runUp[0].x)
    })),
    worstStep: roamWorst
  }

  // B2. Three idle minutes: she naps.
  await page.clock.runFor(185000)
  assert.equal(await stage.locator('[data-pet-pose]').getAttribute('data-pet-pose'), 'sleep')
  await capture('sleep')

  // B3. Work and prompts own her standing pose.
  await page.evaluate(() =>
    window.petStageProof.emit({
      hermesActivity: { invocationId: 'work', roomId: window.petStageProof.roomId, state: 'running', text: '', tools: [] }
    })
  )
  assert.equal(await stage.locator('[data-pet-pose]').getAttribute('data-pet-pose'), 'run')
  assert.equal(await stage.locator('[data-pet-pose]').getAttribute('data-walking'), null)
  await capture('working')
  await page.evaluate(() =>
    window.petStageProof.emit({
      hermesPrompts: {
        roomId: window.petStageProof.roomId,
        prompts: [
          { id: 'approval', kind: 'approval', command: 'synthetic fixture', allowOnce: true, deadlineAt: Date.now() + 60000 }
        ]
      }
    })
  )
  assert.equal(await stage.locator('[data-pet-pose]').getAttribute('data-pet-pose'), 'waiting')
  await capture('waiting')
  await page.evaluate(() => window.petStageProof.emit({ hermesActivity: undefined, hermesPrompts: undefined }))
  await page.mouse.click(chatPoint.x, chatPoint.y)

  // B4. Hidden (EMULATED: headless Chrome never hides a page): pixels and place hold still.
  await page.evaluate(() => {
    window.petStageProof.hidden = true
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.petStageProof.hidden })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (window.petStageProof.hidden ? 'hidden' : 'visible')
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const frozen = await stage.locator('canvas').evaluate(canvas => canvas.toDataURL())
  const frozenAt = await stage.locator('[data-pet-pose]').getAttribute('style')
  await page.clock.runFor(120000)
  assert.equal(await stage.locator('canvas').evaluate(canvas => canvas.toDataURL()), frozen, 'hidden freezes real sprite pixels')
  assert.equal(await stage.locator('[data-pet-pose]').getAttribute('style'), frozenAt, 'hidden freezes her place')
  await page.evaluate(() => {
    window.petStageProof.hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
  })
  // Shown again, she carries on from where she stopped (time flows between these reads, so a
  // step or two of walking is fine; a jump elsewhere is not).
  const place = style => /translateX\((-?[\d.]+)px\) translateY\((-?[\d.]+)px\)/.exec(style).slice(1).map(Number)
  const [hiddenX, hiddenY] = place(frozenAt)
  const [shownX, shownY] = place(await stage.locator('[data-pet-pose]').getAttribute('style'))
  assert.ok(Math.abs(shownX - hiddenX) <= 3 && shownY === hiddenY, 'shown again, she is where she stopped')
  await drain()

  // B5. Reduced motion stands still on its first frame.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.runFor(1000)
  assert.equal(await stage.locator('[data-pet-pose]').getAttribute('data-walking'), null)
  const still = await stage.locator('canvas').evaluate(canvas => canvas.toDataURL())
  await page.clock.runFor(30000)
  assert.equal(await stage.locator('canvas').evaluate(canvas => canvas.toDataURL()), still)
  await capture('reduced-motion')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // B6. Roaming switched off reaches her through a real focus re-read, and she docks.
  await page.evaluate(() => window.petStageProof.setRoaming(false))
  await other.bringToFront()
  await page.bringToFront()
  await page.waitForTimeout(50)
  await page.clock.runFor(1000)
  const docked = await stage.locator('[data-pet-pose]').getAttribute('style')
  await page.clock.runFor(60000)
  assert.equal(await stage.locator('[data-pet-pose]').getAttribute('style'), docked, 'roaming off remains docked')
  await capture('roaming-off')

  // B7. The stage follows a resized window.
  await page.setViewportSize({ width: 980, height: 760 })
  await page.clock.runFor(1000)
  const resized = await stage.evaluate(el => {
    const bounds = el.getBoundingClientRect()
    const chat = document.querySelector('[data-pet-stage]').getBoundingClientRect()
    return { stageWidth: Math.round(bounds.width), chatWidth: Math.round(chat.width), stageLeft: bounds.left, chatLeft: chat.left }
  })
  assert.equal(resized.stageWidth, resized.chatWidth, 'resized stage spans the actual responsive chat column')
  assert.equal(resized.stageLeft, resized.chatLeft, 'resized stage stays aligned with the chat column')
  assert.notEqual(resized.stageWidth, Math.round(surfaces.stage.width), 'window resize recomputes the stage')
  await capture('window-resized')
  const picker = process.argv.includes('--picker') ? await provePetPopover(page, output) : undefined
  const menuGlass = process.argv.includes('--menu') ? await provePetMenuGlass(page, output) : undefined
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      ...result,
      virtualClock: { ...result.virtualClock, asleep: true, workAndWaiting: true, hiddenEmulatedFrozen: true, reducedMotion: true, roamingOffDocked: true, resized },
      seededRestingPlace: SEED_X,
      surfaces,
      externalRequests: 'blocked',
      screenshots,
      ...(picker ? { picker } : {}),
      ...(menuGlass ? { menuGlass } : {})
    })
  )
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  console.error(
    JSON.stringify({
      error: String(error),
      stageCount: await stage.count().catch(() => -1),
      text: (await page.locator('body').innerText().catch(() => '')).slice(0, 1600),
      diagnostics: await diagnostics().catch(() => [])
    })
  )
  throw error
} finally {
  await browser.close()
}
