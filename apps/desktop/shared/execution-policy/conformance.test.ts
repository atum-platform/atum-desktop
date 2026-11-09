import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  buildExecutionPolicyUpdate,
  executionContractAccepts,
  executionDestinationViews,
  executionPolicyDraft,
  executionStatusMatchesPolicy,
  moveExecutionDestination,
  parseExecutionPolicySnapshot,
  parseExecutionStatusSnapshot,
  setExecutionDestinationEnabled
} from './index'

interface FixtureEntry {
  file: string
  message: string
  expect: 'accept' | 'reject'
}

interface ContractPack {
  pack_files: string[]
  fixtures: FixtureEntry[]
}

interface Vendor {
  path: string
  sha256: string
  source_commit: string
}

const root = new URL('./', import.meta.url)
const load = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const vendor = load<{ packs: Vendor[] }>('VENDORED.json').packs[0]
const pack = load<ContractPack>(`${vendor.path}/contract.json`)

function packDigest(path: string, files: string[]): string {
  const hash = createHash('sha256')

  for (const file of files) {
    const name = Buffer.from(file, 'utf8')
    const body = readFileSync(new URL(`${path}/${file}`, root))
    const nameSize = Buffer.alloc(4)
    nameSize.writeUInt32BE(name.length)
    const bodySize = Buffer.alloc(8)
    bodySize.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameSize).update(name).update(bodySize).update(body)
  }

  return hash.digest('hex')
}

it('pins every declared provider byte at the merged H-F source', () => {
  expect(vendor.source_commit).toBe('4f1a2b2e705a1997d80c168cfeb98b310428e377')
  expect(packDigest(vendor.path, pack.pack_files)).toBe(vendor.sha256)
  expect(readFileSync(new URL(`${vendor.path}/PINNED-SHA256`, root), 'utf8').trim()).toBe(vendor.sha256)
})

describe('provider fixture conformance', () => {
  for (const fixture of pack.fixtures) {
    it(`${fixture.expect}: ${fixture.file}`, () => {
      const value = load<unknown>(`${vendor.path}/${fixture.file}`)
      expect(executionContractAccepts(fixture.message, value)).toBe(fixture.expect === 'accept')
    })
  }
})

it('projects only ordered logical destinations and never exposes raw runtime authority', () => {
  const status = parseExecutionStatusSnapshot(load(`${vendor.path}/fixtures/status-working.response.json`))!
  expect(executionDestinationViews(status)).toEqual([
    {
      id: 'mac:00000000-0000-4000-8000-b454f82c5857',
      kind: 'mac',
      macOrdinal: 1,
      state: 'working',
      enabled: true,
      current: true,
      desired: true
    },
    {
      id: 'cloud',
      kind: 'cloud',
      macOrdinal: null,
      state: 'ready',
      enabled: true,
      current: false,
      desired: false
    },
    {
      id: 'mac:00000000-0000-4000-8000-f6222a1106ee',
      kind: 'mac',
      macOrdinal: 2,
      state: 'disabled',
      reason: 'owner_disabled',
      enabled: false,
      current: false,
      desired: false
    }
  ])
})

it('keeps privacy-safe Mac ordinals stable when policy order changes', () => {
  const status = parseExecutionStatusSnapshot(load(`${vendor.path}/fixtures/status-working.response.json`))!

  const reversed = {
    ...status,
    order: [...status.order].reverse(),
    disabled: [...status.disabled],
    destinations: { ...status.destinations }
  }

  const before = new Map(executionDestinationViews(status).map(view => [view.id, view.macOrdinal]))
  const after = new Map(executionDestinationViews(reversed).map(view => [view.id, view.macOrdinal]))

  expect(after).toEqual(before)
})

it('matches a status to the same disabled set regardless of wire array order', () => {
  const value = load<unknown>(`${vendor.path}/fixtures/status-all-disabled.response.json`)
  const status = parseExecutionStatusSnapshot(value)!

  const policy = parseExecutionPolicySnapshot({
    profile: 'atum.execution-policy/1',
    agentPrincipal: status.agentPrincipal,
    revision: status.policyRevision,
    source: 'saved',
    order: status.order,
    disabled: [...status.disabled].reverse()
  })!

  expect(executionStatusMatchesPolicy(policy, status)).toBe(true)
  expect(executionStatusMatchesPolicy({ ...policy, order: [...policy.order].reverse() }, status)).toBe(false)
})

it('builds revision-fenced whole-policy edits without mutating provider snapshots', () => {
  const policy = parseExecutionPolicySnapshot(load(`${vendor.path}/fixtures/policy-saved.response.json`))!
  const original = structuredClone(policy)
  let draft = executionPolicyDraft(policy)
  draft = setExecutionDestinationEnabled(draft, 'mac:00000000-0000-4000-8000-f6222a1106ee', true)
  draft = moveExecutionDestination(draft, 'cloud', 0)

  expect(buildExecutionPolicyUpdate(policy, draft, '00000000-0000-4000-8000-f1d11edf5c5c')).toEqual({
    requestId: '00000000-0000-4000-8000-f1d11edf5c5c',
    expectedRevision: 2,
    order: ['cloud', 'mac:00000000-0000-4000-8000-b454f82c5857', 'mac:00000000-0000-4000-8000-f6222a1106ee'],
    disabled: []
  })
  expect(policy).toEqual(original)
})

it('refuses invented destinations, invalid positions and changed inventory', () => {
  const policy = parseExecutionPolicySnapshot(load(`${vendor.path}/fixtures/policy-default.response.json`))!
  const draft = executionPolicyDraft(policy)

  expect(() => setExecutionDestinationEnabled(draft, 'mac:00000000-0000-4000-8000-fbfe405ca65f', false)).toThrow(
    'execution_policy_destination_unknown'
  )
  expect(() => moveExecutionDestination(draft, 'cloud', 99)).toThrow('execution_policy_order_invalid')
  expect(() =>
    buildExecutionPolicyUpdate(policy, { order: ['cloud'], disabled: [] }, '00000000-0000-4000-8000-f1d11edf5c5c')
  ).toThrow('execution_policy_update_invalid')
})
