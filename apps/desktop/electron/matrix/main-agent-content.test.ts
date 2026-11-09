import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixEnrollment, MatrixEnrollmentIdentity } from '../../shared/matrix'
import { EncryptedStore } from '../encrypted-store'

import { MatrixAccount } from './account'
import { MatrixAgentContent } from './agent-content'
import type { MatrixAgentDefinitionSnapshot } from './agent-definition'
import { matrixRuntimeHome, reconcileMatrixAgentHome } from './agent-home'
import { MatrixAgentRuntime } from './agent-runtime'
import { matrixConfigurationKey } from './config'
import { matrixHermesHome, type MatrixHermesRuntimeConfig } from './hermes-runtime'
import { type MatrixMainAgentContentSource, matrixMainAgentContentTarget } from './main-agent-content'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const ASSISTANT = '00000000-0000-4000-8000-b454f82c5857'
const OWNER = '00000000-0000-4000-8000-f6222a1106ee'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }

  vi.restoreAllMocks()
})

function directory() {
  const value = mkdtempSync(path.join(tmpdir(), 'matrix-main-content-'))
  directories.push(value)

  return value
}

function snapshot(): MatrixAgentDefinitionSnapshot {
  return {
    assistant: {
      id: ASSISTANT,
      identityId: ASSISTANT,
      principal: AGENT,
      displayName: 'Test agent',
      avatar: '',
      avatarUrl: null,
      isDefault: false,
      lifecycleRevision: 1,
      status: 'active',
      identityRevision: 1,
      definitionRevision: 1
    },
    definition: { schemaVersion: 1, soul: 'Test persona.', modelAlias: 'binh-minh', reasoning: null, skills: [] },
    definitionRevision: 1,
    identityRevision: 1
  }
}

function fixture(custody: 'named' | 'root' = 'named') {
  const agent = custody === 'root' ? new MatrixAgentRuntime('agent') : new MatrixAgentRuntime(`agent:${AGENT}`, AGENT)
  agent.agentPrincipal = AGENT
  agent.assistantId = ASSISTANT
  const defaultAgent = custody === 'root' ? agent : new MatrixAgentRuntime('agent')
  const agents = new Map(custody === 'root' ? [] : [[AGENT, agent]])

  const identity: MatrixEnrollmentIdentity = {
    issuer: 'https://id.test/',
    subject: 'owner',
    principal: OWNER,
    agentPrincipal: AGENT,
    executorId: '00000000-0000-4000-8000-f1d11edf5c5c',
    userId: '@test_agent:test',
    deviceId: 'TEST_AGENT',
    expiresAt: Date.now() + 60_000
  }

  const world = {
    scope: { accountKey: 'account-a', generation: 1 } as { accountKey: string; generation: number } | null,
    runtime: { python: '/unused/python', source: '/unused/source', profiles: directory() } as
      | MatrixHermesRuntimeConfig
      | undefined,
    enrollment: { state: 'ready', identity } as MatrixEnrollment,
    closing: false
  }

  const account = {
    appScope: () => world.scope && { ...world.scope },
    agentDefinition: vi.fn<MatrixAccount['agentDefinition']>().mockResolvedValue(snapshot()),
    agentSkill: vi.fn<MatrixAccount['agentSkill']>().mockImplementation(async (_id, sha256) => ({
      schema_version: 1,
      sha256,
      files: []
    }))
  }

  const source: MatrixMainAgentContentSource = {
    defaultAgent,
    agents,
    account: () => account,
    runtime: () => world.runtime,
    closing: () => world.closing,
    enrollment: vi.fn(() => world.enrollment)
  }

  return { agent, agents, identity, world, account, source, target: () => matrixMainAgentContentTarget(source, agent) }
}

