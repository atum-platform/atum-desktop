import { map } from 'nanostores'

import type { MatrixRoom } from '../../../shared/matrix'
import type {
  MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
  MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE,
  MatrixCompanyPrivateCosCapabilityV12,
  MatrixCompanyPrivateCosCapabilityV13,
  MatrixCompanyPrivateCosEnsureLocale,
  MatrixCompanyPrivateCosOwnerReceipt,
  MatrixCompanyPrivateCosPair,
  MatrixCompanyPrivateCosStopReceipt,
  MatrixCompanyPrivateCosView
} from '../../../shared/matrix-company-private-cos'
import {
  isCompanyPrivateCosRoom,
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  matrixCompanyPrivateCosPowerPolicy,
  matrixCompanyPrivateCosSupportsV12,
  matrixCompanyPrivateCosSupportsV13,
  matrixCompanyPrivateCosViewSupportsV11
} from '../../../shared/matrix-company-private-cos'
import type { CompanyPrivateCosDesktopAdapter } from '../company-desktop-adapter'

import { teamSpaceKey } from './keys'

export type CompanyPrivateCosAvailability = 'preparing' | 'ready' | 'paused' | 'unavailable'

export interface CompanyPrivateCosState {
  /** A successful strict view proves the platform serves the frozen capability for this member/company. */
  served: true
  profile:
    | typeof MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE
    | typeof MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE
  capability: MatrixCompanyPrivateCosCapabilityV12 | MatrixCompanyPrivateCosCapabilityV13
  availability: CompanyPrivateCosAvailability
  view: MatrixCompanyPrivateCosView
  loading: boolean
  ensureRequestId?: string
  /** The trigger and locale `ensureRequestId` was first sent with; the platform replays only the same input. */
  ensureRequestInput?: string
}

export const $companyPrivateCos = map<Record<string, CompanyPrivateCosState>>({})

/**
 * What the desktop knows before the platform serves a strict view: still asking, or asked and nothing
 * usable came back (capability off, outage, refusal). Kept apart from `$companyPrivateCos` so a served
 * row keeps meaning exactly one strict platform view.
 */
export type CompanyPrivateCosDiscovery = 'checking' | 'not_available'

export const $companyPrivateCosDiscovery = map<Record<string, CompanyPrivateCosDiscovery>>({})

let sequence = 0
const attempts = new Map<string, number>()
const ensuring = new Map<string, { attempt: number; promise: Promise<CompanyPrivateCosState> }>()
const rechecking = new Map<string, Promise<CompanyPrivateCosState | undefined>>()
const backoff = new Map<string, { failures: number; notBefore: number }>()

/** Automatic re-checks wait 15 s, then double, never longer than five minutes. Retry and focus skip the wait. */
export const COMPANY_PRIVATE_COS_RECHECK_MIN_MS = 15_000
export const COMPANY_PRIVATE_COS_RECHECK_MAX_MS = 300_000

const samePair = (left: MatrixCompanyPrivateCosPair, right: MatrixCompanyPrivateCosPair) =>
  left.companyPrincipal === right.companyPrincipal &&
  left.memberPrincipal === right.memberPrincipal &&
  left.membershipIncarnation === right.membershipIncarnation

const availability = (view: MatrixCompanyPrivateCosView): CompanyPrivateCosAvailability =>
  view.state === 'ready' ? 'ready' : 'preparing'

const doomedBy = (accountKey: string, companyId?: string) => (key: string) =>
  companyId ? key === teamSpaceKey(accountKey, companyId) : key.startsWith(`${accountKey}\n`)

/** Drops the served row and fences its in-flight answers; discovery and its backoff stay. */
function dropServed(accountKey: string, companyId?: string): void {
  const doomed = doomedBy(accountKey, companyId)

  for (const key of attempts.keys()) {
    if (doomed(key)) {attempts.delete(key)}
  }

  for (const key of ensuring.keys()) {
    if (doomed(key)) {ensuring.delete(key)}
  }

  $companyPrivateCos.set(
    Object.fromEntries(Object.entries($companyPrivateCos.get()).filter(([key]) => !doomed(key)))
  )
}

/** The account or company is gone from this window: forget everything, including what discovery learned. */
export function clearCompanyPrivateCos(accountKey: string, companyId?: string): void {
  const doomed = doomedBy(accountKey, companyId)

  dropServed(accountKey, companyId)

  for (const map of [rechecking, backoff]) {
    for (const key of map.keys()) {
      if (doomed(key)) {map.delete(key)}
    }
  }

  $companyPrivateCosDiscovery.set(
    Object.fromEntries(Object.entries($companyPrivateCosDiscovery.get()).filter(([key]) => !doomed(key)))
  )
}

