import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  MATRIX_AGENT_CREATIONS,
  MATRIX_AGENT_RETIREMENTS,
  type MatrixAgentCreation,
  MatrixAgentCreationRefused,
  MatrixAgentLifecycle,
  type MatrixAgentLifecycleDeps,
  matrixAgentSoulText,
  reconcileMatrixAgentSoul,
  seedMatrixAgentSoul
} from './agent-lifecycle'

const AGENT = {
  principal: '00000000-0000-4000-8000-63804d107579',
  id: '00000000-0000-4000-8000-6c8dbd6d95b3',
  matrixUser: '@alfred:test'
}

function vault() {
  const map = new Map<string, string>()

  return {
    map,
    store: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      failureCode: () => null
    }
  }
}

function lifecycle(overrides: Partial<MatrixAgentLifecycleDeps> = {}, shared = vault()) {
  const order: string[] = []

  const deps: MatrixAgentLifecycleDeps = {
    store: shared.store,
    refusal: error => (error instanceof Error && error.message === 'name refused' ? 'name' : undefined),
    createOnPlatform: vi.fn(async (input: { requestId: string }) => {
      order.push(`create:${input.requestId}`)

      return AGENT
    }),
    define: vi.fn(async () => void order.push('define')),
    runtime: vi.fn(() => void order.push('runtime')),
    placed: vi.fn(() => void order.push('placed')),
    retireOnPlatform: vi.fn(async () => {
      order.push('retire')

      return 'complete' as const
    }),
    forgetLocally: vi.fn(async () => void order.push('forget')),
    log: vi.fn(),
    randomId: () => 'request-1',
    ...overrides
  }

  return { deps, order, vault: shared, lifecycle: new MatrixAgentLifecycle(deps) }
}

const saved = (shared: ReturnType<typeof vault>): MatrixAgentCreation[] =>
  JSON.parse(shared.map.get(MATRIX_AGENT_CREATIONS) ?? '[]')

it('recognizes restored native SOUL receipts and adopts confirmed persona text', () => {
  const home = mkdtempSync(join(tmpdir(), 'matrix-native-soul-'))
  const file = join(home, 'SOUL.md')
  const persona = 'Current persona'
  writeFileSync(file, `<!-- atum:instructions revision=7 seed_bytes=1 sha256=${'a'.repeat(64)} -->\n${persona}\n`)

  expect(matrixAgentSoulText(home)).toBe(persona)
  expect(reconcileMatrixAgentSoul(home, persona)).toBe('matches')
  expect(readFileSync(file, 'utf8').trim()).toBe(persona)
})

describe('hiring an open listing', () => {
  const LISTING = 'open/agents/researcher'

  it('sends the listing, never writes a persona over the seed, and leaves it to the cloud', async () => {
    const { deps, order, vault: shared, lifecycle: agents } = lifecycle({
      createOnPlatform: vi.fn(async () => ({ ...AGENT, cloudPlacement: 'capacity' as const }))
    })

    await expect(agents.hire('Researcher', LISTING)).resolves.toEqual({
      principal: AGENT.principal,
      assistantId: AGENT.id
    })
    expect(deps.createOnPlatform).toHaveBeenCalledWith({
      requestId: 'request-1',
      displayName: 'Researcher',
      listingId: LISTING
    })
    // Waiting for capacity is still the cloud's: no definition write, room, setup or connect here.
    expect(deps.define).not.toHaveBeenCalled()
    expect(order).toEqual(['runtime', 'placed'])
    expect(saved(shared)).toEqual([])
  })

  it('resumes an unfinished hire of the same listing under its request, carrying a confirmation', async () => {
    const ids = ['request-1', 'request-2']
    const shared = vault()

    const first = lifecycle(
      {
        randomId: () => ids.shift()!,
        createOnPlatform: vi.fn(async () => {
          throw new Error('offline')
        })
      },
      shared
    )

    await expect(first.lifecycle.hire('Researcher', LISTING)).rejects.toThrow('offline')
    expect(saved(shared)).toMatchObject([{ requestId: 'request-1', listingId: LISTING, step: 'create' }])

    const retry = lifecycle({ randomId: () => ids.shift()! }, shared)
    await retry.lifecycle.hire('Researcher', LISTING, true)
    expect(retry.deps.createOnPlatform).toHaveBeenCalledWith({
      requestId: 'request-1',
      displayName: 'Researcher',
      hireConfirmed: true,
      listingId: LISTING
    })
    expect(retry.deps.define).not.toHaveBeenCalled()
  })

  it('drops a refused hire so the confirmed one starts clean', async () => {
    const shared = vault()
    const refusal = new Error('hire')

    const { lifecycle: agents } = lifecycle(
      {
        refusal: error => (error === refusal ? { hire: 60_000 } : undefined),
        createOnPlatform: vi.fn(async () => {
          throw refusal
        })
      },
      shared
    )

    await expect(agents.hire('Researcher', LISTING)).rejects.toMatchObject({ reason: { hire: 60_000 } })
    expect(saved(shared)).toEqual([])
  })
})

