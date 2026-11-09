import { atom, computed } from 'nanostores'

import type { Locale } from '@/i18n'
import { translateNow } from '@/i18n/runtime'
import type { AtumAccountStatus } from '@/lib/atum-account-facts'
import { ATUM_AUTH_FAILURE_CODES } from '@/lib/atum-auth'
import {
  atumDirectMessagingClient,
  type AtumDirectConversation as AtumMessagingConversation,
  type AtumDirectMessage as AtumMessagingMessage,
  type AtumDirectSyncStatus as AtumMessagingSyncStatus,
  type AtumDirectTransportStatus as AtumMessagingTransportStatus
} from '@/lib/atum-direct-messaging-client'
import { atumMessagingClient, type AtumSocialProjection } from '@/lib/atum-messaging-client'
import { ATUM_ADDRESSED_MENTIONS_CONTRACT, type AtumAddressedMentions } from '@/lib/atum-messaging-client'
import { reportProductEvent } from '@/lib/atum-reporting'

import type { GroupQuotedMessage } from '../../shared/atum-group-conversations'

import { dispatchHostedDmNotification } from './native-notifications'
import { notifyError } from './notifications'
import { $dirtyPreviewUrls } from './preview-edit'

interface AtumAccountBoundary {
  status(): Promise<AtumAccountStatus>
  retryRestore(): Promise<AtumAccountStatus>
  signIn(): Promise<AtumAccountStatus>
  signInWithPassword(credentials: { identifier: string; password: string }): Promise<AtumAccountStatus>
  cancel(): Promise<AtumAccountStatus>
  signOut(): Promise<AtumAccountStatus>
}

interface AtumMessagingComposition {
  account(): AtumAccountBoundary
  clearDependentState(): void
  /** Local preview metadata is not user data. Clear it at the same explicit
   * account boundary as DM workspaces so opaque file-view tokens cannot be
   * restored into another account's renderer. */
  clearPreviewState(): void
  ensureSpecialistConversation(specialist: string): Promise<{ conversationId: string }>
  presentArtifactIntents(conversationId: string, resourceRefs: unknown): void
  setDependentAccount(accountId: string | null): void
}

let messagingComposition: AtumMessagingComposition | null = null

/** Called once by the Atum renderer composition root, never by the S5 engine. */
export function configureAtumMessagingComposition(composition: AtumMessagingComposition): void {
  messagingComposition = composition
}

function composition(): AtumMessagingComposition {
  if (!messagingComposition) {
    throw new Error('Atum messaging composition is unavailable')
  }

  return messagingComposition
}

export const $atumAccountStatus = atom<AtumAccountStatus>({
  state: 'unconfigured',
  configured: false,
  account: null,
  errorCode: null,
  providers: { google: false, password: false }
})
export const $atumStatus = atom<AtumMessagingSyncStatus | null>(null)
export const $atumAccountScopeId = computed(
  [$atumStatus, $atumAccountStatus],
  (status, account) => status?.accountId ?? account.account?.id ?? null
)
export const $atumRoster = atom<AtumMessagingConversation[]>([])
export const $atumSocialRelationships = atom<AtumSocialProjection[]>([])
export const $atumActiveConversationId = atom<string | null>(null)
export const $atumMessages = atom<Record<string, AtumMessagingMessage[]>>({})
export const $atumDrafts = atom<Record<string, string>>({})
export const $atumTransportStatus = atom<AtumMessagingTransportStatus>({
  accountId: null,
  healthy: false,
  state: 'disabled'
})
export type AtumOlderHistoryState = 'idle' | 'loading' | 'exhausted' | 'error'
export const $atumOlderHistory = atom<Record<string, AtumOlderHistoryState>>({})
export const $atumReplyTo = atom<Record<string, string | null>>({})
export const $atumTyping = atom<Record<string, boolean>>({})
export const $atumRemovedGroups = atom<Record<string, boolean>>({})
const groupGenerations = new Map<string, number>()
const draftGenerations = new Map<string, number>()
const dirtyLocalDrafts = new Set<string>()

function roomGeneration(id: string): number {
  return groupGenerations.get(id) ?? 0
}

function draftGeneration(id: string): number {
  return draftGenerations.get(id) ?? 0
}

function clearGroupProjection(id: string): void {
  groupGenerations.set(id, roomGeneration(id) + 1)
  draftGenerations.delete(id)
  dirtyLocalDrafts.delete(id)

  for (const state of [$atumMessages, $atumDrafts, $atumOlderHistory, $atumReplyTo, $atumTyping]) {
    const copy = { ...state.get() }
    delete copy[id]
    state.set(copy as never)
  }
}

export const $atumConnectivity = computed($atumStatus, status => status?.connectivity ?? 'loading')
export const $atumIsAuthenticated = computed(
  [$atumAccountStatus, $atumStatus],
  (account, status) => (account.state === 'signed_in' || account.state === 'refreshing') && Boolean(status?.accountId)
)
export const $atumSortedRoster = computed($atumRoster, roster =>
  [...roster].sort((left, right) =>
    (right.lastMessageAt ?? right.updatedAt).localeCompare(left.lastMessageAt ?? left.updatedAt)
  )
)
export const $atumActiveMessages = computed([$atumActiveConversationId, $atumMessages], (conversationId, messages) =>
  conversationId ? [...(messages[conversationId] ?? [])].sort(compareMessages) : []
)

