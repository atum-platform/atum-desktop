import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { T3Port, T3Reply, ThreadRead } from './ports'

// The gate's HTTP client for T3's own `/mcp` on loopback (plan §11.2, S0-1, S0-4). Plain request and reply:
// initialise a session once per bearer, then `tools/call`. T3 checks the bearer once, as the request enters.

export interface T3ClientOptions {
  /** The loopback origin of the running session server, or undefined while none serves. */
  origin(): string | undefined
  incarnation(): string | undefined
  /** Where T3's settings file is (`<home>/userdata/settings.json`). Its contents are part of the fingerprint. */
  settingsFile: string
  delegated: { instanceId: string; model: string }
  fetch?: typeof fetch
  /** The tool names are T3's: `t3_thread_launch` and the rest. */
  restartWhenIdle?: T3Port['restartWhenIdle']
}

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

export function fileFingerprint(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return 'no-settings'
  }
}

export function createT3Client(options: T3ClientOptions): T3Port {
  const doFetch = options.fetch ?? fetch
  const sessions = new Map<string, string>()
  let nextId = 0

  const url = () => {
    const origin = options.origin()

    return origin ? `${origin}/mcp` : undefined
  }

  const post = async (token: string, body: unknown, extra: Record<string, string>, timeoutMs: number) => {
    const target = url()

    if (!target) {
      throw new Error('t3_not_serving')
    }

    const response = await doFetch(target, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${token}`, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })

    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    let json: { result?: Record<string, unknown>; error?: { message?: string } } | null = null

    try {
      if (contentType.includes('event-stream')) {
        const match = /data: (.*)/u.exec(text)
        json = match ? JSON.parse(match[1]) : null
      } else {
        json = JSON.parse(text)
      }
    } catch {
      json = null
    }

    return { status: response.status, json, sessionId: response.headers.get('mcp-session-id') }
  }

  const initialise = async (token: string): Promise<string | undefined> => {
    const reply = await post(
      token,
      {
        jsonrpc: '2.0',
        id: ++nextId,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'atum-work-gate', version: '1' } }
      },
      {},
      20_000
    )

    if (reply.sessionId) {
      sessions.set(token, reply.sessionId)
    }

    return reply.sessionId ?? undefined
  }

  const parse = (reply: Awaited<ReturnType<typeof post>>): T3Reply => {
    const result = reply.json?.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] } | undefined
    const text = result?.content?.find(item => item.type === 'text')?.text
    let data: Record<string, unknown> | null = result?.structuredContent ?? null

    if (!data && text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>
      } catch {
        data = { text }
      }
    }

    const code = (data?.code ?? data?.error ?? reply.json?.error?.message ?? null) as string | null

    return { transport: 'ok', status: reply.status, isError: result?.isError === true, data, code: typeof code === 'string' ? code : null }
  }

  const failed = (error: unknown): T3Reply => ({
    transport: 'failed',
    error: String((error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.name ?? error)
  })

  /** Started synchronously when the session is already open: no `await` stands before `fetch`. */
  const call = (token: string, name: string, args: unknown, extra: Record<string, string>, timeoutMs: number, mayInitialise: boolean): Promise<T3Reply> => {
    const sessionId = sessions.get(token)

    if (!sessionId && !mayInitialise) {
      return Promise.resolve({ transport: 'failed', error: 'session_not_prepared' })
    }

    const run = async (sid: string | undefined): Promise<T3Reply> => {
      const reply = await post(
        token,
        { jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name, arguments: args } },
        sid ? { 'mcp-session-id': sid, ...extra } : extra,
        timeoutMs
      )

      if (mayInitialise && (reply.status === 404 || reply.json?.error?.message?.includes('MCP-Session-Id'))) {
        sessions.delete(token)
        const fresh = await initialise(token)

        return parse(await post(token, { jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name, arguments: args } }, fresh ? { 'mcp-session-id': fresh, ...extra } : extra, timeoutMs))
      }

      return parse(reply)
    }

    return run(sessionId).catch(failed)
  }

  const read = async (token: string, threadId: string): Promise<ThreadRead> => {
    const reply = await call(token, 't3_thread_read', { threadId }, {}, 30_000, true)

    if (reply.transport !== 'ok') {
      return { kind: 'transport' }
    }

    if (reply.isError && reply.data?.code === 'thread_not_found') {
      return { kind: 'absent' }
    }

    if (reply.isError || reply.status !== 200) {
      return { kind: 'error', code: reply.code ?? `http_${reply.status}` }
    }

    const thread = (reply.data?.thread ?? {}) as { status?: string; activeRunId?: string | null }

    const runs = ((reply.data?.recentRuns ?? []) as { runId: string; ordinal: number; status: string }[]).map(run => ({
      runId: run.runId,
      ordinal: run.ordinal,
      status: run.status
    }))

    return {
      kind: 'found',
      status: thread.status ?? 'idle',
      activeRunId: thread.activeRunId ?? undefined,
      runs,
      raw: reply.data ?? {}
    }
  }

  return {
    incarnation: options.incarnation,
    settingsFingerprint: () => fileFingerprint(options.settingsFile),
    read,
    async providerReady(token) {
      const reply = await call(token, 'orchestrator_capabilities', {}, {}, 20_000, true)
      const providers = (reply.data?.providers ?? []) as { providerInstanceId?: string; models?: { id?: string }[] }[]

      return (
        reply.transport === 'ok' &&
        !reply.isError &&
        providers.some(
          provider =>
            provider.providerInstanceId === options.delegated.instanceId &&
            (provider.models ?? []).some(model => model.id === options.delegated.model)
        )
      )
    },
    async prepare(token) {
      if (sessions.has(token)) {
        return true
      }

      try {
        return Boolean(await initialise(token))
      } catch {
        return false
      }
    },
    launch: (token, args, modeLimit) => call(token, 't3_thread_launch', args, { 'T3-Mode-Limit': modeLimit }, 30_000, false),
    interrupt: (token, threadId, extra) =>
      call(token, 't3_thread_interrupt', { threadId, ...(extra?.stop ? { stop: true } : {}) }, {}, 30_000, true),
    wait: (token, threadId, runId, timeoutMs) => call(token, 't3_thread_wait', { threadId, runId, timeoutMs }, {}, timeoutMs + 10_000, true),
    list: (token, args) => call(token, 't3_thread_list', args, {}, 30_000, true),
    restartWhenIdle: options.restartWhenIdle
  }
}
