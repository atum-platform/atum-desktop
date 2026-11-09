import { mkdirSync, utimesSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MacLocationProvider } from './location'
import { MacSourcesService } from './service'
import { createFixtureDatabase } from './test-fixtures'

const temporary: string[] = []

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'atum-mac-service-'))
  temporary.push(directory)
  const databasePath = createFixtureDatabase('messages', path.join(directory, 'Messages', 'chat.db'))
  const safariPath = createFixtureDatabase('safari-history', path.join(directory, 'Safari', 'History.db'))
  const chromeRoot = path.join(directory, 'Chrome')
  createFixtureDatabase('chrome-history', path.join(chromeRoot, 'Default', 'History'))

  return { directory, databasePath, safariPath, chromeRoot }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('the account-consented Mac source service', () => {
  it('sweeps only stale abandoned Chrome copies when the service starts', async () => {
    const files = await fixture()
    const stale = path.join(files.directory, 'atum-chrome-history-stale')
    const recent = path.join(files.directory, 'atum-chrome-history-recent')
    const unrelated = path.join(files.directory, 'other-service-stale')
    mkdirSync(stale)
    mkdirSync(recent)
    mkdirSync(unrelated)
    const now = Date.now()
    utimesSync(stale, new Date(now - 7 * 60 * 60 * 1_000), new Date(now - 7 * 60 * 60 * 1_000))
    utimesSync(unrelated, new Date(now - 7 * 60 * 60 * 1_000), new Date(now - 7 * 60 * 60 * 1_000))

    new MacSourcesService({
      consent: () => ({ google: true, folders: true, messages: true, browser: true, location: true, teamSpaces: true }),
      fullDisk: () => 'granted',
      messages: { databasePath: files.databasePath },
      browser: { safariPath: files.safariPath, chromeRoot: files.chromeRoot, tmpDir: () => files.directory },
      location: new MacLocationProvider({
        timeZone: () => 'Asia/Ho_Chi_Minh',
        ownerLocation: vi.fn(async () => ({ enabled: true }))
      })
    })

    const { existsSync } = await import('node:fs')
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('checks consent before touching a source and reports every closed error honestly', async () => {
    const location = new MacLocationProvider({
      timeZone: () => 'Asia/Ho_Chi_Minh',
      ownerLocation: vi.fn(async () => ({ enabled: true, city: 'Ho Chi Minh City' }))
    })
    const service = new MacSourcesService({
      consent: () => ({ google: true, folders: true, messages: false, browser: false, location: false, teamSpaces: true }),
      fullDisk: () => {
        throw new Error('must not probe without consent')
      },
      messages: { databasePath: '/owner/messages.db' },
      browser: { safariPath: '/owner/safari.db', chromeRoot: '/owner/chrome' },
      location
    })
    const signal = new AbortController().signal

    await expect(
      service.request({ op: 'messages.conversations', days: 30, limit: 10 }, { background: false }, signal)
    ).resolves.toBe('{"error":"disabled"}')
    await expect(service.request({ op: 'unknown' }, { background: false }, signal)).resolves.toBe(
      '{"error":"invalid"}'
    )
  })

  it('enforces Full Disk Access and prevents message content in background runs', async () => {
    const location = new MacLocationProvider({
      timeZone: () => 'Asia/Ho_Chi_Minh',
      ownerLocation: vi.fn(async () => ({ enabled: true, city: 'Ho Chi Minh City' }))
    })
    let fullDisk: 'granted' | 'not-granted' = 'not-granted'
    const service = new MacSourcesService({
      consent: () => ({ google: true, folders: true, messages: true, browser: true, location: true, teamSpaces: true }),
      fullDisk: () => fullDisk,
      messages: { databasePath: '/fixture/messages.db' },
      browser: { safariPath: '/fixture/safari.db', chromeRoot: '/fixture/chrome' },
      location
    })
    const signal = new AbortController().signal

    await expect(
      service.request({ op: 'messages.conversations', days: 30, limit: 10 }, { background: false }, signal)
    ).resolves.toBe('{"error":"permission_needed","permission":"full_disk"}')

    fullDisk = 'granted'
    await expect(
      service.request({ op: 'messages.read', id: '1', days: 30, limit: 10 }, { background: true }, signal)
    ).resolves.toBe('{"error":"disabled"}')
  })

  it('runs every reader against fixture databases and preserves Safari partial-permission evidence', async () => {
    const files = await fixture()
    const location = new MacLocationProvider({
      timeZone: () => 'Asia/Ho_Chi_Minh',
      ownerLocation: vi.fn(async () => ({ enabled: true, city: 'Ho Chi Minh City', country: 'VN' }))
    })
    const service = new MacSourcesService({
      consent: () => ({ google: true, folders: true, messages: true, browser: true, location: true, teamSpaces: true }),
      fullDisk: () => 'granted',
      messages: { databasePath: files.databasePath, now: () => Date.parse('2026-10-28T12:00:00.000Z') },
      browser: {
        safariPath: files.safariPath,
        chromeRoot: files.chromeRoot,
        now: () => Date.parse('2026-10-28T12:00:00.000Z'),
        tmpDir: () => files.directory
      },
      location
    })
    const signal = new AbortController().signal

    const conversations = JSON.parse(
      await service.request(
        { op: 'messages.conversations', days: 30, limit: 10 },
        { background: false },
        signal
      )
    )
    expect(conversations.conversations).toHaveLength(2)

    const history = JSON.parse(
      await service.request(
        { op: 'browser.history', browser: 'all', days: 30, limit: 10, mode: 'recent' },
        { background: true },
        signal
      )
    )
    expect(history.history).toHaveLength(5)

    await expect(
      service.request({ op: 'location.current', precision: 'city' }, { background: false }, signal)
    ).resolves.toContain('Ho Chi Minh City')
  })
})
