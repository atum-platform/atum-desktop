/** Passive slice-1 reader. Caller supplies current platform-admitted binding, never
 * identity inferred from content or room names. Body/UI and legacy offsets are untouched.
 * Mirrors the company 1.6 port's parse-then-admit pattern (31d2268c,
 * shared/matrix-company-presentation.ts matrixAdmitCompanyPresentation).
 * Feed decrypted originals first, then updates in revision order on history load. */
import {
  type FileChip,
  type FileIdentity,
  parseFileAnswer,
  parseFileUpdate
} from '../../../packages/device-protocol/agent-files'
import { canonicalJson } from '../../../packages/device-protocol/canonical'

export interface FileReaderAuthority {
  identity: FileIdentity
  agentUserId: string
  triggerEventId: string
}
export interface FileReaderEvent {
  eventId: string
  roomId: string
  sender: string
  type: string
  content: unknown
  /** From the SDK's verified redaction state, not arbitrary content. */
  redacted?: boolean
}
export interface FileReaderState {
  answerEventId: string
  identity: FileIdentity
  sender: string
  body: string
  files: FileChip[]
  latestUpdateIds: Record<string, string>
  /** A redaction invalidates file presentation; no older retained-draft claim resurfaces. */
  invalidated: boolean
}

function admitted(event: FileReaderEvent, identity: FileIdentity, authority: FileReaderAuthority): boolean {
  return (
    Boolean(authority.agentUserId) &&
    event.sender === authority.agentUserId &&
    event.roomId === authority.identity.roomId &&
    identity.roomId === event.roomId &&
    canonicalJson(identity) === canonicalJson(authority.identity)
  )
}

export function readFileAnswer(event: FileReaderEvent, authority: FileReaderAuthority): FileReaderState | undefined {
  if (event.redacted || event.type !== 'm.room.message' || !/^\$[!-~]{1,1023}$/u.test(event.eventId)) {
    return undefined
  }

  const answer = parseFileAnswer(event.content)

  if (
    !answer ||
    !admitted(event, answer['io.atum.files'].identity, authority) ||
    answer['m.relates_to']['m.in_reply_to'].event_id !== authority.triggerEventId
  ) {
    return undefined
  }

  return {
    answerEventId: event.eventId,
    identity: answer['io.atum.files'].identity,
    sender: event.sender,
    body: answer.body,
    files: answer['io.atum.files'].files,
    latestUpdateIds: {},
    invalidated: false
  }
}

export function reduceFileUpdate(
  state: FileReaderState,
  event: FileReaderEvent,
  authority: FileReaderAuthority
): FileReaderState {
  if (state.invalidated || !admitted(event, state.identity, authority) || event.sender !== state.sender) {
    return state
  }

  if (event.redacted && event.eventId === state.answerEventId) {
    return { ...state, files: [], invalidated: true }
  }

  if (event.redacted && Object.values(state.latestUpdateIds).includes(event.eventId)) {
    return { ...state, files: [], invalidated: true }
  }

  if (event.type !== 'io.atum.files.update') {
    return state
  }

  const update = parseFileUpdate(event.content)

  if (
    !update ||
    update['io.atum.files'].answerEventId !== state.answerEventId ||
    canonicalJson(update['io.atum.files'].identity) !== canonicalJson(state.identity)
  ) {
    return state
  }

  // A known related update's redaction fails closed, without rolling back availability.
  if (event.redacted) {
    return { ...state, files: [], invalidated: true }
  }

  const next = update['io.atum.files'].file
  const previous = state.files.find(file => file.fileKey === next.fileKey)

  if (
    !previous ||
    next.revision <= previous.revision ||
    ['saved', 'saved_as_copy', 'expired'].includes(previous.state) ||
    (previous.state === 'not_confirmed' && next.state === 'saving')
  ) {
    return state
  }

  return {
    ...state,
    files: state.files.map(file => (file.fileKey === next.fileKey ? next : file)),
    latestUpdateIds: { ...state.latestUpdateIds, [next.fileKey]: event.eventId }
  }
}
