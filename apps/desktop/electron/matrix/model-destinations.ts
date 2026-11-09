import { randomUUID } from 'node:crypto'

import type { ExecutionDeviceName } from '../../shared/execution-policy'
import {
  MATRIX_DEFAULT_MODEL,
  MATRIX_MODELS,
  matrixCloudModelAlias,
  type MatrixModelDestinationsView,
  type MatrixModelDestinationView,
  type MatrixModelId
} from '../../shared/matrix-models'

import { readDomainJson } from './domain'

/**
 * The owner's default model for every destination an agent can answer from, through the
 * platform's `atum.model-choice/1.3` owner routes (plan 2026-10-17 model-lineup S4 D8):
 *
 * - `GET  /agents/{agentPrincipal}/model-destinations` — one revision-fenced snapshot:
 *   the server's recommendation, the saved choices (cloud and each of the owner's Macs),
 *   the daily cap and today's spend.
 * - `PUT  /agents/{agentPrincipal}/model-destinations` — one destination's choice, fenced
 *   by the snapshot's revision and policy digest, with a request id for replay.
 * - `PUT  /agents/{agentPrincipal}/model-daily-cap` — one agent's daily Proton cap, fenced
 *   by the same snapshot revision, with its own request id.
 *
 * This is the strict reader and writer: the frozen pack's schemas (`.strict` in the
 * platform's TypeScript mirror, duplicate destinations and spend/state consistency
 * included) are enforced here, in native main. The window receives only the display rows
 * (`MatrixModelDestinationsView`): names, the line-up aliases, what is selectable and
 * which model is the server's recommendation. No credential or provider field crosses.
 *
 * The route is behind `ATUM_MATRIX_MODEL_CHOICE_SYNC_ENABLED`. With no snapshot (flag off,
 * route absent, read failed) there is no view and the assistant card draws no row; a
 * refused write leaves the previous snapshot in place, so the row goes back quietly.
 */

export const MATRIX_MODEL_DESTINATIONS_PROFILE = 'atum.model-choice/1.3' as const
/** The additive profile a cloud OpenCode Go choice is written and read as. */
export const MATRIX_MODEL_DESTINATIONS_PROFILE_14 = 'atum.model-choice/1.4' as const
export const MATRIX_MODEL_DESTINATIONS_PROFILE_15 = 'atum.model-choice/1.5' as const
export type MatrixModelDestinationsProfile =
  | typeof MATRIX_MODEL_DESTINATIONS_PROFILE
  | typeof MATRIX_MODEL_DESTINATIONS_PROFILE_14
  | typeof MATRIX_MODEL_DESTINATIONS_PROFILE_15
/** How often an open app re-reads the snapshot; another device may have changed a choice. */
export const MATRIX_MODEL_DESTINATIONS_REFRESH_MS = 60_000
/** A destination choice is not on a person's critical path: a failure leaves the row where it was. */
const MATRIX_MODEL_DESTINATIONS_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 256 * 1024

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const ALIAS = /^[a-z0-9][a-z0-9-]*$/u
const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const MAC = /^mac:[A-Za-z0-9_-]+$/u
const OWN_KEY = /^own_key:[a-z0-9][a-z0-9_-]*$/u
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u
const MANAGED_EFFORTS = ['low', 'medium', 'high'] as const
const PRODUCT_EFFORTS = ['low', 'medium', 'high', 'max'] as const
const DAILY_CAP = { timeZone: 'Asia/Ho_Chi_Minh', warningPercent: 80, counts: 'atum_billed_only' } as const

export type MatrixManagedEffort = (typeof MANAGED_EFFORTS)[number]
export type MatrixProductEffort = (typeof PRODUCT_EFFORTS)[number]

interface AtumDestinationChoice {
  destination: 'cloud' | `mac:${string}`
  source: 'atum'
  model: string
  effort: MatrixManagedEffort
}

interface MacPlanDestinationChoice {
  destination: `mac:${string}`
  source: 'chatgpt_plan'
  model: string
  effort: MatrixProductEffort
}

interface MacOwnKeyDestinationChoice {
  destination: `mac:${string}`
  source: `own_key:${string}`
  model: string
  effort: MatrixProductEffort
}

/** `atum.model-choice/1.4`: one cloud model from the account-wide OpenCode Go connection. */
interface CloudSubscriptionDestinationChoice {
  destination: 'cloud'
  source: 'opencode_go' | 'chatgpt_plan'
  model: string
  effort: MatrixManagedEffort
}

export type MatrixDestinationChoice =
  | AtumDestinationChoice
  | MacPlanDestinationChoice
  | MacOwnKeyDestinationChoice
  | CloudSubscriptionDestinationChoice

