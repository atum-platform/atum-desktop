import {
  type WorkConsentRecord,
  WorkConsentRecordSchema,
  WorkSettlementsReplySchema,
  WorkSubscriptionReportReplySchema,
  type WorkSubscriptionState,
  WorkSubscriptionStateSchema
} from './contract'
import type { WorkPlatform } from './ports'

// The platform half of the Work route, as the Mac sees it: operations of the existing device-services endpoint
// (`POST /api/matrix/v1/device-services`, body `{operation, ...}`, the owner's bearer). No new owner URL. Every reply
// is parsed by its caller against the contract; a reply that is not 2xx throws and the sync client treats it as
// offline. Nothing here logs a body.

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

export function createDeviceServicePlatform(options: DeviceServicePlatformOptions): WorkPlatform {
  const call = deviceServiceCall(options)

  return {
    enroll: input => call('work_enroll', input) as ReturnType<WorkPlatform['enroll']>,
    pull: input => call('work_sync_pull', input) as ReturnType<WorkPlatform['pull']>,
    async ack(ack) {
      await call('work_sync_ack', ack as unknown as Record<string, unknown>)
    },
    async macEvent(event) {
      // The reply names the route state the platform now holds: a reopen it is holding back (the key rotated, the ack is not in
      // yet) answers 200 with `closed`, and the caller must not take that for an open route.
      const state = ((await call('work_mac_event', event as unknown as Record<string, unknown>)) as { routeState?: unknown } | null)?.routeState

      return { routeState: state === 'open' || state === 'closed' ? state : undefined }
    },
    async carryGrant(carry) {
      await call('work_grant_carry', carry as unknown as Record<string, unknown>)
    },
    async reportSubscription(report) {
      // Contract 1.2 `work.mac.subscription`: the reply must be the platform's record of THIS Mac's fact; anything else is not an
      // acknowledgement and the caller keeps the fact owed.
      const reply = WorkSubscriptionReportReplySchema.safeParse(
        await call('work_subscription_report', report as unknown as Record<string, unknown>)
      )

      if (
        !reply.success ||
        reply.data.deviceServiceId !== report.deviceServiceId ||
        reply.data.provider !== report.provider
      ) {
        throw Object.assign(new Error('device_services_bad_reply'), { status: 502 })
      }
    },
    async reportSettlements(input) {
      // Contract 1.1 `work.mac.settlements`. A 2xx that is not the contract's reply for this Mac and this batch is not an
      // acknowledgement: the caller keeps the queue. Every report must be accounted for (accepted or ignored): a smaller
      // count means the platform did not see some of them, and clearing the batch would lose those.
      const reply = WorkSettlementsReplySchema.safeParse(await call('work_mac_settlements', input as unknown as Record<string, unknown>))

      if (!reply.success || reply.data.deviceServiceId !== input.deviceServiceId || reply.data.accepted + reply.data.ignored !== input.reports.length) {
        throw Object.assign(new Error('device_services_bad_reply'), { status: 502 })
      }
    }
  }
}

/** The owner's consent for background use of a plan (gate 4b-2). Only the owner's own app writes it. */
export interface WorkConsentClient {
  read(): Promise<WorkSubscriptionState>
  /** Names assistants and Macs (never "all"); the same scope again changes nothing on the platform. */
  set(input: { agents: string[]; devices: string[]; alsoWhenScheduled: boolean }): Promise<WorkConsentRecord>
  revoke(): Promise<WorkConsentRecord>
}

/**
 * `work_subscription_read`, `work_consent_set`, `work_consent_revoke` on the same device-services endpoint, with the owner's bearer.
 * A reply that is not the contract's record is an error, so the page never shows a consent the platform did not record.
 */
export function createWorkConsentClient(options: DeviceServicePlatformOptions): WorkConsentClient {
  const call = deviceServiceCall(options)

  const record = (value: unknown): WorkConsentRecord => {
    const parsed = WorkConsentRecordSchema.safeParse(value)

    if (!parsed.success) {
      throw Object.assign(new Error('device_services_bad_reply'), { status: 502 })
    }

    return parsed.data
  }

  return {
    async read() {
      const parsed = WorkSubscriptionStateSchema.safeParse(await call('work_subscription_read', {}))

      if (!parsed.success) {
        throw Object.assign(new Error('device_services_bad_reply'), { status: 502 })
      }

      return parsed.data
    },
    set: async input =>
      record(
        await call('work_consent_set', {
          provider: 'codex',
          agents: [...input.agents],
          devices: [...input.devices],
          alsoWhenScheduled: input.alsoWhenScheduled
        })
      ),
    revoke: async () => record(await call('work_consent_revoke', { provider: 'codex' }))
  }
}
