import { describe, expect, it, vi } from 'vitest'

import {
  type AgentMemoryServiceBrowse,
  AgentMemoryServiceError,
  type AgentMemoryTransport,
  createAgentMemoryHost
} from './agent-memory'

const PRINCIPAL = '00000000-0000-4000-8000-6a1f0c3e9b21'
const OTHER = '00000000-0000-4000-8000-7b2e1d4f0c32'
const OP = '11111111-2222-4333-8444-5555aaaa7777'
const OP2 = '11111111-2222-4333-8444-8888bbbb0000'

const browse = (): AgentMemoryServiceBrowse => ({
  coverage: 'complete',
  more: false,
  sources: [
    {
      handle: 'svc-source-linh',
      kind: 'human_dm',
      label: 'Linh',
      coverage: 'complete',
      facts: [
        { handle: 'svc-fact-coffee', revision: 3, text: 'Linh prefers tea, not coffee.', learnedAt: 1_700_000_000_000, citable: true }
      ]
    }
  ],
  receipts: [{ handle: 'svc-receipt-1', target: 'fact', sourceKind: 'human_group', sourceLabel: 'Team', cleanup: { state: 'hidden' } }]
})

function transport(overrides: Partial<AgentMemoryTransport> = {}): AgentMemoryTransport {
  return {
    status: vi.fn(async () => ({ active: true as const, enabled: true, revision: 4 })),
    setEnabled: vi.fn(async (_id, input) => ({ active: true as const, enabled: input.enabled, revision: input.expectedRevision + 1 })),
    browse: vi.fn(async () => browse()),
    forget: vi.fn(async () => ({ cleanup: { state: 'hidden' as const }, status: { active: true as const, enabled: true, revision: 4 } })),
    correct: vi.fn(async (_id, input) => ({
      outcome: 'done' as const,
      fact: { handle: input.handle, revision: input.expectedRevision + 1, text: input.text, learnedAt: 1_700_000_100_000, citable: true },
      status: { active: true as const, enabled: true, revision: 4 }
    })),
    citation: vi.fn(async () => ({ kind: 'matrix_event' as const, roomId: '!room:atum.test', eventId: '$event-1' })),
    ...overrides
  }
}

function host(service?: AgentMemoryTransport) {
  let account: string | undefined = 'account-a\n1\ndevice-a'
  let counter = 0
  const open = vi.fn(async () => {})

  const memory = createAgentMemoryHost({
    transport: service,
    account: () => account,
    assistant: principal => (principal === PRINCIPAL ? { assistantId: 'assistant-1' } : principal === OTHER ? { assistantId: 'assistant-2' } : undefined),
    open,
    mint: () => `minted-handle-${String(++counter).padStart(4, '0')}`
  })

  return {
    memory,
    open,
    switchAccount(next: string | undefined) {
      account = next
    }
  }
}

async function ready(memory: ReturnType<typeof host>['memory']) {
  const status = (await memory.handle(PRINCIPAL, { action: 'status' })) as { ok: true; status: { available: true; scope: string } }

  const listed = (await memory.handle(PRINCIPAL, { action: 'browse', scope: status.status.scope })) as {
    ok: true
    browse: { sources: Array<{ handle: string; facts: Array<{ handle: string }> }> }
  }

  return { scope: status.status.scope, source: listed.browse.sources[0]!.handle, fact: listed.browse.sources[0]!.facts[0]!.handle }
}

