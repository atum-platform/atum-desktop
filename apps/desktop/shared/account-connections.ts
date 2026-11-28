import { z } from 'zod'

/**
 * `atum.account-connections/1` (atum-platform `packages/protocol/src/account-connections`, spec
 * `spec/account-connections/v1`), as this app reads it. One account-scoped list of what the owner
 * has connected and where each connection can run. Device-held plans are facts ("Mac M has Claude
 * signed in, these model names"); no token, login or e-mail is ever part of it.
 *
 * The schema mirrors the protocol's (the desktop does not depend on `@atum/protocol`); a reply that
 * does not parse is not shown. Every feature reads this one list: Settings › Connections, the model
 * picker (chat, assistant card) and the connect sheet.
 */

export const ACCOUNT_CONNECTIONS_PROFILE = 'atum.account-connections/1' as const
export const ACCOUNT_PLANS = ['codex', 'claude', 'antigravity'] as const
export type AccountPlan = (typeof ACCOUNT_PLANS)[number]

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const observedAt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const status = z.enum(['connected', 'needs_attention', 'not_connected'])
const plan = z.enum(ACCOUNT_PLANS)
const label = (max: number) => z.string().min(1).max(max).regex(/^[^@\p{Cc}]+$/u)
const model = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u), displayName: label(200) }).strict()

const device = z
  .object({ deviceServiceId: uuid, displayName: label(128), status: z.enum(['connected', 'stale']), observedAt })
  .strict()

const reach = z
  .object({ chat: z.enum(['direct', 'relay', 'none']), work: z.enum(['native', 'none']), agents: z.literal('all') })
  .strict()

const cloudId = z.union([
  z.enum(['opencode_go', 'google', 'owner_chats', 'drive']),
  z.string().regex(/^home_hub:[a-z0-9][a-z0-9-]{0,62}$/u),
  z.string().regex(/^app:[a-z0-9][a-z0-9-]{1,62}$/u)
])

const planConnection = z
  .object({
    id: plan,
    kind: z.literal('plan'),
    provider: plan,
    custody: z.literal('device'),
    status,
    devices: z.array(device),
    models: z.array(model),
    reach
  })
  .strict()

const cloudConnection = z
  .object({
    id: cloudId,
    kind: z.enum(['apiKey', 'integration', 'tools', 'app']),
    provider: cloudId,
    custody: z.literal('cloud'),
    status,
    models: z.array(model).optional(),
    reach
  })
  .strict()

export const AccountConnectionSchema = z
  .union([planConnection, cloudConnection])
  .refine(connection => connection.id === connection.provider, 'stable connection ID')

export const AccountConnectionsSchema = z
  .object({ profile: z.literal(ACCOUNT_CONNECTIONS_PROFILE), connections: z.array(AccountConnectionSchema) })
  .strict()

export type AccountConnections = z.infer<typeof AccountConnectionsSchema>
export type AccountConnection = AccountConnections['connections'][number]
export type AccountPlanConnection = Extract<AccountConnection, { kind: 'plan' }>
export type AccountConnectionStatus = AccountConnection['status']

/**
 * What the window reads. `account`: the platform's registry. `this_mac`: the registry route is not
 * reachable (not deployed yet, offline), so main answered from this Mac's own plan facts only; cloud
 * rows are then absent and each feature keeps its own read for them.
 */
export interface AccountConnectionsView {
  source: 'account' | 'this_mac'
  /** This Mac's device-service id, when it has one, so a row can say "This Mac". */
  thisDevice?: string
  /** Native plans found while this Mac is still enrolling. */
  localPlans?: AccountPlan[]
  connections: AccountConnection[]
}

export function parseAccountConnections(value: unknown): AccountConnections | null {
  const parsed = AccountConnectionsSchema.safeParse(value)

  return parsed.success ? parsed.data : null
}

/** The window's check of main's answer (the same contract, plus the two local fields). */
export function parseAccountConnectionsView(value: unknown): AccountConnectionsView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>
  const source = row.source === 'account' || row.source === 'this_mac' ? row.source : null
  const thisDevice = row.thisDevice === undefined ? undefined : uuid.safeParse(row.thisDevice).data
  const localPlans = row.localPlans === undefined ? undefined : z.array(plan).safeParse(row.localPlans).data
  const registry = parseAccountConnections({ profile: ACCOUNT_CONNECTIONS_PROFILE, connections: row.connections })

  if (!source || !registry || (row.thisDevice !== undefined && !thisDevice) || (row.localPlans !== undefined && !localPlans)) {
    return null
  }

  return { source, ...(thisDevice ? { thisDevice } : {}), ...(localPlans ? { localPlans } : {}), connections: registry.connections }
}

