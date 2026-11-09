/**
 * The Mac participant for `atum.agent-home/2.5`: local catalog publication and
 * next-turn-boundary application of the saved home default. Credentials never
 * leave the existing Hermes connection adapter.
 *
 * Every platform call here is paced (`call-pacer.ts`): the platform's owner-scoped buckets are shared by every agent on
 * every device, so a catalog is refreshed on a slow beat and when its binding changes, a model application is read on a
 * slow beat (a quick one only while turns are waiting for it), and a failing call backs off instead of beating.
 *
 * A Mac becomes a place an agent can move to only by being set up for it: the platform lists a Mac as a target, and takes its
 * catalog, only while the agent has an active local executor on that Mac. Nothing in the background creates one (that would
 * enroll every agent on every Mac); `prepare()` is the owner's explicit "Set this Mac up for <agent>", and the executor it
 * creates is kept answerable until the move to this Mac commits or is cancelled, bounded (`keepAnswerable`).
 */
import { randomBytes } from 'node:crypto'

import {
  MATRIX_MODEL_EFFORTS,
  matrixManagedModelLabel,
  type MatrixModelCatalog,
  type MatrixModelConnection,
  type MatrixModelRoute
} from '../../../shared/matrix-models'

import { CallPacer } from './call-pacer'
import type { PlacementConnectionAuth } from './connection-auth'
import type { PlacementConnectionPlatform } from './connection-platform'
import type { HomePlacement } from './contract'
import {
  ATUM_MANAGED_CONNECTION_REF,
  type HomeModelApplicationReportV25,
  MAC_CATALOG_FRESHNESS_MAX_MS,
  macConnectionCatalogContentSha256,
  type MacConnectionCatalogIngestV25,
  MacConnectionCatalogIngestV25Schema,
  type MacConnectionCatalogReceiptV25,
  type ModelApplicationProjectionV25,
  type PlacementModelChoiceV25,
  type SanitizedMacConnectionV25,
  type SanitizedMacModelV25
} from './contract-v25'
import { fenceFromLease, type LeaseFacts } from './fence'
import type { AgentHomeHolds } from './holds'
import type { AgentHomeOwnerController } from './owner-controller'
import { outcomeIsDefinitive, RetryLedger } from './retry-ledger'

interface ParticipantStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  failureCode(): string | null
}

export type ModelApplyResult =
  | { status: 'applied'; provider: string; model: string }
  | {
      status: 'unavailable'
      reason:
        | 'sign_in_expired'
        | 'connection_unavailable'
        | 'connection_needs_attention'
        | 'model_unavailable'
        | 'effort_unavailable'
        | 'catalog_stale'
    }

type UnavailableReason = Extract<ModelApplyResult, { status: 'unavailable' }>['reason']

/**
 * What the owner's "Set this Mac up" action answers with. `target_not_prepared` is this client's own word: the pack's closed
 * reason set for a catalog receipt has no word for "this Mac has no active executor for the agent" (the platform says
 * `stale_home` for that and for a home that moved), so a `stale_home` that survives this Mac's own enrollment is read as it.
 */
export type PrepareResult =
  | { ok: true; connections: number }
  | {
      ok: false
      /** `connect_model`: this Mac enrolled, but no model is connected, so it is not a usable target. */
      reason:
        | 'unavailable'
        | 'setup_busy'
        | 'not_ready'
        | 'another_move_in_progress'
        | 'target_not_prepared'
        | 'connect_model'
    }

type PublishOutcome =
  /** The platform took it. */
  | { status: 'sent'; receipt: MacConnectionCatalogReceiptV25; connections: number }
  /** Nothing was due (fresh and unchanged, or waiting out a backoff). */
  | { status: 'skipped' }
  /** This Mac's own connections could not be read just now. */
  | { status: 'unreadable' }
  /** The platform refused it; `reason` is its closed word when it named one. */
  | { status: 'refused'; reason?: string }
  /** The answer never came, or the platform could not take it now. */
  | { status: 'failed' }

export interface AgentHomeConnectionParticipantOptions {
  platform: PlacementConnectionPlatform
  auth: PlacementConnectionAuth
  owner: AgentHomeOwnerController
  holds: AgentHomeHolds
  store: ParticipantStore
  /** Current account-generation scope; raw scope stays only in the encrypted local key. */
  scope(): string | null
  me(): string | null
  catalog(agent: string, signal: AbortSignal): Promise<MatrixModelCatalog>
  /**
   * Whether this Mac already holds the agent (an enrollment and a Hermes home, or one it kept): its catalog is read from
   * what is there and nothing is created for it. A Mac only creates custody for an agent it is the home of, or is about
   * to become the home of.
   */
  custody(agent: string): boolean
  /** Make the target's enrollment and Hermes home exist; do not admit turns. */
  materialize(agent: string, signal: AbortSignal): Promise<void>
  /**
   * Keep this Mac's executor for the agent answerable while it holds the agent without running it (nothing renews it then:
   * a host does that for a running agent): rotate it ahead of its expiry, or enroll again once it lapsed. `force` rotates now
   * (the platform has refused a catalog because it sees no active executor). Starts no host, lease, listener or turn.
   * Throws when it could not.
   */
  keepExecutor?(agent: string, signal: AbortSignal, force: boolean): Promise<void>
  /** True only between turns, with Hermes's post-turn review settled. */
  atRest(agent: string): Promise<boolean>
  leaseFacts(agent: string): LeaseFacts | null
  apply(agent: string, route: MatrixModelRoute, effort: PlacementModelChoiceV25['effort'], signal: AbortSignal): Promise<ModelApplyResult>
  /** Let the app start a held agent again: the model hold was the last one set. */
  resume?(agent: string): void
  now?(): number
  uuid?(): string
  log?(line: string): void
}

