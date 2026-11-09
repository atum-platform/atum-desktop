// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import type {
  AtumStoreEntitlementWire,
  AtumStoreItemKind,
  AtumStoreOffer,
  AtumStorePurchaseWire
} from '@/lib/atum-store-items'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { readKey } from '@/lib/storage'

import { $atumAccountScopeId } from './atum-messaging'
import { $atumStoreCatalog, refreshAtumStoreCatalog, storeBridge } from './atum-store-catalog'

/**
 * Purchases, from the renderer's side (plan 2026-09-10-atum-store.md, W5.4).
 *
 * THE IDEMPOTENCY RULE: the renderer mints the idempotency key ONCE, when the
 * person confirms the displayed offer, and persists it until the purchase
 * resolves. A double-click, a retry, or a second window reuses the persisted
 * key, so the platform sees one purchase, never two — a network timeout after
 * a committed charge can never charge twice. The key is discarded the moment
 * the purchase resolves, and NEVER paired with a different offer version: an
 * `offer_changed` answer retires the key with the price it was minted for.
 *
 * The attempts map is account-scoped and durable (localStorage, shared by
 * every window of this profile) so a retry after a restart — or from the
 * second window — is the platform's idempotent replay, not a second charge.
 *
 * The renderer does no arithmetic and no authorisation on balances: it shows
 * what main returns and sends the confirmed `(offer_id, offer_version)` back.
 */

export interface AtumStorePurchaseAttempt {
  assistantId: string | null
  idempotencyKey: string
  offerId: string
  offerVersion: number
  /** Set the moment a `completed` reply names the purchase, so recovery after
   *  a crash-between-reply-and-cleanup is a `purchaseStatus` GET, never a
   *  re-POST. Cleared with the attempt once the entitlement is visible. */
  purchaseId: string | null
}

type AttemptsByAccount = Record<string, Record<string, AtumStorePurchaseAttempt>>

// ONE pattern, the same one main's IPC boundary uses
// (electron/atum-store-ipc.ts): a real RFC-4122 UUID has four hyphens. The
// previous copy here dropped the fourth group, so it matched no real UUID and
// every persisted attempt was silently discarded on load.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function sanitizeAttempts(value: unknown): AttemptsByAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([accountId, byItem]) => {
      if (!byItem || typeof byItem !== 'object' || Array.isArray(byItem)) {
        return []
      }

      const attempts = Object.fromEntries(
        Object.entries(byItem as Record<string, unknown>).flatMap(([itemKey, attempt]) => {
          const row = attempt as Record<string, unknown> | null

          if (
            !row ||
            (row.assistantId !== null && (typeof row.assistantId !== 'string' || !UUID.test(row.assistantId))) ||
            typeof row.idempotencyKey !== 'string' ||
            !UUID.test(row.idempotencyKey) ||
            typeof row.offerId !== 'string' ||
            !UUID.test(row.offerId) ||
            typeof row.offerVersion !== 'number' ||
            !Number.isSafeInteger(row.offerVersion) ||
            row.offerVersion < 1 ||
            (row.purchaseId !== null && (typeof row.purchaseId !== 'string' || !UUID.test(row.purchaseId)))
          ) {
            return []
          }

          return [[itemKey, attempt as AtumStorePurchaseAttempt]]
        })
      )

      return Object.keys(attempts).length > 0 ? [[accountId, attempts]] : []
    })
  )
}

const ATTEMPTS_KEY = 'atum.desktop.storePurchaseAttempts.v2'
const attemptsCodec = Codecs.json(sanitizeAttempts)

export const $atumStorePurchaseAttempts = persistentAtom<AttemptsByAccount>(ATTEMPTS_KEY, {}, attemptsCodec)

/**
 * The PERSISTED map is the single source of truth, shared by every window of
 * this profile. The atom is a window-local projection of it: every read goes
 * back to storage, and every write merges over the latest persisted value, so
 * a second window neither misses the first's attempt nor overwrites it with a
 * stale in-memory copy.
 */
