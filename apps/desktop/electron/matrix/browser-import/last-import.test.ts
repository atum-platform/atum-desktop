import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fileLastImportStore } from './last-import'

const dirs: string[] = []

const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atum-last-import-'))
  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const last = {
  siteCount: 7,
  skippedSiteCount: 4,
  agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
  at: 1_800_000_000_000
}

describe('the last import record', () => {
  it('reads back what was written, per owner', () => {
    const file = path.join(scratch(), 'nested', 'browser-import.json')
    const store = fileLastImportStore(file)

    expect(store.read('@a:atum.example')).toBeNull()
    store.write('@a:atum.example', last)
    store.write('@b:atum.example', { ...last, siteCount: 2 })

    expect(store.read('@a:atum.example')).toEqual(last)
    expect(store.read('@b:atum.example')).toMatchObject({ siteCount: 2 })
    expect(store.read('@c:atum.example')).toBeNull()
  })

  it('keeps the owner id out of the file, writes it private, and leaves no temporary file behind', () => {
    const dir = scratch()
    const file = path.join(dir, 'browser-import.json')
    fileLastImportStore(file).write('@owner:atum.example', last)

    expect(readFileSync(file, 'utf8')).not.toContain('atum.example')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['browser-import.json'])
  })

  it('holds counts and a time, never a site or a value', () => {
    const dir = scratch()
    const file = path.join(dir, 'browser-import.json')
    fileLastImportStore(file).write('@owner:atum.example', last)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { owners: Record<string, Record<string, unknown>> }
    const [record] = Object.values(stored.owners)

    expect(Object.keys(record!).sort()).toEqual(['agentPrincipal', 'at', 'siteCount', 'skippedSiteCount'])
  })

  it.each([
    ['not JSON', 'not json'],
    ['another version', JSON.stringify({ v: 2, owners: {} })],
    ['no owners', JSON.stringify({ v: 1 })],
    ['a damaged record', JSON.stringify({ v: 1, owners: { x: { siteCount: -1 } } })]
  ])('reads %s as nothing, never as an error', (_name, content) => {
    const file = path.join(scratch(), 'browser-import.json')
    writeFileSync(file, content)

    expect(fileLastImportStore(file).read('@owner:atum.example')).toBeNull()
  })

  it('refuses a record that is not a whole, well-formed result', () => {
    const file = path.join(scratch(), 'browser-import.json')
    const store = fileLastImportStore(file)
    store.write('@owner:atum.example', last)

    const stored = JSON.parse(readFileSync(file, 'utf8'))
    const key = Object.keys(stored.owners)[0]!

    for (const damage of [{ siteCount: 1.5 }, { agentPrincipal: 'nope' }, { at: 0 }, { skippedSiteCount: '4' }]) {
      writeFileSync(file, JSON.stringify({ v: 1, owners: { [key]: { ...last, ...damage } } }))

      expect(store.read('@owner:atum.example')).toBeNull()
    }
  })

  it('survives overwriting an owner and a second store on the same file', () => {
    const file = path.join(scratch(), 'browser-import.json')
    fileLastImportStore(file).write('@owner:atum.example', last)
    fileLastImportStore(file).write('@owner:atum.example', { ...last, siteCount: 9 })

    expect(fileLastImportStore(file).read('@owner:atum.example')).toMatchObject({ siteCount: 9 })
  })
})
