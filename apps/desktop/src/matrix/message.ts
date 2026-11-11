import { EventStatus, EventType, type MatrixEvent, RelationType, type Room } from 'matrix-js-sdk'

import { validStopEvent } from '../../../../packages/device-protocol/stop-target'
import {
  MATRIX_REACTION_KEY_MAX,
  matrixAttachmentMsgtype,
  type MatrixMessage,
  type MatrixReaction
} from '../../shared/matrix'
import { matrixAnswerWarning, matrixResultStatusNotice, matrixStatusLine } from '../../shared/matrix-agent-status-marker'
import { plainRoom } from '../../shared/matrix-assistant-room'
import { MATRIX_CHECK_IN_NUDGE_KEY, parseMatrixCheckInNudge } from '../../shared/matrix-check-ins'
import {
  companyRoomTargetBinding,
  MATRIX_COMPANY_CHANNEL_TYPE,
  MATRIX_COMPANY_CONVERSATION_TYPE
} from '../../shared/matrix-company-channel-room'
import { MATRIX_COMPANY_FILE, matrixCompanyFileContent } from '../../shared/matrix-company-files'
import {
  matrixCompanyPresentationClaimed,
  matrixCompanyPresentationContent,
  type MatrixCompanyPresentationContent,
  matrixCompanyPresentationEdit,
  sameMatrixCompanyTurn
} from '../../shared/matrix-company-presentation'
import {
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
  matrixCompanyPrivateCosRoomBinding
} from '../../shared/matrix-company-private-cos-claim'
import { matrixDecryptionReason } from '../../shared/matrix-decryption-reason'
import { matrixInterimMarker } from '../../shared/matrix-interim-marker'
import { parseMatrixPetReply } from '../../shared/matrix-pet-intent'
import { matrixProgressMarker, matrixProgressPresentation } from '../../shared/matrix-progress-marker'
import { MATRIX_CRON_KEY, matrixTurnMarker } from '../../shared/matrix-turn'

import { parseBotApiMessage } from './app-bots/bot-api'
import { MATRIX_FORWARDED_KEY } from './forward-content'
import { matrixMentionProjection } from './matrix-mentions'
import { matrixReplyRoot } from './reply-relation'
import { parseCompanyBoardLink } from './team-space/board-link-target'

/** People named on one reaction's tip, at most. */
const REACTION_SENDERS_MAX = 20

