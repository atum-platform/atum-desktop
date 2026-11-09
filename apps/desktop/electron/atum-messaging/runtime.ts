import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { MessagingCredentialVault, type SafeStorageLike } from './credential-vault'
import { AtumMessagingHttpClient, type MessagingFetch, type MessagingTokenSource } from './http-client'
import { MessagingHttpError } from './http-client'
import { MessagingSyncCoordinator } from './sync-coordinator'
import { AtumMessagingSyncEngine, type MessagingEngineOptions } from './sync-engine'
import type {
  ArtifactResolution,
  ArtifactState,
  AssistantRegistration,
  IdentityProfileUpdate,
  MessagingAccountSession,
  MessagingClientBoundary,
  MessagingSyncStatus,
  MessagingTransportStatus,
  MessagingUser
} from './types'

export interface AtumMessagingRuntimeOptions {
  userDataPath: string
  safeStorage: SafeStorageLike
  databasePathForAccount?: (accountId: string) => string
  /**
   * When present, the official Supabase auth adapter is the sole persistent
   * session owner. Runtime keeps only this in-memory projection for hosted
   * calls; the legacy vault remains readable for older standalone callers.
   */
  officialAuthSession?: MessagingAccountSession | null
  fetchImpl?: MessagingFetch
  refreshSession?: (session: MessagingAccountSession, signal: AbortSignal) => Promise<MessagingAccountSession | null>
  requestTimeoutMs?: number
  maxResponseBytes?: number
  workspaceProtected?: () => boolean
  /** This app's version, sent on hosted requests (AtumMessagingHttpClient). */
  desktopVersion?: string
  maxSyncPages?: number
  appDisconnected?: (input: { accountId: string; app: string }) => Promise<void>
  projectionChanged?: (roster: Awaited<ReturnType<AtumMessagingSyncEngine['roster']>>) => void
  realtime?: { url: string; anonKey: string }
  onActivity?: () => void
  transportChanged?: (status: MessagingTransportStatus) => void
  typingChanged?: (payload: { conversationId: string; accountId: string; typing: boolean }) => void
  log?: (message: string) => void
  createRealtimeClient?: ConstructorParameters<typeof MessagingSyncCoordinator>[0]['createClient']
  /** S5-owned replica seam; supplied only by deterministic lifecycle tests. */
  openStore?: MessagingEngineOptions['openStore']
  /** Deterministic S5.2 crash injection; production callers leave this unset. */
  afterPageProjectionBeforeCursorCommit?: MessagingEngineOptions['afterPageProjectionBeforeCursorCommit']
}

/**
 * Owns credentials and the sync engine in Electron main. `installSession` is a
 * main-only assembly seam for the account-login lane; it is intentionally not
 * registered in preload/IPC.
 */
export class AtumMessagingRuntime implements MessagingClientBoundary {
  /**
   * The single token source for every hosted call this process makes. Public so
   * other MAIN-PROCESS lanes (the per-app intake/connect surfaces) authenticate
   * through the same de-duplicated refresh instead of holding a second copy of
   * the session. It is never registered in preload — a token that reached the
   * renderer would defeat the vault.
   */
  readonly tokens: MessagingTokenSource
  private readonly vault: MessagingCredentialVault
  private readonly engine: AtumMessagingSyncEngine
  private readonly http: AtumMessagingHttpClient
  private readonly coordinator: MessagingSyncCoordinator | null
  private sessionValue: MessagingAccountSession | null
  private refreshFlight: {
    controller: AbortController
    generation: number
    identity: string
    promise: Promise<MessagingAccountSession | null>
  } | null = null
  private sessionGeneration = 0
  /** Set only by account auth's deferred-install path. */
  private initialSyncAfterPublishGeneration: number | null = null
  private readonly officialAuthCustody: boolean

