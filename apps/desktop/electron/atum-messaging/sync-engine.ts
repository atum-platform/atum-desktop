import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type {
  GroupCapabilities,
  GroupDetail,
  GroupOperationInput,
  GroupOperationResult
} from '../../shared/atum-group-conversations'

import type { DirectMessagingTransport, GroupMessagingTransport } from './direct-transport'
import type { GroupStoreBoundary } from './group-store'
import type { SocialMutationAction, SocialProjection } from './social'
import { AtumMessagingStore } from './store'
import { MessagingTransportError } from './transport-error'
import type {
  ConversationDraft,
  DirectMessagingStoreBoundary,
  MessageHistoryPage,
  MessagingConversation,
  MessagingSyncClientBoundary,
  MessagingSyncStatus,
  PendingMutation,
  QueueSendInput,
  SaveDraftInput,
  StoredMessage
} from './types'
import type { SyncChange, SyncPage } from './wire'

export interface MessagingEngineOptions {
  userDataPath: string
  databasePathForAccount?: (accountId: string) => string
  http: DirectMessagingTransport & Partial<GroupMessagingTransport>
  accountId: () => string | null
  /** The signed-in account's own handle, used once to bootstrap the social replica. */
  accountHandle?: () => string | null
  openStore?: (accountId: string, databasePath: string) => DirectMessagingStoreBoundary
  now?: () => Date
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  retryBaseMs?: number
  pollMs?: number
  maxSyncPages?: number
  automaticPolling?: boolean
  /** Deterministic S5.2 crash injection; production callers leave this unset. */
  afterPageProjectionBeforeCursorCommit?: (input: {
    expectedCursor: string | null
    nextCursor: string
  }) => void | Promise<void>
}

const DEFAULT_MAX_SYNC_PAGES = 100
const MAX_SYNC_PAGES = 500

class StaleMessagingLifecycle extends Error {
  constructor() {
    super('stale_messaging_lifecycle')
  }
}

function nextDelay(attempt: number, base: number): number {
  return Math.min(base * 2 ** Math.min(attempt, 6), 60_000)
}

function statusCopy(status: MessagingSyncStatus): MessagingSyncStatus {
  return { ...status }
}

function invalidMessageDeleteScope(): MessagingTransportError {
  return new MessagingTransportError(
    'invalid_response:sync.message_delete.conversation_id_scope',
    200,
    false,
    null,
    null,
    null
  )
}

export class AtumMessagingSyncEngine implements MessagingSyncClientBoundary {
  private readonly openStore: NonNullable<MessagingEngineOptions['openStore']>
  private readonly now: () => Date
  private readonly setTimer: NonNullable<MessagingEngineOptions['setTimer']>
  private readonly clearTimer: NonNullable<MessagingEngineOptions['clearTimer']>
  private readonly retryBaseMs: number
  private readonly pollMs: number
  private readonly maxSyncPages: number
  private readonly automaticPolling: boolean
  private store: DirectMessagingStoreBoundary | null = null
  private activeAccountId: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private inFlight: { generation: number; promise: Promise<MessagingSyncStatus> } | null = null
  private generation = 0
  private capabilities: GroupCapabilities = { available: false, creationEnabled: false, humanMemberLimit: 32 }
  private readonly completedGroupOperations = new Map<string, GroupOperationResult>()
  private retryAttempt = 0
  private readonly historyCursors = new Map<string, { cursor: string | null; hasMore: boolean }>()
  private state: MessagingSyncStatus = {
    accountId: null,
    connectivity: 'loading',
    synchronized: false,
    cursor: null,
    lastSuccessfulSyncAt: null,
    nextRetryAt: null,
    errorCode: null
  }

  constructor(private readonly options: MessagingEngineOptions) {
    this.openStore =
      options.openStore ?? ((accountId, databasePath) => new AtumMessagingStore({ accountId, databasePath }))
    this.now = options.now ?? (() => new Date())
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.retryBaseMs = options.retryBaseMs ?? 1_000
    this.pollMs = options.pollMs ?? 30_000
    this.maxSyncPages = Math.max(
      1,
      Math.min(Math.trunc(options.maxSyncPages ?? DEFAULT_MAX_SYNC_PAGES), MAX_SYNC_PAGES)
    )
    this.automaticPolling = options.automaticPolling !== false
  }

  async start(): Promise<MessagingSyncStatus> {
    this.beginLifecycle()
    this.stopped = false
    this.ensureActiveStore()

    if (!this.store) {
      this.transition('auth_expired', 'auth_unavailable')

      return this.status()
    }

    return this.sync()
  }

