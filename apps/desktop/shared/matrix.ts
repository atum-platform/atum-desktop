import type {
  BotApiMatrixMetadata,
  BotApiMatrixPhotoMetadata,
  BotApiPhotoMimeType
} from '../../../packages/bot-api-v1'

import type { ConversationMarker, ConversationWrite } from './agent-conversation/types'
import type { MatrixConversationView } from './agent-conversation/view'
import type { MatrixRoutinesBridge } from './agent-routines'
import type { AgentTaskBinding, AgentTaskMessage, AgentTaskOwnedAgent, AgentTaskWatch } from './agent-task'
import type { AppDescriptor } from './app-catalog'
import type { MatrixAppHistoryPage } from './app-history'
import type { AppPanelPages } from './app-panel'
import type { AppShortcutState, AppShortcutVisibility } from './app-shortcuts'
import type { AppViewBridge } from './app-view/ipc'
import type { AtumAssistantMark } from './atum-agent-portability'
import type {
  AtumDocumentRecoveryDiscardResult,
  AtumDocumentRecoveryReadResult,
  AtumDocumentRecoveryWriteInput,
  AtumDocumentRecoveryWriteResult
} from './atum-office/document-recovery'
import type { MatrixBackgroundSweepBridge } from './background-sweep'
import type {
  ConsumerBrowserNotice,
  ConsumerBrowserPopup,
  ConsumerBrowserPrepareInput,
  ConsumerBrowserPrepareResult
} from './browser/ipc'
import type { MatrixExecutionPolicyBridge, MatrixExecutionPolicyView } from './execution-policy'
import type { LookPackPublished, LookRoomAccountData } from './look-pack'
import type { MatrixAgentSourcesBridge } from './matrix-agent-sources'
import type { MatrixAliasBridge } from './matrix-aliases'
import type { MatrixAppConnectionState } from './matrix-apps'
import type { MatrixAssistantCardsBridge } from './matrix-assistant-card'
import type { MatrixAwarenessBridge, MatrixAwarenessControlCommand } from './matrix-awareness-controls'
import type {
  MatrixCheckInChange,
  MatrixCheckInFeedbackChange,
  MatrixCheckInLedger,
  MatrixCheckInNudge,
  MatrixCheckInsSnapshot
} from './matrix-check-ins'
import type { MatrixCheckoutBridge, MatrixCheckoutSnapshot } from './matrix-checkout'
import type { MatrixClipboardBridge } from './matrix-clipboard'
import type { MatrixCloudAccessReason } from './matrix-cloud-access'
import type { MatrixCompanyAvatarPhoto, MatrixCompanyBridge } from './matrix-company'
import type { MatrixCompanyActivityItem } from './matrix-company-activity'
import type { MatrixCompanyAISdkCommand } from './matrix-company-ai-sdk'
import type { MatrixCompanyChannelRoomCommand } from './matrix-company-channel-room'
import type { MatrixCompanyFileSdkCommand } from './matrix-company-files'
import type { MatrixCompanyPresentation, MatrixCompanyProgressMarker } from './matrix-company-presentation'
import type { MatrixCompanyPrivateCosRoomCommand } from './matrix-company-private-cos-room'
import type { MatrixCompanyRoomCommand } from './matrix-company-room'
import type { MatrixCompanyMessageSearchSdkCommand } from './matrix-company-search'
import type { MatrixCompanyStoreBridge } from './matrix-company-store'
import type { MatrixContinuityTarget } from './matrix-continuity'
import type { MatrixDecryptionReason } from './matrix-decryption-reason'
import type { MatrixDeviceIsolation } from './matrix-device-isolation'
import type { MatrixDisplayPreferenceChange, MatrixDisplayPreferences } from './matrix-display-preferences'
import type { MatrixDraftsSnapshot } from './matrix-drafts'
import type { MatrixDriveBridge } from './matrix-drive'
import type { MatrixFirstLearningProgress } from './matrix-first-learning'
import type { MatrixFolderAccessBridge } from './matrix-folder-access'
import type {
  MatrixFounderBridge,
  MatrixFounderChatMarker,
  MatrixFounderSdkCommand,
  MatrixFounderView,
  MatrixOfficialAccount
} from './matrix-founder'
import type { MatrixGoogleConnectionBridge } from './matrix-google-connections'
import type { MatrixGoogleAssistantAccess } from './matrix-google-tools'
import type { MatrixHermesActivitySnapshot } from './matrix-hermes-activity'
import type { MatrixInviteLinkBridge } from './matrix-invite-link'
import type { MatrixLinkPreviewBridge } from './matrix-link-preview'
import type { MatrixMacSourcesBridge } from './matrix-mac-sources'
import type { MatrixMessageLinkBridge } from './matrix-message-link'
import type { MatrixModelChoice } from './matrix-model-choice'
import type {
  MatrixCloudModelChoiceView,
  MatrixConnectedModel,
  MatrixEffort,
  MatrixModelCatalog,
  MatrixModelDestinationsView,
  MatrixModelId,
  MatrixModelRouteSelection,
  MatrixModelRouteTarget
} from './matrix-models'
import type { MatrixNativeAppsBridge } from './matrix-native-apps'
import type { MatrixNotesSelfSnapshot } from './matrix-notes-self'
import type { MatrixNotificationPolicy, MatrixNotificationPolicyChange } from './matrix-notification-policy'
import type { MatrixOwnerLocationBridge } from './matrix-owner-location'
import type { MatrixPagesBridge } from './matrix-pages'
import type { MatrixPeopleSearchBridge, MatrixPeopleSearchSdkCommand } from './matrix-people-search'
import type { MatrixPermissionsBridge } from './matrix-permissions'
import type { MatrixPetBridge } from './matrix-pet'
import type { MatrixPetDisplayBridge } from './matrix-pet-display'
import type { MatrixPetIntentEnvelope, MatrixPetIntentProjection } from './matrix-pet-intent'
import type { MatrixPresenceSnapshot, MatrixStatusInput } from './matrix-presence'
import type { MatrixProfileMetadata, MatrixProfilesBridge, MatrixProfileSdkCommand } from './matrix-profile'
import type { MatrixProgressMarker } from './matrix-progress-marker'
import type { MatrixRoomSharedSection } from './matrix-room-shared'
import type { MatrixSavedMessagesSnapshot } from './matrix-saved-messages'
import type { MatrixNativeSecurityCommand, MatrixSecurity, MatrixSecurityCommand } from './matrix-security'
import type { MatrixShelfModelId, MatrixShelfModelView } from './matrix-shelf-models'
import type { MatrixStoreBridge, MatrixStoreSnapshot } from './matrix-store'
import type { MatrixStoreRunLedger } from './matrix-store-runs'
import type {
  MatrixSubscriptionCatalog,
  MatrixSubscriptionKeyResult,
  MatrixSubscriptionPoll,
  MatrixSubscriptionRelayResult,
  MatrixSubscriptionsStatus,
  MatrixSubscriptionStart
} from './matrix-subscriptions'
import type { MatrixTaskFilesPromise } from './matrix-task-files'
import type { MatrixTerminalBridge, MatrixTerminalReadRequest, MatrixTerminalTab } from './matrix-terminal'
import type { MatrixVoiceBridge } from './matrix-voice'
import type { MatrixWalletBridge, MatrixWalletState } from './matrix-wallet'
import type { MatrixWindowAppearance, MatrixWindowFacts, MatrixWindowMode } from './matrix-window'
import type { MatrixWindowFailureDiagnostic } from './matrix-window-failure'
import type { MatrixWebPreviewOffer } from './matrix-workbench-preview'
import type { GroupRecentTarget } from './room-participation/recent'
import type { GroupChainPublication, GroupPolicyChange, GroupRuntimeCommand } from './room-participation/runtime'

export type MatrixDestination = { kind: 'room'; roomId: string } | { kind: 'app'; appId: string } | { kind: 'discover' }
export interface MatrixAppWorkspace {
  state: 'loading' | 'ready' | 'unavailable'
  apps: AppDescriptor[]
  connections: Record<string, MatrixAppConnectionState>
  /** Optional until the L1 endpoint deploys; app packs remain available without it. */
  gallery?: LookPackPublished[]
}
export interface MatrixAppMenu {
  pages?: AppPanelPages['pages']
  defaultPage?: string
  app: AppDescriptor
  routes: Array<{ id: string; label: { vi: string; en: string }; icon: string; session: 'none' | 'required' }>
  /** Declared composer functions, including actions absent from the page menu. */
  actions?: MatrixAppMenu['routes']
}

/** No bearer credentials in UI. Recovery keys are explicit, transient user input. */
export interface MatrixIdentity {
  userId: string
  deviceId: string
}

export interface MatrixRoom {
  id: string
  name: string
  membership: string
  /** Whether this account's current room power allows a message. Display hint only; main rechecks. */
  canSend?: boolean
  /** The room has end-to-end encryption: always the truth, never stretched to mean "Atum may use
   * this room" (that is `encrypted || plainAgent` for agent and bot rooms). */
  encrypted: boolean
  /** An agent's or an official bot's chat without end-to-end encryption (`plainAgentRoom`,
   * shared/matrix-assistant-room.ts), as the SDK projects it; absent means no. Display hint only. */
  plainAgent?: boolean
  /** Immutable standard m.room.create type, projected by the SDK. */
  roomType?: string
  /** A plain Team Space channel's creation binding; display hint only (native rechecks the room).
   * `managerUserId` is the immutable create-event sender: the declared service identity stays out
   * of people surfaces. Optional only for compatibility with older desktop snapshots. */
  companyChannel?: { companyId: string; channelId: string; managerUserId?: string }
  /** Manager-written `m.room.avatar` on a company channel, for Team Space identity only. */
  roomAvatarMxc?: string | null
  /**
   * A company conversation room's creation binding (company DM or group DM); display hint only. The
   * platform's conversation directory confirms it. Such a room is Team Space's, never a Personal chat.
   */
  companyConversation?: { companyId: string; conversationId: string; managerUserId?: string }
  /** Exact `io.atum.company_private_cos` state marker; display hint only. */
  companyPrivateCos?: {
    v: 1
    classification: 'company_private_cos'
    companyId: string
    membershipIncarnation: string
    executorId: string
    attemptId?: string
  }
  /** A raw private-CoS marker event existed but did not pass the exact parser. Quarantine only. */
  companyPrivateCosClaim?: true
  /** Renderer-only: the authenticated platform view names this exact room as the current private-CoS binding. */
  companyPrivateCosBound?: true
  /** Current room policy hints; private-CoS authority rechecks all three with its platform binding. */
  roomVersion?: string
  joinRule?: string
  historyVisibility?: string
  powerLevels?: {
    users: Record<string, number>
    users_default: number
    events_default: number
    state_default: number
    invite: number
    kick: number
    ban: number
    redact: number
    events: Record<string, number>
  }
  /** Immutable creation binding; display hint only, native rechecks server state. */
  appGroup?: { owner: string; app: string }
  direct?: boolean
  legacyAppBotMoved?: { appId: string; botUserId: string; movedAt: number }
  /** An official bot's one-to-one chat with this account (Moon, Andy), read by the SDK from the
   * room's own marker and its current members. Display only; main re-checks before a send. */
  appBot?: MatrixRoomAppBot
  canInvite?: boolean
  /** The group's shared topic (standard `m.room.topic`), one bounded line. Display only. */
  topic?: string
  /** This account's power level allows `m.room.name` / `m.room.topic` in this room. Display hint
   * only: the SDK re-reads room state and power levels before it sends either event. */
  canName?: true
  canTopic?: true
  unreadNotifications?: number
  /** Standard per-user m.favourite tag; display only, never room authority. */
  favourite?: boolean
  favouriteOrder?: number
  /** Standard per-user m.lowpriority tag: the chat sorts below the others. Display only. */
  lowPriority?: boolean
  lastActiveAt?: number
  /** SDK state for display classification only; native re-reads room state before execution. */
  participants?: { userId: string; membership: string }[]
  /** The other member's Matrix profile photo (`mxc://`) in an ordinary one-to-one chat, for its
   * roster row. Display only; the window loads it through the authenticated member bridge, never
   * from this string. Absent for groups, assistant rooms and app groups. */
  peerAvatarMxc?: string | null
  assistant?: boolean
  /** The agent this private room belongs to: the one that is its other member (display
   * only; main re-reads the room before any turn). */
  agentPrincipal?: string
  /** Owner-checked marker hint; admission re-reads full server state. */
  conversation?: ConversationMarker | null
  conversationOwnerId?: string
  /** The owner's model for this conversation (`io.atum.model` room account data, private to
   * them); absent means the default. Main reads it when a turn starts. */
  model?: MatrixModelId
  /** The owner's thinking level for this conversation (`io.atum.model` too); absent means the
   * model's default. */
  effort?: MatrixEffort
  /** Sanitized private choice; native intake refuses unsupported sources before execution. */
  modelChoice?: MatrixModelChoice
  /** A present record failed the closed reader; absence must not become paid defaulting. */
  modelChoiceInvalid?: true
  /** The owner's own name for this chat (`io.atum.title` room account data, private to them).
   * Display only. */
  title?: string
  /** The owner's background choice (`io.atum.chat.look` room account data, private to them). */
  look?: LookRoomAccountData
  /** An assistant history's first message from the owner, bounded, for its title. Only once
   * the room's whole history is loaded, so a title never changes as more history loads.
   * Display only. */
  firstLine?: string
  /** When the room was created (its create event), for a dated title. Display only. */
  createdAt?: number
  /** Muted with a room-specific push rule: no banners and no unread count. Display only. */
  muted?: boolean
  /** Marked unread by its owner (standard `m.marked_unread` room account data, MSC2867):
   * it reads as unread until it is opened or marked read. Display only. */
  markedUnread?: boolean
  /** The server's highlight count (mentions and keywords), threads included. Display only. */
  highlights?: number
  /** The signed-in member currently meets this room's `notifications.room` power threshold.
   * Display/send hint only: the homeserver push rule rechecks the sender's power level. */
  canMentionRoom?: boolean
  /** Messages from others this account has not read yet, whether or not they notified (a
   * muted chat's still count). Display only. */
  unread?: boolean
  /** The latest message, as the chat list previews it (Element's room list). Display only. */
  preview?: MatrixRoomPreview
  /**
   * Whether anyone has spoken in an assistant's chat, from the history this device has loaded:
   * `started` (a message of either side, readable or not) or `none` (the loaded history reaches the
   * room's creation and holds no message). Absent when the loaded history cannot say, and for every
   * other room. The first run reads it once, to tell a new account from one that already talks to
   * its assistant (shared/matrix-first-run-eligibility.ts).
   */
  dialogue?: 'started' | 'none'
}

/**
 * An official bot's chat with this account. The roster draws it inside the bot's own row (one
 * row per bot), never as a chat of its own.
 */
export interface MatrixRoomAppBot {
  appId: string
  botUserId: string
  /** The chat the bot's row opens: the room opening the bot again reuses (src/matrix/app-bot-dm.ts). */
  current?: true
  /** The person deleted this chat. Delete chat keeps a bot's room and its history, out of sight,
   * until the bot is opened again or something new arrives in it. */
  hidden?: true
}