/** A file's size as its event states it: a whole number of bytes, or nothing. */
function attachmentSize(info: unknown): number | undefined {
  const size = (info as { size?: unknown } | null | undefined)?.size

  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The relation an event carries: outside its ciphertext when encrypted, else in its content. */
function relationOf(event: MatrixEvent): Record<string, unknown> | undefined {
  return record(event.getWireContent()['m.relates_to']) ?? record(event.getOriginalContent()['m.relates_to'])
}

/** The immutable create binding is the only room-local authority for a protected file reference. */
export function companyChannelBinding(room: Room | undefined) {
  const creation = room?.currentState.getStateEvents(EventType.RoomCreate, '')

  return creation ? companyRoomTargetBinding(creation.getContent(), creation.getSender()) : undefined
}

/**
 * A company agent's working line or interim remark (agent-turns/1.6) as far as this room can check
 * it: a strict content (the accepted edit's full new content, when edited: `shownContent`) whose
 * identity is the original's and whose revision is above it; the event's own `m.thread` relation to the marker's root; the marker
 * naming this room; and its company and audience matching the room's immutable binding (a channel's
 * create binding, or a private Chief of Staff room's exact state marker). The renderer then requires
 * the sender to be the room's bound agent. Anything else is not company presentation.
 */
export function companyPresentationOf(
  event: MatrixEvent,
  original: Record<string, unknown>,
  content: Record<string, unknown>,
  edited: boolean,
  room: Room | undefined
): MatrixCompanyPresentationContent | undefined {
  const shown = matrixCompanyPresentationContent(content)
  const first = edited ? matrixCompanyPresentationContent(original) : shown

  if (
    !room ||
    !shown ||
    !first ||
    first.stream !== shown.stream ||
    !sameMatrixCompanyTurn(first.identity, shown.identity) ||
    (edited ? shown.identity.revision <= first.identity.revision : shown.identity.revision !== first.identity.revision)
  ) {
    return undefined
  }

  const relation = relationOf(event)
  const roomId = event.getRoomId() ?? room.roomId

  if (
    relation?.rel_type !== 'm.thread' ||
    relation.event_id !== shown.identity.threadRootEventId ||
    roomId !== room.roomId ||
    shown.identity.roomId !== roomId
  ) {
    return undefined
  }

  const audience = shown.identity.audience

  if (audience.kind === 'channel') {
    const binding = companyChannelBinding(room)

    return binding?.target.kind === 'channel' &&
      binding.companyId === shown.identity.companyId &&
      binding.target.channelId === audience.channelId
      ? shown
      : undefined
  }

  const marker = room.currentState.getStateEvents(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, '')

  const binding = marker && !Array.isArray(marker)
    ? matrixCompanyPrivateCosRoomBinding(room.getType(), marker.getType(), marker.getStateKey(), marker.getContent())
    : undefined

  return binding?.companyId === shown.identity.companyId &&
    binding.membershipIncarnation === audience.membershipIncarnation
    ? shown
    : undefined
}

function privateCosGreetingLinks(
  event: MatrixEvent,
  content: Record<string, unknown>,
  room: Room | undefined
): Pick<MatrixMessage, 'privateCosAgentPill' | 'privateCosBoardLink'> | undefined {
  const marker = room?.currentState.getStateEvents(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, '')

  if (!room || !marker || Array.isArray(marker) || !matrixCompanyPrivateCosRoomBinding(
    room.getType(),
    marker.getType(),
    marker.getStateKey(),
    marker.getContent()
  )) {
    return undefined
  }

  const userId = event.getSender()
  if (!userId || !/^@[!-9;-~]{1,255}:[!-~]{1,255}$/u.test(userId)) {
    return undefined
  }

  const label = '@Chief of Staff' as const
  const href = `https://matrix.to/#/${userId}`
  const anchor = `<a href="${href}">${label}</a>`
  const formatted = typeof content.formatted_body === 'string' ? content.formatted_body : ''
  const board = /<br><br><a href="([^"]+)">([^<>]{1,160})<\/a>$/u.exec(formatted)
  const boardHref = board?.[1]
  const boardTitle = board?.[2]

  return content.format === 'org.matrix.custom.html' &&
    formatted.includes(anchor) &&
    typeof content.body === 'string' &&
    content.body.includes(label) &&
    boardHref &&
    boardTitle &&
    parseCompanyBoardLink(boardHref) &&
    content.body.endsWith(`\n\n${boardTitle}: ${boardHref}`)
    ? {
        privateCosAgentPill: { userId, label, href },
        privateCosBoardLink: { title: boardTitle, href: boardHref }
      }
    : undefined
}

type Shown = { content: Record<string, unknown>; edited: boolean; editedAt?: number }

/** A replacement that may count at all: the original sender's, readable, not taken back. */
function usableReplacement(replacement: MatrixEvent | undefined, sender: string | undefined): replacement is MatrixEvent {
  return (
    replacement !== undefined &&
    replacement.getSender() === sender &&
    !replacement.isDecryptionFailure() &&
    !replacement.isRedacted() &&
    replacement.status !== EventStatus.CANCELLED
  )
}

const settledCompanyContent = (content: MatrixCompanyPresentationContent) =>
  content.stream === 'progress' && content.progress.phase === 'settled'

/**
 * A company line's or remark's current content (agent-turns/1.6): every edit of its sender is read
 * whole (`matrixCompanyPresentationEdit`) and must keep the original's identity. Revisions only go up:
 * edits apply in revision order (of conflicting edits of one revision the lowest event ID counts, and a
 * retry of a revision already shown is ignored), however late one
 * arrives, so a later-sent lower revision never replaces a higher one. Settled is a terminal fence:
 * once the original or an accepted edit says settled, nothing after it is read, so a late edit never
 * resurrects the line. Without a valid edit the original shows unedited. This reads only the edits that
 * survive; a settled fact seen once outlives a later redaction of its edit in the renderer's turn memory
 * (`matrixHideEndedTransientLines`).
 */
