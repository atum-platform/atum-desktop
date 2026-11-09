import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { GatewayRpcError } from '../../../shared/src/json-rpc-gateway'
import type { TurnObservation } from '../../shared/atum-observability'
import type { MatrixContinuityRead } from '../../shared/matrix-continuity'
import { macOwnerFacts, MATRIX_TURN_CONTEXT_HEADER, MATRIX_TURN_STYLE } from '../../shared/matrix-turn-style'
import type { EncryptedStore } from '../encrypted-store'

import { continuityDiagnostic, validHistorySeed } from './continuity'
import { MatrixHermesExecutor } from './hermes-executor'
import type { MatrixHermesConnection } from './hermes-runtime'
import { MatrixHermesPreSubmissionError } from './hermes-turn'
import { MatrixTurnEffects } from './turn-effects'

function fixture(uniqueLiveSession = false, observe?: (observation: TurnObservation) => void) {
  const values = new Map<string, string>()

  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    failureCode: () => null,
    assertEncryptionAvailable: () => {}
  } as unknown as EncryptedStore

  type Event = { type: string; session_id?: string; payload?: unknown }
  const events = new Set<(event: Event) => void>()
  const ended = new AbortController()
  let sessionCount = 0
  let live = 'live'
  let automatic = true

  const emit = (type: string, payload: unknown, session_id = live) => {
    for (const handler of events) {
      handler({ type, payload, session_id })
    }
  }

  const emitUnscoped = (type: string, payload: unknown) => {
    for (const handler of events) {
      handler({ type, payload })
    }
  }

  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'session.create') {
      sessionCount++
      live = uniqueLiveSession ? `live-${sessionCount}` : 'live'

      return { session_id: live, stored_session_id: `stored-${sessionCount}`, async_delivery: false }
    }

    if (method === 'session.resume') {
      return { session_id: live, session_key: params.session_id, async_delivery: false, running: false }
    }

    if (method === 'prompt.submit' && automatic) {
      emit('message.complete', { status: 'complete', text: 'done' })
      emit('session.info', { running: false, stored_session_id: `stored-${sessionCount}` })
    }

    return { status: method === 'session.steer' ? 'queued' : 'streaming' }
  })

  const close = vi.fn(async () => {
    ended.abort()
  })

  const connection = {
    workspace: '/fixture/workspace',
    signal: ended.signal,
    close,
    gateway: {
      request,
      onAny: (handler: (event: Event) => void) => {
        events.add(handler)

        return () => {
          events.delete(handler)
        }
      },
      onState: (handler: (state: string) => void) => {
        handler('open')

        return () => {}
      }
    }
  } as unknown as MatrixHermesConnection

  const open = vi.fn(async (_signal: AbortSignal) => connection)
  const executor = new MatrixHermesExecutor(open, store, observe)

  const input = {
    conversationKey: `matrix-conversation-${'a'.repeat(64)}`,
    invocationId: 'one',
    text: 'test',
    signal: new AbortController().signal
  }

  return {
    executor,
    open,
    store,
    connection,
    close,
    request,
    input,
    emit,
    emitUnscoped,
    values,
    ended,
    pause: () => {
      automatic = false
    }
  }
}

function steerState(executor: MatrixHermesExecutor) {
  return executor as unknown as {
    busy: boolean
    activeConversation?: string
    sessions: Map<string, string>
  }
}

it('the resident executor rebases a resumed session using its native connection home', async () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atum-resident-workspace-')))
  const legacy = path.join(home, 'Atum')
  const workspace = path.join(legacy, 'Workspace')
  mkdirSync(workspace, { recursive: true })
  const f = fixture()
  f.connection.workspace = workspace
  f.connection.legacyWorkspace = legacy

  try {
    await f.executor.run(f.input)
    f.request.mockClear()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (...args) =>
      args[0] === 'session.resume' ? { ...(await original(...args)), info: { cwd: legacy } } : original(...args)
    )
    await f.executor.run({ ...f.input, invocationId: 'next' })
    const calls = f.request.mock.calls.map(call => call[0])
    expect(calls.indexOf('session.cwd.set')).toBeGreaterThan(calls.indexOf('session.resume'))
    expect(calls.indexOf('prompt.submit')).toBeGreaterThan(calls.indexOf('session.cwd.set'))
    expect(f.request.mock.calls.find(call => call[0] === 'session.cwd.set')?.[1]).toEqual({
      session_id: 'live',
      cwd: workspace
    })
    expect(f.open).toHaveBeenCalledOnce()
  } finally {
    await f.executor.close()
    rmSync(home, { recursive: true, force: true })
  }
})

it('hands a turn the owner hears narrated to Hermes with the shared turn style, and any other turn as it was', async () => {
  const f = fixture()

  try {
    await f.executor.run({ ...f.input, text: 'Lịch hôm nay?', turnStyle: true })
    await f.executor.run({ ...f.input, invocationId: 'next', text: 'Cảm ơn' })

    const submitted = f.request.mock.calls.filter(call => call[0] === 'prompt.submit').map(call => (call[1] as { text: string }).text)
    // The Mac adds only its own zone under the shared style; the locale region is never a place.
    const facts = macOwnerFacts()
    const place = facts.timeZone ? `\ntime zone: ${facts.timeZone} (from this Mac)` : ''
    expect(submitted).toEqual(['Lịch hôm nay?\n\n' + MATRIX_TURN_CONTEXT_HEADER + '\n' + MATRIX_TURN_STYLE + place, 'Cảm ơn'])
  } finally {
    await f.executor.close()
  }
})

it('streams background output after completion only to the original owned live session and retires on close', async () => {
  const f = fixture(true),
    one = vi.fn(),
    two = vi.fn()

  await f.executor.run({ ...f.input, onTerminal: one })
  await f.executor.run({ ...f.input, conversationKey: `matrix-conversation-${'b'.repeat(64)}`, onTerminal: two })
  f.emit('agent.terminal.output', { process_id: 'proc-1', chunk: 'later' }, 'live-1')
  f.emit('agent.terminal.output', { process_id: 'foreign', chunk: 'private' }, 'foreign')
  f.emit('agent.terminal.output', { process_id: 'proc-2', chunk: 'two' }, 'live-2')
  f.emit('terminal.close', { process_id: 'proc-1' }, 'live-1')
  expect(one.mock.calls.map(call => call[0])).toEqual([
    { kind: 'output', processId: 'proc-1', chunk: 'later' },
    { kind: 'close', processId: 'proc-1' }
  ])
  expect(two).toHaveBeenCalledExactlyOnceWith({ kind: 'output', processId: 'proc-2', chunk: 'two' })
  expect(f.request.mock.calls.some(call => call[0] === 'process.kill')).toBe(false)
  await f.executor.close()
  f.emit('agent.terminal.output', { process_id: 'proc-1', chunk: 'retired' }, 'live-1')
  expect(one).toHaveBeenCalledTimes(2)
})

