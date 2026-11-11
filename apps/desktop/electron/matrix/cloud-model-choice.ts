import { randomUUID } from 'node:crypto'

import type { MatrixCloudModelChoiceView, MatrixModelId } from '../../shared/matrix-models'
import {
  type MatrixShelfModelId,
  type MatrixShelfModelView,
  matrixShelfModelView
} from '../../shared/matrix-shelf-models'

import { readDomainJson } from './domain'

/**
 * The cloud's model choice, read and written through the platform's `atum.model-choice/1.1`
 * owner routes (plan 2026-10-17 model-lineup S4; the same routes the phone and the cloud
 * controller use):
 *
 * - `GET  /agents/{agentPrincipal}/models` — the provider's offer: policy revision, the
 *   choice the server holds, and every curated alias with its eligibility.
 * - `PUT  /agents/{agentPrincipal}/model-choice` — one owner choice, fenced by the offer's
 *   revision and policy digest, with a request id for replay.
 *
 * The offer is presentation data only. The server re-checks eligibility on every write and
 * on every cloud turn, so a stale row can never spend Protons by itself. No offer (the
 * feature flag is off, the route is absent, the read failed) means no cloud choice: the
 * picker falls back to Nguyệt Thực alone.
 */

export const MATRIX_CLOUD_MODEL_PROFILE = 'atum.model-choice/1.1' as const
/** How often an open app re-reads the offer; the server is the only source of an alias flip. */
export const MATRIX_CLOUD_MODEL_REFRESH_MS = 60_000
/** A cloud choice is not on a person's critical path: a failure leaves the row where it was. */
const MATRIX_CLOUD_MODEL_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 256 * 1024

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const ALIAS = /^[a-z0-9][a-z0-9-]*$/u
const EFFORT = /^[a-z]{1,16}$/u

export type MatrixCloudModelAction = 'read' | 'write'

export interface MatrixCloudModelResponse {
  status: number
  value: unknown
}

export interface MatrixCloudModelWriteRequest {
  profile: typeof MATRIX_CLOUD_MODEL_PROFILE
  requestId: string
  expectedRevision: number
  policyDigest: string
  choice: { v: 2; source: 'atum'; model: string; effort?: string }
}

export interface MatrixCloudModelRow {
  alias: string
  efforts: readonly string[]
  defaultEffort?: string
  /** `ready` in the offer's closed eligibility vocabulary; every other state is unavailable. */
  eligible: boolean
  /**
   * An OpenRouter shelf row with its name and Proton price, read from the same row. Absent for
   * Atum's own models, and for a shelf row missing any fact the picker needs to draw it.
   */
  shelf?: MatrixShelfModelView
}

export interface MatrixCloudModelOffer {
  revision: number
  policyDigest: string
  current?: string
  /** The effort the server holds for the current choice, when it names one. */
  effort?: string
  models: readonly MatrixCloudModelRow[]
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function alias(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 40 && ALIAS.test(value) ? value : undefined
}

function effort(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 16 && EFFORT.test(value) ? value : undefined
}

function isEligible(value: unknown): boolean {
  return record(value) && value.state === 'ready'
}

function displayText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined
}

/** The shelf facts on one offered row: its name, maker and USD price (the server's own figures). */
function shelfRow(row: Record<string, unknown>, alias: string, efforts: readonly string[], defaultEffort?: string) {
  const cost = record(row.cost) && row.cost.currency === 'USD' ? row.cost : undefined
  const displayName = displayText(row.displayName, 120)
  const providerModel = displayText(row.providerModel, 200)

  return matrixShelfModelView({
    alias,
    ...(displayName ? { displayName } : {}),
    ...(providerModel ? { providerModel } : {}),
    ...(typeof cost?.inputPerMtok === 'string' ? { inputUsdPerMtok: cost.inputPerMtok } : {}),
    ...(typeof cost?.outputPerMtok === 'string' ? { outputUsdPerMtok: cost.outputPerMtok } : {}),
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    retention: row.retention
  })
}

/**
 * The offer's fields this client needs, strictly typed. Unknown extra fields are ignored:
 * the platform may add evidence and runtime rows without breaking this reader, and none of
 * them is authority here.
 */
