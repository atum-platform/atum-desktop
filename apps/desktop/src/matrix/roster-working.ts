import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

/** The rooms where an assistant's turn is running right now: the default agent's live turn
 * and every other agent's (per-agent runtime). Display only. */
export function matrixWorkingRooms(snapshot: MatrixSnapshot): ReadonlySet<string> {
  const rooms = new Set<string>()

  if (snapshot.hermesActivity?.state === 'running') {
    rooms.add(snapshot.hermesActivity.roomId)
  }

  for (const turn of snapshot.agentTurns ?? []) {
    if (turn.activity?.state === 'running') {
      rooms.add(turn.roomId)
    }
  }

  return rooms
}

/** The current human-readable step for one running room; empty transport text stays absent. */
export function matrixWorkingStep(snapshot: MatrixSnapshot, roomId: string): string | undefined {
  const activity =
    snapshot.hermesActivity?.roomId === roomId
      ? snapshot.hermesActivity
      : snapshot.agentTurns?.find(turn => turn.roomId === roomId)?.activity

  if (activity?.state !== 'running') {
    return undefined
  }

  return activity.text.trim() || undefined
}

/**
 * Where the roster shows an agent at work: on the history it is working in when that row is
 * in sight, otherwise on the agent's own row — including the moment between starting a turn
 * and its first activity, when only the agent knows it is busy. Never on both.
 */
export function matrixAgentWorkingRow(
  agent: Pick<MatrixAgentView, 'hermes'>,
  rooms: readonly Pick<MatrixRoom, 'id'>[],
  shown: readonly Pick<MatrixRoom, 'id'>[],
  working: ReadonlySet<string>
): 'agent' | 'history' | null {
  if (shown.some(room => working.has(room.id))) {
    return 'history'
  }

  return agent.hermes === 'running' || rooms.some(room => working.has(room.id)) ? 'agent' : null
}
