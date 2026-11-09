import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixAgentView, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type {
  MatrixAliasBridge,
  MatrixAliasChange,
  MatrixAliasErrorCode,
  MatrixAliasRequest,
  MatrixAliasResult
} from '../../shared/matrix-aliases'
import type { MatrixHandleBackfillDiagnostic } from '../../shared/matrix-handle-diagnostic'

import {
  backfillMatrixAgentHandles,
  MATRIX_HANDLE_BACKFILL_GAP_MS,
  MATRIX_HANDLE_BACKFILL_ROSTER_MS,
  MATRIX_HANDLE_BACKFILL_START_MS,
  MATRIX_HANDLE_SHEET_CLAIM_MS,
  matrixHandleBackfillLedger,
  noteMatrixAgentHandleSheetClaim,
  useMatrixAgentHandleBackfill
} from './agent-handle-backfill'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const alfred = {
  assistantId: '00000000-0000-4000-8000-fa2b298ca938',
  principal: 'a1f2e3d4-aaaa',
  name: 'Alfred',
  userId: '@alfred:atum.test'
}

const council = {
  assistantId: '00000000-0000-4000-8000-9337a574d44f',
  principal: 'c0c1c2c3-bbbb',
  name: 'Hội đồng',
  userId: '@council:atum.test'
}

const analyst = {
  assistantId: '00000000-0000-4000-8000-89353ff586ea',
  principal: 'd4d5d6d7-cccc',
  name: 'Analyst',
  userId: '@analyst:atum.test'
}

/**
 * The directory behind main, as the claim sees it: `own` is each assistant's handle (absent:
 * none), `fail` refuses a request with a code, `journal` is a change main still holds.
 */
function directory({
  own = {},
  fail,
  journal = null
}: {
  own?: Record<string, string>
  fail?: (input: MatrixAliasRequest) => MatrixAliasErrorCode | undefined
  journal?: MatrixAliasChange | null
} = {}) {
  const held = new Map(Object.entries(own))
  const requests: MatrixAliasRequest[] = []

  const request = vi.fn(async (input: MatrixAliasRequest): Promise<MatrixAliasResult> => {
    requests.push(input)
    const refused = fail?.(input)

    if (refused) {
      return { ok: false, error: refused }
    }

    const target = 'assistantId' in input ? input.assistantId : undefined

    if (input.action === 'current') {
      const handle = target ? held.get(target) : undefined

      return { ok: true, value: { kind: 'current', alias: handle ? { handle, generation: 1 } : null } }
    }

    if (input.action === 'check') {
      const taken = [...held.values()].includes(input.handle)

      return {
        ok: true,
        value: { kind: 'check', handle: input.handle, available: !taken, code: taken ? 'alias_unavailable' : null }
      }
    }

    if (input.action === 'claim' && target) {
      held.set(target, input.handle)

      return { ok: true, value: { kind: 'claim', handle: input.handle, generation: 1 } }
    }

    return { ok: false, error: 'invalid' }
  })

  const diagnostic = vi.fn()

  const bridge: MatrixAliasBridge = {
    pending: vi.fn(async () => ({ ok: true as const, request: journal })),
    request,
    diagnostic
  }

  const changes = () => requests.filter(each => each.action === 'claim' || each.action === 'rename')
  const forAgent = (id: string) => requests.filter(each => 'assistantId' in each && each.assistantId === id)

  return { bridge, requests, changes, forAgent, held, diagnostic }
}

function walk(bridge: MatrixAliasBridge, agents: readonly (typeof alfred)[], ledger = matrixHandleBackfillLedger()) {
  const lines: MatrixHandleBackfillDiagnostic[] = []
  const wait = vi.fn(async () => {})

  return {
    ledger,
    lines,
    wait,
    run: () =>
      backfillMatrixAgentHandles({
        active: () => true,
        agents: () => agents,
        bridge,
        ledger,
        log: line => lines.push(line),
        random: () => 0.5,
        wait
      })
  }
}

