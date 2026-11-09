import { map } from 'nanostores'

import type { MatrixRoom } from '../../../shared/matrix'
import type { MatrixCompanyBridge, MatrixCompanyErrorCode } from '../../../shared/matrix-company'

import type { TeamSpaceProfile } from './abilities'
import { teamSpaceKey } from './keys'
import { requestTeamSpace } from './request'
import { type CompanyConversationView, conversationViewFrom15 } from './views'

/**
 * Each company's conversation directory (company DMs and group DMs) as the platform lists it for this
 * person: wire 1.5, read only when discovery says the family is on. A conversation's audience is its
 * participant set, not the company, so this directory is the single authority for what a person sees
 * of it: a room that merely claims the type is not a conversation until it is listed here.
 *
 * Shared on purpose: the sidebar section, the open conversation's composer and banner read the same
 * directory, and none of them re-asks the platform.
 */
export interface CompanyConversationsState {
  conversations: readonly CompanyConversationView[]
  loading: boolean
  error?: MatrixCompanyErrorCode
  /**
   * The last good list, kept on screen through a transient failure to read it again. It is something to read, not
   * authority: a stale directory opens no composer and offers no change until a read succeeds.
   */
  stale?: true
}

/** Refusals that end the authority outright; anything else (the network, a rate limit) may pass. */
const DEFINITIVE: ReadonlySet<MatrixCompanyErrorCode> = new Set(['authentication', 'denied', 'invalid', 'missing'])

/** The directory can authorize what it lists: it was read, it is not refused, and it is not a leftover. */
export function conversationAuthority(state: CompanyConversationsState | undefined): state is CompanyConversationsState {
  return Boolean(state) && !state?.error && !state?.stale
}

export const $companyConversations = map<Record<string, CompanyConversationsState>>({})

// One sequence for every key, so an attempt number is never reused after a clear.
let sequence = 0
const attempts = new Map<string, number>()

export function clearCompanyConversations(accountKey: string, companyId?: string): void {
  const doomed = (key: string) =>
    companyId ? key === teamSpaceKey(accountKey, companyId) : key.startsWith(`${accountKey}\n`)

  for (const key of attempts.keys()) {
    if (doomed(key)) {
      attempts.delete(key)
    }
  }

  $companyConversations.set(
    Object.fromEntries(Object.entries($companyConversations.get()).filter(([key]) => !doomed(key)))
  )
}

/**
 * Read one company's directory. A newer read supersedes an older one. A failed foreground read clears
 * the list and says why; a failed quiet read keeps the last good list. Privacy never widens: a directory
 * is replaced wholesale by the next one, never merged, so a conversation that left the answer (a removed
 * participant) leaves the screen.
 */
export async function loadCompanyConversations(
  bridge: MatrixCompanyBridge,
  accountKey: string,
  companyId: string,
  profile: Pick<TeamSpaceProfile, 'conversations'>,
  options: { quiet?: boolean } = {}
): Promise<CompanyConversationsState | undefined> {
  const key = teamSpaceKey(accountKey, companyId)

  if (!profile.conversations) {
    // The family is off (or not discovered yet): nothing is asked, and nothing from an earlier answer is kept.
    if ($companyConversations.get()[key]) {
      clearCompanyConversations(accountKey, companyId)
    }

    return undefined
  }

  const attempt = ++sequence
  attempts.set(key, attempt)
  const before = $companyConversations.get()[key]

  if (!options.quiet) {
    // A list that was stale or refused does not become authority because a new read has started.
    $companyConversations.setKey(key, {
      conversations: before?.error ? [] : (before?.conversations ?? []),
      loading: true,
      ...(before?.stale || before?.error ? { stale: true as const } : {})
    })
  }

  const result = await requestTeamSpace(bridge, { action: 'conversations', companyId })

  const next: CompanyConversationsState = result.ok
    ? { conversations: result.value.conversations.map(conversationViewFrom15), loading: false }
    : { conversations: [], loading: false, error: result.error }

  if (attempts.get(key) !== attempt) {
    return $companyConversations.get()[key] ?? next
  }

  if (next.error !== undefined && options.quiet && before && !before.error && !DEFINITIVE.has(next.error)) {
    // A passing failure: the last good list stays to be read, marked stale so it authorizes nothing. A refusal
    // (denied, missing, invalid) is not passing: it empties the directory below.
    const kept: CompanyConversationsState = { ...before, loading: false, stale: true }

    $companyConversations.setKey(key, kept)

    return kept
  }

  $companyConversations.setKey(key, next)

  return next
}

/** The listed conversation that lives in this Matrix room, if the platform lists one: the room's own claim is not enough. */
export function conversationViewForRoom(
  state: CompanyConversationsState | undefined,
  room: Pick<MatrixRoom, 'id' | 'companyConversation'> | null | undefined
): CompanyConversationView | undefined {
  const conversationId = room?.companyConversation?.conversationId

  // Only a directory that can authorize confirms a room: a refused or stale one confirms nothing.
  return conversationId && conversationAuthority(state)
    ? state?.conversations.find(
        conversation =>
          conversation.id === conversationId && conversation.room.state === 'ready' && conversation.room.roomId === room?.id
      )
    : undefined
}

/**
 * The viewer's own member ref in each company, published by the workspace once it has the roster: the open
 * conversation's header names a DM for the other person, which needs to know who "me" is.
 */
export const $companySelfRefs = map<Record<string, string>>({})

export function publishCompanySelfRef(accountKey: string, companyId: string, memberRef: string | undefined): void {
  const key = teamSpaceKey(accountKey, companyId)

  if (memberRef && $companySelfRefs.get()[key] !== memberRef) {
    $companySelfRefs.setKey(key, memberRef)
  }
}

export function clearCompanySelfRefs(accountKey: string): void {
  $companySelfRefs.set(
    Object.fromEntries(Object.entries($companySelfRefs.get()).filter(([key]) => !key.startsWith(`${accountKey}\n`)))
  )
}
