import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { $atumAppCatalog } from '@/lib/atum-app-catalog'
import { allowsIntakeModal } from '@/lib/atum-app-surfaces'
import {
  type AtumMentionTargetCandidate,
  type AtumMessageSearchResult,
  atumMessagingClient
} from '@/lib/atum-messaging-client'
import { $atumGroupQuote, clearAtumGroupQuote, groupQuoteFor, setAtumGroupQuote } from '@/store/atum-group-quote'
import {
  $atumAccountScopeId,
  $atumAccountStatus,
  $atumActiveMessages,
  $atumConnectivity,
  $atumOlderHistory,
  $atumRemovedGroups,
  $atumReplyTo,
  $atumRoster,
  $atumSocialRelationships,
  $atumTyping,
  editAtumMessage,
  initializeAtumMessaging,
  loadOlderAtumMessages,
  recallAtumMessage,
  refreshAtumStatus,
  retryAtumMessage,
  setAtumActiveConversation,
  setAtumReplyTo,
  signInToAtum,
  toggleAtumReaction
} from '@/store/atum-messaging'
import { atumDmWorkbenchScopeKey, ensureWorkbenchAppMenu } from '@/store/workbench-tabs'

import { appConnectionAllowsUse } from '../atum/app-connection-state'
import { presentAtumConversation } from '../atum/roster'
import { useAppConnection } from '../atum/use-app-connection'
import { useAppRoutes } from '../atum/use-app-routes'

import { intakeRequiredByLastTurn } from './dm-app-gate'
import { DmComposer } from './dm-composer'
import { DmConnectCard } from './dm-connect-card'
import { DmIntakeDialog } from './dm-intake-dialog'
import { LEGACY_ATUM_TARGET } from './dm-mentions'
import { DmMessageList } from './dm-message-list'
import { groupContacts } from './group-contacts'
import { GroupRoomControls } from './group-room-controls'
import { type GroupReportTarget, GroupRoomReportDialog } from './group-room-report-dialog'
import {
  $groupCapabilities,
  $groupDetails,
  $groupErrors,
  $groupLoading,
  $groupOperations,
  $groupPendingManagement,
  $groupPendingReports,
  loadGroupDetail,
  operateGroup,
  refreshGroupCapabilities,
  refreshGroupOperations
} from './group-state'
import { PrivateAdvisoryControls } from './private-advisory-controls'

export function canComposeAtum(accountState: string, connectivity: string): boolean {
  return (
    (accountState === 'signed_in' || accountState === 'refreshing') &&
    (connectivity === 'online' || connectivity === 'offline_cached' || connectivity === 'reconnecting')
  )
}

export function canUseAppConnect(accountId: string, accountState: string): boolean {
  return Boolean(accountId) && ['signed_in', 'refreshing', 'error'].includes(accountState)
}

export function counterpartReadMessageId(payload: Record<string, unknown>, accountId: string): string | null {
  const rows = Array.isArray(payload.read_states) ? payload.read_states : payload.read_state ? [payload.read_state] : []

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') {
      continue
    }

    const row = raw as Record<string, unknown>
    const reader = row.account_id ?? row.user_id ?? row.participant_id
    const through = row.through_message_id ?? row.message_id

    if (reader !== accountId && typeof through === 'string') {
      return through
    }
  }

  return null
}

