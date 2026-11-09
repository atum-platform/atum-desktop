import { atom } from 'nanostores'

import { getPortableProfileDefinition } from '@/hermes'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { refreshProfiles } from '@/store/profile'

import type { AtumAgent } from './agents'
import {
  $atumAssistantDirectory,
  captureAtumAssistantDirectoryScope,
  isAtumAssistantDirectoryScopeCurrent,
  refreshAtumAssistantDirectory
} from './assistant-directory'

/** A durable local edit. It is keyed by account and stable hosted id, never a
 * profile name, so the person can retry after a CAS conflict or reconnect. */
export interface AtumDefinitionDraft {
  baseDefinitionRevision: number
  baseIdentityRevision: number
  definition: unknown
  displayName: string
  avatar: string
}

function draftsRecord(value: unknown): Record<string, Record<string, AtumDefinitionDraft>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([account, entries]) => {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        return []
      }

      const cleaned = Object.fromEntries(
        Object.entries(entries as Record<string, unknown>).filter(([, draft]) => {
          if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
            return false
          }

          const value = draft as Record<string, unknown>

          return (
            typeof value.displayName === 'string' &&
            typeof value.avatar === 'string' &&
            typeof value.baseDefinitionRevision === 'number' &&
            typeof value.baseIdentityRevision === 'number' &&
            'definition' in value
          )
        })
      ) as Record<string, AtumDefinitionDraft>

      return [[account, cleaned]]
    })
  )
}

export const $atumDefinitionDrafts = persistentAtom<Record<string, Record<string, AtumDefinitionDraft>>>(
  'atum.desktop.assistantDefinitionDrafts.v1',
  {},
  Codecs.json(draftsRecord)
)

interface DefinitionBase {
  definitionRevision: number
  identityRevision: number
}

/** Last definition actually installed or uploaded on this computer. Merely
 * reading the directory must never advance this conflict precondition. */
export const $atumDefinitionBases = persistentAtom<Record<string, Record<string, DefinitionBase>>>(
  'atum.desktop.assistantDefinitionBases.v1',
  {},
  Codecs.json(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(value).flatMap(([account, entries]) => {
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
          return []
        }

        return [[account, Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, DefinitionBase] => validDefinitionBase(entry[1])))]]
      })
    )
  })
)

function validDefinitionBase(value: unknown): value is DefinitionBase {
  if (!value || typeof value !== 'object') {
    return false
  }

  const base = value as DefinitionBase

  return (
    Number.isSafeInteger(base.definitionRevision) &&
    base.definitionRevision > 0 &&
    Number.isSafeInteger(base.identityRevision) &&
    base.identityRevision > 0
  )
}

function rememberDefinitionBase(assistantId: string, value: unknown): void {
  const account = $atumAssistantDirectory.get().accountId

  if (!account || !validDefinitionBase(value)) {
    return
  }

  const all = $atumDefinitionBases.get()
  $atumDefinitionBases.set({
    ...all,
    [account]: {
      ...all[account],
      [assistantId]: {
        definitionRevision: value.definitionRevision,
        identityRevision: value.identityRevision
      }
    }
  })
}

/** The current operation is intentionally per-row. It is presentation state
 * only and never used as truth about the runtime. */
export const $atumPortableBusy = atom<string | null>(null)

function currentDraft(agent: AtumAgent): AtumDefinitionDraft | null {
  const accountId = $atumAssistantDirectory.get().accountId

  return accountId && agent.hostedId ? ($atumDefinitionDrafts.get()[accountId]?.[agent.hostedId] ?? null) : null
}

function saveDraft(assistantId: string, draft: AtumDefinitionDraft): void {
  const accountId = $atumAssistantDirectory.get().accountId

  if (!accountId) {
    return
  }

  const all = $atumDefinitionDrafts.get()
  $atumDefinitionDrafts.set({ ...all, [accountId]: { ...(all[accountId] ?? {}), [assistantId]: draft } })
}

function discardDraft(assistantId: string): void {
  const accountId = $atumAssistantDirectory.get().accountId

  if (!accountId) {
    return
  }

  const all = $atumDefinitionDrafts.get()
  const entries = { ...(all[accountId] ?? {}) }
  delete entries[assistantId]
  $atumDefinitionDrafts.set({ ...all, [accountId]: entries })
}

export function atumDefinitionDraft(agent: AtumAgent): AtumDefinitionDraft | null {
  return currentDraft(agent)
}

/** Upload the exact portable allowlist exported by the local runtime. This
 * avoids reconstructing a definition from destination defaults or UI fields. */
