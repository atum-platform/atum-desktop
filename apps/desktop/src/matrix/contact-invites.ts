import { useEffect, useRef, useState } from 'react'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixAliasBridge } from '../../shared/matrix-aliases'

import { directRoomWith } from './people'
import type { PersonInviteOutcome } from './person-search'
import type { MatrixInviteJoinRequest } from './team-space/invite-join'

/**
 * Personal "join Atum" invitations (owner 2026-11-25, platform 0550). Sending one reuses the
 * alias transport (`/aliases/invite`); the mail, its link and the `/j` page are the Team Space
 * invitation's own. The invitee opens the link in Atum once signed up: the same `atum://join`
 * hand-off as a team invite, so the request is offered to the contact invitation first and only
 * a link that is not one goes on to Team Space.
 */
export async function inviteContactByEmail(
  bridge: MatrixAliasBridge | undefined,
  email: string,
  locale: 'vi' | 'en'
): Promise<PersonInviteOutcome> {
  if (!bridge) {
    return 'failed'
  }

  try {
    const result = await bridge.request({ action: 'invite', email, locale, requestId: globalThis.crypto.randomUUID() })

    if (!result.ok) {
      return result.error === 'limit' ? 'limited' : 'failed'
    }

    return result.value.kind === 'invite' ? (result.value.state === 'invited' ? 'invited' : 'limited') : 'failed'
  } catch {
    return 'failed'
  }
}

export type ContactAcceptOutcome =
  | { state: 'accepted'; inviterMatrixUser: string }
  /** Not a contact invitation (or no longer one): the link goes on to Team Space as before. */
  | { state: 'other' }

export async function acceptContactInvite(bridge: MatrixAliasBridge | undefined, token: string): Promise<ContactAcceptOutcome> {
  if (!bridge) {
    return { state: 'other' }
  }

  try {
    const result = await bridge.request({ action: 'accept', token })

    return result.ok && result.value.kind === 'accept' && result.value.state === 'accepted'
      ? { state: 'accepted', inviterMatrixUser: result.value.inviterMatrixUser }
      : { state: 'other' }
  } catch {
    return { state: 'other' }
  }
}

/**
 * Offers an opened join link to the contact invitation once per request, for the account that is
 * ready. While the answer is out the request is `checking`, so Team Space waits; an accepted one
 * opens the chat with the inviter (an existing one, or a new direct chat) and ends the request.
 */
export function useContactInviteAccept({
  bridge,
  onAccepted,
  ready,
  request,
  snapshot
}: {
  bridge: MatrixAliasBridge | undefined
  onAccepted(inviterMatrixUser: string, roomId: string | undefined): void
  ready: boolean
  request: MatrixInviteJoinRequest | null
  snapshot: MatrixSnapshot
}): 'checking' | 'settled' {
  const [settled, setSettled] = useState<number | undefined>(undefined)
  const asked = useRef<number | undefined>(undefined)
  const latest = useRef({ onAccepted, snapshot })
  latest.current = { onAccepted, snapshot }
  const serial = request?.serial
  const token = request?.token

  useEffect(() => {
    if (!ready || serial === undefined || !token || asked.current === serial) {
      return
    }

    asked.current = serial
    void acceptContactInvite(bridge, token).then(outcome => {
      if (outcome.state === 'accepted') {
        const { onAccepted, snapshot } = latest.current
        onAccepted(outcome.inviterMatrixUser, directRoomWith(snapshot, outcome.inviterMatrixUser)?.id)
      }

      setSettled(serial)
    })
  }, [bridge, ready, serial, token])

  // A paste flow (no token yet) and a settled request belong to Team Space.
  return serial === undefined || !token || settled === serial ? 'settled' : 'checking'
}