  constructor(private readonly options: AtumMessagingRuntimeOptions) {
    this.vault = new MessagingCredentialVault(
      join(options.userDataPath, 'atum-messaging', 'session.json'),
      options.safeStorage
    )
    this.officialAuthCustody = Object.hasOwn(options, 'officialAuthSession')

    try {
      this.sessionValue = this.officialAuthCustody ? (options.officialAuthSession ?? null) : this.vault.load()
    } catch {
      // A locked/unavailable keychain must not brick the Hermes-powered app.
      // The messaging surface reports auth_expired until the main-process
      // account flow can install a decryptable session.
      this.sessionValue = null
    }

    const tokenSource: MessagingTokenSource = {
      current: () => this.sessionValue,
      refresh: rejected => {
        // Do not refresh a session which was replaced while the rejected
        // request was in flight.
        if (!this.sameSession(this.sessionValue, rejected)) {
          return Promise.resolve(this.sessionValue)
        }

        const generation = this.sessionGeneration
        const identity = this.sessionIdentity(rejected)

        if (this.refreshFlight?.generation === generation && this.refreshFlight.identity === identity) {
          return this.refreshFlight.promise
        }

        const controller = new AbortController()
        // Defer execution one microtask so even a non-conforming refresh
        // callback that throws synchronously cannot settle before the flight
        // is published for concurrent 401s.
        const promise = Promise.resolve().then(() => this.performRefresh(rejected, generation, identity, controller))
        this.refreshFlight = { controller, generation, identity, promise }

        return promise
      }
    }

    this.tokens = tokenSource

    this.http = new AtumMessagingHttpClient(tokenSource, options.fetchImpl, {
      requestTimeoutMs: options.requestTimeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      workspaceProtected: options.workspaceProtected,
      desktopVersion: options.desktopVersion
    })

    this.engine = new AtumMessagingSyncEngine({
      userDataPath: options.userDataPath,
      databasePathForAccount: options.databasePathForAccount,
      http: this.http,
      accountId: () => this.sessionValue?.user.id ?? null,
      accountHandle: () => this.sessionValue?.user.handle ?? null,
      maxSyncPages: options.maxSyncPages,
      automaticPolling: !options.realtime,
      openStore: options.openStore,
      afterPageProjectionBeforeCursorCommit: options.afterPageProjectionBeforeCursorCommit
    })

    this.coordinator = options.realtime
      ? new MessagingSyncCoordinator({
          realtimeUrl: options.realtime.url,
          anonKey: options.realtime.anonKey,
          tokens: this.tokens,
          advertisement: async () => (await this.http.session()).realtime,
          sync: this.realtimeHint,
          status: () => this.engine.status(),
          onActivity: options.onActivity,
          transportChanged: options.transportChanged,
          typingChanged: options.typingChanged,
          log: options.log,
          createClient: options.createRealtimeClient
        })
      : null
  }

  async start(): Promise<MessagingSyncStatus> {
    const generation = this.sessionGeneration
    const status = await this.engine.start()

    if (generation !== this.sessionGeneration) {
      return this.engine.status()
    }

    if (status.accountId) {
      await this.engine.socialSync()
    }

    if (generation === this.sessionGeneration) {
      await this.publishProjection(generation)
      void this.coordinator?.start()
    }

    return status
  }

  stop(): void {
    this.beginSessionLifecycle()
    void this.coordinator?.stop()
    this.engine.stop()
  }

  /**
   * Account auth may pass `{ publish: false }` while it commits the local
   * account authority. That caller must then publish the same generation or
   * quiesce it; ordinary callers retain a synchronous first-sync install.
   */
  async installSession(
    session: MessagingAccountSession,
    options: { publish?: boolean } = {}
  ): Promise<MessagingSyncStatus> {
    const generation = this.beginSessionLifecycle()
    await this.coordinator?.stop()

    if (generation !== this.sessionGeneration) {
      return this.engine.status()
    }

    if (this.officialAuthCustody) {
      this.sessionValue = session
    } else {
      this.vault.save(session)
      this.sessionValue = this.vault.load()
    }

    // Auth owns publication. It opens local custody here, commits account
    // authority, then lets `publishInstalledSession` begin hosted backfill.
    // Direct runtime callers preserve their synchronous first-sync contract.
    const deferInitialSync = options.publish === false

    const status = deferInitialSync
      ? await this.engine.openAccount(this.sessionValue.user.id)
      : await this.engine.replaceAccount(this.sessionValue.user.id)

    if (generation !== this.sessionGeneration) {
      return this.engine.status()
    }

    if (deferInitialSync) {
      this.initialSyncAfterPublishGeneration = generation
    } else {
      this.initialSyncAfterPublishGeneration = null
    }

    if (!deferInitialSync) {
      await this.publishInstalledSession()
    }

    return status
  }

