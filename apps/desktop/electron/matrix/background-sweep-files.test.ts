import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { recentMacFileNames } from './background-sweep-files'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('background-safe recent Mac filenames', () => {
  it('returns only bounded names and times without paths or sensitive entries', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'atum-sweep-files-'))
    roots.push(root)
    const nested = path.join(root, 'Project')
    mkdirSync(nested)
    writeFileSync(path.join(root, 'Plan.md'), 'private contents')
    writeFileSync(path.join(nested, 'Budget.xlsx'), 'private contents')
    writeFileSync(path.join(root, '.env'), 'SECRET=never')
    writeFileSync(path.join(root, 'access-token.txt'), 'never')
    const outside = mkdtempSync(path.join(os.tmpdir(), 'atum-sweep-outside-'))
    roots.push(outside)
    writeFileSync(path.join(outside, 'Outside.txt'), 'never')
    symlinkSync(outside, path.join(root, 'Linked'))
    const recent = new Date('2026-10-28T03:00:00.000Z')
    utimesSync(path.join(root, 'Plan.md'), recent, recent)
    utimesSync(path.join(nested, 'Budget.xlsx'), new Date(recent.getTime() - 1_000), new Date(recent.getTime() - 1_000))

    const result = await recentMacFileNames({ roots: [root], since: recent.getTime() - 10_000, limit: 2 })

    expect(result.map(file => file.name)).toEqual(['Plan.md', 'Budget.xlsx'])
    expect(result.every(file => /^[a-f0-9]{64}$/u.test(file.identity))).toBe(true)
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('private contents')
  })

  it('quietly skips roots that are absent or unreadable to the caller', async () => {
    await expect(recentMacFileNames({ roots: ['/definitely/not/an/atum/root'], since: 1 })).resolves.toEqual([])
  })
})
