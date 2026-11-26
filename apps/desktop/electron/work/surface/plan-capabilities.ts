import { z } from 'zod'

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
