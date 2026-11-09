import { z } from 'zod'

import {
  type MatrixCompanyNativeContext,
  MatrixCompanyNativeError,
  matrixCompanyNativeFetch,
  matrixCompanyRetryAfter,
  matrixCompanyStatusError
} from './matrix-company-ai'

/**
 * D1 native consumer for `atum.company-funding/2`.
 *
 * Wallet and pack reads are owner/admin. Order creation and order reads are
 * owner only. An ordinary member receives HTTP 403 on all four routes; this
 * module turns that into a typed member refusal and deliberately never reads a
 * body that could contain balances. The member surface uses
 * `MatrixCompanyAIView.enabled/state` instead.
 *
 * `atum.company-funding/2.1` adds one owner/admin mutation: fund the company
 * wallet from the caller's own Protons (POST /wallet/fund, whole Protons). The
 * server picks the buckets (promo first, then paid) and returns the split.
 *
 * Requests name only a company, a request UUID, a pack id or an order UUID.
 * The server selects price, order code and the PayOS checkout URL; a renderer
 * cannot supply companyId, purchasedBy, amount, provider state or a redirect.
 */

export const MATRIX_COMPANY_FUNDING_PROFILE = 'atum.company-funding/2' as const
export const MATRIX_COMPANY_FUNDING_SCHEMA_VERSION = 2 as const
export const MATRIX_COMPANY_FUNDING_WIRE_HEADER = 'X-Atum-Company-Funding' as const
export const MATRIX_COMPANY_FUNDING_WIRE_VALUE = '2' as const
export const MATRIX_MICRO_PROTONS_PER_PROTON = 1_000_000 as const
export const MATRIX_COMPANY_MEMBER_FUND_MAX_PROTONS = 1_000_000 as const

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const microProtons = counter
const positiveMicroProtons = generation
const packId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/u)
/**
 * The one definition of a trusted PayOS checkout URL. The funding parser uses it on
 * every platform answer, and the main process re-runs it at the `shell.openExternal`
 * boundary so a renderer or a compromised platform body can never choose a target.
 */
export const trustedPayOSUrl = z
  .string()
  .url()
  .max(2048)
  .refine(value => {
    const url = new URL(value)

    return (
      url.protocol === 'https:' &&
      url.hostname === 'pay.payos.vn' &&
      url.username === '' &&
      url.password === '' &&
      /^\/web\/[A-Za-z0-9_-]{1,128}$/u.test(url.pathname) &&
      url.search === '' &&
      url.hash === ''
    )
  }, 'checkoutUrl must be an exact PayOS HTTPS web URL')

export function isTrustedPayOSUrl(value: unknown): value is string {
  return trustedPayOSUrl.safeParse(value).success
}

export const MatrixCompanyWalletBalancesSchema = z
  .object({
    paid: microProtons,
    earned: microProtons,
    promo: microProtons,
    held: microProtons,
    available: microProtons
  })
  .strict()
export type MatrixCompanyWalletBalances = z.infer<typeof MatrixCompanyWalletBalancesSchema>

export const MatrixCompanyWalletSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_FUNDING_SCHEMA_VERSION),
    companyId: uuid,
    unit: z.literal('micro_proton'),
    balances: MatrixCompanyWalletBalancesSchema,
    checkoutOpen: z.boolean(),
    canTopUp: z.boolean(),
    aiEnabled: z.boolean(),
    policyRevision: generation
  })
  .strict()
  .superRefine((value, context) => {
    const available = value.balances.paid + value.balances.earned + value.balances.promo - value.balances.held

    if (!Number.isSafeInteger(available) || value.balances.available !== available) {
      context.addIssue({
        code: 'custom',
        path: ['balances', 'available'],
        message: 'available balance must equal funded buckets less holds'
      })
    }
  })
export type MatrixCompanyWallet = z.infer<typeof MatrixCompanyWalletSchema>

export const MatrixCompanyProtonPackSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_FUNDING_SCHEMA_VERSION),
    packId,
    protons: generation,
    paidMicroProtons: positiveMicroProtons,
    promoMicroProtons: microProtons,
    totalMicroProtons: positiveMicroProtons,
    amountVnd: generation
  })
  .strict()
  .superRefine((value, context) => {
    if (value.totalMicroProtons !== value.paidMicroProtons + value.promoMicroProtons) {
      context.addIssue({ code: 'custom', path: ['totalMicroProtons'], message: 'pack buckets must sum exactly' })
    }

    if (value.totalMicroProtons !== value.protons * MATRIX_MICRO_PROTONS_PER_PROTON) {
      context.addIssue({ code: 'custom', path: ['protons'], message: 'one Proton is exactly 1,000,000 micro-Protons' })
    }
  })
export type MatrixCompanyProtonPack = z.infer<typeof MatrixCompanyProtonPackSchema>

export const MatrixCompanyProtonPackCatalogSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_FUNDING_SCHEMA_VERSION),
    companyId: uuid,
    packs: z.array(MatrixCompanyProtonPackSchema).max(16)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.packs.map(pack => pack.packId)).size !== value.packs.length) {
      context.addIssue({ code: 'custom', path: ['packs'], message: 'pack ids must be unique' })
    }
  })
export type MatrixCompanyProtonPackCatalog = z.infer<typeof MatrixCompanyProtonPackCatalogSchema>

export const MatrixCompanyProtonOrderCreateSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_FUNDING_SCHEMA_VERSION),
    requestId: uuid,
    packId
  })
  .strict()
export type MatrixCompanyProtonOrderCreate = z.infer<typeof MatrixCompanyProtonOrderCreateSchema>

export const MatrixCompanyProtonOrderSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_FUNDING_SCHEMA_VERSION),
    companyId: uuid,
    orderId: uuid,
    packId,
    protons: generation,
    state: z.enum(['creating', 'pending', 'paid', 'cancelled', 'expired']),
    credited: z.boolean(),
    checkoutUrl: trustedPayOSUrl.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.credited && value.state !== 'paid') {
      context.addIssue({ code: 'custom', path: ['credited'], message: 'only a verified paid order is credited' })
    }

    if (value.checkoutUrl !== undefined && value.state !== 'pending') {
      context.addIssue({ code: 'custom', path: ['checkoutUrl'], message: 'only a pending order carries checkoutUrl' })
    }
  })
export type MatrixCompanyProtonOrder = z.infer<typeof MatrixCompanyProtonOrderSchema>

const memberFundProtons = z.number().int().min(1).max(MATRIX_COMPANY_MEMBER_FUND_MAX_PROTONS)

/** 2.1 answer: the transfer and the company wallet as the caller now sees it. */
export const MatrixCompanyMemberFundSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_FUNDING_SCHEMA_VERSION),
    companyId: uuid,
    requestId: uuid,
    protons: memberFundProtons,
    amountMicroProtons: positiveMicroProtons,
    fromPromoMicroProtons: microProtons,
    fromPaidMicroProtons: microProtons,
    wallet: MatrixCompanyWalletSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.amountMicroProtons !== value.protons * MATRIX_MICRO_PROTONS_PER_PROTON) {
      context.addIssue({ code: 'custom', path: ['amountMicroProtons'], message: 'one Proton is exactly 1,000,000 micro-Protons' })
    }

    if (value.fromPromoMicroProtons + value.fromPaidMicroProtons !== value.amountMicroProtons) {
      context.addIssue({ code: 'custom', path: ['fromPaidMicroProtons'], message: 'the bucket split must sum to the amount' })
    }

    if (value.wallet.companyId !== value.companyId) {
      context.addIssue({ code: 'custom', path: ['wallet', 'companyId'], message: 'the wallet must be the funded company' })
    }
  })