  stop(): void {
    this.capabilities = { available: false, creationEnabled: false, humanMemberLimit: 32 }
    this.completedGroupOperations.clear()
    this.stopped = true
    this.generation += 1
    this.options.http.abortAll()
    this.cancelTimer()

    this.store?.close()
    this.store = null
    this.activeAccountId = null
    this.historyCursors.clear()
  }

  /**
   * Opens the account-local store without making hosted backfill part of the
   * account-authority commit. Auth callers can commit first and begin bounded
   * sync after publication.
   */
  openAccount(accountId: string | null): Promise<MessagingSyncStatus> {
    this.capabilities = { available: false, creationEnabled: false, humanMemberLimit: 32 }
    this.completedGroupOperations.clear()
    this.beginLifecycle()
    this.stopped = false
    this.store?.close()
    this.store = null
    this.activeAccountId = null
    this.historyCursors.clear()
    this.state = {
      accountId,
      connectivity: accountId ? 'loading' : 'auth_expired',
      synchronized: false,
      cursor: null,
      lastSuccessfulSyncAt: null,
      nextRetryAt: null,
      errorCode: accountId ? null : 'auth_unavailable'
    }
    this.ensureActiveStore()

    return this.status()
  }

  /** Preserve the legacy runtime contract: ordinary installs wait for first sync. */
  replaceAccount(accountId: string | null): Promise<MessagingSyncStatus> {
    const status = this.openAccount(accountId)

    return this.store ? this.sync() : status
  }

  status(): Promise<MessagingSyncStatus> {
    if (this.store) {
      this.state.cursor = this.store.getSyncCursor().cursor
    }

    return Promise.resolve(statusCopy(this.state))
  }

  roster(limit = 100): Promise<MessagingConversation[]> {
    return Promise.resolve(this.requireStore().listConversations(limit))
  }

  groupCapabilities(): Promise<GroupCapabilities> {
    return Promise.resolve({ ...this.capabilities })
  }

  groupOperations(): Promise<GroupOperationResult[]> {
    return Promise.resolve(
      this.groups(this.requireStore())
        .groupOperations()
        .map(({ input: _input, membershipEpoch: _epoch, attemptCount: _attempt, ...result }) => result)
    )
  }

  async groupOperate(input: GroupOperationInput): Promise<GroupOperationResult> {
    const generation = this.generation
    const store = this.requireStoreFor(generation)

    if (!this.capabilities.available || !this.options.http.groupOperate) {
      throw new Error('group_feature_unavailable')
    }

    if (
      input.action === 'create' &&
      !(input.contextMode === 'private_advisory'
        ? this.capabilities.advisory?.enabled
        : input.contextMode === 'shared_group'
          ? this.capabilities.creationEnabled && this.capabilities.sharedAgents?.enabled
          : this.capabilities.creationEnabled)
    ) {
      throw new Error('group_creation_disabled')
    }

    const groups = this.groups(store)
    const queued = groups.queueGroupOperation(input, this.now().toISOString())
    await this.sync()
    this.assertStoreLifecycle(generation, store)

    const result =
      groups.groupOperations().find(row => row.operationId === input.clientOperationId) ??
      this.completedGroupOperations.get(input.clientOperationId) ??
      queued

    // A successful operation invalidates roster/detail. Refresh it before publishing.
    if (result.state === 'sent') {
      await this.sync()
    }

    this.assertStoreLifecycle(generation, store)

    return {
      operationId: result.operationId,
      state: result.state,
      conversationId: result.conversationId,
      errorCode: result.errorCode
    }
  }

  async groupDetail(conversationId: string, cursor?: string | null): Promise<GroupDetail> {
    const generation = this.generation
    const store = this.requireStoreFor(generation)
    const groups = this.groups(store)
    const epoch = groups.groupRoom(conversationId)?.membershipEpoch

    if (!epoch || !this.options.http.groupDetail) {
      throw new Error('group_membership_ended')
    }

    try {
      const detail = await this.options.http.groupDetail(conversationId, cursor)
      this.assertStoreLifecycle(generation, store)

      if (groups.groupRoom(conversationId)?.membershipEpoch !== epoch || detail.room.membershipEpoch !== epoch) {
        throw new Error('stale_group_membership')
      }

      const conversation = store.listConversations(500).find(row => row.id === conversationId)

      if (!conversation) {
        throw new Error('group_membership_ended')
      }

      store.upsertConversation({
        ...conversation,
        title: detail.room.title,
        updatedAt: detail.room.updatedAt,
        group: detail.room
      })

      if (!cursor) {
        groups.saveGroupDetail(detail)
      }

      return detail
    } catch (error) {
      this.assertStoreLifecycle(generation, store)

      if (this.revokeDeniedGroup(error, conversationId, store)) {
        throw error
      }

      const cached = !cursor && groups.getGroupDetail(conversationId)

      if (cached && error instanceof MessagingTransportError && error.status === 0) {
        return cached
      }

      throw error
    }
  }