it('steers its active task after that task session registers', async () => {
  vi.useFakeTimers()
  const f = fixture()

  try {
    await f.executor.connect(f.input.signal)
    const state = steerState(f.executor)
    state.busy = true
    state.activeConversation = f.input.conversationKey

    const pending = f.executor.steer(f.input.conversationKey, 'Use primary sources.')
    await vi.advanceTimersByTimeAsync(50)
    state.sessions.set(f.input.conversationKey, 'task-session')
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toBe(true)
    expect(f.request).toHaveBeenCalledWith(
      'session.steer',
      { session_id: 'task-session', text: 'Use primary sources.' },
      5_000,
      expect.any(AbortSignal)
    )
  } finally {
    vi.useRealTimers()
    await f.executor.close()
  }
})

it('does not acknowledge a steer after its matching task session ends', async () => {
  const f = fixture()
  let settle!: (value: { status: string }) => void

  const queued = new Promise<{ status: string }>(resolve => {
    settle = resolve
  })

  try {
    await f.executor.connect(f.input.signal)
    const state = steerState(f.executor)
    state.busy = true
    state.activeConversation = f.input.conversationKey
    state.sessions.set(f.input.conversationKey, 'task-session')
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (...args) => (args[0] === 'session.steer' ? queued : original(...args)))

    const pending = f.executor.steer(f.input.conversationKey, 'Use primary sources.')
    await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'session.steer')).toBe(true))
    state.busy = false
    state.activeConversation = undefined
    settle({ status: 'queued' })

    await expect(pending).resolves.toBe(false)
  } finally {
    await f.executor.close()
  }
})

it('does not steer a next owner conversation after its task ends before session registration', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const ownerConversation = `matrix-conversation-${'b'.repeat(64)}`

  try {
    await f.executor.connect(f.input.signal)
    const state = steerState(f.executor)
    state.busy = true
    state.activeConversation = f.input.conversationKey

    const pending = f.executor.steer(f.input.conversationKey, 'Use primary sources.')
    await vi.advanceTimersByTimeAsync(50)

    // The task ended with no live session. A later owner chat must not satisfy this wait.
    state.busy = false
    state.activeConversation = undefined
    state.busy = true
    state.activeConversation = ownerConversation
    state.sessions.set(ownerConversation, 'owner-session')
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toBe(false)
    expect(f.request.mock.calls.some(call => call[0] === 'session.steer')).toBe(false)
  } finally {
    vi.useRealTimers()
    await f.executor.close()
  }
})

it('reuses one runtime and one stored room session; another room gets a separate session', async () => {
  const f = fixture()
  await f.executor.connect(f.input.signal)
  await f.executor.run(f.input)
  await f.executor.run({ ...f.input, invocationId: 'two' })
  expect(f.open).toHaveBeenCalledTimes(1)
  expect(f.request.mock.calls.filter(call => call[0] === 'session.create')).toHaveLength(1)
  expect(f.request).toHaveBeenCalledWith(
    'session.resume',
    expect.objectContaining({ session_id: 'stored-1' }),
    expect.anything(),
    expect.anything()
  )
  await f.executor.run({ ...f.input, conversationKey: `matrix-conversation-${'b'.repeat(64)}` })
  expect(f.request.mock.calls.filter(call => call[0] === 'session.create')).toHaveLength(2)
  expect(f.values.size).toBe(2)
  expect(f.close).not.toHaveBeenCalled()
  await f.executor.close()
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.executor.usable).toBe(false)
})

it('propagates the optional presentation-only activity observer into its owned turn', async () => {
  const f = fixture()
  const onActivity = vi.fn()
  f.pause()
  const pending = f.executor.run({ ...f.input, onActivity })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))

  f.emit('message.delta', { text: 'Public response' })
  f.emit('tool.start', { name: 'terminal', args_text: 'private command' })
  f.emit('tool.complete', { name: 'terminal', result: 'private output' })
  f.emit('message.complete', { status: 'complete', text: 'done' })
  f.emit('session.info', { running: false, stored_session_id: 'stored-1' })

  await expect(pending).resolves.toEqual({ text: 'done', storedSession: 'stored-1' })
  expect(onActivity.mock.calls.at(-1)?.[0]).toEqual({
    invocationId: 'one',
    state: 'complete',
    text: 'done',
    tools: [{ name: 'Terminal', state: 'complete', summary: 'Completed' }]
  })
  expect(JSON.stringify(onActivity.mock.calls)).not.toContain('private')
  await f.executor.close()
})

it('forwards its optional turn observer without exposing a Matrix invocation or content', async () => {
  const observe = vi.fn<(observation: TurnObservation) => void>()
  const f = fixture(false, observe)
  await expect(f.executor.run(f.input)).resolves.toEqual({ text: 'done', storedSession: 'stored-1' })

  const observations = observe.mock.calls.map(([observation]) => observation)
  expect(observations).toMatchObject([{ phase: 'start' }, { phase: 'finish', outcome: 'completed' }])
  expect(observations.every(observation => observation.key === observations[0].key)).toBe(true)
  expect(JSON.stringify(observations)).not.toContain(f.input.invocationId)
  expect(JSON.stringify(observations)).not.toContain(f.input.text)
  await f.executor.close()
})

it('a new executor resumes the retained binding, never reconstructs history from Matrix text', async () => {
  const f = fixture()
  f.values.set(f.input.conversationKey, JSON.stringify({ version: 1, storedSession: 'retained-root' }))
  await f.executor.run(f.input)
  expect(f.request.mock.calls[0]).toEqual([
    'session.resume',
    { session_id: 'retained-root', source: 'matrix', async_delivery: false },
    15000,
    expect.any(AbortSignal)
  ])
  expect(f.request.mock.calls.some(call => call[0] === 'session.create')).toBe(false)
  await f.executor.close()
})