let accountEpoch = 0
let pollingTimer: ReturnType<typeof setTimeout> | null = null
let initialized = false
let stopDesktopMessagingEvents: (() => void) | null = null
const presentationHydratedConversations = new Set<string>()
const consumedPresentationMessages = new Set<string>()

function compareMessages(left: AtumMessagingMessage, right: AtumMessagingMessage): number {
  return left.createdAt.localeCompare(right.createdAt) || left.localId.localeCompare(right.localId)
}

function mergeMessages(
  current: readonly AtumMessagingMessage[],
  incoming: readonly AtumMessagingMessage[]
): AtumMessagingMessage[] {
  const merged: AtumMessagingMessage[] = []

  const upsert = (message: AtumMessagingMessage): void => {
    const index = merged.findIndex(
      candidate =>
        (Boolean(message.id) && candidate.id === message.id) ||
        candidate.localId === message.localId ||
        (Boolean(message.clientMessageId) &&
          candidate.clientMessageId === message.clientMessageId &&
          // Client ids reconcile the renderer-owned optimistic row with its
          // canonical echo. Do not let malformed historical rows that reuse a
          // client id collapse otherwise distinct canonical messages.
          (candidate.optimistic || message.optimistic || !candidate.id || !message.id))
    )

    if (index === -1) {
      merged.push(message)

      return
    }

    merged[index] = message
  }

  for (const message of current) {
    upsert(message)
  }

  for (const message of incoming) {
    upsert(message)
  }

  return merged.sort(compareMessages)
}

function errorStatus(code: string): AtumMessagingSyncStatus {
  const previous = $atumStatus.get()

  return {
    accountId: previous?.accountId ?? null,
    connectivity: 'error',
    synchronized: false,
    cursor: previous?.cursor ?? null,
    lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt ?? null,
    nextRetryAt: null,
    errorCode: code
  }
}

/** Cleared on account replacement so a new account performs its own recovery drain. */
let mentionRecoveryAttempted = false

function clearAccountScopedState(requireComposition = false): void {
  mentionRecoveryAttempted = false
  accountEpoch += 1
  groupGenerations.clear()
  draftGenerations.clear()
  dirtyLocalDrafts.clear()
  $atumRemovedGroups.set({})
  presentationHydratedConversations.clear()
  consumedPresentationMessages.clear()

  if (requireComposition) {
    composition().clearDependentState()
    composition().clearPreviewState()
  } else {
    // Deterministic test reset may run before the application composition root.
    messagingComposition?.clearDependentState()
    messagingComposition?.clearPreviewState()
  }

  $atumStatus.set(null)
  $atumRoster.set([])
  $atumSocialRelationships.set([])
  $atumMessages.set({})
  $atumDrafts.set({})
  $atumOlderHistory.set({})
  $atumReplyTo.set({})
  $atumTyping.set({})
  $atumTransportStatus.set({ accountId: null, healthy: false, state: 'disabled' })
  $atumActiveConversationId.set(null)
}

function messageIdentity(message: AtumMessagingMessage): string {
  return message.id ?? message.localId
}

/**
 * Present only exact, typed targets on newly reconciled provider messages.
 *
 * The first history read establishes a replay baseline: reopening a
 * conversation (or the app) must not replay an old focus request. Subsequent
 * reads compare canonical message identity, so polling/retry delivery of the
 * same message is idempotent. The workspace store repeats the foreground guard
 * at the presentation boundary.
 */
function presentNewForegroundArtifacts(
  conversationId: string,
  previous: readonly AtumMessagingMessage[],
  incoming: readonly AtumMessagingMessage[]
): void {
  const hydrated = presentationHydratedConversations.has(conversationId)
  presentationHydratedConversations.add(conversationId)

  const unseen = [...incoming].sort(compareMessages).filter(message => {
    const key = `${conversationId}:${messageIdentity(message)}`

    if (consumedPresentationMessages.has(key)) {
      return false
    }

    consumedPresentationMessages.add(key)

    return true
  })

  if (!hydrated || $atumActiveConversationId.get() !== conversationId) {
    return
  }

  const conversation = $atumRoster.get().find(candidate => candidate.id === conversationId)

  if (conversation?.kind !== 'specialist') {
    return
  }

  const previousIds = new Set(previous.map(messageIdentity))

  for (const message of unseen) {
    if (
      previousIds.has(messageIdentity(message)) ||
      message.optimistic ||
      message.recalledAt ||
      (message.sender.type !== 'specialist' && message.sender.type !== 'agent')
    ) {
      continue
    }

    composition().presentArtifactIntents(conversationId, message.metadata?.resource_refs)
  }
}

export function currentAccountScopeId(): string | null {
  return $atumAccountScopeId.get()
}

