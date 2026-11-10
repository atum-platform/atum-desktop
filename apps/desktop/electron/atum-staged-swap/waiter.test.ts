import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { temporaryRoots } from './test-fixtures'
import { waiterArguments } from './waiter'

const roots = temporaryRoots()

afterEach(roots.cleanup)

/** Runs the real launcher script under /bin/sh with a fake `open`, whose behaviour each test scripts. */
async function launcher(options: {
  /** What the fake `open -n -W <target>` does; runs under /bin/sh with STARTED and SHOWN set. */
  onLaunch: string
  relaunch?: boolean
  withTarget?: boolean
  noStartSeconds?: number
  liveSeconds?: number
}) {
  const dir = await roots.make('atum-waiter-')
  const log = path.join(dir, 'open.log')
  const started = path.join(dir, 'started')
  const shown = path.join(dir, 'shown')
  const target = path.join(dir, 'Target.app')
  const backup = path.join(dir, 'previous.app')
  const opener = path.join(dir, 'open')

  await fs.mkdir(backup)

  if (options.withTarget !== false) {await fs.mkdir(target)}
  await fs.writeFile(log, '')

  await fs.writeFile(opener, `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *-W*)
    STARTED="${started}"
    SHOWN="${shown}"
    ${options.onLaunch}
    ;;
esac
`, { mode: 0o755 })

  // A real parent that exits shortly after the launcher starts.
  const parent = spawn('/bin/sleep', ['0.4'], { stdio: 'ignore' })

  const args = waiterArguments({
    parentPid: parent.pid!, target, backup, startedMarker: started, shownMarker: shown, relaunch: options.relaunch ?? true,
    opener, noStartSeconds: options.noStartSeconds ?? 1, liveSeconds: options.liveSeconds ?? 10
  })

  const began = Date.now()
  const child = spawn('/bin/sh', args, { stdio: 'ignore' })
  await new Promise(resolve => child.once('exit', resolve))

  const calls = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean)

  return { calls, elapsed: Date.now() - began, target, backup }
}

describe('update launcher script', () => {
  it('waits for the old process, opens the target, and leaves a window that appeared alone', async () => {
    const run = await launcher({ onLaunch: 'echo $$ > "$STARTED.tmp"; mv "$STARTED.tmp" "$STARTED"; touch "$SHOWN"; sleep 20' })

    expect(run.calls).toEqual([`-n -W ${run.target}`])
    expect(run.elapsed).toBeGreaterThanOrEqual(350)
    expect(run.elapsed).toBeLessThan(5000)
  })

  it('opens the signed backup when the new version exits before showing a window', async () => {
    const run = await launcher({ onLaunch: 'exit 0' })

    expect(run.calls).toEqual([`-n -W ${run.target}`, `-n ${run.backup}`])
  })

  it('opens the backup when the target cannot be opened at all', async () => {
    const run = await launcher({ onLaunch: 'exit 1', withTarget: false })

    expect(run.calls[run.calls.length - 1]).toBe(`-n ${run.backup}`)
  })

  it('opens the backup when nothing started within the short no-start limit', async () => {
    // 3 s, not 1 s: a loaded CI runner can take over a second just to spawn the fake `open` (re-review F1).
    const run = await launcher({ onLaunch: 'sleep 20', noStartSeconds: 3 })

    expect(run.calls).toContain(`-n ${run.backup}`)
    expect(run.elapsed).toBeLessThan(15000)
  })

  it('does not roll back a slow launch whose process is alive and has started', async () => {
    // Started right away, shows a window only after longer than the no-start limit.
    const run = await launcher({ onLaunch: 'echo $$ > "$STARTED.tmp"; mv "$STARTED.tmp" "$STARTED"; sleep 5; touch "$SHOWN"; sleep 20', noStartSeconds: 3, liveSeconds: 15 })

    expect(run.calls).toEqual([`-n -W ${run.target}`])
    expect(run.elapsed).toBeGreaterThan(5000)
  })

  it('opens the backup when the process that started has died before its window', async () => {
    // Publish a real, live fake app, then reap it while the opener remains alive.
    // This exercises the started-to-dead transition without carrying an already
    // reaped PID through asynchronous launcher setup. Publish atomically, as store.ts does.
    const run = await launcher({
      onLaunch: 'sleep 1 & app=$!; echo "$app" > "$STARTED.tmp"; mv "$STARTED.tmp" "$STARTED"; wait "$app"; sleep 20',
      noStartSeconds: 30, liveSeconds: 30
    })

    expect(run.calls).toEqual([`-n -W ${run.target}`, `-n ${run.backup}`])
    expect(run.elapsed).toBeLessThan(6000)
  })

  it('gives a started but windowless launch up after the long limit', async () => {
    const run = await launcher({ onLaunch: 'echo $$ > "$STARTED.tmp"; mv "$STARTED.tmp" "$STARTED"; sleep 30', noStartSeconds: 1, liveSeconds: 2 })

    expect(run.calls).toEqual([`-n -W ${run.target}`, `-n ${run.backup}`])
  })

  it('after an ordinary Quit swap, opens nothing', async () => {
    const run = await launcher({ onLaunch: 'touch "$SHOWN"', relaunch: false })

    expect(run.calls).toEqual([])
  })

  it('after an ordinary Quit that died between the renames, opens the backup', async () => {
    const run = await launcher({ onLaunch: 'touch "$SHOWN"', relaunch: false, withTarget: false })

    expect(run.calls).toEqual([`-n ${run.backup}`])
  })
})
