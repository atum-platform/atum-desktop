import { FIRST_RUN_PROVIDERS, type FirstRunProvider } from './first-run-pick'

/** One of this Mac's four connections as its native T3 status reports it (`work.readPlanLabels`). Local to this Mac. */
export interface FirstRunLabel {
  state: 'ready' | 'signed_out' | 'not_installed'
  /** T3's plan name, e.g. "Claude Pro". Never an email. */
  label?: string
}

export type FirstRunLabels = Partial<Record<FirstRunProvider, FirstRunLabel>>

const STATES = new Set(['ready', 'signed_out', 'not_installed'])

/** The window's check of main's answer: unknown keys, states or long labels are dropped. */
export function parseFirstRunLabels(value: unknown): FirstRunLabels {
  const result: FirstRunLabels = {}

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result
  }

  for (const provider of FIRST_RUN_PROVIDERS) {
    const row = (value as Record<string, unknown>)[provider] as Record<string, unknown> | undefined

    if (!row || typeof row !== 'object' || !STATES.has(row.state as string)) {
      continue
    }

    const label = typeof row.label === 'string' && row.label.length <= 60 && !row.label.includes('@') ? row.label : undefined

    result[provider] = { state: row.state as FirstRunLabel['state'], ...(label ? { label } : {}) }
  }

  return result
}
