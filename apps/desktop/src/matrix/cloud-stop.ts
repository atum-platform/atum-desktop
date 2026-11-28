import type { MatrixCloudStopOutcome, MatrixCloudStopRequest, MatrixLocalTurnView, MatrixMessage } from '../../shared/matrix'
import type { MatrixProgressMarker, MatrixScheduleIdentity } from '../../shared/matrix-progress-marker'
import { matrixWorkingLine } from '../../shared/matrix-transient-lines'

const CLOUD_WORKING: ReadonlySet<MatrixLocalTurnView['state']> = new Set(['waiting', 'running', 'handed_off'])

export function matrixCloudStopTarget(input: {
  messages: readonly MatrixMessage[]
  turns?: readonly MatrixLocalTurnView[]
  roomId: string
  unanswered?: MatrixMessage | null
  working: boolean
  agentId?: string
  roomTimeline?: boolean
}): string | undefined {
  const unanswered = input.unanswered
  const line = input.agentId && matrixWorkingLine(input.messages, new Set([input.agentId]), input.agentId)
  if (line && confirmedProgress(line) && line.progress?.scope === 'owner_private' && !line.progress.trigger &&
      line.replyTo?.startsWith('$')) {
    return line.replyTo
  }

  const candidates = (input.turns ?? [])
    .filter(
      each =>
        each.roomId === input.roomId &&
        each.route === 'cloud' &&
        CLOUD_WORKING.has(each.state) &&
        each.synced.question &&
        !each.synced.answer
    )
    .map(turn => {
      const question = input.messages.findLast(each => each.own && each.turn === turn.turnId)
      const eventId = question?.id.startsWith('$') ? question.id : input.roomTimeline ? turn.questionEventId : undefined

      return { turn, eventId }
    })
    .filter(
      (each): each is { turn: MatrixLocalTurnView; eventId: string } =>
        each.eventId?.startsWith('$') === true
    )

  // The question this room is actually waiting on wins over which turn happens to sit first;
  // among the rest the oldest one is the turn a follow-up queued behind.
  const chosen =
    (unanswered && candidates.find(each => each.eventId === unanswered.id)) ??
    candidates.reduce<(typeof candidates)[number] | undefined>(
      (oldest, each) => (oldest && oldest.turn.createdAt <= each.turn.createdAt ? oldest : each),
      undefined
    )

  if (chosen) {
    return chosen.eventId
  }

  if (!input.working) {
    return undefined
  }

  return unanswered?.own && unanswered.id.startsWith('$') ? unanswered.id : undefined
}

export type MatrixStopRoute =
  | { kind: 'host' | 'legacy'; eventId: string }
  | { kind: 'schedule'; schedule: MatrixScheduleIdentity }
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
  scheduled?: Pick<MatrixProgressMarker, 'schedule'>
}): MatrixStopRoute {
  if (input.runtime === 'hermes' && input.working && input.scheduled) {
    return input.scheduled.schedule ? { kind: 'schedule', schedule: input.scheduled.schedule } : { kind: 'unavailable' }
  }
  if (input.eventId) {
    return { kind: input.runtime === 'hermes' ? 'host' : 'legacy', eventId: input.eventId }
  }
  return { kind: 'unavailable' }
}

export type MatrixStopResult = 'stopped' | 'stopping' | 'settled'

export async function executeMatrixStop(
  route: MatrixStopRoute,
  roomId: string,
  stop: (request: MatrixCloudStopRequest) => Promise<MatrixCloudStopOutcome>
): Promise<MatrixStopResult> {
  if (route.kind === 'unavailable') {
    throw new Error('matrix_stop_unavailable')
  }

  if (route.kind === 'schedule') {
    const outcome = await stop({ action: 'stopSchedule', roomId, schedule: route.schedule })

    if (outcome.state === 'stopped') { return 'stopped' }
    if (outcome.state === 'finished') { return 'settled' }
    if (outcome.state === 'stop_requested') { return 'stopping' }
    throw new Error('matrix_host_stop_unconfirmed')
  }

  const outcome = await stop({ action: 'stopTurn', roomId, eventId: route.eventId })

  return outcome.state === 'stopped' || outcome.state === 'completed' ? 'stopped' : 'stopping'
}

/** Read the native tuple only from the bound agent's active progress line. */
export function matrixCloudStopScheduled(
  messages: readonly MatrixMessage[],
  agentId: string | undefined
): Pick<MatrixProgressMarker, 'schedule'> | undefined {
  if (!agentId) { return undefined }

  const line = matrixWorkingLine(messages, new Set([agentId]), agentId)
  const progress = line?.progress

  if (!line || !progress || !('trigger' in progress) || progress.trigger !== 'cron') {
    return undefined
  }

  return { schedule: confirmedProgress(line) ? progress.schedule : undefined }
}

function confirmedProgress(line: MatrixMessage): boolean {
  return line.id.startsWith('$') && !line.decryptionFailed && !line.pending && !line.failed
}
