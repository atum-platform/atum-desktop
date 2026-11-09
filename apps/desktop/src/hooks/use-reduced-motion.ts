import { matchesQuery, useMediaQuery } from './use-media-query'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** Imperative check for event handlers and animation helpers. */
export function prefersReducedMotion(): boolean {
  return matchesQuery(REDUCED_MOTION_QUERY)
}

/** Reactive preference for rendered motion and timers. */
export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY)
}
