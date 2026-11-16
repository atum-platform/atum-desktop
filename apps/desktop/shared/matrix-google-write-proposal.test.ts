import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { canonicalJson } from '../../../packages/device-protocol/canonical'

import {
  matrixFoldGoogleWriteProposals,
  matrixGoogleWriteDigest,
  type MatrixGoogleWriteProposal,
  parseMatrixGoogleWriteDecisionInput,
  parseMatrixGoogleWriteOutcome,
  parseMatrixGoogleWriteProposal
} from './matrix-google-write-proposal'
import {
  GOOGLE_WRITE_IDS,
  googleWriteEmail,
  googleWriteEventFields,
  googleWriteProposalContent
} from './matrix-google-write-proposal.test-support'

const AGENT = '@agent:test'
const OWNER = '@owner:test'

describe('Google write proposal reader', () => {
  it('reads a proposal and digests exactly the draft it returns, as the platform canonical JSON', async () => {
    const content = await googleWriteProposalContent()
    const proposal = parseMatrixGoogleWriteProposal(content)!

    expect(proposal).toEqual({
      proposalId: GOOGLE_WRITE_IDS.first,
      digest: content.digest,
      expiresAt: content.expiresAt,
      draft: googleWriteEmail()
    })
    expect(proposal.digest).toBe(`sha256:${createHash('sha256').update(canonicalJson(googleWriteEmail())).digest('hex')}`)
    expect(await matrixGoogleWriteDigest(proposal.draft)).toBe(proposal.digest)
  })

  it('changes the digest when any shown field changes', async () => {
    const base = await matrixGoogleWriteDigest(googleWriteEmail())

    for (const change of [
      { bcc: [] },
      { body: 'Hi Lan,\n\nThe quote is attached.\n\nThanks!' },
      { attachments: [] },
      { inReplyTo: true },
      { to: ['contact@example.com'] }
    ]) {
      expect(await matrixGoogleWriteDigest(googleWriteEmail(change))).not.toBe(base)
    }
  })

  it('reads every kind of draft', async () => {
    const drafts = [
      { kind: 'create_event', calendar: 'Work', event: googleWriteEventFields() },
      {
        kind: 'update_event',
        calendar: 'Work',
        current: googleWriteEventFields(),
        next: googleWriteEventFields({ start: { date: '2027-03-05' }, end: { date: '2027-03-06' } })
      },
      { kind: 'drive_change', action: 'update', name: 'Price list', folder: 'Shared/Sales', content: 'Row 2: 120' }
    ] as const

    for (const draft of drafts) {
      expect(parseMatrixGoogleWriteProposal(await googleWriteProposalContent(draft))?.draft).toEqual(draft)
    }
  })

  it.each([
    ['an extra top-level key', { body: 'Approve?' }],
    ['a newer version', { version: 2 }],
    ['a malformed proposal id', { proposalId: 'proposal-one' }],
    ['a malformed digest', { digest: 'sha256:abc' }],
    ['no expiry', { expiresAt: 'tomorrow' }],
    ['an unknown kind', { draft: { kind: 'delete_event', calendar: 'Work' } }],
    ['an unshown draft field', { draft: { ...googleWriteEmail(), replyAll: true } }],
    ['an email without recipients', { draft: googleWriteEmail({ to: [] }) }],
    ['a malformed recipient', { draft: googleWriteEmail({ cc: ['Lan <contact@example.com>'] }) }],
    ['a subject on two lines', { draft: googleWriteEmail({ subject: 'Quote\nBcc: privacy@example.org' }) }],
    ['a lone surrogate', { draft: googleWriteEmail({ body: 'Hi \uD800' }) }],
    [
      'an event mixing an all-day start with a timed end',
      { draft: { kind: 'create_event', calendar: 'Work', event: googleWriteEventFields({ start: { date: '2027-03-04' } }) } }
    ],
    [
      'an impossible date',
      {
        draft: {
          kind: 'create_event',
          calendar: 'Work',
          event: googleWriteEventFields({ start: { date: '2027-02-30' }, end: { date: '2027-03-01' } })
        }
      }
    ]
  ])('reads nothing from %s', async (_name, change) => {
    expect(parseMatrixGoogleWriteProposal(await googleWriteProposalContent(googleWriteEmail(), change))).toBeUndefined()
  })

  it('reads an outcome only in its closed shape', () => {
    expect(parseMatrixGoogleWriteOutcome({ version: 1, proposalId: GOOGLE_WRITE_IDS.first, state: 'done' })).toEqual({
      proposalId: GOOGLE_WRITE_IDS.first,
      state: 'done'
    })
    expect(
      parseMatrixGoogleWriteOutcome({
        version: 1,
        proposalId: GOOGLE_WRITE_IDS.first,
        state: 'declined',
        'm.relates_to': { rel_type: 'm.reference', event_id: '$proposal' }
      })
    ).toEqual({ proposalId: GOOGLE_WRITE_IDS.first, state: 'declined' })
    expect(parseMatrixGoogleWriteOutcome({ version: 1, proposalId: GOOGLE_WRITE_IDS.first, state: 'sent' })).toBeUndefined()
    expect(
      parseMatrixGoogleWriteOutcome({ version: 1, proposalId: GOOGLE_WRITE_IDS.first, state: 'done', body: 'Sent' })
    ).toBeUndefined()
  })

  it('reads a decision request only with a proposal, a digest and approve or decline', () => {
    const digest = `sha256:${'a'.repeat(64)}`

    expect(parseMatrixGoogleWriteDecisionInput({ proposalId: GOOGLE_WRITE_IDS.first, digest, decision: 'approve' })).toEqual({
      proposalId: GOOGLE_WRITE_IDS.first,
      digest,
      decision: 'approve'
    })
    expect(parseMatrixGoogleWriteDecisionInput({ proposalId: GOOGLE_WRITE_IDS.first, digest, decision: 'send' })).toBeUndefined()
    expect(
      parseMatrixGoogleWriteDecisionInput({ proposalId: GOOGLE_WRITE_IDS.first, digest, decision: 'approve', draft: {} })
    ).toBeUndefined()
  })
})