export async function uploadPortableAtumAgent(
  agent: AtumAgent,
  identity: Partial<Pick<AtumDefinitionDraft, 'avatar' | 'displayName'>> = {}
): Promise<void> {
  if (!agent.localProfileId || !agent.hostedId) {
    throw new Error('assistant_profile_unavailable')
  }

  const scope = captureAtumAssistantDirectoryScope()
  const row = $atumAssistantDirectory.get().entries.find(entry => entry.id === agent.hostedId)

  if (!scope.accountId || !row || row.status !== 'active') {
    throw new Error('assistant_profile_unavailable')
  }

  $atumPortableBusy.set(agent.hostedId)

  try {
    const put = atumMessagingClient().putAssistantDefinition

    if (!put) {
      throw new Error('assistant_portability_unavailable')
    }

    const exported = await getPortableProfileDefinition(agent.localProfileId)

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    const prior = currentDraft(agent)
    const installedBase = $atumDefinitionBases.get()[scope.accountId]?.[agent.hostedId]

    const draft: AtumDefinitionDraft = {
      avatar: identity.avatar ?? agent.avatar,
      baseDefinitionRevision: prior?.baseDefinitionRevision ?? installedBase?.definitionRevision ?? 0,
      // Enrollment needs the directory's identity revision. Unknown local
      // definition provenance still sends zero above and conflicts if enrolled.
      baseIdentityRevision: prior?.baseIdentityRevision ?? installedBase?.identityRevision ?? row.identityRevision ?? 0,
      definition: exported.definition,
      displayName: identity.displayName ?? agent.title
    }

    saveDraft(agent.hostedId, draft)

    const accepted = await put(agent.hostedId, {
      avatar: draft.avatar,
      definition: draft.definition,
      displayName: draft.displayName,
      expectedDefinitionRevision: draft.baseDefinitionRevision,
      expectedIdentityRevision: draft.baseIdentityRevision
    })

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    rememberDefinitionBase(agent.hostedId, accepted)

    await refreshAtumAssistantDirectory()

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    discardDraft(agent.hostedId)
  } catch (error) {
    if (ipcErrorMessage(error) === 'google_workspace_local_only' && isAtumAssistantDirectoryScopeCurrent(scope)) {
      discardDraft(agent.hostedId)
    }

    if (ipcErrorMessage(error) === 'revision_conflict') {
      throw new Error('assistant_definition_conflict')
    }

    throw error
  } finally {
    if (isAtumAssistantDirectoryScopeCurrent(scope)) {
      $atumPortableBusy.set(null)
    }
  }
}

/** Retrieve current server revisions then reapply the retained draft. The
 * explicit call is the person's conflict choice; no background sync races it. */
export async function retryPortableAtumAgent(agent: AtumAgent): Promise<void> {
  if (!agent.hostedId) {
    throw new Error('assistant_profile_unavailable')
  }

  const scope = captureAtumAssistantDirectoryScope()
  const draft = currentDraft(agent)

  if (!scope.accountId || !draft) {
    throw new Error('assistant_definition_draft_missing')
  }

  $atumPortableBusy.set(agent.hostedId)

  try {
    const client = atumMessagingClient()

    if (!client.getAssistantDefinition || !client.putAssistantDefinition) {
      throw new Error('assistant_portability_unavailable')
    }

    const latest = await client.getAssistantDefinition(agent.hostedId)

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    const accepted = await client.putAssistantDefinition(agent.hostedId, {
      avatar: draft.avatar,
      definition: draft.definition,
      displayName: draft.displayName,
      expectedDefinitionRevision: latest.definitionRevision,
      expectedIdentityRevision: latest.identityRevision
    })

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    rememberDefinitionBase(agent.hostedId, accepted)
    await refreshAtumAssistantDirectory()

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    discardDraft(agent.hostedId)
  } catch (error) {
    if (ipcErrorMessage(error) === 'google_workspace_local_only' && isAtumAssistantDirectoryScopeCurrent(scope)) {
      discardDraft(agent.hostedId)
    }

    if (ipcErrorMessage(error) === 'revision_conflict') {
      throw new Error('assistant_definition_conflict')
    }

    throw error
  } finally {
    if (isAtumAssistantDirectoryScopeCurrent(scope)) {
      $atumPortableBusy.set(null)
    }
  }
}

/**
 * Explicitly replace an existing managed profile's portable settings from its
 * hosted definition. Main owns the recovery backup and never mutates a live
 * agent object, so this affects only chats opened after the person chooses it.
 */