const changedBindings: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    'runtime principal',
    f => {
      f.agent.agentPrincipal = '00000000-0000-4000-8000-fbfe405ca65f'
    }
  ],
  [
    'account key',
    f => {
      f.world.scope = { ...f.world.scope!, accountKey: 'account-b' }
    }
  ],
  [
    'generation',
    f => {
      f.world.scope = { ...f.world.scope!, generation: 2 }
    }
  ],
  [
    'domain disappearance',
    f => {
      f.world.scope = null
    }
  ],
  [
    'runtime replacement',
    f => {
      f.world.runtime = { ...f.world.runtime! }
    }
  ],
  [
    'runtime disappearance',
    f => {
      f.world.runtime = undefined
    }
  ],
  [
    'assistant definition',
    f => {
      f.agent.assistantId = '00000000-0000-4000-8000-fbfe405ca65f'
    }
  ],
  [
    'retirement',
    f => {
      f.agent.closed = true
    }
  ],
  [
    'quit',
    f => {
      f.world.closing = true
    }
  ],
  [
    'roster removal',
    f => {
      f.agents.delete(AGENT)
    }
  ],
  [
    'roster replacement',
    f => {
      f.agents.set(AGENT, new MatrixAgentRuntime(`agent:${AGENT}`, AGENT))
    }
  ],
  [
    'enrollment disappearance',
    f => {
      f.world.enrollment = { state: 'absent', identity: null }
    }
  ],
  [
    'withdrawal',
    f => {
      f.world.enrollment = { state: 'withdrawn', identity: null }
    }
  ],
  ...(['agentPrincipal', 'executorId', 'principal', 'userId', 'deviceId'] as const).map(
    field =>
      [
        `enrolled ${field}`,
        (f: ReturnType<typeof fixture>) => {
          f.world.enrollment = { state: 'ready', identity: { ...f.identity, [field]: 'changed' } }
        }
      ] as [string, (f: ReturnType<typeof fixture>) => void]
  )
]

