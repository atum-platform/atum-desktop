import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { DeviceLedgerState } from './contracts'
import { DeviceLedger, isTerminalState, LedgerError, type LedgerStore, ledgerTransitionAllowed } from './ledger'

/** An in-memory stand-in for the sealed EncryptedStore. */
function fakeStore(): LedgerStore & { data: Map<string, string>; failWrites: boolean } {
  const data = new Map<string, string>()

  const store = {
    data,
    failWrites: false,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (store.failWrites) {
        throw new Error('auth_storage_write_failed')
      }

      data.set(key, value)
    }
  }

  return store
}

const begin = (ledger: DeviceLedger, commandId: string, seq = 1) =>
  ledger.begin({ commandId, commandHash: `h-${commandId}`, grantId: 'g1', seq })

// The contract's ledger state machine (device-service/1 `state_machines.ledger`) and its sequences.
const packDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/device-protocol/fixtures/device-service'
)
const contract = JSON.parse(readFileSync(path.join(packDir, 'contract.json'), 'utf8'))

describe('the ledger follows the contract state machine', () => {
  const transitions = contract.state_machines.ledger.transitions as [DeviceLedgerState, DeviceLedgerState, string][]

  it('allows exactly the contract transitions', () => {
    const states = contract.state_machines.ledger.states as DeviceLedgerState[]

    for (const from of states) {
      for (const to of states) {
        const listed = transitions.some(([a, b]) => a === from && b === to)
        expect(ledgerTransitionAllowed(from, to), `${from} → ${to}`).toBe(listed)
      }
    }
  })

  it('the terminal states are the contract terminal states', () => {
    for (const state of contract.state_machines.ledger.states as DeviceLedgerState[]) {
      expect(isTerminalState(state)).toBe((contract.state_machines.ledger.terminal as string[]).includes(state))
    }
  })

  for (const entry of (contract.fixtures as { file: string; machine?: string; expect: string }[]).filter(
    f => f.machine === 'ledger'
  )) {
    it(`${entry.file}: ${entry.expect === 'accept' ? 'every step is allowed' : 'some step is refused'}`, () => {
      const steps = JSON.parse(readFileSync(path.join(packDir, entry.file), 'utf8')).steps as {
        from: DeviceLedgerState
        to: DeviceLedgerState
      }[]
      const allowed = steps.every(step => ledgerTransitionAllowed(step.from, step.to))
      expect(allowed).toBe(entry.expect === 'accept')
    })
  }
})

describe('DeviceLedger durability', () => {
  it('persists the intent before the spawn and the terminal state before the receipt', () => {
    const store = fakeStore()
    let now = 1000
    const ledger = new DeviceLedger(store, () => now)

    begin(ledger, 'c1', 5)
    expect(JSON.parse(store.data.get('device-ledger')!).c1.state).toBe('not_started')

    ledger.start('c1', { startedAt: now })
    expect(JSON.parse(store.data.get('device-ledger')!).c1.state).toBe('started')

    now = 2000
    ledger.finish('c1', { state: 'completed', result: { exitCode: 0, output: 'ok' }, endedAt: now })
    const stored = JSON.parse(store.data.get('device-ledger')!).c1
    expect(stored.state).toBe('completed')
    expect(stored.result).toEqual({ exitCode: 0, output: 'ok' })
    expect(stored.commandHash).toBe('h-c1')
  })

  it('an intent that cannot be made durable throws, and nothing is left behind to answer with', () => {
    const store = fakeStore()
    const ledger = new DeviceLedger(store, () => 1)
    store.failWrites = true

    expect(() => begin(ledger, 'c1')).toThrow(LedgerError)
    expect(ledger.get('c1')).toBeUndefined()
  })

  it('a start that cannot be made durable keeps the record at not_started', () => {
    const store = fakeStore()
    const ledger = new DeviceLedger(store, () => 1)
    begin(ledger, 'c1')
    store.failWrites = true

    expect(() => ledger.start('c1', { startedAt: 1 })).toThrow('device_ledger_unwritable')
    expect(ledger.get('c1')?.state).toBe('not_started')
  })

  it('never re-runs a completed or unknown command', () => {
    const ledger = new DeviceLedger(fakeStore(), () => 1)
    begin(ledger, 'done')
    ledger.start('done', { startedAt: 1 })
    ledger.finish('done', { state: 'completed', endedAt: 2 })
    expect(() => ledger.start('done', { startedAt: 3 })).toThrow('device_ledger_transition')

    begin(ledger, 'maybe')
    ledger.start('maybe', { startedAt: 1 })
    ledger.finish('maybe', { state: 'unknown', endedAt: 2 })
    expect(() => ledger.start('maybe', { startedAt: 3 })).toThrow('device_ledger_transition')
  })

  it('cannot complete a command that never started', () => {
    const ledger = new DeviceLedger(fakeStore(), () => 1)
    begin(ledger, 'c1')
    expect(() => ledger.finish('c1', { state: 'completed', endedAt: 2 })).toThrow('device_ledger_transition')
    expect(ledger.finish('c1', { state: 'refused', refusal: 'approval_denied', endedAt: 2 }).state).toBe('refused')
  })

  it('a refusal of an unseen id is recorded, but never overwrites a known one (a replay)', () => {
    const ledger = new DeviceLedger(fakeStore(), () => 1)
    ledger.refuse({ commandId: 'r1', commandHash: 'h', grantId: 'g', seq: 1, refusal: 'args_hash_mismatch' })
    expect(ledger.get('r1')).toMatchObject({ state: 'refused', refusal: 'args_hash_mismatch' })

    begin(ledger, 'c1')
    expect(() =>
      ledger.refuse({ commandId: 'c1', commandHash: 'other', grantId: 'g', seq: 2, refusal: 'replayed' })
    ).toThrow('device_ledger_exists')
    expect(ledger.get('c1')?.commandHash).toBe('h-c1')
  })
})

