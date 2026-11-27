import {
  M_POLL_END,
  M_POLL_KIND_DISCLOSED,
  M_POLL_KIND_UNDISCLOSED,
  M_POLL_RESPONSE,
  M_POLL_START,
  type MatrixClient,
  MatrixEvent,
  Poll,
  type PollEndEventContent,
  PollEvent,
  type PollResponseEventContent,
  type PollStartEventContent,
  type Room
} from 'matrix-js-sdk'
import { PollEndEvent } from 'matrix-js-sdk/lib/extensible_events_v1/PollEndEvent'
import { PollResponseEvent } from 'matrix-js-sdk/lib/extensible_events_v1/PollResponseEvent'
import { PollStartEvent } from 'matrix-js-sdk/lib/extensible_events_v1/PollStartEvent'
import { type Relations, RelationsEvent } from 'matrix-js-sdk/lib/models/relations'

import type { MatrixPoll, MatrixPollCommand } from '../../../shared/matrix-rich-content'

// The SDK models and serializes responses but 42.4.0 omits this member from its sendEvent map.
declare module 'matrix-js-sdk' {
  interface TimelineEvents {
    'org.matrix.msc3381.poll.response': PollResponseEventContent
  }
}

const pollRelations = new WeakMap<Poll, { responses?: Relations; loading: Promise<Relations> }>()

export function matrixPollStart(event: MatrixEvent): PollStartEvent | undefined {
  if (!M_POLL_START.matches(event.getType()) || event.isRedacted()) {
    return undefined
  }

  try {
    return new PollStartEvent({ type: M_POLL_START.name, content: event.getOriginalContent() })
  } catch {
    return undefined
  }
}

function latestAnswers(start: PollStartEvent, responses: MatrixEvent[]) {
  const latest = new Map<string, MatrixEvent>()

  for (const event of responses) {
    const sender = event.getSender()

    if (!sender || event.isRedacted() || event.status === 'not_sent') {
      continue
    }

    const previous = latest.get(sender)

    if (!previous || event.getTs() > previous.getTs() ||
      (event.getTs() === previous.getTs() && (event.getId() ?? '') > (previous.getId() ?? ''))) {
      latest.set(sender, event)
    }
  }

  return new Map([...latest].map(([sender, event]) => {
    try {
      const vote = new PollResponseEvent({ type: M_POLL_RESPONSE.name, content: event.getContent() })
      vote.validateAgainst(start)

      return [sender, vote.spoiled ? [] : [...new Set(vote.answerIds)]]
    } catch {
      return [sender, []]
    }
  }))
}

export function matrixPollView(event: MatrixEvent, ownUserId: string | null, room?: Room): MatrixPoll | undefined {
  const start = matrixPollStart(event)

  if (!start) {
    return undefined
  }

  const poll = room?.polls?.get(event.getId() ?? '')
  const relations = poll && pollRelations.get(poll)?.responses
  const ended = poll?.isEnded ?? false
  const undisclosed = !M_POLL_KIND_DISCLOSED.matches(start.rawKind)
  const latest = latestAnswers(start, relations?.getRelations() ?? [])
  const results = new Map<string, number>()

  if (relations && (ended || !undisclosed)) {
    for (const answers of latest.values()) {
      for (const id of answers) {
        results.set(id, (results.get(id) ?? 0) + 1)
      }
    }
  }

  const canSend = ownUserId !== null && room?.getMyMembership() === 'join' && !ended
  const complete = Boolean(relations && !poll?.isFetchingResponses && !poll?.undecryptableRelationsCount)

  return {
    question: start.question.text,
    answers: start.answers.map(answer => ({
      id: answer.id,
      text: answer.text,
      ...(complete && (ended || !undisclosed) ? { votes: results.get(answer.id) ?? 0 } : {})
    })),
    selected: (ownUserId ? latest.get(ownUserId) : undefined) ?? [],
    maxSelections: start.maxSelections,
    ended,
    undisclosed,
    ...(relations ? { ready: true as const } : {}),
    ...(relations && canSend && room.currentState.maySendEvent(M_POLL_RESPONSE.name, ownUserId)
      ? { canVote: true as const } : {}),
    ...(relations && canSend && room.currentState.maySendEvent(M_POLL_END.name, ownUserId) &&
      (event.getSender() === ownUserId || room.currentState.maySendRedactionForEvent(event, ownUserId))
      ? { canEnd: true as const } : {})
  }
}

async function loadPoll(client: MatrixClient, room: Room, eventId: string, changed: () => void) {
  let poll = room.polls.get(eventId)

  if (!poll) {
    const root = room.findEventById(eventId) ?? new MatrixEvent(await client.fetchRoomEvent(room.roomId, eventId))
    await client.decryptEventIfNeeded(root)

    if (!matrixPollStart(root)) {
      throw new Error('matrix_poll_unavailable')
    }

    poll = new Poll(root, client, room)
    room.polls.set(eventId, poll)
  }

  if (poll.rootEvent.isRedacted() || !poll.pollEvent) {
    throw new Error('matrix_poll_unavailable')
  }

  if (!pollRelations.has(poll)) {
    const watched = poll

    const update = (responses: Relations) => {
      const observed = pollRelations.get(watched)

      if (observed && observed.responses !== responses) {
        observed.responses = responses
        responses.on(RelationsEvent.Remove, changed)
        responses.on(RelationsEvent.Redaction, changed)
      }

      changed()
    }

    watched.on(PollEvent.Responses, update)
    watched.on(PollEvent.End, changed)

    const loading = Promise.resolve().then(() => watched.getResponses()).then(responses => {
      update(responses)

      return responses
    }).catch((error: unknown) => {
      watched.off(PollEvent.Responses, update)
      watched.off(PollEvent.End, changed)
      pollRelations.delete(watched)

      // The SDK does not reset its fetching flag after a rejected first request.
      if (room.polls.get(eventId) === watched) {
        room.polls.delete(eventId)
      }

      throw error
    })

    pollRelations.set(watched, { loading })
  }

  await pollRelations.get(poll)?.loading

  return poll
}

export async function matrixPollCommand(
  client: MatrixClient,
  room: Room,
  userId: string,
  command: MatrixPollCommand,
  changed: () => void
) {
  if (command.kind === 'pollCreate') {
    const start = PollStartEvent.from(command.question, command.options,
      command.undisclosed ? M_POLL_KIND_UNDISCLOSED : M_POLL_KIND_DISCLOSED)

    return client.sendEvent(room.roomId, M_POLL_START.name, start.serialize().content as PollStartEventContent)
  }

  const poll = await loadPoll(client, room, command.eventId, changed)
  const projection = matrixPollView(poll.rootEvent, userId, room)
  const kind = command.kind

  if (kind === 'pollRead') {
    return projection
  }

  if (kind === 'pollVote') {
    if (!projection?.canVote || command.answers.length > projection.maxSelections ||
      command.answers.some(id => !projection.answers.some(answer => answer.id === id))) {
      throw new Error('matrix_poll_unavailable')
    }

    const response = PollResponseEvent.from(command.answers, command.eventId)

    return client.sendEvent(room.roomId, M_POLL_RESPONSE.name, response.wireContent)
  }

  if (!projection?.canEnd) {
    throw new Error('matrix_poll_unavailable')
  }

  const end = PollEndEvent.from(command.eventId, 'Poll closed')

  return client.sendEvent(room.roomId, M_POLL_END.name, end.serialize().content as PollEndEventContent)
}