export function parseMatrixCloudModelOffer(value: unknown, agentPrincipal: string): MatrixCloudModelOffer | null {
  if (
    !record(value) ||
    value.profile !== MATRIX_CLOUD_MODEL_PROFILE ||
    value.agentPrincipal !== agentPrincipal ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.policyDigest !== 'string' ||
    !SHA256.test(value.policyDigest) ||
    !Array.isArray(value.models)
  ) {
    return null
  }

  const models: MatrixCloudModelRow[] = []
  const seen = new Set<string>()

  for (const row of value.models) {
    const rowAlias = record(row) ? alias(row.alias) : undefined

    if (!rowAlias || seen.has(rowAlias) || !Array.isArray(row.efforts)) {
      return null
    }

    seen.add(rowAlias)

    const efforts = row.efforts.flatMap(level => {
      const parsed = effort(level)

      return parsed ? [parsed] : []
    })

    if (efforts.length !== row.efforts.length || new Set(efforts).size !== efforts.length) {
      return null
    }

    const defaultEffort = row.defaultEffort === undefined ? undefined : effort(row.defaultEffort)

    if (row.defaultEffort !== undefined && !defaultEffort) {
      return null
    }

    const shelf = shelfRow(row, rowAlias, efforts, defaultEffort)

    models.push({
      alias: rowAlias,
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      eligible: isEligible(row.eligibility),
      ...(shelf ? { shelf } : {})
    })
  }

  const choice = record(value.choice) ? value.choice : undefined
  const current = choice ? alias(choice.model) : undefined
  const choiceEffort = choice ? effort(choice.effort) : undefined

  if (choice && (!current || choice.v !== 2 || choice.source !== 'atum')) {
    return null
  }

  return {
    revision: value.revision as number,
    policyDigest: value.policyDigest,
    ...(current ? { current } : {}),
    ...(choiceEffort ? { effort: choiceEffort } : {}),
    models
  }
}

/**
 * What the window needs: the aliases the server will take right now, the one it runs, and the
 * shelf models among them with their prices. An inactive shelf row is never eligible, so before
 * the platform activates the shelf the list is empty and the picker has no OpenRouter rail.
 */
export function matrixCloudModelView(offer: MatrixCloudModelOffer): MatrixCloudModelChoiceView {
  const shelf = offer.models.flatMap(row => (row.eligible && row.shelf ? [row.shelf] : []))

  return {
    offered: offer.models.filter(row => row.eligible).map(row => row.alias),
    ...(offer.current ? { current: offer.current } : {}),
    ...(shelf.length ? { shelf } : {})
  }
}

/** The write body for one alias: preserve the server's level when the destination takes it,
 * else its own default. The server still refuses an effort the alias does not serve. */
export function matrixCloudModelWrite(
  offer: MatrixCloudModelOffer,
  model: MatrixModelId | MatrixShelfModelId,
  requestId = randomUUID()
): MatrixCloudModelWriteRequest | null {
  const destination = offer.models.find(row => row.alias === model)

  if (!destination || !destination.eligible) {
    return null
  }

  const choiceEffort = offer.effort && destination.efforts.includes(offer.effort) ? offer.effort : destination.defaultEffort

  return {
    profile: MATRIX_CLOUD_MODEL_PROFILE,
    requestId,
    expectedRevision: offer.revision,
    policyDigest: offer.policyDigest,
    choice: { v: 2, source: 'atum', model, ...(choiceEffort ? { effort: choiceEffort } : {}) }
  }
}

/**
 * One fixed owner route. The bearer and the base stay in native main, like every other S1
 * route; the renderer never names an agent, a URL or a token.
 */
