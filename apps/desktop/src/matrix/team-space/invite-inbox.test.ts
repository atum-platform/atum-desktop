import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyBridge, MatrixCompanyResult } from '../../../shared/matrix-company'

import {
  $companyInviteInbox,
  COMPANY_INVITE_INBOX_BACKOFF_BASE_MS,
  COMPANY_INVITE_INBOX_BACKOFF_CAP_MS,
  COMPANY_INVITE_INBOX_INTERVAL_MS,
  dismissCompanyInvitation,
  invalidateCompanyInviteInbox,
  issueCompanyInviteInboxTicket,
  loadCompanyInviteInbox,
  pendingCompanyInvitations,
  publishCompanyInviteInbox,
  resetCompanyInviteInbox,
  setCompanyInviteInboxAccount,
  startCompanyInviteInboxPolling
} from './invite-inbox'

const A = '@a:example.invalid:DEVICEA'
const B = '@b:example.invalid:DEVICEB'

const invitation = (id: string) => ({ id, companyId: '00000000-0000-4000-8000-0535bd89d837', displayName: 'Other Co', role: 'member' as const,
  inviter: { handle: 'minh', displayName: 'Minh' } })

const directory = (...ids: string[]) => ({ schemaVersion: 2 as const, canCreate: false, companies: [], invitations: ids.map(invitation) })

function bridge(answer: () => Promise<MatrixCompanyResult>): MatrixCompanyBridge {
  return { pending: async () => ({ ok: true, request: null }), request: vi.fn(answer) } as unknown as MatrixCompanyBridge
}

/** A read issued now: newer than anything shown so far. */
const fresh = () => issueCompanyInviteInboxTicket()

const ids = () => pendingCompanyInvitations($companyInviteInbox.get(), A).map(item => item.id)

/** A bridge whose answers the test releases one by one, in any order. */
function deferredBridge() {
  const releases: Array<(value: MatrixCompanyResult) => void> = []
  const source = bridge(() => new Promise<MatrixCompanyResult>(resolve => { releases.push(resolve) }))

  return { source, release: (index: number, value: MatrixCompanyResult) => releases[index]!(value), calls: () => releases.length }
}

afterEach(() => {
  resetCompanyInviteInbox()
  vi.useRealTimers()
})

describe('the invitee’s pending company invitations', () => {
  it('counts the invitations in the signed-in account’s own directory', async () => {
    setCompanyInviteInboxAccount(A)
    await loadCompanyInviteInbox(bridge(async () => ({ ok: true, value: directory('i1', 'i2') })), A)

    expect(pendingCompanyInvitations($companyInviteInbox.get(), A).map(item => item.id)).toEqual(['i1', 'i2'])
  })

  it('never shows one account’s invitations to another, and forgets them on sign-out', async () => {
    setCompanyInviteInboxAccount(A)
    publishCompanyInviteInbox(A, directory('i1'), fresh())

    expect(pendingCompanyInvitations($companyInviteInbox.get(), B)).toEqual([])

    setCompanyInviteInboxAccount(B)
    expect($companyInviteInbox.get()).toBeUndefined()
    // A late publish for A (its workspace, its read) is not for this window any more.
    publishCompanyInviteInbox(A, directory('i1'), fresh())
    expect($companyInviteInbox.get()).toBeUndefined()

    setCompanyInviteInboxAccount(undefined)
    expect(pendingCompanyInvitations($companyInviteInbox.get(), A)).toEqual([])
  })

  it('drops an answer that arrives after the account changed', async () => {
    setCompanyInviteInboxAccount(A)
    let release: (value: MatrixCompanyResult) => void = () => {}
    const pending = loadCompanyInviteInbox(bridge(() => new Promise(resolve => { release = resolve })), A)

    setCompanyInviteInboxAccount(B)
    release({ ok: true, value: directory('i1') })
    await pending

    expect($companyInviteInbox.get()).toBeUndefined()
  })

  it('keeps what was known through a failed read', async () => {
    setCompanyInviteInboxAccount(A)
    publishCompanyInviteInbox(A, directory('i1'), fresh())
    await loadCompanyInviteInbox(bridge(async () => ({ ok: false, error: 'unavailable' })), A)
    await loadCompanyInviteInbox(bridge(async () => { throw new Error('offline') }), A)

    expect(pendingCompanyInvitations($companyInviteInbox.get(), A)).toHaveLength(1)
  })

  it('hides one put off with “Not now” for this run only, until it ends', () => {
    setCompanyInviteInboxAccount(A)
    publishCompanyInviteInbox(A, directory('i1', 'i2'), fresh())
    dismissCompanyInvitation(A, 'i1')
    dismissCompanyInvitation(B, 'i2')

    expect(pendingCompanyInvitations($companyInviteInbox.get(), A).map(item => item.id)).toEqual(['i2'])

    // A later read still holds the dismissal; an invitation that ended takes its dismissal with it.
    publishCompanyInviteInbox(A, directory('i1', 'i2'), fresh())
    expect(pendingCompanyInvitations($companyInviteInbox.get(), A).map(item => item.id)).toEqual(['i2'])
    publishCompanyInviteInbox(A, directory('i2'), fresh())
    expect($companyInviteInbox.get()?.dismissed.size).toBe(0)
  })

  it('ignores an answer that is not the directory', () => {
    setCompanyInviteInboxAccount(A)
    publishCompanyInviteInbox(A, { schemaVersion: 1, company: { id: 'c', displayName: 'C', role: 'member' }, members: [], projects: [] } as never, fresh())

    expect($companyInviteInbox.get()).toBeUndefined()
  })
})

