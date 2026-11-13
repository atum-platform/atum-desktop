import { type Dir, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { searchDriveNames } from './drive-search'

const homes: string[] = []
const ioHooks = vi.hoisted(() => ({ open: undefined as undefined | (() => Promise<Dir>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof NodeFsPromises>()

  return { ...actual, opendir: (...args: Parameters<typeof actual.opendir>) => ioHooks.open?.() ?? actual.opendir(...args) }
})
afterEach(() => {
  ioHooks.open = undefined
  vi.useRealTimers()
  homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true }))
})

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'drive-search-')))
  homes.push(home)
  const root = path.join(home, 'Drive')
  mkdirSync(root)

  return { home, root }
}

it('searches names recursively, returns folder names, and never treats contents as names', async () => {
  const { root } = fixture()
  mkdirSync(path.join(root, 'Docs'))
  writeFileSync(path.join(root, 'Docs', 'Report.txt'), 'secret content')
  writeFileSync(path.join(root, 'other.txt'), 'Report')
  const result = await searchDriveNames(root, root, 'REPORT', {})
  expect(result.rows.map(row => ({ name: row.name, folders: row.folders }))).toEqual([
    { name: 'Report.txt', folders: ['Docs'] }
  ])
})

it('refuses traversal, outside start folders, and symlink roots or start folders', async () => {
  const { home, root } = fixture()
  const outside = path.join(home, 'Outside')
  mkdirSync(outside)
  symlinkSync(outside, path.join(root, 'link'))

  for (const [start, query] of [
    [outside, 'x'],
    [path.join(root, 'link'), 'x'],
    [root, '../x']
  ]) {
    await expect(searchDriveNames(root, start!, query!, {})).rejects.toThrow()
  }

  await expect(searchDriveNames(path.join(root, 'link'), path.join(root, 'link'), 'x', {})).rejects.toThrow()
})

it('omits hidden entries, file links and directory links, even links within Drive', async () => {
  const { home, root } = fixture()
  mkdirSync(path.join(root, 'Docs'))
  writeFileSync(path.join(root, 'Docs', 'report.txt'), '')
  writeFileSync(path.join(root, '.report'), '')
  writeFileSync(path.join(home, 'report-outside'), '')
  symlinkSync(path.join(home, 'report-outside'), path.join(root, 'report-link'))
  symlinkSync(path.join(root, 'Docs'), path.join(root, 'report-folder'))
  expect((await searchDriveNames(root, root, 'report', {})).rows.map(row => row.name)).toEqual(['report.txt'])
})

it('bounds matches, visited entries, depth and elapsed time', async () => {
  const { root } = fixture()

  for (let i = 0; i < 8; i++) {
    writeFileSync(path.join(root, `report-${i}`), '')
  }

  expect(await searchDriveNames(root, root, 'report', { results: 3 })).toMatchObject({
    truncated: true,
    rows: expect.any(Array)
  })
  expect((await searchDriveNames(root, root, 'report', { results: 3 })).rows).toHaveLength(3)
  expect(await searchDriveNames(root, root, 'missing', { entries: 2 })).toMatchObject({ truncated: true })
  mkdirSync(path.join(root, 'deep'))
  writeFileSync(path.join(root, 'deep', 'report-deep'), '')
  expect(await searchDriveNames(root, root, 'report', { depth: 0 })).toMatchObject({ truncated: true })
  expect(await searchDriveNames(root, root, 'report', { timeoutMs: 0 })).toMatchObject({ truncated: true, rows: [] })
})

it('cancels before scanning and during a scan without publishing partial authority', async () => {
  const { root } = fixture()
  writeFileSync(path.join(root, 'report'), '')
  const signal = AbortSignal.abort()
  await expect(searchDriveNames(root, root, 'report', { signal })).rejects.toThrow()
  const controller = new AbortController()
  await expect(
    searchDriveNames(root, root, 'report', { signal: controller.signal, check: () => controller.abort() })
  ).rejects.toThrow()
})

it('times out a stalled directory open and closes a handle that arrives after its deadline', async () => {
  const { root } = fixture()
  const close = vi.fn(async () => {})
  let opened!: () => void
  const reached = new Promise<void>(resolve => { opened = resolve })
  let release!: (dir: Dir) => void

  ioHooks.open = () => {
    opened()

    return new Promise<Dir>(resolve => { release = resolve })
  }

  vi.useFakeTimers()
  const pending = searchDriveNames(root, root, 'report', {})
  await reached
  await vi.advanceTimersByTimeAsync(501)
  expect(await pending).toEqual({ rows: [], truncated: true })
  release({ close } as unknown as Dir)
  await Promise.resolve()
  expect(close).toHaveBeenCalledOnce()
})
