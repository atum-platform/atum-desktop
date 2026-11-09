import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AtumSkillBundle } from '../../../shared/atum-agent-content'
import type { AtumPortableSkillRef } from '../../../shared/atum-agent-portability'
import { MatrixAgentDefinitionError, type MatrixAgentDefinitionSnapshot } from '../agent-definition'
import { matrixHermesHome } from '../hermes-runtime'

import { MatrixAgentContentHelperError } from './helper'

import {
  describeMatrixAgentContent,
  MatrixAgentContent,
  type MatrixAgentContentTarget,
  matrixAgentContentTarget,
  matrixAgentPersona
} from './index'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const OTHER = '00000000-0000-4000-8000-b454f82c5857'
const ASSISTANT = '00000000-0000-4000-8000-f6222a1106ee'
const hash = (n: number) => n.toString(16).padStart(64, '0')
const ref = (n: number): AtumPortableSkillRef => ({ name: `private/secret-skill-${n}`, sha256: hash(n) })
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

function snapshot(skills: AtumPortableSkillRef[], soul = 'Be brief.'): MatrixAgentDefinitionSnapshot {
  return {
    assistant: {
      id: ASSISTANT,
      identityId: ASSISTANT,
      principal: AGENT,
      displayName: 'Main',
      avatar: '',
      avatarUrl: null,
      isDefault: false,
      lifecycleRevision: 1,
      status: 'active',
      identityRevision: 1,
      definitionRevision: 7
    },
    definition: { schemaVersion: 1, soul, modelAlias: 'binh-minh', reasoning: null, skills },
    definitionRevision: 7,
    identityRevision: 1
  }
}

/** A fake home helper: reports the given states and installs whatever bundle arrives. */
function helper(states: Record<string, string> = {}) {
  return vi.fn(
    async (
      _runtime,
      _home,
      operation: string,
      request: { skills: AtumPortableSkillRef[]; bundles?: AtumSkillBundle[] },
      _signal?: AbortSignal
    ) => ({
      ok: true,
      receipt: 'ok',
      skills: request.skills.map(skill => {
        const installed = operation === 'skills-install' && request.bundles?.some(each => each.sha256 === skill.sha256)

        return installed
          ? { ...skill, state: 'installed', detail: 'new' }
          : {
              ...skill,
              state: states[skill.name] ?? 'missing',
              ...(states[skill.name] === 'different' ? { detail: 'local_edit' } : {})
            }
      })
    })
  )
}

function target(
  skills: AtumPortableSkillRef[],
  overrides: Partial<MatrixAgentContentTarget> = {}
): MatrixAgentContentTarget {
  const home = mkdtempSync(path.join(tmpdir(), 'atum-agent-content-'))
  homes.push(home)
  writeFileSync(path.join(home, 'SOUL.md'), 'Be brief.\n')

  return {
    principal: AGENT,
    assistantId: ASSISTANT,
    home,
    runtime: { python: '/unused/python', source: '/unused/source', profiles: '/unused/profiles' },
    live: () => true,
    definition: async () => snapshot(skills),
    skill: async sha256 => ({ schema_version: 1, sha256, files: [] }),
    ...overrides
  }
}