/** One bounded line about a chat's latest message, for its row in the chat list. */
export interface MatrixRoomPreview {
  /** You wrote it. */
  own: boolean
  /** Who did, by the name the room knows them by (never shown for your own). */
  sender?: string
  kind: 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'deleted' | 'unreadable'
  /** What it says, flattened to one line (text and files). */
  text?: string
  at: number
}

/** The longest preview line the SDK hands the chat list; the row's ellipsis does the rest. */
export const MATRIX_ROOM_PREVIEW_MAX = 140

/** One reaction key on a message: each person counts once, whatever their clients sent. */
export interface MatrixReaction {
  key: string
  count: number
  /** You reacted with it. */
  own: boolean
  /** Who reacted, for its tip (display only, bounded). */
  senders: string[]
}

/** Display projection only: Matrix membership/power levels remain authoritative. */
export interface MatrixMember {
  userId: string
  /** Undisambiguated Matrix profile name; routing checks use this, never the cosmetic room label. */
  rawName?: string
  name: string
  membership: string
  /** Its Matrix profile photo (`mxc://`), for the chat's rows. Display only; the window's
   * media is loaded through the authenticated profile bridge, never from this string. */
  avatarMxc?: string | null
  canRemove: boolean
  canBan?: boolean
  canUnban?: boolean
}

/** Versioned `io.atum.bot_api/1` metadata of one bot message, as the window may render it.
 * The sender and pinned-device checks happen before this reaches a bubble; this shape itself
 * grants nothing. */
export interface MatrixBotApiMessage {
  version: BotApiMatrixMetadata['version']
  botId: string
  publicMessageId: number
  /** URL-only Telegram-style rows, strictly decoded from authenticated Matrix metadata. */
  keyboard?: Array<Array<{ label: string; kind: 'url'; url: string }>>
  photo?: {
    fileRef: string
    width: number
    height: number
    mimeType: BotApiMatrixPhotoMetadata['mime_type']
    caption?: string
  }
  fallbackText?: string
  /** The platform's safe Matrix HTML for the body, when it sent one. */
  formattedBody?: string
}

/** A photo's authenticated bytes, as the window's image element may show them. */
export interface MatrixBotApiPhoto {
  url: string
  width: number
  height: number
  mimeType: BotApiPhotoMimeType
}

export interface MatrixMessage {
  /** Cosmetic v1 commands plus SDK live provenance; never execution authority. */
  petIntents?: MatrixPetIntentProjection
  id: string
  sender: string
  body: string
  timestamp: number
  own: boolean
  encrypted: boolean
  decryptionFailed: boolean
  /** Closed SDK-derived display reason; never sender/execution authority. */
  decryptionReason?: MatrixDecryptionReason
  pending: boolean
  failed: boolean
  /** Your own message the server has (its event ID, nothing still sending): the one tick
   * "Sent". Display only; never a delivery or read claim. */
  sent?: true
  attachment: boolean
  /** Strict company-Drive reference; display/routing hint only, native re-reads the event. */
  companyFile?: true
  /** The file's size from its own event, when it says (display only). */
  attachmentSize?: number
  /** Public `m.read` receipts that sit on this exact event, never private ones, SDK-synthesized
   * sender receipts, or a local send. Display only: who the message's reader avatars show. */
  readBy?: string[]
  /** Standard reply/thread parent, for presentation only; never execution authority. */
  replyTo?: string
  /** Standard intentional Matrix mentions. User ids and the room flag are display/notification
   * metadata only; room membership and push rules remain authoritative. */
  mentions?: { userIds: string[]; room: boolean }
  /** Strictly projected private-CoS greeting pill; formatted HTML never reaches React. */
  privateCosAgentPill?: { userId: string; label: '@Chief of Staff'; href: string }
  /** Strict platform board/card target paired with the greeting pill. */
  privateCosBoardLink?: { title: string; href: string }
  /** Untrusted display correlation only, never proof of result provenance. */
  resultFor?: string
  /** The `io.atum.turn` marker of a local-path question or answer (UUID). Display
   * correlation only: the renderer merges a local turn with its room events by it. */
  turn?: string
  /** Changed by its own sender since it was sent (a standard `m.replace` edit); `body` is
   * the latest text. An edit from anyone else is never applied. */
  edited?: boolean
  /** The replacing event's server timestamp. Display only; absent when no valid edit applies. */
  editedAt?: number
  /** Deleted (a standard redaction): it has no body any more. */
  redacted?: boolean
  /** With `redacted`: its own sender removed it with the agent-turns removal reason
   * (`MATRIX_TRANSIENT_REDACTION_REASON`), so it was a working line whose turn ended, not a real
   * deletion. It shows nothing, not a "deleted" tombstone (`matrixHideEndedTransientLines`). */
  transientRemoved?: true
  /** Standard `m.annotation` reactions, most used first. */
  reactions?: MatrixReaction[]
  /** Sent inside a standard Matrix thread; shown only in its thread panel. */
  thread?: boolean
  /** Fresh message content re-sent by a forward. Display only; carries no source identity. */
  forwarded?: true
  /** Standard `m.thread` root. Present only with `thread`; never a separate audience. */
  threadRootId?: string
  /** An `m.notice`: automated status, such as the assistant saying it held a reply. Never an
   * answer: it marks nothing answered and carries no answer actions. */
  notice?: boolean
  /** The agent's one progress line for a turn (agent-turns/1.3 `io.atum.progress`), read from
   * its latest content. Render hook for the bubble that shows it: a light, muted agent row under
   * the typing indicator while the turn works (agent-turns/1.4: transient). Once the turn has ended
   * it is gone (`matrixHideEndedTransientLines`); never marked edited. It is not an answer: it
   * marks nothing answered and is never a roster preview. */
  progress?: MatrixProgressMarker | MatrixCompanyProgressMarker
  /** An interim remark of the agent (agent-turns/1.4 `io.atum.interim`): a real message, never the
   * answer. It marks nothing answered and does not stop the no-reply banner. */
  interim?: true
  /** A company agent's working line or interim remark (agent-turns/1.6, scope `company`): its admitted
   * public identity, after the projection's strict read and room-local checks. The renderer keeps it
   * (with `progress`/`interim`) only for the room's bound agent (`matrixAdmitCompanyPresentation`).
   * Display correlation only; never authority. */
  company?: MatrixCompanyPresentation
  /** Native-validated bot device/marker evidence, never inferred from m.notice. */
  appBot?: {
    appId: string
    kind: 'notice' | 'reply' | 'bot_api'
    authenticated: true
    code?: string
    action?: { kind: 'open_setup' | 'open_app_route' | 'open_bot_dm' | 'connect_account'; app: string; route_id?: string } | { kind: 'retry_later' | 'wait' | 'acknowledge_unknown' } | null
    turnId?: string | null
    part?: number
    parts?: number
    botId?: string
    publicMessageId?: number
  }
  /** A check-in the assistant posted on its own (`io.atum.nudge` beside its cron marker):
   * its card's line, source and one offer. Display only; the window shows it as a card only
   * from the room's own assistant. */
  checkIn?: MatrixCheckInNudge
  /** Closed cloud notice code and its synthetic Stop target; display only. */
  cloudStatus?: { code: string; stopEvent?: string }
  /** Versioned bot-api presentation metadata (`io.atum.bot_api/1`), present only on a message
   * from an official app bot. Display only. */
  botApi?: MatrixBotApiMessage
}

/** One shared room pin. A missing message is an honest tombstone: the state event still names
 * it, but this bounded SDK window cannot currently read it. Redacted messages are omitted from
 * the collection entirely. */
export interface MatrixPinnedMessage {
  eventId: string
  message?: MatrixMessage
}

/** Standard `m.room.pinned_events` state for the selected Team Space room. */
export interface MatrixPinnedMessages {
  /** The live room power levels allow this account to send the pinned-events state event. */
  canChange: boolean
  entries: MatrixPinnedMessage[]
}

/** One standard Matrix thread in the open Team Space channel. Thread content inherits the
 * room ACL; these fields are a bounded display projection, never separate authority. */
export interface MatrixThread {
  root: MatrixMessage
  replies: MatrixMessage[]
  /** Bounded sender IDs represented in the loaded root/replies, for display only. */
  participantIds: string[]
  /** Server/SDK count can be larger than the bounded loaded `replies` window. */
  replyCount: number
  lastActivityAt: number
  unread: boolean
  highlights: number
  /** Explicit preference, participation, or a standard mention; a manual unfollow overrides. */
  followed: boolean
}

/** One standard Matrix thread in the bounded company-wide Threads inbox. The company and room
 * identifiers are navigation/privacy context; the thread content remains the room projection. */
export interface MatrixCompanyThread extends MatrixThread {
  companyId: string
  roomId: string
}

/**
 * Someone coming into, or no longer in, a Team Space channel, as that room's own `m.room.member`
 * events say it. A quiet line between messages, never a message: it has no body, answers nothing
 * and is nobody's unread. Display only; Matrix membership stays the authority.
 */
export interface MatrixMembershipLine {
  /** The membership event's id. */
  id: string
  timestamp: number
  /**
   * `departed` is a leave, a kick or a ban of someone who was in. The platform's room manager
   * completes both a removal and a leave as a ban, so the event cannot say which of the two
   * it was and the line does not claim one.
   */
  kind: 'joined' | 'departed'
  /** Whose membership changed. */
  userId: string
  /** The name that event (or the one before it) gave them, for when the member list no longer has them. */
  name?: string
}

export interface MatrixDevice extends MatrixIdentity {
  fingerprint: string
  verified: boolean
  /** The name the device gave itself ("Element X: iPhone"), display only. */
  name?: string
  /** When it was last active, for the person's own devices (ms since epoch). */
  lastSeenAt?: number
}

export interface MatrixLinkedDocument {
  name: string
  state: 'linked' | 'reconnect_required' | 'unavailable'
  /** Selection identity, not a read capability. Changes even on same-name reselection. */
  revision?: string
  kind?: 'word'
}

export type MatrixDocumentPreview = { token: string; name: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'editable'; recovery: boolean }
  | { kind: 'word'; text: string; saved: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'pdf' }
  | { kind: 'unsupported' }
)

export interface MatrixPdfBridge {
  show(token: string, bounds: { x: number; y: number; width: number; height: number }): Promise<{ shown: boolean }>
  hide(token: string): Promise<void>
  close(token: string): Promise<void>
}

/** The Matrix UI's deliberately small, unprivileged browser capability. */
export interface MatrixConsumerBrowserBridge {
  onPopup(listener: (payload: ConsumerBrowserPopup) => void): () => void
  onNotice(listener: (payload: ConsumerBrowserNotice) => void): () => void
  prepare(input: ConsumerBrowserPrepareInput): Promise<ConsumerBrowserPrepareResult>
  release(partition: string): Promise<{ ok: boolean }>
}

/** A sign-in to this account on another device, after this Mac first saw the device list
 * (new-sign-in-alert.ts). Display only; the window never shows the device ID itself. */
export interface MatrixNewSignIn {
  deviceId: string
  /** The device's own Matrix display name, when it has one. */
  name?: string
}

