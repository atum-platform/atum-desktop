import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { type AtumCloudPreferences, parseAccountPreferences, parseCloudPreferences } from '../shared/atum-account-preferences'
import type { AtumCloudMemory } from '../shared/atum-agent-content'
import {
  type AtumAssistantDefinitionSnapshot,
  type AtumPortableAssistantDefinition,
  portableDefinitionWire
} from '../shared/atum-agent-portability'

import type { AtumAssistantPortabilityService } from './atum-agent-portability'
import { AtumAgentSync, type AtumAgentSyncOptions } from './atum-agent-sync'
import { AccountRootAuthority } from './atum-messaging/account-roots'
import { MessagingTransportError } from './atum-messaging/transport-error'

const account = '00000000-0000-4000-8000-303617b97302'
const id = '00000000-0000-4000-8000-00f765af1c54'
const identity = '00000000-0000-4000-8000-50d86b120e98'
const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) {rmSync(path, { recursive: true, force: true })}
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atum-sync-'))
  roots.push(dir)
  const authority = new AccountRootAuthority(dir)
  authority.commit(account, 1)

  const assistant = {
    id,
    identityId: identity,
    displayName: 'Writer',
    avatar: '',
    avatarUrl: null,
    isDefault: false,
    lifecycleRevision: 1,
    identityRevision: 1,
    definitionRevision: 1,
    status: 'active' as const
  }

  const definition: AtumPortableAssistantDefinition = {
    schemaVersion: 1,
    soul: 'A writer',
    modelAlias: 'binh-minh',
    reasoning: { enabled: true, effort: 'medium' },
    skills: []
  }

  let local = structuredClone(definition)

  let cloud: AtumAssistantDefinitionSnapshot = {
    assistant,
    definition: structuredClone(definition),
    definitionRevision: 1,
    identityRevision: 1
  }

  let memory: AtumCloudMemory = { assistantId: id, revision: 0, enabled: false, snapshot: { memory: [], user: [] } }
  let localMemory = { memory: ['Original'], user: [] as string[] }
  const calls: string[] = []

  let inspectFails = false

  const content = vi.fn(async (_assistant, operation: string, payload?: any) => {
    calls.push(operation)

    if (operation === 'inspect') {
      if (inspectFails) {throw new Error('profile_absent')}

      return { ok: true, definition: portableDefinitionWire(local) }
    }

    if (operation === 'export_skill')
      {return { ok: true, bundle: { schema_version: 1, sha256: payload.skill.sha256, files: [] } }}

    if (operation === 'read_memory') {return { ok: true, snapshot: structuredClone(localMemory) }}

    if (operation === 'apply_memory') {
      if (JSON.stringify(localMemory) !== JSON.stringify(payload.expected_snapshot)) {throw new Error('local conflict')}
      localMemory = structuredClone(payload.snapshot)

      return { ok: true, result: { success: true, snapshot: structuredClone(localMemory) } }
    }

    throw new Error('unexpected operation')
  })

  const apply = vi.fn(async (_id, expected) => {
    expect(expected).toEqual(local)
    local = structuredClone(cloud.definition)

    return { ok: true, status: 'applied' }
  })

  const options: AtumAgentSyncOptions = {
    accountRoots: authority,
    session: () => ({ user: { id: account } }),
    portability: { runContent: content, applyAssistantDefinition: apply } as unknown as AtumAssistantPortabilityService,
    listAssistants: async () => [{ ...assistant, definitionRevision: cloud.definitionRevision }],
    getDefinition: async () => structuredClone(cloud),
    putDefinition: vi.fn(async (_id, input) => {
      calls.push('putDefinition')
      expect(input.expectedDefinitionRevision).toBe(cloud.definitionRevision)
      cloud = {
        ...cloud,
        definition: structuredClone(input.definition),
        definitionRevision: cloud.definitionRevision + 1
      }

      return structuredClone(cloud)
    }),
    putSkill: vi.fn(async () => {
      calls.push('putSkill')
    }),
    getMemory: async () => structuredClone(memory),
    putMemory: vi.fn(async (_id, input) => {
      expect(input.expected_revision).toBe(memory.revision)
      memory = {
        assistantId: id,
        revision: memory.revision + 1,
        enabled: input.enabled,
        snapshot: structuredClone(input.snapshot)
      }

      return structuredClone(memory)
    }),
    changed: vi.fn()
  }

  const sync = new AtumAgentSync(options)

  return {
    sync,
    options,
    content,
    apply,
    authority,
    calls,
    setLocal: (d: typeof definition) => {
      local = d
    },
    local: () => local,
    cloud: () => cloud,
    memory: () => memory,
    localMemory: () => localMemory,
    setCloud: (d: typeof definition) => {
      cloud = { ...cloud, definition: d, definitionRevision: cloud.definitionRevision + 1 }
    },
    setLocalMemory: (m: typeof localMemory) => {
      localMemory = m
    },
    setMemory: (m: AtumCloudMemory) => {
      memory = m
    },
    setInspectFails: (fails: boolean) => {
      inspectFails = fails
    },
    assistant
  }
}

