import { useState } from 'react'

import type { MatrixOpenAgentListing, MatrixUiBridge } from '../../../shared/matrix'
import { NewAssistantDialog } from '../agent-roster'

/** The open Researcher listing as the platform's catalog serves it (0535). */
const RESEARCHER: MatrixOpenAgentListing = {
  listingId: 'open/agents/researcher',
  displayName: 'Researcher',
  title: { vi: 'Nhà nghiên cứu', en: 'Researcher' },
  summary: { vi: 'Nghiên cứu với nguồn rõ ràng', en: 'Research with clear sources' },
  glyph: '🔎',
  skills: ['atum-weekly-digest', 'trend-researcher'],
  seatPriceProtons: 60_000,
  hireRequired: false
}

export const LISTING_HIRE_VIEWS = [
  'hire-list',
  'hire-confirm',
  'hire-hiring',
  'hire-done',
  'hire-short',
  'hire-error'
] as const

type ListingHireView = (typeof LISTING_HIRE_VIEWS)[number]

/** What the native host answers, per view; the states that follow a press are reached by
 * pressing Hire (the evidence script does), so the real sheet draws each one. */
function hireAgent(view: ListingHireView): NonNullable<MatrixUiBridge['hireAgent']> {
  return async () => {
    if (view === 'hire-hiring') {
      return new Promise(() => {})
    }

    if (view === 'hire-short') {
      return { refused: 'short' }
    }

    if (view === 'hire-error') {
      throw new Error('matrix_agent_unavailable')
    }

    return { principal: 'agent-researcher' }
  }
}

/** The new-assistant sheet with the open listings shelf, on fixture data (dev only). */
export function PlaygroundListingHire({ view }: { view: ListingHireView }) {
  const [open, setOpen] = useState(() => {
    const paid = view === 'hire-confirm' || view === 'hire-short'
    const listing = { ...RESEARCHER, hireRequired: paid }

    window.atumMatrix = {
      ...window.atumMatrix,
      openAgents: async () => [listing],
      hireAgent: hireAgent(view),
      openTopUp: async () => {}
    } as MatrixUiBridge

    return true
  })

  return (
    <div className="grid h-full place-items-center" data-playground-listing-hire={view}>
      <NewAssistantDialog onOpenChange={setOpen} open={open} ready />
    </div>
  )
}