describe('the production main content binding', () => {
  it('uses the enrolled home and binds definition/skill reads to the assistant and caller signal', async () => {
    const f = fixture()
    const target = f.target()!
    const signal = new AbortController().signal
    const sha256 = 'a'.repeat(64)

    expect(target.home).toBe(matrixHermesHome(f.world.runtime!, OWNER, f.identity.executorId))
    expect(target.live()).toBe(true)
    await target.definition(signal)
    await target.skill(sha256, signal)
    expect(f.account.agentDefinition).toHaveBeenCalledExactlyOnceWith(ASSISTANT, signal)
    expect(f.account.agentSkill).toHaveBeenCalledExactlyOnceWith(ASSISTANT, sha256, signal)
  })

  it('binds portable memory to the same assistant and keeps the Google-local gate dynamic', async () => {
    const f = fixture()
    const snapshot = { memory: [], user: [] }
    const agentMemory = vi.fn(async () => ({ assistantId: ASSISTANT, revision: 1, enabled: true, snapshot }))
    const writeAgentMemory = vi.fn(async () => ({ assistantId: ASSISTANT, revision: 2, enabled: true, snapshot }))
    Object.assign(f.account, { agentMemory, writeAgentMemory })
    let allowed = true
    f.source.memoryAllowed = () => allowed
    const target = f.target()!
    const signal = new AbortController().signal

    expect(target.memoryAllowed?.()).toBe(true)
    await target.memory!(signal)
    await target.writeMemory!({ expected_revision: 1, enabled: true, snapshot }, signal)
    expect(agentMemory).toHaveBeenCalledExactlyOnceWith(ASSISTANT, signal)
    expect(writeAgentMemory).toHaveBeenCalledExactlyOnceWith(
      ASSISTANT,
      { expected_revision: 1, enabled: true, snapshot },
      signal,
      expect.any(Function)
    )
    allowed = false
    expect(target.memoryAllowed?.()).toBe(false)
    const permitted = (writeAgentMemory.mock.calls[0] as unknown as [unknown, unknown, unknown, () => boolean])[3]
    expect(permitted()).toBe(false)
  })

  it('promoting named Main keeps its enrolled home and imported content untouched', async () => {
    const f = fixture()
    const target = f.target()!
    const promoted = snapshot()
    promoted.assistant.isDefault = true
    promoted.assistant.displayName = 'Main'
    f.account.agentDefinition.mockResolvedValue(promoted)
    mkdirSync(path.join(target.home, 'skills', 'imported'), { recursive: true })
    writeFileSync(path.join(target.home, 'SOUL.md'), 'Imported Main persona.\n')
    writeFileSync(path.join(target.home, 'config.yaml'), 'model: imported-model\n')
    writeFileSync(path.join(target.home, 'skills', 'imported', 'SKILL.md'), 'Imported tool instructions.\n')
    const content = new MatrixAgentContent({ log: vi.fn() })

    await content.sync(target)

    expect(f.target()?.home).toBe(target.home)
    expect(content.view(f.target())).toMatchObject({ state: 'differs', persona: 'differs' })
    expect(readFileSync(path.join(target.home, 'SOUL.md'), 'utf8')).toBe('Imported Main persona.\n')
    expect(readFileSync(path.join(target.home, 'config.yaml'), 'utf8')).toBe('model: imported-model\n')
    expect(readFileSync(path.join(target.home, 'skills', 'imported', 'SKILL.md'), 'utf8')).toBe(
      'Imported tool instructions.\n'
    )
  })

  it("brings both named and root custody into the agent's bound home after a new executor", () => {
    const home: NonNullable<MatrixMainAgentContentSource['home']> = (agent, identity, runtime) =>
      matrixRuntimeHome({
        profiles: runtime.profiles,
        owner: identity.principal,
        agent: agent.agentPrincipal,
        executorId: identity.executorId
      })

    for (const custody of ['named', 'root'] as const) {
      const f = fixture(custody)
      const profiles = f.world.runtime!.profiles
      const earlier = '00000000-0000-4000-8000-a9703d75e616'
      const first = matrixHermesHome({ profiles }, OWNER, earlier)
      mkdirSync(first, { recursive: true })
      // The agent's home was bound under its earlier executor; this one enrolled after a revocation.
      reconcileMatrixAgentHome({
        profiles,
        owner: OWNER,
        agent: AGENT,
        executorId: earlier,
        reserved: [],
        quiescent: true,
        log: () => {}
      })
      f.source.home = home

      expect(f.target()!.home).toBe(first)
    }
  })

  it('allows fresh-device root Main to check canonical content in its own enrolled home', async () => {
    const f = fixture('root')
    const target = f.target()!
    const canonical = snapshot()
    canonical.assistant.isDefault = true
    f.account.agentDefinition.mockResolvedValue(canonical)
    mkdirSync(target.home, { recursive: true })
    writeFileSync(path.join(target.home, 'SOUL.md'), 'Test persona.\n')
    const content = new MatrixAgentContent({ log: vi.fn() })

    await content.sync(target)

    expect(f.agent.principal).toBeUndefined()
    expect(target.principal).toBe(AGENT)
    expect(target.home).toBe(matrixHermesHome(f.world.runtime!, OWNER, f.identity.executorId))
    expect(target.live()).toBe(true)
    expect(content.view(f.target())).toMatchObject({ state: 'complete', persona: 'matches' })
    expect(f.account.agentDefinition).toHaveBeenCalledOnce()
  })

  it('fences the exact root custody object and ignores mutable default metadata', () => {
    const f = fixture('root')
    const target = f.target()!
    f.source.defaultAgent.name = 'Demoted former default'
    expect(target.live()).toBe(true)
    f.source.defaultAgent = new MatrixAgentRuntime('agent')
    expect(target.live()).toBe(false)
    expect(f.target()).toBeUndefined()
  })

  it.each(['named', 'root'] as const)(
    'refuses withdrawn %s custody without projecting cached authority',
    async custody => {
      const f = fixture(custody)
      const target = f.target()!
      mkdirSync(target.home, { recursive: true })
      writeFileSync(path.join(target.home, 'SOUL.md'), 'Test persona.\n')
      const content = new MatrixAgentContent({ log: vi.fn() })
      await content.sync(target)
      expect(content.view(f.target())).toMatchObject({ state: 'complete' })
      f.world.enrollment = { state: 'withdrawn', identity: null }

      expect(target.live()).toBe(false)
      expect(f.target()).toBeUndefined()
      expect(content.status(AGENT)).toBeUndefined()
      expect(content.view(f.target())).toBeUndefined()
      await content.sync(target)
      expect(f.account.agentDefinition).toHaveBeenCalledOnce()
    }
  )

  it.each(changedBindings)('never projects retained success after %s changes', async (_name, change) => {
    const f = fixture()
    const target = f.target()!
    mkdirSync(target.home, { recursive: true })
    writeFileSync(path.join(target.home, 'SOUL.md'), 'Test persona.\n')
    const content = new MatrixAgentContent({ log: vi.fn(), now: () => 42 })
    await content.sync(target)
    expect(content.view(f.target())).toMatchObject({ state: 'complete', checkedAt: 42 })

    change(f)

    expect(target.live()).toBe(false)
    expect(content.view(f.target())).toBeUndefined()
    expect(content.status(AGENT)).toBeUndefined()
  })

  it('keeps a binding live across credential renewal that preserves enrolled identity', () => {
    const f = fixture()
    const target = f.target()!
    f.world.enrollment = { state: 'ready', identity: { ...f.identity, expiresAt: Date.now() + 3_600_000 } }
    expect(target.live()).toBe(true)
  })

  it('does not read enrollment for unbound root, absent scope, missing runtime, retired agent or quit', () => {
    const f = fixture()
    expect(matrixMainAgentContentTarget(f.source, f.source.defaultAgent)).toBeUndefined()
    f.world.scope = null
    expect(f.target()).toBeUndefined()
    f.world.scope = { accountKey: 'account-a', generation: 1 }
    f.world.runtime = undefined
    expect(f.target()).toBeUndefined()
    f.agent.closed = true
    expect(f.target()).toBeUndefined()
    f.agent.closed = false
    f.world.closing = true
    expect(f.target()).toBeUndefined()
    expect(f.source.enrollment).not.toHaveBeenCalled()
  })

  it('returns no optional status if the account has not yet initialized', () => {
    const f = fixture()
    f.source.account = () => undefined
    expect(() => new MatrixAgentContent({ log: vi.fn() }).view(f.target())).not.toThrow()
    expect(f.target()).toBeUndefined()
    expect(f.source.enrollment).not.toHaveBeenCalled()
  })

  it('does not publish a late content result after the actual binding changes', async () => {
    const f = fixture()
    let finish!: (value: MatrixAgentDefinitionSnapshot) => void
    f.account.agentDefinition.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const changed = vi.fn()
    const content = new MatrixAgentContent({ log: vi.fn(), changed })
    const work = content.sync(f.target()!)
    expect(content.view(f.target())).toMatchObject({ state: 'checking' })
    f.world.scope = { accountKey: 'account-b', generation: 2 }
    finish(snapshot())
    await work
    expect(content.view(f.target())).toBeUndefined()
    expect(content.status(AGENT)).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(1) // Initial checking only, not late success.
  })
})

