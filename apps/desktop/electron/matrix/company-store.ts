import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  COMPANY_STORE_HEADER,
  COMPANY_STORE_VERSION,
  CompanyStoreAgentsSchema,
  CompanyStoreCatalogSchema,
  CompanyStoreEntitlementsSchema,
  CompanyStorePurchaseRequestSchema,
  CompanyStoreResultSchema
} from '../../shared/matrix-company-store'
import type {
  MatrixCompanyStoreActionResult,
  MatrixCompanyStoreIntent,
  MatrixCompanyStorePending,
  MatrixCompanyStoreSnapshot
} from '../../shared/matrix-company-store'
import { storeEntitlement, storeUuid } from '../../shared/matrix-store-contract'
import { DESKTOP_VERSION_HEADER, desktopVersionHeaderValue } from '../desktop-version-header'

import { readDomainJson } from './domain'
import { definiteStoreRefusal, MatrixStoreResponseError } from './store'
import type { StoreScope } from './store'

export type CompanyStoreResource =
  'catalog' | 'agents' | 'entitlements' | 'purchases' | `purchases/${string}` | `entitlements/${string}/cancel`
export interface CompanyStoreJournal {
  read(accountKey: string, companyId: string): MatrixCompanyStorePending[]
  write(accountKey: string, companyId: string, pending: MatrixCompanyStorePending[]): void
}

function pendingRows(value: unknown): MatrixCompanyStorePending[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('company_store_journal_invalid')
  }

  const keys = new Set<string>()

  return value.map(row => {
    const { purchaseId, ...input } = row
    const parsed = CompanyStorePurchaseRequestSchema.parse(input)

    if (!(purchaseId === null || storeUuid(purchaseId)) || keys.has(parsed.idempotencyKey)) {
      throw new Error('company_store_journal_invalid')
    }

    keys.add(parsed.idempotencyKey)

    return { ...parsed, purchaseId }
  })
}

export class FileCompanyStoreJournal implements CompanyStoreJournal {
  constructor(private readonly root: string) {}
  private file(accountKey: string, companyId: string) {
    if (!/^[a-f0-9]{64}$/.test(accountKey) || !storeUuid(companyId)) {
      throw new Error('company_store_invalid')
    }

    return path.join(this.root, accountKey, `${companyId}.json`)
  }
  read(accountKey: string, companyId: string) {
    const file = this.file(accountKey, companyId)

    if (!fs.existsSync(file)) {
      return []
    }

    const raw = fs.readFileSync(file, 'utf8')

    if (Buffer.byteLength(raw) > 64 * 1024) {
      throw new Error('company_store_journal_invalid')
    }

    return pendingRows(JSON.parse(raw))
  }
  write(accountKey: string, companyId: string, pending: MatrixCompanyStorePending[]) {
    const file = this.file(accountKey, companyId)
    const data = JSON.stringify(pendingRows(pending))
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, data, { mode: 0o600 })
    fs.renameSync(temporary, file)
  }
}

/** Closed company routes only. Provisioning and payer resolution belong entirely to Shell. */
export async function requestMatrixCompanyStore(
  resource: string,
  token: string,
  companyId: string,
  endpoint: CompanyStoreResource,
  signal: AbortSignal,
  input?: unknown,
  desktopVersion?: string
): Promise<unknown> {
  if (
    !storeUuid(companyId) ||
    (!['catalog', 'agents', 'entitlements', 'purchases'].includes(endpoint) &&
      !/^purchases\/[a-f0-9-]{36}$/i.test(endpoint) &&
      !/^entitlements\/[a-f0-9-]{36}\/cancel$/i.test(endpoint))
  ) {
    throw new Error('company_store_invalid')
  }

  const purchase = endpoint === 'purchases' ? CompanyStorePurchaseRequestSchema.parse(input) : undefined
  const write = Boolean(purchase) || endpoint.endsWith('/cancel')
  const version = desktopVersionHeaderValue(desktopVersion)

  const response = await fetch(
    `${resource}/companies/${companyId}/${endpoint === 'agents' ? 'agents' : `store/${endpoint}`}`,
    {
      method: write ? 'POST' : 'GET',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        [COMPANY_STORE_HEADER]: COMPANY_STORE_VERSION,
        'Atum-Store-Capabilities': 'agents.schedules.1,skills.hub.1,skills.prefix.1,store.ownership.1',
        ...(write ? { 'Content-Type': 'application/json' } : {}),
        ...(purchase ? { 'Idempotency-Key': purchase.idempotencyKey } : {}),
        ...(version ? { [DESKTOP_VERSION_HEADER]: version } : {})
      },
      ...(write ? { body: JSON.stringify(purchase ?? {}) } : {})
    }
  )

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }

  if (response.status !== 200) {
    await response.body?.cancel()

    if (definiteStoreRefusal(response.status)) {
      throw new MatrixStoreResponseError(response.status)
    }

    throw new Error('company_store_unavailable')
  }

  if (
    !response.headers.get('content-type')?.startsWith('application/json') ||
    response.headers.get(COMPANY_STORE_HEADER) !== COMPANY_STORE_VERSION
  ) {
    await response.body?.cancel()
    throw new Error('company_store_invalid')
  }

  return readDomainJson(response, 1024 * 1024)
}

