import { z } from 'zod'

import type { FirstRunLabels } from '../../../shared/first-run-labels'
import { firstRunPick, type FirstRunProvider } from '../../../shared/first-run-pick'
import { PLAN_PROVIDER_BY_INSTANCE } from '../plan-providers'

import type { PlanCapabilities } from './plan-facts'

const modelId = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u
const modelLabel = /^[A-Za-z0-9][A-Za-z0-9 ._()/+:-]{0,119}$/u
const MODEL_LIMIT = 16

const nativeModel = z.object({ slug: z.string().regex(modelId), name: z.string(), isCustom: z.boolean() })

const nativeProvider = z.object({
  instanceId: z.string(),
  driver: z.string(),
  enabled: z.boolean(),
  installed: z.boolean(),
  status: z.enum(['ready', 'warning', 'error', 'disabled']),
  auth: z.object({ status: z.enum(['authenticated', 'unauthenticated', 'unknown']), type: z.string().optional(), subscriptionSharing: z.boolean().optional() }),
  models: z.array(z.unknown())
})

/** Project T3's native status into device capabilities. Only built-in model names cross the account boundary. */
export function projectPlanCapabilities(providers: unknown): PlanCapabilities {
  const result: PlanCapabilities = {}

  if (!Array.isArray(providers)) {return result}

  for (const value of providers) {
    const parsed = nativeProvider.safeParse(value)

    if (!parsed.success) {continue}

    const { instanceId, driver, enabled, installed, status, auth, models } = parsed.data

    if (instanceId !== driver || !Object.hasOwn(PLAN_PROVIDER_BY_INSTANCE, instanceId)) {continue}

    const provider = PLAN_PROVIDER_BY_INSTANCE[instanceId as keyof typeof PLAN_PROVIDER_BY_INSTANCE]

    if (!enabled || status === 'disabled' || auth.status === 'unauthenticated') {
      result[provider] = { state: 'disconnected' }

      continue
    }

    // A pending or failed probe gives no new auth evidence. Keep the previous fact until it expires.
    if (!installed || auth.status !== 'authenticated') {continue}

    const planLogin = {
      codex: auth.type === 'chatgpt' || (auth.type === undefined && auth.subscriptionSharing === true),
      claude: auth.type !== 'apiKey' && auth.type !== 'bedrock',
      antigravity: auth.type === 'oauth-personal'
    }[provider]

    if (!planLogin) {
      result[provider] = { state: 'disconnected' }

      continue
    }

    const catalog = new Map<string, string>()

    for (const entry of models) {
      const model = nativeModel.safeParse(entry)

      if (!model.success || model.data.isCustom || catalog.has(model.data.slug)) {continue}

      const { slug, name } = model.data

      catalog.set(slug, modelLabel.test(name) ? name : slug.slice(0, 120))

      if (catalog.size >= MODEL_LIMIT) {break}
    }

    // An authenticated native client can temporarily have no catalog. Leaving models absent preserves
    // the last list while still reporting the login and refreshing the observation.
    result[provider] = {
      state: 'connected',
      ...(catalog.size ? { models: [...catalog].map(([id, displayName]) => ({ id, displayName })) } : {})
    }
  }

  return result
}

/** T3's built-in instances for the four first-run connections (OpenCode is T3's own `opencode` driver). */
const FIRST_RUN_INSTANCE = {
  claudeAgent: 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  opencode: 'opencode'
} as const satisfies Record<string, FirstRunProvider>

// A plan name only: letters, digits and simple punctuation, never an address (no "@"), at most 60 characters.
const planLabel = /^[A-Za-z0-9][A-Za-z0-9 ._()+:/-]{0,59}$/u

/**
 * This Mac's four connections as T3 reports them, for the first chat's Connections rows and the automatic pick. Local only:
 * it stays on this Mac (main → its own window). The account email T3 also holds is never read.
 * - `ready`: installed and signed in (any login kind; the pick decides what may be used);
 * - `signed_out`: installed or configured, not signed in;
 * - `not_installed`: T3 cannot find the client.
 * A provider T3 does not list, or whose probe has not answered, is left out (the row reads Connect).
 */
export function projectPlanLabels(providers: unknown): FirstRunLabels {
  const result: FirstRunLabels = {}

  if (!Array.isArray(providers)) {return result}

  for (const value of providers) {
    const parsed = nativeProvider.extend({ auth: nativeProvider.shape.auth.extend({ label: z.string().optional() }) }).safeParse(value)

    if (!parsed.success) {continue}

    const { instanceId, driver, enabled, installed, status, auth } = parsed.data

    if (instanceId !== driver || !Object.hasOwn(FIRST_RUN_INSTANCE, instanceId)) {continue}

    const provider = FIRST_RUN_INSTANCE[instanceId as keyof typeof FIRST_RUN_INSTANCE]

    if (!installed) {
      result[provider] = { state: 'not_installed' }
    } else if (!enabled || status === 'disabled' || auth.status === 'unauthenticated') {
      result[provider] = { state: 'signed_out' }
    } else if (auth.status === 'authenticated') {
      const label = auth.label?.trim()

      result[provider] = { state: 'ready', ...(label && planLabel.test(label) ? { label } : {}) }
    }
  }

  return result
}

/** Work uses the same pick table with the plans that its own server can run. */
export function pickWorkSubscription(providers: unknown[]) {
  const usable = providers.flatMap(value => {
    const provider = nativeProvider.safeParse(value)

    return provider.success && provider.data.status !== 'error' ? [{ value, provider: provider.data }] : []
  })

  const values = usable.map(({ value }) => value)
  const capabilities = projectPlanCapabilities(values)
  const labels = projectPlanLabels(values)

  const plans = Object.fromEntries(Object.values(PLAN_PROVIDER_BY_INSTANCE).map(plan => [plan, {
    connected: capabilities[plan]?.state === 'connected',
    label: labels[plan]?.label,
    models: capabilities[plan]?.models ?? []
  }]))

  const openCode = usable.find(({ provider }) => provider.instanceId === 'opencode' && provider.driver === 'opencode')

  const openCodeModels = labels.opencode?.state === 'ready'
    ? (openCode?.provider.models ?? []).flatMap(value => {
      const model = nativeModel.safeParse(value)

      return model.success && !model.data.isCustom && model.data.slug.startsWith('opencode-go/')
        ? [{ id: model.data.slug, displayName: model.data.name }] : []
    }) : []

  // Local sessions already have direct access to these plans and need no relay publication.
  const pick = firstRunPick({ published: true, plans, opencodeGo: { connected: openCodeModels.length > 0, models: openCodeModels } })

  if (pick.kind === 'atum') {return undefined}

  if (pick.kind === 'opencode_go') {return { instanceId: 'opencode', model: pick.model }}

  const instance = Object.entries(PLAN_PROVIDER_BY_INSTANCE).find(([, plan]) => plan === pick.plan)

  return instance && { instanceId: instance[0], model: pick.model }
}
