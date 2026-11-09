import type { AwarenessData, AwarenessEvidence, AwarenessSnapshot } from './types'

export type AwarenessView = { state: 'loading' | 'unavailable' } | { state: 'ready'; snapshot: AwarenessSnapshot }

function hasScopeKey(scopeKey: string | null): scopeKey is string {
  return typeof scopeKey === 'string' && scopeKey.trim().length > 0
}

function isExpired(evidence: AwarenessEvidence, now: number): boolean {
  return evidence.expiresAt !== undefined && evidence.expiresAt <= now
}

/**
 * Projects an already-authorized frozen-v1 awareness snapshot for the current
 * desktop scope. This is intentionally presentation-only: RT remains the
 * authority for membership, policy, coverage, and source access.
 */
export function selectAwarenessView(currentScopeKey: string | null, data: AwarenessData, now: number): AwarenessView {
  if (data.state !== 'ready') {
    return { state: data.state }
  }

  const { snapshot } = data

  if (
    !hasScopeKey(currentScopeKey) ||
    !hasScopeKey(snapshot.scopeKey) ||
    snapshot.scopeKey !== currentScopeKey ||
    snapshot.audience !== 'private_owner'
  ) {
    return { state: 'unavailable' }
  }

  const evidence = snapshot.status === 'unavailable' ? [] : snapshot.evidence.filter(item => !isExpired(item, now))

  return { state: 'ready', snapshot: { ...snapshot, evidence } }
}

/**
 * Citation opening is available only for the exact, current evidence object
 * still displayed by the active snapshot. Native revalidates the final request.
 */
export function canOpenAwarenessCitation(
  snapshot: AwarenessSnapshot,
  evidence: AwarenessEvidence,
  now: number
): boolean {
  return (
    snapshot.status !== 'unavailable' &&
    snapshot.freshness === 'current' &&
    !isExpired(evidence, now) &&
    snapshot.evidence.includes(evidence)
  )
}
