import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { AtumManagedModelProxy } from '../atum-managed-model-proxy'

import type { SafeStorageAuthStorage } from './credential-vault'
import type { SharedGroupDevice } from './shared-group-device'

const STATE_KEY = 'atum-shared-group-runner-v1'
const PROFILE = 'atum.shared-group-turn/1' as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DIGEST = /^[0-9a-f]{64}$/iu
const ALIASES = new Set(['binh-minh', 'nguyet-thuc', 'nhat-thuc'])
const MAX_REPLY_CODEPOINTS = 20_000
const CHILD_TIMEOUT_MS = 150_000

type ModelAlias = 'binh-minh' | 'nguyet-thuc' | 'nhat-thuc'

export interface SharedGroupAccountScope {
  accountId: string
  baseUrl: string
}

export interface SharedGroupRuntime {
  /** Interpreter and source root returned by main's existing resolveHermesBackend bridge. */
  pythonPath: string
  sourceRoot: string
  /** An explicit minimal PATH for that interpreter. It is never inherited from Electron. */
  path: string
  /** Optional runtime-owned site-package paths, never copied from process.env. */
  pythonPathEntries?: string[]
}

export interface SharedGroupPersonaSnapshot {
  assistantId: string
  profileIdentity: string
  personaDigest: string
  personaRevision: number
  soulBytes: Buffer
}

export interface SharedGroupChildInput {
  profile: typeof PROFILE
  job_id: string
  model: ModelAlias
  base_url: string
  persona_digest: string
  context: SharedGroupContext
}

export interface SharedGroupChildResult {
  profile: typeof PROFILE
  job_id: string
  state: 'completed' | 'failed'
  reply_text?: string
  error?: string
}

export interface SharedGroupContext {
  conversation_id: string
  messages: Array<{
    id: string
    version: number
    speaker: { kind: 'user' | 'assistant' | 'specialist'; id: string; display_name: string }
    text: string
  }>
  watermark: string
  truncated: boolean
  source_clipped: false
  context_mode: 'shared_group'
}

interface SharedGroupBinding {
  assistant: string
  profile_identity: string
  model_alias: ModelAlias
  persona_digest: string
  persona_revision: number
}

interface Preflight {
  state: 'ready' | 'completed' | 'denied'
  job_id?: string
  reply_id?: string
  error?: string
  binding?: SharedGroupBinding
  context?: SharedGroupContext
}

interface ClaimedJob {
  job_id: string
  conversation_id: string
  lease_token: string
  reservation_id: string | null
  request: Preflight
}

interface PersistedJob {
  jobId: string
  conversationId: string
  leaseToken: string
  reservationId: string | null
  replyId: string | null
  replyText: string | null
}

interface PersistedState {
  version: 1
  accountId: string
  baseUrl: string
  jobs: Record<string, PersistedJob>
}

export interface SharedGroupRunnerOptions {
  device: Pick<SharedGroupDevice, 'heartbeat' | 'credentialForAccount' | 'authenticatedRequest'>
  proxy: Pick<AtumManagedModelProxy, 'issueSharedJobToken'>
  account: () => SharedGroupAccountScope | null
  storageForAccount: (accountId: string) => SafeStorageAuthStorage | null | undefined
  runtime: () => Promise<SharedGroupRuntime>
  persona: (input: {
    assistantId: string
    profileIdentity: string
    personaDigest: string
    personaRevision: number
  }) => Promise<SharedGroupPersonaSnapshot>
  userDataPath: string
  executeChild?: (input: SharedGroupChildInput, launch: SharedGroupChildLaunch) => Promise<SharedGroupChildResult>
  childTimeoutMs?: number
}

