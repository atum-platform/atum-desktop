// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { AtumAgentHire, AtumExecutionTask, AtumHireResult } from '../shared/atum-hiring'

import { accountKeyFor, type AccountRootAuthority } from './atum-messaging/account-roots'
import { MessagingHttpError, parseStoreCatalog, parseStoreEntitlementEnvelope } from './atum-messaging/http-client'
import type {
  MessagingClientBoundary,
  StoreCatalog,
  StoreCatalogItem,
  StoreCatalogOffer,
  StoreEntitlement,
  StoreEntitlementEnvelope,
  StoreItemKind,
  StoreItemSource,
  StorePurchase,
  StorePurchaseResult,
  StorePurchaseStatus,
  StoreTrainingTask
} from './atum-messaging/types'

/**
 * Atum Store main-process service (plan 2026-09-10-atum-store.md, decisions 5-8).
 *
 * Main owns the bearer, the catalog cache and the signed entitlement envelope;
 * the renderer sees only the wire projections below. The gateway (Hermes,
 * workstream H1) reads exactly ONE store file, from its own account-scoped
 * home (contract C1, review B1):
 *
 *   `<hermesStateRoot>/atum-store/entitlement-proof.json` — the platform-signed
 *     Ed25519 envelope v3, BYTE-FOR-BYTE as received from
 *     GET /api/desktop/v1/protons/entitlements. Never re-serialised: key order
 *     is part of the signed payload. `hermesStateRoot` is the directory main
 *     passes to the backend as HERMES_HOME — writing to `.root` instead was
 *     review B1, the path that made every chokepoint a no-op.
 *
 * There is no `catalog-owned.json` anymore: the catalog-owned set travels
 * INSIDE the signed envelope (`catalog_owned`, every item in every listing
 * state), because "is this item paid?" must never come from an unsigned,
 * listing-dependent file (review B5).
 *
 * The proof is written atomically (temp file + rename, mode 0600) and deleted
 * on sign-out or account change. `catalog.json` beside it is main's own
 * last-good catalog snapshot for stale rendering; Hermes does not read it.
 *
 * Offline proof (decision 8): a stored envelope whose `expires_at` is still
 * ahead lets a priced install of a local asset proceed offline; an expired or
 * missing envelope makes a priced install UNAVAILABLE, never free.
 */

export const ATUM_STORE_DIR = 'atum-store'
export const ATUM_STORE_CATALOG_FILE = 'catalog.json'
export const ATUM_STORE_ENTITLEMENT_FILE = 'entitlement-proof.json'

export interface StoreOfferWire {
  billing_interval?: 'one_time' | 'month'
  id: string
  version: number
  price_protons: number
}

export interface StoreItemHashWire {
  sha256: string
  hermes_release: string | null
}

export interface StoreItemDetailWire {
  description: Record<string, string>
  try_prompt: Record<string, string>
  needs: string[]
}

export interface StoreItemWire {
  kind: StoreItemKind
  id: string
  title: Record<string, string>
  summary: Record<string, string>
  detail: StoreItemDetailWire
  glyph: string
  accent: string
  source: StoreItemSource | null
  featured: boolean
  sort_order: number
  offer: StoreOfferWire | null
  hashes: StoreItemHashWire[]
}

export interface StoreEntitlementWire {
  assistant_id: string | null
  assistant_identity_id: string | null
  kind: StoreItemKind
  id: string
  state: 'active' | 'revoked'
  granted_at: string
}

export interface StoreCatalogWire {
  items: StoreItemWire[]
  entitlements: StoreEntitlementWire[]
  available_protons: number
  /** Items hidden as unfulfillable on this build (plan decision 11). */
  skipped_unknown_items: number
  /**
   * What the signed envelope claims as catalog-owned, identifier only.
   *
   * The listed catalog carries only `state = 'listed'` items, while the
   * envelope's `catalog_owned` carries every state. Without this the renderer
   * priced a delisted or draft paid item as Free by source class and offered
   * to adopt it, and the gateway — which matches the signed set — refused.
   * Hashes are deliberately left out; the renderer matches identifiers.
   */
  catalog_owned: { kind: string; identifier: string; delivery: 'cloud' | 'local' }[]
}