describe('creating another agent', () => {

  it('keeps nothing to repeat when the platform refused the create for good', async () => {
    const {
      lifecycle: agents,
      vault: shared,
      deps
    } = lifecycle({
      createOnPlatform: async () => Promise.reject(new Error('name refused'))
    })

    const refused = agents.create('Atum', '')
    await expect(refused).rejects.toBeInstanceOf(MatrixAgentCreationRefused)
    await expect(refused).rejects.toMatchObject({ reason: 'name' })
    expect(shared.map.has(MATRIX_AGENT_CREATIONS)).toBe(false)
    expect(deps.runtime).not.toHaveBeenCalled()
  })

})

describe('retiring another agent', () => {

  it('retires on the platform first, repeating while sessions remain, then cleans up this Mac', async () => {
    const answers = ['pending', 'pending', 'complete'] as const
    const retireOnPlatform = vi.fn(async () => answers[retireOnPlatform.mock.calls.length - 1]!)
    const { lifecycle: agents, deps, vault: shared } = lifecycle({ retireOnPlatform })

    await expect(agents.retire(AGENT.principal, AGENT.id)).resolves.toBe('complete')
    expect(retireOnPlatform).toHaveBeenCalledTimes(3)
    expect(retireOnPlatform).toHaveBeenCalledWith(AGENT.id)
    expect(deps.forgetLocally).toHaveBeenCalledWith(AGENT.principal)
    expect(shared.map.has(MATRIX_AGENT_RETIREMENTS)).toBe(false)
  })

  it('stops repeating after eight calls, and still cleans up this Mac', async () => {
    const retireOnPlatform = vi.fn(async () => 'pending' as const)
    const { lifecycle: agents, deps } = lifecycle({ retireOnPlatform })

    await expect(agents.retire(AGENT.principal, AGENT.id)).resolves.toBe('pending')
    expect(retireOnPlatform).toHaveBeenCalledTimes(8)
    expect(deps.forgetLocally).toHaveBeenCalledOnce()
  })

  it('keeps nothing of this Mac until the platform retired it, and keeps the intent for the next launch', async () => {
    const first = lifecycle({ retireOnPlatform: async () => Promise.reject(new Error('offline')) })

    await expect(first.lifecycle.retire(AGENT.principal, AGENT.id)).rejects.toThrow('offline')
    expect(first.deps.forgetLocally).not.toHaveBeenCalled()
    // Recorded before the platform was asked: a quit here still retires it.
    expect(JSON.parse(first.vault.map.get(MATRIX_AGENT_RETIREMENTS)!)).toEqual([
      { principal: AGENT.principal, assistantId: AGENT.id }
    ])
    expect(first.lifecycle.retiring()).toEqual(new Set([AGENT.principal]))

    const next = lifecycle({}, first.vault)
    next.lifecycle.resume()
    await vi.waitFor(() => expect(first.vault.map.has(MATRIX_AGENT_RETIREMENTS)).toBe(false))
    expect(next.deps.retireOnPlatform).toHaveBeenCalledWith(AGENT.id)
    expect(next.deps.forgetLocally).toHaveBeenCalledWith(AGENT.principal)
  })

  it("finishes this Mac's cleanup at the next launch when it failed", async () => {
    const first = lifecycle({ forgetLocally: async () => Promise.reject(new Error('disk')) })
    await expect(first.lifecycle.retire(AGENT.principal, AGENT.id)).rejects.toThrow('disk')
    expect(first.lifecycle.retiring()).toEqual(new Set([AGENT.principal]))

    const next = lifecycle({}, first.vault)
    next.lifecycle.resume()
    await vi.waitFor(() => expect(first.vault.map.has(MATRIX_AGENT_RETIREMENTS)).toBe(false))
    expect(next.deps.forgetLocally).toHaveBeenCalledWith(AGENT.principal)
    // The platform's retire repeats safely.
    expect(next.deps.retireOnPlatform).toHaveBeenCalledWith(AGENT.id)
  })

  it('persists root custody until an interrupted root cleanup resumes', async () => {
    const first = lifecycle({ forgetLocally: async () => Promise.reject(new Error('disk')) })
    await expect(first.lifecycle.retire(AGENT.principal, AGENT.id, true)).rejects.toThrow('disk')
    expect(JSON.parse(first.vault.map.get(MATRIX_AGENT_RETIREMENTS)!)).toEqual([
      { principal: AGENT.principal, assistantId: AGENT.id, rootCustody: true }
    ])

    const next = lifecycle({}, first.vault)
    next.lifecycle.resume()
    await vi.waitFor(() => expect(first.vault.map.has(MATRIX_AGENT_RETIREMENTS)).toBe(false))
    expect(next.deps.forgetLocally).toHaveBeenCalledWith(AGENT.principal, true)
  })
})