export interface SharedGroupChildLaunch {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface SharedGroupTickResult {
  state: 'idle' | 'completed' | 'recovered' | 'failed' | 'busy'
  jobId: string | null
  error: string | null
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function fail(code: string): never {
  throw new Error(`shared_group_runner_${code}`)
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : ''
  const match = /^shared_group_runner_([a-z_]+)$/u.exec(text)

  return match ? match[1] : 'runtime_failed'
}

function assertWithin(parent: string, child: string): void {
  const path = relative(parent, child)

  if (path === '' || path.startsWith(`..${sep}`) || path === '..' || resolve(child) === resolve(parent)) {
    fail('isolated_path_invalid')
  }
}

function replyText(value: unknown): string {
  if (typeof value !== 'string') {
    fail('child_result_invalid')
  }

  const trimmed = value.trim()

  if (!trimmed || Array.from(trimmed).length > MAX_REPLY_CODEPOINTS) {
    fail('child_result_invalid')
  }

  return trimmed
}

function parseContext(value: unknown): SharedGroupContext {
  const row = record(value)
  const messages = row && Array.isArray(row.messages) ? row.messages : null

  if (
    !row ||
    !isUuid(row.conversation_id) ||
    !isUuid(row.watermark) ||
    row.context_mode !== 'shared_group' ||
    typeof row.truncated !== 'boolean' ||
    row.source_clipped !== false ||
    !messages ||
    messages.length > 12
  ) {
    fail('preflight_invalid')
  }

  const parsed = messages.map(message => {
    const entry = record(message)
    const speaker = entry && record(entry.speaker)

    if (
      !entry ||
      !speaker ||
      !isUuid(entry.id) ||
      !isPositiveInteger(entry.version) ||
      (speaker.kind !== 'user' && speaker.kind !== 'assistant' && speaker.kind !== 'specialist') ||
      typeof speaker.id !== 'string' ||
      !speaker.id ||
      speaker.id.length > 256 ||
      typeof speaker.display_name !== 'string' ||
      !speaker.display_name ||
      typeof entry.text !== 'string'
    ) {
      fail('preflight_invalid')
    }

    return {
      id: entry.id,
      version: entry.version,
      speaker: {
        kind: speaker.kind as 'user' | 'assistant' | 'specialist',
        id: speaker.id,
        display_name: speaker.display_name
      },
      text: entry.text
    }
  })

  const context: SharedGroupContext = {
    conversation_id: row.conversation_id,
    messages: parsed,
    watermark: row.watermark,
    truncated: row.truncated,
    source_clipped: false,
    context_mode: 'shared_group'
  }

  if (Array.from(JSON.stringify(context)).length > 6_000) {
    fail('preflight_invalid')
  }

  return context
}

function parseBinding(value: unknown): SharedGroupBinding {
  const row = record(value)

  if (
    !row ||
    !isUuid(row.assistant) ||
    !isUuid(row.profile_identity) ||
    !ALIASES.has(row.model_alias as string) ||
    typeof row.persona_digest !== 'string' ||
    !DIGEST.test(row.persona_digest) ||
    !isPositiveInteger(row.persona_revision)
  ) {
    fail('preflight_invalid')
  }

  return {
    assistant: row.assistant,
    profile_identity: row.profile_identity,
    model_alias: row.model_alias as ModelAlias,
    persona_digest: row.persona_digest.toLowerCase(),
    persona_revision: row.persona_revision
  }
}

function parsePreflight(value: unknown, expectedJob?: string, expectedConversation?: string): Preflight {
  const row = record(value)

  if (!row || (row.state !== 'ready' && row.state !== 'completed' && row.state !== 'denied')) {
    fail('preflight_invalid')
  }

  if (row.state === 'ready') {
    if (!isUuid(row.job_id) || (expectedJob && row.job_id !== expectedJob)) {
      fail('preflight_invalid')
    }

    const context = parseContext(row.context)

    if (expectedConversation && context.conversation_id !== expectedConversation) {
      fail('preflight_invalid')
    }

    return { state: 'ready', job_id: row.job_id, binding: parseBinding(row.binding), context }
  }

  if (row.state === 'completed' && !isUuid(row.reply_id)) {
    fail('preflight_invalid')
  }

  return {
    state: row.state,
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    ...(isUuid(row.reply_id) ? { reply_id: row.reply_id } : {})
  }
}

function parseClaim(value: unknown): ClaimedJob | null {
  const row = record(value)
  const job = row && row.job

  if (job === null) {
    return null
  }

  const entry = record(job)
  const reservationId = entry?.reservation_id === null ? null : entry?.reservation_id

  if (
    !entry ||
    !isUuid(entry.job_id) ||
    !isUuid(entry.conversation_id) ||
    !isUuid(entry.lease_token) ||
    (reservationId !== null && !isUuid(reservationId))
  ) {
    fail('claim_invalid')
  }

  let normalizedReservationId: string | null

  if (reservationId === null) {
    normalizedReservationId = null
  } else if (isUuid(reservationId)) {
    normalizedReservationId = reservationId
  } else {
    fail('claim_invalid')
  }

  const request = parsePreflight(entry.request, entry.job_id, entry.conversation_id)

  return {
    job_id: entry.job_id,
    conversation_id: entry.conversation_id,
    lease_token: entry.lease_token,
    reservation_id: normalizedReservationId,
    request
  }
}

/**
 * Main-process-only owner-device execution path for shared-group jobs. The
 * server supplies all authority; this class only persists the minimum needed
 * to recover a reserved/model-dispatched turn without regenerating it.
 */
export class SharedGroupRunner {
  private running: {
    accountId: string
    generation: number
    jobId: string
    cancel: () => void
    revoke: () => void
  } | null = null
  private flight: Promise<SharedGroupTickResult> | null = null
  private stopped = false
  private generation = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private retryAt = 0
  private nextPollAt = 0
  private idlePollMs = 5_000
  private wakeEpoch = 0
  private nextHeartbeatAt = 0
  private nextRecoveryAt = 0
  private presenceScope: string | null = null
  private presenceFlight: Promise<void> | null = null
  private readonly timeoutMs: number

