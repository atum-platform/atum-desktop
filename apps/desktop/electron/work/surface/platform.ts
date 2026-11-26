import type { WorkRelayPlan } from '../../../shared/matrix-work-relay'

import {
  type WorkConsentRecord,
  WorkConsentRecordSchema,
  type WorkSubscriptionReport,
  WorkSubscriptionReportReplySchema,
  type WorkSubscriptionState,
  WorkSubscriptionStateSchema
} from './plan-contract'

// The owner-scoped device services client: operations of the existing device-services endpoint
// (`POST /api/matrix/v1/device-services`, body `{operation, ...}`, the owner's bearer). No new owner URL. Each operation validates its reply against its contract.

export interface DeviceServicePlatformOptions {
  /** `https://<host>/api/matrix/v1/device-services` */
  endpoint: string
  /** The signed-in owner's bearer, read on every call. */
  bearer(): Promise<string>
  fetch?: typeof fetch
}

export function deviceServiceCall(options: DeviceServicePlatformOptions) {
  const doFetch = options.fetch ?? fetch

  return async (operation: string, body: Record<string, unknown>): Promise<unknown> => {
    const response = await doFetch(options.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await options.bearer()}` },
      body: JSON.stringify({ operation, ...body }),
      signal: AbortSignal.timeout(20_000)
    })

    if (!response.ok) {
      // The status is the only thing a caller may act on (a 400 isolates a bad row; the rest is retried): no body, no text.
      throw Object.assign(new Error(`device_services_${response.status}`), { status: response.status })
    }

    return response.json()
  }
}

export async function reportSubscription(call: ReturnType<typeof deviceServiceCall>, report: WorkSubscriptionReport): Promise<void> {
  // Contract 1.2 `work.mac.subscription`: the reply must be the platform's record of THIS Mac's fact; anything else is not an
  // acknowledgement and the caller keeps the fact owed.
  const reply = WorkSubscriptionReportReplySchema.safeParse(
    await call('work_subscription_report', report as unknown as Record<string, unknown>)
  )

  if (
    !reply.success ||
    reply.data.deviceServiceId !== report.deviceServiceId ||
    reply.data.provider !== report.provider ||
    reply.data.state !== report.state ||
    reply.data.observedAt !== report.observedAt
  ) {
    throw Object.assign(new Error('device_services_bad_reply'), { status: 502 })
  }
}

/** The owner's consent for background use of a plan (gate 4b-2). Only the owner's own app writes it. */
export interface WorkConsentClient {
  read(provider?: WorkRelayPlan): Promise<WorkSubscriptionState>
  /** Names assistants and Macs (never "all"); the same scope again changes nothing on the platform. */
  set(input: { provider?: WorkRelayPlan; agents: string[]; devices: string[]; alsoWhenScheduled: boolean }): Promise<WorkConsentRecord>
  revoke(provider?: WorkRelayPlan): Promise<WorkConsentRecord>
}

/**
 * `work_subscription_read`, `work_consent_set`, `work_consent_revoke` on the same device-services endpoint, with the owner's bearer.
 * A reply that is not the contract's record is an error, so the page never shows a consent the platform did not record.
 */
export function createWorkConsentClient(options: DeviceServicePlatformOptions): WorkConsentClient {
  const call = deviceServiceCall(options)

  const record = (value: unknown, provider: WorkRelayPlan): WorkConsentRecord => {
    const parsed = WorkConsentRecordSchema.safeParse(value)

    if (!parsed.success || parsed.data.provider !== provider) {
      throw Object.assign(new Error('device_services_bad_reply'), { status: 502 })
    }

    return parsed.data
  }

  return {
    async read(provider) {
      const plan = provider ?? 'codex'
      const parsed = WorkSubscriptionStateSchema.safeParse(await call('work_subscription_read', provider ? { provider } : {}))

      if (!parsed.success || parsed.data.consent.provider !== plan || parsed.data.facts.some(fact => fact.provider !== plan)) {
        throw Object.assign(new Error('device_services_bad_reply'), { status: 502 })
      }

      return parsed.data
    },
    set: async input =>
      record(
        await call('work_consent_set', {
          provider: input.provider ?? 'codex',
          agents: [...input.agents],
          devices: [...input.devices],
          alsoWhenScheduled: input.alsoWhenScheduled
        }), input.provider ?? 'codex'
      ),
    revoke: async (provider = 'codex') => record(await call('work_consent_revoke', { provider }), provider)
  }
}