interface CatalogJournal {
  v: 1
  deviceServiceId: string
  refs: Record<string, string>
  clientCatalogRevision: number
  catalogRevision: number
  contentSha256?: string
  binding?: string
  publishedAt?: number
  appliedTurnSequence: number
}

const CATALOG_KEY = 'agent-home-v24-connection-catalog-v1'
/** The set-up times kept beside each agent's catalog journal, so an app restart does not shorten their day. */
const PREPARED_KEY = 'agent-home-v24-prepared-v1'
/**
 * The platform clamps a catalog's freshness to five minutes and uses freshness only to admit a preflight, so a catalog
 * is refreshed a little before that (not every minute) and sooner only when its content or binding changed.
 */
const PUBLISH_EVERY_MS = 240_000
const FRESH_FOR_MS = MAC_CATALOG_FRESHNESS_MAX_MS
/** Two catalogs from one Mac are never sent closer than this: a Mac with many agents spreads them out. */
const MIN_PUBLISH_GAP_MS = 1_500
/** The saved choice is read this often once it is applied; and this often while turns are waiting for it. */
const APPLICATION_IDLE_MS = 60_000
const APPLICATION_HELD_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000

/**
 * A Mac the owner set up for an agent stays answerable this long without a move to it (the sheet's setup is good for the
 * rest of the day, no longer); a move to it keeps it answerable for as long as that move lives.
 */
const PREPARED_KEEP_MS = 24 * 3_600_000
/** The executor is looked at this often; it is only rotated within the platform's lead of its expiry. */
const KEEP_EVERY_MS = 60_000
/** After a rotation forced by a refusal, the next one waits this long: a refusal that persists is not rotated at every pass. */
const FORCED_KEEP_EVERY_MS = 5 * 60_000

/** A move whose target has not committed yet: only that target publishes the next epoch. */
const MOVE_PENDING: ReadonlySet<string> = new Set(['requested', 'draining', 'ready_to_commit'])

const PROVIDERS: Readonly<Record<string, { label: SanitizedMacConnectionV25['providerLabel']; ownKey: string }>> = {
  'openai-api': { label: 'OpenAI API', ownKey: 'openai' },
  anthropic: { label: 'Anthropic API', ownKey: 'anthropic' },
  gemini: { label: 'Google API', ownKey: 'google' },
  openrouter: { label: 'OpenRouter API', ownKey: 'openrouter' }
}

function safeOwnKey(provider: string, connection: MatrixModelConnection): string | null {
  if (connection === 'local') {return 'local'}
  const configured = PROVIDERS[provider]?.ownKey
  if (configured) {return configured}
  const normalized = provider.toLowerCase().replace(/[^a-z0-9_-]/gu, '-').replace(/^-+|-+$/gu, '')
  return normalized && normalized.length <= 70 ? normalized : null
}

function connectionIdentity(route: MatrixModelRoute): { source: SanitizedMacConnectionV25['source']; label: SanitizedMacConnectionV25['providerLabel'] } | null {
  if (route.provider === 'openai-codex' && route.connection === 'plan') {
    return { source: 'chatgpt_plan', label: 'ChatGPT' }
  }

  if (route.connection !== 'key' && route.connection !== 'local') {return null}
  const own = safeOwnKey(route.provider, route.connection)
  if (!own) {return null}
  return {
    source: `own_key:${own}`,
    label: route.connection === 'local' ? 'Local model' : (PROVIDERS[route.provider]?.label ?? 'Local model')
  }
}

/** A safe display label for the frozen model-label grammar. */
export function externalModelLabel(model: string): string {
  const gpt = /^gpt-([0-9]+(?:[.][0-9]+)*)(?:-|$)(.*)$/iu.exec(model)
  if (gpt) {
    const suffix = gpt[2]
      .split(/[-_/]+/u)
      .filter(Boolean)
      .map(word => (/^[a-z]+$/u.test(word) ? word[0]!.toUpperCase() + word.slice(1) : word))
      .join(' ')
    return `GPT-${gpt[1]}${suffix ? ` ${suffix}` : ''}`.slice(0, 120)
  }

  const prepared = model
  const words = prepared
    .split(/[-_/]+/u)
    .filter(Boolean)
    .map((word, index) => {
      if (/^gpt$/iu.test(word)) {return 'GPT'}
      if (index === 0 && /^[a-z]+$/u.test(word)) {return word[0]!.toUpperCase() + word.slice(1)}
      if (/^[a-z]+$/u.test(word)) {return word[0]!.toUpperCase() + word.slice(1)}
      return word
    })
    .join(' ')
  const label = words.replace(/[^A-Za-z0-9 ._+/-]/gu, '').trim()
  return (label || model.replace(/[^A-Za-z0-9 ._+/-]/gu, '').trim()).slice(0, 120)
}