function companyShownContent(event: MatrixEvent, original: Record<string, unknown>, room: Room | undefined): Shown {
  const first = matrixCompanyPresentationContent(original)
  const id = event.getId()

  if (!first || !id || settledCompanyContent(first)) {
    return { content: original, edited: false }
  }

  const sender = event.getSender()

  const candidates = new Set(
    room?.relations.getChildEventsForEvent(id, RelationType.Replace, EventType.RoomMessage)?.getRelations() ?? []
  )

  const latest = event.replacingEvent()

  if (latest) {
    candidates.add(latest)
  }

  const accepted = [...candidates]
    .flatMap(replacement => {
      if (!usableReplacement(replacement, sender)) {
        return []
      }

      const content = replacement.getContent()
      const next = matrixCompanyPresentationEdit({ ...content, 'm.relates_to': relationOf(replacement) }, id)

      return next &&
        next.stream === first.stream &&
        sameMatrixCompanyTurn(first.identity, next.identity) &&
        next.identity.revision > first.identity.revision
        ? [
            {
              next,
              content: content['m.new_content'] as Record<string, unknown>,
              at: replacement.getTs(),
              id: replacement.getId() ?? ''
            }
          ]
        : []
    })
    // Conflicting edits of one revision: the lowest event ID wins, whatever their timestamps or the
    // order they arrived in, so every client shows the same one.
    .sort(
      (left, right) =>
        left.next.identity.revision - right.next.identity.revision ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    )

  let shown: (typeof accepted)[number] | undefined

  for (const edit of accepted) {
    if (shown?.next.identity.revision === edit.next.identity.revision) {
      continue
    }

    shown = edit

    if (settledCompanyContent(edit.next)) {
      break
    }
  }

  return shown ? { content: shown.content, edited: true, editedAt: shown.at } : { content: original, edited: false }
}

/**
 * What a message shows now: its sender's latest standard edit (`m.replace`), or what it said
 * first. The SDK applies a replacement only from the same sender, but a server's bundled
 * edit skips that check, so it is made here again; a replacement still being decrypted, or
 * without a text body, leaves the message as it was. A company line or remark (agent-turns/1.6)
 * follows its own edit rules (`companyShownContent`), which need the room's relations.
 */
export function shownContent(event: MatrixEvent, room?: Room): Shown {
  const original = event.getOriginalContent()

  if (matrixCompanyPresentationClaimed(original)) {
    return companyShownContent(event, original, room)
  }

  const replacement = event.replacingEvent() ?? undefined

  if (!usableReplacement(replacement, event.getSender())) {
    return { content: original, edited: false }
  }

  const next = record(replacement.getContent()['m.new_content'])

  return next && typeof next.body === 'string' && typeof next.msgtype === 'string' && !matrixAttachmentMsgtype(original.msgtype)
    ? { content: next, edited: true, editedAt: replacement.getTs() }
    : { content: original, edited: false }
}

/**
 * A message's reactions: one count per person per key, whatever their apps sent (a second
 * identical reaction, or one still being taken back, never counts twice), most used first.
 */
export function matrixReactions(
  room: Room | undefined,
  eventId: string,
  ownUserId: string | null,
  ignored: ReadonlySet<string>
): MatrixReaction[] | undefined {
  const annotations = room?.relations
    .getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction)
    ?.getSortedAnnotationsByKey()

  if (!annotations?.length) {
    return undefined
  }

  const reactions: MatrixReaction[] = []

  for (const [key, events] of annotations) {
    if (typeof key !== 'string' || !key.trim() || [...key].length > MATRIX_REACTION_KEY_MAX) {
      continue
    }

    const senders = new Set<string>()

    for (const reaction of events) {
      const sender = reaction.getSender()

      if (
        !sender ||
        ignored.has(sender) ||
        reaction.isRedacted() ||
        reaction.localRedactionEvent() ||
        reaction.status === EventStatus.CANCELLED ||
        reaction.status === EventStatus.NOT_SENT
      ) {
        continue
      }

      senders.add(sender)
    }

    if (senders.size > 0) {
      reactions.push({
        key,
        count: senders.size,
        own: Boolean(ownUserId && senders.has(ownUserId)),
        senders: [...senders].slice(0, REACTION_SENDERS_MAX)
      })
    }
  }

  // Stable: equal counts keep the order people first reacted in.
  return reactions.length ? reactions.sort((left, right) => right.count - left.count) : undefined
}

/**
 * Display projection of one timeline event. Markers are correlation, never authority.
 *
 * `plainConfirmed`: the SDK's decision for this room by the crypto store as well as the synced
 * state (plain-room.ts `confirmedPlainRoom`, computed asynchronously and passed in). A plain media
 * URL shows as a file only with it; until it is known the room counts as encrypted.
 */
