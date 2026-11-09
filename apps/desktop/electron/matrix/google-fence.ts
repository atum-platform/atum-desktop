import type { MatrixIdentity } from '../../shared/matrix'

import type { MatrixLocalBrain, MatrixLocalBrainOwner } from './local-brain'

/** All fields are supplied by main, never by an observation's payload. */
export interface MatrixGoogleFenceOwner extends MatrixLocalBrainOwner {
  identity: MatrixIdentity
  host: object
}

const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const MATRIX_GOOGLE_FENCE_FAILURE_STAGES = [
  'unclassified',
  'sender',
  'validation',
  'initial_info_rpc',
  'initial_info_receipt',
  'fence_rpc',
  'fence_ack',
  'verify_rpc',
  'verify_receipt'
] as const

export type MatrixGoogleFenceFailureStage = typeof MATRIX_GOOGLE_FENCE_FAILURE_STAGES[number]
const MATRIX_GOOGLE_FENCE_FAILURE_STAGE_SET = new Set<string>(MATRIX_GOOGLE_FENCE_FAILURE_STAGES)

const LOCAL_BRAIN_FAILURE_CODES = [
  'matrix_local_brain_exited',
  'matrix_local_brain_failed',
  'matrix_local_brain_frame_too_large',
  'matrix_local_brain_method_denied',
  'matrix_local_brain_owner_invalid',
  'matrix_local_brain_protocol_invalid',
  'matrix_local_brain_request_invalid',
  'matrix_local_brain_request_limit',
  'matrix_local_brain_request_outcome_unknown',
  'matrix_local_brain_request_too_large',
  'matrix_local_brain_rpc_failed',
  'matrix_local_brain_spawn_failed',
  'matrix_local_brain_stopped',
  'matrix_local_brain_unavailable',
  'matrix_local_brain_write_failed'
] as const

const LOCAL_BRAIN_FAILURE_CODE_SET = new Set<string>(LOCAL_BRAIN_FAILURE_CODES)
type MatrixGoogleFenceFailureCode = typeof LOCAL_BRAIN_FAILURE_CODES[number] | 'rpc_failed'

/** A bounded diagnostic for main; it never retains an RPC payload or raw error text. */
export class MatrixGoogleFenceFailure extends Error {
  constructor(
    readonly stage: MatrixGoogleFenceFailureStage,
    readonly code: MatrixGoogleFenceFailureCode,
    message: string
  ) {
    super(message)
    this.name = 'MatrixGoogleFenceFailure'
  }
}

function rpcFailure(stage: MatrixGoogleFenceFailureStage, error: unknown): MatrixGoogleFenceFailure {
  const message = error instanceof Error && LOCAL_BRAIN_FAILURE_CODE_SET.has(error.message)
    ? error.message as MatrixGoogleFenceFailureCode
    : 'matrix_google_fence_rpc_failed'

  const code = message === 'matrix_google_fence_rpc_failed' ? 'rpc_failed' : message

  return new MatrixGoogleFenceFailure(stage, code, message)
}

function validationFailure(): MatrixGoogleFenceFailure {
  return new MatrixGoogleFenceFailure('validation', 'rpc_failed', 'matrix_google_fence_invalid')
}

function receiptFailure(stage: Extract<MatrixGoogleFenceFailureStage, 'initial_info_receipt' | 'fence_ack' | 'verify_receipt'>): MatrixGoogleFenceFailure {
  return new MatrixGoogleFenceFailure(stage, 'rpc_failed', 'matrix_google_fence_receipt_invalid')
}

/** Constant-format, payload-free main-process diagnostic for a fence failure. */
export function formatMatrixGoogleFenceFailure(error: unknown): string {
  const failure = error instanceof MatrixGoogleFenceFailure ? error : undefined
  const stage = failure?.stage
  const code = failure?.code

  const safe = typeof stage === 'string' && typeof code === 'string' &&
    MATRIX_GOOGLE_FENCE_FAILURE_STAGE_SET.has(stage) &&
    (code === 'rpc_failed' || LOCAL_BRAIN_FAILURE_CODE_SET.has(code))

  return `[Matrix] google_fence_unavailable stage=${safe ? stage : 'unclassified'} code=${safe ? code : 'rpc_failed'}`
}

/**
 * What main does with a fence observation from one SDK host. Only the human host's SDK
 * reads the owner's account data. Agent and app hosts read their own accounts, so their
 * observations say nothing about the owner's fence: they are dropped silently, on every
 * sync. Before the local brain is active there is no fence owner, so the observation has
 * nowhere to go; it is dropped too (the next sync offers it again). A human host that
 * isn't the owner's exact host is refused, and only that is worth a log line.
 *
 * The installed app logged every dropped observation as a failure: six agent hosts, one
 * line each per sync, 20,000 lines a day of `stage=unclassified code=rpc_failed`.
 */
export function matrixGoogleFenceSender(
  role: string,
  host: object,
  owner: Pick<MatrixGoogleFenceOwner, 'host'> | null
): 'observe' | 'ignore' | 'refuse' {
  if (role !== 'human' || !owner) {
    return 'ignore'
  }

  return owner.host === host ? 'observe' : 'refuse'
}

