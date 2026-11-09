import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ErrorBanner } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'
import { setWorkspaceOpen } from '@/store/atum-shell'
import { atumDmWorkbenchScopeKey, openWorkbenchAppView } from '@/store/workbench-tabs'

import type {
  AdvisorTarget,
  GroupAssistant,
  GroupCapabilities,
  GroupMember,
  GroupOperationInput,
  GroupOperationResult,
  GroupRoom
} from '../../../shared/atum-group-conversations'
import { useAppRoutes } from '../atum/use-app-routes'

import { GroupParticipantIdentity } from './group-participant-identity'
import { SharedGroupPersonaApprovalDialog } from './shared-group-persona-approval-dialog'

export interface GroupRoomContact {
  userId: string
  displayName: string
  handle: string
}

export type GroupRoomManagementOperation = Exclude<GroupOperationInput, { action: 'create' | 'report' }>

export interface GroupRoomControlsProps {
  capabilities: GroupCapabilities | null
  accountId?: string | null
  contacts: readonly GroupRoomContact[]
  createOperationId: () => string
  onOperate: (input: GroupOperationInput) => Promise<GroupOperationResult>
  /** Parent-owned copy survives a closed controls dialog unmounting. */
  onPendingOperationChange?: (input: GroupRoomManagementOperation | null) => void
  onRequestReport: () => void
  operationResults?: readonly GroupOperationResult[]
  pendingOperation?: GroupRoomManagementOperation | null
  room: GroupRoom
  viewerUserId: string
}

type ControlResult = GroupOperationResult | null

type RoomManagementInput =
  | { action: 'add_member' | 'remove_member' | 'transfer_owner'; conversationId: string; targetUserId: string }
  | { action: 'leave' | 'retire'; conversationId: string }
  | { action: 'rename'; conversationId: string; title: string }
  | { action: 'add_specialist' | 'remove_specialist'; conversationId: string; specialist: string }
  | { action: 'add_assistant' | 'remove_assistant'; conversationId: string; assistantId: string }
  | {
      action: 'add_advisor' | 'remove_advisor'
      conversationId: string
      target: AdvisorTarget
      audienceRevision: number
    }

function memberLabel(member: Pick<GroupMember, 'displayName' | 'handle'>): string {
  return member.handle ? `${member.displayName} (@${member.handle})` : member.displayName
}

function resultCopy(result: GroupOperationResult, copy: ReturnType<typeof useI18n>['t']['dm']['group']): string {
  if (result.state === 'queued') {
    return copy.operationQueued
  }

  if (result.state === 'sending') {
    return copy.operationSending
  }

  if (result.state === 'sent') {
    return copy.operationSent
  }

  if (result.state === 'conflicted') {
    return copy.operationConflicted
  }

  return copy.operationFailed
}

function SpecialistPanelEntry({
  accountId,
  conversationId,
  specialist
}: {
  accountId: string | null | undefined
  conversationId: string
  specialist: string
}) {
  const { locale, t } = useI18n()
  const { routes } = useAppRoutes(specialist)

  const route = routes?.launch
    ? (routes.routes.find(candidate => candidate.placements.includes('menu')) ?? routes.routes[0])
    : null

  if (!route || !routes) {
    return null
  }

  return (
    <Button
      onClick={() => {
        openWorkbenchAppView(
          routes.app,
          route.id,
          locale === 'vi' ? route.label.vi : route.label.en,
          atumDmWorkbenchScopeKey(accountId, conversationId)
        )
        setWorkspaceOpen(true)
      }}
      size="xs"
      type="button"
      variant="ghost"
    >
      {t.dm.group.openSpecialist}
    </Button>
  )
}

function AssistantMemberEntry({
  assistant,
  canRemove,
  disabled,
  onRemove
}: {
  assistant: GroupAssistant
  canRemove: boolean
  disabled: boolean
  onRemove: () => void
}) {
  const { t } = useI18n()

  return (
    <li className="flex items-center justify-between gap-3 rounded-[var(--atum-r-control)] bg-(--atum-sunk) px-3 py-2">
      <GroupParticipantIdentity
        assistant={assistant}
        displayName={assistant.displayName}
        status={
          assistant.availability === 'available' ? undefined : t.dm.group.assistantTargetState(assistant.availability)
        }
        target={{ type: 'assistant', id: assistant.assistantId }}
      />
      {canRemove && (
        <Button disabled={disabled} onClick={onRemove} size="xs" type="button" variant="ghost">
          {t.dm.group.remove}
        </Button>
      )}
    </li>
  )
}