export interface MatrixSnapshot {
  /** SDK-confirmed account marker; unknown/offline never means a new account. */
  starterMarker?: 'unknown' | 'unseen' | 'seen'
  /** Native ledger allowance, in integer micro-Protons, while its marker is unseen. */
  starter?: { kind: 'founding' | 'standard'; amount: number }
  /** SDK-confirmed legacy first-run marker (`io.atum.onboarding.first_run`), now closed when the
   * comprehensive learning one-shot is handed off; unknown/offline never means a new account. */
  firstRunMarker?: 'unknown' | 'unseen' | 'answered'
  /**
   * SDK-confirmed: whether the primary assistant's welcome is on offer to
   * this account (`io.atum.onboarding.first_run.v2`, a record separate from the legacy marker
   * above). `unseen` means nobody has evaluated the account yet: main does that once, from what the
   * account already holds (an earlier marker, dialogue with its primary), and writes `open` for a
   * new account, `done` for one that is not. `done` and the legacy `dismissed` state never come
   * back. Unknown or
   * offline never means a new account.
   */
  firstRunWelcome?: 'unknown' | 'unseen' | 'open' | 'done' | 'dismissed'
  /** The primary assistant's first-learning presentation: `offer` for the connector card,
   * `working` while its one-shot is claimed. `blocked` is the one-line recovery after a real
   * protected-folder refusal (and remains compatible with 0.20.19). */
  firstRun?: 'offer' | 'working' | 'blocked'
  /** Data-only source transitions for the approved learning tiles. */
  firstRunProgress?: MatrixFirstLearningProgress
  /** The first run is open for this account, whichever side answers its primary assistant (this
   * Mac or the cloud): the welcome and connector card may show while it is set. Absent once the account has
   * answered, while the marker is unknown, and once this window recorded an answer. */
  firstRunOpen?: true
  /** Main-owned ledger projection; absent when the domain wallet is not configured. */
  wallet?: MatrixWalletState
  checkout?: MatrixCheckoutSnapshot
  store?: MatrixStoreSnapshot
  /** The current SDK identity's standard Matrix profile; display only. */
  ownProfile?: MatrixProfileMetadata
  /** Observed Matrix m.presence for joined Team-space people. Missing users are unknown, never fake offline. */
  presence?: MatrixPresenceSnapshot
  /** Human account data from ordinary SDK sync, not local/profile configuration. */
  displayPreferences?: MatrixDisplayPreferences
  /** Private account-wide Team space notification policy, shared with phone clients. */
  notificationPolicy?: MatrixNotificationPolicy
  /** Native per-install policy; a write retires every SDK host before its replacement starts. */
  deviceIsolation?: { value: MatrixDeviceIsolation; writable: boolean }
  /** The default assistant's check-ins (shared/matrix-check-ins.ts): the owner's synced
   * records, from ordinary SDK sync. Display only; main re-reads them fresh to decide. */
  checkIns?: MatrixCheckInsSnapshot
  /** Private per-account Saved message pointers from ordinary Matrix account data. */
  savedMessages?: MatrixSavedMessagesSnapshot
  /** Private per-account Team space composer drafts from ordinary Matrix account data. */
  drafts?: MatrixDraftsSnapshot
  /** Matrix-native notes: legacy personal scope plus one independent room per company. */
  notesSelf?: MatrixNotesSelfSnapshot
  /** Bounded recent mentions and participated-thread replies from joined Team Space rooms. */
  companyActivity?: MatrixCompanyActivityItem[]
  /** Bounded standard threads from joined Team Space channels and company conversations. */
  companyThreads?: MatrixCompanyThread[]
  /** Native account-generation fence for pet presentation and app-view retirement; not a credential. */
  petScope?: string
  /** Public homeserver from native launch config, not inferred from the user's Matrix ID. */
  homeserver?: string
  destination?: MatrixDestination | null
  apps?: MatrixAppWorkspace
  appShortcuts?: Record<string, AppShortcutState>
  state: 'signed_out' | 'signing_in' | 'connecting' | 'ready' | 'offline' | 'error'
  /**
   * With `state: 'ready'`: the sync is reconnecting or failing within its grace (shared/
   * matrix-sync-health.ts). The engine is alive, so nothing running ends; main takes no new
   * claim until it is back. Absent when the sync is healthy, and never present with any other
   * state.
   */
  degraded?: true
  identity: MatrixIdentity | null
  /** Main's enrolled SDK identity, never inferred from a room name or avatar. */
  assistant?: MatrixIdentity
  /** Display-only native app hosts. Membership and enrollment are re-read on send. */
  appParticipants?: Array<{ appId: string; userId: string; ready: boolean }>
  appTurn?: { appId: string; roomId: string }
  rooms: MatrixRoom[]
  roomId: string | null
  messages: MatrixMessage[]
  /** The room's `m.fully_read` event captured before this visit advances receipts. */
  readMarkerEventId?: string
  /** Shared pins for the selected Team Space room. Absent in personal chats. */
  pinnedMessages?: MatrixPinnedMessages
  /** Threads for the open Team Space channel, newest activity first. */
  threads?: MatrixThread[]
  /** Joins and departures of the open Team Space channel, oldest first (absent in every other room). */
  membershipLines?: MatrixMembershipLine[]
  /** Who is typing in the open chat right now (never you, never someone ignored). Display only. */
  typing?: string[]
  /** The open Team Space channel's whole history is loaded, back to its start (its intro goes there).
   * Display only; absent in every other room and while older pages remain. */
  historyStart?: true
  members?: MatrixMember[]
  ignoredUsers?: string[]
  canSend?: boolean
  error: string | null
  /** With no account signed in: which ways in the sign-in server takes, asked in the
   * background when the sign-in window opens. Absent once signed in. */
  signInMethods?: { email: MatrixEmailSignIn }
  /** While signing in: the browser is back and the sign-in finishes in the app (main brings the
   * window forward then), so the window no longer asks the person to finish in the browser. */
  signInReturned?: boolean
  /** While signing in: false until the browser opens (a returning person's Atum account sign-in
   * proves itself first, up to five seconds), so the window doesn't ask them to finish in a
   * browser that hasn't opened yet. Absent means open (older main, every other state). */
  signInBrowser?: boolean
  domainEnabled?: boolean
  /** Display-only rollout state, never company authority. */
  companyWorkspaceEnabled?: boolean
  /** Display-only attachment affordance; native/platform checks remain authoritative. */
  companyDriveFilesEnabled?: boolean
  /** Display-only T3b1 source enrollment affordance; native/platform authority is rechecked. */
  companyProjectSourcesEnabled?: boolean
  /** Display-only T3b2 receipt coverage; native/platform authority is rechecked. */
  companyProjectReaderEnabled?: boolean
  companyFundingEnabled?: boolean
  /** Automatic assistant setup: in progress, waiting for one click, or failed (retryable). */
  assistantSetup?: 'working' | 'action_required' | 'failed'
  /** What the window waits on before it opens (preparing the assistant, then Atum's model),
   * and whether that step is running, needs one click, or failed. Absent once nothing blocks. */
  startup?: { step: 'assistant' | 'model'; state: 'working' | 'action_required' | 'failed' }
  agentCleanupRequired?: boolean
  /** This Mac's disk is filling up (electron/matrix/disk-health.ts): below 10 GB `low`, below
   * 3 GB `critical`. Presentation only. */
  disk?: { state: 'low' | 'critical'; freeGb: number }
  /** This Mac's own device lost its keys under its ID (electron/matrix/device-ledger.ts): only
   * a new sign-in mends it, and the recovery key kept here unlocks that by itself. */
  deviceDamaged?: true
  /** Main-owned progress survives the human device ID changing. */
  ownerDeviceRepair?: { state: 'verifying' | 'resume_pending' | 'failed'; error?: string }
  /** This Mac has no device-service enrollment for the owner, or it no longer matches this human device. */
  deviceControlRequired?: true
  /** The account signed in on another device after this Mac's first sign-in (G13): the window
   * offers to see and sign it out. Dismissing acknowledges that device across restarts. */
  newSignIn?: MatrixNewSignIn
  hermes?: 'unconfigured' | 'invalid' | 'unavailable' | 'ready' | 'running'
  hermesPrompts?: { roomId: string; prompts: MatrixHermesPrompt[] }
  hermesPromptNotice?: { id: string; roomId: string; reason: MatrixHermesPromptNotice }
  hermesListening?: MatrixListeningState
  /** Keyed by { roomId, eventId } on the server path and { roomId, turnId } on the local path. */
  hermesActivity?: MatrixHermesActivitySnapshot & { roomId: string; eventId?: string; turnId?: string }
  security?: MatrixSecurity
  linkedDocument?: MatrixLinkedDocument | null
  webPreview?: MatrixWebPreviewOffer
  terminals?: MatrixTerminalTab[]
  terminalRead?: MatrixTerminalReadRequest
  /** The local assistant's gate and watch (plan 2026-09-26-reliable-local-first-chat §4.5).
   * Absent when this build has no assistant (no domain configured). */
  readiness?: MatrixReadiness
  /** Local turns of the selected room that are not yet both in its timeline (§4.2, §5). */
  localTurns?: MatrixLocalTurnView[]
  /** Which path the assistant composer takes. Main reads the launch config; this is display. */
  assistantPath?: MatrixAssistantPath
  /** The assistant answers with Atum's own model (not one the person brought), so the
   * conversation's model picker applies. */
  atumModel?: boolean
  /** The default assistant answers with a model the person connected (Settings › Assistant). */
  ownModel?: boolean
  /** That connected model, when known: its name for the picker, and whether it thinks. */
  connectedModel?: MatrixConnectedModel
  /** A cloud agent's own model on this Mac, when the saved policy keeps it a destination. */
  localModel?: MatrixConnectedModel
  /** Every agent on this Mac, default first. The singular fields above stay the default
   * agent's until the window reads these (per-agent runtime plan §2.4). */
  agents?: MatrixAgentView[]
  /** The launch-time roster barrier. `ready` means main has fetched and reconciled the
   * authoritative roster for this account generation, so `agents` is the complete set the
   * loading screen must wait for. A failed read is explicit instead of looking like an empty
   * roster and opening the app early. */
  agentRoster?: { state: 'loading' | 'ready' | 'unavailable'; since: number }
  /** Every agent's work in progress, by room. */
  agentTurns?: MatrixAgentTurnView[]
  /** The platform can make more agents (its roster names each agent's Matrix user, 0146). */
  agentCreation?: boolean
  /** Whether the default assistant can use Google: the first-run card / post-skip chip and
   * Settings read it (shared/matrix-google-tools.ts). Absent when this build has no Google. */
  googleAssistant?: MatrixGoogleAssistantAccess
  /** The platform's founder (shared/matrix-founder.ts), for the Founder row and its mark:
   * `roomId` once this account's Founder chat exists. Never inferred from a name; absent while
   * the platform names none or cannot be read. */
  founder?: MatrixFounderView
  /** Every account Atum marks, from the platform. Absent when that read is unavailable: then
   * nobody carries a mark (an unavailable list is never an empty one). */
  officialAccounts?: MatrixOfficialAccount[]
  /** The person's SDK's record of their Founder chat (`io.atum.founder_chat`), published by the
   * SDK host; main decides from it and composes `founder.roomId`. */
  founderChat?: MatrixFounderChatMarker
}

export type MatrixAssistantPath = 'local' | 'server'

/** Closed, read-only content metadata for this agent's current Hermes home on this Mac.
 * Counts describe declared portable skills, not all installed/bundled skills or readiness.
 * No persona text, skill names/hashes, paths or raw errors cross into the window. */
export type MatrixAgentContentSkillState =
  | 'installed'
  | 'bundled'
  | 'bundled_version'
  | 'different'
  | 'suppressed'
  | 'collision'
  | 'blocked'
  | 'missing'
  | 'unsupported'
  | 'unavailable'

export interface MatrixAgentContentView {
  state: 'checking' | 'complete' | 'differs' | 'incomplete' | 'error'
  definitionRevision?: number
  persona?: 'matches' | 'differs' | 'absent' | 'none'
  skills?: { declared: number; installedNow: number; receiptReset: boolean } & Partial<
    Record<MatrixAgentContentSkillState, number>
  >
  error?: 'definition' | 'denied' | 'busy' | 'helper'
  checkedAt?: number
}

/** Where an agent lives and a move in plain steps (atum.agent-home/2.1, slice 1: the owner's Macs).
 * `name` is the owner's name for the Mac; empty when it is not known here, and the window says "another Mac". */
export interface MatrixAgentHomeView {
  activation?: { state: 'ready' | 'not_ready'; reason: string | null }

  lives: { kind: 'cloud' } | { kind: 'mac'; name: string; thisMac: boolean }
  /** A move under way: asking the platform, saving, handing over, or (on the new home) taking over. */
  move: null | {
    step: 'asking' | 'saving' | 'handing_over' | 'taking_over'
    to: { kind: 'cloud' } | { kind: 'mac'; name: string; thisMac: boolean }
    /** What this Mac is doing in it. */
    role: 'source' | 'target' | 'other'
  }
  /** The owner's Mac candidates (their registry names). `thisMac` keeps the running, signed-in
   * Mac visible even while the additive owner-placement route is switched off. */
  targets: Array<{ id: string; name: string; thisMac?: boolean }>
  /** Why the last attempt did not finish, as a closed code; null when nothing is wrong. */
  issue: string | null
  /** Additive 2.5 owner projection. Absent against a 2.1-only platform. */
  placement?: MatrixAgentHomePlacementView
}

export interface MatrixAgentHomeModelOption {
  /** Opaque, display-safe connection reference plus exact model/effort. */
  connectionRef: string
  /** `opencode_go` is the account-wide cloud subscription (`atum.model-choice/1.4`). */
  source: 'atum' | 'chatgpt_plan' | 'opencode_go' | `own_key:${string}`
  providerLabel: string
  model: string
  modelLabel: string
  effort: 'low' | 'medium' | 'high' | 'max'
  efforts: readonly ('low' | 'medium' | 'high' | 'max')[]
  available: boolean
  /** An Atum-funded OpenRouter shelf model (cloud only): its rail, name and Proton price. */
  shelf?: MatrixShelfModelView
}

export interface MatrixAgentHomeDestinationView {
  id: 'cloud' | string
  kind: 'cloud' | 'mac'
  name: string
  thisMac: boolean
  eligibility: 'ready' | 'unavailable'
  reason?: 'offline' | 'not_enrolled' | 'version_unsupported' | 'home_conflict' | 'catalog_unavailable'
  /**
   * Only on the Mac the window is on, while the assistant lives elsewhere and nothing is moving. `needed`: this Mac is not set
   * up for it yet (or its set-up lapsed), so the sheet offers "Set this Mac up", which makes it a place to move to.
   * `connect`: it is set up but no model is connected on it, so the sheet says to connect one. Absent otherwise.
   */
  setUp?: 'needed' | 'connect'
  catalogRevision: number
  models: readonly MatrixAgentHomeModelOption[]
}

export interface MatrixAgentHomePlacementView {
  profile: 'atum.agent-home/2.5'
  moveAvailable: boolean
  /**
   * The assistant lives on a Mac that is not answering (asleep, offline, or its models went stale) so the platform offers no
   * move: the sheet says it waits for that Mac, keeps the move to the cloud (disclosed, the owner accepts what is lost) and
   * Cancel, and offers no other Mac. Absent when it is not waiting.
   */
  waitingForHome?: boolean
  current: 'cloud' | string
  reachability: 'reachable' | 'asleep' | 'offline'
  destinations: readonly MatrixAgentHomeDestinationView[]
  currentModel?: MatrixAgentHomeModelOption
  modelStatus?: 'pending' | 'applied' | 'unavailable'
  progress?: {
    state:
      | 'finishing_current_work'
      | 'moving'
      | 'waiting_for_destination'
      | 'reconciling'
      | 'ready'
      | 'failed'
    sequence: number
    reason: string | null
  }
}

export interface MatrixAgentHomePreflightView {
  ok: true
  preflightId: string
  target: 'cloud' | string
  /** Only what will really not move; empty is said as such, never a generic list. */
  featureLosses: readonly string[]
  /** The newest checkpoint the platform holds (ms): shown beside the loss it discloses. */
  lastCheckpointAtPlatform: number | null
  /**
   * This move would lose the work done since that checkpoint. The window shows the time and asks the owner to accept it;
   * Move stays off until they do, and it is the owner's tick (never this flag) that main passes on.
   */
  checkpointLossRequired: boolean
}

export type MatrixAgentHomeMoveResult =
  | { ok: true }
  | {
      ok: false
      reason: string
    }

export interface MatrixAgentHomeBridge {
  /** Fresh owner projection plus target catalogs for the one placement/model sheet. */
  read(agentPrincipal: string): Promise<MatrixAgentHomeView | undefined>
  /** Compute only actual losses. Main retains the exact accepted preflight; renderer gets its id. */
  preflight(
    agentPrincipal: string,
    target: 'cloud' | string,
    model: Pick<MatrixAgentHomeModelOption, 'connectionRef' | 'model' | 'effort'>
  ): Promise<MatrixAgentHomePreflightView | { ok: false; reason: string }>
  /** Move using the exact preflight main retained; `acceptCheckpointLoss` is the owner's own tick for that review. */
  move(agentPrincipal: string, preflightId: string, acceptCheckpointLoss?: boolean): Promise<MatrixAgentHomeMoveResult>
  /** Cancel the move in flight; the agent goes on where it is. A refusal says why in the platform's closed words. */
  cancel(agentPrincipal: string): Promise<{ ok: boolean; reason?: string }>
  /** Change only the current home's default; application occurs at the next turn boundary. */
  model(
    agentPrincipal: string,
    model: Pick<MatrixAgentHomeModelOption, 'connectionRef' | 'model' | 'effort'>
  ): Promise<{ status: 'saved' | 'refused'; reason?: string }>
  /**
   * The owner's "Set this Mac up for <assistant>": this Mac enrolls for it and tells the platform which models it can answer
   * with, so it becomes a place the assistant can move to (here and on the phone). Moves nothing. Answers with a closed reason.
   */
  prepare(agentPrincipal: string): Promise<{ ok: boolean; reason?: string }>
}

/** One of the person's agents on this Mac (
 * §2.4), for display: the default agent first. */
