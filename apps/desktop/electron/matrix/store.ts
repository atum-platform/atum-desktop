import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {
  MatrixStoreIntent,
  MatrixStoreItem,
  MatrixStorePending,
  MatrixStoreResult,
  MatrixStoreSnapshot
} from '../../shared/matrix-store'
import { MATRIX_STORE_HIRE_SKILLS } from '../../shared/matrix-store-schedules'
import { DESKTOP_VERSION_HEADER, desktopVersionHeaderValue } from '../desktop-version-header'

import { readDomainJson } from './domain'
import {
  storeCatalog,
  storeEntitlement,
  storeIntent,
  storeList,
  storePurchase,
  storeResult,
  storeUuid
} from './store-contract'

export interface StoreScope {
  accountKey: string
  generation: number
}
/** A provisioned monthly-agent target that can be charged by a later, fresh purchase intent. */
interface ReusableHireTarget {
  offerId: string
  offerVersion: number
  assistantId: string
}
export interface StoreJournal {
  read(accountKey: string): MatrixStorePending[]
  /** Old journals do not implement this optional v2 recovery record. */
  readReusableHires?(accountKey: string): ReusableHireTarget[]
  write(accountKey: string, intents: MatrixStorePending[], reusableHires?: ReusableHireTarget[]): void
}
export class FileStoreJournal implements StoreJournal {
  constructor(private readonly root: string) {}
  private file(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) {
      throw new Error('matrix_store_invalid')
    }

    return path.join(this.root, key, 'store-intents.json')
  }
  private document(key: string): { intents: MatrixStorePending[]; reusableHires: ReusableHireTarget[] } {
    const file = this.file(key)

    if (!fs.existsSync(file)) {
      return { intents: [], reusableHires: [] }
    }

    const raw = fs.readFileSync(file, 'utf8')

    if (Buffer.byteLength(raw) > 64 * 1024) {
      throw new Error('matrix_store_journal_invalid')
    }

    const v = JSON.parse(raw) as { version?: unknown; intents?: unknown; reusableHires?: unknown }

    if (
      ![1, 2].includes(v.version as number) ||
      !Array.isArray(v.intents) ||
      v.intents.length > 32 ||
      (v.version === 1 && Object.keys(v).some(name => !['version', 'intents'].includes(name))) ||
      (v.version === 2 &&
        (Object.keys(v).some(name => !['version', 'intents', 'reusableHires'].includes(name)) ||
          !Array.isArray(v.reusableHires) ||
          v.reusableHires.length > 32))
    ) {
      throw new Error('matrix_store_journal_invalid')
    }

    const ids = new Set<string>()

    const intents = v.intents.map((value: MatrixStorePending) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(
          key =>
            ![
              'offerId',
              'offerVersion',
              'assistantId',
              'consentRenewal',
              'idempotencyKey',
              'purchaseId',
              'provision'
            ].includes(key)
        )
      ) {
        throw new Error('matrix_store_journal_invalid')
      }

      let intent: MatrixStoreIntent

      try {
        intent = storeIntent({
          offerId: value.offerId,
          offerVersion: value.offerVersion,
          ...(value.assistantId !== undefined ? { assistantId: value.assistantId } : {}),
          ...(value.consentRenewal !== undefined ? { consentRenewal: value.consentRenewal } : {})
        })
      } catch {
        throw new Error('matrix_store_journal_invalid')
      }

      if (
        !storeUuid(value.idempotencyKey) ||
        !(value.purchaseId === null || storeUuid(value.purchaseId)) ||
        ids.has(value.idempotencyKey)
      ) {
        throw new Error('matrix_store_journal_invalid')
      }

      ids.add(value.idempotencyKey)
      let provision: MatrixStorePending['provision']

      if (value.provision !== undefined) {
        const candidate = value.provision

        if (
          !candidate ||
          typeof candidate !== 'object' ||
          Array.isArray(candidate) ||
          Object.keys(candidate).length !== 2 ||
          !storeUuid(candidate.requestId) ||
          candidate.requestId !== value.idempotencyKey ||
          typeof candidate.name !== 'string' ||
          !candidate.name.trim() ||
          Array.from(candidate.name).length > 40
        ) {
          throw new Error('matrix_store_journal_invalid')
        }

        if (!intent.consentRenewal) {
          throw new Error('matrix_store_journal_invalid')
        }

        provision = { requestId: candidate.requestId, name: candidate.name }
      }

      return {
        ...intent,
        idempotencyKey: value.idempotencyKey,
        purchaseId: value.purchaseId,
        ...(provision ? { provision } : {})
      }
    })

    const rawReusableHires = v.version === 2 ? v.reusableHires : []

    if (!Array.isArray(rawReusableHires)) {
      throw new Error('matrix_store_journal_invalid')
    }

    const reusableHires = rawReusableHires.map(value => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(name => !['offerId', 'offerVersion', 'assistantId'].includes(name))
      ) {
        throw new Error('matrix_store_journal_invalid')
      }

      let target: MatrixStoreIntent

      try {
        target = storeIntent({ ...value, consentRenewal: true })
      } catch {
        throw new Error('matrix_store_journal_invalid')
      }

      if (!target.assistantId || !target.consentRenewal) {
        throw new Error('matrix_store_journal_invalid')
      }

      return { offerId: target.offerId, offerVersion: target.offerVersion, assistantId: target.assistantId }
    })

    const hireIds = new Set<string>()

    if (
      reusableHires.some(target => {
        const id = `${target.offerId}:${target.offerVersion}:${target.assistantId}`

        if (hireIds.has(id)) {
          return true
        }

        hireIds.add(id)

        return false
      })
    ) {
      throw new Error('matrix_store_journal_invalid')
    }

    return { intents, reusableHires }
  }
  read(key: string): MatrixStorePending[] {
    return this.document(key).intents
  }
  readReusableHires(key: string): ReusableHireTarget[] {
    return this.document(key).reusableHires
  }
  write(key: string, intents: MatrixStorePending[], reusableHires: ReusableHireTarget[] = []): void {
    if (intents.length > 32 || reusableHires.length > 32) {
      throw new Error('matrix_store_journal_invalid')
    }

    // Validate before replacing a recoverable journal. The v2 record deliberately
    // contains only the already-created assistant ID and immutable offer target.
    const document = {
      version: reusableHires.length ? 2 : 1,
      intents,
      ...(reusableHires.length ? { reusableHires } : {})
    }

    const serialized = JSON.stringify(document)

    if (Buffer.byteLength(serialized) > 64 * 1024) {
      throw new Error('matrix_store_journal_invalid')
    }

    const file = this.file(key)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    let fd: number | undefined

    try {
      fd = fs.openSync(temp, 'wx', 0o600)
      fs.writeFileSync(fd, serialized)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      fs.renameSync(temp, file)
      const directory = fs.openSync(path.dirname(file), 'r')

      try {
        fs.fsyncSync(directory)
      } finally {
        fs.closeSync(directory)
      }
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd)
      }

      fs.rmSync(temp, { force: true })
    }
  }
}

