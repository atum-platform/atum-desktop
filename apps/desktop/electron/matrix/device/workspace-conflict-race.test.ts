import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ listed: undefined as undefined | ((directory: string) => void),
  read: undefined as undefined | ((file: string) => void) }))

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof FsPromises>()

  return { ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      const names = await fs.readdir(...args)
      hooks.listed?.(String(args[0]))

      return names
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      const read = handle.read.bind(handle)
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs)
        hooks.read?.(String(args[0]))

        return result
      }) as typeof handle.read

      return handle
    }
  }
})
import { ConflictCopyRelay } from './workspace'
const roots: string[] = []
afterEach(() => {
  hooks.listed = undefined; hooks.read = undefined

  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}
})

function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-conflict-race-'))); roots.push(root)
  const drive = path.join(root, 'Drive'), folder = path.join(drive, 'Agents', 'T'), reports = path.join(folder, 'reports')
  mkdirSync(reports, { recursive: true })
  const name = 'brief_conflict-20261005-153000.md', file = path.join(reports, name)
  writeFileSync(file, 'allowed copy')
  let authority = 'account-a', kept: string[] = []

  const relay = new ConflictCopyRelay({ authority: () => authority,
    drive: { manifestFor: async () => ({ root: drive, files: new Map() }) },
    folders: async () => [{ agentPrincipal: 'agent', label: '/Agents/T' }],
    store: { get: () => kept, set: value => { kept = value } }, artifactsRoot: path.join(root, 'artifacts') })

  return { root, folder, reports, name, file, relay, kept: () => kept, authority: (value: string) => { authority = value } }
}

it('refuses a directory replaced by an outside symlink after enumeration', async () => {
  const s = setup(), outside = path.join(s.root, 'outside'), original = s.reports + '-original'
  mkdirSync(outside); writeFileSync(path.join(outside, s.name), 'outside private bytes')

  hooks.listed = directory => {
    if (directory !== s.reports) {return}
    hooks.listed = undefined
    renameSync(s.reports, original); symlinkSync(outside, s.reports)
  }

  expect((await s.relay.scan()).offered).toEqual([])
})
it('refuses bytes from a file edited while its open descriptor is being read', async () => {
  const s = setup()

  hooks.read = file => {
    if (file !== s.file) {return}
    hooks.read = undefined; writeFileSync(file, 'changed during read')
  }

  expect((await s.relay.scan()).offered).toEqual([])
})
it('drops an old account offer and refuses its delayed confirmation', async () => {
  const s = setup(), first = await s.relay.scan()
  expect(first.offered).toHaveLength(1)
  s.authority('account-b'); await s.relay.confirm(first.offered.map(copy => copy.key))
  expect(s.kept()).toEqual([])
  const second = await s.relay.scan()
  expect(second.offered).toHaveLength(1)
  expect(second.offered[0]?.artifact.path).not.toBe(first.offered[0]?.artifact.path)
})