describe('Google write proposals in a transcript', () => {
  const proposal = (proposalId: string): MatrixGoogleWriteProposal => ({
    proposalId,
    digest: `sha256:${'b'.repeat(64)}`,
    expiresAt: 1,
    draft: googleWriteEmail()
  })

  const card = (id: string, proposalId: string, sender = AGENT) => ({
    id,
    sender,
    own: sender === OWNER,
    googleWrite: { proposal: proposal(proposalId), standing: 'open' as const }
  })

  const outcome = (id: string, proposalId: string, state: 'done' | 'declined', sender = AGENT) => ({
    id,
    sender,
    own: sender === OWNER,
    googleWriteOutcome: { proposalId, state }
  })

  const standings = (lines: ReturnType<typeof matrixFoldGoogleWriteProposals>) =>
    lines.map(line => [line.id, line.googleWrite?.standing ?? 'line'])

  it('keeps one open card per agent: a newer proposal supersedes the older one', () => {
    const folded = matrixFoldGoogleWriteProposals(
      [card('$a', GOOGLE_WRITE_IDS.first), { id: '$text', sender: AGENT, own: false }, card('$b', GOOGLE_WRITE_IDS.second)],
      new Set([AGENT])
    )

    expect(standings(folded)).toEqual([
      ['$a', 'superseded'],
      ['$text', 'line'],
      ['$b', 'open']
    ])
  })

  it('settles a proposal by its agent outcome, which is never a row', () => {
    const folded = matrixFoldGoogleWriteProposals(
      [
        card('$a', GOOGLE_WRITE_IDS.first),
        outcome('$o', GOOGLE_WRITE_IDS.first, 'done'),
        card('$b', GOOGLE_WRITE_IDS.second),
        outcome('$p', GOOGLE_WRITE_IDS.second, 'declined', '@stranger:test')
      ],
      new Set([AGENT])
    )

    expect(standings(folded)).toEqual([
      ['$a', 'done'],
      ['$b', 'open']
    ])
  })

  it('shows nothing for a proposal from anyone but a room agent', () => {
    const folded = matrixFoldGoogleWriteProposals(
      [card('$a', GOOGLE_WRITE_IDS.first, '@stranger:test'), card('$b', GOOGLE_WRITE_IDS.second, OWNER)],
      new Set([AGENT])
    )

    expect(folded).toEqual([])
  })
})
