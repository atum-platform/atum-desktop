import { atom, computed } from 'nanostores'

import { ATUM_AVATAR_CONTENT_TYPES, ATUM_AVATAR_MAX_BYTES, putAtumAvatarUpload } from '@/lib/atum-avatar'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { $atumAccountScopeId, $atumAccountStatus, $atumIsAuthenticated } from '@/store/atum-messaging'

import type { ParticipantDisplay } from '../../../shared/atum-participants'

/** A hosted identity is account-scoped server truth. It never reaches disk. */
export interface AtumAssistantDirectoryEntry {
  avatar?: string
  avatarUrl: null | string
  displayName: string
  id: string
  identityId: null | string
  isDefault: boolean
  lifecycleRevision: number
  /** Private definition clock. Zero means the source device has not uploaded it. */
  definitionRevision?: number
  /** Hosted display/lifecycle clock. Never use lifecycleRevision as a sync CAS. */
  identityRevision?: number
  status: 'active' | 'retired'
}

export interface AtumAssistantDirectory {
  accountId: null | string
  entries: readonly AtumAssistantDirectoryEntry[]
  state: 'empty' | 'error' | 'ready'
}

const EMPTY_DIRECTORY: AtumAssistantDirectory = { accountId: null, entries: [], state: 'empty' }

/** The sole hosted assistant directory for this account. */
export const $atumAssistantDirectory = atom<AtumAssistantDirectory>(EMPTY_DIRECTORY)

const $directoryAccount = computed(
  [$atumIsAuthenticated, $atumAccountScopeId, $atumAccountStatus],
  (authenticated, scope, account) => (authenticated && scope && scope === account.account?.id ? scope : null)
)

// Account identity alone cannot distinguish A → B → A from a request that
// started in the later A. Increment on every observed swap so an old response
// cannot repopulate a newly re-entered account.
let generation = 0
// Any local photo/name mutation invalidates reads and registration results
// started before it. Server photo revision stays internal; this client-side
// epoch only orders the renderer cache.
let writeEpoch = 0

$directoryAccount.listen(accountId => {
  generation += 1
  $atumAssistantDirectory.set(accountId ? { accountId, entries: [], state: 'empty' } : EMPTY_DIRECTORY)
})

function isCurrent(accountId: string, requestGeneration: number): boolean {
  return $directoryAccount.get() === accountId && generation === requestGeneration
}

export interface AtumAssistantDirectoryScope {
  accountId: null | string
  generation: number
}

/** Capture the account fence before a UI operation crosses local async work. */
export function captureAtumAssistantDirectoryScope(): AtumAssistantDirectoryScope {
  return { accountId: $directoryAccount.get(), generation }
}

export function isAtumAssistantDirectoryScopeCurrent(scope: AtumAssistantDirectoryScope): boolean {
  return $directoryAccount.get() === scope.accountId && generation === scope.generation
}

export function atumAssistantDirectoryWriteEpoch(): number {
  return writeEpoch
}

function normalize(row: {
  avatar?: string
  avatarUrl?: null | string
  displayName: string
  id: string
  identityId: null | string
  isDefault: boolean
  lifecycleRevision: number
  definitionRevision?: number
  identityRevision?: number
  status: 'active' | 'retired'
}): AtumAssistantDirectoryEntry {
  return {
    avatar: row.avatar ?? '',
    avatarUrl: row.avatarUrl ?? null,
    displayName: row.displayName,
    id: row.id,
    identityId: row.identityId,
    isDefault: row.isDefault,
    lifecycleRevision: row.lifecycleRevision,
    definitionRevision: row.definitionRevision ?? 0,
    identityRevision: row.identityRevision ?? 1,
    status: row.status
  }
}

/** Fold one authoritative row into the current account's directory. */
export function recordAtumAssistantDirectoryEntry(
  row: Parameters<typeof normalize>[0],
  accountId = $directoryAccount.get(),
  requestGeneration = generation,
  options: { invalidateOlderReads?: boolean; writeEpoch?: number } = {}
): void {
  if (
    !accountId ||
    !isCurrent(accountId, requestGeneration) ||
    (options.writeEpoch !== undefined && options.writeEpoch !== writeEpoch)
  ) {
    return
  }

  if (options.invalidateOlderReads) {
    writeEpoch += 1
  }

  const entry = normalize(row)
  const current = $atumAssistantDirectory.get()
  const entries = current.accountId === accountId ? current.entries : []
  const index = entries.findIndex(candidate => candidate.id === entry.id)
  const next = index < 0 ? [...entries, entry] : entries.map((candidate, i) => (i === index ? entry : candidate))

  $atumAssistantDirectory.set({ accountId, entries: next, state: 'ready' })
}

/** Refresh the hosted directory. A failure retains known rows for this account. */
export async function refreshAtumAssistantDirectory(): Promise<void> {
  const accountId = $directoryAccount.get()
  const requestGeneration = generation
  const requestWriteEpoch = writeEpoch

  if (!accountId) {
    return
  }

  try {
    const rows = await atumMessagingClient().listAssistants()

    if (!isCurrent(accountId, requestGeneration) || requestWriteEpoch !== writeEpoch) {
      return
    }

    $atumAssistantDirectory.set({ accountId, entries: rows.map(normalize), state: 'ready' })
  } catch {
    if (!isCurrent(accountId, requestGeneration) || requestWriteEpoch !== writeEpoch) {
      return
    }

    const current = $atumAssistantDirectory.get()
    $atumAssistantDirectory.set({
      accountId,
      entries: current.accountId === accountId ? current.entries : [],
      state: 'error'
    })
  }
}