export interface MatrixAgentView {
  conversation?: MatrixConversationView
  principal: string
  userId: string
  /** Current owner-authorized domain record, for per-agent Store delivery. */
  assistantId?: string
  /** Canonical assistant photo from the owner-scoped platform roster. */
  avatarUrl?: string | null
  /** Its device on this Mac, once enrolled here. */
  deviceId?: string
  name?: string
  /** Optional owner-authored role line and generated-mark fallback. */
  title?: string
  mark?: AtumAssistantMark
  /** Its own SDK's standard Matrix profile. Agent photos do not read from this projection. */
  profile?: MatrixProfileMetadata
  isDefault: boolean
  hire?: { state: 'active' | 'paused'; price_protons: number; period_end?: string; renewal_error?: string }
  /** Its current answering destination is ready. A cloud destination does not borrow this Mac's
   * optional standby-host state. */
  ready: boolean
  hermes: NonNullable<MatrixSnapshot['hermes']>
  readiness?: MatrixReadiness
  setup?: NonNullable<MatrixSnapshot['assistantSetup']>
  /** It answers with Atum's model, so the conversation's model picker applies. */
  atumModel: boolean
  /** The model the person connected for it, when it answers with one (and it is known). */
  connectedModel?: MatrixConnectedModel
  /** Its own model on this Mac while the saved policy keeps this Mac a destination of a
   * cloud-route agent; absent when it answers only in the cloud. */
  localModel?: MatrixConnectedModel
  /** Its server-path room watch, while one runs. */
  listening?: MatrixListeningState
  /** Absent for the default agent or an unchecked/non-current content binding. */
  content?: MatrixAgentContentView
  /** S1 compatibility route: typed questions enter through the cloud handoff. H-F may also keep
   * this Mac ready as a policy-backed failover destination; `executionPolicy` is that authority. */
  answering?: 'cloud'
  /** The platform's model-choice offer for this cloud agent (`atum.model-choice/1.1`), absent
   * when no offer was reachable. Presentation only: the server refuses an ineligible write. */
  cloudModel?: MatrixCloudModelChoiceView
  /** The owner's default model for each destination this agent answers from
   * (`atum.model-choice/1.3`); absent when the route is off or unreachable. */
  modelDestinations?: MatrixModelDestinationsView
  /**
   * What this Mac is for a cloud-route agent (reliability plan R5), decided by the saved policy
   * and the current lease, never by `answering`: `answering` (this Mac holds the term and replies
   * here) or `standby` (the policy keeps its runtime ready; another destination holds the term).
   * Absent: the Mac serves nothing for it, or it is a plain local agent.
   */
  macRole?: 'answering' | 'standby'
  /**
   * What happened to this Mac's memory when it took a cloud-route agent's term, said in the window.
   * `without_recent`: it answers without the cloud home's latest memory (the platform has no owner
   * route for it yet, or the read did not finish), so the first reply may be from older memory.
   * `local_saved`: the cloud's copy replaced some memory files this Mac had changed, and the earlier
   * versions are saved on this Mac (nothing is merged). Absent when nothing needs saying.
   */
  memoryNote?: 'without_recent' | 'local_saved'
  /** H-F: current owner policy/status from main's strict, account-scoped provider cache. */
  executionPolicy?: MatrixExecutionPolicyView
  /** Where the agent lives and whether it is moving (atum.agent-home/2.1); absent while the platform has no
   * placement for it. Presentation only: the platform decides, this Mac only reads and asks. */
  home?: MatrixAgentHomeView
  /** This Mac stepped back from answering for it three or more times in the last hour because
   * its turns (or its listening) kept ending without an answer (electron/matrix/lease-handover.ts).
   * Presentation only: one quiet line in its reply settings, never in the chat. */
  answeringTrouble?: 'handover'
}

/** S1: this Mac's device service for the signed-in owner (`electron/matrix/device/cloud-agent.ts`). */
export type MatrixDevicePresence =
  | { state: 'signed_out' }
  /** No Secure Enclave helper in this build (not macOS, or not staged). */
  | { state: 'unavailable' }
  | { state: 'not_enrolled' }
  | {
      state: 'enrolled'
      connection: 'closed' | 'hello_sent' | 'challenged' | 'ready' | 'status_exchanged'
      deviceServiceId: string
      enrollmentEpoch: number
    }

/** S1: how moving an agent to the cloud ended (`electron/matrix/device/migration.ts`). */
export type MatrixCloudMoveOutcome =
  | {
      state: 'moved'
      /** The agent's Hermes home snapshot kept on this Mac (null: it had none). */
      snapshot: { archive: string; sha256: string; bytes: number; files: number } | null
      /** The snapshot reached the cloud (false in S1: it stays here as a backup). */
      staged: boolean
    }
  | { state: 'cancelled'; snapshot: { archive: string; sha256: string; bytes: number; files: number } | null }
  | {
      state: 'failed'
      step: 'inventory' | 'quiesce' | 'snapshot' | 'stage' | 'cloud_enrollment' | 'confirm' | 'switch' | 'done'
      code: string
    }

/**
 * S1 cloud-agent requests (renderer → main): this Mac's device service and the agents that answer
 * in the cloud (`status`) and moving one agent to the cloud (`moveToCloud`: main asks the owner in
 * a native dialog first); this Mac enrolls automatically at sign-in. The owner
 * reader (`readerStatus`, `readerEnroll`), the trial offer
 * (`trialOffer`) and accepting the version shown (`trialAccept`), and the account's current
 * access (`cloudAccess`, the same `/cloud/status` read, so the window can say why a cloud
 * assistant cannot answer). Never a URL, key or signature from the renderer.
 */
export type MatrixCloudAgentRequest =
  | { action: 'status' }
  | { action: 'serviceStatus'; principal: string }
  | { action: 'moveToCloud'; principal: string }
  | { action: 'stopTurn'; roomId: string; eventId: string }
  | { action: 'readerStatus' }
  | { action: 'readerEnroll' }
  | { action: 'trialOffer' }
  | { action: 'trialAccept'; offerVersion: number; disclosureVersion: number }
  | { action: 'cloudAccess' }

/** The account's cloud access as `GET /cloud/status` states it, reasons included. */
export interface MatrixCloudAccess {
  effective: 'trial' | 'paid' | 'none'
  reason?: MatrixCloudAccessReason
}

/**
 * The owner reader (an Atum device in the cloud that reads the conversations the person includes
 * while every Mac is off): not set up, being made, its keys being checked with this Mac, ready, or
 * stuck (`electron/matrix/device/cloud-agent.tsownerReaderState`).
 */
export interface MatrixOwnerReaderStatus {
  state: 'none' | 'provisioning' | 'awaiting_trust' | 'ready' | 'needs_attention'
}

/** The account's cloud trial offer (`atum.cloud-first-use/1` §3.1), as main read it. */
export interface MatrixCloudTrialOffer {
  offerVersion: number
  status: 'eligible' | 'declined' | 'preparing' | 'active' | 'expired'
  startableNow: boolean
  blockedReason?: 'cohort_budget_exhausted' | 'capacity_unavailable' | 'verification_required'
  disclosureVersion: number
  durationMs: number
  computeSeconds: number
  concurrentTasks: number
}

/** `cancelled`: the person declined main's confirmation of the terms; nothing was accepted. */
export interface MatrixCloudTrialAccepted {
  status: 'preparing' | 'active' | 'cancelled'
}

export interface MatrixCloudStopOutcome {
  state: 'stopped' | 'stop_requested' | 'completed'
}

export interface MatrixCloudAgentStatus {
  device: MatrixDevicePresence
  /** The principals of the owner's agents that answer in the cloud. */
  cloudAgents: string[]
  /** DA's active registrations, when its read succeeds. This is not online presence. */
  hasEnrolledMac?: boolean
}

/** Read-only wording input for the three-minute no-reply notice. Timing stays in the client. */
export type MatrixAgentServiceStatus =
  | {
      profile: 'atum.agent-service-status/1'
      agentPrincipal: string
      state: 'working'
      asOf: number
      presentSince?: number
    }
  | {
      profile: 'atum.agent-service-status/1'
      agentPrincipal: string
      state: 'server_down'
      asOf: number
      serverDownSince: number
      presentSince?: number
    }
  | {
      profile: 'atum.agent-service-status/1'
      agentPrincipal: string
      state: 'refused'
      asOf: number
      reason: string
      presentSince?: number
    }

/** What an agent is doing in one room right now: its turn's activity, open prompts and
 * prompt notice. */
export interface MatrixAgentTurnView {
  roomId: string
  activity?: NonNullable<MatrixSnapshot['hermesActivity']>
  prompts?: MatrixHermesPrompt[]
  notice?: NonNullable<MatrixSnapshot['hermesPromptNotice']>
}

export type MatrixReadinessStep = 'signed_in' | 'assistant' | 'hermes' | 'ai' | 'authority'

/** Published readiness. Assistant trouble stays on its row/chat; `degraded` pauses its composer. */
export interface MatrixReadiness {
  phase: 'starting' | 'ready' | 'degraded' | 'blocked'
  step?: MatrixReadinessStep
  /** Closed code for plain-language copy, never a raw error. */
  code?: string
  since: number
  /** Existing native retry deadline; presentation only, never execution authority. */
  retryAt?: number
}

/**
 * Whether one agent still holds the cold-start launch (src/matrix/startup-screen.tsx). Every
 * assistant gets the same brief wait while it is starting normally. Once it stops, degrades, or
 * waits on something (a platform's Retry-After), its own row/chat says so and its gate keeps
 * retrying in the background. No assistant problem can hold the app's launch.
 */
export function matrixAgentHoldsLaunch(agent: Pick<MatrixAgentView, 'readiness'>): boolean {
  const readiness = agent.readiness

  return !readiness || (readiness.phase === 'starting' && !readiness.code)
}

/** `handed_off`: the question is in the room for the Mac that answers this agent (this Mac
 * holds a guest copy); the answer arrives from there, as for a message from the phone. */
export type MatrixLocalTurnState =
  'waiting' | 'running' | 'answered' | 'done' | 'interrupted' | 'not_sent' | 'retried' | 'handed_off'

/** `home_quiet`: a handed-off question (to the other Mac, or the cloud after a longer bound) has
 * had its bounded time without an answer seen here;
 * `answered_elsewhere`: asked to answer here, but the other Mac had already taken it. */
export type MatrixLocalTurnNotice =
  'offline' | 'ai_unavailable' | 'out_of_protons' | 'still_waiting' | 'not_synced' | 'home_quiet' | 'answered_elsewhere'

/** Display projection of one local turn. The record itself stays in main's encrypted vault. */
export interface MatrixLocalTurnView {
  turnId: string
  roomId: string
  text: string
  createdAt: number
  state: MatrixLocalTurnState
  synced: { question: boolean; answer: boolean }
  /** The answer, shown until its room event arrives (the chat keeps working without the chat server). */
  answer?: string
  notice?: MatrixLocalTurnNotice
  /** The message this question replies to, for its quote until its room event arrives. */
  replyTo?: string
  /** S1: handed to the agent's cloud brain, not another Mac (its line names the cloud). */
  route?: 'cloud'
  /** `not_sent` only: when this Mac gave up on sending it (epoch ms), so a companion reacts to a
   * fresh failure briefly and never stays pinned by an old one. */
  failedAt?: number
}

/**
 * A local turn that replies to an earlier message in the assistant's room: the message's
 * event and its words, which go to the assistant as context with the new question (the
 * reply contract,  §2.1). Context only: it
 * never starts or re-runs a turn of its own.
 */
export interface MatrixTurnReply {
  eventId: string
  quote: string
}

/** The longest quote a reply passes to the assistant as context. */
export const MATRIX_TURN_QUOTE_MAX = 2000

/**
 * The longest message a chat sends (FR20), as the UTF-8 bytes of its JSON-escaped text. One
 * Matrix event holds at most 64 KiB and encryption grows a message by about a third, so a body
 * within this bound always fits, in any language: about 39,000 characters of English, 27,000
 * of Vietnamese, 13,000 of Chinese or Japanese. (It was 16,000 characters, which refused long
 * Vietnamese or English messages and still let a long Chinese one exceed the event limit.)
 */
export const MATRIX_MESSAGE_MAX_BYTES = 40_000
/** The longest prompt a turn hands Hermes, in characters: a message at that bound and its quote. */
export const MATRIX_PROMPT_MAX = 48_000
/** Earlier builds' message limit, in characters: text they sent stays readable. */
const MATRIX_LEGACY_TEXT_MAX = 16_000

export function matrixMessageTooLong(text: string): boolean {
  return new TextEncoder().encode(JSON.stringify(text)).byteLength > MATRIX_MESSAGE_MAX_BYTES
}

/**
 * The message types that carry one media file an invocation may attach: `m.file`, and `m.image`
 * (what the phone's photo picker sends). `m.video` and `m.audio` are not attachments here.
 */
export function matrixAttachmentMsgtype(msgtype: unknown): msgtype is 'm.file' | 'm.image' {
  return msgtype === 'm.file' || msgtype === 'm.image'
}

/** Text read back from a room: within today's bound, or within what earlier builds sent. */
export function matrixRoomTextTooLong(text: string): boolean {
  return text.length > MATRIX_LEGACY_TEXT_MAX && matrixMessageTooLong(text)
}

/** `findTurn` read-back. Only `absent` permits a re-send; `unknown` never does. */
export type MatrixTurnLookup = { state: 'found'; eventId: string } | { state: 'absent' } | { state: 'unknown' }

export interface MatrixListeningState {
  roomId: string
  expiresAt: number
  queued: number
  /** A transport-discovered event whose outcome is unknown; native retains it
   * while draining rather than silently treating it as a completed turn. */
  interruptedEventId?: string
  /** Omitted for the existing temporary watch. Continuous status also describes
   * the persisted preference while native admission is paused. */
  mode?: 'temporary' | 'continuous'
  state: 'listening' | 'stopped' | 'paused'
  reason?:
    | 'cancelled'
    | 'expired'
    | 'unavailable'
    | 'overflow'
    | 'lease_elsewhere'
    | 'offline'
    | 'renewing'
    | 'storage'
    | 'document'
    | 'room_changed'
    | 'busy'
  result?: MatrixInvocationResult['state']
}

/** Main-issued, ephemeral room opt-in; hints are not execution authority. */
export interface MatrixInvocationWatch {
  id: string
  roomId: string
  /** S1 cloud brain (C0 §3.7): the agent's full joined room set, so one watch covers every room
   * between the owner and the agent. WS-2 makes this authoritative (one SDK watch per room) and
   * keeps `roomId` as the first/primary room for back-compat with the local path. */
  roomIds?: string[]
  /** The watcher answers a message sent inside a thread with a one-line notice (the cloud
   * brain), so such messages are offered too; they never start a turn. */
  threads?: true
  since: number
  until: number
  /** For a cloud room-set watch the device is `*`: any of the owner's devices; the controller
   * checks device trust and the origin of every message it re-reads. */
  sender: MatrixIdentity
  /** Automatic recovery scans from this durable/server-derived boundary. It is
   * intentionally distinct from this device's watch acquisition time. */
  automatic?: { windowStart: number }
}

/**
 * The owner device's signed origin assertion (C0 `atum.cloud-answering/1` §3.2), carried inline in
 * the owner's message content under `io.atum.origin` (Megolm-encrypted, or as sent in a room
 * without encryption). It binds the turn to the
 * Mac's device-service identity key and that Mac's Matrix device fingerprint. Display/transport
 * only here; the controller verifies it (WS-3a). Field names are the frozen wire shape.
 */
export interface MatrixOriginAssertion {
  v: 1
  dsid: string
  kid: string
  ee: number
  ae: number
  boot: string
  n: string
  t: number
  owner: string
  agent: string
  room: string
  dev: string
  fpr: string
  dg: string
  sig: string
}