  private groups(store: DirectMessagingStoreBoundary): GroupStoreBoundary {
    const groups = (store as DirectMessagingStoreBoundary & { groups?: GroupStoreBoundary }).groups

    if (!groups) {
      throw new Error('group_store_unavailable')
    }

    return groups
  }

  private revokeDeniedGroup(error: unknown, id: string, store: DirectMessagingStoreBoundary): boolean {
    if (
      error instanceof MessagingTransportError &&
      (error.status === 403 || error.status === 404) &&
      (store as { groups?: GroupStoreBoundary }).groups?.groupRoom(id)
    ) {
      this.groups(store).revokeGroup(id)
      this.historyCursors.delete(id)

      return true
    }

    return false
  }

  socialRelationships(): Promise<SocialProjection[]> {
    return Promise.resolve(this.requireStore().listSocialRelationships())
  }

  async socialLookup(query: string): Promise<SocialProjection> {
    const generation = this.generation
    const store = this.requireStoreFor(generation)
    const handle = query.trim().replace(/^@/u, '').toLowerCase()

    if (!/^[a-z0-9][a-z0-9-]{2,31}$/u.test(handle)) {
      throw new Error('invalid_social_handle')
    }

    const known = store
      .listSocialRelationships()
      .find(row => row.availability === 'available' && row.profile.handle === handle)

    const result = await this.options.http.socialLookup(handle)
    this.assertStoreLifecycle(generation, store)
    const replicaEpoch = store.getSocialReplicaState().accountEpoch

    if (replicaEpoch && result.accountEpoch !== replicaEpoch) {
      throw new Error('social_lookup_scope_mismatch')
    }

    if (result.projection.availability === 'unavailable' && known?.availability === 'available') {
      store.invalidateSocialProfile(known.profile.profileId, this.now().toISOString())
    } else {
      store.applySocialProjection(result.accountEpoch, result.projection, this.now().toISOString())
    }

    return result.projection
  }

  async socialMutate(action: SocialMutationAction, targetProfileId: string): Promise<SocialProjection> {
    const generation = this.generation
    const store = this.requireStoreFor(generation)
    const accountEpoch = store.getSocialReplicaState().accountEpoch

    if (!accountEpoch) {
      throw new Error('social_account_epoch_unavailable')
    }

    const clientOperationId = randomUUID()
    const result = await this.options.http.socialMutate({ accountEpoch, action, clientOperationId, targetProfileId })
    this.assertStoreLifecycle(generation, store)

    if (result.accountEpoch !== accountEpoch || result.operationId !== clientOperationId) {
      throw new Error('social_mutation_scope_mismatch')
    }

    store.applySocialProjection(accountEpoch, result.projection, this.now().toISOString())

    return result.projection
  }

  /**
   * The replica learns its account epoch only from a provider response that
   * carries one. An account that never searched for anyone — everyone who
   * connected before the social slice existed — therefore had an empty
   * replica forever and every direct thread stayed compose-locked. A
   * self-lookup is the cheapest epoch-bearing call: the provider answers the
   * neutral projection (it excludes the caller) plus the epoch, and the store
   * records the epoch without inventing a relationship. Failure is not
   * fatal; the next poll tries again.
   */
  private async bootstrapSocialReplica(generation: number, store: DirectMessagingStoreBoundary): Promise<boolean> {
    const handle = this.options.accountHandle?.() ?? null

    if (!handle) {
      return false
    }

    try {
      const result = await this.options.http.socialLookup(handle)
      this.assertStoreLifecycle(generation, store)
      store.applySocialProjection(result.accountEpoch, result.projection, this.now().toISOString())

      return true
    } catch (error) {
      if (error instanceof Error && error.message === 'stale_messaging_lifecycle') {
        throw error
      }

      return false
    }
  }

