/**
 * The Mac's calls to the platform's `atum.agent-home/2.1` routes (atum-platform PR #653,
 * `apps/shell/src/lib/matrix-agent-home.ts`):
 *
 *   GET  /api/matrix/v1/agents/{agent}/home              the placement record
 *   POST …/home/moves        { operation: request | commit | abort | supersede }   the owner's move
 *   POST …/home/drain        a signed DrainAck from the source executor
 *   POST …/home/checkpoints  a signed CheckpointReserve / CheckpointCommit
 *   POST …/home/readiness    a signed ReadinessReport
 *   POST …/home/publications a signed MatrixPublicationEnqueue plus the exact event bytes (atum-platform PR #658)
 *
 * Every call carries the main-process bearer (`account.s1Request`, never the renderer), the exact
 * `Atum-Agent-Home-Wire: 2.1` header, `Content-Type: application/json` exactly (the Shell refuses a
 * charset suffix), no cookie, no query, and is bounded in time and size. Expected platform answers are
 * values, never exceptions: `unsupported` (no such route yet, the capability check), `refused` (a
 * 403 `{outcome:"refused", reason}` from the authority check), `conflict` (a 409: stale CAS, busy, not
 * the active move), `unauthorized` (a 401), `invalid` (a 400, or an answer that is not the contract's)
 * and `unavailable` (the rest). Nothing here retries; the caller re-reads the placement and decides.
 */
import { readDomainJson } from '../domain'

import {
  AGENT_HOME_WIRE_HEADER,
  AGENT_HOME_WIRE_VERSION,
  type CheckpointCommitOutcome,
  type CheckpointReserveOutcome,
  type DrainAckOutcome,
  type ExecutorSignedMeta,
  type HomeAuthorityFence,
  type HomePlacement,
  type HomeReadinessObservation,
  type HomeReadinessReport,
  type HomeRefusalReason,
  isUuid,
  type MoveAbortOutcome,
  type MoveCommitOutcome,
  type MoveRequestOutcome,
  parseCheckpointCommitResult,
  parseCheckpointReserveResult,
  parseDrainAckResult,
  parseMoveAbortResult,
  parseMoveCommitResult,
  parseMoveRequestResult,
  parsePlacement,
  parsePublicationReceipt,
  parseReadinessObservation,
  parseRefusal,
  type PublicationEnvelope,
  type PublicationReceipt,
  validPublicationEnvelope
} from './contract'

export type HomePlatformFailure =
  /** The platform has no such route (404/405/501) or has it switched off (503 `not_configured`). */
  | { ok: false; kind: 'unsupported'; status: number }
  /** 401: the bearer, or the signed frame's window, is not accepted. */
  | { ok: false; kind: 'unauthorized'; status: number }
  /** 403 with the authority check's closed reason. */
  | { ok: false; kind: 'refused'; reason: HomeRefusalReason; status: number }
  /** 403 without one: not the owner's agent, or the home is erased. */
  | { ok: false; kind: 'forbidden'; status: number }
  /** 409: a stale epoch or revision, a busy reservation, a move that is not the active one. */
  | { ok: false; kind: 'conflict'; status: number }
  /**
   * 503 `details.reason: "publication_disabled"`, exactly: the platform's publication worker is switched off
   * (`ATUM_AGENT_HOME_PUBLICATION_ENABLED`). The enqueue route answers it before it looks at anything, so a Mac may
   * send an agent's result itself, and only if no outbox row of that result was ever accepted (publication.ts).
   */
  | { ok: false; kind: 'publication_disabled'; status: number }
  /**
   * 409 `details.reason: "agent_home_publication_in_flight"`, exactly: a move commit (or an erase) met a publication the
   * worker is sending right now. Retryable: the lease ends in about 45 seconds. Never forced and never sent around.
   */
  | { ok: false; kind: 'publication_in_flight'; status: number }
  /**
   * 409 `details.reason: "agent_home_publication_changed_replay"`, exactly: this outbox id is already on the platform under
   * other bytes, another transaction, part or signer (a Mac that lost its record prepared the result again). The original
   * is the one that publishes; this attempt is over, whatever it would have said.
   */
  | { ok: false; kind: 'publication_changed_replay'; status: number }
  /**
   * 429 `details.reason: "agent_home_publication_queue_full"`, exactly, with `Retry-After` (60 s): the agent has too many
   * rows waiting. Nothing is lost; the Mac keeps what it prepared and asks again no sooner than the platform said.
   */
  | { ok: false; kind: 'publication_queue_full'; status: number; retryAfterSeconds: number }
  /** 400, or an answer that is not what the contract says. */
  | { ok: false; kind: 'invalid'; status: number }
  | { ok: false; kind: 'unavailable'; status: number }