export type StoreResource =
  | 'catalog'
  | 'entitlements'
  | 'purchases'
  | 'tasks'
  | 'topups'
  | `purchases/${string}`
  | `topups/${string}`
  | `entitlements/${string}/cancel`

/** A Store response that proved this request did not reach a money-moving outcome. */
export class MatrixStoreResponseError extends Error {
  constructor(readonly status: number) {
    super(`matrix_store_${status}`)
  }
}

/**
 * Whether an HTTP status proves the Store turned the request away before anything moved:
 * every 4xx except 401 (the account renews its sign-in and sends once more; see
 * `account.storeRequest`) and 408 (a timeout, kept uncertain like any other). A 5xx, a
 * non-JSON reply or a lost connection stays uncertain: the request may have arrived.
 */
export function definiteStoreRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 408
}

type MatrixStoreRefusalCode = Extract<MatrixStoreResult, { outcome: 'refused' }>['code']

/** A definite HTTP refusal as the closed refusal code the Store sheet and main.log use. */
export function refusalForStatus(status: number): MatrixStoreRefusalCode {
  return status === 403
    ? 'forbidden'
    : status === 404 || status === 410
      ? 'offer_unavailable'
      : status === 409
        ? 'feature_unavailable'
        : status === 429
          ? 'rate_limited'
          : 'invalid_request'
}

/**
 * `desktopVersion` is this app's version (main passes `app.getVersion()`), sent on every Store
 * request so the Shell can refuse to sell what this desktop cannot deliver. Without one the
 * header is left out and the Shell answers as it would an older desktop.
 */