  /** Publish only after the account authority has committed this open root. */
  async publishInstalledSession(): Promise<void> {
    if (!this.sessionValue) {
      throw new Error('auth_unavailable')
    }

    const generation = this.sessionGeneration
    const accountId = this.sessionValue.user.id
    const roster = await this.engine.roster(100)

    if (generation !== this.sessionGeneration || this.sessionValue?.user.id !== accountId) {
      throw new Error('stale_messaging_lifecycle')
    }

    this.options.projectionChanged?.(roster)
    void this.coordinator?.start()

    if (this.initialSyncAfterPublishGeneration === generation) {
      this.initialSyncAfterPublishGeneration = null
      // The account controller calls installSession({ publish: false }). Its
      // initial backfill may involve many individually bounded hosted requests,
      // so it begins only after account authority and the local projection commit.
      void this.sync().catch(() => undefined)
    }
  }

  async clearSession(): Promise<MessagingSyncStatus> {
    await this.quiesce()

    return this.engine.status()
  }

  /**
   * Account-switch barrier. It rejects new work immediately, waits for
   * realtime unsubscribe, aborts hosted requests, closes SQLite, and clears
   * the renderer projection before another account may be installed.
   */
  async quiesce(): Promise<void> {
    this.beginSessionLifecycle()
    this.initialSyncAfterPublishGeneration = null

    if (!this.officialAuthCustody) {
      this.vault.clear()
    }

    this.sessionValue = null
    const storeClosed = this.engine.replaceAccount(null)
    const realtimeClosed = this.coordinator?.stop()

    await Promise.all([storeClosed, realtimeClosed])

    try {
      this.options.projectionChanged?.([])
    } catch {
      // Account custody is already closed. A renderer notification failure
      // must not reopen resources or prevent fail-closed cleanup.
    }
  }

  /** Sanitized account metadata for the account controller; tokens stay private. */
  accountProfile() {
    return this.sessionValue ? { ...this.sessionValue.user } : null
  }

  /**
   * A hosted identity mutation answered with the whole user block. Adopt it
   * into the live session so `status()` reflects the new username or name
   * without a re-login; a reply for another account is dropped, never merged.
   */
  private adoptProfile(user: MessagingUser): MessagingUser {
    if (this.sessionValue && this.sessionValue.user.id === user.id) {
      const next = { ...this.sessionValue, user }
      this.sessionValue = next

      if (!this.officialAuthCustody) {
        this.vault.save(next)
      }
    }

    return user
  }

  /** Main-only projection update from an official Auth lifecycle event. */
  async updateSession(session: MessagingAccountSession): Promise<void> {
    if (!this.sessionValue || this.sessionValue.user.id !== session.user.id) {
      throw new Error('account_session_projection_mismatch')
    }

    this.sessionValue = session
  }

  /** Main-only read; never registered in preload or IPC. */
  currentSession(): MessagingAccountSession | null {
    return this.sessionValue
  }