export interface MatrixModelDestinationSnapshot {
  profile: MatrixModelDestinationsProfile
  agentPrincipal: string
  revision: number
  policyDigest: string
  recommended: { source: 'atum'; model: string; effort: MatrixManagedEffort }
  choices: readonly MatrixDestinationChoice[]
  dailyCap: { dailyProtons: number; timeZone: typeof DAILY_CAP.timeZone; warningPercent: 80; counts: 'atum_billed_only' }
  spend: { day: string; usedProtons: number; state: 'normal' | 'warning' | 'exhausted'; notice: 'none' | 'eighty_percent' | 'exhausted' }
}

export interface MatrixModelDestinationsWriteRequest {
  profile: MatrixModelDestinationsProfile
  requestId: string
  expectedRevision: number
  policyDigest: string
  choice: MatrixDestinationChoice
}

/** One agent's daily cap (`PUT /agents/{principal}/model-daily-cap`), fenced like a choice. */
export interface MatrixModelDailyCapWriteRequest {
  profile: MatrixModelDestinationsProfile
  requestId: string
  expectedRevision: number
  dailyProtons: number
}

export type MatrixModelDestinationsAction = 'read' | 'write' | 'cap'

export type MatrixModelDestinationsBody = MatrixModelDestinationsWriteRequest | MatrixModelDailyCapWriteRequest

export interface MatrixModelDestinationsResponse {
  status: number
  value: unknown
}

export interface MatrixModelDestinationsScope {
  accountKey: string
  generation: number
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)

  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function alias(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 40 && ALIAS.test(value) ? value : undefined
}

function modelRef(value: unknown): string | undefined {
  return typeof value === 'string' && [...value].length >= 1 && [...value].length <= 200 && MODEL_REF.test(value)
    ? value
    : undefined
}

function managedEffort(value: unknown): MatrixManagedEffort | undefined {
  return MANAGED_EFFORTS.find(effort => effort === value)
}

function productEffort(value: unknown): MatrixProductEffort | undefined {
  return PRODUCT_EFFORTS.find(effort => effort === value)
}

function destinationId(value: unknown): 'cloud' | `mac:${string}` | undefined {
  if (value === 'cloud') {
    return 'cloud'
  }

  return typeof value === 'string' && value.length >= 5 && value.length <= 132 && MAC.test(value)
    ? (value as `mac:${string}`)
    : undefined
}

/** One destination choice, exactly one of the contract's four shapes and no extra key. */
export function parseMatrixDestinationChoice(value: unknown): MatrixDestinationChoice | undefined {
  if (!record(value)) {
    return undefined
  }

  const destination = destinationId(value.destination)

  if (!destination) {
    return undefined
  }

  if (value.source === 'atum') {
    const model = alias(value.model)
    const effort = managedEffort(value.effort)

    if (!model || !effort || !exact(value, ['destination', 'source', 'model', 'effort'])) {
      return undefined
    }

    return { destination, source: 'atum', model, effort }
  }

  if (value.source === 'opencode_go' || (value.source === 'chatgpt_plan' && destination === 'cloud')) {
    const model = modelRef(value.model)
    const effort = managedEffort(value.effort)

    if (destination !== 'cloud' || !model || !effort || !exact(value, ['destination', 'source', 'model', 'effort'])) {
      return undefined
    }

    return { destination, source: value.source, model, effort }
  }

  if (destination === 'cloud') {
    return undefined
  }

  const model = modelRef(value.model)
  const effort = productEffort(value.effort)

  if (!model || !effort || !exact(value, ['destination', 'source', 'model', 'effort'])) {
    return undefined
  }

  if (value.source === 'chatgpt_plan') {
    return { destination, source: 'chatgpt_plan', model, effort }
  }

  if (typeof value.source === 'string' && OWN_KEY.test(value.source)) {
    return { destination, source: value.source as `own_key:${string}`, model, effort }
  }

  return undefined
}

const DAILY_STATES = ['normal', 'warning', 'exhausted'] as const
const DAILY_NOTICES = ['none', 'eighty_percent', 'exhausted'] as const

function dailySpend(value: unknown, dailyProtons: number): MatrixModelDestinationSnapshot['spend'] | undefined {
  if (!record(value) || !exact(value, ['day', 'usedProtons', 'state', 'notice'])) {
    return undefined
  }

  const state = DAILY_STATES.find(each => each === value.state)
  const notice = DAILY_NOTICES.find(each => each === value.notice)

  if (
    typeof value.day !== 'string' ||
    !DAY.test(value.day) ||
    !integer(value.usedProtons) ||
    !state ||
    !notice ||
    (state === 'normal' && notice !== 'none') ||
    (state === 'warning' && notice !== 'eighty_percent') ||
    (state === 'exhausted' && notice !== 'exhausted')
  ) {
    return undefined
  }

  // The snapshot's own invariant: below 80% is normal, from 80% below the cap is warning,
  // at or above the cap is exhausted, and an uncapped agent is always normal.
  const cap = BigInt(dailyProtons)
  const used = BigInt(value.usedProtons)
  const threshold = (cap * 80n + 99n) / 100n
  const expected = cap === 0n ? 'normal' : used >= cap ? 'exhausted' : used >= threshold ? 'warning' : 'normal'

  if (state !== expected) {
    return undefined
  }

  return { day: value.day, usedProtons: value.usedProtons, state, notice }
}