export interface MatrixInvocationHint {
  watchId: string
  roomId: string
  eventId: string
}

/** An agent host's group watch (src/matrix/group-turns.ts): the owner's new messages after
 * `since` that address this agent, in its groups, become hints (watchId `group`). */
export interface MatrixGroupWatch {
  owner: string
  agentIds?: string[]
  since: number
}

/** A group as the owner's SDK read it from the server (readGroupRoom): who is in it now. */
export interface MatrixGroupRoomRead {
  members: { userId: string; membership: string; membershipEventId?: string }[]
}

/** Bounded encrypted-history scan. `complete: false` means the caller must
 * pause recovery rather than treating the omitted range as empty. */
export interface MatrixInvocationScan {
  hints: MatrixInvocationHint[]
  complete: boolean
  /** At least one otherwise admissible ciphertext could not be decrypted. */
  undecryptable: boolean
}

/**
 * The sender device a message read from a room without end-to-end encryption carries
 * (src/matrix/read-invocation.ts sets it, and nothing else does). Such a message names no device:
 * the homeserver authenticated its sender, which the owner accepted as the identity there (D1,
 * 2026-10-09). One fixed value, so every record of a turn names the same device.
 */
export const MATRIX_PLAIN_SENDER_DEVICE = 'unencrypted'

/** A message type an owner's turn may arrive as: encrypted, or as sent in a room without
 * encryption. Which one a message is reads from `wireType`, never from `senderVerified`. */
export function matrixOwnerWireType(wireType: string | undefined): boolean {
  return wireType === 'm.room.encrypted' || wireType === 'm.room.message'
}

/** Trusted SDK → main only. No media URL, encryption key or local path. */
export interface MatrixInvocationMessage {
  roomId: string
  eventId: string
  /** `m.room.encrypted` when it arrived encrypted; `m.room.message` only from a room without
   * encryption (a plaintext event in an encrypted room is refused, never read). */
  wireType: string
  /** The reader's own decision that the room is plain: no encryption state in its synced view,
   * and its crypto store has never recorded the room as encrypted (src/matrix/plain-room.ts).
   * Set only then, and only with `wireTypem.room.message`; the origin check takes "plain"
   * from here, never from `wireType` alone. */
  roomPlain?: true
  sender: string
  /** The device it came from; `MATRIX_PLAIN_SENDER_DEVICE` for a message from a room without
   * encryption. */
  senderDevice?: string
  /** A verified device sent it, or, in a room without encryption, the homeserver authenticated
   * its sender. Never decides anything that is specific to encryption: that is `wireType`. */
  senderVerified: boolean
  /** C0 §3.2: the owner device's ed25519 fingerprint (Matrix unpadded base64), from
   * `device.getFingerprint`. Set by the SDK projection (WS-2); the controller matches it to the
   * origin assertion's `fpr`. */
  senderFingerprint?: string
  timestamp: number
  related: boolean
  /** C0 §3.2: request digest v2 over the raw decrypted content before any keys are dropped
   * (unpadded base64url sha256 of the canonical content minus `io.atum.origin`). Set by the SDK
   * projection (WS-2); the controller matches it to the origin assertion's `dg`. */
  contentDigest?: string
  /** Sent inside a thread: never a turn (assistant rooms have none), but the cloud assistant says so
   * in one line instead of staying silent. */
  thread?: true
  content: {
    msgtype: string
    body: string
    /** Explicit standard Matrix mentions only; not an app/executor grant. */
    chain?: Pick<GroupChainPublication, 'origin' | 'parent' | 'depth'>
    mentionedUserIds?: string[]
    /** Malformed explicit addressing must not fall back to an ambient turn. */
    invalidMentions?: true
    /** The SDK saw `io.atum.provenance`; protected Google-derived content never enters group routing. */
    googleProtected?: true
    /** The owner deliberately re-sent this content as a forward. */
    forwarded?: true
    /** Owner-selected cloud task-file grant requests. This is a rendezvous marker, never file authority. */
    taskFiles?: MatrixTaskFilesPromise
    /** Authenticated peer-task transport marker. Authority is rechecked at invocation claim. */
    agentTask?: AgentTaskMessage
    /** A present task-file extension that failed its strict schema. */
    invalidTaskFiles?: true
    attachment?: { name: string; fingerprint: string }
    result?: { invocationId: string; transactionId: string; rootEventId: string }
    /** `io.atum.turn`, validated as a UUID: a local-path turn. The server path refuses to
     * execute one sent from this human device (the fence, §4.3). */
    turn?: string
    /** C0 §3.2 (`io.atum.origin`): the owner device's raw signed origin assertion, as read from the
     * decrypted content. The controller verifies it (WS-3a); it grants no authority by itself. */
    origin?: MatrixOriginAssertion
    /** The message a pure rich reply answers (`m.in_reply_to` and no other relation, named
     * inside the ciphertext, as `matrixTurnIntake` admits it). Set only for a message that may
     * start a turn; `related` is still true for it. The Hermes path passes that message's
     * words as context, and does not answer the reply without them. */
    replyTo?: string
  }
  attachmentBytes?: Uint8Array
}

/**
 * The message a reply quotes, read again by the owner's SDK from the reply's own room
 * (`readReplyQuote`). `message`: decrypted, from the owner or the room's agent on a verified
 * device, and its words without a rich-reply fallback. `pending`: not readable yet (not
 * decrypted, not loaded) and worth asking again shortly. `none`: never quoted (another room,
 * another sender, deleted, not a message, an edit or a reaction).
 */
export type MatrixReplyQuoteRead =
  /** `verified`: only on a group read (`anyMember`), whether the sender's device is verified. */
  | { state: 'message'; eventId: string; sender: string; text: string; verified?: boolean }
  | { state: 'pending' }
  | { state: 'none' }

/** Main → existing Hermes file.attach only; never a caller-supplied local path. */
export interface MatrixHermesAttachment {
  name: string
  bytes: Uint8Array
}

/** Display-only prompt data. Native retains the actual Hermes session/request. */
export type MatrixHermesPromptContent =
  | { kind: 'approval'; command: string; description: string; allowOnce: boolean }
  | { kind: 'clarify'; question: string; choices: string[] }
  /** A command needs the Mac's administrator password (Hermes's sudo prompt). */
  | { kind: 'sudo' }
  /** A skill needs a credential it saves in the profile's .env (Hermes's secret capture). */
  | { kind: 'secret'; envVar: string; prompt: string }

export type MatrixHermesPromptNotice = 'clarification_expired' | 'deadline_expired'
export type MatrixHermesPrompt = MatrixHermesPromptContent & { id: string; deadlineAt: number }
export type MatrixHermesPromptAnswer =
  | { kind: 'approval'; choice: 'once' | 'deny' }
  | { kind: 'clarify'; answer: string }
  /** Empty refuses: the command does not run with privileges. */
  | { kind: 'sudo'; password: string }
  /** Empty skips: nothing is saved. */
  | { kind: 'secret'; value: string }
export type MatrixHermesPromptResponse = MatrixHermesPromptAnswer & { id: string }

export interface MatrixInvocationResult {
  state: 'cancelled' | 'expired' | 'unknown' | 'publication_pending' | 'published' | 'setup_required' | 'ignored'
  eventId?: string
}

/** Unverified is display-only restored history, never execution authority. */
export type MatrixRecoveredResult =
  { state: 'unknown' } | { state: 'published' | 'unverified'; eventId: string; body: string }
export interface MatrixResultBinding {
  roomId: string
  eventId: string
  agentUserId: string
  agentDevice: string
  invocationId: string
  transactionId: string
  publishedEvent?: string
}

export interface MatrixHermesModel {
  baseUrl: string
  model: string
  apiKey: string
}

export interface MatrixHermesSetupResult {
  state: 'ready' | 'model_required' | 'helper_required' | 'cancelled'
}

/** Validated domain response, never OAuth credentials or arbitrary server data. */
export interface MatrixDomainIdentity {
  issuer: string
  subject: string
  principal: string
}

export interface MatrixEnrollmentIdentity extends MatrixDomainIdentity, MatrixIdentity {
  executorId: string
  agentPrincipal: string
  expiresAt: number
}

/** Frozen platform authority, not an app name, roster preference or room role. */
export interface MatrixAppBinding {
  appId: string
  installationId: string
  appVersionId: string
  linkEpoch: number
}

export interface MatrixAppEnrollmentIdentity extends MatrixEnrollmentIdentity, MatrixAppBinding {}

export interface MatrixAppEnrollment extends Omit<MatrixEnrollment, 'identity'> {
  identity: MatrixAppEnrollmentIdentity | null
  selection: { appId: string; appVersionId: string } | null
}

export interface MatrixEnrollment {
  state: 'absent' | 'pending' | 'ready' | 'expired' | 'revoking' | 'withdrawn'
  identity: MatrixEnrollmentIdentity | null
}

export type MatrixCommand =
  | MatrixSecurityCommand
  | {
      kind: 'agentConversation'
      identity: MatrixIdentity
      agentId: string
      action: 'preview' | 'keep' | 'makeMain' | 'replaceMain' | 'retry'
      roomId?: string
    }
  | { kind: 'deviceIsolation'; identity: MatrixIdentity; value: MatrixDeviceIsolation }
  | {
      kind: 'peerIdentity'
      identity: MatrixIdentity
      roomId: string
      userId: string
      action: 'read' | 'review' | 'continue'
    }
  | { kind: 'starterSeen'; identity: MatrixIdentity; scope: string }
  /** Human-readable Matrix status_msg with a client-side expiry; display/attention only. */
  | { kind: 'setStatus'; status: MatrixStatusInput | null }
  | ({ kind: 'displayPreference'; identity: MatrixIdentity } & MatrixDisplayPreferenceChange)
  | ({ kind: 'notificationPolicy'; identity: MatrixIdentity } & MatrixNotificationPolicyChange)
  /** The owner's check-in settings: on or off, the morning brief's time, the first-run line seen. */
  | { kind: 'checkInsChange'; identity: MatrixIdentity; change: MatrixCheckInChange }
  /** The owner's answer to a check-in: less like this, snooze, or "keep these coming". */
  | { kind: 'checkInsFeedback'; identity: MatrixIdentity; feedback: MatrixCheckInFeedbackChange }
  | { kind: 'selectApp'; appId: string }
  | { kind: 'discoverApps' }
  | { kind: 'appShortcut'; appId: string; visibility: AppShortcutVisibility }
  | { kind: 'select'; roomId: string }
  /** Lazily discover or create notes, company-scoped in Team Space and legacy-unscoped elsewhere. */
  | { kind: 'notesSelfOpen'; companyId?: string }
  /** One fixed, bounded page of older events for the open transcript. */
  | { kind: 'paginateTimeline'; roomId: string }
  | { kind: 'favourite'; roomId: string; favourite: boolean }
  /** Standard m.lowpriority tag. Setting it removes m.favourite (a chat is one or the other). */
  | { kind: 'lowPriority'; roomId: string; lowPriority: boolean }
  /** `model` is a shelf alias only for a cloud agent; main refuses one anywhere else. */
  | { kind: 'setModel'; roomId: string; model?: MatrixModelId | MatrixShelfModelId; effort?: MatrixEffort }
  | { kind: 'openWebPreview' | 'dismissWebPreview'; roomId: string; id: string }
  /** `appPair`: main's pair with an app that has no bot (`createAppConversation`), made with
   * end-to-end encryption as before 0.20; the renderer's parser never sets it. */
  | { kind: 'create'; name: string; invite: string[]; direct?: boolean; appPair?: true }
  | { kind: 'join'; roomId: string; /** Background admission does not steal navigation. */ select?: false }
  | { kind: 'leave'; roomId: string }
  | { kind: 'invite' | 'removeMember' | 'ban' | 'unban'; roomId: string; userId: string }
  | { kind: 'ignore'; userId: string; ignored: boolean }
  /** `replyTo`: a standard rich reply (`m.in_reply_to`) to that event of the same room.
   * `mentions`: who the message addresses (standard `m.mentions.user_ids`); `roomMention`
   * requests the standard `m.mentions.room` notification after the SDK rechecks room power. In a group, the
   * owner's own assistant answers only a message that names it or replies to it. */
  | {
      kind: 'send'
      roomId: string
      body: string
      replyTo?: string
      /** Keeps the message in this standard `m.thread`; `replyTo` remains a flat quote target. */
      threadRootId?: string
      mentions?: string[]
      roomMention?: boolean
    }
  /** Re-send the source event's visible content into one target room, with no source relation. */
  | { kind: 'forward'; roomId: string; eventId: string; toRoomId: string; dialogNonce: string }
  /** Your own text message, changed for everyone (a standard `m.replace` edit). */
  | { kind: 'edit'; roomId: string; eventId: string; body: string; savedStatus?: 'saved_to_drive' | 'saved_as_copy'; transactionId?: string }
  /** Your own message, deleted for everyone (a standard redaction). */
  | { kind: 'redact'; roomId: string; eventId: string }
  /** Add or remove one server message from the room's standard shared pinned-events state. */
  | { kind: 'pinMessage'; roomId: string; eventId: string; pinned: boolean }
  /** Your reaction to a message (`m.annotation`), added or taken back: one per person per key. */
  | { kind: 'react'; roomId: string; eventId: string; key: string; reacted: boolean }
  /** Save or remove one Team Space message in the owner's private account data. */
  | { kind: 'savedMessage'; roomId: string; eventId: string; saved: boolean }
  /** Resolve the bounded Saved view against fresh account data and current event access. */
  | { kind: 'savedMessagesRead' }
  /** Revalidate and select one still-saved, still-accessible message. */
  | { kind: 'savedMessageOpen'; roomId: string; eventId: string }
  /** Save or clear one private Team space room/thread composer draft. */
  | { kind: 'draft'; identity: MatrixIdentity; roomId: string; threadRootId?: string; text: string }
  /** Delete chat: leave it (when still in it) and forget it, so it leaves the list on every
   * one of your devices. Others in it keep their copy. An official bot's chat is never left:
   * it is kept out of sight instead, and answers `AppBotDmHidden` (shared/matrix-app-bot-dm.ts). */
  | { kind: 'forget'; roomId: string }
  /** You are typing in a chat (a standard typing notification), or stopped. */
  | { kind: 'typing'; roomId: string; typing: boolean }
  /** Mark a chat unread (standard `m.marked_unread`), or read again. */
  | { kind: 'markUnread'; roomId: string; unread: boolean }
  | { kind: 'threadFollow'; roomId: string; rootId: string; followed: boolean }
  | { kind: 'threadRead'; roomId: string; rootId: string }
  | {
      kind: 'attach'
      roomId: string
      name: string
      contentType?: string
      bytes: Uint8Array
      matrixTransactionId?: string
      threadRootId?: string
      replyTo?: string
    }
  | { kind: 'download'; roomId: string; eventId: string; companyFile?: true }
  /** One bounded read of what a chat has shared (shared/matrix-room-shared.ts): a few `/messages`
   * pages, filtered by the server where the room has no encryption, decrypted on this device where
   * it has. `from` continues where the previous read stopped. Answers `MatrixRoomSharedPage`. */
  | { kind: 'roomShared'; roomId: string; section: MatrixRoomSharedSection; limit: number; from?: string }
  /** A shared photo's or video's picture for the info panel, as a data URL (or null): its
   * thumbnail, else the photo itself within `MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES`. */
  | { kind: 'roomSharedThumbnail'; roomId: string; eventId: string }
  /** One of your own messages that didn't send (its local id): send it again, or drop it. */
  | { kind: 'resend' | 'discard'; roomId: string; eventId: string }
  /** The SDK's own room muting (a room-specific push rule): no banners, no unread count. */
  | { kind: 'mute'; roomId: string; muted: boolean }
  /** Your own name for a chat, private to you (room account data); empty clears it. */
  | { kind: 'chatTitle'; roomId: string; title: string }
  /** A personal group's shared name (standard `m.room.name`), for everyone in it; never empty. */
  | { kind: 'groupName'; roomId: string; name: string }
  /** A personal group's shared topic (standard `m.room.topic`); empty clears it. */
  | { kind: 'groupTopic'; roomId: string; topic: string }
  /** Personal background choice (`io.atum.chat.look` room account data). */
  | { kind: 'chatLook'; roomId: string; look: LookRoomAccountData }
  | {
      kind: 'groupPolicy'
      roomId: string
      identity: Pick<MatrixIdentity, 'userId' | 'deviceId'>
      change?: GroupPolicyChange
    }
  /** The conversation on screen in a focused window, or none. The SDK acknowledges its newest
   * event with a private receipt while it stays there (read-receipts.ts). */
  | { kind: 'attend'; roomId: string | null }
  /** Reports one already-synced event. The SDK supplies the fixed score; `reason` is the
   * person's own optional words, never message content. */
  | { kind: 'reportEvent'; roomId: string; eventId: string; userId: string; reason?: string }
  /** Reports a person seen in `roomId` (Matrix user report). Where the homeserver lacks it, the
   * SDK reports that person's latest message in the room instead. */
  | { kind: 'reportUser'; roomId: string; userId: string; reason?: string }
  | { kind: 'devices'; userId: string }