function keepView(key: string, view: MatrixCompanyPrivateCosView, patch: Partial<CompanyPrivateCosState> = {}) {
  const prior = $companyPrivateCos.get()[key]
  const capability = patch.capability ?? prior?.capability

  if (!capability) {
    throw new Error('matrix_company_private_cos_capability_missing')
  }

  if (prior && !samePair(prior.view.pair, view.pair)) {
    dropServed(key.split('\n')[0]!, view.pair.companyPrincipal)
    throw new Error('matrix_company_private_cos_pair_changed')
  }
  if (prior && matrixCompanyPrivateCosViewSupportsV11(prior.view) &&
    matrixCompanyPrivateCosViewSupportsV11(view) &&
    prior.view.operationId !== view.operationId) {
    throw new Error('matrix_company_private_cos_operation_changed')
  }

  // The platform records an ensure only when it succeeds, and a success leaves the pair uncreated no
  // longer. While a read still says uncreated, the last unanswered request id is the one to retry.
  const kept = view.state === 'uncreated' && prior?.ensureRequestId
    ? { ensureRequestId: prior.ensureRequestId, ensureRequestInput: prior.ensureRequestInput }
    : {}

  const next: CompanyPrivateCosState = {
    served: true,
    profile: capability.profile,
    capability,
    availability: availability(view),
    view,
    loading: false,
    ...kept,
    ...patch
  }

  $companyPrivateCos.setKey(key, next)

  return next
}

/**
 * The explicit native capability is the platform signal. Only exact 1.2 or 1.3 advertisements
 * admit their frozen v1 views; older/unclassified responses draw nothing. A passing outage keeps
 * one honest unavailable state.
 */
export async function loadCompanyPrivateCos(
  adapter: CompanyPrivateCosDesktopAdapter | undefined,
  accountKey: string,
  companyId: string,
  capability?: unknown
): Promise<CompanyPrivateCosState | undefined> {
  const key = teamSpaceKey(accountKey, companyId)

  if (!adapter ||
    !(matrixCompanyPrivateCosSupportsV12(capability) || matrixCompanyPrivateCosSupportsV13(capability))) {
    dropServed(accountKey, companyId)

    return undefined
  }

  const attempt = ++sequence
  attempts.set(key, attempt)
  const before = $companyPrivateCos.get()[key]

  if (before) {$companyPrivateCos.setKey(key, { ...before, loading: true })}

  try {
    const view = await adapter.readPrivateCos(companyId)

    if (attempts.get(key) !== attempt) {return $companyPrivateCos.get()[key]}
    return keepView(key, view, { capability })
  } catch (error) {
    if (attempts.get(key) !== attempt) {return $companyPrivateCos.get()[key]}

    const code = error instanceof Error ? error.message : 'unavailable'

    if (['authentication', 'denied', 'missing', 'invalid', 'update_required',
      'matrix_company_private_cos_pair_changed'].includes(code) ||
      !before) {
      dropServed(accountKey, companyId)

      return undefined
    }

    const next: CompanyPrivateCosState = {
      ...before,
      loading: false,
      availability: ['budget_exhausted', 'ai_disabled', 'stopped'].includes(code) ? 'paused' : 'unavailable'
    }

    $companyPrivateCos.setKey(key, next)

    return next
  }
}

export async function ensureCompanyPrivateCos(
  adapter: CompanyPrivateCosDesktopAdapter,
  accountKey: string,
  companyId: string,
  trigger: 'dm_open' | 'first_company_visit' = 'dm_open',
  locale?: MatrixCompanyPrivateCosEnsureLocale
): Promise<CompanyPrivateCosState> {
  const key = teamSpaceKey(accountKey, companyId)
  const before = $companyPrivateCos.get()[key]

  if (!before) {throw new Error('matrix_company_private_cos_not_served')}

  if (before.view.state === 'ready') {return before}

  // One ensure per company and account at a time: the member row, the sidebar and a re-check share it.
  const inFlight = ensuring.get(key)

  if (inFlight && attempts.get(key) === inFlight.attempt) {return inFlight.promise}

  const attempt = ++sequence
  attempts.set(key, attempt)
  const promise = sendEnsure(adapter, key, accountKey, companyId, before, attempt, trigger, locale)
  ensuring.set(key, { attempt, promise })

  const settle = () => {
    if (ensuring.get(key)?.attempt === attempt) {ensuring.delete(key)}
  }

  promise.then(settle, settle)

  return promise
}

