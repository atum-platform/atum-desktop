import {
  type MatrixGoogleWorkDraft,
  matrixGoogleWriteDigest,
  type MatrixGoogleWriteDraft,
  type MatrixGoogleWriteEmail,
  type MatrixGoogleWriteEvent
} from './matrix-google-write-proposal'

/** Invented proposals for tests: role addresses at example domains, ids with no long digit runs. */
export const GOOGLE_WRITE_IDS = {
  first: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  second: '7a2d3b4c-5e6f-4a71-9b8c-ad1e2f3a4b5c',
  third: '8b3e4c5d-6f7a-4b82-ac9d-be2f3a4b5c6d',
  agent: '9c4f5d6e-7a8b-4c93-bdae-cf3a4b5c6d7e',
  otherAgent: 'ad5e6f7a-8b9c-4da4-8ebf-da4b5c6d7e8f'
} as const

export const GOOGLE_WRITE_ROOM = '!personal:example.org'
export const GOOGLE_WRITE_OTHER_ROOM = '!other:example.org'

export function googleWriteEmail(change: Partial<MatrixGoogleWriteEmail> = {}): MatrixGoogleWriteEmail {
  return {
    to: ['contact@example.com'],
    cc: ['support@example.com'],
    subject: 'Quote for the spring order',
    body: 'Hi,\n\nThe quote is attached.\n\nThanks',
    quote: '',
    references: [],
    attachments: [{ filename: 'quote-spring.pdf', mimeType: 'application/pdf', size: 48_213 }],
    ...change
  }
}

export function googleWriteEvent(change: Partial<MatrixGoogleWriteEvent> = {}): MatrixGoogleWriteEvent {
  return {
    action: 'create_event',
    sourceId: 'google:calendar:YQ',
    title: 'Supplier call',
    start: '2027-03-04T09:30:00+07:00',
    end: '2027-03-04T10:00:00+07:00',
    location: 'Room 2',
    description: 'Bring the price list.',
    ...change
  }
}

/** One pending-list entry for `draft`, its digest computed as Shell does. */
export async function googleWriteEntry(
  draft: MatrixGoogleWriteDraft = googleWriteEmail(),
  change: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const proposalId = typeof change.proposalId === 'string' ? change.proposalId : GOOGLE_WRITE_IDS.first

  return {
    proposalId,
    operationId: proposalId,
    agent: GOOGLE_WRITE_IDS.agent,
    room: GOOGLE_WRITE_ROOM,
    draft,
    digest: await matrixGoogleWriteDigest(draft),
    status: 'awaiting_owner',
    ...change
  }
}

export const GOOGLE_WORK_OWNER = '@owner:example.org'
export const GOOGLE_WORK_OTHER_OWNER = '@someone:example.org'

/** An email with no Cc (no key at all: an undefined value has no canonical JSON). */
function workEmail(change: Partial<MatrixGoogleWriteEmail> = {}): MatrixGoogleWriteEmail {
  const { cc: _cc, ...email } = googleWriteEmail(change)

  return email
}

/** One invented draft per Work action (the seven Google changes). */
export const GOOGLE_WORK_DRAFTS = {
  send_email: workEmail(),
  create_event: googleWriteEvent(),
  update_event: googleWriteEvent({ action: 'update_event', eventId: 'evt_supplier', title: 'Supplier call (moved)' }),
  create_draft: {
    ...workEmail({ attachments: [] }),
    action: 'create_draft',
    sourceId: 'google:gmail',
    subject: 'Draft: spring order'
  },
  update_draft: {
    ...workEmail({ attachments: [] }),
    action: 'update_draft',
    sourceId: 'google:gmail',
    draftId: 'r-draft-one',
    subject: 'Draft: spring order v2'
  },
  mailbox: { action: 'mailbox', sourceId: 'google:gmail', operation: 'add_labels', threadId: 'thread_one', labels: ['Suppliers', 'Spring'] },
  create_label: { action: 'create_label', sourceId: 'google:gmail', name: 'Suppliers' }
} satisfies Record<string, MatrixGoogleWorkDraft>

/** One Work entry of the owner list for `draft`: no agent, no room, `source: "work"`. */
export async function googleWorkEntry(
  draft: MatrixGoogleWorkDraft = GOOGLE_WORK_DRAFTS.send_email,
  change: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const proposalId = typeof change.proposalId === 'string' ? change.proposalId : GOOGLE_WRITE_IDS.third

  return {
    proposalId,
    operationId: proposalId,
    agent: null,
    room: null,
    draft,
    digest: await matrixGoogleWriteDigest(draft),
    status: 'awaiting_owner',
    source: 'work',
    ...change
  }
}
