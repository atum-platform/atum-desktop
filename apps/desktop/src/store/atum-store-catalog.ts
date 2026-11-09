// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { atom } from 'nanostores'

import type {
  AtumStoreCatalogWire,
  AtumStorePurchaseStatusWire,
  AtumStorePurchaseWire,
  AtumTrainingTask
} from '@/lib/atum-store-items'

import type { AtumAgentHire, AtumExecutionTask, AtumHireResult } from '../../shared/atum-hiring'

import { $atumAccountScopeId } from './atum-messaging'

/**
 * The renderer's view of the Atum Store catalog (plan 2026-09-10-atum-store.md,
 * "Renderer"). The shelves read THIS — the catalog the owner publishes — never
 * a constant compiled into the app.
 *
 * Same state machine `$atumAppCatalog` uses, with the same account fence:
 *
 *  - `idle`    — no account scope; the store is signed-out.
 *  - `loading` — first read in flight, nothing to show yet.
 *  - `ready`   — a fresh read is published. A HEALTHY refresh keeps this: the
 *                catalog on screen is not stale until a refresh actually fails.
 *  - `stale`   — a refresh failed; the last good catalog stays on screen
 *                rather than blanking the shelf.
 *  - `error`   — a cold read failed and there is nothing retained.
 *
 * The fence: `$atumAccountScopeId` changing (A → B) bumps the generation and
 * drops A's catalog synchronously, and a refresh that resolves after the
 * switch is refused — a late reply from account A can never publish into
 * account B's shelves. Main holds a second, durable fence; this one keeps the
 * renderer honest on its own.
 */
export type AtumStoreCatalogView =
  | { accountId: null; catalog: null; state: 'idle' }
  | { accountId: string; catalog: AtumStoreCatalogWire | null; state: 'idle' | 'loading' | 'ready' | 'stale' | 'error' }

export const $atumStoreCatalog = atom<AtumStoreCatalogView>({ accountId: null, catalog: null, state: 'idle' })

let catalogGeneration = 0

$atumAccountScopeId.listen(accountId => {
  catalogGeneration += 1
  $atumStoreCatalog.set(accountId ? { accountId, catalog: null, state: 'idle' } : { accountId: null, catalog: null, state: 'idle' })

  // The catalog follows the account, not a visit to Discover. Every surface
  // that prices a bundled item — the storefront shelves, the Pet Store, and
  // the assistant's pet picker — fails closed until the catalog answers, and
  // only the storefront used to ask. A signed-in person opening "Choose a pet"
  // on the chat rail therefore saw every bundled pet greyed out as
  // "Unavailable" until they happened to visit Discover (re-review
  // 2026-09-12). Unforced, so main's durable cache answers offline; failures
  // are the store view's own `error`/`stale`, not an unhandled rejection.
  if (accountId) {
    void refreshAtumStoreCatalog().catch(() => null)
  }
})

/** The renderer's side of the `hermesDesktop.store` bridge. Main owns the
 *  bearer, the signed envelope and every account path; these are the wire
 *  projections it returns, typed in `@/lib/atum-store-items`. */
export interface AtumStoreBridge {
  catalog(): Promise<AtumStoreCatalogWire>
  refresh(): Promise<AtumStoreCatalogWire>
  purchase(
    offerId: string,
    offerVersion: number,
    idempotencyKey: string,
    accountId?: string,
    assistantId?: string | null
  ): Promise<AtumStorePurchaseWire>
  agentHires?(accountId: string): Promise<AtumAgentHire[]>
  hireAgent?(assistantId: string, offerId: string, version: number, key: string, consent: true, accountId: string): Promise<AtumHireResult>
  cancelAgentHire?(hireId: string, accountId: string): Promise<AtumAgentHire>
  startAgentTask?(assistantId: string, conversationId: string, skillId: string | null, accountId: string): Promise<AtumExecutionTask | null>
  startTrainingTask(assistantId: string, conversationId: string, skillId: string, accountId: string): Promise<AtumTrainingTask>
  purchaseStatus(purchaseId: string): Promise<AtumStorePurchaseStatusWire>
}

export function storeBridge(): AtumStoreBridge | null {
  const host = globalThis as typeof globalThis & {
    hermesDesktop?: { store?: AtumStoreBridge }
    window?: { hermesDesktop?: { store?: AtumStoreBridge } }
  }

  return host.hermesDesktop?.store ?? host.window?.hermesDesktop?.store ?? null
}

/** Test/reset seam: forget everything, as an account hand-off does. */
export function clearAtumStoreCatalog(): void {
  catalogGeneration += 1
  $atumStoreCatalog.set({ accountId: null, catalog: null, state: 'idle' })
}

/**
 * Read the catalog through main. `force` goes to the network (main's
 * `refresh`); otherwise main's durable cache may answer. A failed refresh over
 * a warm cache keeps the retained rows as `stale`; only a cold failure is
 * `error`. A refresh in flight over a warm cache changes nothing the shelf
 * shows — `stale` means a refresh FAILED, so a healthy one never flashes the
 * "reconnecting" notice. Resolves null when the account changed under the read.
 */
export async function refreshAtumStoreCatalog(force = false): Promise<AtumStoreCatalogWire | null> {
  const accountId = $atumAccountScopeId.get()

  if (!accountId) {
    $atumStoreCatalog.set({ accountId: null, catalog: null, state: 'idle' })

    return null
  }

  const generation = catalogGeneration
  const prior = $atumStoreCatalog.get()
  const retained = prior.accountId === accountId ? prior.catalog : null

  // A retained catalog keeps its current face while the refresh is out: ready
  // stays ready (a healthy refresh is not a disconnection), stale stays stale.
  $atumStoreCatalog.set({ accountId, catalog: retained, state: retained ? prior.state : 'loading' })

  const bridge = storeBridge()

  try {
    if (!bridge) {
      throw new Error('store_bridge_unavailable')
    }

    const catalog = await (force ? bridge.refresh() : bridge.catalog())

    if (generation !== catalogGeneration || $atumAccountScopeId.get() !== accountId) {
      return null
    }

    $atumStoreCatalog.set({ accountId, catalog, state: 'ready' })

    return catalog
  } catch (error) {
    if (generation === catalogGeneration && $atumAccountScopeId.get() === accountId) {
      $atumStoreCatalog.set({ accountId, catalog: retained, state: retained ? 'stale' : 'error' })
    }

    throw error
  }
}
