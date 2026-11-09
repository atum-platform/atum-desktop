import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyBridge, MatrixCompanyRequest } from '../../../shared/matrix-company'
import type { CompanyEmailMailStatus } from '../../../shared/matrix-company-team-space'

import { MAIL_STATUS_MAX_READS, MAIL_STATUS_POLL_MS, useEmailMailStatus } from './email-mail-status'

const companyId = '00000000-0000-4000-8000-72805976e3a7'
const invitationId = '00000000-0000-4000-8000-662b4919353f'

function bridge(statuses: Array<CompanyEmailMailStatus | 'error'>) {
  let index = 0

  const request = vi.fn(async (input: MatrixCompanyRequest) => {
    const next = statuses[Math.min(index++, statuses.length - 1)]!

    if (next === 'error') {
      return { ok: false as const, error: 'unavailable' as const }
    }

    return { ok: true as const, value: { schemaVersion: 10, invitationId: (input as { invitationId: string }).invitationId, mailStatus: next,
      sentAt: next === 'sent' ? 1 : null, failure: next === 'failed' ? 'rejected' : null } }
  })

  return { bridge: { request } as unknown as MatrixCompanyBridge, request }
}

const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0)
})

afterEach(() => vi.useRealTimers())

describe('the mail state of an email invitation', () => {
  it('reads at once, again while queued, and stops once sent', async () => {
    vi.useFakeTimers()
    const { bridge: source, request } = bridge(['queued', 'queued', 'sent'])
    const { result } = renderHook(() => useEmailMailStatus(source, companyId, [invitationId], true))

    await settle()
    expect(result.current.get(invitationId)).toBe('queued')
    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS * 2) })
    expect(result.current.get(invitationId)).toBe('sent')

    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS * 5) })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('keeps what it knew through a failed read, and gives up after a bounded number of reads', async () => {
    vi.useFakeTimers()
    const { bridge: source, request } = bridge(['queued', 'error', 'queued'])
    const { result } = renderHook(() => useEmailMailStatus(source, companyId, [invitationId], true))

    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS) })
    expect(result.current.get(invitationId)).toBe('queued')

    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS * (MAIL_STATUS_MAX_READS + 5)) })
    expect(request).toHaveBeenCalledTimes(MAIL_STATUS_MAX_READS)
    expect(result.current.get(invitationId)).toBe('queued')
  })

  it('asks nothing where the server cannot tell the mail state', async () => {
    vi.useFakeTimers()
    const { bridge: source, request } = bridge(['sent'])

    renderHook(() => useEmailMailStatus(source, companyId, [invitationId], false))
    await settle()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('one poller per invitation', () => {
  const A = '00000000-0000-4000-8000-d3b75709602f'
  const B = '00000000-0000-4000-8000-bb8f12832e3a'
  const queued = (invitation: string) => ({ ok: true as const, value: { schemaVersion: 10, invitationId: invitation, mailStatus: 'queued',
    sentAt: null, failure: null } })

  /** A bridge whose answers the test releases one by one, per invitation. */
  function held() {
    const waiting: Array<{ invitationId: string; release(value: unknown): void }> = []
    const request = vi.fn((input: MatrixCompanyRequest) => new Promise(release => {
      waiting.push({ invitationId: (input as { invitationId: string }).invitationId, release })
    }))

    const answer = async (invitationId: string, value: unknown = queued(invitationId)) => {
      const index = waiting.findIndex(item => item.invitationId === invitationId)
      waiting.splice(index, 1)[0]!.release(value)
      await settle()
    }

    const readsOf = (invitationId: string) =>
      request.mock.calls.filter(([input]) => (input as { invitationId: string }).invitationId === invitationId).length

    return { bridge: { request } as unknown as MatrixCompanyBridge, answer, readsOf, waiting }
  }

  it('inviting B one second after A neither reads A early nor restarts it', async () => {
    vi.useFakeTimers()
    const source = held()
    const { rerender } = renderHook(({ ids }) => useEmailMailStatus(source.bridge, companyId, ids, true), { initialProps: { ids: [A] } })

    await settle()
    await source.answer(A)
    expect(source.readsOf(A)).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    rerender({ ids: [B, A] })
    await settle()

    // B is read at once; A keeps its own clock.
    expect(source.readsOf(B)).toBe(1)
    expect(source.readsOf(A)).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS - 1_000 - 1) })
    expect(source.readsOf(A)).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(source.readsOf(A)).toBe(2)
  })

  it('never overlaps a read still in flight when another invitation arrives', async () => {
    vi.useFakeTimers()
    const source = held()
    const { rerender, result } = renderHook(({ ids }) => useEmailMailStatus(source.bridge, companyId, ids, true), { initialProps: { ids: [A] } })

    await settle()
    expect(source.readsOf(A)).toBe(1)
    rerender({ ids: [B, A] })
    await settle()
    // A's first answer has not come back: it is not asked again, and its late answer still counts.
    expect(source.readsOf(A)).toBe(1)
    await source.answer(A, { ok: true, value: { schemaVersion: 10, invitationId: A, mailStatus: 'sent', sentAt: 1, failure: null } })
    expect(result.current.get(A)).toBe('sent')
    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS * 3) })
    expect(source.readsOf(A)).toBe(1)
  })

  it('drops an answer still in flight after unmount, and reads nothing more', async () => {
    vi.useFakeTimers()
    const source = held()
    const { result, unmount } = renderHook(() => useEmailMailStatus(source.bridge, companyId, [A], true))

    await settle()
    const before = result.current
    unmount()
    await source.answer(A)
    expect(result.current).toBe(before)
    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS * 3) })
    expect(source.readsOf(A)).toBe(1)
  })

  it('stops and forgets everything when the switch goes off, and late answers are dropped', async () => {
    vi.useFakeTimers()
    const source = held()
    const { rerender, result } = renderHook(({ on }) => useEmailMailStatus(source.bridge, companyId, [A], on), { initialProps: { on: true } })

    await settle()
    await source.answer(A)
    expect(result.current.get(A)).toBe('queued')
    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS) })
    expect(source.readsOf(A)).toBe(2)

    rerender({ on: false })
    await source.answer(A, { ok: true, value: { schemaVersion: 10, invitationId: A, mailStatus: 'sent', sentAt: 1, failure: null } })
    expect(result.current.size).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(MAIL_STATUS_POLL_MS * 3) })
    expect(source.readsOf(A)).toBe(2)
  })
})