/** One plan as this Mac's native status reports it (C3's capability projection). */
export interface LocalPlanCapability {
  state: 'connected' | 'disconnected'
  models?: readonly { id: string; displayName: string }[]
}

/**
 * The fallback when the registry cannot be read: this Mac's own facts, shaped as the registry would
 * show them for this one Mac. A plan this Mac cannot speak for reads `not_connected` (Connect is the
 * honest action on this Mac either way). Nothing about other Macs or the cloud is invented.
 */
export function localAccountConnections(input: {
  capabilities: Partial<Record<AccountPlan, LocalPlanCapability>>
  thisDevice?: string
  deviceName: string
  now: number
}): AccountConnectionsView {
  const connections: AccountConnection[] = ACCOUNT_PLANS.map(id => {
    const capability = input.capabilities[id]
    const connected = capability?.state === 'connected'

    return {
      id,
      kind: 'plan' as const,
      provider: id,
      custody: 'device' as const,
      status: connected ? ('connected' as const) : ('not_connected' as const),
      devices:
        connected && input.thisDevice
          ? [{ deviceServiceId: input.thisDevice, displayName: input.deviceName, status: 'connected' as const, observedAt: input.now }]
          : [],
      models: connected ? [...(capability?.models ?? [])] : [],
      reach: { chat: connected && id === 'codex' ? ('relay' as const) : ('none' as const), work: connected ? ('native' as const) : ('none' as const), agents: 'all' as const }
    }
  })

  const localPlans = ACCOUNT_PLANS.filter(id => input.capabilities[id]?.state === 'connected')

  return {
    source: 'this_mac',
    ...(input.thisDevice ? { thisDevice: input.thisDevice } : localPlans.length ? { localPlans } : {}),
    connections
  }
}

/** A typed example of the contract, for tests and the playground (no real device or account). */
export const ACCOUNT_CONNECTIONS_FIXTURE: AccountConnectionsView = {
  source: 'account',
  thisDevice: '11111111-1111-4111-8111-11111111abcd',
  connections: [
    {
      id: 'codex',
      kind: 'plan',
      provider: 'codex',
      custody: 'device',
      status: 'connected',
      devices: [
        { deviceServiceId: '11111111-1111-4111-8111-11111111abcd', displayName: 'MacBook Pro', status: 'connected', observedAt: 1_795_000_000_000 }
      ],
      models: [
        { id: 'gpt-6', displayName: 'GPT-6' },
        { id: 'gpt-6-mini', displayName: 'GPT-6 mini' }
      ],
      reach: { chat: 'relay', work: 'native', agents: 'all' }
    },
    {
      id: 'claude',
      kind: 'plan',
      provider: 'claude',
      custody: 'device',
      status: 'connected',
      devices: [
        { deviceServiceId: '22222222-2222-4222-8222-22222222abcd', displayName: 'Mac mini', status: 'stale', observedAt: 1_794_900_000_000 }
      ],
      models: [{ id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' }],
      reach: { chat: 'relay', work: 'native', agents: 'all' }
    },
    {
      id: 'antigravity',
      kind: 'plan',
      provider: 'antigravity',
      custody: 'device',
      status: 'not_connected',
      devices: [],
      models: [],
      reach: { chat: 'none', work: 'none', agents: 'all' }
    },
    { id: 'opencode_go', kind: 'apiKey', provider: 'opencode_go', custody: 'cloud', status: 'not_connected', reach: { chat: 'direct', work: 'none', agents: 'all' } },
    { id: 'google', kind: 'integration', provider: 'google', custody: 'cloud', status: 'connected', reach: { chat: 'direct', work: 'none', agents: 'all' } },
    { id: 'owner_chats', kind: 'tools', provider: 'owner_chats', custody: 'cloud', status: 'connected', reach: { chat: 'direct', work: 'none', agents: 'all' } },
    { id: 'home_hub:strap', kind: 'tools', provider: 'home_hub:strap', custody: 'cloud', status: 'connected', reach: { chat: 'direct', work: 'none', agents: 'all' } }
  ]
}