function parseJournal(raw: string | null, deviceServiceId: string): CatalogJournal {
  try {
    const value = raw ? (JSON.parse(raw) as CatalogJournal) : null
    if (
      value?.v === 1 &&
      value.deviceServiceId === deviceServiceId &&
      value.refs &&
      typeof value.refs === 'object' &&
      Number.isSafeInteger(value.clientCatalogRevision) &&
      value.clientCatalogRevision >= 1 &&
      Number.isSafeInteger(value.catalogRevision) &&
      value.catalogRevision >= 1 &&
      Number.isSafeInteger(value.appliedTurnSequence) &&
      value.appliedTurnSequence >= 0
    ) {return value}
  } catch {
    // A lost local journal costs a fresh opaque reference/publication, never credentials.
  }

  return {
    v: 1,
    deviceServiceId,
    refs: {},
    clientCatalogRevision: 1,
    catalogRevision: 1,
    appliedTurnSequence: 0
  }
}

/** The set-up times a scope kept: agent → when the owner set this Mac up for it. A lost map only costs a fresh press. */
function parsePrepared(raw: string | null): Record<string, number> {
  try {
    const value = raw ? (JSON.parse(raw) as { v?: unknown; since?: unknown }) : null
    const since = value?.v === 1 && value.since && typeof value.since === 'object' ? (value.since as Record<string, unknown>) : null
    if (!since) {return {}}

    const kept: Record<string, number> = {}
    for (const [agent, at] of Object.entries(since)) {
      if (typeof at === 'number' && Number.isFinite(at) && at >= 0) {kept[agent] = at}
    }

    return kept
  } catch {
    return {}
  }
}

/** Which place a location (or a move's target) names, for telling a committed move from a cancelled one. */
function placeKey(location: HomePlacement['location']): string {
  return location.kind === 'mac' ? `mac:${location.deviceServiceId}` : 'cloud'
}

/**
 * The epoch and move a catalog is bound to (`atum.agent-home/2.5`): outside a move every Mac publishes the home's epoch
 * N with no move; during a move only the target publishes N+1 with that move's id, and every other Mac stays at N.
 */
export function catalogBinding(placement: HomePlacement, me: string): { homeEpoch: number; activeMoveId: string | null; key: string } {
  const move = placement.activeMove
  const target =
    move !== null &&
    MOVE_PENDING.has(move.status) &&
    move.target.kind === 'mac' &&
    move.target.deviceServiceId === me
  const homeEpoch = target ? placement.homeEpoch + 1 : placement.homeEpoch
  const activeMoveId = target ? move.moveId : null

  return { homeEpoch, activeMoveId, key: `${placement.homeId}:${homeEpoch}:${activeMoveId ?? ''}` }
}

export class AgentHomeConnectionParticipant {
  private readonly routes = new Map<string, Map<string, MatrixModelRoute>>()
  private readonly projections = new Map<string, ModelApplicationProjectionV25>()
  /** The saved choice (revisions and content) this Mac has applied to its own profile and read back, per agent. */
  private readonly appliedLocally = new Map<string, string>()
  /** The agents the owner set this Mac up for, and when: kept answerable (not forever) so the Mac stays a place to move to. */
  private readonly prepared = new Map<string, number>()
  /** The scope `prepared` was read for: a sign-in after a signed-out start (or another account) loads its own set-up times. */
  private preparedScope: string | null | undefined
  /** Where a move of the agent was going when it last went elsewhere, so a commit ends the day and a cancel resumes it. */
  private readonly movingElsewhere = new Map<string, string>()
  /** The binding of the last catalog the platform refused as `stale_home`, per agent: a second refusal of the same one is the executor. */
  private readonly staleBinding = new Map<string, string>()
  /** A set-up already running for an agent: a second press joins it. */
  private readonly preparing = new Map<string, Promise<PrepareResult>>()
  private readonly pacer: CallPacer
  private readonly ledger: RetryLedger
  private lastPublishAt = Number.NEGATIVE_INFINITY

