import { createHash, randomUUID } from 'node:crypto'

import { normalizeAwarenessRevision, sourceKey, validSource } from './normalize'
import type {
  AwarenessBatch,
  AwarenessCoverage,
  AwarenessCoverageReason,
  AwarenessCoverageState,
  AwarenessEnvelope,
  AwarenessObject,
  AwarenessReadAccess,
  AwarenessReceipt,
  AwarenessRevision,
  AwarenessSource,
  AwarenessStore,
  AwarenessTransport,
  AwarenessWithdrawal,
  AwarenessWithdrawalReceipt,
  AwarenessWithdrawalScope
} from './types'

interface PendingRevision {
  operationId: string
  fingerprint: string
  observedTime: number
  object: AwarenessObject
}
interface SourceState {
  source: AwarenessSource
  epoch: number
  inclusion: 'included' | 'excluded' | 'left'
  temporary: boolean
  complete: boolean
  processedThrough?: number
  pending?: PendingRevision
  receipt?: AwarenessReceipt
}
interface WithdrawalState {
  request: AwarenessWithdrawal
  receipt?: AwarenessWithdrawalReceipt
}
interface ReaderState {
  v: 1
  binding: string
  destination: 'managed' | 'local'
  sources: SourceState[]
  withdrawals: WithdrawalState[]
  fence?: { since: number; acknowledged: boolean }
}
export interface AwarenessReaderOptions {
  /** Opaque native account/device binding (not a wire owner field). */
  binding: string
  destination: 'managed' | 'local'
  store: AwarenessStore
  transport: AwarenessTransport
  readAccess(source: AwarenessSource): AwarenessReadAccess
  /** Native lifecycle admission, including expiry/revocation, for every dispatch. */
  live(): boolean
  now?(): number
  /** Bounded transport wait, default 10s. A timeout is unknown, not a refusal. */
  requestTimeoutMs?: number
  /** Only initial native provisioning may create a missing metadata store.
   * Restart/restore leaves false; loss of tombstones must not look like fresh use. */
  create?: boolean
}

/** One owner-bound, single-writer ingestion projection. SDK sync/decryption,
 * same-device MAS rotation, encrypted custody and process confinement are RT's
 * adapters, not implemented by this module. No scheduler, commands or model tools. */
export class AwarenessReader {
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private failed = false
  private generation = 0
  private fenceSince?: number
  private readonly blocked = new Set<string>()
  private readonly status = new Map<string, { state: AwarenessCoverageState; reasons: AwarenessCoverageReason[] }>()

  private constructor(
    private readonly options: AwarenessReaderOptions,
    private readonly state: ReaderState
  ) {
    this.fenceSince = state.fence?.since

    for (const row of state.sources) {
      this.status.set(sourceKey(row.source), { state: 'catching_up', reasons: ['backfill_pending'] })
    }
  }

