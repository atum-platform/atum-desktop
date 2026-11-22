import { expect, it } from 'vitest'

import { projectPlanUsage } from './plan-usage'

const now = Date.UTC(2026, 10, 23, 8)
const reset = new Date(now + 60_000).toISOString()
const checkedAt = new Date(now - 1000).toISOString()
const window = { usedPercent: 45, resetsAt: reset, windowDurationMins: 300 }

function provider(driver: string, windows: unknown[]) {
  return { driver, instanceId: driver, enabled: true, usageLimits: { checkedAt, windows } }
}

it('shows the most used current account-wide window from each T3 plan with its own bounds', () => {
  expect(projectPlanUsage([
    provider('codex', [window, { ...window, usedPercent: 90, modelIds: ['one-model'] }]),
    provider('claudeAgent', [{ ...window, usedPercent: 100 }]),
    provider('antigravity', [window])
  ], now)).toEqual([
    { plan: 'codex', state: 'available', observedAt: now - 1000, usedPercent: 45, resetsAt: now + 60_000, windowStart: now - 299 * 60_000 },
    { plan: 'claude', state: 'exhausted', observedAt: now - 1000, usedPercent: 100, resetsAt: now + 60_000, windowStart: now - 299 * 60_000 }
  ])
})

it('does not invent a window boundary, report expired observations, or use another instance', () => {
  expect(projectPlanUsage([
    provider('codex', [{ usedPercent: 0 }]),
    provider('claudeAgent', [{ ...window, resetsAt: checkedAt }]),
    { ...provider('claudeAgent', [window]), instanceId: 'other-account' }
  ], now)).toEqual([{ plan: 'codex', state: 'available', observedAt: now - 1000, usedPercent: 0 }])
})
