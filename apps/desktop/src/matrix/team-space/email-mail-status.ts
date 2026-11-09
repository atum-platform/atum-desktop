import { useEffect, useRef, useState } from 'react'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import type { CompanyEmailMailStatus } from '../../../shared/matrix-company-team-space'

import { requestTeamSpace } from './request'

/** How often a still-queued invitation is asked about while the sheet is open, and how many times at most. */
export const MAIL_STATUS_POLL_MS = 15_000
export const MAIL_STATUS_MAX_READS = 20

const settled = (status: CompanyEmailMailStatus | undefined) => status === 'sent' || status === 'failed' || status === 'cancelled'

interface Poller {
  stop(): void
}

/**
 * The mail state (invites 2) of the email invitations made in one opening of the Add people sheet.
 *
 * One poller per invitation, each on its own schedule: read at once, then `MAIL_STATUS_POLL_MS` after its previous answer
 * while it is still queued (or unread), up to `MAIL_STATUS_MAX_READS` reads. A new invitation starts its own poller and
 * never moves another's: inviting B does not read A early or spend A's reads. A poller never overlaps itself (the next
 * read is scheduled only after the answer). Mail can stay queued for a long time; the last answer is what the sheet says.
 * A failed read changes nothing shown. Unmounting, or another company / bridge / switch, stops every poller and drops
 * any answer still in flight.
 */
export function useEmailMailStatus(
  bridge: MatrixCompanyBridge,
  companyId: string,
  invitationIds: readonly string[],
  enabled: boolean
): ReadonlyMap<string, CompanyEmailMailStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, CompanyEmailMailStatus>>(new Map())
  const pollers = useRef(new Map<string, Poller>())
  const key = invitationIds.join(',')

  // Identity: everything polled belongs to this bridge, company and switch. A change stops it all and forgets it.
  useEffect(() => {
    const own = pollers.current

    return () => {
      for (const poller of own.values()) {
        poller.stop()
      }

      own.clear()
      setStatuses(previous => (previous.size ? new Map() : previous))
    }
  }, [bridge, companyId, enabled])

  // Membership: start a poller for each new invitation; stop the ones no longer listed. Existing pollers are untouched.
  useEffect(() => {
    if (!enabled) {
      return
    }

    const wanted = new Set(key ? key.split(',') : [])
    const own = pollers.current

    for (const [invitationId, poller] of own) {
      if (!wanted.has(invitationId)) {
        poller.stop()
        own.delete(invitationId)
      }
    }

    for (const invitationId of wanted) {
      if (own.has(invitationId)) {
        continue
      }

      let stopped = false
      let reads = 0
      let timer: ReturnType<typeof setTimeout> | undefined

      const read = async () => {
        reads += 1
        const result = await requestTeamSpace(bridge, { action: 'email-invitation-status', companyId, invitationId })

        if (stopped) {
          return
        }

        const status = result.ok ? result.value.mailStatus : undefined

        if (status) {
          setStatuses(previous => new Map(previous).set(invitationId, status))
        }

        if (!settled(status) && reads < MAIL_STATUS_MAX_READS) {
          timer = setTimeout(() => void read(), MAIL_STATUS_POLL_MS)
        }
      }

      own.set(invitationId, {
        stop() {
          stopped = true

          if (timer) {
            clearTimeout(timer)
          }
        }
      })
      void read()
    }
  }, [bridge, companyId, enabled, key])

  return statuses
}