it('concurrent turns are rejected; cancellation reaps the process before returning uncertainty', async () => {
  const f = fixture()
  const abort = new AbortController()
  f.pause()
  const pending = f.executor.run({ ...f.input, signal: abort.signal })
  const rejected = expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  await expect(f.executor.run(f.input)).rejects.toThrow('matrix_hermes_busy')
  abort.abort()
  await rejected
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.executor.usable).toBe(false)
  expect(f.values.has(f.input.conversationKey)).toBe(true)
})

it('keeps the resident runtime when a tracked visible model-only turn is cancelled', async () => {
  const f = fixture()
  const abort = new AbortController()
  const effects = new MatrixTurnEffects()
  const original = f.request.getMockImplementation()!
  f.pause()
  f.request.mockImplementation(async (...args) =>
    args[0] === 'config.get' ? ({ value: 'new' } as never) : original(...args)
  )
  const pending = f.executor.run({ ...f.input, signal: abort.signal, effects })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  abort.abort()
  await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(f.close).not.toHaveBeenCalled()
  expect(f.executor.usable).toBe(true)
  await f.executor.close()
})

it.each([
  ['active', false, true],
  ['completed with possible background work', true, true]
] as const)(
  '%s tracked tool decides whether cancellation reaps the resident runtime',
  async (_label, complete, reaped) => {
    const f = fixture()
    const abort = new AbortController()
    const effects = new MatrixTurnEffects()
    const original = f.request.getMockImplementation()!
    f.pause()
    f.request.mockImplementation(async (...args) =>
      args[0] === 'config.get' ? ({ value: 'new' } as never) : original(...args)
    )
    const pending = f.executor.run({ ...f.input, signal: abort.signal, effects })
    await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
    f.emit('tool.start', { name: 'read_file' })

    if (complete) {
      f.emit('tool.complete', { name: 'read_file' })
    }

    abort.abort()
    await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(f.close).toHaveBeenCalledTimes(reaped ? 1 : 0)
    expect(f.executor.usable).toBe(!reaped)

    if (!reaped) {
      await f.executor.close()
    }
  }
)

it('reaps when a submitted tool event arrives without its required session scope', async () => {
  const f = fixture()
  const abort = new AbortController()
  const effects = new MatrixTurnEffects()
  const original = f.request.getMockImplementation()!
  f.pause()
  f.request.mockImplementation(async (...args) =>
    args[0] === 'config.get' ? ({ value: 'new' } as never) : original(...args)
  )
  const pending = f.executor.run({ ...f.input, signal: abort.signal, effects })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  f.emitUnscoped('tool.start', { name: 'terminal' })
  abort.abort()
  await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.executor.usable).toBe(false)
})

it.each([false, true])(
  'keeps a healthy runtime after explicit attachment rejection (existing room=%s), without submitting or replaying that turn',
  async existing => {
    const f = fixture()

    if (existing) {
      await f.executor.run(f.input)
    }

    f.request.mockClear()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method, params) => {
      if (method === 'file.attach') {
        throw new GatewayRpcError('private disk-full details', 5028)
      }

      if (!existing && method === 'session.resume') {
        throw new GatewayRpcError('unused draft was closed', 4007)
      }

      return original(method, params)
    })
    await expect(
      f.executor.run({
        ...f.input,
        invocationId: 'file',
        attachments: [{ name: 'report.txt', bytes: new Uint8Array([1]) }]
      })
    ).rejects.toMatchObject({ message: 'matrix_hermes_session_rejected', rpcCode: 5028 })
    expect(f.request.mock.calls.map(call => call[0])).toEqual(
      existing ? ['session.resume', 'file.attach'] : ['session.create', 'file.attach', 'session.close']
    )

    if (!existing) {
      expect(JSON.parse(f.values.get(f.input.conversationKey)!)).toMatchObject({ unsubmittedInvocation: 'file' })
    }

    expect(f.executor.usable).toBe(true)
    expect(f.close).not.toHaveBeenCalled()
    await expect(f.executor.run({ ...f.input, invocationId: 'new-authorized-turn' })).resolves.toMatchObject({
      text: 'done'
    })
    expect(f.open).toHaveBeenCalledTimes(1)
    expect(f.request.mock.calls.filter(call => call[0] === 'prompt.submit')).toHaveLength(1)
    await f.executor.close()
  }
)

it.each([
  'null',
  '{}',
  '{',
  '{"version":3,"storedSession":"old"}',
  '{"version":1,"storedSession":"old","unsubmittedInvocation":"old-event"}',
  '{"version":2,"storedSession":"old","unsubmittedInvocation":null}'
])('never replaces an unreadable binding: %s', async raw => {
  const f = fixture()
  f.values.set(f.input.conversationKey, raw)
  await expect(f.executor.run(f.input)).rejects.toBeInstanceOf(MatrixHermesPreSubmissionError)
  expect(f.open).not.toHaveBeenCalled()
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
  expect(f.executor.usable).toBe(true)
  expect(f.close).not.toHaveBeenCalled()
})

it('replaces a never-submitted missing draft only for a new invocation, fencing the replacement before sending', async () => {
  const f = fixture()
  const allocated = { version: 2, storedSession: 'abandoned', unsubmittedInvocation: 'prior-event' }
  f.values.set(f.input.conversationKey, JSON.stringify(allocated))
  const remember = vi.spyOn(f.store, 'setItem')
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (method, params) => {
    if (method === 'session.resume') {
      throw new GatewayRpcError('private message', 4007)
    }

    if (method === 'prompt.submit') {
      expect(JSON.parse(f.values.get(f.input.conversationKey)!)).toEqual({ version: 2, storedSession: 'stored-1' })
    }

    return original(method, params)
  })
  await expect(f.executor.run(f.input)).resolves.toMatchObject({ text: 'done' })
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume', 'session.create', 'prompt.submit'])
  expect(remember.mock.calls.map(call => JSON.parse(call[1]))).toEqual([
    { version: 2, storedSession: 'stored-1', unsubmittedInvocation: 'one' },
    { version: 2, storedSession: 'stored-1' },
    { version: 2, storedSession: 'stored-1' }
  ])
  expect(f.close).not.toHaveBeenCalled()
  await f.executor.close()
})

