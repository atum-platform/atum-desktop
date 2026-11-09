import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createUpdateHandoff,
  restoredUpdateBounds,
  UPDATE_HANDOFF_MAX_AGE_MS,
  updateHelperCopy,
  updateHelperScript
} from './update-handoff'
import {
  atumUpdateHelperStep,
  UPDATE_HELPER_INITIAL_STATE,
  type UpdateHelperFacts,
  type UpdateHelperState,
  type UpdateHelperStep
} from './update-handoff-step'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}
})

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-update-handoff-'))
  roots.push(root)

  return root
}

/** Drives the step like the helper window does: one tick every half second. */
function simulate(
  events: Array<{ at: number; log?: string; appGone?: boolean; shown?: boolean; cancelled?: boolean; failed?: boolean }>,
  until: number,
  step: typeof atumUpdateHelperStep = atumUpdateHelperStep
) {
  let state: UpdateHelperState = { ...UPDATE_HELPER_INITIAL_STATE }
  let appRunning = true
  let shown = false
  let cancelled = false
  let failed = false
  const ticks: Array<UpdateHelperStep & { at: number }> = []

  for (let at = 500; at <= until; at += 500) {
    let log = ''

    for (const event of events.filter(each => each.at > at - 500 && each.at <= at)) {
      log += event.log ?? ''

      if (event.appGone) {appRunning = false}

      if (event.shown) {shown = true}

      if (event.cancelled) {cancelled = true}

      if (event.failed) {failed = true}
    }

    const facts: UpdateHelperFacts = { now: at, startedAt: 0, appRunning, shown, cancelled, failed, log }
    const result = step(state, facts)
    state = result.state

    if (result.open) {
      state = { ...state, lastOpenAttempt: at, openedAt: at }
    }

    ticks.push({ ...result, at })

    if (result.exit) {break}
  }

  return ticks
}

// The 2026-11-04 0.20.38 restart, from ShipIt_stderr.log and main.log (seconds after the click).
const MEASURED = [
  { at: 6_840, appGone: true, log: 'ShipIt Beginning installation\n' },
  { at: 104_320, log: 'Moving bundle from file:///Applications/Atum.app/ to file:///var/T/x/Atum.app\n' },
  { at: 178_560, log: 'Installation completed successfully\n' },
  { at: 189_420, log: 'Successfully launched application at file:///Applications/Atum.app/\n' },
  { at: 194_160, shown: true }
]