  constructor(private readonly options: SharedGroupRunnerOptions) {
    this.timeoutMs = options.childTimeoutMs ?? CHILD_TIMEOUT_MS
  }

  /** Shared availability belongs to Electron main, including while its window is closed. */
  start(): void {
    if (this.timer || this.stopped) {return}

    const poll = () => {
      if (Date.now() < this.retryAt) {return}
      void this.tick(true)
    }

    this.timer = setInterval(poll, 5_000)
    this.timer.unref?.()
    poll()
  }

  /** Focus and power wake reset empty-claim backoff without changing presence ownership. */
  wake(): void {
    this.wakeEpoch += 1
    this.idlePollMs = 5_000
    this.retryAt = 0
    this.nextPollAt = 0
    if (this.timer && !this.stopped) {void this.tick(true)}
  }

  /** Explicit ticks reconcile immediately; the background beat respects the claim deadline. */
  async tick(respectCadence = false): Promise<SharedGroupTickResult> {
    if (this.flight || this.running) {
      // A model call can outlast device presence. Refresh presence without
      // claiming another job or trying to recover the active reservation.
      const scope = this.scope()

      if (scope && !this.stopped) {
        void this.maintainPresence(scope, this.generation).catch(() => undefined)
      }

      return { state: 'busy', jobId: this.running?.jobId ?? null, error: null }
    }

    const flight = this.tickOnce(respectCadence)
    this.flight = flight

    try {
      return await flight
    } finally {
      if (this.flight === flight) {
        this.flight = null
      }
    }
  }

