/** Main's legacy ticker gate. No lease/failed preparation must not release unknown
 * managed jobs; an accepted selected=false snapshot restores the existing plan.
 * The ticker process may start held so it can acquire its first lease normally.
 *
 * `placed`: D1 manages the agent on this Mac (its journal has seen it under the placement model). Only such an
 * agent can be selected (the snapshot requires this Mac's current D1 placement), so any other agent keeps
 * today's plan exactly, the way D1's own standing leaves an unmanaged agent `legacy`.
 */
export function macJobsTickerPlan<T extends { holdUntilAnswering: boolean }>(
  plan: T,
  lifecycle?: { readonly tickerPrepared: boolean },
  placed = true
): T {
  return placed && lifecycle && !lifecycle.tickerPrepared ? { ...plan, holdUntilAnswering: true } : plan
}