export type HomePlatformResult<T> = { ok: true; value: T } | HomePlatformFailure

export interface DrainAckBody {
  meta: ExecutorSignedMeta
  moveId: string
  fence: HomeAuthorityFence
  result: 'quiesced' | 'timed_out' | 'unreachable'
}

export interface CheckpointReserveBody {
  operation: 'reserve'
  meta: ExecutorSignedMeta
  checkpointId: string
  expectedPlacementRevision: number
  fence: HomeAuthorityFence
}

export interface CheckpointCommitBody {
  operation: 'commit'
  meta: ExecutorSignedMeta
  checkpointId: string
  generation: number
  parentGeneration: number
  expectedHomeEpoch: number
  expectedPlacementRevision: number
  manifestSha256: string
  uploadVerified: boolean
  fence: HomeAuthorityFence
}

export interface MoveRequestInput {
  moveId: string
  idempotencyKey: string
  target: { kind: 'mac'; deviceServiceId: string }
  expectedHomeEpoch: number
  expectedPlacementRevision: number
}

export interface MoveCasInput {
  moveId: string
  idempotencyKey: string
  expectedHomeEpoch: number
  expectedPlacementRevision: number
}

export interface MoveAbortInput extends MoveCasInput {
  reason: 'drain_failed' | 'target_unavailable' | 'owner_cancelled' | 'sleep_budget_elapsed'
}

/** What the rest of the Mac depends on: the stub platform in tests and the Shell in the app both give this. */
export interface HomePlatform {
  readPlacement(agent: string, signal: AbortSignal): Promise<HomePlatformResult<HomePlacement>>
  requestMove(agent: string, input: MoveRequestInput, signal: AbortSignal): Promise<HomePlatformResult<MoveRequestOutcome>>
  commitMove(agent: string, input: MoveCasInput, signal: AbortSignal): Promise<HomePlatformResult<MoveCommitOutcome>>
  abortMove(agent: string, input: MoveAbortInput, signal: AbortSignal): Promise<HomePlatformResult<MoveAbortOutcome>>
  ackDrain(agent: string, body: DrainAckBody, signal: AbortSignal): Promise<HomePlatformResult<DrainAckOutcome>>
  reserveCheckpoint(agent: string, body: CheckpointReserveBody, signal: AbortSignal): Promise<HomePlatformResult<CheckpointReserveOutcome>>
  commitCheckpoint(agent: string, body: CheckpointCommitBody, signal: AbortSignal): Promise<HomePlatformResult<CheckpointCommitOutcome>>
  reportReadiness(agent: string, body: HomeReadinessReport, signal: AbortSignal): Promise<HomePlatformResult<HomeReadinessObservation>>
  /**
   * Hand the platform the final Matrix event bytes to send (`matrix.publication.enqueue`). The answer is the outbox
   * row's receipt, whatever its state: a refusal is a receipt with `state: "refused"`, not a failure of the call.
   */
  enqueuePublication(agent: string, envelope: PublicationEnvelope, signal: AbortSignal): Promise<HomePlatformResult<PublicationReceipt>>
}

const RESPONSE_LIMIT_BYTES = 64 * 1024
const CALL_TIMEOUT_MS = 20_000

