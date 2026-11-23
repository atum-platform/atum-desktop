import { readFileSync } from 'node:fs'

import { expect, it, vi } from 'vitest'

import { projectPlanUsage, readPlanUsage } from './plan-usage'

const frames = JSON.parse(readFileSync(new URL('./fixtures/t3-plan-config.json', import.meta.url), 'utf8'))
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


// Work's pinned T3 config RPC, including the Effect request and exit frame.
it('exchanges the pinned plan config frames using the loopback owner ticket', async () => {
  const origin = 'http://127.0.0.1:8137'
  const close = vi.fn()
  const connect = vi.fn()
  const send = vi.fn()
  class Socket extends EventTarget {
    constructor(url: URL) {
      super()
      connect(url.href)
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }

    send(text: string) {
      send(JSON.parse(text))
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frames.response) }))
    }

    close() {
      close()
    }
  }
  const owner = { fetch: vi.fn(async () => Response.json(frames.ticket)) }
  vi.stubGlobal('WebSocket', Socket)
  vi.spyOn(Date, 'now').mockReturnValue(now)

  try {
    expect(await readPlanUsage(origin, owner)).toMatchObject([{ plan: 'codex', usedPercent: 45 }])
    expect(owner.fetch).toHaveBeenCalledWith(`${origin}/api/auth/websocket-ticket/rpc`,
      expect.objectContaining({ method: 'POST', credentials: 'include', redirect: 'error' }))
    expect(connect).toHaveBeenCalledWith('ws://127.0.0.1:8137/ws?orchestrationProtocol=2&wsTicket=fixture-ticket')
    expect(send).toHaveBeenCalledExactlyOnceWith(frames.request)
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})
