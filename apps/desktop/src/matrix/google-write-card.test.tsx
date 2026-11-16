import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EventType, MatrixEvent } from 'matrix-js-sdk'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixUiBridge } from '../../shared/matrix'
import {
  MATRIX_GOOGLE_WRITE_OUTCOME_TYPE,
  MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE,
  matrixFoldGoogleWriteProposals,
  type MatrixGoogleWriteAnswer,
  type MatrixGoogleWriteDecisionInput,
  matrixGoogleWriteDigest,
  type MatrixGoogleWriteDraft,
  type MatrixGoogleWriteProposal,
  type MatrixGoogleWriteStanding,
  parseMatrixGoogleWriteProposal
} from '../../shared/matrix-google-write-proposal'
import {
  GOOGLE_WRITE_IDS,
  googleWriteEmail,
  googleWriteEventFields,
  googleWriteProposalContent
} from '../../shared/matrix-google-write-proposal.test-support'

import { MatrixGoogleWriteCard, resetMatrixGoogleWriteAnswers } from './google-write-card'
import { matrixMessage } from './message'

const AGENT = '@agent:test'
const OWNER = '@owner:test'
const ZONE = 'Asia/Ho_Chi_Minh'
const BEFORE_EXPIRY = () => Date.UTC(2027, 2, 1)

afterEach(() => {
  cleanup()
  resetMatrixGoogleWriteAnswers()
  delete (window as { atumMatrix?: unknown }).atumMatrix
})

function bridge(decideWrite: (input: MatrixGoogleWriteDecisionInput) => Promise<unknown>) {
  const spy = vi.fn(decideWrite)

  window.atumMatrix = { googleConnections: { decideWrite: spy } } as unknown as MatrixUiBridge

  return spy
}

async function proposalOf(draft: MatrixGoogleWriteDraft = googleWriteEmail(), change: Record<string, unknown> = {}) {
  return parseMatrixGoogleWriteProposal(await googleWriteProposalContent(draft, change))!
}

function show(
  proposal: MatrixGoogleWriteProposal,
  { locale = 'en', standing = 'open', now = BEFORE_EXPIRY }: { locale?: Locale; standing?: MatrixGoogleWriteStanding; now?: () => number } = {}
) {
  const wrap = (node: ReactNode) => (
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  )

  const card = (next: MatrixGoogleWriteStanding) => wrap(<MatrixGoogleWriteCard now={now} proposal={proposal} standing={next} timeZone={ZONE} />)
  const view = render(card(standing))

  return { ...view, restand: (next: MatrixGoogleWriteStanding) => view.rerender(card(next)) }
}

const approveButton = (name = 'Send') => screen.findByRole('button', { name })
const enabled = async (name = 'Send') => waitFor(() => expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false))