export function AtumDmView() {
  const { conversationId = '' } = useParams()
  const { locale, t } = useI18n()
  const account = useStore($atumAccountStatus)
  const accountScopeId = useStore($atumAccountScopeId)
  const catalogState = useStore($atumAppCatalog)
  const catalog = catalogState.accountId === accountScopeId ? catalogState.apps : []
  const connectivity = useStore($atumConnectivity)
  const roster = useStore($atumRoster)
  const socialRelationships = useStore($atumSocialRelationships)
  const messages = useStore($atumActiveMessages)
  const olderHistory = useStore($atumOlderHistory)
  const typing = useStore($atumTyping)
  const removedGroups = useStore($atumRemovedGroups)
  const replies = useStore($atumReplyTo)
  useStore($atumGroupQuote)
  const groupCapabilities = useStore($groupCapabilities)
  const groupDetails = useStore($groupDetails)
  const groupLoading = useStore($groupLoading)
  const groupErrors = useStore($groupErrors)
  const groupOperations = useStore($groupOperations)
  const pendingReports = useStore($groupPendingReports)
  const pendingManagement = useStore($groupPendingManagement)
  const [groupControlsOpen, setGroupControlsOpen] = useState(false)
  const [reportPicker, setReportPicker] = useState(false)
  const [reportTarget, setReportTarget] = useState<GroupReportTarget | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<AtumMessageSearchResult[]>([])
  const searchRequest = useRef({ generation: 0, scope: '' })
  const [mentionTargets, setMentionTargets] = useState<AtumMentionTargetCandidate[]>([])

  const [mentionTargetState, setMentionTargetState] = useState<
    'denied' | 'empty' | 'error' | 'legacy' | 'loading' | 'ready'
  >('loading')

  const [mentionCardinality, setMentionCardinality] = useState(8)

  const jumpToMessage = async (messageId: string) => {
    for (let page = 0; page < 20; page += 1) {
      const node = document.getElementById(`dm-message-${messageId}`)

      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' })

        return
      }

      if (($atumOlderHistory.get()[conversationId] ?? 'idle') === 'exhausted') {
        return
      }

      await loadOlderAtumMessages(conversationId)
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
  }

  const conversation = roster.find(item => item.id === conversationId)

  const conversationPresentation = conversation
    ? presentAtumConversation(conversation, locale, { accountId: accountScopeId, people: socialRelationships }, catalog)
    : null

  const title = conversationPresentation?.title ?? t.dm.sectionTitle

  // Both per-app surfaces are exactly that: per APP. A person-to-person thread
  // never declares intake and never has an account to link.
  const isApp = conversation?.kind === 'specialist'
  const isGroup = conversation?.kind === 'group'
  const removedGroup = removedGroups[conversationId] === true
  const unsupported = conversation?.kind === 'unsupported'
  const groupDetail = groupDetails[conversationId]

  const groupRoom =
    groupDetail &&
    groupDetail.room.membershipEpoch === conversation?.group?.membershipEpoch &&
    groupDetail.room.revision >= conversation.group.revision
      ? groupDetail.room
      : conversation?.group

  const groupRetired = Boolean(groupRoom?.retiredAt)
  const privateAdvisory = groupRoom?.contextMode === 'private_advisory'
  const sharedGroup = groupRoom?.contextMode === 'shared_group'

  const groupAddressingEnabled = Boolean(
    isGroup &&
    (privateAdvisory
      ? groupCapabilities?.advisory?.enabled
      : sharedGroup
        ? groupCapabilities?.sharedAgents?.enabled
        : groupCapabilities?.addressing?.enabled) &&
    groupRoom &&
    !groupRetired
  )

  const groupAddressingMentionCardinality = groupCapabilities?.addressing?.mentionCardinality ?? 8

  const searchScope = `${accountScopeId ?? ''}:${conversationId}:${removedGroup ? 'removed' : 'active'}`

  if (searchRequest.current.scope !== searchScope) {
    searchRequest.current = { generation: searchRequest.current.generation + 1, scope: searchScope }
  }

  const roomPendingKey = `${conversationId}:${groupRoom?.membershipEpoch}:management`
  const reportPendingKey = `${conversationId}:${groupRoom?.membershipEpoch}:${reportTarget?.kind}:${reportTarget?.kind === 'message' ? reportTarget.messageId : reportTarget?.kind === 'specialist' ? reportTarget.specialist.specialist : reportTarget?.kind === 'assistant' ? reportTarget.assistant.assistantId : reportTarget?.member.userId}`
  const groupMembershipEpoch = groupRoom?.membershipEpoch
  const groupRevision = groupRoom?.revision
  useEffect(() => {
    void refreshGroupCapabilities().catch(() => {})
    void refreshGroupOperations().catch(() => {})

    if (groupMembershipEpoch) {
      void loadGroupDetail(conversationId)
    }
  }, [conversationId, groupRevision, groupMembershipEpoch, accountScopeId])
  useEffect(() => {
    setSearchResults([])
    setSearchQuery('')
    setSearchOpen(false)
    setGroupControlsOpen(false)
    setReportPicker(false)
    setReportTarget(null)
  }, [conversationId, removedGroup, accountScopeId])
  useEffect(() => {
    clearAtumGroupQuote()
  }, [accountScopeId, conversationId, groupMembershipEpoch, groupRetired])

  const socialRelationship = socialRelationships.find(
    row => row.availability === 'available' && row.directThreadId === conversationId
  )

  const canCompose =
    canComposeAtum(account.state, connectivity) &&
    (isApp ||
      (isGroup && Boolean(groupRoom) && !groupRetired && groupCapabilities?.available === true) ||
      (conversation?.kind === 'direct' && socialRelationship?.canMessage === true))

  const appId = isApp ? ((conversation?.payload?.specialist as string | undefined) ?? '').toLowerCase() : ''
  const { routes: appRoutes } = useAppRoutes(appId)
  const accountId = accountScopeId ?? ''
  const connection = useAppConnection(accountId, appId, isApp && canUseAppConnect(accountId, account.state))
  const appUseAllowed = !isApp || appConnectionAllowsUse(connection)
  // `intake.modal` is a capability the app advertises. When it declares a
  // capability list that omits it, no modal is ever opened for that app.
  const intakeAllowed = isApp && appUseAllowed && Boolean(appId) && allowsIntakeModal(conversation?.payload)
  const [intakeOpen, setIntakeOpen] = useState(false)
  const [intakeSettled, setIntakeSettled] = useState(false)
  const intakeRequired = intakeAllowed && !intakeSettled && intakeRequiredByLastTurn(messages)

  // A failed gated turn opens the form once. It is not re-opened after the user
  // closes it — the banner below stays as the deliberate way back in, so the
  // gate can never trap the window.
  const [autoOpenedFor, setAutoOpenedFor] = useState('')

  useEffect(() => {
    let current = true

    const memberEpoch = groupRoom?.membershipEpoch

    if (isGroup) {
      if (!groupAddressingEnabled || !accountScopeId || !conversationId || !memberEpoch) {
        setMentionTargets([])
        setMentionTargetState('denied')

        return () => {
          current = false
        }
      }

      setMentionTargetState('loading')
      setMentionTargets([])
      void Promise.resolve()
        .then(() => {
          const client = atumMessagingClient()

          if (!client.mentionTargets) {
            throw new Error('Group mention targets unavailable')
          }

          return client.mentionTargets(conversationId)
        })
        .then(result => {
          const stillCurrent =
            current &&
            $atumAccountScopeId.get() === accountScopeId &&
            $atumRoster.get().find(row => row.id === conversationId)?.group?.membershipEpoch === memberEpoch

          if (!stillCurrent) {
            return
          }

          // A legacy response is valid for a direct conversation but never a
          // group: group targeting must be negotiated and room-scoped.
          if (result.legacy) {
            setMentionTargets([])
            setMentionTargetState('denied')

            return
          }

          const targets = result.targets.filter(
            target => target.target.type === 'assistant' || target.target.type === 'specialist'
          )

          setMentionTargets(targets)
          setMentionCardinality(
            Math.min(privateAdvisory ? 1 : groupAddressingMentionCardinality, result.mentionCardinality)
          )
          setMentionTargetState(targets.length === 0 ? 'empty' : 'ready')
        })
        .catch(() => {
          if (current) {
            setMentionTargets([])
            setMentionTargetState('error')
          }
        })

      return () => {
        current = false
      }
    }

    if (isApp || !socialRelationship?.canMessage || !accountScopeId || !conversationId) {
      setMentionTargets([])
      setMentionTargetState('denied')

      return () => {
        current = false
      }
    }

    setMentionTargetState('loading')
    setMentionTargets([])
    // Resolve the bridge inside the promise boundary too: an unavailable
    // runtime must disable mention discovery without crashing the conversation.
    void Promise.resolve()
      .then(() => {
        const client = atumMessagingClient()

        if (!client.mentionTargets) {
          throw new Error('Mention targets unavailable')
        }

        return client.mentionTargets(conversationId)
      })
      .then(result => {
        if (!current) {
          return
        }

        const targets = result.legacy
          ? [LEGACY_ATUM_TARGET]
          : result.targets.filter(target => target.target.type === 'assistant')

        setMentionTargets(targets)
        setMentionCardinality(Math.min(8, result.mentionCardinality))
        setMentionTargetState(result.legacy ? 'legacy' : targets.length === 0 ? 'empty' : 'ready')
      })
      .catch(() => {
        if (current) {
          setMentionTargets([])
          setMentionTargetState('error')
        }
      })

    return () => {
      current = false
    }
  }, [
    accountScopeId,
    conversationId,
    groupAddressingEnabled,
    groupAddressingMentionCardinality,
    groupRevision,
    groupRoom?.membershipEpoch,
    isApp,
    isGroup,
    privateAdvisory,
    socialRelationship?.canMessage
  ])

  const groupQuote =
    !privateAdvisory && groupRoom && accountScopeId
      ? groupQuoteFor({ accountId: accountScopeId, conversationId, membershipEpoch: groupRoom.membershipEpoch })
      : null

  const replyMessage = replies[conversationId]
    ? (messages.find(message => message.id === replies[conversationId]) ?? null)
    : null

  const replySpecialist =
    !privateAdvisory && groupAddressingEnabled && replyMessage?.sender.type === 'specialist'
      ? ((groupRoom?.specialists ?? []).find(specialist => specialist.specialist === replyMessage.sender.id) ?? null)
      : null

  const replyAssistant =
    !privateAdvisory && groupAddressingEnabled && replyMessage?.sender.type === 'assistant'
      ? ((groupRoom?.assistants ?? []).find(assistant => assistant.assistantId === replyMessage.sender.id) ?? null)
      : null

  useEffect(() => {
    if (appRoutes && appUseAllowed) {
      ensureWorkbenchAppMenu(atumDmWorkbenchScopeKey(accountId, conversationId), appRoutes.app)
    }
  }, [accountId, appRoutes, appUseAllowed, conversationId])

  useEffect(() => {
    if (intakeRequired && autoOpenedFor !== conversationId) {
      setAutoOpenedFor(conversationId)
      setIntakeOpen(true)
    }
  }, [autoOpenedFor, conversationId, intakeRequired])

  useEffect(() => {
    setIntakeSettled(false)
    setIntakeOpen(false)
    setAutoOpenedFor('')
  }, [conversationId])

  const reauthenticate = () => {
    if (account.providers.google) {
      void signInToAtum()

      return
    }

    document.getElementById('atum-identifier')?.focus()
  }

  useEffect(() => {
    void initializeAtumMessaging()
  }, [])

  useEffect(() => {
    setAtumActiveConversation(conversationId || null)

    return () => setAtumActiveConversation(null)
  }, [conversationId])

  return (
    <main className="flex h-full min-h-0 flex-col bg-(--atum-chat-solid)">
      {groupRoom && (
        <div className="flex items-center justify-between gap-3 border-b border-(--atum-line) px-5 py-3">
          <div className="min-w-0">
            <h1 className="truncate font-semibold">{groupRoom.title}</h1>
            <p className="text-xs text-(--atum-ink-muted)">
              {groupRoom.contextMode === 'private_advisory'
                ? `${t.dm.group.advisory.title} · ${(groupRoom.advisors ?? []).map(advisor => advisor.displayName).join(', ')}`
                : sharedGroup
                  ? `${t.dm.group.sharedContextTitle} · ${groupRoom.members.length} · ${t.dm.group.members}`
                  : `${groupRoom.members.length} · ${t.dm.group.members}`}
            </p>
          </div>
          <Button onClick={() => setGroupControlsOpen(true)} size="sm" variant="outline">
            {t.dm.group.controlsLabel}
          </Button>
        </div>
      )}
      {groupRoom?.contextMode === 'private_advisory' && (
        <div className="px-5 py-2">
          <PrivateAdvisoryControls key={`${accountScopeId}:${conversationId}`} room={groupRoom} />
        </div>
      )}
      {groupRoom && (
        <Dialog onOpenChange={setGroupControlsOpen} open={groupControlsOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{groupRoom.title}</DialogTitle>
            </DialogHeader>
            <GroupRoomControls
              accountId={accountScopeId}
              capabilities={groupCapabilities}
              contacts={groupContacts(socialRelationships, roster, accountScopeId)}
              createOperationId={() => crypto.randomUUID()}
              key={`${accountScopeId}:${groupRoom.conversationId}:${groupRoom.membershipEpoch}`}
              onOperate={operateGroup}
              onPendingOperationChange={input => {
                if (accountScopeId !== $atumAccountScopeId.get()) {
                  return
                }

                const next = { ...$groupPendingManagement.get() }

                if (input) {
                  next[roomPendingKey] = input
                } else {
                  delete next[roomPendingKey]
                }

                $groupPendingManagement.set(next)
              }}
              onRequestReport={() => setReportPicker(true)}
              operationResults={groupOperations}
              pendingOperation={pendingManagement[roomPendingKey] ?? null}
              room={groupRoom}
              viewerUserId={accountId}
            />
            {reportPicker && (
              <div aria-label={t.dm.group.reportAction} className="grid gap-2">
                {groupRoom.members
                  .filter(member => member.userId !== accountId)
                  .map(member => (
                    <Button
                      key={member.userId}
                      onClick={() => {
                        setReportTarget({ kind: 'member', member })
                        setGroupControlsOpen(false)
                      }}
                      variant="outline"
                    >
                      {member.displayName} (@{member.handle})
                    </Button>
                  ))}
                {(groupRoom.specialists ?? []).map(specialist => (
                  <Button
                    key={`specialist:${specialist.specialist}`}
                    onClick={() => {
                      setReportTarget({ kind: 'specialist', specialist })
                      setGroupControlsOpen(false)
                    }}
                    variant="outline"
                  >
                    {specialist.avatar} {specialist.displayName}
                  </Button>
                ))}
                {(groupRoom.assistants ?? []).map(assistant => (
                  <Button
                    key={`assistant:${assistant.assistantId}`}
                    onClick={() => {
                      setReportTarget({ kind: 'assistant', assistant })
                      setGroupControlsOpen(false)
                    }}
                    variant="outline"
                  >
                    {assistant.displayName}
                  </Button>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
      {groupRoom && reportTarget && (
        <GroupRoomReportDialog
          createOperationId={() => crypto.randomUUID()}
          key={`${groupRoom.conversationId}:${reportTarget.kind}:${reportTarget.kind === 'message' ? reportTarget.messageId : reportTarget.kind === 'specialist' ? reportTarget.specialist.specialist : reportTarget.kind === 'assistant' ? reportTarget.assistant.assistantId : reportTarget.member.userId}`}
          onOpenChange={open => {
            if (!open) {
              setReportTarget(null)
            }
          }}
          onOperate={operateGroup}
          onPendingReportChange={input => {
            if (accountScopeId !== $atumAccountScopeId.get()) {
              return
            }

            const next = { ...$groupPendingReports.get() }

            if (input) {
              next[reportPendingKey] = input
            } else {
              delete next[reportPendingKey]
            }

            $groupPendingReports.set(next)
          }}
          open
          operationResults={groupOperations}
          pendingReport={pendingReports[reportPendingKey] ?? null}
          room={groupRoom}
          target={reportTarget}
        />
      )}
      {groupOperations.some(
        row => row.conversationId === conversationId && ['queued', 'sending', 'failed_retryable'].includes(row.state)
      ) && (
        <p className="px-5 py-2 text-xs text-(--atum-ink-muted)" role="status">
          {t.dm.group.operationQueued}
        </p>
      )}
      {groupRetired && (
        <p className="border-b border-(--atum-line) px-5 py-2 text-xs text-(--atum-ink-muted)" role="status">
          {t.dm.group.retiredReadOnly}
        </p>
      )}
      {isGroup && groupErrors[conversationId] && (
        <div className="flex items-center justify-between px-5 py-2 text-xs" role="alert">
          <span>{t.dm.errorGeneric}</span>
          <Button onClick={() => void loadGroupDetail(conversationId)} size="sm" variant="outline">
            {t.dm.retry}
          </Button>
        </div>
      )}
      {isGroup && groupDetail?.hasMore && (
        <Button
          disabled={groupLoading[conversationId]}
          onClick={() => void loadGroupDetail(conversationId, true)}
          size="sm"
          variant="ghost"
        >
          {t.dm.group.members}
        </Button>
      )}

      <Button
        aria-label={t.dm.searchMessages}
        className="absolute top-2 right-3 z-10"
        disabled={removedGroup || unsupported}
        onClick={() => setSearchOpen(value => !value)}
        size="icon"
        variant="ghost"
      >
        ⌕
      </Button>
      {searchOpen && (
        <div className="relative z-20 border-b border-(--atum-line) bg-(--atum-card) p-2">
          <input
            aria-label={t.dm.searchMessages}
            autoFocus
            className="h-9 w-full rounded-lg border bg-transparent px-3 text-sm"
            onChange={event => {
              const query = event.target.value
              setSearchQuery(query)

              const request = { generation: searchRequest.current.generation + 1, scope: searchScope }
              searchRequest.current = request

              if (query.trim()) {
                void atumMessagingClient()
                  .searchMessages(query, conversationId)
                  .then(results => {
                    if (
                      searchRequest.current.generation === request.generation &&
                      searchRequest.current.scope === request.scope &&
                      $atumAccountScopeId.get() === accountScopeId &&
                      !$atumRemovedGroups.get()[conversationId]
                    ) {
                      setSearchResults(results)
                    }
                  })
              } else {
                setSearchResults([])
              }
            }}
            placeholder={t.dm.searchPlaceholder}
            value={searchQuery}
          />
          {searchQuery.trim() && (
            <div className="max-h-56 overflow-auto pt-1">
              {searchResults.length === 0 ? (
                <p className="p-2 text-xs text-(--atum-ink-muted)">{t.dm.noSearchResults}</p>
              ) : (
                searchResults.map(result => (
                  <button
                    className="block w-full truncate rounded px-2 py-2 text-left text-xs hover:bg-(--atum-hover)"
                    key={result.message.id}
                    onClick={() => {
                      setSearchOpen(false)

                      if (result.message.id) {
                        void jumpToMessage(result.message.id)
                      }
                    }}
                  >
                    {result.message.content}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
      {(account.state === 'expired' || connectivity === 'auth_expired') && (
        <div
          className="flex items-center justify-between gap-4 border-b border-destructive/25 bg-destructive/8 px-5 py-2 text-xs"
          role="alert"
        >
          <span>{t.dm.authExpired}</span>
          <Button onClick={reauthenticate} size="sm" variant="outline">
            {t.dm.authExpiredAction}
          </Button>
        </div>
      )}
      {(account.state === 'error' || connectivity === 'error') && (
        <div
          className="flex items-center justify-between gap-4 border-b border-destructive/25 bg-destructive/8 px-5 py-2 text-xs"
          role="alert"
        >
          <span>{t.dm.errorGeneric}</span>
          <Button onClick={() => void refreshAtumStatus()} size="sm" variant="outline">
            {t.dm.retry}
          </Button>
        </div>
      )}
      {intakeRequired && (
        <div
          className="flex items-center justify-between gap-4 border-b border-(--atum-line-strong) bg-(--atum-sunk) px-5 py-2 text-xs"
          role="status"
        >
          <span className="text-(--atum-ink-soft)">{t.dm.intake.description}</span>
          <Button onClick={() => setIntakeOpen(true)} size="sm" variant="outline">
            {t.dm.intake.open}
          </Button>
        </div>
      )}
      {isApp && appId && (
        <DmConnectCard
          accountId={accountId}
          appId={appId}
          appName={title}
          enabled={canUseAppConnect(accountId, account.state)}
        />
      )}
      {!isApp && canCompose && conversation?.kind === 'direct' && socialRelationship?.canMessage === true && (
        <div
          className="border-b border-(--atum-line) bg-(--atum-sunk) px-5 py-2 text-xs text-(--atum-ink-soft)"
          data-dm-assistant-presence="explicit-mention"
          role="status"
        >
          <b>{t.dm.mention.presenceTitle}</b> {t.dm.mention.presenceDisclosure}
        </div>
      )}
      {intakeAllowed && (
        <DmIntakeDialog
          appId={appId}
          appName={title}
          onComplete={() => setIntakeSettled(true)}
          onOpenChange={setIntakeOpen}
          open={intakeOpen}
        />
      )}
      <DmMessageList
        accountId={accountId || null}
        emptyContent={
          removedGroup || unsupported ? (
            <p className="px-6 text-sm text-(--atum-ink-muted)" role="status">
              {removedGroup ? t.dm.group.membershipEnded : t.dm.group.unavailable}
            </p>
          ) : connectivity === 'loading' ? (
            <p className="text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink-muted)">
              {t.dm.loadingMessages}
            </p>
          ) : (
            <DmEmptyState
              avatarUrl={conversationPresentation?.avatarUrl ?? ''}
              role={conversationPresentation?.role ?? ''}
              title={title}
            />
          )
        }
        groupAdvisors={privateAdvisory ? groupRoom?.advisors : undefined}
        groupMembers={isGroup ? groupRoom?.members : undefined}
        groupSpecialists={isGroup ? groupRoom?.specialists : undefined}
        immutable={groupRetired || removedGroup || unsupported}
        membershipEvents={isGroup ? groupDetail?.events : undefined}
        messages={removedGroup || unsupported ? [] : messages}
        olderState={olderHistory[conversationId] ?? 'idle'}
        onEdit={(messageId, content) => void editAtumMessage(messageId, content)}
        onJumpToMessage={messageId => void jumpToMessage(messageId)}
        onLoadOlder={() => void loadOlderAtumMessages(conversationId)}
        onQuote={
          !privateAdvisory && groupAddressingEnabled && groupRoom && accountScopeId
            ? message => {
                if (
                  !message.id ||
                  message.recalledAt ||
                  [...message.content].length > (groupCapabilities?.addressing?.quoteLimit ?? 4000)
                ) {
                  return
                }

                setAtumGroupQuote({
                  accountId: accountScopeId,
                  conversationId,
                  membershipEpoch: groupRoom.membershipEpoch,
                  messageId: message.id,
                  sourceVersion: message.version,
                  preview: message.content
                })
              }
            : undefined
        }
        onReact={(messageId, emoji) => void toggleAtumReaction(messageId, emoji)}
        onRecall={messageId => void recallAtumMessage(messageId)}
        onReply={message => message.id && setAtumReplyTo(conversationId, message.id)}
        onReport={
          isGroup ? messageId => setReportTarget({ kind: 'message', messageId, label: t.dm.searchMessages }) : undefined
        }
        onRetry={clientMessageId => {
          if (appUseAllowed) {
            void retryAtumMessage(clientMessageId)
          }
        }}
        quoteEnabled={!privateAdvisory && groupAddressingEnabled}
        quoteLimit={groupCapabilities?.addressing?.quoteLimit ?? 4000}
        readMessageId={!isGroup && conversation ? counterpartReadMessageId(conversation.payload, accountId) : null}
        retryLabel={t.dm.retry}
      />
      {!isGroup && !removedGroup && typing[conversationId] && (
        <div className="px-6 text-xs text-(--atum-ink-muted)" role="status">
          {t.dm.typing}
        </div>
      )}
      {!removedGroup && !unsupported && !groupRetired && (
        <DmComposer
          accountId={accountId}
          appRoutes={appUseAllowed ? appRoutes : null}
          conversationId={conversationId}
          disabled={!canCompose}
          key={`${accountId}:${conversationId}`}
          mediaEnabled={!isGroup && appUseAllowed}
          mentionCardinality={mentionCardinality}
          mentionEnabled={conversation?.kind === 'direct' || groupAddressingEnabled}
          mentionTargets={mentionTargets}
          mentionTargetState={mentionTargetState}
          onClearQuote={quote => {
            if (groupQuote?.messageId === quote.messageId && groupQuote.sourceVersion === quote.sourceVersion) {
              clearAtumGroupQuote()
            }
          }}
          placeholder={
            connectivity === 'reconnecting' || connectivity === 'offline_cached'
              ? t.atum.offline.reconnecting
              : undefined
          }
          privateAdvisory={privateAdvisory}
          quotedMessage={groupQuote}
          replyAssistant={replyAssistant}
          replySpecialist={replySpecialist}
          sendDisabled={!appUseAllowed}
          sharedGroup={sharedGroup}
          specialistAddressingEnabled={groupAddressingEnabled}
          typingEnabled={!isGroup}
        />
      )}
    </main>
  )
}

function DmEmptyState({
  avatarUrl,
  role,
  title
}: {
  avatarUrl: string
  role: string
  title: string
}) {
  const { t } = useI18n()

  return (
    <div className="flex max-w-sm flex-col items-center px-6 text-center">
      {avatarUrl ? (
        <img alt="" className="atum-avatar size-14 object-cover" src={avatarUrl} />
      ) : (
        <span className="grid size-14 place-items-center rounded-2xl bg-(--atum-sunk) text-lg font-semibold text-(--atum-ink-soft) shadow-(--atum-shadow-row)">
          {title.slice(0, 1).toLocaleUpperCase()}
        </span>
      )}
      <div className="mt-4 flex items-center justify-center gap-1.5">
        <h2 className="text-(length:--atum-t-section) leading-(--atum-lh-section) font-semibold tracking-[-0.01em] text-(--atum-ink)">
          {t.dm.startConversation(title)}
        </h2>
      </div>
      {role && (
        <p className="mt-1 text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-muted)">{role}</p>
      )}
    </div>
  )
}
