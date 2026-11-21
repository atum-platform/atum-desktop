import { WorkSettlementsReplySchema } from './contract'
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

export function createDeviceServicePlatform(options: DeviceServicePlatformOptions): WorkPlatform {
  const doFetch = options.fetch ?? fetch

  const call = async (operation: string, body: Record<string, unknown>): Promise<unknown> => {
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

  return {
    enroll: input => call('work_enroll', input) as ReturnType<WorkPlatform['enroll']>,
    pull: input => call('work_sync_pull', input) as ReturnType<WorkPlatform['pull']>,
    async ack(ack) {
      await call('work_sync_ack', ack as unknown as Record<string, unknown>)
    },
    async macEvent(event) {
      await call('work_mac_event', event as unknown as Record<string, unknown>)
    },
    async carryGrant(carry) {
      await call('work_grant_carry', carry as unknown as Record<string, unknown>)
    },
    async reportSettlements(input) {
      // Contract 1.1 `work.mac.settlements`. A 2xx that is not the contract's reply for this Mac and this batch is not an
      // acknowledgement: the caller keeps the queue.
      const reply = WorkSettlementsReplySchema.safeParse(await call('work_mac_settlements', input as unknown as Record<string, unknown>))

      if (!reply.success || reply.data.deviceServiceId !== input.deviceServiceId || reply.data.accepted + reply.data.ignored > input.reports.length) {
        throw Object.assign(new Error('device_services_bad_reply'), { status: 502 })
      }
    }
  }
}