function readPersistedAttempts(): AttemptsByAccount {
  const raw = readKey(ATTEMPTS_KEY)

  if (raw === null) {
    return {}
  }

  try {
    return attemptsCodec.decode(raw)
  } catch {
    return {}
  }
}

/** Value equality for the attempts map: key order differs between windows'
 *  merges, so a string compare would ping-pong writes back and forth. */
function sameAttempts(left: AttemptsByAccount, right: AttemptsByAccount): boolean {
  const leftAccounts = Object.keys(left)
  const rightAccounts = Object.keys(right)

  if (leftAccounts.length !== rightAccounts.length) {
    return false
  }

  return leftAccounts.every(accountId => {
    const leftByItem = left[accountId]!
    const rightByItem = right[accountId]

    if (!rightByItem) {
      return false
    }

    const keys = Object.keys(leftByItem)

    return (
      keys.length === Object.keys(rightByItem).length &&
      keys.every(key => {
        const a = leftByItem[key]!
        const b = rightByItem[key]

        return Boolean(
          b &&
          a.idempotencyKey === b.idempotencyKey &&
          a.offerId === b.offerId &&
          a.offerVersion === b.offerVersion &&
          a.purchaseId === b.purchaseId &&
          a.assistantId === b.assistantId
        )
      })
    )
  })
}

// A 'storage' event fires in every window EXCEPT the one that wrote — exactly
// the gap the merge-on-write above leaves. Adopt the other window's attempts
// into this window's projection. The equality check matters: setting the atom
// writes back to storage, and an identical write-back would echo the event
// between windows forever.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== ATTEMPTS_KEY) {
      return
    }

    const next = readPersistedAttempts()

    if (!sameAttempts(next, $atumStorePurchaseAttempts.get())) {
      $atumStorePurchaseAttempts.set(next)
    }
  })
}

function itemKey(kind: AtumStoreItemKind, itemId: string, assistantId: string | null = null): string {
  return `${kind}/${itemId}/${assistantId ?? 'account'}`
}

export function storePurchaseAttemptFor(
  accountId: string,
  kind: AtumStoreItemKind,
  itemId: string,
  assistantId: string | null = null
): AtumStorePurchaseAttempt | null {
  return readPersistedAttempts()[accountId]?.[itemKey(kind, itemId, assistantId)] ?? null
}

function writeAttempt(
  accountId: string,
  kind: AtumStoreItemKind,
  itemId: string,
  attempt: AtumStorePurchaseAttempt
): void {
  // Merge over the latest persisted map, not this window's projection of it:
  // another window may have written since this one loaded.
  const all = readPersistedAttempts()

  $atumStorePurchaseAttempts.set({
    ...all,
    [accountId]: { ...all[accountId], [itemKey(kind, itemId, attempt.assistantId)]: attempt }
  })
}

/** Update the stored attempt only while it is still THIS confirmation's.
 *
 *  A reply to an older confirmation must not resurrect itself over a newer one
 *  the person has already started: the clear that follows would then delete
 *  the newer attempt, because the stored key had become the older one
 *  (re-review 2026-09-12). */
function writeAttemptIfCurrent(
  accountId: string,
  kind: AtumStoreItemKind,
  itemId: string,
  attempt: AtumStorePurchaseAttempt
): void {
  const existing = readPersistedAttempts()[accountId]?.[itemKey(kind, itemId, attempt.assistantId)]

  if (!existing || existing.idempotencyKey !== attempt.idempotencyKey) {
    return
  }

  writeAttempt(accountId, kind, itemId, attempt)
}