describe('the order answers arrive in', () => {
  it('never lets an older poll put back an invitation a newer workspace read no longer has', async () => {
    setCompanyInviteInboxAccount(A)
    const reads = deferredBridge()
    const poll = loadCompanyInviteInbox(reads.source, A)

    // The workspace reads after the invitation was accepted; its answer lands first.
    expect(publishCompanyInviteInbox(A, directory(), fresh())).toBe(true)
    reads.release(0, { ok: true, value: directory('i1') })
    await poll

    expect(ids()).toEqual([])
  })

  it('never lets an older workspace read hide an invitation a newer poll found', async () => {
    setCompanyInviteInboxAccount(A)
    const workspaceTicket = fresh()
    await loadCompanyInviteInbox(bridge(async () => ({ ok: true, value: directory('i2') })), A)

    expect(publishCompanyInviteInbox(A, directory(), workspaceTicket)).toBe(false)
    expect(ids()).toEqual(['i2'])
  })

  it('keeps a dismissal when an older answer without the invitation arrives late', () => {
    setCompanyInviteInboxAccount(A)
    const older = fresh()
    publishCompanyInviteInbox(A, directory('i1', 'i2'), fresh())
    dismissCompanyInvitation(A, 'i1')
    publishCompanyInviteInbox(A, directory('i2'), older)

    expect($companyInviteInbox.get()?.dismissed.has('i1')).toBe(true)
    expect(ids()).toEqual(['i2'])
  })

  it('drops a poll that was in flight when an invitation was answered', async () => {
    setCompanyInviteInboxAccount(A)
    publishCompanyInviteInbox(A, directory('i1'), fresh())
    const reads = deferredBridge()
    const poll = loadCompanyInviteInbox(reads.source, A)

    // Accepting i1 landed; the workspace's own read has not answered yet.
    invalidateCompanyInviteInbox(A)
    reads.release(0, { ok: true, value: directory('i1', 'i3') })
    await poll

    expect(ids()).toEqual(['i1'])
    // The next read is issued after the change and applies.
    await loadCompanyInviteInbox(bridge(async () => ({ ok: true, value: directory('i3') })), A)
    expect(ids()).toEqual(['i3'])
  })

  it('drops a poll from before an account switch, even after switching back', async () => {
    setCompanyInviteInboxAccount(A)
    const reads = deferredBridge()
    const poll = loadCompanyInviteInbox(reads.source, A)

    setCompanyInviteInboxAccount(B)
    setCompanyInviteInboxAccount(A)
    reads.release(0, { ok: true, value: directory('i1') })
    await poll

    expect($companyInviteInbox.get()).toBeUndefined()
  })
})