test('Google-protected workspace memory stays local instead of becoming an unlabelled cloud snapshot', async () => {
  const f = fixture()
  f.setLocalMemory({ memory: ['Synthetic Google-derived demo memory'], user: [] })
  Object.assign(f.options, { workspaceProtected: () => true })

  await f.sync.sync()

  expect(f.options.putMemory).not.toHaveBeenCalled()
  expect(f.options.putDefinition).not.toHaveBeenCalled()
  expect(f.options.putSkill).not.toHaveBeenCalled()
  expect(f.localMemory().memory).toEqual(['Synthetic Google-derived demo memory'])
  expect(f.sync.statuses()[0]).toMatchObject({ skills: 'local_only', memory: 'local_only', workspaceProtected: true })
})

test.each([true, 'unreadable'])('protected or unreadable workspace preserves populated cloud copies (%s)', async state => {
  const f = fixture()
  await f.sync.sync()
  const saved = structuredClone(f.memory())

  f.options.workspaceProtected = () => { if (state === 'unreadable') { throw new Error('storage') };

 return true }

  vi.mocked(f.options.putMemory).mockClear()
  f.setLocalMemory({ memory: ['Synthetic Google-derived memory'], user: [] })
  const putContent = vi.fn(async () => {})
  const put = vi.fn(async () => { throw new Error('must not publish personal pet metadata') })
  f.options.pets = { list: async () => [], putContent, put, getContent: async () => { throw new Error('unused') } }
  await f.sync.sync()
  expect(f.options.putMemory).not.toHaveBeenCalled()
  expect(f.memory()).toEqual(saved)
  expect(f.localMemory().memory).toEqual(['Synthetic Google-derived memory'])
  expect(f.sync.statuses()[0]).toMatchObject({ memory: 'local_only', memoryEnabled: true, pets: 'local_only' })
  expect(putContent).not.toHaveBeenCalled()
  expect(put).not.toHaveBeenCalled()
  await expect(f.sync.setMemoryEnabled(id, false)).rejects.toThrow('google_workspace_local_only')
  expect(f.memory()).toEqual(saved)
})

test('Google protection stops a memory upload when it becomes active during the local read', async () => {
  const f = fixture()
  let protectedWorkspace = false
  Object.assign(f.options, { workspaceProtected: () => protectedWorkspace })
  const read = f.options.portability.runContent.bind(f.options.portability)

  f.options.portability.runContent = async (...args) => {
    const value = await read(...args)

    if (args[1] === 'read_memory') { protectedWorkspace = true }

    return value
  }

  await f.sync.sync()
  expect(f.options.putMemory).not.toHaveBeenCalled()
  expect(f.sync.statuses()[0]).toMatchObject({ memory: 'local_only', workspaceProtected: true })
})

