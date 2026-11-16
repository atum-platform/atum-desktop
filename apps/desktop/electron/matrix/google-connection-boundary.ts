import { randomUUID } from 'node:crypto'

import { isDesktopLocale } from '../../shared/desktop-locale'
import type {
  MatrixGoogleConnectionBridge,
  MatrixGoogleConnectionContext,
  MatrixGoogleConnectionResult,
  MatrixGoogleConnectionStatus
} from '../../shared/matrix-google-connections'
import { type MatrixGoogleFence, parseMatrixGoogleFence } from '../../shared/matrix-google-fence'
import {
  MATRIX_GOOGLE_WRITE_PROFILE,
  type MatrixGoogleWriteAnswer,
  type MatrixGoogleWriteDecisionInput,
  parseMatrixGoogleWriteDecisionInput
} from '../../shared/matrix-google-write-proposal'

import { readDomainJson } from './domain'

/** Main-owned authority captured before a Google connection operation begins. */
export interface MatrixGoogleConnectionBoundaryOwner {
  accountKey: string
  generation: number
  userId: string
  deviceId: string
  host: object
}

/** The only SDK capability the Google fence publisher needs from the captured host. */
export interface MatrixGoogleFenceHost {
  queue: {
    command(command: unknown, timeoutMs?: number): Promise<unknown>
  }
}

export interface MatrixGoogleConnectionIpcHandlerOptions<Event> {
  /** Must reject an untrusted renderer before its request is inspected. */
  assertSender(event: Event): void
  /** Main owns availability; the renderer cannot select a bridge. */
  connections(): MatrixGoogleConnectionBridge | undefined
  /** Called only after a first-run-tagged provider result confirms a connected source. */
  firstRunConnected?(context: MatrixGoogleConnectionContext, status: MatrixGoogleConnectionStatus): void | Promise<void>
}

const unavailable = (): MatrixGoogleConnectionResult => ({ status: null, error: 'unavailable' })
const invalidInput = (): MatrixGoogleConnectionResult => ({ status: null, error: 'invalid_input' })

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)

  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function preferences(value: unknown): value is ReadonlyArray<{ id: string; enabled: boolean }> {
  return Array.isArray(value) && value.length <= 256 && value.every(item => {
    const row = record(item)

    return Boolean(row && exactKeys(row, ['id', 'enabled']) && typeof row.id === 'string' && row.id.length <= 128 &&
      typeof row.enabled === 'boolean')
  })
}

function firstRunContext(value: unknown): MatrixGoogleConnectionContext | null {
  const row = record(value)

  return row && exactKeys(row, ['origin', 'locale']) && row.origin === 'first_run' && isDesktopLocale(row.locale)
    ? { origin: 'first_run', locale: row.locale }
    : null
}

async function observeFirstRun(
  result: MatrixGoogleConnectionResult,
  context: MatrixGoogleConnectionContext | null,
  connected: MatrixGoogleConnectionIpcHandlerOptions<unknown>['firstRunConnected']
): Promise<MatrixGoogleConnectionResult> {
  if (context && !result.status?.degraded && (result.status?.accountState === 'ready' ||
      result.status?.sources.some(source => source.state === 'connected' && source.enabled))) {
    await connected?.(context, result.status)
  }

  return result
}

/** The captured host is part of the owner. Equal account metadata alone is insufficient. */
export function sameMatrixGoogleConnectionOwner(
  captured: MatrixGoogleConnectionBoundaryOwner,
  current: MatrixGoogleConnectionBoundaryOwner | null | undefined
): boolean {
  return Boolean(current && captured.accountKey === current.accountKey && captured.generation === current.generation &&
    captured.userId === current.userId && captured.deviceId === current.deviceId && captured.host === current.host)
}

/**
 * Main-process handler for the fixed renderer Google-connection request union.
 * Sender authority is established before reading `input` or resolving the bridge.
 */