const empty = (companyId: string): MatrixCompanyStoreSnapshot => ({
  companyId,
  state: 'loading',
  capability: 'unknown',
  marketplaceAvailable: false,
  viewer: { canAct: false },
  items: [],
  entitlements: [],
  agents: [],
  pending: []
})

/** Each instance belongs to one company; account generations fence all asynchronous continuations. */
export class MatrixCompanyStoreController {
  private owner: StoreScope | null = null
  private state: MatrixCompanyStoreSnapshot
  private abort = new AbortController()
  private reads?: Promise<MatrixCompanyStoreSnapshot>
  private writes = new Map<string, Promise<MatrixCompanyStoreActionResult>>()
  private journalInvalid = false
  constructor(
    readonly companyId: string,
    private readonly options: {
      journal: CompanyStoreJournal
      request(endpoint: CompanyStoreResource, signal: AbortSignal, input?: unknown): Promise<unknown>
    }
  ) {
    if (!storeUuid(companyId)) {
      throw new Error('company_store_invalid')
    }

    this.state = empty(companyId)
  }
  activate(owner: StoreScope | null) {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) {
      return
    }

    this.abort.abort()
    this.abort = new AbortController()
    this.owner = owner
    this.state = empty(this.companyId)
    this.writes = new Map()
    this.reads = undefined
    this.journalInvalid = false

