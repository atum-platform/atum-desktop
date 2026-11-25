import { useEffect, useState } from 'react'

import {
  type MatrixGoogleWorkDraft,
  type MatrixGoogleWorkProposal,
  matrixGoogleWriteDigest
} from '../../../shared/matrix-google-write-proposal'
import { MatrixGoogleWriteCard, type MatrixGoogleWriteStanding } from '../google-write-card'

/** Invented Work requests (example domains, role addresses), one per Google change. */
const EMAIL = {
  to: ['contact@example.com'],
  subject: 'Spring order: confirmed quantities',
  body: 'Hi,\n\nConfirming 40 units for the spring order. Delivery by 12 March works for us.\n\nThanks',
  quote: '',
  references: [],
  attachments: [{ filename: 'spring-order.pdf', mimeType: 'application/pdf', size: 48_213 }]
}

const DRAFTS: Record<string, MatrixGoogleWorkDraft> = {
  send_email: EMAIL,
  create_event: {
    action: 'create_event',
    sourceId: 'google:calendar:primary',
    title: 'Supplier call',
    start: '2027-03-04T09:30:00+07:00',
    end: '2027-03-04T10:00:00+07:00',
    location: 'Room 2'
  },
  update_event: {
    action: 'update_event',
    sourceId: 'google:calendar:primary',
    eventId: 'evt_supplier',
    title: 'Supplier call',
    start: '2027-03-05T14:00:00+07:00',
    end: '2027-03-05T14:30:00+07:00'
  },
  create_draft: { ...EMAIL, attachments: [], action: 'create_draft', sourceId: 'google:gmail' },
  update_draft: { ...EMAIL, attachments: [], action: 'update_draft', sourceId: 'google:gmail', draftId: 'r-draft-one' },
  mailbox: { action: 'mailbox', sourceId: 'google:gmail', operation: 'add_labels', threadId: 'thread_one', labels: ['Suppliers'] },
  create_label: { action: 'create_label', sourceId: 'google:gmail', name: 'Suppliers' }
}

const SETTLED: Array<[string, MatrixGoogleWriteStanding]> = [
  ['create_label', 'expired'],
  ['mailbox', 'superseded']
]

function id(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

/**
 * Work's Google write card, every action and the settled states, as the real component draws them.
 * Approve and Decline answer locally here (nothing leaves the playground), so their settled lines show too.
 */
export function PlaygroundWorkGoogleWrite() {
  const [proposals, setProposals] = useState<MatrixGoogleWorkProposal[]>()

  useEffect(() => {
    const bridge = (window.atumMatrix ??= {} as typeof window.atumMatrix) as unknown as Record<string, unknown>
    const google = (bridge.googleConnections ?? {}) as Record<string, unknown>
    const statuses = { delivered: 'delivered', approve: 'confirmed', decline: 'declined' } as const

    bridge.googleConnections = {
      ...google,
      writeProposalAction: async ({ action }: { action: keyof typeof statuses }) => ({ state: 'ok', status: statuses[action] })
    }

    void Promise.all(
      Object.values(DRAFTS).map(async (draft, index) => ({ proposalId: id(index + 1), digest: await matrixGoogleWriteDigest(draft), draft }))
    ).then(setProposals)
  }, [])

  if (!proposals) {
    return null
  }

  const kinds = Object.keys(DRAFTS)

  return (
    <div className="grid content-start gap-3 overflow-y-auto p-6" data-playground-work-google-write>
      {proposals.map(proposal => (
        <MatrixGoogleWriteCard key={proposal.proposalId} proposal={proposal} source="work" standing="open" />
      ))}
      {SETTLED.map(([kind, standing], index) => {
        const proposal = proposals[kinds.indexOf(kind)]!

        return (
          <MatrixGoogleWriteCard
            key={`settled-${index}`}
            proposal={{ ...proposal, proposalId: id(100 + index) }}
            source="work"
            standing={standing}
          />
        )
      })}
    </div>
  )
}