function clearAttempt(
  accountId: string,
  kind: AtumStoreItemKind,
  itemId: string,
  idempotencyKey?: string,
  assistantId: string | null = null
): void {
  const all = readPersistedAttempts()
  const key = itemKey(kind, itemId, assistantId)
  const existing = all[accountId]?.[key]

  if (!existing) {
    return
  }

  // A settling result may retire only its OWN confirmation. A late reply to an
  // older key must not clear a newer confirmation's attempt for the same item.
  if (idempotencyKey && existing.idempotencyKey !== idempotencyKey) {
    return
  }

  const byItem = { ...all[accountId] }

  delete byItem[key]

  const { [accountId]: _, ...rest } = all

  $atumStorePurchaseAttempts.set(Object.keys(byItem).length > 0 ? { ...rest, [accountId]: byItem } : rest)
}

function mintIdempotencyKey(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('store_idempotency_unavailable')
  }

  return crypto.randomUUID()
}

/**
 * Mint-or-reuse: the key for a confirmation. An existing attempt for the SAME
 * item and the SAME offer version is that confirmation still unresolved —
 * reuse it (double-click, retry, second window). Any other offer version means
 * the price moved since; the old key is retired with the old price and a new
 * one is minted for the offer now being confirmed.
 */
export function beginStorePurchase(
  accountId: string,
  kind: AtumStoreItemKind,
  itemId: string,
  offer: AtumStoreOffer,
  assistantId: string | null = null
): AtumStorePurchaseAttempt {
  const existing = storePurchaseAttemptFor(accountId, kind, itemId, assistantId)

  if (existing && existing.offerId === offer.id && existing.offerVersion === offer.version) {
    return existing
  }

  const attempt: AtumStorePurchaseAttempt = {
    assistantId,
    idempotencyKey: mintIdempotencyKey(),
    offerId: offer.id,
    offerVersion: offer.version,
    purchaseId: null
  }

  writeAttempt(accountId, kind, itemId, attempt)

  return attempt
}

export type StorePurchaseOutcome =
  /** The entitlement exists — proceed to install. */
  | { kind: 'completed' }
  | { kind: 'already_owned' }
  /** Nothing was charged; the carried offer is the new authoritative price. */
  | { kind: 'offer_changed'; offer: AtumStoreOffer }
  | { kind: 'insufficient_protons' }
  /** The store is not taking purchases. A refusal made before any write. */
  | { kind: 'unavailable' }
  /** The reply was lost; the purchase may be committed. Recover, never retry blind. */
  | { kind: 'uncertain' }
  | { kind: 'failed' }

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A confirmed grant remains usable when the following catalog refresh fails. */
function publishEntitlement(accountId: string, entry: AtumStoreEntitlementWire): void {
  if ($atumAccountScopeId.get() !== accountId) {
    return
  }
  const view = $atumStoreCatalog.get()

  if (view.accountId !== accountId || !view.catalog) {
    return
  }
  $atumStoreCatalog.set({
    ...view,
    catalog: {
      ...view.catalog,
      entitlements: [
        ...view.catalog.entitlements.filter(
          existing =>
            !(existing.kind === entry.kind && existing.id === entry.id && existing.assistant_id === entry.assistant_id)
        ),
        entry
      ]
    }
  })
}