export interface StorePurchaseRecordWire {
  assistant_id: string | null
  id: string
  offer_id: string
  offer_version: number
  kind: StoreItemKind
  item_id: string
  amount_protons: number
  status: 'completed' | 'refunded'
  created_at: string
  refunded_at: string | null
}

export interface StorePurchaseCompletedWire {
  outcome: 'completed'
  purchase: StorePurchaseRecordWire
  entitlement: StoreEntitlementWire
  wallet: { available_protons: number } | null
}

export interface StorePurchaseAlreadyOwnedWire {
  outcome: 'already_owned'
  purchase: null
  entitlement: StoreEntitlementWire
}

/** The confirmed offer lost a race; the returned offer is authoritative and nothing was charged. */
export interface StorePurchaseOfferChangedWire {
  outcome: 'offer_changed'
  offer: StoreOfferWire
}

export interface StorePurchaseRefundedWire {
  outcome: 'refunded'
  purchase: StorePurchaseRecordWire
  entitlement: StoreEntitlementWire | null
}

export type StorePurchaseWire =
  | StorePurchaseCompletedWire
  | StorePurchaseAlreadyOwnedWire
  | StorePurchaseOfferChangedWire
  | StorePurchaseRefundedWire

export interface StorePurchaseStatusWire {
  purchase: StorePurchaseRecordWire
  entitlement: StoreEntitlementWire | null
}

/** What the gateway enforces from the offline proof: distinct, never conflated. */
export type StoreEntitlementState = 'valid' | 'expired' | 'missing'

export interface AtumStoreSession {
  user: { id: string }
}

export interface AtumStoreServiceOptions {
  accountRoots: AccountRootAuthority
  session: () => AtumStoreSession | null
  client: Pick<MessagingClientBoundary, 'catalog' | 'purchase' | 'purchaseStatus' | 'entitlements'> & Partial<Pick<MessagingClientBoundary, 'startTrainingTask' | 'agentHires' | 'hireAgent' | 'cancelAgentHire' | 'startAgentTask'>>
  now?: () => number
}

interface AccountFence {
  accountId: string
  accountKey: string
  generation: number
}

interface CatalogSnapshot {
  fence: AccountFence
  catalog: StoreCatalog
}

interface EnvelopeSnapshot {
  fence: AccountFence
  envelope: StoreEntitlementEnvelope
}

const NO_HASHES: ReadonlySet<string> = new Set()

function offerWire(offer: StoreCatalogOffer): StoreOfferWire {
  return { id: offer.id, version: offer.version, price_protons: offer.priceProtons,
    ...(offer.billingInterval ? { billing_interval: offer.billingInterval } : {}) }
}

function entitlementWire(entry: StoreEntitlement): StoreEntitlementWire {
  return { kind: entry.kind, id: entry.id, state: entry.state, granted_at: entry.grantedAt, assistant_id: entry.assistantId, assistant_identity_id: entry.assistantIdentityId }
}

function itemWire(item: StoreCatalogItem): StoreItemWire {
  return {
    kind: item.kind,
    id: item.id,
    title: item.title,
    summary: item.summary,
    detail: { description: item.detail.description, try_prompt: item.detail.tryPrompt, needs: item.detail.needs },
    glyph: item.glyph,
    accent: item.accent,
    source: item.source,
    featured: item.featured,
    sort_order: item.sortOrder,
    offer: item.offer ? offerWire(item.offer) : null,
    hashes: item.hashes.map(hash => ({ sha256: hash.sha256, hermes_release: hash.hermesRelease }))
  }
}

function catalogWire(
  catalog: StoreCatalog,
  catalogOwned: { kind: string; identifier: string; delivery: 'cloud' | 'local' }[] = []
): StoreCatalogWire {
  return {
    items: catalog.items.map(itemWire),
    entitlements: catalog.entitlements.map(entitlementWire),
    available_protons: catalog.availableProtons,
    skipped_unknown_items: catalog.skippedUnknownItems,
    catalog_owned: catalogOwned
  }
}