  private async tickOnce(respectCadence: boolean): Promise<SharedGroupTickResult> {
    if (this.stopped) {
      return { state: 'idle', jobId: null, error: null }
    }

    const scope = this.scope()

    if (!scope) {
      return { state: 'idle', jobId: null, error: null }
    }

    try {
      const generation = this.generation

      if (!this.options.device.credentialForAccount(scope.accountId)) {
        return { state: 'idle', jobId: null, error: null }
      }

      await this.maintainPresence(scope, generation)
      this.assertScope(scope, generation)

      if (Date.now() >= this.nextRecoveryAt) {
        await this.recover(scope, generation)
        this.assertScope(scope, generation)
        this.nextRecoveryAt = this.nextHeartbeatAt
      }

      if (respectCadence && Date.now() < this.nextPollAt) {
        return { state: 'idle', jobId: null, error: null }
      }

      const wakeEpoch = this.wakeEpoch
      const claimed = parseClaim(await this.request('/api/desktop/v1/group-conversations/claim', { method: 'POST' }))
      this.assertScope(scope, generation)

      if (wakeEpoch === this.wakeEpoch) {
        this.nextPollAt = Date.now() + (claimed ? 5_000 : this.idlePollMs)
        this.idlePollMs = claimed ? 5_000 : Math.min(60_000, this.idlePollMs * 2)
      }

      if (!claimed) {
        return { state: 'recovered', jobId: null, error: null }
      }

      if (claimed.request.state !== 'ready') {
        await this.closeNonReady(scope, claimed, claimed.request, generation)

        return { state: 'recovered', jobId: claimed.job_id, error: null }
      }

      const state = this.readState(scope)
      const pending = state.jobs[claimed.job_id]

      if (pending?.replyText) {
        // A fresh claim is the only new lease after a restart. Re-publish the
        // exact locally committed reply; never ask the model again.
        pending.leaseToken = claimed.lease_token
        pending.conversationId = claimed.conversation_id
        this.saveState(scope, state, generation)
        const completed = await this.completeExact(scope, pending, generation)

        return { state: completed ? 'completed' : 'recovered', jobId: claimed.job_id, error: null }
      }

      if (pending?.reservationId || claimed.reservation_id) {
        // A prior process crossed the billing boundary. The server recovery
        // route decides its ledger outcome; this process must not regenerate.
        // Terminally close the freshly claimed lease so it cannot sit in
        // processing and consume the retry budget without a possible reply.
        await this.fail(scope, claimed, 'provider_reply_unavailable', generation)

        return { state: 'recovered', jobId: claimed.job_id, error: null }
      }

      try {
        const completed = await this.execute(scope, claimed, state, generation)

        return { state: completed ? 'completed' : 'recovered', jobId: claimed.job_id, error: null }
      } catch (error) {
        // Keep a committed reply on transport failure: publication may have
        // succeeded remotely. Restart must replay it, never regenerate it.
        this.assertScope(scope, generation)

        if (!this.readState(scope).jobs[claimed.job_id]?.replyText) {
          await this.fail(scope, claimed, safeError(error), generation)
        }

        throw error
      }
    } catch (error) {
      this.retryAt = Date.now() + 30_000
      return { state: 'failed', jobId: null, error: safeError(error) }
    }
  }

  stop(): void {
    this.stopped = true
    this.presenceFlight = null

    if (this.timer) {clearInterval(this.timer)}
    this.timer = null
    this.generation += 1
    this.running?.cancel()
    this.running?.revoke()
    this.running = null
  }

  /** Account removal and account/base-url transitions quiesce the child first. */
  quiesceAccount(_accountId?: string): void {
    this.generation += 1
    this.presenceFlight = null
    this.presenceScope = null
    this.nextHeartbeatAt = 0
    this.nextRecoveryAt = 0
    this.wakeEpoch += 1
    this.retryAt = 0
    this.nextPollAt = 0
    this.idlePollMs = 5_000
    this.running?.cancel()
    this.running?.revoke()
    this.running = null
  }