/** Starts account-scoped refreshes while the Atum shell is mounted. */
export function startAtumAssistantDirectory(): () => void {
  let previous: null | string | undefined

  return $directoryAccount.subscribe(accountId => {
    if (accountId === previous) {
      return
    }

    previous = accountId

    if (accountId) {
      void refreshAtumAssistantDirectory()
    }
  })
}

export function hostedAtumAssistant(
  directory: AtumAssistantDirectory,
  identityId: string,
  isDefault: boolean
): AtumAssistantDirectoryEntry | null {
  return (
    directory.entries.find(entry => entry.identityId === identityId && Boolean(identityId)) ??
    (isDefault ? (directory.entries.find(entry => entry.isDefault) ?? null) : null)
  )
}

/**
 * Project a hosted assistant only when the current account can name both the
 * assistant and its owner. Local profiles remain routable without this
 * projection while registration is pending.
 */
export function displayAtumAssistant(
  directory: AtumAssistantDirectory,
  identityId: string,
  isDefault: boolean
): ParticipantDisplay | undefined {
  const assistant = hostedAtumAssistant(directory, identityId, isDefault)

  if (!assistant || !directory.accountId) {
    return undefined
  }

  return {
    kind: 'assistant',
    id: assistant.id,
    displayName: assistant.displayName,
    ...(assistant.avatarUrl ? { avatarUrl: assistant.avatarUrl } : {}),
    ownerUserId: directory.accountId
  }
}

export type AtumAssistantAvatarFailure = 'too_large' | 'wrong_type'

export function validateAtumAssistantAvatar(file: Pick<File, 'size' | 'type'>): AtumAssistantAvatarFailure | null {
  if (!ATUM_AVATAR_CONTENT_TYPES.includes(file.type as (typeof ATUM_AVATAR_CONTENT_TYPES)[number])) {
    return 'wrong_type'
  }

  return file.size > ATUM_AVATAR_MAX_BYTES ? 'too_large' : null
}

/** Upload a staged image to a resolved hosted assistant row. */
export async function uploadAtumAssistantAvatar(
  assistantId: string,
  file: File,
  onProgress: (progress: number) => void
): Promise<AtumAssistantDirectoryEntry> {
  const invalid = validateAtumAssistantAvatar(file)

  if (invalid) {
    throw new Error(`assistant_avatar_${invalid}`)
  }

  const accountId = $directoryAccount.get()
  const requestGeneration = generation

  if (!accountId) {
    throw new Error('assistant_avatar_account_changed')
  }

  const client = atumMessagingClient()
  const reservation = await client.createAssistantAvatarUpload(assistantId, { contentType: file.type })

  if (!isCurrent(accountId, requestGeneration)) {
    throw new Error('assistant_avatar_account_changed')
  }

  await putAtumAvatarUpload(file, reservation, onProgress)

  if (!isCurrent(accountId, requestGeneration)) {
    throw new Error('assistant_avatar_account_changed')
  }

  const row = await client.completeAssistantAvatarUpload(assistantId, reservation.uploadId)

  if (!isCurrent(accountId, requestGeneration)) {
    throw new Error('assistant_avatar_account_changed')
  }

  recordAtumAssistantDirectoryEntry(row, accountId, requestGeneration, { invalidateOlderReads: true })

  return normalize(row)
}

export async function clearAtumAssistantAvatar(assistantId: string): Promise<AtumAssistantDirectoryEntry> {
  const accountId = $directoryAccount.get()
  const requestGeneration = generation

  if (!accountId) {
    throw new Error('assistant_avatar_account_changed')
  }

  const row = await atumMessagingClient().clearAssistantAvatar(assistantId)

  if (!isCurrent(accountId, requestGeneration)) {
    throw new Error('assistant_avatar_account_changed')
  }

  recordAtumAssistantDirectoryEntry(row, accountId, requestGeneration, { invalidateOlderReads: true })

  return normalize(row)
}

/** The master name is hosted identity, written through registry revision + 1. */
export async function renameAtumMasterAssistant(input: {
  avatar: string
  identityId: string
  name: string
}): Promise<AtumAssistantDirectoryEntry> {
  const accountId = $directoryAccount.get()
  const requestGeneration = generation
  const directory = $atumAssistantDirectory.get()
  const current = hostedAtumAssistant(directory, input.identityId, true)

  if (!accountId || !current || !current.isDefault || current.identityId !== input.identityId) {
    throw new Error('assistant_profile_unavailable')
  }

  const result = await atumMessagingClient().registerAssistant({
    avatar: input.avatar,
    displayName: input.name,
    identityId: input.identityId,
    isDefault: true,
    lifecycleRevision: current.lifecycleRevision + 1
  })

  if (!isCurrent(accountId, requestGeneration)) {
    throw new Error('assistant_profile_account_changed')
  }

  if (result.outcome === 'stale') {
    recordAtumAssistantDirectoryEntry(result.assistant, accountId, requestGeneration, { invalidateOlderReads: true })
    throw new Error('assistant_profile_stale')
  }

  if (result.outcome !== 'registered') {
    throw new Error('assistant_profile_adopt')
  }

  recordAtumAssistantDirectoryEntry(result.assistant, accountId, requestGeneration, { invalidateOlderReads: true })

  return normalize(result.assistant)
}