export async function requestMatrixCloudModelChoice(
  resource: string,
  accessToken: string,
  agentPrincipal: string,
  action: MatrixCloudModelAction,
  signal: AbortSignal,
  body?: MatrixCloudModelWriteRequest
): Promise<MatrixCloudModelResponse> {
  signal.throwIfAborted()

  if (!UUID.test(agentPrincipal) || (action === 'write') !== Boolean(body)) {
    throw new Error('matrix_cloud_model_invalid')
  }

  const route = action === 'write' ? 'model-choice' : 'models'

  const response = await fetch(`${resource}/agents/${encodeURIComponent(agentPrincipal)}/${route}`, {
    method: action === 'write' ? 'PUT' : 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(action === 'write' ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
    },
    ...(action === 'write' ? { body: JSON.stringify(body) } : {}),
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

export interface MatrixCloudModelChoiceScope {
  accountKey: string
  generation: number
}

interface MatrixCloudModelChoiceOptions {
  scope(): MatrixCloudModelChoiceScope | null
  call(
    agentPrincipal: string,
    action: MatrixCloudModelAction,
    signal: AbortSignal,
    body?: MatrixCloudModelWriteRequest
  ): Promise<MatrixCloudModelResponse>
  changed(): void
  now?(): number
}

interface Entry {
  offer?: MatrixCloudModelOffer
  view?: MatrixCloudModelChoiceView
  refreshedAt: number
  refreshing: boolean
}

function sameScope(left: MatrixCloudModelChoiceScope | null, right: MatrixCloudModelChoiceScope | null): boolean {
  return left?.accountKey === right?.accountKey && left?.generation === right?.generation
}

/**
 * A write the server refused only because its fence was old: another write moved the revision,
 * or the managed-model policy changed (a new digest). The owner's pick is still the newest
 * intent, so the caller reads the fences again and sends the same pick once more.
 */
export function matrixModelChoiceFenceConflict(response: { status: number; value: unknown }): boolean {
  if (response.status !== 409 || !record(response.value) || !record(response.value.details)) {
    return false
  }

  const reason = response.value.details.reason

  return reason === 'revision_conflict' || reason === 'policy_changed'
}

/**
 * Account-generation-fenced cache of each cloud agent's model-choice offer. A missing or
 * failed read leaves no view, which the picker treats as "Nguyệt Thực only": the old
 * behaviour, never an error band. A successful write replaces the cached offer with the
 * server's own answer, so a row that the server refused goes back without a local guess.
 */
export class MatrixCloudModelChoices {
  private owner: MatrixCloudModelChoiceScope | null = null
  private readonly entries = new Map<string, Entry>()
  /** Counts the writes this Mac adopted per agent; a read that started before one is stale. */
  private readonly writes = new Map<string, number>()
  /** Only the latest pick for an agent may retry or publish its answer. */
  private readonly intents = new Map<string, number>()
  private generation = 0

  constructor(private readonly options: MatrixCloudModelChoiceOptions) {}

  activate(owner: MatrixCloudModelChoiceScope | null): void {
    if (sameScope(owner, this.owner)) {
      return
    }

    this.owner = owner
    this.generation += 1
    this.intents.clear()
    this.entries.clear()
    this.writes.clear()
  }

  /** Keep every continuation tied to the account/cache generation that started it. */
  private scopeCurrent(): () => boolean {
    const generation = this.generation
    const owner = this.owner ? { ...this.owner } : null

    return () => owner !== null && generation === this.generation && sameScope(owner, this.options.scope())
  }

  /** What the window shows for this agent; absent when no offer was reachable. */
  view(agentPrincipal: string): MatrixCloudModelChoiceView | undefined {
    return this.entries.get(agentPrincipal)?.view
  }

  offer(agentPrincipal: string): MatrixCloudModelOffer | undefined {
    return this.entries.get(agentPrincipal)?.offer
  }

  /** Re-read at once: another route (the v1.3 destination choice) changed the same cloud row. */
  async reload(agentPrincipal: string): Promise<void> {
    await this.read(agentPrincipal)
  }

  /** Read the offer now if it is stale; never throws and never blocks a publish. */
  refresh(agentPrincipal: string): void {
    if (!this.options.scope()) {
      return
    }

    const now = this.options.now?.() ?? Date.now()
    const entry = this.entries.get(agentPrincipal)

    if (entry?.refreshing || (entry && now - entry.refreshedAt < MATRIX_CLOUD_MODEL_REFRESH_MS)) {
      return
    }

    this.entries.set(agentPrincipal, {
      ...(entry?.offer ? { offer: entry.offer } : {}),
      ...(entry?.view ? { view: entry.view } : {}),
      refreshedAt: now,
      refreshing: true
    })

    const currentScope = this.scopeCurrent()

    void this.read(agentPrincipal).finally(() => {
      if (!currentScope()) {
        return
      }

      const current = this.entries.get(agentPrincipal)

      if (current) {
        this.entries.set(agentPrincipal, { ...current, refreshing: false })
      }
    })
  }

  /**
   * Write one cloud choice. False for any refusal (flag off, ineligible alias, an unreachable
   * server, or a fence still old after one re-read): the caller keeps the row it had. A successful
   * write adopts the server's own snapshot, so the checked row is what the server stores.
   */
  async write(agentPrincipal: string, model: MatrixModelId | MatrixShelfModelId): Promise<boolean> {
    const scopeCurrent = this.scopeCurrent()
    const intent = (this.intents.get(agentPrincipal) ?? 0) + 1
    this.intents.set(agentPrincipal, intent)
    const current = () => scopeCurrent() && this.intents.get(agentPrincipal) === intent
    const first = await this.send(agentPrincipal, model, current)

    if (first !== 'stale') {
      return first
    }

    // The fence was old (the revision moved, or the policy changed): read it again and send the
    // same pick once. A second refusal is final; the row shows the offer just read.
    if (!current()) {
      return false
    }

    await this.read(agentPrincipal, current)

    return current() && (await this.send(agentPrincipal, model, current)) === true
  }

  private async send(agentPrincipal: string, model: MatrixModelId | MatrixShelfModelId, current: () => boolean): Promise<boolean | 'stale'> {
    if (!current()) {
      return false
    }

    const offer = this.offer(agentPrincipal)
    const body = offer ? matrixCloudModelWrite(offer, model) : null

    if (!body) {
      return false
    }

    let response: MatrixCloudModelResponse

    try {
      response = await this.options.call(
        agentPrincipal,
        'write',
        AbortSignal.timeout(MATRIX_CLOUD_MODEL_TIMEOUT_MS),
        body
      )
    } catch {
      // A transport failure changed nothing; the next read settles what the server holds.
      if (current()) {
        this.invalidate(agentPrincipal)
      }

      return false
    }

    if (!current()) {

      return false

    }

    if (matrixModelChoiceFenceConflict(response)) {
      return 'stale'
    }

    const next = response.status === 200 ? parseMatrixCloudModelOffer(response.value, agentPrincipal) : null

    if (!next) {
      if (current()) {
        this.invalidate(agentPrincipal)
      }

      return false
    }

    const held = this.offer(agentPrincipal)

    // The server accepted this write, but a newer snapshot is already held. Keep its clock too.
    if (held && next.revision < held.revision) {
      return true
    }

    this.writes.set(agentPrincipal, (this.writes.get(agentPrincipal) ?? 0) + 1)
    this.entries.set(agentPrincipal, { offer: next, view: matrixCloudModelView(next), refreshedAt: Date.now(), refreshing: false })
    this.options.changed()

    return true
  }

  private invalidate(agentPrincipal: string): void {
    this.entries.delete(agentPrincipal)
    this.options.changed()
  }

  private async read(agentPrincipal: string, current = this.scopeCurrent()): Promise<void> {
    // A periodic read can be in flight while the owner picks. If a write is adopted before that
    // read lands, its answer predates the pick: it must not put the previous model back.
    const writesAtStart = this.writes.get(agentPrincipal) ?? 0
    const superseded = () => !current() || (this.writes.get(agentPrincipal) ?? 0) !== writesAtStart
    let response: MatrixCloudModelResponse

    try {
      response = await this.options.call(agentPrincipal, 'read', AbortSignal.timeout(MATRIX_CLOUD_MODEL_TIMEOUT_MS))
    } catch {
      if (!superseded()) {
        this.fallback(agentPrincipal)
      }

      return
    }

    if (!sameScope(this.owner, this.options.scope()) || superseded()) {
      return
    }

    const offer = response.status === 200 ? parseMatrixCloudModelOffer(response.value, agentPrincipal) : null

    if (!offer) {
      this.fallback(agentPrincipal)

      return
    }

    // Two reads can land out of order; the revision only moves forward on the server.
    const held = this.entries.get(agentPrincipal)?.offer

    if (held && offer.revision < held.revision) {
      return
    }

    this.entries.set(agentPrincipal, { offer, view: matrixCloudModelView(offer), refreshedAt: Date.now(), refreshing: false })
    this.options.changed()
  }

  /**
   * No offer this minute (the flag is off, the route is absent, a read failed). The row goes
   * back to Nguyệt Thực only, and the next read waits for the normal interval so a missing
   * route is never polled once per publish.
   */
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