/**
 * The destination snapshot, strictly. Every top-level and nested key must be the contract's
 * own; a duplicate destination, an unknown alias/effort shape or a spend state that does
 * not follow from the cap is malformed, never silently repaired.
 */
export function parseMatrixModelDestinationSnapshot(
  value: unknown,
  agentPrincipal: string
): MatrixModelDestinationSnapshot | undefined {
  if (
    !record(value) ||
    !exact(value, ['profile', 'agentPrincipal', 'revision', 'policyDigest', 'recommended', 'choices', 'dailyCap', 'spend']) ||
    (value.profile !== MATRIX_MODEL_DESTINATIONS_PROFILE && value.profile !== MATRIX_MODEL_DESTINATIONS_PROFILE_14 &&
      value.profile !== MATRIX_MODEL_DESTINATIONS_PROFILE_15) ||
    value.agentPrincipal !== agentPrincipal ||
    !UUID.test(agentPrincipal) ||
    !integer(value.revision) ||
    typeof value.policyDigest !== 'string' ||
    !SHA256.test(value.policyDigest)
  ) {
    return undefined
  }

  if (
    !record(value.recommended) ||
    !exact(value.recommended, ['source', 'model', 'effort']) ||
    value.recommended.source !== 'atum'
  ) {
    return undefined
  }

  const recommendedModel = alias(value.recommended.model)
  const recommendedEffort = managedEffort(value.recommended.effort)

  if (!recommendedModel || !recommendedEffort) {
    return undefined
  }

  if (!Array.isArray(value.choices) || value.choices.length > 65) {
    return undefined
  }

  const choices: MatrixDestinationChoice[] = []
  const destinations = new Set<string>()

  for (const raw of value.choices) {
    const choice = parseMatrixDestinationChoice(raw)

    if (!choice || destinations.has(choice.destination)) {
      return undefined
    }

    destinations.add(choice.destination)
    choices.push(choice)
  }

  const subscription = choices.find(choice => choice.destination === 'cloud' &&
    (choice.source === 'opencode_go' || choice.source === 'chatgpt_plan'))

  // The platform states 1.4 exactly while the agent has a subscription choice; the two must
  // never drift apart, or an older reader would silently ignore a live source.
  if ((subscription?.source === 'opencode_go') !== (value.profile === MATRIX_MODEL_DESTINATIONS_PROFILE_14) ||
      (subscription?.source === 'chatgpt_plan') !== (value.profile === MATRIX_MODEL_DESTINATIONS_PROFILE_15) ||
      (!subscription && value.profile !== MATRIX_MODEL_DESTINATIONS_PROFILE)) {
    return undefined
  }

  if (
    !record(value.dailyCap) ||
    !exact(value.dailyCap, ['dailyProtons', 'timeZone', 'warningPercent', 'counts']) ||
    !integer(value.dailyCap.dailyProtons) ||
    value.dailyCap.timeZone !== DAILY_CAP.timeZone ||
    value.dailyCap.warningPercent !== DAILY_CAP.warningPercent ||
    value.dailyCap.counts !== DAILY_CAP.counts
  ) {
    return undefined
  }

  const spend = dailySpend(value.spend, value.dailyCap.dailyProtons)

  if (!spend) {
    return undefined
  }

  return {
    profile: value.profile,
    agentPrincipal,
    revision: value.revision,
    policyDigest: value.policyDigest,
    recommended: { source: 'atum', model: recommendedModel, effort: recommendedEffort },
    choices,
    dailyCap: {
      dailyProtons: value.dailyCap.dailyProtons,
      timeZone: DAILY_CAP.timeZone,
      warningPercent: DAILY_CAP.warningPercent,
      counts: DAILY_CAP.counts
    },
    spend
  }
}

/** A Proton count the contract accepts: a whole number from 0 (no limit) upward. */
export function parseMatrixDailyProtons(value: unknown): number | undefined {
  return integer(value) ? value : undefined
}