  async socialSync(): Promise<SocialProjection[]> {
    const generation = this.generation
    const store = this.requireStoreFor(generation)
    let replica = store.getSocialReplicaState()

    if (!replica.accountEpoch) {
      if (!(await this.bootstrapSocialReplica(generation, store))) {
        return store.listSocialRelationships()
      }

      replica = store.getSocialReplicaState()

      if (!replica.accountEpoch) {
        return store.listSocialRelationships()
      }
    }

    let cursor = replica.cursor

    for (let pageCount = 0; pageCount < this.maxSyncPages; pageCount += 1) {
      const page = await this.options.http.socialSync(replica.accountEpoch, cursor)
      this.assertStoreLifecycle(generation, store)

      if (page.accountEpoch !== replica.accountEpoch || (page.hasMore && page.nextCursor === cursor)) {
        throw new Error('social_sync_scope_mismatch')
      }

      if (page.changes.some(change => change.projection.availability === 'unavailable')) {
        for (const known of store.listSocialRelationships()) {
          if (known.availability !== 'available') {
            continue
          }

          const refreshed = await this.options.http.socialLookup(known.profile.handle)
          this.assertStoreLifecycle(generation, store)

          if (refreshed.accountEpoch !== replica.accountEpoch) {
            throw new Error('social_sync_scope_mismatch')
          }

          if (refreshed.projection.availability === 'unavailable') {
            store.invalidateSocialProfile(known.profile.profileId, this.now().toISOString())
          } else {
            store.applySocialProjection(replica.accountEpoch, refreshed.projection, this.now().toISOString())
          }
        }
      }

      for (const change of page.changes) {
        if (change.projection.availability === 'available') {
          store.applySocialProjection(replica.accountEpoch, change.projection, this.now().toISOString())
        }
      }

      if (!store.commitSocialCursor(replica.accountEpoch, cursor, page.nextCursor)) {
        throw new Error('social_sync_cursor_race')
      }

      cursor = page.nextCursor

      if (!page.hasMore) {
        return store.listSocialRelationships()
      }
    }

    throw new Error('social_sync_page_limit')
  }

  messages(conversationId: string, limit = 100): Promise<StoredMessage[]> {
    return Promise.resolve(this.requireStore().listMessages(conversationId, limit))
  }

  async loadOlderMessages(conversationId: string, limit = 100): Promise<MessageHistoryPage> {
    const generation = this.generation
    const store = this.requireStoreFor(generation)
    const groups = (store as { groups?: GroupStoreBoundary }).groups
    const epoch = groups?.groupRoom(conversationId)?.membershipEpoch

    const assertMembership = () => {
      if (epoch !== undefined && groups?.groupRoom(conversationId)?.membershipEpoch !== epoch) {
        throw new Error('stale_group_membership')
      }

      if (
        !epoch &&
        groups?.groupRevokedEpoch(conversationId) !== null &&
        groups?.groupRevokedEpoch(conversationId) !== undefined
      ) {
        throw new Error('group_membership_ended')
      }
    }

    assertMembership()
    let pageState = this.historyCursors.get(conversationId)

    if (pageState && !pageState.hasMore) {
      return { messages: store.listMessages(conversationId, 500), nextCursor: pageState.cursor, hasMore: false }
    }

    const fetchHistory = async (cursor: string | null) => {
      try {
        return await this.options.http.messages(conversationId, cursor, limit)
      } catch (error) {
        this.assertStoreLifecycle(generation, store)
        this.revokeDeniedGroup(error, conversationId, store)
        throw error
      }
    }

    let page = await fetchHistory(pageState?.cursor ?? null)
    this.assertStoreLifecycle(generation, store)
    assertMembership()

    // After a restart the in-memory page cursor is absent while SQLite already
    // contains the first page. Advance once when that page is entirely a replay.
    if (
      !pageState &&
      page.hasMore &&
      page.messages.every(message => store.listMessages(conversationId, 500).some(row => row.id === message.id))
    ) {
      page = await fetchHistory(page.nextCursor)
      this.assertStoreLifecycle(generation, store)
      assertMembership()
    }

    for (const message of [...page.messages].reverse()) {
      store.canonicalizeMessage({ message, incrementUnread: false, now: this.now().toISOString() })
    }

    pageState = { cursor: page.nextCursor, hasMore: page.hasMore }
    this.historyCursors.set(conversationId, pageState)

    return {
      messages: store.listMessages(conversationId, 500),
      nextCursor: pageState.cursor,
      hasMore: pageState.hasMore
    }
  }

  draft(conversationId: string): Promise<ConversationDraft | null> {
    return Promise.resolve(this.requireStore().getDraft(conversationId))
  }

  saveDraft(conversationId: string, draft: SaveDraftInput): Promise<ConversationDraft> {
    return Promise.resolve(this.requireStore().saveDraft(conversationId, draft, this.now().toISOString()))
  }