  static async open(options: AwarenessReaderOptions): Promise<AwarenessReader> {
    if (
      !ref(options.binding) ||
      !['managed', 'local'].includes(options.destination) ||
      (options.requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.requestTimeoutMs) ||
          options.requestTimeoutMs < 1 ||
          options.requestTimeoutMs > 60_000))
    ) {
      throw new Error('awareness_binding_invalid')
    }

    const value = await options.store.read()

    if (value === null && options.create !== true) {
      throw new Error('awareness_store_missing')
    }

    const state: ReaderState =
      value === null
        ? { v: 1, binding: options.binding, destination: options.destination, sources: [], withdrawals: [] }
        : readState(value, options)

    // Initial provisioning must become durable even while trust or the first
    // source is pending. A restart must never mistake an empty reader for loss.
    if (value === null) {
      await options.store.write(state)
    }

    return new AwarenessReader(options, state)
  }

  /** Immediate lifecycle stop also fences work awaiting refresh/receipt. */
  stop(): void {
    this.stopped = true
    this.generation++
  }

  register(source: AwarenessSource, temporary = false): Promise<void> {
    const copy = copySource(source)

    return this.serial(async () => {
      if (!this.state.sources.some(row => sourceKey(row.source) === sourceKey(copy))) {
        this.state.sources.push({
          source: copy,
          epoch: 1,
          inclusion: temporary ? 'excluded' : 'included',
          temporary,
          complete: false
        })
        await this.save()
      }
    })
  }

  /** Owner control. Reinclusion cannot be automatic and cannot erase tombstones. */
  setIncluded(source: AwarenessSource, included: boolean): Promise<boolean> {
    if (typeof included !== 'boolean') {
      throw new Error('awareness_inclusion_invalid')
    }

    const copy = copySource(source)
    const key = sourceKey(copy)
    this.generation++

    if (!included) {
      this.blocked.add(key)
    }

    return this.serial(async () => {
      const row = this.source(copy)

      if (included) {
        if (!(await this.flushControls())) {
          return false
        }

        if (row.inclusion !== 'included') {
          row.epoch = nextEpoch(row.epoch)
          row.inclusion = 'included'
          row.temporary = false
          row.complete = false
          delete row.pending
          delete row.processedThrough
          await this.save()
        }

        this.blocked.delete(key)
        this.status.delete(key)

        return true
      }

      if (row.inclusion !== 'excluded') {
        row.epoch = nextEpoch(row.epoch)
        row.inclusion = 'excluded'
        this.enqueueWithdrawal({ kind: 'source', source: copy }, 'exclude', row.epoch)
        await this.save()
      }

      return this.flushControls()
    })
  }

  /** Current native membership/access, not renderer membership. Deliberate
   * exclusion survives leave/rejoin. Lost keys alone use keysChanged instead. */
  membership(source: AwarenessSource, membership: 'joined' | 'left' | 'revoked'): Promise<boolean> {
    if (!['joined', 'left', 'revoked'].includes(membership)) {
      throw new Error('awareness_membership_invalid')
    }

    const copy = copySource(source)
    const key = sourceKey(copy)
    this.generation++

    if (membership !== 'joined') {
      this.blocked.add(key)
    }

    return this.serial(async () => {
      const row = this.source(copy)

      if (membership === 'joined') {
        if (!(await this.flushControls())) {
          return false
        }

        if (row.inclusion === 'left') {
          row.epoch = nextEpoch(row.epoch)
          row.inclusion = 'included'
          row.complete = false
          delete row.pending
          delete row.processedThrough
          await this.save()
        }

        if (row.inclusion === 'included') {
          this.blocked.delete(key)
        }

        return row.inclusion === 'included'
      }

      if (row.inclusion === 'included') {
        row.epoch = nextEpoch(row.epoch)
        row.inclusion = 'left'
        this.enqueueWithdrawal(
          { kind: 'source', source: copy },
          membership === 'left' ? 'left_room' : 'revoked',
          row.epoch
        )
        await this.save()
      }

      return this.flushControls()
    })
  }

  /** Key/visibility changes invalidate a prepared dispatch. Recovery never
   * claims caught-up coverage until a new authenticated scan closes the gap. */
  keysChanged(source: AwarenessSource): void {
    const row = this.source(copySource(source))
    this.generation++
    this.status.set(sourceKey(row.source), { state: 'catching_up', reasons: ['backfill_pending'] })
  }

  /** Sticky earliest fence. Set the in-memory guard before awaiting durability,
   * including during an in-flight transport.prepare/token refresh. */
  observeFence(value: { v: 1; since: number }): Promise<boolean> {
    if (!exact(value, ['v', 'since']) || value.v !== 1 || !time(value.since)) {
      throw new Error('awareness_fence_invalid')
    }

    this.fenceSince = Math.min(this.fenceSince ?? value.since, value.since)
    this.generation++

    return this.serial(async () => {
      if (!this.state.fence || this.state.fence.since > this.fenceSince!) {
        this.state.fence = { since: this.fenceSince!, acknowledged: false }
        await this.save()
      }

      return this.flushControls()
    })
  }

  /** A native owner withdrawal. Returns true only after recorded is validated
   * and its suppression IDs are durable locally. Failure retains the outbox. */
  withdraw(scope: AwarenessWithdrawalScope, reason: 'forget' | 'delete' | 'account_deleted'): Promise<boolean> {
    if (
      !validScope(scope) ||
      !['forget', 'delete', 'account_deleted'].includes(reason) ||
      (reason === 'account_deleted' && scope.kind !== 'account')
    ) {
      throw new Error('awareness_withdrawal_invalid')
    }

    const copy = structuredClone(scope)
    this.generation++

    // Immediate fail-closed barrier for work already awaiting prepare.
    this.blocked.add('*')

    return this.serial(async () => {
      this.enqueueWithdrawal(copy, reason)
      await this.save()
      this.blocked.delete('*')

      return this.flushControls()
    })
  }

  /** Replays controls before any content, including after restart. */
  retryControls(): Promise<boolean> {
    return this.serial(() => this.flushControls())
  }

  /** The caller must supply a contiguous, authenticated source scan. Receipts
   * permit a checkpoint; max(eventTime), SDK tokens and partial scans do not.
   * Filtered/key-missing/invalid content leaves a gap, while eligible unmarked
   * events in the same batch can still flow. One unknown receipt blocks newer
   * revisions until its exact source revision is reread, not cached plaintext. */
  ingest(batch: AwarenessBatch, checkpoint = true): Promise<AwarenessCoverage> {
    const copy = structuredClone(batch)

    return this.serial(async () => {
      const row = this.source(copySource(copy.source))
      const key = sourceKey(row.source)

      if (
        !time(copy.through) ||
        (copy.after !== null &&
          (!time(copy.after) ||
            row.processedThrough === undefined ||
            copy.after > row.processedThrough ||
            copy.after > copy.through)) ||
        typeof copy.complete !== 'boolean' ||
        !Array.isArray(copy.revisions) ||
        copy.revisions.length > 200 ||
        copy.revisions.some(revision => !validSource(revision?.source) || sourceKey(revision.source) !== key)
      ) {
        throw new Error('awareness_batch_invalid')
      }

      if (!(await this.flushControls()) && this.state.withdrawals.some(withdrawal => !withdrawal.receipt)) {
        this.status.set(key, { state: 'offline', reasons: ['service_unavailable'] })

        return this.coverage(row.source)
      }

      const generation = this.generation
      let gap = false
      let fenced = 0
      let sent = 0
      this.status.delete(key)

      for (const revision of copy.revisions) {
        const denied = this.accessIssue(row, revision)

        if (denied) {
          this.status.set(key, denied)
          gap = true

          continue
        }

        if (this.suppressed(revision)) {
          // A durable permanent withdrawal authorizes skipping this object.
          // A matching forgotten object also clears its unknown receipt: a
          // later replay cannot resurrect it merely to unblock the checkpoint.
          if (
            row.pending &&
            (row.pending.object.replaces ?? row.pending.object.id) === (revision.object.replaces ?? revision.object.id)
          ) {
            delete row.pending
            await this.save()
          }

          continue
        }

        const result = normalizeAwarenessRevision(revision, {
          destination: this.options.destination,
          operationId: row.pending?.operationId ?? randomUUID(),
          observedTime: row.pending?.observedTime ?? this.now(),
          epoch: row.epoch,
          visibility: this.options.readAccess(row.source).visibility,
          accountFence: this.fenceSince !== undefined
        })

        if (result.kind !== 'envelope') {
          gap = true

          if (result.kind === 'blocked') {
            fenced++
          } else {
            this.status.set(key, { state: 'partial', reasons: ['unsupported_media'] })
          }

          continue
        }

        const fingerprint = revisionFingerprint(result.envelope)

        if (row.pending && row.pending.fingerprint !== fingerprint) {
          this.status.set(key, { state: 'catching_up', reasons: ['backfill_pending'] })
          gap = true

          break
        }

        if (!row.pending) {
          row.pending = {
            operationId: result.envelope.operationId,
            observedTime: result.envelope.observedTime,
            fingerprint,
            object: structuredClone(result.envelope.object)
          }
          await this.save()
        }

        try {
          await this.request(signal => this.options.transport.prepare(signal))
          const lateDenied = this.accessIssue(row, revision)

          if (lateDenied || generation !== this.generation) {
            this.status.set(key, lateDenied ?? { state: 'catching_up', reasons: ['backfill_pending'] })
            gap = true

            break
          }

          // No await between the fresh fence/access check and actual dispatch.
          if (
            this.options.destination === 'managed' &&
            (result.envelope.policy.googleDerived ||
              (revision.source.kind === 'drive_file' && this.fenceSince !== undefined))
          ) {
            fenced++
            gap = true

            continue
          }

          result.envelope.policy.accountFence = this.fenceSince !== undefined
          const value = await this.request(signal => this.options.transport.ingest(result.envelope, signal))
          row.receipt = readReceipt(value, result.envelope)
          delete row.pending
          await this.save()
          sent++

          if (row.receipt.state === 'refused') {
            gap = true
            this.status.set(key, { state: 'partial', reasons: ['backfill_pending'] })
          }

          if (revision.content.attachments.some(attachment => attachment.parse !== 'parsed')) {
            gap = true
            this.status.set(key, { state: 'partial', reasons: ['unsupported_media'] })
          }
        } catch {
          this.status.set(key, { state: 'offline', reasons: ['service_unavailable'] })
          gap = true

          break
        }
      }

      if (fenced) {
        this.status.set(key, { state: sent ? 'partial' : 'paused', reasons: ['google_fence'] })
      }

      if (!checkpoint) {
        row.complete=false
        await this.save()
      } else if (!gap && !row.pending && generation === this.generation && !this.accessIssue(row)) {
        row.processedThrough = Math.max(row.processedThrough ?? 0, copy.through)
        row.complete = copy.complete
        this.status.delete(key)
        await this.save()
      }

      return this.coverage(row.source)
    })
  }

  /** RT splits one verified no-gap scan into bounded receipt batches with
   * checkpoint=false. Only their complete aggregate can close the watermark;
   * any refused/unsupported/key-missing batch leaves the prior checkpoint. */
  finishScan(source: AwarenessSource, scan: { through: number; complete: boolean }): Promise<AwarenessCoverage> {
    const copy = copySource(source)

    if (!time(scan.through) || typeof scan.complete !== 'boolean') {
      throw new Error('awareness_scan_invalid')
    }

    return this.serial(async () => {
      const row = this.source(copy), key = sourceKey(copy)
      row.complete = false

      if (!await this.flushControls()) {
        this.status.set(key, { state: 'offline', reasons: ['service_unavailable'] })
        await this.save()

        return this.coverage(copy)
      }

      if (scan.complete && !row.pending && !this.accessIssue(row)) {
        row.processedThrough = Math.max(row.processedThrough ?? 0, scan.through)
        row.complete = true
        this.status.delete(key)
      } else if (!this.accessIssue(row)) {
        this.status.set(key, { state: 'partial', reasons: ['backfill_pending'] })
      }

      await this.save()

      return this.coverage(copy)
    })
  }

  /** KS restore receipt: caller passes authenticated processedThrough, never a
   * UI count. Rewind is durable before replay. Suppression/control state survives. */
  restoreGap(source: AwarenessSource, processedThrough: number): Promise<void> {
    const copy = copySource(source)
    this.generation++

    return this.serial(async () => {
      if (!time(processedThrough)) {
        throw new Error('awareness_restore_invalid')
      }

      const row = this.source(copy)

      if (row.processedThrough === undefined || processedThrough < row.processedThrough) {
        row.processedThrough = processedThrough
        row.complete = false
        delete row.receipt
        this.status.set(sourceKey(copy), { state: 'catching_up', reasons: ['backfill_pending'] })
        await this.save()
      }
    })
  }

  coverage(source: AwarenessSource): AwarenessCoverage {
    const row = this.source(copySource(source))

    const issue =
      this.accessIssue(row) ??
      this.status.get(sourceKey(row.source)) ??
      (row.pending || !row.complete
        ? { state: 'catching_up' as const, reasons: ['backfill_pending' as const] }
        : { state: 'ready' as const, reasons: [] })

    return {
      source: structuredClone(row.source),
      ...structuredClone(issue),
      asOf: this.now(),
      ...(row.processedThrough !== undefined ? { processedThrough: row.processedThrough } : {}),
      backfill: { priorityWindowDays: 30, complete: row.complete && issue.state === 'ready' }
    }
  }

  /** Source-of-record reread hint only: no cached content, token or key. On
   * restart RT rereads this exact object before newer revisions of that source. */
  replayHint(source: AwarenessSource): AwarenessObject | undefined {
    const pending = this.source(copySource(source)).pending

    return pending && structuredClone(pending.object)
  }

  reportCoverage(): Promise<void> {
    return this.serial(async () => {
      if (!(await this.flushControls()) && this.state.withdrawals.some(withdrawal => !withdrawal.receipt)) {
        return
      }

      for (let start = 0; start < this.state.sources.length; start += 200) {
        await this.request(signal => this.options.transport.prepare(signal))
        this.assertLive()
        await this.request(signal =>
          this.options.transport.coverage(
            { entries: this.state.sources.slice(start, start + 200).map(row => this.coverage(row.source)) },
            signal
          )
        )
      }
    })
  }

  private async flushControls(): Promise<boolean> {
    try {
      for (const withdrawal of this.state.withdrawals) {
        if (withdrawal.receipt) {
          continue
        }

        await this.request(signal => this.options.transport.prepare(signal))
        this.assertLive()
        withdrawal.receipt = readWithdrawalReceipt(
          await this.request(signal => this.options.transport.withdraw(structuredClone(withdrawal.request), signal)),
          withdrawal.request
        )

        // Old uncertain ingestion cannot head-of-line-block a purged source.
        for (const row of this.state.sources) {
          const scope = withdrawal.request.scope
          const logical = row.pending && (row.pending.object.replaces ?? row.pending.object.id)

          if (
            withdrawal.request.scope.kind === 'account' ||
            (scope.kind === 'source' && sourceKey(scope.source) === sourceKey(row.source)) ||
            (logical &&
              scope.kind === 'object' &&
              sourceKey(scope.source) === sourceKey(row.source) &&
              scope.objectId === logical) ||
            (logical && scope.kind === 'fact' && scope.evidenceId === evidenceId(row.source, logical))
          ) {
            delete row.pending
            row.complete = false
          }
        }

        await this.save()
      }

      if (this.state.fence && !this.state.fence.acknowledged && this.options.destination === 'managed') {
        await this.request(signal => this.options.transport.prepare(signal))
        this.assertLive()

        const value = (await this.request(signal =>
          this.options.transport.fence({ v: 1, since: this.state.fence!.since }, signal)
        )) as { active: true; since: number }

        if (
          !exact(value, ['active', 'since']) ||
          value.active !== true ||
          !time(value.since) ||
          value.since > this.state.fence.since
        ) {
          throw new Error('awareness_fence_ack_invalid')
        }

        this.state.fence.since = value.since
        this.fenceSince = Math.min(this.fenceSince!, value.since)
        this.state.fence.acknowledged = true
        await this.save()
      }

      return true
    } catch {
      return false
    }
  }

  private enqueueWithdrawal(
    scope: AwarenessWithdrawalScope,
    reason: AwarenessWithdrawal['reason'],
    policyEpoch?: number
  ): void {
    const request = {
      operationId: randomUUID(),
      withdrawalId: randomUUID(),
      scope,
      reason,
      requestedAt: this.now(),
      ...(policyEpoch !== undefined ? { policyEpoch } : {})
    } as AwarenessWithdrawal

    this.state.withdrawals.push({ request })
  }

  private suppressed(revision: AwarenessRevision): boolean {
    return this.state.withdrawals.some(({ request }) => {
      if (['exclude', 'left_room', 'revoked'].includes(request.reason)) {
        return false
      }

      const scope = request.scope
      const logical = revision.object.replaces ?? revision.object.id

      return (
        scope.kind === 'account' ||
        (scope.kind === 'source' && sourceKey(scope.source) === sourceKey(revision.source)) ||
        (scope.kind === 'object' &&
          sourceKey(scope.source) === sourceKey(revision.source) &&
          scope.objectId === logical) ||
        (scope.kind === 'fact' && scope.evidenceId === evidenceId(revision.source, logical))
      )
    })
  }

  private accessIssue(
    row: SourceState,
    revision?: AwarenessRevision
  ): { state: AwarenessCoverageState; reasons: AwarenessCoverageReason[] } | undefined {
    if (row.inclusion !== 'included') {
      return {
        state: 'excluded',
        reasons: [
          row.temporary
            ? 'temporary_conversation'
            : row.inclusion === 'left'
              ? 'cloud_access_ended'
              : 'excluded_by_owner'
        ]
      }
    }

    if (
      this.state.withdrawals.some(
        ({ request }) =>
          !['exclude', 'left_room', 'revoked'].includes(request.reason) &&
          (request.scope.kind === 'account' ||
            (request.scope.kind === 'source' && sourceKey(request.scope.source) === sourceKey(row.source)))
      )
    ) {
      return { state: 'excluded', reasons: ['excluded_by_owner'] }
    }

    if (this.stopped || !this.options.live()) {
      return { state: 'offline', reasons: ['device_offline'] }
    }

    if (this.failed) {
      return { state: 'error', reasons: ['service_unavailable'] }
    }

    const access = this.options.readAccess(row.source)

    if (!access.active || this.blocked.has(sourceKey(row.source)) || this.blocked.has('*')) {
      return { state: 'offline', reasons: ['cloud_access_ended'] }
    }

    if (!access.keysAvailable) {
      return { state: 'needs_keys', reasons: ['keys_missing'] }
    }

    if (revision && !access.readable(revision)) {
      return { state: 'partial', reasons: ['backfill_pending'] }
    }

    if (this.options.destination === 'managed' && row.source.kind === 'drive_file' && this.fenceSince !== undefined) {
      return { state: 'paused', reasons: ['google_fence'] }
    }
  }

  private source(source: AwarenessSource): SourceState {
    const row = this.state.sources.find(value => sourceKey(value.source) === sourceKey(source))

    if (!row) {
      throw new Error('awareness_source_unregistered')
    }

    return row
  }

  private now(): number {
    const value = this.options.now?.() ?? Date.now()

    if (!time(value)) {
      throw new Error('awareness_time_invalid')
    }

    return value
  }

  private assertLive(): void {
    if (this.stopped || this.failed || !this.options.live()) {
      throw new Error('awareness_reader_stopped')
    }
  }

  private async request<T>(dispatch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('awareness_transport_timeout'))
      }, this.options.requestTimeoutMs ?? 10_000)
    })

    try {
      return await Promise.race([dispatch(controller.signal), deadline])
    } finally {
      clearTimeout(timer!)
    }
  }

  private async save(): Promise<void> {
    try {
      await this.options.store.write(structuredClone(this.state))
    } catch {
      this.failed = true
      throw new Error('awareness_store_unavailable')
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const done = this.tail.then(() => {
      this.assertLive()

      return work()
    })

    this.tail = done.catch(() => {})

    return done
  }
}