  constructor(private readonly options: AgentHomeConnectionParticipantOptions) {
    this.pacer = new CallPacer({ now: options.now, maxMs: MAX_BACKOFF_MS })
    this.ledger = new RetryLedger({ now: options.now, uuid: options.uuid })
    this.loadPrepared()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private preparedKey(scope: string): string {
    return `${PREPARED_KEY}:${scope}`
  }

  /**
   * Read the set-up times kept for the current scope (again after a sign-in), dropping the ones whose day is over. The
   * scope is not known until the account is: a signed-out start keeps nothing and loads once it has one.
   */
  private loadPrepared(): void {
    const scope = this.options.scope()
    if (scope === this.preparedScope) {return}

    this.preparedScope = scope
    this.prepared.clear()
    this.movingElsewhere.clear()
    if (!scope) {return}

    const now = this.now()
    let pruned = false
    for (const [agent, since] of Object.entries(parsePrepared(this.options.store.getItem(this.preparedKey(scope))))) {
      if (now - since < PREPARED_KEEP_MS) {this.prepared.set(agent, since)}
      else {pruned = true}
    }

    if (pruned) {this.savePrepared()}
  }

  /** Keep the set-up times beside the journal; a store that cannot keep them costs the day after a restart, never a turn. */
  private savePrepared(): void {
    const scope = this.preparedScope
    if (!scope) {return}

    try {
      this.options.store.setItem(this.preparedKey(scope), JSON.stringify({ v: 1, since: Object.fromEntries(this.prepared) }))
    } catch {
      // This run still has them in memory; the owner can set the Mac up again after a restart.
    }
  }

  /** This Mac is no longer set up for the agent (its home is here, an app no longer holds it, or its day is over). */
  private dropPrepared(agent: string): void {
    this.loadPrepared()
    this.movingElsewhere.delete(agent)
    if (this.prepared.delete(agent)) {this.savePrepared()}
  }

  projection(agent: string): ModelApplicationProjectionV25 | undefined {
    return this.projections.get(agent)
  }

  /** Look at this agent's saved model again at the next pass (the owner has just acted on it). */
  wake(agent: string): void {
    this.pacer.wake(`publish:${agent}`)
    this.pacer.wake(`application:${agent}`)
  }

  /** The agent is gone from this Mac: nothing kept about it is looked at again. */
  forget(agent: string): void {
    this.pacer.forget(`publish:${agent}`)
    this.pacer.forget(`application:${agent}`)
    this.pacer.forget(`keep:${agent}`)
    this.routes.delete(agent)
    this.projections.delete(agent)
    this.appliedLocally.delete(agent)
    this.dropPrepared(agent)
    this.staleBinding.delete(agent)
  }

  private key(agent: string): string | null {
    const scope = this.options.scope()
    return scope ? `${CATALOG_KEY}:${scope}:${agent}` : null
  }

  private journal(agent: string, deviceServiceId: string): CatalogJournal {
    const key = this.key(agent)
    if (!key) {return parseJournal(null, deviceServiceId)}
    return parseJournal(this.options.store.getItem(key), deviceServiceId)
  }

  private save(agent: string, journal: CatalogJournal): void {
    const key = this.key(agent)
    if (!key) {throw new Error('catalog_scope_unavailable')}
    this.options.store.setItem(key, JSON.stringify(journal))
    if (this.options.store.failureCode()) {throw new Error('catalog_store_unavailable')}
  }

  private ref(journal: CatalogJournal, provider: string): string {
    const known = journal.refs[provider]
    if (known && /^conn_[A-Za-z0-9_-]{16,64}$/u.test(known)) {return known}
    const next = `conn_${randomBytes(24).toString('base64url')}`
    journal.refs[provider] = next
    return next
  }

  private sanitize(agent: string, catalog: MatrixModelCatalog, journal: CatalogJournal): SanitizedMacConnectionV25[] {
    const grouped = new Map<string, { connection: SanitizedMacConnectionV25; routes: Map<string, MatrixModelRoute> }>()

    for (const route of catalog.routes) {
      const identity = route.ready ? connectionIdentity(route) : null
      const efforts = route.efforts.filter((value, index, all) => all.indexOf(value) === index)
      if (!identity || efforts.length === 0) {continue}

      const key = `${route.provider}\0${route.accountLabel}`
      let group = grouped.get(key)
      if (!group) {
        group = {
          connection: {
            connectionRef: this.ref(journal, key),
            source: identity.source,
            providerLabel: identity.label,
            state: 'available',
            models: []
          },
          routes: new Map()
        }
        grouped.set(key, group)
      }

      const model: SanitizedMacModelV25 = {
        model: route.model,
        modelLabel: externalModelLabel(route.name || route.model),
        efforts,
        defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0]!
      }
      group.connection.models.push(model)
      group.routes.set(route.model, route)
    }

    const routes = new Map<string, MatrixModelRoute>()
    const connections = [...grouped.values()]
      .map(group => {
        group.connection.models.sort((left, right) => left.model.localeCompare(right.model))
        for (const [model, route] of group.routes) {routes.set(`${group.connection.connectionRef}\0${model}`, route)}
        return group.connection
      })
      .sort((left, right) => left.connectionRef.localeCompare(right.connectionRef))

    // Atum's managed model is a connection this Mac answers with too, but it is not a local route
    // the conversation picker may switch: applying it is a no-op (the profile already runs the
    // managed endpoint). Without it, a Mac with only Atum connected publishes an empty catalog
    // and the platform can never list it as a place to move to.
    const managed = catalog.managed ?? []

    if (managed.length > 0) {
      connections.unshift({
        connectionRef: ATUM_MANAGED_CONNECTION_REF,
        source: 'atum',
        providerLabel: 'Atum',
        state: 'available',
        models: managed.map(each => {
          const efforts = [...MATRIX_MODEL_EFFORTS[each]]

          return {
            model: each,
            modelLabel: matrixManagedModelLabel(each),
            efforts,
            defaultEffort: efforts.includes('medium') ? ('medium' as const) : efforts[0]!
          }
        })
      })
    }

    this.routes.set(agent, routes)
    return connections
  }

  /** What this Mac's connections look like now, as the sanitized catalog; new opaque references are kept at once. */
  private async localCatalog(agent: string, me: string, signal: AbortSignal) {
    const catalog = await this.options.catalog(agent, signal)
    const journal = this.journal(agent, me)
    const refs = JSON.stringify(journal.refs)
    const connections = this.sanitize(agent, catalog, journal)

    if (JSON.stringify(journal.refs) !== refs) {this.save(agent, journal)}

    return { journal, connections, contentSha256: macConnectionCatalogContentSha256(connections) }
  }

