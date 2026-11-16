import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { canonicalJson } from '../../../packages/device-protocol/canonical'

import {
  matrixGoogleWriteDigest,
  matrixGoogleWriteKind,
  parseMatrixGoogleWriteActionInput,
  parseMatrixGoogleWriteProposalList
} from './matrix-google-write-proposal'
import {
  GOOGLE_WRITE_IDS,
  GOOGLE_WRITE_ROOM,
  googleWriteEmail,
  googleWriteEntry,
  googleWriteEvent
} from './matrix-google-write-proposal.test-support'

const list = (...proposals: unknown[]) => parseMatrixGoogleWriteProposalList({ proposals })

describe('Google write pending list reader', () => {
  it('reads an email and a calendar proposal and digests exactly the drafts it returns, as Shell does', async () => {
    const email = googleWriteEmail()
    const event = googleWriteEvent()
    const entries = [
      await googleWriteEntry(email),
      await googleWriteEntry(event, { proposalId: GOOGLE_WRITE_IDS.second, room: '!work:example.org' })
    ]
    const proposals = list(...entries)!

    expect(proposals).toEqual([
      { proposalId: GOOGLE_WRITE_IDS.first, agent: GOOGLE_WRITE_IDS.agent, room: GOOGLE_WRITE_ROOM, digest: entries[0]!.digest, draft: email },
      { proposalId: GOOGLE_WRITE_IDS.second, agent: GOOGLE_WRITE_IDS.agent, room: '!work:example.org', digest: entries[1]!.digest, draft: event }
    ])
    expect(proposals.map(proposal => matrixGoogleWriteKind(proposal.draft))).toEqual(['send_email', 'create_event'])

    // The platform's formula: lowercase hex SHA-256 of the UTF-8 canonical JSON of the draft.
    for (const proposal of proposals) {
      const expected = createHash('sha256').update(canonicalJson(proposal.draft)).digest('hex')

      expect(proposal.digest).toBe(expected)
      expect(await matrixGoogleWriteDigest(proposal.draft)).toBe(expected)
    }
  })

  it('reads a reply and a forward with their quote, threading and file metadata', async () => {
    const forward = googleWriteEmail({
      to: ['info@example.org'],
      cc: undefined,
      subject: 'Fwd: Spring order',
      quote: '---------- Forwarded message ---------\nFrom: hello@example.com\n\nSee below.',
      forwarded: {
        messageId: 'msg-a1',
        from: 'hello@example.com',
        date: 'Tue, 2 Mar 2027 09:00:00 +0700',
        subject: 'Spring order',
        quotePreview: 'See below.',
        quoteLength: 72,
        truncated: true
      },
      attachments: [{ filename: 'order.csv', mimeType: 'text/csv', size: 912, sha256: 'e'.repeat(64) }]
    })
    const reply = googleWriteEmail({ threadId: 'thread-b2', inReplyTo: '<info@example.org>', references: ['<info@example.org>'] })

    delete forward.cc

    expect(list(await googleWriteEntry(forward))?.[0]?.draft).toEqual(forward)
    expect(list(await googleWriteEntry(reply))?.[0]?.draft).toEqual(reply)
    expect(list(await googleWriteEntry(googleWriteEvent({ action: 'update_event', eventId: 'evt-c3' })))).toHaveLength(1)
  })

  it.each([
    ['an extra entry field', { extra: true }],
    ['an operation id that is not the proposal id', { operationId: GOOGLE_WRITE_IDS.second }],
    ['a prefixed digest', { digest: `sha256:${'a'.repeat(64)}` }],
    ['an uppercase digest', { digest: 'A'.repeat(64) }],
    ['a status other than awaiting_owner', { status: 'confirmed' }],
    ['a room that is not a room id', { room: 'personal' }],
    ['an agent that is not an id', { agent: '@agent:example.org' }],
    ['an email draft with an unknown field', { draft: { ...googleWriteEmail(), sendAt: 'later' } }],
    ['an email draft without its quote', { draft: (({ quote: _quote, ...rest }) => rest)(googleWriteEmail()) }],
    ['an email draft with no recipient', { draft: googleWriteEmail({ to: [], cc: [] }) }],
    ['an email draft with a display-name recipient', { draft: googleWriteEmail({ to: ['Support <support@example.com>'] }) }],
    ['an attachment carrying bytes', { draft: googleWriteEmail({ attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 3, data: 'AAA' } as never] }) }],
    ['a calendar draft with an operation id', { draft: { ...googleWriteEvent(), operationId: GOOGLE_WRITE_IDS.first } }],
    ['a calendar draft with a local time', { draft: googleWriteEvent({ start: '2027-03-04T09:30:00' }) }],
    ['an update without its event id', { draft: googleWriteEvent({ action: 'update_event' }) }],
    ['a create naming an event id', { draft: googleWriteEvent({ eventId: 'evt-c3' }) }],
    ['a Drive write', { draft: { action: 'create_file', sourceId: 'google:drive:YQ', title: 'Notes' } }],
    ['a lone surrogate', { draft: googleWriteEmail({ body: 'broken \uD800 text' }) }]
  ])('drops %s and keeps the rest of the list', async (_name, change) => {
    const bad = await googleWriteEntry(googleWriteEmail(), change)
    const good = await googleWriteEntry(googleWriteEvent(), { proposalId: GOOGLE_WRITE_IDS.second, agent: GOOGLE_WRITE_IDS.otherAgent })

    expect(list(bad, good)?.map(proposal => proposal.proposalId)).toEqual([GOOGLE_WRITE_IDS.second])
  })

  it('keeps one proposal per agent and room', async () => {
    const first = await googleWriteEntry(googleWriteEmail())
    const second = await googleWriteEntry(googleWriteEvent(), { proposalId: GOOGLE_WRITE_IDS.second })
    const elsewhere = await googleWriteEntry(googleWriteEvent(), { proposalId: GOOGLE_WRITE_IDS.third, agent: GOOGLE_WRITE_IDS.otherAgent })

    expect(list(first, second, elsewhere)?.map(proposal => proposal.proposalId)).toEqual([GOOGLE_WRITE_IDS.first, GOOGLE_WRITE_IDS.third])
  })

  it('reads an empty list and refuses a body that is not the list', () => {
    expect(list()).toEqual([])
    expect(parseMatrixGoogleWriteProposalList({ proposals: [], next: 'x' })).toBeUndefined()
    expect(parseMatrixGoogleWriteProposalList([])).toBeUndefined()
    expect(parseMatrixGoogleWriteProposalList({ state: 'refused' })).toBeUndefined()
  })
})

describe('Google write action input', () => {
  const input = { proposalId: GOOGLE_WRITE_IDS.first, digest: 'c'.repeat(64), action: 'approve' }

  it.each(['delivered', 'approve', 'decline'])('passes on exactly %s with its proposal and digest', action => {
    expect(parseMatrixGoogleWriteActionInput({ ...input, action })).toEqual({ ...input, action })
  })

  it.each([
    ['another action', { ...input, action: 'send' }],
    ['a draft alongside', { ...input, draft: {} }],
    ['an agent alongside', { ...input, agent: GOOGLE_WRITE_IDS.agent }],
    ['a prefixed digest', { ...input, digest: `sha256:${'c'.repeat(64)}` }],
    ['a non-id proposal', { ...input, proposalId: '../approve' }]
  ])('refuses %s', (_name, value) => {
    expect(parseMatrixGoogleWriteActionInput(value)).toBeUndefined()
  })
})