it.each([
  { version: 1, storedSession: 'missing' },
  { version: 2, storedSession: 'missing' },
  { version: 2, storedSession: 'missing', unsubmittedInvocation: 'one' }
])('does not replace confirmed, legacy or same-invocation missing history: %j', async record => {
  const f = fixture()
  const raw = JSON.stringify(record)
  f.values.set(f.input.conversationKey, raw)
  f.request.mockRejectedValue(new GatewayRpcError('private', 4007))
  await expect(f.executor.run(f.input)).rejects.toMatchObject({ rpcCode: 4007 })
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume'])
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
  expect(f.executor.usable).toBe(true)
  expect(f.close).not.toHaveBeenCalled()
  await f.executor.close()
})

it.each([4090, 5000, 4009])('does not mistake structured resume rejection %i for missing history', async code => {
  const f = fixture()
  const raw = JSON.stringify({ version: 2, storedSession: 'draft', unsubmittedInvocation: 'prior' })
  f.values.set(f.input.conversationKey, raw)
  f.request.mockRejectedValue(new GatewayRpcError('session not found', code))
  await expect(f.executor.run(f.input)).rejects.toMatchObject({ rpcCode: code })
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume'])
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
  expect(f.close).not.toHaveBeenCalled()
  await f.executor.close()
})

it('bounds allocation recovery to one create, including when Hermes is at capacity', async () => {
  const f = fixture()
  const raw = JSON.stringify({ version: 2, storedSession: 'draft', unsubmittedInvocation: 'prior' })
  f.values.set(f.input.conversationKey, raw)
  f.request
    .mockRejectedValueOnce(new GatewayRpcError('missing', 4007))
    .mockRejectedValue(new GatewayRpcError('limit', 4090))
  await expect(f.executor.run(f.input)).rejects.toMatchObject({ rpcCode: 4090 })
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume', 'session.create'])
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
  expect(f.executor.usable).toBe(true)
  await f.executor.close()
})

it('cancellation wins over a structured missing-draft response and cannot start recovery', async () => {
  const f = fixture()
  const abort = new AbortController()
  const raw = JSON.stringify({ version: 2, storedSession: 'draft', unsubmittedInvocation: 'prior' })
  f.values.set(f.input.conversationKey, raw)
  f.request.mockImplementation(async () => {
    abort.abort()
    throw new GatewayRpcError('missing', 4007)
  })
  await expect(f.executor.run({ ...f.input, signal: abort.signal })).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume'])
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.executor.usable).toBe(false)
})

it('cancelling with a created draft closes it without interrupt/submit, then reaps the runtime', async () => {
  const f = fixture()
  const abort = new AbortController()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (method, params) => {
    const result = await original(method, params)

    if (method === 'session.create') {
      abort.abort()
    }

    return result
  })
  await expect(f.executor.run({ ...f.input, signal: abort.signal })).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.create', 'session.close'])
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.executor.usable).toBe(false)
})

it('keeps a healthy existing conversation usable when another room hits Hermes slot capacity', async () => {
  const f = fixture()
  await f.executor.run(f.input)
  f.request.mockRejectedValueOnce(new GatewayRpcError('capacity private details', 4090))
  const other = { ...f.input, conversationKey: `matrix-conversation-${'b'.repeat(64)}`, invocationId: 'other' }
  await expect(f.executor.run(other)).rejects.toMatchObject({
    message: 'matrix_hermes_session_rejected',
    rpcCode: 4090
  })
  expect(f.values.has(other.conversationKey)).toBe(false)
  await expect(f.executor.run({ ...f.input, invocationId: 'later' })).resolves.toMatchObject({ text: 'done' })
  expect(f.open).toHaveBeenCalledTimes(1)
  expect(f.close).not.toHaveBeenCalled()
  await f.executor.close()
})

it.each([1, 2])('closes only its unused draft when vault write %i fails before submission', async failedWrite => {
  const f = fixture()
  let writes = 0
  vi.spyOn(f.store, 'setItem').mockImplementation((key, value) => {
    if (++writes === failedWrite) {
      throw new Error('private vault failure')
    }

    f.values.set(key, value)
  })
  await expect(f.executor.run(f.input)).rejects.toBeInstanceOf(MatrixHermesPreSubmissionError)
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.create', 'session.close'])
  expect(f.close).not.toHaveBeenCalled()

  if (failedWrite === 2) {
    expect(JSON.parse(f.values.get(f.input.conversationKey)!)).toMatchObject({ unsubmittedInvocation: 'one' })
  } else {
    expect(f.values.has(f.input.conversationKey)).toBe(false)
  }

  expect(f.executor.usable).toBe(true)
  await f.executor.close()
})

it('keeps other conversations alive on a local vault read failure, without sending or replacing history', async () => {
  const f = fixture()
  await f.executor.run(f.input)
  const before = f.request.mock.calls.length
  vi.spyOn(f.store, 'getItem').mockImplementationOnce(() => {
    throw new Error('private')
  })
  await expect(f.executor.run({ ...f.input, invocationId: 'later' })).rejects.toBeInstanceOf(
    MatrixHermesPreSubmissionError
  )
  expect(f.request).toHaveBeenCalledTimes(before)
  expect(f.close).not.toHaveBeenCalled()
  await f.executor.close()
})

it.each(['resume', 'submit', 'draft-close'])('retires the process on ambiguous %s failure', async stage => {
  const f = fixture()
  const original = f.request.getMockImplementation()!

  if (stage === 'resume') {
    f.values.set(
      f.input.conversationKey,
      JSON.stringify({ version: 2, storedSession: 'draft', unsubmittedInvocation: 'prior' })
    )
  }

  if (stage === 'draft-close') {
    vi.spyOn(f.store, 'setItem').mockImplementation(() => {
      throw new Error('private')
    })
  }

  f.request.mockImplementation(async (method, params) => {
    if (
      (stage === 'resume' && method === 'session.resume') ||
      (stage === 'draft-close' && method === 'session.close')
    ) {
      // A string resembling not-found (or a plain code field) is NOT a structured RPC rejection.
      throw Object.assign(new Error('session not found'), { code: 4007 })
    }

    if (stage === 'submit' && method === 'prompt.submit') {
      throw new GatewayRpcError('rejected', 4090)
    }

    return original(method, params)
  })
  await expect(f.executor.run(f.input)).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.executor.usable).toBe(false)
  expect(f.request.mock.calls.filter(call => call[0] === 'prompt.submit')).toHaveLength(stage === 'submit' ? 1 : 0)
})

