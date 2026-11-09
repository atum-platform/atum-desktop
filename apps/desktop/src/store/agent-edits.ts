import { atom, computed } from 'nanostores'

import { $sessions, sessionMatchesStoredId, sessionPinId } from './session'


export type AgentReviewStatus = 'open' | 'done' | 'undone'
export type AgentReviewPending = null | 'save' | 'undo'
export type AgentReviewMode = 'diff' | 'live' | 'rendered' | 'source'

export interface AgentEditCheckpoint {
  hash: string
  working_dir: string
}

export interface AgentEditInput {
  profile?: string
  sessionId: string
  turnId: string
  restorePath: string
  checkpoint: AgentEditCheckpoint | null
  diff: string | null
  diffTruncated: boolean
  restoreAvailable: boolean
}

export interface AgentEditReview extends AgentEditInput {
  scopeKey: string
  status: AgentReviewStatus
  settled: boolean
  previousMode: AgentReviewMode | null
  afterRevision?: string
  /** "Để sau": the dirty conflict strip stays collapsed until Atum edits again. */
  deferred: boolean
  pending: AgentReviewPending
  error?: string
  sequence: number
}

export type ReviewsByScope = Record<string, Record<string, AgentEditReview>>

export const $reviewsByScope = atom<ReviewsByScope>({})
let sequence = 0

const reviewKey = (restorePath: string, turnId: string) => `${restorePath}\u0000${turnId}`

function updateReview(
  scopeKey: string,
  restorePath: string,
  turnId: string,
  update: (review: AgentEditReview) => AgentEditReview
): void {
  const current = $reviewsByScope.get()
  const scoped = current[scopeKey]
  const key = reviewKey(restorePath, turnId)
  const review = scoped?.[key]

  if (!review) {
    return
  }

  const next = update(review)

  if (next === review) {
    return
  }

  $reviewsByScope.set({ ...current, [scopeKey]: { ...scoped, [key]: next } })
}

export function recordAgentEdit(scopeKey: string, edit: AgentEditInput): void {
  const current = $reviewsByScope.get()
  const scoped = current[scopeKey] ?? {}
  const key = reviewKey(edit.restorePath, edit.turnId)
  const existing = scoped[key]

  const review: AgentEditReview = existing
    ? {
        ...existing,
        ...edit,
        status: 'open',
        deferred: false,
        error: undefined,
        sequence: ++sequence
      }
    : {
        ...edit,
        scopeKey,
        status: 'open',
        settled: false,
        previousMode: null,
        deferred: false,
        pending: null,
        sequence: ++sequence
      }

  $reviewsByScope.set({ ...current, [scopeKey]: { ...scoped, [key]: review } })
}

export function settleTurn(sessionId: string, turnId: string): void {
  const current = $reviewsByScope.get()
  let changed = false
  const next: ReviewsByScope = {}

  for (const [scopeKey, scoped] of Object.entries(current)) {
    next[scopeKey] = Object.fromEntries(
      Object.entries(scoped).map(([key, review]) => {
        if (review.sessionId === sessionId && review.turnId === turnId && !review.settled) {
          changed = true

          return [key, { ...review, settled: true }]
        }

        return [key, review]
      })
    )
  }

  if (changed) {
    $reviewsByScope.set(next)
  }
}

/**
 * A review recorded before its session row reached `$sessions` is keyed by
 * the runtime session id; once the row is known, its chat scope is the
 * lineage root's. Resolve lazily on read so such reviews are not orphaned.
 */
function reviewScopeKey(review: AgentEditReview): string {
  const session = $sessions.get().find(candidate => sessionMatchesStoredId(candidate, review.sessionId) && (candidate.profile || 'default') === (review.profile || 'default'))

  return session ? `${review.scopeKey.slice(0, review.scopeKey.lastIndexOf(':') + 1)}${encodeURIComponent(sessionPinId(session))}` : review.scopeKey
}

function reviewMatchesScope(review: AgentEditReview, scopeKey: string): boolean {
  return review.scopeKey === scopeKey || reviewScopeKey(review) === scopeKey
}

function allReviews(reviews: ReviewsByScope = $reviewsByScope.get()): AgentEditReview[] {
  return Object.values(reviews).flatMap(scoped => Object.values(scoped))
}

export function openReviewFor(scopeKey: string, restorePath: string): AgentEditReview | null {
  return (
    allReviews()
      .filter(
        review => review.restorePath === restorePath && review.status === 'open' && reviewMatchesScope(review, scopeKey)
      )
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null
  )
}

export function openReviewsForScope(scopeKey: string): AgentEditReview[] {
  return allReviews().filter(review => review.status === 'open' && reviewMatchesScope(review, scopeKey))
}

export function hasOpenReview(reviews: ReviewsByScope, scopeKey: string, restorePath: string): boolean {
  return allReviews(reviews).some(
    review => review.restorePath === restorePath && review.status === 'open' && reviewMatchesScope(review, scopeKey)
  )
}

export const $openReviewsByScope = computed([$reviewsByScope, $sessions], reviews =>
  Object.fromEntries(
    Object.entries(reviews).map(([scope, scoped]) => [
      scope,
      Object.values(scoped).filter(review => review.status === 'open')
    ])
  )
)

export function deferReview(review: AgentEditReview): void {
  updateReview(review.scopeKey, review.restorePath, review.turnId, current => ({
    ...current,
    deferred: true,
    pending: null,
    error: undefined
  }))
}

export function rememberReviewMode(review: AgentEditReview, mode: AgentReviewMode): void {
  updateReview(review.scopeKey, review.restorePath, review.turnId, current => ({
    ...current,
    previousMode: current.previousMode ?? mode
  }))
}

export function observeReviewRevision(review: AgentEditReview, revision: string, replace = false): void {
  updateReview(review.scopeKey, review.restorePath, review.turnId, current =>
    current.afterRevision && !replace ? current : { ...current, afterRevision: revision }
  )
}

export function finishReview(review: AgentEditReview): void {
  updateReview(review.scopeKey, review.restorePath, review.turnId, current => ({
    ...current,
    status: 'done',
    pending: null,
    error: undefined
  }))
}

export function markUndone(review: AgentEditReview): void {
  updateReview(review.scopeKey, review.restorePath, review.turnId, current => ({
    ...current,
    status: 'undone',
    pending: null,
    error: undefined
  }))
}

export function setReviewPending(review: AgentEditReview, pending: AgentReviewPending): void {
  updateReview(review.scopeKey, review.restorePath, review.turnId, current => ({ ...current, pending }))
}

export function setReviewError(review: AgentEditReview, error?: string): void {
  updateReview(review.scopeKey, review.restorePath, review.turnId, current => ({ ...current, error }))
}

export function resetAgentEditReviews(): void {
  sequence = 0
  $reviewsByScope.set({})
}
