import { z } from 'zod'

import type { WorkRelayLimit } from '../../../shared/matrix-work-relay'

const usageWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().optional(),
  windowDurationMins: z.number().int().positive().optional(),
  modelIds: z.array(z.string()).optional(),
  providerIds: z.array(z.string()).optional()
})

const WORK_PLAN_BY_DRIVER = { codex: 'codex', claudeAgent: 'claude' } as const

const providerStatus = z.object({
  driver: z.enum(['codex', 'claudeAgent']),
  instanceId: z.string(),
  enabled: z.boolean(),
  usageLimits: z.object({
    checkedAt: z.string(),
    windows: z.array(z.unknown()),
    unavailable: z.unknown().optional()
  })
})

type Usage = WorkRelayLimit & { windowStart?: number }

/** Keep only the most used account-wide window on the default plan instance. */
export function projectPlanUsage(providers: unknown, now: number): Usage[] {
  if (!Array.isArray(providers)) {return []}

  return providers.flatMap(value => {
    const parsed = providerStatus.safeParse(value)

    if (!parsed.success) {return []}

    const { driver, instanceId, enabled, usageLimits } = parsed.data
    const observedAt = Date.parse(usageLimits.checkedAt)

    if (!enabled || instanceId !== driver || usageLimits.unavailable || !Number.isFinite(observedAt)) {return []}

    const windows = usageLimits.windows.flatMap(value => {
      const window = usageWindow.safeParse(value)

      if (!window.success || window.data.modelIds?.length || window.data.providerIds?.length) {return []}

      const reset = Date.parse(window.data.resetsAt ?? '')

      if (Number.isFinite(reset) && reset <= now) {return []}

      return [{ ...window.data, reset: Number.isFinite(reset) ? reset : undefined }]
    }).sort((a, b) => b.usedPercent - a.usedPercent || (a.reset ?? Infinity) - (b.reset ?? Infinity))

    const window = windows[0]

    if (!window) {return []}

    const { usedPercent, reset: resetsAt, windowDurationMins } = window
    const windowStart = resetsAt !== undefined && windowDurationMins ? resetsAt - windowDurationMins * 60_000 : undefined

    return [{
      plan: WORK_PLAN_BY_DRIVER[driver], state: usedPercent === 100 ? 'exhausted' : 'available',
      observedAt, usedPercent, resetsAt, windowStart: windowStart !== undefined && windowStart <= now ? windowStart : undefined
    }]
  })
}

interface OwnerFetch {
  fetch(input: string, init: RequestInit): Promise<Response>
}

/** Native, read-only T3 config RPC via the existing local Work owner session. */
export async function readPlanUsage(origin: string, owner: OwnerFetch): Promise<Usage[]> {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin)) {return []}

  try {
    const ticket = await owner.fetch(`${origin}/api/auth/websocket-ticket/rpc`, {
      method: 'POST', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(2_000)
    })

    const body = ticket.ok ? await ticket.json() as { ticket?: unknown } : undefined

    if (typeof body?.ticket !== 'string' || !body.ticket) {return []}

    const url = new URL('/ws', origin)

    url.protocol = 'ws:'
    url.searchParams.set('orchestrationProtocol', '2')
    url.searchParams.set('wsTicket', body.ticket)

    const providers = await new Promise<unknown>(resolve => {
      const socket = new WebSocket(url)

      const finish = (value?: unknown) => {
        clearTimeout(timer)
        resolve(value)
        socket.close()
      }

      const timer = setTimeout(finish, 2_000)

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'server.getConfig', payload: {}, headers: [] }))
      }, { once: true })
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string' || event.data.length > 4_000_000) {return finish()}

        try {
          const frame = JSON.parse(event.data) as { _tag?: string; requestId?: string; exit?: { _tag?: string; value?: { providers?: unknown } } }

          if (frame._tag === 'Exit' && frame.requestId === '1') {
            finish(frame.exit?._tag === 'Success' ? frame.exit.value?.providers : undefined)
          }
        } catch {
          finish()
        }
      })
      socket.addEventListener('error', () => finish(), { once: true })
      socket.addEventListener('close', () => finish(), { once: true })
    })

    return projectPlanUsage(providers, Date.now())
  } catch {
    return []
  }
}