export function createMatrixGoogleConnectionIpcHandler<Event>(
  options: MatrixGoogleConnectionIpcHandlerOptions<Event>
): (event: Event, input: unknown) => Promise<MatrixGoogleConnectionResult> | MatrixGoogleConnectionResult {
  return (event, input) => {
    options.assertSender(event)

    const connections = options.connections()
    const row = record(input)

    if (!connections || !row) {
      return unavailable()
    }

    if (row.kind === 'status' && (exactKeys(row, ['kind']) || exactKeys(row, ['kind', 'context']))) {
      const context = Object.hasOwn(row, 'context') ? firstRunContext(row.context) : null

      if (Object.hasOwn(row, 'context') && !context) {
        return invalidInput()
      }

      return connections.status().then(result => observeFirstRun(result, context, options.firstRunConnected))
    }

    if (row.kind === 'connect' && (exactKeys(row, ['kind', 'grant']) || exactKeys(row, ['kind', 'grant', 'context'])) &&
      (row.grant === 'google' || row.grant === 'email-calendar' || row.grant === 'drive')) {
      const context = Object.hasOwn(row, 'context') ? firstRunContext(row.context) : null

      if (Object.hasOwn(row, 'context') && !context) {
        return invalidInput()
      }

      return connections.connect(row.grant).then(result => observeFirstRun(result, context, options.firstRunConnected))
    }

    if (row.kind === 'disconnect' && exactKeys(row, ['kind', 'groupId']) &&
      typeof row.groupId === 'string' && row.groupId.length <= 128) {
      return connections.disconnect(row.groupId)
    }

    if (row.kind === 'preferences' && exactKeys(row, ['kind', 'preferences']) && preferences(row.preferences)) {
      return connections.setSourcePreferences(row.preferences)
    }

    return invalidInput()
  }
}

/**
 * Main-process handler for a Google write card's answer (`MATRIX_GOOGLE_WRITE_IPC`). Sender authority
 * is established before the input is read; only the proposal, the digest of what the card rendered,
 * and approve or decline cross. Anything else, or no bridge, is `retry`: never approved.
 */
export function createMatrixGoogleWriteIpcHandler<Event>(options: {
  assertSender(event: Event): void
  decide(): ((input: MatrixGoogleWriteDecisionInput) => Promise<MatrixGoogleWriteAnswer>) | undefined
}): (event: Event, input: unknown) => Promise<MatrixGoogleWriteAnswer> {
  return async (event, input) => {
    options.assertSender(event)

    const decision = parseMatrixGoogleWriteDecisionInput(input)
    const decide = options.decide()

    return decision && decide ? decide(decision) : 'retry'
  }
}

function fenceHost(value: object): MatrixGoogleFenceHost | null {
  const candidate = value as Partial<MatrixGoogleFenceHost>

  return candidate.queue && typeof candidate.queue === 'object' && typeof candidate.queue.command === 'function'
    ? candidate as MatrixGoogleFenceHost
    : null
}

/**
 * Publishes through the exact host captured with the connection owner. Main's
 * current-owner callback supplies the existing readiness and lifecycle policy.
 */
export async function publishMatrixGoogleFence(
  owner: MatrixGoogleConnectionBoundaryOwner,
  currentOwner: () => MatrixGoogleConnectionBoundaryOwner | null | undefined
): Promise<MatrixGoogleFence> {
  if (!sameMatrixGoogleConnectionOwner(owner, currentOwner())) {
    throw new Error('matrix_google_fence_stale')
  }

  const host = fenceHost(owner.host)

  if (!host) {
    throw new Error('matrix_google_fence_unavailable')
  }

  const raw = await host.queue.command({
    kind: 'publishGoogleFence',
    identity: { userId: owner.userId, deviceId: owner.deviceId }
  }, 30_000)

  if (!sameMatrixGoogleConnectionOwner(owner, currentOwner())) {
    throw new Error('matrix_google_fence_stale')
  }

  const fence = parseMatrixGoogleFence(raw)

  if (!fence) {
    throw new Error('matrix_google_fence_unavailable')
  }

  return fence
}

/** Read only the owner-scoped platform projection. Never interpret an unreadable account as disconnected. */
export async function requestMatrixGoogleAccountStatus(
  resource: string, accessToken: string, signal: AbortSignal
): Promise<MatrixGoogleConnectionResult> {
  const response = await fetch(`${resource}/google/status`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal
  })
  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }
  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    return { status: null, error: 'network' }
  }
  try {
    const value = record(await readDomainJson(response, 32 * 1024))
    if (!value || value.profile !== 'atum.google-connection/1' ||
        !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
        !Array.isArray(value.scopes) || !value.scopes.every(scope => typeof scope === 'string') ||
        !['ready', 'disconnected', 'attention'].includes(String(value.state))) {
      return { status: null, error: 'network' }
    }
    // The pinned account and a recent refusal are additive: an older platform sends neither, and a malformed value is dropped.
    const email = typeof value.googleEmail === 'string' && value.googleEmail.length <= 320 &&
      /^[^\s@]+@[^\s@]+$/u.test(value.googleEmail)
      ? value.googleEmail
      : undefined

    return { status: { available: true, sources: [],
      accountState: value.state as 'ready' | 'disconnected' | 'attention',
      ...(email && value.state !== 'disconnected' ? { accountEmail: email } : {}),
      ...(value.refusal === 'google_account_mismatch' && value.state !== 'disconnected'
        ? { accountNotice: 'google_account_mismatch' as const }
        : {}) } }
  } catch {
    return { status: null, error: 'network' }
  }
}

