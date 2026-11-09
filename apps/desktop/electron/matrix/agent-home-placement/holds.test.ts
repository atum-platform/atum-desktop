import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { AgentHomeHolds } from './holds'
import { AgentHomeJournal } from './journal'
import { MemoryStore } from './mac.fixture'

function setup() {
  const store = new MemoryStore()
  const journal = new AgentHomeJournal(store)

  return { store, journal, holds: new AgentHomeHolds(journal), agent: randomUUID() }
}

const reopen = (store: MemoryStore, agent: string) => {
  const holds = new AgentHomeHolds(new AgentHomeJournal(store))
  holds.seed(agent)

  return holds
}

describe('the model hold', () => {
  it('is written to the journal when set, so a restart still finds the agent held', () => {
    const s = setup()

    s.holds.add(s.agent, 'model')

    expect(s.journal.read(s.agent).modelHold).toBe(true)
    expect(reopen(s.store, s.agent).reasons(s.agent)).toEqual(['model'])
    expect(reopen(s.store, s.agent).has(s.agent)).toBe(true)
  })

  it('is forgotten by the journal only when the step that set it lets it go', () => {
    const s = setup()
    s.holds.add(s.agent, 'model')
    s.holds.add(s.agent, 'drain')

    s.holds.remove(s.agent, 'drain')
    expect(reopen(s.store, s.agent).reasons(s.agent)).toEqual(['model'])

    s.holds.remove(s.agent, 'model')
    expect(s.journal.read(s.agent).modelHold).toBeUndefined()
    expect(reopen(s.store, s.agent).has(s.agent)).toBe(false)
  })

  it('is written once, not on every look', () => {
    const s = setup()
    let writes = 0
    const store = {
      getItem: (key: string) => s.store.getItem(key),
      setItem: (key: string, value: string) => {
        writes += 1
        s.store.setItem(key, value)
      },
      removeItem: (key: string) => s.store.removeItem(key)
    }
    const holds = new AgentHomeHolds(new AgentHomeJournal(store))

    for (let each = 0; each < 5; each += 1) {holds.add(s.agent, 'model')}
    expect(writes).toBe(1)

    // Letting go of a hold that is not set writes nothing either.
    for (let each = 0; each < 5; each += 1) {holds.remove(s.agent, 'standDown')}
    expect(writes).toBe(1)
  })

  it('keeps the lease, and survives alongside a stand-down', () => {
    const s = setup()
    s.holds.add(s.agent, 'model')
    expect(s.holds.keepsLease(s.agent)).toBe(true)

    s.holds.add(s.agent, 'standDown')
    const reopened = reopen(s.store, s.agent)
    expect([...reopened.reasons(s.agent)].sort()).toEqual(['model', 'standDown'])
    expect(reopened.keepsLease(s.agent)).toBe(false)
  })

  it('is not set for an agent that never had one', () => {
    const s = setup()

    expect(reopen(s.store, s.agent).has(s.agent)).toBe(false)
    expect(s.journal.read(s.agent).modelHold).toBeUndefined()
  })
})