  async send(input: QueueSendInput): Promise<PendingMutation> {
    const queued = this.requireStore().queueSend({ ...input, now: input.now ?? this.now().toISOString() })

    if (this.state.connectivity === 'online') {
      try {
        await this.drainOutbox()
      } catch (error) {
        if (!this.transitionAuthFailure(error)) {
          throw error
        }
      }
    } else {
      this.scheduleRetry(this.retryBaseMs)
    }

    return queued
  }

  async retry(clientMessageId: string): Promise<PendingMutation> {
    const mutation = this.requireStore().retryMutation(clientMessageId, this.now().toISOString())

    if (this.state.connectivity === 'online') {
      try {
        await this.drainOutbox()
      } catch (error) {
        if (!this.transitionAuthFailure(error)) {
          throw error
        }
      }
    } else {
      this.scheduleRetry(0)
    }

    return mutation
  }

  async markRead(conversationId: string, throughMessageId: string): Promise<boolean> {
    const store = this.requireStore()
    const marked = store.markRead(conversationId, throughMessageId, this.now().toISOString())

    if (!marked) {
      return false
    }

    store.queueReadReceipt(conversationId, throughMessageId, randomUUID(), this.now().toISOString())

    try {
      await this.drainReadReceipts()
    } catch (error) {
      if (!this.transitionAuthFailure(error)) {
        this.retryAttempt += 1
        this.transition(
          store.listConversations(1).length > 0 ? 'offline_cached' : 'error',
          error instanceof Error ? error.message : 'internal_error'
        )

        if (this.isRetryable(error)) {
          this.scheduleRetry(nextDelay(this.retryAttempt, this.retryBaseMs))
        }
      }
    }

    return true
  }

  sync(): Promise<MessagingSyncStatus> {
    if (this.stopped) {
      return this.status()
    }

    const generation = this.generation

    if (this.inFlight?.generation === generation) {
      return this.inFlight.promise
    }

    const operation = this.performSync(generation).finally(() => {
      if (this.inFlight?.promise === operation) {
        this.inFlight = null
      }
    })

    this.inFlight = { generation, promise: operation }

    return operation
  }

  /** Realtime is deliberately only a coalesced wake-up hint. */
  realtimeHint(): Promise<MessagingSyncStatus> {
    return this.sync()
  }

  private async performSync(generation: number): Promise<MessagingSyncStatus> {
    this.assertLifecycle(generation)
    this.ensureActiveStore()

    if (!this.store) {
      this.transition('auth_expired', 'auth_unavailable')

      return this.status()
    }

    this.transition(this.state.synchronized ? 'reconnecting' : 'loading', null)

    try {
      const verified = await this.options.http.session()
      this.assertLifecycle(generation)
      const selectedAccountId = this.options.accountId()

      if (!selectedAccountId) {
        throw new MessagingTransportError('auth_unavailable', 401, false, null, null, null)
      }

      if (verified.user.id !== selectedAccountId || verified.user.id !== this.activeAccountId) {
        throw new MessagingTransportError('account_scope_mismatch', 403, false, null, null, null)
      }

      this.capabilities = verified.groupCapabilities ?? {
        available: false,
        creationEnabled: false,
        humanMemberLimit: 32
      }

      const activeStore = this.requireStoreFor(generation)
      let cursor = activeStore.getSyncCursor().cursor
      const needsInitialBackfill = cursor === null
      let firstPage = true
      let pageCount = 0

      for (;;) {
        if (pageCount >= this.maxSyncPages) {
          throw new MessagingTransportError('sync_page_limit', 200, false, null, null, null)
        }

        const page = await this.options.http.sync(cursor)
        this.assertStoreLifecycle(generation, activeStore)

        if (page.hasMore && page.nextCursor === cursor) {
          throw new MessagingTransportError('invalid_response', 200, false, null, null, null)
        }

        await this.applyPage(page, needsInitialBackfill && firstPage, generation, activeStore)
        this.assertStoreLifecycle(generation, activeStore)
        await this.options.afterPageProjectionBeforeCursorCommit?.({
          expectedCursor: cursor,
          nextCursor: page.nextCursor
        })
        this.assertStoreLifecycle(generation, activeStore)

        if (!activeStore.commitSyncCursor(cursor, page.nextCursor, this.now().toISOString())) {
          throw new Error('sync_cursor_race')
        }

        cursor = page.nextCursor
        firstPage = false
        pageCount += 1

        if (!page.hasMore) {
          break
        }
      }

      if (await this.drainGroupOperations(generation)) {
        // Refresh membership/retirement before another pending write can leave
        // this process. Operation receipts alone contain no room projection.
        await this.applyPage(
          { changes: [], nextCursor: cursor, hasMore: false, serverTime: this.now().toISOString() },
          false,
          generation,
          activeStore
        )
      }

      await this.drainOutbox(generation)
      await this.drainReadReceipts(generation)
      this.assertStoreLifecycle(generation, activeStore)
      this.retryAttempt = 0
      this.state = {
        accountId: this.activeAccountId,
        connectivity: 'online',
        synchronized: true,
        cursor,
        lastSuccessfulSyncAt: this.now().toISOString(),
        nextRetryAt: null,
        errorCode: null
      }

      if (this.automaticPolling) {
        this.scheduleRetry(this.pollMs, generation)
      } else {
        this.cancelTimer()
        this.state.nextRetryAt = null
      }
    } catch (error) {
      if (error instanceof StaleMessagingLifecycle || !this.isCurrent(generation)) {
        return this.status()
      }

      await this.handleSyncFailure(error, generation)
    }

    return this.status()
  }