describe('Google write card', () => {
  it('shows the whole email draft and its two actions in English', async () => {
    bridge(async () => 'done')
    show(await proposalOf())

    const card = screen.getByRole('region', { name: 'Send this email?' })

    for (const text of [
      'hello@example.com',
      'contact@example.com, info@example.org',
      'support@example.com',
      'help@example.org',
      'Quote for the spring order',
      'quote-spring.pdf'
    ]) {
      expect(within(card).getByText(text)).toBeTruthy()
    }

    // The body exactly, line breaks and all, as plain text.
    expect(card.querySelector('[data-matrix-google-write-text]')?.textContent).toBe(googleWriteEmail().body)
    expect(within(card).getByText('Bcc')).toBeTruthy()
    await enabled()
    expect(screen.getByRole('button', { name: 'Decline' })).toHaveProperty('disabled', false)
  })

  it('speaks Vietnamese', async () => {
    bridge(async () => 'declined')
    show(await proposalOf(), { locale: 'vi' })

    expect(screen.getByRole('region', { name: 'Gửi email này?' })).toBeTruthy()
    expect(screen.getByText('Tiêu đề')).toBeTruthy()
    await enabled('Gửi')
    fireEvent.click(screen.getByRole('button', { name: 'Từ chối' }))
    expect(await screen.findByText('Đã từ chối. Không có gì thay đổi.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('approves with the proposal and the digest of the draft it rendered', async () => {
    const decide = bridge(async () => 'done')
    const proposal = await proposalOf()

    show(proposal)
    await enabled()
    fireEvent.click(await approveButton())

    expect(await screen.findByText('Sent.')).toBeTruthy()
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith({
      proposalId: GOOGLE_WRITE_IDS.first,
      digest: await matrixGoogleWriteDigest(googleWriteEmail()),
      decision: 'approve'
    })
    expect(decide.mock.calls[0]![0].digest).toBe(proposal.digest)
  })

  it('declines with the same proposal and digest', async () => {
    const decide = bridge(async () => 'declined')
    const proposal = await proposalOf()

    show(proposal)
    await enabled()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))

    expect(await screen.findByText('Declined. Nothing changed.')).toBeTruthy()
    expect(decide).toHaveBeenCalledWith({ proposalId: proposal.proposalId, digest: proposal.digest, decision: 'decline' })
  })

  it('sends once however fast the presses, and shows the wait', async () => {
    let finish!: (value: MatrixGoogleWriteAnswer) => void
    const decide = bridge(() => new Promise(resolve => { finish = resolve }))

    show(await proposalOf())
    await enabled()
    const send = await approveButton()

    fireEvent.click(send)
    fireEvent.click(send)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Approving…' })).toHaveProperty('disabled', true))
    expect(screen.getByRole('region').getAttribute('aria-busy')).toBe('true')
    expect(decide).toHaveBeenCalledTimes(1)

    finish('approved')
    expect(await screen.findByText('Approved. It could not be confirmed yet, so check Google before asking again.')).toBeTruthy()
    expect(decide).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['changed', 'This draft changed after it was shown, so it was not sent. Ask for a fresh one.'],
    ['superseded', 'A newer request replaced this one. Nothing changed.'],
    ['expired', 'This request expired. Nothing changed.'],
    ['answered', 'This request was already answered.'],
    ['failed', 'This did not go through. Nothing changed. You can ask again.']
  ] as const)('shows Shell’s %s answer as that state, never as sent', async (answer, line) => {
    bridge(async () => answer)
    show(await proposalOf())
    await enabled()
    fireEvent.click(await approveButton())

    expect(await screen.findByText(line)).toBeTruthy()
    expect(screen.queryByText('Sent.')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([
    ['a lost answer', async () => 'retry'],
    ['an unknown answer', async () => 'sent'],
    ['a failed request', async () => { throw new Error('ipc') }]
  ])('stays open and calm after %s', async (_name, answer) => {
    const decide = bridge(answer)

    show(await proposalOf())
    await enabled()
    fireEvent.click(await approveButton())

    expect(await screen.findByText('Could not reach Atum. Try again.')).toBeTruthy()
    expect(screen.queryByText('Sent.')).toBeNull()
    await enabled()

    decide.mockImplementation(async () => 'done')
    fireEvent.click(await approveButton())
    expect(await screen.findByText('Sent.')).toBeTruthy()
    expect(decide).toHaveBeenCalledTimes(2)
  })

  it('never offers a draft whose digest is not the proposal’s', async () => {
    const decide = bridge(async () => 'done')

    show(await proposalOf(googleWriteEmail(), { digest: await matrixGoogleWriteDigest(googleWriteEmail({ bcc: [] })) }))

    expect(await screen.findByText('This draft changed after it was shown, so it was not sent. Ask for a fresh one.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(decide).not.toHaveBeenCalled()
  })

  it('closes when the proposal expires', async () => {
    const decide = bridge(async () => 'done')

    show(await proposalOf(), { now: () => Date.UTC(2027, 2, 6) })

    expect(screen.getByText('This request expired. Nothing changed.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(decide).not.toHaveBeenCalled()
  })

  it('follows the agent’s outcome and a newer proposal', async () => {
    bridge(async () => 'done')
    const { restand } = show(await proposalOf())

    await enabled()
    restand('superseded')
    expect(screen.getByText('A newer request replaced this one. Nothing changed.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()

    restand('done')
    expect(screen.getByText('Sent.')).toBeTruthy()
  })

  it('shows an event in the owner’s time zone and adds it', async () => {
    const decide = bridge(async () => 'done')
    const event = googleWriteEventFields({ start: { dateTime: '2027-03-04T02:30:00Z', timeZone: 'UTC' }, end: { dateTime: '2027-03-04T03:00:00Z', timeZone: 'UTC' } })

    show(await proposalOf({ kind: 'create_event', calendar: 'Work', event }))

    const time = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: ZONE })

    expect(screen.getByRole('region', { name: 'Add this event to your calendar?' })).toBeTruthy()
    expect(screen.getByText(time.format(Date.parse('2027-03-04T02:30:00Z')))).toBeTruthy()
    expect(screen.getByText(time.format(Date.parse('2027-03-04T03:00:00Z')))).toBeTruthy()
    // The event's own zone differs from the owner's, so it is named.
    expect(screen.getByText('UTC')).toBeTruthy()
    expect(screen.getByText('contact@example.com')).toBeTruthy()
    expect(screen.getByText('Bring the price list.')).toBeTruthy()
    await enabled('Add event')
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }))
    expect(await screen.findByText('Added to your calendar.')).toBeTruthy()
    expect(decide.mock.calls[0]![0].decision).toBe('approve')
  })

  it('shows what an event change replaces, in Vietnamese', async () => {
    bridge(async () => 'done')
    show(
      await proposalOf({
        kind: 'update_event',
        calendar: 'Công việc',
        current: googleWriteEventFields(),
        next: googleWriteEventFields({ location: 'Phòng 3' })
      }),
      { locale: 'vi' }
    )

    expect(screen.getByRole('region', { name: 'Lưu thay đổi này vào lịch?' })).toBeTruthy()
    expect(screen.getByText(/Hiện tại:\s*Room 2/u)).toBeTruthy()
    expect(screen.getByText(/Sau khi đổi:\s*Phòng 3/u)).toBeTruthy()
    await enabled('Lưu thay đổi')
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }))
    expect(await screen.findByText('Đã lưu thay đổi vào lịch.')).toBeTruthy()
  })
})

describe('Google write proposals in the agent’s chat', () => {
  function timelineEvent(type: string, content: Record<string, unknown>, sender = AGENT, id = '$proposal') {
    return new MatrixEvent({ type, room_id: '!room:test', event_id: id, sender, origin_server_ts: 1, content })
  }

  const project = (events: MatrixEvent[]) =>
    matrixFoldGoogleWriteProposals(
      events.flatMap(event => matrixMessage(event, OWNER, new Set()) ?? []),
      new Set([AGENT])
    )

  it('replaces the older card with the newer one', async () => {
    const lines = project([
      timelineEvent(MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE, await googleWriteProposalContent(), AGENT, '$one'),
      timelineEvent(
        MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE,
        await googleWriteProposalContent(googleWriteEmail({ subject: 'Updated quote' }), { proposalId: GOOGLE_WRITE_IDS.second }),
        AGENT,
        '$two'
      )
    ])

    bridge(async () => 'done')
    render(
      <I18nProvider configClient={null} initialLocale="en">
        {lines.map(line => (
          <MatrixGoogleWriteCard
            key={line.id}
            now={BEFORE_EXPIRY}
            proposal={line.googleWrite!.proposal}
            standing={line.googleWrite!.standing}
            timeZone={ZONE}
          />
        ))}
      </I18nProvider>
    )

    const [older, newer] = screen.getAllByRole('region')

    expect(within(older!).getByText('A newer request replaced this one. Nothing changed.')).toBeTruthy()
    expect(within(older!).queryByRole('button')).toBeNull()
    await waitFor(() => expect(within(newer!).getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false))
    expect(within(newer!).getByText('Updated quote')).toBeTruthy()
  })

  it('settles a card by the agent’s outcome event, which shows nothing itself', async () => {
    const lines = project([
      timelineEvent(MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE, await googleWriteProposalContent()),
      timelineEvent(MATRIX_GOOGLE_WRITE_OUTCOME_TYPE, { version: 1, proposalId: GOOGLE_WRITE_IDS.first, state: 'declined' }, AGENT, '$outcome')
    ])

    expect(lines.map(line => [line.id, line.googleWrite?.standing])).toEqual([['$proposal', 'declined']])
  })

  it('shows nothing for a malformed, foreign, own or chat-message copy of a proposal', async () => {
    const content = await googleWriteProposalContent()

    expect(
      project([
        timelineEvent(MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE, { ...content, version: 2 }, AGENT, '$v2'),
        timelineEvent(MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE, { ...content, draft: { kind: 'send_fax' } }, AGENT, '$kind'),
        timelineEvent(MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE, content, '@stranger:test', '$stranger'),
        timelineEvent(MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE, content, OWNER, '$own'),
        timelineEvent(MATRIX_GOOGLE_WRITE_OUTCOME_TYPE, { version: 1, proposalId: 'x', state: 'done' }, AGENT, '$outcome'),
        timelineEvent('io.atum.google.write_proposal.v2', content, AGENT, '$unknown')
      ])
    ).toEqual([])

    // The proposal shape inside an ordinary message is only that message, never a card.
    const message = project([timelineEvent(EventType.RoomMessage, { msgtype: 'm.notice', body: '', ...content }, AGENT, '$text')])

    expect(message).toHaveLength(1)
    expect(message[0]!.googleWrite).toBeUndefined()
  })
})
