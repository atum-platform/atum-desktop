import './look/look.css'
import './team-space/slack-layout.css'

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ComposerRuntime,
  MessagePrimitive,
  useAssistantRuntime,
  useAuiState,
  useExternalStoreRuntime
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import {
  type ChangeEvent,
  createContext,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { AtumChatTranscript } from '@/app/atum/chat-transcript'
import { AtumShellFrame } from '@/app/atum/shell-frame'
import {
  AtumMainHeaderSurface,
  AtumNavSwitchSurface,
  type AtumShellDestination,
  AtumWindowControlsSurface
} from '@/app/atum/shell-surface'
import { ComposerSurface } from '@/app/chat/composer/composer-surface'
import { MarkdownContent } from '@/components/assistant-ui/markdown-surface'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { SearchField } from '@/components/ui/search-field'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import { appSurfaceIcon } from '@/lib/atum-app-surface-icons'
import { ATUM_COMPACT_BREAKPOINT_PX, ATUM_WORKSPACE_DEFAULT_PERCENT } from '@/lib/atum-shell-geometry'
import {
  AlertTriangle,
  ArrowBackUp,
  ArrowLeft,
  ArrowUp,
  BookmarkFilled,
  Check,
  ChevronRight,
  Clock,
  DeviceMobile,
  Files,
  Hash,
  LayoutSidebarRight,
  Messages,
  MoreHorizontal,
  Pencil,
  Plus,
  Refresh,
  Share,
  ThumbsDown,
  ThumbsUp,
  X
} from '@/lib/icons'
import { cn } from '@/lib/utils'

import { attentionConversationRoom, rosterConversationRoom } from '../../shared/agent-conversation'
import { agentConversationCopy } from '../../shared/agent-conversation/copy'
import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import { type AppDescriptor, appLocalizedCopy } from '../../shared/app-catalog'
import type { MatrixAppHistoryEntry } from '../../shared/app-history'
import type { LookRoomAccountData } from '../../shared/look-pack'
import {
  MATRIX_MAX_FILE_BYTES,
  MATRIX_MAX_TURN_INPUTS,
  type MatrixAgentView,
  type MatrixInvocationResult,
  type MatrixMember,
  type MatrixMembershipLine,
  type MatrixMessage,
  matrixMessageTooLong,
  type MatrixReaction,
  type MatrixRoom,
  type MatrixSnapshot,
  type MatrixThread,
  type MatrixUiBridge
} from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'
import { matrixAgentNeedsLocalSetup, matrixAssistantReplySettingsShown } from '../../shared/matrix-agent-actions'
import { matrixAgentStatusText } from '../../shared/matrix-agent-status-copy'
import { appChatCopy } from '../../shared/matrix-app-chat-copy'
import {
  assistantOpeningBlocksRoom,
  isAssistantRoom,
  usableAgentRoom,
  withoutPersonalAgent
} from '../../shared/matrix-assistant-room'
import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'
import {
  isCompanyConversationRoom,
  isTeamSpaceRoom,
  MATRIX_COMPANY_CHANNEL_TYPE
} from '../../shared/matrix-company-channel-room'
import { matrixCompanyCopy } from '../../shared/matrix-company-copy'
import {
  matrixAdmitCompanyPresentation,
  type MatrixCompanyPresentationBinding
} from '../../shared/matrix-company-presentation'
import { isCompanyPrivateCosClaim } from '../../shared/matrix-company-private-cos'
import type { MatrixCompanyMessageSearchResult } from '../../shared/matrix-company-search'
import { matrixMessageBackupAvailable, matrixMessageDecryptionReason } from '../../shared/matrix-decryption-reason'
import { matrixDisplayMode } from '../../shared/matrix-display-preferences'
import { type MatrixDraftTarget, matrixDraftText } from '../../shared/matrix-drafts'
import { matrixMessageLink, validMatrixMessageLinkTarget } from '../../shared/matrix-message-link'
import {
  MATRIX_NOTES_SELF_ROOM_TYPE,
  matrixNotesSelfKnownRoom,
  matrixNotesSelfRoom
} from '../../shared/matrix-notes-self'
import type { MatrixPageId } from '../../shared/matrix-pages'
import type { MatrixProfileTarget } from '../../shared/matrix-profile'
import type { MatrixSavedMessagesSnapshot } from '../../shared/matrix-saved-messages'
import { isMatrixVerificationPending } from '../../shared/matrix-security'
import { matrixTeamSpaceCopy } from '../../shared/matrix-team-space-copy'
import {
  isMatrixTransientLine,
  matrixHideEndedTransientLines,
  matrixLiveWorkingLine
} from '../../shared/matrix-transient-lines'
import { matrixTurnQuote } from '../../shared/matrix-turn-intake'
import type { MatrixWindowFacts } from '../../shared/matrix-window'
import type { MatrixWindowFailureSource } from '../../shared/matrix-window-failure'
import { DAILY_TURNS_DEFAULT, effectiveMode, roomBudget } from '../../shared/room-participation'

import { MATRIX_SNAPSHOT_UNAVAILABLE, MatrixAccountUnavailable, matrixAccountUnavailable } from './account-unavailable'
import { matrixAgentAttention, type MatrixAttentionItem } from './agent-attention'
import { useMatrixAgentHandleBackfill } from './agent-handle-backfill'
import { authorizedBotApi, botApiAppForMessage, isBotApiRoom } from './app-bots/bot-api'
import { MatrixBotApiKeyboard, MatrixBotApiText } from './app-bots/bot-api-text'
import { MatrixBotApiPhotoView } from './app-bots/bot-photo'
import { directAppBot } from './app-bots/direct-app'
import {
  addressedAppBotRecipients,
  appBotGroupMessageError,
  clearStoredAppBotRecipient,
  isEligibleAppBotQuote
} from './app-bots/group-message'
import { openAppBotChat } from './app-bots/open'
import {
  type AppBotOutcome,
  appBotOutcomeText,
  appBotOutcomeUnreadableLine,
  parseAppBotOutcome,
  pollAppBotOutcome
} from './app-bots/outcomes'
import type { AppBotRouteRequest } from './app-bots/route-request'
import { AppBotSetupCard } from './app-bots/setup-card'
import { useAppBotComposerActions } from './app-bots/use-composer-actions'
import { useAppBotHistory } from './app-bots/use-history'
import { useOpenApp } from './app-bots/use-open-app'
import { useAppCopy } from './app-copy'
import { MatrixAppearance } from './appearance'
import { MatrixApps } from './apps'
import {
  $assistantCard,
  $assistantNameOverrides,
  AssistantCardHost,
  openAssistantCard,
  settleAssistantNames,
  withAssistantNames
} from './assistant-card'
import { useAssistantCardCopy } from './assistant-card/copy'
import { matrixComposerHint, useAttentionCopy } from './attention-copy'
import { MatrixAttentionIndicator, useMatrixApprovalSheet } from './attention-indicator'
import { useChatCopy } from './chat-copy'
import {
  aboutAppBot,
  isMatrixFounderRefusal,
  MATRIX_ASSISTANT_NOT_READY,
  MATRIX_CHANNEL_ARCHIVED,
  type MatrixChatFailure,
  matrixChatFailure,
  matrixChatFailureCopy,
  matrixFailureRetry,
  matrixFailureSubject,
  MatrixSendFailure,
  matrixSendFailure,
  matrixSendFailureRetryable
} from './chat-error'
import { MatrixChatSearch } from './chat-search'
import { useChatSearchCopy } from './chat-search-copy'
import { matrixChatTitle } from './chat-title'
import { MatrixCheckInCard, MatrixCheckInsNotice } from './check-in-card'
import { cloudRoomAgent, LinkedDocumentNotice, MatrixCloudAccessBand } from './cloud-status'
import { matrixCloudStopTarget } from './cloud-stop'
import { MatrixCommandPalette, type MatrixPaletteAction } from './command-palette'
import { CompanyAIAnswer, companyAIAnswerProjection } from './company-ai-answer'
import {
  companyAIMentionMatch,
  companyAIMentionUserIds,
  insertCompanyAIMention
} from './company-ai-mention'
import {
  companyAIAvailability,
  companyAIAvailabilityLine,
  CompanyAIAvatar,
  useCompanyAIRecheck,
  useCompanyAIStatus
} from './company-ai-status'
import {
  companyAIPrivateCosStatus,
  companyAIThreadStatus,
  CompanyAIThreadStatusLine,
  companyAIThreadStatusShown
} from './company-ai-thread-status'
import { type CompanyBoardCapture, useCompanyBoardCapture } from './company-board-capture'
import { MatrixCompanyChannelMenu, MatrixCompanyMembersButton } from './company-channel-menu'
import {
  $companyChannelCompanyId,
  $companyChannelOrder,
  companyPaletteChannels,
  companyRoomsBadge,
  isCompanyRoom,
  neighbouringCompanyChannel
} from './company-chrome'
import { companyChannelPresentationBinding, privateCosPresentationBinding } from './company-presentation-binding'
import {
  COMPANY_CHANNEL_BINDING_MAX_AGE_MS,
  useCompanyLineClock,
  useCompanyStrangerSignal
} from './company-presentation-hooks'
import { $companyAIStatuses, companySpaceScope } from './company-space-store'
import { companyTurnMemory } from './company-turn-memory'
import { ComposerDock } from './composer-dock'
import {
  clearLocalMatrixDraftsForIdentity,
  localMatrixDraft,
  reconcileLocalMatrixDraft,
  setLocalMatrixDraft,
  useMatrixDraftWriter
} from './composer-draft'
import { focusMatrixComposer } from './composer-focus'
import {
  type ComposerPlusAvailability,
  type ComposerPlusKind,
  composerPlusKinds,
  ComposerPlusMenu
} from './composer-plus'
import { $matrixConnectionsRequests } from './connections-request'
import { ConversationMembership, MatrixMembers, MatrixMembersButton } from './conversation-controls'
import { useConversationCopy } from './conversation-copy'
import { conversationMainInstead, resolveProjectedConversation } from './conversation-marker'
import { MatrixChatMenu } from './conversation-menu'
import { ConversationRetryLine } from './conversation-recovery'
import { useMatrixCopy } from './copy'
import { MatrixUpdateFooter } from './desktop-settings'
import { $matrixDestinationRequests } from './destination-requests'
import { MatrixApprovalSheet } from './device-approval'
import { matrixDeviceHealthCopy, MatrixDeviceHealthNotice } from './device-health-notice'
import { focusDialogField, MatrixDialogHeader } from './dialog-header'
import { DocumentLink } from './document-link'
import { MatrixDrive, type MatrixDriveDestination, MatrixDriveSidebar, MatrixDriveTitle } from './drive'
import { matrixDriveCopy } from './drive-copy'
import {
  $matrixDriveTaskSelection,
  clearMatrixDriveTaskSelections,
  clearMatrixDriveTaskSelectionsIfCurrent,
  matrixDriveTaskInputSelections,
  removeMatrixDriveTaskSelection,
  selectMatrixDriveFile,
  setMatrixDriveTaskScope
} from './drive-selection'
import type { MatrixDriveTaskScope } from './drive-selection'
import { MatrixFirstLearningTiles } from './first-learning-tiles'
import {
  MatrixFirstRunCard,
  MatrixFirstRunPanel,
  matrixFirstRunPlace,
  MatrixFolderAccessRecovery
} from './first-run-card'
import { MatrixForwardDialog } from './forward-dialog'
import {
  matrixForwardNeedsLocalInvocation,
  type MatrixForwardTarget,
  matrixForwardTargets
} from './forward-targets'
import { useFounderCopy } from './founder/founder-copy'
import { FounderDraftChat } from './founder/founder-draft-chat'
import { $founderDraftOpen, closeFounderDraft, useFounderChatRequests } from './founder/founder-store'
import { FounderHeaderIdentity } from './founder/header-identity'
import { FounderIntroCard } from './founder/intro-card'
import { isFounderRoom } from './founder/roster-founder'
import { MatrixGoogleConnectNudge } from './google-connection-settings'
import { AssistantGreeting } from './greeting'
import {
  groupAssistantMode,
  groupAssistantRecipients,
  groupReplyMentions,
  groupTypedMentions
} from './group-assistants'
import { MatrixGroupHeaderTopic } from './group-details'
import { groupRecipientChoice, useGroupRoomPolicy } from './group-room-policy'
import { groupRoomCopy, GroupRoomSettings } from './group-room-settings'
import { HermesPrompts } from './hermes-prompts'
import {
  $matrixHistoryReveal,
  clearExactMatrixHistoryReveal,
  clearMatrixHistoryReveal,
  companyHistoryRevealProjected,
  revealMatrixHistoryMessage
} from './history-search'
import { invocationCopy, invocationNoticeVisible } from './invocation-notice'
import { MatrixLanguageProvider } from './language'
import { runMatrixReadinessAction } from './launch-actions'
import { useLaunchCopy } from './launch-copy'
import { MatrixLaunchNotice, matrixLaunchNoticeKind } from './launch-notice'
import { MatrixLinkPreviewCard } from './link-preview-card'
import { matrixMessagePreviewLink } from './link-previews'
import { matrixAgentTyping, type MatrixTranscriptEntry, matrixTurnStatus, mergeLocalTurns } from './local-turns'
import { ChatLookPicker } from './look/look-picker'
import { resolveConversationLook } from './look/resolve-look'
import { MatrixMacSourcesNotice } from './mac-sources-notice'
import { MainAgentBadge } from './main-agent-badge'
import { MATRIX_MARKDOWN_HOST } from './markdown-host'
import {
  filterMatrixHumanMentions,
  insertMatrixMention,
  matrixHumanMentions,
  matrixHumanMentionUserIds,
  matrixMentionMatch,
  matrixRoomMentionNeedsConfirmation,
  matrixRoomMentionRequested
} from './matrix-mentions'
import { MatrixPersonAvatar } from './member-avatar'
import {
  MatrixDeletedMessage,
  MatrixFailedSend,
  MatrixFileCard,
  MatrixFileSave,
  MatrixMessageMenu,
  type MatrixMessageSavedAction,
  MatrixMessageToolbar,
  MatrixReactionChips,
  MatrixReactionPicker,
  MatrixSenderLine
} from './message-actions'
import { matrixRoomShowsSenders, matrixRunBreak } from './message-runs'
import { matrixClock, matrixDateTime, matrixFullTime, matrixNewDay } from './message-time'
import { mobileChatCopy, useMobileCopy } from './mobile-copy'
import { MatrixMobileSetup } from './mobile-setup'
import { MatrixModelPicker } from './model-picker'
import { MatrixNoReplyBanner, matrixUnansweredOwnerMessage } from './no-reply-banner'
import { MatrixNotificationLevelMenu } from './notification-level-menu'
import {
  $outgoingEchoes,
  addOutgoingEcho,
  dropOutgoingEchoes,
  failOutgoingEcho,
  isOutgoingEcho,
  mergeOutgoingEchoes,
  settleOutgoingEcho
} from './outgoing-echo'
import { MatrixPeerIdentityPanel } from './peer-identity-panel'
import { directRoomWith } from './people'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { PersonHandleLine } from './person-handle-line'
import {
  bindMatrixHandleOwner,
  bindMatrixHandleOwnerFromSnapshot,
  rememberMatrixHandle,
  useMatrixChatPeople,
  useMatrixHandles,
  useMatrixPeople
} from './person-handles'
import { matrixPersonInfoCopy } from './person-info-copy'
import { matrixConversationInfo } from './person-info-model'
import { MatrixPersonInfoPanel } from './person-info-panel'
import { matrixPersonLine } from './person-name'
import { MatrixAgentPet } from './pet'
import { bindMatrixPresenceSnapshot, clearMatrixPresence } from './presence-store'
import { privateCosGreetingMarkdown } from './private-cos-greeting'
import { MatrixProfileAvatar } from './profile-avatar'
import { MatrixProfileEditor } from './profile-editor'
import { MatrixRailAccount, OwnAvatar, useOwnName } from './rail-account'
import { railSurfaceState } from './rail-surfaces'
import { useMatrixReadAttention } from './read-attention'
import { matrixFirstUnreadMessageId } from './read-marker'
import { matrixReadinessCopy, matrixSetupCooldown } from './readiness-copy'
import { ResultRecoveryOutcome, useResultRecovery } from './result-recovery'
import { anyAgentPrompts, primaryAgent, snapshotForRoom } from './room-agent'
import { sortConversations } from './room-navigation'
import { MatrixRosterConversations } from './roster-conversations'
import { useRosterCopy } from './roster-copy'
import { MatrixRosterCreate, type MatrixRosterCreation } from './roster-create'
import { matrixRosterGlobalSearchPending, useMatrixRosterGlobalSearch } from './roster-global-search'
import { matrixPrimaryAgentName, matrixRosterAgentName, normalizeMatrixRosterQuery, projectMatrixRoster } from './roster-model'
import { matrixAgentConversationRoom } from './roster-preview'
import { $matrixDeviceToShow, VerificationPrompt } from './security-panel'
import { MatrixSendState } from './send-state'
import { type MatrixSettingsPane, MatrixSettingsSheet } from './settings-sheet'
import { MatrixSignIn } from './sign-in'
import { MatrixStartChatButton } from './start-chat'
import { MatrixStarterNotice } from './starter-notice'
import { matrixStartupBlocking, MatrixStartupScreen } from './startup-screen'
import { MatrixStoreSidebar, useMatrixStoreNavigation } from './store/store-sidebar'
import { $matrixStoreDraft, MatrixStoreDraftSeed } from './store/store-try'
import { $matrixStoreHubRequest, $matrixStoreShelfRequest, matrixInAppTopUp, openMatrixTopUp } from './store/top-up'
import { useMatrixSurfaces } from './surface-sources'
import {
  ArchivedChannelBanner,
  ChannelGlyphFor,
  ChannelHeaderMetaFor,
  ChannelTitleFor,
  useChannelTitle
} from './team-space/channel-chrome'
import { ChannelIntroFor } from './team-space/channel-intro'
import { $companyChannels } from './team-space/channels-store'
import {
  ConversationFaceFor,
  ConversationMenu,
  ConversationTitleFor,
  ReadOnlyConversationBanner,
  useConversationTitle
} from './team-space/conversation-chrome'
import { $companyConversations, $companySelfRefs } from './team-space/conversations-store'
import { activateTeamSpaceCacheAccount } from './team-space/directory-store'
import { type FormattedText } from './team-space/formatting'
import { TeamSpaceFormattingBar, TeamSpaceFormattingToggle } from './team-space/formatting-bar'
import { companyShortcutHandlers } from './team-space/intents'
import {
  $companyInviteInbox,
  pendingCompanyInvitations,
  setCompanyInviteInboxAccount,
  startCompanyInviteInboxPolling
} from './team-space/invite-inbox'
import {
  $matrixInviteJoinRequest,
  useMatrixInviteLinkBridge
} from './team-space/invite-join'
import { teamSpaceAccountKey, teamSpaceKey } from './team-space/keys'
import { MembershipLineView } from './team-space/membership-line'
import { TeamSpaceMentionContent } from './team-space/mention-content'
import { TeamSpaceMentionMenu, type TeamSpaceMentionOption } from './team-space/mention-menu'
import {
  $matrixMessageLinkRequest,
  useMatrixMessageLinkBridge
} from './team-space/message-links'
import {
  TeamSpaceDayDivider,
  teamSpaceFirstUnreadMessageId,
  teamSpaceNewDay,
  TeamSpaceNewMessagesDivider,
  TeamSpaceRepliesDivider,
  TeamSpaceThreadSummary,
  THREAD_SUMMARY_FACES_MAX
} from './team-space/message-parts'
import { PinnedMessageMarker, PinnedMessagesButton, PinnedMessagesPanel } from './team-space/pinned-panel'
import { PrivateCosFaceFor, PrivateCosMenu, usePrivateCosName } from './team-space/private-cos-chrome'
import {
  $companyPrivateCos,
  companyPrivateCosBoundRoomId,
  companyPrivateCosRoom
} from './team-space/private-cos-store'
import { useSavedMessagesCopy } from './team-space/saved-messages-copy'
import { useCompanyChannelFacts } from './team-space/use-channel-facts'
import { MatrixTerminalOffers } from './terminal'
import { prepareMatrixDocumentClose, runMatrixCommand } from './text-document-actions'
import { matrixThreadCopy } from './thread-copy'
import { loadTimelineHistoryPage, MATRIX_TIMELINE_SEARCH_PAGES, waitForTimelineProjection } from './timeline-history'
import { followTranscriptEnd } from './transcript-follow'
import { MatrixTurnHandoffActions } from './turn-handoff'
import { MatrixAgentWorking } from './typing-indicator'
import { MatrixUndecryptableMessage } from './undecryptable-message'
import { useShellShortcuts } from './use-shell-shortcuts'
import { MatrixVoiceDictation, useMatrixReadAloud } from './voice'
import { matrixWalletCopy } from './wallet-copy'
import { useMatrixWalletHistory } from './wallet-ui'
import { MatrixWebPreviewOfferCard } from './web-preview-offer'
import { markWelcomePlayed, MatrixWelcomeStory, welcomePlayed } from './welcome-story'
import { reportMatrixWindowFailure } from './window-failure'
import { useMatrixWindowMode } from './window-mode'
import {
  type MatrixDrivePreviewRequest,
  MatrixWorkbench,
  matrixWorkbenchCrowdsRoster,
  matrixWorkbenchScope
} from './workbench'
import { useMatrixWorkbenchCopy } from './workbench-copy'
import { MatrixWorkspace } from './workspace'

declare global {
  interface Window {
    atumMatrix: MatrixUiBridge
  }
}

const initial: MatrixSnapshot = {
  state: 'signed_out',
  identity: null,
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

const initialWindowFacts: MatrixWindowFacts = {
  platform: '',
  isFullscreen: false,
  windowButtonPosition: null,
  overlayWidth: 0
}

const ConversationActions = createContext<{
  room: MatrixRoom
  accountKey?: string
  cloud?: boolean
  /** The assistant's Matrix user: its answers render as markdown, as in the old app. */
  assistantUserId?: string
  assistantName?: string
  ownerUserId?: string
  ownerDeviceId?: string
  /** The open room's members, for the names people go by and their photos (display only). */
  members?: MatrixMember[]
  /** The owner's agents, for their roster photos beside their runs (display only). */
  agents?: readonly MatrixAgentView[]
  /** The signed app catalog, for matching a bot-api message to its official app. */
  appBots?: readonly AppDescriptor[]
  /** Standard Matrix threads in this channel; they inherit the room audience. */
  threads?: MatrixThread[]
  /** The owner's private account-data Saved list. */
  savedMessages?: MatrixSavedMessagesSnapshot
  /** Standard shared room pins and the live state-event permission. Team Space only. */
  pinnedMessages?: MatrixSnapshot['pinnedMessages']
  /** Opens one root in the room's single thread panel. */
  openThread?: (rootId: string) => void
  /** Present inside the panel so a thread reply never creates a nested thread. */
  threadRootId?: string
  fail: (cause?: unknown) => void
  /** Opens an official bot's chat; a refusal names the bot (app-bots/open.ts). */
  openAppBot(appId: string): Promise<void>
  hermes?: MatrixSnapshot['hermes']
  listening: boolean
  recover: boolean
  assistantEligible: boolean
  /** The top-up, where running out stopped a turn: the Store's checkout, or Atum's payments page. */
  topUp?: () => Promise<void>
  /** The owner's own agents: their answers get the action row, never Report. */
  agentUserIds?: readonly string[]
  /** Display-only: the name of the person who sent a cited message in this room. */
  citationSenderName?(eventId: string): string | undefined
  /** The message box, for an answer's Retry and a message's Reply and Edit. */
  composer?: MatrixComposerActions | null
  /** The newest answer keeps its action row in sight. */
  latestAnswerId?: string
  /** Your newest message: the one that says Sent (and, in your assistant's chat, Seen). */
  latestOwnId?: string
  /** First loaded unread message in a Team Space room. */
  firstUnreadId?: string
  /** Opens the one multi-target forward dialog owned by this transcript. */
  forward?: (message: MatrixMessage, sourceName: string) => void
  /** "Turn into task": present only in an active public company channel. */
  captureCard?: CompanyBoardCapture
  /** Settings › Privacy, where the recovery key brings older messages back. */
  restoreMessages?: () => void
  backupAvailable?: boolean
  reviewDevices?: (thisMac: boolean) => void
} | null>(null)

type MatrixThreadFilter = 'recent' | 'following' | 'unread'

interface MatrixThreadView {
  roomId: string
  filter: MatrixThreadFilter
  rootId?: string
  fromList?: boolean
}

/** Scrolls the transcript to one of its messages and marks it for a moment (a reply's quote). */
function jumpToMessage(eventId: string, root: ParentNode = window.document): boolean {
  // Event ids carry characters a selector would need escaped: compare them as values instead.
  const target = [...root.querySelectorAll<HTMLElement>('[data-matrix-message-id]')].find(
    element => element.dataset.matrixMessageId === eventId
  )

  if (!target) {
    return false
  }

  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  target.setAttribute('data-matrix-highlight', '')
  window.setTimeout(() => target.removeAttribute('data-matrix-highlight'), 1600)

  return true
}

function AppHistoryMessageBubble({ entry }: { entry: MatrixAppHistoryEntry }) {
  const { locale } = useI18n()

  const time = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(entry.occurredAt),
    [entry.occurredAt, locale]
  )

  const own = entry.role === 'owner'

  return (
    <MessagePrimitive.Root
      className={`relative flex flex-col gap-1 py-2 ${own ? 'items-end' : 'items-start'}`}
      data-app-history-id={entry.id}
      data-app-history-role={own ? 'owner' : 'app'}
      data-slot={own ? 'aui_user-message-root' : 'aui_assistant-message-root'}
    >
      <span className="text-xs text-(--atum-ink-faint)" data-app-history-source>
        {appLocalizedCopy(entry.source.label, locale, entry.source.id)} · {time}
      </span>
      <div
        className={
          own
            ? 'composer-human-message max-w-full whitespace-pre-wrap break-words'
            : 'app-history-message matrix-chat-bubble max-w-full'
        }
      >
        {own ? entry.text : <MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={entry.text} />}
      </div>
    </MessagePrimitive.Root>
  )
}

function connectLimitedAppBot(appId: string, fail?: () => void) {
  const apps = window.atumMatrix.apps

  if (!apps) {
    return
  }

  // The limit outcome is a Connect action, never an automatic resend: the person
  // starts the existing sign-in and explicit confirmation flow themselves.
  void apps.connection(appId, 'begin', { autoConfirm: true }).catch(() => fail?.())
}

/** A join or departure in a Team Space channel, named as the chat names its people. */
function MatrixMembershipRow({ line }: { line: MatrixMembershipLine }) {
  const action = useContext(ConversationActions)
  const people = useMatrixChatPeople(action?.members, action?.ownerUserId)
  const you = line.userId === action?.ownerUserId

  // The room's list drops someone who left; the event still has the name it gave them.
  const named =
    line.name && !people.members?.some(member => member.userId === line.userId)
      ? { ...people, members: [...(people.members ?? []), { userId: line.userId, name: line.name }] }
      : people

  return (
    <MessagePrimitive.Root data-slot="aui_system-message-root">
      <MembershipLineView
        kind={line.kind}
        name={you ? '' : matrixPersonLine(line.userId, named)}
        timestamp={line.timestamp}
        you={you}
      />
    </MessagePrimitive.Root>
  )
}

function MatrixMessageBubble() {
  const history = useAuiState(state => state.message.metadata.custom?.appHistory) as MatrixAppHistoryEntry | undefined
  const membership = useAuiState(state => state.message.metadata.custom?.membership) as MatrixMembershipLine | undefined

  if (membership) {
    return <MatrixMembershipRow line={membership} />
  }

  return history ? <AppHistoryMessageBubble entry={history} /> : <MatrixEventMessageBubble />
}

function MatrixTimestamp({
  className,
  full,
  timestamp,
  value
}: {
  className?: string
  full: string
  timestamp: number
  value: string
}) {
  return (
    <Tip label={full}>
      <time className={className} dateTime={matrixDateTime(timestamp)} tabIndex={0}>
        {value}
      </time>
    </Tip>
  )
}

/** Stable message component: activity and command state remain scoped to its Matrix event.
 * Every message has a floating toolbar on hover or focus (React, Reply, and a "…" with Copy,
 * Edit and Delete for yours, Copy and Report for people's, Copy, Read aloud and Retry for an
 * answer); right-clicking a message opens the same "…". Reactions sit under a message,
 * replies quote what they answer, an edited message says so and a deleted one keeps its place
 * as one line. Everyone but you writes markdown. Everyone's words are bubbles: in a group a
 * sender's name opens each run, and their photo sits beside its last bubble. */
function MatrixEventMessageBubble() {
  const copy = useMatrixCopy()
  const chat = useChatCopy()
  const savedCopy = useSavedMessagesCopy()
  const action = useContext(ConversationActions)
  const companyAIStatuses = useStore($companyAIStatuses)
  const privateCosCompanyId = action?.room.companyPrivateCos?.companyId

  const privateCosKey = action?.accountKey && privateCosCompanyId
    ? teamSpaceKey(action.accountKey, privateCosCompanyId)
    : ''

  const privateCosRecords = useStore($companyPrivateCos, { keys: [privateCosKey] })
  const privateCosState = privateCosRecords[privateCosKey]
  // Senders, replies, receipts and mentions in a message: names only, never a public @handle.
  const people = useMatrixChatPeople(action?.members, action?.ownerUserId)
  const message = useAuiState(state => state.message.metadata.custom?.matrix) as MatrixMessage
  const local = useAuiState(state => state.message.metadata.custom?.local) as MatrixTranscriptEntry['local']
  const reply = useAuiState(state => state.message.metadata.custom?.reply) as MatrixMessage | undefined
  const consecutiveReply = useAuiState(state => state.message.metadata.custom?.consecutiveReply) as boolean
  // Display grouping and correlation only (Conversation computes them from the transcript).
  const runStart = useAuiState(state => state.message.metadata.custom?.runStart) as boolean | undefined
  const runEnd = useAuiState(state => state.message.metadata.custom?.runEnd) as boolean | undefined
  const question = useAuiState(state => state.message.metadata.custom?.question) as MatrixMessage | undefined
  const answered = useAuiState(state => state.message.metadata.custom?.answered) as boolean | undefined
  const dayStart = useAuiState(state => state.message.metadata.custom?.dayStart) as boolean | undefined
  const threadReplies = useAuiState(state => state.message.metadata.custom?.threadReplies) as number | undefined

  const appBotOutcome = useAuiState(state => state.message.metadata.custom?.appBotOutcome) as
    | AppBotMessageOutcome
    | undefined

  // A bot-api message is drawn only when the sender is that app's official bot (and, in an
  // encrypted room, native pinned-device evidence says so). Everything else keeps today's UI.
  const botApp = action?.appBots ? botApiAppForMessage(action.appBots, message) : undefined
  const botApi = action && botApp ? authorizedBotApi(botApp, message, action.room.encrypted) : undefined
  const privateCosGreeting = privateCosGreetingMarkdown(message)

  const position = useAuiState(state => state.message.index + 1)
  const { locale, t } = useI18n()
  const threadCopy = matrixThreadCopy(locale)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<MatrixInvocationResult | null>(null)
  const [reported, setReported] = useState(false)
  const [pinning, setPinning] = useState(false)
  // The "…" menu is also opened by right-clicking the message.
  const [menuOpen, setMenuOpen] = useState(false)
  const [savedOverride, setSavedOverride] = useState<boolean | null>(null)
  const [savedPending, setSavedPending] = useState(false)
  const [toCardFailed, setToCardFailed] = useState(false)
  // "Turn into task" keeps the person here: the card it made is offered, never opened for them.
  const [toCardAdded, setToCardAdded] = useState<string>()
  const recovery = useResultRecovery(action?.room.id, message.id)

  const messageTime = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
    [locale]
  )

  const settled = !message.decryptionFailed && !message.pending && !message.failed
  const companyAnswer = companyAIAnswerProjection(message)

  const companyAI =
    action?.room.companyChannel && action.accountKey
      ? companyAIStatuses[companySpaceScope(action.accountKey, action.room.companyChannel.companyId)]
      : undefined

  const privateCosRoom = action?.room && companyPrivateCosRoom(privateCosState, [action.room])
  const privateCosBinding = privateCosState?.view.state === 'ready' ? privateCosState.view.binding : undefined

  // The Chief of Staff's no-answer line ("needs Protons", "Stopped."): said in the reader's language.
  // A channel requires its shared-agent thread reply; a private room requires the exact current
  // platform binding and its private agent. A room marker or matching English text alone is never enough.
  const companyStatus = action?.room.companyChannel
    ? companyAIThreadStatus(message, companyAI)
    : privateCosRoom
      ? companyAIPrivateCosStatus(message, privateCosBinding?.agentUserId)
      : undefined

  const companyAgent = Boolean(
    (!message.own &&
      companyAnswer &&
      action?.room.companyChannel?.companyId === companyAnswer.companyId &&
      action.room.companyChannel.channelId === companyAnswer.channelId &&
      (!companyAI || companyAI.agent.userId === message.sender)) ||
    companyStatus
  )

  const agent = Boolean(!message.own && (action?.agentUserIds?.includes(message.sender) || companyAgent))
  const authenticatedBotNotice = message.appBot?.authenticated === true && message.appBot.kind === 'notice'
  // An assistant's notice (it held a reply it couldn't quote) is a quiet status line, not an
  // answer: no answer row, so nothing offers to ask its message again without the quote.
  const status = (agent && Boolean(message.notice)) || authenticatedBotNotice || Boolean(companyStatus)
  // In its own private chat the assistant's answers are bare text, with no name above them.
  const ownAssistant = Boolean(!message.own && action?.assistantEligible && message.sender === action.assistantUserId)

  // A web link's preview card under the text (link-preview-card.tsx): plain chats only, never
  // under a status line, a check-in card, a bot's own layout or the private-CoS greeting.
  const previewLink =
    action && !status && !botApi && !privateCosGreeting && !(message.checkIn && ownAssistant)
      ? matrixMessagePreviewLink(message, action.room.encrypted)
      : null

  const person = !message.own && !agent && message.sender !== action?.assistantUserId
  // A group shows who is talking: a name over a run's first bubble, a face beside its last. A
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  const group = Boolean(action?.room && matrixRoomShowsSenders(action.room))
  const senderMember = action?.members?.find(member => member.userId === message.sender)
  const senderAgent = action?.agents?.find(value => value.userId === message.sender)
  // Team Space reads like Slack: every message on the left, edge to edge, and each run opens on
  // the sender's face, name and time. A new day starts a new run under its day line.
  const flat = Boolean(action?.room && isTeamSpaceRoom(action.room))
  const savedScope = Boolean(action?.room.companyChannel || action?.room.companyConversation)
  const flatRunStart = runStart !== false || Boolean(dayStart)

  const mentioned = Boolean(
    !message.own &&
      action?.ownerUserId &&
      (message.mentions?.room || message.mentions?.userIds.includes(action.ownerUserId))
  )

  const projectedSaved = Boolean(
    savedScope && action?.savedMessages?.records.some(saved =>
      saved.room_id === action.room.id && saved.event_id === message.id)
  )

  const saved = savedOverride ?? projectedSaved

  useEffect(() => {
    if (savedOverride === projectedSaved) {
      setSavedOverride(null)
    }
  }, [projectedSaved, savedOverride])

  const menuLabel = [
    t.matrixShell.messageActions,
    t.matrixShell.messagePosition(position),
    Number.isFinite(message.timestamp) ? messageTime.format(message.timestamp) : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const name =
    message.sender === action?.assistantUserId
      ? action.assistantName
      : companyAgent
        ? (companyAI?.agent.displayName ?? matrixPersonLine(message.sender, people))
        : matrixPersonLine(message.sender, people)

  const ready = Boolean(action?.composer?.ready)
  const assistantChat = Boolean(action?.room.assistant && action.assistantEligible)
  const text = botApi?.photo || message.attachment || message.redacted ? '' : message.body

  // Matrix's own features act on a message the server has (never a local echo, a local turn
  // still on its way, an unreadable or a deleted message), in a chat you are in, encrypted or
  // plain (0.20), as long as it came the way its room sends (never plaintext in an encrypted one).
  const actionable = Boolean(
    action &&
    settled &&
    !message.redacted &&
    message.id.startsWith('$') &&
    action.room.membership === 'join' &&
    (message.encrypted || !action.room.encrypted)
  )

  const stableMessageLinkTarget = actionable && action?.room.companyChannel
    ? {
        companyId: action.room.companyChannel.companyId,
        roomId: action.room.id,
        eventId: message.id,
        ...(action.threadRootId && action.threadRootId !== message.id ? { threadRootId: action.threadRootId } : {})
      }
    : undefined

  const stableMessageLink = validMatrixMessageLinkTarget(stableMessageLinkTarget)
    ? matrixMessageLink(stableMessageLinkTarget)
    : undefined

  const pinned = Boolean(action?.pinnedMessages?.entries.some(entry => entry.eventId === message.id))

  const onPin = actionable && action?.pinnedMessages?.canChange
    ? () => {
        setPinning(true)
        void window.atumMatrix
          .command({ kind: 'pinMessage', roomId: action.room.id, eventId: message.id, pinned: !pinned })
          .catch(action.fail)
          .finally(() => setPinning(false))
      }
    : undefined

  // A person's words in a public company channel can become a task that links back here.
  const captureCard = action?.captureCard

  const toCard =
    captureCard && stableMessageLink && text && !message.attachment && !message.companyFile && !botApi?.photo && !status
      ? {
          busy: captureCard.busy,
          label: matrixCompanyBoardCopy(locale).turnIntoTask,
          onSelect: () => {
            setToCardFailed(false)
            void captureCard
              .capture(text, stableMessageLink)
              .then(cardId => cardId && setToCardAdded(cardId))
              .catch(() => setToCardFailed(true))
          }
        }
      : undefined

  const nameOf = (userId: string) =>
    userId === action?.ownerUserId
      ? t.dm.you
      : userId === action?.assistantUserId
        ? (action.assistantName ?? matrixPersonLine(userId, people))
        : matrixPersonLine(userId, people)

  const eventCommand = (kind: 'download' | 'resend' | 'discard') =>
    action &&
    void window.atumMatrix
      .command(
        kind === 'download'
          ? {
              kind,
              roomId: action.room.id,
              eventId: message.id,
              ...(message.companyFile ? { companyFile: true as const } : {})
            }
          : { kind, roomId: action.room.id, eventId: message.id }
      )
      .catch(action.fail)

  const react = (key: string, reacted: boolean) =>
    action &&
    void window.atumMatrix
      .command({ kind: 'react', roomId: action.room.id, eventId: message.id, key, reacted })
      .catch(action.fail)

  // The quick reactions open toward the column: from the answer row's start, from a toolbar's end.
  const picker = (align: 'end' | 'start') =>
    actionable ? <MatrixReactionPicker align={align} onReact={react} reactions={message.reactions} /> : undefined

  const onReply = actionable && action?.composer?.replies ? () => action.composer?.reply(message) : undefined
  const threadSummary = action?.threads?.find(thread => thread.root.id === message.id)

  const onThread =
    actionable && action?.openThread && !message.thread && !action.threadRootId
      ? () => action.openThread?.(message.id)
      : undefined

  const savedAction = savedScope && actionable && action?.savedMessages?.writable
    ? {
        active: saved,
        busy: savedPending,
        label: saved ? savedCopy.remove : savedCopy.save,
        onSelect: () => {
          const next = !saved
          setSavedPending(true)
          void window.atumMatrix.command({
            kind: 'savedMessage',
            roomId: action.room.id,
            eventId: message.id,
            saved: next
          }).then(() => setSavedOverride(next)).catch(action.fail).finally(() => setSavedPending(false))
        }
      }
    : undefined

  // An unanswered message on the room path runs in place, without posting a second copy;
  // anything else is asked again with the same words, through the message box.
  const runInPlace = Boolean(action?.room.assistant && action.hermes && !message.turn && !answered && !local)

  // A file you sent can be run in place too (the assistant reads it); asking again needs words.
  const retryOwn =
    !message.own || !assistantChat
      ? undefined
      : runInPlace
        ? () => {
            setPending(true)
            void window.atumMatrix
              .invokeHermes(action!.room.id, message.id, locale)
              .then(setResult)
              .catch(action!.fail)
              .finally(() => setPending(false))
          }
        : text
          ? () => action?.composer?.resend(message.body)
          : undefined

  const retryOwnDisabled = runInPlace ? pending || action?.hermes !== 'ready' || action.listening : !ready

  const deleteFailed = message.failed && action && !local
    ? async () => {
        if (isOutgoingEcho(message.id)) {
          dropOutgoingEchoes([message.id])

          return
        }

        await window.atumMatrix.command({ kind: 'discard', roomId: action.room.id, eventId: message.id })
      }
    : undefined

  // Lines under someone else's message start where the bubble starts, past its avatar.
  const underText = message.own || flat || !group ? '' : 'ps-9'

  // An answer right under its question needs no quote. Inside the flat thread, the root is
  // already visible; only an interoperable client that quoted a different reply needs one.
  const threadQuote = Boolean(action?.threadRootId && message.replyTo !== action.threadRootId)

  const quote = Boolean(
    message.replyTo &&
    (threadQuote ||
      (!action?.threadRootId && (!consecutiveReply || message.thread || (!agent && !message.resultFor)))) &&
    !message.decryptionFailed &&
    !message.redacted
  )

  const forwardableKind = message.own || person || (agent && !status && !message.interim && !(message.checkIn && ownAssistant))

  const onForward = action?.forward && actionable && forwardableKind && !message.notice && !message.progress &&
    !message.companyFile && (Boolean(text) || message.attachment) && !(botApi?.photo && !message.attachment)
    ? () => action.forward?.(message, message.own ? t.dm.you : (name ?? message.sender))
    : undefined

  const ownMenu =
    message.own && action && (settled || message.failed) && !message.redacted && (text || retryOwn || actionable || deleteFailed) ? (
      <MatrixMessageMenu
        deleteNote={
          assistantChat
            ? chat.deleteMessageAssistantNote(action.assistantName ?? t.matrixShell.assistantName)
            : undefined
        }
        findDisabled={pending || action.hermes === 'running' || recovery.pending}
        kind="own"
        label={menuLabel}
        link={stableMessageLink}
        onDelete={
          actionable
            ? () =>
                window.atumMatrix
                  .command({ kind: 'redact', roomId: action.room.id, eventId: message.id })
                  .then(() => undefined)
            : deleteFailed
        }
        onEdit={actionable && text && ready ? () => action.composer?.editMessage(message) : undefined}
        onFindAnswer={action.recover && action.room.assistant && !local && !answered ? recovery.recover : undefined}
        onForward={onForward}
        onOpenChange={setMenuOpen}
        onPin={onPin}
        onRetry={retryOwn}
        open={menuOpen}
        pinned={pinned}
        pinning={pinning}
        retryDisabled={retryOwnDisabled}
        saved={savedAction}
        text={text}
        toCard={toCard}
      />
    ) : undefined

  const reportMenu =
    person && action && actionable && message.sender !== action.ownerUserId ? (
      <MatrixMessageMenu
        kind="report"
        label={menuLabel}
        link={stableMessageLink}
        onForward={onForward}
        onOpenChange={setMenuOpen}
        onPin={onPin}
        onReport={reason =>
          window.atumMatrix
            .command({
              kind: 'reportEvent',
              roomId: action.room.id,
              eventId: message.id,
              userId: message.sender,
              ...(reason ? { reason } : {})
            })
            .then(() => setReported(true))
        }
        open={menuOpen}
        pinned={pinned}
        pinning={pinning}
        reported={reported}
        saved={savedAction}
        text={text}
        toCard={toCard}
      />
    ) : person && action && actionable && text ? (
      <MatrixMessageMenu
        kind="report"
        label={menuLabel}
        link={stableMessageLink}
        onForward={onForward}
        onOpenChange={setMenuOpen}
        onPin={onPin}
        open={menuOpen}
        pinned={pinned}
        pinning={pinning}
        saved={savedAction}
        text={text}
        toCard={toCard}
      />
    ) : undefined

  // Your assistant's and other agents' answers get the same floating toolbar as any message.
  // Notices, working lines and a check-in card are not answers.
  const answer = Boolean(
    agent && !status && !message.interim && action && settled && (text || message.attachment) && !(message.checkIn && ownAssistant)
  )

  // Right-click opens the message's "…" menu, as in Element. A selection, a link or a field
  // keeps the browser's own menu.
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null

    if (
      !(ownMenu || reportMenu || answer) ||
      !window.getSelection()?.isCollapsed ||
      target?.closest('a, button, input, textarea, [contenteditable="true"]')
    ) {
      return
    }

    event.preventDefault()
    setMenuOpen(true)
  }

  // In a group the sender's face sits beside the last bubble of their run, level with its bottom
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  const showAvatar = group && !message.own && !status && (person || agent) && runEnd !== false
  // Slack's run header: your own name too, since every message sits on the same side.
  const flatName = message.own ? (senderMember?.name ?? t.dm.you) : (name ?? message.sender)
  const time = Number.isFinite(message.timestamp) ? matrixClock(message.timestamp, locale) : ''
  const fullTime = time ? matrixFullTime(message.timestamp, locale) : ''

  const timestamp = time ? (
    <MatrixTimestamp
      className="shrink-0 text-xs text-(--atum-ink-faint)"
      full={fullTime}
      timestamp={message.timestamp}
      value={time}
    />
  ) : undefined

  const timeEligible = settled && !status && !message.progress && !(message.checkIn && ownAssistant)
  const hoverTime = !flat && timeEligible && runEnd === false && !answer ? timestamp : undefined
  const personEdited = Boolean(message.edited && !agent && !botApp)

  const editTime = personEdited && message.editedAt !== undefined
    ? chat.editedAt(
        matrixNewDay(message.timestamp, message.editedAt)
          ? matrixFullTime(message.editedAt, locale)
          : matrixClock(message.editedAt, locale)
      )
    : undefined

  // Slack's line shows who replied (in the order they first did), not the root's author unless they
  // answered in the thread too. The Chief of Staff wears its channel face; your agents their roster one.
  const threadSummaryFaces = [...new Set((threadSummary?.replies ?? []).map(reply => reply.sender))]
    .slice(0, THREAD_SUMMARY_FACES_MAX)
    .map(userId => {
      const member = action?.members?.find(value => value.userId === userId)
      const cos = companyAI?.agent.userId === userId ? companyAI.agent : undefined

      // A face shows the person's own initial, yours included (never the "You" label's).
      return {
        id: userId,
        name: cos?.displayName ?? member?.name ?? nameOf(userId),
        avatarMxc: member?.avatarMxc,
        agent: action?.agents?.find(value => value.userId === userId),
        ...(cos ? { companyAIPrincipal: cos.principal } : {})
      }
    })

  // A Chief of Staff status-only line with nothing to tell the reader (couldnt_confirm) is not drawn at
  // all. A reply carrying an answer projection never resolves to a status, so it always draws.
  if (companyStatus && !companyAIThreadStatusShown(companyStatus)) {
    return null
  }

  return (
    <MessagePrimitive.Root
      className={flat
        ? `group/message relative flex flex-col items-stretch gap-1 ps-[3.75rem] pe-5 hover:bg-(--atum-row-hover) ${mentioned ? 'bg-(--atum-row-hover)' : ''} ${
            flatRunStart ? 'pt-2 pb-1' : 'py-0.5'
          }`
        : `group/message relative flex flex-col gap-1 ${message.own ? 'items-end' : 'items-start'} ${mentioned ? 'rounded-(--atum-r-card) bg-(--atum-row-hover)' : ''} ${
            // A run from one person reads as one block: its later messages sit close.
            !message.own && runStart === false ? '-mt-4 pt-0 pb-2' : 'py-2'
          }`}
      data-matrix-mentioned={mentioned || undefined}
      data-matrix-message-id={message.id}
      data-matrix-run-end={!message.own && runEnd !== false ? true : undefined}
      data-slot={message.own ? 'aui_user-message-root' : 'aui_assistant-message-root'}
      data-team-space-run-start={flat && flatRunStart ? true : undefined}
      onContextMenu={onContextMenu}
    >
      {message.id === action?.firstUnreadId && !dayStart && (
        <TeamSpaceNewMessagesDivider flat={flat} onJump={() => jumpToMessage(message.id)} />
      )}
      {dayStart && (
        <TeamSpaceDayDivider
          flat={flat}
          onJumpToNew={message.id === action?.firstUnreadId ? () => jumpToMessage(message.id) : undefined}
          timestamp={message.timestamp}
        />
      )}
      {flat && flatRunStart && (
        <div className="relative flex min-w-0 items-baseline gap-2" data-team-space-sender>
          <span className="absolute -start-10 top-0.5" data-matrix-avatar={message.sender}>
            {companyAgent ? (
              <CompanyAIAvatar
                className="size-9 shrink-0 text-sm leading-none"
                name={companyAI?.agent.displayName ?? 'Chief of Staff'}
                principal={companyAI?.agent.principal ?? message.sender}
              />
            ) : (
              <MatrixPersonAvatar
                agent={senderAgent}
                avatarMxc={senderMember?.avatarMxc}
                className="size-9 shrink-0 text-sm leading-none"
                id={message.sender}
                name={flatName}
                presence={false}
              />
            )}
          </span>
          <span className="truncate text-[0.9375rem] font-bold text-(--atum-ink)">{flatName}</span>
          {timestamp}
        </div>
      )}
      {group && runStart && (person || agent) && !flat && <MatrixSenderLine name={name ?? message.sender} />}
      <div
        className={
          flat
            ? 'relative flex w-full min-w-0'
            : `flex w-full min-w-0 gap-1 ${message.own ? 'flex-row-reverse items-start' : 'items-start gap-2'}`
        }
      >
        {/* Slack shows a run's later times in the gutter on hover. */}
        {flat && !flatRunStart && time && (
          <MatrixTimestamp
            className="absolute -start-11 top-0.5 w-10 text-end text-[0.6875rem] text-(--atum-ink-faint) opacity-0 group-hover/message:opacity-100"
            full={fullTime}
            timestamp={message.timestamp}
            value={time}
          />
        )}
        {!message.own && !flat && group && (
          <span
            className="flex w-7 shrink-0 justify-center self-end"
            data-matrix-avatar={showAvatar ? message.sender : undefined}
            data-matrix-face-gutter
          >
            {showAvatar &&
              (companyAgent ? (
                <CompanyAIAvatar
                  className="size-7 shrink-0 text-[0.6875rem] leading-none"
                  name={companyAI?.agent.displayName ?? 'Chief of Staff'}
                  principal={companyAI?.agent.principal ?? message.sender}
                />
              ) : botApp ? (
                // An app keeps its squircle face (STYLE.md §5), drawn from its catalog entry.
                <AppCatalogAvatar app={botApp} className="size-7 text-[0.6875rem] leading-none" locale={locale} tile />
              ) : (
                <MatrixPersonAvatar
                  agent={senderAgent}
                  avatarMxc={senderMember?.avatarMxc}
                  className="size-7 shrink-0 text-[0.6875rem] leading-none"
                  id={message.sender}
                  name={name ?? message.sender}
                  presence={false}
                />
              ))}
          </span>
        )}
        <div
          className={flat ? 'min-w-0 flex-1' : `min-w-0 ${message.own ? 'max-w-full' : 'max-w-[78%]'}`}
          data-matrix-bubble-column={flat ? undefined : true}
          data-slot={message.own ? 'aui_user-bubble-actions' : 'aui_assistant-message-content'}
        >
          {message.forwarded && (
            <p className="mb-1 flex items-center gap-1 text-xs text-(--atum-ink-muted)" data-matrix-forwarded>
              <Share aria-hidden className="size-3.5" />
              {chat.forwarded}
            </p>
          )}
          {message.redacted ? (
            <MatrixDeletedMessage />
          ) : botApi?.photo && botApp ? (
            <>
              <MatrixBotApiPhotoView
                appId={botApp.app_id}
                body={message.body}
                caption={botApi.photo.caption}
                eventId={message.id}
                fallbackText={botApi.fallbackText}
                formattedBody={botApi.formattedBody}
                locale={locale}
                photo={botApi.photo}
                roomId={action!.room.id}
              />
              <MatrixBotApiKeyboard keyboard={botApi.keyboard} />
            </>
          ) : message.attachment && !message.decryptionFailed ? (
            <MatrixFileCard
              action={
                settled ? <MatrixFileSave name={message.body} onSave={() => eventCommand('download')} /> : undefined
              }
              name={message.body}
              size={message.attachmentSize}
            />
          ) : (
            <>
            <div
              className={
                flat && !status
                  ? 'matrix-flat-message whitespace-pre-wrap break-words'
                  : message.own
                    ? `composer-human-message whitespace-pre-wrap break-words${previewLink ? ' ms-auto w-fit max-w-full' : ''}`
                    : status || (message.checkIn && ownAssistant)
                      ? 'py-1'
                      : `matrix-chat-bubble whitespace-pre-wrap break-words${previewLink ? ' w-fit max-w-full' : ''}`
              }
            >
              {quote && (
                <MatrixReplyQuote
                  label={
                    reply?.own
                      ? t.dm.you
                      : reply?.sender === action?.assistantUserId
                        ? action?.assistantName
                        : reply
                          ? matrixPersonLine(reply.sender, people)
                          : t.dm.reply
                  }
                  reply={reply}
                  // The agent removes only its own working lines and a repeated interim remark: no tombstone.
                  silentWhenRedacted={Boolean(reply && reply.sender === action?.assistantUserId)}
                  thread={Boolean(message.thread)}
                />
              )}
              {message.decryptionFailed ? (
                <MatrixUndecryptableMessage
                  backupAvailable={action?.backupAvailable === true}
                  locale={locale}
                  onDevices={action?.reviewDevices ? () => action.reviewDevices?.(false) : undefined}
                  onRestore={action?.restoreMessages}
                  onReview={action?.reviewDevices ? () => action.reviewDevices?.(false) : undefined}
                  onVerify={action?.reviewDevices ? () => action.reviewDevices?.(true) : undefined}
                  reason={matrixMessageDecryptionReason(message)}
                  senderName={name && name !== message.sender && !name.startsWith('@') ? name : undefined}
                />
              ) : message.own && !flat ? (
                <MessagePrimitive.Parts />
              ) : status ? (
                <p className="text-sm text-(--atum-ink-muted)" data-company-ai-status={companyStatus} data-matrix-notice>
                  {companyStatus ? (
                    <CompanyAIThreadStatusLine
                      accountKey={action?.accountKey ?? ''}
                      companyId={action?.room.companyChannel?.companyId ?? privateCosCompanyId ?? ''}
                      status={companyStatus}
                    />
                  ) : authenticatedBotNotice
                    ? appBotOutcomeText(
                        locale,
                        message.appBot?.code ?? null,
                        message.appBot?.action && 'app' in message.appBot.action
                          ? message.appBot.action.app
                          : (name ?? 'Atum')
                      )
                    : message.cloudStatus?.code === 'failed'
                      ? // A failed turn is platform state: show Atum's neutral words, not the
                        // body's fallback. Other codes keep their body, which carries details
                        // (device names, attachment kind) the bare code does not.
                        matrixAgentStatusText('failed', locale)
                      : message.body}
                  {authenticatedBotNotice && message.appBot?.action?.kind === 'open_setup' && (
                    <Button
                      className="ms-2"
                      onClick={() => action && void action.openAppBot(message.appBot!.appId)}
                      size="sm"
                      type="button"
                      variant="text"
                    >
                      {appChatCopy(locale).startBot}
                    </Button>
                  )}
                  {authenticatedBotNotice && message.appBot?.action?.kind === 'connect_account' && (
                    <Button
                      className="ms-2"
                      onClick={() => connectLimitedAppBot(message.appBot!.appId, action?.fail)}
                      size="sm"
                      type="button"
                      variant="text"
                    >
                      {appChatCopy(locale).connectAccount(
                        'app' in message.appBot.action ? message.appBot.action.app : ''
                      )}
                    </Button>
                  )}
                  {authenticatedBotNotice && message.appBot?.action?.kind === 'open_bot_dm' && (
                    <Button
                      className="ms-2"
                      onClick={() => action && void action.openAppBot(message.appBot!.appId)}
                      size="sm"
                      type="button"
                      variant="text"
                    >
                      {appChatCopy(locale).openBot(message.appBot.action.app)}
                    </Button>
                  )}
                  {authenticatedBotNotice && message.appBot?.action?.kind === 'open_app_route' && (
                    <Button
                      className="ms-2"
                      onClick={() =>
                        void window.atumMatrix
                          .command({ kind: 'selectApp', appId: message.appBot!.appId })
                          .catch(action?.fail)
                      }
                      size="sm"
                      type="button"
                      variant="text"
                    >
                      {appChatCopy(locale).openBot(message.appBot.action.app)}
                    </Button>
                  )}
                </p>
              ) : message.checkIn && ownAssistant ? (
                // A check-in the assistant posted on its own: its line, one offer, two answers.
                <MatrixCheckInCard
                  nudge={message.checkIn}
                  onAct={ready ? text => action?.composer?.resend(text) : undefined}
                  postedAt={Number.isFinite(message.timestamp) ? message.timestamp : undefined}
                />
              ) : botApi ? (
                <>
                  <MatrixBotApiText body={message.body} formattedBody={botApi.formattedBody} />
                  <MatrixBotApiKeyboard keyboard={botApi.keyboard} />
                </>
              ) : privateCosGreeting ? (
                <MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={privateCosGreeting} />
              ) : flat && message.mentions && action ? (
                <TeamSpaceMentionContent message={message} people={people} roomId={action.room.id} />
              ) : (
                // People, apps and older history write markdown too; the host opens web links
                // in the browser and renders nothing unsafe.
                <MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={message.body} />
              )}
              {companyAgent && companyAnswer && (
                <CompanyAIAnswer
                  answer={companyAnswer}
                  channelName={
                    action?.room.companyChannel?.channelId === companyAnswer.channelId ? action?.room.name : undefined
                  }
                  citationContext={{
                    senderName: citation =>
                      citation.kind === 'channel' ? action?.citationSenderName?.(citation.eventId) : undefined
                  }}
                />
              )}
            </div>
            {previewLink && action && (
              <MatrixLinkPreviewCard
                message={message}
                own={message.own && !flat}
                roomEncrypted={action.room.encrypted}
                roomId={action.room.id}
              />
            )}
            </>
          )}
        </div>
        {/* Your own message: React, Reply and the "…" beside the bubble, on hover or focus. */}
        {message.own && !flat && (
          <MatrixMessageToolbar
            menu={ownMenu}
            onForward={onForward}
            onReply={onReply}
            onThread={onThread}
            placement="inline"
            react={picker('end')}
            threadLabel={threadCopy.replyInThread}
            time={hoverTime}
          />
        )}
      </div>
      {/* Someone else's message, or an answer: the same toolbar in its top corner. In Team Space
          yours has it there too, as in Slack. */}
      {(!message.own || flat) && !agent && (
        <MatrixMessageToolbar
          menu={message.own ? ownMenu : reportMenu}
          onForward={onForward}
          onReply={onReply}
          onThread={onThread}
          placement="corner"
          react={picker('end')}
          threadLabel={threadCopy.replyInThread}
          time={hoverTime}
        />
      )}
      {personEdited && !message.redacted && (flat || runEnd === false) && (
        <Tip label={editTime}>
          <span className={`text-xs text-(--atum-ink-faint) ${underText}`} data-matrix-edited tabIndex={editTime ? 0 : undefined}>
            {flat ? chat.edited : mobileChatCopy[locale].edited}
          </span>
        </Tip>
      )}
      {savedScope && saved && (
        <Tip label={savedCopy.marker}>
          <span className={underText} data-matrix-saved-message>
            <BookmarkFilled aria-hidden className="size-3.5 text-(--atum-accent)" />
            <span className="sr-only">{savedCopy.marker}</span>
          </span>
        </Tip>
      )}
      {pinned && !message.redacted && (
        <span className={underText}>
          <PinnedMessageMarker />
        </span>
      )}
      {message.reactions && message.reactions.length > 0 && !message.redacted && !flat && (
        <div className={underText}>
          <MatrixReactionChips disabled={!actionable} nameOf={nameOf} onToggle={react} reactions={message.reactions} />
        </div>
      )}
      {/* Slack's order under a message: the reactions row, then the thread line on its own row. */}
      {flat && !message.redacted && (message.reactions?.length ?? 0) > 0 && (
        <div className="flex w-fit max-w-full items-center gap-(--ak-s1)" data-team-space-message-meta>
          <MatrixReactionChips disabled={!actionable} nameOf={nameOf} onToggle={react} reactions={message.reactions!} />
        </div>
      )}
      {flat && !message.redacted && threadSummary && !message.thread && action?.openThread && (
        <TeamSpaceThreadSummary
          faces={threadSummaryFaces}
          lastReplyAt={threadSummary.lastActivityAt}
          messageId={message.id}
          onOpen={() => action.openThread?.(message.id)}
          replyCount={threadSummary.replyCount}
          unread={threadSummary.unread}
        />
      )}
      {threadSummary && !message.thread && action?.openThread && !flat && (
        <Button
          className={underText}
          data-matrix-thread-summary={message.id}
          onClick={() => action.openThread?.(message.id)}
          size="sm"
          variant="text"
        >
          <Messages aria-hidden className="size-4" />
          {threadCopy.replies(threadSummary.replyCount)}
          {threadSummary.unread && (
            <span aria-label={threadCopy.unread} className="size-1.5 rounded-full bg-(--atum-accent)" />
          )}
        </Button>
      )}
      {reported && (
        <span className={`text-xs text-(--atum-ink-muted) ${underText}`} role="status">
          {chat.reportSent}
        </span>
      )}
      {message.own && appBotOutcome?.outcome.state === 'notice' && (
        <NoticeBand
          className="max-w-[42rem]"
          data-app-bot-outcome={appBotOutcome.outcome.code ?? 'notice'}
          role="status"
          tone="notice"
        >
          <span>
            {appChatCopy(locale).privateOutcome} ·{' '}
            {appBotOutcomeText(
              locale,
              appBotOutcome.outcome.code,
              appBotOutcome.outcome.action && 'app' in appBotOutcome.outcome.action
                ? appBotOutcome.outcome.action.app
                : 'Atum'
            )}
          </span>
          {appBotOutcome.outcome.action?.kind === 'open_setup' && (
            <Button
              className="ms-2"
              onClick={() => action && void action.openAppBot(appBotOutcome.appId)}
              size="sm"
              type="button"
              variant="text"
            >
              {appChatCopy(locale).startBot}
            </Button>
          )}
          {appBotOutcome.outcome.action?.kind === 'connect_account' && (
            <Button
              className="ms-2"
              onClick={() => connectLimitedAppBot(appBotOutcome.appId, action?.fail ? () => action.fail() : undefined)}
              size="sm"
              type="button"
              variant="text"
            >
              {appChatCopy(locale).connectAccount(
                'app' in appBotOutcome.outcome.action ? appBotOutcome.outcome.action.app : ''
              )}
            </Button>
          )}
          {appBotOutcome.outcome.action?.kind === 'open_bot_dm' && (
            <Button
              className="ms-2"
              onClick={() => action && void action.openAppBot(appBotOutcome.appId)}
              size="sm"
              type="button"
              variant="text"
            >
              {appChatCopy(locale).openBot(appBotOutcome.outcome.action.app)}
            </Button>
          )}
          {appBotOutcome.outcome.action?.kind === 'open_app_route' && (
            <Button
              className="ms-2"
              onClick={() =>
                void window.atumMatrix.command({ kind: 'selectApp', appId: appBotOutcome.appId }).catch(action?.fail)
              }
              size="sm"
              type="button"
              variant="text"
            >
              {appChatCopy(locale).openBot(appBotOutcome.outcome.action.app)}
            </Button>
          )}
        </NoticeBand>
      )}
      {/* Sending: a small clock under your message, as in any messaging app (the words are
          for screen readers). */}
      {message.pending && !local && (
        <span
          aria-label={copy.pending}
          className="inline-flex text-(--atum-ink-faint)"
          data-matrix-sending
          role="status"
        >
          <Clock aria-hidden className="size-3" />
        </span>
      )}
      {message.failed && !local && isOutgoingEcho(message.id) && (
        <MatrixFailedSend
          onRetry={() => {
            dropOutgoingEchoes([message.id])
            action?.composer?.resend(message.body)
          }}
        />
      )}
      {message.failed && !local && !isOutgoingEcho(message.id) && (
        <MatrixFailedSend onRetry={() => eventCommand('resend')} />
      )}
      {local && <LocalTurnStatus local={local} />}
      {message.own && !local && settled && !message.redacted && (
        <MatrixSendState
          agents={action?.agents}
          assistantChat={Boolean(action?.room.assistant)}
          edited={personEdited && runEnd !== false ? (
            <Tip label={editTime}>
              <span data-matrix-edited tabIndex={editTime ? 0 : undefined}>{mobileChatCopy[locale].edited}</span>
            </Tip>
          ) : undefined}
          latest={message.id === action?.latestOwnId}
          members={action?.members}
          message={message}
          people={people}
          time={!flat && timeEligible && runEnd !== false ? timestamp : undefined}
        />
      )}
      {!message.own && !flat && timeEligible && runEnd !== false && !answer && timestamp && (
        <span className={`inline-flex items-center gap-1 text-xs text-(--atum-ink-faint) ${underText}`} data-matrix-run-time>
          {timestamp}
          {personEdited && (
            <>
              <span aria-hidden>·</span>
              <Tip label={editTime}>
                <span data-matrix-edited tabIndex={editTime ? 0 : undefined}>{mobileChatCopy[locale].edited}</span>
              </Tip>
            </>
          )}
        </span>
      )}
      {result && (
        <p
          className={invocationNoticeVisible(result.state) ? 'text-xs text-(--atum-ink-muted)' : 'sr-only'}
          data-matrix-invocation-notice={result.state}
          role="status"
        >
          {invocationCopy(result, locale)}
        </p>
      )}
      {toCardFailed && (
        <p className="text-xs text-(--atum-ink-muted)" data-company-board-capture-failed role="status">
          {matrixCompanyBoardCopy(locale).taskCaptureFailed}
        </p>
      )}
      {toCardAdded && !toCardFailed && (
        <p className="text-xs text-(--atum-ink-muted)" data-company-board-capture-added role="status">
          {matrixCompanyBoardCopy(locale).taskAdded}
          {captureCard && (
            <>
              {' · '}
              <Button
                className="underline decoration-current"
                onClick={() => captureCard.open(toCardAdded)}
                size="inline"
                variant="link"
              >
                {matrixCompanyBoardCopy(locale).openTask}
              </Button>
            </>
          )}
        </p>
      )}
      <ResultRecoveryOutcome recovery={recovery} />
      {answer && action && (
        <MatrixAnswerToolbar
          alignClass={underText}
          fail={action.fail}
          key={`${action.ownerUserId}:${action.ownerDeviceId}:${action.room.id}:${message.id}`}
          latest={message.id === action.latestAnswerId}
          link={stableMessageLink}
          menuLabel={menuLabel}
          messageId={message.id}
          onForward={onForward}
          onOpenChange={setMenuOpen}
          onPin={onPin}
          onReact={actionable ? react : undefined}
          onReply={onReply}
          onRetry={ownAssistant && question?.body ? () => action.composer?.resend(question.body) : undefined}
          onThread={onThread}
          open={menuOpen}
          pinned={pinned}
          pinning={pinning}
          react={picker('end')}
          reactions={message.reactions}
          readAloud={ownAssistant && Boolean(text)}
          retryDisabled={!ready}
          roomId={action.room.id}
          saved={savedAction}
          spoken={message.body}
          text={text}
          threadLabel={threadCopy.replyInThread}
          time={timestamp}
        />
      )}
      {flat && threadReplies !== undefined && threadReplies > 0 && <TeamSpaceRepliesDivider count={threadReplies} />}
    </MessagePrimitive.Root>
  )
}

/** R9's answer row (Copy, good, bad, Retry) plus the ordinary Reply/"…" toolbar. Read-aloud
 * state lives here because closing its menu must not stop the audio. */
function MatrixAnswerToolbar({
  alignClass,
  fail,
  latest,
  link,
  menuLabel,
  messageId,
  onOpenChange,
  onForward,
  onReact,
  onPin,
  onReply,
  onRetry,
  onThread,
  open,
  reactions,
  pinned,
  pinning,
  react,
  readAloud,
  retryDisabled,
  roomId,
  saved,
  spoken,
  text,
  time,
  threadLabel
}: {
  alignClass: string
  fail(): void
  latest: boolean
  link?: string
  menuLabel: string
  messageId: string
  onOpenChange(open: boolean): void
  onForward?: () => void
  onReact?: (key: string, reacted: boolean) => void
  onPin?: () => void
  onReply?: () => void
  onRetry?: () => void
  onThread?: () => void
  open: boolean
  reactions?: readonly MatrixReaction[]
  pinned: boolean
  pinning: boolean
  react?: ReactNode
  /** Your own assistant's answers can be read aloud; another agent's cannot. */
  readAloud: boolean
  retryDisabled: boolean
  roomId: string
  saved?: MatrixMessageSavedAction
  spoken: string
  text: string
  time?: ReactNode
  threadLabel: string
}) {
  const reading = useMatrixReadAloud({ fail, messageId, roomId, text: spoken })
  const canRead = readAloud && reading.available
  const reacted = (key: string) => Boolean(reactions?.some(reaction => reaction.key === key && reaction.own))
  const chat = useChatCopy()

  return (
    <>
      <div
        className={`${alignClass} mt-(--ak-s1) flex items-center gap-(--ak-s1) text-(--ak-ink-4)`}
        data-latest={latest || undefined}
        data-matrix-answer-actions
      >
        {time}
        <span className={`flex items-center gap-(--ak-s1) transition-opacity motion-reduce:transition-none ${
          latest ? '' : 'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100'
        }`}>
          <CopyButton appearance="icon" buttonSize="icon-sm" className="ak-iconbtn ak-iconbtn--sm" haptic={false} iconClassName="ak-icon ak-icon--sm" text={text} />
          <Tip label={chat.goodAnswer}>
          <button
            aria-label={chat.goodAnswer}
            aria-pressed={reacted('👍')}
            className="ak-iconbtn ak-iconbtn--sm"
            disabled={!onReact}
            onClick={() => onReact?.('👍', !reacted('👍'))}
            type="button"
          >
            <ThumbsUp aria-hidden className="ak-icon ak-icon--sm" />
          </button>
          </Tip>
          <Tip label={chat.badAnswer}>
          <button
            aria-label={chat.badAnswer}
            aria-pressed={reacted('👎')}
            className="ak-iconbtn ak-iconbtn--sm"
            disabled={!onReact}
            onClick={() => onReact?.('👎', !reacted('👎'))}
            type="button"
          >
            <ThumbsDown aria-hidden className="ak-icon ak-icon--sm" />
          </button>
          </Tip>
          <Tip label={chat.retry}>
          <button
            aria-label={chat.retry}
            className="ak-iconbtn ak-iconbtn--sm"
            disabled={!onRetry || retryDisabled}
            onClick={onRetry}
            type="button"
          >
            <Refresh aria-hidden className="ak-icon ak-icon--sm" />
          </button>
          </Tip>
        </span>
      </div>
      <MatrixMessageToolbar
        menu={
          <MatrixMessageMenu
            kind="answer"
            label={menuLabel}
            link={link}
            onForward={onForward}
            onOpenChange={onOpenChange}
            onPin={onPin}
            onRetry={onRetry}
            open={open}
            pinned={pinned}
            pinning={pinning}
            readAloud={
              canRead
                ? {
                    Icon: reading.Icon,
                    busy: reading.busy,
                    label: reading.label,
                    onSelect: reading.read,
                    preparing: reading.preparing
                  }
                : undefined
            }
            retryDisabled={retryDisabled}
            saved={saved}
            text={text}
          />
        }
        onForward={onForward}
        onReply={onReply}
        onThread={onThread}
        placement="corner"
        react={react}
        reading={canRead && reading.owned}
        threadLabel={threadLabel}
      />
      {canRead && reading.failed && (
        <NoticeBand role="status" tone="failure">
          {reading.failedLabel}
        </NoticeBand>
      )}
    </>
  )
}

/** What a reply answers: the sender and a few lines of the message (a click shows it in the
 * transcript when it is loaded), or that it was deleted. A message from another app's thread
 * says so. */
function MatrixReplyQuote({
  label,
  reply,
  silentWhenRedacted = false,
  thread
}: {
  label?: string
  reply?: MatrixMessage
  silentWhenRedacted?: boolean
  thread: boolean
}) {
  const chat = useChatCopy()

  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 font-medium">
        {thread && (
          <span className="shrink-0 text-(--atum-ink-muted)" data-matrix-thread>
            {chat.inThread} ·
          </span>
        )}
        <span className="truncate">{label}</span>
      </span>
      {reply && (
        <span className="line-clamp-3 whitespace-pre-wrap wrap-break-word">
          {reply.redacted
            ? silentWhenRedacted
              ? ''
              : chat.messageDeleted
            : reply.decryptionFailed
              ? chat.undecryptable
              : reply.body}
        </span>
      )}
    </>
  )

  const className =
    'mb-2 block max-w-full border-l-2 border-(--atum-line) px-3 py-1 text-left text-sm text-(--atum-ink-soft)'

  return reply ? (
    <button
      aria-label={`${chat.quoteJump}: ${label ?? ''}`}
      className={`${className} rounded-e-(--atum-r-control) hover:bg-(--atum-hover)`}
      data-matrix-reply-quote
      onClick={() => jumpToMessage(reply.id)}
      type="button"
    >
      {body}
    </button>
  ) : (
    <blockquote className={className} data-matrix-reply-quote>
      {body}
    </blockquote>
  )
}

/** A local turn that failed, in plain words, and the one thing to do about it (only failures
 * speak here: while the agent works the chat shows it typing). */
function LocalTurnStatus({ local }: { local: NonNullable<MatrixTranscriptEntry['local']> }) {
  const { locale, t } = useI18n()
  const actions = useContext(ConversationActions)
  const [pending, setPending] = useState(false)
  const status = matrixTurnStatus(local.view, local.role, t.matrixShell)

  if (!status) {
    return null
  }

  const act = () => {
    setPending(true)

    const request =
      status.action !== 'top_up'
        ? window.atumMatrix.retryTurn(local.view.turnId)
        : actions?.topUp
          ? actions.topUp()
          : window.atumMatrix.openTopUp()

    void request.catch(() => {}).finally(() => setPending(false))
  }

  return (
    <div
      className="flex items-center gap-2 text-xs text-(--atum-ink)"
      data-matrix-turn-state={local.view.state}
      role="status"
    >
      <span>{status.text}</span>
      {status.action === 'answer_here' && <MatrixTurnHandoffActions turnId={local.view.turnId} />}
      {status.action && status.action !== 'answer_here' && (
        <Button disabled={pending} onClick={act} size="sm" variant="text">
          {status.action === 'top_up' ? matrixWalletCopy(locale).topUpMore : t.matrixShell.turnRetry}
        </Button>
      )}
    </div>
  )
}

function MatrixComposerRuntimeRef({
  initialText,
  target
}: {
  initialText?: string
  target: MutableRefObject<ComposerRuntime | null>
}) {
  const runtime = useAssistantRuntime()

  useEffect(() => {
    target.current = runtime.thread.composer

    if (initialText && !runtime.thread.composer.getState().text) {
      runtime.thread.composer.setText(initialText)
    }

    return () => {
      target.current = null
    }
  }, [initialText, runtime, target])

  return null
}

/** What the transcript may ask of the message box (launch night): ask again with the same
 * words, fill it without sending, answer one message (Reply) or change one of yours (Edit).
 * One send path for all. */
interface MatrixComposerActions {
  ready: boolean
  /** Replies go out on this chat's send path: a chat with people, or your assistant's chat on
   * this Mac (its reply reaches the assistant with the quoted message as context). */
  replies: boolean
  send(body: string): Promise<boolean>
  resend(body: string): void
  edit(body: string): void
  reply(message: MatrixMessage): void
  editMessage(message: MatrixMessage): void
  /** What the person has typed (not an edit's words), for a chat that gives way to another. */
  draft(): string
}

interface AppBotMessageOutcome {
  appId: string
  outcome: AppBotOutcome
}

/** The box is answering one message, or changing one of yours. `reask`: your newest message
 * in your assistant's chat, which it answers again once changed (append-only). */
type MatrixComposerMode =
  | { kind: 'reply'; message: MatrixMessage }
  | { kind: 'edit'; message: MatrixMessage; reask: boolean }

/** Tells the chat while you type (a standard typing notification): once as you start, again
 * while you keep going, and "stopped" when the box empties, after a pause or as you leave. */
function MatrixTypingSignal({ enabled, roomId }: { enabled: boolean; roomId: string }) {
  const text = useAuiState(state => state.composer.text)
  const typing = useRef<number | null>(null)

  const signal = useCallback(
    (value: boolean) => void window.atumMatrix.typing?.(roomId, value)?.catch(() => {}),
    [roomId]
  )

  useEffect(() => {
    const stop = () => {
      if (typing.current !== null) {
        typing.current = null
        signal(false)
      }
    }

    if (!enabled || !text.trim()) {
      stop()

      return
    }

    if (typing.current === null || Date.now() - typing.current > MATRIX_TYPING_RENEW_MS) {
      typing.current = Date.now()
      signal(true)
    }

    const pause = setTimeout(stop, MATRIX_TYPING_PAUSE_MS)

    return () => clearTimeout(pause)
  }, [enabled, signal, text])

  useEffect(
    () => () => {
      if (typing.current !== null) {
        signal(false)
      }
    },
    [signal]
  )

  return null
}

/** Typing is said again this often while you keep typing, and stops after this long a pause. */
const MATRIX_TYPING_RENEW_MS = 20_000
const MATRIX_TYPING_PAUSE_MS = 6_000

/** Who is typing (people, or your assistant while it works on your message): one quiet line above the box. */
function MatrixTypingLine({ snapshot }: { snapshot: MatrixSnapshot }) {
  const chat = useChatCopy()
  const { locale } = useI18n()
  const typing = snapshot.typing ?? []
  const people = useMatrixChatPeople(snapshot.members, snapshot.identity?.userId)

  if (typing.length === 0) {
    return null
  }

  // An official app bot's catalog name is its typing name too; a room without the bot's
  // profile name still says "Moon is typing…", never an opaque Matrix id.
  const appBotNames = new Map(
    (snapshot.apps?.apps ?? []).flatMap(app => (app.bot ? [[app.bot.user_id, app.bot.display_name] as const] : []))
  )

  const names = typing.map(userId => appBotNames.get(userId) ?? matrixPersonLine(userId, people))

  const text =
    names.length === 1
      ? chat.typingOne(names[0]!)
      : names.length <= 3
        ? chat.typingSome(new Intl.ListFormat(locale, { type: 'conjunction' }).format(names))
        : chat.typingMany

  return (
    <p
      className="pointer-events-none absolute start-4 bottom-full mb-1 max-w-[calc(100%-2rem)] truncate text-xs text-(--atum-ink-muted)"
      data-matrix-typing
    >
      {text}
    </p>
  )
}

/** What the box is doing when it is not a new message: the bar above the input that names
 * the message being answered or changed, with × to stop (Esc does the same). */
function MatrixComposerContext({
  assistantChat,
  assistantName,
  mode,
  name,
  onCancel
}: {
  assistantChat: boolean
  assistantName: string
  mode: MatrixComposerMode
  name: string
  onCancel(): void
}) {
  const chat = useChatCopy()
  const replying = mode.kind === 'reply'

  const title = replying
    ? chat.replyingTo(name)
    : mode.reask
      ? chat.editingReask(assistantName)
      : assistantChat
        ? chat.editingDisplayOnly
        : chat.editing

  return (
    <div className="flex items-center gap-2 px-1 pt-1" data-matrix-composer-context={mode.kind}>
      <span aria-hidden className="grid size-7 shrink-0 place-items-center text-(--atum-ink-muted)">
        {replying ? <ArrowBackUp className="size-4" /> : <Pencil className="size-4" />}
      </span>
      <div className="min-w-0 flex-1 border-s-2 border-(--atum-line) ps-2">
        <p className="truncate text-(length:--atum-t-control) font-medium text-(--atum-ink)">{title}</p>
        {replying && (
          <p className="truncate text-(length:--atum-t-caption) text-(--atum-ink-muted)">{mode.message.body}</p>
        )}
      </div>
      <Tip label={replying ? chat.cancelReply : chat.cancelEdit}>
        <Button
          aria-label={replying ? chat.cancelReply : chat.cancelEdit}
          onClick={onCancel}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </Tip>
    </div>
  )
}

/** The send button follows the box: muted until there are words or a staged file. A file
 * alone is sent by this button directly (the box itself has nothing to send). */
function MatrixSendButton({
  disabled,
  editing = false,
  file,
  label,
  onSendFile
}: {
  disabled: boolean
  /** Saving an edit: a check, as in other Matrix apps. */
  editing?: boolean
  file: boolean
  label: string
  onSendFile(): void
}) {
  const hasText = useAuiState(state => state.composer.text.trim().length > 0)
  const Icon = editing ? Check : ArrowUp

  // Atum Kit: the ink send circle, faint until there is something to send.
  return !hasText && file ? (
    <button
      aria-label={label}
      className="ak-iconbtn ak-iconbtn--sm ak-iconbtn--primary disabled:opacity-30"
      disabled={disabled}
      onClick={onSendFile}
      type="button"
    >
      <Icon aria-hidden className="size-4" />
    </button>
  ) : (
    <ComposerPrimitive.Send asChild>
      <button
        aria-label={label}
        className="ak-iconbtn ak-iconbtn--sm ak-iconbtn--primary disabled:opacity-30"
        disabled={disabled || !hasText}
        type="submit"
      >
        <Icon aria-hidden className="size-4" />
      </button>
    </ComposerPrimitive.Send>
  )
}

function MatrixComposer({
  assistantName,
  bind,
  blocked,
  cloudOnly,
  contextMessages,
  draftTarget,
  fail,
  onBotOutcome,
  onAppAction,
  onModelSettings,
  onSent,
  onSubscriptions,
  notice,
  room,
  snapshot,
  threadRootId
}: {
  /** A composer notice (STYLE.md §10): one welcome or balance line inside the box's glass, above
   * the text, so nothing stands between the box and its edge. */
  notice?: ReactNode
  /** The assistant this chat belongs to, by its name (an edit's bar says it answers again). */
  assistantName: string
  bind?: (actions: MatrixComposerActions | null) => void
  blocked: boolean
  cloudOnly: boolean
  contextMessages?: readonly MatrixMessage[]
  draftTarget?: MatrixDraftTarget
  fail: (cause?: unknown, source?: MatrixWindowFailureSource) => void
  onBotOutcome?: (eventId: string, appId: string, outcome: AppBotOutcome) => void
  onAppAction?: (appId: string, routeId: string) => void
  onModelSettings?: () => void
  /** Opens Settings › Advanced › Subscriptions for the account-wide connections. */
  onSubscriptions?: () => void
  /** A send went through: an earlier failure notice has said its piece. */
  onSent?: () => void
  room: MatrixRoom
  snapshot: MatrixSnapshot
  threadRootId?: string
}) {
  const copy = useMatrixCopy()
  const chat = useChatCopy()
  const { locale, t } = useI18n()
  const deviceHealth = matrixDeviceHealthCopy(locale)
  // The @ picker names people as lists do (with @handles); the reply/edit line above the box is
  // part of the chat and names them as the chat does.
  const people = useMatrixPeople(snapshot.members, snapshot.identity?.userId)
  const chatPeople = useMatrixChatPeople(snapshot.members, snapshot.identity?.userId)
  const companyChannel = room.roomType === MATRIX_COMPANY_CHANNEL_TYPE
  const notesSelfRoom = matrixNotesSelfRoom(snapshot.notesSelf, room.id)
  const notesSelfKnownRoom = matrixNotesSelfKnownRoom(snapshot.notesSelf, room.id)
  const notesCopy = matrixTeamSpaceCopy(locale)

  // The box reads the company's Chief of Staff itself: `@Chief of Staff` is offered from the platform's
  // computed state, never from a view some other screen happened to load.
  const { reload: reloadCompanyAI, view: companyAI } = useCompanyAIStatus(
    teamSpaceAccountKey(snapshot.identity),
    room.companyChannel?.companyId
  )

  const companyAIReady = companyAI ? companyAIAvailability(companyAI) === 'ready' : false

  // A company DM or group DM: its audience is its participants, and the platform's directory is what says it exists.
  const companyConversation = isCompanyConversationRoom(room)
  // A company channel or conversation: Slack's formatting and mention affordances sit over the box.
  const teamSpaceBox = companyChannel || companyConversation
  // The company's private Chief of Staff chat: an ordinary company-room send that names the Chief of Staff
  // (the SDK adds its mention), never the person's own assistant's path.
  const privateCos = isCompanyPrivateCosClaim(room)
  const privateCosName = usePrivateCosName()
  const companyFiles = teamSpaceBox && snapshot.companyDriveFilesEnabled === true

  // The box names who you are writing to (Atum Kit mockup: "Message Atum"), a channel by the name
  // its header shows ("#chung", never the room's raw "#general"); a thread keeps the plain prompt.
  const channelTitle = useChannelTitle(teamSpaceAccountKey(snapshot.identity), room, (room.name ?? '').trim().replace(/^#/, ''))

  const conversationTitle = useConversationTitle(
    teamSpaceAccountKey(snapshot.identity),
    room,
    room.name?.trim() || copy.placeholder
  )

  const composerTarget = notesSelfRoom
    ? notesCopy.you
    : privateCos
    ? privateCosName
    : room.assistant
    ? assistantName
    : companyChannel
      ? `#${channelTitle.replace(/^#/, '')}`
      : companyConversation
        ? conversationTitle
        : room.name?.trim()

  const composerPrompt = threadRootId
    ? matrixThreadCopy(locale).reply
    : composerTarget
      ? copy.messageTo(composerTarget)
      : copy.placeholder

  // Team Space files use the protected Company Drive path only. The platform directory must identify the exact
  // channel/conversation audience, and a missing capability closes the picker instead of falling back to Matrix media.
  const composerChannel = useCompanyChannelFacts(teamSpaceAccountKey(snapshot.identity), room)
  // The private Chief of Staff chat has no Company Drive audience of its own yet: no file goes there by Matrix media.
  const attachClosed = privateCos || (teamSpaceBox && (!companyFiles || !composerChannel.attachments))
  // The platform has archived this channel: nothing is posted to it, whatever Matrix says about this person's
  // power in the room. Matrix power levels are the second line of defence, not the first.
  const channelArchived = composerChannel.archived
  // A company channel's state is unknown until the platform's directory is read: "not archived yet" is not
  // "not archived", so the box stays closed (quietly) rather than letting an archived channel take a post.
  const channelUnknown = (companyChannel || companyConversation) && composerChannel.state === 'unknown'
  // The cloud controller consumes one bounded m.file per turn (20 MB, the same limit the
  // composer enforces), so a cloud assistant's chat offers the attach entry like any other.
  const cloudAssistant = Boolean(cloudRoomAgent(snapshot, room))
  // This room's agent answers in the cloud: its model is the server's choice, read from the
  // platform's model-choice offer (`cloudModel`). No offer leaves Nguyệt Thực, as before.
  const roomAgent = snapshot.agents?.find(agent => agent.principal === room.agentPrincipal)
  const cloudAnswering = roomAgent?.answering === 'cloud'
  // The selected room's own assistant, not the default one: an agent's model catalog is its own.
  const pickerAgent = roomAgent && !roomAgent.isDefault ? roomAgent : undefined
  const pickerAtumModel = pickerAgent ? pickerAgent.atumModel : Boolean(snapshot.atumModel)

  const pickerConnectedModel = pickerAgent
    ? (pickerAgent.connectedModel ?? pickerAgent.localModel)
    : (snapshot.connectedModel ?? snapshot.localModel)

  // One definition decides whether this Mac answers: a standby role is inert under cloud-only,
  // while a Mac that still holds the answering term remains a local straggler until moved.
  const pickerLocal = roomAgent ? matrixAgentNeedsLocalSetup(roomAgent, cloudOnly) : true
  const pickerHere = pickerLocal ? 'this_mac' : 'cloud'
  const pickerManaged = pickerAtumModel || cloudAnswering
  const pickerHasModel = pickerManaged || Boolean(pickerConnectedModel)
  // The default assistant keeps its Connections entry even when this build knows no model name.
  const pickerConnectionsOnly = Boolean(roomAgent?.isDefault && onModelSettings)

  // Back to Atum's AI from the picker: the default assistant's one switch (Settings ›
  // Assistant has the same); another agent's own model is changed on its Connections page.
  const roomAgentIsDefault = !snapshot.agents?.some(
    agent => agent.principal === room.agentPrincipal && !agent.isDefault
  )

  const switchToAtum = window.atumMatrix.useAtumModel

  const backToAtum =
    !snapshot.atumModel && snapshot.ownModel && roomAgentIsDefault && switchToAtum
      ? () =>
          void switchToAtum()
            .then(result => {
              if (result.state !== 'ready') {
                fail()
              }
            })
            .catch(fail)
      : undefined

  const [sending, setSending] = useState(false)
  const [cloudStopRefused, setCloudStopRefused] = useState(false)
  const [cloudStopping, setCloudStopping] = useState(false)
  // A chosen file waits in the box as a chip until Send; it goes first, as its own message.
  const [staged, setStaged] = useState<File | null>(null)
  const [fileTooLarge, setFileTooLarge] = useState(false)
  // Answering one message or changing one of yours (launch night): a bar above the input.
  const [mode, setMode] = useState<MatrixComposerMode | null>(null)

  // Account data seeds this mount once. Later remote writes never replace local composition,
  // caret or selection in an open box; reopening the room/root restores the newest sync value.
  const initialDraft = useRef(
    draftTarget
      ? localMatrixDraft(snapshot.identity, draftTarget) ?? matrixDraftText(snapshot.drafts, draftTarget)
      : ''
  ).current

  const [draftText, setDraftText] = useState(initialDraft)
  const draftWriter = useMatrixDraftWriter(snapshot.identity, draftTarget, initialDraft)
  const syncedDraft = draftTarget ? matrixDraftText(snapshot.drafts, draftTarget) : ''
  const [mentionCursor, setMentionCursor] = useState(initialDraft.length)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [selectedHumanMentions, setSelectedHumanMentions] = useState<ReadonlySet<string>>(() => new Set())
  // What was in the box before an edit took it over; it comes back when the edit ends.
  const draftBeforeEdit = useRef('')
  const input = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const [result, setResult] = useState<MatrixInvocationResult | null>(null)
  const [recipient, setRecipient] = useState('')
  const [botSetupReady, setBotSetupReady] = useState<{ appId: string; ready: boolean } | null>(null)
  const [taskStatus, setTaskStatus] = useState<'checking' | 'idle' | 'ready' | 'unavailable'>('idle')
  const [taskNotice, setTaskNotice] = useState<'files_unavailable' | 'delivery_unknown' | null>(null)
  const composer = useRef<ComposerRuntime | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const roomMentionConfirmed = useRef(false)

  const roomMentionConfirmationRef = useRef<{
    body: string
    file: File | null
    reply?: MatrixMessage
    resolve(sent: boolean): void
    task: boolean
  } | null>(null)

  const [roomMentionConfirmation, setRoomMentionConfirmation] = useState(roomMentionConfirmationRef.current)

  useEffect(() => {
    reconcileLocalMatrixDraft(snapshot.identity, draftTarget, syncedDraft)
    draftWriter?.reconcile(syncedDraft)
  }, [draftTarget, draftWriter, snapshot.identity, syncedDraft])

  // Authenticated metadata selects Bot API in any room. Before the first reply, the signed
  // catalog may select it only for this owner's exact direct bot room. Legacy rooms keep every
  // old setup, outcome and send path; a Bot API room uses the ordinary Matrix path.
  const botApiRoom = useMemo(
    () =>
      isBotApiRoom(snapshot.messages, snapshot.apps?.apps, room.encrypted, {
        room,
        ownUserId: snapshot.identity?.userId
      }),
    [room, snapshot.apps?.apps, snapshot.identity?.userId, snapshot.messages]
  )

  const { app: composerApp, actions: appActions } = useAppBotComposerActions(snapshot, room, botApiRoom)
  const driveSelection = useStore($matrixDriveTaskSelection)
  const driveCopy = matrixDriveCopy[locale]

  // Routines and skills are the assistant's own: the "+" offers them only in its chats, and a
  // room without one (a company channel, a chat with people) keeps just the two attach entries.
  const composerAgentPrincipal = room.agentPrincipal ?? (room.assistant ? primaryAgent(snapshot)?.principal : undefined)

  const plusAvailability: ComposerPlusAvailability = {
    photos: !attachClosed && !recipient,
    files: !attachClosed && !recipient,
    routines: Boolean(composerAgentPrincipal && window.atumMatrix.routines),
    skills: Boolean(composerAgentPrincipal && snapshot.apps)
  }

  const plusKinds = composerPlusKinds(plusAvailability)

  const runComposerPlus = (kind: ComposerPlusKind) => {
    switch (kind) {
      case 'photos':
        photoInput.current?.click()

        return

      case 'files':
        fileInput.current?.click()

        return

      case 'routines':
        if (composerAgentPrincipal) {
          openAssistantCard({ kind: 'agent', principal: composerAgentPrincipal, focus: 'routines' })
        }

        return

      case 'skills':
        $matrixStoreShelfRequest.set('skills')
        void runMatrixCommand({ kind: 'discoverApps' }).catch(fail)
    }
  }

  const stageAttachment = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    // The composer stages one file at a time (inside the controller's ten-input bound).
    if (!file) {
      return
    }

    setFileTooLarge(file.size > MATRIX_MAX_FILE_BYTES)
    setStaged(file.size > MATRIX_MAX_FILE_BYTES ? null : file)
    input.current?.focus({ preventScroll: true })
  }, [])

  const updateDraftText = useCallback(
    (text: string, persist = true, sync = persist) => {
      setDraftText(text)

      if (persist && draftTarget) {
        setLocalMatrixDraft(snapshot.identity, draftTarget, text)
      }

      if (sync) {
        draftWriter?.schedule(text)
      }
    },
    [draftTarget, draftWriter, snapshot.identity]
  )

  const clearDraftText = useCallback(() => {
    setDraftText('')
    setLocalMatrixDraft(snapshot.identity, draftTarget, '')
    void draftWriter?.clear().catch(() => {})
  }, [draftTarget, draftWriter, snapshot.identity])

  const mentionMatch = teamSpaceBox ? matrixMentionMatch(draftText, mentionCursor) : null

  const excludedMentionUsers = useMemo(
    () =>
      new Set(
        [
          snapshot.assistant?.userId,
          ...(snapshot.agents ?? []).map(agent => agent.userId),
          ...(snapshot.appParticipants ?? []).map(app => app.userId),
          ...(snapshot.apps?.apps ?? []).flatMap(app => (app.bot ? [app.bot.user_id] : [])),
          companyAI?.agent.userId,
          room.companyChannel?.managerUserId,
          room.companyConversation?.managerUserId
        ].filter((userId): userId is string => Boolean(userId))
      ),
    [companyAI?.agent.userId, room.companyChannel?.managerUserId, room.companyConversation?.managerUserId,
      snapshot.agents, snapshot.appParticipants, snapshot.apps?.apps, snapshot.assistant?.userId]
  )

  const humanMentionCandidates = useMemo(
    () =>
      teamSpaceBox
        ? matrixHumanMentions({ excluded: excludedMentionUsers, locale, members: snapshot.members, people })
        : [],
    [excludedMentionUsers, locale, people, snapshot.members, teamSpaceBox]
  )

  // While the @ menu is open it picks people, so it shows their handles; the chat itself does not.
  useMatrixHandleContacts(
    snapshot.identity?.userId,
    mentionMatch ? humanMentionCandidates.map(candidate => candidate.userId) : [],
    Boolean(snapshot.domainEnabled)
  )

  const companyAIMentionAligned = useMemo(() => {
    const companyMatch = mentionMatch && companyAI ? companyAIMentionMatch(draftText, mentionCursor) : null

    return Boolean(companyMatch && mentionMatch && companyMatch.start === mentionMatch.start &&
      companyMatch.end === mentionMatch.end)
  }, [companyAI, draftText, mentionCursor, mentionMatch])

  const mentionOptions = useMemo<TeamSpaceMentionOption[]>(() => {
    if (!mentionMatch) {
      return []
    }

    const options: TeamSpaceMentionOption[] = filterMatrixHumanMentions(
      humanMentionCandidates,
      mentionMatch.query
    ).map(mention => ({ kind: 'person', mention }))

    // People first, then the role-gated channel mention. Company AI remains available after both.
    if (companyChannel && composerChannel.mentionRoom && 'channel'.startsWith(mentionMatch.query)) {
      options.push({ kind: 'channel' })
    }

    if (companyAIReady && companyAIMentionAligned && companyAI) {
      options.push({ kind: 'company_ai', view: companyAI })
    }

    return options
  }, [companyAI, companyAIMentionAligned, companyAIReady, companyChannel, composerChannel.mentionRoom,
    humanMentionCandidates, mentionMatch])

  // A Chief of Staff that can't answer yet is not a target: the menu says so in one line instead.
  const companyAINotice = companyAI && companyAIMentionAligned && !companyAIReady
    ? {
        view: companyAI,
        line: companyAIAvailabilityLine(companyAIAvailability(companyAI), matrixCompanyBoardCopy(locale)) ?? ''
      }
    : undefined

  useCompanyAIRecheck(Boolean(companyAINotice), reloadCompanyAI)

  useEffect(() => setMentionIndex(0), [mentionMatch?.query, mentionMatch?.start])

  const chooseMention = (option: TeamSpaceMentionOption) => {
    if (!mentionMatch) {
      return
    }

    const token =
      option.kind === 'person' ? option.mention.token : option.kind === 'channel' ? '@channel' : '@Chief of Staff'

    const next =
      option.kind === 'company_ai'
        ? insertCompanyAIMention(draftText, mentionMatch)
        : insertMatrixMention(draftText, mentionMatch, token)

    if (option.kind === 'person') {
      setSelectedHumanMentions(current => new Set([...current, option.mention.userId]))
    }

    const caret = mentionMatch.start + token.length + 1
    composer.current?.setText(next)
    updateDraftText(next, mode?.kind !== 'edit')
    setMentionCursor(caret)
    requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true })
      input.current?.setSelectionRange(caret, caret)
    })
  }

  // A company channel or conversation: the box's "Aa" opens a formatting row over it.
  const [formattingOpen, setFormattingOpen] = useState(false)

  const withFormattingToggle = (actions: ReactNode) =>
    teamSpaceBox ? (
      <>
        {actions}
        <TeamSpaceFormattingToggle
          disabled={disabled}
          onToggle={() => setFormattingOpen(open => !open)}
          open={formattingOpen}
        />
      </>
    ) : (
      actions
    )

  const formatText = (next: FormattedText) => {
    composer.current?.setText(next.text)
    updateDraftText(next.text, mode?.kind !== 'edit')
    setMentionCursor(next.selectionEnd)
    requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true })
      input.current?.setSelectionRange(next.selectionStart, next.selectionEnd)
    })
  }

  const taskScope: MatrixDriveTaskScope | null =
    snapshot.identity && room.assistant && isAssistantRoom(room, snapshot.identity.userId, snapshot.assistant?.userId)
      ? { userId: snapshot.identity.userId, deviceId: snapshot.identity.deviceId, roomId: room.id }
      : null

  const taskSelections =
    taskScope &&
    driveSelection.scope &&
    driveSelection.revision !== null &&
    driveSelection.scope.userId === taskScope.userId &&
    driveSelection.scope.deviceId === taskScope.deviceId &&
    driveSelection.scope.roomId === taskScope.roomId
      ? driveSelection.selections
      : []

  const hasTaskFiles = taskSelections.length > 0
  const taskSelectionKey = taskSelections.map(value => `${value.id}:${value.mode}:${value.name}`).join('|')

  const [appResult, setAppResult] = useState<{
    roomId: string
    eventId: string
    appId: string
    result: MatrixInvocationResult
  } | null>(null)

  const [botOutcome, setBotOutcome] = useState<AppBotOutcome | null>(null)
  const [includeBotQuote, setIncludeBotQuote] = useState(false)
  const appCopy = appChatCopy(locale)

  const legacyAppRecipients = (snapshot.appParticipants ?? []).filter(
    app =>
      !room.assistant &&
      room.encrypted &&
      room.membership === 'join' &&
      ((!room.roomType && room.participants?.length === 2) ||
        (room.appGroup?.owner === snapshot.identity?.userId && room.appGroup?.app === app.userId)) &&
      room.participants?.some(member => member.userId === app.userId && member.membership === 'join')
  )

  // The native app host projection intentionally excludes official bots: they
  // are normal room members, selected only from the signed catalog identity.
  const botRecipients = (snapshot.apps?.apps ?? []).flatMap(app => {
    const membership = app.bot && room.participants?.find(member => member.userId === app.bot!.user_id)?.membership

    // Encrypted or plain (0.20): a bot chat or a group with the bot in it.
    return app.bot && room.membership === 'join' && (membership === 'join' || membership === 'invite')
      ? [
          {
            appId: app.app_id,
            userId: app.bot.user_id,
            displayName: app.bot.display_name,
            handle: app.bot.handle,
            joined: membership === 'join',
            ready:
              membership === 'join' &&
              (Boolean(room.direct) || app.bot.groups) &&
              app.bot.state === 'active' &&
              (botApiRoom || (app.bot.consent === 'accepted' && app.link.state === 'linked'))
          }
        ]
      : []
  })

  const appRecipients = [...legacyAppRecipients, ...botRecipients]
  const directBotId = room.direct ? (botRecipients[0]?.appId ?? null) : null

  const catalogBotRecipientKey = (snapshot.apps?.apps ?? [])
    .flatMap(app => (app.bot ? [app.app_id] : []))
    .join('\u0000')

  const catalogBotRecipientIds = useMemo(
    () => (catalogBotRecipientKey ? catalogBotRecipientKey.split('\u0000') : []),
    [catalogBotRecipientKey]
  )

  // Official bots are people-shaped Matrix identities, not optional app
  // recipients layered onto a room.  Their direct chat is implicit, and a
  // group addresses them with a normal mention/reply.  Keep the selector only
  // for legacy hosted apps and the owner's local assistants.
  const selectableAppRecipients = legacyAppRecipients

  const recipientBot = snapshot.apps?.apps.find(app => app.app_id === recipient)?.bot ?? null
  const recipientBotParticipant = botRecipients.find(app => app.appId === recipient)

  const appReady =
    snapshot.apps?.state === 'ready' &&
    (recipientBot
      ? Boolean(
          recipientBotParticipant?.joined &&
          (botApiRoom
            ? true
            : room.direct
              ? botSetupReady?.appId === recipient && botSetupReady.ready
              : recipientBotParticipant.ready)
        )
      : appRecipients.some(app => app.appId === recipient && app.ready))

  const onBotSetupReady = useCallback((ready: boolean) => setBotSetupReady({ appId: recipient, ready }), [recipient])
  const recipientRoom = useRef('')
  const recipientViewer = snapshot.identity?.userId ?? ''
  const recipientRoomId = room.id
  const recipientMeeting = groupAssistantMode(room, snapshot) === 'meeting'
  const recipientScope = JSON.stringify([recipientViewer, recipientRoomId])

  const chooseRecipient = (value: string) => {
    setRecipient(value)

    if (recipientViewer && recipientMeeting) {
      groupRecipientChoice(recipientViewer, recipientRoomId).write(value)
    }
  }

  useEffect(() => {
    const changedRoom = recipientRoom.current !== recipientScope
    recipientRoom.current = recipientScope
    // A selected app that disappears must leave the composer blocked, never
    // silently turn the person's next message into an ambient room send. A
    // different room starts with no app recipient unless it is an official DM.
    setRecipient(current => {
      if (directBotId) {
        return directBotId
      }

      const next = changedRoom
        ? recipientViewer && recipientMeeting
          ? groupRecipientChoice(recipientViewer, recipientRoomId).read()
          : ''
        : current

      return next.startsWith('agent:') ? '' : clearStoredAppBotRecipient(next, catalogBotRecipientIds)
    })
  }, [catalogBotRecipientIds, directBotId, recipientRoomId, recipientViewer, recipientScope, recipientMeeting])

  useEffect(() => {
    const currentResult = appResult
    const app = currentResult && snapshot.apps?.apps.find(value => value.app_id === currentResult.appId)
    const bridge = window.atumMatrix.apps

    if (!currentResult || !app?.bot || !bridge || botApiRoom || currentResult.result.state !== 'published') {
      return
    }

    let live = true
    setBotOutcome(null)
    const wait = (milliseconds: number) => new Promise<void>(resolve => window.setTimeout(resolve, milliseconds))
    void pollAppBotOutcome(
      async () =>
        parseAppBotOutcome(await bridge.botOutcome(app.app_id, currentResult.roomId, currentResult.eventId), {
          app: app.app,
          guest: app.bot?.guest_enabled === true
        }),
      wait,
      outcome => {
        if (live) {
          if (!room.direct) {
            onBotOutcome?.(currentResult.eventId, currentResult.appId, outcome)
          } else {
            setBotOutcome(outcome)
          }
        }
      },
      undefined,
      // An answer this Atum cannot read is a line in the console and the next poll, not the end of the poll.
      error => {
        if (live) {
          console.warn(appBotOutcomeUnreadableLine(error))
        }
      }
    ).catch(() => {})

    return () => {
      live = false
    }
  }, [appResult, botApiRoom, onBotOutcome, room.direct, snapshot.apps?.apps])

  // Your own assistants in this group remain ordinary participants. A typed @mention or a
  // reply addresses one; the composer no longer exposes a separate routing mode.
  const agentRecipients = groupAssistantRecipients(room, snapshot)
  const groupPolicy = useGroupRoomPolicy(room, snapshot)
  const roomGroupCopy = groupRoomCopy(locale)

  const everyone =
    groupAssistantMode(room, snapshot) === 'meeting' &&
    Boolean(groupPolicy.value) &&
    agentRecipients.some(
      agent =>
        effectiveMode({ roomMode: 'meeting', stored: groupPolicy.value!.policy.agents[agent.userId]?.mode }) === 'joins'
    )

  const groupBudget =
    groupPolicy.value &&
    roomBudget({
      now: Date.now(),
      dailyTurns: groupPolicy.value.policy.dailyTurns ?? DAILY_TURNS_DEFAULT,
      usage: groupPolicy.value.usage
    })

  const agentName = (agent: (typeof agentRecipients)[number]) =>
    matrixRosterAgentName(agent, t.matrixShell.assistantName)

  const groupMentionRecipients = [
    ...(snapshot.members ?? [])
      .filter(member => ['join', 'invite'].includes(member.membership))
      .map(member => ({ userId: member.userId, name: member.rawName ?? member.name })),
    ...agentRecipients.map(agent => ({ userId: agent.userId, name: agentName(agent) }))
  ]

  const composerReply = mode?.kind === 'reply' ? mode.message : undefined

  const composerBotTargets =
    room.direct || recipient
      ? []
      : addressedAppBotRecipients(draftText, composerReply?.sender, botRecipients, groupMentionRecipients)

  const composerBotTarget =
    composerBotTargets.length === 1 &&
    composerBotTargets[0]!.ready &&
    Boolean(window.atumMatrix.apps) &&
    !staged &&
    !appBotGroupMessageError({ body: draftText, attachment: false, edited: false, decryptable: true })
      ? composerBotTargets[0]!
      : null

  const replyComesFromComposerBot = Boolean(
    composerReply && composerBotTarget && composerReply.sender === composerBotTarget.userId
  )

  useEffect(() => {
    setIncludeBotQuote(false)
  }, [composerBotTarget?.appId, composerReply?.id])

  const listening =
    room.assistant && snapshot.hermesListening?.state === 'listening' && snapshot.hermesListening.roomId === room.id

  // The local path (plan 2026-09-26-reliable-local-first-chat): this Mac's assistant
  // directly, no chat-server round trip and no per-message dialog. A linked document keeps
  // the server path, with its confirmation.
  const localPath =
    room.assistant &&
    !cloudAssistant &&
    snapshot.assistantPath !== 'server' &&
    Boolean(snapshot.readiness) &&
    !snapshot.linkedDocument

  // Degraded: the box is paused (drafts can still be typed) until the watch recovers.
  // A staged Drive task uses its separately verified cloud path. Its availability
  // comes from taskStatus below, rather than this Mac's local readiness watch.
  const paused =
    Boolean(cloudRoomAgent(snapshot, room) && snapshot.linkedDocument) ||
    (localPath && !hasTaskFiles && snapshot.readiness?.phase !== 'ready')

  const attentionWords = useAttentionCopy()
  const pausedHint = paused ? matrixComposerHint(snapshot, assistantName, attentionWords) : undefined

  // A reply goes out on the chat's own path: people's chats, or your assistant's chat on this
  // Mac. An app recipient, staged Drive files or the confirmation path carry none. Asking your
  // assistant in a group can answer a message: that message is what it is asked about.
  const replies = (!recipient || Boolean(recipientBot)) && !hasTaskFiles && (room.assistant ? Boolean(localPath) : true)

  useEffect(() => {
    if (!hasTaskFiles) {
      setTaskStatus('idle')

      return
    }

    const bridge = window.atumMatrix.drive
    let live = true
    setTaskStatus('checking')
    void bridge?.taskStatus(room.id).then(
      value => live && setTaskStatus(value.state),
      () => live && setTaskStatus('unavailable')
    )

    return () => {
      live = false
    }
  }, [hasTaskFiles, room.id, taskSelectionKey])

  const taskBlocked = hasTaskFiles && taskStatus !== 'ready'

  // Encrypted or plain (0.20): agent rooms pass isAssistantRoom (encrypted or plainAgent), people
  // chats and groups send either way.
  const closedForRoom = hasTaskFiles
    ? blocked ||
      sending ||
      snapshot.state !== 'ready' ||
      room.membership !== 'join' ||
      snapshot.canSend === false ||
      taskBlocked ||
      Boolean(snapshot.appTurn) ||
      !isAssistantRoom(room, snapshot.identity?.userId, snapshot.assistant?.userId)
    : localPath
      ? blocked ||
        sending ||
        room.membership !== 'join' ||
        snapshot.canSend === false ||
        taskBlocked ||
        !isAssistantRoom(room, snapshot.identity?.userId, snapshot.assistant?.userId)
      : blocked ||
        sending ||
        snapshot.state !== 'ready' ||
        room.membership !== 'join' ||
        snapshot.canSend === false ||
        taskBlocked ||
        (Boolean(recipient || directBotId) && !appReady) ||
        Boolean(snapshot.appTurn) ||
        (room.assistant &&
          (!isAssistantRoom(room, snapshot.identity?.userId, snapshot.assistant?.userId) ||
            (!listening && snapshot.hermes !== 'ready')))

  // Notes-to-self integration seam: a former winner or changed audience remains readable but
  // cannot receive another Atum send. The SDK repeats this check at the authority boundary.
  const disabled = channelArchived || channelUnknown || closedForRoom ||
    (room.roomType === MATRIX_NOTES_SELF_ROOM_TYPE && !notesSelfRoom)

  const messages = useMemo(
    () =>
      snapshot.messages.map(message => ({
        id: message.id,
        role: message.own ? ('user' as const) : ('assistant' as const),
        content: [{ type: 'text' as const, text: message.body }],
        createdAt: new Date(message.timestamp),
        metadata: { custom: { matrix: message } }
      })),
    [snapshot.messages]
  )

  // A send that did not go out says what happened, in this chat's terms (chat-error.ts
  // `matrixSendFailure`): an assistant that can't start on this Mac or can't be reached is named,
  // never "finishing another step". Where pressing Send again can help, the band offers Try
  // again, which sends what the box holds then.
  const failSend = (error: unknown) => {
    const failure = matrixSendFailure(error, {
      online: snapshot.state !== 'offline',
      assistant: room.assistant
        ? { readiness: snapshot.readiness, cloud: cloudAssistant || cloudAnswering }
        : undefined
    })

    // An official bot's refusal already names the bot (`aboutAppBot`): keep that name.
    const subject = matrixFailureSubject(error) ?? (room.assistant ? assistantName : undefined)

    fail(
      new MatrixSendFailure(
        error,
        failure,
        subject,
        matrixSendFailureRetryable(failure) ? () => retryBoxRef.current() : matrixFailureRetry(error)
      ),
      'chat.send'
    )
  }

  // One path for the composer, a retried question and a staged file: the file goes first
  // as its own message, then the words through the room's own path. A retry never carries
  // the staged Drive files (`task: false`). `reply`: the words answer that message. Resolves
  // true once the words (or the file alone) went out.
  const sendMessage = async (
    body: string,
    file: File | null,
    { task = true, reply }: { task?: boolean; reply?: MatrixMessage } = {}
  ): Promise<boolean> => {
    if (!body.trim() && !file) {
      return false
    }

    // The channel's state is not known yet: nothing is posted. The words stay in the box; no error is raised.
    if (channelUnknown) {
      if (body.trim() && !composer.current?.getState().text.trim()) {
        composer.current?.setText(body)
      }

      return false
    }

    // The platform archived this channel: nothing is posted, whatever Matrix says about this person's power.
    // Like any refused send, the words go back in the box and the chat says why.
    if (channelArchived) {
      if (body.trim() && !composer.current?.getState().text.trim()) {
        composer.current?.setText(body)
      }

      fail(new Error(MATRIX_CHANNEL_ARCHIVED))

      return false
    }

    // The cloud controller reads at most ten inputs in one turn: the staged file plus each Drive
    // file it reads. Refuse here, before anything leaves the box; the file and selections stay.
    const turnInputs =
      (file ? 1 : 0) + (task && hasTaskFiles ? taskSelections.filter(selection => selection.mode === 'read').length : 0)

    if (turnInputs > MATRIX_MAX_TURN_INPUTS) {
      if (body.trim() && !composer.current?.getState().text.trim()) {
        composer.current?.setText(body)
      }

      fail(new Error('matrix_attachment_limit'))

      return false
    }

    // The assistant isn't ready (starting, stopped or paused): Send is off, but a send that
    // still gets here is never dropped in silence. Its words go back in the box (the runtime
    // emptied it; a retry never overwrites another draft), a staged file stays, and the chat
    // says why.
    if (paused) {
      if (body.trim() && !composer.current?.getState().text.trim()) {
        composer.current?.setText(body)
      }

      failSend(new Error(MATRIX_ASSISTANT_NOT_READY))

      return false
    }

    // Too long for one message (FR20): the words stay in the box, with the reason. A retry
    // of an older, longer message never overwrites another draft (it is still in the chat).
    if (body.trim() && matrixMessageTooLong(body)) {
      if (!composer.current?.getState().text.trim()) {
        composer.current?.setText(body)
      }

      fail(new Error('matrix_message_too_long'))

      return false
    }

    const humanMentionIds = teamSpaceBox
      ? matrixHumanMentionUserIds(body, humanMentionCandidates, selectedHumanMentions)
      : []

    const roomMention = matrixRoomMentionRequested(body, companyChannel && composerChannel.mentionRoom)

    if (
      matrixRoomMentionNeedsConfirmation(roomMention, humanMentionCandidates.length) &&
      !roomMentionConfirmed.current
    ) {
      if (roomMentionConfirmationRef.current) {
        return false
      }

      return new Promise<boolean>(resolve => {
        const confirmation = { body, file, reply, resolve, task }
        roomMentionConfirmationRef.current = confirmation
        setRoomMentionConfirmation(confirmation)
      })
    }

    setSending(true)
    setResult(null)
    setAppResult(null)
    setTaskNotice(null)
    let taskSendStarted = false
    let attached = !file
    const appBridge = window.atumMatrix.apps

    const addressedBotTargets =
      room.direct || recipient
        ? []
        : addressedAppBotRecipients(body, reply?.sender, botRecipients, groupMentionRecipients)

    const addressedBotTarget = addressedBotTargets.length === 1 ? addressedBotTargets[0] : undefined

    const addressedBotProblem = addressedBotTarget
      ? appBotGroupMessageError({
          body,
          attachment: Boolean(file),
          edited: false,
          decryptable: true
        })
      : null

    // A bot-api room's addressed message is an ordinary Matrix message the app's host reads;
    // the old turn API would dispatch it twice. Legacy rooms keep the existing route.
    const routedBotTarget =
      !botApiRoom && addressedBotTarget?.ready && appBridge && !addressedBotProblem ? addressedBotTarget : undefined

    // Your words show at once, as in any messaging app, on the two paths that post them as
    // your own message: your assistant's chat (here or in the cloud), and a plain room message.
    const plainSend =
      botApiRoom ||
      (!(routedBotTarget && appBridge) && !recipient && !(room.assistant && !listening && !cloudAssistant))

    // A reply's quote shows on the echo too (the local path carries it only with a quote).
    const echoReplyTo = reply && (!localPath || matrixTurnQuote(reply.body)) ? reply.id : undefined

    const echoMentions = [
      ...new Set([...humanMentionIds, ...companyAIMentionUserIds(body, companyAI)])
    ]

    const echo =
      !threadRootId && !file && body.trim() && !(task && hasTaskFiles) && (localPath || plainSend)
        ? addOutgoingEcho(room.id, body, {
            replyTo: echoReplyTo,
            ...(echoMentions.length || roomMention
              ? { mentions: { userIds: echoMentions, room: roomMention } }
              : {})
          })
        : null

    // The words went back in the box: the echo goes, so they never show twice.
    const restore = () => {
      composer.current?.setText(body)
      updateDraftText(body)

      if (echo) {
        dropOutgoingEchoes([echo])
      }
    }

    try {
      if (file) {
        await runMatrixCommand({
          kind: 'attach',
          roomId: room.id,
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          bytes: new Uint8Array(await file.arrayBuffer()),
          ...(companyFiles && threadRootId ? { threadRootId, replyTo: reply?.id ?? threadRootId } : {})
        })
        attached = true
        setStaged(current => (current === file ? null : current))

        if (!body.trim()) {
          onSent?.()

          return true
        }
      }

      if (task && hasTaskFiles) {
        const bridge = window.atumMatrix.drive

        if (!bridge || taskStatus !== 'ready' || driveSelection.revision === null) {
          setTaskStatus('unavailable')
          composer.current?.setText(body)
          fail()

          return false
        }

        const status = await bridge.taskStatus(room.id)

        if (status.state !== 'ready') {
          setTaskStatus('unavailable')
          composer.current?.setText(body)
          fail()

          return false
        }

        taskSendStarted = true

        const sent = await bridge.sendTask({
          roomId: room.id,
          body,
          revision: driveSelection.revision,
          selections: matrixDriveTaskInputSelections(driveSelection)
        })

        if (sent.state === 'not_sent') {
          setTaskStatus('unavailable')
          composer.current?.setText(body)
          fail()

          return false
        }

        clearMatrixDriveTaskSelectionsIfCurrent(driveSelection)
        setTaskNotice(
          sent.state === 'grant_failed_after_ack'
            ? 'files_unavailable'
            : sent.state === 'send_unknown'
              ? 'delivery_unknown'
              : null
        )
      } else if (localPath) {
        // Main accepts the text and returns at once; the turn renders from the snapshot. A
        // reply carries the message it answers, which reaches the assistant as context.
        const quote = reply ? matrixTurnQuote(reply.body) : ''

        const accepted =
          reply && quote
            ? await window.atumMatrix.sendTurn(room.id, body, { eventId: reply.id, quote })
            : await window.atumMatrix.sendTurn(room.id, body)

        if (echo) {
          settleOutgoingEcho(echo, { turnId: accepted?.turnId })
        }
      } else if (routedBotTarget && appBridge) {
        const target = routedBotTarget

        // A reply to the bot is bot-authored context and the host derives it
        // from the standard Matrix relation.  A reply to a person remains
        // private unless the sender explicitly chose the adjacent quote action.
        const quote =
          reply &&
          reply.sender !== target.userId &&
          includeBotQuote &&
          isEligibleAppBotQuote({
            body: reply.body,
            attachment: reply.attachment,
            edited: Boolean(reply.edited),
            decryptable: !reply.decryptionFailed,
            redacted: Boolean(reply.redacted)
          })
            ? reply.id
            : undefined

        // A refusal names the bot it was addressed to, as in a direct chat with it.
        const targetName = snapshot.apps?.apps.find(app => app.app_id === target.appId)?.bot?.display_name

        const sent = await (
          reply?.id || quote
            ? appBridge.send(target.appId, room.id, body, locale, reply?.id, quote)
            : appBridge.send(target.appId, room.id, body, locale)
        ).catch((error: unknown) => {
          throw targetName ? aboutAppBot(error, targetName) : error
        })

        setAppResult({ ...sent, roomId: room.id, appId: target.appId })
      } else if (recipient && !botApiRoom) {
        if (!appReady || !appBridge) {
          throw new Error('matrix_app_unavailable')
        }

        const quote =
          recipientBot &&
          !room.direct &&
          reply &&
          reply.sender !== recipientBot.user_id &&
          includeBotQuote &&
          isEligibleAppBotQuote({
            body: reply.body,
            attachment: reply.attachment,
            edited: Boolean(reply.edited),
            decryptable: !reply.decryptionFailed,
            redacted: Boolean(reply.redacted)
          })
            ? reply.id
            : undefined

        // Keep the established four-argument bridge call for ordinary app
        // hosts. The optional reply/quote fields belong only to official bots,
        // and passing explicit `undefined` changes the native/mock call shape.
        // A refusal for an official bot names it, so the window can say why.
        const sent = await (
          recipientBot && !room.direct && (reply?.id || quote)
            ? appBridge.send(recipient, room.id, body, locale, reply?.id, quote)
            : appBridge.send(recipient, room.id, body, locale)
        ).catch((error: unknown) => {
          throw recipientBot ? aboutAppBot(error, recipientBot.display_name) : error
        })

        setAppResult({
          ...sent,
          roomId: room.id,
          appId: recipient
        })
      } else if (room.assistant && !listening) {
        const sent = await window.atumMatrix.sendAssistant(room.id, body, locale)
        setResult(sent.result)

        if (echo) {
          settleOutgoingEcho(echo, { eventId: sent.eventId })
        }
      } else {
        // Answering your own assistant's message in a group names it: it answers you then.
        const mentions = [
          ...new Set([
            ...(groupReplyMentions(reply, agentRecipients) ?? []),
            ...groupTypedMentions(
              body,
              agentRecipients.map(agent => ({ userId: agent.userId, name: agentName(agent) }))
            ),
            ...companyAIMentionUserIds(body, companyAI),
            ...humanMentionIds,
            ...addressedBotTargets.map(target => target.userId)
          ])
        ]

        const sent = await runMatrixCommand({
          kind: 'send',
          roomId: room.id,
          body,
          ...(reply ? { replyTo: reply.id } : {}),
          ...(threadRootId ? { threadRootId } : {}),
          ...(mentions.length ? { mentions } : {}),
          ...(roomMention ? { roomMention: true } : {})
        })

        if (echo) {
          settleOutgoingEcho(echo, typeof sent === 'string' ? { eventId: sent } : {})
        }
      }

      onSent?.()

      return true
    } catch (error) {
      if (task && hasTaskFiles && taskSendStarted) {
        clearMatrixDriveTaskSelectionsIfCurrent(driveSelection)
        setTaskNotice('delivery_unknown')

        return false
      }

      if (task && hasTaskFiles && !taskSendStarted) {
        setTaskStatus('unavailable')
        restore()
        fail()

        return false
      }

      // Preserve user-visible identity, state and recovery behavior across connection changes.
      // in the box, exactly as it was, and its echo goes; a staged file stays staged (it is
      // cleared only once it went). A retry from the chat never overwrites another draft: then
      // its echo stays instead, marked not sent, with its own Retry.
      if (!composer.current?.getState().text.trim()) {
        restore()
      } else if (echo) {
        failOutgoingEcho(echo)
      }

      // A Founder chat refusal (founder/sdk-founder-chat.ts) and strict device policy refusing
      // encryption come before any message is made, and pressing Send again cannot help: the
      // reason, with no Try again.
      if (
        isMatrixFounderRefusal(matrixChatFailure(error)) ||
        (snapshot.deviceIsolation?.value === 'signed' && !taskSendStarted)
      ) {
        fail(error, 'chat.send')

        return false
      }

      failSend(error)

      return false
    } finally {
      setSending(false)
    }
  }

  // The box, ready to type into again, with the caret at the end of what it holds.
  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const length = input.current?.value.length ?? 0
      input.current?.focus({ preventScroll: true })
      input.current?.setSelectionRange(length, length)
    })
  }, [])

  // An edit ends (saved or cancelled): the box gives back what was in it before.
  const leaveEdit = useCallback(() => {
    setMode(current => (current?.kind === 'edit' ? null : current))
    composer.current?.setText(draftBeforeEdit.current)
    draftBeforeEdit.current = ''
  }, [])

  const cancelMode = useCallback(() => {
    if (mode?.kind === 'edit') {
      leaveEdit()
    } else {
      setMode(null)
    }

    focusInput()
  }, [focusInput, leaveEdit, mode?.kind])

  // Your newest message here, and the newest one Edit can change (a text the server has).
  const availableMessages = contextMessages ?? snapshot.messages
  const ownMessages = availableMessages.filter(value => value.own && value.id.startsWith('$') && !value.redacted)
  const newestOwn = ownMessages.at(-1)

  const lastEditable = ownMessages.findLast(
    value => !value.attachment && !value.pending && !value.failed && !value.decryptionFailed && value.body.trim()
  )

  const assistantChat = Boolean(
    room.assistant && isAssistantRoom(room, snapshot.identity?.userId, snapshot.assistant?.userId)
  )

  // Changing your newest message in your assistant's chat asks again with the new words (a
  // question still on its way here is newer, whatever the room shows yet).
  const reasks = (message: MatrixMessage) =>
    assistantChat &&
    message.id === newestOwn?.id &&
    !(snapshot.localTurns ?? []).some(
      turn => turn.roomId === room.id && !turn.synced.question && turn.createdAt > message.timestamp
    )

  const beginEdit = (message: MatrixMessage) => {
    if (mode?.kind !== 'edit') {
      draftBeforeEdit.current = composer.current?.getState().text ?? ''
    }

    setMode({ kind: 'edit', message, reask: reasks(message) })
    composer.current?.setText(message.body)
    focusInput()
  }

  // Saving an edit changes the message for everyone (`m.replace`); unchanged words change
  // nothing. In your assistant's chat your newest message is then asked again, as the next
  // turn: what the assistant already read and answered stays as it was (append-only).
  const saveEdit = async (body: string, editing: Extract<MatrixComposerMode, { kind: 'edit' }>) => {
    if (body.trim() === editing.message.body.trim()) {
      leaveEdit()

      return
    }

    // An edit is a post too: until the channel's state is known, the words stay and nothing is said.
    if (channelUnknown) {
      composer.current?.setText(body)

      return
    }

    // An archived channel changes nothing, so the words stay and the chat says why.
    if (channelArchived) {
      composer.current?.setText(body)
      fail(new Error(MATRIX_CHANNEL_ARCHIVED))

      return
    }

    // An edit that asks again needs the assistant: while it isn't ready, nothing is saved,
    // the bar and the words stay, and the chat says why.
    if (editing.reask && paused) {
      composer.current?.setText(body)
      fail(new Error(MATRIX_ASSISTANT_NOT_READY))

      return
    }

    setSending(true)

    try {
      await runMatrixCommand({ kind: 'edit', roomId: room.id, eventId: editing.message.id, body })
    } catch (error) {
      composer.current?.setText(body)
      fail(error)

      return
    } finally {
      setSending(false)
    }

    leaveEdit()
    onSent?.()

    if (editing.reask) {
      await sendRef.current(body, null, { task: false }).catch(() => false)
    }
  }

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: message => message,
    isDisabled: disabled,
    isRunning: sending,
    onNew: async message => {
      const body = message.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n')

      if (mode?.kind === 'edit') {
        return saveEdit(body, mode)
      }

      await submitBox(body)
    }
  })

  // The box's words (the runtime has already emptied it) and its staged file go out. The reply
  // bar goes once its message went out; a failure keeps it, and the words go back in the box.
  const submitBox = async (body: string) => {
    const replying = mode?.kind === 'reply' ? mode.message : undefined

    if (await sendMessage(body, staged, { reply: replying })) {
      clearDraftText()
      setMentionCursor(0)
      setSelectedHumanMentions(new Set())
      setMode(current => (current?.kind === 'reply' && current.message.id === replying?.id ? null : current))
    }
  }

  // The failure band's Try again: whatever the box holds now goes, as Send would send it (an
  // edit in progress is not a send). The box empties first, as the runtime empties it on Send.
  const retryBoxRef = useRef(() => {})
  // Set until a Try again's send settles, so a second press before the re-render can't send twice.
  const retryingRef = useRef(false)

  retryBoxRef.current = () => {
    const text = composer.current?.getState().text ?? ''

    if (retryingRef.current || mode?.kind === 'edit' || sending || (!text.trim() && !staged)) {
      return
    }

    retryingRef.current = true
    composer.current?.setText('')
    void submitBox(text)
      .catch(() => {})
      .finally(() => {
        retryingRef.current = false
      })
  }

  // The transcript's Retry, Reply and Edit use this same box and path.
  const sendRef = useRef(sendMessage)
  sendRef.current = sendMessage

  const closeRoomMentionConfirmation = () => {
    const pending = roomMentionConfirmationRef.current

    if (!pending) {
      return
    }

    if (pending.body.trim() && !composer.current?.getState().text.trim()) {
      composer.current?.setText(pending.body)
      updateDraftText(pending.body)
    }

    roomMentionConfirmationRef.current = null
    setRoomMentionConfirmation(null)
    pending.resolve(false)
  }

  const confirmRoomMention = async () => {
    const pending = roomMentionConfirmationRef.current

    if (!pending) {
      return
    }

    roomMentionConfirmed.current = true

    try {
      const sent = await sendRef.current(pending.body, pending.file, {
        task: pending.task,
        reply: pending.reply
      })

      pending.resolve(sent)
    } finally {
      roomMentionConfirmed.current = false
      roomMentionConfirmationRef.current = null
      setRoomMentionConfirmation(null)
    }
  }

  const beginEditRef = useRef(beginEdit)
  beginEditRef.current = beginEdit
  const modeRef = useRef(mode)
  modeRef.current = mode
  const ready = !disabled && !paused && !sending

  useEffect(() => {
    bind?.({
      ready,
      replies,
      send: body => sendRef.current(body, null, { task: false }),
      resend: body => void sendRef.current(body, null, { task: false }).catch(() => {}),
      edit: body => {
        composer.current?.setText(body)
        focusInput()
      },
      reply: message => {
        // Replying instead of editing: the edit's words make way for what was in the box.
        if (modeRef.current?.kind === 'edit') {
          composer.current?.setText(draftBeforeEdit.current)
          draftBeforeEdit.current = ''
        }

        setMode({ kind: 'reply', message })
        focusInput()
      },
      editMessage: message => beginEditRef.current(message),
      draft: () =>
        (modeRef.current?.kind === 'edit' ? draftBeforeEdit.current : composer.current?.getState().text) ?? ''
    })
  }, [bind, focusInput, ready, replies])

  useEffect(() => () => bind?.(null), [bind])

  useEffect(
    () => () => {
      roomMentionConfirmationRef.current?.resolve(false)
      roomMentionConfirmationRef.current = null
    },
    []
  )

  // A reply that this path can no longer carry (an app picked as recipient, Drive files
  // staged) or a message that is gone (deleted, or out of the timeline) ends the bar.
  const modeMessage = mode ? availableMessages.find(value => value.id === mode.message.id) : undefined

  useEffect(() => {
    if (!mode) {
      return
    }

    if (!modeMessage || modeMessage.redacted || (mode.kind === 'reply' && !replies)) {
      if (mode.kind === 'edit') {
        leaveEdit()
      } else {
        setMode(null)
      }
    }
  }, [leaveEdit, mode, modeMessage, replies])

  // Opening a chat puts the caret in its box, unless the person is typing elsewhere or a
  // dialog is open. The box is keyed by room: this runs once per chat opened.
  useEffect(() => {
    if (threadRootId) {
      focusInput()
    } else {
      focusMatrixComposer({ ifIdle: true })
    }
  }, [focusInput, threadRootId])

  useEffect(() => {
    setCloudStopRefused(false)
    setCloudStopping(false)
  }, [room.id])

  const running =
    (snapshot.hermesActivity?.roomId === room.id && snapshot.hermesActivity.state === 'running') ||
    (room.assistant && snapshot.hermes === 'running')

  const agentTyping =
    room.assistant &&
    matrixAgentTyping({
      roomId: room.id,
      agentId: snapshot.assistant?.userId,
      typing: snapshot.typing,
      turns: snapshot.localTurns,
      running: snapshot.hermesActivity?.roomId === room.id && snapshot.hermesActivity.state === 'running'
    })

  const cloudUnanswered = cloudAssistant
    ? matrixUnansweredOwnerMessage(
        contextMessages ?? snapshot.messages,
        new Set(
          [snapshot.assistant?.userId, ...(snapshot.agents ?? []).map(agent => agent.userId)].filter(
            (userId): userId is string => Boolean(userId)
          )
        )
      )
    : null

  const cloudStopAvailable = Boolean(cloudAssistant && room.membership === 'join' && window.atumMatrix.cloudAgent)

  const liveCloudStopTarget = cloudStopAvailable
    ? matrixCloudStopTarget({
        messages: contextMessages ?? snapshot.messages,
        turns: snapshot.localTurns,
        roomId: room.id,
        unanswered: cloudUnanswered,
        working: Boolean(agentTyping)
      })
    : undefined

  // The typing signal a question from another device shows through expires in moments, long
  // before a cloud turn does. Once Stop has named that question, keep naming it until the
  // question clears or the room changes, so the button does not vanish mid-turn.
  const cloudStopLatch = useRef<{ roomId: string; unansweredId: string | null; eventId: string } | null>(null)

  if (liveCloudStopTarget) {
    cloudStopLatch.current = {
      roomId: room.id,
      unansweredId: cloudUnanswered?.id ?? null,
      eventId: liveCloudStopTarget
    }
  } else if (
    cloudStopLatch.current &&
    (!cloudStopAvailable ||
      cloudStopLatch.current.roomId !== room.id ||
      cloudStopLatch.current.unansweredId !== (cloudUnanswered?.id ?? null))
  ) {
    cloudStopLatch.current = null
  }

  const cloudStopTarget = liveCloudStopTarget ?? cloudStopLatch.current?.eventId
  // A stop that was already asked for stays disabled until its target clears or moves on: the
  // snapshot clears it, not the request resolving.
  const cloudStopRequested = useRef<string | null>(null)

  const stopCloud = () => {
    const stopTurn = window.atumMatrix.cloudAgent

    if (!cloudStopTarget || !stopTurn || cloudStopRequested.current === cloudStopTarget) {
      return
    }

    cloudStopRequested.current = cloudStopTarget
    setCloudStopRefused(false)
    setCloudStopping(true)
    void stopTurn({ action: 'stopTurn', roomId: room.id, eventId: cloudStopTarget })
      .catch(() => {
        cloudStopRequested.current = null
        setCloudStopRefused(true)
      })
      .finally(() => setCloudStopping(false))
  }

  // An archived channel has no box: the banner stands in its place, says why, and offers the way back to those
  // who may restore it. (The thread panel's box is this same component, so it closes with the channel.)
  if (channelArchived && composerChannel.channel) {
    return <ArchivedChannelBanner abilities={composerChannel.abilities} channel={composerChannel.channel} />
  }

  // A read-only conversation (someone in it left the company) has no box either, whatever Matrix says about power.
  if (channelArchived && composerChannel.conversation) {
    return <ReadOnlyConversationBanner />
  }

  // Until the platform has said whether the channel is archived there is no box either, only a quiet line.
  if (channelUnknown) {
    return (
      <NoticeBand data-matrix-channel-loading role="status" tone="notice">
        {companyConversation
          ? matrixTeamSpaceCopy(locale).conversationsLoading
          : matrixCompanyCopy(locale).loadingChannels}
      </NoticeBand>
    )
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MatrixComposerRuntimeRef initialText={initialDraft || undefined} target={composer} />
      <MatrixStoreDraftSeed roomId={threadRootId ? `${room.id}#${threadRootId}` : room.id} />
      {!botApiRoom && recipient && snapshot.apps?.apps.find(app => app.app_id === recipient)?.bot && (
        <AppBotSetupCard
          app={snapshot.apps.apps.find(app => app.app_id === recipient)!}
          onReadyChange={onBotSetupReady}
          snapshot={snapshot}
        />
      )}
      {!botApiRoom && botOutcome?.state === 'notice' && (
        <NoticeBand
          className="mx-auto mb-3 w-[min(42rem,calc(100%-2rem))]"
          data-app-bot-outcome={botOutcome.code ?? 'notice'}
          role="status"
          tone="notice"
        >
          <span>
            {appBotOutcomeText(
              locale,
              botOutcome.code,
              recipientBot?.display_name ??
                (botOutcome.action && 'app' in botOutcome.action ? botOutcome.action.app : 'Atum')
            )}
          </span>
          {botOutcome.action?.kind === 'open_setup' && (
            <Button
              className="ms-2"
              onClick={() => appResult && void openAppBotChat(snapshot, appResult.appId, locale, fail)}
              size="sm"
              type="button"
              variant="text"
            >
              {appCopy.startBot}
            </Button>
          )}
          {botOutcome.action?.kind === 'connect_account' && appResult && (
            <Button
              className="ms-2"
              onClick={() => connectLimitedAppBot(appResult.appId, fail)}
              size="sm"
              type="button"
              variant="text"
            >
              {appCopy.connectAccount('app' in botOutcome.action ? botOutcome.action.app : '')}
            </Button>
          )}
          {botOutcome.action?.kind === 'open_bot_dm' && appResult && (
            <Button
              className="ms-2"
              onClick={() => void openAppBotChat(snapshot, appResult.appId, locale, fail)}
              size="sm"
              type="button"
              variant="text"
            >
              {appCopy.openBot(recipientBot?.display_name ?? botOutcome.action.app)}
            </Button>
          )}
          {botOutcome.action?.kind === 'open_app_route' && appResult && (
            <Button
              className="ms-2"
              onClick={() => void runMatrixCommand({ kind: 'selectApp', appId: appResult.appId }).catch(fail)}
              size="sm"
              type="button"
              variant="text"
            >
              {appCopy.openBot(recipientBot?.display_name ?? botOutcome.action.app)}
            </Button>
          )}
        </NoticeBand>
      )}
      {composerReply && composerBotTarget && !room.direct && (
        <div
          className="mx-auto mb-2 flex w-[min(42rem,calc(100%-2rem))] items-center gap-2 rounded-(--atum-r-control) border border-(--atum-line) px-3 py-2 text-sm"
          data-app-bot-quote-preview
        >
          {replyComesFromComposerBot ? (
            <span className="min-w-0 flex-1 truncate">
              {appCopy.quotePreview(composerBotTarget.displayName)} {composerReply.body}
            </span>
          ) : includeBotQuote ? (
            <>
              <span className="min-w-0 flex-1 truncate">
                {appCopy.quotePreview(composerBotTarget.displayName)} {composerReply.body}
              </span>
              <Button
                aria-label={appCopy.removeQuote}
                onClick={() => setIncludeBotQuote(false)}
                size="sm"
                type="button"
                variant="text"
              >
                {appCopy.removeQuote}
              </Button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate">{appCopy.plainReplyHint(composerBotTarget.displayName)}</span>
              {isEligibleAppBotQuote({
                body: composerReply.body,
                attachment: composerReply.attachment,
                edited: Boolean(composerReply.edited),
                decryptable: !composerReply.decryptionFailed,
                redacted: Boolean(composerReply.redacted)
              }) && (
                <Button onClick={() => setIncludeBotQuote(true)} size="sm" type="button" variant="text">
                  {appCopy.askAbout(composerBotTarget.displayName)}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {/* People see you typing; your assistant's chat has nobody to tell (it still shows its own). */}
      <MatrixTypingSignal
        enabled={!room.assistant && room.membership === 'join' && snapshot.state === 'ready'}
        roomId={room.id}
      />
      {cloudStopRefused && (
        <NoticeBand
          className="mx-auto mb-2 w-[min(42rem,calc(100%-2rem))]"
          data-matrix-cloud-stop-refused
          role="status"
          tone="notice"
        >
          {t.cloud.stopRefused}
        </NoticeBand>
      )}
      <ComposerPrimitive.Root
        className="group/composer relative z-30 mx-auto w-[min(var(--composer-width),calc(100%-2rem))] max-w-full shrink-0 rounded-[var(--ak-r-xl)] pt-2 pb-[var(--composer-shell-pad-block-end)]"
        data-matrix-kit-composer
        data-slot="composer-root"
      >
        {snapshot.error === 'matrix_disk_full' && !threadRootId && (
          <div
            className="ak-notice ak-notice--warn mb-(--ak-s2) rounded-(--ak-r-xl)"
            data-matrix-composer-notice="disk-full"
            role="status"
          >
            <AlertTriangle aria-hidden className="ak-icon" />
            <span className="ak-notice-main">
              <span className="flex items-center gap-(--ak-s2)">
                <span className="ak-notice-title min-w-0 flex-1">{deviceHealth.diskFullTitle}</span>
                {window.atumMatrix.openStorageSettings && (
                  <span className="ak-notice-actions">
                    <button
                      className="ak-btn ak-btn--sm"
                      onClick={() => void window.atumMatrix.openStorageSettings?.().catch(() => {})}
                      type="button"
                    >
                      {deviceHealth.openStorage}
                    </button>
                  </span>
                )}
              </span>
              <span className="ak-notice-body">{deviceHealth.diskFullBody}</span>
            </span>
          </div>
        )}
        {/* People typing; an agent's chat shows its agent typing in the transcript instead. */}
        {!room.assistant && <MatrixTypingLine snapshot={snapshot} />}
        {!directBotId && (selectableAppRecipients.length > 0 || (recipient && !recipientBot)) && (
          <div aria-label={appCopy.recipient} className="mb-2 px-2" data-matrix-recipients role="group">
            <SegmentedControl
              disabled={sending || Boolean(snapshot.appTurn)}
              onChange={chooseRecipient}
              options={[
                { id: '', label: everyone ? roomGroupCopy.everyone : appCopy.conversation },
                ...selectableAppRecipients.map(app => ({
                  id: app.appId,
                  label: appLocalizedCopy(
                    snapshot.apps?.apps.find(value => value.app_id === app.appId)?.name ?? null,
                    locale,
                    app.userId
                  )
                }))
              ]}
              value={recipient}
            />
            {!recipient && everyone && (
              <p className="mt-1 text-xs text-(--atum-ink-muted)" data-matrix-everyone-note>
                {roomGroupCopy.everyoneNote}
              </p>
            )}
            {groupBudget && (
              <p className="mt-1 text-xs text-(--atum-ink-muted)" data-matrix-group-usage role="status">
                {roomGroupCopy.today(groupBudget.turns, groupBudget.cap)}
                {!groupBudget.allowed
                  ? ` · ${roomGroupCopy.paused}`
                  : ` · ${everyone ? roomGroupCopy.following : roomGroupCopy.called}`}
              </p>
            )}
            {recipient && (
              <p className="mt-1 text-xs text-(--atum-ink-muted)" data-matrix-recipient-note role="status">
                {appReady ? appCopy.contextOff : appCopy.unavailable}
              </p>
            )}
          </div>
        )}
        <ComposerSurface
          actions={
            <>
              {/* The model choice is part of every assistant composer; there is no display
                  preference that can hide it. */}
              {room.assistant && (pickerHasModel || pickerConnectionsOnly) && (
                  <MatrixModelPicker
                    agentPrincipal={roomAgent?.principal}
                    assistantName={assistantName}
                    capability={pickerConnectedModel?.capability}
                    cloud={cloudAnswering}
                    cloudChoice={cloudAnswering ? roomAgent?.cloudModel : undefined}
                    cloudOnly={cloudOnly}
                    connected={pickerConnectedModel}
                    destinationDefault={roomAgent?.modelDestinations?.here}
                    disabled={room.membership !== 'join' || snapshot.state !== 'ready'}
                    fail={fail}
                    here={pickerHere}
                    home={roomAgent?.home}
                    local={pickerLocal}
                    managed={pickerManaged}
                    onAdvanced={onModelSettings}
                    onBackToAtum={backToAtum}
                    onSubscriptions={onSubscriptions}
                    preferenceScope={`account:${snapshot.identity?.userId ?? 'signed-out'}`}
                    room={room}
                  />
                )}
              {room.assistant && window.atumMatrix.voice && (
                <MatrixVoiceDictation
                  disabled={disabled || paused || Boolean(recipient)}
                  fail={fail}
                  key={`${snapshot.identity?.userId}:${snapshot.identity?.deviceId}:${room.id}`}
                  roomId={room.id}
                />
              )}
              {cloudStopTarget ? (
                <button
                  aria-label={matrixActionCopy[locale].cancelHermes}
                  className="ak-iconbtn ak-iconbtn--sm ak-iconbtn--primary disabled:opacity-30"
                  disabled={cloudStopping || cloudStopRequested.current === cloudStopTarget}
                  onClick={stopCloud}
                  type="button"
                >
                  <span aria-hidden className="block size-2.5 rounded-[0.1875rem] bg-current" />
                </button>
              ) : running ? (
                <button
                  aria-label={matrixActionCopy[locale].cancelHermes}
                  className="ak-iconbtn ak-iconbtn--sm ak-iconbtn--primary"
                  onClick={() => void window.atumMatrix.cancelHermes(room.id).catch(fail)}
                  type="button"
                >
                  <span aria-hidden className="block size-2.5 rounded-[0.1875rem] bg-current" />
                </button>
              ) : (
                <MatrixSendButton
                  disabled={disabled || paused || sending}
                  editing={mode?.kind === 'edit'}
                  file={Boolean(staged) && mode?.kind !== 'edit'}
                  label={mode?.kind === 'edit' ? chat.saveEdit : copy.send}
                  onSendFile={() => void sendMessage('', staged).catch(() => {})}
                />
              )}
            </>
          }
          input={
            <ComposerPrimitive.Input
              aria-describedby={fileTooLarge ? `matrix-file-too-large-${room.id}` : undefined}
              aria-label={composerPrompt}
              className="min-h-[1.625rem] w-full resize-none bg-transparent px-1 py-1 text-(--atum-ink) outline-none"
              data-slot="composer-rich-input"
              id={threadRootId ? 'matrix-thread-composer' : 'matrix-composer'}
              onBlur={() => {
                if (!composing.current) {
                  void draftWriter?.flush().catch(() => {})
                }
              }}
              onChange={event => {
                // Editing has its own server event. The normal draft and the IME/caret stay local
                // until that edit ends, then the original composer draft returns unchanged.
                const normalDraft = mode?.kind !== 'edit'
                updateDraftText(
                  event.currentTarget.value,
                  normalDraft,
                  normalDraft && !composing.current && !(event.nativeEvent as InputEvent).isComposing
                )
                setMentionCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
              }}
              onCompositionEnd={event => {
                composing.current = false
                updateDraftText(event.currentTarget.value, mode?.kind !== 'edit')
              }}
              onCompositionStart={() => {
                composing.current = true
              }}
              onKeyDown={event => {
                if (
                  mentionOptions.length > 0 &&
                  !event.nativeEvent.isComposing &&
                  (event.key === 'ArrowDown' || event.key === 'ArrowUp')
                ) {
                  event.preventDefault()
                  setMentionIndex(current =>
                    (current + (event.key === 'ArrowDown' ? 1 : -1) + mentionOptions.length) % mentionOptions.length
                  )

                  return
                }

                if (
                  mentionOptions.length > 0 &&
                  (event.key === 'Enter' || event.key === 'Tab') &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  chooseMention(mentionOptions[Math.min(mentionIndex, mentionOptions.length - 1)]!)

                  return
                }

                // Esc stops replying or editing (and only that: the key goes no further).
                if (event.key === 'Escape' && mode && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelMode()

                  return
                }

                // Up in an empty box edits your last message, as in other Matrix apps.
                if (
                  event.key === 'ArrowUp' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.nativeEvent.isComposing &&
                  !event.currentTarget.value &&
                  mode?.kind !== 'edit' &&
                  lastEditable &&
                  ready
                ) {
                  event.preventDefault()
                  beginEdit(lastEditable)

                  return
                }

                // A staged file with no words: Enter sends the file, as the button does.
                if (
                  mode?.kind !== 'edit' &&
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  staged &&
                  !event.currentTarget.value.trim() &&
                  !paused &&
                  !disabled &&
                  !sending
                ) {
                  event.preventDefault()
                  void sendMessage('', staged).catch(() => {})
                }
              }}
              onSelect={event => setMentionCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              placeholder={pausedHint || (running && room.assistant && !threadRootId ? copy.addToRequest : composerPrompt)}
              ref={input}
              submitMode={paused ? 'none' : 'enter'}
            />
          }
          leading={withFormattingToggle(
            threadRootId && !companyFiles ? undefined : appActions.length > 0 && composerApp && !cloudAssistant ? (
              <>
                {/* An official bot's chat always has an app recipient (the bot itself), so
                    `recipient` must not disable this: the "+" is how its screens open. */}
                <DropdownMenu>
                  <Tip label={appCopy.actions}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={appCopy.actions}
                        className="atum-icon-btn size-7"
                        disabled={disabled}
                        size="icon"
                        variant="ghost"
                      >
                        <Plus aria-hidden className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </Tip>
                  <DropdownMenuContent align="start" side="top">
                    {appActions.map(route => {
                      const Icon = appSurfaceIcon(route.icon)

                      return (
                        <DropdownMenuItem
                          disabled={!onAppAction}
                          key={route.id}
                          onSelect={() => onAppAction?.(composerApp.app_id, route.id)}
                        >
                          <Icon aria-hidden />
                          {appLocalizedCopy(route.label, locale, route.id)}
                        </DropdownMenuItem>
                      )
                    })}
                    {/* A message to an app carries text only: no file to attach in its chat. */}
                    {!recipient && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={attachClosed} onSelect={() => fileInput.current?.click()}>
                          <Files aria-hidden />
                          {copy.attach}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <input
                  aria-label={copy.attach}
                  className="sr-only"
                  disabled={disabled || Boolean(recipient) || attachClosed}
                  onChange={stageAttachment}
                  ref={fileInput}
                  tabIndex={-1}
                  type="file"
                />
              </>
            ) : plusKinds.length > 0 ? (
              <>
                <ComposerPlusMenu availability={plusAvailability} disabled={disabled} onAction={runComposerPlus} />
                <input
                  accept="image/*"
                  aria-label={copy.attachPhotos}
                  className="sr-only"
                  disabled={disabled || Boolean(recipient) || attachClosed}
                  onChange={stageAttachment}
                  ref={photoInput}
                  tabIndex={-1}
                  type="file"
                />
                <input
                  aria-label={copy.attach}
                  className="sr-only"
                  disabled={disabled || Boolean(recipient) || attachClosed}
                  onChange={stageAttachment}
                  ref={fileInput}
                  tabIndex={-1}
                  type="file"
                />
              </>
            ) : (
              <Tip
                label={
                  attachClosed
                    ? companyConversation || privateCos
                      ? matrixTeamSpaceCopy(locale).conversationAttachments
                      : composerChannel.channel?.visibility === 'private'
                        ? matrixTeamSpaceCopy(locale).privateAttachments
                        : matrixTeamSpaceCopy(locale).channelAttachments
                    : copy.attach
                }
              >
                <span className="inline-flex">
                  <Button
                    aria-label={copy.attach}
                    className="atum-icon-btn size-7"
                    data-attach-closed={attachClosed || undefined}
                    disabled
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Plus aria-hidden className="size-4" />
                  </Button>
                </span>
              </Tip>
            )
          )}
          stacked
          surfaceRef={node => void node?.setAttribute('data-pet-perch', 'composer')}
          top={
            notice || (teamSpaceBox && formattingOpen) || mode || staged || mentionOptions.length > 0 ||
            companyAINotice ? (
              <>
                {notice}
                {(mentionOptions.length > 0 || companyAINotice) && (
                  <TeamSpaceMentionMenu
                    companyAINotice={companyAINotice}
                    copy={matrixTeamSpaceCopy(locale)}
                    onPick={chooseMention}
                    options={mentionOptions}
                    selected={Math.min(mentionIndex, mentionOptions.length - 1)}
                  />
                )}
                {/* Team Space's formatting row, opened from the box's "Aa" (markdown underneath). */}
                {teamSpaceBox && formattingOpen && (
                  <TeamSpaceFormattingBar disabled={disabled} input={input} onFormat={formatText} />
                )}
                {mode && (
                  <MatrixComposerContext
                    assistantChat={assistantChat}
                    assistantName={assistantName}
                    mode={mode}
                    name={
                      mode.message.own
                        ? t.dm.you
                        : mode.message.sender === snapshot.assistant?.userId
                          ? assistantName
                          : matrixPersonLine(mode.message.sender, chatPeople)
                    }
                    onCancel={cancelMode}
                  />
                )}
                {staged && (
                  <div className="px-1 pt-1" data-matrix-staged-file>
                    <MatrixFileCard
                      action={
                        <Tip label={chat.removeFile(staged.name)}>
                          <Button
                            aria-label={chat.removeFile(staged.name)}
                            disabled={sending}
                            onClick={() => {
                              setStaged(null)
                              input.current?.focus({ preventScroll: true })
                            }}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <X aria-hidden />
                          </Button>
                        </Tip>
                      }
                      name={staged.name}
                      size={staged.size}
                    />
                  </div>
                )}
              </>
            ) : undefined
          }
        />
      </ComposerPrimitive.Root>
      {draftWriter && draftWriter.status !== 'saved' && draftText.trim() && (
        <p
          className="mx-auto w-[min(var(--composer-width),calc(100%-2rem))] px-3 pb-2 text-xs text-(--atum-ink-faint)"
          data-matrix-draft-save-state={draftWriter.status}
          role="status"
        >
          {draftWriter.status === 'pending' ? chat.draftPending : chat.draftSaveFailed}
        </p>
      )}
      {/* Paused (the assistant starting, or waiting on something): the box's hint says why
          Send is off, but a placeholder goes with the first letter typed. Once there are words
          the same hint stays, faint, under the box, so Enter doing nothing is never unexplained. */}
      {paused && draftText.trim() && pausedHint && (
        <p
          className="mx-auto w-[min(var(--composer-width),calc(100%-2rem))] px-3 pb-2 text-xs text-(--atum-ink-faint)"
          data-matrix-paused-hint
          role="status"
        >
          {pausedHint}
        </p>
      )}
      {fileTooLarge && (
        <p
          className="mx-auto w-[min(var(--composer-width),calc(100%-2rem))] px-3 pb-2 text-xs text-(--atum-danger)"
          id={`matrix-file-too-large-${room.id}`}
          role="alert"
        >
          {copy.fileTooLarge}
        </p>
      )}
      {result && (
        <p
          className={invocationNoticeVisible(result.state) ? 'px-4 text-xs text-(--atum-ink-muted)' : 'sr-only'}
          data-matrix-invocation-notice={result.state}
          role="status"
        >
          {invocationCopy(result, locale)}
        </p>
      )}
      {hasTaskFiles && (
        <div
          aria-label={driveCopy.selectedFiles}
          className="flex flex-wrap items-center gap-2 px-4 text-xs"
          data-matrix-task-files
          role="group"
        >
          {taskSelections.map(selection => (
            <span className="rounded-full bg-(--atum-hover) px-2 py-1" key={selection.id}>
              {selection.name} ·{' '}
              {selection.mode === 'read'
                ? driveCopy.useRead
                : selection.mode === 'replace'
                  ? driveCopy.replace
                  : driveCopy.createOutput}
              <Button
                aria-label={`${driveCopy.removeSelection} ${selection.name}`}
                onClick={() => removeMatrixDriveTaskSelection(selection.id)}
                size="icon"
                type="button"
                variant="text"
              >
                ×
              </Button>
            </span>
          ))}
          <Button onClick={clearMatrixDriveTaskSelections} size="sm" variant="text">
            {driveCopy.clearSelection}
          </Button>
          {taskStatus !== 'ready' && (
            <span role="status">{taskStatus === 'checking' ? '…' : driveCopy.taskUnavailable}</span>
          )}
        </div>
      )}
      {taskNotice && (
        <p className="px-4 text-xs text-(--atum-ink-muted)" role="status">
          {taskNotice === 'files_unavailable' ? driveCopy.filesUnavailable : driveCopy.deliveryUnknown}
        </p>
      )}
      {appResult && (
        <div
          className={invocationNoticeVisible(appResult.result.state) ? 'px-4 text-xs text-(--atum-ink-muted)' : 'sr-only'}
          data-matrix-app-notice={appResult.result.state}
          role="status"
        >
          {appResult.result.state === 'published'
            ? appCopy.published
            : appResult.result.state === 'publication_pending'
              ? appCopy.pending
              : appResult.result.state === 'unknown'
                ? appCopy.unknown
                : appCopy.declined}
          {appResult.result.state === 'publication_pending' && (
            <Button
              disabled={sending || Boolean(snapshot.appTurn)}
              onClick={() => {
                setSending(true)
                void window.atumMatrix
                  .apps!.invoke(appResult.appId, appResult.roomId, appResult.eventId)
                  .then(result => setAppResult({ ...appResult, result }))
                  .catch(fail)
                  .finally(() => setSending(false))
              }}
              size="sm"
              variant="text"
            >
              {appCopy.retry}
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        confirmLabel={matrixTeamSpaceCopy(locale).mentionChannelConfirm}
        description={matrixTeamSpaceCopy(locale).mentionChannelConfirmBody}
        dismissOnConfirm
        onClose={closeRoomMentionConfirmation}
        onConfirm={confirmRoomMention}
        open={Boolean(roomMentionConfirmation)}
        title={matrixTeamSpaceCopy(locale).mentionChannelConfirmTitle(humanMentionCandidates.length)}
      />
    </AssistantRuntimeProvider>
  )
}

/** The same binding object while its facts stay the same, so transcripts recompute only on a real change. */
function useStableCompanyBinding(
  binding: MatrixCompanyPresentationBinding | undefined
): MatrixCompanyPresentationBinding | undefined {
  const key = binding ? JSON.stringify(binding) : ''

  return useMemo(() => (key ? (JSON.parse(key) as MatrixCompanyPresentationBinding) : undefined), [key])
}

function threadTranscriptMessages(root: MatrixMessage, replies: readonly MatrixMessage[]) {
  const source = new Map([root, ...replies].map(message => [message.id, message]))

  return [root, ...replies].map((message, index, messages) => {
    const previous = messages[index - 1]
    const next = messages[index + 1]
    const replied = message.replyTo ? source.get(message.replyTo) : undefined

    return {
      id: message.id,
      role: message.own ? ('user' as const) : ('assistant' as const),
      content: [{ type: 'text' as const, text: message.body }],
      createdAt: new Date(message.timestamp),
      metadata: {
        custom: {
          matrix: message,
          consecutiveReply: Boolean(previous && message.replyTo === previous.id),
          runStart: matrixRunBreak(previous, message),
          runEnd: !next || matrixRunBreak(message, next),
          dayStart: teamSpaceNewDay(previous?.timestamp, message.timestamp),
          // The first message says how many replies follow it (Slack's line under a thread's root).
          ...(index === 0 ? { threadReplies: replies.length } : {}),
          ...(replied ? { reply: replied } : {})
        }
      }
    }
  })
}

function MatrixThreadDetail({
  assistantName,
  blocked,
  cloudOnly,
  fail,
  onBack,
  onSubscriptions,
  room,
  rootId,
  snapshot
}: {
  assistantName: string
  blocked: boolean
  cloudOnly: boolean
  fail(cause?: unknown): void
  onBack?: () => void
  onSubscriptions?: () => void
  room: MatrixRoom
  rootId: string
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const chat = useChatCopy()
  const forwarding = useMatrixForwarding(snapshot)
  const copy = matrixThreadCopy(locale)
  const summary = snapshot.threads?.find(thread => thread.root.id === rootId)
  const root = summary?.root ?? snapshot.messages.find(message => message.id === rootId)
  const replies = useMemo(() => summary?.replies ?? [], [summary?.replies])
  const historyReveal = useStore($matrixHistoryReveal)
  const accountKey = snapshot.identity ? `${snapshot.identity.userId}:${snapshot.identity.deviceId}` : 'signed-out'
  const captureCard = useCompanyBoardCapture(accountKey, room)
  const [composer, setComposer] = useState<MatrixComposerActions | null>(null)
  const threadComposer = useMemo(() => (composer ? { ...composer, replies: false } : null), [composer])
  const [followPending, setFollowPending] = useState(false)
  const [followed, setFollowed] = useState(Boolean(summary?.followed))
  const readAttempt = useRef<string | null>(null)
  // The header names the place as the channel's own header does ("#chung"), never the raw room name.
  const placeTitle = useChannelTitle(teamSpaceAccountKey(snapshot.identity), room, (room.name ?? '').trim().replace(/^#/, ''))
  const conversationTitle = useConversationTitle(teamSpaceAccountKey(snapshot.identity), room, room.name?.trim() ?? '')
  const place = room.companyConversation ? conversationTitle : `#${placeTitle.replace(/^#/, '')}`

  // The channel's own Chief of Staff: its agent-turns/1.6 working line and interim remarks in this
  // thread are drawn as a personal agent's are in its chat (one live line under the transcript). The
  // view is read again whenever the channel's joined members change (a reassigned agent joins, the old
  // one leaves) or a company marker arrives from an agent no fresh view has bound, and at least every
  // half minute while the thread shows company markers (an answer older than a minute no longer
  // binds). Until a read answers, no company line or remark is drawn as one.
  const channelMembers = (room.participants ?? [])
    .filter(member => member.membership === 'join')
    .map(member => member.userId)
    .sort()
    .join('\n')

  const companyAIAccount = teamSpaceAccountKey(snapshot.identity)
  const companyAIScope = room.companyChannel ? companySpaceScope(companyAIAccount, room.companyChannel.companyId) : ''
  const cachedCompanyAI = useStore($companyAIStatuses)[companyAIScope]
  const strangerSignal = useCompanyStrangerSignal(replies, cachedCompanyAI?.agent.userId)

  const { fresh: companyAIFresh, view: companyAI } = useCompanyAIStatus(companyAIAccount, room.companyChannel?.companyId, {
    refreshKey: `${channelMembers}\u0000${strangerSignal}`,
    maxAgeMs: replies.some(message => message.company) ? COMPANY_CHANNEL_BINDING_MAX_AGE_MS : undefined
  })

  const companyPresentation = useStableCompanyBinding(
    companyChannelPresentationBinding(room, companyAI, companyAIFresh)
  )

  const companyName = companyAI?.agent.displayName ?? matrixCompanyBoardCopy(locale).chiefOfStaff
  const companyTurns = companyTurnMemory(companyAIAccount)

  const admitted = useMemo(
    () => matrixAdmitCompanyPresentation(replies, companyPresentation, rootId),
    [companyPresentation, replies, rootId]
  )

  const companyNow = useCompanyLineClock(admitted, companyTurns)

  const { messages, workingLine } = useMemo(() => {
    if (!root) {
      return { messages: [], workingLine: undefined }
    }

    const lineAgents = new Set(companyPresentation ? [companyPresentation.agentUserId] : [])

    const visible = matrixHideEndedTransientLines(admitted, lineAgents, { memory: companyTurns, now: companyNow })

    return {
      messages: threadTranscriptMessages(
        root,
        visible.filter(message => !isMatrixTransientLine(message, lineAgents))
      ),
      workingLine: companyPresentation
        ? matrixLiveWorkingLine(visible, lineAgents, companyPresentation.agentUserId)
        : undefined
    }
  }, [admitted, companyNow, companyPresentation, companyTurns, root])

  const transcript = useExternalStoreRuntime({
    messages,
    convertMessage: message => message,
    isRunning: false,
    isDisabled: true,
    onNew: async () => {}
  })

  useEffect(() => setFollowed(Boolean(summary?.followed)), [rootId, summary?.followed])

  useEffect(() => {
    const attempt = summary?.unread ? `${rootId}:${summary.replyCount}:${summary.lastActivityAt}` : null

    if (!attempt || readAttempt.current === attempt) {
      return
    }

    const acknowledge = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus() || readAttempt.current === attempt) {
        return
      }

      readAttempt.current = attempt
      void window.atumMatrix.command({ kind: 'threadRead', roomId: room.id, rootId }).catch(() => {
        if (readAttempt.current === attempt) {
          readAttempt.current = null
        }
      })
    }

    acknowledge()
    window.addEventListener('focus', acknowledge)
    document.addEventListener('visibilitychange', acknowledge)

    return () => {
      window.removeEventListener('focus', acknowledge)
      document.removeEventListener('visibilitychange', acknowledge)
    }
  }, [room.id, rootId, summary?.lastActivityAt, summary?.replyCount, summary?.unread])

  if (!root) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-sm text-(--atum-ink-muted)">
        <div>
          <p>{copy.threadUnavailable}</p>
          {onBack && (
            <Button className="mt-3" onClick={onBack} size="sm" variant="secondary">
              {copy.backToThreads}
            </Button>
          )}
        </div>
      </div>
    )
  }

  const toggleFollow = () => {
    const next = !followed
    setFollowPending(true)
    void window.atumMatrix
      .command({ kind: 'threadFollow', roomId: room.id, rootId, followed: next })
      .then(() => setFollowed(next))
      .catch(fail)
      .finally(() => setFollowPending(false))
  }

  const followLabel = followed ? copy.unfollow : copy.follow

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {forwarding.dialog}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-(--atum-line) py-2 ps-3 pe-12">
          {onBack && (
            <Tip label={copy.backToThreads}>
              <Button aria-label={copy.backToThreads} onClick={onBack} size="icon-sm" type="button" variant="ghost">
                <ArrowLeft aria-hidden />
              </Button>
            </Tip>
          )}
          <p className="min-w-0 flex-1 truncate [font:var(--ak-t-headline)] text-(--ak-ink)">{copy.thread}</p>
          <span className="truncate [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-matrix-thread-place>
            {place}
          </span>
          {/* Mattermost's thread header: the follow state is a visible capsule that says what it is
              ("Following") and toggles; the notification level stays in the overflow. */}
          <Tip label={followLabel}>
            <button
              className={`ak-btn ak-btn--sm shrink-0 ${followed ? '' : 'ak-btn--plain'}`}
              data-matrix-thread-follow={followed ? 'following' : 'follow'}
              disabled={followPending}
              onClick={toggleFollow}
              type="button"
            >
              {followed ? copy.following : copy.follow}
            </button>
          </Tip>
          <DropdownMenu>
            <Tip label={copy.threadOptions}>
              <DropdownMenuTrigger asChild>
                <button aria-label={copy.threadOptions} className="ak-iconbtn" type="button">
                  <MoreHorizontal aria-hidden className="ak-icon" />
                </button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="end">
              <MatrixNotificationLevelMenu
                fail={fail}
                roomId={room.id}
                rootId={rootId}
                snapshot={snapshot}
                value={snapshot.notificationPolicy?.threadOverrides[room.id]?.[rootId] ?? 'inherit'}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <AssistantRuntimeProvider runtime={transcript}>
          <ConversationActions.Provider
            value={{
              room,
              accountKey,
              captureCard,
              cloud: false,
              assistantUserId: snapshot.assistant?.userId,
              ownerUserId: snapshot.identity?.userId,
              ownerDeviceId: snapshot.identity?.deviceId,
              members: snapshot.members,
              agents: snapshot.agents,
              appBots: snapshot.apps?.apps,
              assistantName,
              fail,
              openAppBot: appId => openAppBotChat(snapshot, appId, locale, fail),
              hermes: snapshot.hermes,
              listening: false,
              recover: false,
              assistantEligible: false,
              topUp: () => openMatrixTopUp(snapshot),
              agentUserIds: [snapshot.assistant?.userId, ...(snapshot.agents ?? []).map(agent => agent.userId)].filter(
                (value): value is string => Boolean(value)
              ),
              citationSenderName: eventId => {
                const cited = snapshot.messages.find(item => item.id === eventId)

                return cited && !cited.own
                  ? snapshot.members?.find(member => member.userId === cited.sender)?.name
                  : undefined
              },
              composer: threadComposer,
              latestOwnId: [...messages]
                .reverse()
                .find(message => (message.metadata.custom.matrix as MatrixMessage).own)?.id,
              forward: forwarding.open,
              threadRootId: rootId
            }}
          >
            <div className="relative min-h-0 flex-1" data-matrix-thread-transcript>
              <AtumChatTranscript
                clampToComposer={false}
                components={{ UserMessage: MatrixMessageBubble, AssistantMessage: MatrixMessageBubble }}
                loadingIndicator={
                  workingLine ? (
                    <MatrixAgentWorking
                      id={workingLine.sender}
                      label={chat.typingOne(companyName)}
                      line={workingLine}
                      name={companyName}
                      typing={false}
                    />
                  ) : undefined
                }
                revealMessageId={
                  historyReveal?.owner === 'company' &&
                  historyReveal.roomId === room.id &&
                  historyReveal.threadRootId === rootId &&
                  historyReveal.accountKey === accountKey
                    ? historyReveal.eventId
                    : undefined
                }
                sessionKey={`${room.id}:${rootId}`}
              />
            </div>
          </ConversationActions.Provider>
        </AssistantRuntimeProvider>
      </div>
      {room.membership === 'join' && (
        <ComposerDock data-matrix-thread-composer-wrap>
          <MatrixComposer
            assistantName={assistantName}
            bind={setComposer}
            blocked={blocked}
            cloudOnly={cloudOnly}
            contextMessages={[root, ...replies]}
            draftTarget={{ roomId: room.id, threadRootId: rootId }}
            fail={fail}
            key={`${snapshot.identity?.userId ?? ''}:${room.id}:${rootId}`}
            onSubscriptions={onSubscriptions}
            room={room}
            snapshot={snapshot}
            threadRootId={rootId}
          />
        </ComposerDock>
      )}
    </div>
  )
}

function MatrixThreadPanel({
  assistantName,
  blocked,
  cloudOnly,
  compact,
  fail,
  onChange,
  onClose,
  onSubscriptions,
  room,
  snapshot,
  view
}: {
  assistantName: string
  blocked: boolean
  cloudOnly: boolean
  compact: boolean
  fail(cause?: unknown): void
  onChange(view: MatrixThreadView): void
  onClose(): void
  onSubscriptions?: () => void
  room: MatrixRoom
  snapshot: MatrixSnapshot
  view: MatrixThreadView
}) {
  const { locale } = useI18n()
  const copy = matrixThreadCopy(locale)
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }), [locale])
  const threads = snapshot.threads ?? []

  // A keyboard-opened panel returns to the exact control that opened it. Mouse clicks do not
  // reliably focus buttons on every WebView (and fireEvent.click deliberately does not), so an
  // unrelated focused composer must never become the panel's return target; in that case the
  // stable header Threads button below is the accessible fallback.
  const opener = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLButtonElement ? document.activeElement : null
  )

  const filtered = threads.filter(thread =>
    view.filter === 'following' ? thread.followed : view.filter === 'unread' ? thread.unread : true
  )

  const back = useCallback(() => {
    const rootId = view.rootId
    onChange({ ...view, rootId: undefined, fromList: undefined })
    requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-matrix-thread-row]')].find(
        element => element.dataset.matrixThreadRow === rootId
      )

      row?.focus({ preventScroll: true })
    })
  }, [onChange, view])

  const close = useCallback(() => {
    onClose()
    requestAnimationFrame(() => {
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>('[data-matrix-threads-button], [data-matrix-chat-menu="company"]')

      target?.focus({ preventScroll: true })
    })
  }, [onClose])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }

      if (view.rootId && view.fromList) {
        back()
      } else {
        close()
      }
    }

    window.addEventListener('keydown', escape)

    return () => window.removeEventListener('keydown', escape)
  }, [back, close, view.rootId])

  return (
    <aside
      aria-label={copy.threads}
      className={`absolute inset-y-0 right-0 z-30 flex flex-col border-l border-(--atum-line) bg-(--atum-main-bg,var(--atum-card)) ${compact ? 'w-full shadow-xl' : 'w-[26rem]'}`}
      data-matrix-thread-panel
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {view.rootId ? (
          <MatrixThreadDetail
            assistantName={assistantName}
            blocked={blocked}
            cloudOnly={cloudOnly}
            fail={fail}
            onBack={view.fromList ? back : undefined}
            onSubscriptions={onSubscriptions}
            room={room}
            rootId={view.rootId}
            snapshot={snapshot}
          />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-3 border-b border-(--atum-line) py-3 ps-4 pe-12">
              <Messages aria-hidden className="size-4" />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-(--atum-ink)">{copy.threads}</h2>
            </div>
            <div className="shrink-0 px-4 py-3">
              <SegmentedControl
                className="w-full"
                onChange={filter => onChange({ ...view, filter })}
                options={[
                  { id: 'recent', label: copy.recent },
                  { id: 'following', label: copy.following },
                  { id: 'unread', label: copy.unread }
                ]}
                value={view.filter}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-matrix-thread-list={view.filter}>
              {filtered.length ? (
                <ul className="space-y-1">
                  {filtered.map(thread => (
                    <li key={thread.root.id}>
                      <button
                        className="w-full rounded-(--atum-r-button) px-3 py-2.5 text-left hover:bg-(--atum-hover) focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--atum-accent)"
                        data-matrix-thread-row={thread.root.id}
                        onClick={() => onChange({ ...view, rootId: thread.root.id, fromList: true })}
                        type="button"
                      >
                        <span className="line-clamp-2 text-sm text-(--atum-ink)">{thread.root.body || '…'}</span>
                        <span className="mt-1 flex items-center gap-2 text-xs text-(--atum-ink-muted)">
                          <span>{copy.replies(thread.replyCount)}</span>
                          <span aria-hidden>·</span>
                          <span>{date.format(thread.lastActivityAt)}</span>
                          {thread.highlights > 0 && (
                            <span className="rounded-full bg-(--atum-accent) px-1.5 text-(--atum-on-accent)">
                              @{thread.highlights}
                            </span>
                          )}
                          {thread.unread && (
                            <span aria-label={copy.unread} className="ms-auto size-2 rounded-full bg-(--atum-accent)" />
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="grid min-h-40 place-items-center px-4 text-center text-sm text-(--atum-ink-muted)">
                  {threads.length ? copy.noFilteredThreads : copy.noThreads}
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <Tip label={copy.closeThreads}>
        <Button
          aria-label={copy.closeThreads}
          className="absolute top-2 right-2"
          onClick={close}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </Tip>
    </aside>
  )
}

/**
 * An empty channel opens on its intro, where the first message will land (Slack's empty channel): the
 * name, what it is for, who made it and when, and the next step. With nobody to invite or add, the
 * company's assistant can post the first message instead.
 */
function CompanyChannelEmptyState({
  accountKey,
  assistant,
  assistantEnabled,
  onAsk,
  room
}: {
  accountKey: string
  assistant: string
  assistantEnabled: boolean
  onAsk(prompt: string): void
  room: MatrixRoom
}) {
  const { locale } = useI18n()
  const copy = matrixTeamSpaceCopy(locale)

  return (
    <div className="row-start-2 min-w-0" data-matrix-company-channel-empty>
      <ChannelIntroFor
        accountKey={accountKey}
        emphasis
        extra={
          assistantEnabled ? (
            <button className="ak-btn ak-btn--sm" onClick={() => onAsk(copy.welcomePrompt(assistant))} type="button">
              {copy.askAssistant}
            </button>
          ) : undefined
        }
        placeholderName={room.name.replace(/^#/, '')}
        room={room}
      />
    </div>
  )
}

function useMatrixForwarding(snapshot: MatrixSnapshot) {
  const { locale, t } = useI18n()
  const channelRecords = useStore($companyChannels)
  const conversationRecords = useStore($companyConversations)
  const selfRefRecords = useStore($companySelfRefs)
  const [source, setSource] = useState<{ message: MatrixMessage; name: string; roomId: string }>()
  const [companyNames, setCompanyNames] = useState<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    if (source && source.roomId !== snapshot.roomId) {
      setSource(undefined)
    }
  }, [snapshot.roomId, source])

  useEffect(() => {
    if (!source || !window.atumMatrix.companies) {
      return
    }

    let live = true
    void window.atumMatrix.companies.request({ action: 'list' }).then(result => {
      if (!live || !result.ok || !('companies' in result.value)) {
        return
      }

      setCompanyNames(new Map(result.value.companies.map(company => [company.id, company.displayName])))
    }).catch(() => {})

    return () => { live = false }
  }, [source])

  const selfRefs = useMemo(() => new Map(
    Object.entries(selfRefRecords).map(([key, value]) => [key.slice(key.lastIndexOf('\n') + 1), value])
  ), [selfRefRecords])

  const forwardHandles = useMatrixHandles(snapshot.identity?.userId)

  const targets = useMemo(() => source ? matrixForwardTargets({
    rooms: snapshot.rooms,
    ownerUserId: snapshot.identity?.userId,
    agents: snapshot.agents,
    apps: snapshot.apps?.apps,
    sourceRoomId: source.roomId,
    encryptedFile: Boolean(source.message.attachment && source.message.encrypted),
    defaultAssistantName: t.matrixShell.assistantName,
    companyNames,
    channelStates: Object.values(channelRecords),
    conversationStates: Object.values(conversationRecords),
    companySelfRefs: selfRefs,
    handles: forwardHandles
  }) : [], [channelRecords, companyNames, conversationRecords, forwardHandles, selfRefs, snapshot.agents, snapshot.apps?.apps,
    snapshot.identity?.userId, snapshot.rooms, source, t.matrixShell.assistantName])

  const send = async (target: MatrixForwardTarget, dialogNonce: string) => {
    if (!source) {
      throw new Error('matrix_forward_invalid')
    }

    const eventId = await window.atumMatrix.command({
      kind: 'forward',
      roomId: source.roomId,
      eventId: source.message.id,
      toRoomId: target.room.id,
      dialogNonce
    })

    if (typeof eventId !== 'string' || !eventId.startsWith('$')) {
      throw new Error('matrix_forward_failed')
    }

    if (matrixForwardNeedsLocalInvocation(target)) {
      await window.atumMatrix.invokeHermes(target.room.id, eventId, locale)
    }
  }

  const sourceRoom = snapshot.rooms.find(room => room.id === source?.roomId)
  const companyId = sourceRoom?.companyChannel?.companyId ?? sourceRoom?.companyConversation?.companyId

  return {
    open: (message: MatrixMessage, name: string) => {
      if (snapshot.roomId) {
        setSource({ message, name, roomId: snapshot.roomId })
      }
    },
    dialog: source ? (
      <MatrixForwardDialog
        key={source.message.id}
        onOpenChange={open => { if (!open) {setSource(undefined)} }}
        onSend={send}
        open
        source={source.message}
        sourceName={source.name}
        targets={targets}
        teamName={companyId ? companyNames.get(companyId) ?? sourceRoom?.name : undefined}
      />
    ) : null
  }
}

function Conversation({
  blocked,
  cloudOnly,
  compact,
  fail,
  onClosePins,
  onCloseThreads,
  pinsOpen,
  snapshot,
  settled,
  threadView,
  onThreadViewChange,
  onModelSettings,
  onBackToAtum,
  onPlanSignIn,
  onOwnModel,
  onSubscriptions,
  onPreview,
  onRestoreMessages,
  onReviewDevices,
  onCheckInSettings,
  onAppAction,
  onSent
}: {
  blocked: boolean
  cloudOnly: boolean
  compact: boolean
  fail: (cause?: unknown) => void
  onClosePins(): void
  onCloseThreads(): void
  pinsOpen: boolean
  snapshot: MatrixSnapshot
  settled: boolean
  threadView: MatrixThreadView | null
  onThreadViewChange(view: MatrixThreadView): void
  onModelSettings?: () => void
  /** Switches the default assistant back to Atum's model through native main. */
  onBackToAtum?: () => Promise<unknown> | void
  /** Opens the account-level ChatGPT recovery, independent of this assistant's backend. */
  onPlanSignIn?: () => void
  /** Opens Settings › Advanced › Subscriptions for the account-wide connections. */
  onSubscriptions?: () => void
  /** Settings › Advanced, where a model of the person's own is set up (out of Protons). */
  onOwnModel?: () => void
  onPreview: () => void
  onRestoreMessages?: () => void
  onReviewDevices?: (thisMac: boolean) => void
  /** The default assistant's card, where check-ins (and its pet) are changed. */
  onCheckInSettings?: () => void
  onAppAction?: (appId: string, routeId: string) => void
  onSent?: () => void
}) {
  const copy = useMatrixCopy()
  const chat = useChatCopy()
  const appCopy = useAppCopy()
  const conversationCopy = useConversationCopy()
  const { locale, t } = useI18n()
  const room = snapshot.rooms.find(value => value.id === snapshot.roomId)
  const appHistory = useAppBotHistory(snapshot, room)
  const selectedRoomId = room?.id
  const historyReveal = useStore($matrixHistoryReveal)
  const forwarding = useMatrixForwarding(snapshot)
  const accountKey = snapshot.identity ? `${snapshot.identity.userId}:${snapshot.identity.deviceId}` : 'signed-out'
  const historyMessagesRef = useRef(snapshot.messages)
  const historyThreadsRef = useRef(snapshot.threads ?? [])

  const historyProjectionCount =
    snapshot.messages.length + (snapshot.threads ?? []).reduce((count, thread) => count + 1 + thread.replies.length, 0)

  const historyMessageCountRef = useRef(historyProjectionCount)
  const failRef = useRef(fail)
  historyMessagesRef.current = snapshot.messages
  historyThreadsRef.current = snapshot.threads ?? []
  historyMessageCountRef.current = historyProjectionCount
  failRef.current = fail

  const loadEarlier = useCallback(async () => {
    if (!selectedRoomId) {
      return false
    }

    const before = historyMessageCountRef.current
    const [page, appHasMore] = await Promise.all([loadTimelineHistoryPage(selectedRoomId), appHistory.loadEarlier()])
    await waitForTimelineProjection(() => historyMessageCountRef.current, before)

    return page.hasMore || appHasMore
  }, [appHistory, selectedRoomId])

  // Company search and the pinned panel may name an event older than the selected room's initial
  // renderer window. Room scrollback feeds both the channel and thread projections, so one
  // bounded path can reveal either without a second transcript.
  useEffect(() => {
    if (historyReveal?.owner !== 'company' && historyReveal?.owner !== 'pinned') {
      return
    }

    if (historyReveal.owner === 'company' && historyReveal.accountKey !== accountKey) {
      clearExactMatrixHistoryReveal(historyReveal)

      return
    }

    if (historyReveal.roomId !== selectedRoomId) {
      if (historyReveal.owner === 'pinned') {clearExactMatrixHistoryReveal(historyReveal)}

      return
    }

    let cancelled = false
    let jumpFrame = 0

    const projected = () =>
      companyHistoryRevealProjected(historyReveal, historyMessagesRef.current, historyThreadsRef.current)

    const retire = (failed = false) => {
      if (cancelled) {
        return
      }

      clearExactMatrixHistoryReveal(historyReveal)

      if (failed) {failRef.current(new Error(historyReveal.owner === 'company'
        ? 'matrix_company_search_result_unavailable' : 'matrix_pinned_message_unavailable'))}
    }

    const reveal = () => {
      let attempts = 0

      const tryJump = () => {
        if (cancelled) {
          return
        }

        const selector = historyReveal.threadRootId
          ? '[data-matrix-thread-transcript]'
          : '[data-matrix-channel-transcript]'

        const transcript = window.document.querySelector<HTMLElement>(selector)

        if (transcript && jumpToMessage(historyReveal.eventId, transcript)) {
          retire()

          return
        }

        if (++attempts >= 60) {
          retire(true)

          return
        }

        jumpFrame = requestAnimationFrame(tryJump)
      }

      jumpFrame = requestAnimationFrame(tryJump)
    }

    if (projected()) {
      reveal()

      return () => {
        cancelled = true
        cancelAnimationFrame(jumpFrame)
      }
    }

    void (async () => {
      for (let page = 0; page < MATRIX_TIMELINE_SEARCH_PAGES && !cancelled; page++) {
        const before = historyMessageCountRef.current
        const result = await loadTimelineHistoryPage(historyReveal.roomId)
        await waitForTimelineProjection(() => historyMessageCountRef.current, before)

        if (cancelled) {
          return
        }

        if (projected()) {
          reveal()

          return
        }

        if (!result.hasMore) {
          retire(true)

          return
        }
      }

      retire(true)
    })().catch(() => retire(true))

    return () => {
      cancelled = true
      cancelAnimationFrame(jumpFrame)
    }
  }, [accountKey, historyReveal, selectedRoomId])
  // Every "out of / low on Protons" here opens the same top-up as the Store and Settings.
  const topUp = () => openMatrixTopUp(snapshot)
  const [composer, setComposerState] = useState<MatrixComposerActions | null>(null)
  const composerRef = useRef<MatrixComposerActions | null>(null)

  const setComposer = useCallback((next: MatrixComposerActions | null) => {
    composerRef.current = next
    setComposerState(next)
  }, [])

  // One conversation per agent: a chat of the agent's that is no longer its main (0.20's move to
  // a plain room, or a change made on another device) gives way to the main, with what was typed
  // carried over. Left open, its sends would never go out: the agent answers only in its main.
  const mainInstead = conversationMainInstead(
    snapshot.rooms,
    snapshot.identity?.userId,
    snapshot.assistant?.userId,
    selectedRoomId
  )

  const movingToMain = useRef(false)

  useEffect(() => {
    if (!mainInstead || movingToMain.current) {
      return
    }

    movingToMain.current = true
    const draft = composerRef.current?.draft().trim()

    if (draft) {
      $matrixStoreDraft.set({ roomId: mainInstead, text: draft })
    }

    void runMatrixCommand({ kind: 'select', roomId: mainInstead }).catch(error => {
      // Still in this chat, whose box keeps the words: the main does not get a copy later.
      if ($matrixStoreDraft.get()?.roomId === mainInstead) {
        $matrixStoreDraft.set(null)
      }

      // Re-homing a superseded conversation is automatic reconciliation. The existing chat
      // remains usable, so record the cause without raising a window-wide failure band.
      reportMatrixWindowFailure('command.select-main', error, snapshot.state !== 'offline')
    })
  }, [mainInstead, snapshot.state])

  const [appBotOutcomes, setAppBotOutcomes] = useState<Readonly<Record<string, AppBotMessageOutcome>>>({})

  const recordAppBotOutcome = useCallback((eventId: string, appId: string, outcome: AppBotOutcome) => {
    setAppBotOutcomes(current => ({ ...current, [eventId]: { appId, outcome } }))
  }, [])

  const agentKey = [snapshot.assistant?.userId, ...(snapshot.agents ?? []).map(agent => agent.userId)].join('\n')

  // A private Chief of Staff room's bound agent: its agent-turns/1.6 working line and interim remarks
  // are drawn exactly as a personal agent's (company channels draw theirs in the thread panel).
  const privateCosRecordKey = room?.companyPrivateCos
    ? teamSpaceKey(teamSpaceAccountKey(snapshot.identity), room.companyPrivateCos.companyId)
    : ''

  const privateCosRecords = useStore($companyPrivateCos, { keys: [privateCosRecordKey] })

  const companyPresentation = useStableCompanyBinding(
    privateCosPresentationBinding(privateCosRecords[privateCosRecordKey], room)
  )

  const privateCosName = usePrivateCosName()
  const companyRoomView = Boolean(room?.companyChannel) || isCompanyPrivateCosClaim(room)
  const companyTurns = companyTurnMemory(teamSpaceAccountKey(snapshot.identity))

  const admittedMessages = useMemo(
    () => (companyRoomView ? matrixAdmitCompanyPresentation(snapshot.messages, companyPresentation) : snapshot.messages),
    [companyPresentation, companyRoomView, snapshot.messages]
  )

  const companyNow = useCompanyLineClock(admittedMessages, companyTurns)

  const outgoing = useStore($outgoingEchoes)

  // Where the "New messages" line goes: the read marker, or in Team Space the room's unread count.
  const teamSpaceTranscript = Boolean(
    room && (room.roomType === MATRIX_COMPANY_CHANNEL_TYPE || isCompanyConversationRoom(room))
  )

  const firstUnreadId = matrixFirstUnreadMessageId(
    snapshot.messages,
    snapshot.readMarkerEventId,
    teamSpaceTranscript && room?.unread
      ? teamSpaceFirstUnreadMessageId(snapshot.messages, room.unreadNotifications ?? 1)
      : undefined
  )

  const { messages, latestAnswerId, latestOwnId, matchedEchoes, unansweredMessage, workingLine } = useMemo(() => {
    const sources = new Map(snapshot.messages.map(message => [message.id, message]))
    const agents = new Set(agentKey.split('\n').filter(Boolean))
    // The company agent's lines are read like a personal agent's; it never becomes an answerer here.
    const lineAgents = companyPresentation ? new Set([...agents, companyPresentation.agentUserId]) : agents
    const lineAgent = companyPresentation?.agentUserId ?? (room?.assistant ? snapshot.assistant?.userId : undefined)

    // A working line whose turn has ended shows nothing (agent-turns/1.4). The one still live
    // is drawn under the typing bubble, not as a transcript row of its own.
    // In a company room (a channel, a private Chief of Staff room) only the bound agent's 1.6 lines
    // and remarks carry agent-turns meaning; personal chats keep their own rules.
    // A company turn seen ended stays ended (`companyTurns`), and a company line expires by `companyNow`.
    const visible = matrixHideEndedTransientLines(admittedMessages, lineAgents, {
      memory: companyTurns,
      now: companyNow
    })

    const line = lineAgent ? matrixLiveWorkingLine(visible, lineAgents, lineAgent) : undefined
    // Only one line shows at a time: the live one goes under the typing bubble, and an older
    // live line a legacy build left behind does not become a second status row.
    const transcriptMessages = visible.filter(message => !isMatrixTransientLine(message, lineAgents))

    // Your message shows the moment you press Send, until its local turn or event takes over.
    const { entries, matched } = mergeOutgoingEchoes(
      mergeLocalTurns(transcriptMessages, snapshot.localTurns, {
        human: snapshot.identity?.userId,
        assistant: snapshot.assistant?.userId
      }),
      outgoing,
      snapshot.roomId ?? '',
      snapshot.identity?.userId ?? ''
    )

    // A question has its answer in view when a reply names it or carries its turn. A notice
    // (the assistant saying it held a reply) answers nothing: that message can still run.
    const answeredEvents = new Set(
      entries.flatMap(({ message }) => (!message.own && !message.notice && message.replyTo ? [message.replyTo] : []))
    )

    const answeredTurns = new Set(
      entries.flatMap(({ message }) => (!message.own && message.turn ? [message.turn] : []))
    )

    let lastQuestion: MatrixMessage | undefined
    let latest: string | undefined
    let latestOwn: string | undefined

    const projected = entries.map(({ message, local }, index) => {
      const previous = entries[index - 1]?.message
      const next = entries[index + 1]?.message
      // An interim remark (agent-turns/1.4) is a real message but never the answer to anything.
      const answer = !message.own && agents.has(message.sender) && !message.notice && !message.interim
      const replied = message.replyTo ? sources.get(message.replyTo) : undefined
      const question = answer ? (replied?.own ? replied : lastQuestion) : undefined

      if (message.own) {
        lastQuestion = message

        if (!message.redacted) {
          latestOwn = message.id
        }
      }

      if (answer && !message.decryptionFailed && !message.attachment) {
        latest = message.id
      }

      return {
        id: message.id,
        role: message.own ? ('user' as const) : ('assistant' as const),
        content: [{ type: 'text' as const, text: message.body }],
        createdAt: new Date(message.timestamp),
        metadata: {
          custom: {
            matrix: message,
            consecutiveReply: index > 0 && message.replyTo === entries[index - 1].message.id,
            // The read marker's line starts a new run, as a day line does.
            runStart: matrixRunBreak(previous, message, firstUnreadId),
            runEnd: !next || matrixRunBreak(message, next, firstUnreadId),
            // Team Space draws a day line where the calendar day changes (Slack's).
            dayStart: teamSpaceNewDay(previous?.timestamp, message.timestamp),
            answered:
              message.own &&
              (answeredEvents.has(message.id) || Boolean(message.turn && answeredTurns.has(message.turn))),
            ...(question ? { question } : {}),
            ...(local ? { local } : {}),
            ...(appBotOutcomes[message.id] ? { appBotOutcome: appBotOutcomes[message.id] } : {}),
            ...(replied ? { reply: replied } : {})
          }
        }
      }
    })

    const projectedHistory = appHistory.entries.map(entry => ({
      id: `app-history:${entry.id}`,
      role: entry.role === 'owner' ? ('user' as const) : ('assistant' as const),
      content: [{ type: 'text' as const, text: entry.text }],
      createdAt: new Date(entry.occurredAt),
      metadata: { custom: { appHistory: entry } }
    }))

    // A Team Space channel's joins and departures sit between its messages by time: rows of the
    // transcript, not messages (nothing answers them, previews them or counts them unread). Only a
    // channel the platform confirmed has them: main publishes a room's own unconfirmed claim as an
    // ordinary room, and an ordinary room never shows them.
    const projectedMembership = (room?.companyChannel ? (snapshot.membershipLines ?? []) : []).map(line => ({
      id: `membership:${line.id}`,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: '' }],
      createdAt: new Date(line.timestamp),
      metadata: { custom: { membership: line } }
    }))

    const combined = [...projectedHistory, ...projectedMembership, ...projected].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
    )

    return {
      messages: combined,
      latestAnswerId: latest,
      latestOwnId: latestOwn,
      matchedEchoes: matched,
      workingLine: line,
      unansweredMessage: matrixUnansweredOwnerMessage(
        entries.filter(entry => entry.local?.view.state !== 'not_sent').map(entry => entry.message),
        agents
      )
    }
  }, [
    snapshot.messages,
    snapshot.membershipLines,
    snapshot.localTurns,
    snapshot.roomId,
    room?.assistant,
    room?.companyChannel,
    outgoing,
    snapshot.identity?.userId,
    snapshot.assistant?.userId,
    agentKey,
    appBotOutcomes,
    appHistory.entries,
    firstUnreadId,
    admittedMessages,
    companyNow,
    companyPresentation,
    companyTurns
  ])

  useEffect(() => dropOutgoingEchoes(matchedEchoes), [matchedEchoes])

  const transcript = useExternalStoreRuntime({
    messages,
    convertMessage: (message: (typeof messages)[number]) => message,
    isRunning: false,
    isDisabled: true,
    onNew: async () => {}
  })

  const cloudAgent = room ? cloudRoomAgent(snapshot, room) : undefined
  const cloudAgentPrincipal = cloudAgent?.principal

  const readServiceStatus = useCallback(() => {
    if (!cloudAgentPrincipal || !window.atumMatrix.cloudAgent) {
      return Promise.reject(new Error('matrix_service_status_unavailable'))
    }

    return window.atumMatrix.cloudAgent({ action: 'serviceStatus', principal: cloudAgentPrincipal })
  }, [cloudAgentPrincipal])

  // A company channel's record in the platform directory (its state, and what this person may do in it).
  const channelFacts = useCompanyChannelFacts(teamSpaceAccountKey(snapshot.identity), room)
  const captureCard = useCompanyBoardCapture(teamSpaceAccountKey(snapshot.identity), room)
  const companyStatuses = useStore($companyAIStatuses)

  const companyAI = room?.companyChannel
    ? companyStatuses[companySpaceScope(teamSpaceAccountKey(snapshot.identity), room.companyChannel.companyId)]
    : undefined

  if (!room) {
    return <EmptyState className="m-auto p-8" description={copy.noRoomHelp} title={copy.noRoom} />
  }

  const channelArchived = channelFacts.archived
  const activity = snapshot.hermesActivity
  const assistantEligible = isAssistantRoom(room, snapshot.identity?.userId, snapshot.assistant?.userId)
  const conversationAgent = snapshot.agents?.find(agent => agent.userId === snapshot.assistant?.userId)
  const defaultAssistantChat = Boolean(settled && assistantEligible && conversationAgent?.isDefault)

  // The new account's first chat: the assistant's welcome opens it, wherever the assistant answers.
  const firstRunHere = Boolean(
    room.assistant &&
    assistantEligible &&
    room.dialogue !== 'started' &&
    messages.length === 0 &&
    matrixFirstRunPlace(snapshot, room.id)
  )

  const firstRunSkippedHere = Boolean(
    room.assistant &&
    assistantEligible &&
    conversationAgent?.isDefault &&
    room.dialogue !== 'started' &&
    messages.length === 0 &&
    snapshot.firstRunWelcome === 'dismissed'
  )

  const firstLearningProgress =
    defaultAssistantChat && !latestAnswerId && snapshot.firstRunProgress && Object.keys(snapshot.firstRunProgress).length
      ? snapshot.firstRunProgress
      : undefined

  const assistantName = conversationAgent
    ? matrixRosterAgentName(conversationAgent, t.matrixShell.assistantName)
    : t.matrixShell.assistantName

  // While the agent works on your message the chat shows it typing (its own standard typing
  // notification, or this Mac's turn still being answered), then its answer: no step-by-step.
  const agentTyping =
    room.assistant &&
    matrixAgentTyping({
      roomId: room.id,
      agentId: snapshot.assistant?.userId,
      typing: snapshot.typing,
      turns: snapshot.localTurns,
      // This room's run only: the agent-wide running flag is also up for the launch's model
      // check and for answers in groups, when nobody asked anything here.
      running: activity?.roomId === room.id && activity.state === 'running'
    })

  const localAssistant = Boolean(
    room.assistant && !cloudAgent && snapshot.assistantPath !== 'server' && snapshot.readiness
  )

  const companyChannel = room.roomType === MATRIX_COMPANY_CHANNEL_TYPE
  const companyConversation = isCompanyConversationRoom(room)
  const teamSpaceRoom = companyChannel || companyConversation
  const notesSelfRoom = matrixNotesSelfRoom(snapshot.notesSelf, room.id)
  const notesSelfKnownRoom = matrixNotesSelfKnownRoom(snapshot.notesSelf, room.id)
  const notesCopy = matrixTeamSpaceCopy(locale)
  const sidePanelOpen = Boolean(threadView || pinsOpen)

  const openThread = teamSpaceRoom
    ? (rootId: string) => onThreadViewChange({ roomId: room.id, filter: threadView?.filter ?? 'recent', rootId })
    : undefined

  return (
    <div
      className={`relative flex min-h-0 flex-1 flex-col ${sidePanelOpen && !compact ? 'pe-[26rem]' : ''}`}
      data-pet-stage
      // Team Space's Slack layout (team-space/slack-layout.css): flat runs, edge to edge.
      data-team-space-layout={companyChannel || companyConversation || undefined}
    >
      {forwarding.dialog}
      {/* At phone width the thread is the content view. Keep the covered channel out of
          keyboard and screen-reader navigation without changing the desktop split view. */}
      <div className="contents" inert={(compact && sidePanelOpen) || undefined}>
        <AssistantRuntimeProvider runtime={transcript}>
          {cloudAgent && <MatrixCloudAccessBand agent={cloudAgent} />}
          <LinkedDocumentNotice room={room} snapshot={snapshot} />
          {cloudAgent && (
            <MatrixNoReplyBanner
              agentPrincipal={cloudAgent.principal}
              assistantName={assistantName}
              locale={locale}
              message={unansweredMessage}
              onResend={composer?.ready ? body => composer.resend(body) : undefined}
              readStatus={window.atumMatrix.cloudAgent ? readServiceStatus : undefined}
              typing={Boolean(agentTyping)}
            />
          )}
          {room.membership !== 'join' && <ConversationMembership room={room} snapshot={snapshot} />}
          {room.assistant && room.membership === 'join' && !assistantEligible && (
            <NoticeBand tone="notice">{t.matrixShell.assistantHistoryOnly}</NoticeBand>
          )}
          {room.assistant && snapshot.domainEnabled && snapshot.linkedDocument && usableAgentRoom(room) && (
            <DocumentLink key={room.id} onPreview={onPreview} snapshot={snapshot} statusOnly />
          )}
          {/* The assistant still starting (the window opens with the person's chats), stopped
            or paused: said here, in its own chat, with the one action that helps. */}
          {localAssistant && (
            <MatrixLaunchNotice
              cloudOnly={cloudOnly}
              fail={fail}
              name={assistantName}
              onBackToAtum={onBackToAtum}
              onOwnModel={onOwnModel}
              onPlanSignIn={onPlanSignIn}
              snapshot={snapshot}
            />
          )}
          {room.assistant && (
            <>
              {/* On the local path the readiness banner speaks for these, in plain words. */}
              {!localAssistant && snapshot.hermes === 'unconfigured' && (
                <NoticeBand tone="notice">{matrixActionCopy[locale].hermesUnconfigured}</NoticeBand>
              )}
              {!localAssistant && snapshot.hermes === 'invalid' && (
                <NoticeBand tone="failure">{matrixActionCopy[locale].hermesInvalid}</NoticeBand>
              )}
              {!localAssistant && snapshot.hermes === 'unavailable' && (
                <NoticeBand tone="notice">{matrixActionCopy[locale].hermesUnavailable}</NoticeBand>
              )}
            </>
          )}
          <ConversationActions.Provider
            value={{
              room,
              accountKey: teamSpaceAccountKey(snapshot.identity),
              captureCard,
              cloud: Boolean(cloudAgent),
              assistantUserId: snapshot.assistant?.userId,
              ownerUserId: snapshot.identity?.userId,
              ownerDeviceId: snapshot.identity?.deviceId,
              members: snapshot.members,
              agents: snapshot.agents,
              appBots: snapshot.apps?.apps,
              threads: teamSpaceRoom ? snapshot.threads : undefined,
              savedMessages: snapshot.savedMessages,
              pinnedMessages: snapshot.pinnedMessages,
              openThread,
              assistantName,
              fail,
              openAppBot: appId => openAppBotChat(snapshot, appId, locale, fail),
              hermes: snapshot.hermes,
              listening: Boolean(
                room.assistant &&
                snapshot.hermesListening?.state === 'listening' &&
                snapshot.hermesListening.roomId === room.id
              ),
              recover: Boolean(snapshot.domainEnabled && snapshot.state === 'ready'),
              assistantEligible,
              topUp,
              agentUserIds: agentKey.split('\n').filter(Boolean),
              citationSenderName: eventId => {
                const cited = snapshot.messages.find(item => item.id === eventId)

                return cited && !cited.own
                  ? snapshot.members?.find(member => member.userId === cited.sender)?.name
                  : undefined
              },
              composer,
              latestAnswerId,
              latestOwnId,
              firstUnreadId,
              forward: forwarding.open,
              restoreMessages: onRestoreMessages,
              backupAvailable: matrixMessageBackupAvailable(snapshot.security),
              reviewDevices: onReviewDevices
            }}
          >
            <div className="relative min-h-0 flex-1" data-matrix-channel-transcript ref={followTranscriptEnd}>
              {appHistory.loading && appHistory.entries.length === 0 && (
                <p className="px-4 py-2 text-xs text-(--atum-ink-muted)" role="status">
                  {appCopy.loading}
                </p>
              )}
              {appHistory.ready && appHistory.error !== null && (
                <NoticeBand className="mx-4 mt-2" role="status" tone="notice">
                  {appCopy.historyUnavailable}
                  <Button onClick={() => void appHistory.retry()} size="sm" variant="text">
                    {appCopy.retry}
                  </Button>
                </NoticeBand>
              )}
              <AtumChatTranscript
                clampToComposer={false}
                components={{ UserMessage: MatrixMessageBubble, AssistantMessage: MatrixMessageBubble }}
                emptyPlaceholder={
                  // The Founder chat opens on the founder's own words, drawn by the app. A new
                  // person's first chat with their assistant opens on its first message (golden
                  // path §3), not the greeting and starters.
                  isFounderRoom(snapshot, room.id) ? (
                    <FounderIntroCard />
                  ) : firstRunHere || firstRunSkippedHere ? (
                    <MatrixFirstRunCard
                      assistantName={assistantName}
                      key={`${snapshot.identity?.userId ?? ''}:${snapshot.identity?.deviceId ?? ''}:${room.id}`}
                      roomId={room.id}
                      skipped={firstRunSkippedHere}
                      snapshot={snapshot}
                    />
                  ) : notesSelfKnownRoom ? (
                    <p className="self-center justify-self-center text-(--atum-ink-muted)">{notesCopy.personalNotes}</p>
                  ) : companyChannel ? (
                    <CompanyChannelEmptyState
                      accountKey={teamSpaceAccountKey(snapshot.identity)}
                      assistant={companyAI?.agent.displayName ?? matrixCompanyBoardCopy(locale).chiefOfStaff}
                      assistantEnabled={companyAI ? companyAIAvailability(companyAI) === 'ready' : false}
                      onAsk={prompt => composer?.edit(prompt)}
                      room={room}
                    />
                  ) : room.assistant ? (
                    <AssistantGreeting
                      brand={Boolean(conversationAgent?.isDefault ?? !snapshot.agents?.length)}
                      id={room.agentPrincipal ?? room.id}
                      name={conversationAgent ? assistantName : room.name}
                      // An empty chat offers a first step: each fills the box, nothing is sent.
                      starters={
                        assistantEligible && composer?.ready
                          ? chat.starters.map(starter => ({
                              ...starter,
                              onPick: () => composer.edit(starter.text)
                            }))
                          : undefined
                      }
                    />
                  ) : (
                    <p className="self-center justify-self-center text-(--atum-ink-muted)">{copy.empty}</p>
                  )
                }
                // A channel's history opens on its intro once nothing older is left to load.
                leading={
                  companyChannel && snapshot.historyStart && snapshot.roomId === room.id ? (
                    <ChannelIntroFor accountKey={teamSpaceAccountKey(snapshot.identity)} room={room} />
                  ) : undefined
                }
                loadEarlier={loadEarlier}
                loadingIndicator={
                  firstLearningProgress ? (
                    <MatrixFirstLearningTiles progress={firstLearningProgress} />
                  ) : agentTyping || workingLine ? (
                    <MatrixAgentWorking
                      agent={companyPresentation ? undefined : conversationAgent}
                      avatarMxc={
                        snapshot.members?.find(
                          member => member.userId === (companyPresentation?.agentUserId ?? snapshot.assistant?.userId)
                        )?.avatarMxc
                      }
                      id={companyPresentation?.agentUserId ?? snapshot.assistant?.userId ?? room.id}
                      label={chat.typingOne(companyPresentation ? privateCosName : assistantName)}
                      line={workingLine}
                      name={companyPresentation ? privateCosName : assistantName}
                      typing={Boolean(agentTyping)}
                    />
                  ) : undefined
                }
                revealMessageId={
                  historyReveal?.roomId === room.id
                    ? historyReveal.eventId
                    : !room.assistant && !room.appBot
                      ? firstUnreadId
                      : undefined
                }
                sessionKey={room.id}
              />
            </div>
          </ConversationActions.Provider>
        </AssistantRuntimeProvider>
        {/* Everything under the transcript floats over the column's foot: the transcript scrolls behind the
          composer's glass, and the dock reports its height so the last message clears it. */}
        <ComposerDock className={sidePanelOpen && !compact ? 'end-[26rem]' : undefined}>
          {/* The companion roams over the chat column. Keep the first-run greeting unobstructed;
          it returns with the ordinary chat as soon as the account-scoped flow settles. */}
          {!firstRunHere && !firstRunSkippedHere && !companyChannel && !companyConversation && !notesSelfKnownRoom && (
            <MatrixAgentPet
              display={window.atumMatrix.petDisplay}
              onSettings={onCheckInSettings}
              onStore={snapshot.apps ? () => void runMatrixCommand({ kind: 'discoverApps' }).catch(fail) : undefined}
              snapshot={snapshot}
            />
          )}
          {/* The assistant's questions and approvals wait here, above the box the person is
            looking at, in the transcript's column (launch night). */}
          {!companyChannel && !companyConversation && !notesSelfKnownRoom && (
            <HermesPrompts fail={fail} placement="inline" snapshot={snapshot} />
          )}
          {defaultAssistantChat && room.membership === 'join' && (
            <MatrixCheckInsNotice
              // The first mention waits until the assistant is up and has spoken in this chat.
              introReady={
                !blocked &&
                snapshot.roomId === room.id &&
                snapshot.messages.some(message => !message.own && message.sender === snapshot.assistant?.userId)
              }
              onOpenSettings={onCheckInSettings}
              snapshot={snapshot}
            />
          )}
          {room.membership === 'join' && (
            <>
              {/* An archived channel's banner is the composer's own, in place of its box. */}
              {!channelArchived && snapshot.canSend === false && (
                <NoticeBand tone="notice">{conversationCopy.cannotSend}</NoticeBand>
              )}
              {(defaultAssistantChat || firstRunHere) && <MatrixFolderAccessRecovery snapshot={snapshot} />}
              {defaultAssistantChat && snapshot.firstRunWelcome === 'dismissed' && !firstRunSkippedHere && (
                <MatrixGoogleConnectNudge access={snapshot.googleAssistant} scope={snapshot.identity?.userId} />
              )}
              {/* Cloud assistants read this Mac's sources: said once, above the box, never in the way.
                The first-run card says it for a new account. */}
              {room.assistant && !firstRunHere && snapshot.identity && (
                <MatrixMacSourcesNotice scope={`${snapshot.identity.userId}:${snapshot.identity.deviceId}`} />
              )}
              <MatrixComposer
                assistantName={assistantName}
                bind={setComposer}
                blocked={blocked}
                cloudOnly={cloudOnly}
                draftTarget={teamSpaceRoom || notesSelfRoom ? { roomId: room.id } : undefined}
                fail={fail}
                key={`${snapshot.identity?.userId ?? ''}:${room.id}`}
                notice={
                  latestOwnId ? undefined : (
                    <MatrixStarterNotice defaultAssistantChat={defaultAssistantChat} locale={locale} snapshot={snapshot} />
                  )
                }
                onAppAction={onAppAction}
                onBotOutcome={recordAppBotOutcome}
                onModelSettings={onModelSettings}
                onSent={onSent}
                onSubscriptions={onSubscriptions}
                room={room}
                snapshot={snapshot}
              />
            </>
          )}
        </ComposerDock>
      </div>
      {teamSpaceRoom && threadView && (
        <MatrixThreadPanel
          assistantName={assistantName}
          blocked={blocked}
          cloudOnly={cloudOnly}
          compact={compact}
          fail={fail}
          onChange={onThreadViewChange}
          onClose={onCloseThreads}
          onSubscriptions={onSubscriptions}
          room={room}
          snapshot={snapshot}
          view={threadView}
        />
      )}
      {(companyChannel || companyConversation) && pinsOpen && (
        <PinnedMessagesPanel
          compact={compact}
          nameOf={userId => userId === snapshot.identity?.userId
            ? t.dm.you
            : snapshot.members?.find(member => member.userId === userId)?.name ?? userId}
          onClose={onClosePins}
          onJump={(eventId, threadRootId) => {
            if (threadRootId) {
              onThreadViewChange({ roomId: room.id, filter: threadView?.filter ?? 'recent', rootId: threadRootId })
            } else if (threadView) {

              onCloseThreads()
            }

            onClosePins()

            revealMatrixHistoryMessage(room.id, eventId, 'pinned', threadRootId)
          }}
          pinned={snapshot.pinnedMessages ?? { canChange: false, entries: [] }}
        />
      )}
    </div>
  )
}

/**
 * Your assistant's reply settings for one chat (launch night): one switch — reply here to
 * what is sent from your other devices while Atum is open — with the document link, and the
 * rare paths (fifteen minutes only, reconnecting) folded under Advanced. Listening recovers
 * by itself (0.20): nothing about it ever shows in the chat, and here only a quiet line when
 * this Mac keeps handing the assistant over (lease-handover.ts) or could not save a Stop.
 */
function AssistantReplySettings({
  fail,
  onOpenChange,
  onPreview,
  open,
  snapshot
}: {
  fail(cause?: unknown): void
  onOpenChange(open: boolean): void
  onPreview(): void
  open: boolean
  snapshot: MatrixSnapshot
}) {
  const { t, locale } = useI18n()
  const copy = matrixActionCopy[locale]
  const chat = useChatCopy()
  const room = snapshot.rooms.find(value => value.id === snapshot.roomId)
  const [controlsPending, setControlsPending] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  if (!room) {
    return null
  }

  const eligible = isAssistantRoom(room, snapshot.identity?.userId, snapshot.assistant?.userId)
  const watch = snapshot.hermesListening?.roomId === room.id ? snapshot.hermesListening : undefined
  const listening = watch?.state === 'listening' || (watch?.mode === 'continuous' && watch.state === 'paused')
  const agent = snapshot.agents?.find(value => value.userId === snapshot.assistant?.userId)
  const name = agent ? matrixRosterAgentName(agent, t.matrixShell.assistantName) : t.matrixShell.assistantName

  const canListen =
    eligible && snapshot.state === 'ready' && snapshot.hermes === 'ready' && !snapshot.linkedDocument && !listening

  const toggle = (on: boolean) => {
    setSwitching(true)

    const request = on
      ? window.atumMatrix.setContinuousListening(room.id, true, locale)
      : watch?.mode === 'continuous'
        ? window.atumMatrix.setContinuousListening(room.id, false, locale)
        : window.atumMatrix.stopListeningHermes(room.id)

    void request.catch(fail).finally(() => setSwitching(false))
  }

  return (
    <Dialog
      onOpenChange={value => {
        if (!controlsPending) {
          onOpenChange(value)
        }
      }}
      open={open}
    >
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-h-[80vh] max-w-md overflow-y-auto"
        data-matrix-assistant-options
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader title={chat.replySettingsTitle} />
        <section className="flex flex-col gap-4 text-sm">
          <label className="flex items-start gap-3">
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-(--atum-ink)">{chat.replyHere}</span>
              <span className="mt-0.5 block text-xs text-(--atum-ink-muted)">{chat.replyHereHelp(name)}</span>
            </span>
            <Switch
              aria-label={chat.replyHere}
              checked={listening}
              className="mt-0.5"
              disabled={switching || (!listening && !canListen) || snapshot.hermes === 'running'}
              onCheckedChange={toggle}
            />
          </label>
          {/* This chat's watch is the switch. A Stop the disk could not keep is pressed again here. */}
          {watch?.state === 'paused' && watch.reason === 'storage' && (
            <p className="text-xs text-(--atum-ink-muted)" data-matrix-reply-note="storage">
              {copy.listeningPausedStorage}
            </p>
          )}
          {agent?.answeringTrouble === 'handover' && (
            <p className="text-xs text-(--atum-ink-muted)" data-matrix-reply-note="handover">
              {chat.replyHandover(name)}
            </p>
          )}
          {snapshot.domainEnabled && usableAgentRoom(room) && (
            <DocumentLink
              className="-ms-2 px-0 py-0"
              disabled={controlsPending}
              onPendingChange={setControlsPending}
              onPreview={onPreview}
              snapshot={snapshot}
            />
          )}
          <div>
            <button
              aria-expanded={advanced}
              className="flex items-center gap-1 text-(length:--atum-t-caption) font-medium text-(--atum-ink-muted) hover:text-(--atum-ink)"
              onClick={() => setAdvanced(value => !value)}
              type="button"
            >
              <ChevronRight
                aria-hidden
                className={`size-3.5 transition-transform motion-reduce:transition-none ${advanced ? 'rotate-90' : ''}`}
              />
              {chat.advanced}
            </button>
            {advanced && (
              <div className="mt-2 flex flex-wrap gap-2 ps-[1.125rem]">
                <Button
                  disabled={!canListen}
                  onClick={() => void window.atumMatrix.listenHermes(room.id, locale).catch(fail)}
                  size="sm"
                  variant="secondary"
                >
                  {chat.listenBriefly}
                </Button>
                <Button
                  disabled={!eligible || snapshot.state !== 'ready' || snapshot.hermes === 'running'}
                  onClick={() => void window.atumMatrix.connectHermes(room.id).catch(fail)}
                  size="sm"
                  variant="secondary"
                >
                  {chat.reconnect}
                </Button>
              </div>
            )}
          </div>
          <span className="sr-only">{copy.keepListeningHelp}</span>
        </section>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The open chat's header actions (launch night): a group's people, then one conversation
 * menu for every kind of chat. No text buttons; nothing when there is nothing to offer.
 */
function ConversationHeaderActions({
  appearance,
  cloudOnly,
  currentLook,
  fail,
  onLookPreview,
  onPins,
  onPreview,
  search,
  onThreads,
  pinsOpen,
  threadsOpen,
  snapshot
}: {
  appearance: 'light' | 'dark'
  cloudOnly: boolean
  currentLook: LookRoomAccountData
  fail(cause?: unknown): void
  onLookPreview(look: LookRoomAccountData): void
  onPins?: () => void
  onPreview(): void
  search?: ReactNode
  onThreads?: () => void
  pinsOpen?: boolean
  threadsOpen?: boolean
  snapshot: MatrixSnapshot
}) {
  const { locale, t } = useI18n()
  const chat = useChatCopy()
  const threadCopy = matrixThreadCopy(locale)
  const room = snapshot.rooms.find(value => value.id === snapshot.roomId)
  const [members, setMembers] = useState(false)
  const [replySettings, setReplySettings] = useState(false)
  const [lookPicker, setLookPicker] = useState(false)

  if (!room || room.membership !== 'join') {
    return null
  }

  if (matrixNotesSelfRoom(snapshot.notesSelf, room.id)) {
    return <>{search}</>
  }

  const eligible = Boolean(
    room.assistant && isAssistantRoom(room, snapshot.identity?.userId, snapshot.assistant?.userId)
  )

  // A company channel is the company's room: its own menu and roster, never the personal chat's.
  const companyChannel = isCompanyRoom(room)
  // A company DM or group DM is the company's room too: its own menu (add people, hide), never the personal chat's.
  const companyConversation = isCompanyConversationRoom(room)
  // The company's private Chief of Staff chat: the company's menu (notifications, background), never the personal chat's.
  const privateCos = isCompanyPrivateCosClaim(room)
  // People, not an assistant's private chat; a group, not a chat with one person.
  const group = !room.assistant && !room.direct && !companyChannel && !companyConversation && !privateCos

  return (
    <>
      {!companyChannel && search}
      {/* The header's right is the page's (Atum Kit): pins show while something is pinned (an
          open panel keeps its button), and threads while one has unread replies (they are always
          in "…" too). */}
      {(companyChannel || companyConversation || privateCos) && onPins &&
        ((snapshot.pinnedMessages?.entries.length ?? 0) > 0 || pinsOpen) && (
        <PinnedMessagesButton
          count={snapshot.pinnedMessages?.entries.length ?? 0}
          onClick={onPins}
          open={Boolean(pinsOpen)}
        />
      )}
      {onThreads && (threadsOpen || (snapshot.threads ?? []).some(thread => thread.unread)) && (
        <Tip label={threadsOpen ? threadCopy.closeThreads : threadCopy.openThreads}>
          <button
            aria-expanded={threadsOpen}
            aria-label={threadsOpen ? threadCopy.closeThreads : threadCopy.openThreads}
            className="atum-icon-btn relative size-7"
            data-matrix-threads-button
            onClick={onThreads}
            type="button"
          >
            <Messages aria-hidden className="size-4" />
            {(snapshot.threads ?? []).some(thread => thread.unread) && (
              <span
                aria-label={threadCopy.unread}
                className="absolute top-0 right-0 size-2 rounded-full bg-(--atum-accent)"
              />
            )}
          </button>
        </Tip>
      )}
      {!companyChannel && !privateCos && groupAssistantRecipients(room, snapshot).length > 0 && (
        <GroupRoomSettings room={room} snapshot={snapshot} />
      )}
      {companyChannel && <MatrixCompanyMembersButton snapshot={snapshot} />}
      {companyChannel && search}
      {group && <MatrixMembersButton onOpen={() => setMembers(true)} snapshot={snapshot} />}
      {group && <MatrixMembers onOpenChange={setMembers} open={members} room={room} snapshot={snapshot} />}
      {companyChannel ? (
        <MatrixCompanyChannelMenu
          fail={fail}
          onBackground={() => setLookPicker(true)}
          onThreads={onThreads}
          room={room}
          snapshot={snapshot}
          title={matrixChatTitle(room, { locale, untitled: t.atum.roster.untitledChat, chatOn: chat.chatOn })}
        />
      ) : companyConversation ? (
        <ConversationMenu
          accountKey={teamSpaceAccountKey(snapshot.identity)}
          fail={fail}
          onBackground={() => setLookPicker(true)}
          room={room}
        />
      ) : privateCos ? (
        <PrivateCosMenu fail={fail} onBackground={() => setLookPicker(true)} room={room} />
      ) : (
        <MatrixChatMenu
          fail={fail}
          onBackground={() => setLookPicker(true)}
          onMembers={group ? () => setMembers(true) : undefined}
          onReplySettings={
            eligible && matrixAssistantReplySettingsShown(cloudOnly) ? () => setReplySettings(true) : undefined
          }
          room={room}
          snapshot={snapshot}
          title={matrixChatTitle(room, { locale, untitled: t.atum.roster.untitledChat, chatOn: chat.chatOn })}
        />
      )}
      {eligible && matrixAssistantReplySettingsShown(cloudOnly) && (
        <AssistantReplySettings
          fail={fail}
          onOpenChange={setReplySettings}
          onPreview={onPreview}
          open={replySettings}
          snapshot={snapshot}
        />
      )}
      <ChatLookPicker
        appearance={appearance}
        current={currentLook}
        onOpenChange={setLookPicker}
        onPreview={onLookPreview}
        open={lookPicker}
        room={room}
        snapshot={snapshot}
      />
    </>
  )
}

function useWindowFacts() {
  const [facts, setFacts] = useState(initialWindowFacts)
  useEffect(() => {
    let live = true

    const unsubscribe = window.atumMatrix.subscribeWindow(value => {
      if (live) {
        setFacts(value)
      }
    })

    void window.atumMatrix
      .windowFacts()
      .then(value => {
        if (live) {
          setFacts(value)
        }
      })
      .catch(() => {})

    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return facts
}

function useCompact() {
  const [compact, setCompact] = useState(() => window.innerWidth < ATUM_COMPACT_BREAKPOINT_PX)
  useEffect(() => {
    const resize = () => setCompact(window.innerWidth < ATUM_COMPACT_BREAKPOINT_PX)
    window.addEventListener('resize', resize)

    return () => window.removeEventListener('resize', resize)
  }, [])

  return compact
}

function MatrixAuthGate({
  error,
  fail,
  clearError,
  settled,
  snapshot
}: {
  error: boolean
  fail: () => void
  clearError: () => void
  /** Main's first snapshot has arrived: before it, "signed out" is only the placeholder. */
  settled: boolean
  snapshot: MatrixSnapshot
}) {
  const [story, setStory] = useState(false)
  const [firstLaunch, setFirstLaunch] = useState<boolean | null>(null)
  // Whether a way in was chosen in this window: an error after it is that sign-in failing,
  // said by the way that was tried (sign-in.tsx).
  const [attempted, setAttempted] = useState(false)

  // The first launch's story plays once per install, on a clean signed-out start.
  useEffect(() => {
    if (!settled || firstLaunch !== null) {
      return
    }

    const fresh = snapshot.state === 'signed_out' && !snapshot.error && !welcomePlayed()
    setFirstLaunch(fresh)
    setStory(fresh)
  }, [firstLaunch, settled, snapshot.error, snapshot.state])

  const finishStory = useCallback(() => {
    markWelcomePlayed()
    setStory(false)
  }, [])

  // An account saved here that can't be opened is never offered the ways in.
  if (matrixAccountUnavailable(snapshot)) {
    return (
      <MatrixAccountUnavailable
        onRetry={() => {
          clearError()

          return window.atumMatrix.retry().catch(fail)
        }}
        onSignOut={() => window.atumMatrix.signOut().catch(fail)}
        snapshot={snapshot}
      />
    )
  }

  return (
    <>
      {/* The story ends in dawn on this screen; until then it is not reachable. */}
      <div className="contents" inert={story || undefined}>
        <MatrixSignIn
          attempted={attempted}
          browser={snapshot.signInBrowser}
          cleanupRequired={snapshot.agentCleanupRequired}
          email={snapshot.signInMethods?.email}
          error={snapshot.error}
          failed={error}
          onCancel={() => {
            setAttempted(false)
            void window.atumMatrix.cancelSignIn().catch(fail)
          }}
          onSignIn={method => {
            clearError()
            setAttempted(true)
            void window.atumMatrix.signIn(method).catch(fail)
          }}
          returned={snapshot.signInReturned}
          state={snapshot.state}
        />
      </div>
      {story && <MatrixWelcomeStory onDone={finishStory} />}
    </>
  )
}

interface CreatedAssistantRoom {
  ownerId: string
  agentId: string
  roomId: string
}

function MatrixRoster({
  assistantOpening,
  cloudOnly,
  compact,
  createdAssistantRoomId,
  facts,
  fail,
  onAssistantOpeningChange,
  onCloseDrawer,
  onCreatedAssistantRoomIdChange,
  onConversationCreated,
  onAppInfo,
  onEditAgent,
  onNavigate,
  onToggle,
  newMessageRef,
  openRef,
  snapshot
}: {
  assistantOpening: string | null
  cloudOnly: boolean
  compact: boolean
  createdAssistantRoomId: CreatedAssistantRoom | null
  facts: MatrixWindowFacts
  fail: (cause?: unknown, source?: MatrixWindowFailureSource) => void
  onAssistantOpeningChange(value: string | null): void
  /** Shuts the compact drawer. Going to a chat only ever shuts it: ⌘N, the palette and a
   * nudge reach the same paths while it is already shut, where a toggle would open it. */
  onCloseDrawer(): void
  onCreatedAssistantRoomIdChange(value: CreatedAssistantRoom | null): void
  onConversationCreated(): void
  /** An official app's read-only card (its row's "Info"). */
  onAppInfo?(app: AppDescriptor): void
  onEditAgent?(agent: MatrixAgentView, focus?: 'name'): void
  onNavigate(): void
  onToggle: () => void
  /** The roster's own way to open (or start) an assistant's chat, for ⌘N and the palette. */
  openRef?: MutableRefObject<((fresh?: boolean, agentId?: string, roomId?: string) => Promise<void>) | null>
  /** ⌘N and the palette's New message open the same start sheet as the roster's "+". */
  newMessageRef?: MutableRefObject<(() => void) | null>
  snapshot: MatrixSnapshot
}) {
  const copy = useMatrixCopy()
  const { locale, t } = useI18n()
  // MatrixAccountView is keyed by identity: presentation state never survives
  // sign-out or an account switch, and typing never writes Matrix navigation.
  const [query, setQuery] = useState('')

  const knownHandles = useMatrixHandles(snapshot.identity?.userId)
  const [creating, setCreating] = useState<MatrixRosterCreation | null>(null)
  // The roster lists the apps kept here (Discover lives in the rail, G1-17f): one row per
  // official bot, carrying its chat (roster-model.ts). Opening one waits for the one before.
  // The start menu opens an app the same way its row does (app-bots/use-open-app.ts).
  const { openApp, openingApp } = useOpenApp(snapshot, locale, fail)
  // A cloud-only default (the first sign-up assistant) never runs local setup: no local
  // identity or setup state is expected, so it is never asked to set up on this Mac.
  const primaryAgent = snapshot.agents?.find(agent => agent.isDefault)
  const localSetupRequired = !primaryAgent || matrixAgentNeedsLocalSetup(primaryAgent, cloudOnly)

  const globalCompanyIds = useMemo(() => [...new Set(snapshot.rooms.flatMap(value => {
    const companyId = value.companyChannel?.companyId ?? value.companyConversation?.companyId

    return companyId ? [companyId] : []
  }))], [snapshot.rooms])

  const globalSearchState = useMatrixRosterGlobalSearch({
    people: window.atumMatrix.people,
    companies: window.atumMatrix.companies
  }, { query, ready: snapshot.state === 'ready', companyIds: globalCompanyIds })

  const currentGlobalSearch = globalSearchState.query === query.trim()

  useEffect(() => {
    const owner = snapshot.identity?.userId

    if (!owner) {
      return
    }

    bindMatrixHandleOwner(owner)

    if (currentGlobalSearch) {
      for (const person of globalSearchState.people.results) {
        if (person.handle) {
          rememberMatrixHandle(person.userId, person.handle)
        }
      }
    }
  }, [currentGlobalSearch, globalSearchState.people.results, snapshot.identity?.userId])

  const globalPeople = useMemo(() => {
    if (!currentGlobalSearch) {
      return []
    }

    const excluded = new Set([
      snapshot.identity?.userId,
      ...(snapshot.agents ?? []).map(agent => agent.userId)
    ].filter((id): id is string => Boolean(id)))

    return globalSearchState.people.results.filter(person =>
      !excluded.has(person.userId) && !directRoomWith(snapshot, person.userId))
  }, [currentGlobalSearch, globalSearchState.people.results, snapshot])

  const globalEvents = currentGlobalSearch ? {
    messages: globalSearchState.messages.results,
    files: globalSearchState.files.results
  } : { messages: [], files: [] }

  const globalSearching = [...query.trim()].length >= 2 &&
    (!currentGlobalSearch || matrixRosterGlobalSearchPending(globalSearchState))

  const globalChannels = useMemo(() => {
    const text = normalizeMatrixRosterQuery(query)

    return text ? snapshot.rooms.filter(value => isTeamSpaceRoom(value) && !isCompanyPrivateCosClaim(value) &&
      normalizeMatrixRosterQuery(value.name).includes(text)) : []
  }, [query, snapshot.rooms])

  const externalSearchResultCount =
    globalPeople.length + globalChannels.length + globalEvents.messages.length + globalEvents.files.length

  const eligibleRooms = snapshot.rooms.filter(room =>
    isAssistantRoom(room, snapshot.identity?.userId, snapshot.assistant?.userId)
  )

  const assistantRoom = rosterConversationRoom(
    eligibleRooms,
    snapshot.roomId,
    resolveProjectedConversation(eligibleRooms, snapshot.identity?.userId, snapshot.assistant?.userId).main
  )

  const openAssistantRef = useRef<() => Promise<void>>(async () => {})
  const landed = useRef(false)
  const sawStartup = useRef(false)
  // The launch covers the window only until the person's chats are ready (startup-screen.tsx);
  // the assistant may still be getting ready in its own chat after that.
  const gating = matrixStartupBlocking(snapshot)
  const assistantStarting = snapshot.readiness?.phase === 'starting' || snapshot.readiness?.phase === 'blocked'

  if (snapshot.startup || gating || assistantStarting) {
    sawStartup.current = true
  }

  const closeDrawer = () => {
    if (compact) {
      onCloseDrawer()
    }
  }

  const openGlobalPerson = async (userId: string) => {
    const existing = directRoomWith(snapshot, userId)
    const roomId = existing?.id ?? await runMatrixCommand({ kind: 'create', name: '', invite: [userId], direct: true })

    if (typeof roomId !== 'string' || !roomId) {
      throw new Error('matrix_direct_room_missing')
    }

    await runMatrixCommand({ kind: 'select', roomId })
    onNavigate()
    closeDrawer()
  }

  const openGlobalEvent = async (result: MatrixCompanyMessageSearchResult & { companyId: string }) => {
    const opened = await window.atumMatrix.companies?.open?.({
      companyId: result.companyId,
      channelId: result.channelId,
      roomId: result.roomId,
      eventId: result.eventId,
      ...(result.threadRootId ? { threadRootId: result.threadRootId } : {})
    })

    if (!opened?.ok) {
      throw new Error('matrix_company_search_unavailable')
    }

    revealMatrixHistoryMessage(result.roomId, result.eventId, 'company', result.threadRootId)
    await runMatrixCommand({ kind: 'select', roomId: result.roomId })
    onNavigate()
    closeDrawer()
  }

  const openAssistant = async (fresh = false, agentId = snapshot.assistant?.userId, preferredRoomId?: string) => {
    if (!agentId || !snapshot.identity || assistantOpening) {
      return
    }

    onNavigate()
    onAssistantOpeningChange(agentId)
    closeDrawer()
    let failureSource: MatrixWindowFailureSource = 'command.select'

    try {
      const agent = snapshot.agents?.find(value => value.userId === agentId)
      // `connectHermes` joins and verifies a local agent host. A cloud-only agent has no such
      // host on this Mac; main deliberately refuses that call before Matrix I/O.
      const connectsHere = agent?.answering !== 'cloud' || agent.macRole === 'answering'
      const agentRooms = snapshot.rooms.filter(room => isAssistantRoom(room, snapshot.identity?.userId, agentId))
      const agentResolution = resolveProjectedConversation(agentRooms, snapshot.identity.userId, agentId)
      const agentRoom = rosterConversationRoom(agentRooms, snapshot.roomId, agentResolution.main)

      const pendingRoomId =
        createdAssistantRoomId?.ownerId === snapshot.identity.userId && createdAssistantRoomId.agentId === agentId
          ? createdAssistantRoomId.roomId
          : null

      // A chat holding unread messages comes first: that is where the nudge points. Before
      // the one-conversation feature is enabled, preserve the existing fresh-chat behaviour.
      const preferred = agentRooms.find(room => room.id === preferredRoomId)?.id

      const existingRoomId =
        fresh && agentResolution.source === 'legacy' ? undefined : (preferred ?? pendingRoomId ?? agentRoom?.id)

      if (existingRoomId) {
        await runMatrixCommand({ kind: 'select', roomId: existingRoomId })

        if (connectsHere) {
          // This is maintenance after the chat is already open. Its failure belongs in main.log
          // and the chat's own readiness state, never in the window failure band.
          void window.atumMatrix.connectHermes(existingRoomId).catch(error => {
            reportMatrixWindowFailure('connectHermes', error, snapshot.state !== 'offline')
          })
        }
      } else {
        failureSource = 'command.create'

        const roomId = await runMatrixCommand({
          kind: 'create',
          name: '',
          invite: [agentId],
          direct: true
        })

        if (typeof roomId !== 'string' || !roomId) {
          throw new Error('matrix_assistant_room_missing')
        }

        onCreatedAssistantRoomIdChange({
          ownerId: snapshot.identity.userId,
          agentId,
          roomId
        })

        if (connectsHere) {
          // A newly created local room is not usable until its agent joins; this remains the
          // person's foreground operation and therefore keeps the typed failure path.
          failureSource = 'connectHermes'
          await window.atumMatrix.connectHermes(roomId)
        }
      }

      onCreatedAssistantRoomIdChange(null)
    } catch (error) {
      fail(error, failureSource)
    } finally {
      onAssistantOpeningChange(null)
    }
  }

  openAssistantRef.current = () => openAssistant()

  if (openRef) {
    openRef.current = openAssistant
  }

  // One sheet answers "who do you want to talk to?": the "+", ⌘N and the palette's New
  // message all open it. Picking an assistant there opens its one conversation (Plan 7); a
  // group is made from its New group (Plan 1), so making one is never hidden.
  if (newMessageRef) {
    newMessageRef.current = () => setCreating({ kind: 'start' })
  }

  const assistantRoomId = assistantRoom?.id
  // Main restored a place at launch (the last chat, the Store or an app), or the person picked one.
  const placed = Boolean(snapshot.roomId || snapshot.destination)
  // Land on Trợ lý, like the old app opening on chat: once per window, after the
  // launch this window waited on finished, when nothing is selected yet. The
  // compact drawer stays shut. While the assistant is still getting ready, its
  // existing chat is only opened (it says so there); connecting waits for it.
  useEffect(() => {
    if (landed.current || !sawStartup.current || snapshot.state !== 'ready' || gating || !snapshot.assistant) {
      return
    }

    // A launch that ended somewhere has landed there. Left armed, the landing fired the first
    // time the person went where no chat is selected (the Store) and pulled them back to Trợ lý.
    if (placed) {
      landed.current = true

      return
    }

    if (compact) {
      return
    }

    if (snapshot.startup || assistantStarting) {
      if (assistantRoomId) {
        landed.current = true
        void runMatrixCommand({ kind: 'select', roomId: assistantRoomId }).catch(() => {})
      }

      return
    }

    landed.current = true
    void openAssistantRef.current()
  }, [
    assistantRoomId,
    assistantStarting,
    compact,
    gating,
    placed,
    snapshot.assistant,
    snapshot.startup,
    snapshot.state
  ])

  return (
    <aside
      className="atum-sidebar relative flex h-full w-(--atum-l-roster) shrink-0 flex-col overflow-hidden [-webkit-app-region:no-drag]"
      data-atum-drawer={compact ? 'true' : undefined}
      data-atum-roster
    >
      <div
        className="flex h-(--atum-l-header) shrink-0 items-center px-3 [-webkit-app-region:drag]"
        data-atum-roster-header
      >
        <AtumWindowControlsSurface
          onToggleSidebar={onToggle}
          reserveLights={!facts.isFullscreen && Boolean(facts.windowButtonPosition)}
          sidebarLabel={t.atum.chat.closeSidebar}
        />
        {/* New chat sits in the title bar beside the sidebar toggle (Atum Kit mockups). */}
        <span className="flex-1" />
        <MatrixStartChatButton disabled={snapshot.state !== 'ready'} onClick={() => setCreating({ kind: 'start' })} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-1 pb-2" data-atum-search-actions>
        <SearchField
          aria-label={t.atum.roster.search}
          containerClassName="h-[2.125rem] min-w-0 flex-1 rounded-full border-none bg-(--atum-sunk) px-3 text-[0.8125rem] !opacity-100 transition-colors focus-within:bg-(--atum-hover)"
          inputClassName="min-w-0 flex-1 text-(--atum-ink) placeholder:text-(--atum-ink-faint)"
          onChange={setQuery}
          placeholder={t.atum.roster.searchPlaceholder}
          value={query}
        />
      </div>
      <MatrixRosterCreate
        creating={creating}
        onConversationCreated={onConversationCreated}
        onCreatingChange={setCreating}
        openAgentChat={agent => void openAssistant(false, agent.userId)}
        openApp={app => {
          onNavigate()
          closeDrawer()
          openApp(app)
        }}
        openAssistant={() => void openAssistant(false)}
        selectRoom={roomId => {
          onNavigate()
          closeDrawer()
          void runMatrixCommand({ kind: 'select', roomId }).catch(fail)
        }}
        snapshot={snapshot}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {query.trim().length >= 2 && (
          <div className="grid gap-1 pb-2" data-matrix-global-search-results>
            {globalSearching && <p className="px-2 py-1 text-xs text-(--atum-ink-muted)" role="status">{t.atum.roster.searching}</p>}
            {globalPeople.length > 0 && <section aria-label={t.atum.roster.people}>
              <h3 className="ak-section px-2 pt-2">{t.atum.roster.people}</h3>
              {globalPeople.map(person => <button aria-label={person.name}
                className="atum-row flex min-h-11 w-full items-center gap-2.5 px-2 py-1 text-left"
                key={person.userId} onClick={() => void openGlobalPerson(person.userId).catch(fail)} type="button">
                <AtumAssistantAvatar className="size-(--atum-avatar-md) rounded-full text-xs" id={person.userId} name={person.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-(length:--atum-t-control) text-(--atum-ink)">{person.name}</span>
                  <PersonHandleLine handle={person.handle ?? knownHandles[person.userId]} name={person.name} />
                </span>
              </button>)}
            </section>}
            {globalChannels.length > 0 && <section aria-label={t.atum.roster.channels}>
              <h3 className="ak-section px-2 pt-2">{t.atum.roster.channels}</h3>
              {globalChannels.map(channel => <button className="atum-row flex min-h-10 w-full items-center gap-2.5 px-2 text-left"
                key={channel.id} onClick={() => { void runMatrixCommand({ kind: 'select', roomId: channel.id }).then(() => {onNavigate(); closeDrawer()}, fail) }} type="button">
                <Hash className="size-4 text-(--atum-ink-muted)" /><span className="truncate text-(--atum-ink)">{channel.name}</span>
              </button>)}
            </section>}
            {(['messages', 'files'] as const).map(kind => globalEvents[kind].length > 0 ? <section aria-label={t.atum.roster[kind]} key={kind}>
              <h3 className="ak-section px-2 pt-2">{t.atum.roster[kind]}</h3>
              {globalEvents[kind].map(result => <button className="atum-row flex min-h-11 w-full items-start gap-2.5 px-2 py-1.5 text-left"
                key={`${kind}:${result.eventId}`} onClick={() => void openGlobalEvent(result).catch(fail)} type="button">
                {kind === 'files' ? <Files className="mt-0.5 size-4 text-(--atum-ink-muted)" /> : <Messages className="mt-0.5 size-4 text-(--atum-ink-muted)" />}
                <span className="min-w-0"><span className="block truncate text-xs text-(--atum-ink-muted)">{result.channelName}</span>
                  <span className="line-clamp-2 block text-sm text-(--atum-ink)">{result.file?.name ?? result.snippet}</span></span>
              </button>)}
            </section> : null)}
          </div>
        )}
        {localSetupRequired &&
          (!snapshot.assistant ||
            snapshot.assistantSetup === 'failed' ||
            snapshot.assistantSetup === 'action_required') &&
          snapshot.domainEnabled &&
          snapshot.state === 'ready' && <AssistantSetupCard state={snapshot.assistantSetup} />}
        <MatrixRosterConversations
          // New assistant lives in the New chat sheet's footer, not as a row here (Atum Kit mockups).
          assistantOpening={Boolean(assistantOpening)}
          cloudOnly={cloudOnly}
          externalResultCount={externalSearchResultCount}
          externalSearching={globalSearching}
          fail={fail}
          onAppInfo={onAppInfo}
          onEditAgent={onEditAgent}
          onOpen={() => {
            onNavigate()
            closeDrawer()
          }}
          onOpenApp={app => {
            onNavigate()
            closeDrawer()
            openApp(app)
          }}
          openAgentChat={agent => openAssistant(false, agent.userId)}
          openAssistant={(fresh, roomId) => openAssistant(fresh, undefined, roomId)}
          openingApp={openingApp}
          query={query}
          snapshot={snapshot}
        />
      </div>
      {compact && <span className="sr-only">{copy.title}</span>}
    </aside>
  )
}

/**
 * The company invitations waiting for the signed-in person, read from their own directory on sign-in, when the
 * window comes to the front and every few minutes, so one shows on the rail without Team space being open. An
 * account switch or sign-out drops what was read for the account before (`invite-inbox.ts`).
 */
function usePendingCompanyInvites(snapshot: MatrixSnapshot) {
  const ready = snapshot.state === 'ready'
  const accountKey = snapshot.identity ? teamSpaceAccountKey(snapshot.identity) : undefined
  const inbox = useStore($companyInviteInbox)

  useEffect(() => {
    setCompanyInviteInboxAccount(accountKey)
  }, [accountKey])

  useEffect(() => {
    const bridge = window.atumMatrix.companies

    if (!ready || !accountKey || !bridge) {
      return
    }

    // One read at a time, five minutes apart while healthy, backing off after failures (`invite-inbox.ts`).
    const polling = startCompanyInviteInboxPolling(bridge, accountKey)
    const onFocus = () => polling.nudge()
    window.addEventListener('focus', onFocus)

    return () => {
      polling.stop()
      window.removeEventListener('focus', onFocus)
    }
  }, [accountKey, ready])

  return accountKey ? pendingCompanyInvitations(inbox, accountKey) : []
}

export function MatrixApp({
  children,
  cloudOnly = true
}: {
  children?: ReactNode
  cloudOnly?: boolean
} = {}) {
  useMatrixMessageLinkBridge()
  useMatrixInviteLinkBridge()
  const [received, setSnapshot] = useState(initial)
  // A name just given on the assistant card shows everywhere before the snapshot confirms it.
  const nameOverrides = useStore($assistantNameOverrides)
  const snapshot = useMemo(() => withAssistantNames(received, nameOverrides), [received, nameOverrides])
  useEffect(() => settleAssistantNames(received), [received])
  const previousDraftIdentity = useRef(snapshot.identity)
  useEffect(() => {
    const previous = previousDraftIdentity.current
    const current = snapshot.identity

    if (previous && (previous.userId !== current?.userId || previous.deviceId !== current?.deviceId)) {
      clearLocalMatrixDraftsForIdentity(previous)
    }

    previousDraftIdentity.current = current
  }, [snapshot.identity])
  useEffect(() => bindMatrixPresenceSnapshot(snapshot), [snapshot])
  useEffect(() => () => clearMatrixPresence(), [])
  const [receivedSnapshot, setReceivedSnapshot] = useState(false)
  const facts = useWindowFacts()
  const desktopServicesReady = useRef(false)
  useEffect(() => {
    let live = true
    let received = false

    const unsubscribe = window.atumMatrix.subscribe(next => {
      received = true

      if (live) {
        if (next.identity || next.state === 'signed_out') {
          activateTeamSpaceCacheAccount(next.identity ? teamSpaceAccountKey(next.identity) : null)
        }

        // Handles (and the contacts reads filling them) belong to this account; signing out
        // tears them down before anything renders for the next one.
        bindMatrixHandleOwnerFromSnapshot(next)

        setSnapshot(next)
        setReceivedSnapshot(true)
      }
    })

    void window.atumMatrix
      .snapshot()
      .then(next => {
        if (live && !received) {
          if (next.identity || next.state === 'signed_out') {
            activateTeamSpaceCacheAccount(next.identity ? teamSpaceAccountKey(next.identity) : null)
          }

          bindMatrixHandleOwnerFromSnapshot(next)

          setSnapshot(next)
          setReceivedSnapshot(true)
        }
      })
      .catch(() => {
        if (live && !received) {
          // Nothing is known about this Mac's account, not even whether there is one
          // (account-unavailable.tsx): Try again, never the ways in or Sign out.
          setSnapshot({ ...initial, state: 'error', error: MATRIX_SNAPSHOT_UNAVAILABLE })
          setReceivedSnapshot(true)
        }
      })

    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    if (receivedSnapshot && !desktopServicesReady.current) {
      desktopServicesReady.current = true
      window.atumDesktopServices?.ready()
    }
  }, [receivedSnapshot])
  // Cold start owns the window once per signed-in account, until the blocking
  // steps finish or the person chooses to continue.
  const identityId = snapshot.identity?.userId ?? null
  const [startupDoneFor, setStartupDoneFor] = useState<string | null>(null)
  useEffect(() => {
    if (!identityId) {
      setStartupDoneFor(null)
    }
  }, [identityId])
  const finishStartup = useCallback(() => setStartupDoneFor(identityId), [identityId])
  const startupActive = Boolean(receivedSnapshot && identityId && startupDoneFor !== identityId)

  // The compact window is the auth step only; a signed-in account has the product window.
  useMatrixWindowMode({ identity: identityId, settled: receivedSnapshot })
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  useMatrixAgentHandleBackfill(snapshot)

  return (
    <MatrixLanguageProvider snapshot={snapshot}>
      {children}
      <MatrixAppearance preference={snapshot.identity ? snapshot.displayPreferences?.appearance.value : 'system'} />
      <MatrixAccountView
        cloudOnly={cloudOnly}
        facts={facts}
        key={JSON.stringify(snapshot.identity)}
        settled={receivedSnapshot}
        snapshot={snapshot}
        startupActive={startupActive}
      />
      {startupActive && <MatrixStartupScreen onDone={finishStartup} snapshot={snapshot} />}
    </MatrixLanguageProvider>
  )
}

/** A Workplace page opened from elsewhere, and where its back control returns. */
interface MatrixPageTrip {
  agentPrincipal: string
  serial: number
  /** Absent: Settings. `chat`: an assistant's sign-in. `store`: a Store listing's Skills Hub. */
  from?: 'chat' | 'store'
  /** With `store`: the official Hub skill the Skills page opens on. */
  hub?: string
}

function MatrixAccountView({
  cloudOnly,
  facts,
  settled,
  snapshot: projectedSnapshot,
  startupActive = false
}: {
  cloudOnly: boolean
  facts: MatrixWindowFacts
  settled: boolean
  snapshot: MatrixSnapshot
  /** The launch screen is over the window: nothing behind it is reachable or shown natively. */
  startupActive?: boolean
}) {
  const copy = useMatrixCopy()
  const launch = useLaunchCopy()
  const conversation = useConversationCopy()
  const chat = useChatCopy()
  const rosterCopy = useRosterCopy()
  const { t, locale } = useI18n()
  const appCopy = useAppCopy()
  const workbenchCopy = useMatrixWorkbenchCopy()
  const personInfoCopy = matrixPersonInfoCopy(locale)
  const shell = t.matrixShell
  const assistantCardCopy = useAssistantCardCopy()
  const privateCosRecords = useStore($companyPrivateCos)

  const snapshot = useMemo(() => {
    const accountKey = teamSpaceAccountKey(projectedSnapshot.identity)
    const prefix = `${accountKey}\n`

    const boundRoomIds = new Set(
      Object.entries(privateCosRecords)
        .filter(([key]) => key.startsWith(prefix))
        .flatMap(([, state]) => {
          const roomId = companyPrivateCosBoundRoomId(state)

          return roomId ? [roomId] : []
        })
    )

    let changed = false

    // A company's private Chief of Staff room is the company's, never one of the person's own
    // assistants: whatever a projection said, it carries no personal assistant flag or agent.
    const rooms = projectedSnapshot.rooms.map(room => {
      const bound = boundRoomIds.has(room.id) && !room.companyPrivateCosBound
        ? { ...room, companyPrivateCosBound: true as const }
        : room

      const next = withoutPersonalAgent(bound)

      if (next !== room) {
        changed = true
      }

      return next
    })

    return changed ? { ...projectedSnapshot, rooms } : projectedSnapshot
  }, [privateCosRecords, projectedSnapshot])

  const compact = useCompact()
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const lookAppearance = matrixDisplayMode(snapshot.displayPreferences?.appearance.value, systemDark)
  const [lookPreview, setLookPreview] = useState<{ roomId: string; look: LookRoomAccountData } | null>(null)
  // What a failed action says (launch night): by cause, cleared when the chat changes or a
  // send goes through, and dismissable. Never a code.
  const [error, setError] = useState<MatrixChatFailure | null>(null)
  // The official bot a failure was about (`aboutAppBot`), so its sentence can name it, and the
  // Retry that does the failed action again. Every failure comes through `fail`, which sets both.
  const [failureSubject, setFailureSubject] = useState<string>()
  const [failureRetry, setFailureRetry] = useState<{ run: () => void } | null>(null)
  const [sidebarShowing, setSidebarShowing] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const storeOpen = snapshot.destination?.kind === 'discover'

  const storeNavigation = useMatrixStoreNavigation({
    active: storeOpen,
    appsAvailable: snapshot.apps?.state === 'ready' && snapshot.apps.apps.length > 0,
    checkoutAvailable: Boolean(snapshot.checkout),
    storeUnavailable: !snapshot.store || snapshot.store.state === 'unavailable'
  })

  const {
    onQueryChange: setStoreQuery,
    onShelfChange: setStoreShelf,
    query: storeQuery,
    shelf: storeShelf
  } = storeNavigation

  // The sidebar toggle says what it does. Not "chats": each agent row has its own chats toggle.
  const sidebarToggleLabel = (compact ? drawerOpen : sidebarShowing)
    ? t.atum.chat.closeSidebar
    : t.atum.chat.openSidebar

  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => {
    if (!compact) {
      setDrawerOpen(false)
    }
  }, [compact])
  const [workspaceScope, setWorkspaceScope] = useState<string | null>(null)
  // What the side panel holds: the workbench, or a chat with people's conversation info.
  const [workspaceKind, setWorkspaceKind] = useState<'workbench' | 'info'>('workbench')
  const [threadView, setThreadView] = useState<MatrixThreadView | null>(null)
  const [pinnedRoomId, setPinnedRoomId] = useState<string | null>(null)
  const workspaceOpener = useRef<HTMLButtonElement>(null)
  const restoreWorkspaceFocus = useRef(false)
  const [workspaceTabs, setWorkspaceTabs] = useState({ scope: '', count: 0 })
  const [documentRequest, setDocumentRequest] = useState(0)
  const [browserRequest, setBrowserRequest] = useState<{ id: string; url: string; scope: string }>()
  const [terminalRequest, setTerminalRequest] = useState<{ id: string; scope: string; serial: number }>()
  const [appRouteRequest, setAppRouteRequest] = useState<AppBotRouteRequest>()
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false)
  const [workspacePercent, setWorkspacePercent] = useState(ATUM_WORKSPACE_DEFAULT_PERCENT)
  const [workplaceActive, setWorkplaceActive] = useState(false)
  const [teamSpaceTranscriptVisible, setTeamSpaceTranscriptVisible] = useState(false)
  const homeEscapeRoomId = useRef<string | null>(null)
  const [driveActive, setDriveActive] = useState(false)
  const [driveDestination, setDriveDestination] = useState<MatrixDriveDestination>('recents')
  const [drivePreviewRequest, setDrivePreviewRequest] = useState<MatrixDrivePreviewRequest>()
  // Drive is a principal destination. The page itself owns unavailable/setup states.
  const driveAvailable = true
  // Workplace opens on its list, or straight on a page (the model picker's Advanced options).
  const [workplacePage, setWorkplacePage] = useState<MatrixPageId>()
  // A page Settings › Advanced opened: whose it is, and that its back control returns to Settings
  // (`from: 'chat'`: one an assistant's sign-in opened, whose back control returns to the chat).
  const [settingsTrip, setSettingsTrip] = useState<MatrixPageTrip>()
  const [assistantOpening, setAssistantOpening] = useState<string | null>(null)
  const [createdAssistantRoomId, setCreatedAssistantRoomId] = useState<CreatedAssistantRoom | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPane, setSettingsPane] = useState<MatrixSettingsPane>('account')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteReturnFocus = useRef<HTMLElement | null>(null)
  const paletteFocusTarget = useRef<(() => void) | null>(null)
  const paletteFocusFrame = useRef<number | null>(null)
  const paletteOwnerLive = useRef(true)
  useLayoutEffect(() => {
    paletteOwnerLive.current = true

    return () => {
      paletteOwnerLive.current = false

      if (paletteFocusFrame.current !== null) {
        cancelAnimationFrame(paletteFocusFrame.current)
      }
    }
  }, [])
  const [profileEditor, setProfileEditor] = useState<{ target: MatrixProfileTarget; name: string } | null>(null)
  const profileTarget = profileEditor?.target

  const walletHistory = useMatrixWalletHistory(
    snapshot,
    settingsOpen && settingsPane === 'protons',
    window.atumMatrix.wallet
  )

  const profileEditorOpen = Boolean(
    profileTarget && snapshot.state === 'ready' && snapshot.identity && profileTarget.kind === 'human'
  )

  // The assistant card (assistant-card/): an assistant's own page, opened from anywhere.
  const assistantCardOpen = Boolean(useStore($assistantCard))

  const mobileCopy = useMobileCopy()
  // The profile editor names the person as the window does: never their raw Matrix ID.
  const { name: ownName } = useOwnName(snapshot)

  const phone = snapshot.identity
    ? {
        icon: <DeviceMobile aria-hidden />,
        label: mobileCopy.title,
        onOpen: () => {
          setAccountMenuOpen(false)
          setMobileOpen(true)
        }
      }
    : undefined

  const selectedAssistant = useRef<string | null>(null)
  const rosterOpen = useRef<((fresh?: boolean, agentId?: string, roomId?: string) => Promise<void>) | null>(null)
  const newMessageOpen = useRef<(() => void) | null>(null)
  const openNewMessageAfterStore = useRef(false)
  useEffect(() => {
    if (!storeOpen && openNewMessageAfterStore.current) {
      openNewMessageAfterStore.current = false
      newMessageOpen.current?.()
    }
  }, [storeOpen])
  // The header's search in the open chat (⌘F and the palette open it).
  const chatSearchOpen = useRef<(() => void) | null>(null)
  const chatSearch = useChatSearchCopy()

  const fail = useCallback(
    (cause?: unknown, source: MatrixWindowFailureSource = 'unknown') => {
      const retry = matrixFailureRetry(cause)

      setError(reportMatrixWindowFailure(source, cause, snapshot.state !== 'offline', Boolean(retry)))
      setFailureSubject(matrixFailureSubject(cause))
      setFailureRetry(retry ? { run: retry } : null)
    },
    [snapshot.state]
  )

  const messageLinkRequest = useStore($matrixMessageLinkRequest)
  const inviteJoinRequest = useStore($matrixInviteJoinRequest)
  const pendingCompanyInvites = usePendingCompanyInvites(snapshot)
  useEffect(() => {
    if (!messageLinkRequest && !inviteJoinRequest) {return}

    setSettingsOpen(false)
    setAccountMenuOpen(false)
    setMobileOpen(false)
    setDriveActive(false)
    setSettingsTrip(undefined)
    setWorkplacePage(undefined)
    setWorkplaceActive(true)
  }, [inviteJoinRequest, messageLinkRequest])

  // A link opened while signed out waits in memory (`invite-join.ts`), never in storage. Once an account is ready the
  // join preview needs Team space on screen: bring it forward then, for that account. A request already previewed
  // by another account still opens, and its dialog refuses to join it under this one (`wrong_account`).
  const readyAccountKey = snapshot.state === 'ready' && snapshot.identity ? teamSpaceAccountKey(snapshot.identity) : undefined
  const inviteJoinSerial = inviteJoinRequest?.serial

  useEffect(() => {
    if (!readyAccountKey || inviteJoinSerial === undefined) {return}

    setSettingsOpen(false)
    setDriveActive(false)
    setSettingsTrip(undefined)
    setWorkplacePage(undefined)
    setWorkplaceActive(true)
  }, [inviteJoinSerial, readyAccountKey])

  // A failure belongs to the chat it happened in.
  useEffect(() => setError(null), [snapshot.roomId])
  // Another device asking this one to approve it: from the indicator, or by itself while this
  // window is in front (attention-indicator.tsx, owner decision D1).
  const approvalSheet = useMatrixApprovalSheet(snapshot.security?.approval)

  /** The indicator's item, at the place its action lives (agent-attention.ts). */
  // One assistant's advanced provider settings. Provider reconnect uses the account dialog below.
  const openAgentConnections = (agentPrincipal: string) => {
    if (!window.atumMatrix.pages) {
      void window.atumMatrix.retryReadiness().catch(fail)

      return
    }

    setSettingsOpen(false)
    setDriveActive(false)
    setSettingsTrip(trip => ({ agentPrincipal, serial: (trip?.serial ?? 0) + 1, from: 'chat' }))
    setWorkplacePage('connections')
    setWorkplaceActive(true)
  }

  // Provider recovery is account-scoped. It must not depend on the assistant management
  // backend whose selected provider is the thing that failed readiness.
  const openPlanSignIn = () => {
    setAccountMenuOpen(false)
    setSettingsPane('connections')
    setSettingsOpen(true)
  }

  // A free Store listing's "Install from Skills Hub" (store/hub-skill.ts): that assistant's
  // Skills page, on the Hub, opened on the skill. The page asks before anything installs.
  const storeHubRequest = useStore($matrixStoreHubRequest)

  useEffect(() => {
    if (!storeHubRequest) {
      return
    }

    $matrixStoreHubRequest.set(null)

    if (!window.atumMatrix.pages) {
      void window.atumMatrix.retryReadiness().catch(fail)

      return
    }

    setSettingsOpen(false)
    setDriveActive(false)
    setSettingsTrip(trip => ({
      agentPrincipal: storeHubRequest.agentPrincipal,
      serial: (trip?.serial ?? 0) + 1,
      from: 'store',
      hub: storeHubRequest.hub
    }))
    setWorkplacePage(storeHubRequest.page)
    setWorkplaceActive(true)
  }, [fail, storeHubRequest])

  const openAttention = (item: MatrixAttentionItem) => {
    if (item.kind === 'plan_sign_in') {
      openPlanSignIn()

      return
    }

    if (item.kind === 'approval') {
      approvalSheet.show()

      return
    }

    if (item.kind === 'recovery') {
      setSettingsPane('privacy')
      setSettingsOpen(true)

      return
    }

    // One of the person's own devices to verify: the devices list, at that device's Verify.
    if (item.kind === 'device_unverified') {
      $matrixDeviceToShow.set(item.device?.deviceId ?? null)
      setSettingsPane('privacy')
      setSettingsOpen(true)

      return
    }

    if (item.kind === 'agent') {
      const agent = snapshot.agents?.find(each => each.principal === item.principal)

      if (agent) {
        // A Stop this Mac could not save is pressed again in the reply settings of the room it
        // listens in, so that room; otherwise its latest chat, where its line says what to do; a
        // new one only if it has none.
        const listeningRoom = matrixAgentAttention(agent, Date.now()).listening
          ? snapshot.rooms.find(each => each.id === agent.listening?.roomId && each.membership === 'join')
          : undefined

        const main = resolveProjectedConversation(snapshot.rooms, snapshot.identity?.userId, agent.userId).main

        const latest = attentionConversationRoom(snapshot.rooms, {
          markedMain: main,
          listeningRoom,
          agentPrincipal: agent.principal
        })

        setWorkplaceActive(false)
        setDriveActive(false)

        if (latest) {
          void runMatrixCommand({ kind: 'select', roomId: latest.id }).catch(fail)
        } else {
          void rosterOpen.current?.(!agent.isDefault, agent.isDefault ? undefined : agent.userId)
        }
      }

      return
    }

    const action = ({ sign_in: 'sign_in', protons: 'top_up', runtime: 'download', connect: 'connect' } as const)[
      item.kind as 'sign_in' | 'protons' | 'runtime' | 'connect'
    ]

    // The readiness that asked, so a sign-in is the right one (launch-actions.ts).
    const asking = snapshot.agents?.find(
      each => matrixAgentAttention(each, Date.now()).waitsOn === item.kind && each.readiness
    )?.readiness

    if (action) {
      void runMatrixReadinessAction(action, asking ? { ...snapshot, readiness: asking } : snapshot).catch(fail)
    }
  }

  // The window's first chat: once the launch steps aside, typing goes into its box.
  const launching = useRef(startupActive)
  useEffect(() => {
    if (launching.current && !startupActive) {
      requestAnimationFrame(() => focusMatrixComposer({ ifIdle: true }))
    }

    launching.current = startupActive
  }, [startupActive])

  const refreshWallet = () => {
    const wallet = window.atumMatrix.wallet

    if (wallet) {
      void wallet.refresh().catch(fail)
    }
  }

  // Under cloud-only, recovery is the account-wide ChatGPT/OpenCode Connections page. The
  // dormant local path still opens its assistant-scoped model setup.
  const openOwnModel = () => {
    setSettingsPane(cloudOnly ? 'subscriptions' : 'assistant')
    setSettingsOpen(true)
  }

  const switchDefaultToAtum = window.atumMatrix.useAtumModel
    ? async () => {
        const result = await window.atumMatrix.useAtumModel!()

        if (result.state !== 'ready') {
          throw new Error('matrix_setup_failed')
        }
      }
    : undefined

  const openProtons = () => {
    setAccountMenuOpen(false)
    setSettingsPane('protons')
    setSettingsOpen(true)
    refreshWallet()
  }

  // Contact us opened the Founder chat (founder/contact-us.tsx), already selected: the person
  // asked for it, so it comes to the front from anywhere. Workplace and Drive step aside, the
  // compact drawer closes, and the select itself ends an app or the Store.
  useFounderChatRequests(() => {
    setWorkplaceActive(false)
    setDriveActive(false)
    setDrawerOpen(false)
  })

  // One top-up for the account menu and Settings: the Store's own checkout, which takes the
  // window from wherever it is; a build without it keeps Atum's payments page and the overlay.
  const openTopUp = () => {
    if (matrixInAppTopUp(snapshot)) {
      setAccountMenuOpen(false)
      setSettingsOpen(false)
      setWorkplacePage(undefined)
      setWorkplaceActive(false)
      setDriveActive(false)
    }

    void openMatrixTopUp(snapshot).catch(fail)
  }

  // The launch, the account menu and Settings draw over the window: native pages step aside.
  const paletteBlocked =
    startupActive ||
    accountMenuOpen ||
    settingsOpen ||
    mobileOpen ||
    profileEditorOpen ||
    assistantCardOpen ||
    anyAgentPrompts(snapshot) ||
    isMatrixVerificationPending(snapshot.security?.verification)

  const paletteVisible = paletteOpen && !paletteBlocked

  const overlaid =
    startupActive ||
    accountMenuOpen ||
    settingsOpen ||
    mobileOpen ||
    profileEditorOpen ||
    assistantCardOpen ||
    paletteVisible

  const signedIn = Boolean(snapshot.identity)
  useEffect(() => window.atumMatrix.onDocumentClose?.(prepareMatrixDocumentClose), [])
  useEffect(() => {
    if (paletteBlocked) {
      setPaletteOpen(false)
    }
  }, [paletteBlocked])
  useEffect(() => {
    if (!snapshot.identity) {
      return
    }

    const active = (event: Event) => {
      if (event.isTrusted) {
        window.atumDesktopServices?.active()
      }
    }

    window.addEventListener('pointerdown', active, { capture: true, passive: true })
    window.addEventListener('keydown', active, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', active, true)
      window.removeEventListener('keydown', active, true)
    }
  }, [snapshot.identity])
  useEffect(() => {
    const room = snapshot.rooms.find(value =>
      isAssistantRoom(value, snapshot.identity?.userId, snapshot.assistant?.userId)
    )

    const scope =
      snapshot.identity && snapshot.assistant ? `${snapshot.identity.userId}:${snapshot.assistant.userId}` : null

    const retainedDestination =
      snapshot.destination?.kind === 'room' || (Boolean(snapshot.apps) && Boolean(snapshot.destination))

    if (
      snapshot.state !== 'ready' ||
      !scope ||
      !room ||
      snapshot.roomId ||
      retainedDestination ||
      selectedAssistant.current === scope
    ) {
      return
    }

    selectedAssistant.current = scope
    void runMatrixCommand({ kind: 'select', roomId: room.id }).catch(error => {
      // Restoring the default chat is background navigation. A refusal leaves the current
      // destination untouched and is diagnostic only; no person action failed.
      reportMatrixWindowFailure('command.select', error, snapshot.state !== 'offline')
    })
  }, [
    snapshot.assistant,
    snapshot.destination,
    snapshot.apps,
    snapshot.identity,
    snapshot.roomId,
    snapshot.rooms,
    snapshot.state
  ])
  // The created room once sync has listed it: a room that was listed and is gone was deleted
  // (left and forgotten), which ends it as surely as leaving does.
  const listedCreatedRoom = useRef<string | null>(null)
  useEffect(() => {
    // Retain an unfinished connect across partial sync. A successful connect
    // retires it above; a terminal membership must not trap the retry shortcut.
    const created = createdAssistantRoomId
      ? snapshot.rooms.find(value => value.id === createdAssistantRoomId.roomId)
      : undefined

    if (created) {
      listedCreatedRoom.current = created.id
    }

    if (
      createdAssistantRoomId &&
      ((created && ['leave', 'ban'].includes(created.membership)) ||
        (!created && listedCreatedRoom.current === createdAssistantRoomId.roomId))
    ) {
      listedCreatedRoom.current = null
      setCreatedAssistantRoomId(null)
    }
  }, [createdAssistantRoomId, snapshot.rooms])
  const room = snapshot.rooms.find(value => value.id === snapshot.roomId)
  const privateCosAccountPrefix = `${teamSpaceAccountKey(snapshot.identity)}\n`

  const verifiedPrivateCosRoom = room && Object.entries(privateCosRecords).some(([key, state]) =>
    key.startsWith(privateCosAccountPrefix) && companyPrivateCosRoom(state, [room])?.id === room.id)

  useEffect(() => {
    if (!lookPreview) {
      return
    }

    if (lookPreview.roomId !== room?.id || JSON.stringify(room.look) === JSON.stringify(lookPreview.look)) {
      setLookPreview(null)
    }
  }, [lookPreview, room?.id, room?.look])
  const founderCopy = useFounderCopy()
  const founderDraftRequested = useStore($founderDraftOpen)
  // The Founder's local draft: offered while no chat exists; opening it puts the empty chat in
  // front of whatever was selected. It is never a room of its own.
  const founderDraftShown = founderDraftRequested && Boolean(snapshot.founder?.offer)
  // A chat that now exists (made here or on another device) takes the draft's place, and so
  // does any room the person opens.
  useEffect(() => {
    if (!snapshot.founder?.offer || snapshot.founder.roomId) {
      closeFounderDraft()
    }
  }, [snapshot.founder?.offer, snapshot.founder?.roomId])
  useEffect(() => {
    if (snapshot.roomId) {
      closeFounderDraft()
    }
  }, [snapshot.roomId])

  const currentThreadView = room && threadView?.roomId === room.id ? threadView : null

  const pinsOpen = Boolean(room && pinnedRoomId === room.id)

  // A channel or a company conversation: Team Space's room, shown in the company workspace and in no Personal list.
  const companyChannelBound = isTeamSpaceRoom(room)

  // A raw marker, renderer-only binding, or restored room selection is quarantine, not authority.
  // Only the current strict platform view plus the exact joined-room policy may mount its transcript.
  const companyChannelContentAuthorized = companyChannelBound &&
    (!isCompanyPrivateCosClaim(room) || verifiedPrivateCosRoom)

  // Notes-to-self integration seam: Team Space keeps its sidebar while this company's notes room
  // occupies the same transcript pane. Its company identity comes from immutable create content.
  const notesSelfBound = Boolean(room && matrixNotesSelfRoom(snapshot.notesSelf, room.id))

  const teamSpaceChannelOpen = Boolean(workplaceActive && !settingsTrip && (companyChannelBound || notesSelfBound))
  const conversationShellVisible = (!workplaceActive && !companyChannelBound) || teamSpaceChannelOpen

  const roomBot = directAppBot(snapshot)

  // In another agent's room, that agent's state stands in for the default agent's.
  const roomView = snapshotForRoom(snapshot)

  const profileAgent = room?.assistant
    ? snapshot.agents?.find(agent => agent.userId === roomView.assistant?.userId)
    : undefined

  const appDestination = Boolean(snapshot.apps && snapshot.destination && snapshot.destination.kind !== 'room')
  const activeAgentPrincipal = room?.agentPrincipal

  const driveTaskScope = useMemo<MatrixDriveTaskScope | undefined>(
    () =>
      room?.assistant &&
      roomView.identity &&
      isAssistantRoom(room, roomView.identity.userId, roomView.assistant?.userId)
        ? { userId: roomView.identity.userId, deviceId: roomView.identity.deviceId, roomId: room.id }
        : undefined,
    [room, roomView.assistant?.userId, roomView.identity]
  )

  useEffect(() => {
    const current = $matrixDriveTaskSelection.get().scope

    if (
      current &&
      (!driveTaskScope ||
        current.userId !== driveTaskScope.userId ||
        current.deviceId !== driveTaskScope.deviceId ||
        current.roomId !== driveTaskScope.roomId)
    ) {
      setMatrixDriveTaskScope(null, null)
    }
  }, [driveTaskScope])

  // The Drive pane is optional UI. Keep its opaque handles bound even while the
  // person is in chat, where a native refresh or withdrawal can replace them.
  useEffect(() => {
    const bridge = window.atumMatrix.drive

    return bridge?.subscribe(view => {
      const current = $matrixDriveTaskSelection.get()

      if (current.scope && (view.state !== 'ready' || current.revision !== view.revision)) {
        setMatrixDriveTaskScope(null, null)
      }
    })
  }, [])

  const selectedApp =
    snapshot.destination?.kind === 'app'
      ? snapshot.apps?.apps.find(
          app => snapshot.destination?.kind === 'app' && app.app_id === snapshot.destination.appId
        )
      : undefined

  // Panel visibility belongs to the room, not to a document revision. A new
  // snapshot must not close the panel or discard a native preview grant.
  const currentWorkspaceScope = founderDraftShown
    ? 'founder-draft'
    : companyChannelBound && !teamSpaceChannelOpen
      ? 'home'
      : (snapshot.roomId ?? 'home')

  const currentWorkbenchScope = matrixWorkbenchScope(snapshot)
  const workspaceOpen = workspaceScope === currentWorkspaceScope
  const workspaceTabCount = workspaceTabs.scope === currentWorkspaceScope ? workspaceTabs.count : 0
  const workspaceOverFrame = workspaceOpen && (compact || workspaceExpanded)

  useEffect(() => {
    setAppRouteRequest(current => (current?.scope === currentWorkbenchScope ? current : undefined))
    setDrivePreviewRequest(current => (current?.scope === currentWorkbenchScope ? current : undefined))
  }, [currentWorkbenchScope])
  // Reading is the transcript on screen in a focused window; its newest message is then acknowledged.
  useMatrixReadAttention({
    roomId: founderDraftShown ? null : (room?.id ?? null),
    onScreen:
      !founderDraftShown &&
      (companyChannelBound || notesSelfBound
        ? teamSpaceChannelOpen && teamSpaceTranscriptVisible
        : !workplaceActive) &&
      !driveActive &&
      !appDestination &&
      !workspaceOverFrame &&
      !(compact && currentThreadView) &&
      !drawerOpen &&
      !settingsOpen &&
      !startupActive &&
      !profileEditorOpen &&
      !mobileOpen,
    connected: snapshot.state === 'ready'
  })

  // A Matrix destination (including an app) is an explicit foreground choice.
  // Native pages must close before that destination can draw above the renderer.
  // The choice is the request (destination-requests.ts), not the snapshot: every snapshot
  // repeats the destination as a new object, which closed Drive or Workplace (or a Store
  // side trip) on the next sync after either was opened over the Store or an app.
  const destinationRequests = useStore($matrixDestinationRequests)
  const seenDestinationRequests = useRef(destinationRequests)
  // "Settings" on the Mac sources band, or a "Can use" row with something to fix.
  const connectionsRequests = useStore($matrixConnectionsRequests)
  const seenConnectionsRequests = useRef(connectionsRequests)
  useEffect(() => {
    if (connectionsRequests !== seenConnectionsRequests.current) {
      seenConnectionsRequests.current = connectionsRequests
      setSettingsPane('connections')
      setSettingsOpen(true)
    }
  }, [connectionsRequests])
  useEffect(() => {
    if (destinationRequests !== seenDestinationRequests.current) {
      seenDestinationRequests.current = destinationRequests
      setWorkplaceActive(false)
      setDriveActive(false)
    }
  }, [destinationRequests])

  useEffect(() => {
    if (!workspaceOpen && restoreWorkspaceFocus.current) {
      restoreWorkspaceFocus.current = false
      workspaceOpener.current?.focus({ preventScroll: true })
    }
  }, [workspaceOpen])

  const closeWorkspace = () => {
    restoreWorkspaceFocus.current = true
    setWorkspaceScope(null)
  }

  // A roster folded away to make room for the side panel comes back when the panel goes.
  const rosterFoldedForPanel = useRef(false)
  useEffect(() => {
    if (!workspaceOpen && rosterFoldedForPanel.current) {
      rosterFoldedForPanel.current = false
      setSidebarShowing(true)
    }
  }, [workspaceOpen])

  const reportWorkspaceTabs = useCallback(
    (count: number) => {
      setWorkspaceTabs(previous =>
        previous.scope === currentWorkspaceScope && previous.count === count
          ? previous
          : { scope: currentWorkspaceScope, count }
      )
    },
    [currentWorkspaceScope]
  )

  const openWorkspace = (kind: 'workbench' | 'info' = 'workbench') => {
    setThreadView(null)
    setPinnedRoomId(null)
    setWorkspaceKind(kind)
    setWorkspaceScope(currentWorkspaceScope)
    setWorkspaceExpanded(false)

    // A narrow window cannot hold rail, roster, chat and panel side by side: fold the
    // roster rather than squeeze the chat to a few words. The sidebar toggle brings it back.
    if (!compact && sidebarShowing && matrixWorkbenchCrowdsRoster(window.innerWidth, workspacePercent)) {
      rosterFoldedForPanel.current = true
      setSidebarShowing(false)
    }
  }

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // or a document still opens the workbench, which stays mounted behind the info panel.
  const conversationInfo =
    !founderDraftShown && !driveActive && !appDestination ? matrixConversationInfo(room, snapshot) : null

  const openSidePanel = () => openWorkspace(conversationInfo ? 'info' : 'workbench')
  const infoShown = Boolean(workspaceOpen && workspaceKind === 'info' && conversationInfo && room)

  const revealDocument = () => {
    openWorkspace()
    setDocumentRequest(value => value + 1)
  }

  const openThreads = (rootId?: string) => {
    if (!room || !isTeamSpaceRoom(room)) {
      return
    }

    if (workspaceOpen) {
      closeWorkspace()
    }

    setPinnedRoomId(null)
    setThreadView({ roomId: room.id, filter: currentThreadView?.filter ?? 'recent', ...(rootId ? { rootId } : {}) })
  }

  const togglePinnedMessages = () => {
    if (!room || !isTeamSpaceRoom(room)) {return}

    if (pinsOpen) {
      setPinnedRoomId(null)

      return
    }

    if (workspaceOpen) {closeWorkspace()}
    setThreadView(null)
    setPinnedRoomId(room.id)
  }

  const selectDefaultConversation = () => {
    if (room && !isTeamSpaceRoom(room)) {
      return
    }

    const homeRooms = snapshot.rooms.filter(value => !isTeamSpaceRoom(value))

    const defaultRoom =
      homeRooms.find(value => isAssistantRoom(value, snapshot.identity?.userId, snapshot.assistant?.userId)) ??
      // An unavailable platform default is not permission to enter another agent's history.
      (!snapshot.assistant && !primaryAgent(snapshot) ? sortConversations(homeRooms)[0] : undefined)

    if (defaultRoom) {
      void runMatrixCommand({ kind: 'select', roomId: defaultRoom.id }).catch(fail)
    }
  }

  const toggle = () => {
    // The person decides about the roster from here on; closing the panel will not undo it.
    rosterFoldedForPanel.current = false

    if (compact) {
      setDrawerOpen(open => !open)
    } else {
      setSidebarShowing(showing => !showing)
    }
  }

  const focusRosterSearch = () => {
    if (room && isTeamSpaceRoom(room)) {
      homeEscapeRoomId.current = room.id
    }

    setWorkplaceActive(false)
    setDriveActive(false)

    if (compact) {
      setDrawerOpen(true)
    } else {
      setSidebarShowing(true)
    }

    if (paletteFocusFrame.current !== null) {
      cancelAnimationFrame(paletteFocusFrame.current)
    }

    paletteFocusFrame.current = requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>('[data-atum-roster] input')?.focus()
    )
  }

  const togglePalette = () => {
    if (!paletteVisible) {
      paletteReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      paletteFocusTarget.current = null
    }

    setPaletteOpen(!paletteVisible)
  }

  const roomAgent =
    room?.assistant && isAssistantRoom(room, roomView.identity?.userId, roomView.assistant?.userId)
      ? snapshot.agents?.find(agent => agent.userId === roomView.assistant?.userId)
      : undefined

  // ⌘N opens New message, the roster's start sheet (the same as its "+"), when the feature is
  // on. The kill switch preserves the old fresh-room path so a rollback changes no legacy
  // interaction.
  const newMessage = () => {
    if (room && isTeamSpaceRoom(room)) {
      homeEscapeRoomId.current = room.id
    }

    setWorkplaceActive(false)
    setDriveActive(false)

    if (AGENT_ONE_CONVERSATION) {
      newMessageOpen.current?.()
    } else {
      void rosterOpen.current?.(true, roomAgent && !roomAgent.isDefault ? roomAgent.userId : undefined)
    }
  }

  // Local facts and the profile cache are projected once; the rail only selects states.
  const surfaces = useMatrixSurfaces(snapshot)
  const workplaceOnRail = railSurfaceState('teamSpace', surfaces) === 'on'
  // Workplace as the rail's place (not a page opened from Settings, which is a side trip).
  const workplaceOnScreen = workplaceActive && workplaceOnRail && !settingsTrip

  // The window header follows the transcript: over Workplace it names the company channel only while the
  // workspace says that channel is what is on screen, and names Workplace for an overview or another company.
  const teamSpaceChannelHeaded = workplaceOnScreen
    ? teamSpaceChannelOpen && teamSpaceTranscriptVisible
    : conversationShellVisible

  // The workspace's selected company and its authoritative channel directory scope ⌘K and the shortcuts.
  const activeCompanyId = useStore($companyChannelCompanyId)
  const companyOrder = useStore($companyChannelOrder)

  // A chat is on screen (not Workplace, Drive, the Store or an app): its header can search it.
  const chatShown = Boolean(room && !founderDraftShown && conversationShellVisible && !driveActive && !appDestination)

  const conversationLook = useMemo(
    () =>
      room && chatShown
        ? resolveConversationLook({
            snapshot,
            room,
            appearance: lookAppearance,
            accountData: lookPreview?.roomId === room.id ? lookPreview.look : room.look
          })
        : null,
    [chatShown, lookAppearance, lookPreview, room, snapshot]
  )

  useEffect(() => {
    if (!room || !isTeamSpaceRoom(room)) {
      homeEscapeRoomId.current = null

      return
    }

    // A notification or deep link into a validated company room enters Team
    // Space. Clicking Home marks this exact room as an intentional escape until
    // the personal-room selection arrives, so it cannot bounce back or leak.
    if (homeEscapeRoomId.current !== room.id && !settingsTrip && !driveActive && !appDestination) {
      setWorkplaceActive(true)
    }
  }, [appDestination, driveActive, room, settingsTrip])

  // Unread and mentions across the company's channels, for the rail's Workplace icon.
  const roomsBadge = companyRoomsBadge(snapshot.rooms)
  // Company invitations addressed to this person count there too: an invitation is not a room, so without this it
  // would wait unseen until Team space is opened. The invitee's own directory is read on sign-in and on focus.
  const inviteCount = pendingCompanyInvites.length

  const roomMentions = roomsBadge?.kind === 'mention' ? roomsBadge.count : 0

  // One count on the icon, as Slack sums its badge; the label names both kinds when both are there.
  const workplaceBadge = inviteCount > 0
    ? { mentions: inviteCount + roomMentions,
        label: roomMentions > 0
          ? `${matrixTeamSpaceCopy(locale).inviteSheet.railInvitations} · ${rosterCopy.mentions}`
          : matrixTeamSpaceCopy(locale).inviteSheet.railInvitations }
    : roomsBadge
      ? { mentions: roomsBadge.kind === 'mention' ? roomsBadge.count : 0,
          label: roomsBadge.kind === 'mention' ? rosterCopy.mentions : rosterCopy.newMessages }
      : undefined

  // Workplace channels, in the sidebar's own order; Home is never part of this walk.
  const openCompanyChannelRoom = (roomId: string) => {
    clearMatrixHistoryReveal(undefined, 'company')
    void runMatrixCommand({ kind: 'select', roomId }).catch(fail)
  }

  const stepCompanyChannel = (direction: 1 | -1, unreadOnly: boolean) => {
    const target = neighbouringCompanyChannel(
      companyOrder,
      companyPaletteChannels(snapshot.rooms, activeCompanyId, companyOrder),
      room?.companyChannel ? room.id : undefined,
      direction,
      unreadOnly
    )

    if (target) {
      openCompanyChannelRoom(target)
    }
  }

  const shellHandlers = {
    'nav.commandPalette': togglePalette,
    'nav.settings': () => setSettingsOpen(true),
    'view.toggleSidebar': toggle,
    'view.toggleRightSidebar': () =>
      pinsOpen ? setPinnedRoomId(null) : currentThreadView ? setThreadView(null) : workspaceOpen ? closeWorkspace() : openSidePanel(),
    'session.focusSearch': focusRosterSearch,
    ...(workplaceOnScreen && snapshot.state === 'ready'
      ? {
          'nav.channelPrev': () => stepCompanyChannel(-1, false),
          'nav.channelNext': () => stepCompanyChannel(1, false),
          'nav.channelUnreadPrev': () => stepCompanyChannel(-1, true),
          'nav.channelUnreadNext': () => stepCompanyChannel(1, true),
          // ⌘⌥1…⌘⌥9 and ⌘⌥↑/↓ between companies: the workspace knows the companies, so it is asked.
          ...companyShortcutHandlers()
        }
      : {}),
    ...(snapshot.assistant && snapshot.state === 'ready' ? { 'session.new': newMessage } : {}),
    ...(chatShown ? { 'chat.find': () => chatSearchOpen.current?.() } : {})
  }

  useShellShortcuts({ enabled: signedIn && !paletteBlocked, paletteOpen: paletteVisible, handlers: shellHandlers })

  // The palette finds what you can do and who and what you can open (launch night).
  const paletteTitle = (value: MatrixRoom) =>
    matrixChatTitle(value, { locale, untitled: t.atum.roster.untitledChat, chatOn: chat.chatOn })

  const openFromPalette = (roomId: string) => {
    if (room && isTeamSpaceRoom(room)) {
      homeEscapeRoomId.current = room.id
    }

    setWorkplaceActive(false)
    setDriveActive(false)
    setDrawerOpen(false)
    void runMatrixCommand({ kind: 'select', roomId }).catch(fail)
  }

  const paletteRoster = paletteVisible ? projectMatrixRoster(snapshot) : { groups: [], rest: [] }

  // The company's channels are offered only while Workplace is on screen: Home stays Home.
  const paletteChannels: MatrixPaletteAction[] =
    paletteVisible && workplaceOnScreen
      ? companyPaletteChannels(snapshot.rooms, activeCompanyId, companyOrder).map(value => ({
          id: `channel:${value.id}`,
          group: 'channels' as const,
          label: paletteTitle(value),
          keywords: [value.name],
          icon: (
            <span
              aria-hidden
              className="grid size-5 shrink-0 place-items-center rounded-md bg-(--atum-sunk) text-(--atum-ink-muted)"
            >
              <Hash className="size-3" />
            </span>
          ),
          run: () => openCompanyChannelRoom(value.id)
        }))
      : []

  const paletteActions: MatrixPaletteAction[] = [
    ...(shellHandlers['session.new']
      ? [
          {
            id: 'session.new',
            label: AGENT_ONE_CONVERSATION
              ? agentConversationCopy(locale).newMessage
              : roomAgent && !roomAgent.isDefault
                ? chat.newChatWith(matrixRosterAgentName(roomAgent, shell.assistantName))
                : t.atum.agents.newChat,
            run: newMessage
          }
        ]
      : []),
    {
      id: 'nav.settings',
      label: shell.settings,
      run: () => {
        paletteFocusTarget.current = () =>
          document.querySelector<HTMLElement>('[data-matrix-settings]:not([hidden]) [aria-current="page"]')?.focus()
        shellHandlers['nav.settings']()
      }
    },
    {
      id: 'session.focusSearch',
      label: t.atum.roster.search,
      run: () => {
        paletteFocusTarget.current = focusRosterSearch
        focusRosterSearch()
      }
    },
    ...(chatShown
      ? [
          {
            id: 'chat.find',
            label: chatSearch.search,
            run: () => {
              paletteFocusTarget.current = () => chatSearchOpen.current?.()
            }
          }
        ]
      : []),
    { id: 'view.toggleSidebar', label: sidebarToggleLabel, run: toggle },
    {
      id: 'view.toggleRightSidebar',
      label: workspaceOpen || currentThreadView || pinsOpen ? chat.hideSidePanel : chat.showSidePanel,
      run: shellHandlers['view.toggleRightSidebar']
    },
    // An assistant is found once, as its one conversation (its marked main): never its rooms.
    ...paletteRoster.groups.map(({ agent, rooms }) => {
      const name = matrixRosterAgentName(agent, shell.assistantName)

      const next = matrixAgentConversationRoom(
        rooms,
        resolveProjectedConversation(rooms, snapshot.identity?.userId, agent.userId).main
      )

      return {
        id: `assistant:${agent.principal}`,
        group: 'assistants' as const,
        label: name,
        adornment: agent.isDefault ? <MainAgentBadge /> : undefined,
        icon: (
          <AtumAssistantAvatar
            brand={agent.isDefault}
            className="size-5 shrink-0 rounded-md text-[0.625rem] leading-none"
            id={agent.principal}
            name={name}
          />
        ),
        run: () => {
          if (next) {
            openFromPalette(next.id)
          } else {
            if (room && isTeamSpaceRoom(room)) {
              homeEscapeRoomId.current = room.id
            }

            setWorkplaceActive(false)
            setDriveActive(false)
            void rosterOpen.current?.(true, agent.isDefault ? undefined : agent.userId)
          }
        }
      }
    }),
    ...paletteChannels,
    ...[
      ...paletteRoster.rest,
      // An official bot's chat is drawn in its roster row, not among the chats; still found
      // here, unless the person deleted it.
      ...(paletteRoster.apps ?? []).flatMap(({ room }) => (room && !room.appBot?.hidden ? [room] : []))
    ]
      .filter(value => value.membership === 'join' || value.membership === 'invite')
      .map(value => {
        const title = paletteTitle(value)

        return {
          id: `room:${value.id}`,
          group: value.direct && !value.assistant ? ('people' as const) : ('chats' as const),
          label: title,
          keywords: [value.name, value.firstLine ?? ''].filter(Boolean),
          icon: (
            <AtumAssistantAvatar
              className="size-5 shrink-0 rounded-md text-[0.625rem] leading-none"
              id={value.id}
              name={title}
            />
          ),
          run: () => openFromPalette(value.id)
        }
      })
  ]

  const notice =
    snapshot.error === 'matrix_sign_out_pending'
      ? copy.signOutPending
      : snapshot.error === 'matrix_signed_out'
        ? copy.sessionExpired
        : snapshot.error === 'matrix_direct_mapping_pending'
          ? conversation.directMapping
          : snapshot.error === 'matrix_disk_full'
            ? launch.diskFullHelp
            : matrixChatFailureCopy(error ?? 'generic', chat, locale, failureSubject)

  const setupCooldown =
    matrixSetupCooldown(snapshot.readiness) === undefined
      ? undefined
      : matrixReadinessCopy(snapshot.readiness!, snapshot.startup, shell, shell.startupSignedIn, locale)

  if (!snapshot.identity) {
    // Nothing is known before main's first snapshot, so nothing here may claim signed out
    // (main shows the window only once it has that answer: window-launch.ts).
    if (!settled) {
      return <div aria-hidden className="atum-shell h-dvh atum-window-ground" data-matrix-unsettled />
    }

    return (
      <MatrixAuthGate
        clearError={() => setError(null)}
        error={error !== null}
        fail={fail}
        settled={settled}
        snapshot={snapshot}
      />
    )
  }

  const conversationRoster = (
    <MatrixRoster
      assistantOpening={assistantOpening}
      cloudOnly={cloudOnly}
      compact={compact}
      createdAssistantRoomId={createdAssistantRoomId}
      facts={facts}
      fail={fail}
      newMessageRef={newMessageOpen}
      onAppInfo={app => {
        setDrawerOpen(false)
        openAssistantCard({ kind: 'app', appId: app.app_id })
      }}
      onAssistantOpeningChange={setAssistantOpening}
      onCloseDrawer={() => setDrawerOpen(false)}
      onConversationCreated={() => {
        setWorkplaceActive(false)
        setDriveActive(false)
        setDrawerOpen(false)
      }}
      onCreatedAssistantRoomIdChange={setCreatedAssistantRoomId}
      onEditAgent={(agent, focus) => {
        setDrawerOpen(false)
        openAssistantCard({ kind: 'agent', principal: agent.principal, ...(focus ? { focus } : {}) })
      }}
      onNavigate={() => {
        setWorkplaceActive(false)
        setDriveActive(false)
      }}
      onToggle={toggle}
      openRef={rosterOpen}
      snapshot={snapshot}
    />
  )

  const roster = storeOpen ? (
    <MatrixStoreSidebar
      compact={compact}
      newChatDisabled={snapshot.state !== 'ready'}
      onNewChat={() => {
        openNewMessageAfterStore.current = true
        selectDefaultConversation()
      }}
      onQueryChange={setStoreQuery}
      onShelfChange={next => {
        setStoreShelf(next)

        if (compact) {
          setDrawerOpen(false)
        }
      }}
      query={storeQuery}
      shelf={storeShelf}
      windowControls={
        <AtumWindowControlsSurface
          onToggleSidebar={toggle}
          reserveLights={!facts.isFullscreen && Boolean(facts.windowButtonPosition)}
          sidebarLabel={t.atum.chat.closeSidebar}
        />
      }
    />
  ) : (
    conversationRoster
  )

  const driveRoster = (
    <MatrixDriveSidebar
      compact={compact}
      current={driveDestination}
      onSelect={setDriveDestination}
      windowControls={
        <AtumWindowControlsSurface
          onToggleSidebar={toggle}
          reserveLights={!facts.isFullscreen && Boolean(facts.windowButtonPosition)}
          sidebarLabel={sidebarToggleLabel}
        />
      }
    />
  )

  const conversationContent =
    !appDestination &&
    (founderDraftShown ? (
      <FounderDraftChat snapshot={snapshot} />
    ) : room ? (
      <Conversation
        blocked={assistantOpeningBlocksRoom(assistantOpening, room, snapshot.identity?.userId)}
        cloudOnly={cloudOnly}
        compact={compact}
        fail={fail}
        key={room.id}
        onAppAction={(appId, routeId) => {
          setAppRouteRequest(current => ({
            appId,
            routeId,
            scope: currentWorkbenchScope,
            serial: (current?.serial ?? 0) + 1
          }))
          openWorkspace()
        }}
        onBackToAtum={roomAgent?.isDefault ? switchDefaultToAtum : undefined}
        onCheckInSettings={() => {
          // Check-ins and the pet are the assistant's own: its card is where they change.
          const agent = primaryAgent(snapshot)

          if (agent) {
            openAssistantCard({ kind: 'agent', principal: agent.principal })

            return
          }

          setSettingsPane('assistants')
          setSettingsOpen(true)
        }}
        onClosePins={() => setPinnedRoomId(null)}
        onCloseThreads={() => setThreadView(null)}
        onModelSettings={
          window.atumMatrix.pages &&
          room.agentPrincipal &&
          (() => {
            const agent = snapshot.agents?.find(each => each.principal === room.agentPrincipal)

            return !agent || matrixAgentNeedsLocalSetup(agent, cloudOnly)
          })()
            ? () => openAgentConnections(room.agentPrincipal!)
            : undefined
        }
        onOwnModel={openOwnModel}
        onPlanSignIn={openPlanSignIn}
        onPreview={revealDocument}
        onRestoreMessages={() => {
          setSettingsPane('privacy')
          setSettingsOpen(true)
        }}
        onReviewDevices={thisMac => {
          $matrixDeviceToShow.set(thisMac ? (snapshot.identity?.deviceId ?? null) : null)
          setSettingsPane('privacy')
          setSettingsOpen(true)
        }}
        onSent={() => setError(null)}
        onSubscriptions={() => {
          // Every connect affordance lands on the one account-scoped Connections page.
          setSettingsPane('connections')
          setSettingsOpen(true)
        }}
        onThreadViewChange={next => {
          if (workspaceOpen) {
            closeWorkspace()
          }

          setThreadView(next)
        }}
        pinsOpen={pinsOpen}
        settled={settled}
        snapshot={roomView}
        threadView={currentThreadView}
      />
    ) : matrixFirstRunPlace(snapshot) ? (
      <MatrixFirstRunPanel
        fail={fail}
        key={`${snapshot.identity?.userId ?? ''}:${snapshot.identity?.deviceId ?? ''}:panel`}
        name={matrixPrimaryAgentName(snapshot, shell.assistantName)}
        snapshot={snapshot}
      />
    ) : matrixLaunchNoticeKind(snapshot.readiness) === 'starting' ||
      matrixLaunchNoticeKind(snapshot.readiness) === 'blocked' ? (
      <MatrixLaunchNotice
        cloudOnly={cloudOnly}
        fail={fail}
        name={matrixPrimaryAgentName(snapshot, shell.assistantName)}
        onBackToAtum={switchDefaultToAtum}
        onOwnModel={openOwnModel}
        onPlanSignIn={openPlanSignIn}
        snapshot={snapshot}
        variant="panel"
      />
    ) : (
      <EmptyState className="m-auto p-8" description={copy.noRoomHelp} title={copy.noRoom} />
    ))

  return (
    <>
      {/* Settings and the launch are modal: the window behind them is inert, which also keeps
          focus out of it. */}
      <div
        className="contents"
        data-matrix-shell-layer
        inert={
          settingsOpen ||
          startupActive ||
          profileEditorOpen ||
          assistantCardOpen ||
          paletteVisible ||
          undefined
        }
      >
        {/* The first stop for the keyboard: straight to the message box (launch night). */}
        {room && !founderDraftShown && conversationShellVisible && !driveActive && !appDestination && (
          <a
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-1/2 focus:z-[300] focus:-translate-x-1/2 focus:rounded-(--atum-r-button) focus:bg-(--atum-ink) focus:px-3 focus:py-1.5 focus:text-(length:--atum-t-control) focus:text-(--atum-on-accent)"
            data-matrix-skip-link
            href="#matrix-composer"
            onClick={event => {
              event.preventDefault()
              focusMatrixComposer()
            }}
          >
            {chat.skipToComposer}
          </a>
        )}
        <AtumShellFrame
          compact={compact}
          main={() => (
            <section
              // On an app's ground the content card takes the kit theme of the ground's tone
              // (FlowAppLook: a dark ground gets the kit's dark glass and controls); the title band
              // keeps the window's own theme below.
              className={cn(
                'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
                conversationLook?.ground && (conversationLook.tone === 'dark' ? 'ak-dark' : 'ak-light')
              )}
              data-atum-chat
              data-atum-look={conversationLook?.ground ? 'pack' : undefined}
              data-atum-look-colors={conversationLook?.hasIdentityColors ? true : undefined}
              data-atum-look-tokens={conversationLook?.tokens ? true : undefined}
              data-atum-look-tone={conversationLook?.tone}
              inert={workspaceOverFrame || undefined}
              style={conversationLook?.style}
            >
              <AtumMainHeaderSurface
                actions={
                  <>
                    {/* The one place the window asks the person to act; nothing while nothing
                        needs them (agent-attention.ts). */}
                    {snapshot.identity && (
                      <MatrixAttentionIndicator
                        agentName={principal => {
                          const agent = snapshot.agents?.find(each => each.principal === principal)

                          return agent ? matrixRosterAgentName(agent, shell.assistantName) : shell.assistantName
                        }}
                        onOpen={openAttention}
                        snapshot={snapshot}
                      />
                    )}
                    {conversationShellVisible && !founderDraftShown && !driveActive && !appDestination && room && (
                      <ConversationHeaderActions
                        appearance={lookAppearance}
                        cloudOnly={cloudOnly}
                        currentLook={conversationLook?.selection ?? { v: 1, background: { kind: 'default' } }}
                        fail={fail}
                        key={`conversation:${room.id}`}
                        onLookPreview={look => setLookPreview({ roomId: room.id, look })}
                        onPins={isTeamSpaceRoom(room) ? togglePinnedMessages : undefined}
                        onPreview={revealDocument}
                        onThreads={
                          isTeamSpaceRoom(room)
                            ? () => (currentThreadView ? setThreadView(null) : openThreads())
                            : undefined
                        }
                        pinsOpen={pinsOpen}
                        search={
                          chatShown ? (
                            <MatrixChatSearch
                              key={`search:${room.id}`}
                              messages={snapshot.messages}
                              openRef={chatSearchOpen}
                              roomId={room.id}
                            />
                          ) : undefined
                        }
                        snapshot={roomView}
                        threadsOpen={Boolean(currentThreadView)}
                      />
                    )}
                    {!workspaceOpen && (
                      // The glyph that closes the panel opens it; a boxed plus read as "new chat".
                      <Tip label={conversationInfo ? personInfoCopy.showInfo : workbenchCopy.showPanel}>
                        <button
                          aria-expanded={false}
                          aria-label={conversationInfo ? personInfoCopy.showInfo : workbenchCopy.showPanel}
                          className="atum-icon-btn relative size-7"
                          data-matrix-side-panel-opens={conversationInfo ? 'info' : 'workbench'}
                          data-workspace-tab-count={workspaceTabCount}
                          onClick={openSidePanel}
                          ref={workspaceOpener}
                          type="button"
                        >
                          <LayoutSidebarRight aria-hidden className="size-[1.0625rem]" strokeWidth={1.6} />
                          {workspaceTabCount > 0 && (
                            <span
                              aria-hidden
                              className="absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-(--atum-ink) px-1 text-[0.5625rem] leading-none font-semibold text-(--atum-on-accent)"
                            >
                              {workspaceTabCount}
                            </span>
                          )}
                        </button>
                      </Tip>
                    )}
                  </>
                }
                className={conversationLook?.ground ? (lookAppearance === 'dark' ? 'ak-dark' : 'ak-light') : undefined}
                leadsRow={compact || !sidebarShowing || workplaceOnScreen}
                reserveOverlay={facts.overlayWidth > 0}
                windowControls={
                  <AtumWindowControlsSurface
                    onToggleSidebar={toggle}
                    reserveLights={!facts.isFullscreen && Boolean(facts.windowButtonPosition)}
                    showSidebarToggle={!workplaceOnScreen}
                    sidebarLabel={sidebarToggleLabel}
                  />
                }
              >
                {/* Gives way to an open search: the subtitle first, then the name; too narrow
                    for the face, the identity steps aside (chat-search.css). */}
                <div className="flex min-w-0 flex-1 items-center gap-2.5" data-matrix-header-identity>
                  {conversationShellVisible &&
                  !driveActive &&
                  !appDestination &&
                  ((room && isFounderRoom(snapshot, room.id)) || founderDraftShown) ? (
                    // The Founder chat: the raven, "Founder" with its mark, who they are.
                    <FounderHeaderIdentity />
                  ) : (
                    (() => {
                      const identity = (
                        <>
                          {teamSpaceChannelHeaded && !driveActive && !appDestination && room && (
                            // The launch's eclipse lands here when this is Atum's own chat.
                            <span
                              className="contents"
                              data-matrix-header-mark={
                                room.assistant && roomView.assistant?.userId === snapshot.assistant?.userId
                                  ? true
                                  : undefined
                              }
                            >
                              {notesSelfBound ? (
                                <Tip label={matrixTeamSpaceCopy(locale).personalNotes}>
                                  <span className="grid size-[22px] shrink-0 place-items-center">
                                    <OwnAvatar
                                      className="size-[22px] rounded-(--atum-r-avatar) text-xs"
                                      snapshot={snapshot}
                                    />
                                  </span>
                                </Tip>
                              ) : room.companyChannel ? (
                                // Slack's "# name": the mark in the name's ink, no tile.
                                <span
                                  aria-hidden
                                  className="-me-1.5 grid size-[22px] shrink-0 place-items-center text-(--atum-ink)"
                                  data-matrix-channel-glyph
                                >
                                  <ChannelGlyphFor
                                    accountKey={teamSpaceAccountKey(snapshot.identity)}
                                    className="size-3.5"
                                    room={room}
                                  />
                                </span>
                              ) : isCompanyPrivateCosClaim(room) ? (
                                // The company's Chief of Staff: its workspace row's face (an assistant: a circle).
                                <span
                                  aria-hidden
                                  className="grid size-[22px] shrink-0 place-items-center"
                                  data-matrix-private-cos-face
                                >
                                  <PrivateCosFaceFor
                                    accountKey={teamSpaceAccountKey(snapshot.identity)}
                                    className="size-[22px] text-[0.625rem] leading-none"
                                    room={room}
                                  />
                                </span>
                              ) : isCompanyConversationRoom(room) ? (
                                <span
                                  aria-hidden
                                  className="grid size-[22px] shrink-0 place-items-center text-(--atum-ink-muted)"
                                  data-matrix-conversation-glyph
                                >
                                  <ConversationFaceFor
                                    accountKey={teamSpaceAccountKey(snapshot.identity)}
                                    className="size-[22px] text-[0.625rem] leading-none"
                                    room={room}
                                  />
                                </span>
                              ) : roomBot ? (
                                <AppCatalogAvatar
                                  app={roomBot}
                                  className="size-[22px] shrink-0 rounded-lg text-xs"
                                  locale={locale}
                                />
                              ) : profileAgent ? (
                                <MatrixProfileAvatar
                                  avatarUrl={profileAgent.avatarUrl}
                                  brand={profileAgent.isDefault}
                                  className="size-[22px] shrink-0 rounded-lg text-xs"
                                  id={profileAgent.principal}
                                  mark={profileAgent.mark}
                                  name={matrixRosterAgentName(profileAgent, shell.assistantName)}
                                  profile={profileAgent.profile}
                                  scopeKey={`${snapshot.identity?.userId}/${snapshot.identity?.deviceId}`}
                                  target={{ kind: 'agent', principal: profileAgent.principal }}
                                />
                              ) : (
                                <AtumAssistantAvatar
                                  className="size-[22px] shrink-0 rounded-lg text-xs"
                                  id={room.agentPrincipal ?? room.id}
                                  name={room.name}
                                />
                              )}
                            </span>
                          )}
                          {/* Drive's lead is Finder's: ‹ › and the open folder's name (drive.tsx). */}
                          {driveActive && <MatrixDriveTitle />}
                          <span className={cn(
                            'truncate [font:var(--ak-t-headline)]',
                            teamSpaceChannelHeaded ? 'max-w-40 shrink-0' : 'max-w-full shrink-0'
                          )} hidden={driveActive}>
                            {driveActive ? null : workplaceOnScreen ? (
                              teamSpaceChannelHeaded && room ? (
                                notesSelfBound ? (
                                  matrixTeamSpaceCopy(locale).you
                                ) : isCompanyPrivateCosClaim(room) ? (
                                  <span data-matrix-private-cos-title>{matrixCompanyBoardCopy(locale).chiefOfStaff}</span>
                                ) : isCompanyConversationRoom(room) ? (
                                  <ConversationTitleFor
                                    accountKey={teamSpaceAccountKey(snapshot.identity)}
                                    fallback={matrixChatTitle(room, {
                                      locale,
                                      untitled: t.atum.roster.untitledChat,
                                      chatOn: chat.chatOn
                                    })}
                                    room={room}
                                  />
                                ) : room.companyChannel ? (
                                  <ChannelTitleFor
                                    accountKey={teamSpaceAccountKey(snapshot.identity)}
                                    fallback={matrixChatTitle(room, {
                                      locale,
                                      untitled: t.atum.roster.untitledChat,
                                      chatOn: chat.chatOn
                                    })}
                                    room={room}
                                  />
                                ) : (
                                  matrixChatTitle(room, {
                                    locale,
                                    untitled: t.atum.roster.untitledChat,
                                    chatOn: chat.chatOn
                                  })
                                )
                              ) : null
                            ) : appDestination ? (
                              selectedApp ? (
                                appLocalizedCopy(selectedApp.name, locale, selectedApp.app)
                              ) : snapshot.destination?.kind === 'discover' ? (
                                shell.discover
                              ) : null
                            ) : conversationShellVisible && room ? (
                              notesSelfBound ? (
                                matrixTeamSpaceCopy(locale).you
                              ) : roomBot ? (
                                roomBot.bot!.display_name
                              ) : room.assistant ? (
                                profileAgent ? (
                                  matrixRosterAgentName(profileAgent, shell.assistantName)
                                ) : (
                                  room.name
                                )
                              ) : (
                                matrixChatTitle(room, {
                                  locale,
                                  untitled: t.atum.roster.untitledChat,
                                  chatOn: chat.chatOn
                                })
                              )
                            ) : founderDraftShown ? (
                              founderCopy.name
                            ) : (
                              copy.title
                            )}
                          </span>
                          {profileAgent?.title && (
                            <span className="truncate text-[0.8125rem] text-(--atum-ink-faint)" data-matrix-agent-title>
                              {profileAgent.title}
                            </span>
                          )}
                          {room?.companyChannel && !driveActive && !appDestination && teamSpaceChannelHeaded && (
                            <ChannelHeaderMetaFor accountKey={teamSpaceAccountKey(snapshot.identity)} room={room} />
                          )}
                          {conversationShellVisible && room && !driveActive && !appDestination && (
                            <MatrixGroupHeaderTopic room={room} snapshot={snapshot} />
                          )}
                        </>
                      )

                      return roomBot && conversationShellVisible && !driveActive && !appDestination ? (
                        <button
                          aria-label={appCopy.menu + ' ' + roomBot.bot!.display_name}
                          className="atum-header-identity -ms-1.5 flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-0.5"
                          data-matrix-app-functions
                          onClick={() => openWorkspace()}
                          type="button"
                        >
                          {identity}
                        </button>
                      ) : profileAgent && conversationShellVisible && !driveActive && !appDestination ? (
                        <button
                          aria-label={assistantCardCopy.sheetLabel(
                            matrixRosterAgentName(profileAgent, shell.assistantName)
                          )}
                          className="atum-header-identity -ms-1.5 flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-0.5"
                          data-matrix-header-card
                          onClick={() => openAssistantCard({ kind: 'agent', principal: profileAgent.principal })}
                          type="button"
                        >
                          {identity}
                        </button>
                      ) : (
                        identity
                      )
                    })()
                  )}
                  {/* Execution destinations replace the redundant assistant-chat subtitle once
                      the authoritative policy is available; other assistant surfaces keep it. */}
                  {conversationShellVisible &&
                    !founderDraftShown &&
                    !driveActive &&
                    !appDestination &&
                    notesSelfBound && (
                      <Tip label={matrixTeamSpaceCopy(locale).personalNotes}>
                        <span
                          className="min-w-0 flex-1 truncate text-[0.8125rem] text-(--atum-ink-muted)"
                          data-matrix-notes-self-subtitle
                        >
                          {matrixTeamSpaceCopy(locale).personalNotes}
                        </span>
                      </Tip>
                    )}
                  {conversationShellVisible &&
                    !founderDraftShown &&
                    !driveActive &&
                    !appDestination &&
                    room?.assistant &&
                    !profileAgent?.executionPolicy && (
                      <span
                        className="min-w-0 flex-1 truncate text-[0.8125rem] text-(--atum-ink-muted)"
                        data-matrix-chat-subtitle
                      >
                        {matrixChatTitle(room, { locale, untitled: t.atum.roster.untitledChat, chatOn: chat.chatOn })}
                      </span>
                    )}
                </div>
              </AtumMainHeaderSurface>
              <div className="mx-auto w-full max-w-[700px] shrink-0 px-10 empty:hidden" data-matrix-status-stack>
                {/* A new sign-in elsewhere is the title bar's attention item (agent-attention.ts),
                    never a band here: a band pushes the page under it down. */}
                <ConversationRetryLine
                  onRetry={() => {
                    if (!snapshot.identity || !profileAgent) {
                      return
                    }

                    void window.atumMatrix
                      .command({
                        kind: 'agentConversation',
                        identity: snapshot.identity,
                        agentId: profileAgent.userId,
                        action: 'retry',
                        ...(profileAgent.conversation?.proposed ? { roomId: profileAgent.conversation.proposed } : {})
                      })
                      .catch(fail)
                  }}
                  view={
                    !founderDraftShown && !workplaceActive && !driveActive && !appDestination
                      ? profileAgent?.conversation
                      : undefined
                  }
                />
                <HermesPrompts
                  conversationVisible={
                    !founderDraftShown && conversationShellVisible && !driveActive && !appDestination && Boolean(room)
                  }
                  fail={fail}
                  snapshot={snapshot}
                />
                {/* A person's verification only: main's own checks of agents never reach the
                    window (background-verification.ts). */}
                <VerificationPrompt snapshot={snapshot} />
                {snapshot.deviceIsolation?.value === 'signed' && error === 'identity_review' && !settingsOpen && (
                  <MatrixPeerIdentityPanel
                    onResolved={() => setError(current => (current === 'identity_review' ? null : current))}
                    snapshot={snapshot}
                  />
                )}
                {/* The chat's offers belong to the chat, never to Drive (Atum Kit review E23). */}
                {!workplaceActive && !driveActive && !appDestination && (
                  <MatrixTerminalOffers
                    onOpened={(id, scope) => {
                      setTerminalRequest({ id, scope, serial: Date.now() })
                      openWorkspace()
                    }}
                    scope={matrixWorkbenchScope(snapshot)}
                    snapshot={snapshot}
                  />
                )}
                {!workplaceActive && !driveActive && !appDestination && (
                  <MatrixWebPreviewOfferCard
                    full={workspaceTabCount >= 32}
                    offer={snapshot.webPreview}
                    onOpened={value => {
                      setBrowserRequest(value)
                      openWorkspace()
                    }}
                    roomId={snapshot.roomId}
                    scope={matrixWorkbenchScope(snapshot)}
                  />
                )}
                {(error || (snapshot.error && snapshot.error !== 'matrix_disk_full')) && (
                  <NoticeBand role="status" tone="notice">
                    <span className="flex items-start gap-2" data-matrix-failure={error ?? undefined}>
                      <span className="min-w-0 flex-1">{notice}</span>
                      {error && !snapshot.error && failureRetry && (
                        <Button
                          className="-my-0.5 shrink-0"
                          data-matrix-failure-retry
                          onClick={() => {
                            setError(null)
                            failureRetry.run()
                          }}
                          size="sm"
                          type="button"
                          variant="text"
                        >
                          {chat.retry}
                        </Button>
                      )}
                      {error && !snapshot.error && (
                        <Tip label={chat.dismiss}>
                          <button
                            aria-label={chat.dismiss}
                            className="atum-icon-btn -my-0.5 size-6 shrink-0"
                            onClick={() => setError(null)}
                            type="button"
                          >
                            <X aria-hidden className="size-3.5" />
                          </button>
                        </Tip>
                      )}
                    </span>
                  </NoticeBand>
                )}
                {snapshot.agentCleanupRequired && <NoticeBand tone="notice">{copy.enrollmentOrphaned}</NoticeBand>}
                {/* The window's one device-health band: this Mac's own device repair/control
                    offers. Disk-full blocks the composer, so its notice lives with that box. */}
                <MatrixDeviceHealthNotice
                  snapshot={{
                    deviceDamaged: snapshot.deviceDamaged,
                    ownerDeviceRepair: snapshot.ownerDeviceRepair
                  }}
                />
                <MatrixApprovalSheet open={approvalSheet.open} snapshot={snapshot} />
                {setupCooldown && (
                  <NoticeBand role="status" tone="notice">
                    {setupCooldown.title} {setupCooldown.help}
                  </NoticeBand>
                )}
              </div>
              {!workplaceActive && !driveActive && snapshot.apps && (
                <MatrixApps
                  fail={fail}
                  obstructed={
                    drawerOpen ||
                    overlaid ||
                    anyAgentPrompts(snapshot) ||
                    isMatrixVerificationPending(snapshot.security?.verification)
                  }
                  snapshot={snapshot}
                  storeNavigation={storeNavigation}
                />
              )}
              {driveActive ? (
                <MatrixDrive
                  bridge={window.atumMatrix.drive}
                  destination={driveDestination}
                  onDestinationChange={setDriveDestination}
                  onPreview={row => {
                    setDrivePreviewRequest(current => ({
                      ...row,
                      scope: currentWorkbenchScope,
                      serial: (current?.serial ?? 0) + 1
                    }))
                    openWorkspace()
                  }}
                  onUseInConversation={
                    driveTaskScope
                      ? () => {
                          setDriveActive(false)
                          setWorkplaceActive(false)
                        }
                      : undefined
                  }
                  taskScope={driveTaskScope}
                />
              ) : workplaceActive ? (
                <MatrixWorkspace
                  channelContent={companyChannelContentAuthorized || notesSelfBound ? conversationContent : undefined}
                  cloudOnly={cloudOnly}
                  exitTo={
                    settingsTrip?.from === 'store'
                      ? 'store'
                      : settingsTrip && settingsTrip.from !== 'chat'
                        ? 'settings'
                        : 'chat'
                  }
                  initialHub={settingsTrip?.hub}
                  initialPage={workplacePage}
                  // Each page Settings opens is a fresh trip, even over one already open.
                  key={settingsTrip ? `settings:${settingsTrip.serial}` : 'workplace'}
                  obstructed={
                    drawerOpen ||
                    overlaid ||
                    anyAgentPrompts(snapshot) ||
                    isMatrixVerificationPending(snapshot.security?.verification) ||
                    workspaceOverFrame
                  }
                  onChannelVisibilityChange={setTeamSpaceTranscriptVisible}
                  onExit={
                    settingsTrip
                      ? () => {
                          setWorkplacePage(undefined)
                          setWorkplaceActive(false)
                          setSettingsTrip(undefined)

                          if (settingsTrip.from === 'store') {
                            // Back on the shelf the listing was on.
                            $matrixStoreShelfRequest.set('skills')
                          } else if (settingsTrip.from !== 'chat') {
                            setSettingsPane('advanced')
                            setSettingsOpen(true)
                          }
                        }
                      : workplaceOnRail
                        ? undefined
                        : () => {
                            setWorkplacePage(undefined)
                            setWorkplaceActive(false)
                          }
                  }
                  onMessageLinkFailure={kind => fail(new Error(kind === 'membership'
                    ? 'matrix_message_link_membership'
                    : 'matrix_message_link_unavailable'))}
                  onOpenConversation={target => {
                    setThreadView(
                      target.threadRootId
                        ? { roomId: target.roomId, filter: 'recent', rootId: target.threadRootId }
                        : null
                    )
                  }}
                  onOpenDrive={
                    driveAvailable
                      ? () => {
                          setWorkplacePage(undefined)
                          setWorkplaceActive(false)
                          setDriveActive(true)
                        }
                      : undefined
                  }
                  // Routines live on the assistant's own card, which has no page of its own to land on.
                  onOpenRoutines={
                    window.atumMatrix.routines
                      ? agentPrincipal => {
                          setWorkplacePage(undefined)
                          setWorkplaceActive(false)
                          openAssistantCard({ kind: 'agent', principal: agentPrincipal })
                        }
                      : undefined
                  }
                  onOpenStore={
                    snapshot.apps
                      ? () => {
                          setWorkplacePage(undefined)
                          setWorkplaceActive(false)
                          void runMatrixCommand({ kind: 'discoverApps' }).catch(fail)
                        }
                      : undefined
                  }
                  preferredAgentPrincipal={settingsTrip?.agentPrincipal ?? activeAgentPrincipal}
                  snapshot={snapshot}
                />
              ) : companyChannelBound ? (
                <EmptyState className="m-auto p-8" description={copy.noRoomHelp} title={copy.noRoom} />
              ) : (
                conversationContent
              )}
            </section>
          )}
          navigation={
            <>
              <AtumNavSwitchSurface
                ariaLabel={shell.navigation}
                destination={
                  driveActive
                    ? 'drive'
                    : workplaceOnScreen
                      ? 'workplace'
                      : // An open app is one of the store's: the rail keeps that place, not Home.
                        snapshot.destination?.kind === 'discover' ||
                          (snapshot.apps && snapshot.destination?.kind === 'app')
                        ? 'discover'
                        : 'chat'
                }
                disabledDiscoverLabel={
                  railSurfaceState('discover', surfaces) === 'coming_soon' ? shell.discoverUnavailable : undefined
                }
                discoverLabel={shell.discover}
                driveLabel={shell.drive}
                homeLabel={shell.home}
                onDestinationChange={(destination: AtumShellDestination) => {
                  setSettingsTrip(undefined)
                  setWorkplacePage(undefined)
                  setDriveActive(destination === 'drive')

                  if (destination === 'chat' && room && isTeamSpaceRoom(room)) {
                    homeEscapeRoomId.current = room.id
                  }

                  setWorkplaceActive(destination === 'workplace')

                  if (destination === 'discover' && snapshot.apps) {
                    void runMatrixCommand({ kind: 'discoverApps' }).catch(fail)
                  } else if (destination === 'chat') {
                    selectDefaultConversation()
                  }
                }}
                surfaceCopy={t.surfaces}
                surfaces={surfaces}
                tray
                workplaceAvailable={workplaceOnRail}
                workplaceBadge={workplaceBadge}
                workplaceLabel={shell.workplace}
              />
              <div className="atum-rail-foot" data-matrix-rail-foot>
                <MatrixUpdateFooter
                  onOpenUpdates={() => {
                    setSettingsPane('help')
                    setSettingsOpen(true)
                  }}
                />
                <MatrixRailAccount
                  balance={snapshot.wallet}
                  fail={fail}
                  onOpenChange={setAccountMenuOpen}
                  onOpenProtons={openProtons}
                  onOpenRecovery={() => {
                    setAccountMenuOpen(false)
                    setSettingsPane('privacy')
                    setSettingsOpen(true)
                  }}
                  onOpenSettings={() => {
                    setAccountMenuOpen(false)
                    setSettingsOpen(true)
                  }}
                  onTopUp={openTopUp}
                  open={accountMenuOpen}
                  phone={phone}
                  snapshot={snapshot}
                />
              </div>
            </>
          }
          onCloseRosterDrawer={() => setDrawerOpen(false)}
          roster={driveActive ? driveRoster : roster}
          rosterDrawerCloseLabel={copy.cancel}
          rosterDrawerLabel={storeOpen ? shell.discover : t.atum.roster.title}
          rosterDrawerOpen={drawerOpen && !workplaceOnScreen}
          sidebarShowing={sidebarShowing && !workplaceOnScreen}
          workspace={motion => (
            <>
              {infoShown && conversationInfo && room && (
                <MatrixPersonInfoPanel
                  compact={compact}
                  expanded={workspaceExpanded}
                  fail={fail}
                  hidden={false}
                  info={conversationInfo}
                  motion={motion}
                  onClose={closeWorkspace}
                  onExpand={setWorkspaceExpanded}
                  onPercentChange={setWorkspacePercent}
                  percent={workspacePercent}
                  room={room}
                  snapshot={snapshot}
                  windowControls={
                    compact || !sidebarShowing ? (
                      <AtumWindowControlsSurface
                        onToggleSidebar={toggle}
                        reserveLights={!facts.isFullscreen && Boolean(facts.windowButtonPosition)}
                        sidebarLabel={sidebarToggleLabel}
                      />
                    ) : null
                  }
                />
              )}
            <MatrixWorkbench
              appRouteRequest={appRouteRequest}
              browserRequest={browserRequest}
              compact={compact}
              documentRequest={documentRequest}
              driveRequest={drivePreviewRequest}
              expanded={workspaceExpanded}
              hidden={!workspaceOpen || infoShown}
              motion={motion}
              obstructed={drawerOpen || overlaid || anyAgentPrompts(snapshot)}
              onAppRouteRequestConsumed={serial =>
                setAppRouteRequest(current => (current?.serial === serial ? undefined : current))
              }
              onAskDrivePreview={
                driveTaskScope
                  ? request => {
                      selectMatrixDriveFile(request.id, request.name, 'read')

                      setDriveActive(false)
                      setWorkplaceActive(false)
                      setDrivePreviewRequest(undefined)
                      closeWorkspace()
                      requestAnimationFrame(() => focusMatrixComposer({ ifIdle: true }))
                    }
                  : undefined
              }
              onClose={closeWorkspace}
              onDriveRequestClose={() => setDrivePreviewRequest(undefined)}
              onExpand={setWorkspaceExpanded}
              onOpenDrive={
                driveAvailable
                  ? () => {
                      setSettingsTrip(undefined)
                      setWorkplacePage(undefined)
                      setWorkplaceActive(false)
                      setDriveActive(true)
                    }
                  : undefined
              }
              onPercentChange={setWorkspacePercent}
              onTabCountChange={reportWorkspaceTabs}
              percent={workspacePercent}
              snapshot={snapshot}
              terminalRequest={terminalRequest}
              windowControls={
                // Only the leftmost row carries the controls: while the roster is in the
                // row its own top row has them, and a second set would sit mid-band.
                compact || !sidebarShowing ? (
                  <AtumWindowControlsSurface
                    onToggleSidebar={toggle}
                    reserveLights={!facts.isFullscreen && Boolean(facts.windowButtonPosition)}
                    sidebarLabel={sidebarToggleLabel}
                  />
                ) : null
              }
            />
            </>
          )}
          workspaceInSplit={workspaceOpen && !workspaceOverFrame}
          workspaceOpen={workspaceOpen}
          workspaceOverFrame={workspaceOverFrame}
          workspacePercent={workspacePercent}
        />
      </div>
      <MatrixCommandPalette
        actions={paletteVisible ? paletteActions : []}
        onCloseAutoFocus={event => {
          event.preventDefault()

          if (!paletteOwnerLive.current) {
            return
          }

          const next = paletteFocusTarget.current
          paletteFocusTarget.current = null

          if (paletteFocusFrame.current !== null) {
            cancelAnimationFrame(paletteFocusFrame.current)
          }

          paletteFocusFrame.current = requestAnimationFrame(() => {
            if (next) {
              next()
            } else if (!paletteBlocked) {
              const back = paletteReturnFocus.current
              const visible = back?.isConnected && back !== document.body && !back.closest('[hidden], [inert]')
              const target = visible ? back : document.querySelector<HTMLElement>('[data-matrix-rail-account]')
              target?.focus()
            }
          })
        }}
        onOpenChange={setPaletteOpen}
        open={paletteVisible}
      />
      <MatrixSettingsSheet
        cloudOnly={cloudOnly}
        fail={fail}
        onClose={() => setSettingsOpen(false)}
        onEditProfile={
          window.atumMatrix.profiles
            ? () => {
                setSettingsOpen(false)
                setProfileEditor({ target: { kind: 'human' }, name: ownName })
              }
            : undefined
        }
        onOpenAdvancedPage={(page, agentPrincipal) => {
          setSettingsOpen(false)
          setDriveActive(false)
          setSettingsTrip(trip => ({ agentPrincipal, serial: (trip?.serial ?? 0) + 1 }))
          setWorkplacePage(page)
          setWorkplaceActive(true)
        }}
        onPaneChange={pane => {
          setSettingsPane(pane)

          if (pane === 'protons') {
            refreshWallet()
          }
        }}
        open={settingsOpen}
        pane={settingsPane}
        protons={
          snapshot.wallet
            ? {
                data: snapshot.wallet,
                history: walletHistory,
                // Atum's page about Protons sits beside the top-up only when the top-up is in the app.
                onAbout: matrixInAppTopUp(snapshot) ? () => void window.atumMatrix.openTopUp().catch(fail) : undefined,
                onLoadMore: walletHistory.loadMore,
                onTopUp: openTopUp
              }
            : undefined
        }
        snapshot={snapshot}
      />
      {profileEditor && snapshot.identity && (
        <MatrixProfileEditor
          name={profileEditor.name}
          onCloseAutoFocus={event => {
            event.preventDefault()
            // Account Settings is already hidden; return to a visible rail control.
            requestAnimationFrame(() => {
              document.querySelector<HTMLButtonElement>('[data-matrix-rail-account]')?.focus()
            })
          }}
          onOpenChange={open => {
            if (!open) {
              setProfileEditor(null)
            }
          }}
          open={profileEditorOpen}
          scopeKey={`${snapshot.identity.userId}:${snapshot.identity.deviceId}:${snapshot.petScope ?? ''}`}
          target={profileEditor.target}
        />
      )}
      <AssistantCardHost compact={compact} openChat={rosterOpen.current} snapshot={snapshot} />
      <MatrixMobileSetup onOpenChange={setMobileOpen} open={mobileOpen} snapshot={snapshot} />
    </>
  )
}

/** First launch: the assistant is set up automatically; this is the one click when it cannot
 * be. Launch night: one line of context first, then the action (Try again after a failure). */
function AssistantSetupCard({ state }: { state: MatrixSnapshot['assistantSetup'] }) {
  const shell = useI18n().t.matrixShell
  const chat = useChatCopy()
  const [pending, setPending] = useState(false)

  if (state === 'working' || pending) {
    return (
      <div className="mb-2 flex items-center gap-2 px-2 py-1.5 text-sm" role="status">
        <Loader size="sm" />
        <span>{shell.assistantSetupWorking}</span>
      </div>
    )
  }

  return (
    <div className="atum-glass-card mb-2 grid gap-2.5 p-3" data-matrix-setup-card>
      <p
        className={`text-(length:--atum-t-control) ${state === 'failed' ? 'text-(--atum-danger)' : 'text-(--atum-ink-soft)'}`}
      >
        {state === 'failed' ? shell.assistantSetupFailed : chat.setupLead}
      </p>
      <Button
        className="w-full"
        onClick={() => {
          setPending(true)
          void window.atumMatrix
            .setupAssistant()
            .catch(() => {})
            .finally(() => setPending(false))
        }}
      >
        {state === 'failed' ? chat.setupRetry : chat.setupNow}
      </Button>
    </div>
  )
}