  private async applyPage(
    page: SyncPage,
    firstPage: boolean,
    generation: number,
    store: DirectMessagingStoreBoundary
  ): Promise<void> {
    this.assertStoreLifecycle(generation, store)
    const affected = new Set<string>()
    const groups = (store as { groups?: GroupStoreBoundary }).groups
    const removed = new Set<string>()

    for (const change of page.changes) {
      if (change.entity === 'conversation' && change.operation === 'delete') {
        if (!change.conversationId || change.entityId !== change.conversationId) {
          throw new Error('invalid_response:conversation_delete_scope')
        }

        if (!groups) {
          throw new Error('group_store_unavailable')
        }

        groups.revokeGroup(change.conversationId)
        this.historyCursors.delete(change.conversationId)
        removed.add(change.conversationId)
      }

      if (change.conversationId) {
        affected.add(change.conversationId)
      }

      if (change.entity === 'message' && change.operation === 'delete') {
        if (!change.conversationId) {
          throw invalidMessageDeleteScope()
        }

        const deletion = store.deleteCanonicalMessage(change.entityId, change.conversationId)

        if (deletion === 'conversation_mismatch') {
          throw invalidMessageDeleteScope()
        }
      }
    }

    // Ledger rows are watermarks and intentionally omit message bodies. Refresh
    // the authoritative allowlisted resources before committing the page cursor.
    const roster = await this.options.http.conversations()
    this.assertStoreLifecycle(generation, store)

    const rosterIds = new Set(roster.conversations.map(conversation => conversation.id))

    for (const id of groups?.groupRoomIds() ?? []) {
      if (!rosterIds.has(id)) {
        groups?.revokeGroup(id)
        this.historyCursors.delete(id)
        removed.add(id)
      }
    }

    for (const conversation of roster.conversations) {
      const previousEpoch = groups?.groupRoom(conversation.id)?.membershipEpoch
      store.upsertConversation(conversation)

      if (
        conversation.group &&
        groups?.groupRoom(conversation.id)?.membershipEpoch === conversation.group.membershipEpoch
      ) {
        removed.delete(conversation.id)

        if (previousEpoch !== conversation.group.membershipEpoch) {
          this.historyCursors.delete(conversation.id)
          affected.add(conversation.id)
        }
      }

      if (firstPage) {
        affected.add(conversation.id)
      }
    }

    for (const conversationId of [...affected].sort()) {
      if (
        removed.has(conversationId) ||
        (groups?.groupRevokedEpoch(conversationId) != null && !groups.groupRoom(conversationId))
      ) {
        continue
      }

      const epoch = groups?.groupRoom(conversationId)?.membershipEpoch
      let history

      try {
        history = await this.options.http.messages(conversationId)
      } catch (error) {
        this.assertStoreLifecycle(generation, store)

        if (this.revokeDeniedGroup(error, conversationId, store)) {
          continue
        }

        throw error
      }

      this.assertStoreLifecycle(generation, store)

      if (epoch !== undefined && groups?.groupRoom(conversationId)?.membershipEpoch !== epoch) {
        continue
      }

      if (firstPage || !this.historyCursors.has(conversationId)) {
        this.historyCursors.set(conversationId, { cursor: history.nextCursor, hasMore: history.hasMore })
      }

      for (const message of [...history.messages].reverse()) {
        store.canonicalizeMessage({ message, incrementUnread: false, now: this.now().toISOString() })
      }
    }

    // Mark each watermark only after every resource fetch and SQLite projection
    // above completed. A crash before here replays the idempotent page; a crash
    // after here but before cursor commit also replays it safely.
    for (const change of page.changes) {
      store.recordSyncChange(change.changeId, this.now().toISOString())
    }
  }

