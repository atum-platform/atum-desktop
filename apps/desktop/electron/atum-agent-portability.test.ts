import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { AtumAssistantDefinitionSnapshot } from '../shared/atum-agent-portability'

import { AtumAssistantPortabilityService } from './atum-agent-portability'
import { AccountRootAuthority } from './atum-messaging/account-roots'

const ACCOUNT_A = '00000000-0000-4000-8000-303617b97302'
const ACCOUNT_B = '00000000-0000-4000-8000-00f765af1c54'
const ASSISTANT_ROW = '00000000-0000-4000-8000-50d86b120e98'
const IDENTITY = '00000000-0000-4000-8000-0bb5de138389'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'atum-portability-'))
  directories.push(result)

  return result
}

const snapshot: AtumAssistantDefinitionSnapshot = {
  assistant: {
    id: ASSISTANT_ROW,
    identityId: IDENTITY,
    displayName: 'Writing',
    avatar: '✍️',
    avatarUrl: null,
    isDefault: false,
    lifecycleRevision: 1,
    status: 'active',
    identityRevision: 4,
    definitionRevision: 2
  },
  definition: {
    schemaVersion: 1,
    soul: '# Writing',
    modelAlias: 'binh-minh',
    reasoning: { enabled: true, effort: 'medium' },
    skills: [{ name: 'writing/example', sha256: 'a'.repeat(64) }]
  },
  definitionRevision: 2,
  identityRevision: 4
}

const directoryAssistant = {
  id: ASSISTANT_ROW,
  identityId: IDENTITY,
  displayName: 'Writing',
  avatar: '✍️',
  avatarUrl: null,
  isDefault: false,
  lifecycleRevision: 1,
  identityRevision: 4,
  definitionRevision: 0,
  status: 'active' as const
}

test('materialization exposes only the one-use ticket id to the local backend and cleans it after use', async () => {
  const userData = directory()
  const roots = new AccountRootAuthority(userData)
  roots.commit(ACCOUNT_A, 1)
  let account = ACCOUNT_A
  let localBody: unknown = null
  let materializeStatus = 'materialized'
  const marker = join(userData, 'backend', 'tickets-root')

  const service = new AtumAssistantPortabilityService({
    accountRoots: roots,
    session: () => ({ user: { id: account } }),
    listAssistants: async () => [directoryAssistant],
    getAssistantDefinition: async id => {
      assert.equal(id, ASSISTANT_ROW)

      return snapshot
    },
    putAssistantDefinition: async () => snapshot,
    materialize: async body => {
      localBody = body
      assert.deepEqual(Object.keys(body), ['ticket_id'])
      const root = readFileSync(marker, 'utf8').trim()
      const ticket = JSON.parse(readFileSync(join(root, `${body.ticket_id}.json`), 'utf8')) as Record<string, unknown>
      assert.equal(ticket.account_id, ACCOUNT_A)
      assert.equal(ticket.definition_revision, 2)
      assert.equal(ticket.identity_revision, 4)
      assert.equal(ticket.legacy_home, join(userData, 'legacy-hermes'))
      assert.equal(Object.hasOwn(ticket, 'apply_existing'), false)

      return {
        ok: true,
        status: materializeStatus,
        profile: {
          name: `agent-${IDENTITY}`,
          identity_id: IDENTITY,
          display_name: 'Writing',
          avatar: '✍️',
          managed_by: 'atum'
        }
      }
    },
    exportLegacy: async () => ({ ok: false, status: 'legacy_source_absent' }),
    legacyHome: join(userData, 'legacy-hermes'),
    ticketRootMarkerPath: marker,
    now: () => 1_000_000
  })

  service.activateAccount(ACCOUNT_A)
  const result = await service.materializeAssistant(ASSISTANT_ROW)
  assert.deepEqual(result, {
    ok: true,
    status: 'materialized',
    profile: {
      name: `agent-${IDENTITY}`,
      identityId: IDENTITY,
      displayName: 'Writing',
      avatar: '✍️',
      managedBy: 'atum',
      definitionRevision: 2,
      identityRevision: 4
    }
  })
  assert.ok(localBody && typeof (localBody as { ticket_id?: unknown }).ticket_id === 'string')
  const ticketRoot = join(roots.pathsForAccount(ACCOUNT_A).hermesStateRoot, '.atum-portability', 'tickets')
  assert.deepEqual(existsSync(ticketRoot) ? readdirSync(ticketRoot) : [], [])
  materializeStatus = 'reused'
  const reused = await service.materializeAssistant(ASSISTANT_ROW)
  assert.ok(reused.ok)
  assert.equal(reused.profile.definitionRevision, undefined)
  assert.equal(reused.profile.identityRevision, undefined)
})