  async publish(agent: string, placement: HomePlacement, signal: AbortSignal, force = false): Promise<MacConnectionCatalogReceiptV25 | null> {
    const outcome = await this.send(agent, placement, signal, force)

    return outcome.status === 'sent' ? outcome.receipt : null
  }

  private async send(agent: string, placement: HomePlacement, signal: AbortSignal, force: boolean): Promise<PublishOutcome> {
    const me = this.options.me()
    if (!me) {return { status: 'failed' }}

    const now = this.now()
    const pace = `publish:${agent}`
    const bound = catalogBinding(placement, me)
    const known = this.journal(agent, me)
    const fresh = known.publishedAt !== undefined && now - known.publishedAt < PUBLISH_EVERY_MS

    if (!force) {
      // Nothing changed and the last catalog is fresh enough: nothing is read, built or sent.
      if (known.binding === bound.key && fresh) {return { status: 'skipped' }}
      if (!this.pacer.due(pace) || now - this.lastPublishAt < MIN_PUBLISH_GAP_MS) {return { status: 'skipped' }}
    }

    this.lastPublishAt = now

    let local: Awaited<ReturnType<AgentHomeConnectionParticipant['localCatalog']>>

    try {
      local = await this.localCatalog(agent, me, signal)
    } catch (error) {
      this.pacer.failed(pace)
      this.options.log?.(`[Home] ${agent.slice(0, 8)} connection catalog not read: ${error instanceof Error ? error.message : 'unknown'}`)

      return { status: 'unreadable' }
    }

    // A retry of this same publication (the answer never came) is the same operation: the same ids and, while its
    // signature is still valid, the same signed bytes. A changed binding or content is a new operation.
    const operation = RetryLedger.key('publish', agent, {
      homeId: placement.homeId,
      homeEpoch: bound.homeEpoch,
      activeMoveId: bound.activeMoveId,
      contentSha256: local.contentSha256
    })
    const identity = this.ledger.begin(operation, 3)
    let body = this.ledger.reusable(identity) as MacConnectionCatalogIngestV25 | undefined

    if (body && body.deviceServiceId !== me) {
      // This Mac re-enrolled since that attempt signed: the old device is retired and the platform
      // would refuse the frame. Sign a fresh one for the device this pass is running as.
      body = undefined
    }

    if (!body) {
      local.journal.clientCatalogRevision = Math.max(local.journal.clientCatalogRevision + 1, now)
      this.save(agent, local.journal)
      // The body's device is the one the frame is signed for, never an earlier read of it: an
      // enrollment that changes between `me` above and the signature below (a re-enrollment) would
      // otherwise produce `catalog_device_mismatch` on a body that was already cached for retry.
      body = MacConnectionCatalogIngestV25Schema.parse(
        await this.options.auth.signMac(
          'home.connection-catalog.ingest',
          meta => ({
            meta,
            publishId: identity.ids[1]!,
            idempotencyKey: identity.ids[2]!,
            deviceServiceId: meta.deviceServiceId,
            ownerUserId: placement.ownerUserId,
            agentPrincipal: agent,
            homeId: placement.homeId,
            homeEpoch: bound.homeEpoch,
            activeMoveId: bound.activeMoveId,
            clientCatalogRevision: local.journal.clientCatalogRevision,
            contentSha256: local.contentSha256,
            generatedAtPlatformEstimate: now,
            freshUntilPlatform: now + FRESH_FOR_MS,
            connections: local.connections
          }),
          { requestId: identity.ids[0]! }
        )
      ) as MacConnectionCatalogIngestV25
      this.ledger.sent(identity, body, body.meta.expiresAt)
    }

    const result = await this.options.platform.publishCatalog(agent, body, signal)

    if (outcomeIsDefinitive(result)) {this.ledger.settle(operation)}

    if (result.ok === false) {
      // A refusal because the placement moved while this was sent is looked at again at a later pass, which reads the
      // placement again and binds to what it says; one that keeps coming back waits longer each time.
      this.pacer.failed(pace, result.retryAfterMs)

      if (result.reason === 'stale_home') {this.staleBinding.set(agent, bound.key)}

      return result.kind === 'conflict' ? { status: 'refused', ...(result.reason ? { reason: result.reason } : {}) } : { status: 'failed' }
    }

    const receipt = result.value

    if (
      receipt.outcome === 'refused' ||
      receipt.publishId !== body.publishId ||
      receipt.deviceServiceId !== me ||
      receipt.contentSha256 !== local.contentSha256
    ) {
      this.pacer.failed(pace)

      if (receipt.outcome === 'refused' && receipt.reason === 'stale_home') {this.staleBinding.set(agent, bound.key)}

      return receipt.outcome === 'refused' ? { status: 'refused', ...(receipt.reason ? { reason: receipt.reason } : {}) } : { status: 'failed' }
    }

    const journal = this.journal(agent, me)
    journal.catalogRevision = receipt.catalogRevision
    journal.contentSha256 = local.contentSha256
    journal.binding = bound.key
    journal.publishedAt = now
    this.save(agent, journal)
    // Done for now: the journal says when the next refresh is due, and a changed binding is due at once.
    this.pacer.forget(pace)
    this.staleBinding.delete(agent)

    return { status: 'sent', receipt, connections: local.connections.length }
  }