async function settleOutcome(
  accountId: string,
  kind: AtumStoreItemKind,
  itemId: string,
  attempt: AtumStorePurchaseAttempt,
  result: AtumStorePurchaseWire
): Promise<StorePurchaseOutcome> {
  if (
    'entitlement' in result &&
    result.entitlement &&
    (result.entitlement.assistant_id !== attempt.assistantId ||
      result.entitlement.id !== itemId ||
      result.entitlement.kind !== kind)
  ) {
    return { kind: 'uncertain' }
  }

  if ('entitlement' in result && result.entitlement?.state === 'active') {
    publishEntitlement(accountId, result.entitlement)
  }

  switch (result.outcome) {
    case 'completed':
      // Record the id first: if this window dies before the entitlement is
      // observed, recovery is a status GET on the id, not a re-POST.
      writeAttemptIfCurrent(accountId, kind, itemId, { ...attempt, purchaseId: result.purchase.id })
      // The fresh read is what makes the new entitlement (and the new
      // balance) visible; a refresh failure must not mask a completed charge.
      await refreshAtumStoreCatalog(true).catch(() => null)
      clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

      return { kind: 'completed' }

    case 'already_owned':
      await refreshAtumStoreCatalog(true).catch(() => null)
      clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

      return { kind: 'already_owned' }

    case 'offer_changed':
      // The price the person confirmed is gone and nothing was charged. The
      // key retires with it — the platform refuses one key across two offers.
      clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

      return {
        kind: 'offer_changed',
        offer: { id: result.offer.id, version: result.offer.version, priceProtons: result.offer.price_protons }
      }

    case 'refunded':
      clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

      return { kind: 'failed' }
  }
}

/** The platform's refusal codes arrive as thrown transport errors whose
 *  message carries the code; the wire's outcome union carries the rest. */
function classifyFailure(
  accountId: string,
  kind: AtumStoreItemKind,
  itemId: string,
  attempt: AtumStorePurchaseAttempt,
  error: unknown
): StorePurchaseOutcome {
  const code = errorCode(error)

  if (code.includes('insufficient_protons')) {
    // A refusal, not an ambiguity: nothing was attempted against the wallet.
    clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

    return { kind: 'insufficient_protons' }
  }

  if (code.includes('idempotency_conflict') || code.includes('offer_unavailable')) {
    // The key was seen with another offer, or the offer is gone: this
    // confirmation is dead. The next one mints fresh.
    clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

    return { kind: 'failed' }
  }

  if (code.includes('feature_unavailable')) {
    // The commercial spending switch is off. The platform refuses before any
    // write, so nothing was charged and nothing is ambiguous — and the attempt
    // MUST NOT survive: a later 'check status' on the same key, once the switch
    // is turned on, would commit a real charge from what the person was told
    // was a status check.
    clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

    return { kind: 'unavailable' }
  }

  if (code.includes('forbidden') || code.includes('not_found') || code.includes('invalid_request')) {
    // A refusal the platform answered BEFORE any write (a suspended membership,
    // an unknown purchase id, a malformed request): nothing was charged and
    // nothing is ambiguous. Retrying the same key gets the same answer, so the
    // attempt ends here — only an ambiguous TRANSPORT outcome is uncertain.
    clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

    return { kind: 'failed' }
  }

  if (code.includes('auth_unavailable')) {
    // No token to send with: the request never left this machine.
    clearAttempt(accountId, kind, itemId, attempt.idempotencyKey, attempt.assistantId)

    return { kind: 'failed' }
  }

  if (code.includes('account_context')) {
    // The account moved under the purchase. The fence is checked AFTER the
    // call returns, so the debit may already have committed — this is an
    // ambiguity, not a refusal, and must not be reported as "nothing was
    // charged". The attempt stays with its account (the attempts map is
    // account-scoped) for that account's return.
    return { kind: 'uncertain' }
  }

  // A timeout or a dropped connection after the request left: the purchase
  // may be committed. The persisted key is the recovery handle.
  return { kind: 'uncertain' }
}

export interface StorePurchaseInput {
  assistantId?: string | null
  accountId: string
  kind: AtumStoreItemKind
  itemId: string
  offer: AtumStoreOffer
}

/**
 * Confirm the displayed offer. Mints (or reuses) the idempotency key, POSTs
 * the purchase, and translates the reply. The dialogs own the asking; this
 * owns the never-charge-twice rules.
 */
