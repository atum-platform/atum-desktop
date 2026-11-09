import { EVERYONE_ANSWERS_MAX, FLOOR_MAX_AGE_MS, GROUP_FRESHNESS_MS } from './limits'
import type { FloorFacts, FloorPlan, FreshnessFacts } from './types'

export async function planFloor(facts: FloorFacts): Promise<FloorPlan> {
  const candidates = [...new Set(facts.candidates)].filter(id => facts.ownAgentIds.includes(id))

  if (facts.kind === 'none') {
    return { order: [] }
  }

  if (facts.kind === 'named') {
    const named = [...new Set(facts.mentions)].filter(id => facts.ownAgentIds.includes(id))

    return {
      order: named.length
        ? named.filter(id => candidates.includes(id))
        : facts.replySenderId && candidates.includes(facts.replySenderId)
          ? [facts.replySenderId]
          : []
    }
  }

  const ranked = await Promise.all(
    candidates.map(async id => {
      const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${facts.eventId}:${id}`))

      return { id, rank: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
    })
  )

  ranked.sort((left, right) =>
    left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  )

  return { order: ranked.slice(0, EVERYONE_ANSWERS_MAX).map(each => each.id) }
}

export function isGroupFresh({ timestamp, now, floor }: FreshnessFacts): boolean {
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(now) || timestamp < 0 || now < timestamp) {
    return false
  }

  if (floor && floor.position > 0) {
    return (
      Number.isSafeInteger(floor.position) &&
      floor.position <= 4 &&
      Number.isSafeInteger(floor.acceptedAt) &&
      floor.acceptedAt >= timestamp &&
      floor.acceptedAt <= now &&
      floor.acceptedAt - timestamp <= GROUP_FRESHNESS_MS &&
      now - timestamp <= FLOOR_MAX_AGE_MS
    )
  }

  return now - timestamp <= GROUP_FRESHNESS_MS
}