it('lost runtime transport marks the executor unusable and never reconnects/replays implicitly', async () => {
  const f = fixture()
  await f.executor.connect(f.input.signal)
  f.ended.abort()
  expect(f.executor.usable).toBe(false)
  await expect(f.executor.run(f.input)).rejects.toThrow('unknown')
  expect(f.request).not.toHaveBeenCalled()
  expect(f.open).toHaveBeenCalledTimes(1)
})

it('close during startup waits for the late child connection and reaps it', async () => {
  const f = fixture()
  let finish!: (connection: MatrixHermesConnection) => void
  f.open.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const pending = f.executor.connect(f.input.signal)
  const rejected = expect(pending).rejects.toThrow('stopped')
  const stopped = f.executor.close()
  expect(f.open.mock.calls[0][0].aborted).toBe(true)
  finish(f.connection)
  await Promise.all([rejected, stopped])
  expect(f.close).toHaveBeenCalledTimes(1)
})

const history = (pairs: string[] = [], stopAt?: string): MatrixContinuityRead => {
  const entries: MatrixContinuityRead['entries'] = pairs.flatMap(id => [
    { eventId: `$${id}`, role: 'assistant' as const, text: `answer ${id}`, invocationId: id },
    { eventId: `$q-${id}`, role: 'user' as const, text: `question ${id}` }
  ])

  const stop = entries.findIndex(row => row.eventId === stopAt)

  return {
    roomId: '!room:test',
    ownerId: '@owner:test',
    agentId: '@agent:test',
    entries: stop >= 0 ? entries.slice(0, stop + 1) : entries,
    reachedStop: !stopAt || stop >= 0,
    gaps: 0,
    uncertainAgent: false
  }
}

it('keeps a normal local session, including publication lag, then refreshes exactly once when another machine answered', async () => {
  const f = fixture()
  let pairs = ['prior']
  const read = vi.fn(async (stopAt?: string) => history(pairs, stopAt))
  const input = { ...f.input, continuity: { read } }
  await f.executor.run(input)
  expect(f.request).toHaveBeenCalledWith(
    'session.create',
    expect.objectContaining({
      messages: [
        { role: 'user', content: 'question prior' },
        { role: 'assistant', content: 'answer prior' }
      ]
    }),
    expect.anything(),
    expect.anything()
  )
  // Completion is remembered before Matrix publication. No needless re-seed.
  await f.executor.run({ ...input, invocationId: 'two' })
  expect(f.request.mock.calls.filter(call => call[0] === 'session.create')).toHaveLength(1)
  // An older local answer arrives AFTER a foreign machine's answer. The whole
  // interval is checked so the newest own answer cannot hide foreign progress.
  pairs = ['two', 'foreign', 'one', 'prior']
  await f.executor.run({ ...input, invocationId: 'three' })
  expect(f.request.mock.calls.filter(call => call[0] === 'session.create')).toHaveLength(2)
  const refreshed = f.request.mock.calls.filter(call => call[0] === 'session.create').at(-1)![1].messages
  expect(refreshed).toContainEqual({ role: 'assistant', content: 'answer foreign' })
  // The resume decision reads to the anchor in full; the re-seed may keep only the newest dialogue.
  expect(read.mock.calls.slice(-2)).toEqual([['$prior'], [undefined, { bounded: true }]])
  await f.executor.run({ ...input, invocationId: 'four' })
  expect(f.request.mock.calls.filter(call => call[0] === 'session.create')).toHaveLength(2)
  expect(JSON.parse(f.values.get(f.input.conversationKey)!)).toMatchObject({
    continuity: { anchor: '$two', ours: ['three', 'four'] }
  })
  await f.executor.close()
})

it('A → B → A carries the visible conversation while each machine retains its own local Hermes binding', async () => {
  const a = fixture()
  const b = fixture()
  let pairs: string[] = []
  const continuity = { read: async (stopAt?: string) => history(pairs, stopAt) }
  await a.executor.run({ ...a.input, invocationId: 'a1', continuity })
  pairs = ['a1']
  await b.executor.run({ ...b.input, invocationId: 'b1', continuity })
  expect(b.request.mock.calls[0][1]).toMatchObject({
    messages: [
      { role: 'user', content: 'question a1' },
      { role: 'assistant', content: 'answer a1' }
    ]
  })
  pairs = ['b1', 'a1']
  await a.executor.run({ ...a.input, invocationId: 'a2', continuity })
  expect(a.request.mock.calls.filter(call => call[0] === 'session.create').at(-1)![1]).toMatchObject({
    messages: [
      { role: 'user', content: 'question a1' },
      { role: 'assistant', content: 'answer a1' },
      { role: 'user', content: 'question b1' },
      { role: 'assistant', content: 'answer b1' }
    ]
  })
  expect(a.values.get(a.input.conversationKey)).not.toEqual(b.values.get(b.input.conversationKey))
  await Promise.all([a.executor.close(), b.executor.close()])
})

it.each([undefined, { ours: 'broken' }])(
  'upgrades legacy or malformed witness without deleting old Hermes history',
  async continuity => {
    const f = fixture()
    f.values.set(f.input.conversationKey, JSON.stringify({ version: 2, storedSession: 'old', continuity }))
    await f.executor.run({ ...f.input, continuity: { read: async () => history(['prior']) } })
    expect(f.request.mock.calls[0][0]).toBe('session.create')
    expect(f.request.mock.calls.some(call => call[0] === 'session.delete')).toBe(false)
    await f.executor.close()
  }
)

it('refuses to submit on SDK history failure or cancellation and leaves the old binding intact', async () => {
  const f = fixture()
  const raw = JSON.stringify({ version: 2, storedSession: 'retained' })
  f.values.set(f.input.conversationKey, raw)

  const read = vi.fn(async (): Promise<MatrixContinuityRead> => {
    throw new Error('private network detail')
  })

  await expect(f.executor.run({ ...f.input, continuity: { read } })).rejects.toThrow(
    'matrix_hermes_continuity_unavailable'
  )
  expect(f.request).not.toHaveBeenCalled()
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
  const abort = new AbortController()
  read.mockImplementation(async () => {
    abort.abort()

    return history()
  })
  await expect(f.executor.run({ ...f.input, signal: abort.signal, continuity: { read } })).rejects.toThrow(
    'outcome_unknown'
  )
  expect(f.request).not.toHaveBeenCalled()
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
})