function applyAccountStatus(next: AtumAccountStatus, options: { preserveSignedOut?: boolean } = {}): void {
  const previousScopeId = currentAccountScopeId()
  const nextId = next.account?.id ?? null
  const explicitlySignedOut = next.state === 'signed_out' || next.state === 'unconfigured'
  const switchedIdentity = Boolean(previousScopeId && nextId && previousScopeId !== nextId)

  // Expiry, refresh, and transient auth failures are not account-boundary
  // transitions. Keep that account's encrypted SQLite projection and drafts so
  // reauthentication is a recoverable pause rather than destructive logout.
  if (switchedIdentity || (previousScopeId && explicitlySignedOut && !options.preserveSignedOut)) {
    clearAccountScopedState(true)
  }

  if (next.state === 'signed_in' && $atumAccountStatus.get().state === 'signing_in') {
    reportProductEvent('onboarding_step_completed', { step: 'signin' })
  }

  $atumAccountStatus.set(next)
  composition().setDependentAccount(currentAccountScopeId())
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'atum_messaging_error'
}

export async function refreshAtumAccountStatus(): Promise<AtumAccountStatus> {
  try {
    const next = await composition().account().status()
    applyAccountStatus(next)

    return next
  } catch (error) {
    const previous = $atumAccountStatus.get()

    // A status REFRESH that throws is a transport failure, not a verdict on the
    // session. `state: 'error'` is what the shell gates on, so letting a dropped
    // request land here replaces the whole app with the sign-in wall — and the
    // wall accuses the user of a sign-in they never attempted. A poll runs on a
    // timer, so one bad minute of network reads as being logged out at random.
    //
    // Nothing was learned about the session, so nothing about it changes. A real
    // expiry arrives as an `expired` STATUS from the host, not as a thrown
    // request.
    if (previous.state === 'signed_in' || previous.state === 'refreshing') {
      return previous
    }

    const code = errorCode(error)

    const next: AtumAccountStatus = {
      state: 'error',
      configured: previous.configured,
      account: previous.account,
      // `authFailureKind` answers 'local' for anything it does not recognise,
      // and 'local' reads as "restart Atum" — blaming the device for what a
      // thrown request usually is: an unreachable host. Keep the code only when
      // it is one the classifier actually knows.
      errorCode: code in ATUM_AUTH_FAILURE_CODES ? code : 'hosted_session_unavailable',
      providers: previous.providers
    }

    applyAccountStatus(next)

    return next
  }
}

/** Explicit retry of saved-session verification, not OAuth or a cached status poll. */
export async function retryAtumAccountRestore(): Promise<boolean> {
  const epoch = accountEpoch

  try {
    const next = await composition().account().retryRestore()

    if (epoch !== accountEpoch) {
      return false
    }

    applyAccountStatus(next, { preserveSignedOut: true })

    if (next.state === 'signed_in') {
      await Promise.all([refreshAtumStatus(), refreshAtumRoster()])
    }

    return next.state === 'signed_in'
  } catch {
    // Transport failure did not reject or erase the saved credentials.
    // Leave the existing notice and explicit retry available.
    return false
  }
}

export async function refreshAtumStatus(): Promise<AtumMessagingSyncStatus | null> {
  const epoch = accountEpoch

  try {
    const status = await atumDirectMessagingClient().status()

    if (epoch === accountEpoch) {
      $atumStatus.set(status)
      composition().setDependentAccount(currentAccountScopeId())
    }

    return epoch === accountEpoch ? status : null
  } catch (error) {
    if (epoch === accountEpoch) {
      $atumStatus.set(errorStatus(errorCode(error)))
    }

    return null
  }
}

export async function refreshAtumRoster(): Promise<AtumMessagingConversation[]> {
  const epoch = accountEpoch

  try {
    const roster = await atumDirectMessagingClient().roster(500)

    if (epoch === accountEpoch) {
      const removed = { ...$atumRemovedGroups.get() }

      for (const previous of $atumRoster.get().filter(row => row.kind === 'group')) {
        const next = roster.find(row => row.id === previous.id)

        if (!next || next.group?.membershipEpoch !== previous.group?.membershipEpoch) {
          clearGroupProjection(previous.id)
          removed[previous.id] = !next
        }
      }

      for (const row of roster) {
        if (row.kind === 'group') {
          delete removed[row.id]
        }
      }

      $atumRemovedGroups.set(removed)
      $atumRoster.set(roster)
    }

    return epoch === accountEpoch ? roster : []
  } catch (error) {
    if (epoch === accountEpoch) {
      $atumStatus.set(errorStatus(errorCode(error)))
    }

    return []
  }
}

function publishSocialProjection(projection: AtumSocialProjection): void {
  if (projection.availability === 'unavailable') {
    return
  }

  const current = $atumSocialRelationships.get()
  $atumSocialRelationships.set([
    projection,
    ...current.filter(row => row.availability !== 'available' || row.profile.profileId !== projection.profile.profileId)
  ])

  if (!projection.canMessage && projection.directThreadId) {
    $atumDrafts.set({ ...$atumDrafts.get(), [projection.directThreadId]: '' })
    $atumMessages.set({
      ...$atumMessages.get(),
      [projection.directThreadId]: ($atumMessages.get()[projection.directThreadId] ?? []).filter(
        message => !message.optimistic
      )
    })
  }
}

