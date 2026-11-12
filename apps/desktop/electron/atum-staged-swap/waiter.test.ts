import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { temporaryRoots } from './test-fixtures'
import { waiterArguments } from './waiter'

const roots = temporaryRoots()

afterEach(roots.cleanup)

interface Poll {
  started: string
  shown: string
  launchPid: number
  seconds: number
}

/** Exercise the real shell and real PIDs, but advance its sleep calls by acknowledgement.
 * JS fake timers cannot control /bin/sh. The shell function below supplies that clock at the
 * existing sleep seam, without adding a test-only option to the production launcher.
 */
async function launcher(options: {
  onPoll?: (poll: Poll) => Promise<void>
  exitOnLaunch?: boolean
  relaunch?: boolean
  withTarget?: boolean
  noStartSeconds?: number
  liveSeconds?: number
} = {}) {
  // A path containing -W must never be mistaken for the opener's wait flag.
  const dir = await roots.make('atum-waiter-W-')
  const log = path.join(dir, 'open.log')
  const started = path.join(dir, 'started')
  const shown = path.join(dir, 'shown')
  const target = path.join(dir, 'Target.app')
  const backup = path.join(dir, 'previous.app')
  const opener = path.join(dir, 'open')
  const hold = path.join(dir, 'hold')

  await fs.mkdir(backup)

  if (options.withTarget !== false) {await fs.mkdir(target)}
  await fs.writeFile(log, '')
  const fifo = spawn('/usr/bin/mkfifo', [hold])
  const [fifoCode] = await once(fifo, 'exit')

  expect(fifoCode).toBe(0)
  await fs.writeFile(opener, `#!/bin/sh
echo "$*" >> "${log}"
case "$2" in
  -W)
    echo "opened:$$"
    ${options.exitOnLaunch ? 'exit 0' : `read -r hold < "${hold}"`}
    ;;
esac
`, { mode: 0o755 })

  // Unlike a short sleep, this parent cannot disappear before the waiter observes it.
  const parent = spawn('/bin/cat', [], { stdio: ['pipe', 'ignore', 'ignore'] })
  const parentExited = once(parent, 'exit')

  const args = waiterArguments({
    parentPid: parent.pid!, target, backup, startedMarker: started, shownMarker: shown,
    relaunch: options.relaunch ?? true, opener,
    noStartSeconds: options.noStartSeconds ?? 30, liveSeconds: options.liveSeconds ?? 30
  })

  args[1] = `sleep() { echo "sleep:$1"; read -r tick <&3; }\n${args[1]}`
  const child = spawn('/bin/sh', args, { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] })
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
  const clock = child.stdio[3] as Duplex
  const lines = createInterface({ input: child.stdout! })
  let opened!: (pid: number) => void
  const opening = new Promise<number>(resolve => { opened = resolve })
  let seconds = 0
  let parentPolls = 0
  let pending = Promise.resolve()
  let failure: unknown

  // Attach before yielding: neither process events nor clock requests can be missed.
  lines.on('line', line => {

    if (line.startsWith('opened:')) {opened(Number(line.slice(7))); return}

    if (!line.startsWith('sleep:')) {return}
    pending = pending.then(async () => {
      if (line === 'sleep:0.1') {
        parentPolls++
        process.kill(parent.pid!, 0)
        parent.kill('SIGKILL')
        await parentExited
      } else {
        const launchPid = await opening

        await options.onPoll?.({ started, shown, launchPid, seconds })
        seconds++
      }

      clock.write('tick\n')
    }).catch(error => {
      failure = error
      child.kill('SIGKILL')
    })
  })

  try {
    const [code] = await exited

    await pending

    if (failure) {throw failure}
    expect(code).toBe(0)
    expect(parentPolls).toBe(1)
    const calls = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean)

    return { calls, seconds, target, backup }
  } finally {
    // Also reap the opener on rollback and assertion failure. No 20/30-second orphan sleeps
    // survive into sibling tests, and nothing can touch roots after their cleanup.
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* Already exited. */ }
    parent.kill('SIGKILL')
    await parentExited
    lines.close()
    clock.destroy()
  }
}

const publish = async (started: string, pid: number) => {
  await fs.writeFile(`${started}.tmp`, `${pid}\n`)
  await fs.rename(`${started}.tmp`, started)
}

describe('update launcher script', () => {
  it('waits for the old process, opens the target, and leaves a window that appeared alone', async () => {
    const run = await launcher({ onPoll: async ({ shown }) => { await fs.writeFile(shown, '') } })

    expect(run.calls).toEqual([`-n -W ${run.target}`])
  })

  it('opens the signed backup when the new version exits before showing a window', async () => {
    const run = await launcher({ exitOnLaunch: true })

    expect(run.calls).toEqual([`-n -W ${run.target}`, `-n ${run.backup}`])
  })

  it('opens the backup when the target cannot be opened at all', async () => {
    const run = await launcher({ exitOnLaunch: true, withTarget: false })

    expect(run.calls[run.calls.length - 1]).toBe(`-n ${run.backup}`)
  })

  it('opens the backup when nothing started within the short no-start limit', async () => {
    const run = await launcher({ noStartSeconds: 3 })

    expect(run.calls).toEqual([`-n -W ${run.target}`, `-n ${run.backup}`])
    expect(run.seconds).toBe(3)
  })

  it('does not roll back a slow launch whose process is alive and has started', async () => {
    const run = await launcher({
      noStartSeconds: 3, liveSeconds: 15,
      onPoll: async ({ started, shown, launchPid, seconds }) => {
        await publish(started, launchPid)

        if (seconds === 5) {await fs.writeFile(shown, '')}
      }
    })

    expect(run.calls).toEqual([`-n -W ${run.target}`])
    expect(run.seconds).toBe(6)
  })

  it('opens the backup when the process that started has died before its window', async () => {
    const app = spawn('/bin/cat', [], { stdio: ['pipe', 'ignore', 'ignore'] })
    const exited = once(app, 'exit')

    try {
      const run = await launcher({
        onPoll: async ({ started, seconds }) => {
          if (seconds === 0) {
            await publish(started, app.pid!)
          } else {
            // Let the waiter observe the live PID for one iteration before reaping it.
            app.kill('SIGKILL')
            await exited
          }
        }
      })

      expect(run.calls).toEqual([`-n -W ${run.target}`, `-n ${run.backup}`])
      // Neither opener exit nor either 30-tick deadline can explain the rollback.
      expect(run.seconds).toBe(2)
    } finally {
      app.kill('SIGKILL')
      await exited
    }
  })

  it('gives a started but windowless launch up after the long limit', async () => {
    const run = await launcher({
      liveSeconds: 2,
      onPoll: async ({ started, launchPid }) => { await publish(started, launchPid) }
    })

    expect(run.calls).toEqual([`-n -W ${run.target}`, `-n ${run.backup}`])
    expect(run.seconds).toBe(2)
  })

  it('after an ordinary Quit swap, opens nothing', async () => {
    const run = await launcher({ relaunch: false })

    expect(run.calls).toEqual([])
  })

  it('after an ordinary Quit that died between the renames, opens the backup', async () => {
    const run = await launcher({ relaunch: false, withTarget: false })

    expect(run.calls).toEqual([`-n ${run.backup}`])
  })
})