function purchaseRecordWire(purchase: StorePurchase): StorePurchaseRecordWire {
  return {
    id: purchase.id,
    offer_id: purchase.offerId,
    offer_version: purchase.offerVersion,
    kind: purchase.kind,
    item_id: purchase.itemId,
    assistant_id: purchase.assistantId,
    amount_protons: purchase.amountProtons,
    status: purchase.status,
    created_at: purchase.createdAt,
    refunded_at: purchase.refundedAt
  }
}

function purchaseResultWire(result: StorePurchaseResult): StorePurchaseWire {
  switch (result.outcome) {
    case 'completed':
      return {
        outcome: 'completed',
        purchase: purchaseRecordWire(result.purchase),
        entitlement: entitlementWire(result.entitlement),
        wallet: result.wallet ? { available_protons: result.wallet.availableProtons } : null
      }

    case 'already_owned':
      return { outcome: 'already_owned', purchase: null, entitlement: entitlementWire(result.entitlement) }

    case 'offer_changed':
      return { outcome: 'offer_changed', offer: offerWire(result.offer) }

    case 'refunded':
      return {
        outcome: 'refunded',
        purchase: purchaseRecordWire(result.purchase),
        entitlement: result.entitlement ? entitlementWire(result.entitlement) : null
      }
  }
}

function purchaseStatusWire(status: StorePurchaseStatus): StorePurchaseStatusWire {
  return {
    purchase: purchaseRecordWire(status.purchase),
    entitlement: status.entitlement ? entitlementWire(status.entitlement) : null
  }
}

/**
 * Every hash the signed envelope's `catalog_owned` claims, deduplicated: the
 * uploader's skip list. Sourced from the SIGNED set — the listed catalog omits
 * delisted and draft items, and ownership must never depend on listing state
 * (review B5/B6). Expiry is an install-time decision; a hash stays
 * catalog-owned for upload purposes even in an expired envelope.
 */
export function catalogOwnedHashesFor(envelope: StoreEntitlementEnvelope): ReadonlySet<string> {
  const hashes = new Set<string>()

  for (const item of envelope.catalogOwned) {
    for (const sha256 of item.hashes) {
      hashes.add(sha256)
    }
  }

  return hashes
}

export class AtumStoreService {
  private catalogSnapshot: CatalogSnapshot | null = null
  private envelopeSnapshot: EnvelopeSnapshot | null = null
  private refreshPending: { fence: AccountFence; promise: Promise<StoreCatalogWire> } | null = null
  private lastRefresh: { fence: AccountFence; at: number } | null = null
  private readonly now: () => number

  constructor(private readonly options: AtumStoreServiceOptions) {
    this.now = options.now ?? Date.now
  }

  /** The last known catalog: in-memory, else the account's disk snapshot, else a refresh. */
  async catalog(): Promise<StoreCatalogWire> {
    const fence = this.captureFence()
    const cached = this.currentCatalog(fence)

    if (cached) {
      return catalogWire(cached, this.catalogOwnedIdentifiers())
    }

    return this.refresh()
  }

  /**
   * Pull the catalog and the signed envelope, persisting each independently.
   * A failed half keeps the other's cache; a failed refresh over a warm cache
   * returns the cache (stale), and only a cold failure throws.
   */
  refresh(ifStale = false): Promise<StoreCatalogWire> {
    const fence = this.captureFence()
    const pending = this.refreshPending

    if (pending && this.sameFence(pending.fence, fence)) {
      return pending.promise
    }

    const cached = this.currentCatalog(fence)
    if (ifStale && cached && this.lastRefresh && this.sameFence(this.lastRefresh.fence, fence)
      && this.now() - this.lastRefresh.at < 15 * 60_000) {
      return Promise.resolve(catalogWire(cached, this.catalogOwnedIdentifiers()))
    }

    this.lastRefresh = { fence, at: this.now() }
    const promise = this.performRefresh(fence).finally(() => {
      if (this.refreshPending?.promise === promise) {
        this.refreshPending = null
      }
    })

    this.refreshPending = { fence, promise }

    return promise
  }

