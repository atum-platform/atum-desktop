import { gatewayForProfile } from '@/store/gateway'

import { parseAdvisorySearchResult } from '../../shared/atum-advisory-search'

interface AdvisorySearchGatewayEvent {
  payload?: unknown
  profile?: unknown
  session_id?: unknown
  type?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.trim() && Array.from(value).length <= maximum ? value.trim() : null
}

/**
 * Returns an advisory-source result to the socket that issued the request.
 * This must not use the foreground request helper: a private advisory job can
 * be running on a pooled profile while the owner is viewing another assistant.
 */
export async function handleAtumAdvisorySearch(event: AdvisorySearchGatewayEvent): Promise<boolean> {
  if (event.type !== 'atum.advisory.search.request') {
    return false
  }

  const payload = record(event.payload)
  const requestId = text(payload?.request_id, 256)
  const sessionId = text(event.session_id, 256)
  const turnId = text(payload?.turn_id, 256)
  const profile = text(event.profile, 128)

  if (!requestId || !sessionId || !turnId || !profile) {
    return true
  }

  let response = parseAdvisorySearchResult(null)

  try {
    const bridge = window.hermesDesktop?.advisoryRunner

    if (bridge) {
      response = parseAdvisorySearchResult(
        await bridge.search({ request_id: requestId, session_id: sessionId, turn_id: turnId, profile })
      )
    }
  } catch {
    // The source is optional; keep local session search usable when main is
    // unavailable or an older Desktop bridge lacks its authority callback.
  }

  const gateway = gatewayForProfile(profile)

  if (gateway) {
    await gateway.request('atum.advisory.search.respond', {
      request_id: requestId,
      session_id: sessionId,
      turn_id: turnId,
      result: JSON.stringify(response)
    })
  }

  return true
}