  private async maintainPresence(scope: SharedGroupAccountScope, generation: number): Promise<void> {
    if (!this.options.device.credentialForAccount(scope.accountId)) {return}
    const key = JSON.stringify([scope.accountId, scope.baseUrl, generation])

    if (this.presenceScope !== key) {
      this.presenceScope = key
      this.nextHeartbeatAt = 0
      this.nextRecoveryAt = 0
    }

    if (this.presenceFlight) {
      await this.presenceFlight
      this.assertScope(scope, generation)

      return
    }

    if (Date.now() < this.nextHeartbeatAt) {return}
    this.nextHeartbeatAt = Date.now() + 30_000

    const flight = (async () => {
      const heartbeat = await this.options.device.heartbeat()
      this.assertScope(scope, generation)
      this.nextHeartbeatAt = Date.now() + heartbeat.nextHeartbeatSeconds * 1000
    })()

    this.presenceFlight = flight

    try {await flight} finally {
      if (this.presenceFlight === flight) {this.presenceFlight = null}
    }
  }

  private scope(): SharedGroupAccountScope | null {
    const scope = this.options.account()

    if (!scope || !isUuid(scope.accountId) || !scope.baseUrl) {
      return null
    }

    return { accountId: scope.accountId, baseUrl: scope.baseUrl }
  }

  private assertScope(expected: SharedGroupAccountScope, generation: number): void {
    const actual = this.scope()

    if (
      !actual ||
      actual.accountId !== expected.accountId ||
      actual.baseUrl !== expected.baseUrl ||
      this.stopped ||
      this.generation !== generation
    ) {
      fail('account_changed')
    }
  }

  private storage(scope: SharedGroupAccountScope): SafeStorageAuthStorage {
    const storage = this.options.storageForAccount(scope.accountId)

    if (!storage) {
      fail('storage_unavailable')
    }

    return storage
  }

  private readState(scope: SharedGroupAccountScope): PersistedState {
    const storage = this.storage(scope)
    const raw = storage.getItem(STATE_KEY)

    if (storage.failureCode()) {
      fail('storage_unavailable')
    }

    if (!raw) {
      return { version: 1, accountId: scope.accountId, baseUrl: scope.baseUrl, jobs: {} }
    }

    try {
      const state = JSON.parse(raw) as PersistedState

      if (
        state.version !== 1 ||
        state.accountId !== scope.accountId ||
        state.baseUrl !== scope.baseUrl ||
        !state.jobs ||
        typeof state.jobs !== 'object'
      ) {
        fail('state_invalid')
      }

      return state
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('shared_group_runner_')) {
        throw error
      }

      fail('state_invalid')
    }
  }

  private saveState(scope: SharedGroupAccountScope, state: PersistedState, generation: number): void {
    this.assertScope(scope, generation)
    const storage = this.storage(scope)
    storage.setItem(STATE_KEY, JSON.stringify(state))

    if (storage.failureCode()) {fail('storage_unavailable')}
  }

  private async recover(scope: SharedGroupAccountScope, generation: number): Promise<void> {
    await this.request('/api/desktop/v1/group-conversations/recover', { method: 'POST' })
    this.assertScope(scope, generation)
    const state = this.readState(scope)

    for (const pending of Object.values(state.jobs)) {
      try {
        if (pending.replyText) {
          await this.completeExact(scope, pending, generation)
        } else {
          const job = { job_id: pending.jobId, conversation_id: pending.conversationId,
            lease_token: pending.leaseToken, reservation_id: pending.reservationId,
            request: { state: 'denied' as const } }

          const result = await this.preflight(scope, job, generation)
          await this.closeNonReady(scope, job, result, generation)
        }
      } catch (error) {
        this.assertScope(scope, generation)

        if (error instanceof Error && error.message === 'shared_group_device_job_gone') {
          this.forget(scope, pending.jobId, generation)
        }
        // Preserve local evidence for transport failures or a lost lease. A
        // fresh claim can publish the same reply; it must never regenerate it.
      }
    }
  }

