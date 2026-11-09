import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { MessagingClientBoundary } from './types'

export interface PrivateAdvisoryMessage {
  id: string
  version: number
  sequence: number
  speaker: { kind: 'owner' | 'specialist' | 'assistant'; id: string }
  text: string
}

export interface PrivateAdvisoryContext {
  mode: 'private_advisory'
  conversation_id: string
  audience_revision: number
  advisor: { kind: 'specialist' | 'assistant'; id: string }
  context_revision: number
  invalidations: Array<{ message_id: string; version: number; kind: 'recalled' | 'superseded' }>
  messages: PrivateAdvisoryMessage[]
  watermark: { sequence: number; message_id: string }
}

export interface PrivateAdvisoryJobRequest {
  job_id: string
  turn_id: string
  conversation_id: string
  source_message_id: string
  round: { id: string; slot: number }
  audience_revision: number
  target: { type: 'assistant'; id: string }
  subject: null
  context: PrivateAdvisoryContext
}

export interface ClaimedPrivateAdvisoryJob {
  job_id: string
  lease_token: string
  request: PrivateAdvisoryJobRequest
}

export interface PrivateAdvisoryClient extends Pick<MessagingClientBoundary, 'status'> {
  advisoryClaim(clientOperationId: string): Promise<{ job: ClaimedPrivateAdvisoryJob | null; replayed: boolean }>
  advisoryComplete(conversationId: string, jobId: string, leaseToken: string, replyText: string): Promise<void>
  advisoryFail(
    conversationId: string,
    jobId: string,
    leaseToken: string,
    errorCode: string,
    retryable: boolean
  ): Promise<void>
  advisoryPreflight(conversationId: string, jobId: string, leaseToken: string): Promise<PrivateAdvisoryJobRequest>
  advisoryHeartbeat(
    conversationId: string,
    jobId: string,
    leaseToken: string
  ): Promise<{ request: PrivateAdvisoryJobRequest; nextHeartbeatSeconds: number }>
  advisoryRefresh(input: {
    conversationId: string
    subjectId: string
    installationId: string
    linkEpoch: number
  }): Promise<{ context: PrivateAdvisoryContext }>
}

export interface AdvisoryRunnerDispatch {
  job_id: string
  request: PrivateAdvisoryJobRequest
  runtime_session_id: string | null
  durable_session_id: string | null
  account_id: string
}

interface PersistedJob {
  accountId: string
  jobId: string
  conversationId: string
  request: PrivateAdvisoryJobRequest
  state: 'claimed' | 'running' | 'publishing' | 'completed' | 'failed' | 'cancelled'
  runtimeSessionId: string | null
  durableSessionId: string | null
  /** Local owned Hermes profile resolved from the platform assistant identity. */
  profile: string | null
  replyText: string | null
  updatedAt: string
}

interface PersistedState {
  version: 1
  jobs: Record<string, PersistedJob>
}

const EMPTY: PersistedState = { version: 1, jobs: {} }
const MAX_REPLY_CODEPOINTS = 20_000

function boundedText(value: string): string {
  const text = value.trim()

  if (!text || Array.from(text).length > MAX_REPLY_CODEPOINTS) {
    throw new Error('reply_text_invalid')
  }

  return text
}

/**
 * Main-process owner for advisory jobs. The lease token and account binding
 * never cross preload. The renderer receives only the platform projection and
 * can only settle the job currently recorded here.
 */
export class PrivateAdvisoryRunner {
  private state: PersistedState = EMPTY
  private readonly dispatched = new Set<string>()
  private readonly leases = new Map<string, string>()
  private readonly heartbeats = new Map<string, ReturnType<typeof setTimeout>>()
  private ready: Promise<void> | null = null

  constructor(
    private readonly client: PrivateAdvisoryClient,
    private readonly statePath: string,
    private readonly dispatch: (job: AdvisoryRunnerDispatch) => void,
    private readonly cancel: (jobId: string, runtimeSessionId: string | null, durableSessionId: string | null) => void
  ) {}

