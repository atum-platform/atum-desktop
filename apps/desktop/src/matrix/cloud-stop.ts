import type { MatrixLocalTurnView, MatrixMessage } from '../../shared/matrix'

const CLOUD_WORKING: ReadonlySet<MatrixLocalTurnView['state']> = new Set(['waiting', 'running', 'handed_off'])

export function matrixCloudStopTarget(input: {
  messages: readonly MatrixMessage[]
  turns?: readonly MatrixLocalTurnView[]
  roomId: string
  unanswered?: MatrixMessage | null
  working: boolean
}): string | undefined {
  const unanswered = input.unanswered

  const candidates = (input.turns ?? [])
    .filter(
      each =>
        each.roomId === input.roomId &&
        each.route === 'cloud' &&
        CLOUD_WORKING.has(each.state) &&
        each.synced.question &&
        !each.synced.answer
    )
    .map(turn => ({ turn, question: input.messages.findLast(each => each.own && each.turn === turn.turnId) }))
    .filter(
      (each): each is { turn: MatrixLocalTurnView; question: MatrixMessage } =>
        each.question?.id.startsWith('$') === true
    )

  // The question this room is actually waiting on wins over which turn happens to sit first;
  // among the rest the oldest one is the turn a follow-up queued behind.
  const chosen =
    (unanswered && candidates.find(each => each.question.id === unanswered.id)) ??
    candidates.reduce<(typeof candidates)[number] | undefined>(
      (oldest, each) => (oldest && oldest.turn.createdAt <= each.turn.createdAt ? oldest : each),
      undefined
    )

  if (chosen) {
    return chosen.question.id
  }

  if (!input.working) {
    return undefined
  }

  return unanswered?.own && unanswered.id.startsWith('$') ? unanswered.id : undefined
}
