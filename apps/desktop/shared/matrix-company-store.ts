import { z } from 'zod'

import type { MatrixStoreEntitlement, MatrixStoreItem } from './matrix-store'
import { storeEntitlement, storeItem, storeResult } from './matrix-store-contract'

/** Mirrored from atum-platform feat/company-store fb791ccc23; no cross-repo imports. */
export const COMPANY_STORE_HEADER = 'X-Atum-Company-Store'
export const COMPANY_STORE_VERSION = '1'
export const COMPANY_STORE_PROFILE = 'atum.company-store/1'
export const CompanyStorePurchaseRequestSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  offerId: z.uuid(),
  offerVersion: z.number().int().positive(),
  target: z.union([z.strictObject({ agentId: z.uuid() }), z.strictObject({ hire: z.strictObject({}) })]),
  consentRenewal: z.literal(true).optional()
})
export type MatrixCompanyStorePurchaseRequest = z.infer<typeof CompanyStorePurchaseRequestSchema>
export type MatrixCompanyStoreIntent = Omit<MatrixCompanyStorePurchaseRequest, 'idempotencyKey'>

function publicSchema<T>(parse: (value: unknown) => T) {
  return z.unknown().transform((value, ctx) => {
    try {
      return parse(value)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid Store value' })

      return z.NEVER
    }
  })
}

export const CompanyStoreItemSchema = z.intersection(
  publicSchema(storeItem),
  z.object({
    deliverable: z.boolean(),
    ownership: z.strictObject({
      state: z.enum(['owned', 'visiting', 'available']),
      source: z.enum(['purchase', 'gift', 'compensation', 'promo', 'visit']).nullable(),
      assistantIds: z.array(z.uuid()),
      until: z.iso.datetime().nullable()
    })
  })
)
export const CompanyStoreCatalogSchema = z.strictObject({
  profile: z.literal(COMPANY_STORE_PROFILE),
  viewer: z.strictObject({ canAct: z.boolean() }),
  items: z.array(CompanyStoreItemSchema)
})
export const CompanyStoreResultSchema = z.intersection(
  publicSchema(storeResult),
  z.object({
    agentId: z.uuid().optional(),
    shortfallMicroProtons: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
)

/** Company entitlements use the source-aware Store projection; older source-less grants are purchases. */
export function companyStoreEntitlement(value: unknown) {
  const entitlement = storeEntitlement(value)

  return { ...entitlement, source: entitlement.source ?? ('purchase' as const) }
}

export const CompanyStoreEntitlementsSchema = z.strictObject({
  entitlements: z.array(publicSchema(companyStoreEntitlement))
})
export const CompanyStoreAgentSchema = z.strictObject({
  agentId: z.uuid(),
  matrixUserId: z.string().nullable(),
  name: z.string(),
  avatar: z.string().nullable(),
  itemId: z.string(),
  state: z.enum(['preparing', 'ready', 'paused', 'ending']),
  renewAt: z.iso.datetime().nullable()
})
export const CompanyStoreAgentsSchema = z.strictObject({ agents: z.array(CompanyStoreAgentSchema) })
export type MatrixCompanyStoreAgent = z.infer<typeof CompanyStoreAgentSchema>
export type MatrixCompanyStoreResult = z.infer<typeof CompanyStoreResultSchema>
export type MatrixCompanyStoreActionResult =
  | MatrixCompanyStoreResult
  | { outcome: 'uncertain' }
  | { outcome: 'refused'; code: 'denied' | 'conflict' | 'invalid_request' | 'unauthenticated' | 'rate_limited' }
export interface MatrixCompanyStorePending extends MatrixCompanyStorePurchaseRequest {
  purchaseId: string | null
}
export interface MatrixCompanyStoreSnapshot {
  companyId: string
  state: 'loading' | 'ready' | 'stale' | 'unavailable'
  capability: 'unknown' | 'supported' | 'absent'
  /** Capability plus at least one deliverable listing: no dead Marketplace tab. */
  marketplaceAvailable: boolean
  viewer: { canAct: boolean }
  items: MatrixStoreItem[]
  entitlements: MatrixStoreEntitlement[]
  agents: MatrixCompanyStoreAgent[]
  pending: MatrixCompanyStorePending[]
}
export interface MatrixCompanyStoreBridge {
  refresh(companyId: string): Promise<MatrixCompanyStoreSnapshot>
  purchase(companyId: string, input: MatrixCompanyStoreIntent): Promise<MatrixCompanyStoreActionResult>
  resume(companyId: string, idempotencyKey: string): Promise<MatrixCompanyStoreActionResult>
  cancel(companyId: string, entitlementId: string): Promise<void>
}

/** Pass directly to the existing company-wallet funding surface; members never receive balances. */
export function companyStoreFundPrefill(companyId: string, result: MatrixCompanyStoreActionResult) {
  return result.outcome === 'refused' &&
    result.code === 'insufficient_protons' &&
    'shortfallMicroProtons' in result &&
    result.shortfallMicroProtons !== undefined
    ? { companyId, shortfallMicroProtons: result.shortfallMicroProtons }
    : null
}

/** Bound identities only. The caller merges these with the included CoS for mentions/DMs. */
export function companyStoreMentionAgents(agents: readonly MatrixCompanyStoreAgent[]) {
  return agents.filter(
    (agent): agent is MatrixCompanyStoreAgent & { matrixUserId: string } =>
      agent.matrixUserId !== null && /^@[^:]+:.+$/.test(agent.matrixUserId)
  )
}

const CompanyStoreIntentSchema = CompanyStorePurchaseRequestSchema.omit({ idempotencyKey: true })
export const CompanyStoreBridgeRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('refresh'), companyId: z.uuid() }),
  z.strictObject({ action: z.literal('purchase'), companyId: z.uuid(), input: CompanyStoreIntentSchema }),
  z.strictObject({ action: z.literal('resume'), companyId: z.uuid(), idempotencyKey: z.uuid() }),
  z.strictObject({ action: z.literal('cancel'), companyId: z.uuid(), entitlementId: z.uuid() })
])