describe('real account refusal before optional content publication', () => {
  it.each(['absent', 'without-domain', 'signing-out', 'invalid-domain', 'unreadable-vault'])(
    'does not enter a throwing enrollment read for %s custody',
    mode => {
      const config = {
        issuer: 'https://id.test/',
        server: 'https://matrix.test',
        nativeClientId: 'matrix',
        callbackPort: 21881,
        domain: { nativeClientId: 'domain', resource: 'https://api.test' }
      }

      let available = true

      const store = new EncryptedStore(path.join(directory(), 'vault.json'), {
        isEncryptionAvailable: () => available,
        encryptString: value => Buffer.from(value),
        decryptString: value => value.toString()
      })

      if (mode !== 'absent') {
        store.setItem(
          'matrix-account',
          JSON.stringify({
            version: 1,
            configurationKey: matrixConfigurationKey(config),
            issuer: config.issuer,
            subject: 'owner',
            userId: '@owner:test',
            deviceId: 'OWNER',
            storageKey: Buffer.alloc(32, 1).toString('base64'),
            accessToken: 'test-access',
            refreshToken: 'test-refresh',
            signingOut: mode === 'signing-out',
            ...(mode !== 'without-domain'
              ? {
                  domain: {
                    issuer: config.issuer,
                    subject: mode === 'invalid-domain' ? 'other' : 'owner',
                    accessToken: 'test-domain-access',
                    refreshToken: 'test-domain-refresh',
                    sessionId: 'test-domain-session'
                  }
                }
              : {})
          })
        )
      }

      available = mode !== 'unreadable-vault'
      const account = new MatrixAccount(config, store, vi.fn())
      const enrollment = vi.spyOn(account, 'agentEnrollment')
      const f = fixture()
      f.source.account = () => account
      f.source.enrollment = agent => account.agentEnrollment(agent.principal!)

      expect(account.appScope()).toBeNull()
      expect(() => new MatrixAgentContent({ log: vi.fn() }).view(f.target())).not.toThrow()
      expect(f.target()).toBeUndefined()
      expect(enrollment).not.toHaveBeenCalled()
    }
  )
})