describe('giving every assistant a handle, once per launch', () => {
  it('claims a missing handle from the name once, one assistant at a time, and never again this launch', async () => {
    const d = directory()
    const w = walk(d.bridge, [alfred, council])

    expect(await w.run()).toEqual({ retry: false })
    expect(d.held.get(alfred.assistantId)).toBe('alfred_bot')
    // Diacritics stripped from the name, as the create sheet derives it.
    expect(d.held.get(council.assistantId)).toBe('hoi_dong_bot')
    expect(d.changes()).toHaveLength(2)
    // A few seconds between the two, never side by side.
    expect(w.wait).toHaveBeenCalledExactlyOnceWith(MATRIX_HANDLE_BACKFILL_GAP_MS)
    expect(w.lines).toEqual([
      { backfill: 'claimed', agent: 'a1f2e3d4', code: 'none', attempt: 1 },
      { backfill: 'claimed', agent: 'c0c1c2c3', code: 'none', attempt: 1 }
    ])

    const before = d.requests.length
    await w.run()
    expect(d.requests).toHaveLength(before)
  })

  it('only reads an assistant that already has a handle, and changes nothing', async () => {
    const d = directory({ own: { [analyst.assistantId]: 'analyst_bot' } })
    const w = walk(d.bridge, [analyst])

    await w.run()
    expect(d.forAgent(analyst.assistantId).map(each => each.action)).toEqual(['current'])
    expect(d.held.get(analyst.assistantId)).toBe('analyst_bot')
    expect(w.lines).toEqual([{ backfill: 'kept', agent: 'd4d5d6d7', code: 'none', attempt: 1 }])
  })

  it('stops at the directory’s limit and asks nothing more this launch', async () => {
    const d = directory({ fail: input => (input.action === 'check' ? 'limit' : undefined) })
    const w = walk(d.bridge, [alfred, council])

    expect(await w.run()).toEqual({ retry: false })
    expect(w.ledger.stopped).toBe(true)
    expect(d.forAgent(council.assistantId)).toEqual([])
    expect(d.changes()).toEqual([])
    expect(w.lines).toEqual([{ backfill: 'limit', agent: 'a1f2e3d4', code: 'limit', attempt: 1 }])

    const before = d.requests.length
    await w.run()
    expect(d.requests).toHaveLength(before)
  })

  it('retries a failure once per launch, never more', async () => {
    const d = directory({
      fail: input => ('assistantId' in input && input.assistantId === alfred.assistantId ? 'unavailable' : undefined)
    })

    const w = walk(d.bridge, [alfred, council])

    expect(await w.run()).toEqual({ retry: true })
    expect(d.held.get(council.assistantId)).toBe('hoi_dong_bot')
    expect(await w.run()).toEqual({ retry: false })
    await w.run()
    await w.run()

    expect(d.forAgent(alfred.assistantId)).toHaveLength(2)
    expect(w.lines.filter(line => line.agent === 'a1f2e3d4')).toEqual([
      { backfill: 'failed', agent: 'a1f2e3d4', code: 'unavailable', attempt: 1 },
      { backfill: 'failed', agent: 'a1f2e3d4', code: 'unavailable', attempt: 2 }
    ])
  })

  it('takes a refusal another try cannot change as final for this launch', async () => {
    const d = directory({ fail: input => (input.action === 'current' ? 'closed' : undefined) })
    const w = walk(d.bridge, [alfred])

    expect(await w.run()).toEqual({ retry: false })
    await w.run()
    expect(d.forAgent(alfred.assistantId)).toHaveLength(1)
    expect(w.lines).toEqual([{ backfill: 'refused', agent: 'a1f2e3d4', code: 'closed', attempt: 1 }])
  })

  it('never touches the person’s own handle, not even a change of it still waiting', async () => {
    const journal: MatrixAliasChange = { action: 'rename', handle: 'minh', from: 'minh_old', requestId: 'r-1' }
    const d = directory({ journal })
    const w = walk(d.bridge, [alfred, council])

    // Each walk stops at the first assistant still open and sends nothing (no replay of the
    // person's rename); the launch's one retry looks again, and each assistant is looked at no
    // more than twice.
    expect(await w.run()).toEqual({ retry: true })
    expect(await w.run()).toEqual({ retry: false })

    for (let more = 0; more < 4; more++) {
      await w.run()
    }

    expect(d.requests).toEqual([])
    expect(w.lines).toEqual([
      { backfill: 'held', agent: 'a1f2e3d4', code: 'none', attempt: 1 },
      { backfill: 'held', agent: 'a1f2e3d4', code: 'none', attempt: 2 },
      { backfill: 'held', agent: 'c0c1c2c3', code: 'none', attempt: 1 },
      { backfill: 'held', agent: 'c0c1c2c3', code: 'none', attempt: 2 }
    ])

    // With nothing waiting, still never a request for the person (one without an assistant).
    const clear = directory()
    await walk(clear.bridge, [alfred, council]).run()
    expect(clear.requests.every(each => 'assistantId' in each && each.assistantId)).toBe(true)
  })

  it('leaves an assistant the create sheet is claiming to the sheet', async () => {
    const sheet = { ...alfred, assistantId: '00000000-0000-4000-8000-d64af5d6b17c' }
    noteMatrixAgentHandleSheetClaim(sheet.assistantId)
    const d = directory()

    await walk(d.bridge, [sheet]).run()
    expect(d.requests).toEqual([])
  })

  it('takes the assistant back once the sheet has had its chance, so a failed sheet claim still ends with a handle', async () => {
    const sheet = { ...alfred, assistantId: '00000000-0000-4000-8000-7ea2247757c7' }
    noteMatrixAgentHandleSheetClaim(sheet.assistantId, Date.now() - MATRIX_HANDLE_SHEET_CLAIM_MS)
    const d = directory()

    await walk(d.bridge, [sheet]).run()
    expect(d.held.get(sheet.assistantId)).toBe('alfred_bot')
  })

  it('stops on a directory outage without spending anyone’s attempts, and asks for the retry', async () => {
    const d = directory()
    d.bridge.pending = vi.fn(async () => ({ ok: false as const, error: 'unavailable' as MatrixAliasErrorCode }))
    const w = walk(d.bridge, [alfred, council, analyst])

    const result = await w.run()
    expect(result.retry).toBe(true)
    expect(d.bridge.pending).toHaveBeenCalledTimes(1)
    expect(w.ledger.attempts.size).toBe(0)
    expect(w.lines).toEqual([{ backfill: 'failed', agent: 'a1f2e3d4', code: 'unavailable', attempt: 1 }])
  })

  it('writes no handle, name or directory ID into its lines', async () => {
    const d = directory()
    const w = walk(d.bridge, [alfred, council])

    await w.run()
    const text = JSON.stringify(w.lines)
    expect(text).not.toMatch(/_bot|alfred|hoi_dong|Hội|a1000000|c2000000/i)
  })
})

