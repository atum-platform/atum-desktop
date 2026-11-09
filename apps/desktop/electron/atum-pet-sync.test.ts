import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, expect, test, vi } from 'vitest'

import type { AtumLocalPet, AtumPersonalPet } from '../shared/atum-account-pets'
import type { AtumCloudPreferences } from '../shared/atum-account-preferences'
import type { AtumCloudMemory, AtumSkillBundle } from '../shared/atum-agent-content'
import type { AtumAssistantDefinitionSnapshot, AtumPortableAssistantDefinition } from '../shared/atum-agent-portability'

import { AtumAssistantPortabilityService } from './atum-agent-portability'
import { AtumAgentSync, type AtumAgentSyncOptions } from './atum-agent-sync'
import { AccountRootAuthority } from './atum-messaging/account-roots'
import type { RegisteredAssistant } from './atum-messaging/types'
import { type AtumPetLibraryClient, type PetSyncContext, restorePersonalPet, syncPersonalPets } from './atum-pet-sync'

const account = '00000000-0000-4000-8000-303617b97302'
const assistantId = '00000000-0000-4000-8000-00f765af1c54'
const identityId = '00000000-0000-4000-8000-50d86b120e98'
const petId = '00000000-0000-4000-8000-0bb5de138389'

const bundle = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../tests/fixtures/atum-pet-bundle-v1.json', import.meta.url)), 'utf8')
) as AtumSkillBundle

const hash = bundle.sha256
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const assistant: RegisteredAssistant = {
  id: assistantId,
  identityId,
  displayName: 'Writer',
  avatar: '',
  avatarUrl: null,
  isDefault: false,
  lifecycleRevision: 1,
  identityRevision: 1,
  definitionRevision: 1,
  status: 'active'
}

function personal(overrides: Partial<AtumPersonalPet> = {}): AtumPersonalPet {
  return {
    pet_id: petId,
    revision: 1,
    display_name: 'Moss',
    description: 'A small companion.',
    content_sha256: hash,
    byte_size: 128,
    updated_at: '2026-09-11T00:00:00.000Z',
    deleted_at: null,
    ...overrides
  }
}

function local(overrides: Partial<AtumLocalPet> = {}): AtumLocalPet {
  return {
    slug: 'moss',
    display_name: 'Moss',
    description: 'A small companion.',
    ref: { kind: 'personal', pet_id: petId },
    content_sha256: hash,
    byte_size: 128,
    published_revision: 0,
    ...overrides
  }
}

function directContext(initial: AtumLocalPet[], cloud = new Map<string, AtumPersonalPet>(), isDefault = false) {
  let pets = structuredClone(initial)
  let active = { ref: null, enabled: false, scale: 1 }
  let explicit = false
  const calls: string[] = []
  const content = new Map<string, AtumSkillBundle>()

  const client: AtumPetLibraryClient = {
    list: async () => [...cloud.values()].map(value => structuredClone(value)),
    putContent: vi.fn(async value => {
      content.set(value.sha256, structuredClone(value))
    }),
    getContent: vi.fn(async sha => {
      const value = content.get(sha)

      if (!value) {
        throw new Error('download_failed')
      }

      return structuredClone(value)
    }),
    put: vi.fn(async (id, input) => {
      const prior = cloud.get(id)

      if ((prior?.revision ?? 0) !== input.expected_revision) {
        throw new Error('revision_conflict')
      }

      const next = personal({ pet_id: id, revision: (prior?.revision ?? 0) + 1, ...input })
      cloud.set(id, next)

      return structuredClone(next)
    })
  }

  const run = vi.fn(async (operation: string, payload?: Record<string, unknown>) => {
    calls.push(operation)

    if (operation === 'read_pets') {
      return { ok: true, pets: structuredClone(pets), active: structuredClone(active), explicit }
    }

    if (operation === 'export_pet') {
      return { ok: true, bundle: structuredClone(bundle) }
    }

    if (operation === 'claim_pet') {
      const pet = payload?.pet as {
        slug: string
        ref: AtumLocalPet['ref']
        content_sha256: string
        published_revision: number
      }

      pets = pets.map(value =>
        value.slug === pet.slug
          ? { ...value, ref: pet.ref, content_sha256: pet.content_sha256, published_revision: pet.published_revision }
          : value
      )

      return { ok: true, status: 'claimed' }
    }

    if (operation === 'install_pet_bundle') {
      const pet = payload?.pet as {
        slug: string
        ref: AtumLocalPet['ref']
        display_name: string
        description: string
        content_sha256: string
        byte_size: number
        published_revision: number
      }

      const existing = pets.find(
        value => value.ref.kind === 'personal' && pet.ref.kind === 'personal' && value.ref.pet_id === pet.ref.pet_id
      )

      if (existing) {
        Object.assign(existing, pet)
      } else {
        pets.push({ ...pet })
      }

      return { ok: true, status: 'installed', slug: pet.slug }
    }

    if (operation === 'apply_pet_binding') {
      const binding = payload?.binding as typeof active
      const expected = payload?.expected_binding as typeof active

      if (JSON.stringify(expected) !== JSON.stringify(active)) {
        return { ok: false, status: 'conflict' }
      }

      active = structuredClone(binding)
      explicit = true

      return { ok: true, status: 'applied' }
    }

    throw new Error(`unexpected operation ${operation}`)
  })

  const context: PetSyncContext = {
    assistant: { ...assistant, isDefault },
    state: { records: {}, restored: [] },
    cloud,
    client,
    run,
    checked: async operation => operation,
    save: vi.fn(),
    assert: vi.fn()
  }

  return {
    context,
    client,
    calls,
    content,
    pets: () => structuredClone(pets),
    setPets: (next: AtumLocalPet[]) => {
      pets = structuredClone(next)
    },
    active: () => structuredClone(active)
  }
}