/** A human host that isn't the owner's exact host offered an observation. */
export function matrixGoogleFenceSenderRefused(): MatrixGoogleFenceFailure {
  return new MatrixGoogleFenceFailure('sender', 'rpc_failed', 'matrix_ipc_denied')
}

function sameOwner(a: MatrixGoogleFenceOwner, b: MatrixGoogleFenceOwner | null): boolean {
  return Boolean(b && a.accountKey === b.accountKey && a.generation === b.generation &&
    a.host === b.host && a.identity.userId === b.identity.userId && a.identity.deviceId === b.identity.deviceId)
}

/** Additive fence notices only. Absence/unknown never means permission to ingest.
 * The provider's existing ledger is the durable authority; no second policy
 * store, clear operation, ingestion admission or automatic restart is added. */
export class MatrixGoogleFenceNotices {
  private earliest = new Map<string, number>()
  private pending: MatrixGoogleFenceOwner | null = null
  private running?: Promise<void>

  constructor(
    private readonly brain: Pick<MatrixLocalBrain, 'ready' | 'call'>,
    private readonly owner: () => MatrixGoogleFenceOwner | null
  ) {}

  observe(value: unknown): Promise<void> {
    const owner = this.owner()

    if (!owner) { return Promise.resolve() }
    const row = value as { state?: unknown; since?: unknown } | null

    if (!row || typeof row !== 'object' || Array.isArray(row) ||
      (row.state !== 'unknown' && row.state !== 'current') ||
      Object.keys(row).some(key => key !== 'state' && key !== 'since') ||
      (row.state === 'unknown' && Object.hasOwn(row, 'since')) ||
      (row.state === 'current' && row.since !== null && !timestamp(row.since))) {
      return Promise.reject(validationFailure())
    }

    if (row.state === 'current' && timestamp(row.since)) {
      this.earliest.set(owner.accountKey, Math.min(this.earliest.get(owner.accountKey) ?? row.since, row.since))

      return this.reconcile()
    }

    return Promise.resolve()
  }

  /** Called after explicit brain activation or the next authenticated notice.
   * A lost acknowledgement retains the same earliest notice for this retry. */
  reconcile(): Promise<void> {
    const owner = this.owner()

    if (!owner || this.earliest.get(owner.accountKey) === undefined || !this.brain.ready(owner)) {
      return Promise.resolve()
    }

    this.pending = owner

    if (this.running) { return this.running }
    this.running = this.flush().finally(() => { this.running = undefined })

    return this.running
  }

  private async call(
    owner: MatrixGoogleFenceOwner,
    method: 'brain.info' | 'brain.fence',
    params: unknown,
    stage: Extract<MatrixGoogleFenceFailureStage, 'initial_info_rpc' | 'fence_rpc' | 'verify_rpc'>
  ): Promise<unknown> {
    try {
      return await this.brain.call(owner, method, params)
    } catch (error) {
      throw rpcFailure(stage, error)
    }
  }

  private async flush(): Promise<void> {
    while (this.pending) {
      const owner = this.pending
      this.pending = null

      if (!sameOwner(owner, this.owner()) || !this.brain.ready(owner)) { continue }
      const info = await this.call(owner, 'brain.info', undefined, 'initial_info_rpc') as { fence?: { active?: unknown; since?: unknown } } | null

      if (!sameOwner(owner, this.owner()) || !this.brain.ready(owner)) { continue }
      const fence = info?.fence

      if (!fence || (fence.active !== true && fence.active !== false) ||
        (fence.active === true && !timestamp(fence.since)) ||
        (fence.active === false && fence.since !== null)) {
        throw receiptFailure('initial_info_receipt')
      }

      if (fence.active === true && timestamp(fence.since)) {
        this.earliest.set(owner.accountKey, Math.min(this.earliest.get(owner.accountKey)!, fence.since))
      }

      const desired = this.earliest.get(owner.accountKey)!

      if (fence.active === true && timestamp(fence.since) && fence.since <= desired) { continue }
      const ack = await this.call(owner, 'brain.fence', { v: 1, since: desired }, 'fence_rpc') as { active?: unknown; since?: unknown } | null

      if (!sameOwner(owner, this.owner()) || !this.brain.ready(owner)) { continue }

      if (ack?.active !== true || !timestamp(ack.since) || ack.since > desired) {
        throw receiptFailure('fence_ack')
      }

      this.earliest.set(owner.accountKey, Math.min(this.earliest.get(owner.accountKey)!, ack.since))
      const verified = await this.call(owner, 'brain.info', undefined, 'verify_rpc') as { fence?: { active?: unknown; since?: unknown } } | null

      if (!sameOwner(owner, this.owner()) || !this.brain.ready(owner)) { continue }

      if (verified?.fence?.active !== true || !timestamp(verified.fence.since) || verified.fence.since > desired) {
        throw receiptFailure('verify_receipt')
      }

      this.earliest.set(owner.accountKey, Math.min(this.earliest.get(owner.accountKey)!, verified.fence.since))
    }
  }
}