  private unavailableReason(
    projection: ModelApplicationProjectionV25,
    connections: readonly SanitizedMacConnectionV25[]
  ): UnavailableReason | null {
    const connection = connections.find(each => each.connectionRef === projection.choice.connectionRef)
    if (!connection) {return 'connection_unavailable'}
    if (connection.state !== 'available') {return 'connection_needs_attention'}
    const model = connection.models.find(each => each.model === projection.choice.model)
    if (!model) {return 'model_unavailable'}
    if (!model.efforts.includes(projection.choice.effort)) {return 'effort_unavailable'}
    return null
  }

  private choiceKey(projection: ModelApplicationProjectionV25): string {
    return JSON.stringify([projection.choiceRevision, projection.catalogRevision, projection.choice])
  }

  /** Put the saved choice on this Mac's own profile and read it back; the agent is not asked to run for it. */
  private async applyLocally(
    agent: string,
    me: string,
    projection: ModelApplicationProjectionV25,
    signal: AbortSignal
  ): Promise<{ applied: true } | { applied: false; reason: UnavailableReason }> {
    const local = await this.localCatalog(agent, me, signal)
    const unavailable = this.unavailableReason(projection, local.connections)
    if (unavailable) {return { applied: false, reason: unavailable }}

    const route = this.routes.get(agent)?.get(`${projection.choice.connectionRef}\0${projection.choice.model}`)
    if (!route) {return { applied: false, reason: 'model_unavailable' }}

    const applied = await this.options.apply(agent, route, projection.choice.effort, signal).catch(() => ({
      status: 'unavailable' as const,
      reason: 'connection_unavailable' as const
    }))
    if (applied.status === 'unavailable') {return { applied: false, reason: applied.reason }}

    this.appliedLocally.set(agent, this.choiceKey(projection))

    return { applied: true }
  }

  /**
   * Before a move's target Mac starts answering: whether the saved home default is already this Mac's own. A fresh
   * profile answers on the platform's paid model, so an unreadable choice, or one that is not the platform's managed
   * model, is applied to the profile first. False keeps the agent held (the `model` hold is persisted); the pass
   * that follows applies the choice, reports it and lets the agent go.
   */
  async prepareActivation(agent: string, signal: AbortSignal): Promise<boolean> {
    const me = this.options.me()
    if (!me) {return false}

    const read = await this.options.platform.readModelApplication(agent, signal)

    // A platform that has no such route (the 2.1 move predates the saved home default) has nothing to wait for; any other
    // reason the choice cannot be read now keeps the agent held until it can.
    if (read.ok === false) {return read.kind === 'unsupported'}

    const projection = read.value
    this.projections.set(agent, projection)
    if (projection.deviceServiceId !== me) {return false}
    // Managed choices are advertised only when that provider is already current on this profile.
    if (projection.choice.source === 'atum') {return true}
    if (this.appliedLocally.get(agent) === this.choiceKey(projection)) {return true}
    const result = await this.applyLocally(agent, me, projection, signal)
    if (result.applied === true) {return true}
    this.recordUnavailable(agent, projection, result.reason)
    return false
  }

  private recordUnavailable(agent: string, projection: ModelApplicationProjectionV25, reason: UnavailableReason): void {
    this.projections.set(agent, { ...projection, status: 'unavailable', reason, turnDisposition: 'held', billingSourceChange: 'forbidden', appliedAtPlatform: null, appliedTurnSequence: null })
  }

  private liftModelHold(agent: string): void {
    if (!this.options.holds.reasons(agent).includes('model')) {return}

    this.options.holds.remove(agent, 'model')
    if (!this.options.holds.has(agent)) {this.options.resume?.(agent)}
  }

  private nextTurnSequence(agent: string, me: string): number {
    const journal = this.journal(agent, me)
    journal.appliedTurnSequence = Math.max(journal.appliedTurnSequence + 1, this.now())
    this.save(agent, journal)

    return journal.appliedTurnSequence
  }