  private async execute(
    scope: SharedGroupAccountScope,
    claimed: ClaimedJob,
    state: PersistedState,
    generation: number
  ): Promise<boolean> {
    let preflight = await this.preflight(scope, claimed, generation)

    if (preflight.state !== 'ready' || !preflight.binding || !preflight.context) {
      await this.closeNonReady(scope, claimed, preflight, generation)

      return preflight.state === 'completed'
    }

    const binding = preflight.binding

    const snapshot = await this.options.persona({
      assistantId: binding.assistant,
      profileIdentity: binding.profile_identity,
      personaDigest: binding.persona_digest,
      personaRevision: binding.persona_revision
    })

    this.assertScope(scope, generation)

    if (
      snapshot.assistantId !== binding.assistant ||
      snapshot.profileIdentity !== binding.profile_identity ||
      snapshot.personaDigest.toLowerCase() !== binding.persona_digest ||
      snapshot.personaRevision !== binding.persona_revision ||
      createHash('sha256').update(snapshot.soulBytes).digest('hex') !== binding.persona_digest
    ) {
      await this.fail(scope, claimed, 'persona_not_approved', generation)

      return false
    }

    const runtime = await this.options.runtime()
    this.assertScope(scope, generation)
    const home = await this.prepareHome(claimed.conversation_id, binding.assistant, snapshot.soulBytes)

    try {
      this.assertScope(scope, generation)
      preflight = await this.heartbeat(scope, claimed, generation)

      if (
        preflight.state !== 'ready' ||
        !preflight.context ||
        !preflight.binding ||
        preflight.binding.assistant !== binding.assistant ||
        preflight.binding.profile_identity !== binding.profile_identity ||
        preflight.binding.model_alias !== binding.model_alias ||
        preflight.binding.persona_digest !== binding.persona_digest ||
        preflight.binding.persona_revision !== binding.persona_revision
      ) {
        if (preflight.state === 'ready') {
          await this.fail(scope, claimed, 'persona_not_approved', generation)
        } else {
          await this.closeNonReady(scope, claimed, preflight, generation)
        }

        return preflight.state === 'completed'
      }

      const credential = this.options.device.credentialForAccount(scope.accountId)

      if (!credential) {
        fail('credential_unavailable')
      }

      const pending: PersistedJob = state.jobs[claimed.job_id] ?? {
        jobId: claimed.job_id,
        conversationId: claimed.conversation_id,
        leaseToken: claimed.lease_token,
        reservationId: claimed.reservation_id,
        replyId: null,
        replyText: null
      }

      pending.leaseToken = claimed.lease_token
      pending.conversationId = claimed.conversation_id

      state.jobs[claimed.job_id] = pending
      this.saveState(scope, state, generation)

      const token = this.options.proxy.issueSharedJobToken({
        jobId: claimed.job_id,
        leaseToken: claimed.lease_token,
        alias: binding.model_alias,
        accountId: scope.accountId,
        baseUrl: scope.baseUrl,
        deviceCredential: () => {
          this.assertScope(scope, generation)

          return this.options.device.credentialForAccount(scope.accountId)
        },
        onReservation: async reservationId => {
          this.assertScope(scope, generation)
          pending.reservationId = reservationId
          this.saveState(scope, state, generation)
        }
      })

      this.running = {
        accountId: scope.accountId,
        generation,
        jobId: claimed.job_id,
        cancel: () => undefined,
        revoke: token.revoke
      }

      try {
        const launch = this.childLaunch(runtime, home, token.baseUrl, token.token)

        const result = await this.runChild(
          {
            profile: PROFILE,
            job_id: claimed.job_id,
            model: binding.model_alias,
            base_url: token.baseUrl,
            persona_digest: binding.persona_digest,
            context: preflight.context
          },
          launch,
          cancelChild => {
            if (this.running?.jobId !== claimed.job_id) {
              return
            }

            this.running = {
              accountId: scope.accountId,
              generation,
              jobId: claimed.job_id,
              cancel: () => {
                cancelChild()
              },
              revoke: token.revoke
            }
          }
        )

        this.assertScope(scope, generation)

        if (result.state !== 'completed' || result.job_id !== claimed.job_id || result.profile !== PROFILE) {
          fail('child_result_invalid')
        }

        pending.replyText = replyText(result.reply_text)
        pending.replyId = randomUUID()
        this.saveState(scope, state, generation)

        return await this.completeExact(scope, pending, generation)
      } finally {
        token.revoke()

        if (this.running?.jobId === claimed.job_id) {
          this.running = null
        }
      }
    } finally {
      // Group history is canonical server state; the child home is disposable.
      // runChild resolves only after its process has actually exited.
      await rm(home, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async preflight(scope: SharedGroupAccountScope, job: ClaimedJob, generation: number): Promise<Preflight> {
    const route = `/api/desktop/v1/group-conversations/${job.conversation_id}/jobs/${job.job_id}/preflight`

    const response = parsePreflight(
      await this.request(route, { method: 'POST', body: JSON.stringify({ lease_token: job.lease_token }) }),
      job.job_id,
      job.conversation_id
    )

    this.assertScope(scope, generation)

    return response
  }

  private async heartbeat(scope: SharedGroupAccountScope, job: ClaimedJob, generation: number): Promise<Preflight> {
    const route = `/api/desktop/v1/group-conversations/${job.conversation_id}/jobs/${job.job_id}/heartbeat`

    const response = parsePreflight(
      await this.request(route, { method: 'POST', body: JSON.stringify({ lease_token: job.lease_token }) }),
      job.job_id,
      job.conversation_id
    )

    this.assertScope(scope, generation)

    return response
  }

  private async completeExact(
    scope: SharedGroupAccountScope,
    pending: PersistedJob,
    generation: number
  ): Promise<boolean> {
    if (!pending.replyId || !pending.replyText) {
      return false
    }

    const preflight = parsePreflight(
      await this.request(
        `/api/desktop/v1/group-conversations/${pending.conversationId}/jobs/${pending.jobId}/preflight`,
        {
          method: 'POST',
          body: JSON.stringify({ lease_token: pending.leaseToken })
        }
      ),
      pending.jobId,
      pending.conversationId
    )

    this.assertScope(scope, generation)

    const job = {
      job_id: pending.jobId, conversation_id: pending.conversationId,
      lease_token: pending.leaseToken, reservation_id: pending.reservationId, request: preflight
    }

    if (preflight.state !== 'ready') {
      await this.closeNonReady(scope, job, preflight, generation)

      return preflight.state === 'completed'
    }

    const result = await this.request(`/api/desktop/v1/group-conversations/${pending.conversationId}/jobs/${pending.jobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        lease_token: pending.leaseToken,
        reply_id: pending.replyId,
        reply_text: pending.replyText
      })
    })

    this.assertScope(scope, generation)
    const completed = parsePreflight(result, pending.jobId, pending.conversationId)

    if (completed.state === 'ready') {fail('completion_invalid')}
    await this.closeNonReady(scope, job, completed, generation)

    return completed.state === 'completed'
  }

  private forget(scope: SharedGroupAccountScope, jobId: string, generation: number): void {
    const state = this.readState(scope)
    delete state.jobs[jobId]
    this.saveState(scope, state, generation)
  }

  private async closeNonReady(scope: SharedGroupAccountScope, job: ClaimedJob, result: Preflight, generation: number): Promise<void> {
    if (result.state === 'denied') {
      await this.fail(scope, job, 'shared_execution_denied', generation)
    } else if (result.state === 'completed') {
      this.forget(scope, job.job_id, generation)
    }
  }

  private async fail(scope: SharedGroupAccountScope, job: ClaimedJob, code: string, generation: number): Promise<void> {
    const allowed = new Set([
      'persona_not_approved',
      'runtime_unavailable',
      'runtime_failed',
      'provider_reply_unavailable',
      'account_changed',
      'shared_execution_denied'
    ])

    const result = await this.request(`/api/desktop/v1/group-conversations/${job.conversation_id}/jobs/${job.job_id}/fail`, {
      method: 'POST',
      body: JSON.stringify({ lease_token: job.lease_token, error_code: allowed.has(code) ? code : 'runtime_failed' })
    })

    this.assertScope(scope, generation)

    if (record(result)?.ok !== true) {fail('failure_ack_invalid')}
    this.forget(scope, job.job_id, generation)
  }

  private async request(path: string, input: RequestInit): Promise<unknown> {
    if (!path.startsWith('/api/desktop/v1/group-conversations/')) {
      fail('request_path_invalid')
    }

    return this.options.device.authenticatedRequest(path, input)
  }

  private async prepareHome(conversationId: string, assistantId: string, soul: Buffer): Promise<string> {
    if (!isUuid(conversationId) || !isUuid(assistantId)) {
      fail('isolated_path_invalid')
    }

    const root = resolve(this.options.userDataPath, 'atum-messaging', 'shared-group-homes')
    const home = resolve(root, conversationId, assistantId)
    assertWithin(root, home)
    const hermesHome = join(home, '.hermes')
    const workspace = join(home, 'workspace')
    await mkdir(hermesHome, { recursive: true, mode: 0o700 })
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    await this.atomic(join(hermesHome, 'SOUL.md'), soul)
    await this.atomic(join(hermesHome, 'config.yaml'), Buffer.from('agent:\n  environment_probe: false\n', 'utf8'))

    return home
  }

  private async atomic(path: string, content: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, path)
  }

  private childLaunch(
    runtime: SharedGroupRuntime,
    home: string,
    baseUrl: string,
    token: string
  ): SharedGroupChildLaunch {
    if (!runtime.pythonPath || !runtime.sourceRoot || !runtime.path || !baseUrl.startsWith('http://127.0.0.1:')) {
      fail('runtime_unavailable')
    }

    const hermesHome = join(home, '.hermes')
    const workspace = join(home, 'workspace')
    assertWithin(home, hermesHome)
    assertWithin(home, workspace)

    return {
      command: runtime.pythonPath,
      args: ['-m', 'hermes_cli.shared_group_turn'],
      cwd: workspace,
      env: {
        HOME: home,
        HERMES_HOME: hermesHome,
        PATH: runtime.path,
        PYTHONPATH: [runtime.sourceRoot, ...(runtime.pythonPathEntries ?? [])].join(sep === '\\' ? ';' : ':'),
        PYTHONDONTWRITEBYTECODE: '1',
        SHARED_MODEL_API_KEY: token,
        NO_PROXY: '127.0.0.1',
        no_proxy: '127.0.0.1',
        USER: 'shared',
        LOGNAME: 'shared',
        HOSTNAME: 'atum-shared-group',
        AWS_EC2_METADATA_DISABLED: 'true',
        TIRITH_ENABLED: 'false',
        LANG: 'C.UTF-8',
        TZ: 'UTC'
      }
    }
  }

  private async runChild(
    input: SharedGroupChildInput,
    launch: SharedGroupChildLaunch,
    onStart: (cancel: () => void) => void
  ): Promise<SharedGroupChildResult> {
    if (this.options.executeChild) {
      onStart(() => undefined)

      return this.options.executeChild(input, launch)
    }

    return new Promise((resolveResult, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let cancelled = false
      onStart(() => {
        cancelled = true
        child.kill('SIGTERM')
      })

      let timedOut = false
      let killTimer: ReturnType<typeof setTimeout> | undefined

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
        killTimer.unref?.()
      }, this.timeoutMs)

      child.stderr.resume()
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
      })
      child.once('error', () => {
        clearTimeout(timer)
        reject(new Error('shared_group_runner_runtime_unavailable'))
      })
      child.once('close', code => {
        clearTimeout(timer)

        if (killTimer) {clearTimeout(killTimer)}

        if (cancelled) {
          return reject(new Error('shared_group_runner_account_changed'))
        }

        if (timedOut || code !== 0) {
          return reject(new Error('shared_group_runner_runtime_failed'))
        }

        try {
          resolveResult(JSON.parse(stdout) as SharedGroupChildResult)
        } catch {
          reject(new Error('shared_group_runner_child_result_invalid'))
        }
      })
      child.stdin.end(JSON.stringify(input))
    })
  }
}