export interface ShellHomePlatformOptions {
  /** `account.s1Request`: runs `send` with a live bearer and the S1 resource base URL. */
  request<T>(send: (accessToken: string, resource: string) => Promise<T>, signal: AbortSignal): Promise<T>
  /** Test seam: the stub platform's fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
}

export class ShellHomePlatform implements HomePlatform {
  constructor(private readonly options: ShellHomePlatformOptions) {}

  private async call<T>(
    agent: string,
    suffix: '' | '/moves' | '/drain' | '/checkpoints' | '/readiness' | '/publications',
    body: unknown | undefined,
    signal: AbortSignal,
    parse: (value: unknown) => T | null,
    /** The answer is the same shape under a 403 too (a refused publication is a receipt). */
    answerOn403 = false
  ): Promise<HomePlatformResult<T>> {
    if (!isUuid(agent)) {
      return { ok: false, kind: 'invalid', status: 0 }
    }

    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? CALL_TIMEOUT_MS)])

    let status = 0
    let value: unknown
    let retryAfter: string | null = null

    try {
      const response = await this.options.request(async (accessToken, resource) => {
        bounded.throwIfAborted()

        return (this.options.fetch ?? fetch)(`${resource}/agents/${encodeURIComponent(agent)}/home${suffix}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            [AGENT_HOME_WIRE_HEADER]: AGENT_HOME_WIRE_VERSION,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: bounded
        })
      }, bounded)

      status = response.status
      retryAfter = response.headers.get('retry-after')

      if (response.headers.get('content-type')?.startsWith('application/json')) {
        try {
          value = await readDomainJson(response, RESPONSE_LIMIT_BYTES)
        } catch {
          return { ok: false, kind: 'invalid', status }
        }
      } else {
        // A route that is not there answers with its framework's page, not JSON.
        await response.body?.cancel().catch(() => {})
        value = undefined
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'matrix_s1_authentication') {
        return { ok: false, kind: 'unauthorized', status: 401 }
      }

      return { ok: false, kind: 'unavailable', status }
    }

    if (answerOn403 && status === 403) {
      const answer = parse(value)

      if (answer !== null) {
        return { ok: true, value: answer }
      }
    }

    return interpret(status, value, parse, retryAfter)
  }

  readPlacement(agent: string, signal: AbortSignal) {
    return this.call(agent, '', undefined, signal, value => {
      const placement = parsePlacement(value)

      return placement && placement.agentPrincipal === agent ? placement : null
    })
  }

  requestMove(agent: string, input: MoveRequestInput, signal: AbortSignal) {
    return this.call(agent, '/moves', { operation: 'request', intent: 'manual', ...input }, signal, value =>
      parseMoveRequestResult(value, agent)
    )
  }

  commitMove(agent: string, input: MoveCasInput, signal: AbortSignal) {
    return this.call(agent, '/moves', { operation: 'commit', ...input }, signal, value => parseMoveCommitResult(value, agent))
  }

  abortMove(agent: string, input: MoveAbortInput, signal: AbortSignal) {
    return this.call(agent, '/moves', { operation: 'abort', ...input }, signal, parseMoveAbortResult)
  }

  ackDrain(agent: string, body: DrainAckBody, signal: AbortSignal) {
    return this.call(agent, '/drain', body, signal, parseDrainAckResult)
  }

  reserveCheckpoint(agent: string, body: CheckpointReserveBody, signal: AbortSignal) {
    return this.call(agent, '/checkpoints', body, signal, parseCheckpointReserveResult)
  }

  commitCheckpoint(agent: string, body: CheckpointCommitBody, signal: AbortSignal) {
    return this.call(agent, '/checkpoints', body, signal, parseCheckpointCommitResult)
  }

  reportReadiness(agent: string, body: HomeReadinessReport, signal: AbortSignal) {
    return this.call(agent, '/readiness', body, signal, parseReadinessObservation)
  }

  async enqueuePublication(agent: string, envelope: PublicationEnvelope, signal: AbortSignal): Promise<HomePlatformResult<PublicationReceipt>> {
    // Nothing the platform would refuse as malformed leaves this Mac: the bytes, their hash and the part are checked here.
    if (!validPublicationEnvelope(envelope) || envelope.publication.fence.agentPrincipal !== agent) {
      return { ok: false, kind: 'invalid', status: 0 }
    }

    return this.call(agent, '/publications', envelope, signal, value => {
      const receipt = parsePublicationReceipt(value)

      // The receipt is for the row that was asked about, under the fence that was sent.
      return receipt && receipt.outboxId === envelope.publication.outboxId ? receipt : null
    }, true)
  }
}

/**
 * The authority check's closed reason, from either place the platform puts it: the SQL authority
 * check answers `{outcome:"refused", reason}` (403), and the Shell's own admission (signature window,
 * placement location, pinned key, signature) throws a closed reason into `{error, details:{reason}}`.
 */
export function refusalReason(value: unknown): HomeRefusalReason | null {
  const direct = parseRefusal(value)

  if (direct) {
    return direct.reason
  }

  const details = value && typeof value === 'object' ? (value as { details?: unknown }).details : undefined
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined
  const named = parseRefusal({ outcome: 'refused', reason })

  return named ? named.reason : null
}

/** The codes of atum-platform#658 and #664's publication rollout, matched exactly (a longer or shorter word is none of them). */
export const PUBLICATION_DISABLED = 'publication_disabled'
export const PUBLICATION_IN_FLIGHT = 'agent_home_publication_in_flight'
export const PUBLICATION_CHANGED_REPLAY = 'agent_home_publication_changed_replay'
export const PUBLICATION_QUEUE_FULL = 'agent_home_publication_queue_full'

/** The platform's `Retry-After` in whole seconds: what it said when sensible, else the minute it always says. */
function retryAfterSeconds(header: string | null): number {
  const seconds = header !== null && /^[0-9]{1,5}$/u.test(header.trim()) ? Number(header.trim()) : 60

  return Math.min(Math.max(seconds, 1), 3600)
}

/** `details.reason` of a Shell error body, when it is a string. */
function detailReason(value: unknown): string | null {
  const details = value && typeof value === 'object' ? (value as { details?: unknown }).details : undefined
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined

  return typeof reason === 'string' ? reason : null
}

/** What an HTTP answer means. Pure, so the status table is tested without a network. */
export function interpret<T>(
  status: number,
  value: unknown,
  parse: (value: unknown) => T | null,
  /** The `Retry-After` header of the answer, when it had one (seconds). */
  retryAfter: string | null = null
): HomePlatformResult<T> {
  if (status === 200) {
    const parsed = parse(value)

    return parsed === null ? { ok: false, kind: 'invalid', status } : { ok: true, value: parsed }
  }

  const reason = status === 400 || status === 401 || status === 403 ? refusalReason(value) : null

  if (reason) {
    return { ok: false, kind: 'refused', reason, status }
  }

  if (status === 401) {
    return { ok: false, kind: 'unauthorized', status }
  }

  if (status === 403) {
    return { ok: false, kind: 'forbidden', status }
  }

  if (status === 404 || status === 405 || status === 501) {
    return { ok: false, kind: 'unsupported', status }
  }

  if (status === 409) {
    const named = detailReason(value)

    if (named === PUBLICATION_IN_FLIGHT) {
      return { ok: false, kind: 'publication_in_flight', status }
    }

    return named === PUBLICATION_CHANGED_REPLAY ? { ok: false, kind: 'publication_changed_replay', status } : { ok: false, kind: 'conflict', status }
  }

  if (status === 429 && detailReason(value) === PUBLICATION_QUEUE_FULL) {
    return { ok: false, kind: 'publication_queue_full', status, retryAfterSeconds: retryAfterSeconds(retryAfter) }
  }

  if (status === 400) {
    return { ok: false, kind: 'invalid', status }
  }

  if (status === 503) {
    const named = detailReason(value)

    // The route exists in the build but is switched off for this deployment.
    if (named === 'not_configured') {
      return { ok: false, kind: 'unsupported', status }
    }

    return named === PUBLICATION_DISABLED ? { ok: false, kind: 'publication_disabled', status } : { ok: false, kind: 'unavailable', status }
  }

  return { ok: false, kind: 'unavailable', status }
}