test('manual memory enable and conflict choices cannot export a protected workspace', async () => {
  const f = fixture()
  Object.assign(f.options, { workspaceProtected: () => true })
  await expect(f.sync.setMemoryEnabled(id, true)).rejects.toThrow('google_workspace_local_only')
  await expect(f.sync.resolve(id, 'memory', 'local')).rejects.toThrow('google_workspace_local_only')
  await expect(f.sync.resolve(id, 'skills', 'local')).rejects.toThrow('google_workspace_local_only')
  expect(f.options.putMemory).not.toHaveBeenCalled()
  expect(f.options.putDefinition).not.toHaveBeenCalled()
  expect(f.options.putSkill).not.toHaveBeenCalled()
  await expect(f.sync.publishDefinition(id, {
    definition: f.local(), displayName: 'Writer', avatar: '', expectedDefinitionRevision: 1, expectedIdentityRevision: 1
  })).rejects.toThrow('google_workspace_local_only')
})

test('connecting Google during skill export stops publication of both skill bytes and instructions', async () => {
  const f = fixture()
  let protectedWorkspace = false
  f.options.workspaceProtected = () => protectedWorkspace
  f.setLocal({ ...f.local(), skills: [{ name: 'writing', sha256: 'a'.repeat(64) }] })
  f.setCloud(f.local())
  const read = f.options.portability.runContent.bind(f.options.portability)

  f.options.portability.runContent = async (...args) => {
    const result = await read(...args)

    if (args[1] === 'export_skill') { protectedWorkspace = true }

    return result
  }

  await f.sync.sync()
  expect(protectedWorkspace).toBe(true)
  expect(f.options.putSkill).not.toHaveBeenCalled()
  expect(f.options.putDefinition).not.toHaveBeenCalled()
  expect(f.options.putMemory).not.toHaveBeenCalled()
})

function preferenceCloud() {
  let cloud: AtumCloudPreferences = { accountId: account, revision: 0, snapshot: { schema_version: 1 } }
  let online = true

  const get = vi.fn(async () => {
    if (!online) { throw new Error('offline') }

    return structuredClone(cloud)
  })

  const put = vi.fn(async (input: { expected_revision: number; snapshot: AtumCloudPreferences['snapshot'] }) => {
    if (!online) { throw new Error('offline') }

    if (input.expected_revision !== cloud.revision) { throw new Error('revision_conflict') }
    cloud = parseCloudPreferences(JSON.parse(JSON.stringify({ account_id: account, revision: cloud.revision + 1, snapshot: input.snapshot })))

    return structuredClone(cloud)
  })

  const device = () => {
    const f = fixture()
    f.options.getPreferences = get
    f.options.putPreferences = put

    return f
  }

  return { device, get, put, cloud: () => cloud, offline: () => { online = false }, online: () => { online = true } }
}

test('portable preferences seed once; an existing cloud choice wins over a new device seed', async () => {
  const c = preferenceCloud()
  const a = c.device(); const b = c.device()
  await a.sync.seedPreferences(account, { schema_version: 1, app: { language: 'vi', appearance_mode: 'dark' } })
  await a.sync.sync()
  await b.sync.seedPreferences(account, { schema_version: 1, app: { language: 'en', appearance_mode: 'light' } })
  await b.sync.sync()
  expect(b.sync.preferences().snapshot).toEqual(a.sync.preferences().snapshot)
  expect(c.cloud().snapshot.app?.appearance_mode).toBe('dark')
  expect(c.put).toHaveBeenCalledTimes(1)
})