    if (owner) {
      try {
        this.state.pending = this.options.journal.read(owner.accountKey, this.companyId)
      } catch {
        this.journalInvalid = true
        this.state.state = 'unavailable'
      }
    }
  }
  snapshot() {
    return structuredClone(this.state)
  }
  private live(owner: StoreScope) {
    if (owner !== this.owner || this.abort.signal.aborted) {
      throw new Error('company_store_cancelled')
    }
  }
  refresh(): Promise<MatrixCompanyStoreSnapshot> {
    if (!this.owner || this.journalInvalid) {
      return Promise.resolve(this.snapshot())
    }

    if (this.reads) {
      return this.reads
    }

    const owner = this.owner
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)])

    const read = (async () => {
      try {
        // The catalog is the capability probe. A 404 on a later resource is a read failure.
        let raw: unknown

        try {
          raw = await this.options.request('catalog', signal)
        } catch (error) {
          if (error instanceof MatrixStoreResponseError && error.status === 404) {
            this.live(owner)
            this.state = { ...empty(this.companyId), state: 'ready', capability: 'absent', pending: this.state.pending }

            return this.snapshot()
          }

          throw error
        }

        const catalog = CompanyStoreCatalogSchema.parse(raw)
        this.live(owner)
        const items = catalog.items.filter(item => item.deliverable && (item.kind === 'agent' || item.kind === 'skill'))
        this.state = {
          ...this.state,
          capability: 'supported',
          viewer: catalog.viewer,
          items,
          marketplaceAvailable: items.length > 0
        }

        const [inventory, roster] = await Promise.all([
          this.options.request('entitlements', signal),
          this.options.request('agents', signal)
        ])

        const entitlements = CompanyStoreEntitlementsSchema.parse(inventory).entitlements
        const agents = CompanyStoreAgentsSchema.parse(roster).agents
        this.live(owner)
        this.state = { ...this.state, state: 'ready', entitlements, agents }
      } catch {
        this.live(owner)
        this.state = {
          ...this.state,
          state: this.state.state === 'ready' || this.state.state === 'stale' ? 'stale' : 'unavailable',
          viewer: { canAct: false }
        }
      }

      return this.snapshot()
    })().finally(() => {
      if (this.owner === owner) {
        this.reads = undefined
      }
    })

    this.reads = read

    return read
  }
  private save(pending: MatrixCompanyStorePending[]) {
    this.options.journal.write(this.owner!.accountKey, this.companyId, pending)
    this.state = { ...this.state, pending }
  }
  async purchase(value: MatrixCompanyStoreIntent): Promise<MatrixCompanyStoreActionResult> {
    const input = CompanyStorePurchaseRequestSchema.parse({ ...value, idempotencyKey: randomUUID() })

    if (!this.owner || this.journalInvalid) {
      return { outcome: 'uncertain' }
    }

    if (!this.state.viewer.canAct) {
      return { outcome: 'refused', code: 'denied' }
    }

    if (this.state.state !== 'ready') {
      return { outcome: 'uncertain' }
    }

    const item = this.state.items.find(item => item.offer?.id === input.offerId)

    if (!item?.deliverable || ('hire' in input.target && item.kind !== 'agent')) {
      return { outcome: 'refused', code: 'offer_unavailable' }
    }

    // A second click resumes the durable operation, including after a restart/lost response.
    const existing = this.state.pending.find(
      row =>
        row.offerId === input.offerId &&
        row.offerVersion === input.offerVersion &&
        JSON.stringify(row.target) === JSON.stringify(input.target) &&
        row.consentRenewal === input.consentRenewal
    )

    if (existing) {
      return this.resume(existing.idempotencyKey)
    }

    if (this.state.pending.length >= 32) {
      return { outcome: 'uncertain' }
    }

    this.save([...this.state.pending, { ...input, purchaseId: null }])

    return this.resume(input.idempotencyKey)
  }
  resume(key: string): Promise<MatrixCompanyStoreActionResult> {
    const inflight = this.writes.get(key)

    if (inflight) {
      return inflight
    }

    const intent = this.state.pending.find(row => row.idempotencyKey === key)
    const owner = this.owner

    if (!owner || this.journalInvalid || !intent) {
      return Promise.resolve({ outcome: 'uncertain' })
    }

    if (!this.state.viewer.canAct) {
      return Promise.resolve({ outcome: 'refused', code: 'denied' })
    }

    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(25_000)])

    const promise = (async (): Promise<MatrixCompanyStoreActionResult> => {
      try {
        const { purchaseId, ...body } = intent

        const raw = await this.options.request(
          purchaseId ? `purchases/${purchaseId}` : 'purchases',
          signal,
          purchaseId ? undefined : body
        )

        const result = CompanyStoreResultSchema.parse(raw)
        this.live(owner)

        if (
          result.outcome === 'purchased' &&
          (result.purchase.idempotencyKey !== key ||
            result.purchase.offerId !== intent.offerId ||
            result.purchase.offerVersion !== intent.offerVersion ||
            !result.agentId ||
            result.purchase.assistantId !== result.agentId ||
            ('agentId' in intent.target && result.agentId !== intent.target.agentId) ||
            (purchaseId !== null && result.purchase.id !== purchaseId))
        ) {
          throw new Error('company_store_invalid')
        }

        if (
          result.outcome === 'already_owned' &&
          (!result.agentId ||
            result.entitlement.assistantId !== result.agentId ||
            ('agentId' in intent.target && result.agentId !== intent.target.agentId))
        ) {
          throw new Error('company_store_invalid')
        }

        if (result.outcome === 'offer_changed' && result.offer.id !== intent.offerId) {
          throw new Error('company_store_invalid')
        }

        if (result.outcome === 'purchased' && !['completed', 'reversed'].includes(result.purchase.state)) {
          this.save(
            this.state.pending.map(row =>
              row.idempotencyKey === key ? { ...row, purchaseId: result.purchase.id } : row
            )
          )
        } else {
          this.save(this.state.pending.filter(row => row.idempotencyKey !== key))
        }

        await this.refresh()
        this.live(owner)

        return result
      } catch (error) {
        this.live(owner)

        // HTTP refusals keep the key: an earlier dispatch may have succeeded before a lost reply.
        // Only a validated terminal Store body can settle a durable intent.
        if (!intent.purchaseId && error instanceof MatrixStoreResponseError) {
          const code =
            error.status === 403
              ? 'denied'
              : error.status === 409
                ? 'conflict'
                : error.status === 429
                  ? 'rate_limited'
                  : error.status === 404
                    ? 'offer_unavailable'
                    : 'invalid_request'

          return { outcome: 'refused', code }
        }

        return { outcome: 'uncertain' }
      }
    })().finally(() => {
      if (this.owner === owner) {
        this.writes.delete(key)
      }
    })

    this.writes.set(key, promise)

    return promise
  }
  async cancel(entitlementId: string): Promise<void> {
    const owner = this.owner

    if (!owner || this.journalInvalid || !this.state.viewer.canAct || !storeUuid(entitlementId)) {
      throw new Error('company_store_denied')
    }

    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)])
    const result = storeEntitlement(await this.options.request(`entitlements/${entitlementId}/cancel`, signal, {}))
    this.live(owner)

    if (result.id !== entitlementId || result.subscription?.state !== 'cancelled') {
      throw new Error('company_store_invalid')
    }

    await this.refresh()
  }
}