export async function applyPortableAtumAgent(agent: AtumAgent): Promise<string> {
  if (!agent.localProfileId || !agent.hostedId || agent.isDefault || agent.definitionState !== 'available') {
    throw new Error('assistant_profile_unavailable')
  }

  const scope = captureAtumAssistantDirectoryScope()

  if (!scope.accountId) {
    throw new Error('assistant_profile_account_changed')
  }

  $atumPortableBusy.set(agent.hostedId)

  try {
    const apply = atumMessagingClient().applyAssistantDefinition

    if (!apply) {
      throw new Error('assistant_portability_unavailable')
    }

    const result = await apply(agent.hostedId)

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    if (!result.ok) {
      if (result.status === 'missing_skills') {
        throw new Error('assistant_missing_skills')
      }

      throw new Error('assistant_apply_failed')
    }

    rememberDefinitionBase(agent.hostedId, result.profile)

    await Promise.all([refreshProfiles(), refreshAtumAssistantDirectory()])

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    discardDraft(agent.hostedId)

    return result.profile.name
  } finally {
    if (isAtumAssistantDirectoryScopeCurrent(scope)) {
      $atumPortableBusy.set(null)
    }
  }
}

/** Discard only this persisted draft; leave the local Hermes profile intact. */
export function discardPortableAtumAgentDraft(agent: AtumAgent): void {
  if (agent.hostedId) {
    discardDraft(agent.hostedId)
  }
}

/** Main owns definition fetch, ticket custody and identity binding. After a
 * successful materialization we refresh profiles before exposing the local id
 * to the caller, so the new chat targets the bound runtime rather than a name
 * guessed by the renderer. */
export async function setupPortableAtumAgent(agent: AtumAgent): Promise<string> {
  if (!agent.hostedId || agent.definitionState !== 'setup') {
    throw new Error(
      agent.definitionState === 'local_only' ? 'assistant_definition_missing' : 'assistant_profile_unavailable'
    )
  }

  const scope = captureAtumAssistantDirectoryScope()

  if (!scope.accountId) {
    throw new Error('assistant_profile_account_changed')
  }

  $atumPortableBusy.set(agent.hostedId)

  try {
    const materialize = atumMessagingClient().materializeAssistant

    if (!materialize) {
      throw new Error('assistant_portability_unavailable')
    }

    const result = await materialize(agent.hostedId)

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    if (!result.ok) {
      if (result.status === 'missing_skills') {
        throw new Error('assistant_missing_skills')
      }

      throw new Error('assistant_materialize_failed')
    }

    rememberDefinitionBase(agent.hostedId, result.profile)

    await refreshProfiles()

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    return result.profile.name
  } finally {
    if (isAtumAssistantDirectoryScopeCurrent(scope)) {
      $atumPortableBusy.set(null)
    }
  }
}

/** Recovery for a metadata-only hosted identity. Main searches only the
 * current account's legacy managed profiles by the already-owned identity,
 * exports the frozen allowlist, then materializes it into this account root.
 * It never guesses from a display name or imports another account's profile. */
export async function recoverLegacyPortableAtumAgent(agent: AtumAgent): Promise<string> {
  if (!agent.hostedId || agent.definitionState !== 'local_only') {
    throw new Error('assistant_profile_unavailable')
  }

  const scope = captureAtumAssistantDirectoryScope()

  if (!scope.accountId) {
    throw new Error('assistant_profile_account_changed')
  }

  const client = atumMessagingClient()

  if (!client.importLegacyAssistant) {
    throw new Error('assistant_portability_unavailable')
  }

  $atumPortableBusy.set(agent.hostedId)

  try {
    const result = await client.importLegacyAssistant(agent.hostedId)

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    if (!result.ok) {
      if (result.status === 'legacy_source_absent') {
        throw new Error('assistant_source_computer_needed')
      }

      if (result.status === 'missing_skills') {
        throw new Error('assistant_missing_skills')
      }

      throw new Error('assistant_definition_exists')
    }

    rememberDefinitionBase(agent.hostedId, result.profile)

    await Promise.all([refreshAtumAssistantDirectory(), refreshProfiles()])

    if (!isAtumAssistantDirectoryScopeCurrent(scope)) {
      throw new Error('assistant_profile_account_changed')
    }

    return result.profile.name
  } finally {
    if (isAtumAssistantDirectoryScopeCurrent(scope)) {
      $atumPortableBusy.set(null)
    }
  }
}