export type MatrixCompanyMemberFund = z.infer<typeof MatrixCompanyMemberFundSchema>

export const MatrixCompanyFundingErrorSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_FUNDING_SCHEMA_VERSION),
    error: z
      .object({ code: z.enum(['denied', 'budget_exhausted', 'conflict', 'unavailable', 'insufficient_protons']) })
      .strict()
  })
  .strict()

/* ------------------------------------------------------------------ IPC vocabulary */

export const MatrixCompanyFundingRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('funding-wallet'), companyId: uuid }).strict(),
  z.object({ action: z.literal('funding-packs'), companyId: uuid }).strict(),
  z
    .object({
      action: z.literal('funding-order-create'),
      companyId: uuid,
      requestId: uuid,
      packId
    })
    .strict(),
  z
    .object({
      action: z.literal('funding-order'),
      companyId: uuid,
      orderId: uuid
    })
    .strict(),
  z
    .object({
      action: z.literal('funding-member-fund'),
      companyId: uuid,
      requestId: uuid,
      protons: memberFundProtons
    })
    .strict(),
  /** Native-only read of this account's unresolved transfer for the company; no network. */
  z.object({ action: z.literal('funding-member-fund-pending'), companyId: uuid }).strict()
])

export type MatrixCompanyFundingRequest = z.infer<typeof MatrixCompanyFundingRequestSchema>
export type MatrixCompanyFundingMutation = Extract<
  MatrixCompanyFundingRequest,
  { action: 'funding-order-create' | 'funding-member-fund' }
>
/**
 * A transfer that was submitted but never got a definite answer. Native keeps it in the
 * account's durable intent journal; the renderer offers only "retry the same request".
 */
export interface MatrixCompanyMemberFundPending {
  pending: { requestId: string; protons: number } | null
}

export type MatrixCompanyFundingValue =
  | MatrixCompanyWallet
  | MatrixCompanyProtonPackCatalog
  | MatrixCompanyProtonOrder
  | MatrixCompanyMemberFund
  | MatrixCompanyMemberFundPending

/**
 * A member never receives a wallet projection. The 403 is a typed refusal, not
 * a value: the renderer pairs it with the Company AI view for the pause state.
 */
export class MatrixCompanyFundingMemberError extends MatrixCompanyNativeError {
  /** The ordinary member path: pair this refusal with `CompanyAIView.enabled/state`. */
  readonly member = true

  constructor() {
    super('denied')
    this.name = 'MatrixCompanyFundingMemberError'
  }
}

export function parseMatrixCompanyFundingRequest(value: unknown): MatrixCompanyFundingRequest {
  const parsed = MatrixCompanyFundingRequestSchema.safeParse(value)

  if (!parsed.success) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return parsed.data
}

export function isMatrixCompanyFundingMutation(
  input: MatrixCompanyFundingRequest
): input is MatrixCompanyFundingMutation {
  return input.action === 'funding-order-create' || input.action === 'funding-member-fund'
}