function replaceSocialRelationships(relationships: AtumSocialProjection[]): void {
  const nextProfileIds = new Set(
    relationships.filter(row => row.availability === 'available').map(row => row.profile.profileId)
  )

  for (const previous of $atumSocialRelationships.get()) {
    if (
      previous.availability === 'available' &&
      !nextProfileIds.has(previous.profile.profileId) &&
      previous.directThreadId
    ) {
      $atumDrafts.set({ ...$atumDrafts.get(), [previous.directThreadId]: '' })
      $atumMessages.set({
        ...$atumMessages.get(),
        [previous.directThreadId]: ($atumMessages.get()[previous.directThreadId] ?? []).filter(
          message => !message.optimistic
        )
      })
    }
  }

  $atumSocialRelationships.set(relationships)
}

export async function refreshAtumSocialRelationships(): Promise<AtumSocialProjection[]> {
  const epoch = accountEpoch
  const relationships = await atumDirectMessagingClient().socialRelationships()

  if (epoch !== accountEpoch) {
    return []
  }

  replaceSocialRelationships(relationships)

  return relationships
}

export async function lookupAtumSocial(query: string): Promise<AtumSocialProjection | null> {
  const epoch = accountEpoch
  const projection = await atumDirectMessagingClient().socialLookup(query)

  if (epoch !== accountEpoch) {
    return null
  }

  if (projection.availability === 'unavailable') {
    const normalized = query.trim().replace(/^@/u, '').toLowerCase()
    replaceSocialRelationships(
      $atumSocialRelationships
        .get()
        .filter(row => row.availability !== 'available' || row.profile.handle !== normalized)
    )
  } else {
    publishSocialProjection(projection)
  }

  return projection
}

export async function mutateAtumSocial(
  action: 'request' | 'accept' | 'decline' | 'block' | 'unblock',
  targetProfileId: string
): Promise<AtumSocialProjection | null> {
  const epoch = accountEpoch
  const projection = await atumDirectMessagingClient().socialMutate(action, targetProfileId)

  if (epoch !== accountEpoch) {
    return null
  }

  publishSocialProjection(projection)
  await refreshAtumRoster()

  return projection
}

export async function ensureAtumSpecialistConversation(specialist: string): Promise<string> {
  const epoch = accountEpoch
  const { conversationId } = await composition().ensureSpecialistConversation(specialist)

  if (epoch !== accountEpoch) {
    throw new Error('atum_account_changed')
  }

  // The roster refresh only decides how this app is listed afterwards, so the
  // caller must not wait for a second round trip to open the conversation it
  // already has. Until it lands the caller has navigated, and the panel it
  // navigated to is the one on screen.
  void refreshAtumRoster().catch(() => undefined)

  return conversationId
}

function isWindowFocused(): boolean {
  return typeof document === 'undefined' || (!document.hidden && document.hasFocus())
}

export async function loadAtumMessages(
  conversationId: string,
  options: { markRead?: boolean; notifyNew?: boolean } = { markRead: true }
): Promise<AtumMessagingMessage[]> {
  const epoch = accountEpoch
  const roomEpoch = roomGeneration(conversationId)
  const draftRevision = draftGeneration(conversationId)

  if ($atumRemovedGroups.get()[conversationId]) {
    return []
  }

  try {
    const [messages, draft] = await Promise.all([
      atumDirectMessagingClient().messages(conversationId, 100),
      atumDirectMessagingClient().draft(conversationId)
    ])

    if (epoch !== accountEpoch || roomEpoch !== roomGeneration(conversationId)) {
      return []
    }

    const previous = $atumMessages.get()[conversationId] ?? []
    $atumMessages.set({ ...$atumMessages.get(), [conversationId]: mergeMessages(previous, messages) })
    presentNewForegroundArtifacts(conversationId, previous, messages)

    if (draft && !dirtyLocalDrafts.has(conversationId) && draftRevision === draftGeneration(conversationId)) {
      $atumDrafts.set({ ...$atumDrafts.get(), [conversationId]: draft.text })
    }

    if (options.notifyNew) {
      const previousIds = new Set(previous.map(message => message.id).filter(Boolean))
      const accountId = currentAccountScopeId()

      const incoming = messages.find(
        message => message.id && !previousIds.has(message.id) && message.sender.id !== accountId
      )

      if (incoming && ($atumActiveConversationId.get() !== conversationId || !isWindowFocused())) {
        const sender = $atumRoster.get().find(conversation => conversation.id === conversationId)?.title
        dispatchHostedDmNotification({
          conversationId,
          title: sender || translateNow('ws3.hostedDm.title'),
          body: incoming.content.trim().slice(0, 180) || translateNow('ws3.hostedDm.body')
        })
      }
    }

    const newestCanonical = [...messages]
      .sort(compareMessages)
      .reverse()
      .find(message => message.id)

    if (options.markRead !== false && newestCanonical?.id) {
      try {
        if (epoch !== accountEpoch || roomEpoch !== roomGeneration(conversationId)) {
          return []
        }

        await atumDirectMessagingClient().markRead(conversationId, newestCanonical.id)

        if (epoch === accountEpoch && roomEpoch === roomGeneration(conversationId)) {
          await refreshAtumRoster()
        }
      } catch (error) {
        if (epoch === accountEpoch && roomEpoch === roomGeneration(conversationId)) {
          $atumStatus.set(errorStatus(errorCode(error)))
        }
      }
    }

    return messages
  } catch (error) {
    if (epoch === accountEpoch && roomEpoch === roomGeneration(conversationId)) {
      $atumStatus.set(errorStatus(errorCode(error)))
    }

    return []
  }
}

