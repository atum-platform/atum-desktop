import { atom } from 'nanostores'

import type {
  MatrixCompanyStoreActionResult,
  MatrixCompanyStoreBridge,
  MatrixCompanyStoreIntent,
  MatrixCompanyStoreSnapshot
} from '../../shared/matrix-company-store'

import type { CompanySpaceTab } from './company-space-store'

/**
 * The company Store native owns (`window.atumMatrix.companyStore`): one bridge, keyed by company in
 * the path. It never takes a payer, a price or a role from the renderer, and there is no way from
 * here to the personal Store's purchase.
 */
export function companyStoreBridge(): MatrixCompanyStoreBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return (window as unknown as { atumMatrix?: { companyStore?: MatrixCompanyStoreBridge } }).atumMatrix?.companyStore
}

/** The latest company Store snapshot per `companySpaceScope` (account and company). */
export const $companyMarketplaces = atom<Record<string, MatrixCompanyStoreSnapshot>>({})

const readSerials = new Map<string, number>()

function publish(scope: string, snapshot: MatrixCompanyStoreSnapshot) {
  $companyMarketplaces.set({ ...$companyMarketplaces.get(), [scope]: snapshot })
}

/**
 * The Marketplace page exists when the Shell answers `atum.company-store/1` and there is something
 * a company can actually get (no dead tab), or when the company already has hires or an unconfirmed
 * purchase to look after.
 */
export function companyMarketplaceVisible(snapshot: MatrixCompanyStoreSnapshot | undefined): boolean {
  if (!snapshot) {
    return false
  }

  return (
    snapshot.marketplaceAvailable ||
    (snapshot.capability === 'supported' && (snapshot.agents.length > 0 || snapshot.pending.length > 0))
  )
}

/** The company's title pages, in order: Chat · Board, then Marketplace while it is there. */
export function companySpaceTabIds(snapshot: MatrixCompanyStoreSnapshot | undefined): readonly CompanySpaceTab[] {
  return companyMarketplaceVisible(snapshot) ? ['chat', 'board', 'marketplace'] : ['chat', 'board']
}

/** A remembered page that is not there any more opens Chat. */
export function effectiveCompanySpaceTab(
  tab: CompanySpaceTab,
  snapshot: MatrixCompanyStoreSnapshot | undefined
): CompanySpaceTab {
  return companySpaceTabIds(snapshot).includes(tab) ? tab : 'chat'
}

export async function refreshCompanyMarketplace(
  scope: string,
  companyId: string
): Promise<MatrixCompanyStoreSnapshot | undefined> {
  const bridge = companyStoreBridge()

  if (!bridge) {
    return undefined
  }

  const serial = (readSerials.get(scope) ?? 0) + 1
  readSerials.set(scope, serial)

  try {
    const snapshot = await bridge.refresh(companyId)

    if (readSerials.get(scope) === serial && snapshot.companyId === companyId) {
      publish(scope, snapshot)
    }

    return snapshot
  } catch {
    const previous = $companyMarketplaces.get()[scope]

    if (readSerials.get(scope) === serial) {
      publish(
        scope,
        previous
          ? { ...previous, state: previous.state === 'ready' || previous.state === 'stale' ? 'stale' : 'unavailable' }
          : {
              companyId,
              state: 'unavailable',
              capability: 'unknown',
              marketplaceAvailable: false,
              viewer: { canAct: false },
              items: [],
              entitlements: [],
              agents: [],
              pending: []
            }
      )
    }

    return undefined
  }
}

async function act(
  scope: string,
  companyId: string,
  run: (bridge: MatrixCompanyStoreBridge) => Promise<MatrixCompanyStoreActionResult>
): Promise<MatrixCompanyStoreActionResult> {
  const bridge = companyStoreBridge()

  if (!bridge) {
    return { outcome: 'uncertain' }
  }

  try {
    return await run(bridge)
  } catch {
    // A lost reply may still have charged: native kept the request and Check again replays it.
    return { outcome: 'uncertain' }
  } finally {
    void refreshCompanyMarketplace(scope, companyId)
  }
}

export function purchaseCompanyItem(scope: string, companyId: string, intent: MatrixCompanyStoreIntent) {
  return act(scope, companyId, bridge => bridge.purchase(companyId, intent))
}

export function resumeCompanyPurchase(scope: string, companyId: string, idempotencyKey: string) {
  return act(scope, companyId, bridge => bridge.resume(companyId, idempotencyKey))
}

export async function cancelCompanyEntitlement(scope: string, companyId: string, entitlementId: string) {
  const bridge = companyStoreBridge()

  if (!bridge) {
    return false
  }

  try {
    await bridge.cancel(companyId, entitlementId)

    return true
  } catch {
    return false
  } finally {
    void refreshCompanyMarketplace(scope, companyId)
  }
}

/** Tests and sign-out: forget every company's snapshot. */
export function resetCompanyMarketplaces() {
  readSerials.clear()
  $companyMarketplaces.set({})
}