  /**
   * @param confirmedForAccountId the account the person was looking at when
   *   they confirmed. Main holds the authoritative account, and the renderer's
   *   view of it arrives asynchronously, so a hand-off committed here while
   *   the renderer's push was still in flight would otherwise let account A's
   *   confirmation be charged to account B (re-review 2026-09-12).
   */
  async purchase(
    offerId: string,
    offerVersion: number,
    idempotencyKey: string,
    confirmedForAccountId?: string,
    assistantId: string | null = null
  ): Promise<StorePurchaseWire> {
    const fence = this.captureFence()

    if (confirmedForAccountId !== undefined && confirmedForAccountId !== fence.accountId) {
      throw new Error('account_context_changed')
    }

    const result = await this.options.client.purchase(offerId, offerVersion, idempotencyKey, assistantId)
    this.assertFence(fence)

    if (result.outcome === 'completed') {
      // The fresh envelope is what lets the just-bought item activate offline;
      // a refresh failure must not mask a completed charge.
      await this.refresh().catch(() => undefined)
    }

    return purchaseResultWire(result)
  }

  async agentHires(accountId: string): Promise<AtumAgentHire[]> {
    const fence = this.captureFence()
    if (fence.accountId !== accountId) { throw new Error('account_context_changed') }
    if (!this.options.client.agentHires) { throw new Error('hiring_unavailable') }
    const result = await this.options.client.agentHires()
    this.assertFence(fence)
    return result
  }

  async hireAgent(assistantId: string, offerId: string, version: number, key: string, consent: true, accountId: string): Promise<AtumHireResult> {
    const fence = this.captureFence()
    if (fence.accountId !== accountId) { throw new Error('account_context_changed') }
    if (consent !== true || !this.options.client.hireAgent) { throw new Error('hiring_consent_required') }
    const result = await this.options.client.hireAgent(assistantId, offerId, version, key, consent)
    this.assertFence(fence)
    return result
  }

  async cancelAgentHire(hireId: string, accountId: string): Promise<AtumAgentHire> {
    const fence = this.captureFence()
    if (fence.accountId !== accountId) { throw new Error('account_context_changed') }
    if (!this.options.client.cancelAgentHire) { throw new Error('hiring_unavailable') }
    const result = await this.options.client.cancelAgentHire(hireId)
    this.assertFence(fence)
    return result
  }

  async startAgentTask(assistantId: string, conversationId: string, skillId: string | null, accountId: string): Promise<AtumExecutionTask | null> {
    const fence = this.captureFence()
    if (fence.accountId !== accountId) { throw new Error('account_context_changed') }
    if (!this.options.client.startAgentTask) { throw new Error('hiring_unavailable') }
    const result = await this.options.client.startAgentTask(assistantId, conversationId, skillId)
    this.assertFence(fence)
    return result
  }

  async startTrainingTask(assistantId: string, conversationId: string, skillId: string, accountId: string): Promise<StoreTrainingTask> {
    const fence = this.captureFence()

    if (fence.accountId !== accountId) { throw new Error('account_context_changed') }

    if (!this.options.client.startTrainingTask) { throw new Error('training_unavailable') }
    const task = await this.options.client.startTrainingTask(assistantId, conversationId, skillId)
    this.assertFence(fence)

    return task
  }

  async purchaseStatus(purchaseId: string): Promise<StorePurchaseStatusWire> {
    const fence = this.captureFence()
    const status = await this.options.client.purchaseStatus(purchaseId)
    this.assertFence(fence)

    return purchaseStatusWire(status)
  }