export async function loadOlderAtumMessages(conversationId: string): Promise<AtumMessagingMessage[]> {
  const epoch = accountEpoch
  const roomEpoch = roomGeneration(conversationId)

  if ($atumRemovedGroups.get()[conversationId]) {
    return []
  }

  if ($atumOlderHistory.get()[conversationId] === 'loading') {
    return $atumMessages.get()[conversationId] ?? []
  }

  $atumOlderHistory.set({ ...$atumOlderHistory.get(), [conversationId]: 'loading' })

  try {
    const page = await atumDirectMessagingClient().loadOlderMessages(conversationId, 100)

    if (epoch !== accountEpoch || roomEpoch !== roomGeneration(conversationId)) {
      return []
    }

    const merged = mergeMessages($atumMessages.get()[conversationId] ?? [], page.messages)
    $atumMessages.set({ ...$atumMessages.get(), [conversationId]: merged })
    $atumOlderHistory.set({
      ...$atumOlderHistory.get(),
      [conversationId]: page.hasMore ? 'idle' : 'exhausted'
    })

    return merged
  } catch (error) {
    if (epoch === accountEpoch && roomEpoch === roomGeneration(conversationId)) {
      $atumOlderHistory.set({ ...$atumOlderHistory.get(), [conversationId]: 'error' })
      $atumStatus.set(errorStatus(errorCode(error)))
    }

    return []
  }
}

export function setAtumActiveConversation(conversationId: string | null): void {
  $atumActiveConversationId.set(conversationId)

  if (conversationId) {
    void loadAtumMessages(conversationId, { markRead: true })
  }
}

export function setAtumDraft(conversationId: string, text: string): void {
  if ($atumRemovedGroups.get()[conversationId]) {
    return
  }

  draftGenerations.set(conversationId, draftGeneration(conversationId) + 1)
  dirtyLocalDrafts.add(conversationId)
  $atumDrafts.set({ ...$atumDrafts.get(), [conversationId]: text })
}

export function setAtumReplyTo(conversationId: string, messageId: string | null): void {
  $atumReplyTo.set({ ...$atumReplyTo.get(), [conversationId]: messageId })
}

export async function toggleAtumReaction(messageId: string, emoji: string): Promise<void> {
  await atumDirectMessagingClient().toggleReaction(messageId, emoji)
  const active = $atumActiveConversationId.get()

  if (active) {
    await loadAtumMessages(active, { markRead: false })
  }
}

export async function editAtumMessage(messageId: string, content: string): Promise<void> {
  await atumDirectMessagingClient().editMessage(messageId, content)
  const active = $atumActiveConversationId.get()

  if (active) {
    await loadAtumMessages(active, { markRead: false })
  }
}

export async function recallAtumMessage(messageId: string): Promise<void> {
  await atumDirectMessagingClient().recallMessage(messageId)
  const active = $atumActiveConversationId.get()

  if (active) {
    await loadAtumMessages(active, { markRead: false })
  }
}

export function sendAtumTyping(conversationId: string, typing: boolean): void {
  if (
    $atumRemovedGroups.get()[conversationId] ||
    $atumRoster.get().some(row => row.id === conversationId && row.kind === 'group')
  ) {
    return
  }

  void atumDirectMessagingClient().sendTyping?.(conversationId, typing)
}

export async function persistAtumDraft(conversationId: string): Promise<boolean> {
  if ($atumRemovedGroups.get()[conversationId]) {
    return false
  }

  const epoch = accountEpoch
  const text = $atumDrafts.get()[conversationId] ?? ''
  const draftRevision = draftGeneration(conversationId)

  try {
    await atumDirectMessagingClient().saveDraft(conversationId, { text })

    if (
      epoch === accountEpoch &&
      draftRevision === draftGeneration(conversationId) &&
      $atumDrafts.get()[conversationId] === text
    ) {
      dirtyLocalDrafts.delete(conversationId)
      draftGenerations.set(conversationId, draftRevision + 1)
    }

    return epoch === accountEpoch
  } catch (error) {
    if (epoch === accountEpoch) {
      $atumStatus.set(errorStatus(errorCode(error)))
    }

    return false
  }
}

export function hostedAtumLocale(locale: Locale | string): 'vi' | 'en' {
  return locale === 'vi' ? 'vi' : 'en'
}

