import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixUiBridge } from '../../shared/matrix'
import {
  type MatrixGoogleWriteActionAnswer,
  type MatrixGoogleWriteActionInput,
  type MatrixGoogleWriteDraft,
  type MatrixGoogleWriteListAnswer,
  parseMatrixGoogleWriteProposalList
} from '../../shared/matrix-google-write-proposal'
import {
  GOOGLE_WRITE_IDS,
  GOOGLE_WRITE_OTHER_ROOM,
  GOOGLE_WRITE_ROOM,
  googleWriteEmail,
  googleWriteEntry,
  googleWriteEvent
} from '../../shared/matrix-google-write-proposal.test-support'

import { MatrixGoogleWriteProposals, resetMatrixGoogleWriteAnswers } from './google-write-card'

const ZONE = 'Asia/Ho_Chi_Minh'
const STATUS = { delivered: 'delivered', approve: 'confirmed', decline: 'declined' } as const

beforeEach(() => {
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  resetMatrixGoogleWriteAnswers()
  vi.restoreAllMocks()
  delete (window as { atumMatrix?: unknown }).atumMatrix
})

/** The list as main hands it over: Shell's body, read by the same strict reader. */
function listed(...entries: unknown[]): MatrixGoogleWriteListAnswer {
  return { state: 'ok', proposals: parseMatrixGoogleWriteProposalList({ proposals: entries }) ?? [] }
}

function bridge(
  lists: MatrixGoogleWriteListAnswer[],
  answer: (input: MatrixGoogleWriteActionInput) => Promise<MatrixGoogleWriteActionAnswer> = async input => ({
    state: 'ok',
    status: STATUS[input.action]
  })
) {
  const queue = [...lists]
  const writeProposals = vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]!))
  const writeProposalAction = vi.fn(answer)

  window.atumMatrix = { googleConnections: { writeProposals, writeProposalAction } } as unknown as MatrixUiBridge

  const decisions = () => writeProposalAction.mock.calls.map(([input]) => input).filter(input => input.action !== 'delivered')
  const deliveries = () => writeProposalAction.mock.calls.map(([input]) => input).filter(input => input.action === 'delivered')

  return { writeProposals, writeProposalAction, decisions, deliveries }
}

function show({ locale = 'en', roomId = GOOGLE_WRITE_ROOM, activity = '$one' }: { locale?: Locale; roomId?: string; activity?: string } = {}) {
  const onWaiting = vi.fn()
  const wrap = (next: string): ReactNode => (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixGoogleWriteProposals activity={next} onWaiting={onWaiting} roomId={roomId} timeZone={ZONE} />
    </I18nProvider>
  )
  const view = render(wrap(activity))

  return { ...view, onWaiting, activity: (next: string) => view.rerender(wrap(next)) }
}

const card = (name = 'Send this email?') => screen.findByRole('region', { name })
const enabled = async (name = 'Approve') =>
  waitFor(() => expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false))

async function entry(draft: MatrixGoogleWriteDraft = googleWriteEmail(), change: Record<string, unknown> = {}) {
  return googleWriteEntry(draft, change)
}