export function awarenessEvidenceId(source: AwarenessSource, logicalObject: string): string {
  return evidenceId(copySource(source), logicalObject)
}

function evidenceId(source: AwarenessSource, logicalObject: string): string {
  const objectKey = createHash('sha256')
    .update(`object\0${source.kind}\0${source.id}\0${source.agentPrincipal ?? ''}\0${logicalObject}`, 'utf8')
    .digest('hex')

  const hex = createHash('sha256').update(`evidence\0${objectKey}`, 'utf8').digest('hex').slice(0, 32).split('')
  hex[12] = '8'
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16)
  const value = hex.join('')

  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function revisionFingerprint(envelope: AwarenessEnvelope): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: envelope.source,
        object: envelope.object,
        author: envelope.author,
        eventTime: envelope.eventTime,
        digest: envelope.digest,
        attachments: envelope.content.attachments,
        epoch: envelope.policy.epoch,
        googleDerived: envelope.policy.googleDerived
      }),
      'utf8'
    )
    .digest('hex')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function time(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function ref(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{1,1024}$/u.test(value)
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function exact(value: unknown, required: string[], optional: string[] = []): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  )
}

function copySource(source: AwarenessSource): AwarenessSource {
  if (!validSource(source)) {
    throw new Error('awareness_source_invalid')
  }

  return structuredClone(source)
}