test('generated personal pet uploads once, then a same-content rename only CASes record cosmetics', async () => {
  const fixture = directContext([local()])
  await syncPersonalPets(fixture.context)
  expect(fixture.client.putContent).toHaveBeenCalledTimes(1)
  expect(fixture.client.put).toHaveBeenCalledTimes(1)
  expect(fixture.pets()[0].published_revision).toBe(1)

  fixture.setPets([local({ display_name: 'Moss Renamed', published_revision: 1 })])
  await syncPersonalPets(fixture.context)
  expect(fixture.client.putContent).toHaveBeenCalledTimes(1)
  expect(fixture.client.put).toHaveBeenCalledTimes(2)
  expect(fixture.context.cloud.get(petId)?.display_name).toBe('Moss Renamed')
})

test('catalog pets never use the personal export or upload path', async () => {
  const fixture = directContext([{ ...local(), ref: { kind: 'catalog', item_id: 'paid-moss' } }])
  await syncPersonalPets(fixture.context)
  expect(fixture.client.putContent).not.toHaveBeenCalled()
  expect(fixture.client.put).not.toHaveBeenCalled()
  expect(fixture.calls).not.toContain('export_pet')
})

test('changed bytes on a published identity report a conflict and preserve both copies', async () => {
  const fixture = directContext([local({ published_revision: 1, content_sha256: 'a'.repeat(64) })], new Map([[petId, personal()]]))
  const result = await syncPersonalPets(fixture.context)
  expect(result.conflict).toBe(true)
  expect(fixture.client.putContent).not.toHaveBeenCalled()
  expect(fixture.client.put).not.toHaveBeenCalled()
  expect(fixture.calls).not.toContain('install_pet_bundle')
  expect(fixture.pets()[0].content_sha256).toBe('a'.repeat(64))
  expect(fixture.context.cloud.get(petId)?.content_sha256).toBe(hash)
})

test('a failed cloud download is partial and leaves the local binding untouched', async () => {
  const cloud = new Map([[petId, personal()]])
  const fixture = directContext([], cloud, true)
  const result = await syncPersonalPets(fixture.context)
  expect(result.partial).toBe(true)
  expect(fixture.active()).toEqual({ ref: null, enabled: false, scale: 1 })
  expect(fixture.calls).not.toContain('apply_pet_binding')
})