/** The cap body this client sends, checked against the contract before it leaves main. */
export function parseMatrixModelDailyCapWrite(
  value: unknown
): MatrixModelDailyCapWriteRequest | undefined {
  if (
    !record(value) ||
    !exact(value, ['profile', 'requestId', 'expectedRevision', 'dailyProtons']) ||
    ![MATRIX_MODEL_DESTINATIONS_PROFILE, MATRIX_MODEL_DESTINATIONS_PROFILE_14,
      MATRIX_MODEL_DESTINATIONS_PROFILE_15].includes(value.profile as MatrixModelDestinationsProfile) ||
    typeof value.requestId !== 'string' ||
    !UUID.test(value.requestId) ||
    !integer(value.expectedRevision)
  ) {
    return undefined
  }

  const dailyProtons = parseMatrixDailyProtons(value.dailyProtons)

  if (dailyProtons === undefined) {
    return undefined
  }

  return {
    profile: MATRIX_MODEL_DESTINATIONS_PROFILE,
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
    dailyProtons
  }
}

/**
 * One cap write body, fenced by the snapshot the person is looking at. 0 is the contract's
 * uncapped value. The server computes spend and state again from its own ledger.
 */
export function matrixModelDailyCapWrite(
  snapshot: MatrixModelDestinationSnapshot,
  dailyProtons: number,
  requestId = randomUUID()
): MatrixModelDailyCapWriteRequest | undefined {
  return parseMatrixModelDailyCapWrite({
    profile: MATRIX_MODEL_DESTINATIONS_PROFILE,
    requestId,
    expectedRevision: snapshot.revision,
    dailyProtons
  })
}

/** The body this client sends, checked against the contract before it leaves main. */
export function parseMatrixModelDestinationsWrite(
  value: unknown
): MatrixModelDestinationsWriteRequest | undefined {
  if (
    !record(value) ||
    !exact(value, ['profile', 'requestId', 'expectedRevision', 'policyDigest', 'choice']) ||
    (value.profile !== MATRIX_MODEL_DESTINATIONS_PROFILE && value.profile !== MATRIX_MODEL_DESTINATIONS_PROFILE_14 &&
      value.profile !== MATRIX_MODEL_DESTINATIONS_PROFILE_15) ||
    typeof value.requestId !== 'string' ||
    !UUID.test(value.requestId) ||
    !integer(value.expectedRevision) ||
    typeof value.policyDigest !== 'string' ||
    !SHA256.test(value.policyDigest)
  ) {
    return undefined
  }

  const choice = parseMatrixDestinationChoice(value.choice)

  if (!choice || (choice.source === 'opencode_go') !== (value.profile === MATRIX_MODEL_DESTINATIONS_PROFILE_14) ||
      (choice.source === 'chatgpt_plan') !== (value.profile === MATRIX_MODEL_DESTINATIONS_PROFILE_15)) {
    return undefined
  }

  return {
    profile: value.profile,
    requestId: value.requestId,
    expectedRevision: value.expectedRevision,
    policyDigest: value.policyDigest,
    choice
  }
}

/**
 * One destination's write body. A model change keeps the standard effort (`recommended`,
 * medium today); choosing the model already stored keeps that destination's own effort.
 * The server still refuses an alias dispatch does not offer.
 */
export function matrixModelDestinationWrite(
  snapshot: MatrixModelDestinationSnapshot,
  destination: 'cloud' | `mac:${string}`,
  model: MatrixModelId,
  requestId = randomUUID()
): MatrixModelDestinationsWriteRequest | undefined {
  if (!destinationId(destination) || !MATRIX_MODELS.includes(model)) {
    return undefined
  }

  const current = snapshot.choices.find(choice => choice.destination === destination)

  const effort =
    current?.source === 'atum' && current.model === model ? current.effort : snapshot.recommended.effort

  return parseMatrixModelDestinationsWrite({
    profile: MATRIX_MODEL_DESTINATIONS_PROFILE,
    requestId,
    expectedRevision: snapshot.revision,
    policyDigest: snapshot.policyDigest,
    choice: { destination, source: 'atum', model, effort }
  })
}

/**
 * A cloud pick from the account's OpenCode Go connection (`atum.model-choice/1.4`). The server
 * accepts only a connected connection and a model the catalogue serves; a refusal changes
 * nothing and never silently becomes an Atum choice.
 */
export function matrixSubscriptionDestinationWrite(
  snapshot: MatrixModelDestinationSnapshot,
  source: 'opencode_go' | 'chatgpt_plan',
  model: string,
  effort: MatrixManagedEffort,
  requestId = randomUUID()
): MatrixModelDestinationsWriteRequest | undefined {
  return parseMatrixModelDestinationsWrite({
    profile: source === 'chatgpt_plan' ? MATRIX_MODEL_DESTINATIONS_PROFILE_15 : MATRIX_MODEL_DESTINATIONS_PROFILE_14,
    requestId,
    expectedRevision: snapshot.revision,
    policyDigest: snapshot.policyDigest,
    choice: { destination: 'cloud', source, model, effort }
  })
}