// A stored session this Mac's Hermes home no longer has (never persisted: Hermes writes the row
// only at prompt.submit; or the agent's home moved) used to strand the room: every message
// failed with matrix_hermes_session_rejected. With the room's history at hand, a new message
// starts a session seeded from the room, as a new or migrated conversation does.
it('replaces a stored session missing from this Hermes home with one seeded from the room', async () => {
  const f = fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.values.set(
    f.input.conversationKey,
    JSON.stringify({ version: 2, storedSession: 'gone-from-home', continuity: { anchor: '$prior', ours: ['prior'] } })
  )
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (method, params) => {
    if (method === 'session.resume') {
      throw new GatewayRpcError('session not found', 4007)
    }

    if (method === 'prompt.submit') {
      // The replacement is the conversation's durable link before anything is sent.
      expect(JSON.parse(f.values.get(f.input.conversationKey)!)).toMatchObject({ storedSession: 'stored-1' })
      expect(JSON.parse(f.values.get(f.input.conversationKey)!)).not.toHaveProperty('unsubmittedInvocation')
    }

    return original(method, params)
  })
  const read = vi.fn(async (stopAt?: string) => history(['prior'], stopAt))

  try {
    await expect(f.executor.run({ ...f.input, continuity: { read } })).resolves.toMatchObject({
      text: 'done',
      storedSession: 'stored-1'
    })
    expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume', 'session.create', 'prompt.submit'])
    expect(f.request.mock.calls[1][1]).toMatchObject({
      messages: [
        { role: 'user', content: 'question prior' },
        { role: 'assistant', content: 'answer prior' }
      ]
    })
    // Witness read first, then the room read that seeds the replacement.
    expect(read.mock.calls).toEqual([['$prior'], [undefined, { bounded: true }]])
    expect(JSON.parse(f.values.get(f.input.conversationKey)!)).toEqual({
      version: 2,
      storedSession: 'stored-1',
      continuity: { anchor: '$prior', ours: ['one'] }
    })
    const lines = warn.mock.calls.map(call => call.join(' ')).filter(line => line.includes('session replaced'))
    expect(lines).toEqual(['[Matrix] conversation session replaced reason=stored_session_missing seed=room'])
    expect(f.close).not.toHaveBeenCalled()
    // Healed: the next message resumes the replacement, nothing is replaced again.
    f.request.mockImplementation(original)
    await f.executor.run({ ...f.input, invocationId: 'two', continuity: { read } })
    expect(f.request.mock.calls.slice(3).map(call => call[0])).toEqual(['session.resume', 'prompt.submit'])
    expect(f.request.mock.calls[3][1]).toMatchObject({ session_id: 'stored-1' })
  } finally {
    warn.mockRestore()
    await f.executor.close()
  }
})

it.each([4009, 4090, 5000])(
  'keeps refusing a stored session rejected with %i even with the room at hand',
  async code => {
    const f = fixture()
    const raw = JSON.stringify({ version: 2, storedSession: 'kept', continuity: { anchor: '$prior', ours: ['prior'] } })
    f.values.set(f.input.conversationKey, raw)
    f.request.mockRejectedValue(new GatewayRpcError('rejected', code))
    await expect(
      f.executor.run({ ...f.input, continuity: { read: async stopAt => history(['prior'], stopAt) } })
    ).rejects.toMatchObject({ rpcCode: code })
    expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume'])
    expect(f.values.get(f.input.conversationKey)).toBe(raw)
    await f.executor.close()
  }
)

it('never replaces a missing stored session without a full room read', async () => {
  const f = fixture()
  const raw = JSON.stringify({ version: 2, storedSession: 'kept', continuity: { anchor: '$prior', ours: ['prior'] } })
  f.values.set(f.input.conversationKey, raw)
  f.request.mockRejectedValue(new GatewayRpcError('session not found', 4007))

  const read = vi.fn(async (stopAt?: string) => {
    if (!stopAt) {
      throw new Error('private network detail')
    }

    return history(['prior'], stopAt)
  })

  await expect(f.executor.run({ ...f.input, continuity: { read } })).rejects.toThrow(
    'matrix_hermes_continuity_unavailable'
  )
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume'])
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
  expect(f.executor.usable).toBe(true)
  await f.executor.close()
})

it('re-seeds a known unused draft instead of falling back to a context-free replacement', async () => {
  const f = fixture()
  f.values.set(
    f.input.conversationKey,
    JSON.stringify({
      version: 2,
      storedSession: 'draft',
      unsubmittedInvocation: 'old',
      continuity: { anchor: '$prior', ours: [] }
    })
  )
  await f.executor.run({ ...f.input, continuity: { read: async stopAt => history(['prior'], stopAt) } })
  expect(f.request.mock.calls[0][0]).toBe('session.create')
  expect(f.request.mock.calls[0][1]).toHaveProperty('messages')
  await f.executor.close()
})

it.each([{ gaps: 1, uncertainAgent: true }, { reachedStop: false }, { gaps: 1 }])(
  'uses only the bounded verified subset on a fresh partial read (%j), with content-free diagnostics',
  async partial => {
    const f = fixture()
    const snapshot = { ...history(['visible']), ...partial }
    await f.executor.run({ ...f.input, continuity: { read: async () => snapshot } })
    const seed = f.request.mock.calls[0][1].messages
    expect(validHistorySeed(seed)).toBe(true)
    expect(seed).toEqual([
      { role: 'user', content: 'question visible' },
      { role: 'assistant', content: 'answer visible' }
    ])
    const notice = continuityDiagnostic(snapshot)!
    expect(notice).toMatch(/^\[Matrix\] conversation history partial: verified=2, gaps=[01], bounded=(true|false)$/)
    expect(notice).not.toMatch(/visible|question|answer|!room|@owner|@agent/)
    await f.executor.close()
  }
)

it('closes only the idle live session opened by this executor when foreign progress creates a replacement', async () => {
  const f = fixture(true)
  await f.executor.run({ ...f.input, continuity: { read: async () => history() } })
  await f.executor.run({ ...f.input, invocationId: 'second', continuity: { read: async () => history(['foreign']) } })
  expect(f.request.mock.calls.filter(call => call[0] === 'session.close')).toEqual([
    ['session.close', { session_id: 'live-1' }, 2_000]
  ])
  await f.executor.run({
    ...f.input,
    invocationId: 'third',
    continuity: { read: async stopAt => history(['foreign'], stopAt) }
  })
  expect(f.request.mock.calls.filter(call => call[0] === 'session.create')).toHaveLength(2)
  await f.executor.close()
})

