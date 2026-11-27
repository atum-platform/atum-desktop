import { spawn } from 'node:child_process'
import { once } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { createMatrixQuitHandler } from './matrix/quit'
import { OwnedBackgroundChildren } from './owned-background-children'

function alive(pid: number) {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

async function child() {
  const processChild = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `
    ],
    { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] }
  )

  await once(processChild.stdout!, 'data')

  return processChild
}

describe('update quit with live owned children', () => {
  it('one Restart waits for persistence then kills a stubborn child before handing off', async () => {
    const children = new OwnedBackgroundChildren()
    const background = children.track(await child(), true)
    const bystander = await child()
    let release!: () => void

    const checkpoint = new Promise<void>(resolve => {
      release = resolve
    })

    let handler!: ReturnType<typeof createMatrixQuitHandler>
    const quit = () => handler({ preventDefault() {} })
    let installs = 0
    let installState: { killSent: boolean; bystanderAlive: boolean } | undefined
    const signal = vi.spyOn(process, 'kill')

    handler = createMatrixQuitHandler(
      () => new Promise(() => {}),
      quit,
      () => {
        installs++
        installState = {
          killSent: process.platform === 'win32'
            ? background.killed
            : signal.mock.calls.some(([pid, kind]) => pid === -background.pid! && kind === 'SIGKILL'),
          bystanderAlive: alive(bystander.pid!)
        }

        return 'handled'
      },
      { prepare: () => checkpoint, deadlineMs: 30, forceCleanup: () => children.killNow() }
    )

    try {
      quit()
      quit()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(alive(background.pid!)).toBe(true) // No killing before document save.
      expect(installs).toBe(0)
      release()
      await vi.waitFor(() => expect(installs).toBe(1))
      // POSIX group signalling does not set ChildProcess.killed; a killed pid
      // can remain visible until the OS reaps it. Still require actual death below.
      expect(installState).toEqual({ killSent: true, bystanderAlive: true })
      await vi.waitFor(() => expect(alive(background.pid!)).toBe(false))
    } finally {
      children.killNow()
      signal.mockRestore()
      bystander.kill('SIGKILL')

      if (bystander.exitCode === null && bystander.signalCode === null) {
        await once(bystander, 'exit')
      }
    }
  })

  it('kills the detached process group when its leader exits', async () => {
    if (process.platform === 'win32') {
      return
    }

    const children = new OwnedBackgroundChildren()

    const leader = children.track(
      spawn(
        process.execPath,
        [
          '-e',
          `
      const { spawn } = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(helper.pid));
      setTimeout(() => process.exit(0), 100);
    `
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ),
      true
    )

    const [data] = await once(leader.stdout!, 'data')
    const helper = Number(String(data))

    try {
      await once(leader, 'exit')
      await vi.waitFor(() => expect(alive(helper)).toBe(false))
    } finally {
      children.killNow()

      try {
        process.kill(helper, 'SIGKILL')
      } catch {
        /* Gone. */
      }
    }
  })
})