  async claim(clientOperationId: string): Promise<{ claimed: boolean; replayed: boolean; jobId: string | null }> {
    await this.load()
    const accountId = (await this.client.status()).accountId

    if (!accountId) {
      throw new Error('advisory_account_unavailable')
    }

    await this.cancelOtherAccounts(accountId)
    const result = await this.client.advisoryClaim(clientOperationId)
    const claimed = result.job

    if (!claimed) {
      return { claimed: false, replayed: result.replayed, jobId: null }
    }

    // A network claim can span an account switch. Do not save or dispatch under
    // the account observed before the request.
    if ((await this.client.status()).accountId !== accountId) {
      throw new Error('advisory_account_changed')
    }

    this.leases.set(claimed.job_id, claimed.lease_token)
    claimed.request = await this.client.advisoryPreflight(
      claimed.request.conversation_id,
      claimed.job_id,
      claimed.lease_token
    )
    this.assertRequestScope(claimed.request, claimed.job_id, claimed.request.conversation_id)
    await this.assertClaimAccount(accountId)
    const existing = this.state.jobs[claimed.job_id]

    if (existing?.accountId === accountId && existing.replyText) {
      // A lost completion acknowledgement is recovered by publishing the exact
      // durable result with the freshly claimed lease, never by regenerating.
      await this.publish(existing, existing.replyText)

      return { claimed: false, replayed: true, jobId: claimed.job_id }
    }

    if (
      existing?.accountId === accountId &&
      (existing.state === 'claimed' || existing.state === 'running') &&
      this.dispatched.has(claimed.job_id)
    ) {
      return { claimed: false, replayed: true, jobId: claimed.job_id }
    }

    this.state.jobs[claimed.job_id] = {
      accountId,
      jobId: claimed.job_id,
      conversationId: claimed.request.conversation_id,
      request: claimed.request,
      state: existing?.state === 'running' ? 'running' : 'claimed',
      runtimeSessionId: existing?.runtimeSessionId ?? null,
      durableSessionId: existing?.durableSessionId ?? null,
      profile: existing?.profile ?? null,
      replyText: existing?.replyText ?? null,
      updatedAt: new Date().toISOString()
    }
    await this.save()
    this.dispatched.add(claimed.job_id)
    this.dispatch({
      job_id: claimed.job_id,
      request: claimed.request,
      runtime_session_id: existing?.runtimeSessionId ?? null,
      durable_session_id: existing?.durableSessionId ?? null,
      account_id: accountId
    })

    return { claimed: true, replayed: result.replayed, jobId: claimed.job_id }
  }

  /**
   * A renderer reload loses its listeners and in-memory gateway map while main
   * still holds the lease. Revalidate every active lease before redelivery;
   * a main-process restart has no lease and waits for the normal claim path.
   */
  async attachRenderer(): Promise<{ attached: number }> {
    await this.load()
    const accountId = (await this.client.status()).accountId

    if (!accountId) {
      await this.cancelWhere(() => true)

      return { attached: 0 }
    }

    await this.cancelOtherAccounts(accountId)
    let attached = 0
    let changed = false

    for (const job of Object.values(this.state.jobs)) {
      if (job.accountId !== accountId || (job.state !== 'claimed' && job.state !== 'running')) {
        continue
      }

      const lease = this.leases.get(job.jobId)

      // Leases deliberately do not survive a main-process restart. The claim
      // loop will obtain a fresh lease and authoritative request projection.
      if (!lease) {
        continue
      }

      try {
        const fresh = await this.client.advisoryPreflight(job.conversationId, job.jobId, lease)
        await this.assertClaimAccount(accountId)
        this.assertRequestScope(fresh, job.jobId, job.conversationId)
        const priorRevision = job.request.context?.context_revision

        if (priorRevision !== undefined && priorRevision !== fresh.context.context_revision) {
          this.cancel(job.jobId, job.runtimeSessionId, job.durableSessionId)
          job.request = fresh
          job.state = 'claimed'
          job.runtimeSessionId = null
          job.durableSessionId = null
        } else {
          job.request = fresh

          if (job.state === 'running') {
            this.scheduleHeartbeat(job, 30)
          }
        }

        job.updatedAt = new Date().toISOString()
        changed = true
        attached += 1
        this.dispatch({
          job_id: job.jobId,
          request: job.request,
          runtime_session_id: job.runtimeSessionId,
          durable_session_id: job.durableSessionId,
          account_id: job.accountId
        })
      } catch {
        // A renderer attachment must have an authority-fresh projection. Stop
        // the local turn instead of renewing a lease with no safe attachment.
        await this.cancelWhere(candidate => candidate.jobId === job.jobId)
        changed = true
      }
    }

    if (changed) {
      await this.save()
    }

    return { attached }
  }