describe('restart progress helper step', () => {
  it('follows ShipIt milestones with a bar that only moves forward and closes when the new window is up', () => {
    const ticks = simulate(MEASURED, 30 * 60_000)
    const last = ticks.at(-1)!
    expect(last.exit).toBe(true)
    expect(last.at).toBe(194_500)
    expect(last.view.progress).toBe(1)
    expect(ticks.some(tick => tick.open)).toBe(false)
    expect(ticks.every(tick => tick.view.phase === 'updating')).toBe(true)

    const progress = ticks.map(tick => tick.view.progress!)
    progress.slice(1).forEach((value, index) => expect(value).toBeGreaterThanOrEqual(progress[index]!))
    // Anchored: before ShipIt reports the swap, the bar stays below the swap's share.
    expect(Math.max(...ticks.filter(tick => tick.at < 104_320).map(tick => tick.view.progress!))).toBeLessThan(0.55)
    expect(Math.max(...ticks.filter(tick => tick.at < 178_560).map(tick => tick.view.progress!))).toBeLessThan(0.9)
  })

  it('goes away at once when the quit is refused', () => {
    const ticks = simulate([{ at: 2_000, cancelled: true }], 60_000)
    expect(ticks.at(-1)).toMatchObject({ at: 2_000, exit: true, open: false })
  })

  it('reopens the installed version once after ShipIt reports an error, only after the old app is gone', () => {
    const ticks = simulate(
      [
        { at: 5_000, log: 'Installation error: Error Domain=SQRLInstallerErrorDomain Code=-9\n' },
        { at: 9_000, appGone: true }
      ],
      10 * 60_000
    )

    const opens = ticks.filter(tick => tick.open)
    expect(opens).toHaveLength(1)
    expect(opens[0]!.at).toBe(9_000)
    expect(ticks.find(tick => tick.at === 5_000)!.view).toMatchObject({ phase: 'failed', progress: null })
    expect(ticks.at(-1)).toMatchObject({ exit: true, at: 99_500 })
  })

  it('treats the old process reporting a failed handoff like a ShipIt error', () => {
    const ticks = simulate([{ at: 3_000, failed: true }, { at: 4_000, appGone: true }], 60_000)
    expect(ticks.filter(tick => tick.open).map(tick => tick.at)).toEqual([4_000])
  })

  it('recovers when ShipIt never starts after the app quit', () => {
    const ticks = simulate([{ at: 6_000, appGone: true }], 5 * 60_000)
    const firstOpen = ticks.find(tick => tick.open)!
    expect(firstOpen.at).toBe(96_500)
    expect(firstOpen.view.phase).toBe('failed')
  })

  it('opens the new version itself when ShipIt installed it but did not relaunch', () => {
    const ticks = simulate(
      [
        { at: 6_000, appGone: true, log: 'Beginning installation\n' },
        { at: 60_000, log: 'Moving bundle from a to b\n' },
        { at: 90_000, log: 'Installation completed successfully\n' }
      ],
      5 * 60_000
    )

    expect(ticks.filter(tick => tick.open).map(tick => tick.at)).toEqual([120_500])
    expect(ticks.every(tick => tick.view.phase !== 'failed')).toBe(true)
  })

  it('leaves the reopening to the staged launcher: after stage state=relaunch the panel never opens the app itself', () => {
    const ticks = simulate(
      [
        { at: 3_000, log: '[updates] stage state=swap\n' },
        { at: 3_500, appGone: true, log: '[updates] stage state=relaunch\n' }
      ],
      5 * 60_000
    )

    expect(ticks.filter(tick => tick.open)).toEqual([])
    expect(ticks.every(tick => tick.view.phase !== 'failed' || tick.at > 15 * 60_000)).toBe(true)
  })

  it('says it is slow after six minutes, gives up waiting at fifteen, and never outlives twenty', () => {
    const ticks = simulate([{ at: 6_000, appGone: true, log: 'Beginning installation\n' }], 25 * 60_000)
    expect(ticks.find(tick => tick.at === 6 * 60_000 + 500)!.view.phase).toBe('slow')
    expect(ticks.find(tick => tick.open)!.at).toBe(15 * 60_000 + 500)
    expect(ticks.at(-1)!.exit).toBe(true)
    expect(ticks.at(-1)!.at).toBeLessThanOrEqual(20 * 60_000 + 500)
  })

  it('leaves quietly if the old app never quits', () => {
    const ticks = simulate([], 10 * 60_000)
    expect(ticks.at(-1)).toMatchObject({ exit: true, open: false, at: 180_500 })
  })

  it('is self-contained, so the helper window runs the exact same decisions', () => {
    const embedded = new Function(`return (${atumUpdateHelperStep.toString()})`)() as typeof atumUpdateHelperStep
    expect(simulate(MEASURED, 30 * 60_000, embedded)).toEqual(simulate(MEASURED, 30 * 60_000))
  })
})

