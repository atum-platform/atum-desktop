import { APP_UUID } from '../../shared/app-shortcuts'
import { APP_VIEW_IPC } from '../../shared/app-view/ipc'
import { ATUM_MAILBOXES } from '../../shared/atum-company'
import { parseLookRoomAccountData } from '../../shared/look-pack'
import {
  MATRIX_CHAT_TITLE_MAX,
  MATRIX_GROUP_TOPIC_MAX,
  MATRIX_MAX_FILE_BYTES,
  MATRIX_PROMPT_MAX,
  MATRIX_REACTION_KEY_MAX,
  MATRIX_REPORT_REASON_MAX,
  MATRIX_TURN_QUOTE_MAX,
  type MatrixCommand,
  type MatrixIdentity,
  matrixMessageTooLong,
  type MatrixNewSignIn,
  type MatrixSignInMethod,
  type MatrixTurnReply
} from '../../shared/matrix'
import { matrixCheckInChange, matrixCheckInFeedbackChange } from '../../shared/matrix-check-ins'
import { matrixDisplayPreferenceChange } from '../../shared/matrix-display-preferences'
import { MATRIX_DRAFT_TEXT_MAX_BYTES } from '../../shared/matrix-drafts'
import { parseMatrixEffort, parseMatrixModel } from '../../shared/matrix-models'
import { MATRIX_NOTES_SELF_COMPANY_ID } from '../../shared/matrix-notes-self'
import { matrixNotificationPolicyChange } from '../../shared/matrix-notification-policy'
import { MATRIX_PET_OVERLAY_IPC, type MatrixPetOverlayAction } from '../../shared/matrix-pet-overlay'
import {
  MATRIX_STATUS_EMOJI_MAX,
  MATRIX_STATUS_TEXT_MAX,
  normalizeMatrixStatusText,
  validMatrixStatusInput
} from '../../shared/matrix-presence'
import {
  MATRIX_ROOM_SHARED_MAX_ITEMS,
  MATRIX_ROOM_SHARED_SECTIONS,
  type MatrixRoomSharedSection,
  validMatrixRoomSharedToken
} from '../../shared/matrix-room-shared'
import { parseMatrixShelfModel } from '../../shared/matrix-shelf-models'

interface SenderEvent {
  sender: unknown
  senderFrame: unknown
}
interface Caller {
  mainFrame: { url: string }
}

/** Readiness gates acquisition, never the ability to detach/close an owned
 * native view while offline or during account teardown. Caller checks still apply. */
export function matrixAppViewCommandAllowed(channel: string, ready: boolean) {
  return ready || (channel !== APP_VIEW_IPC.open && channel !== APP_VIEW_IPC.reload)
}

/** Renderer geometry is CSS px; native controls occupy 40 DIP after zoom. */
export function matrixPdfBelowTitlebar(bounds: unknown, zoom: number): boolean {
  const y = (bounds as { y?: unknown } | null)?.y

  return typeof y === 'number' && Number.isFinite(y) && Number.isFinite(zoom) && zoom > 0 && y * zoom >= 40
}

export function requireMatrixCaller(event: SenderEvent, expected: Caller | undefined, url: string): void {
  if (
    !expected ||
    event.sender !== expected ||
    event.senderFrame !== expected.mainFrame ||
    expected.mainFrame.url !== url
  ) {
    throw new Error('matrix_ipc_denied')
  }
}

/** An overlay names no agent, position, room or file; main owns all authority. */
export function parseMatrixPetOverlayInput(channel: string, value: unknown): string | boolean | undefined {
  const IPC = MATRIX_PET_OVERLAY_IPC
  if ((channel === IPC.click || channel === IPC.popIn) && value === undefined) {
    return undefined
  }
  if (channel === IPC.drag && (value === 'start' || value === 'end')) {
    return value
  }
  if (channel === IPC.setInteractive && typeof value === 'boolean') {
    return value
  }
  const actions: readonly MatrixPetOverlayAction[] = [
    'chat',
    'wave',
    'sit',
    'lounge',
    'hide',
    'change',
    'size',
    'store',
    'settings'
  ]
  if (channel === IPC.menu && typeof value === 'string' && actions.includes(value as MatrixPetOverlayAction)) {
    return value
  }
  if (channel === IPC.submit && typeof value === 'string' && value.trim() && [...value].length <= 500) {
    return value
  }
  throw new Error('matrix_pet_overlay_invalid')
}