/** The aliases the server offers for this agent's cloud turns; the same rule as the composer. */
export interface MatrixModelDestinationOffer {
  offered: readonly string[]
}

/**
 * What the assistant card draws: one row per destination the agent can answer from —
 * the cloud, then each of the owner's Macs by display name — with the reference model
 * (the saved choice, else the server's recommendation) and the line-up rows it may pick.
 * Cloud availability follows the composer's offer; Mac availability is the line-up.
 */
export function matrixModelDestinationsView(
  snapshot: MatrixModelDestinationSnapshot,
  options: {
    deviceNames?: Record<string, ExecutionDeviceName>
    /** Older registry rows this Mac superseded. Display-only cleanup; the platform remains the
     * authority and the current device is never in this set. */
    supersededDeviceIds?: readonly string[]
    offer?: MatrixModelDestinationOffer
    here?: 'cloud' | 'mac'
    thisDevice?: string
  } = {}
): MatrixModelDestinationsView {
  const recommended = matrixCloudModelAlias(snapshot.recommended.model) ?? MATRIX_DEFAULT_MODEL

  const offered = new Set(
    (options.offer?.offered ?? []).flatMap(alias => {
      const model = matrixCloudModelAlias(alias)

      return model ? [model] : []
    })
  )

  const cloudModels = MATRIX_MODELS.filter(model => model === MATRIX_DEFAULT_MODEL || offered.has(model))

  const current = (destination: string): { model: MatrixModelId; external?: MatrixModelDestinationView['external'] } => {
    const choice = snapshot.choices.find(each => each.destination === destination)
    const chosen = choice ? matrixCloudModelAlias(choice.model) : undefined

    return {
      model: chosen ?? recommended,
      ...(choice && choice.source !== 'atum'
        ? {
            external: {
              source: choice.source,
              providerLabel: choice.source === 'chatgpt_plan' ? 'ChatGPT' : choice.source === 'opencode_go' ? 'OpenCode Go' : 'API connection',
              model: choice.model,
              modelLabel: choice.model
                .split(/[-_/]+/u)
                .filter(Boolean)
                .map(word => (/^gpt$/iu.test(word) ? 'GPT' : /^[a-z]+$/u.test(word) ? word[0]!.toUpperCase() + word.slice(1) : word))
                .join(' '),
              effort: choice.effort
            }
          }
        : {})
    }
  }

  const superseded = new Set(options.supersededDeviceIds ?? [])
  const macIds = [
    ...snapshot.choices.flatMap(choice => (choice.destination === 'cloud' ? [] : [choice.destination as string])),
    ...Object.keys(options.deviceNames ?? {}).map(deviceId => `mac:${deviceId}`)
  ].filter(
    (id, index, all) =>
      all.indexOf(id) === index &&
      (!superseded.has(id.slice('mac:'.length)) || id === `mac:${options.thisDevice}`)
  )

  const cloud = current('cloud')

  const macs = macIds.map((id, index) => {
    const deviceId = id.slice('mac:'.length)
    const device = options.deviceNames?.[deviceId]
    const reference = current(id)

    return {
      id,
      kind: 'mac' as const,
      ...(device?.displayName ? { deviceName: device.displayName } : {}),
      ...(device?.model ? { deviceModel: device.model } : {}),
      ...(device?.thisMac || deviceId === options.thisDevice ? { thisMac: true } : {}),
      macOrdinal: index + 1,
      current: reference.model,
      ...(reference.external ? { external: reference.external } : {}),
      recommended: reference.model === recommended,
      models: [...MATRIX_MODELS],
      unavailable: []
    }
  })

  const choices: MatrixModelDestinationView[] = [
    {
      id: 'cloud',
      kind: 'cloud',
      current: cloud.model,
      ...(cloud.external ? { external: cloud.external } : {}),
      recommended: cloud.model === recommended,
      models: cloudModels,
      unavailable: MATRIX_MODELS.filter(model => !cloudModels.includes(model))
    },
    ...macs
  ]

  const hereCurrent =
    options.here === 'cloud'
      ? cloud.model
      : options.here === 'mac'
        ? ((options.thisDevice ? macs.find(choice => choice.id === `mac:${options.thisDevice}`)?.current : undefined) ??
          recommended)
        : undefined

  return {
    recommended,
    choices,
    dailyCap: {
      dailyProtons: snapshot.dailyCap.dailyProtons,
      revision: snapshot.revision,
      spend: {
        day: snapshot.spend.day,
        usedProtons: snapshot.spend.usedProtons,
        state: snapshot.spend.state,
        notice: snapshot.spend.notice
      }
    },
    ...(hereCurrent ? { here: hereCurrent } : {})
  }
}

