import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { Tip } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import { ArrowLeft, Bookmark, ChevronUpDown, Hash, Messages, PencilLine, Plus, SearchIcon } from '@/lib/icons'
import { AppViewOverlayHold } from '@/store/use-app-view-overlay'

import type { MatrixCompanyThread, MatrixRoom } from '../../shared/matrix'
import type {
  MatrixCompanyBridge,
  MatrixCompanyChannelItem,
  MatrixCompanyDirectory,
  MatrixCompanyDirectory11,
  MatrixCompanyErrorCode,
  MatrixCompanyInvitation11,
  MatrixCompanyLeave11,
  MatrixCompanyMember11,
  MatrixCompanyMutation,
  MatrixCompanyProjectReaderStatus,
  MatrixCompanyProjectSources,
  MatrixCompanyRemoval11,
  MatrixCompanySnapshot,
  MatrixCompanySnapshot11,
  MatrixCompanyValue
} from '../../shared/matrix-company'
import type { MatrixCompanyActivityItem } from '../../shared/matrix-company-activity'
import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'
import { matrixCompanyCopy } from '../../shared/matrix-company-copy'
import {
  isCompanyPrivateCosClaim,
  matrixCompanyPrivateCosSupportsV13
} from '../../shared/matrix-company-private-cos'
import type { MatrixCompanyMessageSearchResult } from '../../shared/matrix-company-search'
import {
  companyInvitationPolicy,
  companyPolicy3,
  type CompanyRole13,
  isDefinitiveCompanyRefusal,
  isTeamSpaceAction,
  type MatrixCompanyRefusalReason
} from '../../shared/matrix-company-team-space'
import { matrixDraftKey, type MatrixDraftRecord, type MatrixDraftsSnapshot } from '../../shared/matrix-drafts'
import { matrixCompanyNotesSelf, type MatrixNotesSelfSnapshot } from '../../shared/matrix-notes-self'
import { matrixProfileMxc } from '../../shared/matrix-profile'
import type { MatrixSavedMessagesSnapshot, MatrixSavedMessageView } from '../../shared/matrix-saved-messages'
import { matrixTeamSpaceCopy } from '../../shared/matrix-team-space-copy'

import { CompanyAIStatus } from './company-ai-status'
import { companyAIActivityStatusHidden } from './company-ai-thread-status'
import { CompanyBoard } from './company-board'
import { $companyChannelCompanyId, $companyChannelOrder, $companyOverviewRequest, companyRoomBadge } from './company-chrome'
import { companyDesktopAdapter, companyPrivateCosDesktopAdapter } from './company-desktop-adapter'
import { MatrixCompanyFundingPanel } from './company-funding'
import { CompanyMarketplace } from './company-marketplace'
import { $companyMarketplaces, effectiveCompanySpaceTab, refreshCompanyMarketplace } from './company-marketplace-store'
import { CompanyProjectBrief } from './company-project-brief'
import { MatrixCompanyProjectSourcesPanel } from './company-project-sources'
import {
  $companyAIStatuses,
  $companySpacePreferences,
  $companyWalletScope,
  companySpacePreferences,
  companySpaceScope,
  patchCompanySpacePreferences
} from './company-space-store'
import { CompanySpaceTabs } from './company-space-tabs'
import { CompanyWalletDrawer } from './company-wallet'
import { RosterBadge } from './roster-badge'
import { TeamSpaceSidebar, TeamSpaceSidebarRow, TeamSpaceSidebarSection } from './team-space-sidebar'
import { companyAbilities, memberAbilities, teamSpaceProfile } from './team-space/abilities'
import { authorizedCompanyActivity, type CompanyActivityRoomLabel, CompanyActivityView } from './team-space/activity'
import { ActivityButton } from './team-space/activity-button'
import { activityCopy } from './team-space/activity-copy'
import { $companyAdmin, clearCompanyAdmin, loadCompanyAdmin } from './team-space/admin-store'
import { type SendingStanding, sendVerdict } from './team-space/authorize'
import { $companyBoardLinkRequest, clearCompanyBoardLink } from './team-space/board-links'
import { type ChannelDialog, ChannelDialogs } from './team-space/channel-dialogs'
import { ChannelSections } from './team-space/channel-sections'
import {
  $companyChannels,
  channelAuthority,
  clearCompanyChannels,
  failCompanyChannels,
  loadCompanyChannels,
  markCompanyChannelsLoading
} from './team-space/channels-store'
import { runChannelCommand } from './team-space/commands'
import { useCompanyAvatarUrls } from './team-space/company-avatar'
import { CompanyAvatarSettings } from './team-space/company-avatar-settings'
import { companyBadge, companyUnread } from './team-space/company-badge'
import { CompanyCreateDialog, type CompanyCreationSetup } from './team-space/company-create-dialog'
import { CompanyMenu } from './team-space/company-menu'
import { CompanySearch } from './team-space/company-search'
import {
  companyActivity,
  companyAtSlot,
  companyInitials,
  initialCompany,
  orderCompanies,
  readLastChannelId,
  readLastCompanyId,
  steppedCompany,
  writeLastChannelId,
  writeLastCompanyId
} from './team-space/company-switcher'
import { authorizedCompanyThreads, companyThreadKey, CompanyThreadsView } from './team-space/company-threads'
import { companyThreadsCopy } from './team-space/company-threads-copy'
import { ConversationDialog, type ConversationDialogMode } from './team-space/conversation-dialog'
import { ConversationSections } from './team-space/conversation-sections'
import {
  $companyConversations,
  clearCompanyConversations,
  clearCompanySelfRefs,
  conversationAuthority,
  loadCompanyConversations,
  publishCompanySelfRef
} from './team-space/conversations-store'
import { companyDirectoryCache } from './team-space/directory-store'
import {
  $teamSpaceDiscovery,
  $teamSpaceInviteReadiness,
  loadTeamSpaceDiscovery,
  loadTeamSpaceInviteReadiness
} from './team-space/discovery-store'
import { authorizedCompanyDrafts, CompanyDraftsView } from './team-space/drafts'
import { draftsCopy } from './team-space/drafts-copy'
import { $teamSpaceIntent, type CompanyTarget, type TeamSpaceIntent } from './team-space/intents'
import {
  $companyInviteInbox,
  dismissCompanyInvitation,
  invalidateCompanyInviteInbox,
  issueCompanyInviteInboxTicket,
  publishCompanyInviteInbox,
  setCompanyInviteInboxAccount
} from './team-space/invite-inbox'
import { $matrixInviteJoinRequest, openMatrixInviteJoinPaste } from './team-space/invite-join'
import { InviteJoinDialog } from './team-space/invite-join-dialog'
import { replayedInviteLinkId } from './team-space/invite-links'
import { InviteSheet } from './team-space/invite-sheet'
import { teamSpaceKey } from './team-space/keys'
import { teamSpaceLayoutCopy } from './team-space/layout-copy'
import { type InvitationAction, type MemberAction, MembersPanel } from './team-space/members-panel'
import { companyErrorText, type MutationOutcome, outcomeText } from './team-space/outcome'
import { DirectAddPolicyControl, PolicyControl } from './team-space/policy-control'
import { PrivateCosAutoJoin } from './team-space/private-cos-invite'
import {
  $companyPrivateCos,
  $companyPrivateCosDiscovery,
  clearCompanyPrivateCos,
  companyPrivateCosRoom,
  companyPrivateCosRowStatus,
  ensureCompanyPrivateCos,
  loadCompanyPrivateCos,
  recheckCompanyPrivateCos
} from './team-space/private-cos-store'
import { SavedMessagesView } from './team-space/saved-messages'
import { savedMessagesCopy } from './team-space/saved-messages-copy'
import { teamSpaceSidebarEntryVisibility } from './team-space/sidebar-entry-visibility'
import { clearCompanyStanding, publishCompanyStanding } from './team-space/standing-store'
import { type CompanyChannelView, type CompanyConversationView, conversationTitle, type InvitationRow, isDefaultChannel, pendingInvitations, type RosterMember, rosterMembers, rosterName } from './team-space/views'

export interface MatrixCompanyWorkspaceProps {
  /** Native bridge for the authenticated Matrix authority projection. */
  bridge: MatrixCompanyBridge
  /** Account-scoped renderer cache key; no result may cross this boundary. */
  accountKey: string
  /** Separate, default-off company funding capability. */
  fundingEnabled?: boolean
  /** Separate, default-off T3b1 project source enrollment capability. */
  projectSourcesEnabled?: boolean
  /** Separate, default-off T3b2 hosted reader coverage capability. */
  projectReaderEnabled?: boolean
  /** The Project hub is hidden unless its own capability is on. */
  projectsEnabled?: boolean
  /** Company-wide exact message search in the company-menu settings sheet. */
  searchEnabled?: boolean
  /** Retained for fixture compatibility; default channels are platform-owned. */
  ensureDefaultChannels?: boolean
  /** Test-only compatibility for legacy behavior tests that inspect settings before a parent supplies channel content. */
  overviewFallback?: boolean
  /** The Matrix rooms, for each channel's unread and mention counts (display only). */
  rooms?: readonly MatrixRoom[]
  /** Bounded joined-room activity from the local Matrix SDK projection. */
  activity?: readonly MatrixCompanyActivityItem[]
  /** Bounded joined-room standard threads from the local Matrix SDK projection. */
  threads?: readonly MatrixCompanyThread[]
  /** Private account-data Saved list; its view spans every company in this account. */
  savedMessages?: MatrixSavedMessagesSnapshot
  /** Private account-data room/thread drafts; the current platform directory filters the view. */
  drafts?: MatrixDraftsSnapshot
  /** Matrix-native notes projection containing one independent lazy room per company. */
  notesSelf?: MatrixNotesSelfSnapshot
  /** The signed-in person's profile squircle, shared with the personal chat roster. */
  notesSelfAvatar?: ReactNode
  onOpenNotesSelf?(companyId: string): Promise<void>
  /**
   * Display-only name of the person who sent a cited message. The citation
   * projection carries only the event id; a board source should read as a
   * person, never a raw id, when this room has the event.
   */
  citationSenderName?(eventId: string): string | undefined
  /** Bounded convergence timings (tests shorten them). */
  convergenceDelayMs?: number
  convergenceAttempts?: number
  /** The selected company channel transcript. The company sidebar stays mounted beside it. */
  channelContent?: ReactNode
  /** Reports whether the bound transcript is actually painted and readable. */
  onChannelVisibilityChange?(visible: boolean): void
  /** Current Matrix room, used only to mark the active channel row. */
  activeRoomId?: string | null
  /** Authority-projected company binding for the active room; never inferred from its name. */
  preferredCompanyId?: string
  /**
   * Opens an authority-projected, ready room inside Team Space.
   * The owner verifies the current account's Matrix membership before acting.
   */
  onOpenChannel(roomId: string, isCurrent?: () => boolean): Promise<void>
  /** Uses the existing company-room invitation helper without selecting or navigating. */
  onAcceptPrivateCosInvite?(roomId: string, isCurrent?: () => boolean): Promise<void>
  /** Full-state verification failed after join: leave and hide the bound look-alike. */
  onRejectPrivateCosRoom?(roomId: string): Promise<void>
  /** Selects the still-joined room and reveals the exact activity event in its thread when present. */
  onOpenActivityItem?(item: MatrixCompanyActivityItem, isCurrent?: () => boolean): Promise<void>
  /** Selects the still-joined room and opens its standard thread. */
  onOpenCompanyThread?(thread: MatrixCompanyThread, isCurrent?: () => boolean): Promise<void>
  /** Writes the existing private follow preference for this still-authorized thread. */
  onFollowCompanyThread?(thread: MatrixCompanyThread, followed: boolean, isCurrent?: () => boolean): Promise<void>
  /** Writes the existing private read receipt for this still-authorized thread. */
  onReadCompanyThread?(thread: MatrixCompanyThread, isCurrent?: () => boolean): Promise<void>
  /** Native has reauthorized and selected the room; switch surfaces and reveal the exact event. */
  onOpenSearchResult?(result: MatrixCompanyMessageSearchResult): Promise<void>
  /** Native has revalidated and selected this still-saved Matrix event. */
  onOpenSavedMessage?(message: MatrixSavedMessageView & { available: true }): Promise<void>
  /** Selects a still-joined Team space room/thread holding this private draft. */
  onOpenCompanyDraft?(draft: MatrixDraftRecord, isCurrent?: () => boolean): Promise<void>
  /** Clears a draft whose current platform directory no longer admits its room. */
  onPurgeCompanyDraft?(draft: MatrixDraftRecord): Promise<void>
  /** Opens the already-authorized Team Space thread named by a board card. */
  onOpenThread?(roomId: string, threadRootEventId: string): void
}

type DirectoryValue = MatrixCompanyDirectory | MatrixCompanyDirectory11
type SnapshotValue = MatrixCompanySnapshot | MatrixCompanySnapshot11

type DirectoryCache = { accountKey: string; value: DirectoryValue }
type SnapshotCache = { accountKey: string; companyId: string; value: SnapshotValue }
type ProjectSourcesCache = { accountKey: string; companyId: string; projectId: string; value: MatrixCompanyProjectSources }
type ProjectReaderCache = { accountKey: string; companyId: string; projectId: string; value: MatrixCompanyProjectReaderStatus }
type Mutation = MatrixCompanyMutation

function isProjectSourceMutation(mutation: Mutation): mutation is Extract<Mutation, {
  action: 'include-project-channel-source' | 'include-project-file-source' | 'withdraw-project-source'
}> {
  return ['include-project-channel-source', 'include-project-file-source', 'withdraw-project-source'].includes(mutation.action)
}

/** Every way to bring someone into the company: by handle (1.1, 1.3), directory pick (1.10), email (1.9) or a direct add (1.12). */
function isInviteMutation(
  mutation: Mutation
): mutation is Extract<Mutation, { action: 'invitation-create' | 'invitation-create-directory' | 'email-invitation-create' | 'invite' | 'member-add' }> {
  return mutation.action === 'invite' || mutation.action === 'invitation-create' ||
    mutation.action === 'invitation-create-directory' || mutation.action === 'email-invitation-create' || mutation.action === 'member-add'
}

function requestId(): string {
  return globalThis.crypto.randomUUID()
}

/** A clicked channel is tried this many times at most (still bounded by `convergenceAttempts`). */
const CHANNEL_OPEN_ATTEMPTS = 4

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const resultError = companyErrorText
const COMPANY_INVITE_HANDLE = /^@?[a-z][a-z0-9_]{2,31}$/iu

function isDirectory(value: MatrixCompanyValue): value is DirectoryValue {
  return 'companies' in value
}

function isSnapshot(value: MatrixCompanyValue): value is SnapshotValue {
  return 'company' in value && 'members' in value
}

function isSnapshot11(value: SnapshotValue): value is MatrixCompanySnapshot11 {
  return value.schemaVersion === 2
}

function isChannelSnapshot(value: MatrixCompanyValue): value is MatrixCompanyChannelItem {
  return 'channel' in value
}

function isRemoval(value: MatrixCompanyValue): value is MatrixCompanyRemoval11 {
  return value.schemaVersion === 2 && 'memberRef' in value && 'state' in value
}

function isLeave(value: MatrixCompanyValue): value is MatrixCompanyLeave11 {
  return value.schemaVersion === 2 && 'retired' in value && 'state' in value
}

function isProjectSources(value: MatrixCompanyValue): value is MatrixCompanyProjectSources {
  return value.schemaVersion === 1 && 'eligibleChannels' in value && 'sources' in value && 'projectId' in value
}

function isProjectReader(value: MatrixCompanyValue): value is MatrixCompanyProjectReaderStatus {
  return value.schemaVersion === 2 && 'coverage' in value && 'sources' in value && 'projectId' in value
}

/** A full-screen scrim; it holds the app-view overlay token so a native app view never paints over the dialog. */
function ModalScrim({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation">
      <AppViewOverlayHold />
      {children}
    </div>
  )
}

/** The overview becomes a full-screen layer only over the empty workspace. */
function CompanyOverviewFrame({ children, overlay }: { children: ReactNode; overlay: boolean }) {
  return (
    <div className={overlay
      ? 'fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4'
      : 'grid w-full max-w-3xl gap-6 px-8 py-6'}>
      {overlay && <AppViewOverlayHold />}
      {children}
    </div>
  )
}

/**
 * A deliberately small C1 navigator. It only projects authority data returned
 * by the platform; selecting a company or project never grants access itself.
 */
