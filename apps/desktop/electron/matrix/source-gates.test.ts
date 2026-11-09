import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_SOURCE_GATES_PROFILE,
  type AgentSourceGates,
  type AgentSourceGateSnapshot,
  parseAgentSourceGateWriteConflict
} from '../../../../packages/device-protocol/agent-source-gates'

import {
  MatrixSourceGateError,
  MatrixSourceGateSync,
  readMatrixSourceGates,
  writeMatrixSourceGates
} from './source-gates'

const assistantA = '34200000-0000-4000-8000-000000000001'
const assistantB = '34200000-0000-4000-8000-000000000002'
const accountKey = 'a'.repeat(64)
const conflictFixture = parseAgentSourceGateWriteConflict(JSON.parse(readFileSync(new URL(
  '../../../../packages/device-protocol/fixtures/agent-source-gates/fixtures/write-stale-revision-conflict.json',
  import.meta.url
), 'utf8')))

const enabled = (): AgentSourceGates => ({
  google: true,
  folders: true,
  messages: true,
  browser: true,
  location: true,
  team_spaces: true
})

function snapshot(revision: number, gates: AgentSourceGates): AgentSourceGateSnapshot {
  return { profile: AGENT_SOURCE_GATES_PROFILE, revision, gates: { ...gates } }
}

function harness(input: {
  local?: AgentSourceGates
  remote?: Record<string, AgentSourceGateSnapshot>
  read?: (assistantId: string) => Promise<AgentSourceGateSnapshot>
  write?: (assistantId: string, value: any) => Promise<AgentSourceGateSnapshot>
  retryMs?: readonly number[]
  log?: (line: string) => void
} = {}) {
  let local = input.local ?? enabled()
  let scope: { accountKey: string; generation: number } | null = { accountKey, generation: 1 }
  const remote = input.remote ?? {
    [assistantA]: snapshot(0, enabled()),
    [assistantB]: snapshot(0, enabled())
  }
  let request = 0
  const read = vi.fn(input.read ?? (async assistantId => remote[assistantId]!))
  const write = vi.fn(input.write ?? (async (assistantId, value) => {
    const next = snapshot(value.expectedRevision + 1, value.gates)
    remote[assistantId] = next
    return next
  }))
  const sync = new MatrixSourceGateSync({
    scope: () => scope,
    gates: () => ({ ...local }),
    assistants: async () => [assistantA, assistantB],
    read,
    write,
    uuid: () => `34200000-0000-4000-8000-${String(++request).padStart(12, '0')}`,
    retryMs: input.retryMs,
    log: input.log
  })

  return { sync, read, write, remote,
    setLocal: (gates: AgentSourceGates) => { local = gates },
    clearScope: () => { scope = null } }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('owner source gate synchronization', () => {
  it('puts a switched-off gate immediately with the complete local intent', async () => {
    const local = { ...enabled(), google: false }
    const h = harness({ local, remote: { [assistantA]: snapshot(4, enabled()) } })

    expect(h.sync.reconcile([assistantA])).toBeUndefined()
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledOnce())

    expect(h.write).toHaveBeenCalledWith(assistantA, {
      profile: AGENT_SOURCE_GATES_PROFILE,
      requestId: '34200000-0000-4000-8000-000000000001',
      expectedRevision: 4,
      gates: local
    }, expect.any(AbortSignal))
  })

  it('reconciles every active assistant on app start when server state drifted', async () => {
    const drifted = { ...enabled(), messages: false }
    const h = harness({ remote: {
      [assistantA]: snapshot(2, drifted),
      [assistantB]: snapshot(9, drifted)
    } })

    h.sync.reconcile([assistantB, assistantA])
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(2))

    expect(h.write.mock.calls.map(call => call[0])).toEqual([assistantA, assistantB])
    expect(h.write.mock.calls.map(call => call[1].expectedRevision)).toEqual([2, 9])
    expect(h.write.mock.calls.every(call => call[1].gates.messages === true)).toBe(true)
  })

  it('re-reads a stale revision conflict and reapplies current local intent', async () => {
    const local = { ...enabled(), team_spaces: false }
    let revision = 3
    const read = vi.fn(async () => snapshot(revision, enabled()))
    const write = vi.fn(async (_assistantId: string, value: any) => {
      if (value.expectedRevision === 3) {
        revision = 4
        throw new MatrixSourceGateError('conflict', snapshot(4, enabled()))
      }

      return snapshot(5, value.gates)
    })
    const h = harness({ local, read, write })

    h.sync.reconcile([assistantA])
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))

    expect(read).toHaveBeenCalledOnce()
    expect(write.mock.calls.map(call => call[1].expectedRevision)).toEqual([3, 4])
    expect(write.mock.calls.map(call => call[1].requestId)).toEqual([
      '34200000-0000-4000-8000-000000000001',
      '34200000-0000-4000-8000-000000000002'
    ])
    expect(write.mock.calls[1]![1].gates.team_spaces).toBe(false)
  })

  it('retries an offline write with backoff and the same idempotent request ID', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const read = vi.fn(async () => snapshot(1, { ...enabled(), browser: false }))
    const write = vi.fn(async (_assistantId: string, value: any) => {
      if (++attempts === 1) {
        throw new MatrixSourceGateError('unavailable')
      }
      return snapshot(2, value.gates)
    })
    const h = harness({ read, write, retryMs: [10] })

    expect(h.sync.reconcile([assistantA])).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]![1].requestId).toBe(write.mock.calls[0]![1].requestId)
  })

  it('keeps an unavailable route out of user state, coalesces roster refreshes and logs once', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const read = vi.fn(async () => {
      throw new MatrixSourceGateError('unavailable', undefined, 'http_503')
    })
    const h = harness({ read, retryMs: [10, 20], log })

    expect(h.sync.reconcile([assistantA])).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[Matrix] source gates unavailable reason=http_503; retrying quietly'
    )

    // The periodic roster read is not a new user intent and must not reset the outage to 10 ms.
    h.sync.reconcile([assistantA])
    await vi.advanceTimersByTimeAsync(9)
    expect(read).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20)
    expect(read).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('does not put when the server already equals local intent', async () => {
    const h = harness({ remote: { [assistantA]: snapshot(8, enabled()) } })

    h.sync.reconcile([assistantA])
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce())

    expect(h.write).not.toHaveBeenCalled()
  })
})