export async function runStorePurchase(input: StorePurchaseInput): Promise<StorePurchaseOutcome> {
  const bridge = storeBridge()

  if (!bridge) {
    return { kind: 'failed' }
  }

  // The attempt belongs to the account that confirmed it. If the scope has
  // moved on (A → B), sending A's key now would be a FRESH purchase for B —
  // the platform keys idempotency per (user, key). Refuse, and leave the
  // attempt untouched for A's return.
  if ($atumAccountScopeId.get() !== input.accountId) {
    return { kind: 'failed' }
  }

  if (input.kind === 'skill' && (!input.assistantId || !UUID.test(input.assistantId))) {
    return { kind: 'failed' }
  }
  const attempt = beginStorePurchase(input.accountId, input.kind, input.itemId, input.offer, input.assistantId ?? null)

  try {
    const result = await bridge.purchase(
      input.offer.id,
      input.offer.version,
      attempt.idempotencyKey,
      input.accountId,
      attempt.assistantId
    )

    return await settleOutcome(input.accountId, input.kind, input.itemId, attempt, result)
  } catch (error) {
    const failure = classifyFailure(input.accountId, input.kind, input.itemId, attempt, error)

    if (
      failure.kind !== 'uncertain' ||
      errorCode(error).includes('account_context') ||
      $atumAccountScopeId.get() !== input.accountId
    ) {
      return failure
    }

    // The purchase endpoint is idempotent for this persisted key. A lost reply
    // is safe to ask for once more with that exact key; this recovers the common
    // "charge committed, response dropped" path without minting a second charge.
    try {
      const recovered = await bridge.purchase(
        attempt.offerId,
        attempt.offerVersion,
        attempt.idempotencyKey,
        input.accountId,
        attempt.assistantId
      )

      return await settleOutcome(input.accountId, input.kind, input.itemId, attempt, recovered)
    } catch (recoveryError) {
      return classifyFailure(input.accountId, input.kind, input.itemId, attempt, recoveryError)
    }
  }
}

/**
 * Recovery after an ambiguous outcome. With a known purchase id this is the
 * owner-bound status lookup (W5.4); without one it is the idempotent replay —
 * same key, same offer — which the platform answers with the original result.
 * Both are safe to repeat.
 */
export async function recoverStorePurchase(input: {
  assistantId?: string | null
  accountId: string
  kind: AtumStoreItemKind
  itemId: string
}): Promise<StorePurchaseOutcome> {
  const bridge = storeBridge()
  const attempt = storePurchaseAttemptFor(input.accountId, input.kind, input.itemId, input.assistantId ?? null)

  if (!bridge || !attempt) {
    return { kind: 'failed' }
  }

  // Same fence as the first send: replaying A's key while the scope is B would
  // be a fresh purchase for B, not a recovery of A's.
  if ($atumAccountScopeId.get() !== input.accountId) {
    return { kind: 'failed' }
  }

  try {
    if (attempt.purchaseId) {
      const status = await bridge.purchaseStatus(attempt.purchaseId)

      if (
        status.entitlement?.state === 'active' &&
        status.entitlement.assistant_id === attempt.assistantId &&
        status.entitlement.id === input.itemId &&
        status.entitlement.kind === input.kind
      ) {
        publishEntitlement(input.accountId, status.entitlement)
        await refreshAtumStoreCatalog(true).catch(() => null)
        clearAttempt(input.accountId, input.kind, input.itemId, attempt.idempotencyKey, attempt.assistantId)

        return { kind: 'completed' }
      }

      if (status.purchase.status === 'refunded') {
        clearAttempt(input.accountId, input.kind, input.itemId, attempt.idempotencyKey, attempt.assistantId)

        return { kind: 'failed' }
      }

      return { kind: 'uncertain' }
    }

    const result = await bridge.purchase(
      attempt.offerId,
      attempt.offerVersion,
      attempt.idempotencyKey,
      input.accountId,
      attempt.assistantId
    )

    return await settleOutcome(input.accountId, input.kind, input.itemId, attempt, result)
  } catch (error) {
    return classifyFailure(input.accountId, input.kind, input.itemId, attempt, error)
  }
}