/** Runtime validation at the main boundary; renderer TypeScript isn't authority. */
/** A link from rendered messages may open in the browser: http(s) only, never a
 * file, app or custom scheme, and never with embedded credentials. */
export function matrixExternalLink(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096) {
    throw new Error('matrix_link_invalid')
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new Error('matrix_link_invalid')
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('matrix_link_invalid')
  }

  return url.href
}

/** One message email link: a single recipient and optional subject/body, never copies or an
 * attachment parameter. Bot API v1.1 formatted links include `mailto:`; main remains the
 * authority before the operating system sees one. */
export function matrixMessageMail(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096) {
    throw new Error('matrix_link_invalid')
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new Error('matrix_link_invalid')
  }

  const fields = [...url.searchParams.keys()]
  let address = ''

  try {
    address = decodeURIComponent(url.pathname)
  } catch {
    throw new Error('matrix_link_invalid')
  }

  if (
    url.protocol !== 'mailto:' ||
    url.hash ||
    !/^[^@\s,;]+@[^@\s,;]+$/u.test(address) ||
    fields.some(field => field !== 'subject' && field !== 'body') ||
    new Set(fields).size !== fields.length
  ) {
    throw new Error('matrix_link_invalid')
  }

  return url.href
}

/** An email to one of Atum's own role mailboxes, used by Settings account actions. */
export function matrixAtumMail(value: unknown): string {
  const href = matrixMessageMail(value)
  const mailboxes: readonly string[] = Object.values(ATUM_MAILBOXES)

  if (!mailboxes.includes(new URL(href).pathname.toLowerCase())) {
    throw new Error('matrix_link_invalid')
  }

  return href
}

/** What the window's `openLink` opens: a plain web link or one bounded message email. */
export function matrixOpenLink(value: unknown): string {
  return typeof value === 'string' && /^mailto:/i.test(value) ? matrixMessageMail(value) : matrixExternalLink(value)
}

/**
 * Back to Atum's AI (`useAtumModel`): the request names nothing. Main picks the default agent,
 * Atum's own endpoint and the managed key itself; an agent, model, endpoint or key from the
 * renderer is refused, so a parameter added later has to be validated here first.
 */
export function parseMatrixUseAtumModel(value: unknown): { kind: 'useAtumModel' } {
  const row = value as Record<string, unknown> | null

  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    row.kind !== 'useAtumModel' ||
    Object.keys(row).some(key => key !== 'kind')
  ) {
    throw new Error('matrix_command_invalid')
  }

  return { kind: 'useAtumModel' }
}

/** The way in the sign-in window chose; omitted means Google, as older windows ask. */
export function parseMatrixSignInMethod(value: unknown): MatrixSignInMethod {
  if (value === undefined) {
    return 'google'
  }

  if (value === 'google' || value === 'email' || value === 'create') {
    return value
  }

  throw new Error('matrix_command_invalid')
}

/**
 * Dismissing the new sign-in banner names exactly the device the window is showing, in a ready
 * account. A printable, bounded ID that matches nothing shown acknowledges nothing here.
 */
export function parseMatrixNewSignInDismiss(input: {
  closing: boolean
  ready: boolean
  identity: MatrixIdentity | null | undefined
  shown: MatrixNewSignIn | undefined
  deviceId: unknown
}): { identity: MatrixIdentity; deviceId: string } {
  if (
    input.closing ||
    !input.ready ||
    !input.identity ||
    typeof input.deviceId !== 'string' ||
    !/^[\x21-\x7e]{1,255}$/u.test(input.deviceId) ||
    input.shown?.deviceId !== input.deviceId
  ) {
    throw new Error('matrix_command_invalid')
  }

  return { identity: input.identity, deviceId: input.deviceId }
}