describe("an agent's content on this Mac", () => {
  it('reports complete only when every declared skill is here with its bytes', async () => {
    const log = vi.fn()

    const content = new MatrixAgentContent({
      log,
      helper: helper({ 'private/secret-skill-1': 'bundled' }),
      now: () => 42
    })

    await content.sync(target([ref(1), ref(2)]))

    expect(content.status(AGENT)).toEqual({
      principal: AGENT,
      assistantId: ASSISTANT,
      state: 'complete',
      definitionRevision: 7,
      persona: 'matches',
      skills: { declared: 2, installedNow: 1, receiptReset: false, bundled: 1, installed: 1 },
      checkedAt: 42
    })
    expect(log).toHaveBeenCalledWith(
      '[Matrix] agent 00000000 content r7: 2 skills (1 installed (1 new), 1 shipped); persona matches: complete'
    )
    // Diagnostics carry counts and closed words only.
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-skill')
  })

  it('reports what differs here, and what could not come, instead of claiming parity', async () => {
    const differs = new MatrixAgentContent({ log: vi.fn(), helper: helper({ 'private/secret-skill-1': 'different' }) })
    await differs.sync(target([ref(1)]))
    expect(differs.status(AGENT)?.state).toBe('differs')

    const failed = new MatrixAgentContent({ log: vi.fn(), helper: helper() })

    await failed.sync(
      target([ref(1), ref(2)], {
        skill: async sha256 => {
          if (sha256 === hash(2)) {
            throw new MatrixAgentDefinitionError('unavailable')
          }

          return { schema_version: 1, sha256, files: [] }
        }
      })
    )
    expect(failed.status(AGENT)).toMatchObject({ state: 'incomplete', skills: { installed: 1, unavailable: 1 } })
  })

  it('keeps the last counts when a check cannot finish, with a closed reason', async () => {
    const log = vi.fn()
    const fake = helper()
    const content = new MatrixAgentContent({ log, helper: fake })
    const agent = target([ref(1)])
    await content.sync(agent)

    fake.mockRejectedValueOnce(new MatrixAgentContentHelperError('agent_content_busy'))
    await content.sync(agent)
    expect(content.status(AGENT)).toMatchObject({ state: 'error', error: 'busy', skills: { installed: 1 } })

    await content.sync({ ...agent, definition: async () => Promise.reject(new MatrixAgentDefinitionError('denied')) })
    expect(content.status(AGENT)).toMatchObject({ state: 'error', error: 'denied' })
    expect(log).toHaveBeenLastCalledWith('[Matrix] agent 00000000 content not checked: denied')
  })

  it('never brings back a retired agent, and stops its downloads', async () => {
    const content = new MatrixAgentContent({ log: vi.fn(), helper: helper() })

    let release: () => void = () => {}
    let seen: AbortSignal | undefined

    const running = content.sync(
      target([ref(1)], {
        skill: (sha256, signal) => {
          seen = signal

          return new Promise(resolve => {
            release = () => resolve({ schema_version: 1, sha256, files: [] })
          })
        }
      })
    )

    await vi.waitFor(() => expect(seen).toBeDefined())
    content.forget(AGENT)
    expect(seen?.aborted).toBe(true)
    release()
    await running
    expect(content.status(AGENT)).toBeUndefined()
    expect(content.statuses()).toEqual([])
  })

  it.each(['skills-check', 'skills-install'])(
    'retiring while the home is %s stops the helper and leaves no status',
    async operation => {
      let helperSignal: AbortSignal | undefined

      let answer: (value: unknown) => void = () => {}
      const fake = helper()

      const content = new MatrixAgentContent({
        log: vi.fn(),
        helper: vi.fn(async (runtime, home, current, request, signal) => {
          if (current !== operation) {
            return fake(runtime, home, current, request, signal)
          }

          helperSignal = signal

          return new Promise(resolve => {
            answer = resolve
          })
        })
      })

      const running = content.sync(target([ref(1)]))
      await vi.waitFor(() => expect(helperSignal).toBeDefined())
      content.forget(AGENT)
      // The transport kills the helper on this abort (helper.test.ts).
      expect(helperSignal?.aborted).toBe(true)
      answer({ ok: true, receipt: 'ok', skills: [{ ...ref(1), state: 'installed', detail: 'new' }] })
      await running
      expect(content.status(AGENT)).toBeUndefined()
    }
  )

  it('prunes agents that left the roster and clears everything at sign-out', async () => {
    const content = new MatrixAgentContent({ log: vi.fn(), helper: helper() })
    await content.sync(target([ref(1)]))
    await content.sync(target([ref(1)], { principal: OTHER }))

    content.retain([OTHER])
    expect(content.statuses().map(status => status.principal)).toEqual([OTHER])
    content.clear()
    expect(content.statuses()).toEqual([])
  })

  it('says it is writing the agent’s home while a sync runs, and not before, after, or for another agent', async () => {
    let finish!: () => void

    const gate = new Promise<void>(resolve => {
      finish = resolve
    })

    const inner = helper()

    const slow: typeof inner = vi.fn(async (...args: Parameters<typeof inner>) => {
      await gate

      return inner(...args)
    })

    const content = new MatrixAgentContent({ log: vi.fn(), helper: slow })

    expect(content.writing(AGENT)).toBe(false)

    const done = content.sync(target([ref(1)]))

    expect(content.writing(AGENT)).toBe(true)
    expect(content.writing(OTHER)).toBe(false)
    finish()
    await done
    expect(content.writing(AGENT)).toBe(false)
  })

  it('joins a sync already running for the same agent', async () => {
    const fake = helper()
    const content = new MatrixAgentContent({ log: vi.fn(), helper: fake })
    const agent = target([ref(1)])

    await Promise.all([content.sync(agent), content.sync(agent)])
    expect(fake.mock.calls.filter(([, , operation]) => operation === 'skills-check')).toHaveLength(1)
  })

  it('projects only closed metadata for the exact current home, with detached counts', async () => {
    const content = new MatrixAgentContent({ log: vi.fn(), helper: helper(), now: () => 42 })
    const agent = target([ref(1)])
    await content.sync(agent)
    const view = content.view(agent)!
    expect(view).toEqual({
      state: 'complete',
      definitionRevision: 7,
      persona: 'matches',
      skills: { declared: 1, installedNow: 1, receiptReset: false, installed: 1 },
      checkedAt: 42
    })
    expect(content.view(undefined)).toBeUndefined()
    expect(content.view({ ...agent, home: `${agent.home}-changed` })).toBeUndefined()
    expect(content.view({ ...agent, assistantId: 'another-assistant' })).toBeUndefined()
    expect(content.view({ ...agent, runtime: { ...agent.runtime, source: '/another/source' } })).toBeUndefined()
    expect(JSON.stringify(view)).not.toMatch(/secret-skill|sha256|\/unused\/|principal|assistantId|SOUL/)
    view.skills!.declared = 99
    expect(content.view(agent)?.skills?.declared).toBe(1)
  })

  it('never carries completed counts into a new home for the same agent', async () => {
    const content = new MatrixAgentContent({ log: vi.fn(), helper: helper(), now: () => 42 })
    const old = target([ref(1)])
    await content.sync(old)

    let answer: (value: MatrixAgentDefinitionSnapshot) => void = () => {}

    const next = target([], {
      definition: () =>
        new Promise(resolve => {
          answer = resolve
        })
    })

    const running = content.sync(next)

    expect(content.view(old)).toBeUndefined()
    expect(content.view(next)).toEqual({ state: 'checking' })
    answer(snapshot([]))
    await running
    expect(content.view(next)).toMatchObject({ state: 'complete', skills: { declared: 0, installedNow: 0 } })
  })

  it('aborts an old home and publishes only its successor when a late response arrives', async () => {
    const changed = vi.fn()
    const content = new MatrixAgentContent({ log: vi.fn(), helper: helper(), changed })

    let answer: (value: MatrixAgentDefinitionSnapshot) => void = () => {}
    let oldSignal: AbortSignal | undefined

    const old = target([ref(1)], {
      definition: signal => {
        oldSignal = signal

        return new Promise(resolve => {
          answer = resolve
        })
      }
    })

    const previous = content.sync(old)
    const next = target([])
    await content.sync(next)
    expect(oldSignal!.aborted).toBe(true)
    const published = changed.mock.calls.length
    answer(snapshot([ref(1)]))
    await previous
    expect(changed).toHaveBeenCalledTimes(published)
    expect(content.view(old)).toBeUndefined()
    expect(content.view(next)?.skills?.declared).toBe(0)
  })

  it('hides stale account status and refuses to start an already stopped binding', async () => {
    const content = new MatrixAgentContent({ log: vi.fn(), helper: helper() })
    let live = true
    const agent = target([ref(1)], { live: () => live })
    await content.sync(agent)
    live = false
    expect(content.status(AGENT)).toBeUndefined()
    expect(content.view(agent)).toBeUndefined()
    expect(content.statuses()).toEqual([])
    const definition = vi.fn(agent.definition)
    await content.sync({ ...agent, definition })
    expect(definition).not.toHaveBeenCalled()
  })

  it('a dead generation cannot join a same-home successor or bring back its counts', async () => {
    const content = new MatrixAgentContent({ log: vi.fn(), helper: helper() })
    let live = true

    let answer: (value: MatrixAgentDefinitionSnapshot) => void = () => {}

    const old = target([ref(1)], {
      live: () => live,
      definition: () =>
        new Promise(resolve => {
          answer = resolve
        })
    })

    const previous = content.sync(old)
    live = false
    const next = { ...old, live: () => true, definition: async () => snapshot([]) }
    await content.sync(next)
    answer(snapshot([ref(1)]))
    await previous
    expect(content.view(next)).toMatchObject({ state: 'complete', skills: { declared: 0 } })
  })

  it('publishes checking and completion through the existing callback, then removes the view on sign-out', async () => {
    const views: unknown[] = []
    const agent = target([])

    const content = new MatrixAgentContent({
      log: vi.fn(),
      changed: () => views.push(content.view(agent)),
      now: () => 42
    })

    await content.sync(agent)
    content.clear()
    expect(views).toEqual([
      { state: 'checking' },
      {
        state: 'complete',
        definitionRevision: 7,
        persona: 'matches',
        skills: { declared: 0, installedNow: 0, receiptReset: false },
        checkedAt: 42
      },
      undefined
    ])
  })

  it('checks nothing it was not declared, and still compares the persona', async () => {
    const fake = helper()
    const content = new MatrixAgentContent({ log: vi.fn(), helper: fake })
    const agent = target([], { definition: async () => snapshot([], 'Another persona.') })

    await content.sync(agent)
    expect(fake).not.toHaveBeenCalled()
    expect(content.status(AGENT)).toMatchObject({ state: 'differs', persona: 'differs', skills: { declared: 0 } })
  })
})