function nextEpoch(epoch: number): number {
  if (epoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error('awareness_epoch_exhausted')
  }

  return epoch + 1
}

function validScope(scope: AwarenessWithdrawalScope): boolean {
  return (
    !!scope &&
    ((scope.kind === 'account' && exact(scope, ['kind'])) ||
      (scope.kind === 'fact' && exact(scope, ['kind', 'evidenceId']) && uuid(scope.evidenceId)) ||
      (scope.kind === 'source' && exact(scope, ['kind', 'source']) && validSource(scope.source)) ||
      (scope.kind === 'object' &&
        exact(scope, ['kind', 'source', 'objectId']) &&
        validSource(scope.source) &&
        ref(scope.objectId)))
  )
}

function readReceipt(value: unknown, envelope: AwarenessEnvelope): AwarenessReceipt {
  const receipt = value as AwarenessReceipt
  const acknowledged = ['accepted', 'duplicate', 'superseded'].includes(receipt?.state)

  if (
    !exact(value, ['operationId', 'source', 'object', 'state', acknowledged ? 'acceptedRevision' : 'reason']) ||
    receipt.operationId !== envelope.operationId ||
    !validSource(receipt.source) ||
    sourceKey(receipt.source) !== sourceKey(envelope.source) ||
    !exact(receipt.object, ['kind', 'id', 'revision']) ||
    receipt.object.kind !== envelope.object.kind ||
    receipt.object.id !== envelope.object.id ||
    receipt.object.revision !== envelope.object.revision ||
    (acknowledged
      ? !time((receipt as { acceptedRevision: number }).acceptedRevision) ||
        (receipt as { acceptedRevision: number }).acceptedRevision < envelope.object.revision
      : receipt.state !== 'refused' ||
        ![
          'google_derived',
          'fence_active',
          'excluded',
          'withdrawn',
          'stale_policy_epoch',
          'invalid',
          'unsupported'
        ].includes((receipt as { reason: string }).reason))
  ) {
    throw new Error('awareness_receipt_invalid')
  }

  return structuredClone(receipt)
}

