import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Where the pet starts, and whose choice that is.
 *
 * This one function has produced two shipped bugs — a `[]` that re-persisted
 * itself on subscribe and could not be cleared from inside the app, and a v1
 * `false` written on subscribe for everyone, read back later as a deliberate
 * "no pet". Both were about telling an applied default apart from a real
 * preference, which is untestable by inspection and trivial to test here.
 *
 * `storedAgents()` runs at import time, so each case seeds storage and then
 * imports the module fresh.
 */

const V1_ACTIVE = 'hermes.desktop.pet-overlay-active.v1'
const V3_AGENTS = 'hermes.desktop.pet-overlay-agents.v3'
const V4_AGENTS = 'hermes.desktop.pet-overlay-agents.v4'

async function agentsOnBoot(): Promise<readonly string[]> {
  vi.resetModules()
  const { $petOverlayAgents } = await import('./pet-overlay')

  return $petOverlayAgents.get()
}

describe('where the pet starts', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('keeps the pet in the app window on a fresh install', async () => {
    await expect(agentsOnBoot()).resolves.toEqual([])
  })

  it('ignores the v3 pop-out default, which was applied rather than chosen', async () => {
    // Every v3 install reads `["default"]` whether or not anyone asked for it.
    window.localStorage.setItem(V3_AGENTS, JSON.stringify(['default']))

    await expect(agentsOnBoot()).resolves.toEqual([])
  })

  it('honours a v1 pop-out, which only a real gesture could have written', async () => {
    window.localStorage.setItem(V1_ACTIVE, 'true')

    await expect(agentsOnBoot()).resolves.toEqual(['default'])
  })

  it('reads a v1 false as no opinion, not as a refusal', async () => {
    // v1 persisted on subscribe, so `false` was written for people who never
    // touched the pet. It must not be mistaken for a choice either way.
    window.localStorage.setItem(V1_ACTIVE, 'false')

    await expect(agentsOnBoot()).resolves.toEqual([])
  })

  it('restores what the user actually popped out', async () => {
    window.localStorage.setItem(V4_AGENTS, JSON.stringify(['default', 'researcher']))

    await expect(agentsOnBoot()).resolves.toEqual(['default', 'researcher'])
  })

  it('keeps an emptied list empty instead of re-applying a default', async () => {
    // Popping the pet back in persists `[]`. Re-popping it on the next launch
    // would overrule that choice every single time.
    window.localStorage.setItem(V4_AGENTS, JSON.stringify([]))

    await expect(agentsOnBoot()).resolves.toEqual([])
  })

  it('survives a corrupt value rather than throwing on boot', async () => {
    window.localStorage.setItem(V4_AGENTS, '{not json')

    await expect(agentsOnBoot()).resolves.toEqual([])
  })

  it('drops non-string entries from a hand-edited list', async () => {
    window.localStorage.setItem(V4_AGENTS, JSON.stringify(['default', 42, null, '']))

    await expect(agentsOnBoot()).resolves.toEqual(['default'])
  })
})
