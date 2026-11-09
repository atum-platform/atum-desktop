export const MANAGED_MODEL_AUTHORITY_STATES = [
  'ready',
  'insufficient_funds',
  'service_paused',
  'denied',
  'model_unavailable'
] as const

export type ManagedModelAuthorityState = (typeof MANAGED_MODEL_AUTHORITY_STATES)[number]

export const MANAGED_MODEL_ACCESS_ALIASES = ['binh-minh', 'nguyet-thuc', 'nhat-thuc'] as const

export type ManagedModelAccessAlias = (typeof MANAGED_MODEL_ACCESS_ALIASES)[number]

export function parseManagedModelAccessAlias(value: unknown): ManagedModelAccessAlias | null {
  return typeof value === 'string' && MANAGED_MODEL_ACCESS_ALIASES.includes(value as ManagedModelAccessAlias)
    ? (value as ManagedModelAccessAlias)
    : null
}

/**
 * Atum Shell v2 names the three models by what they trade off — fast /
 * balanced / deep — instead of by name (SPEC §2 composer, §6). The mapping
 * follows the models' order of capability and is the owner's to confirm.
 */
export type ManagedModelTier = 'fast' | 'balanced' | 'deep'

export const ATUM_MODEL_TIERS: Record<ManagedModelAccessAlias, ManagedModelTier> = {
  'binh-minh': 'fast',
  'nguyet-thuc': 'balanced',
  'nhat-thuc': 'deep'
}

export function managedModelTier(model: string): ManagedModelTier | null {
  const id = model.trim().toLowerCase()
  const slash = id.lastIndexOf('/')
  const base = slash >= 0 ? id.slice(slash + 1) : id
  const alias = MANAGED_MODEL_ACCESS_ALIASES.find(candidate => base === candidate || base.startsWith(`${candidate}-`))

  return alias ? ATUM_MODEL_TIERS[alias] : null
}

/** The tier word for the composer chip, or `null` for a model outside the three. */
export function managedModelTierLabel(
  model: string,
  copy: { modelBalanced: string; modelDeep: string; modelFast: string }
): string | null {
  const tier = managedModelTier(model)

  return tier === 'fast'
    ? copy.modelFast
    : tier === 'balanced'
      ? copy.modelBalanced
      : tier === 'deep'
        ? copy.modelDeep
        : null
}

export function managedModelAccessLabel(accessAlias: ManagedModelAccessAlias): string {
  return {
    'binh-minh': 'Bình Minh',
    'nguyet-thuc': 'Nguyệt Thực',
    'nhat-thuc': 'Nhật Thực'
  }[accessAlias]
}

/** A funding/eligibility display, never permission to spend. Dispatch checks the wallet again. */
export interface ManagedModelAccessAuthority {
  state: ManagedModelAuthorityState
  access_alias: ManagedModelAccessAlias
  billing_currency: 'protons'
  reason?: 'funding_required' | 'model_reserved'
  alias_version?: string
  display_name?: string
  display_version?: string
  available_protons?: number
  held_protons?: number
  next_quote_protons?: number
}

export const MANAGED_MODEL_TURN_STATES = [
  'reserved',
  'dispatched',
  'settled',
  'reconciliation_pending',
  'expired',
  'corrected',
  'revoked'
] as const

export type ManagedModelTurnState = (typeof MANAGED_MODEL_TURN_STATES)[number]

/** One account-owned managed turn as projected by `GET /api/managed-model/usage`. */
export interface ManagedModelUsageTurn {
  access_alias: ManagedModelAccessAlias
  actual_microcredits: number | null
  cache_hit_tokens: number
  completion_tokens: number
  display_name?: string
  prompt_tokens: number
  provider_calls: number
  quoted_microcredits: number
  reservation_id: string
  settled_at: string | null
  started_at: string
  status: ManagedModelTurnState
}

export type ManagedModelUsageSnapshot =
  | { state: 'authentication_expired' | 'unavailable' }
  | { state: 'resolved'; turns: ManagedModelUsageTurn[] }

export type ManagedModelAccessSnapshot =
  | ManagedModelAccessAuthority
  | { state: 'authentication_expired' | 'unavailable' }

const TEMPORARILY_UNAVAILABLE_MANAGED_MODELS = new Set(['nhat-thuc'])

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function parseManagedModelAccessAuthority(value: unknown): ManagedModelAccessAuthority | null {
  if (!isRecord(value)) {
    return null
  }

  const state = value.state as ManagedModelAuthorityState
  const accessAlias = parseManagedModelAccessAlias(value.access_alias)

  if (!MANAGED_MODEL_AUTHORITY_STATES.includes(state) || !accessAlias || value.billing_currency !== 'protons') {
    return null
  }

  const result: ManagedModelAccessAuthority = { state, access_alias: accessAlias, billing_currency: 'protons' }

  if (value.reason !== undefined) {
    if (value.reason !== 'funding_required' && value.reason !== 'model_reserved') { return null }
    result.reason = value.reason
  }

  for (const key of ['alias_version', 'display_name', 'display_version'] as const) {
    if (value[key] === undefined) { continue }
    const text = boundedString(value[key], 128)

    if (!text) { return null }
    result[key] = text
  }

  for (const key of ['available_protons', 'held_protons', 'next_quote_protons'] as const) {
    const amount = value[key]

    if (amount === undefined) { continue }

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
      return null
    }

    result[key] = amount
  }

  return result
}

