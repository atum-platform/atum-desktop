import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  discoverChromeHistoryDatabases,
  MacBrowserHistoryError,
  readBrowserHistory
} from './browser-history'
import { createFixtureDatabase } from './test-fixtures'

const temporary: string[] = []

async function browserFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'atum-browser-history-'))
  temporary.push(directory)
  const safariPath = createFixtureDatabase('safari-history', path.join(directory, 'Safari', 'History.db'))
  const chromeRoot = path.join(directory, 'Chrome')
  createFixtureDatabase('chrome-history', path.join(chromeRoot, 'Default', 'History'))

  return { directory, safariPath, chromeRoot }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('fixture-only browser history reads', () => {
  it('discovers Chrome profiles, copies locked-style databases, and strips URL secrets', async () => {
    const fixture = await browserFixture()
    const result = readBrowserHistory(
      { browser: 'all', days: 30, limit: 100, mode: 'recent' },
      {
        safariPath: fixture.safariPath,
        chromeRoot: fixture.chromeRoot,
        now: () => Date.parse('2026-10-28T12:00:00.000Z'),
        tmpDir: () => fixture.directory
      }
    )

    expect(discoverChromeHistoryDatabases(fixture.chromeRoot)).toHaveLength(1)
    expect(result.history.map(entry => `${entry.browser}:${entry.domain}${entry.path}`)).toEqual([
      'chrome:work.example.test/tools',
      'safari:docs.example.test/research',
      'chrome:docs.example.test/editor',
      'chrome:travel.example.test/guide',
      'chrome:code.example.test/projects/atum'
    ])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('?')
    expect(serialized).not.toContain('#')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('eyJhbGci')
    expect(serialized).not.toContain('0123456789abcdef0123456789abcdef')
    expect(serialized).not.toContain('X-Amz')
    expect(serialized).not.toContain('Reset password')
    expect(serialized).toContain('VS Code tips')
    expect(serialized).toContain('Passport guide')
    expect(readdirSync(fixture.directory).some(name => name.startsWith('atum-chrome-history-'))).toBe(false)
  })

  it('orders top pages by visit count and applies the requested total cap', async () => {
    const fixture = await browserFixture()
    const result = readBrowserHistory(
      { browser: 'all', days: 30, limit: 2, mode: 'top' },
      {
        safariPath: fixture.safariPath,
        chromeRoot: fixture.chromeRoot,
        now: () => Date.parse('2026-10-28T12:00:00.000Z'),
        tmpDir: () => fixture.directory
      }
    )

    expect(result.history.map(entry => entry.visits)).toEqual([15, 8])
  })

  it('reports Full Disk Access when Safari cannot be opened and returns Chrome for all', async () => {
    const fixture = await browserFixture()
    const options = {
      safariPath: path.join(fixture.directory, 'missing-safari.db'),
      chromeRoot: fixture.chromeRoot,
      now: () => Date.parse('2026-10-28T12:00:00.000Z'),
      tmpDir: () => fixture.directory
    }

    expect(() =>
      readBrowserHistory({ browser: 'safari', days: 30, limit: 10, mode: 'recent' }, options)
    ).toThrowError(new MacBrowserHistoryError('permission_needed'))

    const partial = readBrowserHistory({ browser: 'all', days: 30, limit: 10, mode: 'recent' }, options)
    expect(partial.permissionNeeded).toEqual(['full_disk'])
    expect(partial.history.every(entry => entry.browser === 'chrome')).toBe(true)
  })
})