describe('restart handoff record', () => {
  function handoff(root: string, overrides: Partial<Parameters<typeof createUpdateHandoff>[0]> = {}) {
    const spawn = vi.fn()
    const log = vi.fn()
    let clock = 1_000_000

    const value = createUpdateHandoff({
      directory: path.join(root, 'update-handoff'),
      currentVersion: '0.20.38',
      bundlePath: '/Applications/Atum.app',
      shipItLog: path.join(root, 'ShipIt_stderr.log'),
      pid: 4242,
      locale: () => 'vi',
      bounds: () => ({ x: 120, y: 80, width: 1220, height: 800 }),
      log,
      now: () => clock,
      spawn,
      ...overrides
    })

    return { value, spawn, log, advance: (ms: number) => {clock += ms} }
  }

  it('starts the progress window with the place, language and the files it watches', () => {
    const root = tempRoot()
    const directory = path.join(root, 'update-handoff')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'shown'), '')
    const test = handoff(root)
    test.value.begin('0.20.39')

    expect(fs.existsSync(path.join(directory, 'shown'))).toBe(false)
    expect(test.spawn).toHaveBeenCalledExactlyOnceWith('/usr/bin/osascript', [
      '-l', 'JavaScript', path.join(directory, 'progress.js'), path.join(directory, 'handoff.json')
    ])
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'handoff.json'), 'utf8'))
    expect(record).toMatchObject({
      v: 1, fromVersion: '0.20.38', toVersion: '0.20.39', pid: 4242, bundlePath: '/Applications/Atum.app',
      bounds: { x: 120, y: 80, width: 1220, height: 800 }, copy: { title: 'Đang cập nhật Atum' }, directory
    })
    expect(fs.readFileSync(path.join(directory, 'progress.js'), 'utf8')).toBe(updateHelperScript())
  })

  it('never throws when the window cannot start', () => {
    const root = tempRoot()
    const test = handoff(root, { spawn: () => {throw new Error('spawn EACCES')} })
    expect(() => test.value.begin('0.20.39')).not.toThrow()
    expect(test.log).toHaveBeenCalledWith(expect.stringContaining('not started'))
  })

  it('on the next launch reports updated or not, once, and closes the window only when shown', () => {
    const root = tempRoot()
    const directory = path.join(root, 'update-handoff')
    handoff(root).value.begin('0.20.39')

    const next = handoff(root, { currentVersion: '0.20.39' })
    next.value.shown()
    expect(fs.existsSync(path.join(directory, 'shown'))).toBe(false)
    next.advance(194_000)
    expect(next.value.consume()).toMatchObject({
      outcome: 'updated', fromVersion: '0.20.38', toVersion: '0.20.39',
      bounds: { x: 120, y: 80, width: 1220, height: 800 }
    })
    expect(next.value.consume()).toBeNull()
    next.value.shown()
    expect(fs.existsSync(path.join(directory, 'shown'))).toBe(true)
    expect(next.log).toHaveBeenCalledWith('[updates] restart finished outcome=updated from=0.20.38 to=0.20.39 ms=194000')

    handoff(root).value.begin('0.20.39')
    expect(handoff(root).value.consume()?.outcome).toBe('not_updated')
  })

  it('ignores a stale or malformed record', () => {
    const root = tempRoot()
    handoff(root).value.begin('0.20.39')
    const late = handoff(root, { currentVersion: '0.20.39' })
    late.advance(UPDATE_HANDOFF_MAX_AGE_MS + 1)
    expect(late.value.consume()).toBeNull()

    fs.writeFileSync(path.join(root, 'update-handoff', 'handoff.json'), '{"v":1,"fromVersion":3}')
    expect(handoff(root).value.consume()).toBeNull()
    expect(fs.existsSync(path.join(root, 'update-handoff', 'handoff.json'))).toBe(false)
  })

  it('drops a fullscreen or nonsensical place and keeps a restored place on screen', () => {
    const root = tempRoot()
    handoff(root, { bounds: () => null }).value.begin('0.20.39')
    expect(handoff(root, { currentVersion: '0.20.39' }).value.consume()?.bounds).toBeNull()

    expect(restoredUpdateBounds({ x: 3000, y: -40, width: 1220, height: 800 }, { x: 0, y: 25, width: 1440, height: 875 }))
      .toEqual({ x: 220, y: 25, width: 1220, height: 800 })
    expect(restoredUpdateBounds({ x: 10, y: 10, width: 3000, height: 2000 }, { x: 0, y: 25, width: 1440, height: 875 }))
      .toEqual({ x: 0, y: 25, width: 1440, height: 875 })
  })

  it('cancel takes the window down and leaves nothing for the next launch', () => {
    const root = tempRoot()
    const test = handoff(root)
    test.value.begin('0.20.39')
    test.value.cancel()
    expect(fs.existsSync(path.join(root, 'update-handoff', 'cancelled'))).toBe(true)
    expect(handoff(root).value.consume()).toBeNull()
  })

  it('has copy in every desktop language and falls back to English', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant']) {
      expect(Object.values(updateHelperCopy(locale)).every(text => text.length > 0 && text.length <= 40)).toBe(true)
    }

    expect(updateHelperCopy('fr').title).toBe('Updating Atum')
  })

  it.runIf(process.platform === 'darwin')('compiles as macOS JavaScript for Automation', () => {
    const root = tempRoot()
    const script = path.join(root, 'progress.js')
    fs.writeFileSync(script, updateHelperScript())
    execFileSync('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', path.join(root, 'progress.scpt'), script])
    expect(fs.existsSync(path.join(root, 'progress.scpt'))).toBe(true)
  })
})


it('generates a syntactically valid standalone JXA helper', () => {
  expect(() => new Function(updateHelperScript())).not.toThrow()
})