export async function requestMatrixStore(
  resource: string,
  token: string,
  endpoint: StoreResource,
  signal: AbortSignal,
  input?: unknown,
  desktopVersion?: string
): Promise<unknown> {
  if (
    !['catalog', 'entitlements', 'purchases', 'tasks', 'topups'].includes(endpoint) &&
    !/^purchases\/[a-f0-9-]{36}$/i.test(endpoint) &&
    !/^topups\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(endpoint) &&
    !/^entitlements\/[a-f0-9-]{36}\/cancel$/i.test(endpoint)
  ) {
    throw new Error('matrix_store_invalid')
  }

  const key = input && typeof input === 'object' && 'idempotencyKey' in input ? input.idempotencyKey : undefined
  const version = desktopVersionHeaderValue(desktopVersion)

  const response = await fetch(`${resource}/store/${endpoint}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      // Understanding plus this desktop's existing Mac delivery, never Cloud admission. Free
      // official Hub skills are handed to the Skills Hub (store-contract.ts `storeCatalog`).
      'Atum-Store-Capabilities': 'agents.schedules.1,skills.hub.1,skills.prefix.1,store.ownership.1',
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(typeof key === 'string' ? { 'Idempotency-Key': key } : {}),
      ...(version ? { [DESKTOP_VERSION_HEADER]: version } : {})
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    redirect: 'error',
    signal
  })

  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()

    if (response.status === 401) {
      throw new Error('matrix_store_authentication')
    }

    if (definiteStoreRefusal(response.status)) {
      throw new MatrixStoreResponseError(response.status)
    }

    throw new Error('matrix_store_unavailable')
  }

  const value = await readDomainJson(response, 1024 * 1024)
  signal.throwIfAborted()

  return value
}

const empty = (): MatrixStoreSnapshot => ({ state: 'loading', items: [], entitlements: [], purchases: [], pending: [] })

/** Why a Store read failed, as a closed code for main.log. Never a URL, body or token. */
export type MatrixStoreReadFailure =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rejected'
  | 'invalid'
  | 'timeout'
  | 'unavailable'
  | 'other'

export function matrixStoreReadFailure(error: unknown): MatrixStoreReadFailure {
  if (error instanceof MatrixStoreResponseError) {
    return error.status === 403
      ? 'forbidden'
      : error.status === 404 || error.status === 410
        ? 'not_found'
        : error.status === 409
          ? 'conflict'
          : 'rejected'
  }

  if (!(error instanceof Error)) {
    return 'other'
  }

  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return 'timeout'
  }

  return error.message === 'matrix_store_authentication'
    ? 'auth'
    : error.message === 'matrix_store_invalid'
      ? 'invalid'
      : error.message === 'matrix_store_unavailable'
        ? 'unavailable'
        : 'other'
}

/**
 * One main.log line per Store read outcome: what the catalog holds per kind, and how many of
 * them are on sale. It is what decides whether the Assistants shelf shows hires, "coming soon"
 * or the outage notice. Counts only: no titles, prices or account detail.
 */
export function matrixStoreReadLine(
  read:
    | { outcome: 'ready'; items: MatrixStoreItem[] }
    | { outcome: 'failed'; state: MatrixStoreSnapshot['state']; reason: MatrixStoreReadFailure }
    | { outcome: 'journal_invalid' }
): string {
  if (read.outcome === 'failed') {
    return `[Matrix] store read outcome=failed state=${read.state} reason=${read.reason}`
  }

  if (read.outcome === 'journal_invalid') {
    return '[Matrix] store read outcome=journal_invalid state=unavailable'
  }

  const kinds = (['agent', 'skill', 'pet'] as const).map(kind => {
    const rows = read.items.filter(item => item.kind === kind)

    return `${kind}s=${rows.length} ${kind}s_offered=${rows.filter(item => item.offer).length}`
  })

  return `[Matrix] store read outcome=ready ${kinds.join(' ')}`
}

/** What a purchase attempt ended as, in closed words for main.log. */
export type MatrixStorePurchaseLog =
  | { outcome: 'ok'; code: 'completed' | 'granted' | 'delivery_pending' | 'already_owned' }
  | { outcome: 'refused'; code: MatrixStoreRefusalCode | 'offer_changed' | 'reversed' }
  | { outcome: 'uncertain'; code: MatrixStoreUncertainty }

/**
 * Why an attempt could not be confirmed either way. Each of these can still complete;
 * `status_refused` is a status read of a purchase the Store already created.
 */
export type MatrixStoreUncertainty =
  | 'timeout'
  | 'unavailable'
  | 'invalid_response'
  | 'network'
  | 'status_refused'
  | 'cancelled'
  | 'other'

export function matrixStoreUncertainty(error: unknown): MatrixStoreUncertainty {
  if (error instanceof MatrixStoreResponseError) {
    return 'status_refused'
  }

  if (!(error instanceof Error)) {
    return 'other'
  }

  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return 'timeout'
  }

  // undici reports a refused or dropped connection as TypeError("fetch failed").
  if (error.name === 'TypeError' && error.message === 'fetch failed') {
    return 'network'
  }

  return error.message === 'matrix_store_unavailable'
    ? 'unavailable'
    : error.message === 'matrix_store_invalid'
      ? 'invalid_response'
      : error.message === 'matrix_store_cancelled'
        ? 'cancelled'
        : 'other'
}

export function matrixStorePurchaseLog(
  result: MatrixStoreResult | { outcome: 'uncertain' },
  error?: unknown
): MatrixStorePurchaseLog {
  if (result.outcome === 'uncertain') {
    return { outcome: 'uncertain', code: matrixStoreUncertainty(error) }
  }

  if (result.outcome === 'refused') {
    return { outcome: 'refused', code: result.code }
  }

  if (result.outcome === 'offer_changed') {
    return { outcome: 'refused', code: 'offer_changed' }
  }

  if (result.outcome === 'already_owned') {
    return { outcome: 'ok', code: 'already_owned' }
  }

  const state = result.purchase.state

  return state === 'reversed' ? { outcome: 'refused', code: 'reversed' } : { outcome: 'ok', code: state }
}

/**
 * One main.log line per purchase attempt (a new purchase, or a pending one checked again):
 * the item's kind, whether it went through, and a closed code. Never an item name, price,
 * offer, purchase, assistant or request identifier. `unknown` is a journaled purchase
 * resumed before the catalog that sells it has loaded.
 */
export function matrixStorePurchaseLine(
  kind: MatrixStoreItem['kind'] | 'unknown',
  result: MatrixStorePurchaseLog
): string {
  return `[Matrix] store purchase kind=${kind} outcome=${result.outcome} code=${result.code}`
}

/**
 * What the person's synced agent list says of a reusable hire target's assistant: true while it
 * lists the assistant active, false once it lists it retired (the platform's tombstone), and
 * undefined with no list, or for an assistant not on it (a hire created since the last read).
 */
export function matrixHireTargetLive(
  roster: readonly { id: string; status: 'active' | 'retired' }[] | undefined,
  assistantId: string
): boolean | undefined {
  const record = roster?.find(each => each.id === assistantId)

  return record ? record.status === 'active' : undefined
}

/**
 * matrixHireTargetLive against the roster main last read, only while that read was for the
 * signed-in account and its current generation: another account's (or an older sign-in's)
 * list says nothing of this one's agents, so it reads as unknown.
 */
export function matrixScopedHireTargetLive(
  read:
    | {
        scope: { accountKey: string; generation: number }
        roster: readonly { id: string; status: 'active' | 'retired' }[]
      }
    | undefined,
  scope: { accountKey: string; generation: number } | null | undefined,
  assistantId: string
): boolean | undefined {
  return read && scope && read.scope.accountKey === scope.accountKey && read.scope.generation === scope.generation
    ? matrixHireTargetLive(read.roster, assistantId)
    : undefined
}

/** A key is saved before dispatch and retained whenever the outcome is uncertain. */
export class MatrixStoreController {
  private owner: StoreScope | null = null
  private state = empty()
  private abort = new AbortController()
  private reads?: Promise<void>
  private writes = new Map<string, Promise<MatrixStoreResult | { outcome: 'uncertain' }>>()
  private journalInvalid = false
  private reusableHires: ReusableHireTarget[] = []
  /** Assistants retired on this Mac this session, before the agent list says so. */
  private retired = new Set<string>()
  constructor(
    private readonly options: {
      journal: StoreJournal
      request(endpoint: StoreResource, signal: AbortSignal, input?: unknown): Promise<unknown>
      /** Creating a hired agent is idempotent on this request ID; no agent data reaches the renderer. */
      createAgent?(input: { requestId: string; displayName: string }, signal: AbortSignal): Promise<{ id: string }>
      /** Whether a hire whose assistant needs optional skills (MATRIX_STORE_HIRE_SKILLS) can
       * have them installed on this Mac. Asked before a new purchase of one: false (or a
       * failed check) refuses it before anything is charged. */
      hireReady?(itemId: string): Promise<boolean>
      /** What the person's synced agent list says of a reusable hire target's assistant
       * (matrixHireTargetLive): true alive, false retired, undefined while unknown (no list
       * synced yet). Only a false ever drops a target on its own. */
      hireTargetLive?(assistantId: string): boolean | undefined
      /** A reused hire target was turned away (403/404/410): the agent list may be stale (the
       * assistant retired on another Mac). Main reads it again, and its tombstone then prunes
       * the target (pruneHireTargets) instead of the next quarter-hour refresh. */
      rosterStale?(): void
      changed(): void
      walletChanged(): void
      /** main.log. A read writes only a changed outcome, so a Store left open does not repeat
       * it; every purchase attempt writes its own line. */
      log?(line: string): void
    }
  ) {}
  private lastRefreshAt = -Infinity
  private lastLog: string | null = null
  private log(line: string): void {
    if (line === this.lastLog) {
      return
    }

    this.lastLog = line
    this.options.log?.(line)
  }
  activate(owner: StoreScope | null): void {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) {
      return
    }

    this.abort.abort()
    this.abort = new AbortController()
    this.owner = owner
    this.state = empty()
    this.reads = undefined
    this.writes = new Map()
    this.journalInvalid = false
    this.reusableHires = []
    this.retired = new Set()
    this.lastLog = null
    this.lastRefreshAt = -Infinity

    if (owner) {
      try {
        this.state.pending = this.options.journal.read(owner.accountKey)
        this.reusableHires = this.options.journal.readReusableHires?.(owner.accountKey) ?? []
      } catch {
        this.journalInvalid = true
        this.state.state = 'unavailable'
        this.log(matrixStoreReadLine({ outcome: 'journal_invalid' }))
      }

      void this.refresh()
    }
  }
  snapshot(): MatrixStoreSnapshot | undefined {
    return this.owner ? this.state : undefined
  }
  private live(owner: StoreScope): void {
    if (this.owner !== owner || this.abort.signal.aborted) {
      throw new Error('matrix_store_cancelled')
    }
  }
  refresh(ifStale = false): Promise<void> {
    if (!this.owner || this.journalInvalid) {
      return Promise.resolve()
    }

    if (this.reads) {
      return this.reads
    }

    if (ifStale && Date.now() - this.lastRefreshAt < 15 * 60_000) {
      return Promise.resolve()
    }

    this.lastRefreshAt = Date.now()
    const owner = this.owner
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)])

    const pending = Promise.all(
      ['catalog', 'entitlements', 'purchases'].map(endpoint => this.options.request(endpoint as StoreResource, signal))
    )
      .then(([catalog, entitlements, purchases]) => {
        const items = storeCatalog(catalog)
        const owned = storeList(entitlements, 'entitlements', storeEntitlement)
        const orders = storeList(purchases, 'purchases', storePurchase)
        this.live(owner)
        this.state = { ...this.state, state: 'ready', items, entitlements: owned, purchases: orders }
        this.log(matrixStoreReadLine({ outcome: 'ready', items }))
        this.options.changed()
      })
      .catch((error: unknown) => {
        if (this.owner !== owner) {
          return
        }

        this.state = {
          ...this.state,
          state: this.state.state === 'ready' || this.state.state === 'stale' ? 'stale' : 'unavailable'
        }
        this.log(
          matrixStoreReadLine({ outcome: 'failed', state: this.state.state, reason: matrixStoreReadFailure(error) })
        )
        this.options.changed()
      })
      .finally(() => {
        if (this.owner === owner) {
          this.reads = undefined
        }
      })

    this.reads = pending

    return pending
  }
  /** Writes the idempotency key before any network dispatch. Callers that need
   * their own durable workflow (hatch publishing) can persist this key first. */
  preparePurchase(value: unknown): string {
    const input = storeIntent(value)

    if (!this.owner || this.journalInvalid) {
      throw new Error('matrix_store_unavailable')
    }

    const item = this.state.items.find(item => item.offer?.id === input.offerId)
    const newHire = item?.kind === 'agent' && item.offer?.billingInterval === 'month' && !input.assistantId

    // A retired assistant is never charged as a new hire: the hire provisions a fresh one.
    if (newHire) {
      this.pruneHireTargets()
    }

    let intent = this.state.pending.find(
      p =>
        p.offerId === input.offerId &&
        (newHire
          ? Boolean(
              p.provision || this.reusableHires.some(t => t.offerId === p.offerId && t.assistantId === p.assistantId)
            )
          : p.assistantId === input.assistantId)
    )

    if (intent && intent.offerVersion !== input.offerVersion) {
      throw new Error('matrix_store_pending')
    }

    if (!intent) {
      if (!item?.offer || item.offer.version !== input.offerVersion) {
        throw new Error('matrix_store_invalid')
      }

      if (newHire) {
        if (!input.consentRenewal || item.offer.renewalPriceMicroProtons === undefined) {
          throw new Error('matrix_store_invalid')
        }
      } else if ((item.offer.scope === 'agent') !== Boolean(input.assistantId)) {
        throw new Error('matrix_store_invalid')
      }

      if (this.state.pending.length >= 32) {
        throw new Error('matrix_store_pending')
      }

      const idempotencyKey = randomUUID()
      const title = item.title.vi?.trim()

      if (newHire && (!title || Array.from(title).length > 40)) {
        throw new Error('matrix_store_invalid')
      }

      const reusable = newHire ? this.reusableHires.find(target => target.offerId === input.offerId) : undefined

      intent = {
        ...input,
        idempotencyKey,
        purchaseId: null,
        ...(reusable
          ? { assistantId: reusable.assistantId }
          : newHire
            ? { provision: { requestId: idempotencyKey, name: title! } }
            : {})
      }
      this.save([...this.state.pending, intent])
    }

    return intent.idempotencyKey
  }
  async purchase(value: unknown): Promise<MatrixStoreResult | { outcome: 'uncertain' }> {
    const check = this.hireCheck(value)

    // Without a check the key is journaled now, synchronously, as before.
    if (check) {
      const owner = this.owner

      if (!(await check)) {
        const refused = { outcome: 'refused', code: 'feature_unavailable' } as const
        this.options.log?.(matrixStorePurchaseLine('agent', matrixStorePurchaseLog(refused)))

        return refused
      }

      if (this.owner !== owner) {
        throw new Error('matrix_store_cancelled')
      }
    }

    return this.resume(this.preparePurchase(value))
  }
  /**
   * A new hire of an assistant that needs optional skills is sold only where they can be
   * installed: a buyer is never charged for an assistant missing them. Nothing is checked
   * for a purchase already journaled (it may be charged, so it is always resumed).
   */
  private hireCheck(value: unknown): Promise<boolean> | undefined {
    let input: MatrixStoreIntent

    try {
      input = storeIntent(value)
    } catch {
      return undefined
    }

    const item = this.state.items.find(item => item.offer?.id === input.offerId)

    if (
      !this.options.hireReady ||
      item?.kind !== 'agent' ||
      !MATRIX_STORE_HIRE_SKILLS[item.itemId]?.length ||
      this.state.pending.some(pending => pending.offerId === input.offerId)
    ) {
      return undefined
    }

    return this.options.hireReady(item.itemId).catch(() => false)
  }
  resume(key: string): Promise<MatrixStoreResult | { outcome: 'uncertain' }> {
    if (!storeUuid(key) || !this.owner || this.journalInvalid) {
      throw new Error('matrix_store_unavailable')
    }

    let intent = this.state.pending.find(p => p.idempotencyKey === key)

    if (!intent) {
      throw new Error('matrix_store_invalid')
    }

    const existing = this.writes.get(key)

    if (existing) {
      return existing
    }

    const owner = this.owner
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(25_000)])
    const kind = this.state.items.find(item => item.offer?.id === intent!.offerId)?.kind ?? 'unknown'

    // Every attempt is logged, even one identical to the last (unlike the deduplicated reads).
    const logAttempt = (result: MatrixStoreResult | { outcome: 'uncertain' }, error?: unknown) =>
      this.options.log?.(matrixStorePurchaseLine(kind, matrixStorePurchaseLog(result, error)))

    // Which request went out: the purchase itself, or a status read of one the Store already
    // created (and so may already have charged). Nothing yet while the hire is provisioned.
    let sent: 'purchase' | 'status' | null = null

    const promise = (async () => {
      if (intent!.provision && !intent!.assistantId) {
        if (!this.options.createAgent) {
          throw new Error('matrix_store_unavailable')
        }

        const created = await this.options.createAgent(
          {
            requestId: intent!.provision.requestId,
            displayName: intent!.provision.name
          },
          signal
        )

        this.live(owner)

        if (!storeUuid(created.id)) {
          throw new Error('matrix_store_invalid')
        }

        intent = { ...intent!, assistantId: created.id }
        this.save(this.state.pending.map(pending => (pending.idempotencyKey === key ? intent! : pending)))
      }

      const input = {
        offerId: intent!.offerId,
        offerVersion: intent!.offerVersion,
        idempotencyKey: key,
        ...(intent!.assistantId ? { assistantId: intent!.assistantId } : {}),
        ...(intent!.consentRenewal ? { consentRenewal: true as const } : {})
      }

      sent = intent!.purchaseId ? 'status' : 'purchase'

      return this.options.request(
        intent!.purchaseId ? `purchases/${intent!.purchaseId}` : 'purchases',
        signal,
        intent!.purchaseId ? undefined : input
      )
    })()
      .then(value => {
        const result = storeResult(value)

        if (result.outcome === 'already_owned' && result.entitlement.assistantId !== (intent!.assistantId ?? null)) {
          throw new Error('matrix_store_invalid')
        }

        if (result.outcome === 'offer_changed' && result.offer.id !== intent!.offerId) {
          throw new Error('matrix_store_invalid')
        }

        if (
          result.outcome === 'purchased' &&
          (result.purchase.offerId !== intent!.offerId ||
            result.purchase.offerVersion !== intent!.offerVersion ||
            result.purchase.idempotencyKey !== key ||
            result.purchase.assistantId !== (intent!.assistantId ?? null))
        ) {
          throw new Error('matrix_store_invalid')
        }

        this.live(owner)

        if (result.outcome === 'purchased' && !['completed', 'reversed'].includes(result.purchase.state)) {
          this.save(
            this.state.pending.map(p => (p.idempotencyKey === key ? { ...p, purchaseId: result.purchase.id } : p))
          )
        } else {
          this.rememberReusableHire(
            intent!,
            result.outcome === 'refused' ||
              result.outcome === 'offer_changed' ||
              (result.outcome === 'purchased' && result.purchase.state === 'reversed')
          )
          this.save(this.state.pending.filter(p => p.idempotencyKey !== key))
        }

        this.options.walletChanged()
        void this.refresh()
        logAttempt(result)

        return result
      })
      .catch(error => {
        const definite = error instanceof MatrixStoreResponseError

        // A 4xx to the purchase request, or a 401 the account's renewed sign-in got again,
        // proves the Store turned it away: nothing was charged, so the key is not kept.
        const refusal =
          sent !== 'purchase'
            ? null
            : definite
              ? refusalForStatus(error.status)
              : error instanceof Error && error.message === 'matrix_store_authentication'
                ? ('unauthenticated' as const)
                : null

        // A status read refused with 403/404/409 still drops the row, as it always has, but
        // the purchase it asked about exists: that says nothing about a charge either way.
        const dropped = Boolean(refusal) || (sent === 'status' && definite && [403, 404, 409].includes(error.status))
        const result = refusal ? { outcome: 'refused' as const, code: refusal } : { outcome: 'uncertain' as const }
        logAttempt(result, error)
        this.live(owner)

        // A reused target turned away (403/404/410) may be an assistant retired since it was
        // kept, here or on another Mac: the agent list is read again, and its tombstone prunes
        // the target. Not found (404/410) lets it go now unless the list says it is alive. A
        // 403 also answers an account that may not spend (0130 `denied`), so it never drops a
        // target on its own (each click would make another agent); a known retirement is
        // dropped by rememberReusableHire, whatever the refusal.
        const doubted =
          sent === 'purchase' &&
          definite &&
          [403, 404, 410].includes(error.status) &&
          Boolean(intent!.assistantId) &&
          !intent!.provision

        const gone = doubted && error.status !== 403 && this.hireTargetLive(intent!.assistantId!) !== true

        if (dropped) {
          this.rememberReusableHire(intent!, !gone)
          this.save(this.state.pending.filter(pending => pending.idempotencyKey !== key))
          void this.refresh()
        }

        if (doubted) {
          this.options.rosterStale?.()
        }

        return result
      })
      .finally(() => {
        if (this.owner === owner) {
          this.writes.delete(key)
        }
      })

    this.writes.set(key, promise)

    return promise
  }
  /** Replays an already-durable idempotency key after the SDK has compacted a
   * terminal journal row. It never generates a key or changes immutable terms. */
  resumePrepared(key: string, value: unknown): Promise<MatrixStoreResult | { outcome: 'uncertain' }> {
    const input = storeIntent(value)
    if (!storeUuid(key) || !this.owner || this.journalInvalid) {
      throw new Error('matrix_store_unavailable')
    }
    const pending = this.state.pending.find(item => item.idempotencyKey === key)
    if (pending) {
      if (
        pending.offerId !== input.offerId ||
        pending.offerVersion !== input.offerVersion ||
        pending.assistantId !== input.assistantId
      ) {
        throw new Error('matrix_store_invalid')
      }
      return this.resume(key)
    }
    if (this.state.pending.length >= 32) {
      throw new Error('matrix_store_invalid')
    }
    this.save([...this.state.pending, { ...input, idempotencyKey: key, purchaseId: null }])
    return this.resume(key)
  }
  private save(pending: MatrixStorePending[]): void {
    this.options.journal.write(this.owner!.accountKey, pending, this.reusableHires)
    this.state = { ...this.state, pending }
    this.options.changed()
  }
  /** Keep the created agent only when this request has a definite terminal outcome. */
  private rememberReusableHire(intent: MatrixStorePending, retain: boolean): void {
    if (!intent.assistantId) {
      return
    }

    const reusable = this.reusableHires.some(
      target => target.offerId === intent.offerId && target.assistantId === intent.assistantId
    )
    this.reusableHires = this.reusableHires.filter(
      target => target.offerId !== intent.offerId || target.assistantId !== intent.assistantId
    )

    if (retain && (intent.provision || reusable) && this.hireTargetLive(intent.assistantId) !== false) {
      this.reusableHires.push({
        offerId: intent.offerId,
        offerVersion: intent.offerVersion,
        assistantId: intent.assistantId
      })
    }
  }
  private hireTargetLive(assistantId: string): boolean | undefined {
    return this.retired.has(assistantId) ? false : this.options.hireTargetLive?.(assistantId)
  }
  /**
   * Drops the reusable hire targets whose assistant is known retired, so the next hire of that
   * offer provisions a fresh agent. Unknown keeps a target (a live half-created agent is still
   * reused), and so does a pending purchase naming it: that one is resolved first.
   */
  pruneHireTargets(): void {
    if (!this.owner || this.journalInvalid) {
      return
    }

    const kept = this.reusableHires.filter(
      target =>
        this.hireTargetLive(target.assistantId) !== false ||
        this.state.pending.some(
          pending => pending.offerId === target.offerId && pending.assistantId === target.assistantId
        )
    )

    if (kept.length !== this.reusableHires.length) {
      this.reusableHires = kept

      // Called from roster sync and retirement: a journal write failure must not fail those.
      // The pruned list stays in memory and goes out with the next journal write.
      try {
        this.save(this.state.pending)
      } catch {
        this.options.log?.('[Matrix] store hire targets outcome=unsaved')
      }
    }
  }
  /** An agent retired on this Mac is never charged as a hire again, even before the agent
   * list shows its tombstone. */
  forgetHireTarget(assistantId: string): void {
    this.retired.add(assistantId)
    this.pruneHireTargets()
  }
  async cancel(id: string): Promise<void> {
    if (!storeUuid(id) || !this.owner || this.journalInvalid) {
      throw new Error('matrix_store_invalid')
    }

    const owner = this.owner

    const result = storeEntitlement(
      await this.options.request(
        `entitlements/${id}/cancel`,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]),
        {}
      )
    )

    this.live(owner)

    if (result.id !== id || result.subscription?.state !== 'cancelled') {
      throw new Error('matrix_store_invalid')
    }

    this.state = { ...this.state, entitlements: this.state.entitlements.map(e => (e.id === id ? result : e)) }
    this.options.changed()
    await this.refresh()
  }
}
