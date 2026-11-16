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
  MATRIX_GOOGLE_HOST_BRIDGE_CONTRACT,
  MATRIX_GOOGLE_HOST_BRIDGE_HEADER,
  MATRIX_GOOGLE_PROPOSALS_PATH,
  MATRIX_GOOGLE_WRITE_STATUS,
  type MatrixGoogleWriteActionAnswer,
  type MatrixGoogleWriteActionInput,
  type MatrixGoogleWriteListAnswer,
  parseMatrixGoogleWriteActionInput,
  parseMatrixGoogleWriteProposalList
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

/** What main does for the Google write cards, through the owner's bearer (`matrixGoogleWriteProposals`). */
export interface MatrixGoogleWriteProposalsBridge {
  list(): Promise<MatrixGoogleWriteListAnswer>
  act(input: MatrixGoogleWriteActionInput): Promise<MatrixGoogleWriteActionAnswer>
}

const writeUnavailable = { state: 'unavailable' } as const

/**
 * Main-process handler for the Google write cards (`MATRIX_GOOGLE_WRITE_IPC`). Sender authority is
 * established before the input is read; only `list`, or one action with the proposal and the
 * digest of what the card rendered, crosses. Anything else, or no bridge, is unavailable.
 */
export function createMatrixGoogleWriteIpcHandler<Event>(options: {
  assertSender(event: Event): void
  proposals(): MatrixGoogleWriteProposalsBridge | undefined
}): (event: Event, input: unknown) => Promise<MatrixGoogleWriteListAnswer | MatrixGoogleWriteActionAnswer> {
  return async (event, input) => {
    options.assertSender(event)

    const row = record(input)
    const proposals = options.proposals()

    if (!row || !proposals) {
      return writeUnavailable
    }

    if (row.kind === 'list' && exactKeys(row, ['kind'])) {
      return proposals.list()
    }

    const action = row.kind === 'action' && exactKeys(row, ['kind', 'input']) ? parseMatrixGoogleWriteActionInput(row.input) : undefined

    return action ? proposals.act(action) : writeUnavailable
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

/** A pending list carries whole drafts (bodies, a forward's full quote); this bounds it. */
const WRITE_LIST_BYTES = 4 * 1024 * 1024
const WRITE_ANSWER_BYTES = 4 * 1024

function proposalsUrl(resource: string, ...path: string[]): URL {
  const url = new URL([MATRIX_GOOGLE_PROPOSALS_PATH, ...path.map(part => encodeURIComponent(part))].join('/'), resource)

  if (url.protocol !== 'https:') {
    throw new Error('matrix_google_unavailable')
  }

  return url
}

function proposalHeaders(accessToken: string, body: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    [MATRIX_GOOGLE_HOST_BRIDGE_HEADER]: MATRIX_GOOGLE_HOST_BRIDGE_CONTRACT
  }
}

/**
 * Shell's failure states. A 401 asks the account to refresh its bearer once (it is `refused` after
 * that); 400/403/409 are `refused`; anything else Shell did not positively answer is `unavailable`.
 */
async function writeFailure(response: Response): Promise<MatrixGoogleWriteActionAnswer & { state: 'refused' | 'unavailable' }> {
  await response.body?.cancel()

  if (response.status === 401) {
    throw new Error('matrix_s1_authentication')
  }

  return [400, 403, 409].includes(response.status) ? { state: 'refused' } : writeUnavailable
}

function json(response: Response): boolean {
  return response.status === 200 && Boolean(response.headers.get('content-type')?.startsWith('application/json'))
}

/** The owner's pending, unexpired proposals (`GET /api/connections/google/proposals`). */
export async function requestMatrixGoogleWriteProposals(
  resource: string,
  accessToken: string,
  signal: AbortSignal
): Promise<MatrixGoogleWriteListAnswer> {
  const response = await fetch(proposalsUrl(resource), {
    headers: proposalHeaders(accessToken, false),
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal
  })

  if (!json(response)) {
    return writeFailure(response)
  }

  try {
    const proposals = parseMatrixGoogleWriteProposalList(await readDomainJson(response, WRITE_LIST_BYTES))

    return proposals ? { state: 'ok', proposals } : writeUnavailable
  } catch {
    return writeUnavailable
  }
}

/**
 * One card action (`POST …/{proposalId}/delivered|approve|decline` with exactly `{digest}`). Only
 * HTTP 200 naming this proposal, this digest and the action's own status is `ok`; an approval is
 * `confirmed`, never sent: the assistant's repeated call carries it out.
 */
export async function requestMatrixGoogleWriteAction(
  resource: string,
  accessToken: string,
  input: MatrixGoogleWriteActionInput,
  signal: AbortSignal
): Promise<MatrixGoogleWriteActionAnswer> {
  const response = await fetch(proposalsUrl(resource, input.proposalId, input.action), {
    method: 'POST',
    headers: proposalHeaders(accessToken, true),
    body: JSON.stringify({ digest: input.digest }),
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal
  })

  if (!json(response)) {
    return writeFailure(response)
  }

  const status = MATRIX_GOOGLE_WRITE_STATUS[input.action]

  try {
    const value = record(await readDomainJson(response, WRITE_ANSWER_BYTES))

    return value && exactKeys(value, ['proposalId', 'digest', 'status']) && value.proposalId === input.proposalId &&
      value.digest === input.digest && value.status === status
      ? { state: 'ok', status }
      : writeUnavailable
  } catch {
    return writeUnavailable
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
 * The cards' requests through the owner's native bearer (`account.s1Request`: one refresh after a
 * 401). A second 401 is `refused`; a lost answer, a failure, or an answer that arrives after the
 * account changed is `unavailable`, never confirmed.
 */
export function matrixGoogleWriteProposals(account: MatrixGoogleWriteAccount): MatrixGoogleWriteProposalsBridge {
  async function owned<T extends { state: string }>(
    send: (accessToken: string, resource: string, signal: AbortSignal) => Promise<T>
  ): Promise<T | MatrixGoogleWriteActionAnswer & { state: 'refused' | 'unavailable' }> {
    const owner = account.appScope()

    try {
      const answer = await account.s1Request(send, AbortSignal.timeout(20_000))
      const current = account.appScope()

      return owner && current?.accountKey === owner.accountKey && current.generation === owner.generation
        ? answer
        : writeUnavailable
    } catch (error) {
      return error instanceof Error && error.message === 'matrix_s1_authentication' ? { state: 'refused' } : writeUnavailable
    }
  }

  return {
    list: () => owned((token, resource, signal) => requestMatrixGoogleWriteProposals(resource, token, signal)),
    act: input => owned((token, resource, signal) => requestMatrixGoogleWriteAction(resource, token, input, signal))
  }
}
