import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEVICE_SERVICE_PACK } from '../../../../../packages/device-protocol/contract-packs'

import { MigrationWriterHolds } from './migration-hold'

const P = DEVICE_SERVICE_PACK.parameters as { migration_hold_ms: number; skew_ms: number }
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migration-hold-'))
  dirs.push(dir)
  const file = path.join(dir, 'vault.json')
  writeFileSync(file, '{}', { mode: 0o600 })

  let wall = 1_000_000,
    mono = 0,
    broken = false

  const store = {
    getItem(key: string) {
      return JSON.parse(readFileSync(file, 'utf8'))[key] ?? null
    },
    setItem(key: string, value: string) {
      if (broken) {
        throw Error('store down')
      }

      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), [key]: value }))
    },
    removeItem() {
      throw Error('unused')
    },
    failureCode() {
      return broken ? 'store_down' : null
    }
  }

  const create = (ownerUserId = '@owner:example.test') =>
    new MigrationWriterHolds({ ownerUserId, store, wallNow: () => wall, monotonicNow: () => mono })

  return {
    create,
    store,
    advance(ms: number) {
      wall += ms
      mono += ms
    },
    jump(ms: number) {
      wall += ms
    },
    break() {
      broken = true
    },
    file
  }
}

describe('migration writers remain stopped until their snapshots cannot commit', () => {
  it('persists before a snapshot and survives app restart and a forward clock jump', () => {
    const f = fixture(),
      migration = randomUUID(),
      agent = randomUUID(),
      holds = f.create()

    holds.begin(migration, agent)
    expect(holds.held(agent)).toBe(true)
    expect(f.create('@other:example.test').held(agent)).toBe(false)
    f.advance(P.migration_hold_ms - 1)
    const restored = f.create()
    f.jump(365 * 24 * 60 * 60_000)
    expect(restored.held(agent)).toBe(true)
    f.advance(P.migration_hold_ms + P.skew_ms + 1)
    expect(restored.held(agent)).toBe(false)
  })

  it('a repeated or inconsistent request never shortens a hold', () => {
    const f = fixture(),
      migration = randomUUID(),
      agent = randomUUID(),
      holds = f.create()

    holds.begin(migration, agent)
    const deadline = holds.deadline(migration)!
    expect(holds.extend(migration, deadline)).toBe(true)
    f.advance(P.migration_hold_ms - 1)
    expect(holds.extend(migration, deadline - 1)).toBe(false)
    expect(holds.deadline(migration)).toBe(deadline)
    f.advance(P.skew_ms + 2)
    expect(holds.held(agent)).toBe(true)
    f.advance(P.migration_hold_ms)
    expect(holds.held(agent)).toBe(false)
  })

  it('definitive refusal releases the agent and prevents overlapping migrations', () => {
    const f = fixture(),
      migration = randomUUID(),
      agent = randomUUID(),
      holds = f.create()

    holds.begin(migration, agent)
    expect(() => holds.begin(randomUUID(), agent)).toThrow('already_moving')
    holds.release(migration, 'failed')
    expect(holds.held(agent)).toBe(false)
    expect(f.create().held(agent)).toBe(false)
    holds.begin(randomUUID(), agent)
  })

  it('vault failure never admits a writer or an unjournaled snapshot', () => {
    const f = fixture(),
      migration = randomUUID(),
      agent = randomUUID(),
      holds = f.create()

    holds.begin(migration, agent)
    f.break()
    expect(() => holds.release(migration, 'failed')).toThrow()
    expect(holds.held(agent)).toBe(true)
    expect(() => holds.begin(randomUUID(), randomUUID())).toThrow()
    expect(() => f.create()).toThrow('store_unavailable')
  })

  it('a malformed persisted hold cannot silently become an empty hold set', () => {
    const f = fixture()
    f.store.setItem('device-migration-holds-v1:@owner:example.test', '[{"agentPrincipal":"bad"}]')
    expect(() => f.create()).toThrow('store_unavailable')
  })
})