export function matrixMessage(
  event: MatrixEvent,
  ownUserId: string | null,
  ignored: ReadonlySet<string>,
  room?: Room,
  petLive = false,
  plainConfirmed = false
): MatrixMessage | null {
  if (ignored.has(event.getSender() ?? '')) {
    return null
  }

  // An edit is not a message of its own: it changes the one it replaces (below), as a
  // reaction decorates one. Neither ever shows as a bubble, even unreadable.
  if (event.isRelation(RelationType.Replace)) {
    return null
  }

  const deleted = event.isRedacted() || Boolean(event.localRedactionEvent())

  if (deleted) {
    // A deleted message keeps its place as one quiet line. Once deleted, an encrypted event
    // no longer says what it was, but reactions and redactions are never encrypted: an
    // encrypted event that was deleted was a message.
    if (event.getType() !== EventType.RoomMessage && event.getWireType() !== EventType.RoomMessageEncrypted) {
      return null
    }

    return {
      id: event.getId() ?? '',
      sender: event.getSender() ?? '',
      body: '',
      timestamp: event.getTs(),
      own: event.getSender() === ownUserId,
      encrypted: event.isEncrypted(),
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      redacted: true
    }
  }

  const failed = event.isDecryptionFailure()

  if (event.getType() !== EventType.RoomMessage && !failed) {
    return null
  }

  // Markers and relations come from the message as first sent; only what it shows follows
  // its sender's latest edit.
  const original = event.getOriginalContent()
  const { content, edited, editedAt } = failed ? { content: original, edited: false } : shownContent(event, room)
  const mentions = failed ? undefined : matrixMentionProjection(content['m.mentions'])
  const privateCosGreeting = failed ? undefined : privateCosGreetingLinks(event, content, room)
  // Versioned bot-api presentation metadata is read from a bot's own event only. The renderer
  // rechecks the sender against the signed catalog before it draws a photo or formatted text; a
  // human or any other member carrying the key never becomes bot UI.
  const botApi =
    !failed && event.getSender() !== ownUserId
      ? parseBotApiMessage({
          sender: event.getSender(),
          own: false,
          content: original,
          formattedBody:
            original.format === 'org.matrix.custom.html' ? original.formatted_body : undefined
        })
      : undefined
  // A handed-off question's marker correlates too: its sending Mac shows it once.
  const turn = failed ? undefined : matrixTurnMarker(original)
  const relation = relationOf(event)
  const resultFor = matrixReplyRoot(original) ?? (relation ? matrixReplyRoot({ 'm.relates_to': relation }) : undefined)

  // Old answers are thread relations; any other thread message comes from another app. Only
  // Team Space rooms expose it as a panel thread. Ordinary rooms flatten it as a rich reply.
  const standardThread =
    !failed && relation?.rel_type === 'm.thread' && typeof relation.event_id === 'string' && !original['io.atum.result']

  const thread = standardThread &&
    [MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room?.getType() ?? '')
  const threadRootId = thread ? (relation.event_id as string) : undefined
  const threadReply = thread ? record(relation?.['m.in_reply_to']) : undefined
  const replyTo = thread && typeof threadReply?.event_id === 'string' ? threadReply.event_id : resultFor

  // A protected company reference is never Matrix media. Its marker opts out of
  // ordinary attachment handling even when malformed, so a marker plus mxc URL or
  // encrypted descriptor cannot downgrade into a downloadable Matrix file.
  const binding = companyChannelBinding(room)

  const protectedFile = !failed
    ? binding
      ? matrixCompanyFileContent(original, {
          companyId: binding.companyId,
          target: binding.target.kind === 'channel'
            ? { kind: 'channel', channelId: binding.target.channelId }
            : { kind: 'conversation', conversationId: binding.target.conversationId }
        })
      : Object.hasOwn(original, MATRIX_COMPANY_FILE)
        ? null
        : undefined
    : undefined

  // An encrypted descriptor (`file`), or a plain mxc URL only for a plain event in a room without
  // encryption (0.20 chats; what phones and Element X send there), by its synced state and its
  // crypto store both. Plain media in an encrypted room is never shown as a file (no downgrade).
  const file =
    protectedFile !== undefined
      ? Boolean(protectedFile)
      : !failed &&
        matrixAttachmentMsgtype(original.msgtype) &&
        (Boolean(original.file) ||
          (room !== undefined &&
            plainRoom(room) &&
            plainConfirmed &&
            !event.isEncrypted() &&
            typeof original.url === 'string'))

  const size = file ? attachmentSize(original.info) : undefined
  const id = event.getId() ?? ''
  const reactions = id.startsWith('$') ? matrixReactions(room, id, ownUserId, ignored) : undefined
  const own = event.getSender() === ownUserId
  const cloud = record(content['io.atum.result'])
  // An outcome's code and bounded details (agent-turns/1.5 A14): the viewer words it in its own
  // language; a marker outside the contract's shape leaves the body as it is.
  const notice = !failed && !own ? matrixResultStatusNotice(content) : undefined

  const cloudStatus = notice
    ? {
        ...notice,
        ...(notice.code === 'resuming_on_device' && validStopEvent(cloud?.stopEvent)
          ? { stopEvent: cloud!.stopEvent as string }
          : {})
      }
    : undefined

  // A scheduled or standing line (A15) and an answer that ends with an appended warning (A14).
  const statusLine = !failed && !own ? matrixStatusLine(content) : undefined
  const answerWarning = !failed && !own ? matrixAnswerWarning(content) : undefined

  // A check-in's card: only a scheduled post (its cron marker) that carries a valid nudge.
  const checkIn =
    !failed && !own && original[MATRIX_CRON_KEY]
      ? parseMatrixCheckInNudge(original[MATRIX_CHECK_IN_NUDGE_KEY])
      : undefined

  const petCommands = !failed && !edited ? parseMatrixPetReply(original) : undefined

  // A content claiming the company profile (agent-turns/1.6) is read only as company presentation,
  // never as a personal marker: dispatch is by exact profile and scope.
  const companyClaimed = !failed && matrixCompanyPresentationClaimed(content)
  const company = companyClaimed && !own ? companyPresentationOf(event, original, content, edited, room) : undefined

  // The agent's one progress line (agent-turns/1.3, or 1.6 for a company agent), from its latest
  // content. Only the agent itself can edit it, so a stranger's copy of the marker is never read as one.
  const progress =
    !failed && !own && content.msgtype === 'm.notice'
      ? companyClaimed
        ? company?.stream === 'progress' ? company.progress : undefined
        : matrixProgressMarker(content)
      : undefined

  // Its descriptor (agent-turns/1.5 A12, optional on a 1.6 company line too), a sibling of the
  // marker in the same latest content.
  const presentation = progress ? matrixProgressPresentation(content, progress) : undefined

  // The agent's interim remark (agent-turns/1.4, or 1.6): a real message that is not the answer.
  const interim = !failed && !own && (companyClaimed ? company?.stream === 'interim' : matrixInterimMarker(content))

  return {
    id,
    sender: event.getSender() ?? '',
    body: typeof content.body === 'string' && !failed ? content.body : '',
    timestamp: event.getTs(),
    own,
    encrypted: event.isEncrypted(),
    decryptionFailed: failed,
    ...(failed ? { decryptionReason: matrixDecryptionReason(event.decryptionFailureReason) } : {}),
    pending: event.status === 'sending' || event.status === 'queued' || event.status === 'encrypting',
    failed: event.status === 'not_sent',
    // Sent: the server has it (its own event ID) and nothing about it is still in flight.
    ...(own && event.status === null && id.startsWith('$') ? { sent: true as const } : {}),
    // Keep the ordinary file projection too. The renderer prefers an authenticated bot-api
    // photo, but can fall back to this card when catalog/device authorization is unavailable.
    attachment: file,
    ...(protectedFile ? { companyFile: true as const } : {}),
    ...(size !== undefined ? { attachmentSize: size } : {}),
    ...(!failed && replyTo ? { replyTo } : {}),
    ...(mentions ? { mentions } : {}),
    ...(privateCosGreeting ?? {}),
    // Current answers are ordinary rich replies carrying `io.atum.result`; a question that
    // replies to something is never an answer, even with its turn marker.
    ...((original['io.atum.result'] || (turn && !own)) && resultFor ? { resultFor } : {}),
    ...(turn ? { turn } : {}),
    // A progress line is edited by design: it never reads "(đã sửa)".
    ...(edited && !progress ? { edited: true, editedAt } : {}),
    ...(progress ? { progress } : {}),
    ...(presentation ? { presentation } : {}),
    ...(interim ? { interim: true as const } : {}),
    ...(company ? { company: { ...company.identity, revisedAt: editedAt ?? event.getTs() } } : {}),
    ...(!failed && original[MATRIX_FORWARDED_KEY] === true ? { forwarded: true as const } : {}),
    ...(thread ? { thread: true, threadRootId } : {}),
    ...(!failed && original.msgtype === 'm.notice' ? { notice: true } : {}),
    ...(reactions ? { reactions } : {}),
    ...(checkIn ? { checkIn } : {}),
    ...(cloudStatus ? { cloudStatus } : {}),
    ...(statusLine ? { statusLine } : {}),
    ...(answerWarning ? { answerWarning } : {}),
    ...(petCommands ? { petIntents: { commands: petCommands, live: petLive } } : {}),
    ...(botApi ? { botApi } : {})
  }
}