/** What a result carries to the SDK window, whether it is sent (`publishResult`) or only prepared (`prepareResult`). */
// A type alias, not an interface: the command it replaces was an object literal type, which callers read as a record.
type MatrixPublishResultBase = {
  /** Validated cosmetic reply data, retained with the native outcome for retries. */
  pet?: MatrixPetIntentEnvelope
  roomId: string
  body: string
  invocationId: string
  transactionId: string
  /** Local-path answers carry the turn marker. */
  turnId?: string
  /** The Matrix transaction ID when it differs from the result's (`atum-a-<turnId>`). */
  matrixTransactionId?: string
  /** One part of an answer too long for one message (`io.atum.part`, matrix-answer-parts.ts):
   * `body` is that part's words. Absent for an answer posted as one message. */
  part?: { index: number; count: number }
  /** Main marks what an agent latched to Google posts (`io.atum.provenance`, G2-19). */
  google?: true
  /** An answer in a group: the agent shares this room's keys with every member's device
   * (publish-result.ts), never in its private room. */
  chain?: GroupChainPublication
  /** The last part of a meeting answer too long for one message: the whole answer, which the
   * hand-on's typed mentions (`chain`) are read from, as they would be from one message.
   * Never posted. */
  mentionsFrom?: string
  group?: true
  /** An app's answer (an app without a bot, `invokeMatrixApp`): main has just re-read the
   * room with `readAppRoom`, so a plain app pair or app group of this app is admitted. */
  app?: true
  /** An owned-agent task result; publish-result revalidates the typed task room. */
  task?: true
  /** Task lifecycle is independent of generic answer/status decoration. */
  taskOutcome?: 'completed' | 'failed' | 'stopped'
  /** C0 §3.5: an optional status code published under `io.atum.result` (atum.agent-home/1
   * status outbox), e.g. `couldnt_confirm`, `saved_to_drive`. WS-2 sets it. */
  status?: string
  /** Synthetic turn event used by Stop on a resumed or scheduled request. */
  stopEvent?: string
  /**
   * `invocationId` is a completed invocation of the platform's ledger. Only such a result can go through the
   * platform's outbox for an agent whose home the placement model governs (atum.agent-home/2.1): the worker
   * records the published event on that invocation. Set by the flows that hold a ledger grant; absent otherwise.
   */
  ledger?: true
}

export type MatrixPublishResultFields = MatrixPublishResultBase &
  (
    | { eventId: string; sweep?: false }
    | {
        eventId?: undefined
        /** A follow-up sweep's standalone offer: no reply target, posted under `sys_followup_sweep_v1`. */
        sweep: true
      }
  )

/** Trusted main → SDK only. The UI parser deliberately rejects these commands. */
export type MatrixSdkCommand =
  | MatrixAwarenessControlCommand
  | MatrixCommand
  | MatrixCompanyAISdkCommand
  | MatrixCompanyChannelRoomCommand
  | MatrixCompanyPrivateCosRoomCommand
  | MatrixCompanyMessageSearchSdkCommand
  | MatrixCompanyFileSdkCommand
  | MatrixCompanyRoomCommand
  | MatrixPeopleSearchSdkCommand
  | MatrixProfileSdkCommand
  | MatrixNativeSecurityCommand
  | { kind: 'publishGoogleFence'; identity: MatrixIdentity }
  /** Main-only notification quarantine learned from authenticated private-CoS platform views. */
  | { kind: 'companyPrivateCosNotificationRooms'; roomIds: string[] }
  /** Native lifecycle only: renderer commands cannot select another availability state. */
  | { kind: 'setOwnPresence'; presence: 'online' | 'away' | 'offline' }
  | { kind: 'appCatalog'; appIds: string[] }
  | { kind: 'verify'; userId: string; deviceId: string; fingerprint: string }
  /** One member of the open chat's profile photo, as authenticated bytes. Main re-checks the
   * member against the shown room before asking its SDK. */
  | { kind: 'memberAvatar'; roomId: string; userId: string }
  /** One message's link preview in a joined plain room (shared/matrix-link-preview.ts). Main
   * forwards only a room the window shows as plain; the SDK reads the link from the event. */
  | { kind: 'linkPreview'; roomId: string; eventId: string }
  /** Company identity media stays in the user's Matrix SDK: upload bytes, or read one joined channel's avatar. */
  | { kind: 'companyAvatarUpload'; photo: MatrixCompanyAvatarPhoto }
  | { kind: 'companyAvatarRead'; roomId: string }
  | { kind: 'watchInvocations'; watch: MatrixInvocationWatch | null }
  | { kind: 'scanInvocations'; watch: MatrixInvocationWatch }
  | { kind: 'watchAgentTasks'; watch: AgentTaskWatch | null }
  | { kind: 'scanAgentTasks'; watch: AgentTaskWatch }
  | {
      kind: 'reconcileAgentTasks'
      ownerId: string
      agentPrincipal: string
      agentUserId: string
      ownedAgents?: readonly AgentTaskOwnedAgent[]
    }
  | {
      kind: 'reconcileAgentTaskCoordinators'
      ownerId: string
      currentMainPrincipal: string
      currentMainUser: string
      ownedAgents?: readonly AgentTaskOwnedAgent[]
    }
  | {
      kind: 'listAgentTasks'
      ownerId: string
      agentPrincipal: string
      agentUserId: string
      ownedAgents?: readonly AgentTaskOwnedAgent[]
      /** Exact lookup avoids making old tasks unreadable as the room count grows. */
      taskId?: string
      /** Bounded native projection; model-facing lists currently request at most 100. */
      limit?: number
    }
  | {
      kind: 'readAgentTaskRoom'
      roomId: string
      ownerId: string
      agentPrincipal: string
      agentUserId: string
      ownedAgents?: readonly AgentTaskOwnedAgent[]
    }
  | { kind: 'createAgentTask'; binding: AgentTaskBinding; prompt: string }
  | {
      kind: 'sendAgentTask'
      roomId: string
      taskId: string
      action: 'accepted' | 'running' | 'completed' | 'failed' | 'stopped' | 'stop' | 'steer'
      body: string
      transactionId: string
    }
  /**
   * An agent's or an app's SDK takes its owner's invitation (src/matrix/sdk.ts): `scope` says
   * what the room was admitted as (the agent's own chat, a group, an app's room), `ownerId` whose
   * invitation a plain group or app room must be.
   */
  | { kind: 'joinAgentRoom'; roomId: string; ownerId: string; scope: 'assistant' | 'group' | 'app' }
  /** Controller-only lifecycle bootstrap: the agent creates or reuses its typed
   * private room and grants its owner room administration. */
  | { kind: 'ensureAssistantConversation'; ownerId: string }
  /** An agent host's watch over its groups (src/matrix/group-turns.ts); null stops it. */
  | { kind: 'watchGroupTurns'; watch: MatrixGroupWatch | null }
  /** The owner's SDK reads a group an assistant answers in (readGroupRoom). */
  | { kind: 'readGroupRoom'; roomId: string; ownerId: string; agentId: string; allowInvite?: boolean }
  | ({ kind: 'readGroupRecent' } & GroupRecentTarget)
  | GroupRuntimeCommand
  /** A group made with some of the owner's own assistants in it (`agents`, at most five). */
  | { kind: 'createGroup'; name: string; invite: string[]; agents: string[] }
  /** The owner adds one of their own assistants (`agentIds`: all of them) to a group. */
  | { kind: 'inviteAgent'; roomId: string; userId: string; agentIds: string[] }
  | {
      kind: 'readAssistantRoom'
      roomId: string
      ownerId: string
      agentId: string
      allowInvite?: boolean
      forTurn?: boolean
    }
  | { kind: 'readConversationMarker'; roomId: string; ownerId: string; agentId: string; allowInvite?: boolean }
  | { kind: 'preflightConversationRoom'; roomId: string; ownerId: string; agentId: string }
  | { kind: 'readConversationCandidates'; ownerId: string; agentId: string; knownMain?: string; knownRooms?: string[] }
  | {
      kind: 'writeConversationMarker'
      roomId: string
      ownerId: string
      agentId: string
      content: ConversationWrite['content']
    }
  | {
      kind: 'conversationAppVersions'
      ownerId: string
      devices: string[]
      own?: { deviceServiceId: string; version: string; at: number }
    }
  | { kind: 'findAssistantRoom'; ownerId: string; agentId: string }
  /** A retired agent's chat with the owner: leave and forget it once the server's full room
   * state shows no one else was ever in it (assistant-room.ts readRetiredAgentRoom). Answers
   * `forgotten`, or `kept` for a room that is not only theirs. */
  | { kind: 'forgetAgentRoom'; roomId: string; ownerId: string; agentId: string }
  | { kind: 'readAppRoom'; roomId: string; ownerId: string; agentId: string; allowInvite?: boolean }
  | { kind: 'sendAppMessage'; roomId: string; body: string; userId: string }
  /** Native-owned official DM resolver (src/matrix/app-bot-dm.ts). It reuses the room the
   * stored pointer names, else another room with the bot that still works, and makes a new
   * plain direct room (marker in its initial state, then the pointer) only when none can be
   * used. Answers `AppBotDmOpened` (shared/matrix-app-bot-dm.ts). This device decides alone: the
   * four commands below are its steps when the platform decides which room is the bot's chat
   * (`POST /api/matrix/v1/apps/{slug}/bot/start`, spec/canonical-room/v1.1). */
  | { kind: 'openAppBotDm'; appId: string; botUserId: string }
  /** The plain chat this device already has with the bot, to offer the platform (it records the
   * room as the bot's chat if none is recorded). Looks only; makes, selects and writes nothing.
   * Answers `AppBotDmFound`. */
  | { kind: 'findAppBotDm'; appId: string; botUserId: string }
  /** A new plain one-to-one `is_direct` chat with the bot, invited and marked, that this device
   * has not selected and has no pointer to yet: the platform decides whether it is the bot's
   * chat. Answers `AppBotDmMade`. */
  | { kind: 'makeAppBotDm'; appId: string; botUserId: string }
  /** Open the room the platform named as the bot's chat: checked on the server (plain, only the
   * person and the bot in it), marked if it has no marker yet, pointed at, shown again if deleted,
   * and selected unless the person chose another room since `selection`. Refuses an encrypted
   * room (`matrix_app_bot_dm_encrypted`) or one that is not the bot's one-to-one chat
   * (`matrix_app_bot_dm_invalid`). Answers `AppBotDmOpened`. */
  | { kind: 'openAppBotRoom'; appId: string; botUserId: string; roomId: string; selection?: number }
  /** Leave a room that lost the race, only while nobody has written in it. Answers `AppBotDmLeft`. */
  | { kind: 'leaveAppBotDm'; appId: string; botUserId: string; roomId: string }
  /** A person's addressed message to an official app bot.  The optional quote
   * is accepted only when it is the standard visible reply target. */
  | { kind: 'sendAppBotMessage'; roomId: string; body: string; userId: string; replyTo?: string; quote?: string }
  /** Headless bot commands.  These are available only to an SDK configured with mode app-bot. */
  | { kind: 'appBotWatch'; watch: boolean }
  | { kind: 'appBotRooms' }
  | { kind: 'appBotReadEvent'; roomId: string; eventId: string }
  | { kind: 'appBotReadMedia'; roomId: string; eventId: string }
  | { kind: 'appBotScan'; roomId: string; since: number; pageCap: number }
  | { kind: 'appBotMembers'; roomId: string }
  | { kind: 'appBotInviteState'; roomId: string }
  | { kind: 'appBotJoin'; roomId: string }
  | { kind: 'appBotReject'; roomId: string; reason: string }
  | { kind: 'appBotLeave'; roomId: string; reason: string }
  | {
      kind: 'appBotSend'
      roomId: string
      body: string
      appId: string
      replyTo?: string
      mentions?: string[]
      transactionId: string
      turnId: string | null
      part?: number
      parts?: number
      notice?: boolean
      code?: string
      action?: { kind: 'open_setup' | 'open_app_route' | 'open_bot_dm' | 'connect_account'; app: string; route_id?: string } | { kind: 'retry_later' | 'wait' | 'acknowledge_unknown' } | null
    }
  | {
      kind: 'appBotApiSend'
      roomId: string
      /** The person bound when this room was admitted as private. */
      directPerson: string
      body: string
      transactionId: string
      replyTo?: string
      formattedBody?: string
      metadata: Record<string, unknown>
      photo?: { bytes_base64: string; mime_type: BotApiPhotoMimeType; width: number; height: number }
    }
  | { kind: 'appBotTyping'; roomId: string; typing: boolean }
  | { kind: 'appBotProfile'; displayName: string; avatar?: Uint8Array; mimeType?: 'image/png' }
  | { kind: 'appBotRoomState'; roomId: string; type: string; content?: Record<string, unknown> }
  | { kind: 'appBotDeviceKeys' }
  | {
      kind: 'appBotRecent'
      roomId: string
      untilTs: number
      pageCap: number
      botDevices: Array<{ deviceId: string; ed25519: string; curve25519: string }>
    }
  | { kind: 'appBotDirectRoomWith'; userId: string }
  /** Retire a previously pinned bot device before rotating outbound room keys. */
  | { kind: 'retireDevice'; userId: string; deviceId: string }
  | { kind: 'isOfficialAppBotDm'; appId: string; userId: string; roomId: string }
  | {
      kind: 'appBotDisplayEvidence'
      appId: string
      /** The app's catalog slug and whether its bot is guest-enabled: the bot this evidence is for. */
      app: string
      guest: boolean
      userId: string
      roomId: string
      eventId: string
      devices: Array<{ deviceId: string; ed25519: string; curve25519: string; retiredAt: number | null }>
    }
  | { kind: 'retireLegacyAppBotRoom'; appId: string; userId: string; roomId: string; movedAt: number }
  /** Start a new outbound Megolm session for an encrypted bot room. */
  | { kind: 'rotateOutboundKeys'; roomId: string }
  | { kind: 'sendTaskFiles'; roomId: string; body: string; userId: string; taskFiles: MatrixTaskFilesPromise }
  | {
      kind: 'createAssistant'
      name: string
      invite: string[]
      direct: true
      replaceMain?: true
      /** A cloud bootstrap may be creating the same pair from the agent side. Give its signed
       * invitation a bounded chance to arrive, then adopt it instead of creating a second room. */
      adoptAgentInvite?: true
    }
  | { kind: 'createAppGroup'; name: string; app: string }
  /** `agentIds`: every one of the owner's assistants, none of whom is invited this way. */
  | { kind: 'inviteHuman'; roomId: string; userId: string; agentId?: string; agentIds?: string[] }
  | { kind: 'readInvocation'; roomId: string; eventId: string; includeAttachment?: boolean }
  /** `anyMember`: a group turn's quote may be anyone's message there (marked as theirs). */
  | { kind: 'readReplyQuote'; roomId: string; eventId: string; ownerId: string; agentId: string; anyMember?: true }
  | ({ kind: 'readContinuity' } & MatrixContinuityTarget)
  | ({ kind: 'readResult' } & MatrixResultBinding)
  | ({ kind: 'publishResult' } & MatrixPublishResultFields)
  /**
   * The same event as `publishResult`, prepared as the final Matrix bytes (`m.room.encrypted` for an encrypted room)
   * and NOT sent. For an agent whose home the placement model governs: the platform's worker sends what this Mac signs
   * (atum.agent-home/2.1 `matrix.publication.enqueue`), and this window never does. Answers `{ eventType, content }`.
   */
  | ({ kind: 'prepareResult' } & MatrixPublishResultFields)
  /** A local-path question: the fixed transaction ID is reused on every attempt. */
  /** `handoff`: the question is for the Mac that answers this agent, so it carries the handoff
   * marker (`io.atum.handoff`), never the local-turn marker that every answering Mac skips.
   * `replyTo`: the question is a standard rich reply to that event (never with `handoff`). */
  | {
      kind: 'sendTurn'
      roomId: string
      body: string
      turnId: string
      transactionId: string
      handoff?: true
      replyTo?: string
      /** S1: the question goes to the agent's cloud brain (always with `handoff`, so no Mac answers
       * it): unlike a question for another Mac it keeps its reply, whose quote the cloud reads. */
      cloud?: true
      /** C0 §3.2: the owner device's signed origin assertion (`io.atum.origin`), for cloud agents. */
      origin?: MatrixOriginAssertion
    }
  /** Read-back on the sending device: found / absent / unknown, bounded (plan §4.4). With
   * marker `cron`, `turnId` is a scheduled run's ID (`io.atum.cron`). */
  /** `part`: one part of a split answer (`io.atum.part` index), never any other message of the turn. */
  | {
      kind: 'findTurn'
      roomId: string
      turnId: string
      sender: string
      since: number
      marker?: 'cron' | 'handoff'
      part?: number
    }
  /** A scheduled job's result, posted by the agent once per run (readiness plan §4.5). A
   * check-in's post carries its nudge for the card (`io.atum.nudge`); a latched agent's
   * post carries the Google provenance mark (`google`, spec/awareness/v1 §3.7). */
  | {
      kind: 'prepareCron'
      roomId: string
      body: string
      runId: string
      jobId: string
      google?: true
    }
  | {
      kind: 'publishCron'
      roomId: string
      body: string
      runId: string
      jobId: string
      nudge?: MatrixCheckInNudge
      google?: true
      /** A routine whose owner disabled alerts is still posted, as a non-notifying notice. */
      notify?: false
    }
  /** The agent's status line about one of the owner's messages (`eventId`): an `m.notice`
   * (never a turn, never an answer) as a rich reply to it, under a transaction fixed per
   * message. Main posts it into the agent's own room with its owner, with fixed copy. */
  | {
      kind: 'publishNotice'
      roomId: string
      eventId: string
      body: string
      group?: true
      statusLine?: true
      transactionId?: string
      replaces?: string
      revision?: number
      /** The agent-turns/1.3 progress line (`io.atum.progress`), private chat only. */
      progress?: MatrixProgressMarker
      /** The agent-turns/1.4 interim remark (`io.atum.interim`), private chat only. */
      interim?: true
      /** The agent-turns/1.4 removal of its own ended progress line (`replaces`), private chat only. */
      redact?: true
    }
  /**
   * The agent's public, unthreaded `m.read` in its own chat with its owner (agent-turns v1.1
   * "Presentation signals"): sent by main only for an owner message that passed the trust,
   * fence and lease checks (`eventId`), or once one has its answer. Receipts are cumulative,
   * so the agent's SDK holds it at the last event before any earlier owner message that has
   * neither an answer or status line from the agent nor a place in `admitted` (the messages
   * this Mac took up and is still answering): a message the agent declined never looks seen.
   */
  | { kind: 'agentSeen'; roomId: string; eventId: string; ownerId: string; admitted: string[] }
  /** The agent's `m.typing` in a joined room containing its owner while the Mac holding its
   * lease is working on a turn (30 s timeout, renewed by main). Presentation only: never
   * turn state (v1 rule 10). */
  | { kind: 'agentTyping'; roomId: string; ownerId: string; typing: boolean }
  /** Native-admitted shared-answer disclosure; old callers keep the join default (publish-result.ts). */
  | { kind: 'publishGroupNotice'; roomId: string; body: string; transactionId?: string }
  /** Compatibility answer for the first-run account marker, and with it how the welcome ends. */
  | {
      kind: 'firstRunAnswered'
      identity: MatrixIdentity
      answer: 'allowed' | 'declined'
      welcome: 'done' | 'dismissed'
    }
  /** The first evaluation of an account's welcome (main's, once): `open` for a new account, `done`
   * for one that already has a folder answer or dialogue with its primary. Never replaces a record. */
  | { kind: 'firstRunWelcome'; identity: MatrixIdentity; state: 'open' | 'done' }
  /** Check-ins' three records fresh from the server (main's gate, holding the lease). */
  | { kind: 'checkInsRead' }
  /** Check-ins' ledger, written by main only while this Mac holds the answering lease. */
  | { kind: 'checkInsLedger'; ledger: MatrixCheckInLedger }
  /** The Founder chat: who the founder is and whether to make the chat (shared/matrix-founder.ts). */
  | MatrixFounderSdkCommand
  /** A paid assistant's Store-run ledger fresh from the server (main, holding its lease). */
  | { kind: 'storeRunsRead'; assistantId: string }
  /** Its claim of a scheduled run's occurrence, written by main only while holding the lease. */
  | { kind: 'storeRunsWrite'; assistantId: string; ledger: MatrixStoreRunLedger }