describe('DeviceLedger after a crash', () => {
  it('a started record is unknown and a never-spawned one failed_no_effect on the next load', () => {
    const store = fakeStore()
    const first = new DeviceLedger(store, () => 1000)
    begin(first, 'mid')
    first.start('mid', { startedAt: 1000 })
    begin(first, 'pre')

    const reloaded = new DeviceLedger(store, () => 5000)
    const reconciled = reloaded.load()
    expect(reconciled.map(r => r.commandId).sort()).toEqual(['mid', 'pre'])
    expect(reloaded.get('mid')?.state).toBe('unknown')
    expect(reloaded.get('pre')?.state).toBe('failed_no_effect')
    // ... and it is durable, not just in memory.
    expect(new DeviceLedger(store, () => 6000).load()).toHaveLength(0)
  })

  it('a completed record is left alone', () => {
    const store = fakeStore()
    const first = new DeviceLedger(store, () => 1000)
    begin(first, 'c3')
    first.start('c3', { startedAt: 1000 })
    first.finish('c3', { state: 'completed', endedAt: 1001 })

    const reloaded = new DeviceLedger(store, () => 5000)
    expect(reloaded.load()).toHaveLength(0)
    expect(reloaded.get('c3')?.state).toBe('completed')
  })

  it('survives a corrupt sealed blob by starting empty', () => {
    const store = fakeStore()
    store.data.set('device-ledger', '{not json')
    const ledger = new DeviceLedger(store, () => 1)
    expect(ledger.load()).toHaveLength(0)
    expect(ledger.get('anything')).toBeUndefined()
  })
})

describe('DeviceLedger stays bounded', () => {
  it('prunes terminal records past the 7-day dedup window, never in-flight ones', () => {
    const store = fakeStore()
    let now = 0
    const ledger = new DeviceLedger(store, () => now)
    begin(ledger, 'old')
    ledger.start('old', { startedAt: 0 })
    ledger.finish('old', { state: 'completed', endedAt: 0 })
    begin(ledger, 'stuck')
    ledger.start('stuck', { startedAt: 0 })

    now = 8 * 24 * 60 * 60 * 1000
    begin(ledger, 'new', 2)
    expect(ledger.get('old')).toBeUndefined()
    expect(ledger.get('stuck')?.state).toBe('started')
    expect(ledger.get('new')?.state).toBe('not_started')
  })

  it('keeps output only for the most recent receipts', () => {
    let now = 0
    const ledger = new DeviceLedger(fakeStore(), () => now)

    for (let index = 0; index < 40; index += 1) {
      now = index + 1
      begin(ledger, `c${index}`, index + 1)
      ledger.start(`c${index}`, { startedAt: now })
      ledger.finish(`c${index}`, { state: 'completed', result: { exitCode: 0, output: 'x'.repeat(100) }, endedAt: now })
    }

    expect(ledger.get('c39')?.result?.output).toHaveLength(100)
    expect(ledger.get('c0')?.result).toEqual({ exitCode: 0 })
    expect(ledger.get('c0')?.state).toBe('completed')
  })
})
