import type { MatrixSnapshot } from '../../../shared/matrix'
import type { PetSignals } from '../../../shared/pet-engine/types'

/** How long a message that could not be sent shows on the companion. The chat keeps showing the
 * unsent message and its retry; the pet only reacts, then goes back to her day. A turn whose
 * failure time is unknown (kept from before 0.19.4) is history, not news. */
export const PET_FAILED_MS = 30_000

type LocalTurn = NonNullable<MatrixSnapshot['localTurns']>[number]

function latestLocalTurn(snapshot: MatrixSnapshot): LocalTurn | undefined {
  return snapshot.localTurns
    ?.filter(value => value.roomId === snapshot.roomId)
    .reduce<LocalTurn | undefined>((latest, value) => (!latest || value.createdAt > latest.createdAt ? value : latest), undefined)
}

/** Until when the room's latest unsent message still counts as news, or null when it doesn't. */
function failureShownUntil(snapshot: MatrixSnapshot, now: number): number | null {
  const local = latestLocalTurn(snapshot)

  if (local?.state !== 'not_sent' || typeof local.failedAt !== 'number') {
    return null
  }

  const until = local.failedAt + PET_FAILED_MS

  return now < until ? until : null
}

/** Reads only existing room-scoped presentation facts; it grants no execution authority. */
export function petWorkFor(snapshot: MatrixSnapshot, now: number = Date.now()): PetSignals['work'] {
  const room = snapshot.roomId
  const turn = snapshot.agentTurns?.find(value => value.roomId === room)

  if ((snapshot.hermesPrompts?.roomId === room && snapshot.hermesPrompts.prompts.length) || turn?.prompts?.length) {
    return 'waiting'
  }

  if (
    (snapshot.hermesActivity?.roomId === room && snapshot.hermesActivity.state === 'running') ||
    turn?.activity?.state === 'running'
  ) {
    return 'working'
  }

  const local = latestLocalTurn(snapshot)

  if (local?.state === 'running') {
    return 'working'
  }

  if (failureShownUntil(snapshot, now) !== null) {
    return 'failed'
  }

  return 'idle'
}

/** When `petWorkFor` changes on its own, with no new snapshot: a failure's reaction ending. */
export function petWorkChangesAt(snapshot: MatrixSnapshot, now: number = Date.now()): number | null {
  return petWorkFor(snapshot, now) === 'failed' ? failureShownUntil(snapshot, now) : null
}