export function parseMatrixCompanyFundingResponse(
  value: unknown,
  input: MatrixCompanyFundingRequest
): MatrixCompanyFundingValue {
  if (input.action === 'funding-wallet') {
    const parsed = MatrixCompanyWalletSchema.safeParse(value)

    if (!parsed.success || parsed.data.companyId !== input.companyId) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  if (input.action === 'funding-packs') {
    const parsed = MatrixCompanyProtonPackCatalogSchema.safeParse(value)

    if (!parsed.success || parsed.data.companyId !== input.companyId) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  if (input.action === 'funding-member-fund-pending') {
    throw new MatrixCompanyNativeError('invalid')
  }

  if (input.action === 'funding-member-fund') {
    const parsed = MatrixCompanyMemberFundSchema.safeParse(value)

    if (
      !parsed.success ||
      parsed.data.companyId !== input.companyId ||
      parsed.data.requestId !== input.requestId ||
      parsed.data.protons !== input.protons
    ) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  const parsed = MatrixCompanyProtonOrderSchema.safeParse(value)

  if (!parsed.success || parsed.data.companyId !== input.companyId) {
    throw new MatrixCompanyNativeError('invalid')
  }

  if (input.action === 'funding-order-create' && parsed.data.packId !== input.packId) {
    throw new MatrixCompanyNativeError('invalid')
  }

  if (input.action === 'funding-order' && parsed.data.orderId !== input.orderId) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return parsed.data
}

/* ------------------------------------------------------------------ native routes */

export interface MatrixCompanyFundingRoute {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

export function matrixCompanyFundingRoute(input: MatrixCompanyFundingRequest): MatrixCompanyFundingRoute {
  const base = `/companies/${input.companyId}/wallet`

  if (input.action === 'funding-wallet') {
    return { method: 'GET', path: base }
  }

  if (input.action === 'funding-packs') {
    return { method: 'GET', path: `${base}/packs` }
  }

  if (input.action === 'funding-order-create') {
    return {
      method: 'POST',
      path: `${base}/orders`,
      body: {
        schemaVersion: MATRIX_COMPANY_FUNDING_SCHEMA_VERSION,
        requestId: input.requestId,
        packId: input.packId
      }
    }
  }

  if (input.action === 'funding-member-fund') {
    return {
      method: 'POST',
      path: `${base}/fund`,
      body: {
        schemaVersion: MATRIX_COMPANY_FUNDING_SCHEMA_VERSION,
        requestId: input.requestId,
        protons: input.protons
      }
    }
  }

  if (input.action === 'funding-member-fund-pending') {
    // Answered from the native journal; it never reaches the network.
    throw new MatrixCompanyNativeError('invalid')
  }

  return { method: 'GET', path: `${base}/orders/${input.orderId}` }
}

export function matrixCompanyFundingHeaders(): Record<string, string> {
  return { [MATRIX_COMPANY_FUNDING_WIRE_HEADER]: MATRIX_COMPANY_FUNDING_WIRE_VALUE }
}

/** Owner/admin read. A 403 is the member path and returns no balance-shaped value. */
export async function requestMatrixCompanyFundingValue(
  context: MatrixCompanyNativeContext,
  input: MatrixCompanyFundingRequest
): Promise<MatrixCompanyFundingValue> {
  const route = matrixCompanyFundingRoute(input)
  const result = await matrixCompanyNativeFetch(context, {
    ...route,
    headers: matrixCompanyFundingHeaders()
  })

  if (result.status === 403) {
    // The funding failure body is intentionally not parsed into a value here.
    throw new MatrixCompanyFundingMemberError()
  }

  if (result.status !== 200) {
    const parsed = MatrixCompanyFundingErrorSchema.safeParse(result.body)

    if (parsed.success && fundingCodeStatus(parsed.data.error.code) === result.status) {
      const code =
        parsed.data.error.code === 'denied'
          ? 'denied'
          : parsed.data.error.code === 'budget_exhausted'
            ? 'budget_exhausted'
            : parsed.data.error.code === 'conflict'
              ? 'conflict'
              : parsed.data.error.code === 'insufficient_protons'
                ? 'insufficient_protons'
                : 'unavailable'

      throw new MatrixCompanyNativeError(code, result.retryAfterSeconds, parsed.data.error.code)
    }

    throw matrixCompanyStatusError(result.status)
  }

  return parseMatrixCompanyFundingResponse(result.body, input)
}

function fundingCodeStatus(
  code: 'denied' | 'budget_exhausted' | 'conflict' | 'unavailable' | 'insufficient_protons'
): number {
  return code === 'denied'
    ? 403
    : code === 'budget_exhausted'
      ? 402
      : code === 'conflict' || code === 'insufficient_protons'
        ? 409
        : 503
}

export { matrixCompanyRetryAfter }