describe('source gate transport', () => {
  it('uses the exact GET and PUT wire shapes and reports revision conflict', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (calls.length === 3) {
        return Response.json(conflictFixture, { status: 409 })
      }
      return Response.json(snapshot(calls.length, enabled()))
    })
    await expect(readMatrixSourceGates('https://platform.test/api/matrix/v1', 'secret', assistantA,
      new AbortController().signal, fetch)).resolves.toMatchObject({ revision: 1 })
    const write = { profile: AGENT_SOURCE_GATES_PROFILE, requestId: '00000000-0000-4000-8000-2ac574a9242c',
      expectedRevision: 1, gates: { ...enabled(), folders: false } }
    await expect(writeMatrixSourceGates('https://platform.test/api/matrix/v1', 'secret', assistantA, write,
      new AbortController().signal, fetch)).resolves.toMatchObject({ revision: 2 })
    await expect(writeMatrixSourceGates('https://platform.test/api/matrix/v1', 'secret', assistantA, write,
      new AbortController().signal, fetch)).rejects.toMatchObject({ code: 'conflict',
        current: conflictFixture.current })

    expect(calls[0]).toMatchObject({ url: `https://platform.test/api/matrix/v1/agents/${assistantA}/source-gates`,
      init: { method: 'GET', credentials: 'omit', redirect: 'error' } })
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(write)
  })

  it('retains a sanitized HTTP reason for quiet retry diagnostics', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'matrix_503' }, { status: 503 }))

    await expect(readMatrixSourceGates(
      'https://platform.test/api/matrix/v1',
      'secret',
      assistantA,
      new AbortController().signal,
      fetch
    )).rejects.toMatchObject({ code: 'unavailable', reason: 'http_503' })
  })
})