export async function sendAtumMessage(
  conversationId: string,
  rawText: string,
  locale: Locale | string,
  attachmentIds: string[] = [],
  mention: { agent: 'binh-minh'; revision: 0; startOffset: number; endOffset: number } | null = null,
  mentions: AtumAddressedMentions | null = null,
  quotedMessage: GroupQuotedMessage | null = null
): Promise<void> {
  const content = rawText.trim()
  const leadingWhitespace = rawText.length - rawText.trimStart().length

  // The composer measures the span in UTF-16 code units; the hosted validator
  // measures it in code points. They agree for ASCII and disagree the moment an
  // emoji precedes the mention, so convert before the offsets leave the client.
  const codePointOffset = (utf16Offset: number): number => [...content.slice(0, utf16Offset)].length

  const normalizedMention =
    mention && mention.startOffset >= leadingWhitespace
      ? {
          ...mention,
          startOffset: codePointOffset(mention.startOffset - leadingWhitespace),
          endOffset: codePointOffset(mention.endOffset - leadingWhitespace)
        }
      : null

  const normalizedMentions =
    mentions && mentions.targets.every(target => target.startOffset >= leadingWhitespace)
      ? {
          contract: ATUM_ADDRESSED_MENTIONS_CONTRACT,
          targets: mentions.targets
            .filter(target => target.startOffset >= leadingWhitespace)
            .map(target => ({
              ...target,
              startOffset: codePointOffset(target.startOffset - leadingWhitespace),
              endOffset: codePointOffset(target.endOffset - leadingWhitespace)
            }))
        }
      : null

  if (mentions && !normalizedMentions) {
    throw new Error('message mentions are invalid after trimming')
  }

  if (!content && attachmentIds.length === 0) {
    return
  }

  const relationship = $atumSocialRelationships
    .get()
    .find(row => row.availability === 'available' && row.directThreadId === conversationId)

  const conversation = $atumRoster.get().find(row => row.id === conversationId)

  if (conversation?.kind === 'unsupported') {
    throw new Error('unsupported_conversation')
  }

  if (conversation?.kind === 'group') {
    if (!conversation.group || conversation.group.retiredAt || attachmentIds.length || mention) {
      throw new Error('group_compose_denied')
    }

    // Addressing is a separately negotiated capability. A group-capable
    // installed main process can still be paired with an old plane, and a
    // rollout-disabled plane must retain ordinary human room sends.
    if (normalizedMentions || quotedMessage) {
      const capabilities = await atumMessagingClient().groupCapabilities?.()

      const addressingEnabled =
        conversation.group.contextMode === 'private_advisory'
          ? capabilities?.advisory?.enabled
          : conversation.group.contextMode === 'shared_group'
            ? capabilities?.sharedAgents?.enabled
            : capabilities?.addressing?.enabled

      if (!capabilities?.available || !addressingEnabled) {
        throw new Error('group_compose_denied')
      }
    }
  }

  if (
    (conversation?.kind === 'direct' && relationship?.canMessage !== true) ||
    (relationship && !relationship.canMessage)
  ) {
    throw new Error('direct_compose_denied')
  }

  const epoch = accountEpoch
  const roomEpoch = roomGeneration(conversationId)

  if ($atumRemovedGroups.get()[conversationId]) {
    return
  }

  const clientMessageId = crypto.randomUUID()
  const accountId = $atumStatus.get()?.accountId ?? $atumAccountStatus.get().account?.id ?? 'self'

  const optimistic: AtumMessagingMessage = {
    localId: `optimistic:${clientMessageId}`,
    id: null,
    clientMessageId,
    conversationId,
    sender: { type: 'account', id: accountId },
    content,
    kind: 'text',
    attachments: [],
    metadata: null,
    replyToMessageId: $atumReplyTo.get()[conversationId] ?? null,
    forwardedFrom: null,
    reactions: [],
    version: 1,
    createdAt: new Date().toISOString(),
    editedAt: null,
    recalledAt: null,
    delivery: 'sending',
    optimistic: true
  }

  $atumMessages.set({
    ...$atumMessages.get(),
    [conversationId]: [...($atumMessages.get()[conversationId] ?? []), optimistic]
  })
  setAtumDraft(conversationId, '')
  void persistAtumDraft(conversationId)

  try {
    const replyToMessageId = $atumReplyTo.get()[conversationId] ?? null
    setAtumReplyTo(conversationId, null)
    await atumDirectMessagingClient().send({
      conversationId,
      clientMessageId,
      content,
      locale: hostedAtumLocale(locale),
      replyToMessageId,
      attachmentIds,
      mention: normalizedMention,
      mentions: normalizedMentions,
      ...(quotedMessage ? { quotedMessage } : {})
    })

    // A mention enqueues a hosted job. The job is metered against this account's
    // managed allowance, so this account's session is what runs it; nothing
    // unattended drains the queue. Failure here is not a send failure — the
    // message is delivered and the next poll retries the drain.
    if (normalizedMention || normalizedMentions) {
      void atumDirectMessagingClient().drainMentionJobs().catch(() => {
        // The pending dispatch state stays on the message; the poll retries.
      })
    }

    if (epoch === accountEpoch && roomEpoch === roomGeneration(conversationId)) {
      // Keep the renderer-owned optimistic row until the canonical projection
      // with this client id arrives. A refresh failure must not make a message
      // that the server already accepted disappear from the conversation.
      $atumMessages.set({
        ...$atumMessages.get(),
        [conversationId]: ($atumMessages.get()[conversationId] ?? []).map(message =>
          message.clientMessageId === clientMessageId ? { ...message, delivery: 'sent', optimistic: true } : message
        )
      })
      await loadAtumMessages(conversationId)
    }
  } catch {
    if (epoch !== accountEpoch || roomEpoch !== roomGeneration(conversationId)) {
      return
    }

    const current = $atumMessages.get()[conversationId] ?? []
    $atumMessages.set({
      ...$atumMessages.get(),
      [conversationId]: current.map(message =>
        message.clientMessageId === clientMessageId
          ? { ...message, delivery: 'failed_retryable', optimistic: true }
          : message
      )
    })
  }
}