describe('Google write cards', () => {
  it('shows the email draft as data, with Approve and Decline, in English', async () => {
    bridge([listed(await entry())])
    show()

    const region = await card()

    for (const text of ['contact@example.com', 'support@example.com', 'Quote for the spring order', 'To', 'Cc', 'Subject']) {
      expect(within(region).getByText(text)).toBeTruthy()
    }

    expect(within(region).getByText(/quote-spring\.pdf · 48(\.2)? kB/u)).toBeTruthy()
    // The body exactly, line breaks and all, as plain text.
    expect(region.querySelector('[data-matrix-google-write-text]')?.textContent).toBe(googleWriteEmail().body)
    await enabled()
    expect(screen.getByRole('button', { name: 'Decline' })).toHaveProperty('disabled', false)
  })

  it('shows a forward with its quote and a calendar event in the owner’s time zone', async () => {
    const forward = googleWriteEmail({
      subject: 'Fwd: Spring order',
      quote: 'From: hello@example.com\n\nSee below.',
      forwarded: { messageId: 'msg-a1', from: 'hello@example.com', date: 'Tue, 2 Mar 2027', subject: 'Spring order', quotePreview: 'See below.', quoteLength: 36 }
    })

    bridge([
      listed(
        await entry(forward),
        await entry(googleWriteEvent(), { proposalId: GOOGLE_WRITE_IDS.second, agent: GOOGLE_WRITE_IDS.otherAgent })
      )
    ])
    show()

    const email = await card()

    expect(within(email).getByText('Quoted message')).toBeTruthy()
    expect(within(email).getByText('hello@example.com · Spring order')).toBeTruthy()
    expect([...email.querySelectorAll('[data-matrix-google-write-text]')].map(node => node.textContent)).toEqual([forward.body, forward.quote])

    const event = await card('Add this event to your calendar?')

    expect(within(event).getByText('Supplier call')).toBeTruthy()
    expect(within(event).getByText('Room 2')).toBeTruthy()
    expect(within(event).getByText(/9:30\s?AM/u)).toBeTruthy()
    expect(within(event).getByText('Bring the price list.')).toBeTruthy()
  })

  it('speaks Vietnamese, and a decline settles to one calm line', async () => {
    const calls = bridge([listed(await entry())])
    show({ locale: 'vi' })

    expect(await card('Gửi email này?')).toBeTruthy()
    await enabled('Duyệt')
    fireEvent.click(screen.getByRole('button', { name: 'Từ chối' }))

    expect(await screen.findByText('Đã từ chối. Trợ lý sẽ không thực hiện việc này.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(calls.decisions()).toEqual([{ proposalId: GOOGLE_WRITE_IDS.first, digest: (await entry()).digest, action: 'decline' }])
  })

  it('lists with the bridge only, and shows only this chat’s proposals', async () => {
    const calls = bridge([listed(await entry(), await entry(googleWriteEvent(), { proposalId: GOOGLE_WRITE_IDS.second, room: GOOGLE_WRITE_OTHER_ROOM }))])
    show()

    await card()
    expect(calls.writeProposals).toHaveBeenCalledWith()
    expect(screen.queryByRole('region', { name: 'Add this event to your calendar?' })).toBeNull()
  })

  it('approves with the digest of the rendered draft and says it is approved, never sent', async () => {
    const calls = bridge([listed(await entry())])
    show()

    await enabled()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('Approved. Your assistant will carry it out.')).toBeTruthy()
    expect(screen.queryByText(/sent/iu)).toBeNull()
    expect(calls.decisions()).toEqual([{ proposalId: GOOGLE_WRITE_IDS.first, digest: (await entry()).digest, action: 'approve' }])
  })

  it('never sends a second decision once one was accepted, however the presses and refreshes go', async () => {
    let release: (answer: MatrixGoogleWriteActionAnswer) => void = () => {}
    const calls = bridge([listed(await entry())], input =>
      input.action === 'approve' ? new Promise(resolve => (release = resolve)) : Promise.resolve({ state: 'ok', status: STATUS[input.action] })
    )
    const view = show()

    await enabled()
    const approve = screen.getByRole('button', { name: 'Approve' })

    fireEvent.click(approve)
    fireEvent.click(approve)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(await screen.findByText('Approving…')).toBeTruthy()

    await act(async () => release({ state: 'ok', status: 'confirmed' }))
    expect(await screen.findByText('Approved. Your assistant will carry it out.')).toBeTruthy()

    // Still listed for a moment (or listed again): the answer stands and nothing more is sent.
    view.activity('$two')
    await waitFor(() => expect(calls.writeProposals.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(screen.getByText('Approved. Your assistant will carry it out.')).toBeTruthy()
    expect(calls.decisions()).toHaveLength(1)
  })

  it('shows a refusal as a closed card, never as approved', async () => {
    bridge([listed(await entry())], async input => (input.action === 'delivered' ? { state: 'ok', status: 'delivered' } : { state: 'refused' }))
    show()

    await enabled()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('This request is no longer waiting for you.')).toBeTruthy()
    expect(screen.queryByText(/Approved/u)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps the actions after Atum could not be reached, and a retry can still be accepted', async () => {
    let state: 'unavailable' | 'ok' = 'unavailable'
    const calls = bridge([listed(await entry())], async input =>
      input.action === 'delivered' ? { state: 'ok', status: 'delivered' } : state === 'ok' ? { state: 'ok', status: 'confirmed' } : { state: 'unavailable' }
    )
    show()

    await enabled()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Couldn’t reach Atum. Try again.')).toBeTruthy()
    expect(screen.queryByText(/Approved/u)).toBeNull()
    await enabled()

    state = 'ok'
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Approved. Your assistant will carry it out.')).toBeTruthy()
    expect(calls.decisions()).toHaveLength(2)
  })

  it('never offers Approve for a draft whose digest is not the proposal’s, and reports no delivery', async () => {
    const calls = bridge([listed(await entry(googleWriteEmail(), { digest: 'c'.repeat(64) }))])
    show()

    expect(await screen.findByText(/doesn’t match what your assistant proposed/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(calls.writeProposalAction).not.toHaveBeenCalled()
  })

  it('reports delivery once, only after the card was on screen in a focused window', async () => {
    const calls = bridge([listed(await entry())])
    const view = show()

    await card()
    expect(calls.deliveries()).toEqual([])
    await waitFor(() => expect(calls.deliveries()).toHaveLength(1), { timeout: 2_500 })
    expect(calls.deliveries()[0]).toEqual({ proposalId: GOOGLE_WRITE_IDS.first, digest: (await entry()).digest, action: 'delivered' })

    // Re-rendering, refreshing and remounting the same proposal never report it again.
    view.activity('$two')
    await waitFor(() => expect(calls.writeProposals.mock.calls.length).toBeGreaterThanOrEqual(2))
    view.unmount()
    show()
    await card()
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(calls.deliveries()).toHaveLength(1)
  })

  it('reports no delivery while the window is not focused', async () => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
    const calls = bridge([listed(await entry())])
    show()

    await card()
    await new Promise(resolve => setTimeout(resolve, 1_300))
    expect(calls.deliveries()).toEqual([])
  })

  it('reads the list again on this chat’s activity and settles an older card as superseded by the newer one', async () => {
    const newer = googleWriteEmail({ subject: 'Revised quote' })
    const calls = bridge([listed(await entry()), listed(await entry(newer, { proposalId: GOOGLE_WRITE_IDS.second }))])
    const view = show()

    await enabled()
    expect(calls.writeProposals).toHaveBeenCalledTimes(1)

    view.activity('$two')
    await waitFor(() => expect(calls.writeProposals).toHaveBeenCalledTimes(2))

    expect(await screen.findByText('A newer request replaced this one.')).toBeTruthy()
    const open = screen.getAllByRole('region', { name: 'Send this email?' })

    expect(open).toHaveLength(2)
    expect(within(open[0]!).getByText('Quote for the spring order')).toBeTruthy()
    expect(within(open[0]!).queryByRole('button')).toBeNull()
    expect(within(open[1]!).getByText('Revised quote')).toBeTruthy()
    expect(within(open[1]!).getByRole('button', { name: 'Approve' })).toBeTruthy()
  })

  it('reads the list again when the window regains focus, and a card that left the list closes', async () => {
    const calls = bridge([listed(await entry()), listed()])
    const view = show()

    await enabled()
    expect(view.onWaiting).toHaveBeenLastCalledWith(true)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(calls.writeProposals).toHaveBeenCalledTimes(2))

    expect(await screen.findByText('This request is no longer waiting for you.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(view.onWaiting).toHaveBeenLastCalledWith(false)
  })

  it('keeps what is shown when the list cannot be read', async () => {
    bridge([listed(await entry()), { state: 'unavailable' }])
    const view = show()

    await enabled()
    view.activity('$two')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  })

  it('renders nothing for malformed list entries', async () => {
    const calls = bridge([
      listed(
        { ...(await entry()), draft: { ...googleWriteEmail(), sendAt: 'later' } },
        { ...(await entry(googleWriteEvent())), status: 'confirmed' },
        'not a proposal'
      )
    ])
    const view = show()

    await waitFor(() => expect(calls.writeProposals).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(view.container.querySelector('[data-matrix-google-write-cards]')).toBeNull()
  })

  it('shows nothing and asks nothing without the bridge', async () => {
    const view = show()

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(view.container.innerHTML).toBe('')
  })
})
