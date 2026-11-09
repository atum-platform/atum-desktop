import { describe, expect, it, vi } from 'vitest'

import type {
  MatrixAliasBridge,
  MatrixAliasChange,
  MatrixAliasErrorCode,
  MatrixAliasRequest,
  MatrixAliasResult
} from '../../shared/matrix-aliases'

import { claimMatrixAgentHandle, matrixAgentHandleRetryable } from './agent-handle-claim'
import { matrixAgentHandleCandidates } from './handle-rules'

const assistantId = '00000000-0000-4000-8000-95eb2692c90e'
const otherAssistant = '00000000-0000-4000-8000-951c747b3afc'

/**
 * A directory behind main's alias journal, as main keeps it: one change at a time; a different
 * change is refused locally as `conflict` while one is kept; a definite answer clears it and a
 * lost one (`lose`) keeps it. The platform replays a request ID it has already answered.
 * `taken` handles belong to others, `reserved` ones are refused by the naming policy, `existing`
 * is the assistant's own.
 */
function directory({
  taken = [],
  raceLost = [],
  reserved = () => false,
  existing = null,
  failOn,
  lose = 0,
  lands = false,
  journal = null
}: {
  taken?: string[]
  raceLost?: string[]
  reserved?: (handle: string) => boolean
  existing?: string | null
  failOn?: { action: MatrixAliasRequest['action']; error: MatrixAliasErrorCode }
  /** How many sent changes lose their answer (a timeout, a dropped connection). */
  lose?: number
  /** Whether a change whose answer is lost still took effect on the platform. */
  lands?: boolean
  journal?: MatrixAliasChange | null
} = {}) {
  const held = new Map(taken.map(handle => [handle, 'someone']))
  const answered = new Map<string, string>()
  let kept = journal
  let lost = lose
  let own = existing

  if (own) {
    held.set(own, assistantId)
  }

  const same = (a: MatrixAliasChange | null, b: MatrixAliasChange) => JSON.stringify(a) === JSON.stringify(b)

  const change = (input: MatrixAliasChange): MatrixAliasResult => {
    if (kept && !same(kept, input)) {
      return { ok: false, error: 'conflict' }
    }

    kept = input
    const target = input.assistantId ?? 'person'
    const replay = answered.get(input.requestId)

    if (replay) {
      kept = null

      return { ok: true, value: { kind: 'claim', handle: replay, generation: 1, replayed: true } }
    }

    const refused = held.has(input.handle) || raceLost.includes(input.handle) || (target === assistantId && own)

    if (lost > 0) {
      lost -= 1

      if (lands && !refused) {
        held.set(input.handle, target)
        answered.set(input.requestId, input.handle)
        own = target === assistantId ? input.handle : own
      }

      return { ok: false, error: 'unavailable' }
    }

    kept = null

    if (refused) {
      return { ok: false, error: 'conflict' }
    }

    held.set(input.handle, target)
    answered.set(input.requestId, input.handle)
    own = target === assistantId ? input.handle : own

    return { ok: true, value: { kind: 'claim', handle: input.handle, generation: 1 } }
  }

  const request = vi.fn(async (input: MatrixAliasRequest): Promise<MatrixAliasResult> => {
    if (failOn?.action === input.action) {
      return { ok: false, error: failOn.error }
    }

    if (input.action === 'current') {
      return { ok: true, value: { kind: 'current', alias: own ? { handle: own, generation: 1 } : null } }
    }

    if (input.action === 'check') {
      const refusal = reserved(input.handle) ? 'alias_reserved' : held.has(input.handle) ? 'alias_unavailable' : null

      return { ok: true, value: { kind: 'check', handle: input.handle, available: refusal === null, code: refusal } }
    }

    if (input.action === 'claim' || input.action === 'rename') {
      return change(input)
    }

    return { ok: false, error: 'invalid' }
  })

  const pending = vi.fn(async () => ({ ok: true as const, request: kept }))
  const bridge: MatrixAliasBridge = { pending, request }

  const claims = () =>
    request.mock.calls.flatMap(([input]) => (input.action === 'claim' ? [input] : []))

  return { bridge, request, claims, own: () => own, kept: () => kept }
}

