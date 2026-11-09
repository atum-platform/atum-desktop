import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyBridge, MatrixCompanyRequest } from '../../../shared/matrix-company'

import { addModeOf } from './invite-sheet'
import { useMemberAddReadiness } from './member-add-readiness'

const ACME = '00000000-0000-4000-8000-72805976e3a7'
const BETA = '00000000-0000-4000-8000-4ddf7748f9cd'

const value = (companyId: string, directAdd: 'allowed' | 'invite_only' | 'not_allowed') => ({ schemaVersion: 12, companyId, directAdd,
  policy: 'members', assignableRoles: directAdd === 'not_allowed' ? [] : ['member'], rosterRemaining: 50 })

/** A bridge whose readiness answers the test releases. */
function held() {
  const waiting: Array<{ companyId: string; release(value: unknown): void }> = []

  const request = vi.fn((input: MatrixCompanyRequest) => new Promise(release => {
    waiting.push({ companyId: (input as { companyId: string }).companyId, release })
  }))

  const answer = async (companyId: string, directAdd: 'allowed' | 'invite_only' | 'not_allowed') => {
    const index = waiting.findIndex(item => item.companyId === companyId)
    await act(async () => {
      waiting.splice(index, 1)[0]!.release({ ok: true, value: value(companyId, directAdd) })
    })
  }

  return { bridge: { request } as unknown as MatrixCompanyBridge, request, answer, waiting }
}

describe('the readiness an open sheet acts on', () => {
  it.each(['allowed', 'invite_only', 'not_allowed'] as const)(
    'when direct add switches on under an open sheet, it is checking in that same render, then %s',
    async directAdd => {
      const source = held()
      const { rerender, result } = renderHook(({ on }) => useMemberAddReadiness(source.bridge, ACME, on), { initialProps: { on: false } })

      expect(addModeOf(result.current.readiness)).toBe('legacy')
      rerender({ on: true })
      // No render in which the old one-press invite is still what Add means.
      expect(result.current.readiness).toEqual({ state: 'checking' })
      expect(addModeOf(result.current.readiness)).toBe('checking')

      await source.answer(ACME, directAdd)
      expect(addModeOf(result.current.readiness)).toBe(directAdd === 'allowed' ? 'add' : directAdd === 'invite_only' ? 'invite' : 'none')
    }
  )

  it('switching off is legacy in that same render, and a late answer cannot bring direct add back', async () => {
    const source = held()
    const { rerender, result } = renderHook(({ on }) => useMemberAddReadiness(source.bridge, ACME, on), { initialProps: { on: true } })

    rerender({ on: false })
    expect(result.current.readiness).toEqual({ state: 'off' })
    await source.answer(ACME, 'allowed')
    expect(result.current.readiness).toEqual({ state: 'off' })
  })

  it('another company starts at checking, and the first company’s late answer is dropped', async () => {
    const source = held()

    const { rerender, result } = renderHook(({ company }) => useMemberAddReadiness(source.bridge, company, true), {
      initialProps: { company: ACME } })

    rerender({ company: BETA })
    expect(result.current.readiness).toEqual({ state: 'checking' })
    // ACME's answer lands after the switch: it is not BETA's.
    await source.answer(ACME, 'allowed')
    expect(result.current.readiness).toEqual({ state: 'checking' })
    await source.answer(BETA, 'invite_only')
    expect(addModeOf(result.current.readiness)).toBe('invite')
  })

  it('a reload that holds returns to checking until the new answer', async () => {
    const source = held()
    const { result } = renderHook(() => useMemberAddReadiness(source.bridge, ACME, true))

    await source.answer(ACME, 'allowed')
    act(() => result.current.reload({ hold: true }))
    expect(result.current.readiness).toEqual({ state: 'checking' })
    await source.answer(ACME, 'invite_only')
    expect(addModeOf(result.current.readiness)).toBe('invite')
  })
})
