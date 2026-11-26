import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixUiBridge } from '../../shared/matrix'
import {
  type MatrixGoogleWorkDraft,
  type MatrixGoogleWriteActionAnswer,
  type MatrixGoogleWriteActionInput,
  type MatrixGoogleWriteListAnswer,
  parseMatrixGoogleWorkProposalList
} from '../../shared/matrix-google-write-proposal'
import {
  GOOGLE_WORK_DRAFTS,
  GOOGLE_WORK_OTHER_OWNER,
  GOOGLE_WORK_OWNER,
  GOOGLE_WRITE_IDS,
  googleWorkEntry
} from '../../shared/matrix-google-write-proposal.test-support'

import { MatrixGoogleWorkWriteProposals, resetMatrixGoogleWriteAnswers } from './google-write-card'

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

/** The list as main hands it over: Shell's body read by the same strict reader, named for `owner`. */
function listed(owner: string | undefined, ...entries: unknown[]): MatrixGoogleWriteListAnswer {
  return {
    state: 'ok',
    proposals: [],
    work: parseMatrixGoogleWorkProposalList({ proposals: entries }) ?? [],
    ...(owner ? { owner } : {})
  }
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

  return { writeProposals, writeProposalAction, decisions }
}

function show({ locale = 'en', owner = GOOGLE_WORK_OWNER }: { locale?: Locale; owner?: string } = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixGoogleWorkWriteProposals owner={owner} pollMs={60_000} timeZone={ZONE} />
    </I18nProvider>
  )
}

const card = (name: string) => screen.findByRole('region', { name })

const enabled = async (name = 'Approve') =>
  waitFor(() => expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false))

/** The page re-reads the list when the window regains focus. */
const reread = () => act(() => void window.dispatchEvent(new Event('focus')))

const RENDERED: Array<[keyof typeof GOOGLE_WORK_DRAFTS, string, string[]]> = [
  ['send_email', 'Send this email?', ['contact@example.com', 'Quote for the spring order']],
  ['create_event', 'Add this event to your calendar?', ['Supplier call', 'Room 2']],
  ['update_event', 'Save these changes to your calendar?', ['Supplier call (moved)']],
  ['create_draft', 'Save this draft in Gmail?', ['contact@example.com', 'Draft: spring order']],
  ['update_draft', 'Update this Gmail draft?', ['Draft: spring order v2']],
  ['mailbox', 'Add these Gmail labels?', ['The whole conversation', 'Suppliers, Spring']],
  ['create_label', 'Create this Gmail label?', ['Suppliers']]
]