/** The default for the destination that answers a turn here (the card's composer fallback). */
export function matrixModelDestinationHere(
  view: MatrixModelDestinationsView,
  kind: 'cloud' | 'mac',
  thisDevice?: string
): MatrixModelId {
  const destination = kind === 'cloud' ? 'cloud' : thisDevice ? `mac:${thisDevice}` : undefined

  return view.choices.find(choice => choice.id === destination)?.current ?? view.recommended
}

/**
 * One fixed owner route. The bearer and the base stay in native main, like every other S1
 * route; the renderer never names an agent, a URL or a token.
 */
export async function requestMatrixModelDestinations(
  resource: string,
  accessToken: string,
  agentPrincipal: string,
  action: MatrixModelDestinationsAction,
  signal: AbortSignal,
  body?: MatrixModelDestinationsBody
): Promise<MatrixModelDestinationsResponse> {
  signal.throwIfAborted()

  const validBody =
    action === 'read'
      ? !body
      : action === 'write'
        ? Boolean(body && parseMatrixModelDestinationsWrite(body))
        : Boolean(body && parseMatrixModelDailyCapWrite(body))

  if (!UUID.test(agentPrincipal) || !validBody) {
    throw new Error('matrix_model_destinations_invalid')
  }

  const route = action === 'cap' ? 'model-daily-cap' : 'model-destinations'

  const response = await fetch(`${resource}/agents/${encodeURIComponent(agentPrincipal)}/${route}`, {
    method: action === 'read' ? 'GET' : 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(action !== 'read' ? { 'Content-Type': 'application/json' } : {})
    },
    ...(action !== 'read' ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal
  })

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()

    return { status: response.status, value: null }
  }

  try {
    return { status: response.status, value: await readDomainJson(response, MAX_RESPONSE_BYTES) }
  } catch {
    return { status: response.status, value: null }
  }
}

export interface MatrixModelDestinationsOptions {
  scope(): MatrixModelDestinationsScope | null
  call(
    agentPrincipal: string,
    action: MatrixModelDestinationsAction,
    signal: AbortSignal,
    body?: MatrixModelDestinationsBody
  ): Promise<MatrixModelDestinationsResponse>
  /** The owner's Macs, the same registry the failover rows name. Cosmetic and optional. */
  deviceNames(): Promise<Record<string, ExecutionDeviceName> | undefined>
  /** Older exact-name enrollments hidden by the registry-name projection. */
  supersededDeviceIds?(): readonly string[]
  /** The composer's cloud offer (`GET /models`); absent leaves the cloud row on Nguyệt Thực. */
  offer(agentPrincipal: string): MatrixModelDestinationOffer | undefined
  /** Which destination answers here now: the cloud, or this Mac. */
  here(agentPrincipal: string): 'cloud' | 'mac'
  thisDevice(): string | undefined
  changed(): void
  now?(): number
}

interface Entry {
  snapshot?: MatrixModelDestinationSnapshot
  view?: MatrixModelDestinationsView
  refreshedAt: number
  refreshing: boolean
}

function sameScope(left: MatrixModelDestinationsScope | null, right: MatrixModelDestinationsScope | null): boolean {
  return left?.accountKey === right?.accountKey && left?.generation === right?.generation
}

/**
 * Account-generation-fenced cache of each agent's destination snapshot. A missing or failed
 * read leaves no view, and the card draws no row: the flag-off behaviour, never an error
 * band. A successful write adopts the server's own snapshot; a refusal changes nothing,
 * so the row goes back to what the server last said.
 */
/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export async function writeMatrixCloudAtumChoice(
  agentPrincipal: string,
  model: MatrixModelId,
  options: {
    destinations?: Pick<MatrixModelDestinations, 'view' | 'read' | 'write'>
    legacy?: { write(agentPrincipal: string, model: MatrixModelId): Promise<boolean>; reload(agentPrincipal: string): Promise<void> }
  }
): Promise<boolean> {
  const { destinations, legacy } = options

  if (!destinations) {
    return legacy ? legacy.write(agentPrincipal, model) : false
  }

  if (!destinations.view(agentPrincipal)) {
    await destinations.read(agentPrincipal).catch(() => undefined)
  }

  const applied = await destinations.write(agentPrincipal, 'cloud', model).catch(() => false)

  if (applied) {
    await legacy?.reload(agentPrincipal).catch(() => undefined)
  }

  return applied
}