describe('giving a new assistant its handle', () => {
  it('claims the handle from its name when it is free', async () => {
    const { bridge, own } = directory()

    expect(await claimMatrixAgentHandle(bridge, assistantId, [['tiep_thi_bot', 'tiep_thi42_bot']])).toEqual({
      ok: true,
      handle: 'tiep_thi_bot'
    })
    expect(own()).toBe('tiep_thi_bot')
  })

  it('moves to the numbered handle when the plain one is taken, or is taken between check and claim', async () => {
    const taken = directory({ taken: ['tiep_thi_bot'] })
    expect(await claimMatrixAgentHandle(taken.bridge, assistantId, [['tiep_thi_bot', 'tiep_thi42_bot']])).toEqual({
      ok: true,
      handle: 'tiep_thi42_bot'
    })

    const raced = directory({ raceLost: ['tiep_thi_bot'] })
    expect(await claimMatrixAgentHandle(raced.bridge, assistantId, [['tiep_thi_bot', 'tiep_thi42_bot']])).toEqual({
      ok: true,
      handle: 'tiep_thi42_bot'
    })
  })

  it('keeps a handle the assistant already has and never claims a second one', async () => {
    const { bridge, claims } = directory({ existing: 'tiep_thi_bot' })

    expect(await claimMatrixAgentHandle(bridge, assistantId, [['tiep_thi_bot', 'tiep_thi42_bot']])).toEqual({
      ok: true,
      handle: 'tiep_thi_bot',
      existing: true
    })
    expect(claims()).toEqual([])
  })

  it('leaves a reserved name for the fallback rather than trying its numbers, which are reserved too', async () => {
    const groups = matrixAgentHandleCandidates('Hà Nội', () => 0.5)
    const { bridge, request, own } = directory({ reserved: handle => handle.startsWith('ha_noi') })

    const outcome = await claimMatrixAgentHandle(bridge, assistantId, groups)

    expect(outcome).toEqual({ ok: true, handle: groups[1][0] })
    expect(own()).toBe(groups[1][0])

    const checked = request.mock.calls.flatMap(([input]) => (input.action === 'check' ? [input.handle] : []))
    expect(checked.filter(handle => handle.startsWith('ha_noi'))).toEqual([groups[0][0]])
  })

  it('finishes without a Retry when every handle is reserved, as for a name with no letters to use', async () => {
    const { bridge, claims } = directory({ reserved: () => true })

    const outcome = await claimMatrixAgentHandle(bridge, assistantId, matrixAgentHandleCandidates('小助手'))

    expect(outcome).toEqual({ ok: false, reason: 'exhausted' })
    expect(matrixAgentHandleRetryable(outcome)).toBe(false)
    expect(claims()).toEqual([])
  })

  it('resends a claim whose answer was lost, as it was, instead of walking past it', async () => {
    for (const lands of [false, true]) {
      const directoryState = directory({ lose: 1, lands })
      const groups = [['tiep_thi_bot', 'tiep_thi42_bot']]

      const first = await claimMatrixAgentHandle(directoryState.bridge, assistantId, groups)
      expect(first).toEqual({ ok: false, reason: 'unavailable' })
      expect(matrixAgentHandleRetryable(first)).toBe(true)
      expect(directoryState.kept()).not.toBeNull()

      expect(await claimMatrixAgentHandle(directoryState.bridge, assistantId, groups)).toEqual({
        ok: true,
        handle: 'tiep_thi_bot'
      })
      expect(directoryState.kept()).toBeNull()

      const [sent, resent, ...rest] = directoryState.claims()
      expect(resent).toEqual(sent)
      expect(rest).toEqual([])
    }
  })

  it('answers a change kept for another assistant first, then gives this one its handle', async () => {
    const earlier: MatrixAliasChange = {
      action: 'claim',
      handle: 'ban_hang_bot',
      assistantId: otherAssistant,
      requestId: '00000000-0000-4000-8000-325c97b86b50'
    }

    const cleared = directory({ journal: earlier })
    expect(await claimMatrixAgentHandle(cleared.bridge, assistantId, [['tiep_thi_bot']])).toEqual({
      ok: true,
      handle: 'tiep_thi_bot'
    })
    expect(cleared.claims().map(claim => claim.assistantId)).toEqual([otherAssistant, assistantId])

    const stuck = directory({ journal: earlier, lose: 1 })
    const outcome = await claimMatrixAgentHandle(stuck.bridge, assistantId, [['tiep_thi_bot']])
    expect(outcome).toEqual({ ok: false, reason: 'unavailable' })
    expect(matrixAgentHandleRetryable(outcome)).toBe(true)
    expect(stuck.claims().map(claim => claim.assistantId)).toEqual([otherAssistant])
  })

  it('says every candidate was taken, and stops at a refusal it cannot step around', async () => {
    const full = directory({ taken: ['a_bot', 'a12_bot'] })
    const exhausted = await claimMatrixAgentHandle(full.bridge, assistantId, [['a_bot', 'a12_bot']])
    expect(exhausted).toEqual({ ok: false, reason: 'exhausted' })
    expect(matrixAgentHandleRetryable(exhausted)).toBe(false)

    const closed = directory({ failOn: { action: 'check', error: 'closed' } })
    const shut = await claimMatrixAgentHandle(closed.bridge, assistantId, [['a_bot', 'a12_bot']])
    expect(shut).toEqual({ ok: false, reason: 'closed' })
    expect(matrixAgentHandleRetryable(shut)).toBe(false)
    expect(closed.request).toHaveBeenCalledTimes(2)

    const limited = directory({ failOn: { action: 'claim', error: 'limit' } })
    const waiting = await claimMatrixAgentHandle(limited.bridge, assistantId, [['a_bot', 'a12_bot']])
    expect(waiting).toEqual({ ok: false, reason: 'limit' })
    expect(matrixAgentHandleRetryable(waiting)).toBe(true)
  })

  it('names only the assistant it was given in every request of its own', async () => {
    const { bridge, request } = directory({ taken: ['a_bot'] })
    await claimMatrixAgentHandle(bridge, assistantId, [['a_bot', 'a12_bot']])

    for (const [input] of request.mock.calls) {
      expect(input).toMatchObject({ assistantId })
    }
  })
})