test('Google-protected content stays local while ordinary preferences still sync', async () => {
  const c = preferenceCloud()
  const a = c.device(); const b = c.device()
  a.options.workspaceProtected = () => true
  await a.sync.seedPreferences(account, { schema_version: 1, app: { language: 'vi', appearance_mode: 'dark' } })
  await a.sync.sync(); await b.sync.sync()
  expect(b.sync.preferences().snapshot.app).toEqual({ language: 'vi', appearance_mode: 'dark' })
  expect(a.options.putMemory).not.toHaveBeenCalled()
  expect(a.options.putDefinition).not.toHaveBeenCalled()
})

test('offline explicit preference edits survive restart and merge with other device fields', async () => {
  const c = preferenceCloud()
  const a = c.device(); const b = c.device()
  await a.sync.sync(); await b.sync.sync()
  c.offline()
  await a.sync.patchPreferences(account, { schema_version: 1, app: { language: 'en' } })
  await a.sync.sync()
  expect(a.sync.preferences().status).toBe('error')
  a.sync.stop()
  c.online()
  await b.sync.patchPreferences(account, { schema_version: 1, app: { pet_roaming: false } })
  await b.sync.sync()
  const restarted = new AtumAgentSync(a.options)
  await restarted.sync(); await b.sync.sync()
  expect(c.cloud().snapshot.app).toEqual({ language: 'en', pet_roaming: false })
  expect(b.sync.preferences().snapshot).toEqual(restarted.preferences().snapshot)
})

test('an explicit clear remains empty on another device instead of resurrecting old pins', async () => {
  const c = preferenceCloud()
  const a = c.device(); const b = c.device()
  await a.sync.patchPreferences(account, { schema_version: 1, chat_pins: [id] }); await a.sync.sync()
  await b.sync.sync()
  await a.sync.patchPreferences(account, { schema_version: 1, chat_pins: [] }); await a.sync.sync()
  await b.sync.sync()
  expect(b.sync.preferences().snapshot.chat_pins).toEqual([])
})

test('Postgres JSON object ordering does not create false preference conflicts or repeated writes', async () => {
  const c = preferenceCloud()
  const a = c.device()

  a.options.putPreferences = async input => {
    const saved = await c.put(input)
    const app = saved.snapshot.app ?? {}

    return { ...saved, snapshot: { schema_version: 1, app: Object.fromEntries(Object.entries(app).reverse()) } }
  }

  await a.sync.patchPreferences(account, { schema_version: 1, app: { language: 'vi', appearance_mode: 'dark' } })
  await a.sync.sync(); await a.sync.sync()
  expect(a.sync.preferences().status).toBe('synced')
  expect(c.put).toHaveBeenCalledTimes(1)
})

test('preferences reject a stale account caller and invalidate a cloud response across account switch', async () => {
  const c = preferenceCloud()
  const a = c.device()
  const other = '00000000-0000-4000-8000-0bb5de138389'
  await expect(a.sync.patchPreferences(other, { schema_version: 1, app: { language: 'vi' } })).rejects.toThrow('account_context_changed')

  a.options.getPreferences = async () => {
    a.authority.commit(other, 2)
    a.options.session = () => ({ user: { id: other } })

    return c.cloud()
  }

  await expect(a.sync.sync()).rejects.toThrow('account_context_changed')
  expect(c.put).not.toHaveBeenCalled()
  expect(a.sync.preferences().snapshot).toEqual({ schema_version: 1 })
})

test('preference wire rejects credentials, local paths, unknown notification fields and invalid pet refs', () => {
  for (const value of [
    { schema_version: 1, api_key: 'not-a-secret' },
    { schema_version: 1, app: { directory: '/tmp/private' } },
    { schema_version: 1, app: { notifications: { enabled: true, kinds: { arbitrary: true } } } },
    { schema_version: 1, assistants: { [id]: { pet: { ref: { kind: 'bundled', slug: '../private' }, enabled: true, scale: 1 } } } }
  ]) { expect(() => parseAccountPreferences(value)).toThrow('invalid_account_preferences') }
})

