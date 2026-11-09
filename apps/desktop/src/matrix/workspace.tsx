import { useStore } from '@nanostores/react'
import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef } from 'react'

import type { MatrixCompanyThread } from '../../shared/matrix'
import type { MatrixCompanyActivityItem } from '../../shared/matrix-company-activity'
import type { MatrixCompanyMessageSearchResult } from '../../shared/matrix-company-search'
import { matrixDraftKey, type MatrixDraftRecord } from '../../shared/matrix-drafts'
import type { MatrixMessageLinkTarget } from '../../shared/matrix-message-link'
import { matrixNotesSelfCompanyId } from '../../shared/matrix-notes-self'
import type {
  MatrixSavedMessageOpenResult,
  MatrixSavedMessageView
} from '../../shared/matrix-saved-messages'

import { MatrixCompanyWorkspace } from './company-workspace'
import {
  $matrixHistoryReveal,
  clearExactMatrixHistoryReveal,
  clearMatrixHistoryReveal,
  revealMatrixHistoryMessage
} from './history-search'
import { OwnAvatar } from './rail-account'
import { teamSpaceAccountKey } from './team-space/keys'
import {
  $matrixMessageLinkRequest,
  clearMatrixMessageLinkRequest
} from './team-space/message-links'
import { runMatrixCommand } from './text-document-actions'
import { MatrixWorkplace } from './workplace'

export interface MatrixWorkspaceConversationTarget {
  roomId: string
  threadRootId?: string
}

export interface MatrixWorkspaceProps extends Omit<ComponentProps<typeof MatrixWorkplace>, 'header'> {
  channelContent?: ReactNode
  onChannelVisibilityChange?(visible: boolean): void
  onOpenConversation?(target: MatrixWorkspaceConversationTarget): void
  onMessageLinkFailure?(kind: 'membership' | 'unavailable'): void
}

