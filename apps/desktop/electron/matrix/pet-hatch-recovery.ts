import { MATRIX_PET_DEFAULT_SCALE } from '../../shared/matrix-pet'
import type { MatrixStoreResult } from '../../shared/matrix-store'

export interface MatrixPetPaymentIntent {
  accountKey: string
  operationId: string
  offerId: string
  offerVersion: number
  purchaseKey?: string
  creditEntitlementId?: string
}

/** The size a hatched pet is saved at: the agent's current pet's size, or the same
 * default a first pick and the unsaved stand-in use, so hatching never resizes. */
export function matrixPetHatchScale(current: { scale: number } | null | undefined): number {
  return current?.scale ?? MATRIX_PET_DEFAULT_SCALE
}

/** A withdrawn credit or denied publication needs a foreground decision.
 * Transport failures may resume, but permanent responses must not loop. */
export function matrixPetPublicationNeedsAttention(error: unknown): boolean {
  return /matrix_agent_definition_(invalid|conflict|missing|denied)|payload_too_large|pet_credit_reserved/u.test(String(error))
}

/** Main-only payment recovery. Persist a known key before the Store journal
 * can dispatch, including its automatic restart recovery. No new financial
 * attempt is ever created by a background retry. */
export async function recoverMatrixPetCredit<T extends MatrixPetPaymentIntent>(
  original: T,
  port: {
    save(intent: T): void
    clear(accountKey: string): void
    resume(
      key: string,
      terms: { offerId: string; offerVersion: number }
    ): Promise<MatrixStoreResult | { outcome: 'uncertain' }>
  },
  allowPurchase = false
): Promise<T & { creditEntitlementId: string }> {
  let intent = original
  if (intent.creditEntitlementId) {return intent as T & { creditEntitlementId: string }}
  if (!intent.purchaseKey) {
    if (!allowPurchase) {throw new Error('matrix_pet_recovery_needs_confirmation')}
    intent = { ...intent, purchaseKey: intent.operationId }
    port.save(intent)
  }
  const result = await port.resume(intent.purchaseKey, { offerId: intent.offerId, offerVersion: intent.offerVersion })
  if (result.outcome === 'uncertain') {throw new Error('matrix_pet_uncertain')}
  if (
    result.outcome === 'offer_changed' ||
    result.outcome === 'refused' ||
    (result.outcome === 'purchased' && result.purchase.state === 'reversed')
  ) {
    port.clear(intent.accountKey)
    throw new Error(
      result.outcome === 'offer_changed'
        ? 'matrix_pet_price_changed'
        : result.outcome === 'refused'
          ? `matrix_pet_refused_${result.code}`
          : 'matrix_pet_purchase_reversed'
    )
  }
  if (result.outcome === 'purchased' && result.purchase.state !== 'completed') {throw new Error('matrix_pet_recovering')}
  const entitlement = result.entitlement
  if (
    !entitlement ||
    entitlement.state !== 'active' ||
    entitlement.kind !== 'pet' ||
    entitlement.assistantId !== null ||
    !['pet/hatch', 'pet/hatch-first'].includes(entitlement.itemId)
  ) {
    throw new Error('matrix_pet_recovering')
  }
  const ready = { ...intent, creditEntitlementId: entitlement.id }
  port.save(ready)
  return ready
}

/** IPC and lifecycle recovery share one flight, including synchronous publish
 * callbacks. Only this flight updates the retry clock after an outcome. */
export class MatrixPetRecoveryFlights<T> {
  private readonly active = new Map<string, Promise<T>>()
  private readonly retries = new Map<string, { attempts: number; after: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  busy(accountKey: string): boolean {
    return this.active.has(accountKey)
  }

  run(accountKey: string, work: () => Promise<T>): Promise<T> {
    const existing = this.active.get(accountKey)
    if (existing) {return existing}
    const promise = Promise.resolve()
      .then(work)
      .then(
        value => {
          this.retries.delete(accountKey)
          return value
        },
        error => {
          const attempts = Math.min((this.retries.get(accountKey)?.attempts ?? 0) + 1, 9)
          this.retries.set(accountKey, { attempts, after: this.now() + Math.min(300_000, 1_000 * 2 ** attempts) })
          throw error
        }
      )
      .finally(() => {
        if (this.active.get(accountKey) === promise) {this.active.delete(accountKey)}
      })
    this.active.set(accountKey, promise)
    return promise
  }

  background(accountKey: string, work: () => Promise<T>): Promise<void> {
    const existing = this.active.get(accountKey)
    if (existing)
      {return existing.then(
        () => {},
        () => {}
      )}
    if (this.now() < (this.retries.get(accountKey)?.after ?? 0)) {return Promise.resolve()}
    return this.run(accountKey, work).then(
      () => {},
      () => {}
    )
  }
}

/** Preserve corrupt evidence before removing only its active hatch key. Disk
 * or encryption failures must never escape a cosmetic lifecycle callback. */
export function quarantineMatrixPetRecord(
  store:
    | { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
    | undefined,
  activeKey: string,
  quarantineKey: string
): boolean {
  try {
    const raw = store?.getItem(activeKey)
    if (!store || !raw || raw.length > 4_300_000) {return false}
    // Keep the first malformed record intact; subsequent corruption stays in
    // the active key until an operator reconciles it.
    if (store.getItem(quarantineKey)) {return false}
    store.setItem(quarantineKey, raw)
    store.removeItem(activeKey)
    return true
  } catch {
    return false
  }
}