/**
 * The ways into an account the sign-in window offers: Google (straight to Google's account
 * picker), email (the sign-in server's own password page) or a new account by email (its
 * registration page). Never a credential: every way runs in the browser.
 */
export type MatrixSignInMethod = 'google' | 'email' | 'create'

/** Whether the sign-in server takes email sign-in (electron/matrix/sign-in-entry.ts). */
export type MatrixEmailSignIn = 'available' | 'unavailable' | 'unknown'

/**
 * Settings › Connections › Subscriptions and the model picker (2026-10-27). Main owns the
 * account store, the plan sign-in and every model list; the window sees booleans, safe model
 * names and one opaque sign-in handle. A key is write-only and cleared from the field at once.
 */
export interface MatrixSubscriptionsBridge {
  /** One read per Atum account, shared by every assistant on this Mac. */
  status(): Promise<MatrixSubscriptionsStatus>
  /** The room agent's Mac-hosted subscription catalog (account connections, safe names). */
  catalog(roomId: string): Promise<MatrixSubscriptionCatalog>
  startChatGpt(): Promise<MatrixSubscriptionStart>
  pollChatGpt(session: string): Promise<MatrixSubscriptionPoll>
  cancelChatGpt(session: string): Promise<void>
  disconnectChatGpt(): Promise<void>
  useThisMacForChatGpt(enabled: boolean): Promise<MatrixSubscriptionRelayResult>
  /** The account-wide OpenCode Go connection: the key is sent once and never read back. */
  connectOpenCode(value: string): Promise<MatrixSubscriptionKeyResult>
  disconnectOpenCode(): Promise<void>
}