/**
 * Controlled room-management surface. It receives server projections and emits
 * only typed, idempotent GroupOperationInput records; it owns no navigation or
 * transport and never treats a queued record as a completed mutation.
 */
export function GroupRoomControls({
  accountId,
  capabilities,
  contacts,
  createOperationId,
  onOperate,
  onPendingOperationChange,
  onRequestReport,
  operationResults,
  pendingOperation: controlledPendingOperation,
  room,
  viewerUserId
}: GroupRoomControlsProps) {
  const { t } = useI18n()
  const copy = t.dm.group
  const [title, setTitle] = useState(room.title)
  const [pendingAction, setPendingAction] = useState<GroupOperationInput['action'] | null>(null)
  const [localPendingOperation, setLocalPendingOperation] = useState<GroupRoomManagementOperation | null>(null)
  const [result, setResult] = useState<ControlResult>(null)
  const [failure, setFailure] = useState(false)
  const [reviewAssistant, setReviewAssistant] = useState<GroupAssistant | null>(null)
  const viewer = room.members.find(member => member.userId === viewerUserId) ?? null
  const owner = viewer?.role === 'owner'
  const retired = room.retiredAt !== null
  const active = viewer !== null
  const mutable = Boolean(capabilities?.available && active && !retired)
  const titleValue = title.trim()
  const addableContacts = contacts.filter(contact => !room.members.some(member => member.userId === contact.userId))
  const canAddMember = mutable && room.members.length < Math.max(1, capabilities?.humanMemberLimit ?? 1)
  const addressing = capabilities?.addressing
  const privateMode = room.contextMode === 'private_advisory'
  const sharedGroup = room.contextMode === 'shared_group'
  const specialists = privateMode ? [] : (room.specialists ?? [])
  const assistants = sharedGroup ? (room.assistants ?? []) : []
  const advisors = room.advisors ?? []

  const addableAdvisors = (capabilities?.advisory?.advisorCatalog ?? []).filter(
    candidate =>
      !advisors.some(
        advisor => advisor.target.type === candidate.target.type && advisor.target.id === candidate.target.id
      )
  )

  const canAddSpecialist = Boolean(
    !privateMode && mutable && addressing?.enabled && specialists.length < addressing.specialistMemberLimit
  )

  const addableAssistants = (sharedGroup ? (capabilities?.sharedAgents?.assistantCatalog ?? []) : []).filter(
    candidate =>
      candidate.ownerUserId === viewerUserId &&
      candidate.availability === 'available' &&
      !assistants.some(member => member.assistantId === candidate.assistantId)
  )

  const reviewableAssistants = (sharedGroup ? (capabilities?.sharedAgents?.assistantCatalog ?? []) : []).filter(
    candidate => candidate.ownerUserId === viewerUserId && candidate.availability === 'assistant_not_approved'
  )

  const canAddAssistant = Boolean(
    sharedGroup &&
    owner &&
    mutable &&
    capabilities?.sharedAgents?.enabled &&
    assistants.length < Math.min(4, capabilities.sharedAgents.assistantMemberLimit)
  )

  const addableSpecialists = (privateMode ? [] : (addressing?.specialistCatalog ?? [])).filter(
    candidate => !specialists.some(member => member.specialist === candidate.specialist)
  )

  const pendingInput = controlledPendingOperation ?? localPendingOperation

  const persistedResult = pendingInput
    ? (operationResults?.find(candidate => candidate.operationId === pendingInput.clientOperationId) ?? null)
    : null

  const activeResult =
    persistedResult?.state === 'sent' ||
    persistedResult?.state === 'failed_terminal' ||
    persistedResult?.state === 'conflicted'
      ? persistedResult
      : (result ?? persistedResult)

  const lockedByPendingInput = pendingInput !== null

  const setPendingOperation = useCallback(
    (input: GroupRoomManagementOperation | null) => {
      setLocalPendingOperation(input)
      onPendingOperationChange?.(input)
    },
    [onPendingOperationChange]
  )

  useEffect(() => {
    if (!pendingInput || !activeResult) {
      return
    }

    if (
      activeResult.state === 'sent' ||
      activeResult.state === 'failed_terminal' ||
      activeResult.state === 'conflicted'
    ) {
      setPendingOperation(null)
    }
  }, [activeResult, pendingInput, setPendingOperation])

  const submit = async (input: GroupRoomManagementOperation) => {
    setFailure(false)
    setResult(null)
    setPendingAction(input.action)
    setPendingOperation(input)

    try {
      const outcome = await onOperate(input)
      setResult(outcome)

      if (outcome.state === 'sent' && privateMode && (input.action === 'remove_advisor' || input.action === 'retire')) {
        await window.hermesDesktop?.advisoryRunner
          ?.cancelConversation(room.conversationId, input.action === 'remove_advisor' ? input.target.id : undefined)
          .catch(() => {})
      }
    } catch {
      setFailure(true)
    } finally {
      setPendingAction(null)
    }
  }

  const operation = (input: RoomManagementInput) => {
    if (pendingInput) {
      return
    }

    void submit({ ...input, clientOperationId: createOperationId() })
  }

  if (!capabilities?.available) {
    return <ErrorBanner>{copy.unavailable}</ErrorBanner>
  }

  return (
    <section aria-label={copy.controlsLabel} className="grid gap-4">
      {retired && (
        <p className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
          {copy.retiredReadOnly}
        </p>
      )}
      {!active && <ErrorBanner>{copy.membershipEnded}</ErrorBanner>}
      {privateMode && <p className="text-xs text-(--atum-ink-muted)">{copy.advisory.disclosure}</p>}

      <div className="grid gap-2">
        <h2 className="text-(length:--atum-t-body) leading-(--atum-lh-body) font-semibold text-(--atum-ink)">
          {copy.members}
        </h2>
        <ul aria-label={copy.members} className="grid gap-1">
          {room.members.map(member => (
            <li
              className="flex items-center justify-between gap-3 rounded-[var(--atum-r-control)] bg-(--atum-sunk) px-3 py-2"
              key={member.userId}
            >
              <span className="min-w-0 truncate text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink)">
                {memberLabel(member)} {member.role === 'owner' ? `· ${copy.owner}` : ''}
              </span>
              {owner && mutable && member.userId !== viewerUserId && (
                <div className="flex shrink-0 gap-1">
                  <Tip label={copy.transferOwner}>
                    <Button
                      disabled={pendingAction !== null || lockedByPendingInput}
                      onClick={() =>
                        operation({
                          action: 'transfer_owner',
                          conversationId: room.conversationId,
                          targetUserId: member.userId
                        })
                      }
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      {copy.transfer}
                    </Button>
                  </Tip>
                  <Tip label={copy.removeMember(member.displayName)}>
                    <Button
                      disabled={pendingAction !== null || lockedByPendingInput}
                      onClick={() =>
                        operation({
                          action: 'remove_member',
                          conversationId: room.conversationId,
                          targetUserId: member.userId
                        })
                      }
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {copy.remove}
                    </Button>
                  </Tip>
                </div>
              )}
            </li>
          ))}
          {specialists.map(specialist => (
            <li
              className="flex items-center justify-between gap-3 rounded-[var(--atum-r-control)] bg-(--atum-sunk) px-3 py-2"
              key={`specialist:${specialist.specialist}`}
            >
              <GroupParticipantIdentity
                displayName={specialist.displayName}
                status={
                  specialist.availability === 'available'
                    ? undefined
                    : copy.specialistTargetState(specialist.availability)
                }
                target={{ type: 'specialist', id: specialist.specialist }}
              />
              <div className="flex shrink-0 gap-1">
                <SpecialistPanelEntry
                  accountId={accountId}
                  conversationId={room.conversationId}
                  specialist={specialist.specialist}
                />
                {owner && mutable && (
                  <Button
                    disabled={pendingAction !== null || lockedByPendingInput}
                    onClick={() =>
                      operation({
                        action: 'remove_specialist',
                        conversationId: room.conversationId,
                        specialist: specialist.specialist
                      })
                    }
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    {copy.remove}
                  </Button>
                )}
              </div>
            </li>
          ))}
          {assistants.map(assistant => (
            <AssistantMemberEntry
              assistant={assistant}
              canRemove={Boolean(owner && mutable)}
              disabled={pendingAction !== null || lockedByPendingInput}
              key={`assistant:${assistant.assistantId}`}
              onRemove={() =>
                operation({
                  action: 'remove_assistant',
                  conversationId: room.conversationId,
                  assistantId: assistant.assistantId
                })
              }
            />
          ))}
          {privateMode &&
            advisors.map(advisor => (
              <li
                className="flex items-center justify-between gap-3"
                key={`${advisor.target.type}:${advisor.target.id}`}
              >
                <GroupParticipantIdentity
                  displayName={advisor.displayName}
                  status={advisor.availability === 'available' ? undefined : copy.advisory.unavailable}
                  target={advisor.target}
                />
                <div className="flex gap-1">
                  {advisor.target.type === 'specialist' && (
                    <SpecialistPanelEntry
                      accountId={accountId}
                      conversationId={room.conversationId}
                      specialist={advisor.target.id}
                    />
                  )}
                  {owner && mutable && (
                    <Button
                      disabled={pendingAction !== null || lockedByPendingInput}
                      onClick={() =>
                        operation({
                          action: 'remove_advisor',
                          conversationId: room.conversationId,
                          target: advisor.target,
                          audienceRevision: room.audienceRevision!
                        })
                      }
                      size="xs"
                      variant="ghost"
                    >
                      {copy.remove}
                    </Button>
                  )}
                </div>
              </li>
            ))}
        </ul>
      </div>

      {owner && mutable && (
        <div className="grid gap-2">
          <label
            className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) font-medium text-(--atum-ink-muted)"
            htmlFor="atum-group-title"
          >
            {copy.roomName}
          </label>
          <div className="flex gap-2">
            <Input
              disabled={pendingAction !== null || lockedByPendingInput}
              id="atum-group-title"
              maxLength={160}
              onChange={event => setTitle(event.target.value)}
              value={title}
            />
            <Button
              disabled={
                pendingAction !== null ||
                lockedByPendingInput ||
                [...titleValue].length < 1 ||
                [...titleValue].length > 80 ||
                titleValue === room.title
              }
              onClick={() => operation({ action: 'rename', conversationId: room.conversationId, title: titleValue })}
              size="sm"
              type="button"
            >
              {copy.rename}
            </Button>
          </div>
          {!privateMode && addableContacts.length > 0 && (
            <div className="grid gap-1">
              <span className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                {copy.addMember}
              </span>
              <p className="text-xs text-(--atum-ink-muted)">{copy.create.historyDisclosure}</p>
              <div className="flex flex-wrap gap-1">
                {addableContacts.map(contact => (
                  <Button
                    disabled={pendingAction !== null || lockedByPendingInput || !canAddMember}
                    key={contact.userId}
                    onClick={() =>
                      operation({
                        action: 'add_member',
                        conversationId: room.conversationId,
                        targetUserId: contact.userId
                      })
                    }
                    size="xs"
                    type="button"
                    variant="secondary"
                  >
                    {memberLabel(contact)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {addableSpecialists.length > 0 && (
            <div className="grid gap-1">
              <span className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                {copy.addSpecialist}
              </span>
              <div className="flex flex-wrap gap-1">
                {addableSpecialists.map(specialist => (
                  <Button
                    disabled={pendingAction !== null || lockedByPendingInput || !canAddSpecialist}
                    key={specialist.specialist}
                    onClick={() =>
                      operation({
                        action: 'add_specialist',
                        conversationId: room.conversationId,
                        specialist: specialist.specialist
                      })
                    }
                    size="default"
                    type="button"
                    variant="secondary"
                  >
                    <GroupParticipantIdentity
                      displayName={specialist.displayName}
                      status={specialist.roomSupported ? undefined : copy.create.specialistUnsupported}
                      target={{ type: 'specialist', id: specialist.specialist }}
                    />
                  </Button>
                ))}
              </div>
            </div>
          )}
          {sharedGroup && addableAssistants.length > 0 && (
            <div className="grid gap-1">
              <span className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                {copy.addAssistant}
              </span>
              <div className="flex flex-wrap gap-1">
                {addableAssistants.map(assistant => (
                  <Button
                    disabled={pendingAction !== null || lockedByPendingInput || !canAddAssistant}
                    key={assistant.assistantId}
                    onClick={() =>
                      operation({
                        action: 'add_assistant',
                        conversationId: room.conversationId,
                        assistantId: assistant.assistantId
                      })
                    }
                    size="default"
                    type="button"
                    variant="secondary"
                  >
                    <GroupParticipantIdentity
                      assistant={assistant}
                      displayName={assistant.displayName}
                      target={{ type: 'assistant', id: assistant.assistantId }}
                    />
                  </Button>
                ))}
              </div>
            </div>
          )}
          {sharedGroup && reviewableAssistants.length > 0 && (
            <div className="grid gap-1">
              <span className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                {copy.addAssistant}
              </span>
              <div className="flex flex-wrap gap-1">
                {reviewableAssistants.map(assistant => (
                  <Button
                    key={`review:${assistant.assistantId}`}
                    onClick={() => setReviewAssistant(assistant)}
                    size="default"
                    type="button"
                    variant="secondary"
                  >
                    {copy.persona.review}: {assistant.displayName}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {privateMode && addableAdvisors.length > 0 && (
            <div className="grid gap-1">
              <span>{copy.advisory.add}</span>
              <p className="text-xs text-(--atum-ink-muted)">{copy.advisory.historyDisclosure}</p>
              <div className="flex flex-wrap gap-1">
                {addableAdvisors.map(advisor => (
                  <Button
                    disabled={
                      pendingAction !== null ||
                      lockedByPendingInput ||
                      !capabilities.advisory?.enabled ||
                      advisor.availability !== 'available' ||
                      advisors.length >= (capabilities.advisory?.advisorLimit ?? 0)
                    }
                    key={`${advisor.target.type}:${advisor.target.id}`}
                    onClick={() =>
                      operation({
                        action: 'add_advisor',
                        conversationId: room.conversationId,
                        target: advisor.target,
                        audienceRevision: room.audienceRevision!
                      })
                    }
                    size="default"
                    variant="secondary"
                  >
                    <GroupParticipantIdentity
                      displayName={advisor.displayName}
                      status={advisor.availability === 'available' ? undefined : copy.advisory.unavailable}
                      target={advisor.target}
                    />
                  </Button>
                ))}
              </div>
            </div>
          )}
          <Button
            disabled={pendingAction !== null || lockedByPendingInput}
            onClick={() => operation({ action: 'retire', conversationId: room.conversationId })}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy.retire}
          </Button>
        </div>
      )}

      {active && (
        <div className="flex flex-wrap gap-2">
          {owner && !retired ? (
            <p className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
              {privateMode ? copy.advisory.ownerBoundary : copy.ownerTransferBeforeLeave}
            </p>
          ) : (
            <Button
              disabled={pendingAction !== null || lockedByPendingInput}
              onClick={() => operation({ action: 'leave', conversationId: room.conversationId })}
              size="sm"
              type="button"
              variant="outline"
            >
              {copy.leave}
            </Button>
          )}
          <Button onClick={onRequestReport} size="sm" type="button" variant="ghost">
            {copy.reportAction}
          </Button>
        </div>
      )}

      {pendingAction && (
        <div
          className="flex items-center gap-2 text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)"
          role="status"
        >
          <Spinner className="size-4 animate-spin" /> {copy.operationSending}
        </div>
      )}
      {activeResult && (
        <p role={activeResult.state === 'failed_terminal' || activeResult.state === 'conflicted' ? 'alert' : 'status'}>
          {resultCopy(activeResult, copy)}
        </p>
      )}
      {failure && (
        <div className="flex items-center gap-2">
          <ErrorBanner>{copy.operationFailed}</ErrorBanner>
          {pendingInput && (
            <Button
              disabled={pendingAction !== null}
              onClick={() => void submit(pendingInput)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t.dm.retry}
            </Button>
          )}
        </div>
      )}
      {reviewAssistant && (
        <SharedGroupPersonaApprovalDialog
          assistant={reviewAssistant}
          onOpenChange={next => {
            if (!next) {
              setReviewAssistant(null)
            }
          }}
          open
        />
      )}
    </section>
  )
}