it('preserves the disclosed audience across session-link rewrites without changing session arguments', async () => {
  const f = fixture()
  const input = { ...f.input, sharedRoom: true }
  await f.executor.run(input)
  const disclosedAudience = { members: ['@guest:test'], epoch: 'a'.repeat(64) }
  f.store.setItem(
    input.conversationKey,
    JSON.stringify({
      ...JSON.parse(f.values.get(input.conversationKey)!),
      disclosedAudience
    })
  )
  await f.executor.run({ ...input, invocationId: 'two' })
  expect(JSON.parse(f.values.get(input.conversationKey)!)).toMatchObject({ disclosedAudience, sharedRoom: true })
  const calls = f.request.mock.calls.filter(([method]) => method === 'session.create' || method === 'session.resume')
  expect(calls.map(([method]) => method)).toEqual(['session.create', 'session.resume'])

  for (const [, args] of calls) {
    expect(args).not.toHaveProperty('disclosedAudience')
  }

  await f.executor.close()
})

it('runs a shared group’s turns in a restricted session, created and resumed so, apart from the private one', async () => {
  const f = fixture()
  const group = { ...f.input, conversationKey: `matrix-conversation-${'b'.repeat(64)}`, sharedRoom: true }

  await f.executor.run(group)
  await f.executor.run({ ...group, invocationId: 'two' })
  await f.executor.run(f.input)

  const calls = f.request.mock.calls.filter(([method]) => method === 'session.create' || method === 'session.resume')

  // The group's session asks Hermes for the restricted kind, on create and on every resume.
  expect(calls[0]).toEqual([
    'session.create',
    expect.objectContaining({ shared_room: true }),
    15_000,
    expect.anything()
  ])
  expect(calls[1]).toEqual([
    'session.resume',
    expect.objectContaining({ shared_room: true }),
    15_000,
    expect.anything()
  ])
  // The private session never does: its system prompt and tools are exactly as before.
  expect(calls[2]![0]).toBe('session.create')
  expect(calls[2]![1]).not.toHaveProperty('shared_room')
  expect(JSON.parse(f.values.get(group.conversationKey)!)).toMatchObject({ sharedRoom: true })
  expect(JSON.parse(f.values.get(f.input.conversationKey)!)).not.toHaveProperty('sharedRoom')
})

