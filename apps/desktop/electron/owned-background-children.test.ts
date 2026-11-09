import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { createDesktopUpdater, type ElectronUpdaterPort } from './desktop-updater'
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
  it('one Restart waits for persistence then kills a stubborn child before stock install', async () => {
    const children = new OwnedBackgroundChildren()
    const background = children.track(await child(), true)
    const bystander = await child()
    const native = new EventEmitter()
    const events = new EventEmitter()
    let release!: () => void

    const checkpoint = new Promise<void>(resolve => {
      release = resolve
    })

    let handler!: ReturnType<typeof createMatrixQuitHandler>
    const quit = () => handler({ preventDefault() {} })
    let installs = 0

    const stock = Object.assign(events, {
      checkForUpdates: async () => null,
      setFeedURL() {},
      quitAndInstall: () => {
        installs++
        expect(background.killed || !alive(background.pid!)).toBe(true)
        expect(alive(bystander.pid!)).toBe(true)
      }
    }) as unknown as ElectronUpdaterPort

    const updater = createDesktopUpdater({
      busy: () => false,
      currentVersion: '1.0.0',
      feedUrl: 'https://updates.example/',
      isPackaged: true,
      loadUpdater: async () => stock,
      logger: console,
      nativeUpdater: native,
      quit,
      setInterval() {},
      settings: {
        migrate: async () => ({ applied: null, channel: 'latest' }),
        getChannel: async () => 'latest',
        setChannel: async () => {}
      },
      setInstallTimer: () => 0
    })

    handler = createMatrixQuitHandler(
      () => new Promise(() => {}),
      quit,
      () => (updater.afterTeardown() ? 'handled' : 'quit'),
      { prepare: () => checkpoint, deadlineMs: 30, forceCleanup: () => children.killNow() }
    )

    try {
      await updater.start()
      events.emit('update-downloaded', { version: '1.1.0' })
      native.emit('update-downloaded')
      expect(updater.restart()).toBe(true)
      expect(updater.restart()).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(alive(background.pid!)).toBe(true) // No killing before document save.
      expect(installs).toBe(0)
      release()
      await vi.waitFor(() => expect(installs).toBe(1))
      await vi.waitFor(() => expect(alive(background.pid!)).toBe(false))
    } finally {
      children.killNow()
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