  /**
   * The sync uploader's skip list, from the stored SIGNED envelope's
   * `catalog_owned` — never from the listed catalog, which omits delisted and
   * draft items (review B5/B6). No stored envelope means "nothing known
   * catalog-owned", so nothing is skipped: the platform's 409 `catalog_owned`
   * refusal is the cold-start backstop, and the uploader treats it as an
   * expected skip, so sync completes rather than stalls.
   */
  /**
   * The signed catalog-owned set as `(kind, identifier)` pairs, for the
   * renderer. The listed catalog omits delisted and draft items, so without
   * this the shelves priced a delisted paid pet as Free and offered to adopt
   * it while the gateway refused (re-review 2026-09-12). Empty when there is
   * no usable envelope — the renderer then falls back to its own
   * "unknown is unavailable" rule for bundled pets.
   */
  private catalogOwnedIdentifiers(): { kind: string; identifier: string; delivery: 'cloud' | 'local' }[] {
    const snapshot = this.currentEnvelope()

    if (!snapshot) {
      return []
    }

    return snapshot.envelope.catalogOwned.map(item => ({ kind: item.kind, identifier: item.identifier, delivery: item.delivery }))
  }

  catalogOwnedHashes(): ReadonlySet<string> {
    const snapshot = this.currentEnvelope()

    return snapshot ? catalogOwnedHashesFor(snapshot.envelope) : NO_HASHES
  }

  /** Expired is reported as expired — unavailable, never absent, never free. */
  entitlementState(): StoreEntitlementState {
    const snapshot = this.currentEnvelope()

    if (!snapshot) {
      return 'missing'
    }

    return snapshot.envelope.expiresAt * 1000 > this.now() ? 'valid' : 'expired'
  }

  /** Sign-out / account hand-off: memory and the outgoing account's proof files go together. */
  revokeAccount(accountId: string): void {
    this.catalogSnapshot = null
    this.envelopeSnapshot = null
    rmSync(this.dirFor(accountId), { recursive: true, force: true })
    this.removeLegacyDir(accountId)
  }

  private async performRefresh(fence: AccountFence): Promise<StoreCatalogWire> {
    let catalog = this.currentCatalog(fence)
    let failure: unknown = null

    try {
      const fresh = await this.options.client.catalog()
      this.assertFence(fence)
      this.persistCatalog(fence, fresh)
      this.catalogSnapshot = { fence, catalog: fresh }
      catalog = fresh
    } catch (error) {
      failure = error
    }

    try {
      const proof = await this.options.client.entitlements()
      this.assertFence(fence)

      if (proof.envelope.accountId !== fence.accountId) {
        throw new Error('invalid_response:store.entitlements.account_id')
      }

      this.persistEnvelope(fence, proof.raw)
      this.envelopeSnapshot = { fence, envelope: proof.envelope }
    } catch (error) {
      if (failure === null) {
        failure = error
      }
    }

    if (catalog) {
      return catalogWire(catalog, this.catalogOwnedIdentifiers())
    }

    throw failure instanceof Error ? failure : new Error('store_catalog_unavailable')
  }

  private currentSnapshot(): CatalogSnapshot | null {
    let fence: AccountFence

    try {
      fence = this.captureFence()
    } catch {
      return null
    }

    if (this.catalogSnapshot && this.sameFence(this.catalogSnapshot.fence, fence)) {
      return this.catalogSnapshot
    }

    return this.loadCatalog(fence)
  }

  private currentCatalog(fence: AccountFence): StoreCatalog | null {
    return this.currentSnapshot()?.catalog ?? null
  }

  private currentEnvelope(): EnvelopeSnapshot | null {
    let fence: AccountFence

    try {
      fence = this.captureFence()
    } catch {
      return null
    }

    if (this.envelopeSnapshot && this.sameFence(this.envelopeSnapshot.fence, fence)) {
      return this.envelopeSnapshot
    }

    return this.loadEnvelope(fence)
  }

  /** A corrupt or foreign snapshot is absent, never partially trusted. */
  private loadCatalog(fence: AccountFence): CatalogSnapshot | null {
    const path = join(this.dirFor(fence.accountId), ATUM_STORE_CATALOG_FILE)

    try {
      if (!existsSync(path)) {
        return null
      }

      const catalog = parseStoreCatalog(JSON.parse(readFileSync(path, 'utf8')))
      const snapshot: CatalogSnapshot = { fence, catalog }

      this.catalogSnapshot = snapshot

      return snapshot
    } catch {
      return null
    }
  }

