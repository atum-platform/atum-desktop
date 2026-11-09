import { setTimeout as delay } from 'node:timers/promises'

import { MacJobSnapshotEnvelopeSchema, type MacJobSnapshotResponse, MacJobSnapshotResponseSchema } from '../../../../packages/device-protocol/mac-job-snapshot-pending'
/** N7 signed Mac scheduling transport. Selection belongs exclusively to the platform. */
import {
  type MacJobFireEnvelope, MacJobFireEnvelopeSchema,
  type MacJobFireResponse, MacJobFireResponseSchema,
  type MacJobGrantEnvelope, MacJobGrantEnvelopeSchema,
  type MacJobGrantResponse, MacJobGrantResponseSchema,
  type MacJobOccurrenceEnvelope, MacJobOccurrenceEnvelopeSchema,
  type MacJobOccurrenceResponse, MacJobOccurrenceResponseSchema
} from '../../../../packages/device-protocol/vendor/mac-jobs-0.7.72/mac-jobs'

import type { HomeLeaseFence, HomeSignedAction } from './agent-home-placement/contract'
import { isUuid } from './agent-home-placement/contract'
import type { MacExecutorAuth } from './agent-home-placement/executor-auth'
import type { ShellHomePlatformOptions } from './agent-home-placement/platform-client'
import { readDomainJson } from './domain'

export class MacJobTransportError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid' | 'not_home') {
    super(`mac_job_${code}`)
  }
}

export interface MacJobsOptions extends ShellHomePlatformOptions {
  /** The SAME auth instance/store used by D1: never a per-job sequence counter. */
  auth: MacExecutorAuth
  /** Injectable backoff for contract tests; production uses abortable timers. */
  wait?(ms: number, signal: AbortSignal): Promise<void>
  /** Fresh platform placement + current lease via fenceFromLease; null unless current Mac home. */
  authority(assistantId: string, signal: AbortSignal): Promise<HomeLeaseFence | null>
}

/**
 * Only explicit busy refusals are retried: a lost dispatch response must enter existing uncertain recovery.
 * s1Request may refresh the MAS bearer and call send again. Sign INSIDE send so every HTTP attempt
 * has fresh device-wide replay metadata, retaining the exact caller's business identifiers.
 */
export class MacJobsClient {
  constructor(private readonly options: MacJobsOptions) {}

  snapshot(assistantId: string, signal: AbortSignal): Promise<MacJobSnapshotResponse> {
    return this.call(assistantId, 'snapshot', 'MacJobSnapshot', undefined,
      MacJobSnapshotEnvelopeSchema, MacJobSnapshotResponseSchema, signal)
  }

  fire(assistantId: string, request: MacJobFireEnvelope['request'], signal: AbortSignal): Promise<MacJobFireResponse> {
    return this.call(assistantId, 'fire', 'MacJobFire', request, MacJobFireEnvelopeSchema, MacJobFireResponseSchema, signal)
  }

  occurrence(assistantId: string, request: MacJobOccurrenceEnvelope['request'], signal: AbortSignal): Promise<MacJobOccurrenceResponse> {
    return this.call(assistantId, 'occurrence', 'MacJobOccurrence', request, MacJobOccurrenceEnvelopeSchema, MacJobOccurrenceResponseSchema, signal)
  }

  grant(assistantId: string, request: MacJobGrantEnvelope['request'], signal: AbortSignal): Promise<MacJobGrantResponse> {
    return this.call(assistantId, 'grant', 'MacJobGrant', request, MacJobGrantEnvelopeSchema, MacJobGrantResponseSchema, signal)
  }

  private async call<T>(
    assistantId: string, route: string, action: HomeSignedAction, request: unknown,
    envelope: { safeParse(value: unknown): { success: boolean } },
    responseSchema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    signal: AbortSignal
  ): Promise<T> {
    if (!isUuid(assistantId)) {throw new MacJobTransportError('invalid')}
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 20_000)])

    try {
      for (let attempt = 0; ; attempt++) {
        const result = await this.options.request(async (accessToken, resource) => {
          bounded.throwIfAborted()
          const home = await this.options.authority(assistantId, bounded)

          if (!home) {throw new MacJobTransportError('not_home')}
          const body = await this.options.auth.sign(action, meta => route === 'snapshot' ? ({ meta, home, profile: 'atum.mac-job-snapshot/1' }) : ({ meta, home, request }))

          if (!envelope.safeParse(body).success) {throw new MacJobTransportError('invalid')}
          bounded.throwIfAborted()

          const response = await (this.options.fetch ?? fetch)(`${resource}/agents/${assistantId}/jobs/${route}`, {
            method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: bounded, credentials: 'omit', redirect: 'error', cache: 'no-store'
          })

          if (!response.headers.get('content-type')?.startsWith('application/json')) {
            await response.body?.cancel()
            throw new MacJobTransportError('unavailable')
          }

          const parsed = responseSchema.safeParse(await readDomainJson(response, 256 * 1024))

          if (!parsed.success) {throw new MacJobTransportError('unavailable')}
          bounded.throwIfAborted()
          const value = parsed.data
          const code = typeof value === 'object' && value !== null && 'code' in value ? value.code : null

          const statuses: Record<string, number[]> = {
            lease_lost: [409], matrix_invalid: [400], denied: [401, 403], not_found: [404], conflict: [409], busy: [429], unavailable: [503]
          }

          if (code ? typeof code !== 'string' || !statuses[code]?.includes(response.status) : response.status !== 200) {
            throw new MacJobTransportError('unavailable')
          }

          return value
        }, bounded)

        if (typeof result !== 'object' || result === null || !('code' in result) || result.code !== 'busy' || attempt >= 3) {
          return result
        }

        const wait = this.options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }))
        await wait(250 * 2 ** attempt, bounded)
      }
    } catch (error) {
      if (error instanceof MacJobTransportError) {throw error}
      // Never include signed bodies, grant tokens or server exception text in errors/logs.
      throw new MacJobTransportError('unavailable')
    }
  }
}