test('first sync publishes memory automatically; skill upload precedes definition publication', async () => {
  const f = fixture()
  await f.sync.sync()
  expect(f.calls).toContain('read_memory')
  expect(f.memory().snapshot.memory).toEqual(['Original'])
  expect(f.memory().revision).toBe(1)
  f.setLocal({ ...f.local(), skills: [{ name: 'writing', sha256: 'a'.repeat(64) }] })
  await f.sync.sync()
  expect(f.calls.indexOf('putSkill')).toBeLessThan(f.calls.indexOf('putDefinition'))
  expect(f.sync.statuses()[0].skills).toBe('synced')
  await f.sync.setMemoryEnabled(id, true)
  expect(f.memory().snapshot.memory).toEqual(['Original'])
  expect(f.sync.statuses()[0].memory).toBe('synced')
})

test('a catalog skill resolved from this device stays synced and is never republished', async () => {
  // Preserve the recovery and user-visible behavior covered by this path.
  // device's own shipped tree — its bytes are refused by the owner-private CAS
  // by design — so device B's hash legitimately differs from device A's.
  // Hermes says so with `skill_hash_mismatches`; the desktop discarded the
  // field, so the assistant sat in conflict on every run and "Use account copy"
  // threw `cloud_definition_changed` every time.
  const cloudHash = 'c'.repeat(64)
  const deviceHash = 'd'.repeat(64)
  const f = fixture()

  await f.sync.sync()
  f.setCloud({ ...f.cloud().definition, skills: [{ name: 'meme-generation', sha256: cloudHash }] })

  // This device has no local profile yet, so the run materialises one.
  f.setInspectFails(true)
  f.options.portability.materializeAssistant = vi.fn(async () => {
    f.setInspectFails(false)
    f.setLocal({ ...structuredClone(f.cloud().definition), skills: [{ name: 'meme-generation', sha256: deviceHash }] })

    return {
      ok: true as const,
      status: 'materialized' as const,
      profile: { name: 'writer', identityId: identity, displayName: 'Writer', avatar: '', managedBy: 'atum' as const },
      skillHashMismatches: [{ name: 'meme-generation', expectedSha256: cloudHash, actualSha256: deviceHash }]
    }
  })

  const revisionBefore = f.cloud().definitionRevision

  await f.sync.sync()

  expect(f.sync.statuses()[0].skills).toBe('synced')
  // The account's definition is untouched: this device's tree hash is a fact
  // about this computer, not an edit to publish.
  expect(f.cloud().definitionRevision).toBe(revisionBefore)
  expect(f.cloud().definition.skills).toEqual([{ name: 'meme-generation', sha256: cloudHash }])

  // And it holds on the next tick, which materialises nothing and so learns
  // nothing new — the drift is remembered.
  f.calls.length = 0
  await f.sync.sync()

  expect(f.sync.statuses()[0].skills).toBe('synced')
  expect(f.calls).not.toContain('putDefinition')
  expect(f.cloud().definitionRevision).toBe(revisionBefore)
})

test('one-sided edits pull, concurrent different edits preserve both, explicit choice resolves', async () => {
  const f = fixture()
  await f.sync.sync()
  f.setCloud({ ...f.local(), soul: 'Changed elsewhere' })
  await f.sync.sync()
  expect(f.local().soul).toBe('Changed elsewhere')
  f.setLocal({ ...f.local(), soul: 'This computer' })
  f.setCloud({ ...f.cloud().definition, soul: 'Other computer' })
  await f.sync.sync()
  expect(f.sync.statuses()[0].skills).toBe('conflict')
  expect(f.local().soul).toBe('This computer')
  expect(f.cloud().definition.soul).toBe('Other computer')
  await f.sync.resolve(id, 'skills', 'local')
  expect(f.cloud().definition.soul).toBe('This computer')
})

