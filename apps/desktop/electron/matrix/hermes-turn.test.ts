import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GatewayRpcError } from '../../../shared/src/json-rpc-gateway'
import type { TurnObservation } from '../../shared/atum-observability'
import { MATRIX_PROMPT_MAX } from '../../shared/matrix'
import { macOwnerFacts, MATRIX_TURN_CONTEXT_HEADER, MATRIX_TURN_STYLE } from '../../shared/matrix-turn-style'

import { MatrixHermesPrompts } from './hermes-prompts'
import { MatrixHermesPreSubmissionError, runMatrixHermesTurn } from './hermes-turn'
import { MatrixTurnEffects } from './turn-effects'

type GatewayEvent = Parameters<Parameters<Parameters<typeof runMatrixHermesTurn>[0]['onAny']>[0]>[0]
type ConnectionState = string

afterEach(() => vi.useRealTimers())

function fixture() {
  const events = new Set<(event: GatewayEvent) => void>()
  const states = new Set<(state: ConnectionState) => void>()

  const request = vi.fn(
    async (method: string, _params?: unknown, _timeout?: number, _signal?: AbortSignal): Promise<unknown> =>
      method === 'session.create'
        ? { session_id: 'own', stored_session_id: 'stored', async_delivery: false }
        : method === 'config.get'
          ? { value: 'all' }
          : { status: 'streaming' }
  )

  const gateway = {
    request: request as Parameters<typeof runMatrixHermesTurn>[0]['request'],
    onAny(handler: (event: GatewayEvent) => void) {
      events.add(handler)

      return () => {
        events.delete(handler)
      }
    },
    onState(handler: (state: ConnectionState) => void) {
      states.add(handler)
      handler('open')

      return () => {
        states.delete(handler)
      }
    }
  }

  const emit = (type: string, payload = {}, session_id = 'own') => {
    for (const fn of events) {
      fn({ type, payload, session_id })
    }
  }

  const input = { invocationId: 'fence', text: 'Approved synthetic request', workspace: '/disposable' }

  return { gateway, request, events, states, emit, input }
}

function finish(f: ReturnType<typeof fixture>) {
  f.emit('message.complete', { text: 'done', status: 'complete' })
  f.emit('session.info', { running: false, stored_session_id: 'stored' })
}

it('binds Store and Apps requests to one live turn, spends duplicates once and ignores late events', async () => {
  const f = fixture()
  const store = vi.fn(async () => ({ items: [] }))
  const apps = vi.fn(async () => ({ apps: [] }))
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onStoreDiscovery: store, onAppsDiscovery: apps })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  const payload = { request_id: 'store-one', turn_id: 'actual', operation: 'search', query: 'focus' }
  f.emit('atum.store.request', payload)
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('atum.store.request', payload, 'foreign')
  f.emit('atum.store.request', { ...payload, turn_id: 'old' })
  expect(store).not.toHaveBeenCalled()
  f.emit('atum.store.request', payload)
  f.emit('atum.store.request', payload)
  f.emit('atum.apps.list.request', { request_id: 'apps-one', turn_id: 'actual' })
  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      'atum.store.respond',
      {
        request_id: 'store-one',
        session_id: 'own',
        turn_id: 'actual',
        result: '{"items":[]}'
      },
      2_000,
      expect.any(AbortSignal)
    )
  )
  expect(store).toHaveBeenCalledTimes(1)
  expect(apps).toHaveBeenCalledTimes(1)
  finish(f)
  await pending
  f.emit('atum.store.request', { ...payload, request_id: 'late' })
  expect(store).toHaveBeenCalledTimes(1)
})

it('binds profile management to one live turn and aborts it immediately on an uncertain turn', async () => {
  const f = fixture()
  let requestSignal: AbortSignal | undefined

  const profile = vi.fn(
    (_payload: unknown, signal: AbortSignal) =>
      new Promise(resolve => {
        requestSignal = signal
        signal.addEventListener('abort', () => resolve({ error: 'unavailable' }), { once: true })
      })
  )

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onAgentProfile: profile })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  f.emit('message.start', { turn_id: 'actual' })
  const payload = { request_id: 'profile-one', turn_id: 'actual', operation: 'read' }
  f.emit('atum.agents.request', payload)
  f.emit('atum.agents.request', payload)
  await vi.waitFor(() => expect(profile).toHaveBeenCalledTimes(1))
  expect(requestSignal?.aborted).toBe(false)
  f.emit('error', { code: 'transport_uncertain' })
  await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(requestSignal?.aborted).toBe(true)
  expect(f.request.mock.calls.some(call => call[0] === 'atum.agents.respond')).toBe(false)
})

it('spends a named-agent task request once and aborts an in-flight task with its turn', async () => {
  const f = fixture()
  let requestSignal: AbortSignal | undefined

  const task = vi.fn(
    (value: unknown, signal: AbortSignal) => {
      const payload = value as { request_id?: unknown }

      if (payload.request_id === 'task-one') {return Promise.resolve({ tasks: [] })}

      return new Promise(resolve => {
        requestSignal = signal
        signal.addEventListener('abort', () => resolve({ error: 'unavailable' }), { once: true })
      })
    }
  )

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onAgentTask: task })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  const payload = { request_id: 'task-one', turn_id: 'actual', operation: 'list' }
  f.emit('atum.agent_tasks.request', payload)
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('atum.agent_tasks.request', payload, 'foreign')
  f.emit('atum.agent_tasks.request', { ...payload, turn_id: 'old' })
  expect(task).not.toHaveBeenCalled()
  f.emit('atum.agent_tasks.request', payload)
  f.emit('atum.agent_tasks.request', payload)
  await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1))
  await vi.waitFor(() =>
    expect(f.request.mock.calls.some(call => call[0] === 'atum.agent_tasks.respond')).toBe(true)
  )
  f.emit('atum.agent_tasks.request', payload)
  await Promise.resolve()
  expect(task).toHaveBeenCalledTimes(1)

  const pendingPayload = { ...payload, request_id: 'task-two' }
  f.emit('atum.agent_tasks.request', pendingPayload)
  f.emit('atum.agent_tasks.request', pendingPayload)
  await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2))
  expect(requestSignal?.aborted).toBe(false)
  f.emit('error', { code: 'transport_uncertain' })
  await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(requestSignal?.aborted).toBe(true)
})

it('binds chat bytes to the original live turn, spends duplicates once and removes the handler at completion', async () => {
  const f = fixture()
  const bytes = '{\n  "rooms": [],\n  "truncated": false\n}\n'
  const chats = vi.fn(async () => bytes)
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onChats: chats })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))

  const payload = { request_id: 'chats-one', turn_id: 'actual', op: 'list', sinceMs: 1_791_913_600_000 }
  f.emit('atum.chats.request', payload)
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('atum.chats.request', payload, 'foreign')
  f.emit('atum.chats.request', { ...payload, turn_id: 'old' })
  expect(chats).not.toHaveBeenCalled()

  f.emit('atum.chats.request', payload)
  f.emit('atum.chats.request', payload)
  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      'atum.chats.respond',
      {
        request_id: 'chats-one',
        session_id: 'own',
        turn_id: 'actual',
        result: bytes
      },
      2_000,
      expect.any(AbortSignal)
    )
  )
  expect(chats).toHaveBeenCalledTimes(1)

  finish(f)
  await pending
  f.emit('atum.chats.request', { ...payload, request_id: 'late' })
  await Promise.resolve()
  expect(chats).toHaveBeenCalledTimes(1)
})

it('aborts an in-flight chat host call when the original turn becomes uncertain', async () => {
  const f = fixture()
  let requestSignal: AbortSignal | undefined

  const chats = vi.fn(
    (_payload: unknown, signal: AbortSignal) =>
      new Promise<string>(resolve => {
        requestSignal = signal
        signal.addEventListener('abort', () => resolve('{"error":"unavailable"}'), { once: true })
      })
  )

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onChats: chats })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('atum.chats.request', { request_id: 'chats-pending', turn_id: 'actual', op: 'list' })
  await vi.waitFor(() => expect(chats).toHaveBeenCalledTimes(1))
  expect(requestSignal?.aborted).toBe(false)

  f.emit('error', { code: 'transport_uncertain' })
  await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(requestSignal?.aborted).toBe(true)
  expect(f.request.mock.calls.some(call => call[0] === 'atum.chats.respond')).toBe(false)
})

it('binds Mac-source bytes to the original live turn and spends duplicate events once', async () => {
  const f = fixture()
  const bytes = '{"error":"disabled"}'
  const macSources = vi.fn(async () => bytes)
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onMacSources: macSources })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))

  const payload = { request_id: 'mac-one', turn_id: 'actual', op: 'location.current', precision: 'city' }
  f.emit('atum.mac.request', payload)
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('atum.mac.request', payload, 'foreign')
  f.emit('atum.mac.request', { ...payload, turn_id: 'old' })
  expect(macSources).not.toHaveBeenCalled()

  f.emit('atum.mac.request', payload)
  f.emit('atum.mac.request', payload)
  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      'atum.mac.respond',
      {
        request_id: 'mac-one',
        session_id: 'own',
        turn_id: 'actual',
        result: bytes
      },
      2_000,
      expect.any(AbortSignal)
    )
  )
  expect(macSources).toHaveBeenCalledTimes(1)

  finish(f)
  await pending
})