export function MatrixCompanyWorkspace({ accountKey, activeRoomId, activity: syncedActivity = [], bridge, fundingEnabled = false, projectSourcesEnabled = false,
    projectReaderEnabled = false, projectsEnabled = false, rooms = [], searchEnabled = false,
    overviewFallback = false, channelContent, drafts = { records: [], writable: false }, notesSelf, notesSelfAvatar,
    onOpenNotesSelf, savedMessages = { records: [], writable: false }, citationSenderName,
    convergenceDelayMs = 1_500, convergenceAttempts = 8,
    onAcceptPrivateCosInvite, onChannelVisibilityChange, onFollowCompanyThread, onOpenActivityItem, onOpenChannel,
    onOpenCompanyDraft, onOpenCompanyThread,
    onOpenSavedMessage, onOpenSearchResult, onOpenThread, onPurgeCompanyDraft, onReadCompanyThread,
    onRejectPrivateCosRoom, preferredCompanyId,
    threads = [] }: MatrixCompanyWorkspaceProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyCopy(locale)
  const directoryCache = companyDirectoryCache
  const boardCopy = matrixCompanyBoardCopy(locale)
  const companyDesktopAvailable = Boolean(companyDesktopAdapter())
  const compact = useMediaQuery('(max-width: 650px)')
  const [compactPane, setCompactPane] = useState<'sidebar' | 'content'>('sidebar')
  const [activityOpen, setActivityOpen] = useState(false)
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [savedOpen, setSavedOpen] = useState(false)
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [overviewCompanyId, setOverviewCompanyId] = useState<string>()

  const [directory, setDirectory] = useState<DirectoryCache | undefined>(() => {
    const value = directoryCache.get(accountKey)

    return value ? { accountKey, value } : undefined
  })

  const [directoryLoading, setDirectoryLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState<MatrixCompanyErrorCode>()
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>()
  const [snapshot, setSnapshot] = useState<SnapshotCache>()
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotError, setSnapshotError] = useState<MatrixCompanyErrorCode>()
  const [projectName, setProjectName] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const [briefProjectId, setBriefProjectId] = useState<string>()
  const [projectChannelName, setProjectChannelName] = useState('')
  const [channelName, setChannelName] = useState('')
  const [sidebarQuery, setSidebarQuery] = useState('')
  const [channelComposerOpen, setChannelComposerOpen] = useState(false)
  const [companyMembersPanel, setCompanyMembersPanel] = useState(false)
  const [projectSources, setProjectSources] = useState<ProjectSourcesCache>()
  const [projectSourcesLoading, setProjectSourcesLoading] = useState(false)
  const [projectSourcesError, setProjectSourcesError] = useState<MatrixCompanyErrorCode>()
  const [projectReader, setProjectReader] = useState<ProjectReaderCache>()
  const [projectReaderLoading, setProjectReaderLoading] = useState(false)
  const [projectReaderError, setProjectReaderError] = useState<MatrixCompanyErrorCode>()
  const [activeMutation, setActiveMutation] = useState<Mutation>()
  const mutationPending = Boolean(activeMutation)
  const [pendingLoading, setPendingLoading] = useState(true)
  const [pendingError, setPendingError] = useState<MatrixCompanyErrorCode>()
  const [mutationError, setMutationError] = useState<MatrixCompanyErrorCode>()
  const [mutationReason, setMutationReason] = useState<MatrixCompanyRefusalReason>()
  const [leaveWalletRefusal, setLeaveWalletRefusal] = useState(false)
  const [retryMutation, setRetryMutation] = useState<Mutation>()
  const [fundingRefresh, setFundingRefresh] = useState(0)
  const [openingRoomId, setOpeningRoomId] = useState<string>()
  // A newer open supersedes an older one still retrying: the person's last click wins, never a stale retry.
  const openSequenceRef = useRef(0)
  const [channelOpenError, setChannelOpenError] = useState(false)
  // The channel this person last opened here, kept until something else is on screen: when Matrix holds it but the window
  // is not shown it (the platform has not confirmed the room yet), the pane says so instead of staying empty.
  const [openedChannel, setOpenedChannel] = useState<{ companyId: string; roomId: string }>()
  // The Add people sheet keeps its own query, picks and results (team-space/invite-sheet.tsx); it is keyed by company
  // and opening, so nothing typed or picked in one company is ever sent into another.
  const [inviteOpen, setInviteOpen] = useState(false)
  const [confirmMember, setConfirmMember] = useState<{ kind: 'remove' | 'leave'; memberRef: string; name: string }>()
  const [leavePending, setLeavePending] = useState(false)
  const [convergeNotice, setConvergeNotice] = useState(false)
  const [createCompanyOpen, setCreateCompanyOpen] = useState(false)
  const [walletOpen, setWalletOpen] = useState(false)
  // Which opening of the invite dialog this is: a link's one-time text belongs to one company in one opening.
  const [inviteInstance, setInviteInstance] = useState(0)
  // Links whose create was replayed (their text can no longer be shown), however the create was run.
  const [replayedLinkIds, setReplayedLinkIds] = useState<ReadonlySet<string>>(new Set())
  const [overviewSection, setOverviewSection] = useState<'members' | 'settings'>()
  const [pendingCompanySetup, setPendingCompanySetup] = useState<CompanyCreationSetup>()
  const [setupAvatarUploadError, setSetupAvatarUploadError] = useState(false)
  const [avatarUploadBusy, setAvatarUploadBusy] = useState(false)
  const [avatarSettlement, setAvatarSettlement] = useState<{ companyId: string; requestId: string; ok: boolean }>()
  // This window refused to send a change because the viewer's standing moved under an open control.
  // A change this window refused to send: 'changed' (the viewer's standing moved) or 'unknown' (an irreversible change
  // whose authority or target is not read yet).
  const [notAllowed, setNotAllowed] = useState<false | 'changed' | 'conversations' | 'unknown'>(false)
  const overviewRequest = useStore($companyOverviewRequest)
  const inviteJoinRequest = useStore($matrixInviteJoinRequest)
  const overviewRequestSeenRef = useRef(overviewRequest)

  const mounted = useRef(true)
  const accountKeyRef = useRef(accountKey)
  const scopeRef = useRef(0)
  const directoryAttemptRef = useRef(0)
  const companyAttemptRef = useRef(0)
  const selectedCompanyIdRef = useRef<string | undefined>(undefined)
  // Counts every change of the company on screen, so a flow that began under one can tell it has been left (and returned to).
  const selectionEpochRef = useRef(0)
  const selectedProjectIdRef = useRef<string | undefined>(undefined)
  const retryOriginRef = useRef<{ companyId: string | undefined; attempt: number } | undefined>(undefined)
  const projectSourcesAttemptRef = useRef(0)
  const projectReaderAttemptRef = useRef(0)
  const openChannelRef = useRef(onOpenChannel)
  const leaveRetryRef = useRef(0)
  const convergeCompanyRef = useRef<string | undefined>(undefined)
  const autoSelectedCompanyRef = useRef<string | undefined>(undefined)
  const followedPreferredCompanyRef = useRef<string | undefined>(undefined)
  const setupBusyRef = useRef(false)
  const compactRoomRef = useRef<string | null>(null)
  const overviewButtonRef = useRef<HTMLButtonElement>(null)
  const backToChannelsRef = useRef<HTMLButtonElement>(null)
  const quietRef = useRef(false)
  // Companies this person has just left: the directory read still lists them for a moment, and none may be reopened.
  // Every switcher input reads it (the rail, the menu, the shortcuts, the first pick), so it is also state: a leave redraws.
  const leftCompanyIdsRef = useRef<Set<string>>(new Set())
  const [leftVersion, setLeftVersion] = useState(0)
  const purgingDraftsRef = useRef<Set<string>>(new Set())

  const markCompanyLeft = useCallback((companyId: string) => {
    leftCompanyIdsRef.current.add(companyId)
    clearCompanyPrivateCos(accountKey, companyId)
    setLeftVersion(version => version + 1)
  }, [accountKey])
  // The viewer's standing as of the latest render, which every change is checked against as it is sent.
  const standingRef = useRef<SendingStanding | undefined>(undefined)
  const roomsRef = useRef(rooms)
  const companyInboxAuthorizationRef = useRef<{
    companyId?: string
    roomIds: ReadonlySet<string>
    threadKeys: ReadonlySet<string>
    draftKeys: ReadonlySet<string>
  }>({
    roomIds: new Set(),
    threadKeys: new Set(),
    draftKeys: new Set()
  })

  openChannelRef.current = onOpenChannel
  roomsRef.current = rooms

  // This is intentionally assigned while rendering: a promise that resolves
  // between render and the account-change effect must still fail closed.
  accountKeyRef.current = accountKey
  selectedProjectIdRef.current = selectedProjectId

  /** A fence for one flow: still true only while the company on screen is the one it began under. */
  const companyFence = () => {
    const companyId = selectedCompanyIdRef.current
    const epoch = selectionEpochRef.current

    return () => companyId !== undefined && selectedCompanyIdRef.current === companyId && selectionEpochRef.current === epoch
  }

  /** Activity and Threads share one live directory fence; a thread pins only its stable identity. */
  const companyInboxFence = (
    item: Pick<MatrixCompanyActivityItem, 'companyId' | 'roomId'>,
    threadKey?: string
  ) => {
    const sameCompany = companyFence()

    return () => {
      const authorization = companyInboxAuthorizationRef.current

      return sameCompany() && authorization.companyId === item.companyId &&
        authorization.roomIds.has(item.roomId) &&
        (threadKey === undefined || authorization.threadKeys.has(threadKey))
    }
  }

  const companyDraftFence = (draft: MatrixDraftRecord) => {
    const companyId = selectedCompanyIdRef.current
    const sameCompany = companyFence()
    const key = matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id })

    return () => {
      const authorization = companyInboxAuthorizationRef.current

      return companyId !== undefined && sameCompany() && authorization.companyId === companyId &&
        authorization.roomIds.has(draft.room_id) && authorization.draftKeys.has(key)
    }
  }

  // What the server says Team Space can do (C1: roles and ownership; C2: private channels). Until it
  // has answered, and on any server that predates it, this is the 1.1 workspace exactly.
  const teamCopy = matrixTeamSpaceCopy(locale)
  const layoutCopy = teamSpaceLayoutCopy(locale)
  const companyAvatarUrls = useCompanyAvatarUrls(bridge, rooms)
  const discovery = useStore($teamSpaceDiscovery)
  const inviteReadiness = useStore($teamSpaceInviteReadiness)
  // The invitations addressed to this person, shared with the rail's badge: "Not now" hides one in both.
  const inviteInbox = useStore($companyInviteInbox)
  const profile = teamSpaceProfile(discovery?.accountKey === accountKey ? discovery.discovery : { state: 'unknown' })
  const profileRef = useRef(profile)
  profileRef.current = profile
  const adminKey = selectedCompanyId ? teamSpaceKey(accountKey, selectedCompanyId) : ''
  const adminRecord = useStore($companyAdmin, { keys: [adminKey] })
  const adminSnapshot = profile.admin ? adminRecord[adminKey]?.snapshot : undefined
  const channelsRecord = useStore($companyChannels, { keys: [adminKey] })
  const channelsState = channelsRecord[adminKey]
  const conversationsRecord = useStore($companyConversations, { keys: [adminKey] })
  const privateCosRecord = useStore($companyPrivateCos, { keys: [adminKey] })
  const privateCosState = privateCosRecord[adminKey]
  const privateCosDiscovery = useStore($companyPrivateCosDiscovery, { keys: [adminKey] })[adminKey]
  const companyAIStatuses = useStore($companyAIStatuses)
  const sharedChief = selectedCompanyId ? companyAIStatuses[companySpaceScope(accountKey, selectedCompanyId)] : undefined

  // The private Chief of Staff row tells its real state (setting up, open, not available yet) once the
  // company has a Chief of Staff at all, not only after the platform has served a view.
  const privateCosStatus = privateCosState || (sharedChief?.enabled && privateCosDiscovery)
    ? companyPrivateCosRowStatus(privateCosState, privateCosDiscovery)
    : undefined

  // The Chief of Staff's lines that show nothing in the thread show nothing in Activity either, under the
  // thread's own scope: the company's CoS replying in one of its channels, or the bound private agent in
  // the private room. Anything carrying an answer stays.
  const activityPrivateCosRoom = companyPrivateCosRoom(privateCosState, rooms)

  const activityPrivateCos = activityPrivateCosRoom && privateCosState?.view.state === 'ready'
    ? { roomId: activityPrivateCosRoom.id, agentUserId: privateCosState.view.binding.agentUserId }
    : undefined

  const activityChannels = new Map(rooms.map(room => [room.id, room.companyChannel]))

  const activity = syncedActivity.filter(item => {
    const channel = activityChannels.get(item.roomId)

    const channelAgentUserId = channel?.companyId === item.companyId
      ? companyAIStatuses[companySpaceScope(accountKey, item.companyId)]?.agent.userId
      : undefined

    return !companyAIActivityStatusHidden(item, { channelAgentUserId, privateCos: activityPrivateCos })
  })
  // Company DMs and group DMs exist only where discovery says wire 1.5 is on; otherwise there is nothing to draw.
  const conversationsState = profile.conversations ? conversationsRecord[adminKey] : undefined
  const channelsLoading = channelsState?.loading ?? false
  const channelsError = channelsState?.error
  const channelsStale = channelsState?.stale === true
  const channelsUsable = channelAuthority(channelsState)
  // The directory as the platform admits this person; undefined until read, while it is failing, and
  // while it was read on another wire than discovery now selects. A 1.4 list is never drawn as the flat
  // 1.1 one (a private channel would read as a company-wide one); it waits for the read on the right wire.
  const expectedWire = profile.channels ? '1.4' : '1.1'

  const channelViews: readonly CompanyChannelView[] | undefined =
    channelsState && !channelsState.error && (channelsState.wire === expectedWire || (channelsState.stale === true && (!discovery || discovery.discovery.state === 'unknown'))) ? channelsState.channels : undefined

  const [transferTarget, setTransferTarget] = useState<{ memberRef: string; name: string }>()
  const [dialog, setDialog] = useState<ChannelDialog>()
  const [conversationDialog, setConversationDialog] = useState<ConversationDialogMode>()
  // A conversation was started but its room is not here yet; it opens by itself when it is.
  const [conversationNotice, setConversationNotice] = useState(false)

  const inScope = useCallback((scope: number) => mounted.current && scopeRef.current === scope && accountKeyRef.current === accountKey, [accountKey])

  const clearProjectSources = useCallback(() => {
    projectSourcesAttemptRef.current += 1
    setProjectSources(undefined)
    setProjectSourcesLoading(false)
    setProjectSourcesError(undefined)
  }, [])

  const clearProjectReader = useCallback(() => {
    projectReaderAttemptRef.current += 1
    setProjectReader(undefined)
    setProjectReaderLoading(false)
    setProjectReaderError(undefined)
  }, [])

  const clearProjectSelection = useCallback(() => {
    selectedProjectIdRef.current = undefined
    setSelectedProjectId(undefined)
    setProjectChannelName('')
    clearProjectSources()
    clearProjectReader()
  }, [clearProjectReader, clearProjectSources])

  const readCompany = useCallback(async (companyId: string, scope: number) => {
    const attempt = ++companyAttemptRef.current
    setSnapshot(undefined)
    setSnapshotLoading(true)
    setSnapshotError(undefined)

    try {
      const result = await bridge.request({ action: 'read', companyId })

      if (!inScope(scope) || companyAttemptRef.current !== attempt || selectedCompanyIdRef.current !== companyId) {return}

      if (!result.ok) {
        setSnapshot(undefined)
        setSnapshotError(result.error)

        if (result.error === 'denied' || result.error === 'missing') {clearProjectSelection()}

        return
      }

      if (!isSnapshot(result.value) || result.value.company.id !== companyId) {
        setSnapshot(undefined)
        setSnapshotError('invalid')
        clearProjectSelection()

        return
      }

      setSnapshot({ accountKey, companyId, value: result.value })
    } catch {
      if (inScope(scope) && companyAttemptRef.current === attempt && selectedCompanyIdRef.current === companyId) {
        setSnapshot(undefined)
        setSnapshotError('unavailable')
      }
    } finally {
      if (inScope(scope) && companyAttemptRef.current === attempt && selectedCompanyIdRef.current === companyId) {
        setSnapshotLoading(false)
      }
    }
  }, [accountKey, bridge, clearProjectSelection, directoryCache, inScope])

  const loadChannels = useCallback(async (companyId: string, scope: number) => {
    markCompanyChannelsLoading(accountKey, companyId)

    // The first discovery answer says which directory to read (1.4 admitted, or 1.1 company-wide).
    const discovered = await loadTeamSpaceDiscovery(bridge, accountKey)

    if (!inScope(scope) || selectedCompanyIdRef.current !== companyId) {return}

    await loadCompanyChannels(bridge, accountKey, companyId, teamSpaceProfile(discovered))
  }, [accountKey, bridge, inScope])

  const loadProjectSources = useCallback(async (companyId: string, projectId: string, scope: number) => {
    if (!projectSourcesEnabled) {clearProjectSources();

 return}

    const attempt = ++projectSourcesAttemptRef.current
    setProjectSources(undefined)
    setProjectSourcesLoading(true)
    setProjectSourcesError(undefined)

    try {
      const result = await bridge.request({ action: 'project-sources', companyId, projectId })

      if (!inScope(scope) || projectSourcesAttemptRef.current !== attempt ||
        selectedCompanyIdRef.current !== companyId || selectedProjectIdRef.current !== projectId) {return}

      if (!result.ok || !isProjectSources(result.value) || result.value.companyId !== companyId || result.value.projectId !== projectId) {
        setProjectSources(undefined)
        setProjectSourcesError(result.ok ? 'invalid' : result.error)

        return
      }

      setProjectSources({ accountKey, companyId, projectId, value: result.value })
    } catch {
      if (inScope(scope) && projectSourcesAttemptRef.current === attempt &&
        selectedCompanyIdRef.current === companyId && selectedProjectIdRef.current === projectId) {
        setProjectSources(undefined)
        setProjectSourcesError('unavailable')
      }
    } finally {
      if (inScope(scope) && projectSourcesAttemptRef.current === attempt &&
        selectedCompanyIdRef.current === companyId && selectedProjectIdRef.current === projectId) {
        setProjectSourcesLoading(false)
      }
    }
  }, [accountKey, bridge, clearProjectSources, inScope, projectSourcesEnabled])

  const loadProjectReader = useCallback(async (companyId: string, projectId: string, scope: number) => {
    if (!projectReaderEnabled) {clearProjectReader();

 return}

    const attempt = ++projectReaderAttemptRef.current
    setProjectReader(undefined)
    setProjectReaderLoading(true)
    setProjectReaderError(undefined)

    try {
      const result = await bridge.request({ action: 'project-reader', companyId, projectId })

      if (!inScope(scope) || projectReaderAttemptRef.current !== attempt ||
        selectedCompanyIdRef.current !== companyId || selectedProjectIdRef.current !== projectId) {return}

      if (!result.ok || !isProjectReader(result.value) || result.value.companyId !== companyId ||
        result.value.projectId !== projectId) {
        setProjectReader(undefined)
        setProjectReaderError(result.ok ? 'invalid' : result.error)

        if (!result.ok && (result.error === 'denied' || result.error === 'missing')) {
          clearProjectSelection()
          void readCompany(companyId, scope)
        }

        return
      }

      setProjectReader({ accountKey, companyId, projectId, value: result.value })
    } catch {
      if (inScope(scope) && projectReaderAttemptRef.current === attempt &&
        selectedCompanyIdRef.current === companyId && selectedProjectIdRef.current === projectId) {
        setProjectReader(undefined)
        setProjectReaderError('unavailable')
      }
    } finally {
      if (inScope(scope) && projectReaderAttemptRef.current === attempt &&
        selectedCompanyIdRef.current === companyId && selectedProjectIdRef.current === projectId) {
        setProjectReaderLoading(false)
      }
    }
  }, [accountKey, bridge, clearProjectReader, clearProjectSelection, inScope, projectReaderEnabled, readCompany])

  const loadDirectory = useCallback(async (scope: number) => {
    const attempt = ++directoryAttemptRef.current
    setDirectoryLoading(true)
    setDirectoryError(undefined)

    try {
      const inboxTicket = issueCompanyInviteInboxTicket()
      const result = await bridge.request({ action: 'list' })

      if (!inScope(scope) || directoryAttemptRef.current !== attempt) {return}

      if (!result.ok) {
        if (['authentication', 'denied', 'missing', 'invalid'].includes(result.error)) {directoryCache.delete(accountKey); setDirectory(undefined)}
        setDirectoryError(result.error)

        return
      }

      if (!isDirectory(result.value)) {
        directoryCache.delete(accountKey)
        setDirectory(undefined)
        setDirectoryError('invalid')

        return
      }

      directoryCache.set(accountKey, result.value)
      publishCompanyInviteInbox(accountKey, result.value, inboxTicket)
      setDirectory({ accountKey, value: result.value })
      const selected = selectedCompanyIdRef.current

      if (selected && convergeCompanyRef.current !== selected &&
        !result.value.companies.some(company => company.id === selected)) {
        selectedCompanyIdRef.current = undefined
        selectionEpochRef.current += 1
        setSelectedCompanyId(undefined)
        setSnapshot(undefined)
        setSnapshotError('missing')
        setSnapshotLoading(false)
        clearProjectSelection()
        failCompanyChannels(accountKey, selected, 'missing')
        clearCompanyConversations(accountKey, selected)
        clearCompanyPrivateCos(accountKey, selected)
        companyAttemptRef.current += 1
      }
    } catch {
      if (inScope(scope) && directoryAttemptRef.current === attempt) {
        setDirectoryError('unavailable')
      }
    } finally {
      if (inScope(scope) && directoryAttemptRef.current === attempt) {setDirectoryLoading(false)}
    }
  }, [accountKey, bridge, clearProjectSelection, directoryCache, inScope])

  const convergeToDefaultChannel = useCallback(async (companyId: string, preferredChannelId: string | null,
    scope: number) => {
    convergeCompanyRef.current = companyId
    setConvergeNotice(false)

    for (let attempt = 0; attempt < convergenceAttempts; attempt += 1) {
      // Another company on screen is not this one's default channel to open.
      if (!inScope(scope) || selectedCompanyIdRef.current !== companyId) { return }

      let roomId: string | undefined

      try {
        const discovered = await loadTeamSpaceDiscovery(bridge, accountKey)
        const state = await loadCompanyChannels(bridge, accountKey, companyId, teamSpaceProfile(discovered), { quiet: true })

        if (!inScope(scope) || selectedCompanyIdRef.current !== companyId) { return }

        if (!state.error) {
          const preferred = preferredChannelId
            ? state.channels.find(item => item.id === preferredChannelId)
            : undefined

          const seeded = state.channels.find(item => isDefaultChannel(item))
          const target = preferred ?? seeded

          if (target?.room.state === 'ready') { roomId = target.room.roomId }
        }
      } catch {
        // A bounded retry covers the manager still provisioning the room.
      }

      if (roomId) {
        try {
          await openChannelRef.current(roomId, () => selectedCompanyIdRef.current === companyId)
          convergeCompanyRef.current = undefined

          return
        } catch {
          // The platform room exists; the Matrix invitation may not be synced yet.
        }
      }

      if (attempt + 1 < convergenceAttempts) { await wait(convergenceDelayMs) }
    }

    convergeCompanyRef.current = undefined

    if (!inScope(scope)) { return }

    setConvergeNotice(true)
  }, [accountKey, bridge, convergenceAttempts, convergenceDelayMs, inScope])

  const replayLeave = useCallback(async (mutation: Extract<MatrixCompanyMutation, { action: 'leave' }>, scope: number,
    startAttempt = 0) => {
    const attemptId = ++leaveRetryRef.current
    markCompanyLeft(mutation.companyId)

    for (let attempt = startAttempt; attempt < convergenceAttempts; attempt += 1) {
      if (!inScope(scope) || leaveRetryRef.current !== attemptId) { return }

      let result: Awaited<ReturnType<typeof bridge.request>>

      try {
        result = await bridge.request(mutation)
      } catch {
        result = { ok: false, error: 'unavailable' }
      }

      if (!inScope(scope) || leaveRetryRef.current !== attemptId) { return }

      if (result.ok && isLeave(result.value)) {
        if (result.value.state === 'removed' || result.value.retired) {
          setLeavePending(false)
          setRetryMutation(undefined)
          setMutationError(undefined)
          retryOriginRef.current = undefined
          void loadDirectory(scope)

          return
        }
      } else if (!result.ok && ['invalid', 'denied', 'missing', 'conflict'].includes(result.error)) {
        // No longer a member (or a v1 server): stop quietly and let the directory speak.
        setLeavePending(false)
        setRetryMutation(undefined)
        void loadDirectory(scope)

        return
      }

      if (attempt + 1 < convergenceAttempts) { await wait(convergenceDelayMs) }
    }

    if (inScope(scope) && leaveRetryRef.current === attemptId) {
      setLeavePending(false)
      setRetryMutation(mutation)
      setMutationError('unavailable')
      retryOriginRef.current = { companyId: mutation.companyId, attempt: companyAttemptRef.current }
    }
  }, [bridge, convergenceAttempts, convergenceDelayMs, inScope, loadDirectory, markCompanyLeft])

  const loadPending = useCallback(async (scope: number) => {
    const origin = retryOriginRef.current ?? { companyId: selectedCompanyIdRef.current, attempt: companyAttemptRef.current }
    setPendingLoading(true)
    setPendingError(undefined)

    try {
      const result = await bridge.pending()

      if (!inScope(scope)) { return }

      if (!result.ok) {
        setPendingError(result.error)

        return
      }

      if (result.request?.action === 'leave') {
        // Leaving is kept until the ban is witnessed; replay quietly, bounded.
        setRetryMutation(undefined)
        setMutationError(undefined)
        retryOriginRef.current = undefined
        setLeavePending(true)
        void replayLeave(result.request, scope)
      } else if (result.request) {
        setRetryMutation(result.request)
        setMutationError('unavailable')
        retryOriginRef.current = origin
      } else {
        setRetryMutation(undefined)
        setMutationError(undefined)
        retryOriginRef.current = undefined
      }
    } catch {
      if (inScope(scope)) { setPendingError('unavailable') }
    } finally {
      if (inScope(scope)) { setPendingLoading(false) }
    }
  }, [bridge, inScope])

  useEffect(() => {
    mounted.current = true
    const scope = ++scopeRef.current
    selectedCompanyIdRef.current = undefined
    selectionEpochRef.current += 1
    setDirectory(directoryCache.has(accountKey) ? { accountKey, value: directoryCache.get(accountKey)! } : undefined)
    setDirectoryLoading(true)
    setDirectoryError(undefined)
    setSelectedCompanyId(undefined)
    setSnapshot(undefined)
    setSnapshotLoading(false)
    setSnapshotError(undefined)
    setMutationError(undefined)
    setRetryMutation(undefined)
    retryOriginRef.current = undefined
    setActiveMutation(undefined)
    setPendingLoading(true)
    setPendingError(undefined)
    setProjectName('')
    setBriefProjectId(undefined)
    clearProjectSelection()
    setChannelName('')
    setChannelComposerOpen(false)
    setCompanyMembersPanel(false)
    autoSelectedCompanyRef.current = undefined
    followedPreferredCompanyRef.current = undefined
    clearCompanyChannels(accountKey)
    clearCompanyConversations(accountKey)
    clearCompanyPrivateCos(accountKey)
    setConversationDialog(undefined)
    setConversationNotice(false)
    setFundingRefresh(0)
    setOpeningRoomId(undefined)
    setChannelOpenError(false)
    setOpenedChannel(undefined)
    setInviteOpen(false)
    setConfirmMember(undefined)
    setLeavePending(false)
    setConvergeNotice(false)
    leaveRetryRef.current += 1
    setTransferTarget(undefined)
    setDialog(undefined)
    setMutationReason(undefined)
    setCreateCompanyOpen(false)
    setWalletOpen(false)
    setReplayedLinkIds(new Set())
    setOverviewSection(undefined)
    setActivityOpen(false)
    setThreadsOpen(false)
    setSavedOpen(false)
    setDraftsOpen(false)
    purgingDraftsRef.current.clear()
    setPendingCompanySetup(undefined)
    setNotAllowed(false)
    leftCompanyIdsRef.current = new Set()
    setupBusyRef.current = false
    setCompanyInviteInboxAccount(accountKey)
    void loadTeamSpaceDiscovery(bridge, accountKey).then(() => loadTeamSpaceInviteReadiness(bridge, accountKey))
    void loadDirectory(scope)
    void loadPending(scope)

    return () => {
      mounted.current = false
      // Live authority ends here; durable navigation rows remain stale until revalidated.
      clearCompanyAdmin(accountKey)
      clearCompanyChannels(accountKey)
      clearCompanyConversations(accountKey)
      clearCompanyPrivateCos(accountKey)
      clearCompanySelfRefs(accountKey)
      clearCompanyStanding(accountKey)
    }
  }, [accountKey, bridge, clearProjectSelection, directoryCache, loadDirectory, loadPending])

  // Discovery can flip under a running window (an activation or a rollback): read the directory again
  // on the wire it now selects.
  const heldWire = channelsState?.wire

  useEffect(() => {
    if (selectedCompanyId && heldWire && heldWire !== expectedWire) {
      void loadChannels(selectedCompanyId, scopeRef.current)
    }
  }, [expectedWire, heldWire, loadChannels, selectedCompanyId])

  // Discovery can switch company DMs on or off under a running window: read them, or drop them, at once.
  useEffect(() => {
    if (selectedCompanyId) {
      void loadCompanyConversations(bridge, accountKey, selectedCompanyId, { conversations: profile.conversations })
    }
  }, [accountKey, bridge, profile.conversations, selectedCompanyId])

  // GET is non-creating; an ensure follows only for an uncreated pair. The served row exists only after
  // the platform serves one strict pair view. The same admission runs again when it could now succeed:
  // here on an account or company change, on focus below, and on the quiet refresh (with backoff).
  const localeRef = useRef(locale)
  localeRef.current = locale

  useEffect(() => {
    if (selectedCompanyId) {
      // The generation-fenced store owns both definitive cleanup and late-answer rejection.
      // A stale caller must never clear a newer membership incarnation here.
      void recheckCompanyPrivateCos(
        companyPrivateCosDesktopAdapter(),
        accountKey,
        selectedCompanyId,
        locale,
        { force: true }
      )
    }
  }, [accountKey, locale, selectedCompanyId])

  useEffect(() => {
    const again = () => {
      const companyId = selectedCompanyIdRef.current

      if (!companyId || (typeof document !== 'undefined' && document.hidden)) {return}

      void recheckCompanyPrivateCos(companyPrivateCosDesktopAdapter(), accountKey, companyId, localeRef.current,
        { force: true })
    }

    window.addEventListener('focus', again)
    window.addEventListener('online', again)

    return () => {
      window.removeEventListener('focus', again)
      window.removeEventListener('online', again)
    }
  }, [accountKey])

  // The administration snapshot (roles, owner, invitations, policy), once discovery says C1 is on.
  useEffect(() => {
    if (profile.admin && selectedCompanyId) {
      void loadCompanyAdmin(bridge, accountKey, selectedCompanyId)
    }
  }, [accountKey, bridge, profile.admin, selectedCompanyId])

  useEffect(() => {
    if (!projectSourcesEnabled) {clearProjectSources()}
  }, [clearProjectSources, projectSourcesEnabled])

  useEffect(() => {
    if (!projectReaderEnabled) {clearProjectReader()}
  }, [clearProjectReader, projectReaderEnabled])

  // Every dialog belongs to the company it was opened in: another company closes them all, so nothing a dialog
  // holds (an invite link's one-time text, a typed name, a half-made decision) is carried across.
  const closeCompanyDialogs = useCallback(() => {
    setInviteOpen(false)
    setConfirmMember(undefined)
    setTransferTarget(undefined)
    setDialog(undefined)
    setCompanyMembersPanel(false)
    setConversationDialog(undefined)
    setCreateCompanyOpen(false)
    setWalletOpen(false)
  }, [])

  const dialogCompanyRef = useRef(selectedCompanyId)

  // However the selection moved (a tile, a shortcut, a notification, a company that went away), the dialogs go.
  useEffect(() => {
    if (dialogCompanyRef.current !== selectedCompanyId) {
      dialogCompanyRef.current = selectedCompanyId
      closeCompanyDialogs()
    }
  }, [closeCompanyDialogs, selectedCompanyId])

  // The company on screen is the one to come back to on this device.
  useEffect(() => {
    if (selectedCompanyId) {
      writeLastCompanyId(accountKey, selectedCompanyId)
    }
  }, [accountKey, selectedCompanyId])

  const selectCompany = useCallback((companyId: string, openLastChannel = true) => {
    const scope = scopeRef.current
    closeCompanyDialogs()
    setNotAllowed(false)
    selectedCompanyIdRef.current = companyId
    selectionEpochRef.current += 1
    clearCompanyPrivateCos(accountKey)
    setSelectedCompanyId(companyId)
    setOverviewCompanyId(undefined)
    setSnapshot(undefined)
    setSnapshotError(undefined)
    setSnapshotLoading(true)
    clearProjectSelection()
    setBriefProjectId(undefined)
    setChannelName('')
    setChannelComposerOpen(false)
    companyAttemptRef.current += 1
    void readCompany(companyId, scope)
    void loadChannels(companyId, scope)

    if (openLastChannel) {
      void convergeToDefaultChannel(companyId, readLastChannelId(accountKey, companyId) ?? null, scope)
    }
  }, [accountKey, clearProjectSelection, closeCompanyDialogs, convergeToDefaultChannel, loadChannels, readCompany])

  const openJoinedCompany = async (companyId: string) => {
    selectCompany(companyId, false)
    await convergeToDefaultChannel(companyId, null, scopeRef.current)
  }

  const selectProject = (projectId: string) => {
    const companyId = selectedCompanyIdRef.current

    if (!companyId) {return}

    if (selectedProjectIdRef.current !== projectId) {setProjectChannelName('')}
    selectedProjectIdRef.current = projectId
    setSelectedProjectId(projectId)
    clearProjectSources()
    clearProjectReader()

    if (projectSourcesEnabled) {void loadProjectSources(companyId, projectId, scopeRef.current)}

    if (projectReaderEnabled) {void loadProjectReader(companyId, projectId, scopeRef.current)}
  }

  const refresh = () => {
    if (mutationPending) { return }
    setFundingRefresh(value => value + 1)
    void loadPending(scopeRef.current)
    void loadDirectory(scopeRef.current)
    const companyId = selectedCompanyIdRef.current
    const projectId = selectedProjectIdRef.current

    if (companyId && profileRef.current.admin) {void loadCompanyAdmin(bridge, accountKey, companyId)}

    if (companyId) {void readCompany(companyId, scopeRef.current)}

    if (companyId) {void loadChannels(companyId, scopeRef.current)}

    if (companyId) {void loadCompanyConversations(bridge, accountKey, companyId, profileRef.current)}

    if (companyId && projectId && projectSourcesEnabled) {
      void loadProjectSources(companyId, projectId, scopeRef.current)
    }

    if (companyId && projectId && projectReaderEnabled) {
      void loadProjectReader(companyId, projectId, scopeRef.current)
    }
  }

  // A quiet refresh: no spinners, no cleared screen. Manual "refresh" is gone
  // because convergence and this periodic/focus refresh keep the view honest.
  const quietRefresh = useCallback(async (scope: number) => {
    if (quietRef.current) {return}

    quietRef.current = true

    try {
      const attempt = directoryAttemptRef.current
      const inboxTicket = issueCompanyInviteInboxTicket()
      const listed = await bridge.request({ action: 'list' })

      if (!inScope(scope) || directoryAttemptRef.current !== attempt) {return}

      if (!listed.ok || !isDirectory(listed.value)) {
        const error = listed.ok ? 'invalid' : listed.error

        if (['authentication', 'denied', 'missing', 'invalid'].includes(error)) {directoryCache.delete(accountKey); setDirectory(undefined)}
        setDirectoryError(error)
        return
      }

      directoryCache.set(accountKey, listed.value)
      publishCompanyInviteInbox(accountKey, listed.value, inboxTicket)
      setDirectory({ accountKey, value: listed.value })
      setDirectoryError(undefined)
      // Discovery can change under a running window (an activation, a rollback): ask again, quietly.
      void loadTeamSpaceDiscovery(bridge, accountKey, { force: true })
      const companyId = selectedCompanyIdRef.current

      if (!companyId) {return}

      if (profileRef.current.admin) {void loadCompanyAdmin(bridge, accountKey, companyId, { quiet: true })}
      // The capability can switch on under a running window: admit again (backoff after a miss).
      void recheckCompanyPrivateCos(companyPrivateCosDesktopAdapter(), accountKey, companyId, localeRef.current)

      const [read] = await Promise.all([
        bridge.request({ action: 'read', companyId }),
        // The directory keeps its last good list through a failure here.
        loadCompanyChannels(bridge, accountKey, companyId, profileRef.current, { quiet: true }),
        loadCompanyConversations(bridge, accountKey, companyId, profileRef.current, { quiet: true })
      ])

      if (!inScope(scope) || selectedCompanyIdRef.current !== companyId) {return}

      if (read.ok && isSnapshot(read.value) && read.value.company.id === companyId) {
        setSnapshot({ accountKey, companyId, value: read.value })
        setSnapshotError(undefined)
      } else if (!read.ok && (read.error === 'denied' || read.error === 'missing')) {
        setSnapshot(undefined)
        setSnapshotError(read.error)
        clearProjectSelection()
      }

    } catch {
      if (inScope(scope)) {setDirectoryError('unavailable')}
      // Keep the last good projection visible, with the server failure marked.
    } finally {
      quietRef.current = false
    }
  }, [accountKey, bridge, clearProjectSelection, directoryCache, inScope])

  // What each Team Space change makes stale. The administration snapshot is the authority for roles,
  // owner and invitations; the directory carries the viewer's own role and any invitation addressed to them.
  const refreshAfterTeamSpace = useCallback((mutation: Mutation, scope: number) => {
    if (!('companyId' in mutation) || selectedCompanyIdRef.current !== mutation.companyId) {return}

    // Opening, widening or hiding a conversation changes the conversation directory only.
    if (mutation.action.startsWith('conversation-')) {
      void loadCompanyConversations(bridge, accountKey, mutation.companyId, profileRef.current, { quiet: true })

      return
    }

    // A channel command changes who is in which channel: look at the directory again, quietly.
    if (mutation.action === 'channel-command') {
      void loadCompanyChannels(bridge, accountKey, mutation.companyId, profileRef.current, { quiet: true })

      return
    }

    // Before C1 nothing beyond the 1.1 answer is read, so nothing else is stale.
    if (!profileRef.current.admin) {return}

    void loadCompanyAdmin(bridge, accountKey, mutation.companyId, { quiet: true })

    // The roster's names and the viewer's own role come from the 1.1 reads; look again without blanking the screen.
    if (!mutation.action.startsWith('invite-link')) {void quietRefresh(scope)}
  }, [accountKey, bridge, quietRefresh])

  const clearPendingCompanyLogo = (companyId: string) => {
    setPendingCompanySetup(current => current?.companyId === companyId ? { ...current, logo: undefined } : current)
  }

  /**
   * Runs one change through the single-slot pending journal. It returns what happened so a control
   * that shows its own refusal (`inline`) can; a definitive refusal is then not also drawn in the
   * workspace banner. An unclear outcome always reaches the banner, whose Retry replays the same request.
   */
  const runMutation = async (mutation: Mutation, options: { inline?: boolean } = {}): Promise<MutationOutcome | undefined> => {
    if (mutationPending || pendingLoading || pendingError) {return undefined}

    // A dialog opened under one standing can outlive it (a demotion, a hand-over, a policy change), and the control that
    // opened it sends on its old closure. So every change is checked against the standing held *now*, as it is sent. A
    // retry is exempt: it replays a request the platform may already hold, and must reach it to learn what happened.
    // A conversation request is the exception: its retry is checked too, because the 1.5 probe can go from on to off
    // between the lost answer and the Retry. It keeps its request id while the family is on; off, it is not sent.
    const conversationRequest = mutation.action.startsWith('conversation-')
    const verdict = (conversationRequest || mutation !== retryMutation) && standingRef.current ? sendVerdict(mutation, standingRef.current) : 'allowed'

    if (verdict === 'changed') {
      // A control that shows its own refusal says it there; one that does not leaves it in the banner.
      setNotAllowed(options.inline ? false : conversationRequest ? 'conversations' : 'changed')

      return { ok: false, error: 'denied', uncertain: false, notAllowed: conversationRequest ? 'conversations' as const : true as const }
    }

    // A change that cannot be taken back is not sent on a guess: the authority or the target is not read yet, so the
    // screen says it changed and asks for a refresh (the platform's own conflict wording), and nothing leaves the app.
    if (verdict === 'unknown') {
      setNotAllowed(options.inline ? false : 'unknown')

      return { ok: false, error: 'conflict', uncertain: false }
    }

    const scope = scopeRef.current
    const retryOrigin = mutation === retryMutation ? retryOriginRef.current : undefined
    const selectedAtStart = retryOrigin ? retryOrigin.companyId : selectedCompanyIdRef.current
    const selectionAttempt = retryOrigin ? retryOrigin.attempt : companyAttemptRef.current
    const projectSourceMutation = isProjectSourceMutation(mutation)
    const teamSpaceMutation = isTeamSpaceAction(mutation.action)
    setActiveMutation(mutation)
    setMutationError(undefined)
    setMutationReason(undefined)

    if (mutation.action === 'leave') {setLeaveWalletRefusal(false)}

    setNotAllowed(false)

    try {
      const result = await bridge.request(mutation)

      if (!inScope(scope)) {return undefined}

      // A change landed (an invitation answered, a company joined or left): a directory read issued before it is stale
      // and must not put back what it changed on the rail.
      if (result.ok) {invalidateCompanyInviteInbox(accountKey)}
      const selectionStillCurrent = selectedCompanyIdRef.current === selectedAtStart && companyAttemptRef.current === selectionAttempt

      if (!result.ok) {
        // The same classification main's journal uses (a typed add / email-invite 429 recorded nothing): both sides
        // release the request together, so nothing waits on a Retry and the next press is a new request.
        const definitive = isDefinitiveCompanyRefusal(mutation.action, result.error, result.reason)

        if (mutation.action === 'set-avatar' && definitive) {
          clearPendingCompanyLogo(mutation.companyId)
          setAvatarSettlement({ companyId: mutation.companyId, requestId: mutation.requestId, ok: false })
        }

        if (isInviteMutation(mutation)) {
          // The Add people sheet says what became of each person on their row.
        } else if (mutation.action === 'leave' && result.error === 'conflict') {
          // Leave refusals stay in the confirmation sheet. The 1.11 wallet refusal has its own
          // inline copy and must never also become the workspace's floating recovery banner.
          if (result.reason === 'company_wallet_not_empty') {
            setLeaveWalletRefusal(true)
          } else {
            setMutationError('conflict')
            setMutationReason(result.reason)
          }

          setLeavePending(false)
        } else if (!(options.inline && definitive)) {
          setMutationError(result.error)
          setMutationReason(result.reason)
        }

        setRetryMutation(definitive ? undefined : mutation)
        retryOriginRef.current = definitive ? undefined : { companyId: selectedAtStart, attempt: selectionAttempt }

        if (teamSpaceMutation) {
          // A refused administration or channel command concerns one person or channel, not the whole
          // company: keep the screen and look again, so a real loss of access shows in the directory.
          if (definitive) { void quietRefresh(scope) }
        } else if ((result.error === 'denied' || result.error === 'missing') && projectSourceMutation &&
          selectedCompanyIdRef.current === mutation.companyId) {
          clearProjectSelection()
          void readCompany(mutation.companyId, scope)
        } else if ((result.error === 'denied' || result.error === 'missing') && !isInviteMutation(mutation) &&
          'companyId' in mutation && selectedCompanyIdRef.current === mutation.companyId) {
          setSnapshot(undefined)
          setSnapshotError(result.error)
          clearProjectSelection()
          failCompanyChannels(accountKey, mutation.companyId, result.error)
          clearCompanyConversations(accountKey, mutation.companyId)
          companyAttemptRef.current += 1
        }

        if (result.error === 'conflict') {
          void loadPending(scope)

          if (projectSourceMutation && selectedCompanyIdRef.current === mutation.companyId &&
            selectedProjectIdRef.current === mutation.projectId) {
            void loadProjectSources(mutation.companyId, mutation.projectId, scope)

            if (projectReaderEnabled) {void loadProjectReader(mutation.companyId, mutation.projectId, scope)}
          }
        }

        return { ok: false, error: result.error, ...(result.reason ? { reason: result.reason } : {}), uncertain: !definitive }
      }

      setRetryMutation(undefined)
      retryOriginRef.current = undefined

      if (mutation.action === 'set-avatar') {
        clearPendingCompanyLogo(mutation.companyId)
        setAvatarSettlement({ companyId: mutation.companyId, requestId: mutation.requestId, ok: true })
      }

      if (mutation.action === 'funding') { setFundingRefresh(value => value + 1) }

      // A replayed link create (an earlier answer was lost) has no text to show, whichever control ran it: the dialog's
      // button or this banner's Retry. The link's row says so.
      if (mutation.action === 'invite-link-create') {
        const replayed = replayedInviteLinkId(result.value)

        if (replayed) {setReplayedLinkIds(previous => new Set(previous).add(replayed))}
      }

      if (mutation.action === 'remove-member' && isRemoval(result.value)) {
        const removal = result.value

        setConfirmMember(undefined)
        setSnapshot(previous => {
          if (!previous || !isSnapshot11(previous.value)) { return previous }

          return { ...previous, value: { ...previous.value, members: previous.value.members.map(member =>
            member.memberRef === removal.memberRef ? { ...member, state: removal.state } : member) } }
        })
        void readCompany(mutation.companyId, scope)
      }

      if (mutation.action === 'leave' && isLeave(result.value)) {
        setConfirmMember(undefined)
        markCompanyLeft(mutation.companyId)

        if (result.value.state === 'removed' || result.value.retired) {
          setLeavePending(false)
          selectedCompanyIdRef.current = undefined
          selectionEpochRef.current += 1
          setSelectedCompanyId(undefined)
          setSnapshot(undefined)
          clearCompanyChannels(accountKey, mutation.companyId)
          clearCompanyConversations(accountKey, mutation.companyId)
          companyAttemptRef.current += 1
        } else {
          setLeavePending(true)
          // Authority ended with `revoking`; the company leaves every list now.
          void loadDirectory(scope)
          void replayLeave(mutation, scope, 1)
        }
      }

      if (isChannelSnapshot(result.value) && selectionStillCurrent) {
        if (mutation.action === 'create-channel' && mutation.projectId) {
          if (selectedProjectIdRef.current === mutation.projectId) {setProjectChannelName('')}
        } else {
          setChannelName('')
          setChannelComposerOpen(false)
        }

        void loadChannels(result.value.channel.companyId, scope)
      }

      if (isProjectSources(result.value) && selectionStillCurrent && projectSourceMutation &&
        selectedProjectIdRef.current === mutation.projectId && result.value.companyId === mutation.companyId &&
        result.value.projectId === mutation.projectId) {
        setProjectSources({ accountKey, companyId: mutation.companyId, projectId: mutation.projectId,
          value: result.value })
        setProjectSourcesError(undefined)
        clearProjectReader()

        if (projectReaderEnabled) {void loadProjectReader(mutation.companyId, mutation.projectId, scope)}
      }

      if (isSnapshot(result.value) && selectionStillCurrent) {
        const companyId = result.value.company.id
        const isProjectResult = mutation.action === 'create-project'

        if (!isProjectResult || selectedCompanyIdRef.current === mutation.companyId) {
          selectedCompanyIdRef.current = companyId
          selectionEpochRef.current += 1

          // Coming back (an accepted invitation to a company once left) makes it switchable again.
          if (leftCompanyIdsRef.current.delete(companyId)) {setLeftVersion(version => version + 1)}

          setSelectedCompanyId(companyId)
          setSnapshot({ accountKey, companyId, value: result.value })
          setSnapshotError(undefined)

          if ((mutation.action === 'create' || mutation.action === 'accept') && isSnapshot11(result.value) &&
            result.value.defaultChannelId) {
            void convergeToDefaultChannel(companyId, result.value.defaultChannelId, scope)
          }
        }
      } else if (isDirectory(result.value)) {
        directoryCache.set(accountKey, result.value)
        // A change's answer is newer than any read issued before it landed (the invalidation above).
        publishCompanyInviteInbox(accountKey, result.value, issueCompanyInviteInboxTicket())
        setDirectory({ accountKey, value: result.value })
      }

      if (selectionStillCurrent) {
        setProjectName('')

        if (mutation.action !== 'create-channel' && !projectSourceMutation) {setChannelName('')}
      }

      // Who is in the company moves with the 1.1 invitation and removal too, not only with C1's own changes.
      if (teamSpaceMutation || ['invite', 'remove-member', 'leave', 'accept'].includes(mutation.action)) {
        refreshAfterTeamSpace(mutation, scope)
      }

      void loadDirectory(scope)

      return { ok: true, value: result.value }
    } catch {
      if (inScope(scope)) {
        setMutationError('unavailable')
        setRetryMutation(mutation)
        retryOriginRef.current = { companyId: selectedAtStart, attempt: selectionAttempt }
      }

      return { ok: false, error: 'unavailable', uncertain: true }
    } finally {
      if (inScope(scope)) {setActiveMutation(undefined)}
    }
  }

  /** Opens one room of the company on screen. Told after every await whether it is still that company (`still`). */
  const openRoom = async (roomId: string, fence: () => boolean = companyFence()) => {
    const scope = scopeRef.current
    const sequence = (openSequenceRef.current += 1)
    const still = () => fence() && openSequenceRef.current === sequence
    const companyId = selectedCompanyIdRef.current
    patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })
    setChannelOpenError(false)
    setOpenedChannel(undefined)
    setOpeningRoomId(roomId)

    try {
      // The directory can name a room before this Mac's sync holds it (or before the invitation arrives), so a
      // failed open is tried again a few times, bounded, as the default channel's convergence does. Each attempt
      // uses the opener of the latest render: the one this click started with still sees the rooms of that moment.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await openChannelRef.current(roomId, still)
          break
        } catch (error) {
          if (!inScope(scope) || !still() || attempt + 1 >= Math.min(convergenceAttempts, CHANNEL_OPEN_ATTEMPTS)) {throw error}
          await wait(convergenceDelayMs)
        }
      }

      if (inScope(scope) && still()) {
        if (companyId) {setOpenedChannel({ companyId, roomId })}

        if (compact) {setCompactPane('content')}
      }
    } catch {
      // The personal-chat owner rechecks membership. Keep this authority view
      // visible on failure and do not disclose transport or SDK details. A company left behind on the way
      // is not a failure: the room was simply not opened.
      // On a narrow window the reason is shown where the channel would have been, with the way back.
      if (inScope(scope) && still()) {
        setChannelOpenError(true)

        if (compact) {setCompactPane('content')}
      }
    } finally {
      if (inScope(scope) && openSequenceRef.current === sequence) {setOpeningRoomId(undefined)}
    }
  }

  const openChannel = async (item: CompanyChannelView) => {
    if (item.room.state !== 'ready') {return}

    setActivityOpen(false)
    setThreadsOpen(false)
    setSavedOpen(false)
    setDraftsOpen(false)
    await openRoom(item.room.roomId)
  }

  const visibleDirectory = directory?.accountKey === accountKey ? directory.value : undefined
  const visibleSnapshot = snapshot?.accountKey === accountKey && snapshot.companyId === selectedCompanyId ? snapshot.value : undefined
  // A company this person has just left is gone from every list at once, whatever the directory read still says.
  const listedCompanies = visibleDirectory?.companies.filter(company => !leftCompanyIdsRef.current.has(company.id))
  const selectedCompany = visibleDirectory?.companies.find(company => company.id === selectedCompanyId)
  const boardLinkRequest = useStore($companyBoardLinkRequest)
  const boardLinkSeenRef = useRef<number | undefined>(undefined)
  const companySpaceStates = useStore($companySpacePreferences)
  const activeCompanyScope = companySpaceScope(accountKey, selectedCompanyId ?? 'none')
  const companyMarketplaces = useStore($companyMarketplaces)

  const activeCompanyTab = effectiveCompanySpaceTab(
    (companySpaceStates[activeCompanyScope] ?? companySpacePreferences(activeCompanyScope)).tab,
    companyMarketplaces[activeCompanyScope]
  )

  // The company Store answers whether this company has a Marketplace page (a capability, not a flag).
  useEffect(() => {
    if (selectedCompanyId) {
      void refreshCompanyMarketplace(activeCompanyScope, selectedCompanyId)
    }
  }, [activeCompanyScope, selectedCompanyId])
  const roomsById = new Map(rooms.map(room => [room.id, room]))
  const selectedProject = visibleSnapshot?.projects.find(project => project.id === selectedProjectId)

  const visibleProjectSources = projectSources?.accountKey === accountKey &&
    projectSources.companyId === selectedCompanyId && projectSources.projectId === selectedProjectId
    ? projectSources.value : undefined

  const visibleProjectReader = projectReader?.accountKey === accountKey &&
    projectReader.companyId === selectedCompanyId && projectReader.projectId === selectedProjectId
    ? projectReader.value : undefined

  const projectChannels = selectedProject && channelViews
    ? channelViews.filter(item => item.projectId === selectedProject.id)
    : []

  const isAdmin = visibleSnapshot?.company.role === 'admin' && selectedCompany?.role === 'admin'
  const canCreateProject = isAdmin
  const canCreateChannel = isAdmin
  const canCreateCompany = visibleDirectory?.schemaVersion === 2 ? visibleDirectory.canCreate : true
  const snapshot11 = visibleSnapshot && isSnapshot11(visibleSnapshot) ? visibleSnapshot : undefined

  useEffect(() => {
    if (!boardLinkRequest || boardLinkSeenRef.current === boardLinkRequest.serial) {
      return
    }

    const company = visibleDirectory?.companies.find(item => item.id === boardLinkRequest.target.companyId)

    if (!company) {
      return
    }

    boardLinkSeenRef.current = boardLinkRequest.serial

    if (selectedCompanyIdRef.current !== company.id) {
      selectCompany(company.id, false)
    }

    patchCompanySpacePreferences(companySpaceScope(accountKey, company.id), {
      tab: 'board',
      selectedCardId: boardLinkRequest.target.cardId ?? null
    })
    clearCompanyBoardLink(boardLinkRequest)
  }, [accountKey, boardLinkRequest, selectCompany, visibleDirectory])

  // C1: who the viewer is in this company and what that allows. One resolver for every control; before
  // C1 (or without an answer from the server) it reproduces the 1.1 admin/member rules exactly.
  const viewerRole: CompanyRole13 | undefined =
    adminSnapshot?.company.role ?? (visibleSnapshot && selectedCompany ? (isAdmin ? 'admin' : 'member') : undefined)

  const abilities = companyAbilities(
    profile,
    viewerRole
      ? { role: viewerRole, policy: adminSnapshot?.company.policy.channelCreation ?? 'members',
          invitations: companyInvitationPolicy(adminSnapshot) }
      : undefined,
    inviteReadiness?.accountKey === accountKey && inviteReadiness.readiness.state === 'ready' ? inviteReadiness.readiness.value : undefined
  )

  // C2: the sidebar draws sections and private channels only when the directory it holds was read on 1.4.
  const channelsMode = channelsState?.wire === '1.4' && (profile.channels ||
    (channelsState.stale === true && (!discovery || discovery.discovery.state === 'unknown')))
  const policy = adminSnapshot?.company.policy.channelCreation ?? 'members'

  useEffect(() => {
    if (selectedCompanyId) {
      publishCompanyStanding(accountKey, selectedCompanyId, viewerRole ? { role: viewerRole, policy } : undefined)
    }
  }, [accountKey, policy, selectedCompanyId, viewerRole])

  const nowSeconds = Math.floor(Date.now() / 1000)
  const roster = snapshot11 ? rosterMembers(snapshot11, adminSnapshot, locale) : []
  const invitationRows = pendingInvitations(adminSnapshot, nowSeconds)
  const blocked = avatarUploadBusy || mutationPending || pendingLoading || Boolean(pendingError) || Boolean(retryMutation)
  const mutate = (mutation: Mutation) => runMutation(mutation, { inline: true })
  const runMutationRef = useRef(runMutation)
  runMutationRef.current = runMutation

  // Finish the optional creation data only after the new company's own authority and channel directory are on screen.
  // One mutation runs at a time through the same journal as every other Team Space change.
  useEffect(() => {
    const setup = pendingCompanySetup

    if (!setup || setup.companyId !== selectedCompanyId || !visibleSnapshot || blocked || setupBusyRef.current) {return}

    if (setup.inviteHandles.length > 0 && abilities.invite) {
      const [memberHandle, ...rest] = setup.inviteHandles
      setupBusyRef.current = true

      const invitation: Mutation = profile.admin
        ? { action: 'invitation-create', companyId: setup.companyId, requestId: requestId(), memberHandle: memberHandle!, role: 'member' }
        : { action: 'invite', companyId: setup.companyId, requestId: requestId(), memberHandle: memberHandle!, role: 'member' }

      void runMutationRef.current(invitation, { inline: true }).then(outcome => {
        setupBusyRef.current = false

        if (outcome && (outcome.ok || !outcome.uncertain)) {
          setPendingCompanySetup(current => current?.companyId === setup.companyId
            ? { ...current, inviteHandles: rest }
            : current)
        }
      }, () => { setupBusyRef.current = false })

      return
    }

    if (setup.description) {
      const general = channelViews?.find(channel => isDefaultChannel(channel))

      if (!profile.channels) {
        // A 1.1 server has no channel metadata mutation; the precise platform gap is surfaced in the handoff.
        setPendingCompanySetup(current => current?.companyId === setup.companyId
          ? { ...current, description: undefined }
          : current)

        return
      }

      if (!general || general.wire !== '1.4' || !general.actions?.includes('update_metadata')) {return}
      setupBusyRef.current = true
      void runChannelCommand(bridge, mutation => runMutationRef.current(mutation, { inline: true }), {
        companyId: setup.companyId,
        channelId: general.id
      }, generations => ({
        requestId: requestId(),
        operation: 'update_metadata',
        expectedChannelGeneration: generations.channel,
        topic: setup.description
      })).then(outcome => {
        setupBusyRef.current = false

        if (outcome && (outcome.ok || !outcome.uncertain)) {
          setPendingCompanySetup(current => current?.companyId === setup.companyId
            ? { ...current, description: undefined }
            : current)
        }
      }, () => { setupBusyRef.current = false })

      return
    }

    if (setup.logo) {
      if (setupAvatarUploadError || !bridge.uploadAvatar) {return}
      setupBusyRef.current = true
      setAvatarUploadBusy(true)

      void bridge.uploadAvatar(setup.logo).then(uploaded => {
        const avatarUri = matrixProfileMxc(uploaded)

        if (!avatarUri) {throw new Error('matrix_company_avatar_unavailable')}
        setSetupAvatarUploadError(false)

        return runMutationRef.current({
          action: 'set-avatar', companyId: setup.companyId, requestId: requestId(), avatarUri
        }, { inline: true })
      }).then(() => {
        setupBusyRef.current = false
        setAvatarUploadBusy(false)
      }, () => {
        setupBusyRef.current = false
        setAvatarUploadBusy(false)
        setSetupAvatarUploadError(true)
      })

      return
    }

    setPendingCompanySetup(undefined)
  }, [abilities.invite, blocked, bridge, channelViews, pendingCompanySetup, profile.admin, profile.channels,
    selectedCompanyId, setupAvatarUploadError, visibleSnapshot])

  standingRef.current = {
    companyId: selectedCompanyId,
    profile,
    viewerRole,
    abilities,
    roster,
    invitations: invitationRows,
    channels: channelsUsable ? channelViews : undefined,
    discovered: discovery?.accountKey === accountKey && discovery.discovery.state !== 'unknown',
    conversationsUsable: conversationsState === undefined ? undefined : conversationAuthority(conversationsState)
  }

  const activeMembers = roster.filter(row => row.state === 'active').length
  const selfRow = roster.find(row => row.self)
  const selfRefOfRoster = selfRow?.memberRef

  // The open conversation's header names a DM for the other person, so it needs to know who "me" is here.
  useEffect(() => {
    if (selectedCompanyId) {
      publishCompanySelfRef(accountKey, selectedCompanyId, selfRefOfRoster)
    }
  }, [accountKey, selectedCompanyId, selfRefOfRoster])

  const canLeaveCompany = selfRow ? memberAbilities(profile, viewerRole, selfRow, activeMembers).leave : false

  // Dialogs that were opened under a standing which has since moved say so and stop offering the action: the person
  // reads why, and Cancel works. (The send itself is checked again as it leaves: see `runMutation`.) A standing that is
  // not known (nothing read yet, or a read that failed) blocks nothing: the platform is decisive, not a gap in the screen.
  const transferBlocked = Boolean(transferTarget && viewerRole) && !abilities.transferOwnership

  const confirmBlocked = (() => {
    const target = confirmMember ? roster.find(row => row.memberRef === confirmMember.memberRef) : undefined

    if (!confirmMember || !target || !viewerRole) {return false}

    const can = memberAbilities(profile, viewerRole, target, activeMembers)

    return confirmMember.kind === 'leave' ? !can.leave : !can.remove
  })()

  const inviteBlocked = Boolean(viewerRole) && !abilities.invite

  // A person who left or was removed while a dialog was about them leaves nothing to confirm: it closes.
  const confirmSubjectGone = Boolean(confirmMember) && roster.length > 0 && !roster.some(row => row.memberRef === confirmMember!.memberRef)

  const transferSubjectGone =
    Boolean(transferTarget) && roster.length > 0 &&
    !roster.some(row => row.memberRef === transferTarget!.memberRef && row.state === 'active')

  useEffect(() => {
    if (confirmSubjectGone) {
      setConfirmMember(undefined)
      setLeaveWalletRefusal(false)
    }

    if (transferSubjectGone) {setTransferTarget(undefined)}
  }, [confirmSubjectGone, transferSubjectGone])

  const openInvite = () => {
    setInviteInstance(count => count + 1)
    setInviteOpen(true)
    // Which invite methods the server takes now (email, directory, link): asked again each time the sheet opens.
    void loadTeamSpaceInviteReadiness(bridge, accountKey, { force: true })
  }

  const openOverview = (section?: 'members' | 'settings') => {
    setActivityOpen(false)
    setThreadsOpen(false)
    setSavedOpen(false)
    setDraftsOpen(false)
    setOverviewCompanyId(selectedCompanyId)
    setOverviewSection(section)
    // Overview and settings live on the Chat page. Without moving the active
    // company page first, these menu actions updated hidden state while Board
    // (or Marketplace) stayed painted, which looked exactly like a dead menu.
    patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })

    if (compact) {setCompactPane('content')}
  }

  const onMemberAction = (action: MemberAction, member: RosterMember) => {
    if (!visibleSnapshot || blocked) {return}

    const companyId = visibleSnapshot.company.id
    const name = rosterName(member, copy.someone)

    switch (action) {
      case 'leave':
      case 'remove':
        setConfirmMember({ kind: action, memberRef: member.memberRef, name })

        return

      case 'cancel-invited':
        void runMutation({ action: 'remove-member', companyId, requestId: requestId(), memberRef: member.memberRef })

        return

      case 'make-owner':
        setTransferTarget({ memberRef: member.memberRef, name })

        return

      case 'make-admin':
      case 'make-member':
        if (adminSnapshot) {
          void runMutation({ action: 'role-change', companyId, requestId: requestId(), memberRef: member.memberRef,
            role: action === 'make-admin' ? 'admin' : 'member',
            expectedAuthorityGeneration: adminSnapshot.company.authorityGeneration })
        }
    }
  }

  const onInvitationAction = (action: InvitationAction, invitation: InvitationRow) => {
    if (!visibleSnapshot || blocked) {return}

    void runMutation({ action: action === 'resend' ? 'invitation-resend' : 'invitation-cancel',
      companyId: visibleSnapshot.company.id, invitationId: invitation.id, requestId: requestId() })
  }

  const transferOwnership = async () => {
    if (!visibleSnapshot || !adminSnapshot || !transferTarget) {return}

    const outcome = await mutate({ action: 'ownership-transfer', companyId: visibleSnapshot.company.id,
      requestId: requestId(), targetMemberRef: transferTarget.memberRef,
      expectedAuthorityGeneration: adminSnapshot.company.authorityGeneration })

    // An unclear outcome stays in the workspace's retry; a refusal is said here, in the dialog.
    if (outcome && !outcome.ok && !outcome.uncertain) {throw new Error(outcomeText(outcome, teamCopy, copy))}
  }

  // ----- C2: channels. Dialogs live in ChannelDialogs; everything that sends comes through `mutate`
  // (or runMutation), so the pending journal, Retry and error wording are the workspace's, once.

  const openChannelById = (channelId: string) => {
    const view = channelViews?.find(item => item.id === channelId)

    if (view) {
      setOverviewCompanyId(undefined)
      void openChannel(view)
    }
  }

  const afterChannelChange = () => {
    // A dialog can finish after the workspace has gone; what it read must not outlive it.
    if (mounted.current && accountKeyRef.current === accountKey && selectedCompanyIdRef.current) {
      void loadCompanyChannels(bridge, accountKey, selectedCompanyIdRef.current, profileRef.current, { quiet: true })
    }
  }

  const channelCreated = (channelId: string) => {
    if (visibleSnapshot) {void convergeToDefaultChannel(visibleSnapshot.company.id, channelId, scopeRef.current)}
  }

  const channelLeft = (channelId: string) => {
    const view = channelViews?.find(item => item.id === channelId)

    // Leaving the channel on screen moves to the default one rather than leaving a channel that is gone.
    if (view?.room.state === 'ready' && view.room.roomId === activeRoomId && visibleSnapshot) {
      void convergeToDefaultChannel(visibleSnapshot.company.id, null, scopeRef.current)
    }
  }

  // ----- C3: company DMs and group DMs (wire 1.5). Same rule as channels: everything that sends comes through
  // `mutate` / `runMutation`, so the pending journal, Retry and error wording are the workspace's, once.

  const conversationViews: readonly CompanyConversationView[] | undefined =
    conversationsState && !conversationsState.error ? conversationsState.conversations : undefined

  const selfMemberRef = roster.find(row => row.self)?.memberRef

  const conversationPeople = roster
    .filter(row => row.state === 'active' && !row.self)
    .map(row => ({ memberRef: row.memberRef, name: rosterName(row, copy.someone), handle: row.handle }))

  const showConversationAgain = async (companyId: string, conversationId: string) =>
    runMutation({ action: 'conversation-hidden', companyId, conversationId, requestId: requestId(), hidden: false })

  // The directory can authorize only while it is a good read of the platform's answer: not refused, not left over
  // from before a failed read.
  const conversationsUsable = conversationAuthority(conversationsState)

  // Opening a conversation brings it back if it was hidden, as Mattermost's does; the room opens either way, unless the
  // person has moved to another company in the meantime.
  const openConversation = async (view: CompanyConversationView) => {
    if (view.room.state !== 'ready') {return}

    const still = companyFence()
    setActivityOpen(false)
    setThreadsOpen(false)
    setSavedOpen(false)
    setDraftsOpen(false)
    setOverviewCompanyId(undefined)

    if (view.hidden && !blocked && conversationsUsable) {await showConversationAgain(view.companyId, view.id)}

    if (!still()) {return}

    await openRoom(view.room.roomId, still)
  }

  const openPrivateCos = async () => {
    const companyId = selectedCompanyIdRef.current
    const adapter = companyPrivateCosDesktopAdapter()

    if (!companyId || !adapter || !privateCosState) {
      throw new Error('matrix_company_private_cos_unavailable')
    }

    const still = companyFence()
    const next = await ensureCompanyPrivateCos(
      adapter,
      accountKey,
      companyId,
      'dm_open',
      matrixCompanyPrivateCosSupportsV13(privateCosState.capability) ? locale : undefined
    )

    if (!still()) {
      return
    }

    const target = companyPrivateCosRoom(next, roomsRef.current)

    // Preparing is an honest bounded row state, never a fake chat. A ready view whose Matrix room
    // is not synced/classified yet stays closed and offers Retry inline.
    if (next.view.state !== 'ready') {
      return
    }
    if (!target) {
      throw new Error('matrix_company_private_cos_room_unavailable')
    }

    setActivityOpen(false)
    setThreadsOpen(false)
    setSavedOpen(false)
    setDraftsOpen(false)
    setOverviewCompanyId(undefined)
    patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })
    await onOpenChannel(target.id, still)

    if (still() && compact) {
      setCompactPane('content')
    }
  }

  // Retry on a Chief of Staff row that is not available yet: the same admission, now.
  const retryPrivateCos = async () => {
    const companyId = selectedCompanyIdRef.current

    if (!companyId) {return}

    await recheckCompanyPrivateCos(companyPrivateCosDesktopAdapter(), accountKey, companyId, locale, { force: true })
  }

  const acceptPrivateCosInvitation = async (roomId: string) => {
    const companyId = selectedCompanyIdRef.current

    if (!companyId || !onAcceptPrivateCosInvite) {
      throw new Error('matrix_company_private_cos_unavailable')
    }

    const still = companyFence()
    await onAcceptPrivateCosInvite(roomId, still)
  }

  const verifyPrivateCosRoom = async () => {
    const companyId = selectedCompanyIdRef.current
    const adapter = companyPrivateCosDesktopAdapter()

    if (!companyId || !adapter) {
      throw new Error('matrix_company_private_cos_unavailable')
    }

    const still = companyFence()
    const capability = privateCosState?.capability ?? await adapter.readPrivateCosCapability(companyId)

    for (let attempt = 0; attempt < convergenceAttempts && still(); attempt += 1) {
      const next = await loadCompanyPrivateCos(adapter, accountKey, companyId, capability)

      if (next?.view.state === 'ready') {
        return
      }

      if (attempt + 1 < convergenceAttempts) {
        await wait(convergenceDelayMs)
      }
    }
  }

  // A conversation the platform has just opened (or found) gets its room from the hosted manager, and the invitation
  // reaches this window a moment later. Ask again, bounded, as for a new company's first channel; never an error.
  const convergeToConversation = async (created: CompanyConversationView, scope: number, still: () => boolean) => {
    setConversationNotice(false)

    for (let attempt = 0; attempt < convergenceAttempts; attempt += 1) {
      if (!inScope(scope) || !still()) {return}

      try {
        const state = await loadCompanyConversations(bridge, accountKey, created.companyId, profileRef.current, { quiet: true })
        const current = state?.conversations.find(item => item.id === created.id)

        if (!inScope(scope) || !still()) {return}

        if (current?.room.state === 'ready') {
          setOverviewCompanyId(undefined)
          patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })
          await onOpenChannel(current.room.roomId, still)
          if (inScope(scope) && compact && still()) {setCompactPane('content')}

          return
        }
      } catch {
        // The room exists on the platform; the Matrix invitation may not be synced yet.
      }

      if (attempt + 1 < convergenceAttempts) {await wait(convergenceDelayMs)}
    }

    if (inScope(scope) && still()) {setConversationNotice(true)}
  }

  // `still` was taken when Start was pressed, before the request: a create or an expand whose answer comes back after the
  // window moved to another company loads, joins and selects nothing of the old one.
  const conversationOpened = (created: CompanyConversationView, still: () => boolean) => {
    const scope = scopeRef.current

    void (async () => {
      if (!still()) {return}

      // The same people always open the same conversation: it may be one the person hid before.
      if (created.hidden) {await showConversationAgain(created.companyId, created.id)}

      if (!still()) {return}

      await convergeToConversation(created, scope, still)
    })()
  }

  const hideConversation = async (conversationId: string) => {
    const view = conversationViews?.find(item => item.id === conversationId)

    if (!view || blocked || !conversationsUsable) {return}

    const still = companyFence()

    const outcome = await runMutation({
      action: 'conversation-hidden',
      companyId: view.companyId,
      conversationId,
      requestId: requestId(),
      hidden: true
    })

    // Hiding the conversation on screen moves to the company's default channel rather than leaving a hidden one open,
    // but only while that company is still the one on screen: the hide may have finished after the person left it.
    if (outcome?.ok && still() && selectedCompanyIdRef.current === view.companyId && view.room.state === 'ready' &&
      view.room.roomId === activeRoomId) {
      void convergeToDefaultChannel(view.companyId, null, scopeRef.current)
    }
  }

  const acceptChannelInvitation = async (view: CompanyChannelView) => {
    if (!visibleSnapshot || !view.admission || blocked) {return}

    // The invitation's own generations, as the directory row carries them.
    await runMutation({ action: 'channel-command', companyId: visibleSnapshot.company.id, channelId: view.id,
      command: { requestId: requestId(), operation: 'accept', expectedChannelGeneration: view.channelGeneration,
        expectedAdmissionGeneration: view.admission.generation } })
  }

  const restoreChannel = async (channelId: string) => {
    if (!visibleSnapshot || blocked) {return}

    // Not inline: a refusal belongs in the workspace banner, there is no dialog to show it in.
    await runChannelCommand(bridge, mutation => runMutation(mutation), { companyId: visibleSnapshot.company.id, channelId },
      generations => ({ requestId: requestId(), operation: 'restore', expectedChannelGeneration: generations.channel }))
  }

  // ----- Switching companies: the rail, the menu and the shortcuts all come here, in one order.
  const orderedCompanies = listedCompanies ? orderCompanies(listedCompanies, locale) : []

  const switchCompany = (target: CompanyTarget) => {
    // Like the rail's tiles: a running change finishes first.
    if (mutationPending) {return}

    const next = 'slot' in target
      ? companyAtSlot(orderedCompanies, target.slot)
      : steppedCompany(orderedCompanies, selectedCompanyIdRef.current, target.step)

    if (next && next.id !== selectedCompanyIdRef.current) {selectCompany(next.id)}
  }

  const runIntent = (intent: TeamSpaceIntent) => {
    if (intent.kind === 'switch-company') {
      switchCompany(intent.to)

      return
    }

    if (intent.kind === 'conversation-add-people') {
      const view = conversationViews?.find(item => item.id === intent.conversationId)

      if (view && !blocked && conversationsUsable) {setConversationDialog({ kind: 'add', conversation: view })}

      return
    }

    if (intent.kind === 'conversation-hide') {
      void hideConversation(intent.conversationId)

      return
    }

    if (intent.kind === 'open-wallet') {
      const current = selectedCompanyIdRef.current

      if (current && intent.companyId === current && $companyWalletScope.get() === companySpaceScope(accountKey, current)) {
        setWalletOpen(true)
      }

      return
    }

    if (intent.kind === 'invite-members') {
      if (abilities.invite) {openInvite()}

      return
    }

    if (intent.kind === 'channel-members') {
      const channel = channelsMode ? channelViews?.find(view => view.id === intent.channelId) : undefined

      setCompanyMembersPanel(!channel)
      setDialog(channel ? { kind: 'members-panel', channelId: channel.id } : undefined)

      return
    }

    if (!channelsMode) {return}

    switch (intent.kind) {
      case 'browse-channels': setDialog({ kind: 'browse' }); return
      case 'create-channel': setDialog({ kind: 'create' }); return
      case 'channel-details':
        setDialog({ kind: 'details', channelId: intent.channelId, ...(intent.field ? { field: intent.field } : {}) })
        return
      case 'add-people': setDialog({ kind: 'members', channelId: intent.channelId }); return
      case 'leave-channel': setDialog({ kind: 'leave', channelId: intent.channelId }); return
      case 'archive-channel': setDialog({ kind: 'archive', channelId: intent.channelId }); return
      case 'restore-channel': void restoreChannel(intent.channelId)
    }
  }

  const intentRequest = useStore($teamSpaceIntent)
  const intentSeenRef = useRef(intentRequest?.id)
  const runIntentRef = useRef(runIntent)
  runIntentRef.current = runIntent

  // The channel header's menu leaves a note here; act on each note once, never on one left before this mounted.
  useEffect(() => {
    if (!intentRequest || intentSeenRef.current === intentRequest.id) {return}

    intentSeenRef.current = intentRequest.id
    runIntentRef.current(intentRequest.intent)
  }, [intentRequest])

  const visibleInvitations = (visibleDirectory?.invitations ?? []).filter(invitation =>
    !(inviteInbox?.accountKey === accountKey && inviteInbox.dismissed.has(invitation.id)))

  const singleCompany = listedCompanies?.length === 1 ? listedCompanies[0] : undefined
  const companyUnavailable = snapshotError === 'denied' || snapshotError === 'missing'
  const showingOverview = Boolean(selectedCompanyId && overviewCompanyId === selectedCompanyId)
  const showingActivity = activityOpen && !showingOverview
  const showingThreads = threadsOpen && !showingOverview
  const showingSaved = savedOpen && !showingOverview
  const showingDrafts = draftsOpen && !showingOverview
  const activePrivateCosRoom = companyPrivateCosRoom(privateCosState, rooms)
  const activeChannelRoom = activeRoomId ? roomsById.get(activeRoomId) : undefined
  const channelContentVerified = !isCompanyPrivateCosClaim(activeChannelRoom) ||
    activePrivateCosRoom?.id === activeRoomId

  const boundChannelSelected = Boolean(channelContent) &&
    channelContentVerified &&
    !showingOverview &&
    (!preferredCompanyId || preferredCompanyId === selectedCompanyId)

  const boundChannelVisible = boundChannelSelected && !showingActivity && !showingThreads && !showingSaved && !showingDrafts && activeCompanyTab === 'chat'

  // Keep the transcript mounted while Board is selected; its draft and scroll
  // belong to Chat and must survive a page switch. Visibility alone controls read attention.
  const visibleChannelContent = boundChannelSelected ? channelContent : undefined

  const savedContent = showingSaved ? (
    <SavedMessagesView
      accountKey={accountKey}
      companies={orderedCompanies}
      key={accountKey}
      onOpen={async message => {
        if (!onOpenSavedMessage) {throw new Error('matrix_saved_message_unavailable')}
        await onOpenSavedMessage(message)
        setSavedOpen(false)
      }}
      saved={savedMessages}
    />
  ) : undefined

  // The platform directories name only rooms this person may see in the selected company. Activity
  // is filtered through this list again before any row or badge count reaches the screen.
  const activityRooms: CompanyActivityRoomLabel[] = [
    ...(channelViews ?? []).flatMap(item => {
      if (item.room.state !== 'ready' || roomsById.get(item.room.roomId)?.membership !== 'join') {return []}

      return [{
        roomId: item.room.roomId,
        kind: 'channel' as const,
        name: isDefaultChannel(item) ? copy.defaultChannelName : item.displayName
      }]
    }),
    ...(conversationViews ?? []).flatMap(view => {
      if (view.room.state !== 'ready' || roomsById.get(view.room.roomId)?.membership !== 'join') {return []}

      return [{
        roomId: view.room.roomId,
        kind: 'conversation' as const,
        name: conversationTitle(view, selfMemberRef, copy.someone)
      }]
    })
  ]
  const authorizedThreads = authorizedCompanyThreads(threads, selectedCompanyId ?? '', activityRooms)
  const authorizedDrafts = authorizedCompanyDrafts(drafts.records, activityRooms)
  const authorizedDraftRoomIds = new Set([
    ...activityRooms.map(room => room.roomId),
    ...(activePrivateCosRoom ? [activePrivateCosRoom.id] : [])
  ])
  const draftDirectoryReady = Boolean(channelViews && (!profile.conversations || conversationViews))
  const inaccessibleDirectoryDrafts = draftDirectoryReady && selectedCompanyId
    ? drafts.records.filter(draft => {
        const room = roomsById.get(draft.room_id)
        if (isCompanyPrivateCosClaim(room)) {
          return false
        }

        const companyId = room?.companyChannel?.companyId ?? room?.companyConversation?.companyId ??
          room?.companyPrivateCos?.companyId

        return companyId === selectedCompanyId && !authorizedDraftRoomIds.has(draft.room_id)
      })
    : []
  const inaccessiblePrivateCosDrafts = drafts.records.filter(draft => {
    const room = roomsById.get(draft.room_id)

    if (!isCompanyPrivateCosClaim(room)) {
      return false
    }

    const companyId = room?.companyPrivateCos?.companyId

    return !selectedCompanyId || companyId !== selectedCompanyId ||
      Boolean(privateCosState && activePrivateCosRoom?.id !== room?.id)
  })
  const inaccessibleDrafts = [...new Map(
    [...inaccessibleDirectoryDrafts, ...inaccessiblePrivateCosDrafts]
      .map(draft => [matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id }), draft])
  ).values()]
  const inaccessibleDraftKeys = inaccessibleDrafts.map(draft =>
    matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id })
  ).join('\n')

  useEffect(() => {
    if (!onPurgeCompanyDraft) {
      return
    }

    for (const draft of inaccessibleDrafts) {
      const key = matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id })

      if (purgingDraftsRef.current.has(key)) {
        continue
      }

      purgingDraftsRef.current.add(key)
      void onPurgeCompanyDraft(draft).catch(() => purgingDraftsRef.current.delete(key))
    }
  // Stable keys avoid repeating clears while account-data sync catches up.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, inaccessibleDraftKeys, onPurgeCompanyDraft])

  companyInboxAuthorizationRef.current = {
    companyId: selectedCompanyId,
    roomIds: new Set(activityRooms.map(room => room.roomId)),
    threadKeys: new Set(authorizedThreads.map(companyThreadKey)),
    draftKeys: new Set(authorizedDrafts.map(draft =>
      matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id })
    ))
  }

  const activityContent = showingActivity && selectedCompanyId ? (
    <CompanyActivityView
      companyId={selectedCompanyId}
      items={activity}
      key={`${accountKey}:${selectedCompanyId}`}
      onOpen={async item => {
        if (!onOpenActivityItem) {throw new Error('matrix_company_activity_unavailable')}
        // The clicked row can outlive a directory refresh while native selection is awaiting.
        // Keep the same platform-derived authorization as both preflight and owner fence.
        const still = companyInboxFence(item)

        if (!still()) {throw new Error('matrix_company_activity_unavailable')}
        await onOpenActivityItem(item, still)

        if (still()) {setActivityOpen(false)}
      }}
      rooms={activityRooms}
    />
  ) : undefined

  const threadsContent = showingThreads && selectedCompanyId ? (
    <CompanyThreadsView
      companyId={selectedCompanyId}
      key={`${accountKey}:${selectedCompanyId}`}
      onFollow={async (thread, followed) => {
        if (!onFollowCompanyThread) {throw new Error('matrix_company_thread_unavailable')}
        const still = companyInboxFence(thread, companyThreadKey(thread))

        if (!still()) {return}
        await onFollowCompanyThread(thread, followed, still)
      }}
      onOpen={async thread => {
        if (!onOpenCompanyThread) {throw new Error('matrix_company_thread_unavailable')}
        const still = companyInboxFence(thread, companyThreadKey(thread))

        if (!still()) {return}
        await onOpenCompanyThread(thread, still)

        if (still()) {setThreadsOpen(false)}
      }}
      onRead={async thread => {
        if (!onReadCompanyThread) {throw new Error('matrix_company_thread_unavailable')}
        const still = companyInboxFence(thread, companyThreadKey(thread))

        if (!still()) {return}
        await onReadCompanyThread(thread, still)
      }}
      rooms={activityRooms}
      threads={threads}
    />
  ) : undefined

  const draftsContent = showingDrafts && selectedCompanyId ? (
    <CompanyDraftsView
      drafts={{ ...drafts, records: authorizedDrafts }}
      key={`${accountKey}:${selectedCompanyId}`}
      onOpen={async draft => {
        if (!onOpenCompanyDraft) {throw new Error('matrix_company_draft_unavailable')}
        const still = companyDraftFence(draft)

        if (!still()) {throw new Error('matrix_company_draft_unavailable')}
        await onOpenCompanyDraft(draft, still)

        if (still()) {setDraftsOpen(false)}
      }}
      rooms={activityRooms}
    />
  ) : undefined

  // Inboxes are return paths, not second chat lifecycles: keep the channel mounted
  // behind them so its draft, scroll and thread state survive the short visit.
  const visibleMainContent = visibleChannelContent || activityContent || threadsContent || savedContent || draftsContent ? (
    <>
      {visibleChannelContent && <div className={showingActivity || showingThreads || showingSaved || showingDrafts ? 'hidden' : 'contents'}>{visibleChannelContent}</div>}
      {activityContent}
      {threadsContent}
      {savedContent}
      {draftsContent}
    </>
  ) : undefined

  // Opening a channel never leaves the pane empty: it is opening, it could not open, or Matrix has it but the platform
  // has not confirmed the room to this window yet. Said here, inline, never in a floating banner.
  const openedChannelWaiting = Boolean(openedChannel && openedChannel.companyId === selectedCompanyId && !boundChannelSelected)

  const channelPaneStatus = showingOverview ? null : openingRoomId ? (
    <Loader className="size-6" data-matrix-company-channel-pane="opening" label={copy.loadingChannels} />
  ) : channelOpenError ? (
    <p className="text-sm text-destructive" data-matrix-company-channel-pane="failed" role="alert">{copy.channelOpenFailed}</p>
  ) : convergeNotice || openedChannelWaiting ? (
    <p className="text-sm text-(--atum-ink-muted)" data-matrix-company-channel-pane="preparing" role="status">{copy.convergeFailed}</p>
  ) : null

  const overviewBackground = showingOverview
    ? ((!preferredCompanyId || preferredCompanyId === selectedCompanyId) && channelContentVerified
        ? channelContent
        : undefined)
    : undefined

  const compactRoomId = showingActivity
    ? 'activity'
    : showingThreads
      ? 'threads'
      : showingSaved
        ? 'saved'
        : showingDrafts
          ? 'drafts'
          : visibleMainContent
            ? activeRoomId ?? null
            : null

  useEffect(() => {
    setOverviewCompanyId(undefined)
  }, [activeRoomId])

  useEffect(() => {
    if (!selectedCompanyId || !activeRoomId || !channelViews) {return}
    const active = channelViews.find(item => item.room.state === 'ready' && item.room.roomId === activeRoomId)

    if (active) {
      writeLastChannelId(accountKey, selectedCompanyId, active.id)
    }
  }, [accountKey, activeRoomId, channelViews, selectedCompanyId])

  // The channel header's Members button asks for this company's roster (the overview).
  useEffect(() => {
    if (overviewRequestSeenRef.current === overviewRequest) {return}

    overviewRequestSeenRef.current = overviewRequest

    if (selectedCompanyId) {
      setOverviewCompanyId(selectedCompanyId)

      if (compact) {setCompactPane('content')}
    }
  }, [compact, overviewRequest, selectedCompanyId])

  // A channel room that appears or goes away in Matrix sync means the directory changed: refresh
  // quietly now instead of waiting for the next periodic read (no separate change signal exists).
  const companyRoomKey = rooms
    .filter(
      room =>
        (room.companyChannel?.companyId === selectedCompanyId ||
          room.companyConversation?.companyId === selectedCompanyId ||
          room.companyPrivateCos?.companyId === selectedCompanyId) &&
        room.membership !== 'leave'
    )
    .map(room => room.id)
    .sort()
    .join('\n')

  const companyRoomKeyRef = useRef(companyRoomKey)

  useEffect(() => {
    if (companyRoomKeyRef.current === companyRoomKey) {return}

    companyRoomKeyRef.current = companyRoomKey

    if (selectedCompanyId && !pendingLoading && !activeMutation) {void quietRefresh(scopeRef.current)}
  }, [activeMutation, companyRoomKey, pendingLoading, quietRefresh, selectedCompanyId])

  // The company menu's Members and Company settings open the overview, then bring that part of it into view.
  useEffect(() => {
    if (!overviewSection || !showingOverview || !visibleSnapshot) {return}

    document
      .querySelector<HTMLElement>(overviewSection === 'members'
        ? '[data-matrix-company-members]'
        : '[data-matrix-company-avatar-settings], [data-matrix-company-policy]')
      ?.scrollIntoView?.({ block: 'start' })
    setOverviewSection(undefined)
  }, [overviewSection, showingOverview, visibleSnapshot])

  // The channel shortcuts walk the sidebar's order, so publish it (and withdraw it on exit).
  const channelOrderKey = (channelViews ?? [])
    .filter(item => item.room.state === 'ready' && item.state !== 'archived')
    .map(item => item.room.state === 'ready' ? item.room.roomId : '')
    .join('\n')

  useEffect(() => {
    $companyChannelOrder.set(channelOrderKey ? channelOrderKey.split('\n') : [])
    $companyChannelCompanyId.set(channelOrderKey ? selectedCompanyId : undefined)
  }, [channelOrderKey, selectedCompanyId])

  useEffect(() => () => {
    $companyChannelOrder.set([])
    $companyChannelCompanyId.set(undefined)
  }, [])

  useEffect(() => {
    onChannelVisibilityChange?.(boundChannelVisible && (!compact || compactPane === 'content'))
  }, [boundChannelVisible, compact, compactPane, onChannelVisibilityChange])

  useEffect(() => () => onChannelVisibilityChange?.(false), [onChannelVisibilityChange])

  useEffect(() => {
    if (!compact) {return}

    if (showingOverview) {
      compactRoomRef.current = null
      setCompactPane('content')
    } else if (!compactRoomId) {
      compactRoomRef.current = null
      setCompactPane('sidebar')
    } else if (compactRoomRef.current !== compactRoomId) {
      compactRoomRef.current = compactRoomId
      setCompactPane('content')
    }
  }, [compact, compactRoomId, showingOverview])

  useEffect(() => {
    if (!compact) {return}

    const frame = requestAnimationFrame(() => {
      if (compactPane === 'content') {
        backToChannelsRef.current?.focus({ preventScroll: true })
      } else {
        const current = document.querySelector<HTMLElement>(
          '[data-matrix-company-sidebar] [aria-current="page"]'
        )
        const target = current ?? overviewButtonRef.current
        target?.focus({ preventScroll: true })
      }
    })

    return () => cancelAnimationFrame(frame)
  }, [compact, compactPane])

  useEffect(() => {
    if (!visibleDirectory) {return}

    // A preference for a company just left is stale: it names nothing, and the fallback order picks instead.
    const preferenceLeft = Boolean(preferredCompanyId && leftCompanyIdsRef.current.has(preferredCompanyId))
    const listed = visibleDirectory.companies.filter(company => !leftCompanyIdsRef.current.has(company.id))

    const preferred = preferredCompanyId && !preferenceLeft
      ? listed.find(company => company.id === preferredCompanyId)
      : undefined

    if (preferredCompanyId && !preferenceLeft && !preferred) {return}

    const preferredChanged = followedPreferredCompanyRef.current !== preferredCompanyId
    followedPreferredCompanyRef.current = preferredCompanyId

    if (preferredChanged && preferred && preferred.id !== selectedCompanyId) {
      autoSelectedCompanyRef.current = preferred.id
      selectCompany(preferred.id, false)

      return
    }

    if (selectedCompanyId !== undefined) {return}

    // Nothing names a company: the one last open on this device (by id) if it is still there, else the one with the
    // newest activity, else the first. A company just left is never reopened from a directory read that still lists it.
    const next = preferred ?? initialCompany(orderCompanies(listed, locale), {
      activity: companyActivity(roomsRef.current),
      excluded: leftCompanyIdsRef.current,
      lastUsedId: readLastCompanyId(accountKey)
    })

    if (!next || autoSelectedCompanyRef.current === next.id) {return}

    autoSelectedCompanyRef.current = next.id
    const active = roomsRef.current.find(room => room.id === activeRoomId)
    const activeCompanyId = active?.companyChannel?.companyId ?? active?.companyConversation?.companyId ??
      active?.companyPrivateCos?.companyId

    selectCompany(next.id, !preferred && activeCompanyId !== next.id)
  }, [accountKey, activeRoomId, leftVersion, locale, preferredCompanyId, selectCompany, selectedCompanyId, visibleDirectory])

  useEffect(() => {
    if (pendingLoading || activeMutation) {return}

    const scope = scopeRef.current

    const quiet = () => {
      if (typeof document === 'undefined' || !document.hidden) {void quietRefresh(scope)}
    }

    const timer = setInterval(quiet, directoryError || channelsState?.stale ? 15_000 : 60_000)

    window.addEventListener('focus', quiet)
    window.addEventListener('online', quiet)

    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', quiet)
      window.removeEventListener('online', quiet)
    }
  }, [activeMutation, pendingLoading, quietRefresh, directoryError, channelsState?.stale])

  const channelLabel = (item: CompanyChannelView) =>
    isDefaultChannel(item) ? copy.defaultChannelName : item.displayName

  const memberStateLabel = (state: MatrixCompanyMember11['state']) =>
    state === 'invited' ? copy.memberStateInvited : state === 'revoking' ? copy.memberStateRevoking :
      state === 'removed' ? copy.memberStateRemoved : ''

  const memberName = (member: MatrixCompanyMember11) =>
    member.displayName ?? (member.handle ? `@${member.handle}` : copy.someone)

  const fundingRecoveryDisabled = !fundingEnabled && retryMutation?.action === 'funding'
  // Company DMs switched off since the answer was lost: the request is kept (the same id replays when they are on again)
  // and not sent.
  const conversationsRecoveryDisabled = !profile.conversations && Boolean(retryMutation?.action.startsWith('conversation-'))

  const projectSourcesRecoveryDisabled = !projectSourcesEnabled && retryMutation !== undefined &&
    isProjectSourceMutation(retryMutation)

  useEffect(() => {
    if (visibleSnapshot && selectedProjectId && !selectedProject) {
      clearProjectSelection()
    }
  }, [clearProjectSelection, selectedProject, selectedProjectId, visibleSnapshot])

  const channelStatus = (
    <>
      {channelsLoading && !channelViews && <Loader className="m-2 size-5" label={copy.loadingChannels} size="sm" />}
      {channelsError && <p className="px-2 text-xs text-destructive" role="alert">{resultError(channelsError, copy)}</p>}
      {channelsStale && !channelsError && (
        <p className="px-2 text-xs text-(--atum-ink-muted)" data-matrix-company-channels-stale role="status">
          {channelsLoading ? copy.loadingChannels : copy.unavailable}
        </p>
      )}
    </>
  )

  // The switcher's data. One rule badges a company (`companyBadge`); the company on screen shows none.
  const unreadOf = (companyId: string) => companyBadge(companyUnread(rooms, companyId), companyId === selectedCompanyId)

  const menuCompanies = orderedCompanies.map(item => ({
    id: item.id,
    displayName: item.displayName,
    role: item.role,
    badge: unreadOf(item.id),
    avatarUrl: companyAvatarUrls[item.id]
  }))

  // Creating another company is offered only to those the directory says may, and never to a server that does not say.
  const canCreateMore = visibleDirectory?.schemaVersion === 2 && visibleDirectory.canCreate

  const menuAllowed = {
    overview: Boolean(selectedCompanyId),
    members: Boolean(visibleSnapshot),
    invite: Boolean(visibleSnapshot && snapshot11 && abilities.invite),
    settings: Boolean(adminSnapshot && abilities.editPolicy),
    create: canCreateMore,
    leave: canLeaveCompany,
    wallet: Boolean(companyDesktopAvailable && selectedCompanyId && isAdmin)
  }

  // The wallet gate, published for the selected company only: a thread's Top up shows exactly when this opens it.
  const walletScope = menuAllowed.wallet && selectedCompanyId ? companySpaceScope(accountKey, selectedCompanyId) : null

  useEffect(() => {
    $companyWalletScope.set(walletScope)

    return () => {
      if ($companyWalletScope.get() === walletScope) {$companyWalletScope.set(null)}
    }
  }, [walletScope])

  const companyTitle = !companyUnavailable
    ? visibleSnapshot?.company.displayName ?? selectedCompany?.displayName ?? singleCompany?.displayName ?? copy.title
    : copy.title

  const companyAvatarUrl = selectedCompanyId ? companyAvatarUrls[selectedCompanyId] : undefined

  const titleHeading = (
    <h1 className="min-w-0 flex-1 truncate [font:var(--ak-t-headline)] text-(--atum-ink)">{companyTitle}</h1>
  )

  const visibleActivity = authorizedCompanyActivity(activity, selectedCompanyId ?? '', activityRooms)
  const unreadActivity = visibleActivity.filter(item => item.unread)
  const activityBadge = companyBadge({
    mentions: unreadActivity.filter(item => item.kind === 'mention').length,
    unread: unreadActivity.some(item => item.kind === 'thread_reply')
  })
  const visibleThreads = authorizedThreads

  const openActivity = () => {
    setOverviewCompanyId(undefined)
    setThreadsOpen(false)
    setSavedOpen(false)
    setDraftsOpen(false)
    setActivityOpen(true)
    patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })

    if (compact) {setCompactPane('content')}
  }

  const sidebarEntries = teamSpaceSidebarEntryVisibility({
    threads: visibleThreads.length,
    saved: savedMessages.records.length,
    drafts: authorizedDrafts.length
  })
  const threadsBadge = companyBadge({
    mentions: visibleThreads.reduce((count, thread) => count + thread.highlights, 0),
    unread: visibleThreads.some(thread => thread.unread)
  })

  return (
    <section aria-label={copy.title} className="relative flex min-h-0 flex-1 overflow-hidden" data-matrix-company-workspace>
      <PrivateCosAutoJoin
        accountKey={accountKey}
        activeMember={Boolean(selectedCompanyId && visibleSnapshot && selectedCompany && selfRow?.state === 'active')}
        companyId={selectedCompanyId}
        onAccept={onAcceptPrivateCosInvite ? acceptPrivateCosInvitation : undefined}
        onReject={onRejectPrivateCosRoom}
        onVerified={verifyPrivateCosRoom}
        rooms={rooms}
        state={privateCosState}
      />
      <TeamSpaceSidebar compactFull={compact && compactPane === 'sidebar'}
        footer={menuAllowed.invite ? (
          <button
            className="ak-btn ak-btn--plain w-full justify-start"
            data-team-space-invite-teammates
            disabled={mutationPending}
            onClick={openInvite}
            type="button"
          >
            <Plus aria-hidden className="ak-icon ak-icon--sm" />
            {teamCopy.inviteTeammates}
          </button>
        ) : undefined}
        header={
          <div className="flex min-w-0 items-center gap-1 px-1" data-matrix-company-title>
            {orderedCompanies.length > 0 ? (
              <CompanyMenu
                allowed={menuAllowed}
                companies={menuCompanies}
                currentId={selectedCompanyId}
                disabled={mutationPending}
                onCreate={() => setCreateCompanyOpen(true)}
                onInvite={openInvite}
                onLeave={() => {
                  if (selfRow) {setConfirmMember({ kind: 'leave', memberRef: selfRow.memberRef, name: rosterName(selfRow, copy.someone) })}
                }}
                onOverview={() => openOverview()}
                onSettings={() => openOverview('settings')}
                onSwitch={companyId => selectCompany(companyId)}
                onWallet={() => setWalletOpen(true)}
              >
                {/* Atum Kit (FlowTeamSpace): the company's app tile, its name at headline size and an
                    up-down chevron at the row's end, as a Mac sidebar's account switcher. */}
                <button className="flex w-full min-w-0 flex-1 items-center gap-2.5 rounded-(--atum-r-control) px-2 py-1.5 text-start hover:bg-(--ak-fill-hover)"
                  data-matrix-company-menu-trigger ref={overviewButtonRef} type="button">
                  {companyAvatarUrl ? (
                    <img alt="" className="atum-avatar size-7 shrink-0 object-cover" data-face="app" src={companyAvatarUrl} />
                  ) : (
                    <span aria-hidden className="atum-avatar grid size-7 shrink-0 place-items-center bg-(--ak-ink) text-[0.75rem] font-semibold text-(--ak-on-ink)" data-face="app">
                      {companyInitials(companyTitle, locale)}
                    </span>
                  )}
                  {titleHeading}
                  <ChevronUpDown aria-hidden className="size-4 shrink-0 text-(--ak-ink-3)" />
                </button>
              </CompanyMenu>
            ) : (
              <button aria-label={copy.companyOverview} className="min-w-0 rounded-(--atum-r-control) text-start"
                disabled ref={overviewButtonRef} type="button">
                {titleHeading}
              </button>
            )}
            {selectedCompanyId && (
              <ActivityButton
                badge={activityBadge}
                label={activityCopy(locale).title}
                onOpen={openActivity}
                selected={showingActivity}
              />
            )}
          </div>
        }
        hidden={compact && compactPane === 'content'} label={copy.channels} resizeLabel={copy.resizeSidebar}
        scope={accountKey}>
        <div className="px-(--ak-s2)" data-matrix-company-sidebar-search>
          <label className="ak-field ak-field--search">
            <SearchIcon aria-hidden className="ak-icon ak-icon--sm" />
            <input
              aria-label={teamCopy.sidebarSearch(companyTitle)}
              onChange={event => setSidebarQuery(event.currentTarget.value)}
              placeholder={teamCopy.sidebarSearch(companyTitle)}
              value={sidebarQuery}
            />
          </label>
        </div>
        {sidebarEntries.threads && <div data-matrix-company-threads-entry>
          <TeamSpaceSidebarRow
            ariaLabel={companyThreadsCopy(locale).title}
            icon={<Messages />}
            label={companyThreadsCopy(locale).title}
            onSelect={() => {
              setOverviewCompanyId(undefined)
              setActivityOpen(false)
              setSavedOpen(false)
              setDraftsOpen(false)
              setThreadsOpen(true)
              patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })

              if (compact) {setCompactPane('content')}
            }}
            selected={showingThreads}
            trailing={threadsBadge ? <RosterBadge badge={threadsBadge} /> : undefined}
            unread={Boolean(threadsBadge)}
          />
        </div>}
        {sidebarEntries.saved && <div data-matrix-saved-entry>
          <TeamSpaceSidebarRow
            icon={<Bookmark />}
            label={savedMessagesCopy(locale).title}
            onSelect={() => {
              setOverviewCompanyId(undefined)
              setActivityOpen(false)
              setThreadsOpen(false)
              setDraftsOpen(false)
              setSavedOpen(true)
              patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })

              if (compact) {setCompactPane('content')}
            }}
            selected={showingSaved}
          />
        </div>}
        {sidebarEntries.drafts && <div data-matrix-drafts-entry>
          <TeamSpaceSidebarRow
            icon={<PencilLine />}
            label={draftsCopy(locale).title}
            onSelect={() => {
              setOverviewCompanyId(undefined)
              setActivityOpen(false)
              setThreadsOpen(false)
              setSavedOpen(false)
              setDraftsOpen(true)
              patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })

              if (compact) {setCompactPane('content')}
            }}
            selected={showingDrafts}
          />
        </div>}
        {channelsMode ? (
          <ChannelSections
            abilities={abilities}
            activeRoomId={activeRoomId}
            bottom={channelStatus}
            onAcceptInvitation={view => void acceptChannelInvitation(view)}
            onBrowse={() => setDialog({ kind: 'browse' })}
            onCreate={() => setDialog({ kind: 'create' })}
            onOpen={view => {
              setOverviewCompanyId(undefined)
              void openChannel(view)
            }}
            openingRoomId={openingRoomId}
            query={sidebarQuery}
            rooms={rooms}
            showingOverview={showingOverview || showingActivity || showingThreads || showingSaved || showingDrafts}
            views={channelViews ?? []}
          />
        ) : listedCompanies?.length === 0 ? null : (
        // No company yet: the page offers to make one; an empty Channels heading would say nothing.
        <div data-matrix-company-channels>
          <TeamSpaceSidebarSection
            action={canCreateChannel ? (
              <Button aria-expanded={channelComposerOpen} aria-label={copy.createChannel} onClick={() => {
                setChannelComposerOpen(open => !open)
                setChannelName('')
              }} size="icon-xs" variant="ghost"><Plus aria-hidden /></Button>
            ) : undefined}
            title={copy.channels}
          >
            {channelStatus}
            {channelViews && (channelViews.length === 0 ? (
              <p className="px-2 py-1 text-sm text-(--atum-ink-muted)">{copy.noChannels}</p>
            ) : channelViews.map(item => {
              const label = channelLabel(item)
              const selected = item.room.state === 'ready' && item.room.roomId === activeRoomId
              const state = item.state === 'archived' ? 'archived' : item.room.state
              const badge = item.room.state === 'ready' ? companyRoomBadge(roomsById.get(item.room.roomId)) : null

              return (
                <div data-matrix-company-channel-row key={item.id}>
                  <TeamSpaceSidebarRow
                    ariaLabel={item.room.state === 'ready' ? copy.openChannel(label) : undefined}
                    disabled={item.room.state !== 'ready'}
                    icon={<Hash />}
                    label={label}
                    onSelect={() => {
                      setOverviewCompanyId(undefined)
                      void openChannel(item)
                    }}
                    selected={selected && !showingOverview && !showingActivity && !showingThreads && !showingSaved && !showingDrafts}
                    trailing={state === 'ready' ? (badge ? <RosterBadge badge={badge} /> : undefined) : copy.channelState(state)}
                    unread={badge !== null}
                  />
                </div>
              )
            }))}
            {canCreateChannel && channelComposerOpen && visibleSnapshot && (
              <form aria-label={copy.createChannel} className="grid gap-2 px-2 pt-2" onSubmit={event => {
                event.preventDefault()
                const displayName = channelName.trim()

                if (displayName && !retryMutation) {void runMutation({ action: 'create-channel', companyId: visibleSnapshot.company.id,
                  requestId: requestId(), displayName })}
              }}>
                <Input aria-label={copy.channelName} autoFocus disabled={mutationPending} maxLength={160}
                  onChange={event => setChannelName(event.target.value)} value={channelName} />
                <div className="flex gap-1">
                  <Button disabled={mutationPending || Boolean(retryMutation) || !channelName.trim()} size="sm" type="submit">{copy.createChannel}</Button>
                  <Button onClick={() => setChannelComposerOpen(false)} size="sm" type="button" variant="text">{copy.cancel}</Button>
                </div>
              </form>
            )}
          </TeamSpaceSidebarSection>
        </div>
        )}

        {visibleSnapshot && (
          <>
            <ConversationSections
              activeRoomId={activeRoomId}
              busy={blocked || (profile.conversations && !conversationsUsable)}
              conversations={profile.conversations ? conversationViews ?? [] : []}
              failed={profile.conversations && Boolean(conversationsState?.error || conversationsState?.stale)}
              loading={profile.conversations && (conversationsState?.loading ?? !conversationsState)}
              notesAccountKey={`${accountKey}:${selectedCompanyId}`}
              notesSelf={matrixCompanyNotesSelf(notesSelf, selectedCompanyId)}
              notesSelfAvatar={notesSelfAvatar}
              onNew={profile.conversations ? () => setConversationDialog({ kind: 'new' }) : undefined}
              onOpen={view => void openConversation(view)}
              onOpenNotesSelf={onOpenNotesSelf ? async () => {
                if (!selectedCompanyId) {return}
                patchCompanySpacePreferences(activeCompanyScope, { tab: 'chat' })
                await onOpenNotesSelf(selectedCompanyId)
                setOverviewCompanyId(undefined)
                setActivityOpen(false)
                setThreadsOpen(false)
                setSavedOpen(false)
                setDraftsOpen(false)
                setCompactPane('content')
              } : undefined}
              onOpenPrivateCos={privateCosState ? openPrivateCos : undefined}
              onRetryPrivateCos={retryPrivateCos}
              openingRoomId={openingRoomId}
              privateCos={privateCosState}
              privateCosAccountKey={`${accountKey}:${selectedCompanyId}`}
              privateCosStatus={privateCosStatus}
              query={sidebarQuery}
              rooms={rooms}
              selfMemberRef={selfMemberRef}
              showingOverview={showingOverview || showingActivity || showingThreads || showingSaved || showingDrafts}
            />
            {conversationNotice && (
              <p className="px-2 text-xs text-(--atum-ink-muted)" data-matrix-company-conversation-notice role="status">
                {teamCopy.conversationNotReady}
              </p>
            )}
          </>
        )}
      </TeamSpaceSidebar>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-matrix-company-content
        hidden={compact && compactPane === 'sidebar'}>
        {compact && compactPane === 'content' && (
          <div className="flex h-10 shrink-0 items-center border-b border-(--atum-line) px-3">
            <Button onClick={() => setCompactPane('sidebar')} ref={backToChannelsRef} size="inline" variant="text">
              <ArrowLeft aria-hidden />
              {copy.backToChannels}
            </Button>
          </div>
        )}
        {selectedCompanyId && <CompanySpaceTabs scope={activeCompanyScope} />}
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className={visibleMainContent
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
          : 'min-h-0 flex-1 overflow-y-auto'}
          hidden={activeCompanyTab !== 'chat'} id="company-page-chat" role="tabpanel">
          {overviewBackground}
          {visibleMainContent ?? <CompanyOverviewFrame overlay={showingOverview}>
          <h1 className="sr-only">{copy.title}</h1>

        {channelPaneStatus}

        {leavePending && <p className="text-sm text-(--atum-ink-muted)" role="status">{copy.leavePendingCopy}</p>}

        {visibleInvitations.map(invitation => (
          <div className="grid gap-2 rounded-(--atum-r-card) bg-(--atum-card) p-4 shadow-(--atum-glass-edge)"
            data-matrix-company-invitation-banner key={invitation.id} role="status">
            <p className="text-sm text-(--atum-ink)">
              {copy.joinInvitation(
                'inviter' in invitation
                  ? (invitation as MatrixCompanyInvitation11).inviter.displayName ??
                    ((invitation as MatrixCompanyInvitation11).inviter.handle
                      ? `@${(invitation as MatrixCompanyInvitation11).inviter.handle}` : copy.someone)
                  : copy.someone,
                invitation.displayName
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={mutationPending || pendingLoading || Boolean(pendingError) || Boolean(retryMutation)}
                onClick={() => void runMutation({ action: 'accept', companyId: invitation.companyId,
                  invitationId: invitation.id, requestId: requestId() })}
                size="sm"
              >
                {copy.joinAction}
              </Button>
              <Button onClick={() => dismissCompanyInvitation(accountKey, invitation.id)}
                size="sm" variant="text">{copy.laterAction}</Button>
              {profile.admin && (
                <Button
                  disabled={mutationPending || pendingLoading || Boolean(pendingError) || Boolean(retryMutation)}
                  onClick={() => void runMutation({ action: 'invitation-decline', companyId: invitation.companyId,
                    invitationId: invitation.id, requestId: requestId() })}
                  size="sm"
                  variant="text"
                >
                  {teamCopy.declineInvitation}
                </Button>
              )}
            </div>
          </div>
        ))}

        {directoryLoading && !visibleDirectory && <Loader className="size-6" label={copy.loading} />}
        {visibleDirectory && (directoryLoading || directoryError) && (
          <p className="text-xs text-(--atum-ink-muted)" data-matrix-company-directory-refreshing role="status">{copy.loading}</p>
        )}
        {directoryError && !visibleDirectory && (
          <div className="grid justify-items-start gap-2" role="alert">
            <p className="text-sm text-destructive">{resultError(directoryError, copy)}</p>
            <Button onClick={refresh} size="sm" variant="text">{copy.retry}</Button>
          </div>
        )}

        {visibleDirectory && !directoryError && listedCompanies?.length === 0 && visibleInvitations.length === 0 && (
          <div className="grid gap-3 rounded-(--atum-r-card) bg-(--atum-card) p-6 shadow-(--atum-glass-edge)" data-matrix-company-empty>
            <div>
              <h2 className="text-(length:--atum-t-section) font-semibold tracking-tight text-(--atum-ink)">{copy.emptyTitle}</h2>
              <p className="mt-1 text-sm text-(--atum-ink-muted)">{copy.emptyBody}</p>
            </div>
            {canCreateCompany ? (
              <Button disabled={blocked} onClick={() => setCreateCompanyOpen(true)} variant="secondary">
                <Plus aria-hidden />
                {copy.createCompany}
              </Button>
            ) : <p className="text-sm text-(--atum-ink-muted)">{copy.creationClosed}</p>}
          </div>
        )}

        {pendingError && <div className="grid justify-items-start gap-2" role="alert">
          <p className="text-sm text-destructive">{resultError(pendingError, copy)}</p>
          <Button disabled={pendingLoading || mutationPending} onClick={refresh} size="sm" variant="text">{copy.retry}</Button>
        </div>}

        {mutationError && (
          <div className="grid justify-items-start gap-2" role="alert">
            <p className="text-sm text-destructive">{projectSourcesRecoveryDisabled ? copy.projectSourcesDisabled :
              fundingRecoveryDisabled ? copy.fundingDisabled :
                conversationsRecoveryDisabled ? teamCopy.conversationsDisabled :
                mutationReason ? teamCopy.refusal[mutationReason] : resultError(mutationError, copy)}</p>
            {retryMutation && <Button disabled={mutationPending || pendingLoading || Boolean(pendingError) ||
              fundingRecoveryDisabled || projectSourcesRecoveryDisabled || conversationsRecoveryDisabled} onClick={() => void runMutation(retryMutation)}
              size="sm" variant="text">{copy.retry}</Button>}
          </div>
        )}

        {setupAvatarUploadError && pendingCompanySetup?.logo && (
          <div className="grid justify-items-start gap-2" data-matrix-company-avatar-upload-error role="alert">
            <p className="text-sm text-destructive">{layoutCopy.logoUploadFailed}</p>
            <Button disabled={blocked} onClick={() => setSetupAvatarUploadError(false)} size="sm" variant="text">
              {copy.retry}
            </Button>
          </div>
        )}

        {notAllowed === 'changed' && <p className="text-sm text-destructive" data-matrix-company-not-allowed role="alert">{teamCopy.noLongerAllowed}</p>}
        {notAllowed === 'conversations' && <p className="text-sm text-destructive" data-matrix-company-not-allowed role="alert">{teamCopy.conversationsDisabled}</p>}
        {notAllowed === 'unknown' && <p className="text-sm text-destructive" data-matrix-company-changed role="alert">{copy.conflict}</p>}

        {selectedCompanyId && !selectedCompany && !directoryLoading && !directoryError && (
          <p className="text-sm text-(--atum-ink-muted)" role="status">{copy.companyUnavailable}</p>
        )}
        {snapshotLoading && selectedCompanyId && <Loader className="size-6" label={copy.loading} />}
        {snapshotError && selectedCompanyId && <p className="text-sm text-destructive" role="alert">{resultError(snapshotError, copy)}</p>}

        {(showingOverview || overviewFallback) && visibleSnapshot && selectedCompany && (
          <div aria-label={showingOverview ? copy.companyOverview : undefined} aria-modal={showingOverview || undefined}
            className={showingOverview
              ? 'atum-sheet grid max-h-[min(44rem,calc(100dvh-2rem))] w-full max-w-3xl gap-5 overflow-y-auto p-6'
              : 'grid gap-5 rounded-(--atum-r-card) bg-(--atum-card) p-5 shadow-(--atum-glass-edge)'}
            data-matrix-company-detail role={showingOverview ? 'dialog' : undefined}>
            {showingOverview && (
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-(length:--atum-t-section) font-semibold text-(--atum-ink)">{copy.companyOverview}</h2>
                <Button onClick={() => setOverviewCompanyId(undefined)} size="sm" variant="text">{copy.close}</Button>
              </div>
            )}
            {searchEnabled && bridge.search && bridge.open && onOpenSearchResult && (
              <CompanySearch
                bridge={{ search: bridge.search, open: bridge.open }}
                companyId={visibleSnapshot.company.id}
                copy={copy}
                key={visibleSnapshot.company.id}
                locale={locale}
                onOpen={onOpenSearchResult}
              />
            )}
            {convergeNotice && showingOverview && <p className="text-sm text-(--atum-ink-muted)" role="status">{copy.convergeFailed}</p>}
            {snapshot11 && (
              <MembersPanel
                blocked={blocked}
                canInvite={abilities.invite}
                invitations={invitationRows}
                nowSeconds={nowSeconds}
                onInvitationAction={onInvitationAction}
                onInvite={openInvite}
                onMemberAction={onMemberAction}
                profile={profile}
                rows={roster}
                viewer={viewerRole}
              />
            )}
            {abilities.editPolicy && bridge.uploadAvatar && visibleSnapshot && (
              <div className="border-t border-(--atum-line) pt-5">
                <CompanyAvatarSettings
                  avatarUrl={companyAvatarUrl}
                  blocked={blocked}
                  bridge={bridge}
                  companyId={visibleSnapshot.company.id}
                  mutate={mutate}
                  onUploadBusyChange={setAvatarUploadBusy}
                  settlement={avatarSettlement?.companyId === visibleSnapshot.company.id ? avatarSettlement : undefined}
                />
              </div>
            )}
            {abilities.editPolicy && adminSnapshot && visibleSnapshot && (
              <PolicyControl
                authorityGeneration={adminSnapshot.company.authorityGeneration}
                blocked={blocked}
                companyId={visibleSnapshot.company.id}
                mutate={mutate}
                value={adminSnapshot.company.policy.channelCreation}
              />
            )}
            {abilities.editPolicy && adminSnapshot && visibleSnapshot && companyPolicy3(adminSnapshot) && (
              <DirectAddPolicyControl
                authorityGeneration={adminSnapshot.company.authorityGeneration}
                blocked={blocked}
                companyId={visibleSnapshot.company.id}
                mutate={mutate}
                policy={companyPolicy3(adminSnapshot)!}
              />
            )}
            {visibleSnapshot && (
              <div className="border-t border-(--atum-line) pt-5" data-company-ai-setting>
                <CompanyAIStatus accountKey={accountKey} companyId={visibleSnapshot.company.id} manage />
              </div>
            )}
            {projectsEnabled && <div className="grid gap-2 border-t border-(--atum-line) pt-5">
              <h3 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{copy.projects}</h3>
              {visibleSnapshot.projects.length === 0 ? <p className="text-sm text-(--atum-ink-muted)">{copy.noProjects}</p> : (
                <div className="grid gap-4 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
                  <ul aria-label={copy.projects} className="grid content-start gap-1">
                    {visibleSnapshot.projects.map(project => (
                      <li key={project.id}>
                        <Button
                          aria-pressed={project.id === selectedProjectId}
                          className="w-full justify-start"
                          disabled={mutationPending}
                          onClick={() => selectProject(project.id)}
                          size="sm"
                          variant={project.id === selectedProjectId ? 'secondary' : 'ghost'}
                        >
                          {project.displayName}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {selectedProject && (
                    <section aria-label={selectedProject.displayName} className="grid content-start gap-3" data-matrix-company-project>
                      <div className="flex items-start justify-between gap-3">
                        <span>
                          <h4 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{selectedProject.displayName}</h4>
                          <p className="mt-1 text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.channels}</p>
                        </span>
                        {companyDesktopAvailable && (
                          <Button onClick={() => setBriefProjectId(selectedProject.id)} size="sm" variant="text">
                            {boardCopy.openBrief}
                          </Button>
                        )}
                      </div>
                      {channelsLoading && !channelViews && <Loader className="size-5" label={copy.loadingChannels} size="sm" />}
                      {channelViews && (projectChannels.length === 0 ? (
                        <p className="text-sm text-(--atum-ink-muted)">{copy.noChannels}</p>
                      ) : (
                        <ul aria-label={`${selectedProject.displayName} · ${copy.channels}`} className="grid gap-1">
                          {projectChannels.map(item => (
                            <li className="flex items-center justify-between gap-3 text-sm text-(--atum-ink)" key={item.id}>
                              {item.room.state === 'ready' ? (
                                <Button
                                  aria-label={copy.openChannel(item.displayName)}
                                  onClick={() => void openChannel(item)}
                                  size="sm"
                                  variant="text"
                                >
                                  # {item.displayName}
                                </Button>
                              ) : <span># {item.displayName}</span>}
                              <span className="text-(--atum-ink-muted)">{copy.channelState(
                                item.state === 'archived' ? 'archived' : item.room.state
                              )}</span>
                            </li>
                          ))}
                        </ul>
                      ))}
                      {canCreateChannel && (
                        <form
                          aria-label={`${copy.createChannel} · ${selectedProject.displayName}`}
                          className="flex flex-wrap items-end gap-2"
                          onSubmit={event => {
                            event.preventDefault()
                            const displayName = projectChannelName.trim()

                            if (displayName && !retryMutation) {
                              void runMutation({ action: 'create-channel', companyId: visibleSnapshot.company.id,
                                projectId: selectedProject.id, requestId: requestId(), displayName })
                            }
                          }}
                        >
                          <label className="grid min-w-56 gap-1 text-sm">
                            <span className="text-(--atum-ink-muted)">{copy.channelName}</span>
                            <Input
                              aria-label={`${copy.channelName} · ${selectedProject.displayName}`}
                              disabled={mutationPending}
                              maxLength={160}
                              onChange={event => setProjectChannelName(event.target.value)}
                              value={projectChannelName}
                            />
                          </label>
                          <Button
                            disabled={mutationPending || pendingLoading || Boolean(pendingError) || Boolean(retryMutation) || !projectChannelName.trim()}
                            type="submit"
                            variant="secondary"
                          >
                            {copy.createChannel}
                          </Button>
                        </form>
                      )}
                      {projectSourcesEnabled && (
                        <div className="grid gap-2 border-t border-(--atum-line) pt-3">
                          {projectSourcesLoading && !visibleProjectSources && (
                            <Loader className="size-5" label={copy.loadingSources} size="sm" />
                          )}
                          {projectSourcesError && (
                            <div className="grid justify-items-start gap-1" role="alert">
                              <p className="text-sm text-destructive">{resultError(projectSourcesError, copy)}</p>
                              <Button
                                disabled={projectSourcesLoading || mutationPending}
                                onClick={() => void loadProjectSources(visibleSnapshot.company.id, selectedProject.id, scopeRef.current)}
                                size="sm"
                                variant="text"
                              >
                                {copy.retry}
                              </Button>
                            </div>
                          )}
                          {visibleProjectSources && !projectSourcesError && (
                            <MatrixCompanyProjectSourcesPanel
                              admin={canCreateProject}
                              blocked={mutationPending || pendingLoading || Boolean(pendingError) || Boolean(retryMutation)}
                              channelNames={Object.fromEntries(projectChannels.map(item => [item.id, item.displayName]))}
                              onMutation={mutation => void runMutation(mutation)}
                              onRetryReader={projectReaderEnabled
                                ? () => void loadProjectReader(visibleSnapshot.company.id, selectedProject.id, scopeRef.current)
                                : undefined}
                              readerStatus={visibleProjectReader}
                              readerStatusError={projectReaderError}
                              readerStatusLoading={projectReaderLoading}
                              value={visibleProjectSources}
                            />
                          )}
                        </div>
                      )}
                    </section>
                  )}
                </div>
              )}
              {canCreateProject && (
                <form
                  className="mt-1 flex flex-wrap items-end gap-2"
                  onSubmit={event => {
                    event.preventDefault()
                    const displayName = projectName.trim()

                    if (displayName && !retryMutation) {void runMutation({ action: 'create-project', companyId: visibleSnapshot.company.id, requestId: requestId(), displayName })}
                  }}
                >
                  <label className="grid min-w-56 gap-1 text-sm">
                    <span className="text-(--atum-ink-muted)">{copy.projectName}</span>
                    <Input disabled={mutationPending} onChange={event => setProjectName(event.target.value)} value={projectName} />
                  </label>
                  <Button disabled={mutationPending || pendingLoading || Boolean(pendingError) || Boolean(retryMutation) || !projectName.trim()} type="submit" variant="secondary">{copy.createProjectAction}</Button>
                </form>
              )}
            </div>}
            {projectsEnabled && canCreateProject && fundingEnabled && (
              <div className="border-t border-(--atum-line) pt-5">
                <MatrixCompanyFundingPanel
                  accountKey={accountKey}
                  blocked={mutationPending || pendingLoading || Boolean(pendingError) || Boolean(retryMutation)}
                  bridge={bridge}
                  companyId={visibleSnapshot.company.id}
                  key={`${accountKey}:${visibleSnapshot.company.id}`}
                  onConfigure={(enabled, taskLimit) => {
                    if (!retryMutation) { void runMutation({ action: 'funding', companyId: visibleSnapshot.company.id, requestId: requestId(), enabled, taskLimit }) }
                  }}
                  pendingChange={(activeMutation?.action === 'funding' && activeMutation.companyId === visibleSnapshot.company.id) ||
                    (retryMutation?.action === 'funding' && retryMutation.companyId === visibleSnapshot.company.id)}
                  refreshKey={fundingRefresh}
                />
              </div>
            )}
          </div>
        )}

          </CompanyOverviewFrame>}
        </div>
        {activeCompanyTab === 'board' && selectedCompanyId && visibleSnapshot && (
          <div className="flex min-h-0 min-w-0 flex-1" id="company-page-board" role="tabpanel">
            <CompanyBoard
              citationChannels={Object.fromEntries((channelViews ?? []).map(item => [item.id, item.displayName]))}
              citationContext={{
                senderName: citation => citation.kind === 'channel'
                  ? citationSenderName?.(citation.eventId)
                  : undefined
              }}
              companyId={selectedCompanyId}
              members={(snapshot11?.members ?? []).filter(member => member.state === 'active').map(member => ({
                memberRef: member.memberRef,
                displayName: member.displayName ?? (member.handle ? `@${member.handle}` : copy.someone),
                avatarUri: member.avatarUri
              }))}
              onOpenDiscussion={(channelId, threadRootEventId) => {
                const channel = channelViews?.find(item => item.id === channelId)

                if (channel?.room.state !== 'ready') {return}
                const roomId = channel.room.roomId
                void openRoom(roomId).then(() => {
                  onOpenThread?.(roomId, threadRootEventId)
                })
              }}
              projects={visibleSnapshot.projects.map(project => ({ id: project.id, displayName: project.displayName }))}
              scope={activeCompanyScope}
              viewerManages={viewerRole ? viewerRole !== 'member' : undefined}
              viewerMemberRef={selfMemberRef}
            />
          </div>
        )}
        {activeCompanyTab === 'marketplace' && selectedCompanyId && (
          <div className="flex min-h-0 min-w-0 flex-1" id="company-page-marketplace" role="tabpanel">
            <CompanyMarketplace
              chief={sharedChief?.enabled ? {
                principal: sharedChief.agent.principal,
                name: boardCopy.chiefOfStaff,
                ready: sharedChief.state === 'ready'
              } : undefined}
              companyId={selectedCompanyId}
              scope={activeCompanyScope}
            />
          </div>
        )}
        </div>
      </div>

      {walletOpen && selectedCompanyId && (
        <CompanyWalletDrawer companyId={selectedCompanyId} onClose={() => setWalletOpen(false)} />
      )}

      {briefProjectId && selectedCompanyId && (
        <CompanyProjectBrief
          citationChannels={Object.fromEntries((channelViews ?? []).map(item => [item.id, item.displayName]))}
          citationContext={{
            senderName: citation => citation.kind === 'channel'
              ? citationSenderName?.(citation.eventId)
              : undefined
          }}
          companyId={selectedCompanyId}
          onClose={() => setBriefProjectId(undefined)}
          onOpenTask={cardId => {
            patchCompanySpacePreferences(activeCompanyScope, {
              tab: 'board',
              projectId: briefProjectId,
              selectedCardId: cardId
            })
            setBriefProjectId(undefined)
          }}
          projectId={briefProjectId}
        />
      )}

      {companyMembersPanel && visibleSnapshot && (
        <aside
          aria-label={teamCopy.channelMembersTitle}
          className="absolute inset-y-0 end-0 z-30 flex w-[min(26rem,100%)] flex-col border-s border-(--atum-panel-line) bg-(--atum-main-bg) shadow-nous"
          data-matrix-company-members-panel
        >
          <header className="flex h-(--atum-l-header) shrink-0 items-center gap-3 border-b border-(--atum-panel-line) px-5">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-(--atum-ink)">{teamCopy.channelMembersTitle}</h2>
            <Button onClick={() => setCompanyMembersPanel(false)} size="sm" variant="text">{copy.close}</Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <MembersPanel
              blocked={blocked}
              canInvite={abilities.invite}
              invitations={invitationRows}
              nowSeconds={nowSeconds}
              onInvitationAction={onInvitationAction}
              onInvite={openInvite}
              onMemberAction={onMemberAction}
              panel
              profile={profile}
              rows={roster}
              viewer={viewerRole}
            />
          </div>
        </aside>
      )}

      {/* Dialogs sit at the workspace's root, not in the overview page, so the company menu can open one from beside an
          open channel as well. Each belongs to the company it was opened in: another company closes it (see
          `closeCompanyDialogs`), and it stops offering its action the moment the viewer's standing no longer allows it. */}
      {inviteOpen && visibleSnapshot && snapshot11 && (
        <ModalScrim>
          <InviteSheet
            abilities={abilities}
            blocked={blocked}
            bridge={bridge}
            companyId={visibleSnapshot.company.id}
            companyName={visibleSnapshot.company.displayName}
            dialogInstance={inviteInstance}
            invitations={invitationRows}
            key={`${visibleSnapshot.company.id}:${inviteInstance}`}
            mutate={mutate}
            notAllowed={inviteBlocked}
            nowSeconds={nowSeconds}
            onClose={() => setInviteOpen(false)}
            onInvitationAction={onInvitationAction}
            onRetry={async () => retryMutation && isInviteMutation(retryMutation) ? runMutation(retryMutation) : undefined}
            profile={profile}
            replayedLinkIds={replayedLinkIds}
            retry={retryMutation && isInviteMutation(retryMutation) ? retryMutation : undefined}
            roster={roster}
            viewer={viewerRole}
          />
        </ModalScrim>
      )}

      {transferTarget && visibleSnapshot && (
        <ConfirmDialog
          blockedReason={transferBlocked ? teamCopy.noLongerAllowed : undefined}
          cancelLabel={copy.cancel}
          confirmLabel={teamCopy.transferConfirm}
          description={teamCopy.transferBody(transferTarget.name, visibleSnapshot.company.displayName)}
          onClose={() => setTransferTarget(undefined)}
          onConfirm={transferOwnership}
          open
          title={teamCopy.transferTitle(transferTarget.name)}
        />
      )}

      {inviteJoinRequest && (
        <ModalScrim>
          <InviteJoinDialog
            accountKey={accountKey}
            bridge={bridge}
            cancelLabel={copy.cancel}
            key={inviteJoinRequest.serial}
            onJoined={openJoinedCompany}
            request={inviteJoinRequest}
          />
        </ModalScrim>
      )}

      {confirmMember && visibleSnapshot && (
        <ModalScrim>
          <div aria-label={confirmMember.kind === 'leave' ? teamCopy.leaveCompanyTitle(visibleSnapshot.company.displayName) : copy.removeTitle}
            aria-modal="true"
            className="atum-sheet grid w-full max-w-sm gap-4 p-5"
            data-matrix-company-confirm role="dialog">
            <div>
              <h2 className="text-(length:--atum-t-section) font-semibold tracking-tight text-(--atum-ink)">
                {confirmMember.kind === 'leave' ? teamCopy.leaveCompanyTitle(visibleSnapshot.company.displayName) : copy.removeTitle}
              </h2>
              <p className="mt-1 text-sm text-(--atum-ink-muted)">
                {confirmMember.kind === 'leave'
                  ? activeMembers === 1 ? teamCopy.leaveCompanyLastMemberBody : teamCopy.leaveCompanyBody
                  : copy.removeBody}
              </p>
              {confirmMember.kind === 'leave' && leaveWalletRefusal && (
                <p className="mt-2 text-sm text-destructive" data-matrix-company-wallet-not-empty role="alert">
                  <Tip label={teamCopy.leaveCompanyWalletNotEmptyTooltip}>
                    <span className="cursor-help" tabIndex={0}>{teamCopy.refusal.company_wallet_not_empty}</span>
                  </Tip>
                </p>
              )}
              {confirmMember.kind === 'leave' && mutationError === 'conflict' && (
                <p className="mt-2 text-sm text-destructive" role="alert">{copy.lastAdmin}</p>
              )}
              {confirmBlocked && <p className="mt-2 text-sm text-destructive" data-matrix-company-not-allowed role="alert">{teamCopy.noLongerAllowed}</p>}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => {
                setConfirmMember(undefined)
                setLeaveWalletRefusal(false)
              }} variant="text">{copy.cancel}</Button>
              <Button
                disabled={mutationPending || pendingLoading || Boolean(pendingError) || Boolean(retryMutation) || confirmBlocked}
                onClick={() => void runMutation(confirmMember.kind === 'leave'
                  ? { action: 'leave', companyId: visibleSnapshot.company.id, requestId: requestId() }
                  : { action: 'remove-member', companyId: visibleSnapshot.company.id,
                      requestId: requestId(), memberRef: confirmMember.memberRef })}
                variant="secondary"
              >
                {confirmMember.kind === 'leave' ? teamCopy.leaveCompanyConfirm : copy.removeConfirm}
              </Button>
            </div>
          </div>
        </ModalScrim>
      )}

      <CompanyCreateDialog blocked={blocked} mutate={mutate} onClose={() => setCreateCompanyOpen(false)}
        onCreated={setup => {
          setSetupAvatarUploadError(false)
          setPendingCompanySetup(setup)
        }} onJoinInviteLink={openMatrixInviteJoinPaste} open={createCompanyOpen} />

      {profile.conversations && visibleSnapshot && conversationDialog && (
        <ConversationDialog
          begin={companyFence}
          companyId={visibleSnapshot.company.id}
          mode={conversationDialog}
          mutate={mutate}
          onClose={() => setConversationDialog(undefined)}
          onOpened={conversationOpened}
          open
          people={conversationPeople}
          selfMemberRef={selfMemberRef}
        />
      )}

      {channelsMode && visibleSnapshot && (
        <ChannelDialogs
          abilities={abilities}
          accountKey={accountKey}
          bridge={bridge}
          companyId={visibleSnapshot.company.id}
          dialog={dialog}
          mutate={mutate}
          onChanged={afterChannelChange}
          onCreated={channelCreated}
          onDialog={setDialog}
          onLeft={channelLeft}
          onOpenChannel={openChannelById}
          onOpenPrivateCos={privateCosState ? openPrivateCos : undefined}
          onRetryPrivateCos={retryPrivateCos}
          profile={profile}
          roster={roster}
          viewerRole={viewerRole}
          views={channelViews ?? []}
        />
      )}
    </section>
  )
}