  async running(
    jobId: string,
    runtimeSessionId: string,
    durableSessionId?: string | null,
    profile?: string | null
  ): Promise<void> {
    await this.load()
    const job = this.state.jobs[jobId]

    if (!job || (job.state !== 'claimed' && job.state !== 'running')) {
      throw new Error('advisory_job_not_claimed')
    }

    await this.assertAccount(job)
    job.state = 'running'
    job.runtimeSessionId = runtimeSessionId

    if (durableSessionId) {
      job.durableSessionId = durableSessionId
    }

    if (profile) {
      job.profile = profile
    }

    job.updatedAt = new Date().toISOString()
    await this.save()
    this.scheduleHeartbeat(job, 30)
  }

  /** Main-only retrieval scope. Private discovery does not depend on job receipts. */
  async searchConversation(
    accountId: string,
    runtimeSessionId: string,
    assistantId: string,
    source: 'desktop' | 'atum-private-advisory'
  ): Promise<string | null> {
    if ((await this.client.status()).accountId !== accountId) {
      throw new Error('advisory_account_changed')
    }

    if (source === 'desktop') {
      return null
    }

    await this.load()

    const job = Object.values(this.state.jobs).find(
      candidate =>
        candidate.accountId === accountId &&
        candidate.state === 'running' &&
        candidate.runtimeSessionId === runtimeSessionId &&
        candidate.request.target.id === assistantId
    )

    const lease = job && this.leases.get(job.jobId)

    if (!job || !lease) {
      throw new Error('advisory_job_not_active')
    }

    const fresh = await this.client.advisoryPreflight(job.conversationId, job.jobId, lease)
    this.assertRequestScope(fresh, job.jobId, job.conversationId)
    await this.assertAccount(job)

    if (job.state !== 'running' || fresh.target.id !== assistantId) {
      throw new Error('advisory_job_not_active')
    }

    return job.conversationId
  }

  async complete(jobId: string, replyText: string): Promise<void> {
    await this.load()
    const job = this.state.jobs[jobId]

    if (!job || job.state === 'cancelled' || job.state === 'failed' || job.state === 'completed') {
      throw new Error('advisory_job_not_active')
    }

    await this.assertAccount(job)
    const reply = boundedText(replyText)

    if (job.replyText && job.replyText !== reply) {
      throw new Error('advisory_job_already_completed')
    }

    // Commit canonical output before crossing the network. If the response is
    // lost, reclaim publishes this exact text with a new lease.
    job.replyText = reply
    job.state = 'publishing'
    job.updatedAt = new Date().toISOString()
    await this.save()
    await this.publish(job, reply)
  }

  async fail(jobId: string, errorCode: string, retryable: boolean): Promise<void> {
    await this.load()
    const job = this.state.jobs[jobId]

    if (!job || job.state === 'cancelled' || job.state === 'completed') {
      return
    }

    await this.assertAccount(job)
    const code = errorCode.trim().slice(0, 120) || 'assistant_execution_failed'
    await this.client.advisoryFail(job.conversationId, job.jobId, this.leaseFor(job), code, retryable)
    job.state = 'failed'
    job.updatedAt = new Date().toISOString()
    await this.save()
  }

  async cancelConversation(conversationId: string, targetId?: string): Promise<void> {
    await this.load()
    await this.cancelWhere(
      job => job.conversationId === conversationId && (!targetId || job.request.target.id === targetId)
    )
  }

  /** The account authority is being torn down: no outstanding lease may survive it. */
  async revokeAll(): Promise<void> {
    await this.load()
    await this.cancelWhere(() => true)
  }

  /** Account transitions invalidate all outstanding leases before any late renderer completion can publish. */
  async revokeInactiveAccount(): Promise<void> {
    await this.load()
    const accountId = (await this.client.status()).accountId

    if (accountId) {
      await this.cancelOtherAccounts(accountId)
    } else {
      await this.cancelWhere(() => true)
    }
  }

  private async publish(job: PersistedJob, replyText: string): Promise<void> {
    await this.assertAccount(job)
    await this.client.advisoryComplete(job.conversationId, job.jobId, this.leaseFor(job), replyText)
    // Recheck after the hosted call as account transitions can race an ACK.
    await this.assertAccount(job)
    job.state = 'completed'
    this.clearHeartbeat(job.jobId)
    job.updatedAt = new Date().toISOString()
    await this.save()
  }

  private scheduleHeartbeat(job: PersistedJob, seconds: number): void {
    this.clearHeartbeat(job.jobId)
    this.heartbeats.set(
      job.jobId,
      setTimeout(() => void this.heartbeat(job.jobId), seconds * 1000)
    )
  }