export async function retryAtumMessage(clientMessageId: string): Promise<void> {
  const match = Object.values($atumMessages.get())
    .flat()
    .find(message => message.clientMessageId === clientMessageId)

  if (!match) {
    return
  }

  const epoch = accountEpoch
  $atumMessages.set({
    ...$atumMessages.get(),
    [match.conversationId]: ($atumMessages.get()[match.conversationId] ?? []).map(message =>
      message.clientMessageId === clientMessageId ? { ...message, delivery: 'sending' } : message
    )
  })

  try {
    await atumDirectMessagingClient().retry(clientMessageId)

    if (epoch === accountEpoch) {
      await loadAtumMessages(match.conversationId)
    }
  } catch {
    if (epoch !== accountEpoch) {
      return
    }

    $atumMessages.set({
      ...$atumMessages.get(),
      [match.conversationId]: ($atumMessages.get()[match.conversationId] ?? []).map(message =>
        message.clientMessageId === clientMessageId ? { ...message, delivery: 'failed_retryable' } : message
      )
    })
  }
}

/** True while any loaded message still carries a mention job that has not reached a terminal state. */
function hasUnfinishedMentionDispatch(): boolean {
  return Object.values($atumMessages.get())
    .flat()
    .some(message => {
      const dispatch = message.metadata?.mention_dispatch
      const targetDispatches = message.metadata?.target_dispatches

      if (Array.isArray(targetDispatches) && targetDispatches.some(row => {
        const state = row && typeof row === 'object' && !Array.isArray(row)
          ? (row as Record<string, unknown>).state
          : null

        return state === 'pending' || state === 'processing'
      })) {
        return true
      }

      if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
        return false
      }

      const state = (dispatch as Record<string, unknown>).state

      return state === 'pending' || state === 'processing'
    })
}

export async function pollAtumSync(): Promise<void> {
  const account = await refreshAtumAccountStatus()

  if (account.state !== 'signed_in' && account.state !== 'refreshing') {
    if (account.state === 'expired') {
      const previous = $atumStatus.get()

      $atumStatus.set({
        accountId: previous?.accountId ?? account.account?.id ?? null,
        connectivity: 'auth_expired',
        synchronized: false,
        cursor: previous?.cursor ?? null,
        lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt ?? null,
        nextRetryAt: null,
        errorCode: account.errorCode ?? 'account_session_expired'
      })
    }

    return
  }

  const epoch = accountEpoch

  try {
    const current = await atumDirectMessagingClient().status()

    if (epoch !== accountEpoch) {
      return
    }

    $atumStatus.set(current)

    if (!shouldPollAtumSync(current)) {
      return
    }

    // An unfinished mention job only advances while this account runs it, so a
    // reply that was still pending when the app closed is picked up on the next
    // poll rather than stranded.
    // Message history is not loaded at startup, so a job left pending in a
    // conversation the user has not opened is invisible to the gate below. One
    // unconditional drain per start recovers it; the claim is cheap and returns
    // nothing when the queue is empty.
    if (!mentionRecoveryAttempted) {
      try {
        await atumDirectMessagingClient().drainMentionJobs()
        // Only a completed drain counts as recovered. Marking the attempt
        // before it succeeds would strand a job in an unopened conversation
        // until the next account or app lifecycle.
        mentionRecoveryAttempted = true
      } catch {
        // Transient; the next poll retries the recovery drain.
      }
    }

    if (hasUnfinishedMentionDispatch()) {
      try {
        await atumDirectMessagingClient().drainMentionJobs()
      } catch {
        // Transient; the next poll retries.
      }
    }

    const previousRoster = $atumRoster.get()

    const [status] = await Promise.all([
      atumDirectMessagingClient().sync(),
      atumDirectMessagingClient()
        .socialSync()
        .then(relationships => {
          if (epoch === accountEpoch) {
            replaceSocialRelationships(relationships)
          }
        })
    ])

    if (epoch !== accountEpoch) {
      return
    }

    $atumStatus.set(status)
    const roster = await refreshAtumRoster()

    const active = $atumActiveConversationId.get()

    if (active) {
      await loadAtumMessages(active, { markRead: isWindowFocused(), notifyNew: true })
    }

    for (const conversation of roster) {
      const previousUnread = previousRoster.find(item => item.id === conversation.id)?.unreadCount ?? 0

      if (conversation.id !== active && conversation.unreadCount > previousUnread) {
        await loadAtumMessages(conversation.id, { markRead: false, notifyNew: true })
      }
    }
  } catch (error) {
    if (epoch === accountEpoch) {
      $atumStatus.set(errorStatus(errorCode(error)))
    }
  }
}

export function shouldPollAtumSync(status: AtumMessagingSyncStatus, now = Date.now()): boolean {
  if (status.connectivity === 'auth_expired' || (status.connectivity === 'error' && !status.nextRetryAt)) {
    return false
  }

  if (!status.nextRetryAt) {
    return true
  }

  const retryAt = Date.parse(status.nextRetryAt)

  return Number.isFinite(retryAt) && retryAt <= now
}

function schedulePoll(): void {
  if (pollingTimer) {
    clearTimeout(pollingTimer)
  }

  const delay = atumPollDelay($atumTransportStatus.get(), typeof document !== 'undefined' && document.hidden)
  pollingTimer = setTimeout(async () => {
    await pollAtumSync()
    schedulePoll()
  }, delay)
}

