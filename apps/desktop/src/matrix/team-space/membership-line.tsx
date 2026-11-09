import { useMemo } from 'react'

import type { MatrixMembershipLine } from '../../../shared/matrix'
import type { MatrixTeamSpaceCopy } from '../../../shared/matrix-team-space-copy'

import { useTeamSpaceCopy } from './copy'

const LINE_TEXT: Record<MatrixMembershipLine['kind'], (team: MatrixTeamSpaceCopy) => (name: string, you: boolean) => string> = {
  joined: team => team.membershipJoined,
  departed: team => team.membershipDeparted
}

export interface MembershipLineViewProps {
  kind: MatrixMembershipLine['kind']
  /** The person as the chat names them; the line says "you" itself when it is about the viewer. */
  name: string
  you: boolean
  timestamp: number
}

/**
 * One quiet, centered line of a channel's transcript: someone joined, or is no longer in. The
 * time sits in its tooltip, as a message's does. It comes from Matrix membership events, so it is
 * drawn only for what the room itself recorded.
 */
export function MembershipLineView({ kind, name, timestamp, you }: MembershipLineViewProps) {
  const { locale, team } = useTeamSpaceCopy()

  const time = useMemo(
    () =>
      Number.isFinite(timestamp)
        ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
        : undefined,
    [locale, timestamp]
  )

  return (
    <p className="py-1.5 text-center text-xs text-(--atum-ink-faint)" data-matrix-membership-line={kind} title={time}>
      {LINE_TEXT[kind](team)(name, you)}
    </p>
  )
}