test('explicit cloud apply writes the apply-only ticket flag and accepts an applied response', async () => {
  const userData = directory()
  const roots = new AccountRootAuthority(userData)
  roots.commit(ACCOUNT_A, 1)
  const marker = join(userData, 'backend', 'tickets-root')

  const service = new AtumAssistantPortabilityService({
    accountRoots: roots,
    session: () => ({ user: { id: ACCOUNT_A } }),
    listAssistants: async () => [directoryAssistant],
    getAssistantDefinition: async () => snapshot,
    putAssistantDefinition: async () => snapshot,
    materialize: async body => {
      const root = readFileSync(marker, 'utf8').trim()
      const ticket = JSON.parse(readFileSync(join(root, `${body.ticket_id}.json`), 'utf8')) as Record<string, unknown>
      assert.equal(ticket.apply_existing, true)

      return {
        ok: true,
        status: 'applied',
        profile: {
          name: `agent-${IDENTITY}`,
          identity_id: IDENTITY,
          display_name: 'Writing',
          avatar: '✍️',
          managed_by: 'atum'
        }
      }
    },
    exportLegacy: async () => ({ ok: false, status: 'legacy_source_absent' }),
    legacyHome: join(userData, 'legacy-hermes'),
    ticketRootMarkerPath: marker
  })

  service.activateAccount(ACCOUNT_A)
  const result = await service.applyAssistantDefinition(ASSISTANT_ROW)
  assert.equal(result.ok, true)

  if (result.ok) {
    assert.equal(result.status, 'applied')
  }
})

test('A to B to A invalidates an in-flight cloud apply fetch before ticket creation', async () => {
  const userData = directory()
  const roots = new AccountRootAuthority(userData)
  roots.commit(ACCOUNT_A, 1)
  let account = ACCOUNT_A
  let resolveFetch: ((value: AtumAssistantDefinitionSnapshot) => void) | null = null

  const fetch = new Promise<AtumAssistantDefinitionSnapshot>(resolve => {
    resolveFetch = resolve
  })

  let materializeCalls = 0

  const service = new AtumAssistantPortabilityService({
    accountRoots: roots,
    session: () => ({ user: { id: account } }),
    listAssistants: async () => [directoryAssistant],
    getAssistantDefinition: () => fetch,
    putAssistantDefinition: async () => snapshot,
    materialize: async () => {
      materializeCalls += 1
      throw new Error('must_not_materialize')
    },
    exportLegacy: async () => ({ ok: false, status: 'legacy_source_absent' }),
    legacyHome: join(userData, 'legacy-hermes'),
    ticketRootMarkerPath: join(userData, 'backend', 'tickets-root')
  })

  const pending = service.applyAssistantDefinition(ASSISTANT_ROW)
  account = ACCOUNT_B
  roots.commit(ACCOUNT_B, 2)
  account = ACCOUNT_A
  roots.commit(ACCOUNT_A, 3)
  resolveFetch!(snapshot)

  await assert.rejects(pending, /account_context_changed/)
  assert.equal(materializeCalls, 0)
  const ticketRoot = join(roots.pathsForAccount(ACCOUNT_A).hermesStateRoot, '.atum-portability', 'tickets')
  assert.deepEqual(existsSync(ticketRoot) ? readdirSync(ticketRoot) : [], [])
})