  status = () => this.engine.status()
  roster = (limit?: number) => this.engine.roster(limit)
  messages = (conversationId: string, limit?: number) => this.engine.messages(conversationId, limit)
  loadOlderMessages = async (conversationId: string, limit?: number) => {
    const generation = this.sessionGeneration

    try {
      return await this.engine.loadOlderMessages(conversationId, limit)
    } finally {
      await this.publishProjection(generation)
    }
  }
  transportStatus = async () =>
    this.coordinator?.status() ?? {
      accountId: this.sessionValue?.user.id ?? null,
      healthy: false,
      state: 'disabled' as const
    }
  mentionTargets = (conversationId: string) => this.http.mentionTargets(conversationId)
  handlePowerResume = () => this.coordinator?.reconnect()
  handleNetworkChange = (online: boolean) => {
    if (online) {
      this.coordinator?.reconnect()
    }
  }
  artifact = async (conversationId: string, resourceId: string): Promise<ArtifactResolution> => {
    try {
      return { state: 'ready', artifact: await this.http.artifact(conversationId, resourceId) }
    } catch (error) {
      const state = error instanceof MessagingHttpError ? error.details?.artifact_state : null

      if (state === 'missing' || state === 'denied' || state === 'offline' || state === 'unsupported') {
        return { state: state as Exclude<ArtifactState, 'ready'>, artifact: null }
      }

      if (error instanceof MessagingHttpError && (error.status === 0 || error.code === 'temporarily_unavailable')) {
        return { state: 'offline', artifact: null }
      }

      return { state: 'error', artifact: null }
    }
  }
  ensureSpecialistConversation = async (specialist: string): Promise<{ conversationId: string }> => {
    const result = await this.http.ensureSpecialistConversation(specialist, randomUUID())
    await this.engine.sync()

    return { conversationId: result.conversationId }
  }
  ensureContactConversation = async (contactUserId: string): Promise<{ conversationId: string }> => {
    const result = await this.http.ensureContactConversation({
      contactUserId,
      clientOperationId: randomUUID()
    })

    await this.engine.sync()

    return result
  }
  handleAvailability = (handle: string) => this.http.handleAvailability(handle)
  renameHandle = async (handle: string) => this.adoptProfile(await this.http.renameHandle(handle))
  updateProfile = async (input: IdentityProfileUpdate) => this.adoptProfile(await this.http.updateProfile(input))
  createAvatarUpload = (input: { contentType: string }) => this.http.createAvatarUpload(input)
  completeAvatarUpload = async (uploadId: string) => this.adoptProfile(await this.http.completeAvatarUpload(uploadId))
  clearAvatar = async () => this.adoptProfile(await this.http.clearAvatar())
  createAssistantAvatarUpload = (assistantId: string, input: { contentType: string }) =>
    this.http.createAssistantAvatarUpload(assistantId, input)
  completeAssistantAvatarUpload = (assistantId: string, uploadId: string) =>
    this.http.completeAssistantAvatarUpload(assistantId, uploadId)
  clearAssistantAvatar = (assistantId: string) => this.http.clearAssistantAvatar(assistantId)
  drainMentionJobs = () => this.http.drainMentionJobs()
  groupCapabilities = () => this.engine.groupCapabilities()
  groupDetail = async (conversationId: string, cursor?: string | null) => {
    const generation = this.sessionGeneration

    try {
      return await this.engine.groupDetail(conversationId, cursor)
    } finally {
      await this.publishProjection(generation)
    }
  }
  groupOperations = () => this.engine.groupOperations()
  groupOperate = async (input: Parameters<MessagingClientBoundary['groupOperate']>[0]) => {
    const generation = this.sessionGeneration
    const result = await this.engine.groupOperate(input)
    await this.publishProjection(generation)

    return result
  }
  socialLookup = (query: string) => this.engine.socialLookup(query)
  socialMutate = (action: Parameters<MessagingClientBoundary['socialMutate']>[0], targetProfileId: string) =>
    this.engine.socialMutate(action, targetProfileId)
  socialRelationships = () => this.engine.socialRelationships()
  socialSync = () => this.engine.socialSync()
  linkedApps = () => this.http.linkedApps()
  disconnectApp = async (app: string) => {
    const accountId = this.tokens.current()?.user.id

    if (!accountId) {
      throw new Error('atum_account_changed')
    }

    await this.http.disconnectApp(app)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.options.appDisconnected?.({ accountId, app })

        return { localCleanup: 'complete' as const }
      } catch {
        // The server has withdrawn authority. Local cleanup is idempotent, so
        // absorb one transient native failure before asking the person to retry.
      }
    }

    // The view controller keeps the withdrawn app blocked and offers only the
    // local cleanup again; it never reports that the server disconnect failed.
    return { localCleanup: 'unconfirmed' as const }
  }
  /** `atum.assistant-registry/1`: pass-through; the renderer honours the outcomes. */
  registerAssistant = (input: AssistantRegistration) => this.http.registerAssistant(input)
  retireAssistant = (input: { identityId: string; lifecycleRevision: number; expectedIdentityRevision?: number }) =>
    this.http.retireAssistant(input)
  listAssistants = () => this.http.listAssistants()
  getAssistantDefinition = (assistantId: string) => this.http.getAssistantDefinition(assistantId)
  getAssistantSkill = (assistantId: string, sha256: string) => this.http.getAssistantSkill(assistantId, sha256)
  putAssistantSkill = (...args: Parameters<AtumMessagingHttpClient['putAssistantSkill']>) =>
    this.http.putAssistantSkill(...args)
  getAssistantMemory = (assistantId: string) => this.http.getAssistantMemory(assistantId)
  getAccountPreferences = () => this.http.getAccountPreferences()
  listAccountPets = () => this.http.listAccountPets()
  putAccountPet = (...args: Parameters<AtumMessagingHttpClient['putAccountPet']>) => this.http.putAccountPet(...args)
  getAccountPetContent = (sha256: string) => this.http.getAccountPetContent(sha256)
  putAccountPetContent = (...args: Parameters<AtumMessagingHttpClient['putAccountPetContent']>) =>
    this.http.putAccountPetContent(...args)
  putAccountPreferences = (...args: Parameters<AtumMessagingHttpClient['putAccountPreferences']>) =>
    this.http.putAccountPreferences(...args)
  putAssistantMemory = (...args: Parameters<AtumMessagingHttpClient['putAssistantMemory']>) =>
    this.http.putAssistantMemory(...args)
  putAssistantDefinition = (
    assistantId: string,
    input: Parameters<AtumMessagingHttpClient['putAssistantDefinition']>[1]
  ) => this.http.putAssistantDefinition(assistantId, input)
  protonRewards = () => this.http.protonRewards()
  claimProtonConnectionReward = (...args: Parameters<AtumMessagingHttpClient['claimProtonConnectionReward']>) =>
    this.http.claimProtonConnectionReward(...args)
  protonWallet = () => this.http.protonWallet()
  catalog = () => this.http.catalog()
  purchase = (...args: Parameters<AtumMessagingHttpClient['purchase']>) => this.http.purchase(...args)
  agentHires = (...args: Parameters<AtumMessagingHttpClient['agentHires']>) => this.http.agentHires(...args)
  hireAgent = (...args: Parameters<AtumMessagingHttpClient['hireAgent']>) => this.http.hireAgent(...args)
  cancelAgentHire = (...args: Parameters<AtumMessagingHttpClient['cancelAgentHire']>) =>
    this.http.cancelAgentHire(...args)
  startAgentTask = (...args: Parameters<AtumMessagingHttpClient['startAgentTask']>) => this.http.startAgentTask(...args)
  startTrainingTask = (...args: Parameters<AtumMessagingHttpClient['startTrainingTask']>) =>
    this.http.startTrainingTask(...args)
  purchaseStatus = (purchaseId: string) => this.http.purchaseStatus(purchaseId)
  entitlements = () => this.http.entitlements()
  advisoryClaim = (clientOperationId: string) => this.http.advisoryClaim(clientOperationId)
  advisoryComplete = (conversationId: string, jobId: string, leaseToken: string, replyText: string) =>
    this.http.advisoryComplete(conversationId, jobId, leaseToken, replyText)
  advisoryFail = (conversationId: string, jobId: string, leaseToken: string, errorCode: string, retryable: boolean) =>
    this.http.advisoryFail(conversationId, jobId, leaseToken, errorCode, retryable)
  advisoryPreflight = (conversationId: string, jobId: string, leaseToken: string) =>
    this.http.advisoryPreflight(conversationId, jobId, leaseToken)
  advisoryHeartbeat = (conversationId: string, jobId: string, leaseToken: string) =>
    this.http.advisoryHeartbeat(conversationId, jobId, leaseToken)
  advisorySearch = (input: Parameters<MessagingClientBoundary['advisorySearch']>[0]) => this.http.advisorySearch(input)
  advisoryRefresh = (input: { conversationId: string; subjectId: string; installationId: string; linkEpoch: number }) =>
    this.http.advisoryRefresh(input)
  draft = (conversationId: string) => this.engine.draft(conversationId)
  saveDraft = (conversationId: string, draft: Parameters<MessagingClientBoundary['saveDraft']>[1]) =>
    this.engine.saveDraft(conversationId, draft)
  send = (input: Parameters<MessagingClientBoundary['send']>[0]) => this.engine.send(input)
  retry = (clientMessageId: string) => this.engine.retry(clientMessageId)
  markRead = async (conversationId: string, throughMessageId: string) => {
    const generation = this.sessionGeneration
    const marked = await this.engine.markRead(conversationId, throughMessageId)
    await this.publishProjection(generation)

    return marked
  }
  toggleReaction = async (messageId: string, emoji: string) => {
    await this.http.toggleReaction(messageId, emoji)
    await this.sync()
  }
  editMessage = async (messageId: string, content: string) => {
    await this.http.editMessage(messageId, content)
    await this.sync()
  }
  recallMessage = async (messageId: string) => {
    await this.http.recallMessage(messageId)
    await this.sync()
  }
  searchMessages = (query: string, conversationId?: string) => this.http.searchMessages(query, conversationId)
  createMediaUpload = (input: { fileName: string; mimeType: string; sizeBytes: number }) =>
    this.http.createMediaUpload(input)
  completeMediaUpload = (attachmentId: string) => this.http.completeMediaUpload(attachmentId)
  downloadMedia = (attachmentId: string) => this.http.downloadMedia(attachmentId)
  sendTyping = (conversationId: string, typing: boolean) =>
    this.coordinator?.sendTyping(conversationId, typing) ?? Promise.resolve(false)
  sync = async () => {
    const generation = this.sessionGeneration
    const status = await this.engine.sync()
    await this.publishProjection(generation)

    return status
  }
  realtimeHint = async () => {
    const generation = this.sessionGeneration
    const status = await this.engine.realtimeHint()
    await this.publishProjection(generation)

    return status
  }

  private async publishProjection(expectedGeneration = this.sessionGeneration): Promise<void> {
    if (!this.options.projectionChanged || expectedGeneration !== this.sessionGeneration) {
      return
    }

    try {
      const roster = await this.engine.roster(100)

      if (expectedGeneration === this.sessionGeneration) {
        this.options.projectionChanged(roster)
      }
    } catch {
      if (expectedGeneration === this.sessionGeneration) {
        this.options.projectionChanged([])
      }
    }
  }

  private beginSessionLifecycle(): number {
    this.sessionGeneration += 1
    this.refreshFlight?.controller.abort()
    this.refreshFlight = null

    return this.sessionGeneration
  }

  private sameSession(current: MessagingAccountSession | null, expected: MessagingAccountSession): boolean {
    return current !== null && this.sessionIdentity(current) === this.sessionIdentity(expected)
  }

  private sessionIdentity(session: MessagingAccountSession): string {
    return [session.baseUrl, session.user.id, session.tokens.accessToken, session.tokens.refreshToken].join('\0')
  }

  private async performRefresh(
    rejected: MessagingAccountSession,
    generation: number,
    identity: string,
    controller: AbortController
  ): Promise<MessagingAccountSession | null> {
    let refreshed: MessagingAccountSession | null = null

    try {
      refreshed = (await this.options.refreshSession?.(rejected, controller.signal)) ?? null

      if (
        controller.signal.aborted ||
        generation !== this.sessionGeneration ||
        !this.sameSession(this.sessionValue, rejected)
      ) {
        return this.sessionValue
      }

      if (refreshed) {
        this.sessionValue = refreshed

        if (!this.officialAuthCustody) {
          this.vault.save(refreshed)
        }
      }

      return refreshed
    } finally {
      if (this.refreshFlight?.generation === generation && this.refreshFlight.identity === identity) {
        this.refreshFlight = null
      }
    }
  }
}