  private clearHeartbeat(jobId: string): void {
    const timer = this.heartbeats.get(jobId)

    if (timer) {
      clearTimeout(timer)
    }

    this.heartbeats.delete(jobId)
  }

  private async heartbeat(jobId: string): Promise<void> {
    const job = this.state.jobs[jobId]

    if (!job || job.state !== 'running') {
      return
    }

    try {
      await this.assertAccount(job)
      const beat = await this.client.advisoryHeartbeat(job.conversationId, job.jobId, this.leaseFor(job))
      await this.assertAccount(job)
      this.assertRequestScope(beat.request, job.jobId, job.conversationId)

      if (beat.request.context.context_revision !== job.request.context.context_revision) {
        // Edits/recalls change the complete projection. Interrupt the old Hermes
        // turn and restart only after replacing its context with the fenced one.
        this.cancel(job.jobId, job.runtimeSessionId, job.durableSessionId)
        job.request = beat.request
        job.state = 'claimed'
        job.runtimeSessionId = null
        job.durableSessionId = null
        job.updatedAt = new Date().toISOString()
        await this.save()
        this.dispatch({
          job_id: job.jobId,
          request: job.request,
          runtime_session_id: null,
          durable_session_id: null,
          account_id: job.accountId
        })

        return
      }

      this.scheduleHeartbeat(job, beat.nextHeartbeatSeconds)
    } catch {
      // Lost authority or an expired lease must not leave a hidden turn alive.
      await this.cancelWhere(candidate => candidate.jobId === jobId)
    }
  }

  private assertRequestScope(request: PrivateAdvisoryJobRequest, jobId: string, conversationId: string): void {
    if (
      request.job_id !== jobId ||
      request.conversation_id !== conversationId ||
      request.target.type !== 'assistant' ||
      request.context.mode !== 'private_advisory' ||
      request.context.conversation_id !== conversationId ||
      request.context.advisor.kind !== 'assistant' ||
      request.context.advisor.id !== request.target.id
    ) {
      throw new Error('advisory_preflight_scope_mismatch')
    }
  }

  private async assertClaimAccount(accountId: string): Promise<void> {
    if ((await this.client.status()).accountId !== accountId) {
      throw new Error('advisory_account_changed')
    }
  }

  private leaseFor(job: PersistedJob): string {
    const lease = this.leases.get(job.jobId)

    if (!lease) {
      throw new Error('advisory_lease_unavailable')
    }

    return lease
  }

  private async assertAccount(job: PersistedJob): Promise<void> {
    const accountId = (await this.client.status()).accountId

    if (accountId === job.accountId) {
      return
    }

    await this.cancelWhere(candidate => candidate.jobId === job.jobId)
    throw new Error('advisory_account_changed')
  }

  private async cancelOtherAccounts(accountId: string): Promise<void> {
    await this.cancelWhere(job => job.accountId !== accountId)
  }

  private async cancelWhere(predicate: (job: PersistedJob) => boolean): Promise<void> {
    let changed = false

    for (const job of Object.values(this.state.jobs)) {
      if (!predicate(job) || job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
        continue
      }

      job.state = 'cancelled'
      job.updatedAt = new Date().toISOString()
      this.dispatched.delete(job.jobId)
      this.clearHeartbeat(job.jobId)
      this.leases.delete(job.jobId)
      this.cancel(job.jobId, job.runtimeSessionId, job.durableSessionId)
      changed = true
    }

    if (changed) {
      await this.save()
    }
  }

  private async load(): Promise<void> {
    this.ready ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedState

        if (raw?.version === 1 && raw.jobs && typeof raw.jobs === 'object') {
          this.state = raw
        }
      } catch {
        this.state = { version: 1, jobs: {} }
      }
    })()
    await this.ready
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.tmp`

    // Platform messages are a short-lived execution projection. Persist only
    // job/session identity and canonical replies; reclaim/attach always fetch
    // a fresh projection before a renderer can execute it.
    const stateForDisk = {
      version: this.state.version,
      jobs: Object.fromEntries(
        Object.entries(this.state.jobs).map(([jobId, job]) => [
          jobId,
          { ...job, request: { ...job.request, context: undefined } }
        ])
      )
    }

    await writeFile(temporary, JSON.stringify(stateForDisk), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.statePath)
  }
}

export function privateAdvisoryRunnerStatePath(userDataPath: string): string {
  return join(userDataPath, 'atum-messaging', 'private-advisory-jobs.json')
}