it('resolves Word edits independently through the original pending turn and spends duplicate events once', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) =>
    args[0] === 'word.document.resolve'
      ? {
          action: 'replace_text',
          session_id: 'own',
          turn_id: 'actual',
          durable_session_id: 'stored',
          expires_at: Date.now() / 1000 + 30,
          revision: 'native',
          find: 'old',
          replacement: 'new'
        }
      : original(...args)
  )

  const word = vi.fn(async (ref, resolve, signal) => {
    expect(ref).toEqual({ profile: 'matrix', request_id: 'edit-one', session_id: 'own', turn_id: 'actual' })
    expect(signal.aborted).toBe(false)
    expect(await resolve()).toMatchObject({ find: 'old', replacement: 'new' })

    return { text: 'new', revision: 'after', saved: false, applied: true }
  })

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onWord: word })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  const payload = { request_id: 'edit-one', turn_id: 'actual', replacement: 'forged' }
  f.emit('word.document.request', payload)
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('word.document.request', payload, 'foreign')
  f.emit('word.document.request', { ...payload, turn_id: 'old' })
  expect(word).not.toHaveBeenCalled()
  f.emit('word.document.request', payload)
  f.emit('word.document.request', payload)
  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      'word.document.respond',
      {
        request_id: 'edit-one',
        session_id: 'own',
        turn_id: 'actual',
        result: JSON.stringify({ text: 'new', revision: 'after', saved: false, applied: true })
      },
      2_000,
      expect.any(AbortSignal)
    )
  )
  expect(word).toHaveBeenCalledTimes(1)
  expect(f.request).toHaveBeenCalledWith(
    'word.document.resolve',
    {
      request_id: 'edit-one',
      session_id: 'own',
      turn_id: 'actual'
    },
    2_000,
    expect.any(AbortSignal)
  )
  finish(f)
  await pending
  f.emit('word.document.request', { ...payload, request_id: 'late' })
  expect(word).toHaveBeenCalledTimes(1)
})

it('does not substitute another document for a turn without a Word link', async () => {
  const f = fixture()
  const pending = runMatrixHermesTurn(f.gateway, f.input)
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('word.document.request', { request_id: 'read', turn_id: 'actual' })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'word.document.respond')).toBe(true))
  expect(f.request.mock.calls.find(call => call[0] === 'word.document.respond')![1]).toMatchObject({
    result: JSON.stringify({ error: 'WORD_DOCUMENT_UNAVAILABLE' })
  })
  expect(f.request.mock.calls.some(call => call[0] === 'word.document.resolve')).toBe(false)
  finish(f)
  expect(await pending).toMatchObject({ text: 'done' })
})

it('reads the visible terminal only for the original live turn and answers each request once', async () => {
  const f = fixture()
  const result = { total_lines: 24, start: 0, end: 24, viewport_rows: 24, cursor_row: 2, text: 'actual cells' }
  const read = vi.fn(async () => result)
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onTerminalRead: read })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  const payload = { request_id: 'read-one', turn_id: 'actual', start: 0, count: 24 }
  f.emit('terminal.read.request', payload)
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('terminal.read.request', payload, 'foreign')
  f.emit('terminal.read.request', { ...payload, turn_id: 'old' })
  expect(read).not.toHaveBeenCalled()
  f.emit('terminal.read.request', payload)
  f.emit('terminal.read.request', payload)
  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      'terminal.read.respond',
      {
        request_id: 'read-one',
        session_id: 'own',
        turn_id: 'actual',
        text: JSON.stringify(result)
      },
      2_000,
      expect.any(AbortSignal)
    )
  )
  expect(read).toHaveBeenCalledExactlyOnceWith({ start: 0, count: 24 }, expect.any(AbortSignal))
  finish(f)
  await pending
  f.emit('terminal.read.request', { ...payload, request_id: 'late' })
  expect(read).toHaveBeenCalledTimes(1)
})

it('reports an unavailable terminal without opening a view or failing the answer', async () => {
  const f = fixture(),
    read = vi.fn(async () => null)

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onTerminalRead: read })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  f.emit('message.start', { turn_id: 'actual' })
  f.emit('terminal.read.request', { request_id: 'read-one', turn_id: 'actual' })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'terminal.read.respond')).toBe(true))
  expect(f.request.mock.calls.find(call => call[0] === 'terminal.read.respond')?.[1]).toEqual({
    request_id: 'read-one',
    session_id: 'own',
    turn_id: 'actual',
    text: JSON.stringify({ error: 'No in-app terminal is open.' })
  })
  finish(f)
  expect(await pending).toMatchObject({ text: 'done' })
})

it('offers web previews only from the original live runtime turn, without forwarding raw events', async () => {
  const f = fixture(),
    preview = vi.fn()

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onWebPreview: preview })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  const value = { url: 'https://example.test/page', label: 'A page', turn_id: 'runtime-turn', bearer: 'private' }
  f.emit('preview.open', value)
  f.emit('message.start', { turn_id: 'runtime-turn' })
  f.emit('preview.open', value, 'foreign')
  f.emit('preview.open', { ...value, turn_id: 'foreign-turn' })
  f.emit('preview.open', { ...value, url: 'file:///private/a' })
  expect(preview).not.toHaveBeenCalled()
  f.emit('preview.open', value)
  expect(preview).toHaveBeenCalledExactlyOnceWith({ url: value.url, label: value.label })
  f.emit('message.complete', { text: 'done', status: 'complete' })
  f.emit('preview.open', value)
  f.emit('session.info', { running: false, stored_session_id: 'stored' })
  await pending
  f.emit('preview.open', value)
  expect(preview).toHaveBeenCalledTimes(1)
})

it('observes only native turn facts from the matching raw gateway stream', async () => {
  const f = fixture()
  const observe = vi.fn<(observation: TurnObservation) => void>()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, observe })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))

  f.emit('message.delta', { text: '' })
  f.emit('message.delta', { text: 'foreign private text' }, 'foreign-session')
  f.emit('message.delta', { text: 'first private response' })
  f.emit('message.delta', { text: 'later private response' })

  for (let index = 0; index < 14; index += 1) {
    f.emit('tool.start', { name: `private-tool-${index}`, args_text: 'private arguments' })
  }

  f.emit('message.complete', { text: 'done', status: 'complete' })
  expect(observe.mock.calls.some(([observation]) => observation.phase === 'finish')).toBe(false)
  f.emit('session.info', { running: false, stored_session_id: 'stored' })
  await expect(pending).resolves.toEqual({ text: 'done', storedSession: 'stored' })

  const observations = observe.mock.calls.map(([observation]) => observation)
  expect(observations.map(observation => observation.phase)).toEqual([
    'start',
    'first_token',
    ...Array.from({ length: 14 }, () => 'tool'),
    'finish'
  ])
  expect(
    observations.filter(observation => observation.phase === 'tool').map(observation => observation.toolKey)
  ).toEqual(Array.from({ length: 14 }, (_, index) => String(index + 1)))
  expect(observations.every(observation => observation.key === observations[0].key)).toBe(true)
  expect(JSON.stringify(observations)).not.toContain('private')
  expect(observations.at(-1)).toMatchObject({ phase: 'finish', outcome: 'completed' })
})

it('reports a submitted unknown outcome as lost and contains observer exceptions', async () => {
  const f = fixture()
  const controller = new AbortController()

  const observe = vi.fn<(observation: TurnObservation) => void>(() => {
    throw new Error('reporting unavailable')
  })

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, signal: controller.signal, observe })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  controller.abort()

  await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(observe.mock.calls.map(([observation]) => observation.phase)).toEqual(['start', 'lost'])
  expect(observe.mock.calls.some(([observation]) => observation.outcome !== undefined)).toBe(false)
})

it('keeps both an explicit room attachment and linked document in one ordinary Hermes turn', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) =>
    args[0] === 'file.attach'
      ? { attached: true, ref_text: `@file:${(args[1] as { name: string }).name}` }
      : original(...args)
  )

  const pending = runMatrixHermesTurn(f.gateway, {
    ...f.input,
    attachments: [
      { name: 'room.txt', bytes: new Uint8Array([1]) },
      { name: 'linked.txt', bytes: new Uint8Array([2]) }
    ]
  })

  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      'prompt.submit',
      {
        session_id: 'own',
        text: `${f.input.text}\n\n@file:room.txt\n\n@file:linked.txt`
      },
      15000,
      expect.any(AbortSignal)
    )
  )
  finish(f)
  await pending
})