it('never resumes a session as the other kind: restricted stays restricted, private stays private', async () => {
  const f = fixture()
  const group = { ...f.input, conversationKey: `matrix-conversation-${'c'.repeat(64)}` }

  await f.executor.run({ ...group, sharedRoom: true })
  await expect(f.executor.run({ ...group, invocationId: 'two' })).rejects.toThrow('matrix_hermes_conversation_invalid')

  await f.executor.run(f.input)
  await expect(f.executor.run({ ...f.input, invocationId: 'two', sharedRoom: true })).rejects.toThrow(
    'matrix_hermes_conversation_invalid'
  )
  expect(f.request.mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(2)
})

it('leaves the private session alone across a group turn: same stored session, same request, nothing closed', async () => {
  const f = fixture(true)
  const group = { ...f.input, conversationKey: `matrix-conversation-${'d'.repeat(64)}`, sharedRoom: true }

  await f.executor.run(f.input)
  const privateLink = f.values.get(f.input.conversationKey)
  await f.executor.run({ ...group, invocationId: 'group-one' })

  // The group turn opened its own session and touched nothing of the private one.
  expect(f.values.get(f.input.conversationKey)).toBe(privateLink)
  expect(f.request.mock.calls.filter(([method]) => method === 'session.close')).toEqual([])
  expect(f.request.mock.calls.filter(([method]) => method === 'session.resume')).toEqual([])

  // The private chat resumes its own stored session, asked for exactly as before.
  await f.executor.run({ ...f.input, invocationId: 'two' })
  const resumed = f.request.mock.calls.filter(([method]) => method === 'session.resume')
  expect(resumed).toHaveLength(1)
  expect(resumed[0]![1]).toEqual({ session_id: 'stored-1', source: 'matrix', async_delivery: false })
})

it('persists a reply-only profile through native create/resume and refuses a cross-profile vault link', async () => {
  const f = fixture()
  const input = { ...f.input, replyOnly: true }
  await f.executor.run(input)
  await f.executor.run({ ...input, invocationId: 'second' })
  const sessions = f.request.mock.calls.filter(call => call[0] === 'session.create' || call[0] === 'session.resume')
  expect(sessions.map(call => call[1])).toEqual([
    expect.objectContaining({ reply_only: true }),
    expect.objectContaining({ reply_only: true })
  ])
  expect(JSON.parse(f.values.get(input.conversationKey)!)).toMatchObject({ replyOnly: true })
  await expect(f.executor.run({ ...input, replyOnly: false, invocationId: 'third' })).rejects.toThrow(
    'matrix_hermes_conversation_invalid'
  )
  await f.executor.close()
})

it('persists first learning as its own immutable read-only session profile', async () => {
  const f = fixture()
  const input = { ...f.input, firstLearning: true }
  await f.executor.run(input)
  await f.executor.run({ ...input, invocationId: 'second' })
  const sessions = f.request.mock.calls.filter(call => call[0] === 'session.create' || call[0] === 'session.resume')
  expect(sessions.map(call => call[1])).toEqual([
    expect.objectContaining({ first_learning: true }),
    expect.objectContaining({ first_learning: true })
  ])
  expect(JSON.parse(f.values.get(input.conversationKey)!)).toMatchObject({ firstLearning: true })
  await expect(f.executor.run({ ...input, firstLearning: false, invocationId: 'third' })).rejects.toThrow(
    'matrix_hermes_conversation_invalid'
  )
  await f.executor.close()
})

it('persists the private pet profile and sends it unchanged on create and cold resume', async () => {
  const f = fixture()
  await f.executor.run({ ...f.input, petSurface: true })
  expect(JSON.parse(f.values.get(f.input.conversationKey)!)).toMatchObject({ petSurface: true })
  const resumed = new MatrixHermesExecutor(f.open, f.store)
  await resumed.run({ ...f.input, invocationId: 'two', petSurface: true })
  const calls = f.request.mock.calls.filter(([method]) => method === 'session.create' || method === 'session.resume')
  expect(calls.map(([method]) => method)).toEqual(['session.create', 'session.resume'])
  expect(calls.every(([, params]) => params.pet_surface === true)).toBe(true)
})

it.each([true, false])('rejects a persisted pet profile mismatch before opening a runtime: stored=%s', async stored => {
  const f = fixture()
  f.values.set(
    f.input.conversationKey,
    JSON.stringify({ version: 2, storedSession: 'stored', ...(stored ? { petSurface: true } : {}) })
  )
  await expect(f.executor.run({ ...f.input, petSurface: !stored })).rejects.toThrow('conversation_invalid')
  expect(f.open).not.toHaveBeenCalled()
  expect(f.request).not.toHaveBeenCalled()
})

it.each([true, false])('restricted profiles cannot acquire the pet tool: shared=%s', async sharedRoom => {
  const f = fixture()
  await f.executor.run({ ...f.input, petSurface: true, sharedRoom, replyOnly: !sharedRoom })
  expect(JSON.parse(f.values.get(f.input.conversationKey)!)).not.toHaveProperty('petSurface')
  const create = f.request.mock.calls.find(([method]) => method === 'session.create')![1]
  expect(create).not.toHaveProperty('pet_surface')
})

// 0.20 turn path: what can refuse without Hermes is done before dispatch (prepare), and the run
// uses exactly what was prepared, once.
it('runs a conversation prepared before dispatch exactly once, and refuses it a second time before opening', async () => {
  const f = fixture()
  const read = vi.fn(async (stopAt?: string) => history(['prior'], stopAt))

  const prepared = await f.executor.prepare({
    conversationKey: f.input.conversationKey,
    signal: f.input.signal,
    continuity: { read }
  })

  expect(f.open).not.toHaveBeenCalled()
  expect(f.executor.owns(prepared)).toBe(true)

  await expect(f.executor.run({ ...f.input, prepared, continuity: { read } })).resolves.toMatchObject({ text: 'done' })
  // The run read nothing again: the history was taken once, before dispatch.
  expect(read).toHaveBeenCalledOnce()
  expect(f.request.mock.calls[0]).toEqual([
    'session.create',
    expect.objectContaining({
      messages: [
        { role: 'user', content: 'question prior' },
        { role: 'assistant', content: 'answer prior' }
      ]
    }),
    expect.anything(),
    expect.anything()
  ])
  expect(f.executor.owns(prepared)).toBe(false)

  const requests = f.request.mock.calls.length
  await expect(f.executor.run({ ...f.input, invocationId: 'two', prepared })).rejects.toThrow(
    'matrix_hermes_conversation_invalid'
  )
  expect(f.request.mock.calls).toHaveLength(requests)
  expect(f.executor.usable).toBe(true)
  await f.executor.close()
})

it('refuses a preparation made for another conversation or by another executor', async () => {
  const f = fixture()
  const other = fixture()
  const prepared = await f.executor.prepare({ conversationKey: f.input.conversationKey, signal: f.input.signal })
  const foreign = await other.executor.prepare({ conversationKey: f.input.conversationKey, signal: f.input.signal })

  await expect(
    f.executor.run({ ...f.input, conversationKey: `matrix-conversation-${'b'.repeat(64)}`, prepared })
  ).rejects.toThrow('matrix_hermes_conversation_invalid')
  expect(f.executor.owns(foreign)).toBe(false)
  await expect(f.executor.run({ ...f.input, prepared: foreign })).rejects.toThrow('matrix_hermes_conversation_invalid')
  expect(f.request).not.toHaveBeenCalled()
  await Promise.all([f.executor.close(), other.executor.close()])
})

it('refuses to prepare on a failed history read, opening nothing and leaving the stored link as it was', async () => {
  const f = fixture()

  const raw = JSON.stringify({
    version: 2,
    storedSession: 'retained',
    continuity: { anchor: '$prior', ours: ['prior'] }
  })

  f.values.set(f.input.conversationKey, raw)

  const read = vi.fn(async (): Promise<MatrixContinuityRead> => {
    throw new Error('private network detail')
  })

  await expect(
    f.executor.prepare({ conversationKey: f.input.conversationKey, signal: f.input.signal, continuity: { read } })
  ).rejects.toThrow('matrix_hermes_continuity_unavailable')
  expect(f.open).not.toHaveBeenCalled()
  expect(f.values.get(f.input.conversationKey)).toBe(raw)
  expect(f.executor.usable).toBe(true)
})

it('with no stored link, seeds from the newest dialogue a read short of time kept, and answers', async () => {
  const f = fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const clipped = { ...history(['recent']), reachedStop: false, clipped: true as const }
  const read = vi.fn(async () => clipped)

  try {
    const prepared = await f.executor.prepare({
      conversationKey: f.input.conversationKey,
      signal: f.input.signal,
      continuity: { read }
    })

    expect(read.mock.calls).toEqual([[undefined, { bounded: true }]])
    await expect(f.executor.run({ ...f.input, prepared })).resolves.toMatchObject({
      text: 'done',
      storedSession: 'stored-1'
    })
    expect(f.request.mock.calls[0][1]).toMatchObject({
      messages: [
        { role: 'user', content: 'question recent' },
        { role: 'assistant', content: 'answer recent' }
      ]
    })
    // Invisible to the person: no note in the session, one closed line in the log.
    expect(JSON.stringify(f.request.mock.calls[0][1].messages)).not.toMatch(/earlier|unavailable/i)
    expect(warn.mock.calls.map(call => call.join(' ')).filter(line => line.includes('seeded'))).toEqual([
      '[Matrix] conversation seeded reason=history_clipped entries=2'
    ])
  } finally {
    warn.mockRestore()
    await f.executor.close()
  }
})

it('resumes a stored session only from a complete read to its anchor, never from a bounded one', async () => {
  const f = fixture()
  f.values.set(
    f.input.conversationKey,
    JSON.stringify({ version: 2, storedSession: 'kept', continuity: { anchor: '$prior', ours: ['prior'] } })
  )
  const read = vi.fn(async (stopAt?: string) => history(['prior'], stopAt))

  const prepared = await f.executor.prepare({
    conversationKey: f.input.conversationKey,
    signal: f.input.signal,
    continuity: { read }
  })

  expect(read.mock.calls).toEqual([['$prior']])
  await f.executor.run({ ...f.input, prepared })
  expect(f.request.mock.calls[0]).toEqual([
    'session.resume',
    expect.objectContaining({ session_id: 'kept' }),
    expect.anything(),
    expect.anything()
  ])
  await f.executor.close()
})