function agentFixture() {
  const root = mkdtempSync(join(tmpdir(), 'atum-pet-agent-sync-'))
  temporaryRoots.push(root)
  const authority = new AccountRootAuthority(root)
  authority.commit(account, 1)
  let activeAccount = account
  let rotateOnNextPreferenceRead = false

  const definition: AtumPortableAssistantDefinition = {
    schemaVersion: 1,
    soul: 'Writer',
    modelAlias: 'binh-minh',
    reasoning: { enabled: true, effort: 'medium' },
    skills: []
  }

  let cloudDefinition: AtumAssistantDefinitionSnapshot = {
    assistant: { ...assistant, avatarUrl: assistant.avatarUrl ?? null },
    definition,
    definitionRevision: 1,
    identityRevision: 1
  }

  let memory: AtumCloudMemory = { assistantId, revision: 1, enabled: false, snapshot: { memory: [], user: [] } }
  let pets = [local({ published_revision: 1 })]
  let active = { ref: { kind: 'personal' as const, pet_id: petId }, enabled: true, scale: 1 }
  let explicit = true
  let preferences: AtumCloudPreferences = { accountId: account, revision: 1, snapshot: { schema_version: 1 } }
  const cloud = new Map([[petId, personal()]])

  const petClient: AtumPetLibraryClient = {
    list: vi.fn(async () => [...cloud.values()].map(value => structuredClone(value))),
    put: vi.fn(async () => {
      throw new Error('unexpected put')
    }),
    putContent: vi.fn(async () => {
      throw new Error('unexpected upload')
    }),
    getContent: vi.fn(async () => structuredClone(bundle))
  }

  const content = vi.fn(
    async (_assistant: RegisteredAssistant, operation: string, payload?: Record<string, unknown>) => {
      if (operation === 'inspect') {
        return { ok: true, definition }
      }

      if (operation === 'read_memory') {
        return { ok: true, snapshot: { memory: [], user: [] } }
      }

      if (operation === 'read_pets') {
        return { ok: true, pets: structuredClone(pets), active: structuredClone(active), explicit }
      }

      if (operation === 'claim_pet') {
        return { ok: true }
      }

      if (operation === 'apply_pet_binding') {
        if (JSON.stringify(payload?.expected_binding) !== JSON.stringify(active)) {
          return { ok: false, status: 'conflict' }
        }

        active = structuredClone(payload?.binding as typeof active)
        explicit = true

        return { ok: true, status: 'applied' }
      }

      if (operation === 'install_pet_bundle') {
        return { ok: true, status: 'installed', slug: 'moss' }
      }

      if (operation === 'export_pet') {
        return { ok: true, bundle }
      }

      throw new Error(`unexpected operation ${operation}`)
    }
  )

  const options: AtumAgentSyncOptions = {
    accountRoots: authority,
    session: () => ({ user: { id: activeAccount } }),
    portability: {
      runContent: content,
      applyAssistantDefinition: vi.fn()
    } as unknown as AtumAssistantPortabilityService,
    listAssistants: async () => [assistant],
    getDefinition: async () => structuredClone(cloudDefinition),
    putDefinition: async (_id, input) => {
      cloudDefinition = {
        ...cloudDefinition,
        definition: structuredClone(input.definition),
        definitionRevision: cloudDefinition.definitionRevision + 1
      }

      return structuredClone(cloudDefinition)
    },
    putSkill: async () => {},
    getMemory: async () => structuredClone(memory),
    putMemory: async (_id, input) => {
      memory = {
        ...memory,
        revision: memory.revision + 1,
        enabled: input.enabled,
        snapshot: structuredClone(input.snapshot)
      }

      return structuredClone(memory)
    },
    changed: vi.fn(),
    pets: petClient,
    getPreferences: async () => {
      if (rotateOnNextPreferenceRead) {
        activeAccount = '00000000-0000-4000-8000-6cc9b1298c8f'
        authority.commit(activeAccount, 2)
      }

      return structuredClone(preferences)
    },
    putPreferences: async input => {
      if (input.expected_revision !== preferences.revision) {
        throw new Error('preference_conflict')
      }

      preferences = {
        accountId: account,
        revision: preferences.revision + 1,
        snapshot: structuredClone(input.snapshot)
      }

      return structuredClone(preferences)
    }
  }

  return {
    sync: new AtumAgentSync(options),
    content,
    petClient,
    setActive: (value: typeof active) => {
      active = structuredClone(value)
    },
    active: () => structuredClone(active),
    preferences: () => structuredClone(preferences),
    setPreferences: (value: AtumCloudPreferences) => { preferences = structuredClone(value) },
    setExplicit: (value: boolean) => { explicit = value },
    setPets: (value: AtumLocalPet[]) => {
      pets = structuredClone(value)
    },
    rotateAccountOnNextPreferenceRead: () => {
      rotateOnNextPreferenceRead = true
    }
  }
}

test.each([true, false])('first sync respects explicit=%s when the account already has a pet choice', async explicit => {
  const fixture = agentFixture()
  const cleared = { ref: null, enabled: false, scale: 1 }
  fixture.setExplicit(explicit)
  fixture.setPreferences({ accountId: account, revision: 2, snapshot: { schema_version: 1, assistants: { [assistantId]: { pet: cleared } } } })
  await fixture.sync.sync()
  expect(fixture.preferences().snapshot.assistants?.[assistantId]?.pet.ref).toEqual(explicit ? { kind: 'personal', pet_id: petId } : null)
})

test('public coordinator persists an explicit clear and does not resurrect the old personal binding', async () => {
  const fixture = agentFixture()
  await fixture.sync.sync()
  fixture.setActive({ ref: null, enabled: false, scale: 1 })
  fixture.setPets([local({ published_revision: 1 })])
  await fixture.sync.sync()
  expect(fixture.active()).toEqual({ ref: null, enabled: false, scale: 1 })
  expect(fixture.preferences().snapshot.assistants?.[assistantId]?.pet).toEqual({ ref: null, enabled: false, scale: 1 })
  expect(fixture.content.mock.calls.filter(([, operation]) => operation === 'apply_pet_binding')).toHaveLength(0)
  expect(fixture.sync.statuses()[0]?.pets).toBe('synced')
})