describe("seeding an agent's persona", () => {
  const home = () => join(mkdtempSync(join(tmpdir(), 'agent-soul-')), 'profile')

  it("writes the persona before Hermes's own default, private to the person", async () => {
    const target = home()
    await seedMatrixAgentSoul(target, async () => '  You are Alfred.  ')
    expect(readFileSync(join(target, 'SOUL.md'), 'utf8')).toBe('You are Alfred.\n')
    expect(statSync(join(target, 'SOUL.md')).mode & 0o777).toBe(0o600)
  })

  it('never replaces a SOUL.md that is already there, and does not read the definition then', async () => {
    const target = home()
    await seedMatrixAgentSoul(target, async () => 'first')
    const soul = vi.fn(async () => 'second')
    writeFileSync(join(target, 'SOUL.md'), 'edited by the person\n')
    await seedMatrixAgentSoul(target, soul)
    expect(readFileSync(join(target, 'SOUL.md'), 'utf8')).toBe('edited by the person\n')
    expect(soul).not.toHaveBeenCalled()
  })

  it('writes nothing without a persona, and fails when the definition cannot be read', async () => {
    const empty = home()
    await seedMatrixAgentSoul(empty, async () => '   ')
    await seedMatrixAgentSoul(empty, async () => undefined)
    expect(existsSync(join(empty, 'SOUL.md'))).toBe(false)

    const offline = home()
    await expect(seedMatrixAgentSoul(offline, async () => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline'
    )
    expect(existsSync(join(offline, 'SOUL.md'))).toBe(false)
  })
})

describe("the primary assistant's persona", () => {
  const home = () => join(mkdtempSync(join(tmpdir(), 'primary-soul-')), 'profile')

  // What Hermes writes into a home that has no SOUL.md yet (its own default, no newline).
  const hermesDefault =
    'You are Hermes Agent, an intelligent AI assistant created by Nous Research. ' +
    'You are helpful, knowledgeable, and direct. You assist users with a wide ' +
    'range of tasks including answering questions, writing and editing code, ' +
    'analyzing information, creative work, and executing actions via your tools. ' +
    'You communicate clearly, admit uncertainty when appropriate, and prioritize ' +
    'being genuinely useful over being verbose unless otherwise directed below. ' +
    'Be targeted and efficient in your exploration and investigations.'

  const soulOf = (target: string) => readFileSync(join(target, 'SOUL.md'), 'utf8')

  it('never gives another agent the primary persona', async () => {
    const other = home()
    await seedMatrixAgentSoul(other, async () => undefined)

    expect(existsSync(join(other, 'SOUL.md'))).toBe(false)
  })
})
