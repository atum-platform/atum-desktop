import {
  matrixGoogleWriteDigest,
  type MatrixGoogleWriteDraft,
  type MatrixGoogleWriteEmail,
  type MatrixGoogleWriteEventFields
} from './matrix-google-write-proposal'

/** Invented proposals for tests: example.com people, ids with no long digit runs. */
export const GOOGLE_WRITE_IDS = {
  first: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  second: '7a2d3b4c-5e6f-4a71-9b8c-ad1e2f3a4b5c',
  third: '8b3e4c5d-6f7a-4b82-ac9d-be2f3a4b5c6d'
} as const

export function googleWriteEmail(change: Partial<MatrixGoogleWriteEmail> = {}): MatrixGoogleWriteEmail {
  return {
    kind: 'send_email',
    from: 'hello@example.com',
    to: ['contact@example.com', 'info@example.org'],
    cc: ['support@example.com'],
    bcc: ['help@example.org'],
    subject: 'Quote for the spring order',
    body: 'Hi Lan,\n\nThe quote is attached.\n\nThanks',
    attachments: [{ name: 'quote-spring.pdf' }],
    inReplyTo: false,
    ...change
  }
}

export function googleWriteEventFields(change: Partial<MatrixGoogleWriteEventFields> = {}): MatrixGoogleWriteEventFields {
  return {
    title: 'Supplier call',
    start: { dateTime: '2027-03-04T09:30:00+07:00', timeZone: 'Asia/Ho_Chi_Minh' },
    end: { dateTime: '2027-03-04T10:00:00+07:00', timeZone: 'Asia/Ho_Chi_Minh' },
    location: 'Room 2',
    notes: 'Bring the price list.',
    attendees: ['contact@example.com'],
    ...change
  }
}

/** A proposal event's content for `draft`, its digest computed as Shell would. */
export async function googleWriteProposalContent(
  draft: MatrixGoogleWriteDraft = googleWriteEmail(),
  change: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return {
    version: 1,
    proposalId: GOOGLE_WRITE_IDS.first,
    digest: await matrixGoogleWriteDigest(draft),
    expiresAt: Date.UTC(2027, 2, 5),
    draft,
    ...change
  }
}