async function sendEnsure(
  adapter: CompanyPrivateCosDesktopAdapter,
  key: string,
  accountKey: string,
  companyId: string,
  before: CompanyPrivateCosState,
  attempt: number,
  trigger: 'dm_open' | 'first_company_visit',
  locale?: MatrixCompanyPrivateCosEnsureLocale
): Promise<CompanyPrivateCosState> {
  const input = `${trigger}\u0000${locale ?? ''}`

  const requestId = before.ensureRequestId && (before.ensureRequestInput ?? input) === input
    ? before.ensureRequestId
    : globalThis.crypto.randomUUID()

  $companyPrivateCos.setKey(key, {
    ...before,
    loading: true,
    availability: 'preparing',
    ensureRequestId: requestId,
    ensureRequestInput: input
  })

  try {
    const view = await adapter.ensurePrivateCos(companyId, {
      schemaVersion: 1,
      requestId,
      action: 'ensure',
      trigger,
      ...(locale ? { locale } : {})
    })

    if (attempts.get(key) !== attempt) {
      throw new Error('matrix_company_private_cos_stale')
    }

    return keepView(key, view)
  } catch (error) {
    // Company/account clears and newer reads/ensures invalidate both halves of this request.
    // A late rejection must not resurrect `before` or overwrite a newer membership incarnation.
    if (attempts.get(key) !== attempt) {throw error}

    const code = error instanceof Error ? error.message : 'unavailable'

    if (['authentication', 'denied', 'missing', 'invalid', 'update_required'].includes(code)) {
      dropServed(accountKey, companyId)
      throw error
    }

    const next: CompanyPrivateCosState = {
      ...before,
      loading: false,
      availability: ['budget_exhausted', 'ai_disabled', 'stopped'].includes(code) ? 'paused' : 'unavailable',
      ensureRequestId: requestId,
      ensureRequestInput: input
    }

    $companyPrivateCos.setKey(key, next)
    throw error
  }
}

/** First admitted company visit: read without creating, then ensure only an uncreated current pair. */
export async function admitCompanyPrivateCosVisit(
  adapter: CompanyPrivateCosDesktopAdapter | undefined,
  accountKey: string,
  companyId: string,
  capability?: unknown,
  locale?: MatrixCompanyPrivateCosEnsureLocale
): Promise<CompanyPrivateCosState | undefined> {
  const advertised = capability ?? await adapter?.readPrivateCosCapability(companyId)
  const state = await loadCompanyPrivateCos(adapter, accountKey, companyId, advertised)

  return state?.view.state === 'uncreated' && adapter
    ? ensureCompanyPrivateCos(
        adapter,
        accountKey,
        companyId,
        'first_company_visit',
        matrixCompanyPrivateCosSupportsV13(advertised) ? locale : undefined
      )
    : state
}

/**
 * Run the first-visit admission again whenever it could now succeed: the capability switched on under a
 * running window, the app came back to the front, the account changed, or the periodic refresh came
 * round. It is the same idempotent path (one strict read, an ensure only for an uncreated pair, the
 * kept request id on a retry), shared by concurrent callers, and an automatic call waits out a backoff
 * after an attempt that left nothing usable. `force` (Retry, focus, account switch) skips that wait.
 */
export function recheckCompanyPrivateCos(
  adapter: CompanyPrivateCosDesktopAdapter | undefined,
  accountKey: string,
  companyId: string,
  locale?: MatrixCompanyPrivateCosEnsureLocale,
  options: { force?: boolean; now?: number } = {}
): Promise<CompanyPrivateCosState | undefined> {
  const key = teamSpaceKey(accountKey, companyId)
  const now = options.now ?? Date.now()
  const current = $companyPrivateCos.get()[key]

  const running = rechecking.get(key)

  if (running) {return running}

  // An ensure in flight is already the answer; a read now would only fence it as stale.
  const inFlight = ensuring.get(key)

  if (inFlight && attempts.get(key) === inFlight.attempt) {return Promise.resolve(current)}

  if (!options.force && now < (backoff.get(key)?.notBefore ?? 0)) {return Promise.resolve(current)}

  if (!adapter) {
    $companyPrivateCosDiscovery.setKey(key, 'not_available')

    return Promise.resolve(undefined)
  }

  if (!current) {$companyPrivateCosDiscovery.setKey(key, 'checking')}

  const settle = (state: CompanyPrivateCosState | undefined) => {
    if (rechecking.get(key) !== promise) {return state}

    rechecking.delete(key)
    const usable = state && state.view.state !== 'uncreated' &&
      (state.availability === 'ready' || state.availability === 'preparing')

    if (usable) {
      backoff.delete(key)
    } else {
      const failures = (backoff.get(key)?.failures ?? 0) + 1
      const wait = Math.min(COMPANY_PRIVATE_COS_RECHECK_MIN_MS * 2 ** (failures - 1), COMPANY_PRIVATE_COS_RECHECK_MAX_MS)
      backoff.set(key, { failures, notBefore: now + wait })
    }

    if (state) {
      const { [key]: _served, ...rest } = $companyPrivateCosDiscovery.get()
      $companyPrivateCosDiscovery.set(rest)
    } else {
      $companyPrivateCosDiscovery.setKey(key, 'not_available')
    }

    return state
  }

  const promise: Promise<CompanyPrivateCosState | undefined> = admitCompanyPrivateCosVisit(
    adapter,
    accountKey,
    companyId,
    undefined,
    locale
  ).then(settle, () => settle($companyPrivateCos.get()[key]))

  rechecking.set(key, promise)

  return promise
}