  private async report(
    agent: string,
    placement: HomePlacement,
    projection: ModelApplicationProjectionV25,
    reported: { status: 'applied' } | { status: 'unavailable'; reason: UnavailableReason },
    signal: AbortSignal,
    me: string
  ): Promise<void> {
    const fence = fenceFromLease(placement, this.options.leaseFacts(agent))
    // Failure is observable even before an answering lease exists. The frozen wire contract requires a fence;
    // retain the local projection now and send the signed receipt on the next leased pass.
    if (reported.status === 'unavailable') {this.recordUnavailable(agent, projection, reported.reason)}
    if (!fence) {return}

    const operation = RetryLedger.key('application', agent, {
      choiceRevision: projection.choiceRevision,
      catalogRevision: projection.catalogRevision,
      homeId: projection.homeId,
      homeEpoch: projection.homeEpoch,
      activeMoveId: projection.activeMoveId,
      choice: projection.choice,
      status: reported.status,
      reason: reported.status === 'unavailable' ? reported.reason : null
    })
    const identity = this.ledger.begin(operation, 3)
    let body = this.ledger.reusable(identity) as HomeModelApplicationReportV25 | undefined

    if (!body) {
      body = (await this.options.auth.signMac(
        'home.model-choice.application',
        meta => ({
          meta,
          applicationId: identity.ids[1]!,
          idempotencyKey: identity.ids[2]!,
          fence,
          expectedHomeId: projection.homeId,
          expectedHomeEpoch: projection.homeEpoch,
          expectedActiveMoveId: projection.activeMoveId,
          choiceRevision: projection.choiceRevision,
          catalogRevision: projection.catalogRevision,
          storedChoice: projection.choice,
          // Only a report that is really being sent takes the next turn sequence.
          reportedStatus:
            reported.status === 'applied'
              ? { status: 'applied' as const, appliedAtPlatform: this.now(), appliedTurnSequence: this.nextTurnSequence(agent, me) }
              : reported
        }),
        { requestId: identity.ids[0]! }
      )) as unknown as HomeModelApplicationReportV25
      this.ledger.sent(identity, body, body.meta.expiresAt)
    }

    const answer = await this.options.platform.reportModelApplication(agent, body, signal)
    if (outcomeIsDefinitive(answer)) {this.ledger.settle(operation)}

    if (answer.ok === true) {
      this.projections.set(agent, answer.value)
      if (answer.value.status === 'applied') {
        this.appliedLocally.delete(agent)
        this.liftModelHold(agent)
        this.pacer.ok(`application:${agent}`, APPLICATION_IDLE_MS)
      }
    } else {
      this.pacer.failed(`application:${agent}`, answer.retryAfterMs)
    }
  }

  /** Apply the saved home default at a turn boundary and report it; turns wait meanwhile and never fall back to paid Atum. */
  private async applyModel(agent: string, placement: HomePlacement, me: string, signal: AbortSignal): Promise<void> {
    const pace = `application:${agent}`
    if (!this.pacer.due(pace)) {return}

    const read = await this.options.platform.readModelApplication(agent, signal)
    if (read.ok === false) {
      this.pacer.failed(pace, read.retryAfterMs)
      return
    }

    const projection = read.value
    this.projections.set(agent, projection)

    // An old applied receipt cannot override a local activation hold after auth/catalog changes.
    // Managed choices are offered only when that provider is already current.
    if ((projection.status === 'applied' && !this.options.holds.reasons(agent).includes('model')) || projection.choice.source === 'atum') {
      this.appliedLocally.delete(agent)
      this.liftModelHold(agent)
      this.pacer.ok(pace, APPLICATION_IDLE_MS)
      return
    }

    const choice = this.choiceKey(projection)

    if (this.appliedLocally.get(agent) !== choice) {
      // Binding says held in every pending/unavailable state. There is deliberately no Atum fallback.
      this.options.holds.add(agent, 'model')
      this.pacer.ok(pace, APPLICATION_HELD_MS)
      if (projection.activeMoveId !== null || !(await this.options.atRest(agent))) {return}

      const result = await this.applyLocally(agent, me, projection, signal)

      if (result.applied === false) {
        // Still held. A failing connection is asked again with a growing wait, not every few seconds.
        this.pacer.failed(pace)
        await this.report(agent, placement, projection, { status: 'unavailable', reason: result.reason }, signal, me)
        return
      }
    }

    // This Mac's own profile is on the saved choice, read back: nothing can answer on another model. The agent goes, and
    // the platform is told as soon as the agent holds the lease that fences the report (and no move is under way).
    this.liftModelHold(agent)
    this.pacer.ok(pace, APPLICATION_HELD_MS)
    if (projection.activeMoveId !== null) {return}

    await this.report(agent, placement, projection, { status: 'applied' }, signal, me)
  }

  /** Reconcile one agent after the base placement pass. */
  async reconcile(agent: string, placement: HomePlacement, signal: AbortSignal): Promise<void> {
    const me = this.options.me()
    if (!me) {return}

    const homeHere = placement.location.kind === 'mac' && placement.location.deviceServiceId === me
    const targetHere =
      placement.activeMove?.target.kind === 'mac' && placement.activeMove.target.deviceServiceId === me
    const custody = this.options.custody(agent)

    // Neither the home nor about to be: a saved model it was holding the agent for is no longer this Mac's concern, and
    // a Mac that holds nothing of the agent has nothing to publish either.
    if (!homeHere && !targetHere) {
      this.options.holds.remove(agent, 'model')

      if (!custody) {return}
    }

    // Custody is created only for an agent this Mac is (about to be) the home of, and only once. (A Mac the owner set up
    // for the agent has it already: `prepare`.)
    if ((homeHere || targetHere) && !custody) {
      await this.options.materialize(agent, signal)
    }

    // A Mac that holds the agent without running it stays answerable to the platform, which lists it as a place to move to
    // only while its executor for the agent is active; nothing else renews that executor until a host runs.
    if (homeHere) {
      this.dropPrepared(agent)
    } else if (this.keepsAnswerable(agent, placement, targetHere)) {
      await this.keepAnswerable(agent, placement, me, signal)
    }

    await this.publish(agent, placement, signal)
    await this.options.owner.follow(agent, placement.activeMove !== null, signal)

    if (!homeHere) {return}

    await this.applyModel(agent, placement, me, signal)
  }