export function atumPollDelay(status: AtumMessagingTransportStatus, hidden: boolean): number {
  if (status.healthy) {
    return 90_000
  }

  return hidden ? 30_000 : 5_000
}

export function startAtumPolling(): () => void {
  if (!pollingTimer) {
    schedulePoll()
  }

  return () => {
    if (pollingTimer) {
      clearTimeout(pollingTimer)
    }

    pollingTimer = null
  }
}

export async function initializeAtumMessaging(): Promise<void> {
  if (initialized) {
    return
  }

  initialized = true

  const account = await refreshAtumAccountStatus()

  if (account.state === 'signed_in') {
    const [, , , transport] = await Promise.all([
      refreshAtumStatus(),
      refreshAtumRoster(),
      atumDirectMessagingClient().socialSync().then(replaceSocialRelationships),
      atumDirectMessagingClient().transportStatus()
    ])

    $atumTransportStatus.set(transport)
  }

  startAtumPolling()

  const refreshFocusedConversation = () => {
    if (!isWindowFocused()) {
      return
    }

    const active = $atumActiveConversationId.get()
    void refreshAtumRoster().then(() => (active ? loadAtumMessages(active, { markRead: true }) : undefined))
  }

  window.addEventListener('focus', refreshFocusedConversation)
  document.addEventListener('visibilitychange', refreshFocusedConversation)
  const stopChanged = window.hermesDesktop?.onAtumMessagingChanged?.(() => void refreshAtumRoster())

  const stopTransport = window.hermesDesktop?.onAtumMessagingTransportChanged?.(status => {
    $atumTransportStatus.set(status)
    schedulePoll()
  })

  const stopOpen = window.hermesDesktop?.onAtumConversationRequested?.(conversationId =>
    setAtumActiveConversation(conversationId)
  )

  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const stopTyping = window.hermesDesktop?.onAtumMessagingTypingChanged?.(payload => {
    $atumTyping.set({ ...$atumTyping.get(), [payload.conversationId]: payload.typing })
    const old = typingTimers.get(payload.conversationId)

    if (old) {
      clearTimeout(old)
    }

    if (payload.typing) {
      typingTimers.set(
        payload.conversationId,
        setTimeout(() => $atumTyping.set({ ...$atumTyping.get(), [payload.conversationId]: false }), 5_000)
      )
    }
  })

  stopDesktopMessagingEvents = () => {
    window.removeEventListener('focus', refreshFocusedConversation)
    document.removeEventListener('visibilitychange', refreshFocusedConversation)
    stopChanged?.()
    stopTransport?.()
    stopOpen?.()
    stopTyping?.()

    for (const timer of typingTimers.values()) {
      clearTimeout(timer)
    }
  }
}

export async function signInToAtum(): Promise<void> {
  $atumAccountStatus.set({ ...$atumAccountStatus.get(), state: 'signing_in', errorCode: null })

  try {
    const status = await composition().account().signIn()
    applyAccountStatus(status, { preserveSignedOut: true })

    if (status.state === 'signed_in') {
      await Promise.all([refreshAtumStatus(), refreshAtumRoster()])
    }
  } catch (error) {
    const previous = $atumAccountStatus.get()
    applyAccountStatus({
      state: 'error',
      configured: previous.configured,
      account: previous.account,
      errorCode: errorCode(error),
      providers: previous.providers
    })
  }
}

export async function signInToAtumWithPassword(credentials: { identifier: string; password: string }): Promise<void> {
  $atumAccountStatus.set({ ...$atumAccountStatus.get(), state: 'signing_in', errorCode: null })

  try {
    const status = await composition().account().signInWithPassword(credentials)
    applyAccountStatus(status, { preserveSignedOut: true })

    if (status.state === 'signed_in') {
      await Promise.all([refreshAtumStatus(), refreshAtumRoster()])
    }
  } catch (error) {
    const previous = $atumAccountStatus.get()
    applyAccountStatus({
      state: 'error',
      configured: previous.configured,
      account: previous.account,
      errorCode: errorCode(error),
      providers: previous.providers
    })
  }
}

export async function cancelAtumSignIn(): Promise<void> {
  applyAccountStatus(await composition().account().cancel(), { preserveSignedOut: true })
}

export async function signOutOfAtum(): Promise<void> {
  // A voluntary account change must not revoke a document lease while its
  // newest revision exists only in the renderer (including an active IME).
  if (Object.values($dirtyPreviewUrls.get()).some(Boolean)) {
    notifyError(null, translateNow('document.saveBeforeSignOut'))

    return
  }

  clearAccountScopedState(true)
  $atumAccountStatus.set(await composition().account().signOut())
}

/** Deterministic test reset; intentionally not part of the preload contract. */
export function resetAtumMessagingState(): void {
  if (pollingTimer) {
    clearTimeout(pollingTimer)
  }

  pollingTimer = null
  stopDesktopMessagingEvents?.()
  stopDesktopMessagingEvents = null
  initialized = false
  clearAccountScopedState()
  $atumAccountStatus.set({
    state: 'unconfigured',
    configured: false,
    account: null,
    errorCode: null,
    providers: { google: false, password: false }
  })
}
