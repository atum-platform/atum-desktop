import { Attachment } from '@matrix-org/matrix-sdk-crypto-wasm'
import {
  ClientEvent,
  createClient,
  Direction,
  EventStatus,
  EventType,
  IndexedDBStore,
  type MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
  Method,
  MsgType,
  type Room,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  ThreadEvent,
  TokenRefreshLogoutError,
  UserEvent
} from 'matrix-js-sdk'
import { EventShieldReason } from 'matrix-js-sdk/lib/crypto-api/index'
import type { Logger } from 'matrix-js-sdk/lib/logger'

import {
  APP_BOT_AUDIENCE_CHANGED,
  APP_BOT_AUDIENCE_UNKNOWN,
  AppBotAudienceError,
  type AppBotAudienceMember,
  appBotDirectSafe
} from '../../../../packages/app-bot-audience'
import { BOT_API_MATRIX_METADATA } from '../../../../packages/bot-api-v1'
import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import { APP_UUID } from '../../shared/app-shortcuts'
import { DEFAULT_DESKTOP_LOCALE, desktopLocaleFor } from '../../shared/desktop-locale'
import { LOOK_ROOM_ACCOUNT_DATA_TYPE } from '../../shared/look-pack'
import {
  MATRIX_MAX_FILE_BYTES,
  MATRIX_PLAIN_SENDER_DEVICE,
  matrixAttachmentMsgtype,
  type MatrixDestination,
  type MatrixDevice,
  type MatrixInvocationHint,
  type MatrixMessage,
  type MatrixNotificationHint,
  type MatrixRefreshResult,
  type MatrixSdkCommand,
  type MatrixSdkConfiguration,
  type MatrixSnapshot
} from '../../shared/matrix'
import {
  type AppBotDmFound,
  type AppBotDmHidden,
  type AppBotDmLeft,
  type AppBotDmMade,
  type AppBotDmOpened,
  type AppBotDmPointer,
  type AppBotDmShown,
  isCanonicalMatrixRoomId
} from '../../shared/matrix-app-bot-dm'
import { appGroupBinding, MATRIX_APP_GROUP_TYPE } from '../../shared/matrix-app-room'
import { MATRIX_ASSISTANT_ROOM_TYPE, plainAgentRoom, plainRoom } from '../../shared/matrix-assistant-room'
import {
  companyRoomTargetBinding,
  MATRIX_COMPANY_CHANNEL_TYPE,
  MATRIX_COMPANY_CONVERSATION_TYPE
} from '../../shared/matrix-company-channel-room'
import { MATRIX_COMPANY_FILE } from '../../shared/matrix-company-files'
import type { MatrixGoogleFenceObservation } from '../../shared/matrix-google-fence'
import { MATRIX_GOOGLE_PROVENANCE_KEY } from '../../shared/matrix-google-tools'
import { MATRIX_GROUP_AGENT_LIMIT } from '../../shared/matrix-group-room'
import { MATRIX_MODEL_ACCOUNT_DATA, matrixModelChoiceContent } from '../../shared/matrix-models'
import { MATRIX_NOTES_SELF_ROOM_TYPE } from '../../shared/matrix-notes-self'
import { createMatrixSyncHealth, matrixSyncTokenRefused } from '../../shared/matrix-sync-health'
import { MATRIX_TASK_FILES_KEY, parseMatrixTaskFilesPromise } from '../../shared/matrix-task-files'
import type { MatrixUndecryptableObservation } from '../../shared/matrix-undecryptable'

import { agentIdentityCarrier } from './agent-identity-carrier'
import { sendMatrixAgentSeen, sendMatrixAgentTyping } from './agent-signals'
import {
  createAgentTaskRoom,
  queryAgentTaskRooms,
  readAgentTaskRoom,
  reconcileAgentTaskCoordinators,
  reconcileAgentTaskRooms,
  scanAgentTasks,
  sendAgentTaskEvent,
  watchAgentTasks
} from './agent-tasks'
import { APP_BOT_UNSYNCED_PROBES, appBotCreatedRooms } from './app-bot-created'
import {
  APP_BOT_DM_MARKER,
  appBotDmCandidate,
  appBotDmMarker,
  appBotDmPointer,
  appBotDmRooms,
  appBotDmUsable,
  chooseAppBotDm,
  hideAppBotDm,
  showAppBotDm
} from './app-bot-dm'
import { waitForRoom } from './app-bot-room-wait'
import { appShortcuts } from './app-shortcuts'
import {
  adoptAssistantRoomInvitation,
  AssistantRoomAdoptionUncertainError,
  findAssistantRoom,
  inviteAgentToGroup,
  isMatrixPrivateChat,
  readAppRoom,
  readAssistantRoom,
  readConversationMarker,
  readGroupRoom,
  readRetiredAgentRoom,
  requireHumanInvitation
} from './assistant-room'
import { matrixBackupAvailability } from './backup-availability'
import { matrixCheckIns } from './check-ins'
import { matrixCompanyActivity } from './company-activity'
import {
  companyPrivateCosRecipient,
  findCompanyThread,
  joinCompanyAIChannel,
  joinCompanyPrivateCosRoom,
  leaveCompanyPrivateCosRoom,
  openCompanyCitation,
  publishCompanyOnboardingWelcome,
  publishCompanyPrivateCos,
  publishCompanyPrivateCosGreeting,
  publishCompanyThread,
  publishCompanyThreadMessage,
  readCompanyAIEvent,
  readCompanyAIJoinedMembers,
  readCompanyAIQuestion,
  readCompanyPrivateCosQuestion,
  watchCompanyAI,
  watchCompanyPrivateCos
} from './company-ai-sdk'
import {
  createCompanyChannelRoom,
  createCompanyRoomTarget,
  findCompanyChannelRoom,
  findCompanyRoomTarget,
  readCompanyChannelRoom,
  readCompanyRoomTarget,
  reconcileCompanyChannelRoom,
  reconcileCompanyRoomTarget
} from './company-channel-room'
import { companyFileContext, companyFileReference, sendCompanyFile } from './company-files'
import { companyMessageRoom, openCompanyMessage, searchCompanyMessages } from './company-message-search'
import {createCompanyPrivateCosRoom,findCompanyPrivateCosRoom,finishCompanyPrivateCosRoom} from './company-private-cos-room'
import {
  createCompanyProjectRoom,
  findCompanyProjectRoom,
  joinCompanyProjectRoom,
  readCompanyProjectRoom,
  reconcileCompanyProjectRoom,
  rotateCompanyProjectSession
} from './company-room'
import { readMatrixContinuity } from './continuity'
import { projectedConversationMarker } from './conversation-marker'
import {
  conversationAppVersions,
  preflightConversationRoom,
  readConversationCandidates,
  writeConversationMarker
} from './conversation-marker-write'
import {
  canMentionMatrixRoom,
  changeConversationMembership,
  conversationMembers,
  conversationRoom,
  createConversation,
  joinedConversation,
  MATRIX_TITLE_ACCOUNT_DATA,
  personalGroupStateAllowed,
  rememberDirectConversation
} from './conversations'
import { initializeMatrixDeviceIsolation } from './device-isolation'
import { matrixDisplayPreferences } from './display-preferences'
import { matrixDrafts } from './drafts'
import { watchEarlierConversations } from './earlier-watch'
import { matrixFirstRunOnboarding } from './first-run-onboarding'
import { matrixForwardContent, matrixForwardTransactionId } from './forward-content'
import { matrixFounderChat } from './founder/sdk-founder-chat'
import { matrixGoogleFencePublisher, observeMatrixGoogleFence } from './google-fence'
import { readGroupRecent } from './group-recent'
import { readGroupSettled } from './group-settled'
import { watchMatrixGroupTurns } from './group-turns'
import { changeIgnoredUser, ignoredInvitation } from './ignore'
import { scanMatrixInvocations, watchMatrixInvocations } from './invocation-listener'
import { discoveryReport } from './joined-room-discovery'
import { matrixLinkPreviews } from './link-preview-media'
import { boundedMatrixFetch, downloadMatrixAttachment } from './media'
import { matrixMemberAvatars } from './member-avatar-media'
import { matrixMembershipLines } from './membership-lines'
import { matrixMessage, shownContent } from './message'
import {
  editMatrixMessage,
  markMatrixRoomUnread,
  matrixMarkedUnread,
  matrixTyping,
  reactToMatrixMessage,
  redactMatrixMessage,
  sendMatrixReply,
  sendMatrixText,
  sendMatrixTyping
} from './message-commands'
import { matrixNotesSelf } from './notes-self'
import { matrixNotificationPolicy } from './notification-policy'
import {
  matrixCompanyPrivateCosNotificationRoomIds,
  watchMatrixNotifications
} from './notifications'
import { ownerRecoveryCarrier } from './owner-recovery-carrier'
import { requireMatrixRoomPeerTrust } from './peer-identity'
import { readPeoplePrivacy, searchMatrixPeople, writePeoplePrivacy } from './people-search-sdk'
import { createPetLiveEvents } from './pet/live-events'
import { changeMatrixMessagePin, matrixPinnedMessages } from './pinned-events'
import { confirmedPlainRoom, plainRoomAnswer, withJoinedWireType } from './plain-room'
import { matrixPresence } from './presence'
import { matrixProfile } from './profile'
import { prepareMatrixResult, publishMatrixGroupNotice, publishMatrixNotice, publishMatrixResult } from './publish-result'
import { readMatrixInvocation } from './read-invocation'
import { matrixReadReceipts } from './read-receipts'
import { readMatrixResult } from './read-result'
import { publicReaders } from './read-state'
import { readMatrixReplyQuote } from './reply-quote'
import { roomSelection } from './room-navigation'
import { matrixRoomPolicy } from './room-policy'
import { readMatrixRoomShared, readMatrixRoomSharedThumbnail } from './room-shared'
import { matrixSavedMessages } from './saved-messages'
import { appBotPinnedShield, type MatrixAppBotEvent } from './sdk-app-bot'
import { loadDeviceForVerification } from './sdk-device-verification'
import { matrixSecurity, recoveryKeyCache } from './security'
import { matrixStarterOnboarding } from './starter-onboarding'
import { matrixStoreRuns } from './store-runs'
import { MATRIX_COMPANY_THREADS_MAX, matrixCompanyThreads, matrixRoomTimelineEvents, matrixThreads, readMatrixThread, sendMatrixThreadReply, setMatrixThreadFollow } from './threads'
import {
  MATRIX_TIMELINE_EVENT_BOUND,
  MATRIX_TIMELINE_INITIAL_EVENTS,
  MATRIX_TIMELINE_PAGE_EVENTS,
  type MatrixTimelinePage,
  nextTimelineEventLimit,
  timelineReachesStart
} from './timeline-history'
import { matrixTimelineKeyRetry } from './timeline-key-retry'
import { findMatrixTurn, prepareMatrixCron, publishMatrixCron, sendMatrixTurn, sendWithTransaction } from './turn'
import { observeMatrixUndecryptable } from './undecryptable'

// Raw SDK/provider errors can contain request data. Product state uses closed
// error codes; do not send SDK logs or decrypted messages to diagnostics.
const quietLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return quietLogger
  }
}

/**
 * The host gives an attachment command a 120-second absolute deadline. Stop an upload
 * before that deadline so a timed-out upload can never continue into `sendEvent` after
 * the caller has been told it failed. The remaining 30 seconds are deliberately for the
 * event send; unlike an upload, a Matrix event already accepted by the homeserver cannot
 * be undone by aborting the client-side request.
 */
export const MATRIX_ATTACHMENT_UPLOAD_TIMEOUT_MS = 90_000
export const MATRIX_ASSISTANT_INVITE_WAIT_MS = 1_500
export const MATRIX_ASSISTANT_POST_CREATE_SETTLE_MS = 400
export const MATRIX_ASSISTANT_LATE_INVITE_WINDOW_MS = 10_000

/** Said when the person gives no reason: the standard abuse category. */
const MATRIX_REPORT_DEFAULT_REASON = 'abuse'

/** A synced message from `userId` exactly as this device holds it: sent, not redacted, readable,
 * and in its room's own wire type (a room with encryption state takes only the encrypted
 * original; plaintext there is refused, no downgrade). */
async function reportableMatrixEvent(client: MatrixClient, room: Room, event: MatrixEvent, userId: string) {
  return (
    event.status === null &&
    event.getRoomId() === room.roomId &&
    Boolean(event.getId()?.startsWith('$')) &&
    event.getSender() === userId &&
    userId !== client.getSafeUserId() &&
    event.getType() === EventType.RoomMessage &&
    !event.isRedacted() &&
    !event.isDecryptionFailure() &&
    event.getWireType() ===
      ((await confirmedPlainRoom(client, room)) ? EventType.RoomMessage : EventType.RoomMessageEncrypted)
  )
}

/** Matrix event report: identifiers, the fixed score and the person's reason, never content. */
async function reportMatrixEvent(client: MatrixClient, roomId: string, eventId: string, reason?: string) {
  await client.http.authedRequest(
    Method.Post,
    `/rooms/${encodeURIComponent(roomId)}/report/${encodeURIComponent(eventId)}`,
    undefined,
    // Matrix v1.12 requires this fixed, most-offensive value. It is SDK-owned:
    // the renderer cannot select a score or supply any message content.
    { reason: reason ?? MATRIX_REPORT_DEFAULT_REASON, score: -100 },
    { prefix: '/_matrix/client/v3' }
  )
}

/** The homeserver does not offer this endpoint (an older server): unknown route or method. */
function matrixEndpointUnsupported(error: unknown): boolean {
  if (!record(error)) {
    return false
  }

  return error.errcode === 'M_UNRECOGNIZED' || error.httpStatus === 404 || error.httpStatus === 405
}

function matrixUploadTooLarge(error: unknown): boolean {
  if (!record(error)) {
    return false
  }

  return error.httpStatus === 413 || error.errcode === 'M_TOO_LARGE' || error.name === 'M_TOO_LARGE'
}