  /**
   * Whether this Mac keeps its executor for the agent answerable though no host runs it: the target of a move (until it
   * commits or is cancelled), or a Mac the owner set up while no move goes elsewhere, for at most `PREPARED_KEEP_MS`.
   */
  private keepsAnswerable(agent: string, placement: HomePlacement, targetHere: boolean): boolean {
    // A sign-in after a signed-out start gives the account a scope: its set-up times load with it.
    this.loadPrepared()

    if (targetHere) {
      this.movingElsewhere.delete(agent)

      return true
    }

    const since = this.prepared.get(agent)
    if (since === undefined) {
      this.movingElsewhere.delete(agent)

      return false
    }

    // A move to another place is under way: this Mac stays quiet, but its day is not spent by it. A cancel resumes the
    // day; a commit ends it (below). Nothing else deletes the set-up time, so a cancelled move cannot lose it.
    if (placement.activeMove !== null) {
      this.movingElsewhere.set(agent, placeKey(placement.activeMove.target))

      return false
    }

    const movedTo = this.movingElsewhere.get(agent)
    this.movingElsewhere.delete(agent)

    // The move committed somewhere else: this Mac is no longer the place the owner set up, so the day is over.
    if (movedTo !== undefined && movedTo === placeKey(placement.location)) {
      this.dropPrepared(agent)

      return false
    }

    // The bound is up: let go (the executor lapses; the owner can set the Mac up again).
    if (this.now() - since >= PREPARED_KEEP_MS) {
      this.dropPrepared(agent)

      return false
    }

    return true
  }

  private async keepAnswerable(agent: string, placement: HomePlacement, me: string, signal: AbortSignal): Promise<void> {
    const pace = `keep:${agent}`
    if (!this.options.keepExecutor || !this.pacer.due(pace)) {return}

    // The platform refused this very catalog as `stale_home` and the placement has not changed since (the binding is the
    // same): the home did not move, so it sees no active executor for the agent here. Rotate it now, once.
    const force = this.staleBinding.get(agent) === catalogBinding(placement, me).key

    try {
      await this.options.keepExecutor(agent, signal, force)
      if (force) {this.staleBinding.delete(agent)}
      this.pacer.ok(pace, force ? FORCED_KEEP_EVERY_MS : KEEP_EVERY_MS)
    } catch (error) {
      this.pacer.failed(pace)
      this.options.log?.(`[Home] ${agent.slice(0, 8)} executor not kept answerable: ${error instanceof Error ? error.message : 'unknown'}`)
    }
  }

  /**
   * The owner's "Set this Mac up for <agent>", for an agent whose home is elsewhere: this Mac enrolls for it and creates its
   * bound Hermes home (no turn is admitted, no lease or host started: `materialize`), then publishes its catalog at once, so
   * the platform lists this Mac as a place the agent can move to on the desktop and on the phone. Nothing moves. The Mac
   * is then kept answerable (see `keepsAnswerable`). A second press while one runs joins it.
   */
  prepare(agent: string, placement: HomePlacement, signal: AbortSignal): Promise<PrepareResult> {
    const running = this.preparing.get(agent)
    if (running) {return running}

    const run = this.setUp(agent, placement, signal).finally(() => {
      if (this.preparing.get(agent) === run) {this.preparing.delete(agent)}
    })
    this.preparing.set(agent, run)

    return run
  }

  private async setUp(agent: string, placement: HomePlacement, signal: AbortSignal): Promise<PrepareResult> {
    const me = this.options.me()
    if (!me) {return { ok: false, reason: 'unavailable' }}

    const homeHere = placement.location.kind === 'mac' && placement.location.deviceServiceId === me
    const targetHere =
      placement.activeMove?.target.kind === 'mac' && placement.activeMove.target.deviceServiceId === me

    // Setting up for one move while another goes elsewhere would only be dropped again.
    if (placement.activeMove !== null && !targetHere) {return { ok: false, reason: 'another_move_in_progress' }}

    try {
      // Idempotent: it enrolls only when this Mac has no usable enrollment for the agent (never, or it lapsed).
      await this.options.materialize(agent, signal)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'unknown'
      this.options.log?.(`[Home] ${agent.slice(0, 8)} not set up on this Mac: ${code}`)

      return { ok: false, reason: code === 'matrix_agent_busy' ? 'setup_busy' : code === 'matrix_agent_unavailable' ? 'not_ready' : 'unavailable' }
    }

    if (!homeHere) {
      this.loadPrepared()
      this.prepared.set(agent, this.now())
      this.savePrepared()
    }
    this.pacer.forget(`keep:${agent}`)

    let outcome = await this.send(agent, placement, signal, true)

    // Just enrolled and still no active executor in the platform's eyes: rotate it once and say it again.
    if (outcome.status === 'refused' && outcome.reason === 'stale_home' && this.options.keepExecutor) {
      try {
        await this.options.keepExecutor(agent, signal, true)
        this.staleBinding.delete(agent)
      } catch {
        // The refusal below stays the answer.
      }

      outcome = await this.send(agent, placement, signal, true)
    }

    if (outcome.status === 'sent') {
      // A published catalog with no connection is honest but useless: the platform reports the Mac
      // as unreachable and the owner would see the same empty sheet after a "successful" set-up.
      return outcome.connections === 0
        ? { ok: false, reason: 'connect_model' }
        : { ok: true, connections: outcome.connections }
    }

    return { ok: false, reason: outcome.status === 'refused' && outcome.reason === 'stale_home' ? 'target_not_prepared' : 'unavailable' }
  }
}