describe('the persona here', () => {
  it('compares the trimmed persona, as it is seeded', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'atum-agent-persona-'))
    homes.push(home)

    expect(matrixAgentPersona(home, '  ')).toBe('none')
    expect(matrixAgentPersona(home, 'Be brief.')).toBe('absent')
    writeFileSync(path.join(home, 'SOUL.md'), 'Be brief.\n')
    expect(matrixAgentPersona(home, '\nBe brief.  ')).toBe('matches')
    expect(matrixAgentPersona(home, 'Be long.')).toBe('differs')
  })

  it('describes a check still running without counts', () => {
    expect(describeMatrixAgentContent(AGENT, undefined)).toBe(
      '[Matrix] agent 00000000 content r0: 0 skills; persona none: checking'
    )
  })
})

describe('which agent main starts content for', () => {
  const runtime = { python: '/runtime/python', source: '/runtime/source', profiles: '/runtime/profiles' }
  const identity = { principal: 'owner-principal', executorId: 'executor-1' }

  const source = (overrides: Record<string, unknown> = {}) => ({
    isDefault: false,
    principal: AGENT,
    assistantId: ASSISTANT,
    identity,
    runtime,
    live: () => true,
    definition: vi.fn(async (_assistantId: string, _signal: AbortSignal) => snapshot([])),
    skill: vi.fn(async (_assistantId: string, sha256: string, _signal: AbortSignal) => ({
      schema_version: 1 as const,
      sha256,
      files: []
    })),
    ...overrides
  })

  it('leaves out any agent without its definition or enrolled home', () => {
    for (const missing of ['principal', 'assistantId', 'identity', 'runtime']) {
      expect(matrixAgentContentTarget(source({ [missing]: undefined }))).toBeUndefined()
    }
  })

  it('keeps the same enrolled content home when the platform default role changes', () => {
    const named = matrixAgentContentTarget(source())!
    const promoted = matrixAgentContentTarget(source({ isDefault: true }))!
    expect(promoted.principal).toBe(named.principal)
    expect(promoted.home).toBe(named.home)
    expect(promoted.assistantId).toBe(named.assistantId)
  })

  it("targets the agent's own Hermes home and its own definition", async () => {
    const input = source()
    const agent = matrixAgentContentTarget(input)!
    const signal = new AbortController().signal

    expect(agent.home).toBe(matrixHermesHome(runtime, identity.principal, identity.executorId))
    await agent.definition(signal)
    await agent.skill('a'.repeat(64), signal)
    expect(input.definition).toHaveBeenCalledWith(ASSISTANT, signal)
    expect(input.skill).toHaveBeenCalledWith(ASSISTANT, 'a'.repeat(64), signal)
  })

  it('never waits: a start returns before any of the work, and does nothing without a target', () => {
    const content = new MatrixAgentContent({ log: vi.fn(), helper: helper() })
    const never = vi.fn(() => new Promise<MatrixAgentDefinitionSnapshot>(() => {}))

    expect(content.start(target([ref(1)], { definition: never }))).toBeUndefined()
    expect(never).toHaveBeenCalledTimes(1)
    expect(content.status(AGENT)?.state).toBe('checking')
    content.start(undefined)
    expect(content.statuses()).toHaveLength(1)
    content.clear()
  })
})