  private async drainGroupOperations(generation: number): Promise<boolean> {
    if (!this.capabilities.available || !this.options.http.groupOperate) {
      return false
    }

    let changed = false
    const store = this.requireStoreFor(generation)
    const groups = this.groups(store)

    for (const due of groups.dueGroupOperations(this.now().toISOString())) {
      this.assertStoreLifecycle(generation, store)

      if (due.conversationId && groups.groupRoom(due.conversationId)?.membershipEpoch !== due.membershipEpoch) {
        groups.revokeGroup(due.conversationId)
        this.historyCursors.delete(due.conversationId)

        continue
      }

      groups.startGroupOperation(due.operationId, this.now().toISOString())

      try {
        const result = await this.options.http.groupOperate(due.input)
        this.assertStoreLifecycle(generation, store)

        if (due.conversationId && groups.groupRoom(due.conversationId)?.membershipEpoch !== due.membershipEpoch) {
          continue
        }

        groups.settleGroupOperation(due.operationId, result.conversationId, this.now().toISOString())
        changed = true
        this.completedGroupOperations.set(due.operationId, {
          operationId: due.operationId,
          conversationId: result.conversationId,
          state: 'sent',
          errorCode: null
        })

        if (this.completedGroupOperations.size > 100) {
          this.completedGroupOperations.delete(this.completedGroupOperations.keys().next().value!)
        }

        if (due.input.action === 'leave') {
          groups.revokeGroup(result.conversationId)
          this.historyCursors.delete(result.conversationId)
        }
      } catch (error) {
        this.assertStoreLifecycle(generation, store)
        groups.failGroupOperation(due.operationId, this.failure(error, due.attemptCount + 1))

        if (error instanceof MessagingTransportError && error.status === 401) {
          throw error
        }
      }
    }

    return changed
  }

  private async drainOutbox(generation = this.generation): Promise<void> {
    const store = this.requireStoreFor(generation)

    for (const due of store.listDueMutations(this.now().toISOString(), 100)) {
      this.assertStoreLifecycle(generation, store)
      const groups = (store as { groups?: GroupStoreBoundary }).groups
      const room = groups?.groupRoom(due.conversationId)

      if (room?.retiredAt) {
        store.markMutationFailed(due.clientMessageId, { code: 'group_retired', retryable: false })

        continue
      }

      if (!room && groups?.groupRevokedEpoch(due.conversationId) != null) {
        continue
      }

      const epoch = room?.membershipEpoch
      const sending = store.markMutationSending(due.clientMessageId, this.now().toISOString())

      try {
        const acknowledged = await this.options.http.send(sending)
        this.assertStoreLifecycle(generation, store)

        if (epoch !== undefined && groups?.groupRoom(due.conversationId)?.membershipEpoch !== epoch) {
          continue
        }

        store.canonicalizeMessage({
          message: acknowledged.message,
          clientMessageId: sending.clientMessageId,
          incrementUnread: false,
          now: this.now().toISOString()
        })
      } catch (error) {
        this.assertStoreLifecycle(generation, store)

        if (epoch !== undefined && groups?.groupRoom(due.conversationId)?.membershipEpoch !== epoch) {
          continue
        }

        if (this.revokeDeniedGroup(error, due.conversationId, store)) {
          continue
        }

        const failure = this.failure(error, sending.attemptCount)
        store.markMutationFailed(sending.clientMessageId, failure)

        if (error instanceof MessagingTransportError && error.status === 401) {
          throw error
        }
      }
    }
  }

  private async drainReadReceipts(generation = this.generation): Promise<void> {
    const store = this.requireStoreFor(generation)

    for (const due of store.listDueReadReceipts(this.now().toISOString(), 100)) {
      this.assertStoreLifecycle(generation, store)
      const sending = store.markReadReceiptSending(due.id, this.now().toISOString())

      try {
        await this.options.http.markRead(sending.conversationId, sending.throughMessageId, sending.clientOperationId)
        this.assertStoreLifecycle(generation, store)
        store.markReadReceiptSent(sending.id)
      } catch (error) {
        this.assertStoreLifecycle(generation, store)
        store.markReadReceiptFailed(sending.id, this.failure(error, sending.attemptCount))
        throw error
      }
    }
  }

  private failure(error: unknown, attempt: number) {
    if (error instanceof MessagingTransportError) {
      const retryAt = new Date(
        this.now().getTime() + (error.retryAfterMs ?? nextDelay(attempt, this.retryBaseMs))
      ).toISOString()

      return {
        code: error.code,
        retryable: error.retryable || error.status === 0 || error.status >= 500,
        conflicted: error.code === 'idempotency_conflict' || error.code === 'version_conflict',
        retryAt,
        now: this.now().toISOString()
      }
    }

    return {
      code: error instanceof Error ? error.message : 'internal_error',
      retryable: true,
      retryAt: new Date(this.now().getTime() + nextDelay(attempt, this.retryBaseMs)).toISOString(),
      now: this.now().toISOString()
    }
  }