export class MatrixModelDestinations {
  private owner: MatrixModelDestinationsScope | null = null
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly options: MatrixModelDestinationsOptions) {}

  activate(owner: MatrixModelDestinationsScope | null): void {
    if (sameScope(owner, this.owner)) {
      return
    }

    this.owner = owner
    this.entries.clear()
  }

  /** The server's cloud choice, including its source; absent until a snapshot was read. */
  cloudChoice(agentPrincipal: string): Extract<MatrixDestinationChoice, { destination: 'cloud' }> | undefined {
    const choice = this.entries.get(agentPrincipal)?.snapshot?.choices.find(each => each.destination === 'cloud')

    return choice as Extract<MatrixDestinationChoice, { destination: 'cloud' }> | undefined
  }

  /** What the window shows for this agent; absent when no snapshot was reachable. */
  view(agentPrincipal: string): MatrixModelDestinationsView | undefined {
    const entry = this.entries.get(agentPrincipal)

    if (!entry?.view) {
      return undefined
    }

    // The cloud eligibility is the composer's live offer, which can widen without a new
    // destination snapshot (a dispatch change); the Mac rows never depend on it. No offer
    // is the composer's no-offer state: Nguyệt Thực only.
    const offer = this.options.offer(agentPrincipal) ?? { offered: [] }

    const offered = new Set(
      offer.offered.flatMap(alias => {
        const model = matrixCloudModelAlias(alias)

        return model ? [model] : []
      })
    )

    const models = MATRIX_MODELS.filter(model => model === MATRIX_DEFAULT_MODEL || offered.has(model))
    const unavailable = MATRIX_MODELS.filter(model => !models.includes(model))
    const cloud = entry.view.choices.find(choice => choice.kind === 'cloud')
    const hereKind = this.options.here(agentPrincipal)
    const thisDevice = this.options.thisDevice()

    const here =
      hereKind === 'cloud'
        ? cloud?.current
        : ((thisDevice
            ? entry.view.choices.find(choice => choice.id === `mac:${thisDevice}`)?.current
            : undefined) ?? entry.view.recommended)

    // Keep the same object across publishes unless one of the live facts changed, so the
    // window does not reset an open row (or a pick in flight) every snapshot.
    if (
      cloud &&
      entry.view.here === here &&
      cloud.models.length === models.length &&
      cloud.models.every((model, index) => model === models[index]) &&
      cloud.unavailable.length === unavailable.length &&
      cloud.unavailable.every((model, index) => model === unavailable[index])
    ) {
      return entry.view
    }

    return {
      ...entry.view,
      here,
      choices: entry.view.choices.map(choice =>
        choice.kind === 'cloud' ? { ...choice, models, unavailable } : choice
      )
    }
  }

  snapshot(agentPrincipal: string): MatrixModelDestinationSnapshot | undefined {
    return this.entries.get(agentPrincipal)?.snapshot
  }

  /** Read the snapshot now if it is stale; never throws and never blocks a publish. */
  refresh(agentPrincipal: string): void {
    if (!this.options.scope()) {
      return
    }

    const now = this.options.now?.() ?? Date.now()
    const entry = this.entries.get(agentPrincipal)

    if (entry?.refreshing || (entry && now - entry.refreshedAt < MATRIX_MODEL_DESTINATIONS_REFRESH_MS)) {
      return
    }

    this.entries.set(agentPrincipal, {
      ...(entry?.snapshot ? { snapshot: entry.snapshot } : {}),
      ...(entry?.view ? { view: entry.view } : {}),
      refreshedAt: now,
      refreshing: true
    })

    void this.read(agentPrincipal).finally(() => {
      const current = this.entries.get(agentPrincipal)

      if (current) {
        this.entries.set(agentPrincipal, { ...current, refreshing: false })
      }
    })
  }

  /** A forced read (the card opening, or after the composer wrote the cloud choice). */
  async read(agentPrincipal: string): Promise<MatrixModelDestinationsView | undefined> {
    let response: MatrixModelDestinationsResponse

    try {
      response = await this.options.call(
        agentPrincipal,
        'read',
        AbortSignal.timeout(MATRIX_MODEL_DESTINATIONS_TIMEOUT_MS)
      )
    } catch {
      this.fallback(agentPrincipal)

      return this.view(agentPrincipal)
    }

    if (!sameScope(this.owner, this.options.scope())) {
      return this.view(agentPrincipal)
    }

    const snapshot =
      response.status === 200 ? parseMatrixModelDestinationSnapshot(response.value, agentPrincipal) : undefined

    if (!snapshot) {
      this.fallback(agentPrincipal)

      return this.view(agentPrincipal)
    }

    const view = await this.display(snapshot, agentPrincipal)

    if (!view) {
      return this.view(agentPrincipal)
    }

    this.entries.set(agentPrincipal, { snapshot, view, refreshedAt: Date.now(), refreshing: false })
    this.options.changed()

    return view
  }

  /**
   * Write one destination's model. False for any refusal (ineligible alias, revision or
   * policy change, an unreachable server): the caller keeps the row it had.
   */
  async write(agentPrincipal: string, destination: string, model: MatrixModelId): Promise<boolean> {
    const snapshot = this.entries.get(agentPrincipal)?.snapshot
    const id = destinationId(destination)
    const body = snapshot && id ? matrixModelDestinationWrite(snapshot, id, model) : undefined

    if (!body) {
      return false
    }

    let response: MatrixModelDestinationsResponse

    try {
      response = await this.options.call(
        agentPrincipal,
        'write',
        AbortSignal.timeout(MATRIX_MODEL_DESTINATIONS_TIMEOUT_MS),
        body
      )
    } catch {
      // A transport failure changed nothing; the next read settles what the server holds.
      this.fallback(agentPrincipal)

      return false
    }

    return this.adopt(response, agentPrincipal)
  }

  /**
   * Write the cloud destination to one account-subscription model (`atum.model-choice/1.4`).
   * The server accepts only a connected OpenCode Go connection and a served model; a refusal
   * changes nothing and never becomes an Atum choice.
   */
  async writeSubscription(agentPrincipal: string, source: 'opencode_go' | 'chatgpt_plan', model: string,
    effort: MatrixManagedEffort): Promise<boolean> {
    const snapshot = this.entries.get(agentPrincipal)?.snapshot
    const body = snapshot ? matrixSubscriptionDestinationWrite(snapshot, source, model, effort) : undefined

    if (!body) {
      return false
    }

    let response: MatrixModelDestinationsResponse

    try {
      response = await this.options.call(
        agentPrincipal,
        'write',
        AbortSignal.timeout(MATRIX_MODEL_DESTINATIONS_TIMEOUT_MS),
        body
      )
    } catch {
      this.fallback(agentPrincipal)

      return false
    }

    return this.adopt(response, agentPrincipal)
  }

  /**
   * Write one agent's daily cap, fenced by the snapshot's revision. False for a refusal or an
   * unreachable server: the previous snapshot stays, so the row keeps the server's last value
   * and the person can retry after the next read.
   */
  async cap(agentPrincipal: string, dailyProtons: number): Promise<boolean> {
    const snapshot = this.entries.get(agentPrincipal)?.snapshot
    const body = snapshot ? matrixModelDailyCapWrite(snapshot, dailyProtons) : undefined

    if (!body) {
      return false
    }

    let response: MatrixModelDestinationsResponse

    try {
      response = await this.options.call(
        agentPrincipal,
        'cap',
        AbortSignal.timeout(MATRIX_MODEL_DESTINATIONS_TIMEOUT_MS),
        body
      )
    } catch {
      // Nothing changed. Keep the last snapshot (unlike a failed read): the row must not
      // disappear just because one retryable write did not reach the server.
      return false
    }

    return this.adopt(response, agentPrincipal)
  }

  /** The server's own answer replaces the snapshot; a refusal changes nothing. */
  private async adopt(
    response: MatrixModelDestinationsResponse,
    agentPrincipal: string
  ): Promise<boolean> {
    const next =
      response.status === 200 ? parseMatrixModelDestinationSnapshot(response.value, agentPrincipal) : undefined

    if (!next) {
      return false
    }

    const view = await this.display(next, agentPrincipal)

    if (!view) {
      return false
    }

    this.entries.set(agentPrincipal, { snapshot: next, view, refreshedAt: Date.now(), refreshing: false })
    this.options.changed()

    return true
  }

  private async display(
    snapshot: MatrixModelDestinationSnapshot,
    agentPrincipal: string
  ): Promise<MatrixModelDestinationsView | undefined> {
    const deviceNames = await this.options.deviceNames().catch(() => undefined)

    if (!sameScope(this.owner, this.options.scope())) {
      return undefined
    }

    return matrixModelDestinationsView(snapshot, {
      ...(deviceNames ? { deviceNames } : {}),
      ...(this.options.supersededDeviceIds ? { supersededDeviceIds: this.options.supersededDeviceIds() } : {}),
      ...(this.options.offer(agentPrincipal) ? { offer: this.options.offer(agentPrincipal) } : {}),
      here: this.options.here(agentPrincipal),
      ...(this.options.thisDevice() ? { thisDevice: this.options.thisDevice() } : {})
    })
  }

  /** No snapshot this minute (the flag is off, the route is absent, a read failed). */
  private fallback(agentPrincipal: string): void {
    if (!sameScope(this.owner, this.options.scope())) {
      return
    }

    const previous = this.entries.get(agentPrincipal)

    this.entries.set(agentPrincipal, { refreshedAt: Date.now(), refreshing: false })

    if (previous?.view) {
      this.options.changed()
    }
  }
}