describe('Work Google write card', () => {
  it.each(RENDERED)('shows a Work %s request, says it came from Work, and offers Approve and Decline', async (kind, question, texts) => {
    bridge([listed(GOOGLE_WORK_OWNER, await googleWorkEntry(GOOGLE_WORK_DRAFTS[kind]))])
    show()

    const region = await card(question)

    expect(region.getAttribute('data-matrix-google-write-source')).toBe('work')
    expect(within(region).getByText('From Work on this Mac')).toBeTruthy()

    for (const text of texts) {
      expect(within(region).getByText(text)).toBeTruthy()
    }

    await enabled()
    expect(screen.getByRole('button', { name: 'Decline' })).toHaveProperty('disabled', false)
  })

  it('shows a calendar time in the owner’s time zone and a single email change plainly', async () => {
    const archive: MatrixGoogleWorkDraft = { action: 'mailbox', sourceId: 'google:gmail', operation: 'archive', messageId: 'msg_one' }

    bridge([listed(GOOGLE_WORK_OWNER, await googleWorkEntry(archive))])
    show()

    const region = await card('Archive this in Gmail?')

    expect(within(region).getByText('One email')).toBeTruthy()
    expect(within(region).queryByText('Labels')).toBeNull()

    cleanup()
    bridge([listed(GOOGLE_WORK_OWNER, await googleWorkEntry(GOOGLE_WORK_DRAFTS.create_event))])
    show()
    expect(within(await card('Add this event to your calendar?')).getByText(/9:30\s?AM/u)).toBeTruthy()
  })

  it('approves through the owner endpoint with the digest it rendered, then settles to one line', async () => {
    const entry = await googleWorkEntry(GOOGLE_WORK_DRAFTS.send_email)
    const calls = bridge([listed(GOOGLE_WORK_OWNER, entry), listed(GOOGLE_WORK_OWNER)])

    show()
    await card('Send this email?')
    await enabled()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('Approved.')).toBeTruthy()
    expect(calls.decisions()).toEqual([{ proposalId: entry.proposalId, digest: entry.digest, action: 'approve' }])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('declines through the same endpoint and says nothing was changed', async () => {
    const entry = await googleWorkEntry(GOOGLE_WORK_DRAFTS.mailbox)
    const calls = bridge([listed(GOOGLE_WORK_OWNER, entry), listed(GOOGLE_WORK_OWNER)])

    show()
    await card('Add these Gmail labels?')
    await enabled()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))

    expect(await screen.findByText('Declined. Nothing was changed.')).toBeTruthy()
    expect(calls.decisions()).toEqual([{ proposalId: entry.proposalId, digest: entry.digest, action: 'decline' }])
  })

  it('speaks Vietnamese', async () => {
    bridge([listed(GOOGLE_WORK_OWNER, await googleWorkEntry(GOOGLE_WORK_DRAFTS.create_label))])
    show({ locale: 'vi' })

    const region = await card('Tạo nhãn Gmail này?')

    expect(within(region).getByText('Từ Work trên máy Mac này')).toBeTruthy()
    await enabled('Duyệt')
  })

  it('shows an expired request once it leaves the list unanswered', async () => {
    const calls = bridge([listed(GOOGLE_WORK_OWNER, await googleWorkEntry(GOOGLE_WORK_DRAFTS.create_label)), listed(GOOGLE_WORK_OWNER)])

    show()
    await card('Create this Gmail label?')
    await reread()

    expect(await screen.findByText('This request expired.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(calls.decisions()).toEqual([])
  })

  it('replaces a request with the newer one Work asked for', async () => {
    bridge([
      listed(GOOGLE_WORK_OWNER, await googleWorkEntry(GOOGLE_WORK_DRAFTS.create_label)),
      listed(GOOGLE_WORK_OWNER, await googleWorkEntry(GOOGLE_WORK_DRAFTS.send_email, { proposalId: GOOGLE_WRITE_IDS.second }))
    ])

    show()
    await card('Create this Gmail label?')
    await reread()

    expect(await screen.findByText('A newer request from Work replaced this one.')).toBeTruthy()
    expect(await card('Send this email?')).toBeTruthy()
  })

  it('never offers a draft whose digest is not the proposal’s', async () => {
    const calls = bridge([listed(GOOGLE_WORK_OWNER, await googleWorkEntry(GOOGLE_WORK_DRAFTS.send_email, { digest: 'e'.repeat(64) }))])

    show()

    expect(await screen.findByText('This doesn’t match what Work asked for, so it can’t be approved here.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(calls.writeProposalAction).not.toHaveBeenCalled()
  })

  it.each([
    ['another account’s list', GOOGLE_WORK_OTHER_OWNER],
    ['a list that names no account', undefined]
  ])('shows nothing for %s', async (_name, owner) => {
    const calls = bridge([listed(owner, await googleWorkEntry(GOOGLE_WORK_DRAFTS.send_email))])

    show()
    await waitFor(() => expect(calls.writeProposals).toHaveBeenCalled())
    await reread()

    expect(screen.queryByRole('region')).toBeNull()
    expect(calls.writeProposalAction).not.toHaveBeenCalled()
  })

  it('drops the cards when the account on screen changes', async () => {
    bridge([listed(GOOGLE_WORK_OWNER, await googleWorkEntry(GOOGLE_WORK_DRAFTS.send_email))])

    const view = show()

    await card('Send this email?')
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixGoogleWorkWriteProposals owner={GOOGLE_WORK_OTHER_OWNER} pollMs={60_000} timeZone={ZONE} />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
  })
})