describe('when the walk runs', () => {
  const agentView = (agent: typeof alfred) =>
    ({ ...agent, isDefault: false, ready: true }) as unknown as MatrixAgentView

  const snapshotFor = (owner: string, agents: (typeof alfred)[]): MatrixSnapshot =>
    ({
      state: 'ready',
      identity: { userId: owner, deviceId: 'ONE' },
      domainEnabled: true,
      agentRoster: { state: 'ready', since: 0 },
      agents: agents.map(agentView),
      rooms: [],
      roomId: null,
      messages: [],
      error: null
    }) as MatrixSnapshot

  it('starts a little after launch, and again once an assistant is made or hired, through main’s log line', async () => {
    vi.useFakeTimers()
    const d = directory()
    window.atumMatrix = { aliases: d.bridge } as unknown as MatrixUiBridge
    const owner = '@owner-launch:atum.test'

    const view = renderHook(({ snapshot }) => useMatrixAgentHandleBackfill(snapshot), {
      initialProps: { snapshot: snapshotFor(owner, [alfred]) }
    })

    await act(async () => vi.advanceTimersByTime(MATRIX_HANDLE_BACKFILL_START_MS - 1))
    expect(d.requests).toEqual([])
    await act(async () => vi.advanceTimersByTime(1))
    await act(async () => {})
    expect(d.held.get(alfred.assistantId)).toBe('alfred_bot')
    expect(d.diagnostic).toHaveBeenCalledWith({ backfill: 'claimed', agent: 'a1f2e3d4', code: 'none', attempt: 1 })

    // A new assistant on the roster: its turn comes after the create sheet's own window.
    view.rerender({ snapshot: snapshotFor(owner, [alfred, council]) })
    await act(async () => vi.advanceTimersByTime(MATRIX_HANDLE_BACKFILL_ROSTER_MS))
    await act(async () => {})
    expect(d.held.get(council.assistantId)).toBe('hoi_dong_bot')
    expect(d.changes()).toHaveLength(2)
  })

  it('leaves the primary assistant’s handle to the person', async () => {
    vi.useFakeTimers()
    const d = directory()
    window.atumMatrix = { aliases: d.bridge } as unknown as MatrixUiBridge
    const owner = '@owner-primary:atum.test'
    const snapshot = snapshotFor(owner, [alfred, council])
    const primary = { ...snapshot, agents: snapshot.agents!.map((each, index) => ({ ...each, isDefault: index === 0 })) }

    renderHook(() => useMatrixAgentHandleBackfill(primary))
    await act(async () => vi.advanceTimersByTime(MATRIX_HANDLE_BACKFILL_START_MS))
    await act(async () => {})
    await act(async () => vi.advanceTimersByTime(MATRIX_HANDLE_BACKFILL_GAP_MS * 4))
    await act(async () => {})

    expect(d.held.has(alfred.assistantId)).toBe(false)
    expect(d.held.get(council.assistantId)).toBe('hoi_dong_bot')
  })

  it('waits for a ready account, its directory and its roster', async () => {
    vi.useFakeTimers()
    const d = directory()
    window.atumMatrix = { aliases: d.bridge } as unknown as MatrixUiBridge
    const owner = '@owner-waiting:atum.test'

    renderHook(() =>
      useMatrixAgentHandleBackfill({ ...snapshotFor(owner, [alfred]), agentRoster: { state: 'loading', since: 0 } })
    )
    await act(async () => vi.advanceTimersByTime(MATRIX_HANDLE_BACKFILL_START_MS * 10))
    expect(d.requests).toEqual([])
  })
})