export type CompanyPrivateCosRowStatus = 'setting_up' | 'ready' | 'paused' | 'not_available'

/**
 * The one honest line a Chief of Staff row shows. Before the first answer it is setting up: the
 * workspace asks as soon as a company opens.
 */
export function companyPrivateCosRowStatus(
  state: CompanyPrivateCosState | undefined,
  discovery: CompanyPrivateCosDiscovery | undefined
): CompanyPrivateCosRowStatus {
  if (!state) {return discovery === 'not_available' ? 'not_available' : 'setting_up'}

  if (state.loading) {return 'setting_up'}

  switch (state.availability) {
    case 'ready':
      return 'ready'
    case 'preparing':
      return 'setting_up'
    case 'paused':
      return 'paused'
    default:
      return 'not_available'
  }
}

/** The exact current room, only when both platform binding and fail-closed room classification agree. */
export function companyPrivateCosBoundRoomId(state: CompanyPrivateCosState | undefined): string | undefined {
  return state && 'binding' in state.view ? state.view.binding.roomId : undefined
}

/** Full post-join verification; invite-state stripped state is never used for this decision. */
export function companyPrivateCosJoinedRoomMatches(
  state: CompanyPrivateCosState | undefined,
  room: MatrixRoom | undefined
): boolean {
  const view = state?.view

  if (!view || !('binding' in view) || !room || room.id !== view.binding.roomId ||
    room.membership !== 'join' || !isCompanyPrivateCosRoom(room)) {
    return false
  }

  const marker = room.companyPrivateCos
  const joined = room.participants?.filter(participant => participant.membership === 'join')

  return marker?.companyId === view.pair.companyPrincipal &&
    marker.membershipIncarnation === view.pair.membershipIncarnation &&
    marker.executorId === view.binding.executorId &&
    room.roomVersion === '11' &&
    !room.encrypted &&
    room.joinRule === 'invite' &&
    room.historyVisibility === 'joined' &&
    joined?.length === 2 &&
    joined.some(participant => participant.userId === view.binding.agentUserId) &&
    matrixCompanyPrivateCosPowerPolicy(room.powerLevels, joined.map(participant => participant.userId))
}

export function companyPrivateCosRoom(
  state: CompanyPrivateCosState | undefined,
  rooms: readonly MatrixRoom[]
): MatrixRoom | undefined {
  const view = state?.view

  if (!view || view.state !== 'ready' || state?.availability === 'unavailable') {return undefined}
  const room = rooms.find(candidate => candidate.id === view.binding.roomId)

  return companyPrivateCosJoinedRoomMatches(state, room) ? room : undefined
}

function ownerReceipt<T extends MatrixCompanyPrivateCosOwnerReceipt | MatrixCompanyPrivateCosStopReceipt>(
  state: CompanyPrivateCosState,
  receipt: T
): T {
  if (!samePair(state.view.pair, receipt.pair)) {throw new Error('matrix_company_private_cos_pair_mismatch')}

  return receipt
}

/** No member selector: native/platform derive the owner from the authenticated session. */
export async function readCompanyPrivateCosReceipt(
  adapter: CompanyPrivateCosDesktopAdapter,
  state: CompanyPrivateCosState,
  runId: string
): Promise<MatrixCompanyPrivateCosOwnerReceipt> {
  return ownerReceipt(state, await adapter.readPrivateCosReceipt(state.view.pair.companyPrincipal, runId))
}

/** No member selector: only the authenticated pair owner can stop this run. */
export async function stopCompanyPrivateCos(
  adapter: CompanyPrivateCosDesktopAdapter,
  state: CompanyPrivateCosState,
  runId: string,
  requestId = globalThis.crypto.randomUUID()
): Promise<MatrixCompanyPrivateCosStopReceipt> {
  return ownerReceipt(state, await adapter.stopPrivateCos(state.view.pair.companyPrincipal, runId, {
    schemaVersion: 1,
    requestId
  }))
}

/** Kept explicit for room producer/controller conformance tests. */
export const COMPANY_PRIVATE_COS_ROOM_TYPE = MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE
