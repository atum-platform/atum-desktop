import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  seedMatrixAgentSoul
} from './agent-lifecycle'
import { ATUM_ASSISTANT_SOUL, MATRIX_PRIMARY_SOUL_FALLBACK } from './atum-soul'

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
    room: vi.fn(async () => {
      order.push('room')

      return '!alfred:test'
    }),
    setUp: vi.fn(async () => {
      order.push('setUp')

      return true
    }),
    connect: vi.fn(async () => void order.push('connect')),
    started: vi.fn(() => void order.push('started')),
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

describe('creating another agent', () => {
  it('blocks background runtime starts until the new profile home is installed and resumes a failed install', async () => {
    const profileImport = { prepared: '/private/prepared', sha256: 'a'.repeat(64) }
    const first = lifecycle({
      importProfile: async () => {
        throw new Error('disk full')
      }
    })
    await expect(first.lifecycle.create('Alfred', '', profileImport)).rejects.toThrow('disk full')
    expect(first.deps.setUp).not.toHaveBeenCalled()
    expect(first.deps.connect).not.toHaveBeenCalled()
    expect(saved(first.vault)[0]).toMatchObject({ step: 'import', roomId: '!alfred:test', profileImport })
    expect(first.lifecycle.blocksRuntime(AGENT.principal)).toBe(true)
    expect(first.lifecycle.blocksRuntime('unrelated')).toBe(false)

    let installed!: () => void
    const next = lifecycle(
      {
        importProfile: () =>
          new Promise<void>(resolve => {
            installed = resolve
          })
      },
      first.vault
    )
    next.lifecycle.resume()
    await vi.waitFor(() => expect(installed).toBeTypeOf('function'))
    expect(next.lifecycle.busy).toBe(true)
    expect(next.lifecycle.blocksRuntime(AGENT.principal)).toBe(true)
    expect(next.deps.setUp).not.toHaveBeenCalled()
    installed()
    await vi.waitFor(() => expect(next.deps.started).toHaveBeenCalled())
    expect(next.lifecycle.blocksRuntime(AGENT.principal)).toBe(false)
    expect(next.lifecycle.busy).toBe(false)
    expect(next.deps.createOnPlatform).not.toHaveBeenCalled()
    expect(next.deps.room).not.toHaveBeenCalled()
    expect(next.deps.setUp).toHaveBeenCalledOnce()
  })

  it('keeps an import stopped if this app cannot install it', async () => {
    const first = lifecycle()
    await expect(
      first.lifecycle.create('Alfred', '', { prepared: '/private/prepared', sha256: 'a'.repeat(64) })
    ).rejects.toThrow('matrix_profile_import_invalid')
    expect(first.lifecycle.blocksRuntime(AGENT.principal)).toBe(true)
    expect(first.deps.setUp).not.toHaveBeenCalled()
  })

  it('reselecting an interrupted preparation resumes the same platform request', async () => {
    const profileImport = { prepared: '/private/prepared', sha256: 'a'.repeat(64) }
    const first = lifecycle({
      importProfile: async () => {
        throw new Error('disk full')
      }
    })
    await expect(first.lifecycle.create('Alfred', '', profileImport)).rejects.toThrow('disk full')
    const next = lifecycle(
      { importProfile: vi.fn(async () => {}), randomId: () => 'must-not-create-twin' },
      first.vault
    )
    // The UI documents that retrying a preparation retains its original agent/name.
    await expect(next.lifecycle.create('New typed name', '', profileImport)).resolves.toEqual({
      principal: AGENT.principal,
      roomId: '!alfred:test',
      assistantId: AGENT.id
    })
    expect(next.deps.runtime).toHaveBeenCalledWith(expect.objectContaining({ name: 'Alfred' }))
    expect(next.deps.createOnPlatform).not.toHaveBeenCalled()
    expect(next.deps.room).not.toHaveBeenCalled()
  })

  it('runs every step in order and keeps no record once the agent answers in its room', async () => {
    const { lifecycle: agents, order, vault: shared, deps } = lifecycle()

    await expect(agents.create('Alfred', 'You are Alfred.')).resolves.toEqual({
      principal: AGENT.principal,
      roomId: '!alfred:test',
      assistantId: AGENT.id
    })
    expect(order).toEqual(['create:request-1', 'runtime', 'define', 'room', 'setUp', 'connect', 'started'])
    expect(deps.createOnPlatform).toHaveBeenCalledWith({ requestId: 'request-1', displayName: 'Alfred' })
    expect(deps.connect).toHaveBeenCalledWith(AGENT.principal, '!alfred:test')
    expect(shared.map.has(MATRIX_AGENT_CREATIONS)).toBe(false)
  })

  it.each(['placed', 'pending_trust'] as const)(
    'keeps the persona write but leaves the room, executor, connect and import to the cloud when %s',
    async cloudPlacement => {
      const { lifecycle: agents, order, vault: shared, deps } = lifecycle({
        createOnPlatform: async (input: { requestId: string }) => {
          order.push(`create:${input.requestId}`)

          return { ...AGENT, cloudPlacement }
        }
      })

      await expect(agents.create('Alfred', 'You are Alfred.')).resolves.toEqual({
        principal: AGENT.principal,
        assistantId: AGENT.id
      })
      expect(order).toEqual(['create:request-1', 'runtime', 'placed', 'define'])
      expect(deps.room).not.toHaveBeenCalled()
      expect(deps.setUp).not.toHaveBeenCalled()
      expect(deps.connect).not.toHaveBeenCalled()
      expect(deps.started).not.toHaveBeenCalled()
      // The cloud owns the room: there is none to open here.
      expect(shared.map.has(MATRIX_AGENT_CREATIONS)).toBe(false)
      expect(agents.creating()).toEqual(new Set())
    }
  )

  it('never installs a local profile for an agent the platform placed', async () => {
    const importProfile = vi.fn(async () => {})
    const { lifecycle: agents, deps } = lifecycle({
      createOnPlatform: async () => ({ ...AGENT, cloudPlacement: 'placed' }),
      importProfile
    })

    await agents.create('Alfred', '', { prepared: '/private/prepared', sha256: 'a'.repeat(64) })
    expect(importProfile).not.toHaveBeenCalled()
    expect(deps.setUp).not.toHaveBeenCalled()
    expect(deps.connect).not.toHaveBeenCalled()
  })

  it.each(['capacity', 'no_access', 'consent_mismatch'] as const)(
    'makes a %s agent Mac-run, exactly as today',
    async cloudPlacement => {
      const { lifecycle: agents, order, deps } = lifecycle({
        createOnPlatform: async (input: { requestId: string }) => {
          order.push(`create:${input.requestId}`)

          return { ...AGENT, cloudPlacement }
        }
      })

      await expect(agents.create('Alfred', '')).resolves.toEqual({
        principal: AGENT.principal,
        roomId: '!alfred:test',
        assistantId: AGENT.id
      })
      expect(order).toEqual(['create:request-1', 'runtime', 'define', 'room', 'setUp', 'connect', 'started'])
      expect(deps.placed).not.toHaveBeenCalled()
      expect(deps.setUp).toHaveBeenCalledWith(AGENT.principal)
    }
  )

  it('keeps a placement across a failed persona write and resumes into the cloud, never the room', async () => {
    const first = lifecycle({
      createOnPlatform: async () => ({ ...AGENT, cloudPlacement: 'pending_trust' }),
      define: async () => Promise.reject(new Error('offline'))
    })
    await expect(first.lifecycle.create('Alfred', '')).rejects.toThrow('offline')
    expect(saved(first.vault)).toEqual([
      expect.objectContaining({ step: 'define', cloudPlacement: 'pending_trust', principal: AGENT.principal })
    ])

    const next = lifecycle({}, first.vault)
    next.lifecycle.resume()
    await vi.waitFor(() => expect(next.deps.placed).toHaveBeenCalledWith(expect.objectContaining({ principal: AGENT.principal })))
    await vi.waitFor(() => expect(first.vault.map.has(MATRIX_AGENT_CREATIONS)).toBe(false))
    expect(next.deps.createOnPlatform).not.toHaveBeenCalled()
    expect(next.deps.room).not.toHaveBeenCalled()
    expect(next.deps.setUp).not.toHaveBeenCalled()
    expect(next.deps.connect).not.toHaveBeenCalled()
    expect(next.deps.started).not.toHaveBeenCalled()
  })

  it('keeps an unknown placement (an older Shell) on today’s full Mac-run flow', async () => {
    const { lifecycle: agents, order, deps } = lifecycle()

    await agents.create('Alfred', '')
    expect(order).toEqual(['create:request-1', 'runtime', 'define', 'room', 'setUp', 'connect', 'started'])
    expect(deps.placed).not.toHaveBeenCalled()
  })

  it.each([
    ['define', { define: async () => Promise.reject(new Error('offline')) }],
    ['room', { room: async () => Promise.reject(new Error('offline')) }],
    ['enroll', { setUp: async () => false }],
    ['connect', { connect: async () => Promise.reject(new Error('matrix_not_ready')) }]
  ] as const)(
    'stops at %s, resumes from there at the next launch, and never makes a second agent',
    async (step, failing) => {
      const first = lifecycle(failing)
      await expect(first.lifecycle.create('Alfred', 'You are Alfred.')).rejects.toThrow()
      expect(saved(first.vault)).toEqual([
        expect.objectContaining({ requestId: 'request-1', step, principal: AGENT.principal, assistantId: AGENT.id })
      ])

      // The next launch, same vault.
      const next = lifecycle({}, first.vault)
      next.lifecycle.resume()
      await vi.waitFor(() => expect(next.deps.started).toHaveBeenCalledWith(AGENT.principal))
      expect(next.deps.createOnPlatform).not.toHaveBeenCalled()
      expect(next.order[0]).toBe('runtime')
      expect(next.deps.setUp).toHaveBeenCalledWith(AGENT.principal)
      expect(next.order.indexOf('setUp')).toBeLessThan(next.order.indexOf('connect'))
      expect(first.vault.map.has(MATRIX_AGENT_CREATIONS)).toBe(false)
    }
  )

  it('keeps a connect checkpoint when the replacement process cannot restore its SDK host', async () => {
    const first = lifecycle({ connect: async () => Promise.reject(new Error('offline')) })
    await expect(first.lifecycle.create('Alfred', '')).rejects.toThrow('offline')
    const next = lifecycle({ setUp: async () => false }, first.vault)
    next.lifecycle.resume()
    await vi.waitFor(() =>
      expect(next.deps.log).toHaveBeenCalledWith('[Matrix] agent creation still pending at connect')
    )
    expect(next.deps.connect).not.toHaveBeenCalled()
    expect(next.deps.started).not.toHaveBeenCalled()
    expect(saved(first.vault)).toEqual([expect.objectContaining({ step: 'connect', principal: AGENT.principal })])
  })

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

  it('repeats the platform create with the same request ID when it did not answer', async () => {
    const first = lifecycle({ createOnPlatform: async () => Promise.reject(new Error('timeout')) })
    await expect(first.lifecycle.create('Alfred', '')).rejects.toThrow('timeout')
    expect(saved(first.vault)).toEqual([{ requestId: 'request-1', name: 'Alfred', persona: '', step: 'create' }])

    const next = lifecycle({ randomId: () => 'never-used' }, first.vault)
    next.lifecycle.resume()
    await vi.waitFor(() => expect(next.deps.started).toHaveBeenCalled())
    expect(next.deps.createOnPlatform).toHaveBeenCalledOnce()
    expect(next.deps.createOnPlatform).toHaveBeenCalledWith({ requestId: 'request-1', displayName: 'Alfred' })
  })

  it('runs each creation once at a time, and names the agent as being created until it answers', async () => {
    let connected!: () => void
    const connect = vi.fn(() => new Promise<void>(resolve => (connected = resolve)))
    const { lifecycle: agents, deps } = lifecycle({ connect })

    const pending = agents.create('Alfred', '')
    await vi.waitFor(() => expect(connect).toHaveBeenCalled())
    expect(agents.creating()).toEqual(new Set([AGENT.principal]))

    // A resume while it runs joins the same run.
    agents.resume()
    connected()
    await expect(pending).resolves.toEqual({
      principal: AGENT.principal,
      roomId: '!alfred:test',
      assistantId: AGENT.id
    })
    expect(deps.createOnPlatform).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()
    expect(agents.creating()).toEqual(new Set())
  })

  it('refuses a record that lost its agent rather than guessing', async () => {
    const shared = vault()
    shared.map.set(MATRIX_AGENT_CREATIONS, JSON.stringify([{ requestId: 'r', name: 'A', persona: '', step: 'room' }]))
    const { lifecycle: agents, deps } = lifecycle({}, shared)
    agents.resume()
    await vi.waitFor(() => expect(deps.log).toHaveBeenCalledWith('[Matrix] agent creation still pending at room'))
    expect(deps.room).not.toHaveBeenCalled()
  })
})

describe('retiring another agent', () => {
  it('drops a creation of the same agent, which never resumes', async () => {
    const first = lifecycle({ setUp: async () => false })
    await expect(first.lifecycle.create('Alfred', '')).rejects.toThrow()
    expect(saved(first.vault)).toHaveLength(1)

    await first.lifecycle.retire(AGENT.principal, AGENT.id)
    expect(first.vault.map.has(MATRIX_AGENT_CREATIONS)).toBe(false)

    const next = lifecycle({}, first.vault)
    next.lifecycle.resume()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(next.deps.setUp).not.toHaveBeenCalled()
  })

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

  it('is Atum when its definition carries no persona, and says it can work on this Mac', async () => {
    const target = home()
    await seedMatrixAgentSoul(target, async () => undefined, MATRIX_PRIMARY_SOUL_FALLBACK)

    expect(soulOf(target)).toBe(`${ATUM_ASSISTANT_SOUL}\n`)
    expect(soulOf(target)).toMatch(/^You are Atum/)
    expect(soulOf(target)).toMatch(/Mac/)
    expect(soulOf(target)).not.toMatch(/Hermes|Nous/)
    expect(statSync(join(target, 'SOUL.md')).mode & 0o777).toBe(0o600)
  })

  it('keeps a persona its definition declares', async () => {
    const target = home()
    await seedMatrixAgentSoul(target, async () => 'You are Lan, a calm planner.', MATRIX_PRIMARY_SOUL_FALLBACK)

    expect(soulOf(target)).toBe('You are Lan, a calm planner.\n')
  })

  it("replaces Hermes's untouched default, never an edited one", async () => {
    const seeded = home()
    mkdirSync(seeded, { recursive: true })
    writeFileSync(join(seeded, 'SOUL.md'), hermesDefault)
    await seedMatrixAgentSoul(seeded, async () => undefined, MATRIX_PRIMARY_SOUL_FALLBACK)
    expect(soulOf(seeded)).toBe(`${ATUM_ASSISTANT_SOUL}\n`)

    const edited = home()
    mkdirSync(edited, { recursive: true })
    writeFileSync(join(edited, 'SOUL.md'), `${hermesDefault}\nAlways answer in French.`)
    const soul = vi.fn(async () => undefined)
    await seedMatrixAgentSoul(edited, soul, MATRIX_PRIMARY_SOUL_FALLBACK)
    expect(soulOf(edited)).toBe(`${hermesDefault}\nAlways answer in French.`)
    expect(soul).not.toHaveBeenCalled()
  })

  it("keeps Hermes's default while the definition cannot be read, so the assistant still starts", async () => {
    const target = home()
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SOUL.md'), `${hermesDefault}\r\n`)

    await expect(
      seedMatrixAgentSoul(target, async () => Promise.reject(new Error('offline')), MATRIX_PRIMARY_SOUL_FALLBACK)
    ).resolves.toBeUndefined()
    expect(soulOf(target)).toBe(`${hermesDefault}\r\n`)
  })

  it('never gives another agent the primary persona', async () => {
    const other = home()
    await seedMatrixAgentSoul(other, async () => undefined)

    expect(existsSync(join(other, 'SOUL.md'))).toBe(false)
  })
})
