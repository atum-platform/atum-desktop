/** Public Store contract. Exact micro-Protons; no private bodies or credentials. */
export type MatrixStoreKind = 'skill' | 'agent' | 'pet'
export type MatrixStoreGrantSource = 'purchase' | 'gift' | 'compensation' | 'promo'
export interface MatrixStoreOwned {
  state: 'owned'
  source: MatrixStoreGrantSource
  assistantIds: string[]
  until: string | null
}
export interface MatrixStoreVisiting {
  state: 'visiting'
  source: 'visit'
  assistantIds: []
  until: string
}
export interface MatrixStoreAvailable {
  state: 'available'
  source: null
  assistantIds: []
  until: null
}
export type MatrixStoreOwnership = MatrixStoreOwned | MatrixStoreVisiting | MatrixStoreAvailable
/** A free official Hermes skill the Skills Hub installs, with its own scan and confirmation.
 * It never has a price, a grant or an entitlement (Store v1.1, `skills.hub.1`). */
export interface MatrixStoreInstall {
  source: 'hermes_hub'
  /** `official/<category>/<name>`. */
  id: string
}
export interface MatrixStoreOffer {
  id: string
  version: number
  priceMicroProtons: number
  /** Explicit price for subsequent monthly periods. */
  renewalPriceMicroProtons?: number
  scope: 'account' | 'agent'
  billingInterval: 'one_time' | 'month'
  delivery: 'cloud' | 'bundled'
}
export interface MatrixStoreItem {
  itemId: string
  kind: MatrixStoreKind
  title: Record<string, string>
  summary: Record<string, string>
  description: Record<string, string>
  tryPrompt: Record<string, string>
  needs: string[]
  glyph: string
  accent: string
  featured: boolean
  sortOrder: number
  offer: MatrixStoreOffer | null
  ownership?: MatrixStoreOwnership
  deliverable?: boolean
  /** Only on a free skill (`offer: null`) whose item ID is `skill/<install.id>`. */
  install?: MatrixStoreInstall
}
export interface MatrixStoreEntitlement {
  id: string
  itemId: string
  kind: MatrixStoreKind
  state: 'active' | 'revoked'
  assistantId: string | null
  delivery: 'cloud' | 'bundled'
  grantedAt: string
  subscription: null | {
    state: 'active' | 'cancelled' | 'lapsed'
    renewAt: string
    priceMicroProtons: number
    offerVersion: number
  }
  /** Older Shells omit this; absence means purchase. */
  source?: MatrixStoreGrantSource
}
export interface MatrixStorePurchase {
  id: string
  state: 'delivery_pending' | 'granted' | 'completed' | 'reversed'
  itemId: string
  offerId: string
  offerVersion: number
  idempotencyKey: string
  assistantId: string | null
  amountMicroProtons: number
  createdAt: string
}
export interface MatrixStoreIntent {
  offerId: string
  offerVersion: number
  assistantId?: string
  consentRenewal?: true
}
export type MatrixStoreResult =
  | { outcome: 'purchased'; purchase: MatrixStorePurchase; entitlement: MatrixStoreEntitlement | null }
  | { outcome: 'already_owned'; purchase: null; entitlement: MatrixStoreEntitlement }
  | { outcome: 'offer_changed'; offer: MatrixStoreOffer }
  | {
      outcome: 'refused'
      /** The first five come from the Store's own refusal. The last three are this desktop's
       * reading of a definite HTTP refusal (store.ts `refusalForStatus`): the request was
       * turned away before anything was charged. The Store never sends them in a reply body. */
      code:
        | 'insufficient_protons'
        | 'offer_unavailable'
        | 'feature_unavailable'
        | 'forbidden'
        | 'pet_credit_reserved'
        | 'invalid_request'
        | 'unauthenticated'
        | 'rate_limited'
    }
export interface MatrixStorePending extends MatrixStoreIntent {
  idempotencyKey: string
  purchaseId: string | null
  /** Saved before creating the hired agent, using a stable platform request. */
  provision?: { requestId: string; name: string }
}
export interface MatrixStoreSnapshot {
  state: 'loading' | 'ready' | 'stale' | 'unavailable'
  items: MatrixStoreItem[]
  entitlements: MatrixStoreEntitlement[]
  purchases: MatrixStorePurchase[]
  pending: MatrixStorePending[]
}
export interface MatrixStoreBridge {
  refresh(): Promise<void>
  purchase(input: MatrixStoreIntent): Promise<MatrixStoreResult | { outcome: 'uncertain' }>
  resume(idempotencyKey: string): Promise<MatrixStoreResult | { outcome: 'uncertain' }>
  cancel(entitlementId: string): Promise<void>
}
