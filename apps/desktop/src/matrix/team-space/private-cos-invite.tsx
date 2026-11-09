import { useEffect, useRef } from 'react'

import type { MatrixRoom } from '../../../shared/matrix'
import { MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE } from '../../../shared/matrix-company-private-cos'

import {
  companyPrivateCosBoundRoomId,
  companyPrivateCosJoinedRoomMatches,
  type CompanyPrivateCosState
} from './private-cos-store'

/** The one invited room this current owner pair may accept automatically. */
export function companyPrivateCosInvitation(
  state: CompanyPrivateCosState | undefined,
  companyId: string | undefined,
  activeMember: boolean,
  rooms: readonly MatrixRoom[]
): MatrixRoom | undefined {
  if (!state || !companyId || !activeMember || state.availability === 'unavailable') {
    return undefined
  }

  const pair = state.view.pair

  if (pair.companyPrincipal !== companyId) {
    return undefined
  }

  const roomId = companyPrivateCosBoundRoomId(state)

  return roomId
    ? rooms.find(room => room.id === roomId &&
      room.membership === 'invite' &&
      room.roomType === MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE)
    : undefined
}

export interface PrivateCosAutoJoinProps {
  accountKey: string
  activeMember: boolean
  companyId?: string
  rooms: readonly MatrixRoom[]
  state?: CompanyPrivateCosState
  onAccept?(roomId: string): Promise<void>
  onReject?(roomId: string): Promise<void>
  onVerified?(roomId: string): Promise<void>
}

/** Automatic owner-rule admission. It renders nothing and asks no consent question. */
export function PrivateCosAutoJoin({
  accountKey,
  activeMember,
  companyId,
  onAccept,
  onReject,
  onVerified,
  rooms,
  state
}: PrivateCosAutoJoinProps) {
  const attempted = useRef<string | undefined>(undefined)
  const resolved = useRef<string | undefined>(undefined)

  useEffect(() => {
    const boundRoomId = companyPrivateCosBoundRoomId(state)
    const joined = boundRoomId ? rooms.find(room => room.id === boundRoomId && room.membership === 'join') : undefined

    if (joined) {
      const fullState = joined.roomVersion !== undefined &&
        joined.joinRule !== undefined &&
        joined.historyVisibility !== undefined &&
        joined.powerLevels !== undefined &&
        joined.participants !== undefined
      const key = [accountKey, companyId, state?.view.pair.membershipIncarnation, joined.id, 'verified'].join('\0')

      if (!fullState || resolved.current === key) {
        return
      }

      resolved.current = key
      const action = companyPrivateCosJoinedRoomMatches(state, joined) ? onVerified : onReject

      if (action) {
        void action(joined.id)
      }

      return
    }

    const room = companyPrivateCosInvitation(state, companyId, activeMember, rooms)

    if (!room || !onAccept) {
      return
    }

    const key = [accountKey, companyId, state?.view.pair.membershipIncarnation, room.id].join('\0')

    if (attempted.current === key) {
      return
    }

    attempted.current = key
    let current = true

    void onAccept(room.id).catch(() => {
      if (current && attempted.current === key) {
        attempted.current = undefined
      }
    })

    return () => {
      current = false
    }
  }, [accountKey, activeMember, companyId, onAccept, onReject, onVerified, rooms, state])

  return null
}
