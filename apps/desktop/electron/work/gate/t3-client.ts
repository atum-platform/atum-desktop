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
  /**
   * Gate 4b-1: the plan instance, compiled in by main (Codex only; `PLAN_INSTANCE_IDS`). Absent: no plan launch is ever built.
   * `model` is the one T3 advertises first for the instance when it is connected; this names only which instance.
   */
  plan?: { instanceId: string }
  /** The tool names are T3's: `t3_thread_launch` and the rest. */
  restartWhenIdle?: T3Port['restartWhenIdle']
}

const NOT_READY = /authenticat|not installed|not found|disabled|log ?in|sign ?in|unavailable/iu

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

    // No `result` is not a success: a JSON-RPC error, a proxy page or an empty body must never read as one.
    return { transport: 'ok', status: reply.status, isError: result === undefined || result.isError === true, data, code: typeof code === 'string' ? code : null }
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

    const thread = (reply.data?.thread ?? {}) as {
      status?: string
      activeRunId?: string | null
      providerInstanceId?: string | null
    }

    const runs = ((reply.data?.recentRuns ?? []) as { runId: string; ordinal: number; status: string }[]).map(run => ({
      runId: run.runId,
      ordinal: run.ordinal,
      status: run.status
    }))

    return {
      kind: 'found',
      status: thread.status ?? 'idle',
      activeRunId: thread.activeRunId ?? undefined,
      ...(typeof thread.providerInstanceId === 'string' && thread.providerInstanceId
        ? { provider: thread.providerInstanceId }
        : {}),
      runs,
      raw: reply.data ?? {}
    }
  }

  const planProvider: NonNullable<T3Port['planProvider']> = async (token, instanceId = options.plan?.instanceId) => {
    if (!instanceId) {return { status: 'unknown' }}

    const reply = await call(token, 'orchestrator_capabilities', {}, {}, 20_000, true)

    if (reply.transport !== 'ok' || reply.isError || !Array.isArray(reply.data?.providers)) {
      return { status: 'unknown' }
    }

    const providers = reply.data.providers as {
      providerInstanceId?: string
      driverKind?: string
      models?: { id?: string }[]
      constraints?: unknown
    }[]

    const found = providers.find(item => item.providerInstanceId === instanceId && item.driverKind === instanceId)
    const models = [...new Set((found?.models ?? []).flatMap(model => (typeof model.id === 'string' && model.id.length > 0 && model.id.length <= 200 ? [model.id] : [])))].slice(0, 64)

    const constraints = Array.isArray(found?.constraints)
      ? (found.constraints as unknown[]).filter((item): item is string => typeof item === 'string')
      : []

    // T3's own words for "not ready": no models, or a constraint that says it is disabled, not installed or not signed in.
    // Fail closed: a plan is `connected` only when T3 lists a model and no such constraint.
    if (!found || models.length === 0 || constraints.some(item => NOT_READY.test(item))) {
      return { status: 'disconnected' }
    }

    return { status: 'connected', selection: { instanceId, model: models[0] as string }, models }
  }

  return {
    projects: (token, cursor) => call(token, 't3_project_list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) }, {}, 20_000, true),
    createProject: (token, input) => call(token, 't3_project_create', input, {}, 20_000, true),
    incarnation: options.incarnation,
    settingsFingerprint: () => fileFingerprint(options.settingsFile),
    read,
    pendingQuestion: (token, threadId, input) => call(token, 't3_pending_request', { threadId, ...input }, {}, 10_000, input.action !== 'respond'),
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
    // Present only when main configured a plan instance: a client without one cannot read, set or report a plan.
    ...(options.plan ? { planProvider } : {}),
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
    send: (token, args, modeLimit) => call(token, 't3_thread_send', args, { 'T3-Mode-Limit': modeLimit }, 30_000, false),
    configure: (token, threadId, modelSelection, modeLimit) => call(token, 't3_thread_configure', {threadId, modelSelection}, modeLimit ? { 'T3-Mode-Limit': modeLimit } : {}, 30_000, false),
    readPage: (token, threadId, afterPosition, item) => call(token, 't3_thread_read', {threadId, limit: 100, maxChars: 24000, ...(afterPosition === undefined ? {} : {afterPosition}), ...item}, {}, 30_000, true),
    launch: (token, args, modeLimit) => call(token, 't3_thread_launch', args, { 'T3-Mode-Limit': modeLimit }, 30_000, false),
    interrupt: (token, threadId, extra) =>
      call(token, 't3_thread_interrupt', { threadId, ...(extra?.stop ? { stop: true } : {}) }, {}, 30_000, true),
    wait: (token, threadId, runId, timeoutMs) => call(token, 't3_thread_wait', { threadId, runId, timeoutMs, untilDelegatedWorkSettled: true }, {}, timeoutMs + 10_000, true),
    // T3 answers `target_required` to a list from a client that is not inside a thread, unless it names a project or
    // `allProjects`. The gate always means "every project this session may see" (the peer fence still applies).
    list: (token, args) => call(token, 't3_thread_list', { ...args, allProjects: true }, {}, 30_000, true),
    restartWhenIdle: options.restartWhenIdle
  }
}