/** Team Space is a company mode. Personal assistant management stays in Settings. */
export function MatrixWorkspace({ channelContent, onChannelVisibilityChange, onMessageLinkFailure,
  onOpenConversation, ...props }: MatrixWorkspaceProps) {
  const bridge = window.atumMatrix.companies
  const enabled = Boolean(props.snapshot.companyWorkspaceEnabled && bridge?.pending)
  const identity = props.snapshot.identity
  const accountKey = teamSpaceAccountKey(identity)
  const accountKeyRef = useRef(accountKey)
  const snapshotRef = useRef(props.snapshot)
  const openingMessageLinkRef = useRef<number | undefined>(undefined)
  const messageLinkRequest = useStore($matrixMessageLinkRequest)
  accountKeyRef.current = accountKey
  snapshotRef.current = props.snapshot

  useEffect(() => {
    const reveal = $matrixHistoryReveal.get()

    if (reveal?.owner === 'company' && reveal.accountKey !== accountKey) {
      clearExactMatrixHistoryReveal(reveal)
    }
  }, [accountKey])

  const acceptCompanyRoomInvitation = useCallback(async (
    roomId: string,
    isCurrent?: () => boolean,
    selectOnJoin = true
  ) => {
    // The directory is an authority projection, not a room capability. Only
    // act on the current account's snapshot, and recheck after every await. The company
    // on screen is part of that: a room opened for one company is not selected under another.
    const stale = () => accountKeyRef.current !== accountKey || isCurrent?.() === false

    if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}

    if (stale()) {throw new Error('MATRIX_COMPANY_SELECTION_CHANGED')}

    const snapshot = snapshotRef.current
    const room = snapshot.rooms.find(value => value.id === roomId)

    if (snapshot.state !== 'ready' || !room || !['invite', 'join'].includes(room.membership)) {
      throw new Error('MATRIX_COMPANY_CHANNEL_UNAVAILABLE')
    }

    if (room.membership === 'invite') {
      await runMatrixCommand({ kind: 'join', roomId, ...(selectOnJoin ? {} : { select: false as const }) })

      if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}

      if (stale()) {throw new Error('MATRIX_COMPANY_SELECTION_CHANGED')}
    }
  }, [accountKey])

  const acceptPrivateCosInvitation = useCallback(
    (roomId: string, isCurrent?: () => boolean) => acceptCompanyRoomInvitation(roomId, isCurrent, false),
    [acceptCompanyRoomInvitation]
  )

  const rejectPrivateCosRoom = useCallback(async (roomId: string) => {
    await runMatrixCommand({ kind: 'leave', roomId })
    await runMatrixCommand({ kind: 'forget', roomId })
  }, [])

  const selectCompanyRoom = useCallback(async (roomId: string, isCurrent?: () => boolean) => {
    await acceptCompanyRoomInvitation(roomId, isCurrent)
    const stale = () => accountKeyRef.current !== accountKey || isCurrent?.() === false

    await runMatrixCommand({ kind: 'select', roomId })

    if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}
    // The room is selected in Matrix; the window is not taken to it under another company.

    if (stale()) {throw new Error('MATRIX_COMPANY_SELECTION_CHANGED')}
  }, [acceptCompanyRoomInvitation, accountKey])

  const openCompanyChannel = useCallback(async (roomId: string, isCurrent?: () => boolean) => {
    await selectCompanyRoom(roomId, isCurrent)
    clearMatrixHistoryReveal(undefined, 'company')
    onOpenConversation?.({ roomId })
  }, [onOpenConversation, selectCompanyRoom])

  const currentCompanyMessageRoom = useCallback((
    item: MatrixMessageLinkTarget,
    isCurrent?: () => boolean
  ) => {
    const room = snapshotRef.current.rooms.find(value => value.id === item.roomId)
    const binding = room?.companyChannel ?? room?.companyConversation

    if (isCurrent?.() === false || room?.membership !== 'join' || binding?.companyId !== item.companyId) {
      throw new Error('MATRIX_COMPANY_MESSAGE_UNAVAILABLE')
    }

    return room
  }, [])

  const revealCompanyMessageTarget = useCallback(async (
    item: MatrixMessageLinkTarget,
    isCurrent?: () => boolean
  ) => {
    currentCompanyMessageRoom(item, isCurrent)

    revealMatrixHistoryMessage(item.roomId, item.eventId, 'company', item.threadRootId, accountKey)
    onOpenConversation?.({
      roomId: item.roomId,
      ...(item.threadRootId ? { threadRootId: item.threadRootId } : {})
    })
  }, [accountKey, currentCompanyMessageRoom, onOpenConversation])

  const openCompanyActivity = useCallback(async (item: MatrixCompanyActivityItem, isCurrent?: () => boolean) => {
    currentCompanyMessageRoom(item, isCurrent)
    await selectCompanyRoom(item.roomId, isCurrent)
    if (isCurrent?.() === false) {throw new Error('MATRIX_COMPANY_ACTIVITY_UNAVAILABLE')}
    await revealCompanyMessageTarget(item, isCurrent)
  }, [currentCompanyMessageRoom, revealCompanyMessageTarget, selectCompanyRoom])

  useEffect(() => {
    const request = messageLinkRequest
    if (!request || openingMessageLinkRef.current === request.serial) {return}
    openingMessageLinkRef.current = request.serial

    const finish = (failure?: 'membership' | 'unavailable') => {
      if (failure) {onMessageLinkFailure?.(failure)}
      clearMatrixMessageLinkRequest(request)
    }
    const room = snapshotRef.current.rooms.find(value => value.id === request.target.roomId)
    const binding = room?.companyChannel

    if (snapshotRef.current.state !== 'ready' || !bridge?.open) {finish('unavailable'); return}
    if (room?.membership !== 'join' || binding?.companyId !== request.target.companyId) {
      finish('membership')

      return
    }

    const accountAtStart = accountKey
    const open = bridge.open
    void open({
      companyId: request.target.companyId,
      channelId: binding.channelId,
      roomId: request.target.roomId,
      eventId: request.target.eventId,
      ...(request.target.threadRootId ? { threadRootId: request.target.threadRootId } : {})
    }).then(async opened => {
      if ($matrixMessageLinkRequest.get() !== request || accountKeyRef.current !== accountAtStart) {return}
      if (!opened.ok) {
        finish(opened.error === 'denied' || opened.error === 'missing' ? 'membership' : 'unavailable')

        return
      }
      const current = snapshotRef.current.rooms.find(value => value.id === request.target.roomId)
      if (current?.membership !== 'join' || current.companyChannel?.companyId !== request.target.companyId ||
        current.companyChannel.channelId !== binding.channelId) {
        finish('membership')

        return
      }

      const still = () => $matrixMessageLinkRequest.get() === request && accountKeyRef.current === accountAtStart
      await revealCompanyMessageTarget(request.target, still)
      finish()
    }).catch(() => {
      if ($matrixMessageLinkRequest.get() === request && accountKeyRef.current === accountAtStart) {
        finish('unavailable')
      }
    })
  }, [accountKey, bridge, messageLinkRequest, onMessageLinkFailure, revealCompanyMessageTarget])

  const currentCompanyThreadRoom = useCallback((thread: MatrixCompanyThread, isCurrent?: () => boolean) => {
    if (isCurrent?.() === false) {return undefined}
    const room = props.snapshot.rooms.find(value => value.id === thread.roomId)
    const binding = room?.companyChannel ?? room?.companyConversation
    const current = props.snapshot.companyThreads?.some(item =>
      item.companyId === thread.companyId && item.roomId === thread.roomId && item.root.id === thread.root.id)

    if (!current || room?.membership !== 'join' || binding?.companyId !== thread.companyId) {
      throw new Error('MATRIX_COMPANY_THREAD_UNAVAILABLE')
    }

    return room
  }, [props.snapshot.companyThreads, props.snapshot.rooms])

  const openCompanyThread = useCallback(async (thread: MatrixCompanyThread, isCurrent?: () => boolean) => {
    if (!currentCompanyThreadRoom(thread, isCurrent)) {return}
    await selectCompanyRoom(thread.roomId, isCurrent)
    if (isCurrent?.() === false) {return}
    onOpenConversation?.({ roomId: thread.roomId, threadRootId: thread.root.id })
  }, [currentCompanyThreadRoom, onOpenConversation, selectCompanyRoom])

  const openCompanyDraft = useCallback(async (draft: MatrixDraftRecord, isCurrent?: () => boolean) => {
    if (isCurrent?.() === false || accountKeyRef.current !== accountKey) {
      throw new Error('MATRIX_COMPANY_DRAFT_UNAVAILABLE')
    }

    const room = props.snapshot.rooms.find(value => value.id === draft.room_id)
    const binding = room?.companyChannel ?? room?.companyConversation
    const key = matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id })
    const current = props.snapshot.drafts?.records.some(record =>
      matrixDraftKey({ roomId: record.room_id, threadRootId: record.thread_root_id }) === key
    )

    if (!current || room?.membership !== 'join' || !binding) {
      throw new Error('MATRIX_COMPANY_DRAFT_UNAVAILABLE')
    }

    await selectCompanyRoom(draft.room_id, isCurrent)

    if (isCurrent?.() === false || accountKeyRef.current !== accountKey) {
      throw new Error('MATRIX_COMPANY_DRAFT_UNAVAILABLE')
    }

    onOpenConversation?.({
      roomId: draft.room_id,
      ...(draft.thread_root_id ? { threadRootId: draft.thread_root_id } : {})
    })
  }, [accountKey, onOpenConversation, props.snapshot.drafts?.records, props.snapshot.rooms, selectCompanyRoom])

  const purgeCompanyDraft = useCallback(async (draft: MatrixDraftRecord) => {
    const fencedIdentity = props.snapshot.identity

    if (!fencedIdentity || accountKeyRef.current !== accountKey) {
      throw new Error('MATRIX_ACCOUNT_CHANGED')
    }

    await runMatrixCommand({
      kind: 'draft',
      identity: fencedIdentity,
      roomId: draft.room_id,
      ...(draft.thread_root_id ? { threadRootId: draft.thread_root_id } : {}),
      text: ''
    })

    if (accountKeyRef.current !== accountKey) {
      throw new Error('MATRIX_ACCOUNT_CHANGED')
    }
  }, [accountKey, props.snapshot.identity])

  const readCompanyThread = useCallback(async (thread: MatrixCompanyThread, isCurrent?: () => boolean) => {
    if (!currentCompanyThreadRoom(thread, isCurrent) || isCurrent?.() === false) {return}
    await runMatrixCommand({ kind: 'threadRead', roomId: thread.roomId, rootId: thread.root.id })
    if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}
  }, [accountKey, currentCompanyThreadRoom])

  const followCompanyThread = useCallback(async (
    thread: MatrixCompanyThread,
    followed: boolean,
    isCurrent?: () => boolean
  ) => {
    if (!currentCompanyThreadRoom(thread, isCurrent) || isCurrent?.() === false) {return}
    await runMatrixCommand({ kind: 'threadFollow', roomId: thread.roomId, rootId: thread.root.id, followed })
    if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}
  }, [accountKey, currentCompanyThreadRoom])

  /**
   * A cited message's sender, for a human source label. The citation projection
   * carries only the event id; when this room has the event, read the name from
   * the same display projection the transcript uses. Missing stays missing.
   */
  const citationSenderName = useCallback((eventId: string) => {
    const message = props.snapshot.messages.find(item => item.id === eventId)

    if (!message || message.own) {
      return undefined
    }

    return props.snapshot.members?.find(member => member.userId === message.sender)?.name
  }, [props.snapshot.members, props.snapshot.messages])

  const openCompanySearchResult = useCallback(async (result: MatrixCompanyMessageSearchResult) => {
    if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}
    revealMatrixHistoryMessage(result.roomId, result.eventId, 'company', result.threadRootId, accountKey)
    onOpenConversation?.({
      roomId: result.roomId,
      ...(result.threadRootId ? { threadRootId: result.threadRootId } : {})
    })
  }, [accountKey, onOpenConversation])

  const openSavedMessage = useCallback(async (message: MatrixSavedMessageView & { available: true }) => {
    if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}

    const opened = await runMatrixCommand({
      kind: 'savedMessageOpen',
      roomId: message.room_id,
      eventId: message.event_id
    }) as MatrixSavedMessageOpenResult

    if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}
    revealMatrixHistoryMessage(message.room_id, message.event_id, 'company', opened.threadRootId, accountKey)
    onOpenConversation?.({
      roomId: message.room_id,
      ...(opened.threadRootId ? { threadRootId: opened.threadRootId } : {})
    })
  }, [accountKey, onOpenConversation])

  const openNotesSelf = useCallback(async (companyId: string) => {
    if (accountKeyRef.current !== accountKey) {throw new Error('MATRIX_ACCOUNT_CHANGED')}

    const opened = await runMatrixCommand({ kind: 'notesSelfOpen', companyId }) as { roomId?: unknown }

    if (accountKeyRef.current !== accountKey || typeof opened?.roomId !== 'string') {
      throw new Error('MATRIX_ACCOUNT_CHANGED')
    }

    clearMatrixHistoryReveal(undefined, 'company')
    onOpenConversation?.({ roomId: opened.roomId })
  }, [accountKey, onOpenConversation])

  // Settings may still open a specific assistant-management page. The Team Space
  // rail itself never routes through that personal workspace landing page.
  if (!enabled || props.initialPage) {
    return <MatrixWorkplace {...props} />
  }

  return (
    <MatrixCompanyWorkspace
      accountKey={accountKey}
      activeRoomId={props.snapshot.roomId}
      activity={props.snapshot.companyActivity}
      bridge={bridge!}
      channelContent={channelContent}
      citationSenderName={citationSenderName}
      drafts={props.snapshot.drafts}
      fundingEnabled={Boolean(props.snapshot.companyFundingEnabled)}
      notesSelf={props.snapshot.notesSelf}
      notesSelfAvatar={(
        <OwnAvatar
          className="size-5 rounded-(--atum-r-avatar) text-[0.625rem] leading-none"
          snapshot={props.snapshot}
        />
      )}
      onAcceptPrivateCosInvite={acceptPrivateCosInvitation}
      onChannelVisibilityChange={onChannelVisibilityChange}
      onFollowCompanyThread={followCompanyThread}
      onOpenActivityItem={openCompanyActivity}
      onOpenChannel={openCompanyChannel}
      onOpenCompanyDraft={openCompanyDraft}
      onOpenCompanyThread={openCompanyThread}
      onOpenNotesSelf={openNotesSelf}
      onOpenSavedMessage={openSavedMessage}
      onOpenSearchResult={openCompanySearchResult}
      onOpenThread={(roomId, threadRootEventId) => onOpenConversation?.({ roomId, threadRootId: threadRootEventId })}
      onPurgeCompanyDraft={purgeCompanyDraft}
      onReadCompanyThread={readCompanyThread}
      onRejectPrivateCosRoom={rejectPrivateCosRoom}
      preferredCompanyId={
        props.snapshot.rooms.find(room => room.id === props.snapshot.roomId)?.companyChannel?.companyId ??
        props.snapshot.rooms.find(room => room.id === props.snapshot.roomId)?.companyConversation?.companyId ??
        props.snapshot.rooms.find(room => room.id === props.snapshot.roomId)?.companyPrivateCos?.companyId ??
        (props.snapshot.roomId ? matrixNotesSelfCompanyId(props.snapshot.notesSelf, props.snapshot.roomId) : undefined)
      }
      projectReaderEnabled={Boolean(props.snapshot.companyProjectReaderEnabled)}
      projectsEnabled={Boolean(props.snapshot.companyProjectSourcesEnabled)}
      projectSourcesEnabled={Boolean(props.snapshot.companyProjectSourcesEnabled)}
      rooms={props.snapshot.rooms}
      savedMessages={props.snapshot.savedMessages}
      searchEnabled
      threads={props.snapshot.companyThreads}
    />
  )
}