describe('agent memory host', () => {
  it('is simply not available while no cloud transport is wired (activation off)', async () => {
    const { memory } = host()

    expect(await memory.handle(PRINCIPAL, { action: 'status' })).toEqual({ ok: true, status: { available: false } })
    expect(await memory.handle(PRINCIPAL, { action: 'browse', scope: 'minted-handle-0001' })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('shows the window only its own opaque handles and plain words', async () => {
    const { memory } = host(transport())
    const status = await memory.handle(PRINCIPAL, { action: 'status' })

    expect(status).toEqual({ ok: true, status: { available: true, scope: 'minted-handle-0001', state: 'on', revision: 4 } })

    const listed = JSON.stringify(await memory.handle(PRINCIPAL, { action: 'browse', scope: 'minted-handle-0001' }))

    expect(listed).toContain('Linh prefers tea')
    expect(listed).not.toMatch(/svc-|assistant-1|account-a|device-a/)
  })

  it('refuses malformed requests and unknown assistants before calling the service', async () => {
    const service = transport()
    const { memory } = host(service)
    const { scope, fact } = await ready(memory)

    for (const bad of [
      { action: 'forget', scope, target: { kind: 'fact', handle: fact }, operationId: 'not-a-uuid' },
      { action: 'forget', scope, target: { kind: 'fact', handle: fact, factId: 'x' }, operationId: OP },
      { action: 'correct', scope, handle: fact, text: '   ', operationId: OP },
      { action: 'setEnabled', scope, revision: -1, enabled: true, operationId: OP },
      { action: 'browse', scope, databaseUrl: 'postgres://example' }
    ]) {
      expect(await memory.handle(PRINCIPAL, bad)).toEqual({ ok: false, reason: 'invalid' })
    }

    expect(await memory.handle(OTHER, { action: 'browse', scope })).toEqual({ ok: false, reason: 'stale' })
    expect(await memory.handle('someone-else', { action: 'status' })).toEqual({ ok: true, status: { available: false } })
    expect(service.forget).not.toHaveBeenCalled()
  })

  it('turns every older scope and handle stale after an account switch, sign-out or reconnect', async () => {
    const service = transport()
    const { memory, switchAccount } = host(service)
    const { scope, fact } = await ready(memory)

    switchAccount('account-b\n1\ndevice-a')

    expect(await memory.handle(PRINCIPAL, { action: 'forget', scope, target: { kind: 'fact', handle: fact }, operationId: OP })).toEqual({
      ok: false,
      reason: 'stale'
    })

    // The same account reconnecting (a new session generation) is a new scope too.
    switchAccount('account-a\n1\ndevice-a')
    const again = await ready(memory)
    switchAccount('account-a\n2\ndevice-a')

    expect(await memory.handle(PRINCIPAL, { action: 'openSource', scope: again.scope, handle: again.fact })).toEqual({
      ok: false,
      reason: 'stale'
    })

    const fresh = await ready(memory)
    memory.invalidate()

    expect(await memory.handle(PRINCIPAL, { action: 'browse', scope: fresh.scope })).toEqual({ ok: false, reason: 'stale' })
    expect(service.forget).not.toHaveBeenCalled()
  })

  it('drops a reply that lands after the account changed', async () => {
    let release!: () => void

    const service = transport({
      browse: vi.fn(() => new Promise<AgentMemoryServiceBrowse>(resolve => (release = () => resolve(browse()))))
    })

    const { memory, switchAccount } = host(service)
    const status = (await memory.handle(PRINCIPAL, { action: 'status' })) as { status: { scope: string } }
    const pending = memory.handle(PRINCIPAL, { action: 'browse', scope: status.status.scope })

    await vi.waitFor(() => expect(service.browse).toHaveBeenCalled())
    switchAccount('account-b\n1\ndevice-a')
    release()

    expect(await pending).toEqual({ ok: false, reason: 'stale' })
  })

  it('sends the service its own handle and reuses one operation ID for a retry, never for another intent', async () => {
    const forget = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue({ cleanup: { state: 'cleaned', backupExpiresAt: 1_800_000_000_000 }, status: { active: true, enabled: true, revision: 4 } })

    const service = transport({ forget })
    const { memory } = host(service)
    const { scope, fact, source } = await ready(memory)
    const request = { action: 'forget', scope, target: { kind: 'fact', handle: fact }, operationId: OP }

    expect(await memory.handle(PRINCIPAL, request)).toEqual({ ok: false, reason: 'offline' })
    expect(await memory.handle(PRINCIPAL, request)).toEqual({
      ok: true,
      cleanup: { state: 'cleaned', backupExpiresAt: 1_800_000_000_000 },
      status: { available: true, scope, state: 'on', revision: 4 }
    })
    expect(forget.mock.calls.map(call => call[1])).toEqual([
      { target: { kind: 'fact', handle: 'svc-fact-coffee' }, operationId: OP },
      { target: { kind: 'fact', handle: 'svc-fact-coffee' }, operationId: OP }
    ])

    // The same ID for a different target is refused, not applied.
    expect(await memory.handle(PRINCIPAL, { ...request, target: { kind: 'source', handle: source } })).toEqual({ ok: false, reason: 'invalid' })
    // A source handle cannot be sent as a fact.
    expect(await memory.handle(PRINCIPAL, { ...request, target: { kind: 'fact', handle: source }, operationId: OP2 })).toEqual({
      ok: false,
      reason: 'stale'
    })
  })

  it('corrects against the revision the person was shown, and retries with that same revision', async () => {
    const correct = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'pending', status: { active: true, enabled: false, revision: 5 } })
      .mockImplementation(async (_id, input) => ({
        outcome: 'done',
        fact: { handle: input.handle, revision: 9, text: input.text, learnedAt: 1, citable: false },
        status: { active: true, enabled: false, revision: 5 }
      }))

    const service = transport({ correct })
    const { memory } = host(service)
    const { scope, fact } = await ready(memory)
    const request = { action: 'correct', scope, handle: fact, text: 'Linh drinks green tea.', operationId: OP }

    expect(await memory.handle(PRINCIPAL, request)).toMatchObject({ ok: true, outcome: 'pending', status: { state: 'off' } })

    // A later read shows a newer revision; the retry still expects the first one.
    await memory.handle(PRINCIPAL, { action: 'browse', scope })
    const done = await memory.handle(PRINCIPAL, request)

    expect(done).toMatchObject({ ok: true, outcome: 'done', fact: { handle: fact, text: 'Linh drinks green tea.', canOpen: false } })
    expect(correct.mock.calls.map(call => call[1].expectedRevision)).toEqual([3, 3])
  })

  it('maps service refusals to calm answers and keeps permission failures out of chat', async () => {
    const service = transport({
      status: vi.fn(async () => {
        throw new AgentMemoryServiceError('forbidden')
      }),
      setEnabled: vi.fn(async () => {
        throw new AgentMemoryServiceError('conflict')
      })
    })

    const { memory } = host(service)

    expect(await memory.handle(PRINCIPAL, { action: 'status' })).toEqual({ ok: true, status: { available: false } })

    const scoped = host(transport({ setEnabled: service.setEnabled }))
    const { scope } = await ready(scoped.memory)

    expect(
      await scoped.memory.handle(PRINCIPAL, { action: 'setEnabled', scope, revision: 4, enabled: false, operationId: OP })
    ).toEqual({ ok: false, reason: 'conflict' })
  })

  it('asks for the exact current citation on every open and opens only what the service still allows', async () => {
    const citation = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'matrix_event', roomId: '!room:atum.test', eventId: '$event-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: 'matrix_event', roomId: 'https://example.test', eventId: '$x' })

    const { memory, open } = host(transport({ citation }))
    const { scope, fact, source } = await ready(memory)

    expect(await memory.handle(PRINCIPAL, { action: 'openSource', scope, handle: fact })).toEqual({ ok: true })
    expect(await memory.handle(PRINCIPAL, { action: 'openSource', scope, handle: fact })).toEqual({ ok: false, reason: 'unavailable' })
    expect(await memory.handle(PRINCIPAL, { action: 'openSource', scope, handle: fact })).toEqual({ ok: false, reason: 'unavailable' })
    expect(await memory.handle(PRINCIPAL, { action: 'openSource', scope, handle: source })).toEqual({ ok: false, reason: 'stale' })
    expect(citation).toHaveBeenCalledTimes(3)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({ kind: 'matrix_event', roomId: '!room:atum.test', eventId: '$event-1' })
  })

  it('keeps malformed service rows out of the list and says the list is partial', async () => {
    const { memory } = host(
      transport({
        browse: vi.fn(async () => {
          const value = browse()
          value.sources[0]!.facts.push({ handle: 'svc-fact-bad', revision: 1, text: '', learnedAt: 1, citable: true })
          value.sources.push({ handle: 'svc-x', kind: 'mystery' as never, coverage: 'complete', facts: [] })

          return value
        })
      })
    )

    const status = (await memory.handle(PRINCIPAL, { action: 'status' })) as { status: { scope: string } }

    const listed = (await memory.handle(PRINCIPAL, { action: 'browse', scope: status.status.scope })) as {
      browse: { coverage: string; sources: Array<{ facts: unknown[] }>; receipts: Array<{ cleanup: unknown }> }
    }

    expect(listed.browse.coverage).toBe('partial')
    expect(listed.browse.sources).toHaveLength(1)
    expect(listed.browse.sources[0]!.facts).toHaveLength(1)
    expect(listed.browse.receipts).toEqual([
      expect.objectContaining({ target: 'fact', sourceLabel: 'Team', cleanup: { state: 'hidden' } })
    ])
  })
})