/** Upload only. Its deadline is intentionally cleared before the event send begins. */
async function uploadMatrixAttachment(
  client: Pick<MatrixClient, 'uploadContent'>,
  bytes: Uint8Array,
  options: { type: string; includeFilename: false },
  deadlineAt: number
) {
  const abortController = new AbortController()
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true
        // matrix-js-sdk 42.4.0 passes this controller to XHR/fetch and rejects
        // its upload promise on abort. The race also settles if a test double or
        // future transport fails to observe the signal.
        abortController.abort()
        reject(new Error('matrix_send_failed'))
      },
      Math.max(0, deadlineAt - Date.now())
    )
  })

  try {
    return await Promise.race([
      client.uploadContent(new Blob([buffer], { type: options.type }), { ...options, abortController }),
      deadline
    ])
  } catch (error) {
    if (timedOut) {
      // This is a known pre-event failure: `sendEvent` has not been called.
      throw new Error('matrix_send_failed')
    }

    if (matrixUploadTooLarge(error)) {
      // Keep the server's 413/error body on the SDK side of the closed-code seam.
      throw new Error('matrix_file_invalid')
    }

    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** A bot's turn ids are version-4 UUIDs; its app id is whatever id the catalog gives the app. */
const APP_BOT_TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const APP_SLUG = /^[a-z][a-z0-9_-]{0,63}$/u
const APP_ROUTE_ID = /^[a-z][a-z0-9_-]{0,63}$/u
/** An official bot's Matrix identity is derived from its app's slug (shared/app-catalog.ts). */
const appBotUserOf = (slug: string) => `@app-${slug}:atumplatform.com`
/**
 * Which official bot a notice is checked against: the app's catalog id and slug, and whether its
 * bot is guest-enabled. Main passes them from the signed catalog entry it opened the chat for, so
 * a new app needs no entry here.
 */
interface AppBotIdentity {
  appId: string
  slug: string
  guest: boolean
}

const APP_BOT_NOTICE_CODES = new Set([
  'needs_intake',
  'unsupported_content',
  'message_too_long',
  'cannot_read',
  'unverified_sender',
  'needs_setup',
  'link_pending',
  'allowance_exhausted',
  'guest_limit_reached',
  'quota_unavailable',
  'groups_unavailable',
  'busy',
  'rate_limited',
  'app_unavailable',
  'app_timeout',
  'outcome_unknown',
  'missed_while_offline',
  'sent_before_link',
  'andy_group_declined',
  'joined',
  'now_group',
  'andy_leaving'
])

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The action a bot's notice carries. What gives it authority is read and checked: its kind; the app
 * it names, which is the sending bot's own; for a route, a route id; for a recovery action, the code
 * it answers. Any other field is ignored and does not survive the read (the result is built here,
 * not passed through), so the platform can add fields without an older Atum refusing the notice.
 */
function appBotAction(value: unknown, bot: AppBotIdentity, code: unknown) {
  // The recovery actions of a guest-enabled bot (turn-memory/2, shared/app-catalog.ts): the
  // catalog says which bots have them, not their names.
  const guestAction = bot.guest && typeof code === 'string'
    ? ({
        guest_limit_reached: 'connect_account',
        quota_unavailable: 'retry_later',
        busy: 'wait',
        outcome_unknown: 'acknowledge_unknown'
      } as Readonly<Record<string, string>>)[code]
    : undefined

  if (value === null) {
    return guestAction ? undefined : null
  }

  if (
    !record(value) ||
    typeof value.kind !== 'string'
  ) {
    return undefined
  }

  // A recovery action names no app; if one is named anyway, it is the sending bot's own.
  if (
    (value.kind === 'retry_later' || value.kind === 'wait' || value.kind === 'acknowledge_unknown') &&
    value.kind === guestAction &&
    (value.app === undefined || value.app === bot.slug)
  ) {
    return { kind: value.kind } as const
  }

  // An action names the app whose bot sent it, and no other.
  if (value.app !== bot.slug) {
    return undefined
  }

  const app = bot.slug

  if (value.kind === 'open_setup' || value.kind === 'open_bot_dm') {
    return { kind: value.kind, app } as const
  }

  if (value.kind === 'open_app_route' && typeof value.route_id === 'string' && APP_ROUTE_ID.test(value.route_id)) {
    return { kind: value.kind, app, route_id: value.route_id } as const
  }

  if (value.kind === 'connect_account' && guestAction === 'connect_account') {
    return { kind: value.kind, app } as const
  }

  return undefined
}

type AppBotInviteMemberEvent = {
  getStateKey(): string | undefined
  getSender(): string | undefined
  getContent(): Record<string, unknown>
}

/**
 * An invited user cannot call `/members`: Synapse correctly returns forbidden
 * until the invite is accepted.  Matrix sync includes a stripped state snapshot
 * with the invitation, however.  Keep that snapshot separate from
 * `appBotMembers`, which deliberately remains an authoritative HTTP read for
 * joined rooms.
 */
export function appBotInviteSnapshot(
  membership: string | undefined,
  /** Undefined when the crypto store has not answered in time: neither plain nor encrypted. */
  encrypted: boolean | undefined,
  ownUserId: string,
  stateEvents: readonly AppBotInviteMemberEvent[]
) {
  const members = stateEvents
    .flatMap(event => {
      const content = event.getContent()
      const userId = event.getStateKey()

      if (
        typeof userId !== 'string' ||
        typeof content.membership !== 'string' ||
        !['join', 'invite'].includes(content.membership)
      ) {
        return []
      }

      return [{ userId, membership: content.membership }]
    })
    .sort((left, right) => left.userId.localeCompare(right.userId) || left.membership.localeCompare(right.membership))

  const ownInvite =
    membership === 'invite'
      ? stateEvents.find(event => event.getStateKey() === ownUserId && event.getContent().membership === 'invite')
      : undefined

  const content = ownInvite?.getContent()

  return {
    membership: membership ?? 'leave',
    encrypted,
    // The sender and direct flag are part of the stripped, signed Matrix state
    // event. `null` means the server did not include a direct hint; callers
    // must never infer one from an incomplete snapshot.
    inviter: typeof ownInvite?.getSender() === 'string' ? ownInvite.getSender() : null,
    isDirect: typeof content?.is_direct === 'boolean' ? content.is_direct : null,
    members
  }
}

async function appBotCurrentMembers(
  client: MatrixClient,
  roomId: string
): Promise<Array<AppBotAudienceMember & { displayName?: string }>> {
  const current = await client.members(roomId)
  return current.chunk
    .filter(member => typeof member.content.membership === 'string' && typeof member.state_key === 'string')
    .map(member => ({
      userId: member.state_key,
      membership: member.content.membership as string,
      ...(typeof member.content.displayname === 'string' ? { displayName: member.content.displayname } : {})
    }))
}

/**
 * Read a bot message's `io.atum.app_bot` metadata by the fields that give it meaning, and nothing
 * else: UI code never trusts a notice by type alone, and an unknown field is ignored, not believed.
 */
function appBotDisplayMetadata(value: unknown, bot: AppBotIdentity) {
  const appId = bot.appId

  if (!record(value) || value.v !== 1 || value.app_id !== appId || typeof value.kind !== 'string') {
    return null
  }

  if (
    value.kind === 'reply' &&
    typeof value.turn_id === 'string' &&
    APP_BOT_TURN_ID.test(value.turn_id) &&
    typeof value.part === 'number' &&
    Number.isInteger(value.part) &&
    typeof value.parts === 'number' &&
    Number.isInteger(value.parts) &&
    value.part >= 1 &&
    value.parts >= value.part &&
    value.parts <= 4
  ) {
    return {
      appId,
      kind: 'reply' as const,
      authenticated: true as const,
      turnId: value.turn_id,
      part: value.part,
      parts: value.parts
    }
  }

  const action = appBotAction(value.action, bot, value.code)

  if (
    value.kind === 'notice' &&
    value.turn_id === null &&
    typeof value.code === 'string' &&
    APP_BOT_NOTICE_CODES.has(value.code) &&
    action !== undefined
  ) {
    return { appId, kind: 'notice' as const, authenticated: true as const, code: value.code, action }
  }

  return null
}

/**
 * Bot API metadata has no legacy notice/turn wrapper. This is deliberately a
 * small evidence projection: D1 parses the full strict presentation payload,
 * while this path proves the official sender and (for encrypted rooms) its
 * pinned device before the renderer is allowed to use that payload.
 */
function botApiDisplayMetadata(value: unknown, bot: AppBotIdentity) {
  if (
    !record(value) ||
    value.version !== BOT_API_MATRIX_METADATA ||
    !APP_UUID.test(String(value.bot_id)) ||
    !Number.isSafeInteger(value.public_message_id) ||
    Number(value.public_message_id) < 1
  ) {
    return null
  }

  return {
    appId: bot.appId,
    kind: 'bot_api' as const,
    authenticated: true as const,
    botId: String(value.bot_id),
    publicMessageId: Number(value.public_message_id)
  }
}

function appBotMessageEvidence(content: Record<string, unknown>, bot: AppBotIdentity) {
  return appBotDisplayMetadata(content['io.atum.app_bot'], bot) ??
    botApiDisplayMetadata(content['io.atum.bot_api'], bot)
}

/** Remove only clear `m.room.message` wire events before IndexedDB receives a
 * sync response. Encrypted wire events, room state and crypto keys remain so
 * the bot is still an ordinary encrypted room member. */
export function appBotDurableSync(sync: Parameters<IndexedDBStore['setSyncData']>[0]) {
  const copy = structuredClone(sync)

  for (const bucket of [copy.rooms?.join, copy.rooms?.leave]) {
    if (!bucket) {
      continue
    }

    for (const room of Object.values(bucket)) {
      if (Array.isArray(room.timeline?.events)) {
        room.timeline.events = room.timeline.events.filter(event => event.type !== EventType.RoomMessage)
      }
    }
  }

  return copy
}

/** The real js-sdk IndexedDB store, with only its durable write inputs filtered. */
class AppBotIndexedDBStore extends IndexedDBStore {
  constructor(options: ConstructorParameters<typeof IndexedDBStore>[0]) {
    super(options)
    // IndexedDBStore installs setSyncData as an own arrow-function property.
    // A prototype override is shadowed, so wrap that actual initialized writer.
    const save = this.setSyncData
    this.setSyncData = sync => save(appBotDurableSync(sync))
  }

  override setPendingEvents(roomId: string, _events: Parameters<IndexedDBStore['setPendingEvents']>[1]) {
    // Local echoes carry our plaintext before the server returns ciphertext.
    // The app-bot journal owns retry/idempotency, so this store never needs them.
    return super.setPendingEvents(roomId, [])
  }
}

export async function startMatrixSdk(
  configuration: MatrixSdkConfiguration,
  refresh: (handle: string) => Promise<MatrixRefreshResult>,
  publish: (snapshot: MatrixSnapshot) => void,
  offerInvocation: (hint: MatrixInvocationHint) => void = () => {},
  offerNotification: (hint: MatrixNotificationHint) => void = () => {},
  offerGoogleFence: (observation: MatrixGoogleFenceObservation) => void = () => {},
  offerAppBotEvent: (hint: MatrixAppBotEvent) => void = () => {},
  offerUndecryptable: (observation: MatrixUndecryptableObservation) => void = () => {}
) {
  const appBotMode = configuration.mode === 'app-bot'
  const initialPrivateCosNotificationRoomIds = matrixCompanyPrivateCosNotificationRoomIds(
    configuration.companyPrivateCosNotificationRoomIds ?? []
  )

  if (!initialPrivateCosNotificationRoomIds) {
    throw new Error('matrix_company_private_cos_notifications_invalid')
  }

  const store = appBotMode
    ? new AppBotIndexedDBStore({ indexedDB, localStorage, dbName: `sync-${configuration.deviceId}` })
    : new IndexedDBStore({ indexedDB, localStorage, dbName: `sync-${configuration.deviceId}` })

  const recoveryKeys = recoveryKeyCache()
  let security: ReturnType<typeof matrixSecurity> | undefined
  // One question to the host at a time: a refused token and the host's own renewal notice
  // (`renewed`) arriving together share the host's one answer.
  let refreshing: Promise<MatrixRefreshResult> | undefined

  const refreshOnce = (handle: string) =>
    (refreshing ??= refresh(handle).finally(() => {
      refreshing = undefined
    }))

  const client = createClient({
    ...configuration,
    store,
    logger: quietLogger,
    cryptoCallbacks: recoveryKeys.callbacks,
    verificationMethods: ['m.sas.v1'],
    fetchFn: boundedMatrixFetch(),
    tokenRefreshFunction: configuration.refreshToken
      ? async handle => {
          const result = await refreshOnce(handle)

          if (result.ok) {
            return {
              accessToken: result.accessToken,
              refreshToken: result.refreshToken,
              ...(result.expiresAt ? { expiry: new Date(result.expiresAt) } : {})
            }
          }

          if (result.reauthenticate) {
            throw new TokenRefreshLogoutError(new Error('matrix_signed_out'))
          }

          throw new Error('matrix_refresh_unavailable')
        }
      : undefined
  })

  const earlierConversations = watchEarlierConversations(client, offerInvocation)
  const listener = watchMatrixInvocations(client, offerInvocation)
  // An agent host's groups (armed by main on agent hosts only): the owner's own mentions.
  const groupTurns = watchMatrixGroupTurns(client, offerInvocation)
  const agentTasks = watchAgentTasks(client, offerInvocation)
  const roomPolicy = matrixRoomPolicy(client, () => !stopped && state === 'ready')
  const stopGoogleFence = observeMatrixGoogleFence(client, offerGoogleFence)
  // Why a message couldn't be read, room and reason only (main logs it, hashed and rate-limited).
  // An app bot's host keeps no timeline and reports nothing.
  const stopUndecryptable = appBotMode ? () => {} : observeMatrixUndecryptable(client, offerUndecryptable)

  let roomId: string | null = null
  let readMarkerRoomId: string | null = null
  let readMarkerEventId: string | undefined
  let destination: MatrixDestination | null = null
  let appIds: string[] | null = null
  const selection = roomSelection(localStorage, configuration.userId, configuration.deviceId)
  let restoredSelection = false
  let selectionRevision = 0
  let conversationNotice: string | null = null
  let state: MatrixSnapshot['state'] = 'connecting'
  let stopped = false
  // The sync is reconnecting or failing within its grace (matrix-sync-health.ts).
  let degraded = false
  let observingSync = false

  // A degraded sync that outlasts its grace turns offline by itself: no sync event says so.
  // (A change a sync event brings is the event handler's own to publish.)
  const syncHealth = createMatrixSyncHealth({
    onChange: next => {
      if (!observingSync && next === 'offline' && state === 'ready' && !stopped) {
        degraded = false
        state = 'offline'
        snapshot()
      }
    }
  })

  const petLive = createPetLiveEvents<MatrixEvent>()
  const keyRetry = matrixTimelineKeyRetry(client, changed)
  const backupAvailability = matrixBackupAvailability(client, changed)
  let appBotWatching = false

  let markAppBotReady: () => void = () => {}

  const appBotReady = appBotMode
    ? new Promise<void>(resolve => {
        markAppBotReady = resolve
      })
    : Promise.resolve()

  const publishGoogleFence = matrixGoogleFencePublisher(client, configuration, () => !stopped && state === 'ready')
  let changingIgnore = false
  let directUpdates = Promise.resolve()
  // `createRoom` commits before sync brings the room here. Retain that result so a quick second
  // open opens the same room instead of creating another official-bot DM. This is the pending state
  // of a room made but not yet synced: the open holds the selection until sync brings the room
  // (`selectAppBotDirectRoom`), and the retry of an open whose wait ran out finds the same room here.
  // The record is kept across a restart (app-bot-created.ts) until the room is in the store: the
  // room's own marker and the pointer find it only once it is (or the pointer write succeeded), and a
  // restart in between must not make the next open a first use. What a previous run made is not
  // trusted until the server shows the account is still in it (`unsyncedAppBotDm`).
  const retainedAppBotDms = appBotCreatedRooms(localStorage, configuration.userId, configuration.deviceId)
  const createdAppBotDms = new Map(retainedAppBotDms.read())
  const restoredAppBotDms = new Set(createdAppBotDms.keys())
  const openingAppBotDms = new Map<string, Promise<AppBotDmOpened>>()
  // The waits for a bot's room to reach the store (`selectAppBotDirectRoom`): `stop` ends them.
  const appBotRoomWaits = new Set<() => void>()

  /** A chat this device made: kept in memory, and on this device until the room is in the store (when
   * sync won the race with `createRoom`'s answer, there is nothing to keep it for). */
  const rememberCreatedAppBotDm = (appId: string, direct: { botUserId: string; roomId: string }) => {
    createdAppBotDms.set(appId, direct)
    restoredAppBotDms.delete(appId)

    if (!client.getRoom(direct.roomId)) {
      retainedAppBotDms.write(appId, direct)
    }
  }

  const forgetCreatedAppBotDm = (appId: string) => {
    createdAppBotDms.delete(appId)
    restoredAppBotDms.delete(appId)
    retainedAppBotDms.remove(appId)
  }

  const lateAssistantReconciliations = new Map<
    string,
    { ownerRoomId: string; selectionRevision: number; expiresAt: number }
  >()

  let dirtyTimer: ReturnType<typeof setTimeout> | undefined
  let draftPruneTimer: ReturnType<typeof setTimeout> | undefined
  const timelineWindows = new Map<string, { timeline: ReturnType<Room['getLiveTimeline']>; limit: number }>()

  // A limited sync replaces a room's live timeline. Keep the projection bound attached to
  // the timeline it counted so a previously capped room can page the replacement normally.
  const timelineWindow = (room: Room) => {
    const timeline = room.getLiveTimeline()
    const previous = timelineWindows.get(room.roomId)

    if (previous?.timeline === timeline) {
      return previous
    }

    const next = { timeline, limit: MATRIX_TIMELINE_INITIAL_EVENTS }
    timelineWindows.set(room.roomId, next)

    return next
  }

  const shortcuts = appShortcuts(client, () => !stopped, changed)
  // An account that never chose a language is shown in the system's, where Atum speaks it.
  const systemLanguage = desktopLocaleFor(globalThis.navigator?.languages) ?? DEFAULT_DESKTOP_LOCALE
  const displayPreferences = matrixDisplayPreferences(client, configuration, () => !stopped, systemLanguage)
  const notificationPolicy = matrixNotificationPolicy(client, configuration, () => !stopped && state === 'ready')
  let privateCosNotificationRoomIds = initialPrivateCosNotificationRoomIds

  const receipts = matrixReadReceipts(client, {
    selected: () => roomId,
    ready: () => !stopped && state === 'ready',
    shareActivity: () => displayPreferences.snapshot(state === 'ready').shareActivity?.value !== false
  })

  const profile = matrixProfile(client, () => !stopped, changed)
  const presence = matrixPresence(client, configuration.userId, () => !stopped && state === 'ready', changed)
  const memberAvatars = matrixMemberAvatars(client, () => !stopped)
  const linkPreviews = matrixLinkPreviews(client, () => !stopped)
  const starter = matrixStarterOnboarding(client, configuration, () => !stopped && state === 'ready', changed)
  const firstRun = matrixFirstRunOnboarding(client, configuration, () => !stopped && state === 'ready', changed)

  // The Founder chat (founder/sdk-founder-chat.ts): its record, the chat itself, and trust.
  const founderChat = matrixFounderChat(client, configuration, {
    active: () => !stopped && state === 'ready',
    changed,
    rememberDirect: (userId, id) => rememberDirect(userId, id)
  })

  const checkIns = matrixCheckIns(client, configuration, () => !stopped && state === 'ready')
  const savedMessages = matrixSavedMessages(client, configuration, () => !stopped && state === 'ready')

  const notesSelf = matrixNotesSelf(
    client,
    configuration.userId,
    () => !stopped && state === 'ready',
    changed
  )

  type NotesSelfProjection = ReturnType<typeof notesSelf.snapshot>
  type NotesSelfProjectionOperation = 'assert-send' | 'can-use' | 'snapshot'

  let lastNotesSelfProjection: NotesSelfProjection = {
    state: 'uncreated',
    duplicates: [],
    quarantinedRoomIds: [],
    retiredRoomIds: [],
    pointerWritable: false
  }

  const reportNotesSelfProjectionFailure = (operation: NotesSelfProjectionOperation) => {
    // Never include the thrown value, room id or event content: provider errors can carry secrets.
    console.warn(`[matrix] notes-self projection failed (${operation})`)
  }

  const notesSelfSnapshot = (): NotesSelfProjection => {
    try {
      lastNotesSelfProjection = notesSelf.snapshot()
    } catch {
      reportNotesSelfProjectionFailure('snapshot')
    }

    return lastNotesSelfProjection
  }

  const notesSelfCanUse = (roomId: string): boolean => {
    try {
      return notesSelf.canUse(roomId)
    } catch {
      reportNotesSelfProjectionFailure('can-use')

      return false
    }
  }

  const notesSelfAssertSend = (roomId: string): void => {
    try {
      notesSelf.assertSend(roomId)
    } catch (error) {
      if (error instanceof Error && error.message === 'matrix_notes_self_quarantined') {
        throw error
      }

      reportNotesSelfProjectionFailure('assert-send')
      throw new Error('matrix_notes_self_unavailable')
    }
  }

  const drafts = matrixDrafts(
    client,
    configuration,
    () => !stopped && state === 'ready',
    Date.now,
    room => notesSelfCanUse(room.roomId)
  )

  const storeRuns = matrixStoreRuns(client, configuration, () => !stopped && state === 'ready')

  const notifications = watchMatrixNotifications(
    client,
    () => !stopped && state === 'ready' && displayPreferences.snapshot(true).notifications?.value === true,
    hint => {
      // IPC preserves send order. Publish current membership/preferences before
      // an alert, rather than making native consume the prior 40ms projection.
      snapshot()
      offerNotification({ ...hint, sound: hint.sound && displayPreferences.snapshot(true).sound?.value === true })
    },
    () => notificationPolicy.snapshot(state === 'ready'),
    id => privateCosNotificationRoomIds.has(id)
  )

  /**
   * Each shown room's plain decision by the crypto store as well as its synced state
   * (`plainRoomAnswer`), for the display projection, which is synchronous: asked once per room
   * and counted as encrypted until it answers. Only the store's own answer is kept. Once true it
   * stays true only while the room shows no encryption state (`matrixMessage` checks that again),
   * and the store never turns a room's encryption off, so its false is final. No answer (an error,
   * or none within `PLAIN_ANSWER_MS`) is kept as nothing: encrypted for now, asked again by the
   * next projection.
   */
  const plainVerdicts = new Map<string, boolean | 'asking'>()
  const threadRooms = new Set<Room>()

  const plainConfirmed = (room: Room): boolean => {
    const known = plainVerdicts.get(room.roomId)

    if (known === undefined && plainRoom(room)) {
      plainVerdicts.set(room.roomId, 'asking')
      void plainRoomAnswer(client, room).then(plain => {
        if (plain === undefined) {
          plainVerdicts.delete(room.roomId)

          return
        }

        plainVerdicts.set(room.roomId, plain)

        if (plain) {
          changed()
        }
      })
    }

    return known === true
  }

  const message = (event: MatrixEvent, ignored: ReadonlySet<string>, room: Room): MatrixMessage | null =>
    matrixMessage(
      keyRetry.project(event),
      client.getUserId(),
      ignored,
      room,
      petLive.has(event, room.roomId),
      plainConfirmed(room)
    )

  // Company inbox room caches keep one stable projector across publishes. The explicit revision
  // invalidates Activity or Threads content changes that keep the same event ids and list lengths.
  let activityIgnored: ReadonlySet<string> = new Set()
  let activityProjectionRevision = 0
  const activityMessage = (event: MatrixEvent, eventRoom: Room) => message(event, activityIgnored, eventRoom)

  const typingIn = (room: Room, ignored: ReadonlySet<string>) => matrixTyping(room, configuration.userId, ignored)

  const forgetThreadRoom = (room: Room) => {
    room.off(RoomEvent.UnreadNotifications, changed)
    room.off(ThreadEvent.New, changed)
    room.off(ThreadEvent.Update, changed)
    room.off(ThreadEvent.NewReply, changed)
    room.off(ThreadEvent.Delete, changed)
    threadRooms.delete(room)
  }

  const ensureThreadList = (room: Room) => {
    if (![MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '') ||
      threadRooms.has(room)) {
      return
    }

    threadRooms.add(room)
    room.on(RoomEvent.UnreadNotifications, changed)
    room.on(ThreadEvent.New, changed)
    room.on(ThreadEvent.Update, changed)
    room.on(ThreadEvent.NewReply, changed)
    room.on(ThreadEvent.Delete, changed)
    void room
      .createThreadsTimelineSets()
      .then(timelineSets => {
        if (timelineSets) {
          changed()
        } else {
          // Thread support can become known after the first prepared snapshot. A later sync
          // may try again; a null capability result must not pin this room as initialized.
          forgetThreadRoom(room)
        }
      })
      .catch(() => forgetThreadRoom(room))
  }

  function snapshot() {
    // A bot host must never receive the desktop projection.  In particular a projection
    // would retain a room list and decrypted timeline text in the parent process.
    if (stopped || appBotMode) {
      return
    }

    let room = roomId ? client.getRoom(roomId) : null

    if (room && ignoredInvitation(client, room)) {
      room = null
      roomId = null
      destination = null
      selection.write(null)
      selectionRevision++
    }

    // Freeze Matrix's standard fully-read marker once per room visit, before the renderer's
    // attend command lets the receipt scheduler advance it.
    if (readMarkerRoomId !== roomId) {
      readMarkerRoomId = roomId
      const marker = room?.getAccountData(EventType.FullyRead)?.getContent()?.event_id
      readMarkerEventId = typeof marker === 'string' && marker.startsWith('$') ? marker : undefined
    }

    petLive.loaded(room?.roomId ?? null)

    const history = room ? timelineWindow(room) : null
    const ignoredUsers = client.getIgnoredUsers()
    const ignored = new Set(ignoredUsers)
    activityIgnored = ignored

    for (const threaded of threadRooms) {
      if (threaded !== room || threaded.getMyMembership() !== 'join') {
        forgetThreadRoom(threaded)
      }
    }

    if (room?.getMyMembership() === 'join') {
      ensureThreadList(room)
    }

    // Moon's and Andy's chats: the roster draws each inside its bot's row, once.
    const appBots = appBotDmRooms(client)

    const projectedRooms = client
      .getRooms()
      .filter(r => r.roomId === roomId || ['join', 'invite'].includes(r.getMyMembership()))
      .filter(r => !ignoredInvitation(client, r))
      .map(r => {
        const appBot = appBots.get(r.roomId)

        return {
          ...conversationRoom(client, r),
          conversation: projectedConversationMarker(r, configuration.userId),
          conversationOwnerId: configuration.userId,
          ...(appBot ? { appBot } : {})
        }
      })

    const presenceUsers = new Set<string>([configuration.userId])

    for (const projected of projectedRooms) {
      if (projected.membership !== 'join' || !(projected.companyChannel || projected.companyConversation)) {
        continue
      }

      for (const participant of projected.participants ?? []) {
        if (participant.membership === 'join') {
          presenceUsers.add(participant.userId)
        }
      }
    }

    publish({
      state,
      ...(degraded && state === 'ready' ? { degraded: true as const } : {}),
      displayPreferences: displayPreferences.snapshot(state === 'ready'),
      notificationPolicy: notificationPolicy.snapshot(state === 'ready'),
      checkIns: checkIns.snapshot(state === 'ready'),
      savedMessages: savedMessages.snapshot(state === 'ready'),
      drafts: drafts.snapshot(state === 'ready'),
      notesSelf: notesSelfSnapshot(),
      starterMarker: starter.snapshot(),
      firstRunMarker: firstRun.snapshot(),
      firstRunWelcome: firstRun.welcome(),
      founderChat: founderChat.snapshot(),
      security: security ? { ...security.snapshot(), backupAvailable: backupAvailability.available() } : undefined,
      identity: { userId: configuration.userId, deviceId: configuration.deviceId },
      ownProfile: profile.snapshot(),
      presence: presence.snapshot(presenceUsers),
      rooms: projectedRooms,
      companyActivity: matrixCompanyActivity(
        projectedRooms,
        id => client.getRoom(id),
        configuration.userId,
        activityMessage,
        `${activityProjectionRevision}\0${ignoredUsers.toSorted().join('\0')}`
      ),
      companyThreads: matrixCompanyThreads(
        projectedRooms,
        id => client.getRoom(id),
        configuration.userId,
        activityMessage,
        MATRIX_COMPANY_THREADS_MAX,
        `${activityProjectionRevision}\0${ignoredUsers.toSorted().join('\0')}`
      ),
      roomId,
      destination: roomId ? { kind: 'room', roomId } : destination,
      appShortcuts: shortcuts.snapshot(appIds ?? [], state === 'ready'),
      members: room ? conversationMembers(room, configuration.userId) : [],
      ignoredUsers,
      canSend: room?.maySendMessage() ?? false,
      typing: room ? typingIn(room, ignored) : [],
      messages:
        room && history
          ? matrixRoomTimelineEvents(
              room,
              history.timeline,
              // Cut the room timeline first: ordinary-room thread events may fill gaps inside
              // this window, but never move its boundary or displace a pending local echo.
              history.timeline.getEvents().slice(-history.limit)
            )
              .map(event => message(event, ignored, room))
              .filter((m): m is MatrixMessage => m !== null)
              // Team Space replies remain panel rows. Ordinary-room SDK threads were flattened
              // above and project as normal rich replies because those rooms have no panel.
              .filter(value => value.thread !== true)
              .map(value => {
                const event = value.own ? room.findEventById(value.id) : undefined

                return { ...value, readBy: event ? publicReaders(room, event) : [] }
              })
          : [],
      ...(readMarkerEventId ? { readMarkerEventId } : {}),
      ...(room?.getMyMembership() === 'join' &&
      [MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '')
        ? { pinnedMessages: matrixPinnedMessages(room, configuration.userId, event => message(event, ignored, room)) }
        : {}),
      threads:
        room?.getMyMembership() === 'join' &&
        [MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '')
          ? matrixThreads(room, configuration.userId, event => message(event, ignored, room))
          : [],
      // Who came in and who is no longer in, from the channel's own membership events (the same
      // bound as the messages). Only a Team Space channel room has them.
      ...(room && history && room.getType() === MATRIX_COMPANY_CHANNEL_TYPE
        ? { membershipLines: matrixMembershipLines(room, history.timeline.getEvents().slice(-history.limit), ignored) }
        : {}),
      // A channel's intro opens its history only once nothing older is left to load (Slack's and
      // Mattermost's "start of the channel"), never above a window that still has pages behind it.
      ...(room &&
      history &&
      room.getType() === MATRIX_COMPANY_CHANNEL_TYPE &&
      timelineReachesStart(
        history.timeline.getEvents(),
        history.limit,
        history.timeline.getPaginationToken(Direction.Backward)
      )
        ? { historyStart: true as const }
        : {}),
      error: state === 'error' ? 'matrix_signed_out' : conversationNotice
    })
  }

  function changed() {
    if (!dirtyTimer && !stopped) {
      dirtyTimer = setTimeout(() => {
        dirtyTimer = undefined
        snapshot()
      }, 40)
    }
  }

  const scheduleDraftPrune = () => {
    if (draftPruneTimer || stopped || appBotMode || state !== 'ready') {
      return
    }

    draftPruneTimer = setTimeout(() => {
      draftPruneTimer = undefined
      void drafts.prune().catch(() => {})
    }, 250)
  }

  const activityContentChanged = () => {
    activityProjectionRevision++
    changed()
  }

  client.on(UserEvent.AvatarUrl, profile.synced)
  client.on(UserEvent.DisplayName, profile.synced)

  client.on(ClientEvent.Sync, (status, _previous, data) => {
    // A reconnecting or briefly failing sync is degraded, not offline (matrix-sync-health.ts):
    // the engine stays 'ready' so running turns, the lease and every watch carry on, and the
    // snapshot says `degraded` so main takes no new claim until the sync is back.
    observingSync = true
    const health = syncHealth.observe(status, data)
    observingSync = false
    degraded = health === 'degraded'
    state = health === 'offline' ? 'offline' : 'ready'

    // `SYNCING` can be the poll transition before restored rooms have been applied.
    // `PREPARED` is emitted after initial sync processing and is the first safe app-bot
    // command boundary.
    if (status === 'PREPARED') {
      markAppBotReady()
      scheduleDraftPrune()
    }

    if (state === 'ready' && !appBotMode) {
      void notesSelf.observedSync().catch(() => {})
    }

    if (matrixSyncTokenRefused(data)) {
      state = 'error'
    }

    // Restore once, after sync has populated membership. Never replay the pointer
    // over an explicit selection or on a later reconnect/background update.
    if (state === 'ready' && !restoredSelection) {
      restoredSelection = true

      if (!roomId && selectionRevision === 0) {
        const saved = selection.readDestination()
        const savedId = saved?.kind === 'room' ? saved.roomId : null
        const savedRoom = savedId ? client.getRoom(savedId) : null

        if (
          savedRoom &&
          ['join', 'invite'].includes(savedRoom.getMyMembership()) &&
          !ignoredInvitation(client, savedRoom)
        ) {
          roomId = savedId
        } else if (
          saved?.kind === 'discover' ||
          (saved?.kind === 'app' && (appIds === null || appIds.includes(saved.appId)))
        ) {
          destination = saved
        } else {
          selection.write(null)
        }
      }
    }

    // Authority-bearing readiness transitions must not be coalesced away by
    // the timeline's rendering debounce during a quick disconnect/reconnect.
    snapshot()
  })

  const roomChanged = (room: Room) => {
    void reconcileLateAssistantInvite(room).catch(() => {})
    void notesSelf.observedRoom().catch(() => {})
    scheduleDraftPrune()
    changed()
  }

  client.on(ClientEvent.Room, roomChanged)
  client.on(RoomEvent.Timeline, (event, room, toStart, removed, data) => {
    if (!stopped && !appBotMode && state === 'ready') {
      petLive.observed(event, room?.roomId ?? '', Boolean(toStart), Boolean(removed), data?.liveEvent === true)
    }

    if (room?.getType() === MATRIX_NOTES_SELF_ROOM_TYPE) {
      void notesSelf.observedRoom().catch(() => {})
    }

    changed()
  })
  client.on(RoomEvent.MyMembership, roomChanged)
  client.on(RoomEvent.LocalEchoUpdated, changed)
  client.on(RoomEvent.Name, changed)
  client.on(RoomEvent.Receipt, changed)
  client.on(RoomEvent.AccountData, changed)
  client.on(RoomStateEvent.Members, changed)
  client.on(RoomStateEvent.Events, changed)
  client.on(RoomMemberEvent.PowerLevel, changed)
  client.on(ClientEvent.AccountData, changed)
  client.on(ClientEvent.AccountData, event => shortcuts.observed(event.getType(), event.getContent()))
  client.on(MatrixEventEvent.Decrypted, activityContentChanged)

  if (appBotMode) {
    client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline, removed, data) => {
      // Remote Matrix events have `undefined` status; only a real local status
      // is a local echo/pending event. `!== null` incorrectly dropped every
      // production event and starved the host of intake hints.
      if (!appBotWatching || stopped || toStartOfTimeline || removed || !data?.liveEvent || event.status != null) {
        return
      }

      if (!room) {
        return
      }

      const roomId = room.roomId
      const eventId = event.getId()
      // A message is a hint when it arrives the way its room sends: encrypted where the room
      // has end-to-end encryption, plain where it has none (0.20 bot chats). A plaintext message
      // in an encrypted room never is (no downgrade), also while its encryption state has not
      // synced yet but the crypto store knows (`withJoinedWireType`).
      const arrived = event.getWireType()

      if (roomId && eventId?.startsWith('$')) {
        // A store that does not answer in time passes the hint on: the pipeline reads it again
        // (`appBotReadEvent`), and that read fails, to be retried by the scan, if it still cannot tell.
        withJoinedWireType(client, roomId, wireType => {
          if ((wireType === undefined || arrived === wireType) && appBotWatching && !stopped) {
            offerAppBotEvent({ roomId, eventId })
          }
        })
      }

      if (event.getWireType() === EventType.RoomMessage && eventId) {
        // Plaintext (a hostile one, an outbound local echo, or a plain room's message already
        // offered above) does not stay in the bot's in-memory timeline: every read re-fetches.
        room.removeEvent(eventId)
      }

      // The bot never renders a timeline. Keep only a small transport window; all authority
      // reads re-fetch a single event, so dropping an in-memory event cannot drop a turn.
      const retained = room.getLiveTimeline().getEvents()

      for (const old of retained.slice(0, Math.max(0, retained.length - 50))) {
        const oldId = old.getId()

        if (oldId) {
          room.removeEvent(oldId)
        }
      }
    })
    client.on(MatrixEventEvent.Decrypted, event => {
      // Crypto's MatrixEvent cache is a second plaintext retention path outside
      // IndexedDB. One-shot `appBotReadEvent` owns the only readable copy.
      // The SDK still consumes the completion in its current promise chain.
      // Clearing synchronously makes restored encrypted sync events appear
      // undecrypted while that chain is running and can stall initial sync.
      setTimeout(() => {
        const mutable = event as unknown as { clearEvent?: unknown }
        mutable.clearEvent = undefined
      }, 0)
    })
  }

  // An edit, a deletion (or one that failed), someone typing and a forgotten chat change what
  // the window shows too; a reaction arrives through the timeline.
  client.on(MatrixEventEvent.Replaced, activityContentChanged)
  client.on(RoomEvent.Redaction, activityContentChanged)
  client.on(RoomEvent.RedactionCancelled, activityContentChanged)
  client.on(RoomMemberEvent.Typing, changed)
  client.on(ClientEvent.DeleteRoom, deletedRoomId => {
    // A bot room made here is remembered until sync holds it. A room forgotten elsewhere
    // (another client's Delete chat) is no longer one to open.
    for (const [appId, direct] of createdAppBotDms) {
      if (direct.roomId === deletedRoomId) {
        forgetCreatedAppBotDm(appId)
      }
    }

    changed()
  })
  // The store holds a chat this device made: its own marker and the pointer find it from here, and
  // what was kept for the moment before is no longer needed (for this run's retries it stays in memory).
  client.on(ClientEvent.Room, arrived => {
    for (const [appId, direct] of createdAppBotDms) {
      if (direct.roomId === arrived.roomId) {
        restoredAppBotDms.delete(appId)
        retainedAppBotDms.remove(appId, arrived.roomId)
      }
    }
  })
  await store.startup()
  await client.initRustCrypto({
    cryptoDatabasePrefix: `crypto-${configuration.deviceId}`,
    storageKey: Uint8Array.from(atob(configuration.storageKey), c => c.charCodeAt(0))
  })
  const crypto = client.getCrypto()!
  security = matrixSecurity(client, recoveryKeys, changed)
  const agentIdentity = agentIdentityCarrier(client)
  const ownerRecovery = ownerRecoveryCarrier(client)
  initializeMatrixDeviceIsolation(crypto, configuration.deviceIsolation, configuration.keySharing)
  // Standard replies are projected from SDK threads only in the person's desktop window.
  // Hidden agent/app/controller engines keep the SDK default so room-timeline intake is stable.
  await client.startClient({ initialSyncLimit: 50, ...(configuration.threadSupport ? { threadSupport: true } : {}) })
  snapshot()

  /** Delete chat: the server forgets only a room you are no longer in, so leave it first;
   * forgetting drops it from this client and from every device of yours. History stays on
   * the server for everyone else in it.
   *
   * An official bot's chat is never left: a left bot room cannot be rejoined (it is
   * invite-only), so leaving orphaned its history and the next click made a new room. It is
   * kept, out of sight on every device of yours, until you open the bot again (app-bot-dm.ts). */
  async function forgetRoom(id: string): Promise<AppBotDmHidden | null> {
    const room = client.getRoom(id)

    if (state !== 'ready' || !room || !['join', 'invite', 'leave', 'ban'].includes(room.getMyMembership())) {
      throw new Error('matrix_membership_required')
    }

    const bot = appBotDmMarker(room, client.getSafeUserId())
    const keep = Boolean(bot && appBotDmUsable(room, client.getSafeUserId(), bot.appId, bot.botUserId))

    if (keep) {
      await hideAppBotDm(client, room)
    } else {
      if (['join', 'invite'].includes(room.getMyMembership())) {
        await client.leave(id)
      }

      for (const draft of drafts.snapshot(true).records.filter(value => value.room_id === id)) {
        await drafts.change({ roomId: id, ...(draft.thread_root_id ? { threadRootId: draft.thread_root_id } : {}) }, '')
      }

      for (const tag of ['m.favourite', 'm.lowpriority']) {
        if (room.tags?.[tag]) {
          await client.deleteRoomTag(id, tag)
        }
      }

      await markMatrixRoomUnread(client, room, false, { acknowledge: false })
      await client.forget(id, true)
    }

    // It is gone from the list, whatever was opened meanwhile.
    if (!stopped && roomId === id) {
      roomId = null
      destination = null
      selection.write(null)
      selectionRevision++
    }

    snapshot()

    return keep && bot ? { outcome: 'hidden', appId: bot.appId } : null
  }

  /** A room this account is in, encrypted or not (`joinedConversation`). */
  function joinedRoom(id: string) {
    return joinedConversation(client, id)
  }

  async function assertAppBotDirectAudience(roomId: string, directPerson: string): Promise<void> {
    let members: AppBotAudienceMember[]
    try {
      members = await appBotCurrentMembers(client, roomId)
    } catch {
      throw new AppBotAudienceError(APP_BOT_AUDIENCE_UNKNOWN)
    }
    if (!appBotDirectSafe(members, configuration.userId, directPerson)) {
      throw new AppBotAudienceError(APP_BOT_AUDIENCE_CHANGED)
    }
  }

  /** Whether a room has no end-to-end encryption: from this client's synced state, or from the
   * server's room state when a just-restored bot does not hold the room yet, and in both cases
   * only when the crypto store has never recorded the room as encrypted (plain-room.ts). A
   * failed server read counts as encrypted, so plaintext there stays unreadable. Undefined when
   * the crypto store has not answered in time (`plainRoomAnswer`): neither plain nor encrypted,
   * so the read that asked fails and is tried again, instead of withholding a plain message. */
  async function appBotPlainRoom(id: string): Promise<boolean | undefined> {
    const room = client.getRoom(id)

    if (room) {
      return plainRoomAnswer(client, room)
    }

    try {
      await client.getStateEvent(id, EventType.RoomEncryption, '')

      return false
    } catch (error) {
      return (error as { errcode?: unknown } | null)?.errcode === 'M_NOT_FOUND'
        ? plainRoomAnswer(client, { roomId: id, hasEncryptionStateEvent: () => false })
        : false
    }
  }

  /**
   * Whether this agent's or app's SDK may take the room main (or the cloud room set) admitted, by
   * what the invitation's state shows. A room with end-to-end encryption, as before 0.20. Without
   * it, only what was admitted, never any plain untyped room:
   * - `assistant`: the agent's own plain chat (`plainAgentRoom`: the assistant type, or a bot chat's
   *   marker);
   * - `group`: an ordinary group (no room type, not a direct chat of two), invited by its owner,
   *   the one who ran the group admission (`readGroupRoom`, `inviteAgentToGroup`);
   * - `app`: the app's own plain pair (an untyped room), or an app group bound to this owner and
   *   this app, invited by its owner (`readAppRoom`).
   * A room already joined changes nothing on join, so who invited it is not asked again.
   */
  function joinableAgentRoom(room: Room, command: { ownerId: string; scope: 'assistant' | 'group' | 'app' }): boolean {
    if (room.hasEncryptionStateEvent()) {
      return true
    }

    if (command.scope === 'assistant') {
      return plainAgentRoom(room)
    }

    const self = client.getSafeUserId()

    const fromOwner =
      room.getMyMembership() === 'join' ||
      room.currentState.getStateEvents(EventType.RoomMember, self)?.getSender() === command.ownerId

    if (!fromOwner || !command.ownerId || command.ownerId === self) {
      return false
    }

    if (command.scope === 'group') {
      return room.getType() === undefined && !isMatrixPrivateChat(client, room)
    }

    const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
    const binding = creation ? appGroupBinding(creation.getContent(), creation.getSender()) : undefined

    if (room.getType() === MATRIX_APP_GROUP_TYPE) {
      return binding?.owner === command.ownerId && binding.app === self
    }

    return room.getType() === undefined
  }

  function rememberDirect(userId: string, id: string) {
    // Optional labels must not hold the successful room operation open. Serialize
    // this client's account-data writes so quick consecutive DMs retain both.
    directUpdates = directUpdates.then(async () => {
      if (stopped) {
        return
      }

      try {
        await rememberDirectConversation(client, userId, id, () => !stopped)
        conversationNotice = null
      } catch {
        conversationNotice = 'matrix_direct_mapping_pending'
      }

      snapshot()
    })
  }

  async function devices(userId: string): Promise<MatrixDevice[]> {
    const info = await crypto.getUserDeviceInfo([userId], true)

    // The person's own devices: their names and when each was last active (the account's
    // device list), so they read as "iPhone · active 2 days ago", never as raw IDs. Display
    // only, and optional: a failed read keeps the verified list.
    const own =
      userId === configuration.userId
        ? new Map(
            ((await client.getDevices().catch(() => null))?.devices ?? []).map(device => [device.device_id, device])
          )
        : undefined

    const result = await Promise.all(
      [...(info.get(userId)?.values() ?? [])].map(async device => {
        const listed = own?.get(device.deviceId)
        const name = (listed?.display_name ?? device.displayName)?.trim().slice(0, 120)
        const lastSeenAt = listed?.last_seen_ts

        return {
          userId,
          deviceId: device.deviceId,
          fingerprint: device.getFingerprint() ?? '',
          verified: Boolean((await crypto.getDeviceVerificationStatus(userId, device.deviceId))?.isVerified()),
          ...(name ? { name } : {}),
          ...(typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt) ? { lastSeenAt } : {})
        }
      })
    )

    // The current device's keys needn't have arrived through sync yet.
    if (userId === configuration.userId && !result.some(d => d.deviceId === configuration.deviceId)) {
      result.push({
        userId,
        deviceId: configuration.deviceId,
        fingerprint: (await crypto.getOwnDeviceKeys()).ed25519,
        verified: true
      })
    }

    return result
  }

  /**
   * Open the bot's chat on the window: select its room, unless the person chose another since
   * `revision`. The window draws only rooms this store holds, and `createRoom` (or the platform
   * naming a room another Mac made) answers before sync has brought the room here: selecting it then
   * would draw "no conversation" until it arrives, and for good if it never does. So the room is
   * selected only once it is here. While it is on its way the person keeps what they were looking
   * at and the roster row keeps saying the chat is opening; past `APP_BOT_ROOM_WAIT_MS` the open
   * fails closed (`matrix_app_bot_syncing`), with the room, its marker and the pointer already
   * written, so the retry opens the same room.
   */
  async function selectAppBotDirectRoom(id: string, revision: number) {
    if (stopped || selectionRevision !== revision) {
      return
    }

    if (!client.getRoom(id)) {
      const wait = waitForRoom(
        {
          has: value => Boolean(client.getRoom(value)),
          watch: listener => {
            const arrived = (room: Room) => listener(room.roomId)
            client.on(ClientEvent.Room, arrived)

            return () => {
              client.off(ClientEvent.Room, arrived)
            }
          }
        },
        id
      )

      appBotRoomWaits.add(wait.cancel)

      const arrived = await wait.arrived.finally(() => appBotRoomWaits.delete(wait.cancel))

      if (stopped) {
        throw new Error('matrix_sdk_stopped')
      }

      // The person chose another room while this one was on its way: it is still theirs to open
      // later, and nothing says it failed.
      if (selectionRevision !== revision) {
        return
      }

      if (!arrived) {
        throw new Error('matrix_app_bot_syncing')
      }
    }

    roomId = id
    destination = null
    selection.write(roomId)
    selectionRevision++
    snapshot()
  }

  /** The room marker is enough to recover a canonical DM. The pointer is a durable index,
   * not a reason to make an already-created conversation look as if opening failed. A later
   * roster selection repairs a transiently failed write from the retained room id. */
  async function repairAppBotDirectPointer(
    pointerType: `io.atum.app_bot.dm.${string}`,
    botUserId: string,
    id: string
  ): Promise<boolean> {
    try {
      await client.setAccountData(pointerType, { v: 1, room_id: id, bot_user_id: botUserId })

      return true
    } catch {
      // The room's own marker, and the record of a chat made here (`createdAppBotDms`), still find
      // it. Main logs `pointer=write_failed` on the open's line.
      return false
    }
  }

  /** Every room the person has, or had, with this bot: rooms here with their marker for it, the
   * room the pointer names, the rooms `m.direct` lists for the bot (all a left room leaves
   * behind after a restart), and one made in this session that sync has not brought yet. */
  function appBotDmCandidates(appId: string, botUserId: string, pointedId: string | undefined) {
    const ownerId = client.getSafeUserId()
    const ids = new Set<string>()

    for (const room of client.getRooms()) {
      const marker = appBotDmMarker(room, ownerId)

      if (marker?.appId === appId && marker.botUserId === botUserId) {
        ids.add(room.roomId)
      }
    }

    if (pointedId) {
      ids.add(pointedId)
    }

    const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, unknown>>()?.[botUserId]

    for (const id of Array.isArray(direct) ? direct : []) {
      if (typeof id === 'string' && id.startsWith('!') && id.length <= 1024) {
        ids.add(id)
      }
    }

    // A chat made in this run that sync has not brought yet. One a previous run made is not trusted
    // until the server shows the account is still in it (`unsyncedAppBotDm`).
    const created = createdAppBotDms.get(appId)

    const pending =
      created?.botUserId === botUserId && !restoredAppBotDms.has(appId) && !client.getRoom(created.roomId)
        ? created.roomId
        : undefined

    if (pending) {
      ids.add(pending)
    }

    return [...ids].map(id =>
      id === pending
        ? {
            roomId: id,
            membership: 'join' as const,
            usable: true,
            invitedByBot: false,
            // Made in this session by `createConversation`: plain, like every bot chat since 0.20.
            encrypted: false,
            lastMessageAt: 0,
            lastActiveAt: Date.now()
          }
        : appBotDmCandidate(client, id, appId, botUserId)
    )
  }

  /** The room the account's pointer names on the server right now, never this device's sync cache
   * (which lags a write another device, or this one, made a moment ago). `undefined` when it names
   * none; throws when the server cannot say. */
  async function serverAppBotPointerRoom(
    pointerType: `io.atum.app_bot.dm.${string}`,
    botUserId: string
  ): Promise<string | undefined> {
    try {
      const pointer = await client.http.authedRequest<Record<string, unknown>>(
        Method.Get,
        `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${encodeURIComponent(pointerType)}`
      )

      return pointer?.v === 1 &&
        pointer.bot_user_id === botUserId &&
        typeof pointer.room_id === 'string' &&
        pointer.room_id.startsWith('!') &&
        pointer.room_id.length <= 1024
        ? pointer.room_id
        : undefined
    } catch (error) {
      if ((error as { errcode?: unknown } | null)?.errcode === 'M_NOT_FOUND') {
        return undefined
      }

      throw error
    }
  }

  /**
   * The bot's chat as the server's pointer names it right now, when that room works as the bot's
   * plain chat: one another of this person's Macs made while this one was choosing (each Mac
   * writes the pointer right after making the room). Read from the server, never the sync cache
   * (which lags another Mac's write); the room too when this device has not synced it yet. Any
   * failure is "none", and the open goes on as chosen.
   */
  async function serverAppBotDm(
    pointerType: `io.atum.app_bot.dm.${string}`,
    appId: string,
    botUserId: string
  ): Promise<string | undefined> {
    const ownerId = client.getSafeUserId()

    try {
      const id = await serverAppBotPointerRoom(pointerType, botUserId)

      if (!id || stopped) {
        return undefined
      }

      const synced = client.getRoom(id)

      // A room this device holds is plain only when the crypto store agrees (`confirmedPlainRoom`):
      // an encrypted chat made before 0.20 whose encryption state has not synced is never reused.
      if (synced?.getMyMembership() === 'join') {
        return appBotDmUsable(synced, ownerId, appId, botUserId) && (await confirmedPlainRoom(client, synced))
          ? id
          : undefined
      }

      if (!(await client.getJoinedRooms()).joined_rooms.includes(id)) {
        return undefined
      }

      return (await serverAppBotRoomWorks(id, appId, botUserId)) ? id : undefined
    } catch {
      return undefined
    }
  }

  /** Whether a room the account is in works as the bot's plain chat, from the room's own state on
   * the server: this account's marker for this bot, no encryption, the bot in it and nobody else but
   * the account. Throws when the server cannot say. */
  async function serverAppBotRoomWorks(id: string, appId: string, botUserId: string): Promise<boolean> {
    const ownerId = client.getSafeUserId()
    const state = await client.roomState(id)
    const marker = state.find(event => event.type === APP_BOT_DM_MARKER && event.state_key === '')

    const present = state.filter(
      event =>
        event.type === EventType.RoomMember && ['join', 'invite'].includes(String(event.content?.membership ?? ''))
    )

    return (
      marker?.sender === ownerId &&
      marker.content?.v === 1 &&
      marker.content.app_id === appId &&
      marker.content.bot_user_id === botUserId &&
      !state.some(event => event.type === EventType.RoomEncryption) &&
      present.some(event => event.state_key === botUserId) &&
      present.every(event => event.state_key === ownerId || event.state_key === botUserId)
    )
  }

  /**
   * The chat the account already has with the bot that this device's store does not hold yet: a room
   * this device made before a restart and never saw arrive (the record), or any room the server shows the
   * account is in that carries its marker for this bot. Asked before a second chat is made, because
   * the store only knows what sync has brought: `createRoom` answers before sync does, and when the
   * pointer write failed too, nothing else names the room after a restart. Read from the server's
   * list of rooms the account is in (never the sync cache), only the rooms the store lacks, a bounded
   * few (`APP_BOT_UNSYNCED_PROBES`), the record's room and the `m.direct` ones first.
   *
   * Throws `matrix_app_bot_syncing` when the server cannot say: a chat made on a guess cannot be taken
   * back, and the retry asks again. A room the server refuses to show is not the bot's chat.
   */
  async function unsyncedAppBotDm(appId: string, botUserId: string): Promise<string | undefined> {
    let joined: string[]

    try {
      joined = (await client.getJoinedRooms()).joined_rooms
    } catch {
      throw new Error('matrix_app_bot_syncing')
    }

    if (stopped) {
      throw new Error('matrix_sdk_stopped')
    }

    const kept = createdAppBotDms.get(appId)
    const restored = kept?.botUserId === botUserId && restoredAppBotDms.has(appId) ? kept.roomId : undefined
    const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, unknown>>()?.[botUserId]
    const likely = new Set<unknown>([restored, ...(Array.isArray(direct) ? direct : [])])
    const unsynced = joined.filter(id => !client.getRoom(id))

    const order = [...unsynced.filter(id => likely.has(id)), ...unsynced.filter(id => !likely.has(id))].slice(
      0,
      APP_BOT_UNSYNCED_PROBES
    )

    for (const id of order) {
      let works: boolean

      try {
        works = await serverAppBotRoomWorks(id, appId, botUserId)
      } catch (error) {
        const errcode = (error as { errcode?: unknown } | null)?.errcode

        if (errcode === 'M_FORBIDDEN' || errcode === 'M_NOT_FOUND') {
          continue
        }

        throw new Error('matrix_app_bot_syncing')
      }

      if (stopped) {
        throw new Error('matrix_sdk_stopped')
      }

      if (works) {
        // Confirmed by the server: from here it is this run's own pending room.
        if (id === restored) {
          restoredAppBotDms.delete(appId)
        }

        return id
      }
    }

    // What a previous run made is not among the rooms the account is in (or no longer works as the
    // bot's chat): nothing is waiting for it any more, unless a newer chat has replaced it meanwhile.
    if (restored && createdAppBotDms.get(appId)?.roomId === restored) {
      forgetCreatedAppBotDm(appId)
    }

    return undefined
  }

  /** Leave a room this client has just made only while the server shows nobody has written in it:
   * from its newest event back to its making, nothing but state. Any doubt (a failed read, a
   * longer history) keeps it: a room with messages is never left. */
  async function leaveEmptyCreatedRoom(id: string): Promise<boolean> {
    try {
      const page = await client.createMessagesRequest(id, null, 50, Direction.Backward)

      const events: Array<{ type?: unknown; state_key?: unknown } | undefined> = Array.isArray(page?.chunk)
        ? page.chunk
        : []

      if (
        events.some(event => event?.type === EventType.RoomCreate) &&
        events.every(event => typeof event?.state_key === 'string')
      ) {
        await client.leave(id)

        return true
      }
    } catch {
      // Kept: the winning chat is opened either way, and uncertain history is never discarded.
    }

    return false
  }

  /** One invite arriving just after the short first-open settle gets one bounded reconciliation.
   * It never moves the user from a different chat, and it leaves the owner room only after the
   * server proves that room contains state events and no messages. */
  async function reconcileLateAssistantInvite(room: Room): Promise<void> {
    if (stopped || state !== 'ready' || room.getMyMembership() !== 'invite') {
      return
    }

    const now = Date.now()

    for (const [agentId, pending] of lateAssistantReconciliations) {
      if (pending.expiresAt < now) {
        lateAssistantReconciliations.delete(agentId)

        continue
      }

      const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
      const members = room.currentState.getStateEvents(EventType.RoomMember)
      const ownerInvite = members.find(event => event.getStateKey() === configuration.userId)
      const agentMember = members.find(event => event.getStateKey() === agentId)

      if (
        creation?.getContent().type !== MATRIX_ASSISTANT_ROOM_TYPE ||
        creation.getSender() !== agentId ||
        members.length !== 2 ||
        ownerInvite?.getContent().membership !== 'invite' ||
        ownerInvite.getSender() !== agentId ||
        agentMember?.getContent().membership !== 'join'
      ) {
        continue
      }

      // One matching invite event consumes this pair's adaptive pass. A failed join is left for
      // ordinary retry/open behavior; it never starts a timer loop.
      lateAssistantReconciliations.delete(agentId)

      const adopted = await adoptAssistantRoomInvitation(
        client,
        { ownerId: configuration.userId, agentId, createdBy: 'agent' },
        () => !stopped && state === 'ready'
      )

      if (!adopted || adopted === pending.ownerRoomId) {
        continue
      }

      await leaveEmptyCreatedRoom(pending.ownerRoomId)
      rememberDirect(agentId, adopted)

      if (
        !stopped &&
        state === 'ready' &&
        roomId === pending.ownerRoomId &&
        selectionRevision === pending.selectionRevision
      ) {
        roomId = adopted
        destination = null
        selection.write(roomId)
        selectionRevision++
        snapshot()
      }
    }
  }

  /** The rooms a choice reads (`appBotDmCandidates`), each checked against the crypto store: a room
   * whose encryption state has not synced here while the store has it as encrypted is a chat made
   * before 0.20, never reused as the plain chat. Only the store's own answer changes the choice: no
   * answer leaves it to the synced view (what is read or sent there still waits for the store). */
  async function plainAppBotDmCandidates(appId: string, botUserId: string, pointedId: string | undefined) {
    return Promise.all(
      appBotDmCandidates(appId, botUserId, pointedId).map(async candidate => {
        const room = candidate.membership === 'join' && !candidate.encrypted ? client.getRoom(candidate.roomId) : null

        return room && (await plainRoomAnswer(client, room)) === false ? { ...candidate, encrypted: true } : candidate
      })
    )
  }

  /** The bot's new plain one-to-one chat: `is_direct`, the bot invited, this account's marker in
   * its initial state. Nothing is selected and no pointer is written. */
  function createAppBotRoom(appId: string, botUserId: string) {
    return createConversation(client, {
      name: '',
      direct: true,
      invite: [botUserId],
      initialState: [
        {
          type: APP_BOT_DM_MARKER,
          state_key: '',
          content: { v: 1, app_id: appId, bot_user_id: botUserId }
        }
      ]
    })
  }

  /** Open the bot's one chat (app-bot-dm.ts `chooseAppBotDm`): reuse, recover or rejoin a room
   * the person has with it, and make a new one only when none can be used.
   *
   * Two Macs opening the bot at once must not leave two chats: before making a room, just before
   * writing the pointer to one it made, and again right after that write, the server's pointer is
   * read (`serverAppBotDm`). A working room another Mac made meanwhile is opened instead, and the
   * room this Mac made in the same moment is left while it is still empty
   * (`leaveEmptyCreatedRoom`), so both end in the same chat. A room with messages is never left. */
  async function performOpenAppBotDm(appId: string, botUserId: string): Promise<AppBotDmOpened> {
    const pointerType: `io.atum.app_bot.dm.${string}` = `io.atum.app_bot.dm.${appId}`
    const revision = selectionRevision
    const pointedId = appBotDmPointer(client, appId, botUserId)

    const candidates = await plainAppBotDmCandidates(appId, botUserId, pointedId)
    let choice = chooseAppBotDm(pointedId, candidates)
    // The server's pointer already names the room opened: nothing to write.
    let serverPointed = false
    // This Mac made the room opened, and points the account at it.
    let made = false
    // The server shows a chat this device's store lacks (`unsyncedAppBotDm`): opened, its pointer written.
    let unsynced = false
    let id: string

    if (choice.action === 'create') {
      const made = await serverAppBotDm(pointerType, appId, botUserId)

      if (made) {
        choice = { action: 'open', roomId: made, outcome: 'recovered', reason: 'pointer' }
        serverPointed = true
      }
    }

    if (choice.action === 'create') {
      // Before a second chat: one the store does not hold yet (made here before a restart, or by a
      // client whose room has not synced) is the person's chat, and opens when sync brings it.
      const found = await unsyncedAppBotDm(appId, botUserId)

      if (found) {
        choice = { action: 'open', roomId: found, outcome: 'recovered', reason: 'pointer_missing' }
        unsynced = true
      }
    }

    if (choice.action === 'create') {
      if (choice.retire) {
        // Moving out of an encrypted chat (before 0.20): mark it moved first, while the
        // pointer may still name it. The note is display only, so a failed write does not stop
        // the move; the next open finds the plain room and reuses it.
        await markAppBotRoomMoved(choice.retire, appId, botUserId, Date.now()).catch(() => {})
      }

      const room = await createAppBotRoom(appId, botUserId)
      const raced = await serverAppBotDm(pointerType, appId, botUserId)

      if (raced && raced !== room.room_id) {
        // Another Mac made the bot's chat in the same moment and its pointer landed first: use
        // that one, and leave the room made here while it is empty so only one chat remains.
        await leaveEmptyCreatedRoom(room.room_id)
        id = raced
        serverPointed = true
      } else {
        // Remember the committed room before either optional m.direct metadata or the canonical
        // pointer can fail. A retry in this SDK session opens this exact room.
        rememberCreatedAppBotDm(appId, { botUserId, roomId: room.room_id })
        id = room.room_id
        made = true
      }
    } else {
      if (choice.action === 'join') {
        await client.joinRoom(choice.roomId)
      }

      id = choice.roomId
    }

    let pointer: AppBotDmPointer = 'kept'

    if (pointedId !== id) {
      if (!serverPointed) {
        pointer = (await repairAppBotDirectPointer(pointerType, botUserId, id)) ? 'written' : 'write_failed'
      }

      // Read back: another Mac that made its room in the same moment may have written its pointer
      // just after this one. The last write names the chat both open; the room made here is left
      // while it is empty, and kept (never left) once anyone has written in it.
      const winner = made ? await serverAppBotDm(pointerType, appId, botUserId) : undefined

      if (winner && winner !== id) {
        await leaveEmptyCreatedRoom(id)

        if (createdAppBotDms.get(appId)?.roomId === id) {
          forgetCreatedAppBotDm(appId)
        }

        id = winner
        pointer = 'kept'
      }

      rememberDirect(botUserId, id)
    }

    // Delete chat kept this room out of sight; opening the bot shows the same room again. A
    // failed write leaves it flagged (main logs `shown=failed`), and the room still opens.
    const shown: AppBotDmShown = await showAppBotDm(client, id).then(
      showed => (showed ? 'shown' : 'none'),
      () => 'failed'
    )

    await selectAppBotDirectRoom(id, revision)

    return {
      roomId: id,
      outcome: choice.outcome,
      reason: choice.reason,
      // Plain chats only: an encrypted one made before 0.20 is no longer opened as the bot's chat.
      joined:
        candidates.filter(candidate => candidate.usable && !candidate.encrypted).length +
        (choice.action === 'open' && !serverPointed && !unsynced ? 0 : 1),
      left: candidates.filter(candidate => candidate.membership === 'gone').length,
      pointer,
      shown
    }
  }

  /** The existing "moved" note on an official bot's old chat (`io.atum.app_bot.legacy_moved`,
   * per-person room account data): display guidance only, read by `conversationRoom`. */
  async function markAppBotRoomMoved(id: string, appId: string, botUserId: string, movedAt: number) {
    const content = { v: 1, app_id: appId, bot_user_id: botUserId, moved_at: movedAt }

    await client.setRoomAccountData(id, 'io.atum.app_bot.legacy_moved' as never, content as never)
    // The server holds it now; its sync echo can lag, and the note should show at once.
    client.getRoom(id)?.addAccountData([new MatrixEvent({ type: 'io.atum.app_bot.legacy_moved', content })])
  }

  function openAppBotDm(appId: string, botUserId: string): Promise<AppBotDmOpened> {
    const key = `${appId}\u0000${botUserId}`
    const pending = openingAppBotDms.get(key)

    if (pending) {
      return pending
    }

    const opening = performOpenAppBotDm(appId, botUserId)
    openingAppBotDms.set(key, opening)

    const clear = () => {
      if (openingAppBotDms.get(key) === opening) {
        openingAppBotDms.delete(key)
      }
    }

    void opening.then(clear, clear)

    return opening
  }

  /**
   * The steps this device keeps when the platform decides which room is the bot's chat
   * (`POST /api/matrix/v1/apps/{slug}/bot/start`, spec/canonical-room/v1.1; the order is
   * electron/matrix/app-bots/platform-room.ts). Two Macs starting at once cannot both be right, so
   * none of these four picks a winner: they find a chat to offer, make a candidate, open the room the
   * platform names, and leave a candidate that lost. The plaintext preference is the local rule's:
   * only a plain chat is offered, made or opened.
   *
   * The plain chat this device already has with the bot, to offer the platform: it records the room
   * as the bot's chat when none is recorded, so a person who chatted before the route existed keeps
   * their history. Only a room that works as the bot's plain chat now is offered (`chooseAppBotDm`'s
   * `open` answers): an invitation back and a new room are not. Looks only.
   */
  async function findAppBotDm(appId: string, botUserId: string): Promise<AppBotDmFound> {
    const selection = selectionRevision
    const pointedId = appBotDmPointer(client, appId, botUserId)
    const choice = chooseAppBotDm(pointedId, await plainAppBotDmCandidates(appId, botUserId, pointedId))

    // Where this device's store has none: a chat it lacks (made here before a restart) is the one to
    // offer, not nothing. An invitation back is not offered.
    const roomId =
      choice.action === 'open'
        ? choice.roomId
        : choice.action === 'create'
          ? await unsyncedAppBotDm(appId, botUserId)
          : undefined

    return { roomId: roomId && isCanonicalMatrixRoomId(roomId) ? roomId : null, selection }
  }

  /** A new plain one-to-one chat with the bot, to offer the platform. Not selected and no pointer or
   * `m.direct` entry yet: those follow when the platform keeps it (`openAppBotRoom`), so a candidate
   * that lost leaves nothing behind. Remembered like the local open's (kept across a restart until
   * the room is in the store), so a retry before sync brings the room offers this one instead of
   * making another. */
  async function makeAppBotDm(appId: string, botUserId: string): Promise<AppBotDmMade> {
    const pointedId = appBotDmPointer(client, appId, botUserId)
    const choice = chooseAppBotDm(pointedId, await plainAppBotDmCandidates(appId, botUserId, pointedId))
    const retire = choice.action === 'create' ? choice.retire : undefined

    // As when this device decides alone: a chat from before 0.20 is marked moved. The note is
    // display only, so a failed write does not stop the new chat.
    if (retire) {
      await markAppBotRoomMoved(retire, appId, botUserId, Date.now()).catch(() => {})
    }

    const room = await createAppBotRoom(appId, botUserId)

    if (!isCanonicalMatrixRoomId(room.room_id)) {
      throw new Error('matrix_app_bot_dm_invalid')
    }

    rememberCreatedAppBotDm(appId, { botUserId, roomId: room.room_id })

    return { roomId: room.room_id, moved: retire !== undefined }
  }

  /** A refusal of a room read or write, by what a retry can change: a room the server will not show
   * the person is not their chat; any other failure is a moment's, never a reason to look elsewhere
   * (which could make a second chat). */
  function appBotRoomRefusal(error: unknown): Error {
    const errcode = (error as { errcode?: unknown } | null)?.errcode

    return new Error(
      errcode === 'M_FORBIDDEN' || errcode === 'M_NOT_FOUND' ? 'matrix_app_bot_dm_invalid' : 'matrix_app_bot_resting'
    )
  }

  /**
   * Open the room the platform named as the bot's chat. The server decided which room it is; this
   * device makes sure it can be opened as the bot's chat, from the server's own state (a room another
   * device just made may not have synced here): not encrypted, and only the person and the bot in it.
   * It then brings its records in line: the room's marker (a room another client made may have none),
   * the account's pointer and `m.direct`, a deleted chat shown again, and the selection, unless the
   * person chose another room since `selection`.
   */
  async function openAppBotRoom(
    appId: string,
    botUserId: string,
    id: string,
    selection: number | undefined
  ): Promise<AppBotDmOpened> {
    const revision = selection ?? selectionRevision
    const ownerId = client.getSafeUserId()
    const pointerType: `io.atum.app_bot.dm.${string}` = `io.atum.app_bot.dm.${appId}`
    const pointedId = appBotDmPointer(client, appId, botUserId)

    const state = await client.roomState(id).catch((error: unknown) => {
      throw appBotRoomRefusal(error)
    })

    if (stopped) {
      throw new Error('matrix_sdk_stopped')
    }

    if (state.some(event => event.type === EventType.RoomEncryption)) {
      throw new Error('matrix_app_bot_dm_encrypted')
    }

    const present = state.filter(
      event =>
        event.type === EventType.RoomMember && ['join', 'invite'].includes(String(event.content?.membership ?? ''))
    )

    if (
      !present.some(event => event.state_key === ownerId && event.content?.membership === 'join') ||
      !present.some(event => event.state_key === botUserId) ||
      !present.every(event => event.state_key === ownerId || event.state_key === botUserId)
    ) {
      throw new Error('matrix_app_bot_dm_invalid')
    }

    const marker = state.find(event => event.type === APP_BOT_DM_MARKER && event.state_key === '')
    const markerApp = marker?.content?.app_id
    const markerBot = marker?.content?.bot_user_id

    // Another app's or another bot's marker: this room is not the bot's chat, whatever the server says.
    if ((markerApp !== undefined && markerApp !== appId) || (markerBot !== undefined && markerBot !== botUserId)) {
      throw new Error('matrix_app_bot_dm_invalid')
    }

    // The account's own marker is what recognises the room as the bot's chat (`appBotDmMarker`).
    if (!(marker?.sender === ownerId && marker.content?.v === 1 && markerApp === appId && markerBot === botUserId)) {
      const content = { v: 1, app_id: appId, bot_user_id: botUserId }

      await client.sendStateEvent(id, APP_BOT_DM_MARKER as never, content as never, '').catch((error: unknown) => {
        throw appBotRoomRefusal(error)
      })

      // The sync echo can lag, and the chat should be the bot's at once.
      client
        .getRoom(id)
        ?.currentState.setStateEvents([
          new MatrixEvent({ type: APP_BOT_DM_MARKER, state_key: '', room_id: id, sender: ownerId, content })
        ])
    }

    let pointer: AppBotDmPointer = 'kept'

    if (pointedId !== id) {
      pointer = (await repairAppBotDirectPointer(pointerType, botUserId, id)) ? 'written' : 'write_failed'
      rememberDirect(botUserId, id)
    }

    const shown: AppBotDmShown = await showAppBotDm(client, id).then(
      showed => (showed ? 'shown' : 'none'),
      () => 'failed'
    )

    const candidates = await plainAppBotDmCandidates(appId, botUserId, pointedId)
    await selectAppBotDirectRoom(id, revision)

    return {
      roomId: id,
      outcome:
        pointedId === id ? 'reused' : createdAppBotDms.get(appId)?.roomId === id ? 'created' : 'recovered',
      reason: 'canonical',
      joined:
        candidates.filter(candidate => candidate.usable && !candidate.encrypted).length +
        (candidates.some(candidate => candidate.roomId === id && candidate.usable && !candidate.encrypted) ? 0 : 1),
      left: candidates.filter(candidate => candidate.membership === 'gone').length,
      pointer,
      shown
    }
  }

  /** Leave a chat that lost the race, only while the server shows nobody has written in it
   * (`leaveEmptyCreatedRoom`). Never the room the account's pointer names, read from the server (the
   * pointer `openAppBotRoom` wrote a moment ago has not synced here); a pointer the server cannot
   * read keeps the chat too. */
  async function leaveAppBotDm(appId: string, botUserId: string, id: string): Promise<AppBotDmLeft> {
    const pointerType: `io.atum.app_bot.dm.${string}` = `io.atum.app_bot.dm.${appId}`
    const pointed = await serverAppBotPointerRoom(pointerType, botUserId).then(room => room === id, () => true)
    const left = pointed ? false : await leaveEmptyCreatedRoom(id)

    if (createdAppBotDms.get(appId)?.roomId === id) {
      forgetCreatedAppBotDm(appId)
    }

    return { left }
  }

  /** The bot of the room the person's pointer names, when that room works as its chat. */
  function officialAppBotDirectRoom(appId: string, userId: string, candidateId: string): string | null {
    if (!APP_UUID.test(appId) || userId !== client.getSafeUserId()) {
      return null
    }

    const pointer = client.getAccountData(`io.atum.app_bot.dm.${appId}`)?.getContent<Record<string, unknown>>()
    const botUserId = typeof pointer?.bot_user_id === 'string' ? pointer.bot_user_id : undefined
    const room = client.getRoom(candidateId)

    return botUserId &&
      appBotDmPointer(client, appId, botUserId) === candidateId &&
      room &&
      appBotDmUsable(room, userId, appId, botUserId)
      ? botUserId
      : null
  }

  async function command(command: MatrixSdkCommand): Promise<unknown> {
    // Count peer/trust checks and legacy-room encryption inside the upload-stage
    // budget too. If they consume it, upload aborts immediately instead of eating
    // the event-send reserve in the host's outer deadline.
    const attachmentUploadDeadline = command.kind === 'attach' || command.kind === 'forward' || command.kind === 'appBotApiSend' && command.photo
      ? Date.now() + MATRIX_ATTACHMENT_UPLOAD_TIMEOUT_MS
      : 0

    if (stopped) {
      throw new Error('matrix_sdk_stopped')
    }

    switch (command.kind) {
      case 'companyPrivateCosNotificationRooms': {
        const next = matrixCompanyPrivateCosNotificationRoomIds(command.roomIds)

        if (!next) {
          throw new Error('matrix_company_private_cos_notifications_invalid')
        }

        privateCosNotificationRoomIds = next

        return null
      }

      case 'publishGoogleFence':
        return publishGoogleFence(command.identity)

      case 'starterSeen':
        await starter.acknowledge(command.identity)
        snapshot()

        return null

      case 'firstRunAnswered':
        await firstRun.answer(command.identity, command.answer, command.welcome)
        snapshot()

        return null

      case 'firstRunWelcome':
        await firstRun.settle(command.identity, command.state)
        snapshot()

        return null

      case 'founderChat':
        return founderChat.apply(command)

      case 'profileRead':

      case 'profileOpen':

      case 'profileUpload':

      case 'profileCommit':

      case 'profileName':

      case 'profileSyncName':

      case 'profileDiscard':
        if (state !== 'ready' && command.kind !== 'profileDiscard') {
          throw new Error('matrix_profile_unavailable')
        }

        return profile.command(command)

      case 'setOwnPresence':
        return presence.setAvailability(command.presence)

      case 'setStatus':
        return presence.setStatus(command.status)

      case 'memberAvatar':
        if (state !== 'ready') {
          throw new Error('matrix_member_avatar_unavailable')
        }

        return memberAvatars.read(command.roomId, command.userId)

      case 'linkPreview':
        if (state !== 'ready') {
          return null
        }

        return linkPreviews.read(command.roomId, command.eventId)

      case 'companyAvatarUpload':
        if (state !== 'ready') {
          throw new Error('matrix_company_avatar_unavailable')
        }

        return memberAvatars.uploadCompany(command.photo)

      case 'companyAvatarRead':
        if (state !== 'ready') {
          throw new Error('matrix_company_avatar_unavailable')
        }

        return memberAvatars.readCompanyRoom(command.roomId)

      case 'displayPreference':
        if (state !== 'ready') {
          throw new Error('matrix_display_preference_unavailable')
        }

        await displayPreferences.change(command)

        return null

      case 'notificationPolicy':
        await notificationPolicy.change(command)

        return null

      case 'checkInsChange':
        await checkIns.change(command)

        return null

      case 'checkInsFeedback':
        await checkIns.feedback(command)

        return null

      case 'checkInsRead':
        return checkIns.read()

      case 'checkInsLedger':
        await checkIns.writeLedger(command.ledger)

        return null

      case 'storeRunsRead':
        return storeRuns.read(command.assistantId)

      case 'storeRunsWrite':
        await storeRuns.write(command.assistantId, command.ledger)

        return null

      case 'agentIdentityToDeviceSend':

      case 'agentIdentityToDeviceRead':
        return agentIdentity.command(command)

      case 'agentRecoveryGenerate':
        return agentIdentity.generateRecoveryKey()

      case 'awarenessPrepareControls':
        return (await import('./awareness-controls')).prepareAwarenessControls(client,()=>!stopped && state === 'ready')

      case 'awarenessControl':
        return (await import('./awareness-controls')).sendAwarenessControl(client,command.control,()=>!stopped && state === 'ready')

      case 'awarenessRooms':
        return (await import('./awareness-controls')).readAwarenessRooms(client,()=>!stopped && state === 'ready')

      case 'awarenessRoomChange':
        return (await import('./awareness-controls')).changeAwarenessRoom(client,command.roomId,command.action,()=>!stopped && state === 'ready')

      case 'deviceIsolation':

      case 'peerIdentity':
        throw new Error('matrix_command_invalid')

      case 'agentVerificationStart':

      case 'peerIdentityRead':

      case 'peerIdentityStart':

      case 'peerIdentityContinue':

      case 'securityStatus':

      case 'ownerReaderCrossSignDevice':

      case 'ownerReaderVerificationPrepare':

      case 'ownerReaderVerificationRead':

      case 'ownerReaderVerificationRespond':

      case 'agentIdentityStatus':

      case 'agentIdentityCreate':

      case 'agentIdentityRestore':

      case 'agentRecoveryKey':

      case 'ownerRecovery':

      case 'ownerStatus':

      case 'recoveryCheck':

      case 'ownerRestore':

      case 'agentTrustStatus':

      case 'approvalRequest':

      case 'ownDevices':

      case 'approvalMarker':

      case 'approveOwnDevice':

      case 'nameOwnDevice':
        return security!.nativeCommand(command)

      case 'ownerRecoveryToDeviceSend':

      case 'ownerRecoveryToDeviceRead':

      case 'ownerRecoveryChannelOpen':

      case 'ownerRecoveryDrops':
        return ownerRecovery.command(command)

      case 'verificationStart':

      case 'verificationRespond':

      case 'recoveryCreateKey':

      case 'recoverySetUp':

      case 'recoveryDiscard':

      case 'recoveryRestore':
        return security!.command(command)

      case 'watchInvocations':
        // A cloud room-set watch covers every room of the agent with its owner (`roomIds`).
        for (const id of command.watch
          ? command.watch.roomIds?.length
            ? command.watch.roomIds
            : [command.watch.roomId]
          : []) {
          joinedRoom(id)
        }

        listener.set(command.watch)

        return null

      case 'scanInvocations':
        joinedRoom(command.watch.roomId)

        return scanMatrixInvocations(client, command.watch)

      case 'watchAgentTasks':
        agentTasks.set(command.watch)

        return null

      case 'scanAgentTasks':
        return scanAgentTasks(client, command.watch, () => !stopped && state === 'ready')

      case 'reconcileAgentTasks':
        return reconcileAgentTaskRooms(client, command, () => !stopped && state === 'ready')

      case 'reconcileAgentTaskCoordinators':
        return reconcileAgentTaskCoordinators(client, command, () => !stopped && state === 'ready')

      case 'listAgentTasks':
        return queryAgentTaskRooms(client, command, () => !stopped && state === 'ready')

      case 'readAgentTaskRoom':
        return readAgentTaskRoom(client, command, () => !stopped && state === 'ready')

      case 'createAgentTask':
        return createAgentTaskRoom(client, command, () => !stopped && state === 'ready')

      case 'sendAgentTask':
        return sendAgentTaskEvent(client, command, () => !stopped && state === 'ready')

      case 'watchGroupTurns':
        groupTurns.set(command.watch)
        earlierConversations.set(command.watch)

        return null

      case 'readGroupRoom':
        return readGroupRoom(client, command, () => !stopped)

      case 'ownerGroupPolicy':
        return roomPolicy.settings(command)

      case 'readRoomPolicy':
        return roomPolicy.read(command)

      case 'readGroupSettled':
        return readGroupSettled(client, command, () => !stopped && state === 'ready')

      case 'writeRoomUsage':
        return roomPolicy.usage(command)

      case 'readGroupRecent':
        return readGroupRecent(client, command, () => !stopped && state === 'ready')

      case 'inviteAgent':
        if (state !== 'ready') {
          throw new Error('matrix_offline')
        }

        await inviteAgentToGroup(client, command, () => !stopped && state === 'ready')
        snapshot()

        return null
      case 'joinAgentRoom': {
        // Main's explicit owner action may arrive before the invitation sync.
        // Bounded wait for SDK state, never force-join an arbitrary room.
        const deadline = Date.now() + 15_000

        while (!stopped && !client.getRoom(command.roomId) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }

        const room = client.getRoom(command.roomId)

        if (
          stopped ||
          !room ||
          !['invite', 'join'].includes(room.getMyMembership()) ||
          !joinableAgentRoom(room, command)
        ) {
          throw new Error('matrix_encrypted_invite_required')
        }

        if (room.getMyMembership() === 'invite') {
          await client.joinRoom(command.roomId)
        }

        return null
      }

      case 'ensureAssistantConversation': {
        if (state !== 'ready' || stopped || command.ownerId === configuration.userId ||
          !/^@[^:\s]+:[^\s]+$/u.test(command.ownerId) || command.ownerId.length > 1024) {
          throw new Error('matrix_agent_conversation_invalid')
        }

        const existing = await findAssistantRoom(
          client,
          {
            ownerId: command.ownerId,
            agentId: configuration.userId,
            allowOwnerInviteByAgent: true
          },
          () => !stopped && state === 'ready'
        )

        if (existing) {
          return existing
        }

        // Only an account with no joined main adopts the ordinary owner-created direction. A
        // controller restart must not replace its established main with a newer pending invite.
        const invited = AGENT_ONE_CONVERSATION
          ? await adoptAssistantRoomInvitation(
              client,
              { ownerId: command.ownerId, agentId: configuration.userId, createdBy: 'owner' },
              () => !stopped && state === 'ready'
            )
          : null

        if (invited) {
          rememberDirect(command.ownerId, invited)

          return invited
        }

        const room = await createConversation(client, {
          name: '', invite: [command.ownerId], direct: true, ownerAdmin: command.ownerId
        }, true)

        rememberDirect(command.ownerId, room.room_id)

        return room.room_id
      }

      case 'readAssistantRoom':
        return readAssistantRoom(client, command, () => !stopped)

      case 'readConversationMarker':
        return readConversationMarker(client, command, () => !stopped)

      case 'preflightConversationRoom':
        return preflightConversationRoom(client, command, () => !stopped)

      case 'readConversationCandidates':
        return readConversationCandidates(client, command, () => !stopped)

      case 'writeConversationMarker':
        return writeConversationMarker(client, command, () => !stopped)

      case 'conversationAppVersions':
        return conversationAppVersions(client, command, () => !stopped)

      case 'createCompanyChannelRoom':
        return createCompanyChannelRoom(client, command, () => !stopped && state === 'ready')

      case 'findCompanyChannelRoom':
        return findCompanyChannelRoom(client, command, () => !stopped && state === 'ready')

      case 'reconcileCompanyChannelRoom':
        return reconcileCompanyChannelRoom(client, command, () => !stopped && state === 'ready')

      case 'readCompanyChannelRoom':
        return readCompanyChannelRoom(client, command, () => !stopped && state === 'ready')

      case 'createCompanyRoomTarget':
        return createCompanyRoomTarget(client, command, () => !stopped && state === 'ready')

      case 'createCompanyPrivateCosRoom':
        return createCompanyPrivateCosRoom(client, command.plan, () => !stopped && state === 'ready')

      case 'finishCompanyPrivateCosRoom':
        return finishCompanyPrivateCosRoom(client,command.plan,command.roomId,()=>!stopped&&state==='ready')

      case 'findCompanyPrivateCosRoom':
        return findCompanyPrivateCosRoom(client,command.plan,()=>!stopped&&state==='ready')

      case 'findCompanyRoomTarget':
        return findCompanyRoomTarget(client, command, () => !stopped && state === 'ready')

      case 'reconcileCompanyRoomTarget':
        return reconcileCompanyRoomTarget(client, command, () => !stopped && state === 'ready')

      case 'readCompanyRoomTarget':
        return readCompanyRoomTarget(client, command, () => !stopped && state === 'ready')

      case 'reportCompanyChannelDiscovery':
        return discoveryReport(client)

      case 'createCompanyProjectRoom':
        return createCompanyProjectRoom(client, command, () => !stopped && state === 'ready')

      case 'findCompanyProjectRoom':
        return findCompanyProjectRoom(client, command, () => !stopped && state === 'ready')

      case 'reconcileCompanyProjectRoom':
        return reconcileCompanyProjectRoom(client, command, () => !stopped && state === 'ready')

      case 'readCompanyProjectRoom':
        return readCompanyProjectRoom(client, command, () => !stopped && state === 'ready')

      case 'joinCompanyProjectRoom':
        return joinCompanyProjectRoom(client, command, () => !stopped && state === 'ready')

      case 'rotateCompanyProjectSession':
        return rotateCompanyProjectSession(client, command, () => !stopped && state === 'ready')

      case 'findAssistantRoom':
        return findAssistantRoom(client, command, () => !stopped)

      case 'readAppRoom':
        return readAppRoom(client, command, () => !stopped)

      case 'inviteHuman':
        if (state !== 'ready') {
          throw new Error('matrix_offline')
        }

        await requireHumanInvitation(client, command, () => !stopped && state === 'ready')

        return changeConversationMembership(client, { ...command, kind: 'invite' })

      case 'readInvocation':
        return readMatrixInvocation(client, command)

      case 'readReplyQuote':
        return readMatrixReplyQuote(client, command)

      case 'readContinuity':
        return readMatrixContinuity(client, command)

      case 'readResult':
        return readMatrixResult(client, command)

      case 'publishResult':
        return publishMatrixResult(client, command, configuration.deviceIsolation)

      case 'prepareResult':
        return prepareMatrixResult(client, command, configuration.deviceIsolation)

      case 'sendTurn':
        return sendMatrixTurn(client, command)

      case 'findTurn':
        return findMatrixTurn(client, command)

      case 'prepareCron':
        return prepareMatrixCron(client, command)

      case 'publishCron':
        return publishMatrixCron(client, command)

      case 'publishNotice':
        return publishMatrixNotice(client, command, () => !stopped, configuration.deviceIsolation)

      case 'publishGroupNotice':
        return publishMatrixGroupNotice(client, command, configuration.deviceIsolation)

      case 'agentSeen':
        return sendMatrixAgentSeen(client, command, () => !stopped)

      case 'agentTyping':
        return sendMatrixAgentTyping(client, command)
      case 'appCatalog': {
        appIds = command.appIds

        if (destination?.kind === 'app' && !appIds.includes(destination.appId)) {
          destination = { kind: 'discover' }
          selection.writeDestination(destination)
          selectionRevision++
        }

        snapshot()

        return null
      }

      case 'selectApp':
      case 'discoverApps': {
        if (command.kind === 'selectApp' && !appIds?.includes(command.appId)) {
          throw new Error('matrix_app_unavailable')
        }

        destination = command.kind === 'selectApp' ? { kind: 'app', appId: command.appId } : { kind: 'discover' }
        roomId = null
        selection.writeDestination(destination)
        selectionRevision++
        snapshot()

        return null
      }

      case 'appShortcut':
        if (!appIds?.includes(command.appId) || state !== 'ready') {
          throw new Error('matrix_app_unavailable')
        }

        await shortcuts.change(command.appId, command.visibility)

        return null
      case 'select': {
        const selected = client.getRoom(command.roomId)

        if (!selected || ignoredInvitation(client, selected)) {
          throw new Error('matrix_room_missing')
        }

        roomId = command.roomId
        destination = null
        selection.write(roomId)
        selectionRevision++
        conversationNotice = null
        snapshot()

        return null
      }

      case 'notesSelfOpen': {
        if (state !== 'ready') {
          throw new Error('matrix_notes_self_offline')
        }

        const notesRoomId = await notesSelf.ensure(command.companyId)
        const selected = client.getRoom(notesRoomId)

        if (!selected || !notesSelfCanUse(notesRoomId)) {
          throw new Error('matrix_notes_self_unavailable')
        }

        roomId = notesRoomId
        destination = null
        selection.write(roomId)
        selectionRevision++
        conversationNotice = null
        snapshot()

        return { roomId: notesRoomId }
      }

      case 'paginateTimeline': {
        if (state !== 'ready' || roomId !== command.roomId) {
          throw new Error('matrix_timeline_unavailable')
        }

        const selected = joinedRoom(command.roomId)
        const history = timelineWindow(selected)
        const timeline = history.timeline
        const timelineEvents = timeline.getEvents()
        const current = history.limit
        const visible = Math.min(timelineEvents.length, current)
        const cached = timelineEvents.length > current

        if (
          current >= MATRIX_TIMELINE_EVENT_BOUND ||
          (!cached && timeline.getPaginationToken(Direction.Backward) === null)
        ) {
          return {
            loaded: 0,
            visible,
            hasMore: false,
            capped: current >= MATRIX_TIMELINE_EVENT_BOUND
          }
        }

        const beforeEvents = new Set(timelineEvents)
        const before = timelineEvents.length

        if (!cached) {
          await client.scrollback(selected, MATRIX_TIMELINE_PAGE_EVENTS)
        }

        if (stopped || state !== 'ready' || roomId !== command.roomId) {
          throw new Error('matrix_timeline_unavailable')
        }

        // The SDK may replace the live timeline across a sync gap; never retain its old object.
        const nextHistory = timelineWindow(selected)
        const nextTimeline = nextHistory.timeline
        const nextEvents = nextTimeline.getEvents()
        const after = nextEvents.length
        const nextCurrent = nextTimeline === timeline ? current : nextHistory.limit
        const limit = nextTimelineEventLimit(nextCurrent)

        // Matrix scrollback can resolve before the page has finished decrypting. Decrypt both
        // newly learned events and the cached window this step newly admits; the snapshot sent
        // before the command result then contains every readable message in the page.
        const admittedStart = Math.max(0, after - limit)
        const previousStart = Math.max(0, after - nextCurrent)

        const learned =
          nextTimeline === timeline
            ? nextEvents.filter(event => !beforeEvents.has(event))
            : nextEvents.slice(admittedStart)

        const decrypt = new Set([...learned, ...nextEvents.slice(admittedStart, previousStart)])
        await Promise.allSettled(
          [...decrypt].filter(event => event.isEncrypted()).map(event => client.decryptEventIfNeeded(event))
        )

        if (stopped || state !== 'ready' || roomId !== command.roomId || selected.getLiveTimeline() !== nextTimeline) {
          throw new Error('matrix_timeline_unavailable')
        }

        const capped = limit >= MATRIX_TIMELINE_EVENT_BOUND
        nextHistory.limit = limit
        snapshot()

        return {
          loaded: Math.max(0, after - before),
          visible: Math.min(after, limit),
          hasMore:
            !capped &&
            (nextEvents.length > limit || nextTimeline.getPaginationToken(Direction.Backward) !== null),
          capped
        } satisfies MatrixTimelinePage
      }

      case 'companyMessageSearch':
        if (state !== 'ready') {
          throw new Error('matrix_company_search_unavailable')
        }

        return searchCompanyMessages(client, command, () => !stopped && state === 'ready')

      case 'peopleSearch':
        if (state !== 'ready') {
          throw new Error('matrix_people_search_unavailable')
        }

        return searchMatrixPeople(client, command)

      case 'peoplePrivacyRead':
        if (state !== 'ready') {
          throw new Error('matrix_people_privacy_unavailable')
        }

        return readPeoplePrivacy(client)

      case 'peoplePrivacyWrite':
        if (state !== 'ready') {
          throw new Error('matrix_people_privacy_unavailable')
        }

        return writePeoplePrivacy(client, command.enabled)

      case 'companyMessageOpen':
        if (state !== 'ready') {
          throw new Error('matrix_company_search_unavailable')
        }

        await openCompanyMessage(client, command, () => !stopped && state === 'ready')

        return null

      case 'companyCitationOpen':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return openCompanyCitation(client, command, () => !stopped && state === 'ready')

      case 'companyAIWatch':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return watchCompanyAI(client, command, () => !stopped && state === 'ready')

      case 'companyAIJoin':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return joinCompanyAIChannel(
          client,
          command,
          configuration.userId,
          () => !stopped && state === 'ready'
        )

      case 'companyAIReadEvent':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return readCompanyAIEvent(client, command, () => !stopped && state === 'ready')

      case 'companyAIJoinedMembers':
        if (state !== 'ready') {throw new Error('matrix_company_ai_unavailable')}
        return readCompanyAIJoinedMembers(client, command, () => !stopped && state === 'ready')

      case 'companyAIQuestion':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return readCompanyAIQuestion(
          client,
          command,
          configuration.userId,
          () => !stopped && state === 'ready'
        )

      case 'companyAIPublish':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return publishCompanyThread(client, command)

      case 'companyAIFindPublished':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return findCompanyThread(client, command)

      case 'companyAIThreadMessage':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return publishCompanyThreadMessage(client, command)

      case 'companyAIOnboardingWelcome':
        if (state !== 'ready') {
          throw new Error('matrix_company_ai_unavailable')
        }

        return publishCompanyOnboardingWelcome(client, command)

      case 'companyPrivateCosJoin':
        if (state !== 'ready') {throw new Error('matrix_company_ai_unavailable')}

        return joinCompanyPrivateCosRoom(client, command, () => !stopped && state === 'ready')

      case 'companyPrivateCosWatch':
        if (state !== 'ready') {throw new Error('matrix_company_ai_unavailable')}

        return watchCompanyPrivateCos(client, command, () => !stopped && state === 'ready')

      case 'companyPrivateCosQuestion':
        if (state !== 'ready') {throw new Error('matrix_company_ai_unavailable')}

        return readCompanyPrivateCosQuestion(client, command, () => !stopped && state === 'ready')

      case 'companyPrivateCosPublish':
        if (state !== 'ready') {throw new Error('matrix_company_ai_unavailable')}

        return publishCompanyPrivateCos(client, command)

      case 'companyPrivateCosGreeting':
        if (state !== 'ready') {throw new Error('matrix_company_ai_unavailable')}

        return publishCompanyPrivateCosGreeting(client, command)

      case 'companyPrivateCosLeave':
        if (state !== 'ready') {throw new Error('matrix_company_ai_unavailable')}

        return leaveCompanyPrivateCosRoom(client, command)

      case 'companyMessageSelect':
        if (state !== 'ready') {
          throw new Error('matrix_company_search_unavailable')
        }

        companyMessageRoom(client, command)
        roomId = command.roomId
        destination = null
        selection.write(roomId)
        selectionRevision++
        conversationNotice = null
        snapshot()

        return null
      case 'favourite': {
        const room = client.getRoom(command.roomId)

        if (state !== 'ready' || !room || room.getMyMembership() !== 'join') {
          throw new Error('matrix_favourite_unavailable')
        }

        // Tag-specific SDK calls preserve unrelated room/account metadata.
        // Wait for ordinary sync to update the projection, never fabricate tags.
        if (command.favourite) {
          await client.setRoomTag(command.roomId, 'm.favourite')

          // A chat is pinned or low priority, never both (as Element tags it).
          if (room.tags?.['m.lowpriority']) {
            await client.deleteRoomTag(command.roomId, 'm.lowpriority')
          }
        } else {
          await client.deleteRoomTag(command.roomId, 'm.favourite')
        }

        return null
      }

      case 'lowPriority': {
        const room = client.getRoom(command.roomId)

        if (state !== 'ready' || !room || room.getMyMembership() !== 'join') {
          throw new Error('matrix_low_priority_unavailable')
        }

        // The standard per-user tag, synced to the account's other devices like m.favourite.
        if (command.lowPriority) {
          await client.setRoomTag(command.roomId, 'm.lowpriority')

          if (room.tags?.['m.favourite']) {
            await client.deleteRoomTag(command.roomId, 'm.favourite')
          }
        } else {
          await client.deleteRoomTag(command.roomId, 'm.lowpriority')
        }

        return null
      }

      case 'setModel': {
        const room = client.getRoom(command.roomId)

        if (state !== 'ready' || !room || room.getMyMembership() !== 'join') {
          throw new Error('matrix_model_unavailable')
        }

        // Per-user room account data: private to the owner, synced to their devices. The
        // projection updates from ordinary sync, like the favourite tag.
        // Model and thinking level share the one record; a change to one keeps the other.
        await client.setRoomAccountData(
          command.roomId,
          MATRIX_MODEL_ACCOUNT_DATA,
          matrixModelChoiceContent(room.getAccountData(MATRIX_MODEL_ACCOUNT_DATA)?.getContent(), {
            ...(command.model ? { model: command.model } : {}),
            ...(command.effort ? { effort: command.effort } : {})
          })
        )

        return null
      }

      case 'create':

      case 'createGroup':

      case 'createAssistant':
      case 'createAppGroup': {
        if (command.kind === 'createGroup' && new Set(command.agents).size > MATRIX_GROUP_AGENT_LIMIT) {
          throw new Error('matrix_group_agents_full')
        }

        let existingAssistant: string | null = null

        if (
          AGENT_ONE_CONVERSATION &&
          command.kind === 'createAssistant' &&
          (!command.replaceMain || command.adoptAgentInvite)
        ) {
          const discoveryRevision = selectionRevision
          existingAssistant = await findAssistantRoom(
            client,
            { ownerId: configuration.userId, agentId: command.invite[0] },
            () => !stopped
          )

          if (existingAssistant && !command.replaceMain) {
            if (!stopped && selectionRevision === discoveryRevision) {
              roomId = existingAssistant
              destination = null
              selection.write(roomId)
              selectionRevision++
              snapshot()
            }

            return existingAssistant
          }

          // Cloud bootstrap deliberately creates the reverse direction. Give its signed invite
          // a bounded head start; other assistant opens still adopt one already in sync at once.
          if (!existingAssistant && (!command.replaceMain || command.adoptAgentInvite)) {
            const adopted = await adoptAssistantRoomInvitation(
              client,
              {
                ownerId: configuration.userId,
                agentId: command.invite[0],
                createdBy: 'agent',
                ...(command.adoptAgentInvite ? { waitMs: MATRIX_ASSISTANT_INVITE_WAIT_MS } : {})
              },
              () => !stopped
            )

            if (adopted) {
              if (!stopped && selectionRevision === discoveryRevision) {
                roomId = adopted
                destination = null
                selection.write(roomId)
                selectionRevision++
                snapshot()
              }

              rememberDirect(command.invite[0], adopted)

              return adopted
            }
          }
        }

        const revision = selectionRevision
        conversationNotice = null

        const input =
          command.kind === 'createAppGroup'
            ? { name: command.name, invite: [command.app] }
            : command.kind === 'createGroup'
              ? // The owner's own assistants are invited with the people; main then has each join.
                // With no people it is a private meeting, made like any group (history shared).
                { name: command.name, invite: [...command.invite, ...command.agents], direct: false }
              : command

        const room = await createConversation(
          client,
          input,
          command.kind === 'createAssistant',
          command.kind === 'createAppGroup' ? command.app : undefined
        )

        if (
          AGENT_ONE_CONVERSATION &&
          command.kind === 'createAssistant' &&
          command.adoptAgentInvite &&
          !existingAssistant
        ) {
          // Close the edge where the controller commits during the fallback create. The
          // just-created loser is left only when the server proves its history is state-only.
          let adopted: string | null = null

          try {
            adopted = await adoptAssistantRoomInvitation(
              client,
              {
                ownerId: configuration.userId,
                agentId: command.invite[0],
                createdBy: 'agent',
                waitMs: MATRIX_ASSISTANT_POST_CREATE_SETTLE_MS
              },
              () => !stopped
            )
          } catch (error) {
            // Once join succeeded, uncertainty is authoritative: never create/select a fallback.
            // Every failure before join leaves this already-created owner room usable.
            if (error instanceof AssistantRoomAdoptionUncertainError) {
              throw error
            }
          }

          if (adopted && adopted !== room.room_id) {
            await leaveEmptyCreatedRoom(room.room_id)

            if (!stopped && selectionRevision === revision) {
              roomId = adopted
              destination = null
              selection.write(roomId)
              selectionRevision++
              snapshot()
            }

            rememberDirect(command.invite[0], adopted)

            return adopted
          }
        }

        if (stopped) {
          return room.room_id
        }

        if (selectionRevision === revision) {
          roomId = room.room_id
          destination = null
          selection.write(roomId)
          selectionRevision++
        }

        snapshot()

        if ('direct' in input && input.direct) {
          rememberDirect(input.invite[0], room.room_id)
        }

        if (
          AGENT_ONE_CONVERSATION &&
          command.kind === 'createAssistant' &&
          command.adoptAgentInvite &&
          !existingAssistant
        ) {
          lateAssistantReconciliations.set(command.invite[0], {
            ownerRoomId: room.room_id,
            selectionRevision,
            expiresAt: Date.now() + MATRIX_ASSISTANT_LATE_INVITE_WINDOW_MS
          })
        }

        return room.room_id
      }

      case 'openAppBotDm': {
        if (!APP_UUID.test(command.appId) || !/^@[^:\s]+:[^\s]+$/u.test(command.botUserId)) {
          throw new Error('matrix_app_bot_dm_invalid')
        }

        return openAppBotDm(command.appId, command.botUserId)
      }

      case 'findAppBotDm':

      case 'makeAppBotDm':

      case 'openAppBotRoom':
      case 'leaveAppBotDm': {
        if (
          !APP_UUID.test(command.appId) ||
          !/^@[^:\s]+:[^\s]+$/u.test(command.botUserId) ||
          (command.kind === 'openAppBotRoom' &&
            command.selection !== undefined &&
            !(Number.isSafeInteger(command.selection) && command.selection >= 0)) ||
          ((command.kind === 'openAppBotRoom' || command.kind === 'leaveAppBotDm') &&
            !isCanonicalMatrixRoomId(command.roomId))
        ) {
          throw new Error('matrix_app_bot_dm_invalid')
        }

        switch (command.kind) {
          case 'findAppBotDm':
            return findAppBotDm(command.appId, command.botUserId)

          case 'makeAppBotDm':
            return makeAppBotDm(command.appId, command.botUserId)

          case 'openAppBotRoom':
            return openAppBotRoom(command.appId, command.botUserId, command.roomId, command.selection)

          default:
            return leaveAppBotDm(command.appId, command.botUserId, command.roomId)
        }
      }

      case 'isOfficialAppBotDm':
        return officialAppBotDirectRoom(command.appId, command.userId, command.roomId) !== null
      case 'appBotDisplayEvidence': {
        let evidenceRoom: Room

        try {
          evidenceRoom = joinedRoom(command.roomId)
        } catch {
          return null
        }

        // The app and its bot come from the catalog entry main opened this chat for. An official
        // bot's Matrix identity is derived from its slug, so the pair must agree with itself
        // (shared/app-catalog.ts): nothing else vouches for a name this client was not built with.
        if (
          !APP_UUID.test(command.appId) ||
          typeof command.app !== 'string' ||
          !APP_SLUG.test(command.app) ||
          command.userId !== appBotUserOf(command.app) ||
          !Array.isArray(command.devices)
        ) {
          return null
        }

        const bot: AppBotIdentity = { appId: command.appId, slug: command.app, guest: command.guest === true }

        // A bot's chat without end-to-end encryption (0.20): its notice arrives plain, and the
        // homeserver's sender is the bot's identity (owner decision D1). No device, shield or
        // Megolm check applies; the sender, the room and the exact metadata still must match.
        // A plaintext notice in an encrypted room never counts (no downgrade).
        if (await confirmedPlainRoom(client, evidenceRoom)) {
          const raw = await client.fetchRoomEvent(command.roomId, command.eventId).catch(() => null)

          if (!raw || raw.type !== EventType.RoomMessage) {
            return null
          }

          const event = new MatrixEvent(raw)
          const metadata = appBotMessageEvidence(event.getContent(), bot)

          return metadata &&
            event.getRoomId() === command.roomId &&
            event.getSender() === command.userId &&
            !event.isRedacted() &&
            !evidenceRoom.hasEncryptionStateEvent()
            ? metadata
            : null
        }

        if (
          command.devices.length < 1 ||
          command.devices.length > 64 ||
          command.devices.some(
            device =>
              !device ||
              typeof device.deviceId !== 'string' ||
              !device.deviceId ||
              typeof device.ed25519 !== 'string' ||
              typeof device.curve25519 !== 'string' ||
              (device.retiredAt !== null && (!Number.isSafeInteger(device.retiredAt) || device.retiredAt < 0))
          )
        ) {
          return null
        }

        const raw = await client.fetchRoomEvent(command.roomId, command.eventId).catch(() => null)

        if (!raw) {
          return null
        }

        const event = new MatrixEvent(raw)

        try {
          await client.decryptEventIfNeeded(event)
        } catch {
          return null
        }

        const wire = event.getWireContent()
        const timestamp = event.getTs()
        const encryption = await crypto.getEncryptionInfoForEvent(event).catch(() => null)

        const matched = command.devices.find(
          device =>
            device.curve25519 === event.getSenderKey() &&
            device.ed25519 === event.getClaimedEd25519Key() &&
            wire.device_id === device.deviceId &&
            (device.retiredAt === null || timestamp < device.retiredAt)
        )

        const metadata = appBotMessageEvidence(event.getContent(), bot)
        const safeShield = appBotPinnedShield(encryption?.shieldReason)

        if (
          !metadata ||
          !matched ||
          event.getRoomId() !== command.roomId ||
          event.getSender() !== command.userId ||
          event.getWireType() !== EventType.RoomMessageEncrypted ||
          wire.algorithm !== 'm.megolm.v1.aes-sha2' ||
          event.isDecryptionFailure() ||
          !safeShield
        ) {
          return null
        }

        return metadata
      }

      case 'retireLegacyAppBotRoom': {
        const botUserId = officialAppBotDirectRoom(command.appId, command.userId, command.roomId)

        if (!botUserId || !Number.isSafeInteger(command.movedAt) || command.movedAt < 0) {
          throw new Error('matrix_app_bot_dm_invalid')
        }

        await markAppBotRoomMoved(command.roomId, command.appId, botUserId, command.movedAt)

        return null
      }

      case 'join': {
        const revision = selectionRevision
        const room = client.getRoom(command.roomId)

        // An invitation to a chat with or without end-to-end encryption: since 0.20 people
        // Preserve user-visible identity, state and recovery behavior across connection changes.
        if (!room || room.getMyMembership() !== 'invite' || ignoredInvitation(client, room)) {
          throw new Error('matrix_encrypted_invite_required')
        }

        // A company DM is the company's room, not the person's own direct chat: it is never written to their
        // `m.direct` map, whatever the invitation said about being direct.
        const inviter = room.getType() === MATRIX_COMPANY_CONVERSATION_TYPE ? null : room.getDMInviter()
        await client.joinRoom(command.roomId)

        if (!stopped && inviter) {
          rememberDirect(inviter, command.roomId)
        }

        if (!stopped && command.select !== false && selectionRevision === revision) {
          roomId = command.roomId
          destination = null
          selection.write(roomId)
          selectionRevision++
        }

        snapshot()

        return null
      }

      case 'invite':

      case 'removeMember':

      case 'ban':

      case 'unban':
        if (state !== 'ready') {
          throw new Error('matrix_offline')
        }

        await changeConversationMembership(client, command)
        snapshot()

        return null

      case 'ignore':
        if (state !== 'ready' || changingIgnore) {
          throw new Error('matrix_ignore_unavailable')
        }

        changingIgnore = true

        try {
          await changeIgnoredUser(client, command.userId, command.ignored, () => !stopped && state === 'ready')
        } finally {
          changingIgnore = false
        }

        snapshot()

        return null
      case 'leave': {
        const revision = selectionRevision
        const room = client.getRoom(command.roomId)

        if (!room || !['join', 'invite'].includes(room.getMyMembership())) {
          throw new Error('matrix_membership_required')
        }

        await client.leave(command.roomId)

        if (!stopped && selectionRevision === revision && roomId === command.roomId) {
          roomId = null
          destination = null
          selection.write(null)
          selectionRevision++
        }

        snapshot()

        return null
      }

      case 'resend':
      case 'discard': {
        const room = joinedRoom(command.roomId)

        // Only this account's own message that the server never took: its local echo.
        const event = room
          .getLiveTimeline()
          .getEvents()
          .find(value => value.getId() === command.eventId)

        if (
          state !== 'ready' ||
          !event ||
          event.status !== EventStatus.NOT_SENT ||
          event.getSender() !== client.getSafeUserId() ||
          event.getRoomId() !== command.roomId
        ) {
          throw new Error('matrix_unsent_message_changed')
        }

        if (command.kind === 'resend') {
          await client.resendEvent(event, room)
        } else {
          client.cancelPendingEvent(event)
        }

        snapshot()

        return null
      }

      case 'mute': {
        const room = client.getRoom(command.roomId)

        if (state !== 'ready' || !room || room.getMyMembership() !== 'join') {
          throw new Error('matrix_mute_unavailable')
        }

        // The SDK's own muting rule; the projection follows the synced push rules.
        await client.setRoomMutePushRule('global', command.roomId, command.muted)
        snapshot()

        return null
      }

      case 'chatTitle': {
        const room = client.getRoom(command.roomId)

        if (state !== 'ready' || !room || room.getMyMembership() !== 'join') {
          throw new Error('matrix_title_unavailable')
        }

        // Private to the owner, like the model choice; ordinary sync updates the projection.
        await client.setRoomAccountData(
          command.roomId,
          MATRIX_TITLE_ACCOUNT_DATA,
          command.title ? { title: command.title } : {}
        )

        return null
      }

      case 'groupName':
      case 'groupTopic': {
        const room = client.getRoom(command.roomId)
        const type = command.kind === 'groupName' ? EventType.RoomName : EventType.RoomTopic

        if (state !== 'ready' || !room || !personalGroupStateAllowed(client, room, type)) {
          throw new Error('matrix_group_details_unavailable')
        }

        if (command.kind === 'groupName') {
          // The standard room name, for everyone in the group.
          await client.setRoomName(command.roomId, command.name)

          // Your own private name for the group would hide the new one from you: it goes.
          if (room.getAccountData(MATRIX_TITLE_ACCOUNT_DATA)?.getContent()?.title) {
            await client.setRoomAccountData(command.roomId, MATRIX_TITLE_ACCOUNT_DATA, {})
          }
        } else {
          await client.setRoomTopic(command.roomId, command.topic)
        }

        // Ordinary sync brings the new state into the projection everywhere the group shows.
        return null
      }

      case 'chatLook': {
        const room = client.getRoom(command.roomId)

        if (state !== 'ready' || !room || room.getMyMembership() !== 'join') {
          throw new Error('matrix_look_unavailable')
        }

        await client.setRoomAccountData(command.roomId, LOOK_ROOM_ACCOUNT_DATA_TYPE, command.look)

        return null
      }

      case 'attend': {
        // What the person has on screen in a focused window; see read-receipts.ts.
        receipts.attend(command.roomId)
        // A chat on screen is being read: its unread mark goes (the receipts acknowledge its
        // messages; nothing is acknowledged here).
        const attended = command.roomId ? client.getRoom(command.roomId) : null

        if (attended && state === 'ready' && attended.getMyMembership() === 'join' && matrixMarkedUnread(attended)) {
          void markMatrixRoomUnread(client, attended, false, { acknowledge: false }).catch(() => {})
        }

        return null
      }

      case 'markUnread': {
        const room = client.getRoom(command.roomId)

        if (state !== 'ready' || !room || room.getMyMembership() !== 'join') {
          throw new Error('matrix_unread_unavailable')
        }

        // Room account data, synced to the person's devices; the projection follows sync.
        await markMatrixRoomUnread(client, room, command.unread)

        return null
      }

      case 'threadFollow': {
        const room = client.getRoom(command.roomId)

        if (
          state !== 'ready' ||
          !room ||
          room.getMyMembership() !== 'join' ||
          ![MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '')
        ) {
          throw new Error('matrix_thread_unavailable')
        }

        await setMatrixThreadFollow(client, room, command.rootId, command.followed)

        return null
      }

      case 'companyFileContext':
        return companyFileContext(joinedRoom(command.roomId), command.threadRootId, command.replyTo)

      case 'companyFileSend':
        return sendCompanyFile(client, joinedRoom(command.roomId), command)

      case 'companyFileReference':
        return companyFileReference(client, joinedRoom(command.roomId), command.eventId)
      case 'threadRead': {
        const room = client.getRoom(command.roomId)

        if (
          state !== 'ready' ||
          !room ||
          room.getMyMembership() !== 'join' ||
          ![MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(room.getType() ?? '')
        ) {
          throw new Error('matrix_thread_unavailable')
        }

        await readMatrixThread(client, room, command.rootId)
        snapshot()

        return null
      }

      case 'typing': {
        const room = client.getRoom(command.roomId)

        // A presentation signal: nothing to send while offline, for a chat that is gone, or
        // when the person keeps their reading and typing private.
        if (
          state !== 'ready' ||
          !room ||
          displayPreferences.snapshot(true).shareActivity?.value === false
        ) {
          return null
        }

        await sendMatrixTyping(client, room, command.typing)

        return null
      }

      case 'edit':
        return editMatrixMessage(client, joinedRoom(command.roomId), command.eventId, command.body)

      case 'redact':
        await redactMatrixMessage(client, joinedRoom(command.roomId), command.eventId)
        snapshot()

        return null

      case 'pinMessage':
        await changeMatrixMessagePin(client, joinedRoom(command.roomId), command.eventId, command.pinned)
        snapshot()

        return null

      case 'react':
        await reactToMatrixMessage(
          client,
          joinedRoom(command.roomId),
          command.eventId,
          command.key,
          command.reacted
        )
        snapshot()

        return null

      case 'savedMessage':
        if (state !== 'ready') {
          throw new Error('matrix_saved_messages_unavailable')
        }

        await savedMessages.change(command)

        return null

      case 'savedMessagesRead':
        if (state !== 'ready') {
          throw new Error('matrix_saved_messages_unavailable')
        }

        return savedMessages.read()
      case 'savedMessageOpen': {
        if (state !== 'ready') {
          throw new Error('matrix_saved_messages_unavailable')
        }

        const opened = await savedMessages.open(command)
        roomId = command.roomId
        destination = null
        selection.write(roomId)
        selectionRevision++
        conversationNotice = null
        snapshot()

        return opened
      }

      case 'draft':
        if (
          state !== 'ready' ||
          command.identity.userId !== configuration.userId ||
          command.identity.deviceId !== configuration.deviceId
        ) {
          throw new Error('matrix_drafts_unavailable')
        }

        await drafts.change(
          { roomId: command.roomId, ...(command.threadRootId ? { threadRootId: command.threadRootId } : {}) },
          command.text
        )

        return null

      case 'forget':
        // An official bot's chat answers that it was kept, out of sight (main logs it).
        return forgetRoom(command.roomId)

      case 'forgetAgentRoom':
        // Same Delete chat, for a retired agent's chat: only after the server's full room
        // state shows no one but the owner and that agent was ever in it. A room that is not
        // one is answered, not thrown: the host reports every failure alike to main.
        if (state !== 'ready' || !client.getRoom(command.roomId)) {
          throw new Error('matrix_membership_required')
        }

        try {
          await readRetiredAgentRoom(client, command, () => !stopped && state === 'ready')
        } catch (error) {
          if (error instanceof Error && error.message === 'matrix_retired_agent_room_required') {
            return 'kept'
          }

          throw error
        }

        await forgetRoom(command.roomId)

        return 'forgotten'
      case 'sendTaskFiles': {
        const promise = parseMatrixTaskFilesPromise(command.taskFiles)

        if (!promise || !command.body.trim()) {
          throw new Error('matrix_task_files_invalid')
        }

        await readAssistantRoom(
          client,
          { roomId: command.roomId, ownerId: configuration.userId, agentId: command.userId, forTurn: true },
          () => !stopped && state === 'ready'
        )
        joinedRoom(command.roomId)

        const content = {
          msgtype: MsgType.Text as const,
          body: command.body,
          [MATRIX_TASK_FILES_KEY]: promise
        }

        return (await client.sendEvent(command.roomId, EventType.RoomMessage, content)).event_id
      }

      case 'reportEvent': {
        const room = joinedRoom(command.roomId)

        // Keep the report bound to the event the person saw. Do not fetch or decrypt
        // another copy: the homeserver needs only these identifiers and a category.
        const event = room
          .getLiveTimeline()
          .getEvents()
          .find(value => value.getId() === command.eventId)

        if (
          state !== 'ready' ||
          !event ||
          event.getId() !== command.eventId ||
          !(await reportableMatrixEvent(client, room, event, command.userId))
        ) {
          throw new Error('matrix_report_target_changed')
        }

        await reportMatrixEvent(client, command.roomId, command.eventId, command.reason)

        if (stopped) {
          throw new Error('matrix_sdk_stopped')
        }

        return null
      }

      case 'reportUser': {
        const room = joinedRoom(command.roomId)

        // Someone in this chat, never yourself: the menus offer it beside Block.
        if (state !== 'ready' || command.userId === client.getSafeUserId() || !room.getMember(command.userId)) {
          throw new Error('matrix_report_target_changed')
        }

        try {
          // Matrix user report (MSC4260, Synapse 1.146+). Only the id and the person's reason.
          await client.http.authedRequest(
            Method.Post,
            `/users/${encodeURIComponent(command.userId)}/report`,
            undefined,
            { reason: command.reason ?? MATRIX_REPORT_DEFAULT_REASON },
            { prefix: '/_matrix/client/v3' }
          )
        } catch (error) {
          if (!matrixEndpointUnsupported(error)) {
            throw error
          }

          // A homeserver without user reports: report the latest message they sent here.
          const events = room.getLiveTimeline().getEvents()
          let latest: MatrixEvent | undefined

          for (let index = events.length - 1; index >= 0 && !latest; index--) {
            if (await reportableMatrixEvent(client, room, events[index], command.userId)) {
              latest = events[index]
            }
          }

          if (!latest?.getId()) {
            throw new Error('matrix_report_unavailable')
          }

          await reportMatrixEvent(client, command.roomId, latest.getId()!, command.reason)
        }

        if (stopped) {
          throw new Error('matrix_sdk_stopped')
        }

        return null
      }

      case 'sendAppMessage':
        joinedRoom(command.roomId)

        return (
          await client.sendEvent(command.roomId, EventType.RoomMessage, {
            msgtype: MsgType.Text,
            body: command.body,
            'm.mentions': { user_ids: [command.userId] }
          })
        ).event_id
      case 'sendAppBotMessage': {
        const room = joinedRoom(command.roomId)

        if (room.getMember(command.userId)?.membership !== 'join') {
          throw new Error('matrix_app_bot_membership_required')
        }

        if (
          !command.body.trim() ||
          command.body.length > 4_000 ||
          (command.quote && command.quote !== command.replyTo)
        ) {
          throw new Error('matrix_app_bot_message_invalid')
        }

        return (
          await client.sendEvent(command.roomId, EventType.RoomMessage, {
            msgtype: MsgType.Text,
            body: command.body,
            'm.mentions': { user_ids: [command.userId] },
            ...(command.replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: command.replyTo } } } : {}),
            ...(command.quote ? { 'io.atum.app_bot.quote': { v: 1, event_id: command.quote } } : {})
          })
        ).event_id
      }

      case 'appBotWatch':
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        appBotWatching = command.watch

        return null

      case 'appBotRooms':
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        // IDs and membership only, encrypted or not (0.20 bot chats are plain); the host
        // classifies/re-reads every room separately.
        return client
          .getRooms()
          .filter(room => ['join', 'invite'].includes(room.getMyMembership()))
          .map(room => ({ roomId: room.roomId, membership: room.getMyMembership() }))
      case 'appBotReadEvent': {
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        // Read the one server event directly. A just-restored SDK may not have populated
        // its room cache yet; the encrypted wire type and authenticated sender checks below
        // are the authority, while the homeserver still enforces membership on this request.
        const raw = await client.fetchRoomEvent(command.roomId, command.eventId)
        const event = new MatrixEvent(raw)
        const encrypted = event.getWireType() === EventType.RoomMessageEncrypted
        // A plaintext event is readable only in a room without end-to-end encryption (0.20 bot
        // chats), told by the room's current state; in an encrypted room it stays unreadable
        // (no downgrade): its content and device are withheld.
        const plain = encrypted ? false : await appBotPlainRoom(command.roomId)

        if (plain === undefined) {
          // The crypto store has not answered in time: not readable, not refused either. The read
          // fails, so the hint or scan that asked is tried again (the host keeps its cursor).
          throw new Error('matrix_operation_failed')
        }

        let decrypted = false
        let output: Record<string, unknown>

        try {
          try {
            await client.decryptEventIfNeeded(event)
            decrypted = encrypted && !event.isDecryptionFailure()
          } catch {
            // A missing or unusable Megolm session is a normal host outcome. Return only
            // closed metadata so the pipeline can issue the bounded DM cannot-read notice.
          }

          const sender = event.getSender()
          let devices = new Map()

          if (decrypted && sender) {
            // Prefer a fresh server list for the event-to-device check. A crash can race its
            // first sync with that refresh; then the sealed, restored device record is still
            // the only safe fallback (it is checked against both event keys and wire device).
            devices = await crypto
              .getUserDeviceInfo([sender], true)
              .catch(() => crypto.getUserDeviceInfo([sender], false))
              .catch(() => new Map())
          }

          const device = sender
            ? [...(devices.get(sender)?.values() ?? [])].find(
                candidate =>
                  candidate.getIdentityKey() === event.getSenderKey() &&
                  candidate.getFingerprint() === event.getClaimedEd25519Key()
              )
            : undefined

          const wireDeviceId = event.getWireContent().device_id

          const wireDeviceBound = Boolean(
            device && typeof wireDeviceId === 'string' && wireDeviceId === device.deviceId
          )

          const trust =
            wireDeviceBound && sender
              ? await crypto.getDeviceVerificationStatus(sender, device!.deviceId).catch(() => null)
              : null

          const encryption = decrypted ? await crypto.getEncryptionInfoForEvent(event).catch(() => null) : null
          output = {
            roomId: command.roomId,
            eventId: command.eventId,
            sender: sender ?? null,
            senderDevice: plain ? MATRIX_PLAIN_SENDER_DEVICE : (device?.deviceId ?? null),
            senderKey: event.getSenderKey() ?? null,
            claimedEd25519: event.getClaimedEd25519Key() ?? null,
            encrypted,
            decrypted,
            decryptionFailure: event.decryptionFailureReason,
            wireDeviceBound,
            wireDeviceId: typeof wireDeviceId === 'string' ? wireDeviceId : null,
            pinnedBotDecryption:
              decrypted &&
              event.getWireContent().algorithm === 'm.megolm.v1.aes-sha2' &&
              appBotPinnedShield(encryption?.shieldReason),
            // Only the two non-unsafe shield results satisfy the bot-host contract.
            // A shield reason is not itself a trust grant.
            verifiedDecryption:
              decrypted &&
              wireDeviceBound &&
              (encryption?.shieldReason === null || encryption?.shieldReason === EventShieldReason.UNVERIFIED_IDENTITY),
            // Existing host callers already require keyBinding; include the wire-device
            // check here so a different signed device can never pass that older gate.
            keyBinding: Boolean(device) && wireDeviceBound,
            ownerSigned: Boolean(trust?.signedByOwner),
            shieldReason: encryption?.shieldReason ?? null,
            type: event.getType(),
            content: decrypted || plain ? event.getContent() : {},
            wireRelation: event.getWireContent()['m.relates_to'] ?? null,
            redacted: event.isRedacted(),
            originServerTs: event.getTs()
          }
        } finally {
          // MatrixEvent keeps decrypted clearEvent privately. The bot has consumed this
          // one-shot read; erase it before releasing the object. The encrypted wire event
          // remains in the sealed sync store as required for an E2EE member device.
          const mutable = event as unknown as { clearEvent?: unknown; event: Record<string, unknown> }
          mutable.clearEvent = undefined
        }

        return output
      }

      case 'appBotReadMedia': {
        // Shared by the headless H1 bot host and D1's human-host photo bridge.
        // Both read one joined-room event through the authenticated SDK media
        // path. H1 receives the Matrix media ref for atomic ingress registration;
        // D1's main-process bridge strips it before anything reaches the renderer.
        const room = joinedRoom(command.roomId)
        const raw = await client.fetchRoomEvent(command.roomId, command.eventId)
        const event = new MatrixEvent(raw)
        const encrypted = event.getWireType() === EventType.RoomMessageEncrypted
        const plain = encrypted ? false : await plainRoomAnswer(client, room)

        if (plain === undefined) {
          throw new Error('matrix_operation_failed')
        }

        try {
          await client.decryptEventIfNeeded(event)

          if (encrypted && event.isDecryptionFailure()) {
            throw new Error('matrix_file_unavailable')
          }

          const content = event.getContent()

          if (content.msgtype !== MsgType.Image || !content.info || typeof content.info !== 'object') {
            throw new Error('matrix_file_unavailable')
          }

          const encryptedFile = content.file && typeof content.file === 'object'
            ? content.file as Record<string, unknown>
            : undefined

          const mxc = typeof encryptedFile?.url === 'string'
            ? encryptedFile.url
            : plain && typeof content.url === 'string'
              ? content.url
              : undefined

          if (!mxc) {
            throw new Error('matrix_file_unavailable')
          }

          const media = await downloadMatrixAttachment(client, content, { plain })
          const info = content.info as Record<string, unknown>

          if (
            !['image/jpeg', 'image/png', 'image/webp'].includes(String(info.mimetype)) ||
            !Number.isSafeInteger(info.w) ||
            !Number.isSafeInteger(info.h)
          ) {
            throw new Error('matrix_file_invalid')
          }

          const caption = typeof content.body === 'string' &&
            typeof content.filename === 'string' && content.body !== content.filename
            ? content.body
            : undefined

          return {
            bytes: media.bytes,
            mxc,
            mimeType: info.mimetype,
            width: info.w,
            height: info.h,
            ...(caption ? { caption } : {})
          }
        } finally {
          const mutable = event as unknown as { clearEvent?: unknown }; mutable.clearEvent = undefined
        }
      }

      case 'appBotScan': {
        if (
          !appBotMode ||
          !Number.isFinite(command.since) ||
          !Number.isInteger(command.pageCap) ||
          command.pageCap < 1 ||
          command.pageCap > 10
        ) {
          throw new Error('matrix_app_bot_scan_invalid')
        }

        // A message counts as it arrives in its room: encrypted with end-to-end encryption,
        // plain without it (0.20 bot chats); never plaintext in an encrypted room. Without the
        // crypto store's answer in time, which messages count is unknown: the scan is incomplete,
        // so the host keeps its cursor and scans the room again.
        const scanPlain = await plainRoomAnswer(client, joinedRoom(command.roomId))

        if (scanPlain === undefined) {
          return { hints: [], complete: false }
        }

        const scanWireType = scanPlain ? EventType.RoomMessage : EventType.RoomMessageEncrypted
        const hints: Array<{ roomId: string; eventId: string; timestamp: number }> = []
        const seen = new Set<string>()
        const tokens = new Set<string>()
        let from: string | null = null
        let complete = false

        for (let page = 0; page < command.pageCap && !complete; page++) {
          const batch = await client.createMessagesRequest(command.roomId, from, 100, Direction.Backward)

          if (!Array.isArray(batch.chunk) || batch.chunk.length > 100) {
            throw new Error('matrix_app_bot_scan_invalid')
          }

          let oldest = Number.POSITIVE_INFINITY

          for (const raw of batch.chunk) {
            const event = new MatrixEvent(raw)
            const eventId = event.getId()
            const timestamp = event.getTs()

            if (Number.isFinite(timestamp)) {
              oldest = Math.min(oldest, timestamp)
            }

            if (
              raw.type === scanWireType &&
              event.getRoomId() === command.roomId &&
              eventId?.startsWith('$') &&
              Number.isFinite(timestamp) &&
              timestamp >= command.since &&
              !seen.has(eventId)
            ) {
              seen.add(eventId)
              hints.push({ roomId: command.roomId, eventId, timestamp })
            }
          }

          if (!batch.end || (Number.isFinite(oldest) && oldest < command.since)) {
            complete = true
          }
          else if (tokens.has(batch.end)) {break}
          else {
            tokens.add(batch.end)
            from = batch.end
          }
        }

        hints.sort((left, right) => left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId))

        return { hints, complete }
      }

      case 'appBotMembers': {
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        // The cached room can lag an invite/join while an answer is in flight. Fetch the
        // current membership list before each safety classification.
        return appBotCurrentMembers(client, command.roomId)
      }

      case 'appBotInviteState': {
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        const room = client.getRoom(command.roomId)
        const members = room?.currentState.getStateEvents(EventType.RoomMember)
        // Encrypted unless the crypto store agrees the room is plain (`plainRoomAnswer`): the
        // controller's pipeline decides by this whether a plaintext message may count. Undefined
        // while the store has not answered in time: the pipeline retries rather than refuse.
        const plain = room ? await plainRoomAnswer(client, room) : false

        return appBotInviteSnapshot(
          room?.getMyMembership(),
          plain === undefined ? undefined : !plain,
          configuration.userId,
          Array.isArray(members) ? members : []
        )
      }

      case 'appBotJoin':
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        await client.joinRoom(command.roomId)

        return null

      case 'appBotReject':
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        await client.http.authedRequest(
          Method.Post,
          `/rooms/${encodeURIComponent(command.roomId)}/leave`,
          undefined,
          { reason: command.reason },
          { prefix: '/_matrix/client/v3' }
        )

        return null

      case 'appBotLeave':
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        await client.leave(command.roomId)

        return null

      case 'appBotTyping':
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        await client.sendTyping(command.roomId, command.typing, 30_000)

        return null
      case 'appBotProfile': {
        if (
          !appBotMode ||
          !command.displayName.trim() ||
          command.displayName.length > 120 ||
          (command.avatar && (!command.mimeType || command.avatar.byteLength > 131_072))
        ) {
          throw new Error('matrix_app_bot_profile_invalid')
        }

        await client.setDisplayName(command.displayName)

        if (command.avatar) {
          const bytes = command.avatar.buffer.slice(
            command.avatar.byteOffset,
            command.avatar.byteOffset + command.avatar.byteLength
          ) as ArrayBuffer

          const upload = await client.uploadContent(new Blob([bytes], { type: command.mimeType }))
          await client.setAvatarUrl(upload.content_uri)
        }

        return null
      }

      case 'appBotRoomState':
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        if (command.content === undefined) {
          return client.getRoom(command.roomId)?.getAccountData(command.type)?.getContent() ?? {}
        }

        await client.setRoomAccountData(command.roomId, command.type as never, command.content as never)
        // The server has committed this metadata, while its sync echo can still be delayed.
        // Reflect the acknowledged value locally so recovery does not repeatedly write the
        // same classification or notice timestamp and exhaust the account-data rate limit.
        client
          .getRoom(command.roomId)
          ?.addAccountData([new MatrixEvent({ type: command.type, content: command.content })])

        return null
      case 'appBotDeviceKeys': {
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        // `startClient` starts the background sync but resolves before the restored room
        // state is ready. A fresh host may ask for its keys immediately, so wait for the
        // first usable sync rather than falsely reporting a recovered device as unavailable.
        if (state !== 'ready') {
          await appBotReady
        }

        // Restore the same immutable identity. MAS expiry can remove the homeserver's
        // device record while Rust retains its already-sent upload; query HTTP directly
        // because getUserDeviceInfo returns the tracked cache. Never overwrite another key.
        const own = await crypto.getOwnDeviceKeys()

        if (!own.ed25519 || !own.curve25519) {
          throw new Error('matrix_bot_device_keys_unavailable')
        }

        const serverDevice = async () => {
          const response = (await client.http.authedRequest(
            Method.Post,
            '/keys/query',
            undefined,
            { device_keys: { [configuration.userId]: [configuration.deviceId] } },
            { prefix: '/_matrix/client/v3' }
          )) as { device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>> }

          return response.device_keys?.[configuration.userId]?.[configuration.deviceId]
        }

        const sameKeys = (device: Awaited<ReturnType<typeof serverDevice>>) =>
          device?.keys?.[`ed25519:${configuration.deviceId}`] === own.ed25519 &&
          device?.keys?.[`curve25519:${configuration.deviceId}`] === own.curve25519

        const served = await serverDevice()

        if (served && !sameKeys(served)) {
          throw new Error('matrix_bot_device_keys_mismatch')
        }

        if (!served) {
          const deviceKeys = {
            user_id: configuration.userId,
            device_id: configuration.deviceId,
            algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
            signatures: {} as Record<string, Record<string, string>>,
            keys: {
              [`ed25519:${configuration.deviceId}`]: own.ed25519,
              [`curve25519:${configuration.deviceId}`]: own.curve25519
            }
          }

          // Pinned matrix-js-sdk 42.4 uses this canonical-JSON/Rust signer for its own
          // signed objects. It preserves the private identity and adds no cross-signing.
          const signer = crypto as unknown as { signObject(value: object): Promise<void> }

          if (typeof signer.signObject !== 'function') {
            throw new Error('matrix_bot_device_keys_unavailable')
          }

          await signer.signObject(deviceKeys)
          await client.uploadKeysRequest({ device_keys: deviceKeys })

          if (!sameKeys(await serverDevice())) {
            throw new Error('matrix_bot_device_keys_mismatch')
          }

          // Normal sync replenishes Rust's one-time/fallback keys from server counts.
          client.retryImmediately()
        }

        return {
          deviceId: configuration.deviceId,
          ed25519: own.ed25519,
          curve25519: own.curve25519
        }
      }

      case 'appBotRecent': {
        if (
          !appBotMode ||
          !Number.isFinite(command.untilTs) ||
          !Number.isInteger(command.pageCap) ||
          command.pageCap < 1 ||
          command.pageCap > 10 ||
          !Array.isArray(command.botDevices) ||
          command.botDevices.length > 64 ||
          command.botDevices.some(
            device =>
              !device ||
              typeof device.deviceId !== 'string' ||
              typeof device.ed25519 !== 'string' ||
              typeof device.curve25519 !== 'string'
          )
        ) {
          throw new Error('matrix_app_bot_recent_invalid')
        }

        joinedRoom(command.roomId)
        const eventIds: string[] = []
        const seen = new Set<string>()
        const tokens = new Set<string>()
        let from: string | null = null
        let complete = false

        for (let page = 0; page < command.pageCap && !complete; page++) {
          const batch = await client.createMessagesRequest(command.roomId, from, 100, Direction.Backward)

          if (!Array.isArray(batch.chunk) || batch.chunk.length > 100) {
            throw new Error('matrix_app_bot_recent_invalid')
          }

          let oldest = Number.POSITIVE_INFINITY

          for (const raw of batch.chunk) {
            const event = new MatrixEvent(raw)
            const timestamp = event.getTs()
            const eventId = event.getId()

            if (Number.isFinite(timestamp)) {
              oldest = Math.min(oldest, timestamp)
            }

            if (event.getSender() === configuration.userId && eventId?.startsWith('$') && !seen.has(eventId)) {
              seen.add(eventId)
              eventIds.push(eventId)
            }
          }

          if (!batch.end || (Number.isFinite(oldest) && oldest < command.untilTs)) {
            complete = true
          }
          else if (tokens.has(batch.end)) {break}
          else {
            tokens.add(batch.end)
            from = batch.end
          }
        }

        return { eventIds, complete }
      }

      case 'appBotDirectRoomWith': {
        if (!appBotMode || !/^@[^:\s]+:[^\s]+$/.test(command.userId)) {
          throw new Error('matrix_app_bot_direct_invalid')
        }

        const direct = client.getAccountData(EventType.Direct)?.getContent()?.[command.userId]

        const classified = client.getRooms().find(room => {
          const state = room.getAccountData('io.atum.app_bot.state')?.getContent()

          return (
            room.getMyMembership() === 'join' &&
            state?.v === 2 &&
            state.classification === 'direct' &&
            state.direct_person === command.userId
          )
        })?.roomId

        const known = Array.isArray(direct)
          ? direct.find(
              (roomId): roomId is string =>
                typeof roomId === 'string' && client.getRoom(roomId)?.getMyMembership() === 'join'
            )
          : classified

        if (known ?? classified) {
          return known ?? classified
        }

        return (await createConversation(client, { name: '', invite: [command.userId], direct: true })).room_id
      }

      case 'appBotSend': {
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        joinedRoom(command.roomId)
        const reply = !command.notice

        if (
          !APP_UUID.test(command.appId) ||
          !command.body.trim() ||
          (reply &&
            (!command.turnId ||
              !Number.isInteger(command.part) ||
              !Number.isInteger(command.parts) ||
              command.part! < 1 ||
              command.parts! < command.part! ||
              command.parts! > 4)) ||
          (!reply && (typeof command.code !== 'string' || !command.code || command.turnId !== null))
        ) {
          throw new Error('matrix_app_bot_message_invalid')
        }

        const content: Record<string, unknown> = {
          msgtype: command.notice ? MsgType.Notice : MsgType.Text,
          body: command.body,
          'm.mentions': { user_ids: command.mentions ?? [] },
          'io.atum.app_bot': reply
            ? {
                v: 1,
                app_id: command.appId,
                turn_id: command.turnId,
                kind: 'reply',
                part: command.part,
                parts: command.parts
              }
            : {
                v: 1,
                app_id: command.appId,
                turn_id: null,
                kind: 'notice',
                code: command.code,
                action: command.action ?? null
              }
        }

        if (command.replyTo) {content['m.relates_to'] = { 'm.in_reply_to': { event_id: command.replyTo } }}

        return (await client.sendEvent(command.roomId, EventType.RoomMessage, content as never, command.transactionId))
          .event_id
      }

      case 'appBotApiSend': {
        if (!appBotMode) {
          throw new Error('matrix_app_bot_mode_required')
        }

        const room = joinedRoom(command.roomId)

        if (
          !/^atum-bot-[A-Za-z0-9_-]{16,192}$/.test(command.transactionId) ||
          !command.body.trim() ||
          command.body.length > 4096 ||
          command.formattedBody !== undefined && (!command.formattedBody.trim() || command.formattedBody.length > 16_384) ||
          command.metadata.version !== BOT_API_MATRIX_METADATA ||
          !APP_UUID.test(String(command.metadata.bot_id)) ||
          !Number.isSafeInteger(command.metadata.public_message_id)
        ) {
          throw new Error('matrix_app_bot_message_invalid')
        }

        const relation = command.replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: command.replyTo } } } : {}

        const formatted = command.formattedBody
          ? { format: 'org.matrix.custom.html', formatted_body: command.formattedBody }
          : {}

        const send = async () => {
          await assertAppBotDirectAudience(command.roomId, command.directPerson)
          if (!command.photo) {
            return client.sendEvent(command.roomId, EventType.RoomMessage, { msgtype: MsgType.Text, body: command.body, ...formatted, ...relation, 'io.atum.bot_api': command.metadata } as never, command.transactionId)
          }

          const bytes = Buffer.from(command.photo.bytes_base64, 'base64')

          if (!bytes.byteLength || bytes.byteLength > MATRIX_MAX_FILE_BYTES) {
            throw new Error('matrix_file_invalid')
          }

          const info = { mimetype: command.photo.mime_type, size: bytes.byteLength, w: command.photo.width, h: command.photo.height }

          if (await confirmedPlainRoom(client, room)) {
            const upload = await uploadMatrixAttachment(client, bytes, { type: command.photo.mime_type, includeFilename: false }, attachmentUploadDeadline)
            await assertAppBotDirectAudience(command.roomId, command.directPerson)

            return client.sendEvent(command.roomId, EventType.RoomMessage, { msgtype: MsgType.Image, body: command.body, url: upload.content_uri, info, ...formatted, ...relation, 'io.atum.bot_api': command.metadata } as never, command.transactionId)
          }

          const encrypted = Attachment.encrypt(bytes)

          try {
            const upload = await uploadMatrixAttachment(client, new Uint8Array(encrypted.encryptedData), { type: 'application/octet-stream', includeFilename: false }, attachmentUploadDeadline)
            await assertAppBotDirectAudience(command.roomId, command.directPerson)

            return client.sendEvent(command.roomId, EventType.RoomMessage, { msgtype: MsgType.Image, body: command.body, file: { ...JSON.parse(encrypted.mediaEncryptionInfo!), url: upload.content_uri }, info, ...formatted, ...relation, 'io.atum.bot_api': command.metadata } as never, command.transactionId)
          } finally { encrypted.free() }
        }

        // Every retry re-reads server membership even if transaction read-back can
        // confirm an earlier send without entering `send` again.
        await assertAppBotDirectAudience(command.roomId, command.directPerson)
        return await sendWithTransaction(client, command.roomId, command.transactionId, send)
      }

      case 'send': {
        if (client.getRoom(command.roomId)?.getType() === MATRIX_NOTES_SELF_ROOM_TYPE) {
          notesSelfAssertSend(command.roomId)
        }

        await requireMatrixRoomPeerTrust(client, command.roomId, configuration.deviceIsolation, () => !stopped && state === 'ready')
        // A message to the founder (or, on the founder's account, to a person) reaches their
        // cross-signed devices, or it is refused before anything goes out.
        await founderChat.beforeSend(command.roomId)
        const room = joinedRoom(command.roomId)

        const roomMention = Boolean(
          command.roomMention &&
            room.getType() === MATRIX_COMPANY_CHANNEL_TYPE &&
            canMentionMatrixRoom(room, client.getSafeUserId())
        )

        const privateRecipient=companyPrivateCosRecipient(room,client.getSafeUserId())
        const mentions=[...new Set([...(command.mentions??[]),...(privateRecipient?[privateRecipient]:[])])]

        // A reply is a standard rich reply to a message of the same room. Who it names (an
        // assistant in a group) goes as standard intentional mentions.
        return command.threadRootId
          ? sendMatrixThreadReply(
              client,
              room,
              command.body,
              command.threadRootId,
              command.replyTo,
              mentions,
              roomMention
            )
          : command.replyTo
            ? sendMatrixReply(client, room, command.body, command.replyTo, mentions, roomMention)
            : mentions.length || roomMention
              ? sendMatrixText(client, room, command.body, mentions, roomMention)
              : (await client.sendTextMessage(command.roomId, command.body)).event_id
      }

      case 'forward': {
        const sourceRoom = joinedRoom(command.roomId)
        const targetRoom = joinedRoom(command.toRoomId)
        const sourceEvent = sourceRoom.findEventById(command.eventId)

        if (
          !sourceEvent ||
          sourceEvent.getType() !== EventType.RoomMessage ||
          sourceEvent.isRedacted() ||
          sourceEvent.isDecryptionFailure() ||
          sourceEvent.status !== null ||
          Object.hasOwn(sourceEvent.getOriginalContent(), MATRIX_COMPANY_FILE) ||
          !targetRoom.maySendMessage() ||
          appBotDmMarker(targetRoom, configuration.userId)
        ) {
          throw new Error('matrix_forward_invalid')
        }

        const createBinding = (room: Room) => {
          const create = room.currentState.getStateEvents(EventType.RoomCreate, '')

          return create && !Array.isArray(create)
            ? companyRoomTargetBinding(create.getContent(), create.getSender())
            : undefined
        }

        const sourceBinding = createBinding(sourceRoom)
        const targetBinding = createBinding(targetRoom)
        const members = targetRoom.getMembers().filter(member => ['join', 'invite'].includes(member.membership ?? ''))

        const ownAssistant =
          targetRoom.getType() === MATRIX_ASSISTANT_ROOM_TYPE &&
          members.length === 2 &&
          members.some(member => member.userId === configuration.userId && member.membership === 'join')

        if (sourceBinding && sourceBinding.companyId !== targetBinding?.companyId && !ownAssistant) {
          throw new Error('matrix_forward_scope')
        }

        const sourceContent = shownContent(sourceEvent).content
        const content = matrixForwardContent(sourceContent)
        const originalContent = sourceEvent.getOriginalContent()

        if (Object.prototype.hasOwnProperty.call(originalContent, MATRIX_GOOGLE_PROVENANCE_KEY) &&
            !Object.prototype.hasOwnProperty.call(content, MATRIX_GOOGLE_PROVENANCE_KEY)) {
          content[MATRIX_GOOGLE_PROVENANCE_KEY] = originalContent[MATRIX_GOOGLE_PROVENANCE_KEY]
        }

        const encryptedFile = matrixAttachmentMsgtype(content.msgtype) && Boolean(content.file)
        const plainFile = matrixAttachmentMsgtype(content.msgtype) && typeof content.url === 'string'
        const targetPlain = await confirmedPlainRoom(client, targetRoom)

        if (encryptedFile && targetPlain) {
          throw new Error('matrix_forward_encrypted_target')
        }

        if (plainFile && !(await confirmedPlainRoom(client, sourceRoom))) {
          throw new Error('matrix_forward_invalid')
        }

        await requireMatrixRoomPeerTrust(client, command.toRoomId, configuration.deviceIsolation, () => !stopped && state === 'ready')
        await founderChat.beforeSend(command.toRoomId)

        if (plainFile && !targetPlain) {
          const media = await downloadMatrixAttachment(client, sourceContent, { plain: true })
          const encrypted = Attachment.encrypt(media.bytes)

          try {
            const upload = await uploadMatrixAttachment(
              client,
              new Uint8Array(encrypted.encryptedData),
              { type: 'application/octet-stream', includeFilename: false },
              attachmentUploadDeadline
            )

            content.file = { ...JSON.parse(encrypted.mediaEncryptionInfo!), url: upload.content_uri }
            delete content.url
            const info: Record<string, unknown> = record(content.info) ? { ...content.info } : {}
            delete info.thumbnail_url
            delete info.thumbnail_info
            content.info = info
          } finally {
            encrypted.free()
          }
        }

        const transactionId = await matrixForwardTransactionId(
          command.roomId,
          command.eventId,
          command.toRoomId,
          command.dialogNonce
        )

        return sendWithTransaction(
          client,
          command.toRoomId,
          transactionId,
          () => client.sendEvent(command.toRoomId, EventType.RoomMessage, content as never, transactionId)
        )
      }

      case 'attach': {
        if (client.getRoom(command.roomId)?.getType() === MATRIX_NOTES_SELF_ROOM_TYPE) {
          notesSelfAssertSend(command.roomId)
        }

        await requireMatrixRoomPeerTrust(client, command.roomId, configuration.deviceIsolation, () => !stopped && state === 'ready')
        await founderChat.beforeSend(command.roomId)
        const attachRoom = joinedRoom(command.roomId)

        if (command.bytes.byteLength > MATRIX_MAX_FILE_BYTES) {
          throw new Error('matrix_file_invalid')
        }

        // A device's file sent by the cloud assistant carries a fixed transaction ID
        // (`atum-f-<commandId>`): a retry finds the first send instead of uploading again.
        if (command.matrixTransactionId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(command.matrixTransactionId)) {
          throw new Error('matrix_command_invalid')
        }

        const info = { mimetype: 'application/octet-stream', size: command.bytes.byteLength }

        // A room without encryption (every 0.20 chat): the bytes as they are and a plain mxc URL,
        // the form phones and Element X send and show there. A room with encryption keeps the
        // encrypted descriptor (`file`) and never gets plain media.
        const sendPlainFile = async () => {
          const upload = await uploadMatrixAttachment(
            client,
            new Uint8Array(command.bytes),
            { type: info.mimetype, includeFilename: false },
            attachmentUploadDeadline
          )

          return client.sendEvent(
            command.roomId,
            EventType.RoomMessage,
            { msgtype: MsgType.File, body: command.name, filename: command.name, url: upload.content_uri, info },
            command.matrixTransactionId
          )
        }

        const sendFile = async () => {
          if (await confirmedPlainRoom(client, attachRoom)) {
            return sendPlainFile()
          }

          const encrypted = Attachment.encrypt(command.bytes)

          try {
            const upload = await uploadMatrixAttachment(
              client,
              new Uint8Array(encrypted.encryptedData),
              { type: 'application/octet-stream', includeFilename: false },
              attachmentUploadDeadline
            )

            return await client.sendEvent(
              command.roomId,
              EventType.RoomMessage,
              {
                msgtype: MsgType.File,
                body: command.name,
                file: { ...JSON.parse(encrypted.mediaEncryptionInfo!), url: upload.content_uri },
                info
              },
              command.matrixTransactionId
            )
          } finally {
            encrypted.free()
          }
        }

        return command.matrixTransactionId
          ? sendWithTransaction(client, command.roomId, command.matrixTransactionId, sendFile)
          : (await sendFile()).event_id
      }

      case 'download': {
        const room = joinedRoom(command.roomId)
        const raw = await client.fetchRoomEvent(command.roomId, command.eventId)
        const event = new MatrixEvent(raw)
        // A plain file is saved only from a room without end-to-end encryption (0.20 chats);
        // in an encrypted room a file must be an encrypted one (no downgrade).
        const plain = !event.isEncrypted() && (await confirmedPlainRoom(client, room))

        if (!plain) {
          await client.decryptEventIfNeeded(event)
        }

        if ((!plain && !event.isEncrypted()) || event.isDecryptionFailure() || event.isRedacted()) {
          throw new Error('matrix_file_unavailable')
        }

        return downloadMatrixAttachment(client, event.getContent(), { plain })
      }

      case 'roomShared': {
        if (state !== 'ready') {
          throw new Error('matrix_room_shared_unavailable')
        }

        const room = joinedRoom(command.roomId)

        return readMatrixRoomShared(
          client,
          { ...command, encrypted: !(await confirmedPlainRoom(client, room)) },
          () => !stopped && state === 'ready'
        )
      }

      case 'roomSharedThumbnail': {
        const room = joinedRoom(command.roomId)
        const event = new MatrixEvent(await client.fetchRoomEvent(command.roomId, command.eventId))
        // The same rule as Save: a plain photo only in a room without encryption.
        const plain = !event.isEncrypted() && (await confirmedPlainRoom(client, room))

        if (!plain) {
          await client.decryptEventIfNeeded(event)
        }

        if ((!plain && !event.isEncrypted()) || event.isDecryptionFailure() || event.isRedacted()) {
          return null
        }

        return readMatrixRoomSharedThumbnail(client, event.getContent(), plain)
      }

      case 'devices':
        return devices(command.userId)
      case 'verify': {
        await loadDeviceForVerification(crypto, command.userId, command.deviceId)
        const device = (await devices(command.userId)).find(d => d.deviceId === command.deviceId)

        if (!device?.fingerprint || device.fingerprint !== command.fingerprint) {
          throw new Error('matrix_fingerprint_mismatch')
        }

        await crypto.setDeviceVerified(command.userId, command.deviceId, true)

        return null
      }

      case 'retireDevice':
        await crypto.setDeviceVerified(command.userId, command.deviceId, false)

        return null

      case 'rotateOutboundKeys':
        joinedRoom(command.roomId)
        await crypto.forceDiscardSession(command.roomId)

        return null
    }
  }

  return {
    command,
    /**
     * The host renewed this device's credential (an agent's executor, before it expires):
     * take the new token through the host's refresh now, rather than at the next refused
     * request, and resume a sync that was waiting. The device, its keys and its rooms stay
     * as they are. A failure changes nothing: a refused request asks the host again.
     */
    async renewed(): Promise<boolean> {
      if (stopped || !configuration.refreshToken) {
        return false
      }

      const result = await refreshOnce(client.getRefreshToken() ?? configuration.refreshToken)

      if (!result.ok || stopped) {
        return false
      }

      client.setAccessToken(result.accessToken)
      client.retryImmediately()

      return true
    },
    async stop() {
      stopped = true

      for (const cancel of [...appBotRoomWaits]) {
        cancel()
      }

      lateAssistantReconciliations.clear()
      syncHealth.dispose()
      keyRetry.stop()
      backupAvailability.stop()
      stopGoogleFence()
      stopUndecryptable()
      starter.stop()
      firstRun.stop()
      founderChat.stop()
      notesSelf.stop()
      profile.stop()
      presence.stop()
      shortcuts.dispose()
      security?.stop()
      agentIdentity.stop()
      ownerRecovery.stop()
      earlierConversations.stop()
      listener.stop()
      groupTurns.stop()
      agentTasks.stop()
      notifications.stop()
      receipts.stop()

      for (const room of threadRooms) {
        forgetThreadRoom(room)
      }

      clearTimeout(dirtyTimer)
      clearTimeout(draftPruneTimer)
      client.stopClient()
      await store.save(true)
    }
  }
}
