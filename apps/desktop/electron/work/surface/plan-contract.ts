import { z } from 'zod'

import { WORK_RELAY_EFFORTS, WORK_RELAY_PLANS } from '../../../shared/matrix-work-relay'
import { ACCOUNT_PLAN_PROVIDERS, type AccountPlanProvider } from '../plan-providers'

const uuid = z.uuid()
const safe = z.number().int().nonnegative()
const positive = safe.positive()

export const WorkRelaySelectionSchema = z.object({
  provider: z.literal('atum-work'), plan: z.enum(WORK_RELAY_PLANS),
  model: z.string().min(1).max(200),
  // Read when the platform keeps a thinking level with the plan selection; absent is the model's default.
  effort: z.enum(WORK_RELAY_EFFORTS).optional(),
  revision: positive
}).strict()

export const WorkSubscriptionReportReplySchema = z
  .object({
    deviceServiceId: uuid,
    provider: z.enum(ACCOUNT_PLAN_PROVIDERS),
    state: z.enum(['connected', 'disconnected']),
    observedAt: safe,
    recordedAt: safe
  })
  .strict()

/** 4b-2, `work.consent.record`: the account's one consent for a plan, as `work_consent_set` / `_revoke` answer it. Default off. */
export const WorkConsentRecordSchema = z
  .object({
    provider: z.enum(WORK_RELAY_PLANS),
    state: z.enum(['on', 'off']),
    agents: z.union([z.literal('all'), z.array(uuid).max(256)]).nonoptional(),
    devices: z.array(uuid).max(32),
    alsoWhenScheduled: z.boolean(),
    revision: safe,
    grantedAt: safe.optional(),
    revokedAt: safe.optional()
  })
  .strict()
export type WorkConsentRecord = z.infer<typeof WorkConsentRecordSchema>

/** `work.subscription.state` (`work_subscription_read`): the consent record and each Mac's plan fact. */
export const WorkSubscriptionStateSchema = z
  .object({
    issuedAt: safe,
    consent: WorkConsentRecordSchema,
    facts: z
      .array(
        z
          .object({
            deviceServiceId: uuid,
            provider: z.enum(WORK_RELAY_PLANS),
            status: z.enum(['connected', 'disconnected', 'stale']),
            observedAt: safe.optional(),
            // The owner's own label for the Mac (the device registry's display name): shown beside its checkbox, nothing else.
            displayName: z.string().min(1).max(64).optional(),
            models: z.array(z.object({
              id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u),
              displayName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()/+:-]{0,119}$/u)
            }).strict()).max(16).optional()
          })
          .strict()
      )
      .max(64)
  })
  .strict()
export type WorkSubscriptionState = z.infer<typeof WorkSubscriptionStateSchema>

export interface WorkPlanModel {
  id: string
  displayName: string
}

/** G9, `work_subscription_report`: native plan availability and its safe model catalog. */
export interface WorkSubscriptionReport {
  deviceServiceId: string
  accountId: string
  routeEpoch: number
  provider: AccountPlanProvider
  state: 'connected' | 'disconnected'
  observedAt: number
  models?: WorkPlanModel[]
}