/** Start the existing platform OAuth flow; only main may open the validated Google URL. */
export async function requestMatrixGoogleAccountConnect(resource: string, accessToken: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${resource}/google/connect`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: 'atum.google-connection/1', requestId: randomUUID(), returnTo: 'desktop' }),
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal
  })
  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }
  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_google_unavailable')
  }
  const value = record(await readDomainJson(response, 32 * 1024))
  if (!value || value.profile !== 'atum.google-connection/1' || value.state !== 'authorization_required' || typeof value.authorizeUrl !== 'string') {
    throw new Error('matrix_google_unavailable')
  }
  const url = new URL(value.authorizeUrl)
  if (url.origin !== 'https://accounts.google.com' || url.username || url.password) {
    throw new Error('matrix_google_unavailable')
  }
  return url.href
}

const WRITE_ANSWER_BYTES = 4 * 1024

/**
 * The owner's answer to one Google write proposal (atum.google-write-confirmation/1), sent with the
 * owner's bearer through `account.s1Request`. The idempotency key is fixed per proposal and decision,
 * so a retry after a lost answer returns Shell's saved answer and never writes twice. Only a positive,
 * well-formed answer for this exact proposal is `done`/`approved`/`declined`; every refusal keeps its
 * own state, and anything else is `retry`, never approved.
 */
export async function requestMatrixGoogleWriteDecision(
  resource: string,
  accessToken: string,
  input: MatrixGoogleWriteDecisionInput,
  signal: AbortSignal
): Promise<MatrixGoogleWriteAnswer> {
  const response = await fetch(`${resource}/google/proposals/${encodeURIComponent(input.proposalId)}/decision`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Atum-Google-Write-Contract': MATRIX_GOOGLE_WRITE_PROFILE,
      'Idempotency-Key': `${input.proposalId}:${input.decision}`
    },
    body: JSON.stringify({ decision: input.decision, digest: input.digest }),
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal
  })

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()

    return 'retry'
  }

  let value: Record<string, unknown> | null

  try {
    value = record(await readDomainJson(response, WRITE_ANSWER_BYTES))
  } catch {
    return 'retry'
  }

  if (!value || value.profile !== MATRIX_GOOGLE_WRITE_PROFILE || value.proposalId !== input.proposalId) {
    return 'retry'
  }

  const { status } = response
  const approve = input.decision === 'approve'

  if (exactKeys(value, ['profile', 'proposalId', 'state'])) {
    if (status === 200 && approve && value.state === 'done') { return 'done' }
    if (status === 202 && approve && value.state === 'approved') { return 'approved' }
    if (status === 200 && !approve && value.state === 'declined') { return 'declined' }

    return 'retry'
  }

  if (!exactKeys(value, ['profile', 'proposalId', 'error'])) {
    return 'retry'
  }

  const refusal = `${status} ${String(value.error)}`

  switch (refusal) {
    case '409 digest_mismatch': return 'changed'
    case '409 superseded': return 'superseded'
    case '409 already_decided': return 'answered'
    case '410 expired':
    case '404 not_found': return 'expired'
    case '422 write_failed': return approve ? 'failed' : 'retry'
    default: return 'retry'
  }
}

/** The account's owner seam: `MatrixAccount.appScope` and `MatrixAccount.s1Request`. */
export interface MatrixGoogleWriteAccount {
  appScope(): { accountKey: string; generation: number } | null
  s1Request<T>(
    send: (accessToken: string, resource: string, requestSignal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    options?: { timeoutMs?: number }
  ): Promise<T>
}

/**
 * The card's decision through the owner's native bearer (`account.s1Request`: one refresh after a
 * 401, the same idempotency key on the resend). Shell may take its 110-second dispatch to answer an
 * approval. A lost answer, a failure or an answer that arrives for another account's window is
 * `retry`; the card's retry carries the same key, so Shell returns its saved answer.
 */
export function matrixGoogleWriteDecider(account: MatrixGoogleWriteAccount) {
  return async (input: MatrixGoogleWriteDecisionInput): Promise<MatrixGoogleWriteAnswer> => {
    const owner = account.appScope()

    try {
      const answer = await account.s1Request(
        (token, resource, requestSignal) => requestMatrixGoogleWriteDecision(resource, token, input, requestSignal),
        AbortSignal.timeout(125_000),
        { timeoutMs: 120_000 }
      )
      const current = account.appScope()

      return owner && current?.accountKey === owner.accountKey && current.generation === owner.generation
        ? answer
        : 'retry'
    } catch {
      return 'retry'
    }
  }
}