function readWithdrawalReceipt(value: unknown, request: AwarenessWithdrawal): AwarenessWithdrawalReceipt {
  const receipt = value as AwarenessWithdrawalReceipt

  if (
    !exact(value, ['withdrawalId', 'state', 'recordedAt', 'purgeBy', 'suppressionIds']) ||
    receipt.withdrawalId !== request.withdrawalId ||
    receipt.state !== 'recorded' ||
    !time(receipt.recordedAt) ||
    !time(receipt.purgeBy) ||
    receipt.purgeBy < receipt.recordedAt ||
    receipt.purgeBy - receipt.recordedAt > 86_400_000 ||
    !Array.isArray(receipt.suppressionIds) ||
    !receipt.suppressionIds.length ||
    receipt.suppressionIds.length > 1000 ||
    !receipt.suppressionIds.every(uuid) ||
    new Set(receipt.suppressionIds).size !== receipt.suppressionIds.length
  ) {
    throw new Error('awareness_withdrawal_receipt_invalid')
  }

  return structuredClone(receipt)
}

function readState(value: unknown, options: AwarenessReaderOptions): ReaderState {
  const state = value as ReaderState

  const invalid = () => {
    throw new Error('awareness_store_invalid')
  }

  if (
    !exact(value, ['v', 'binding', 'destination', 'sources', 'withdrawals'], ['fence']) ||
    state.v !== 1 ||
    state.binding !== options.binding ||
    state.destination !== options.destination ||
    !Array.isArray(state.sources) ||
    !Array.isArray(state.withdrawals)
  ) {
    invalid()
  }

  if (
    Object.hasOwn(state, 'fence') &&
    (!exact(state.fence, ['since', 'acknowledged']) ||
      !time(state.fence?.since) ||
      typeof state.fence?.acknowledged !== 'boolean')
  ) {
    invalid()
  }

  for (const row of state.sources) {
    if (
      !exact(
        row,
        ['source', 'epoch', 'inclusion', 'temporary', 'complete'],
        ['processedThrough', 'pending', 'receipt']
      ) ||
      !validSource(row.source) ||
      !time(row.epoch) ||
      row.epoch < 1 ||
      !['included', 'excluded', 'left'].includes(row.inclusion) ||
      typeof row.temporary !== 'boolean' ||
      typeof row.complete !== 'boolean' ||
      (row.processedThrough !== undefined && !time(row.processedThrough)) ||
      (Object.hasOwn(row, 'pending') &&
        (!exact(row.pending, ['operationId', 'fingerprint', 'observedTime', 'object']) ||
          !uuid(row.pending?.operationId) ||
          !/^[0-9a-f]{64}$/u.test(row.pending.fingerprint) ||
          !time(row.pending.observedTime) ||
          !exact(row.pending.object, ['kind', 'id', 'revision'], ['replaces']) ||
          !ref(row.pending.object.id) ||
          !time(row.pending.object.revision) ||
          row.pending.object.revision < 1 ||
          !['message', 'edit', 'redaction', 'file_version', 'memory_revision'].includes(row.pending.object.kind) ||
          (row.pending.object.replaces !== undefined && !ref(row.pending.object.replaces))))
    ) {
      invalid()
    }

    // Last receipts are diagnostic metadata only; never reconstruct coverage from them.
    if (row.receipt) {
      if (
        !uuid(row.receipt.operationId) ||
        !validSource(row.receipt.source) ||
        sourceKey(row.receipt.source) !== sourceKey(row.source) ||
        !row.receipt.object ||
        !['message', 'edit', 'redaction', 'file_version', 'memory_revision'].includes(row.receipt.object.kind) ||
        !ref(row.receipt.object.id) ||
        !time(row.receipt.object.revision) ||
        row.receipt.object.revision < 1
      ) {
        invalid()
      }

      readReceipt(row.receipt, {
        operationId: row.receipt.operationId,
        source: row.source,
        object: row.receipt.object
      } as AwarenessEnvelope)
    }
  }

  if (new Set(state.sources.map(row => sourceKey(row.source))).size !== state.sources.length) {
    invalid()
  }

  for (const row of state.withdrawals) {
    const request = row?.request
    const epochReason = ['exclude', 'left_room', 'revoked'].includes(request?.reason)

    if (
      !exact(row, ['request'], ['receipt']) ||
      !exact(
        request,
        ['operationId', 'withdrawalId', 'scope', 'reason', 'requestedAt'],
        epochReason ? ['policyEpoch'] : []
      ) ||
      !uuid(request.operationId) ||
      !uuid(request.withdrawalId) ||
      !validScope(request.scope) ||
      !time(request.requestedAt) ||
      !['forget', 'delete', 'account_deleted', 'exclude', 'left_room', 'revoked'].includes(request.reason) ||
      (epochReason &&
        (!time((request as { policyEpoch: number }).policyEpoch) ||
          (request as { policyEpoch: number }).policyEpoch < 1 ||
          request.scope.kind !== 'source')) ||
      (request.reason === 'account_deleted' && request.scope.kind !== 'account')
    ) {
      invalid()
    }

    if (row.receipt) {
      readWithdrawalReceipt(row.receipt, request)
    }
  }

  return structuredClone(state)
}