export interface MatrixUiBridge {
  /** Closed renderer failure diagnostics written by main to main.log; never message text or ids. */
  windowFailureDiagnostic?(value: MatrixWindowFailureDiagnostic): void
  awareness?: MatrixAwarenessBridge
  /** The owner's own coarse location and its one switch (0333). */
  ownerLocation?: MatrixOwnerLocationBridge
  drive?: MatrixDriveBridge
  companies?: MatrixCompanyBridge
  /**
   * Release B Company Desktop adapter (`src/matrix/company-desktop-adapter.ts`),
   * built by the preload over the closed `company-desktop` main-process request.
   * The renderer validates every method before adopting it.
   */
  companyDesktop?: unknown
  googleConnections?: MatrixGoogleConnectionBridge
  aliases?: MatrixAliasBridge
  /** Native Synapse people directory plus the one exact-email MAS seam. */
  people?: MatrixPeopleSearchBridge
  /** Contact us: opens the Founder chat, or (the person's own request) starts it. */
  founder?: MatrixFounderBridge
  terminals?: MatrixTerminalBridge
  wallet?: MatrixWalletBridge
  checkout?: MatrixCheckoutBridge
  companyStore?: MatrixCompanyStoreBridge
  store?: MatrixStoreBridge
  voice?: MatrixVoiceBridge
  profiles?: MatrixProfilesBridge
  /** Link previews under messages in plain chats (shared/matrix-link-preview.ts). */
  linkPreviews?: MatrixLinkPreviewBridge
  /** The assistant card: an assistant's name and persona (matrix-assistant-card.ts). */
  assistants?: MatrixAssistantCardsBridge
  /** The assistant card's scheduled tasks (agent-routines.ts); every agent has them. */
  routines?: MatrixRoutinesBridge
  /** The platform-owned per-agent background follow-up setting. */
  backgroundSweep?: MatrixBackgroundSweepBridge
  nativeApps?: MatrixNativeAppsBridge
  /** Passive permissions of this running app on this device; no agent authority. */
  permissions?: MatrixPermissionsBridge
  /** Per-account live source switches; every read remains main/tool-handler enforced. */
  macSources?: MatrixMacSourcesBridge
  /** Current-assistant descriptor projection; main owns both account and assistant selection. */
  agentSources?: MatrixAgentSourcesBridge
  /** Which Mac folders the owner shares; main alone asks macOS and enforces the choice. */
  folderAccess?: MatrixFolderAccessBridge
  /** Copy to the system clipboard; the window's own web clipboard is not permitted. */
  clipboard?: MatrixClipboardBridge
  /** Native `atum://message` deliveries, already decoded to identifier-only targets. */
  messageLinks?: MatrixMessageLinkBridge
  /** Process-local `atum://join` bearer handoff. Tokens are never persisted by this bridge. */
  inviteLinks?: MatrixInviteLinkBridge
  pets?: MatrixPetBridge
  petDisplay?: MatrixPetDisplayBridge
  /** Native-owned bundled management pages; no REST authority in chat. */
  pages?: MatrixPagesBridge
  /** The two account subscriptions, for Settings › Connections and the picker. */
  subscriptions?: MatrixSubscriptionsBridge
  apps?: {
    onReturn(listener: () => void): () => void
    refresh(): Promise<void>
    menu(appId: string): Promise<MatrixAppMenu>
    history(appId: string, cursor?: string | null): Promise<MatrixAppHistoryPage>
    /** `autoConfirm` (begin only): the setup card's flow confirms on the gated browser return. */
    connection(
      appId: string,
      action: 'read' | 'begin' | 'confirm' | 'cancel' | 'disconnect',
      options?: { autoConfirm?: true }
    ): Promise<void>
    chat(appId: string, locale?: string): Promise<string | null>
    group(appId: string, name: string, locale?: string): Promise<string | null>
    /** Native pins the published bot device before this ordinary Matrix invite. */
    botInvite(appId: string, roomId: string): Promise<void>
    withdraw(appId: string): Promise<void>
    botStatus(appId: string): Promise<unknown>
    botConsent(appId: string, disclosureVersion: number, locale: string): Promise<unknown>
    botRevoke(appId: string): Promise<unknown>
    botOutcome(appId: string, roomId: string, eventId: string): Promise<unknown>
    /** A bot-api photo's authenticated bytes, as a data URL the window may display. */
    botApiMedia(input: { appId: string; roomId: string; eventId: string }): Promise<MatrixBotApiPhoto | null>
    /** The existing declaration-driven intake form, scoped to this official bot. */
    botIntakeStatus(appId: string): Promise<unknown>
    botIntakeSubmit(appId: string, values: Record<string, string>): Promise<unknown>
    send(
      appId: string,
      roomId: string,
      body: string,
      locale?: string,
      replyTo?: string,
      quote?: string
    ): Promise<{ eventId: string; result: MatrixInvocationResult }>
    invoke(appId: string, roomId: string, eventId: string): Promise<MatrixInvocationResult>
    view: AppViewBridge
  }
  /** Available only in the Matrix UI; SDK and app hosts receive no browser bridge. */
  consumerBrowser?: MatrixConsumerBrowserBridge
  windowFacts(): Promise<MatrixWindowFacts>
  subscribeWindow(listener: (facts: MatrixWindowFacts) => void): () => void
  setWindowMode(mode: MatrixWindowMode): Promise<void>
  /** Pins the native appearance (and so the glass under the shell) to the shell's light/dark choice. */
  setWindowAppearance?(appearance: MatrixWindowAppearance): Promise<void>
  /** A fixed main-owned close request; it grants no new file or window authority. */
  onDocumentClose?(prepare: () => Promise<void>): () => void
  snapshot(): Promise<MatrixSnapshot>
  /** Google by default; the browser opens at the chosen way in (sign-in.tsx). */
  signIn(method?: MatrixSignInMethod): Promise<void>
  repairOwnerDevice(method?: MatrixSignInMethod): Promise<{ state: 'repaired' | 'resume_pending' }>
  cancelOwnerDeviceRepair(): Promise<void>
  cancelSignIn(): Promise<void>
  /** `forgetKey`: forget the recovery key kept on this Mac too (selling or giving it away);
   * by default it stays, so signing in again here unlocks by itself. */
  signOut(options?: { forgetKey?: boolean }): Promise<void>
  retry(): Promise<void>
  /** Opens the sign-in server's own page for ending that one device's session, in the browser
   * (it signs the person in first if needed): the only thing of its account app Atum opens. */
  endDeviceSession(deviceId: string): Promise<void>
  /** The person dismissed the new sign-in banner: account for that device for this sign-in. */
  dismissNewSignIn(deviceId: string): Promise<void>
  document(roomId: string, action: 'choose' | 'remove'): Promise<void>
  arrangeWord(roomId: string, show: boolean): Promise<void>
  previewDocument(roomId: string): Promise<MatrixDocumentPreview>
  closeDocumentPreview(token: string): Promise<void>
  textDocument?: {
    read(token: string): Promise<{ revision: string; text: string; truncated: boolean }>
    write(token: string, input: { expectedRevision: string; text: string }): Promise<{ revision: string }>
    recoveryRead(token: string): Promise<AtumDocumentRecoveryReadResult>
    recoveryWrite(token: string, input: AtumDocumentRecoveryWriteInput): Promise<AtumDocumentRecoveryWriteResult>
    recoveryDiscard(token: string, revision: string): Promise<AtumDocumentRecoveryDiscardResult>
  }
  pdf: MatrixPdfBridge
  readDomain(): Promise<MatrixDomainIdentity>
  cancelDomain(): Promise<void>
  enrollment(): Promise<MatrixEnrollment>
  enrollHermes(): Promise<MatrixEnrollment>
  /** One-click (and post-sign-in) setup: assistant account, enrollment and Atum's model. */
  setupAssistant(): Promise<void>
  revokeHermes(): Promise<MatrixEnrollment>
  connectHermes(roomId: string): Promise<void>
  listenHermes(roomId: string, locale?: string): Promise<void>
  setContinuousListening(roomId: string, enabled: boolean, locale?: string): Promise<void>
  stopListeningHermes(roomId?: string): Promise<void>
  invokeHermes(roomId: string, eventId: string, locale?: string): Promise<MatrixInvocationResult>
  sendAssistant(
    roomId: string,
    body: string,
    locale?: string
  ): Promise<{ eventId: string; result: MatrixInvocationResult }>
  recoverHermes(roomId: string, eventId: string): Promise<MatrixRecoveredResult>
  /** Local path: main accepts the text and returns at once; the turn shows in the snapshot.
   * `reply`: the message it answers, whose words go to the assistant as context. */
  sendTurn(roomId: string, body: string, reply?: MatrixTurnReply): Promise<{ turnId: string }>
  /** A new turn with the same text; the old one is retired and never runs again. */
  retryTurn(turnId: string): Promise<{ turnId: string }>
  /** A handed-off question, answered on this Mac instead; `always` keeps this agent's typed
   * messages on this Mac from now on. */
  answerTurnHere?(turnId: string, always?: boolean): Promise<{ turnId: string }>
  /** S1: this Mac's device service, and moving an agent to the cloud (MatrixCloudAgentRequest). */
  cloudAgent?(request: { action: 'status' }): Promise<MatrixCloudAgentStatus>
  cloudAgent?(request: { action: 'serviceStatus'; principal: string }): Promise<MatrixAgentServiceStatus>
  cloudAgent?(request: { action: 'moveToCloud'; principal: string }): Promise<MatrixCloudMoveOutcome>
  cloudAgent?(request: { action: 'stopTurn'; roomId: string; eventId: string }): Promise<MatrixCloudStopOutcome>
  cloudAgent?(request: { action: 'readerStatus' | 'readerEnroll' }): Promise<MatrixOwnerReaderStatus>
  cloudAgent?(request: { action: 'trialOffer' }): Promise<MatrixCloudTrialOffer | null>
  cloudAgent?(request: { action: 'cloudAccess' }): Promise<MatrixCloudAccess>
  cloudAgent?(request: {
    action: 'trialAccept'
    offerVersion: number
    disclosureVersion: number
  }): Promise<MatrixCloudTrialAccepted>
  /** H-F: owner-authoritative per-agent order/enablement. Main owns URL, bearer and validation. */
  executionPolicy?: MatrixExecutionPolicyBridge
  /** Where an agent lives: move it to another of the owner's Macs, or cancel the move. */
  agentHome?: MatrixAgentHomeBridge
  /** The owner's default model per destination (`atum.model-choice/1.3`); display rows only. */
  modelDestinations?: {
    read(agentPrincipal: string): Promise<MatrixModelDestinationsView | undefined>
    write(
      agentPrincipal: string,
      destination: string,
      model: MatrixModelId
    ): Promise<{ status: 'saved' | 'refused' }>
    /** One cloud pick from the account-wide OpenCode Go connection (`atum.model-choice/1.4`). */
    writeSubscription(
      agentPrincipal: string,
      source: 'opencode_go' | 'chatgpt_plan',
      model: string,
      effort: 'low' | 'medium' | 'high'
    ): Promise<{ status: 'saved' | 'refused' }>
    /** The agent's daily cap in Protons; 0 means no limit. Refused keeps the last server value. */
    cap(agentPrincipal: string, dailyProtons: number): Promise<{ status: 'saved' | 'refused' }>
  }
  /** Re-checks the readiness gate now (the loading screen's Try again). */
  retryReadiness(): Promise<void>
  /** One-tap approval between the person's devices (electron/matrix/device-approval.ts). */
  approval?: {
    /** On the approving device: "Yes, it's me" (this device takes the request). */
    accept(): Promise<void>
    /** On the approving device: which of the three symbols matches, or null for none. */
    pick(index: number | null): Promise<void>
    /** On the approving device: "This wasn't me". */
    decline(): Promise<void>
    /** Opens the sign-in server's page for ending the session of the device declined just now. */
    signOutDevice(): Promise<void>
    /** Closes a finished approval. */
    dismiss(): Promise<void>
    /** On the new Mac: "I picked them" (a Mac with nothing to check the identity against). */
    confirm(): Promise<void>
    /** Try again: on the new Mac, ask the person's other devices again; on the approving device,
     * after a comparison that took too long, compare with that device again. */
    retry(): Promise<void>
  }
  /** Keeps the recovery key in iCloud Keychain, or removes it there on every device. */
  icloudKeychain?(enabled: boolean): Promise<void>
  /** Opens macOS's Storage settings, to free space (a disk-full notice). */
  openStorageSettings?(): Promise<void>
  /** Replaces one agent's executor on this Mac (its device lost its keys, or the platform
   * withdrew it): a new device, the same agent, chats and memory. */
  reconnectAgent?(principal: string): Promise<void>
  /** The comprehensive first-learning run in `roomId`, else the primary's newest chat. `allow`,
   * `decline` and `finish` remain for a 0.20.19 renderer during an app/runtime upgrade. */
  firstRun?: {
    start?(input: { roomId?: string; locale: string; ending: 'done' | 'dismissed' }): Promise<void>
    allow(input: { roomId?: string; locale: string }): Promise<void>
    decline(): Promise<void>
    finish(): Promise<void>
  }
  /** The recovery key this Mac keeps for the account, shown when the person asks to write it
   * down (Settings, or before signing out); `written` once they confirm they did. */
  recoveryKey?: {
    reveal(): Promise<string>
    written(): Promise<void>
  }
  /** Opens Proton purchase information in the browser; this is not a checkout action. */
  openTopUp(): Promise<void>
  /** Stops the room's agent's turn (without a room: the default agent's). */
  cancelHermes(roomId?: string): Promise<void>
  respondHermes(response: MatrixHermesPromptResponse): Promise<void>
  /** Another agent, with a name and a persona; resolves once it exists (a local one once it
   * answers in its new room, a cloud-placed one once the platform reports the placement), or
   * with the platform's final refusal (a name it does not allow, the limit, the account).
   * `roomId` is absent when the platform placed it in the cloud: its room is the controller's
   * and this Mac has nothing local to open yet. */
  createAgent(
    name: string,
    persona: string,
    hireConfirmed?: boolean
  ): Promise<
    | { principal: string; roomId?: string; assistantId?: string }
    | { refused: 'name' | 'limit' | 'account' | 'short' }
    | { refused: { hire: number } }
  >
  /** Native folder picker for a verified offline profile; no paths/credentials in the UI. */
  importAgent(
    name: string,
    hireConfirmed?: boolean
  ): Promise<
    | { principal: string; roomId?: string; assistantId?: string }
    | { refused: 'name' | 'limit' | 'account' | 'short' }
    | { refused: { hire: number } }
    | { cancelled: true }
  >
  /** Retires one of the person's other agents for good. */
  retireAgent(principal: string): Promise<{ sessionCleanup: 'complete' | 'pending' | 'unconfirmed' }>
  renewAgent?(assistantId: string): Promise<{ renewed: true } | { refused: 'short' }>
  configureHermes(model: MatrixHermesModel): Promise<MatrixHermesSetupResult>
  /** Back to Atum's AI after the person's own model (the default assistant). */
  useAtumModel?(): Promise<MatrixHermesSetupResult>
  /** Every ready route from the room agent's own Hermes provider catalog, sanitized: model
   * names, safe provider/account labels, exact thinking levels and current/readiness flags.
   * Never a list, credential or endpoint the window supplies. */
  modelCatalog?(roomId: string): Promise<MatrixModelCatalog>
  /** Switches the room's agent to one catalog route through the native select the Connections
   * page uses: main re-reads the catalog, revalidates the route and target, Hermes switches,
   * main reads it back. Refusals are MATRIX_CONNECTED_MODEL_ERRORS codes. */
  selectModelRoute?(
    roomId: string,
    routeId: string,
    target: MatrixModelRouteTarget
  ): Promise<MatrixModelRouteSelection>
  command(command: MatrixCommand): Promise<unknown>
  /** The `attend` command: the conversation on screen in a focused window, or none. */
  attend?(roomId: string | null): Promise<unknown>
  /** The `typing` command: a presentation signal, like `attend`, never an operation. */
  typing?(roomId: string, typing: boolean): Promise<unknown>
  /** Opens a web link in the default browser (http(s) only), or an email to one of Atum's own
   * role mailboxes in the mail app (Settings › Delete my account). */
  openLink(url: string): Promise<void>
  /** Settings › General › Legal › Open-source licences: opens the open-source notice that ships
   * with the app (Resources/licenses/THIRD-PARTY-NOTICES.txt) in a window of the app, titled with
   * the row's own words. */
  openSourceNotices?(title: string): Promise<void>
  subscribe(listener: (snapshot: MatrixSnapshot) => void): () => void
}

/** Main → trusted SDK host only; never exposed by the UI preload. */
export interface MatrixSdkConfiguration extends MatrixIdentity {
  baseUrl: string
  accessToken: string
  refreshToken?: string // Personal-session agents have no refresh credential.
  storageKey: string
  /** The person's visible desktop host projects standard Matrix threads. Hidden agent,
   * app-bot and controller engines leave this off so their intake keeps the room timeline. */
  threadSupport?: true
  /** Desktop is the existing projection-bearing behaviour; app-bot is an explicit future mode. */
  mode?: 'desktop' | 'app-bot'
  /** People encrypt only to verified devices unless the bot runtime opts in to all member devices. */
  keySharing?: 'verified' | 'all'
  /** Per-install opt-in; missing keeps released legacy behavior. */
  deviceIsolation?: MatrixDeviceIsolation
  /** Main-owned private-CoS bindings. Missing keeps non-desktop hosts compatible. */
  companyPrivateCosNotificationRoomIds?: string[]
}

/**
 * Why a refresh of the person's chat sign-in gave no new token: closed codes for main's routing
 * and main.log, never a token. Only `session_ended` means the sign-in is over (the sign-in
 * server refused this Mac's grant: invalid_grant or invalid_client). `signed_out`: no account
 * here, or it is signing out or was replaced meanwhile; `stale`: the asking engine holds an old
 * handle. The rest pass by themselves: the sign-in server not reached (`transport`,
 * `discovery`, `5xx`), another refusal (`refused`), this Mac's saved sign-in unreadable or not
 * writable (`vault`), or a new token the disk is too full to save (`disk_full`: the vault's
 * write failed even in the room kept for it; the chats wait until a save lands).
 */
export type MatrixRefreshCause =
  | 'session_ended'
  | 'signed_out'
  | 'stale'
  | 'transport'
  | 'discovery'
  | '5xx'
  | 'refused'
  | 'vault'
  | 'disk_full'
  | 'unexpected'

export type MatrixRefreshResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresAt?: number }
  | { ok: false; reauthenticate: boolean; cause?: MatrixRefreshCause }

/** The largest file a chat sends or reads (CH6): the homeserver's own upload limit, Synapse
 * `max_upload_size: "20M"` (20 MiB; atum-platform deploy/chat/prepare.py). An encrypted file
 * uploads at its own size, so the whole limit is usable. */
export const MATRIX_MAX_FILE_BYTES = 20 * 1024 * 1024
/** The cloud controller admits at most ten inputs in one turn: the chat attachment plus the
 * Drive files it reads (`packages/cloud-controllerCLOUD_ATTACHMENT_MAX_COUNT`). */
export const MATRIX_MAX_TURN_INPUTS = 10
/** How long one media download may take: room for a file of MATRIX_MAX_FILE_BYTES on a slow link. */
export const MATRIX_MEDIA_TIMEOUT_MS = 60_000
/** The longest name a person can give a chat of theirs (`chatTitle`). */
/** A report's optional reason: one line of the person's own words. */
export const MATRIX_REPORT_REASON_MAX = 500

export const MATRIX_CHAT_TITLE_MAX = 80
/** The longest topic a person can give a group (`groupTopic`); a longer one set elsewhere is
 * shown cut to this length. */
export const MATRIX_GROUP_TOPIC_MAX = 500
/** The longest reaction key accepted (`react`): an emoji, or a short word from another app. */
export const MATRIX_REACTION_KEY_MAX = 64
/** SDK push-rule result; no decrypted preview or caller-selected native action. */
export interface MatrixNotificationHint {
  roomId: string
  eventId: string
  sound: boolean
}

export const MATRIX_CHANNELS = {
  ui: 'matrix:ui',
  snapshot: 'matrix:snapshot',
  terminal: 'matrix:terminal',
  sdkConfig: 'matrix:sdk:config',
  sdkRefresh: 'matrix:sdk:refresh',
  sdkSnapshot: 'matrix:sdk:snapshot',
  sdkInvocation: 'matrix:sdk:invocation',
  sdkNotification: 'matrix:sdk:notification',
  sdkGoogleFence: 'matrix:sdk:google-fence',
  sdkUndecryptable: 'matrix:sdk:undecryptable',
  sdkCommand: 'matrix:sdk:command',
  sdkResult: 'matrix:sdk:result'
} as const