test('durable bases survive restart and independent memory targets merge without resurrecting deletion', async () => {
  const f = fixture()
  await f.sync.sync()
  await f.sync.setMemoryEnabled(id, true)
  f.setLocalMemory({ memory: [], user: [] })
  f.setMemory({ ...f.memory(), revision: 2, snapshot: { memory: ['Original'], user: ['Cloud preference'] } })
  const restarted = new AtumAgentSync(f.options)
  await restarted.sync()
  expect(f.localMemory()).toEqual({ memory: [], user: ['Cloud preference'] })
  expect(f.memory().snapshot).toEqual(f.localMemory())
})

test('memory conflicts do not overwrite either side, and disabling prevents reads and writes', async () => {
  const f = fixture()
  await f.sync.sync()
  await f.sync.setMemoryEnabled(id, true)
  f.setLocalMemory({ memory: ['Local'], user: [] })
  f.setMemory({ ...f.memory(), revision: 2, snapshot: { memory: ['Remote'], user: [] } })
  await f.sync.sync()
  expect(f.sync.statuses()[0].memory).toBe('conflict')
  expect(f.localMemory().memory).toEqual(['Local'])
  expect(f.memory().snapshot.memory).toEqual(['Remote'])
  await f.sync.setMemoryEnabled(id, false)
  f.calls.length = 0
  await f.sync.sync()
  expect(f.calls).not.toContain('read_memory')
})

test('account generation changes invalidate outstanding responses and publish no outgoing status', async () => {
  const f = fixture()

  f.options.getDefinition = async () => {
    f.authority.commit(account, 2)

    return f.cloud()
  }

  await expect(f.sync.sync()).rejects.toThrow('account_context_changed')
  expect(f.options.putDefinition).not.toHaveBeenCalled()
})

test('signed-out startup is harmless and rejected unknown assistant ids cannot enable memory', async () => {
  const f = fixture()
  await expect(f.sync.setMemoryEnabled(identity, true)).rejects.toThrow('assistant_not_found')
  f.options.session = () => null
  expect(() => f.sync.start()).not.toThrow()
  f.sync.stop()
})

test('stopping sync invalidates an in-flight result even before the account marker changes', async () => {
  const f = fixture()

  f.options.getDefinition = async () => { f.sync.stop();

 return f.cloud() }

  await expect(f.sync.sync()).rejects.toThrow('account_context_changed')
  expect(f.sync.statuses()).toEqual([])
})


test('retired entries are pruned and re-added agents establish a fresh baseline', async () => {
  const f = fixture()
  const list = f.options.listAssistants
  await f.sync.sync()
  expect(f.sync.statuses()).toHaveLength(1)
  f.options.listAssistants = async () => []
  await f.sync.sync()
  expect(f.sync.statuses()).toEqual([])
  f.options.listAssistants = list
  await f.sync.sync()
  expect(f.sync.statuses()[0].skills).toBe('synced')
})


test('an explicit pause prevents memory reads and writes on a fresh computer', async () => {
  const f = fixture()
  f.setMemory({ ...f.memory(), revision: 3, enabled: false, snapshot: { memory: ['Saved elsewhere'], user: [] } })
  await f.sync.sync()
  expect(f.calls).not.toContain('read_memory')
  expect(f.options.putMemory).not.toHaveBeenCalled()
  expect(f.sync.statuses()[0].memory).toBe('disabled')
})

test('a new computer never treats a saved empty snapshot as virgin memory', async () => {
  const f = fixture()
  f.setMemory({ ...f.memory(), revision: 4, enabled: true })
  await f.sync.sync()
  expect(f.sync.statuses()[0].memory).toBe('conflict')
  expect(f.memory().snapshot.memory).toEqual([])
  expect(f.localMemory().memory).toEqual(['Original'])
  expect(f.options.putMemory).not.toHaveBeenCalled()
})