it('uses byte-only file.attach and its returned reference before the ordinary prompt, without changing prior context', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) =>
    args[0] === 'file.attach'
      ? { attached: true, ref_text: '@file:".hermes/desktop-attachments/report.txt"' }
      : original(...args)
  )
  const bytes = new TextEncoder().encode('fixture content')
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, attachments: [{ name: '../../report.txt', bytes }] })
  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith('prompt.submit', expect.anything(), 15000, expect.any(AbortSignal))
  )
  const params = f.request.mock.calls.find(call => call[0] === 'file.attach')![1]
  expect(params).toEqual({
    session_id: 'own',
    name: '../../report.txt',
    data_url: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`
  })
  expect(f.request.mock.calls.find(call => call[0] === 'prompt.submit')![1]).toEqual({
    session_id: 'own',
    text: `${f.input.text}\n\n@file:".hermes/desktop-attachments/report.txt"`
  })
  finish(f)
  expect(await pending).toEqual({ text: 'done', storedSession: 'stored' })
})

it.each(['error', 'malformed', 'abort'] as const)('does not submit after attachment %s', async mode => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  const abort = new AbortController()
  f.request.mockImplementation(async (...args) => {
    if (args[0] !== 'file.attach') {
      return original(...args)
    }

    if (mode === 'error') {
      throw new Error('fixture upload failure')
    }

    if (mode === 'abort') {
      abort.abort()
    }

    return { attached: true, ref_text: mode === 'malformed' ? undefined : '@file:report.txt' }
  })
  await expect(
    runMatrixHermesTurn(f.gateway, {
      ...f.input,
      signal: abort.signal,
      attachments: [{ name: 'report.txt', bytes: new Uint8Array([1]) }]
    })
  ).rejects.toThrow('unknown')
  expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(false)
})

it.each(['duplicate', 'overflow'])('rejects %s prompt admission without replying and clears the queue', async mode => {
  const f = fixture()
  const prompts = new MatrixHermesPrompts(() => {})
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, ask: prompts.ask })
  const rejected = expect(pending).rejects.toThrow('unknown')
  await vi.waitFor(() => expect(f.events.size).toBe(1))

  const count = mode === 'duplicate' ? 1 : 8

  for (let index = 0; index < count; index++) {
    f.emit('approval.request', { request_id: `r-${index}`, command: 'fixture', description: '' })
  }

  expect(prompts.snapshot()).toHaveLength(count)
  f.emit('approval.request', { request_id: mode === 'duplicate' ? 'r-0' : 'r-8', command: 'fixture', description: '' })

  await rejected
  expect(prompts.snapshot()).toEqual([])
  expect(f.request.mock.calls.some(call => call[0] === 'approval.respond')).toBe(false)
  expect(f.events.size + f.states.size).toBe(0)
})

it('cannot forward a click after cancellation wins the response microtask', async () => {
  const f = fixture()
  const prompts = new MatrixHermesPrompts(() => {})
  const abort = new AbortController()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, ask: prompts.ask, signal: abort.signal })
  const rejected = expect(pending).rejects.toThrow('unknown')
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  f.emit('approval.request', { request_id: 'r', command: 'fixture', description: '' })
  prompts.respond({ id: prompts.snapshot()[0].id, kind: 'approval', choice: 'once' })
  abort.abort()
  await rejected
  expect(f.request.mock.calls.some(call => call[0] === 'approval.respond')).toBe(false)
  expect(prompts.snapshot()).toEqual([])
})

it.each(['once', 'deny'] as const)(
  'forwards actual scoped approval %s and waits for its ACK even after completion',
  async choice => {
    const f = fixture()
    const prompts = new MatrixHermesPrompts(() => {})
    const original = f.request.getMockImplementation()!

    let acknowledge: (value: unknown) => void = () => {}
    f.request.mockImplementation(async (...args) => {
      if (args[0] === 'approval.respond') {
        expect(args[1]).toEqual({ session_id: 'own', request_id: 'occurrence', choice })
        finish(f)

        return new Promise(resolve => {
          acknowledge = resolve
        })
      }

      return original(...args)
    })
    let completed = false

    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, ask: prompts.ask }).then(value => {
      completed = true

      return value
    })

    await vi.waitFor(() => expect(f.events.size).toBe(1))
    const payload = { request_id: 'occurrence', command: 'fixture', description: 'approval', choices: ['once', 'deny'] }
    f.emit('approval.request', payload, 'foreign')
    expect(prompts.snapshot()).toEqual([])
    f.emit('approval.request', payload)
    const id = prompts.snapshot()[0].id
    prompts.respond({ id, kind: 'approval', choice })
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith('approval.respond', expect.anything(), 15000, expect.any(AbortSignal))
    )
    expect(completed).toBe(false)
    acknowledge({ resolved: 1 })
    expect(await pending).toEqual({ text: 'done', storedSession: 'stored' })
    expect(prompts.snapshot()).toEqual([])
  }
)

it('keeps an unacknowledged decision unknown despite a completion, and never replays it', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) => {
    if (args[0] === 'approval.respond') {
      finish(f)

      return { resolved: 0 }
    }

    return original(...args)
  })

  const pending = runMatrixHermesTurn(f.gateway, {
    ...f.input,
    ask: async () => ({ kind: 'approval', choice: 'once' })
  })

  const rejected = expect(pending).rejects.toThrow('unknown')
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  f.emit('approval.request', { request_id: 'r', command: 'fixture', description: '' })
  await rejected
  expect(f.request.mock.calls.filter(call => call[0] === 'approval.respond')).toHaveLength(1)
})

it.each(['answered', 'expired', 'aborted', 'completed'] as const)(
  'clarification is %s through the same invocation lifetime',
  async mode => {
    const f = fixture()
    const prompts = new MatrixHermesPrompts(() => {})
    const abort = new AbortController()
    const onPromptNotice = vi.fn()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (...args) => {
      if (args[0] === 'clarify.respond') {
        expect(args[1]).toEqual({ request_id: 'question', answer: 'Here' })
        finish(f)

        return { status: 'ok' }
      }

      return original(...args)
    })

    const pending = runMatrixHermesTurn(f.gateway, {
      ...f.input,
      ask: prompts.ask,
      signal: abort.signal,
      onPromptNotice
    })

    const result =
      mode === 'aborted'
        ? expect(pending).rejects.toThrow('unknown')
        : expect(pending).resolves.toMatchObject({ text: 'done' })

    await vi.waitFor(() => expect(f.events.size).toBe(1))
    f.emit('clarify.request', { request_id: 'question', question: 'Where?', choices: ['Here'] })
    const id = prompts.snapshot()[0].id

    if (mode === 'answered') {
      prompts.respond({ id, kind: 'clarify', answer: 'Here' })
    }

    if (mode === 'expired') {
      f.emit('clarify.expire', { request_id: 'question' })
      finish(f)
    }

    if (mode === 'aborted') {
      abort.abort()
    }

    if (mode === 'completed') {
      finish(f)
    }

    await result
    expect(prompts.snapshot()).toEqual([])
    expect(() => prompts.respond({ id, kind: 'clarify', answer: 'late' })).toThrow('expired')
    expect(f.request.mock.calls.filter(call => call[0] === 'clarify.respond')).toHaveLength(mode === 'answered' ? 1 : 0)
    expect(onPromptNotice.mock.calls).toEqual(mode === 'expired' ? [['clarification_expired']] : [])
  }
)

it.each([false, true])(
  'retains one authoritative late-answer notice after card removal (expiry event=%s)',
  async eventFirst => {
    const f = fixture()
    const prompts = new MatrixHermesPrompts(() => {})
    const onPromptNotice = vi.fn()
    const original = f.request.getMockImplementation()!

    let acknowledge: (value: unknown) => void = () => {}
    f.request.mockImplementation(async (...args) => {
      if (args[0] === 'clarify.respond') {
        return new Promise(resolve => {
          acknowledge = resolve
        })
      }

      return original(...args)
    })
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, ask: prompts.ask, onPromptNotice })
    await vi.waitFor(() => expect(f.events.size).toBe(1))
    f.emit('clarify.request', { request_id: 'question', question: 'Where?' })
    prompts.respond({ id: prompts.snapshot()[0].id, kind: 'clarify', answer: 'Here' })
    expect(prompts.snapshot()).toEqual([])
    await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'clarify.respond')).toBe(true))
    f.emit('clarify.expire', { request_id: 'question' }, 'foreign')
    f.emit('clarify.expire', { request_id: 'unrelated' })
    expect(onPromptNotice).not.toHaveBeenCalled()

    if (eventFirst) {
      f.emit('clarify.expire', { request_id: 'question' })
      f.emit('clarify.expire', { request_id: 'question' })
    }

    finish(f)
    acknowledge({ status: 'expired' })
    expect(await pending).toEqual({ text: 'done', storedSession: 'stored' })
    expect(onPromptNotice.mock.calls).toEqual([['clarification_expired']])
    expect(f.request.mock.calls.filter(call => call[0] === 'clarify.respond')).toHaveLength(1)
    expect(f.request.mock.calls.filter(call => call[0] === 'prompt.submit')).toHaveLength(1)
  }
)

it('projects the original authorization deadline and ignores wrong-kind expiry', async () => {
  const f = fixture()
  const prompts = new MatrixHermesPrompts(() => {})
  const onPromptNotice = vi.fn()
  const deadlineAt = Date.now() + 30000
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, deadlineAt, ask: prompts.ask, onPromptNotice })
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  f.emit('approval.request', { request_id: 'a', command: 'fixture', description: '' })
  expect(prompts.snapshot()[0].deadlineAt).toBe(deadlineAt)
  f.emit('clarify.expire', { request_id: 'a' })
  expect(prompts.snapshot()).toHaveLength(1)
  finish(f)
  await pending
  expect(onPromptNotice).not.toHaveBeenCalled()
})

it('runs to the caller deadline, not the 90 s default, when the caller names one', async () => {
  // A phone message's turn passes only its deadline (invocation.ts): it was cut at 90 s.
  const f = fixture()
  const prompts = new MatrixHermesPrompts(() => {})
  const deadlineAt = Date.now() + 2 * 60 * 60_000
  const timeout = vi.spyOn(AbortSignal, 'timeout')

  try {
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, deadlineAt, ask: prompts.ask })
    await vi.waitFor(() => expect(f.events.size).toBe(1))
    f.emit('approval.request', { request_id: 'a', command: 'fixture', description: '' })
    expect(prompts.snapshot()[0].deadlineAt).toBe(deadlineAt)
    expect(timeout.mock.calls.some(([ms]) => ms > 60 * 60_000)).toBe(true)
    expect(timeout.mock.calls.some(([ms]) => ms <= 90_000)).toBe(false)
    finish(f)
    await pending
  } finally {
    timeout.mockRestore()
  }
})

it('keeps the 90 s default only for a caller that names neither a deadline nor a timeout', async () => {
  const f = fixture()
  const timeout = vi.spyOn(AbortSignal, 'timeout')

  try {
    const pending = runMatrixHermesTurn(f.gateway, f.input)
    await vi.waitFor(() => expect(f.events.size).toBe(1))
    expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(90_000)
    expect(timeout.mock.calls[0]?.[0]).toBeGreaterThan(60_000)
    finish(f)
    await pending
  } finally {
    timeout.mockRestore()
  }
})

it('ends a quiet run at its inactivity window, not at the 90 s default', async () => {
  const f = fixture()
  const window = 30 * 60_000
  vi.useFakeTimers()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, inactivityMs: window })

  const observed = pending.then(
    () => 'resolved',
    () => 'rejected'
  )

  await Promise.resolve()

  await vi.advanceTimersByTimeAsync(window - 1_000)
  // Quiet, but the window has not run out: the old 90 s default would have cut this long ago.
  expect(await Promise.race([observed, Promise.resolve('running')])).toBe('running')
  await vi.advanceTimersByTimeAsync(2_000)
  await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps a run alive past the window while events keep arriving', async () => {
  const f = fixture()
  const window = 30 * 60_000
  vi.useFakeTimers()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, inactivityMs: window })
  await Promise.resolve()

  // Three ten-minute gaps with events between: half an hour in total, past one whole window,
  // and the run is still going because no single quiet stretch reached it.
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  f.emit('message.delta', { text: 'still working' })
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  f.emit('tool.start', { name: 'terminal' })
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  f.emit('tool.complete', { name: 'terminal' })
  finish(f)

  await expect(pending).resolves.toEqual({ text: 'done', storedSession: 'stored' })
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps a completed answer longer than any one message: nothing the turn produced is discarded', async () => {
  const f = fixture()

  const long = Array.from({ length: 1200 }, (_, index) => `Paragraph ${index}: ${'lorem ipsum '.repeat(8)}`).join(
    '\n\n'
  )

  expect(long.length).toBeGreaterThan(100_000)
  const pending = runMatrixHermesTurn(f.gateway, f.input)
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  f.emit('message.complete', { text: long, status: 'complete' })
  f.emit('session.info', { running: false, stored_session_id: 'stored' })
  expect(await pending).toEqual({ text: long, storedSession: 'stored' })
})

it.each(['deadline', 'stop', 'disconnect'] as const)(
  'only labels a real %s while input is pending as expiry',
  async mode => {
    const f = fixture()
    const prompts = new MatrixHermesPrompts(() => {})
    const abort = new AbortController()
    const onPromptNotice = vi.fn()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (...args) => {
      if (args[0] === 'prompt.submit') {
        f.emit('approval.request', { request_id: 'a', command: 'fixture', description: '' })

        if (mode === 'stop') {
          abort.abort()
        }

        if (mode === 'disconnect') {
          for (const fn of f.states) {
            fn('closed')
          }
        }
      }

      return original(...args)
    })
    await expect(
      runMatrixHermesTurn(f.gateway, {
        ...f.input,
        timeoutMs: mode === 'deadline' ? 20 : 90000,
        signal: abort.signal,
        ask: prompts.ask,
        onPromptNotice
      })
    ).rejects.toThrow('unknown')
    expect(prompts.snapshot()).toEqual([])
    expect(onPromptNotice.mock.calls).toEqual(mode === 'deadline' ? [['deadline_expired']] : [])
    expect(f.request.mock.calls.filter(call => call[0] === 'approval.respond')).toHaveLength(0)
    expect(f.request.mock.calls.filter(call => call[0] === 'prompt.submit')).toHaveLength(1)
  }
)

it('submits one existing Hermes turn, correlates its session, retains completion arriving before ACK, and detaches', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) => {
    if (args[0] === 'prompt.submit') {
      f.emit('message.complete', { text: 'foreign', status: 'complete' }, 'other')
      f.emit('message.complete', { text: 'answer', status: 'complete' })
      f.emit('session.info', { running: false, stored_session_id: 'stored' })
    }

    return original(...args)
  })
  expect(await runMatrixHermesTurn(f.gateway, f.input)).toEqual({ text: 'answer', storedSession: 'stored' })
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.create', 'prompt.submit'])
  expect(f.request.mock.calls[0][1]).toEqual({
    source: 'matrix',
    title: 'Atum conversation fence',
    cwd: '/disposable',
    async_delivery: false
  })
  expect(f.events.size + f.states.size).toBe(0)
})

it('projects the answer, reasoning and Hermes tool labels for its own session, never raw inputs or results', async () => {
  const f = fixture()
  const onActivity = vi.fn()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onActivity })
  await vi.waitFor(() => expect(f.events.size).toBe(1))

  f.emit('reasoning.delta', { text: 'Weighing ' })
  f.emit('reasoning.delta', { text: 'the question' })
  f.emit('thinking.delta', { text: '(¬‿¬) spinner status' })
  f.emit('tool.start', { name: 'terminal', args_text: 'token=private', context: '  ls -la\n   ~/Projects ' })
  f.emit('tool.complete', {
    name: 'terminal',
    result: 'private result',
    result_text: 'private output',
    summary: 'private summary'
  })
  f.emit('tool.start', { name: 'untrusted.plugin', args_text: 'must not render', context: 'must not render' })
  f.emit('message.delta', { text: 'Public response' })
  f.emit('reasoning.available', { text: 'too late: the answer has started' })
  f.emit('message.delta', { text: 'foreign room text' }, 'foreign')
  f.emit('reasoning.delta', { text: 'foreign reasoning' }, 'foreign')
  finish(f)
  await pending

  expect(onActivity).toHaveBeenCalledWith({
    invocationId: 'fence',
    state: 'complete',
    text: 'done',
    reasoning: 'Weighing the question',
    tools: [{ name: 'Terminal', state: 'complete', summary: 'Completed', detail: 'ls -la ~/Projects' }]
  })
  const published = JSON.stringify(onActivity.mock.calls)
  expect(published).not.toContain('private')
  expect(published).not.toContain('must not render')
  expect(published).not.toContain('spinner')
  expect(published).not.toContain('too late')
  expect(published).not.toContain('foreign')
})

it('tells main each tool the turn starts by its Hermes name, plugins and memory included', async () => {
  const f = fixture()

  const onToolStart = vi.fn(() => {
    throw new Error('a watcher cannot fail the turn')
  })

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onToolStart })
  await vi.waitFor(() => expect(f.events.size).toBe(1))

  f.emit('tool.start', { name: 'memory', args_text: 'private' })
  f.emit('tool.start', { name: 'untrusted.plugin' })
  f.emit('tool.start', { name: 'x'.repeat(129) })
  f.emit('tool.start', { name: 'terminal' }, 'foreign')
  finish(f)
  await expect(pending).resolves.toMatchObject({ text: 'done' })

  expect(onToolStart.mock.calls).toEqual([['memory'], ['untrusted.plugin'], ['']])
})

it('reports a protected-folder denial as one native signal without exposing the result', async () => {
  const f = fixture()
  const onProtectedFolderDenied = vi.fn()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onProtectedFolderDenied })
  await vi.waitFor(() => expect(f.events.size).toBe(1))

  f.emit('tool.complete', {
    name: 'read_file',
    args: { path: '/home/example/Documents/plan.md' },
    result: { error: 'Operation not permitted', secret: 'never forward me' }
  })
  f.emit('tool.complete', {
    name: 'read_file',
    args: { path: '/home/example/Projects/plan.md' },
    result: { error: 'Operation not permitted' }
  })
  finish(f)
  await pending

  expect(onProtectedFolderDenied).toHaveBeenCalledOnce()
  expect(onProtectedFolderDenied).toHaveBeenCalledWith()
})

it('hands the progress line only redacted narration and todos of its own session, while the turn works', async () => {
  const f = fixture()

  const onProgress = vi.fn((event: unknown) => {
    void event
    throw new Error('a progress line cannot fail the turn')
  })

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onProgress })
  await vi.waitFor(() => expect(f.events.size).toBe(1))

  f.emit('message.interim', { text: 'sk-secret', redacted_text: 'Mình sẽ đọc lịch.' })
  f.emit('message.interim', { text: 'unredacted only' })
  f.emit('message.interim', { redacted_text: 'foreign' }, 'foreign')
  f.emit('tool.start', { name: 'read_file', context: 'SECRET PATH' })
  f.emit('tool.complete', {
    name: 'todo',
    todos: [{ id: '1', content: 'raw', status: 'pending' }],
    redacted_todos: [{ id: '1', content: 'Đọc lịch', status: 'in_progress' }]
  })
  f.emit('learning.progress', { source: 'messages', state: 'reading' })
  f.emit('learning.progress', { source: 'messages', state: 'private' })
  finish(f)
  f.emit('message.interim', { redacted_text: 'after the answer' })
  await expect(pending).resolves.toMatchObject({ text: 'done' })

  expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
    { kind: 'narration', text: 'Mình sẽ đọc lịch.' },
    { kind: 'tool', name: 'read_file' },
    { kind: 'plan', todos: [{ text: 'Đọc lịch', state: 'active' }] },
    { kind: 'learning', source: 'messages', state: 'reading' }
  ])
})

describe('the shared turn style, for a turn the owner hears narrated', () => {
  // The Mac adds only its own zone under the shared style; compute the same bytes.
  const ownerFacts = macOwnerFacts()
  const ownerPlace = ownerFacts.timeZone ? `\ntime zone: ${ownerFacts.timeZone} (from this Mac)` : ''
  const styled = (text: string) => `${text}\n\n${MATRIX_TURN_CONTEXT_HEADER}\n${MATRIX_TURN_STYLE}${ownerPlace}`

  const submitted = (f: ReturnType<typeof fixture>) =>
    (f.request.mock.calls.find(call => call[0] === 'prompt.submit')![1] as { text: string }).text

  it('goes last in the one prompt, after the words and what is attached, and nowhere else', async () => {
    const f = fixture()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (...args) =>
      args[0] === 'file.attach' ? { attached: true, ref_text: '@file:report.txt' } : original(...args)
    )

    const pending = runMatrixHermesTurn(f.gateway, {
      ...f.input,
      turnStyle: true,
      attachments: [{ name: 'report.txt', bytes: new Uint8Array([1]) }]
    })

    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('prompt.submit', expect.anything(), 15000, expect.any(AbortSignal)))
    expect(submitted(f)).toBe(styled(`${f.input.text}\n\n@file:report.txt`))
    // Per turn, in the owner's new message: never the session's creation (its system prompt) or a message of its own.
    expect(JSON.stringify(f.request.mock.calls.filter(call => call[0] !== 'prompt.submit'))).not.toContain('style:')
    expect(f.request.mock.calls.filter(call => call[0] === 'prompt.submit')).toHaveLength(1)
    finish(f)
    await pending
  })

  it('is the prompt exactly as it was for a turn nobody hears narrated', async () => {
    const f = fixture()
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onProgress: () => {} })
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('prompt.submit', expect.anything(), 15000, expect.any(AbortSignal)))
    expect(submitted(f)).toBe(f.input.text)
    finish(f)
    await pending
  })

  it('is left out rather than cut into the words or past the prompt maximum', async () => {
    const room = styled('').length

    const fits = fixture()
    const fitting = 'x'.repeat(MATRIX_PROMPT_MAX - room)
    const first = runMatrixHermesTurn(fits.gateway, { ...fits.input, text: fitting, turnStyle: true })
    await vi.waitFor(() => expect(fits.request).toHaveBeenCalledWith('prompt.submit', expect.anything(), 15000, expect.any(AbortSignal)))
    expect(submitted(fits)).toBe(styled(fitting))
    expect(submitted(fits).length).toBeLessThanOrEqual(MATRIX_PROMPT_MAX)
    finish(fits)
    await first

    const full = fixture()
    const long = 'x'.repeat(MATRIX_PROMPT_MAX - room + 1)
    const second = runMatrixHermesTurn(full.gateway, { ...full.input, text: long, turnStyle: true })
    await vi.waitFor(() => expect(full.request).toHaveBeenCalledWith('prompt.submit', expect.anything(), 15000, expect.any(AbortSignal)))
    expect(submitted(full)).toBe(long)
    finish(full)
    await second
  })
})

it('shows a complete reasoning block in place of the thinking so far, and bounds tool labels', async () => {
  const f = fixture()
  const onActivity = vi.fn()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onActivity })
  await vi.waitFor(() => expect(f.events.size).toBe(1))

  f.emit('reasoning.delta', { text: 'partial' })
  f.emit('reasoning.available', { text: 'I will list the folder first.' })
  f.emit('tool.start', { name: 'terminal', context: 'x'.repeat(500) })
  finish(f)
  await pending

  const last = onActivity.mock.calls.at(-1)?.[0]
  expect(last.reasoning).toBe('I will list the folder first.')
  expect(last.tools[0].detail).toHaveLength(160)
})

it('coalesces token bursts, flushes completion immediately, and cancels pending/late updates', async () => {
  const f = fixture()
  const onActivity = vi.fn()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onActivity })
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  vi.useFakeTimers()

  for (let index = 0; index < 120; index++) {
    f.emit('message.delta', { text: 'x' })
  }

  expect(onActivity).toHaveBeenCalledTimes(1)
  expect(onActivity.mock.calls[0][0]).toMatchObject({ state: 'running', text: 'x' })
  await vi.advanceTimersByTimeAsync(99)
  expect(onActivity).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(onActivity).toHaveBeenCalledTimes(2)
  expect(onActivity.mock.calls.at(-1)?.[0].text).toBe('x'.repeat(120))
  f.emit('message.delta', { text: 'queued' })
  finish(f)
  await pending
  expect(onActivity).toHaveBeenCalledTimes(3)
  expect(onActivity.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'complete', text: 'done' })

  f.emit('message.delta', { text: 'late text' })
  f.emit('tool.start', { name: 'terminal' })
  await vi.advanceTimersByTimeAsync(1000)
  expect(onActivity).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps long turns live without a lifetime cutoff and flushes tools without waiting for text', async () => {
  const f = fixture()
  const onActivity = vi.fn()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onActivity })
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  vi.useFakeTimers()

  for (let index = 0; index < 110; index++) {
    f.emit('message.delta', { text: 'x' })
    await vi.advanceTimersByTimeAsync(100)
  }

  expect(onActivity.mock.calls.at(-1)?.[0].text).toBe('x'.repeat(110))
  f.emit('message.delta', { text: 'queued' })
  f.emit('tool.start', { name: 'terminal' })
  expect(onActivity.mock.calls.at(-1)?.[0]).toMatchObject({
    text: `${'x'.repeat(110)}queued`,
    tools: [{ name: 'Terminal', state: 'running' }]
  })
  expect(vi.getTimerCount()).toBe(0)
  f.emit('tool.complete', { name: 'terminal' })
  expect(onActivity.mock.calls.at(-1)?.[0].tools[0].state).toBe('complete')

  for (let index = 0; index < 30; index++) {
    f.emit('message.delta', { text: 'x'.repeat(5000) })
    f.emit('tool.start', { name: 'terminal' })
  }

  await vi.advanceTimersByTimeAsync(100)
  expect(onActivity.mock.calls.at(-1)?.[0].text).toHaveLength(16000)
  expect(onActivity.mock.calls.at(-1)?.[0].tools).toHaveLength(12)
  finish(f)
  await pending
})

it('contains a presentation observer exception without changing the Hermes turn outcome', async () => {
  const f = fixture()

  const onActivity = vi.fn(() => {
    throw new Error('renderer unavailable')
  })

  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, onActivity })
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  f.emit('message.delta', { text: 'still running' })
  finish(f)

  await expect(pending).resolves.toEqual({ text: 'done', storedSession: 'stored' })
  expect(onActivity).toHaveBeenCalledTimes(2)
})

it.each(['abort', 'disconnect', 'error'])(
  'seals pending activity on %s and never projects a late gateway event',
  async mode => {
    const f = fixture()
    const controller = new AbortController()
    const onActivity = vi.fn()
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, signal: controller.signal, onActivity })
    await vi.waitFor(() => expect(f.events.size).toBe(1))
    vi.useFakeTimers()
    f.emit('message.delta', { text: 'Before stop' })
    f.emit('message.delta', { text: ' queued' })

    if (mode === 'abort') {
      controller.abort()
    } else if (mode === 'disconnect') {
      for (const handler of f.states) {
        handler('closed')
      }
    } else {
      f.emit('error', { message: 'private' })
    }

    f.emit('message.delta', { text: 'After stop' })

    await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(onActivity.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'stopped', text: 'Before stop queued' })
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain('After stop')
    const count = onActivity.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(onActivity).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it.each(['error', 'approval.request', 'clarify.request', 'sudo.request', 'secret.request', 'message.complete'])(
  'never approves or retries a %s and preserves uncertainty',
  async type => {
    const f = fixture()
    const promise = runMatrixHermesTurn(f.gateway, f.input)
    const rejected = expect(promise).rejects.toThrow('matrix_hermes_outcome_unknown')
    await vi.waitFor(() => expect(f.events.size).toBe(1))
    f.emit(type, { status: 'interrupted', message: 'private' })
    await rejected
    expect(f.request.mock.calls.map(call => call[0])).toEqual([
      'session.create',
      'prompt.submit',
      'session.interrupt',
      'session.close'
    ])
    expect(f.events.size + f.states.size).toBe(0)
  }
)

it.each(['abort', 'disconnect'])('closes its own session after %s and never resumes/replays', async mode => {
  const f = fixture()
  const controller = new AbortController()
  const promise = runMatrixHermesTurn(f.gateway, { ...f.input, signal: controller.signal })
  const rejected = expect(promise).rejects.toThrow('matrix_hermes_outcome_unknown')
  await vi.waitFor(() => expect(f.events.size).toBe(1))

  if (mode === 'abort') {
    controller.abort()
  } else {
    for (const handler of f.states) {
      handler('closed')
    }
  }

  await rejected
  expect(f.request.mock.calls.filter(call => call[0] === 'prompt.submit')).toHaveLength(1)
  expect(f.events.size + f.states.size).toBe(0)
})

it('rejects already-cancelled input before any dispatch and bounds a silent gateway', async () => {
  const f = fixture()
  await expect(runMatrixHermesTurn(f.gateway, { ...f.input, signal: AbortSignal.abort() })).rejects.toThrow('unknown')
  expect(f.request).not.toHaveBeenCalled()
  await expect(runMatrixHermesTurn(f.gateway, { ...f.input, timeoutMs: 20 })).rejects.toThrow('unknown')
  expect(f.events.size + f.states.size).toBe(0)
})

it('preserves uncertainty if prompt ACK fails despite an earlier completion event', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) => {
    if (args[0] === 'prompt.submit') {
      f.emit('message.complete', { status: 'complete', text: 'not durable proof of ACK' })
      throw new Error('private transport error')
    }

    return original(...args)
  })
  await expect(runMatrixHermesTurn(f.gateway, f.input)).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(f.request.mock.calls.filter(call => call[0] === 'prompt.submit')).toHaveLength(1)
  expect(f.events.size + f.states.size).toBe(0)
})

it('does not accept a completion after abort', async () => {
  const f = fixture()
  const controller = new AbortController()
  const promise = runMatrixHermesTurn(f.gateway, { ...f.input, signal: controller.signal })
  const rejected = expect(promise).rejects.toThrow('matrix_hermes_outcome_unknown')
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  controller.abort()
  f.emit('message.complete', { status: 'complete', text: 'too late' })
  await rejected
  expect(f.events.size + f.states.size).toBe(0)
})

it('retires a queued submission immediately instead of waiting for another turn to finish', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) =>
    args[0] === 'prompt.submit' ? { status: 'queued' } : original(...args)
  )
  const pending = runMatrixHermesTurn(f.gateway, f.input)
  await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
  expect(f.request.mock.calls.map(call => call[0])).toEqual([
    'session.create',
    'prompt.submit',
    'session.interrupt',
    'session.close'
  ])
  expect(f.events.size + f.states.size).toBe(0)
})

it('resumes through Hermes lineage and waits for post-completion idle before retaining the current stored identity', async () => {
  const f = fixture()
  const remember = vi.fn()
  f.request.mockImplementation(async (method, params) => {
    if (method === 'session.resume') {
      expect(params).toEqual({ session_id: 'parent', source: 'matrix', async_delivery: false })

      return { session_id: 'own', session_key: 'tip', running: false, async_delivery: false }
    }

    expect(remember).toHaveBeenCalledWith('tip')

    return { status: 'streaming' }
  })
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, conversation: { storedSession: 'parent', remember } })
  let settled = false
  void pending.then(() => {
    settled = true
  })
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  f.emit('session.info', { running: false, stored_session_id: 'tip' })
  f.emit('message.complete', { text: 'resumed answer', status: 'complete' })
  await Promise.resolve()
  expect(settled).toBe(false)
  f.emit('session.info', { running: true, stored_session_id: 'compressed-tip' })
  await Promise.resolve()
  expect(settled).toBe(false)
  f.emit('session.info', { running: false, stored_session_id: 'compressed-tip' })
  expect(await pending).toEqual({ text: 'resumed answer', storedSession: 'compressed-tip' })
  expect(remember.mock.calls).toEqual([['tip'], ['compressed-tip', undefined, true]])
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume', 'prompt.submit'])
})

it.each([
  { session_id: 'own', stored_session_id: 'stored' },
  { session_id: 'own', stored_session_id: 'stored', async_delivery: true },
  { session_id: 'own', stored_session_id: 'stored', async_delivery: false, running: true }
])('never dispatches on unsupported or busy session %j', async response => {
  const f = fixture()
  f.request.mockResolvedValue(response)
  await expect(
    runMatrixHermesTurn(f.gateway, {
      ...f.input,
      conversation: { storedSession: 'existing', remember: vi.fn() }
    })
  ).rejects.toBeInstanceOf(MatrixHermesPreSubmissionError)
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume'])
})

it.each([
  { session_id: 'own', stored_session_id: 'stored' },
  { session_id: 'own', stored_session_id: 'stored', async_delivery: true },
  { session_id: 'own', stored_session_id: 'stored', async_delivery: false, running: true }
])('closes only the newly created unusable draft without interrupting: %j', async response => {
  const f = fixture()
  f.request.mockResolvedValue(response)
  await expect(runMatrixHermesTurn(f.gateway, f.input)).rejects.toBeInstanceOf(MatrixHermesPreSubmissionError)
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.create', 'session.close'])
  expect(f.events.size + f.states.size).toBe(0)
})

it('does not substitute a new session for missing/corrupt retained history or a failed vault write', async () => {
  const f = fixture()
  f.request.mockRejectedValue(new Error('missing stored session'))
  await expect(
    runMatrixHermesTurn(f.gateway, {
      ...f.input,
      conversation: { storedSession: 'missing', remember: vi.fn() }
    })
  ).rejects.toThrow('unknown')
  expect(f.request.mock.calls.map(call => call[0])).toEqual(['session.resume'])
  const g = fixture()
  await expect(
    runMatrixHermesTurn(g.gateway, {
      ...g.input,
      conversation: {
        remember: () => {
          throw new Error('vault failed')
        }
      }
    })
  ).rejects.toBeInstanceOf(MatrixHermesPreSubmissionError)
  expect(g.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(false)
  expect(g.request.mock.calls.map(call => call[0])).toEqual(['session.create', 'session.close'])
})

it('does not report a completed turn when retaining its final session identity fails', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) => {
    if (args[0] === 'prompt.submit') {
      f.emit('message.complete', { status: 'complete', text: 'done' })
      f.emit('session.info', { running: false, stored_session_id: 'compressed-tip' })
    }

    return original(...args)
  })

  const remember = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('vault write failed')
    })

  await expect(runMatrixHermesTurn(f.gateway, { ...f.input, conversation: { remember } })).rejects.toThrow('unknown')
  expect(remember.mock.calls).toEqual([['stored', 'fence'], ['stored'], ['compressed-tip', undefined, true]])
  expect(f.request.mock.calls.filter(call => call[0] === 'prompt.submit')).toHaveLength(1)
  expect(f.request.mock.calls.slice(-2).map(call => call[0])).toEqual(['session.interrupt', 'session.close'])
  expect(f.events.size + f.states.size).toBe(0)
})

it.each(['sudo', 'secret'] as const)(
  'answers a %s prompt from the owner and keeps the turn going, as the old app did',
  async kind => {
    const f = fixture()
    const prompts = new MatrixHermesPrompts(() => {})
    const original = f.request.getMockImplementation()!

    f.request.mockImplementation(async (...args) => {
      if (args[0] === `${kind}.respond`) {
        expect(args[1]).toEqual(
          kind === 'sudo' ? { request_id: 'q', password: 'hunter2' } : { request_id: 'q', value: 'sk-owner' }
        )
        finish(f)

        return { status: 'ok' }
      }

      return original(...args)
    })

    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, ask: prompts.ask })
    await vi.waitFor(() => expect(f.events.size).toBe(1))
    f.emit(
      `${kind}.request`,
      kind === 'sudo' ? { request_id: 'q' } : { request_id: 'q', env_var: 'KEY', prompt: 'Key' }
    )
    const [prompt] = prompts.snapshot()
    expect(prompt.kind).toBe(kind)
    prompts.respond(
      kind === 'sudo' ? { id: prompt.id, kind, password: 'hunter2' } : { id: prompt.id, kind, value: 'sk-owner' }
    )
    await expect(pending).resolves.toMatchObject({ text: 'done' })
    expect(prompts.snapshot()).toEqual([])
  }
)

it('drops a password card when Hermes stops waiting, and the turn carries on', async () => {
  const f = fixture()
  const prompts = new MatrixHermesPrompts(() => {})
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, ask: prompts.ask })
  await vi.waitFor(() => expect(f.events.size).toBe(1))
  f.emit('sudo.request', { request_id: 'q' })
  expect(prompts.snapshot()).toHaveLength(1)
  f.emit('sudo.expire', { request_id: 'q' })
  expect(prompts.snapshot()).toEqual([])
  finish(f)
  await expect(pending).resolves.toMatchObject({ text: 'done' })
  expect(f.request.mock.calls.some(call => call[0] === 'sudo.respond')).toBe(false)
})

it("names the turn's room, so a job the agent schedules posts back there", async () => {
  const f = fixture()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, roomId: '!alfred:atum.test' })
  await vi.waitFor(() =>
    expect(f.request).toHaveBeenCalledWith('prompt.submit', expect.anything(), 15000, expect.any(AbortSignal))
  )
  expect(f.request.mock.calls.find(call => call[0] === 'prompt.submit')![1]).toEqual({
    session_id: 'own',
    text: f.input.text,
    chat_id: '!alfred:atum.test'
  })
  finish(f)
  expect(await pending).toEqual({ text: 'done', storedSession: 'stored' })
})

it('starts a new conversation at the chosen thinking level without touching its model', async () => {
  const f = fixture()

  const pending = runMatrixHermesTurn(f.gateway, {
    ...f.input,
    effort: 'high',
    sessionModel: { provider: 'openai-codex', model: 'gpt-5.5' }
  })

  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  finish(f)
  await pending
  expect(f.request.mock.calls.find(call => call[0] === 'session.create')![1]).toMatchObject({
    reasoning_effort: 'high'
  })
  // A new session already runs on the profile's model: no switch, no second level write.
  expect(f.request.mock.calls.some(call => call[0] === 'config.set')).toBe(false)
})

it("switches a resumed conversation to the person's current model and level before its turn, for this session only", async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) =>
    args[0] === 'session.resume'
      ? {
          session_id: 'own',
          stored_session_id: 'stored',
          async_delivery: false,
          info: { model: 'nguyet-thuc', provider: 'custom:atum', reasoning_effort: '' }
        }
      : args[0] === 'config.set'
        ? // Hermes's answer to a switch it made: no confirmation was needed.
          {
            key: (args[1] as { key: string }).key,
            value:
              (args[1] as { key: string; value: string }).key === 'reasoning'
                ? (args[1] as { value: string }).value
                : 'gpt-5.5',
            confirm_required: false,
            scope: 'session'
          }
        : original(...args)
  )

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const pending = runMatrixHermesTurn(f.gateway, {
    ...f.input,
    effort: 'low',
    sessionModel: { provider: 'openai-codex', model: 'gpt-5.5' },
    conversation: { storedSession: 'stored', remember: () => {} }
  })

  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  finish(f)
  await expect(pending).resolves.toMatchObject({ text: 'done' })
  const order = f.request.mock.calls.map(call => call[0])
  const sets = f.request.mock.calls.filter(call => call[0] === 'config.set').map(call => call[1])
  // The switch never confirms an expensive model on the person's behalf.
  expect(sets).toEqual([
    { key: 'model', value: 'gpt-5.5 --provider openai-codex --session', session_id: 'own' },
    { key: 'reasoning', value: 'low', session_id: 'own', scope: 'session' }
  ])
  expect(warn).not.toHaveBeenCalled()
  // Both at the boundary: before the prompt is submitted, never during the turn.
  expect(order.lastIndexOf('config.set')).toBeLessThan(order.indexOf('prompt.submit'))
  warn.mockRestore()
})

it('keeps a resumed conversation on its model when Hermes asks to confirm an expensive one, and still answers', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  const message = 'gpt-5.5-pro costs about $30 per million tokens. Confirm to switch.'

  f.request.mockImplementation(async (...args) =>
    args[0] === 'session.resume'
      ? {
          session_id: 'own',
          stored_session_id: 'stored',
          async_delivery: false,
          info: { model: 'nguyet-thuc', provider: 'custom:atum', reasoning_effort: 'medium' }
        }
      : args[0] === 'config.set'
        ? // Hermes's answer when it held the switch back: nothing was switched.
          { key: 'model', value: 'gpt-5.5-pro', warning: message, confirm_required: true, confirm_message: message }
        : original(...args)
  )

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const pending = runMatrixHermesTurn(f.gateway, {
    ...f.input,
    effort: 'medium',
    sessionModel: { provider: 'openai-codex', model: 'gpt-5.5-pro' },
    conversation: { storedSession: 'stored', remember: () => {} }
  })

  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  finish(f)
  await expect(pending).resolves.toMatchObject({ text: 'done' })

  // One try, never confirmed and never retried with a confirmation.
  const sets = f.request.mock.calls.filter(call => call[0] === 'config.set').map(call => call[1])
  expect(sets).toEqual([{ key: 'model', value: 'gpt-5.5-pro --provider openai-codex --session', session_id: 'own' }])
  expect(JSON.stringify(f.request.mock.calls)).not.toContain('confirm_expensive_model')

  // One log line, with no model name and none of Hermes's message.
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith('[Matrix] conversation model switch not applied: confirmation_required')
  expect(JSON.stringify(warn.mock.calls)).not.toContain('gpt-5.5')
  warn.mockRestore()
})

it('leaves a resumed conversation alone when it already runs on the choice, and goes on when a switch is refused', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  let info: Record<string, unknown> = { model: 'gpt-5.5', provider: 'openai-codex', reasoning_effort: 'medium' }
  f.request.mockImplementation(async (...args) =>
    args[0] === 'session.resume'
      ? { session_id: 'own', stored_session_id: 'stored', async_delivery: false, info }
      : args[0] === 'config.set'
        ? Promise.reject(new Error('refused'))
        : original(...args)
  )

  const run = async () => {
    const pending = runMatrixHermesTurn(f.gateway, {
      ...f.input,
      effort: 'medium',
      sessionModel: { provider: 'openai-codex', model: 'gpt-5.5' },
      conversation: { storedSession: 'stored', remember: () => {} }
    })

    await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
    finish(f)

    return pending
  }

  await expect(run()).resolves.toMatchObject({ text: 'done' })
  expect(f.request.mock.calls.some(call => call[0] === 'config.set')).toBe(false)

  // On another model: the switch is tried, refused, and the turn still answers.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.request.mockClear()
  info = { model: 'claude-fable-5', provider: 'anthropic', reasoning_effort: 'medium' }
  await expect(run()).resolves.toMatchObject({ text: 'done' })
  expect(f.request.mock.calls.filter(call => call[0] === 'config.set')).toHaveLength(1)
})

it.each(['legacy', 'project', 'busy'])(
  'resume cwd integration preserves %s behavior before prompt submission',
  async mode => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atum-r1-resume-')))
    const legacy = path.join(home, 'Atum')
    const workspace = path.join(legacy, 'Workspace')
    const project = path.join(home, 'Project')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(project)

    try {
      const f = fixture()
      f.request.mockImplementation(async (method, params) => {
        if (method === 'session.resume') {
          return {
            session_id: 'own',
            stored_session_id: 'stored',
            running: false,
            async_delivery: false,
            info: { cwd: mode === 'project' ? project : legacy }
          }
        }

        if (method === 'session.cwd.set') {
          expect(params).toEqual({ session_id: 'own', cwd: workspace })

          if (mode === 'busy') {
            throw new GatewayRpcError('synthetic busy', 4009)
          }

          return {}
        }

        return { status: 'streaming' }
      })

      const pending = runMatrixHermesTurn(f.gateway, {
        ...f.input,
        workspace,
        legacyWorkspace: legacy,
        conversation: { storedSession: 'prior', remember: vi.fn() }
      })

      await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
      expect(f.request.mock.calls.map(call => call[0])).toEqual(
        mode === 'project'
          ? ['session.resume', 'prompt.submit']
          : ['session.resume', 'session.cwd.set', 'prompt.submit']
      )
      finish(f)
      await expect(pending).resolves.toMatchObject({ text: 'done' })
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  }
)

it.each([
  { petSurface: true, admitted: true },
  { petSurface: false, admitted: false },
  { petSurface: true, sharedRoom: true, admitted: false },
  { petSurface: true, replyOnly: true, admitted: false }
])('returns completion cosmetics only for an admitted private profile $admitted', async profile => {
  const f = fixture()
  const pending = runMatrixHermesTurn(f.gateway, { ...f.input, ...profile })
  await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  const intents = [{ action: 'go', place: 'left' }, { action: 'wave' }]
  f.emit('message.complete', { status: 'complete', text: 'done', pet_intents: intents })
  intents[0].place = 'right'
  f.emit('session.info', { running: false, stored_session_id: 'stored' })
  expect(await pending).toEqual({
    text: 'done',
    storedSession: 'stored',
    ...(profile.admitted
      ? {
          pet: { v: 1, intents: [{ action: 'go', place: 'left' }, { action: 'wave' }] }
        }
      : {})
  })
  const create = f.request.mock.calls.find(call => call[0] === 'session.create')![1] as Record<string, unknown>
  expect(create.pet_surface).toBe(profile.admitted ? true : undefined)
})

it.each([[{ action: 'go' }], [{ action: 'wave', text: 'extra' }], [], null])(
  'malformed completion cosmetics do not invalidate the text answer %j',
  async pet_intents => {
    const f = fixture()
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, petSurface: true })
    await vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
    f.emit('message.complete', { status: 'complete', text: 'done', pet_intents })
    f.emit('session.info', { running: false, stored_session_id: 'stored' })
    expect(await pending).toEqual({ text: 'done', storedSession: 'stored' })
  }
)

it.each(['refusal', 'mismatch', 'missing'])('never submits a resumed turn after effort %s', async mode => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (...args) => {
    if (args[0] === 'session.resume') {
      return {
        session_id: 'own',
        stored_session_id: 'stored',
        async_delivery: false,
        info: { reasoning_effort: 'medium' }
      }
    }

    if (args[0] === 'config.set') {
      if (mode === 'refusal') {
        throw new Error('upstream-private-canary')
      }

      return mode === 'missing' ? null : { key: 'reasoning', value: 'high' }
    }

    return original(...args)
  })
  const submit = vi.fn()
  await expect(
    runMatrixHermesTurn(f.gateway, {
      ...f.input,
      effort: 'low',
      onSubmit: submit,
      conversation: { storedSession: 'stored', remember: () => {} }
    })
  ).rejects.toThrow('matrix_hermes_session_invalid')
  expect(f.request.mock.calls.some(call => ['prompt.submit', 'file.attach', 'session.create'].includes(call[0]))).toBe(
    false
  )
  expect(submit).not.toHaveBeenCalled()
})

// R3 (resume instead of refuse): what a run did, as far as this Mac saw it (turn-effects.ts).
describe('what a failed run is known to have done', () => {
  const submitted = (f: ReturnType<typeof fixture>) =>
    vi.waitFor(() => expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))

  it('proves nothing ran for a run that failed before the prompt left', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    f.request.mockImplementation(async method => {
      if (method === 'session.create') {
        throw new Error('network blip')
      }

      return { status: 'streaming' }
    })
    await expect(runMatrixHermesTurn(f.gateway, { ...f.input, effects })).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(f.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(false)
    expect(effects.evidence()).toEqual({ effect: 'none', tools: [], blind: false })
  })

  it('proves nothing ran for a run aborted before it was submitted', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    const abort = new AbortController()
    f.request.mockImplementation(async method => {
      if (method === 'session.create') {
        abort.abort()
      }

      return method === 'session.create'
        ? { session_id: 'own', stored_session_id: 'stored', async_delivery: false }
        : { status: 'streaming' }
    })
    await expect(runMatrixHermesTurn(f.gateway, { ...f.input, effects, signal: abort.signal })).rejects.toThrow(
      'matrix_hermes_outcome_unknown'
    )
    expect(effects.evidence().effect).toBe('none')
  })

  it('counts model work and read-only tools as no effect', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, effects })
    await submitted(f)
    f.emit('message.start', { turn_id: 'actual' })
    f.emit('message.delta', { text: 'looking' })
    f.emit('tool.start', { name: 'read_file' })
    f.emit('tool.complete', { name: 'read_file' })
    f.emit('tool.start', { name: 'web_search' })
    f.emit('error', { code: 'provider_down' })
    await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(effects.evidence()).toEqual({ effect: 'read_only', tools: [], blind: false })
  })

  it('names the tool that may have changed something, including one the public activity omits', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, effects })
    await submitted(f)
    f.emit('tool.start', { name: 'read_file' })
    f.emit('tool.start', { name: 'terminal' })
    f.emit('tool.start', { name: 'mcp_calendar_create_event' })
    f.emit('error', { code: 'provider_down' })
    await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(effects.evidence()).toEqual({
      effect: 'side_effect_possible',
      tools: ['terminal', 'mcp_calendar_create_event'],
      blind: false
    })
  })

  it('still counts a tool that starts while the run is being interrupted', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    f.request.mockImplementation(async method => {
      if (method === 'session.interrupt') {
        f.emit('tool.start', { name: 'write_file' })

        return {}
      }

      return method === 'session.create'
        ? { session_id: 'own', stored_session_id: 'stored', async_delivery: false }
        : { status: 'streaming' }
    })
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, effects })
    await submitted(f)
    f.emit('error', { code: 'provider_down' })
    await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(effects.evidence()).toEqual({ effect: 'side_effect_possible', tools: ['write_file'], blind: false })
    // Nothing is listening once the run is over.
    expect(f.events.size).toBe(0)
  })

  it('rules nothing out when the connection to Hermes is lost after submission', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, effects })
    await submitted(f)

    for (const handler of [...f.states]) {
      handler('closed')
    }

    await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(effects.evidence()).toEqual({ effect: 'side_effect_possible', tools: [], blind: true })
    expect(f.states.size).toBe(0)
  })

  it('does not count a tool of another session', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, effects })
    await submitted(f)
    f.emit('tool.start', { name: 'terminal' }, 'someone-else')
    f.emit('error', { code: 'provider_down' })
    await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(effects.evidence().effect).toBe('read_only')
  })

  it('does not call a run read-only when the session does not show tool starts', async () => {
    // Hermes announces a tool's start only when its tool-progress mode is not "off": a run that
    // used `terminal` then looks like one that did nothing, so it must count as one that may have.
    for (const answer of [{ value: 'off' }, {}, null, 'garbage']) {
      const f = fixture()
      const effects = new MatrixTurnEffects()
      f.request.mockImplementation(async method =>
        method === 'session.create'
          ? { session_id: 'own', stored_session_id: 'stored', async_delivery: false }
          : method === 'config.get'
            ? answer
            : { status: 'streaming' }
      )
      const pending = runMatrixHermesTurn(f.gateway, { ...f.input, effects })
      await submitted(f)
      f.emit('error', { code: 'provider_down' })
      await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
      expect(effects.evidence().effect).toBe('side_effect_possible')
    }
  })

  it('fails closed against a Hermes that does not know the question, and asks about its own session', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    f.request.mockImplementation(async method => {
      if (method === 'config.get') {
        throw new Error('unknown config key')
      }

      return method === 'session.create'
        ? { session_id: 'own', stored_session_id: 'stored', async_delivery: false }
        : { status: 'streaming' }
    })
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, effects })
    await submitted(f)
    f.emit('error', { code: 'provider_down' })
    await expect(pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(effects.evidence().effect).toBe('side_effect_possible')

    const asked = f.request.mock.calls.find(call => call[0] === 'config.get')
    expect(asked?.[1]).toEqual({ key: 'verbose', session_id: 'own' })
    // The question comes before the prompt leaves.
    expect(f.request.mock.calls.findIndex(call => call[0] === 'config.get')).toBeLessThan(
      f.request.mock.calls.findIndex(call => call[0] === 'prompt.submit')
    )
  })

  it('leaves a completed run exactly as it was, with the tracker saying read-only or what ran', async () => {
    const f = fixture()
    const effects = new MatrixTurnEffects()
    const pending = runMatrixHermesTurn(f.gateway, { ...f.input, effects })
    await submitted(f)
    f.emit('tool.start', { name: 'terminal' })
    finish(f)
    await expect(pending).resolves.toMatchObject({ text: 'done' })
    expect(effects.evidence().tools).toEqual(['terminal'])
    expect(f.events.size).toBe(0)
  })
})
