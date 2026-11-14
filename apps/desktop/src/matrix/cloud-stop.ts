import type { MatrixCloudStopOutcome, MatrixLocalTurnView, MatrixMessage } from '../../shared/matrix'

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

export type MatrixStopRoute =
  | { kind: 'host' | 'legacy'; eventId: string }
  | { kind: 'native' }
  | { kind: 'unavailable' }

/** Legacy agents hide Stop without a source; only Hermes advertises an unresolved target. */
export function matrixShowCloudStop(input: {
  eventId?: string
  cloud: boolean
  runtime?: 'hermes'
  working: boolean
}): boolean {
  return Boolean(input.eventId || (input.cloud && input.runtime === 'hermes' && input.working))
}

/** Only the owner-scoped roster's explicit runtime opts into the host contract. */
export function matrixStopRoute(input: {
  runtime?: 'hermes'
  eventId?: string
  working: boolean
  scheduled?: boolean
}): MatrixStopRoute {
  if (input.runtime === 'hermes' && input.working && input.scheduled) {
    return { kind: 'native' }
  }
  if (input.eventId) {
    return { kind: input.runtime === 'hermes' ? 'host' : 'legacy', eventId: input.eventId }
  }
  return { kind: 'unavailable' }
}

/** `stopping`: the turn was cut but the agent has not confirmed it stopped; `sent`: an in-room `/stop`. */
export type MatrixStopResult = 'stopped' | 'stopping' | 'sent'

export async function executeMatrixStop(
  route: MatrixStopRoute,
  stop: (eventId: string) => Promise<MatrixCloudStopOutcome>,
  send: (body: string) => Promise<unknown>
): Promise<MatrixStopResult> {
  if (route.kind === 'unavailable') {
    throw new Error('matrix_stop_unavailable')
  }

  if (route.kind === 'native') {
    await send('/stop')

    return 'sent'
  }

  const outcome = await stop(route.eventId)

  return outcome.state === 'stopped' || outcome.state === 'completed' ? 'stopped' : 'stopping'
}

/** The bound agent's latest progress line identifies a cron turn explicitly. */
export function matrixCloudStopScheduled(messages: readonly MatrixMessage[], agentId: string | undefined): boolean {
  const progress = messages.findLast(message =>
    message.sender === agentId && !message.own && !message.redacted &&
    (message.progress || (!message.notice && !message.interim))
  )?.progress
  return Boolean(progress && 'trigger' in progress && progress.trigger === 'cron' && progress.phase !== 'settled')
}