export function parseManagedModelUsageTurn(value: unknown): ManagedModelUsageTurn | null {
  if (!isRecord(value)) {
    return null
  }

  const reservationId = boundedString(value.reservation_id, 64)
  const accessAlias = parseManagedModelAccessAlias(value.access_alias)
  const status = boundedString(value.status, 32)
  const startedAt = boundedString(value.started_at, 64)

  if (
    !reservationId ||
    !accessAlias ||
    !status ||
    !MANAGED_MODEL_TURN_STATES.includes(status as ManagedModelTurnState) ||
    !startedAt
  ) {
    return null
  }

  const counters = {} as Pick<
    ManagedModelUsageTurn,
    'cache_hit_tokens' | 'completion_tokens' | 'prompt_tokens' | 'provider_calls' | 'quoted_microcredits'
  >

  for (const key of [
    'quoted_microcredits',
    'provider_calls',
    'prompt_tokens',
    'cache_hit_tokens',
    'completion_tokens'
  ] as const) {
    const number = nonnegativeSafeInteger(value[key])

    if (number === null) {
      return null
    }

    counters[key] = number
  }

  let actual: number | null = null

  if (value.actual_microcredits !== undefined && value.actual_microcredits !== null) {
    actual = nonnegativeSafeInteger(value.actual_microcredits)

    if (actual === null) {
      return null
    }
  }

  let settledAt: string | null = null

  if (value.settled_at !== undefined && value.settled_at !== null) {
    settledAt = boundedString(value.settled_at, 64)

    if (!settledAt) {
      return null
    }
  }

  const displayName = boundedString(value.display_name, 80)

  return {
    reservation_id: reservationId,
    access_alias: accessAlias,
    ...(displayName ? { display_name: displayName } : {}),
    status: status as ManagedModelTurnState,
    actual_microcredits: actual,
    ...counters,
    started_at: startedAt,
    settled_at: settledAt
  }
}

/** Parses the `{ turns: [...] }` body of `GET /api/managed-model/usage`; fails closed on any bad entry. */
export function parseManagedModelUsageHistory(value: unknown): ManagedModelUsageTurn[] | null {
  if (!isRecord(value) || !Array.isArray(value.turns) || value.turns.length > 50) {
    return null
  }

  const turns: ManagedModelUsageTurn[] = []

  for (const entry of value.turns) {
    const turn = parseManagedModelUsageTurn(entry)

    if (!turn) {
      return null
    }

    turns.push(turn)
  }

  return turns
}

export function managedModelAccessFailure(status: number, value: unknown): ManagedModelAccessSnapshot {
  const error = isRecord(value) && typeof value.error === 'string' ? value.error : ''

  return status === 401 || error === 'authentication_expired'
    ? { state: 'authentication_expired' }
    : { state: 'unavailable' }
}

export function isManagedModelSelection(provider: string, model: string): boolean {
  return provider.trim() === 'atum-managed' || ['binh-minh', 'nguyet-thuc', 'nhat-thuc'].includes(model.trim())
}

export function managedModelAccessAliasForSelection(provider: string, model: string, workspaceProtected = false): ManagedModelAccessAlias | null {
  if (workspaceProtected) { return 'binh-minh' }
  const normalizedProvider = provider.trim()
  const normalizedModel = model.trim()
  const modelAlias = parseManagedModelAccessAlias(normalizedModel)

  return (
    modelAlias ??
    (normalizedProvider === 'atum-managed' || (!normalizedProvider && !normalizedModel) ? 'binh-minh' : null)
  )
}

/**
 * Like `managedModelAccessAliasForSelection` but without the empty-selection
 * default: only an explicit `atum-managed` provider or a known alias counts.
 * Use it for side effects triggered by a turn, where a blank selection must
 * not be read as "the default managed model".
 */
export function managedModelAccessAliasForExplicitSelection(
  provider: string,
  model: string
): ManagedModelAccessAlias | null {
  const modelAlias = parseManagedModelAccessAlias(model.trim())

  return modelAlias ?? (provider.trim() === 'atum-managed' ? 'binh-minh' : null)
}

/**
 * Models that remain in Atum's fixed public catalog but cannot be selected
 * until their platform-held provider credential is production-ready.
 *
 * The hosted edge rejects unavailable aliases independently. Removing an
 * entry here later changes picker availability; it cannot bypass authority.
 */
export function isManagedModelTemporarilyUnavailable(provider: string, model: string): boolean {
  return provider.trim() === 'atum-managed' && TEMPORARILY_UNAVAILABLE_MANAGED_MODELS.has(model.trim())
}

/**
 * One microcredit is one micro-USD of wholesale model cost. Amounts under one
 * cent keep four decimals so a single cheap turn does not render as $0.00.
 */
export function formatManagedModelUsd(microcredits: number, locale?: string): string {
  const dollars = microcredits / 1_000_000
  const fine = dollars > 0 && dollars < 0.01

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: fine ? 4 : 2
  }).format(dollars)
}