test('legacy import binds only the owned identity, exports its allowlist, then uses ordinary materialization', async () => {
  const userData = directory()
  const roots = new AccountRootAuthority(userData)
  roots.commit(ACCOUNT_A, 1)
  const legacyHome = join(userData, 'legacy-hermes')
  const marker = join(userData, 'backend', 'tickets-root')
  const calls: string[] = []

  const importedSnapshot: AtumAssistantDefinitionSnapshot = {
    ...snapshot,
    assistant: {
      ...snapshot.assistant,
      displayName: 'Writing legacy',
      avatar: '📜',
      identityRevision: 5,
      definitionRevision: 1
    },
    identityRevision: 5,
    definitionRevision: 1
  }

  const service = new AtumAssistantPortabilityService({
    accountRoots: roots,
    session: () => ({ user: { id: ACCOUNT_A } }),
    listAssistants: async () => [directoryAssistant],
    getAssistantDefinition: async () => snapshot,
    putAssistantDefinition: async (assistantId, input) => {
      assert.equal(assistantId, ASSISTANT_ROW)
      assert.deepEqual(input, {
        expectedDefinitionRevision: 0,
        expectedIdentityRevision: 4,
        displayName: 'Writing legacy',
        avatar: '📜',
        definition: snapshot.definition
      })

      return importedSnapshot
    },
    exportLegacy: async body => {
      calls.push('export')
      assert.deepEqual(Object.keys(body), ['ticket_id'])
      const ticketRoot = readFileSync(marker, 'utf8').trim()

      const ticket = JSON.parse(readFileSync(join(ticketRoot, `${body.ticket_id}.json`), 'utf8')) as Record<
        string,
        unknown
      >

      assert.deepEqual(ticket, {
        operation: 'export_legacy',
        account_id: ACCOUNT_A,
        expires_at: 1090,
        assistant: { identity_id: IDENTITY, display_name: 'Writing', avatar: '✍️' },
        legacy_home: legacyHome
      })

      return {
        ok: true,
        status: 'exported',
        assistant: { identity_id: IDENTITY, display_name: 'Writing legacy', avatar: '📜' },
        definition: {
          schema_version: 1,
          soul: '# Writing',
          model_alias: 'binh-minh',
          reasoning: { enabled: true, effort: 'medium' },
          skills: [{ name: 'writing/example', sha256: 'a'.repeat(64) }]
        }
      }
    },
    materialize: async body => {
      calls.push('materialize')
      assert.deepEqual(Object.keys(body), ['ticket_id'])

      return {
        ok: true,
        status: 'materialized',
        profile: {
          name: `agent-${IDENTITY}`,
          identity_id: IDENTITY,
          display_name: 'Writing legacy',
          avatar: '📜',
          managed_by: 'atum'
        }
      }
    },
    legacyHome,
    ticketRootMarkerPath: marker,
    now: () => 1_000_000
  })

  service.activateAccount(ACCOUNT_A)
  assert.deepEqual(await service.importLegacyAssistant(ASSISTANT_ROW), {
    ok: true,
    status: 'imported',
    profile: {
      name: `agent-${IDENTITY}`,
      identityId: IDENTITY,
      displayName: 'Writing legacy',
      avatar: '📜',
      managedBy: 'atum',
      definitionRevision: 1,
      identityRevision: 5
    }
  })
  assert.deepEqual(calls, ['export', 'materialize'])
})

test('legacy import reports no source without writing a cloud definition', async () => {
  const userData = directory()
  const roots = new AccountRootAuthority(userData)
  roots.commit(ACCOUNT_A, 1)
  let writes = 0

  const service = new AtumAssistantPortabilityService({
    accountRoots: roots,
    session: () => ({ user: { id: ACCOUNT_A } }),
    listAssistants: async () => [directoryAssistant],
    getAssistantDefinition: async () => snapshot,
    putAssistantDefinition: async () => {
      writes += 1

      return snapshot
    },
    exportLegacy: async () => ({ ok: false, status: 'legacy_source_absent' }),
    materialize: async () => {
      throw new Error('must_not_materialize')
    },
    legacyHome: join(userData, 'legacy-hermes'),
    ticketRootMarkerPath: join(userData, 'backend', 'tickets-root')
  })

  assert.deepEqual(await service.importLegacyAssistant(ASSISTANT_ROW), { ok: false, status: 'legacy_source_absent' })
  assert.equal(writes, 0)
})

test('legacy import refuses an enrolled definition instead of overwriting it', async () => {
  const userData = directory()
  const roots = new AccountRootAuthority(userData)
  roots.commit(ACCOUNT_A, 1)
  let exportCalls = 0

  const service = new AtumAssistantPortabilityService({
    accountRoots: roots,
    session: () => ({ user: { id: ACCOUNT_A } }),
    listAssistants: async () => [{ ...directoryAssistant, definitionRevision: 1 }],
    getAssistantDefinition: async () => snapshot,
    putAssistantDefinition: async () => snapshot,
    exportLegacy: async () => {
      exportCalls += 1
      throw new Error('must_not_export')
    },
    materialize: async () => {
      throw new Error('must_not_materialize')
    },
    legacyHome: join(userData, 'legacy-hermes'),
    ticketRootMarkerPath: join(userData, 'backend', 'tickets-root')
  })

  assert.deepEqual(await service.importLegacyAssistant(ASSISTANT_ROW), { ok: false, status: 'definition_exists' })
  assert.equal(exportCalls, 0)
})