test('concurrent initial uploads preserve both versions when another computer wins CAS', async () => {
  const f = fixture()
  f.options.putMemory = vi.fn(async () => {
    f.setMemory({ ...f.memory(), revision: 1, enabled: true, snapshot: { memory: ['Other computer'], user: [] } })
    throw new Error('revision_conflict')
  })
  await f.sync.sync()
  expect(f.sync.statuses()[0].memory).toBe('error')
  await f.sync.sync()
  expect(f.sync.statuses()[0].memory).toBe('conflict')
  expect(f.memory().snapshot.memory).toEqual(['Other computer'])
  expect(f.localMemory().memory).toEqual(['Original'])
  expect(f.options.putMemory).toHaveBeenCalledTimes(1)
})


test.each([false, true])('resume keeps the prior base and reconciles edits (remote=%s)', async remoteEdit => {
  const f = fixture()
  await f.sync.sync()
  await f.sync.setMemoryEnabled(id, false)
  f.setLocalMemory({ memory: ['Edited while paused'], user: [] })

  if (remoteEdit) {
    f.setMemory({ ...f.memory(), revision: 3, snapshot: { memory: ['Other paused edit'], user: [] } })
  }

  await f.sync.setMemoryEnabled(id, true)
  expect(f.sync.statuses()[0].memory).toBe(remoteEdit ? 'conflict' : 'synced')
  expect(f.localMemory().memory).toEqual(['Edited while paused'])
  expect(f.memory().snapshot.memory).toEqual([remoteEdit ? 'Other paused edit' : 'Edited while paused'])
})

test('catalog-owned hashes are skipped before upload and the omission is recorded in the agent state', async () => {
  const f = fixture()
  const owned = '1'.repeat(64)
  const plain = '2'.repeat(64)

  const skills = [
    { name: 'owned', sha256: owned },
    { name: 'plain', sha256: plain }
  ]

  f.options.catalogOwnedHashes = () => new Set([owned])
  f.setLocal({ ...f.local(), skills })
  f.setCloud({ ...f.cloud().definition, skills: structuredClone(skills) })
  await f.sync.sync()

  const exports = f.content.mock.calls.filter(call => call[1] === 'export_skill')

  expect(exports.map(call => (call[2] as { skill: { sha256: string } }).skill.sha256)).toEqual([plain])
  expect(f.options.putSkill).toHaveBeenCalledTimes(1)
  expect(f.sync.statuses()[0].skills).toBe('synced')

  const statePath = join(f.authority.pathsForAccount(account).hermesStateRoot, '.atum-portability', 'sync-state.json')
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))

  expect(saved.agents[id].catalogOwned).toEqual([owned])
  expect(saved.agents[id].uploaded).toEqual([plain])
})

test('a catalog_owned refusal from the platform is an expected skip, never a sync failure', async () => {
  const f = fixture()
  const hash = '2'.repeat(64)
  const skills = [{ name: 'plain', sha256: hash }]

  // Cold catalog cache: the uploader learns the hash is catalog-owned only
  // from the platform's refusal, records it, and carries on.
  f.options.putSkill = vi.fn(async () => {
    throw new MessagingTransportError('catalog_owned', 409, false, null, null, null)
  })
  f.setLocal({ ...f.local(), skills })
  f.setCloud({ ...f.cloud().definition, skills: structuredClone(skills) })
  await f.sync.sync()

  expect(f.options.putSkill).toHaveBeenCalledTimes(1)
  expect(f.sync.statuses()[0].skills).toBe('synced')
  expect(f.sync.statuses()[0].memory).toBe('synced')
  expect(f.sync.statuses()[0].lastSyncedAt).not.toBeNull()

  const statePath = join(f.authority.pathsForAccount(account).hermesStateRoot, '.atum-portability', 'sync-state.json')
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))

  expect(saved.agents[id].catalogOwned).toEqual([hash])
})

test('the sync tick fires the store refresh hook once per run', async () => {
  const f = fixture()
  const onTick = vi.fn()

  f.options.onTick = onTick
  await f.sync.sync()
  expect(onTick).toHaveBeenCalledTimes(1)
})