test('an account fence change stops the coordinator before it can query the pet library', async () => {
  const fixture = agentFixture()
  fixture.rotateAccountOnNextPreferenceRead()
  await expect(fixture.sync.sync()).rejects.toThrow('account_context_changed')
  expect(fixture.petClient.list).not.toHaveBeenCalled()
  expect(fixture.sync.statuses()).toEqual([])
})

/** Opt in with ATUM_SYNC_PYTHON to exercise canonical bytes through real Python tickets and managed profiles. */
test.skipIf(!process.env.ATUM_SYNC_PYTHON)(
  'two managed homes upload then restore a personal pet without overwriting a slug collision',
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'atum-pet-two-homes-'))
    const execute = promisify(execFile)
    const content = new Map<string, AtumSkillBundle>()
    const cloud = new Map<string, AtumPersonalPet>()

    const makeComputer = (name: string) => {
      const data = join(scratch, name)
      const authority = new AccountRootAuthority(data)
      authority.commit(account, 1)
      const home = authority.pathsForAccount(account).hermesStateRoot
      mkdirSync(home, { recursive: true })
      const marker = join(data, 'ticket-marker')

      const call = async (body: { ticket_id: string }) => {
        const { stdout } = await execute(
          process.env.ATUM_SYNC_PYTHON!,
          [
            '-c',
            'import json,sys; from pathlib import Path; from hermes_cli.atum_content_sync import content_ticket; print(json.dumps(content_ticket(Path(sys.argv[1]), sys.argv[2])))',
            readFileSync(marker, 'utf8').trim(),
            body.ticket_id
          ],
          {
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: { ...process.env, HERMES_HOME: home },
            maxBuffer: 4_300_000
          }
        )

        return JSON.parse(stdout)
      }

      const service = new AtumAssistantPortabilityService({
        accountRoots: authority,
        session: () => ({ user: { id: account } }),
        listAssistants: async () => [assistant],
        getAssistantDefinition: async () => {
          throw new Error('unused')
        },
        putAssistantDefinition: async () => {
          throw new Error('unused')
        },
        content: call,
        materialize: async () => ({ ok: false }),
        exportLegacy: async () => ({ ok: false }),
        legacyHome: join(data, 'legacy'),
        ticketRootMarkerPath: marker
      })

      service.activateAccount(account)

      return { home, service }
    }

    const writeProfile = (home: string, slug: string) => {
      const profile = join(home, 'profiles', 'writer')
      mkdirSync(join(profile, 'pets', slug), { recursive: true })
      writeFileSync(
        join(profile, 'profile.yaml'),
        `identity_id: ${identityId}\nmanaged_by: atum\ndisplay_name: Writer\navatar: ''\n`
      )
      writeFileSync(join(profile, 'SOUL.md'), 'Writer')
      writeFileSync(
        join(profile, 'config.yaml'),
        'model:\n  provider: atum-managed\n  default: binh-minh\ndisplay:\n  pet:\n    enabled: true\n    slug: moss\n    scale: 1\n'
      )

      for (const file of bundle.files) {
        writeFileSync(join(profile, 'pets', slug, file.path), Buffer.from(file.content_base64, 'base64'))
      }
    }

    try {
      const source = makeComputer('source')
      const target = makeComputer('target')
      writeProfile(source.home, 'moss')
      writeProfile(target.home, 'moss')

      const sourceContext: PetSyncContext = {
        assistant,
        state: { records: {}, restored: [] },
        cloud,
        client: {
          list: async () => [...cloud.values()],
          putContent: async value => {
            content.set(value.sha256, value)
          },
          getContent: async sha => {
            const value = content.get(sha)

            if (!value) {
              throw new Error('missing')
            }

            return value
          },
          put: async (id, input) => {
            const next = personal({ pet_id: id, revision: 1, ...input })
            cloud.set(id, next)

            return next
          }
        },
        run: (operation, payload) => source.service.runContent(assistant, operation, payload),
        checked: async op => op,
        save: () => {},
        assert: () => {}
      }

      await syncPersonalPets(sourceContext)
      const uploaded = [...cloud.values()][0]
      expect(uploaded).toBeTruthy()

      const targetContext: PetSyncContext = {
        ...sourceContext,
        state: { records: {}, restored: [] },
        run: (operation, payload) => target.service.runContent(assistant, operation, payload)
      }

      await restorePersonalPet(targetContext, uploaded!)

      const inspected = (await target.service.runContent(assistant, 'read_pets')) as {
        pets: Array<{ slug: string; ref: { kind: string; pet_id?: string } }>
      }

      expect(inspected.pets.map(value => value.slug).sort()).toEqual(['moss', 'moss-2'])
      expect(
        inspected.pets.find(value => value.ref.kind === 'personal' && value.ref.pet_id === uploaded!.pet_id)?.slug
      ).toBe('moss-2')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  },
  30_000
)