describe('how often the inbox is read', () => {
  const failing = () => bridge(async () => ({ ok: false, error: 'unavailable' }))

  it('keeps one read in flight: sign-in, focus and the timer share it', async () => {
    setCompanyInviteInboxAccount(A)
    const reads = deferredBridge()
    const polling = startCompanyInviteInboxPolling(reads.source, A)
    const direct = loadCompanyInviteInbox(reads.source, A)
    polling.nudge()
    polling.nudge()

    expect(reads.calls()).toBe(1)
    reads.release(0, { ok: true, value: directory('i1') })
    await direct
    expect(ids()).toEqual(['i1'])
    polling.stop()
  })

  it('reads every five minutes while healthy, and on focus straight away', async () => {
    vi.useFakeTimers()
    setCompanyInviteInboxAccount(A)
    const source = bridge(async () => ({ ok: true, value: directory() }))
    const polling = startCompanyInviteInboxPolling(source, A)
    await vi.advanceTimersByTimeAsync(0)
    expect(source.request).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(COMPANY_INVITE_INBOX_INTERVAL_MS - 1)
    expect(source.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(source.request).toHaveBeenCalledTimes(2)

    polling.nudge()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.request).toHaveBeenCalledTimes(3)
    polling.stop()
  })

  it('backs off after failures (doubling, capped), skips focus during the wait, and resets on success', async () => {
    vi.useFakeTimers()
    setCompanyInviteInboxAccount(A)
    let healthy = false
    const source = bridge(async () => healthy ? { ok: true, value: directory() } : { ok: false, error: 'unavailable' })
    const polling = startCompanyInviteInboxPolling(source, A)
    await vi.advanceTimersByTimeAsync(0)
    expect(source.request).toHaveBeenCalledTimes(1)

    // Focus during the first wait asks nothing.
    polling.nudge()
    await vi.advanceTimersByTimeAsync(COMPANY_INVITE_INBOX_BACKOFF_BASE_MS - 1)
    expect(source.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(source.request).toHaveBeenCalledTimes(2)

    // The second wait is twice as long.
    await vi.advanceTimersByTimeAsync(2 * COMPANY_INVITE_INBOX_BACKOFF_BASE_MS - 1)
    expect(source.request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(source.request).toHaveBeenCalledTimes(3)

    // Many failures later the wait stops growing at the cap.
    for (let index = 0; index < 8; index += 1) {
      await vi.advanceTimersByTimeAsync(COMPANY_INVITE_INBOX_BACKOFF_CAP_MS)
    }
    const before = vi.mocked(source.request).mock.calls.length
    await vi.advanceTimersByTimeAsync(COMPANY_INVITE_INBOX_BACKOFF_CAP_MS)
    expect(source.request).toHaveBeenCalledTimes(before + 1)

    // A success clears the wait: focus reads again at once, and the healthy cadence returns.
    healthy = true
    await vi.advanceTimersByTimeAsync(COMPANY_INVITE_INBOX_BACKOFF_CAP_MS)
    const recovered = vi.mocked(source.request).mock.calls.length
    polling.nudge()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.request).toHaveBeenCalledTimes(recovered + 1)
    await vi.advanceTimersByTimeAsync(COMPANY_INVITE_INBOX_INTERVAL_MS)
    expect(source.request).toHaveBeenCalledTimes(recovered + 2)
    polling.stop()
  })

  it('waits at least as long as the server’s Retry-After', async () => {
    vi.useFakeTimers()
    setCompanyInviteInboxAccount(A)
    const source = bridge(async () => ({ ok: false, error: 'limit', retryAfterSeconds: 600 }))
    const polling = startCompanyInviteInboxPolling(source, A)
    await vi.advanceTimersByTimeAsync(600_000 - 1)
    expect(source.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(source.request).toHaveBeenCalledTimes(2)
    polling.stop()
  })

  it('starts a new account with no wait left over from the one before', async () => {
    vi.useFakeTimers()
    setCompanyInviteInboxAccount(A)
    await loadCompanyInviteInbox(failing(), A)
    const retry = bridge(async () => ({ ok: true, value: directory('i1') }))
    await loadCompanyInviteInbox(retry, A)
    expect(retry.request).not.toHaveBeenCalled()

    setCompanyInviteInboxAccount(B)
    setCompanyInviteInboxAccount(A)
    await loadCompanyInviteInbox(retry, A)
    expect(retry.request).toHaveBeenCalledTimes(1)
    expect(ids()).toEqual(['i1'])
  })

  it('stops reading once stopped', async () => {
    vi.useFakeTimers()
    setCompanyInviteInboxAccount(A)
    const source = bridge(async () => ({ ok: true, value: directory() }))
    const polling = startCompanyInviteInboxPolling(source, A)
    await vi.advanceTimersByTimeAsync(0)
    polling.stop()
    await vi.advanceTimersByTimeAsync(3 * COMPANY_INVITE_INBOX_INTERVAL_MS)
    expect(source.request).toHaveBeenCalledTimes(1)
  })
})