  private async handleSyncFailure(error: unknown, generation: number): Promise<void> {
    this.assertLifecycle(generation)

    if (
      error instanceof MessagingTransportError &&
      error.code === 'sync_cursor_expired' &&
      error.details?.reset_required
    ) {
      this.requireStore().resetProjection()
      this.historyCursors.clear()
      this.state.synchronized = false
      this.retryAttempt += 1
      this.scheduleRetry(nextDelay(this.retryAttempt, this.retryBaseMs), generation)
      this.transition('reconnecting', error.code)

      return
    }

    if (error instanceof MessagingTransportError && error.status === 401) {
      this.cancelTimer()
      this.state.nextRetryAt = null
      this.transition('auth_expired', error.code)

      return
    }

    this.retryAttempt += 1
    const cached = this.requireStore().listConversations(1).length > 0
    this.transition(cached ? 'offline_cached' : 'error', error instanceof Error ? error.message : 'internal_error')

    if (this.isRetryable(error)) {
      this.scheduleRetry(nextDelay(this.retryAttempt, this.retryBaseMs), generation)
    } else {
      this.cancelTimer()
      this.state.nextRetryAt = null
    }
  }

  private ensureActiveStore(): void {
    if (this.stopped) {
      return
    }

    const accountId = this.options.accountId()

    if (!accountId) {
      return
    }

    if (this.activeAccountId === accountId && this.store) {
      return
    }

    this.store?.close()
    this.activeAccountId = accountId
    this.store = this.openStore(accountId, this.databasePath())
    this.state.accountId = accountId
    this.state.cursor = this.store.getSyncCursor().cursor
  }

  private databasePath(): string {
    const accountId = this.activeAccountId ?? this.options.accountId()

    if (this.options.databasePathForAccount) {
      if (!accountId) {
        throw new Error('auth_unavailable')
      }

      return this.options.databasePathForAccount(accountId)
    }

    return join(this.options.userDataPath, 'atum-messaging', 'messaging.sqlite3')
  }

  private requireStore(): DirectMessagingStoreBoundary {
    this.ensureActiveStore()

    if (!this.store) {
      throw new Error('auth_unavailable')
    }

    return this.store
  }

  private requireStoreFor(generation: number): DirectMessagingStoreBoundary {
    this.assertLifecycle(generation)
    const store = this.requireStore()
    this.assertStoreLifecycle(generation, store)

    return store
  }

  private transition(connectivity: MessagingSyncStatus['connectivity'], errorCode: string | null): void {
    this.state = { ...this.state, connectivity, errorCode }
  }

  private transitionAuthFailure(error: unknown): boolean {
    if (!(error instanceof MessagingTransportError) || error.status !== 401) {
      return false
    }

    this.cancelTimer()
    this.state.nextRetryAt = null
    this.transition('auth_expired', error.code)

    return true
  }

  private scheduleRetry(delayMs: number, generation = this.generation): void {
    if (!this.isCurrent(generation)) {
      return
    }

    if (this.timer) {
      this.clearTimer(this.timer)
    }

    const delay = Math.max(0, delayMs)
    this.state.nextRetryAt = new Date(this.now().getTime() + delay).toISOString()
    this.timer = this.setTimer(() => {
      this.timer = null

      if (!this.isCurrent(generation)) {
        return
      }

      void this.sync()
    }, delay)
  }

  private beginLifecycle(): void {
    this.generation += 1
    this.options.http.abortAll()
    this.cancelTimer()
  }

  private cancelTimer(): void {
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation
  }

  private assertLifecycle(generation: number): void {
    if (!this.isCurrent(generation)) {
      throw new StaleMessagingLifecycle()
    }
  }

  private assertStoreLifecycle(generation: number, store: DirectMessagingStoreBoundary): void {
    this.assertLifecycle(generation)

    if (this.store !== store || this.activeAccountId !== store.accountId) {
      throw new StaleMessagingLifecycle()
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof MessagingTransportError) {
      return error.retryable || error.status === 0 || error.status >= 500
    }

    return true
  }
}

export function conversationsAffectedBy(changes: readonly SyncChange[]): string[] {
  return [...new Set(changes.flatMap(change => (change.conversationId ? [change.conversationId] : [])))].sort()
}