/** A local turn's reply: the message it answers (an event of the room) and its words, bounded.
 * Absent means an ordinary question. */
export function parseMatrixTurnReply(value: unknown): MatrixTurnReply | undefined {
  if (value === undefined) {
    return undefined
  }

  const reply = value as { eventId?: unknown; quote?: unknown } | null

  if (
    !reply ||
    typeof reply !== 'object' ||
    typeof reply.eventId !== 'string' ||
    !reply.eventId.startsWith('$') ||
    reply.eventId.length > 1024 ||
    typeof reply.quote !== 'string' ||
    !reply.quote.trim() ||
    reply.quote.length > MATRIX_TURN_QUOTE_MAX
  ) {
    throw new Error('matrix_command_invalid')
  }

  return { eventId: reply.eventId, quote: reply.quote }
}

export function parseMatrixCommand(value: unknown): MatrixCommand {
  const row = value as Record<string, unknown>

  if (!row || typeof row !== 'object') {
    throw new Error('matrix_command_invalid')
  }

  const text = (key: string, max: number, prefix?: string) => {
    const value = row[key]

    if (typeof value !== 'string' || !value.length || value.length > max || (prefix && !value.startsWith(prefix))) {
      throw new Error('matrix_command_invalid')
    }

    return value
  }

  const roomId = () => text('roomId', 1024, '!')

  // A report's optional reason: the person's own words on one bounded line; blank is none.
  // It reaches only the homeserver's moderators, like the other one-line metadata the renderer
  // sets (a chat's name, a group's topic); the SDK never adds message content to a report.
  const reason = () => {
    if (row.reason === undefined) {
      return {}
    }

    const value =
      typeof row.reason === 'string' && row.reason.length <= 4096
        ? row.reason
            .replace(/\p{Cc}/gu, ' ')
            .trim()
            .replace(/\s+/gu, ' ')
        : null

    if (value === null || [...value].length > MATRIX_REPORT_REASON_MAX) {
      throw new Error('matrix_command_invalid')
    }

    return value ? { reason: value } : {}
  }

  const memberId = () => {
    const id = text('userId', 1024, '@')

    if (!/^@[^:\s]+:[^\s]+$/.test(id)) {
      throw new Error('matrix_command_invalid')
    }

    return id
  }

  switch (row.kind) {
    case 'setStatus': {
      if (row.status === null) {
        return { kind: 'setStatus', status: null }
      }

      const raw = row.status as Record<string, unknown> | null
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.dnd !== 'boolean' ||
          typeof raw.expiresAt !== 'number') {
        throw new Error('matrix_command_invalid')
      }

      const emoji = raw.emoji === undefined ? undefined : typeof raw.emoji === 'string' ? raw.emoji.trim() : null
      const statusText = raw.text === undefined ? undefined : typeof raw.text === 'string'
        ? normalizeMatrixStatusText(raw.text)
        : null
      const status = {
        dnd: raw.dnd,
        expiresAt: raw.expiresAt,
        ...(emoji ? { emoji } : {}),
        ...(statusText ? { text: statusText } : {})
      }

      if (emoji === null || statusText === null || (emoji && [...emoji].length > MATRIX_STATUS_EMOJI_MAX) ||
          (statusText && [...statusText].length > MATRIX_STATUS_TEXT_MAX) || !validMatrixStatusInput(status)) {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'setStatus', status }
    }

    case 'starterSeen': {
      const identity = row.identity as { userId?: unknown; deviceId?: unknown } | null

      if (
        !identity ||
        typeof identity.userId !== 'string' ||
        identity.userId.length > 1024 ||
        !/^@[^:\s]+:[^\s]+$/.test(identity.userId) ||
        typeof identity.deviceId !== 'string' ||
        !identity.deviceId.length ||
        identity.deviceId.length > 255
      ) {
        throw new Error('matrix_command_invalid')
      }

      return {
        kind: 'starterSeen',
        identity: { userId: identity.userId, deviceId: identity.deviceId },
        scope: text('scope', 2048)
      }
    }

    case 'groupPolicy': {
      const identity = row.identity as { userId?: unknown; deviceId?: unknown } | null
      if (
        !identity ||
        typeof identity.userId !== 'string' ||
        identity.userId.length > 1024 ||
        !/^@[^:\s]+:[^\s]+$/.test(identity.userId) ||
        typeof identity.deviceId !== 'string' ||
        !identity.deviceId.length ||
        identity.deviceId.length > 255
      ) {
        throw new Error('matrix_command_invalid')
      }
      const target = {
        kind: 'groupPolicy' as const,
        roomId: roomId(),
        identity: { userId: identity.userId, deviceId: identity.deviceId }
      }
      if (row.change === undefined) {
        return target
      }
      if (!row.change || typeof row.change !== 'object' || Array.isArray(row.change)) {
        throw new Error('matrix_command_invalid')
      }
      const change = row.change as Record<string, unknown>
      if (
        'agentId' in change &&
        Object.keys(change).length === 2 &&
        typeof change.agentId === 'string' &&
        /^@[^:\s]+:[^\s]+$/.test(change.agentId) &&
        change.agentId.length <= 1024 &&
        ['off', 'addressed', 'joins'].includes(String(change.mode))
      ) {
        return { ...target, change: { agentId: change.agentId, mode: change.mode as 'off' | 'addressed' | 'joins' } }
      }
      if (
        Object.keys(change).length === 1 &&
        Number.isSafeInteger(change.dailyTurns) &&
        Number(change.dailyTurns) >= 1 &&
        Number(change.dailyTurns) <= 200
      ) {
        return { ...target, change: { dailyTurns: Number(change.dailyTurns) } }
      }
      throw new Error('matrix_command_invalid')
    }

    case 'deviceIsolation':
    case 'peerIdentity':
    case 'displayPreference': {
      const identity = row.identity as { userId?: unknown; deviceId?: unknown } | null

      if (
        !identity ||
        typeof identity.userId !== 'string' ||
        !/^@[^:\s]+:[^\s]+$/.test(identity.userId) ||
        identity.userId.length > 1024 ||
        typeof identity.deviceId !== 'string' ||
        !identity.deviceId.length ||
        identity.deviceId.length > 255
      ) {
        throw new Error('matrix_command_invalid')
      }

      if (row.kind === 'deviceIsolation') {
        if (row.value !== 'all' && row.value !== 'signed') {
          throw new Error('matrix_command_invalid')
        }
        return { kind: row.kind, identity: { userId: identity.userId, deviceId: identity.deviceId }, value: row.value }
      }
      if (row.kind === 'peerIdentity') {
        if (row.action !== 'read' && row.action !== 'review' && row.action !== 'continue') {
          throw new Error('matrix_command_invalid')
        }
        return {
          kind: row.kind,
          identity: { userId: identity.userId, deviceId: identity.deviceId },
          roomId: roomId(),
          userId: memberId(),
          action: row.action
        }
      }

      return {
        kind: 'displayPreference',
        identity: { userId: identity.userId, deviceId: identity.deviceId },
        ...matrixDisplayPreferenceChange(row.field, row.value)
      }
    }
    case 'notificationPolicy': {
      const identity = row.identity as { userId?: unknown; deviceId?: unknown } | undefined

      if (
        typeof identity?.userId !== 'string' ||
        !identity.userId.startsWith('@') ||
        identity.userId.length > 1024 ||
        typeof identity.deviceId !== 'string' ||
        !identity.deviceId ||
        identity.deviceId.length > 255
      ) {
        throw new Error('matrix_command_invalid')
      }

      try {
        return {
          kind: 'notificationPolicy',
          identity: { userId: identity.userId, deviceId: identity.deviceId },
          ...matrixNotificationPolicyChange(row)
        }
      } catch {
        throw new Error('matrix_command_invalid')
      }
    }

    case 'checkInsChange':
    case 'checkInsFeedback': {
      const identity = row.identity as { userId?: unknown; deviceId?: unknown } | null

      if (
        !identity ||
        typeof identity.userId !== 'string' ||
        !/^@[^:\s]+:[^\s]+$/.test(identity.userId) ||
        identity.userId.length > 1024 ||
        typeof identity.deviceId !== 'string' ||
        !identity.deviceId.length ||
        identity.deviceId.length > 255
      ) {
        throw new Error('matrix_command_invalid')
      }

      const owner = { userId: identity.userId, deviceId: identity.deviceId }

      try {
        return row.kind === 'checkInsChange'
          ? { kind: 'checkInsChange', identity: owner, change: matrixCheckInChange(row.change) }
          : { kind: 'checkInsFeedback', identity: owner, feedback: matrixCheckInFeedbackChange(row.feedback) }
      } catch {
        throw new Error('matrix_command_invalid')
      }
    }

    case 'discoverApps':
      return { kind: 'discoverApps' }

    // Notes-to-self integration seam: the renderer can request only the fixed lazy action;
    // room choice and creation policy remain inside the owner's Matrix SDK.
    case 'notesSelfOpen':
      if (
        ![1, 2].includes(Object.keys(row).length) ||
        (Object.keys(row).length === 2 &&
          (typeof row.companyId !== 'string' || !MATRIX_NOTES_SELF_COMPANY_ID.test(row.companyId)))
      ) {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'notesSelfOpen', ...(typeof row.companyId === 'string' ? { companyId: row.companyId } : {}) }

    case 'selectApp':
    case 'appShortcut': {
      const appId = text('appId', 36).toLowerCase()

      if (!APP_UUID.test(appId)) {
        throw new Error('matrix_command_invalid')
      }

      if (row.kind === 'selectApp') {
        return { kind: 'selectApp', appId }
      }

      if (row.visibility !== 'shown' && row.visibility !== 'hidden') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'appShortcut', appId, visibility: row.visibility }
    }

    case 'recoveryCreateKey':

    case 'recoveryDiscard':
      return { kind: row.kind }

    case 'recoverySetUp':
      return { kind: row.kind, id: text('id', 100) }

    case 'recoveryRestore':
      return { kind: row.kind, key: text('key', 256) }

    case 'verificationStart':
      return { kind: row.kind, userId: text('userId', 1024, '@'), deviceId: text('deviceId', 255) }
    case 'verificationRespond': {
      if (!['accept', 'start', 'confirm', 'mismatch', 'cancel'].includes(String(row.action))) {
        throw new Error('matrix_command_invalid')
      }

      return {
        kind: row.kind,
        id: text('id', 100),
        action: row.action as 'accept' | 'start' | 'confirm' | 'mismatch' | 'cancel'
      }
    }

    case 'select':

    case 'paginateTimeline':

    case 'leave':

    // Delete chat: the SDK re-reads the room and its own membership before it leaves and forgets.
    case 'forget':
      return { kind: row.kind, roomId: roomId() }

    case 'join':
      if (row.select !== undefined && row.select !== false) {
        throw new Error('matrix_command_invalid')
      }

      return { kind: row.kind, roomId: roomId(), ...(row.select === false ? { select: false as const } : {}) }

    case 'invite':

    case 'removeMember':

    case 'ban':

    case 'unban':
      return { kind: row.kind, roomId: roomId(), userId: memberId() }

    case 'favourite':
      if (typeof row.favourite !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'favourite', roomId: roomId(), favourite: row.favourite }

    case 'lowPriority':
      if (typeof row.lowPriority !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'lowPriority', roomId: roomId(), lowPriority: row.lowPriority }
    case 'agentConversation': {
      const actions = ['preview', 'keep', 'makeMain', 'replaceMain', 'retry']
      if (!actions.includes(String(row.action))) {
        throw new Error('matrix_command_invalid')
      }
      const identity = row.identity as { userId?: unknown; deviceId?: unknown } | undefined
      if (
        typeof identity?.userId !== 'string' ||
        !identity.userId.startsWith('@') ||
        identity.userId.length > 1024 ||
        typeof identity.deviceId !== 'string' ||
        !identity.deviceId ||
        identity.deviceId.length > 255
      ) {
        throw new Error('matrix_command_invalid')
      }
      const action = row.action as 'preview' | 'keep' | 'makeMain' | 'replaceMain' | 'retry'
      return {
        kind: 'agentConversation',
        identity: { userId: identity.userId, deviceId: identity.deviceId },
        agentId: text('agentId', 1024, '@'),
        action,
        ...(action === 'keep' ||
        action === 'makeMain' ||
        ((action === 'preview' || action === 'retry') && row.roomId !== undefined)
          ? { roomId: roomId() }
          : {})
      }
    }
    case 'setModel': {
      // A shelf alias passes this shape check; main accepts it for a cloud agent only.
      const model =
        row.model === undefined ? undefined : (parseMatrixModel(row.model) ?? parseMatrixShelfModel(row.model))
      const effort = row.effort === undefined ? undefined : parseMatrixEffort(row.effort)

      // At least one known change, and nothing unknown passed through as one.
      if ((row.model !== undefined && !model) || (row.effort !== undefined && !effort) || (!model && !effort)) {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'setModel', roomId: roomId(), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    }

    case 'ignore':
      if (typeof row.ignored !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'ignore', userId: memberId(), ignored: row.ignored }
    case 'create': {
      if (
        !Array.isArray(row.invite) ||
        row.invite.length > 20 ||
        row.invite.some(v => typeof v !== 'string' || !/^@[^:\s]+:[^\s]+$/.test(v) || v.length > 1024) ||
        (row.direct !== undefined && typeof row.direct !== 'boolean') ||
        (row.direct === true && row.invite.length !== 1)
      ) {
        throw new Error('matrix_command_invalid')
      }

      return {
        kind: 'create',
        name: row.direct === true ? '' : text('name', 200),
        invite: row.invite as string[],
        ...(row.direct === undefined ? {} : { direct: row.direct as boolean })
      }
    }

    case 'send': {
      const body = text('body', MATRIX_PROMPT_MAX)

      // One message must fit one encrypted event (MATRIX_MESSAGE_MAX_BYTES); say so plainly.
      if (matrixMessageTooLong(body)) {
        throw new Error('matrix_message_too_long')
      }

      // Who it names (standard intentional mentions): Matrix user IDs only, a handful at most.
      const mentions = row.mentions

      if (
        mentions !== undefined &&
        (!Array.isArray(mentions) ||
          mentions.length > 10 ||
          mentions.some(id => typeof id !== 'string' || id.length > 1024 || !/^@[^:\s]+:[^\s]+$/.test(id)))
      ) {
        throw new Error('matrix_command_invalid')
      }

      return {
        kind: 'send',
        roomId: roomId(),
        body,
        ...(row.replyTo === undefined ? {} : { replyTo: text('replyTo', 1024, '$') }),
        ...(row.threadRootId === undefined ? {} : { threadRootId: text('threadRootId', 1024, '$') }),
        ...(Array.isArray(mentions) && mentions.length ? { mentions: [...new Set(mentions as string[])] } : {})
      }
    }

    // Your own message, changed or deleted, and your reaction to one: the SDK re-reads the
    // target in that room's timeline (yours, from the server, not changed meanwhile).
    case 'edit': {
      const body = text('body', 16000)

      if (!body.trim()) {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'edit', roomId: roomId(), eventId: text('eventId', 1024, '$'), body }
    }

    case 'redact':
      return { kind: 'redact', roomId: roomId(), eventId: text('eventId', 1024, '$') }
    case 'pinMessage':
      if (typeof row.pinned !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'pinMessage', roomId: roomId(), eventId: text('eventId', 1024, '$'), pinned: row.pinned }
    case 'react': {
      const key = text('key', MATRIX_REACTION_KEY_MAX * 2)

      // One short key (an emoji counts its code points), nothing invisible around it.
      if (
        typeof row.reacted !== 'boolean' ||
        key.trim() !== key ||
        [...key].length > MATRIX_REACTION_KEY_MAX ||
        /\p{Cc}/u.test(key)
      ) {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'react', roomId: roomId(), eventId: text('eventId', 1024, '$'), key, reacted: row.reacted }
    }

    case 'savedMessage':
      if (typeof row.saved !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return {
        kind: 'savedMessage',
        roomId: roomId(),
        eventId: text('eventId', 1024, '$'),
        saved: row.saved
      }

    case 'savedMessagesRead':
      return { kind: 'savedMessagesRead' }

    case 'savedMessageOpen':
      return { kind: 'savedMessageOpen', roomId: roomId(), eventId: text('eventId', 1024, '$') }

    case 'draft': {
      const identity = row.identity as { userId?: unknown; deviceId?: unknown } | null

      if (
        !identity ||
        typeof identity.userId !== 'string' ||
        identity.userId.length > 1024 ||
        !/^@[^:\s]+:[^\s]+$/.test(identity.userId) ||
        typeof identity.deviceId !== 'string' ||
        !identity.deviceId.length ||
        identity.deviceId.length > 255 ||
        typeof row.text !== 'string' ||
        row.text.length > MATRIX_DRAFT_TEXT_MAX_BYTES
      ) {
        throw new Error('matrix_command_invalid')
      }

      return {
        kind: 'draft',
        identity: { userId: identity.userId, deviceId: identity.deviceId },
        roomId: roomId(),
        ...(row.threadRootId === undefined ? {} : { threadRootId: text('threadRootId', 1024, '$') }),
        text: row.text
      }
    }

    case 'typing':
      if (typeof row.typing !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'typing', roomId: roomId(), typing: row.typing }

    case 'markUnread':
      if (typeof row.unread !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'markUnread', roomId: roomId(), unread: row.unread }
    case 'threadFollow':
      if (typeof row.followed !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'threadFollow', roomId: roomId(), rootId: text('rootId', 1024, '$'), followed: row.followed }
    case 'threadRead':
      return { kind: 'threadRead', roomId: roomId(), rootId: text('rootId', 1024, '$') }
    case 'forward':
      return {
        kind: 'forward',
        roomId: roomId(),
        eventId: text('eventId', 1024, '$'),
        toRoomId: text('toRoomId', 1024, '!'),
        dialogNonce: text('dialogNonce', 128)
      }
    case 'attach': {
      if (!(row.bytes instanceof Uint8Array) || row.bytes.byteLength > MATRIX_MAX_FILE_BYTES) {
        throw new Error('matrix_file_invalid')
      }
      if (row.replyTo !== undefined && row.threadRootId === undefined) {
        throw new Error('matrix_command_invalid')
      }

      return {
        kind: 'attach',
        roomId: roomId(),
        name: text('name', 200).replace(/[\\/]|\p{Cc}/gu, '_'),
        contentType:
          typeof row.contentType === 'string' &&
          /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,63}$/u.test(row.contentType)
            ? row.contentType
            : 'application/octet-stream',
        bytes: row.bytes,
        ...(row.threadRootId === undefined ? {} : { threadRootId: text('threadRootId', 1024, '$') }),
        ...(row.replyTo === undefined ? {} : { replyTo: text('replyTo', 1024, '$') })
      }
    }

    case 'download':
      if (row.companyFile !== undefined && row.companyFile !== true) {
        throw new Error('matrix_command_invalid')
      }
      return {
        kind: row.kind,
        roomId: roomId(),
        eventId: text('eventId', 1024, '$'),
        ...(row.companyFile === true ? { companyFile: true as const } : {})
      }

    // What a chat has shared, for its info panel: a bounded read; the SDK re-reads the room.
    case 'roomShared': {
      if (
        !MATRIX_ROOM_SHARED_SECTIONS.includes(row.section as MatrixRoomSharedSection) ||
        !Number.isSafeInteger(row.limit) ||
        (row.limit as number) < 1 ||
        (row.limit as number) > MATRIX_ROOM_SHARED_MAX_ITEMS ||
        (row.from !== undefined && !validMatrixRoomSharedToken(row.from))
      ) {
        throw new Error('matrix_command_invalid')
      }

      return {
        kind: 'roomShared',
        roomId: roomId(),
        section: row.section as MatrixRoomSharedSection,
        limit: row.limit as number,
        ...(row.from === undefined ? {} : { from: row.from as string })
      }
    }

    case 'roomSharedThumbnail':
      return { kind: 'roomSharedThumbnail', roomId: roomId(), eventId: text('eventId', 1024, '$') }

    // A local echo's id (`~` + room + transaction), never a server event: the SDK re-checks it
    // is this account's own unsent message before it sends or drops anything.
    case 'resend':

    case 'discard':
      return { kind: row.kind, roomId: roomId(), eventId: text('eventId', 2048, '~') }

    case 'mute':
      if (typeof row.muted !== 'boolean') {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'mute', roomId: roomId(), muted: row.muted }
    case 'chatTitle': {
      // One line, bounded; empty clears the name.
      const title =
        typeof row.title === 'string' && row.title.length <= 1024
          ? row.title
              .replace(/\p{Cc}/gu, ' ')
              .trim()
              .replace(/\s+/gu, ' ')
          : null

      if (title === null || [...title].length > MATRIX_CHAT_TITLE_MAX) {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'chatTitle', roomId: roomId(), title }
    }

    // A group's shared name and topic: one bounded line each. A name is never empty (Matrix
    // would fall back to listing members); an empty topic clears it.
    case 'groupName':
    case 'groupTopic': {
      const field = row.kind === 'groupName' ? row.name : row.topic
      const max = row.kind === 'groupName' ? MATRIX_CHAT_TITLE_MAX : MATRIX_GROUP_TOPIC_MAX

      const value =
        typeof field === 'string' && field.length <= 4096
          ? field
              .replace(/\p{Cc}/gu, ' ')
              .trim()
              .replace(/\s+/gu, ' ')
          : null

      if (value === null || [...value].length > max || (row.kind === 'groupName' && !value)) {
        throw new Error('matrix_command_invalid')
      }

      return row.kind === 'groupName'
        ? { kind: 'groupName', roomId: roomId(), name: value }
        : { kind: 'groupTopic', roomId: roomId(), topic: value }
    }

    case 'chatLook': {
      const look = parseLookRoomAccountData(row.look)

      if (!look) {
        throw new Error('matrix_command_invalid')
      }

      return { kind: 'chatLook', roomId: roomId(), look }
    }

    case 'attend':
      return { kind: 'attend', roomId: row.roomId === null ? null : roomId() }

    case 'reportEvent':
      return {
        kind: 'reportEvent',
        roomId: roomId(),
        eventId: text('eventId', 1024, '$'),
        userId: memberId(),
        ...reason()
      }

    case 'reportUser':
      return { kind: 'reportUser', roomId: roomId(), userId: memberId(), ...reason() }

    case 'devices':
      return { kind: 'devices', userId: text('userId', 1024, '@') }

    default:
      throw new Error('matrix_command_invalid')
  }
}