  private loadEnvelope(fence: AccountFence): EnvelopeSnapshot | null {
    const path = join(this.dirFor(fence.accountId), ATUM_STORE_ENTITLEMENT_FILE)

    try {
      if (!existsSync(path)) {
        return null
      }

      const envelope = parseStoreEntitlementEnvelope(JSON.parse(readFileSync(path, 'utf8')))

      if (envelope.accountId !== fence.accountId) {
        return null
      }

      const snapshot: EnvelopeSnapshot = { fence, envelope }

      this.envelopeSnapshot = snapshot

      return snapshot
    } catch {
      return null
    }
  }

  private persistCatalog(fence: AccountFence, catalog: StoreCatalog): void {
    this.removeLegacyDir(fence.accountId)
    const dir = this.dirFor(fence.accountId)

    // The snapshot is stored in the wire shape — exactly what the route emits —
    // so the loader can revalidate it with the same parser, never trusting it.
    // Without catalog_owned: that set belongs to the signed envelope, which is
    // persisted beside this file and reloaded on its own.
    const { catalog_owned: _ownedOmitted, ...snapshot } = catalogWire(catalog)

    this.persistAtomic(join(dir, ATUM_STORE_CATALOG_FILE), JSON.stringify(snapshot))
  }

  private persistEnvelope(fence: AccountFence, raw: string): void {
    this.removeLegacyDir(fence.accountId)
    this.persistAtomic(join(this.dirFor(fence.accountId), ATUM_STORE_ENTITLEMENT_FILE), raw)
  }

  private persistAtomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`

    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  }

  /**
   * Contract C1 / review B1: Hermes reads the proof at `$HERMES_HOME/atum-store`,
   * and the account-scoped HERMES_HOME main spawns the backend with IS
   * `hermesStateRoot` (`account-roots.ts`, `main.ts` runtime-home activation).
   * Writing under `.root` instead was the mismatch that made enforcement a
   * no-op. Do not "fix" this back.
   */
  private dirFor(accountId: string): string {
    return join(this.options.accountRoots.pathsForAccount(accountId).hermesStateRoot, ATUM_STORE_DIR)
  }

  /**
   * Builds before the B1 fix wrote the store files to `<account root>/atum-store`
   * — a directory Hermes never reads. That tree is unsigned leftovers (including
   * the removed `catalog-owned.json`); it is deleted on the next write and on
   * sign-out so it cannot confuse anything later.
   */
  private legacyDirFor(accountId: string): string {
    return join(this.options.accountRoots.pathsForAccount(accountId).root, ATUM_STORE_DIR)
  }

  private removeLegacyDir(accountId: string): void {
    const legacy = this.legacyDirFor(accountId)

    if (existsSync(legacy)) {
      rmSync(legacy, { recursive: true, force: true })
    }
  }

  private captureFence(): AccountFence {
    const session = this.options.session()

    if (!session?.user.id) {
      throw new MessagingHttpError('auth_unavailable', 401, false, null, null, null)
    }

    const committed = this.options.accountRoots.committed()
    const accountKey = accountKeyFor(session.user.id)

    if (!committed || committed.marker.accountKey !== accountKey) {
      throw new MessagingHttpError('account_context_mismatch', 409, false, null, null, null)
    }

    return { accountId: session.user.id, accountKey, generation: committed.marker.generation }
  }

  private assertFence(expected: AccountFence): void {
    const session = this.options.session()
    const committed = this.options.accountRoots.committed()

    if (
      session?.user.id !== expected.accountId ||
      !committed ||
      committed.marker.accountKey !== expected.accountKey ||
      committed.marker.generation !== expected.generation
    ) {
      throw new MessagingHttpError('account_context_changed', 409, false, null, null, null)
    }
  }

  private sameFence(a: AccountFence, b: AccountFence): boolean {
    return a.accountId === b.accountId && a.accountKey === b.accountKey && a.generation === b.generation
  }
}
