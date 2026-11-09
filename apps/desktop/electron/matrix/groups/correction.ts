import type { MatrixInvocationMessage } from '../../../shared/matrix'

import { requireGroupOwnerEvent } from './floor'

interface TrackedGroupTurn {
  roomId: string
  eventId: string
  abort: AbortController
}

/**
 * A fresh, verified owner reply supersedes work for the message it quotes. The
 * reply itself remains an ordinary group message and is routed after the older
 * work is stopped.
 */
export function groupCorrectionTarget(
  message: MatrixInvocationMessage,
  input: { roomId: string; eventId: string; ownerId: string; since: number; acceptedAt: number }
): string | undefined {
  const accepted = requireGroupOwnerEvent(message, input)

  return accepted.related === true ? accepted.content.replyTo : undefined
}

export class GroupTurnCorrections {
  private readonly turns = new Set<TrackedGroupTurn>()

  track(turn: TrackedGroupTurn): () => void {
    this.turns.add(turn)

    return () => this.turns.delete(turn)
  }

  apply(roomId: string, eventId: string): number {
    let stopped = 0

    for (const turn of this.turns) {
      if (turn.roomId === roomId && turn.eventId === eventId && !turn.abort.signal.aborted) {
        turn.abort.abort(new Error('matrix_group_corrected'))
        stopped++
      }
    }

    return stopped
  }
}

/** Revalidate immediately before enqueueing a group publication. */
export async function publishCurrentGroupTurn<T>(
  signal: AbortSignal,
  revalidate: () => Promise<unknown>,
  publish: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  await revalidate()
  signal.throwIfAborted()

  return publish()
}
