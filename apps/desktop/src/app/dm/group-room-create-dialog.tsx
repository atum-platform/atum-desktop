import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'

import type {
  AdvisoryAdvisor,
  GroupAssistant,
  GroupCapabilities,
  GroupOperationInput,
  GroupOperationResult,
  GroupSpecialistOption
} from '../../../shared/atum-group-conversations'

import { GroupParticipantIdentity } from './group-participant-identity'
import type { GroupRoomContact } from './group-room-controls'
import { SharedGroupPersonaApprovalDialog } from './shared-group-persona-approval-dialog'

export type GroupCreateInput = Extract<GroupOperationInput, { action: 'create' }>

export interface GroupRoomCreateDialogProps {
  capabilities: GroupCapabilities | null
  contacts: readonly GroupRoomContact[]
  createOperationId: () => string
  onCreated?: (result: GroupOperationResult) => void
  onOpenChange: (open: boolean) => void
  onOperate: (input: GroupOperationInput) => Promise<GroupOperationResult>
  /** Parent-owned copy survives a temporary dialog unmount. */
  onPendingCreateChange?: (input: GroupCreateInput | null) => void
  operationResults?: readonly GroupOperationResult[]
  open: boolean
  pendingCreate?: GroupCreateInput | null
}

interface PickerApp {
  id: string
  displayName: string
  availability: string
  roomSupported: boolean
}
interface PickerAgent {
  assistant?: GroupAssistant
  id: string
  displayName: string
  availability: string
}

function appCatalog(capabilities: GroupCapabilities | null, privateMode: boolean): PickerApp[] {
  const apps = new Map<string, PickerApp>()

  const add = (entry: GroupSpecialistOption | AdvisoryAdvisor) => {
    const id = 'specialist' in entry ? entry.specialist : entry.target.id

    const availability =
      'target' in entry
        ? entry.availability
        : privateMode
          ? (apps.get(id)?.availability ?? 'unsupported')
          : entry.roomSupported
            ? 'available'
            : 'unsupported'

    apps.set(id, {
      id,
      displayName: entry.displayName,
      availability,
      roomSupported: 'target' in entry ? false : entry.roomSupported
    })
  }

  for (const entry of capabilities?.advisory?.advisorCatalog ?? []) {
    if (entry.target.type === 'specialist') {
      add(entry)
    }
  }

  for (const entry of capabilities?.addressing?.specialistCatalog ?? []) {
    add(entry)
  }

  return [...apps.values()]
}

function agentCatalog(capabilities: GroupCapabilities | null, privateMode: boolean): PickerAgent[] {
  const agents = new Map<string, PickerAgent>()

  for (const entry of capabilities?.advisory?.advisorCatalog ?? []) {
    if (entry.target.type === 'assistant') {
      agents.set(entry.target.id, {
        id: entry.target.id,
        displayName: entry.displayName,
        availability: privateMode ? entry.availability : 'unavailable'
      })
    }
  }

  for (const entry of capabilities?.sharedAgents?.assistantCatalog ?? []) {
    agents.set(entry.assistantId, {
      assistant: entry,
      id: entry.assistantId,
      displayName: entry.displayName,
      availability: privateMode
        ? (agents.get(entry.assistantId)?.availability ?? 'assistant_not_owned')
        : entry.availability
    })
  }

  return [...agents.values()]
}

/** Controlled create sheet; a queued operation remains visibly queued. */
export function GroupRoomCreateDialog({
  capabilities,
  contacts,
  createOperationId,
  onCreated,
  onOpenChange,
  onOperate,
  onPendingCreateChange,
  operationResults,
  pendingCreate: controlledPendingCreate,
  open
}: GroupRoomCreateDialogProps) {
  const { t } = useI18n()
  const copy = t.dm.group.create
  const [title, setTitle] = useState('')
  const [selectedPeople, setSelectedPeople] = useState<readonly string[]>([])
  const [selectedApps, setSelectedApps] = useState<readonly string[]>([])
  const [selectedAgents, setSelectedAgents] = useState<readonly string[]>([])
  const [reviewAssistant, setReviewAssistant] = useState<GroupAssistant | null>(null)

  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<GroupOperationResult | null>(null)
  const [failed, setFailed] = useState(false)
  const [localPendingCreate, setLocalPendingCreate] = useState<GroupCreateInput | null>(null)
  const handledFinalResult = useRef('')
  const submission = useRef<string | null>(null)
  const pendingCreate = controlledPendingCreate ?? localPendingCreate
  const maximum = Math.max(1, capabilities?.humanMemberLimit ?? 1)
  const maximumContacts = Math.max(0, maximum - 1)
  const titleValue = title.trim()
  const peopleSet = useMemo(() => new Set(selectedPeople), [selectedPeople])
  const appsSet = useMemo(() => new Set(selectedApps), [selectedApps])
  const agentsSet = useMemo(() => new Set(selectedAgents), [selectedAgents])
  const hasOtherPerson = selectedPeople.length > 0
  const sharedEnabled = capabilities?.sharedAgents?.enabled === true

  // A retry is the exact operation originally sent. Capability refreshes may
  // make a new create impossible, but cannot reinterpret a durable intent.
  const contextMode = pendingCreate
    ? (pendingCreate.contextMode ?? 'ordinary')
    : hasOtherPerson
      ? sharedEnabled
        ? 'shared_group'
        : 'ordinary'
      : 'private_advisory'

  const privateMode = contextMode === 'private_advisory'
  const apps = useMemo(() => appCatalog(capabilities, privateMode), [capabilities, privateMode])
  const agents = useMemo(() => agentCatalog(capabilities, privateMode), [capabilities, privateMode])

  const appLimit = privateMode
    ? (capabilities?.advisory?.advisorLimit ?? 0)
    : (capabilities?.addressing?.specialistMemberLimit ?? 0)

  const agentLimit = privateMode
    ? (capabilities?.advisory?.advisorLimit ?? 0)
    : (capabilities?.sharedAgents?.assistantMemberLimit ?? 0)

  const hasSelection = hasOtherPerson || selectedApps.length + selectedAgents.length > 0
  const requiresUnavailableSharedAgent = hasOtherPerson && selectedAgents.length > 0 && !sharedEnabled
  const requiresUnavailableSharedMode = contextMode === 'shared_group' && !sharedEnabled

  const createEnabled =
    capabilities?.available === true &&
    (contextMode === 'private_advisory' ? capabilities.advisory?.enabled === true : capabilities.creationEnabled) &&
    !requiresUnavailableSharedAgent &&
    !requiresUnavailableSharedMode

  const appAvailable = (app: PickerApp) => (privateMode ? app.availability === 'available' : app.roomSupported)
  const agentAvailable = (agent: PickerAgent) => agent.availability === 'available' && (privateMode || sharedEnabled)

  const selectionAvailable =
    selectedPeople.length <= maximumContacts &&
    selectedPeople.every(id => contacts.some(contact => contact.userId === id)) &&
    selectedApps.every(id => apps.some(app => app.id === id && appAvailable(app))) &&
    selectedAgents.every(id => agents.some(agent => agent.id === id && agentAvailable(agent))) &&
    selectedApps.length <= appLimit &&
    selectedAgents.length <= agentLimit &&
    (!privateMode || selectedApps.length + selectedAgents.length <= (capabilities?.advisory?.advisorLimit ?? 0))

  const canCreate =
    createEnabled &&
    (capabilities?.createDefaults || titleValue.length > 0) &&
    [...titleValue].length <= 80 &&
    hasSelection &&
    selectionAvailable

  useEffect(() => {
    if (!pendingCreate) {
      setSelectedPeople(current => {
        const available = current.filter(id => contacts.some(contact => contact.userId === id))

        return available.length === current.length ? current : available
      })
    }
  }, [contacts, pendingCreate])

  useEffect(
    () => () => {
      submission.current = null
    },
    []
  )

  const setPendingCreate = useCallback(
    (input: GroupCreateInput | null) => {
      setLocalPendingCreate(input)
      onPendingCreateChange?.(input)
    },
    [onPendingCreateChange]
  )

  const persistedResult = pendingCreate
    ? (operationResults?.find(candidate => candidate.operationId === pendingCreate.clientOperationId) ?? null)
    : null

  const submittedResult = result?.operationId === pendingCreate?.clientOperationId ? result : null

  const activeResult =
    persistedResult?.state === 'sent' ||
    persistedResult?.state === 'failed_terminal' ||
    persistedResult?.state === 'conflicted'
      ? persistedResult
      : (submittedResult ?? persistedResult)

  useEffect(() => {
    if (!pendingCreate || !activeResult) {
      return
    }

    const resolution = `${pendingCreate.clientOperationId}:${activeResult.state}`

    if (handledFinalResult.current === resolution) {
      return
    }

    if (activeResult.state === 'sent') {
      handledFinalResult.current = resolution
      submission.current = null
      setPending(false)
      setPendingCreate(null)
      setTitle('')
      setSelectedPeople([])
      setSelectedApps([])
      setSelectedAgents([])
      setResult(null)
      setFailed(false)
      onCreated?.(activeResult)
      onOpenChange(false)
    } else if (activeResult.state === 'failed_terminal' || activeResult.state === 'conflicted') {
      handledFinalResult.current = resolution
      submission.current = null
      setPending(false)
      setPendingCreate(null)
      setResult(null)
      setFailed(true)
    }
  }, [activeResult, onCreated, onOpenChange, pendingCreate, setPendingCreate])

  const toggle = (id: string, setter: Dispatch<SetStateAction<readonly string[]>>, limit: number) =>
    setter(current =>
      current.includes(id)
        ? current.filter(value => value !== id)
        : current.length >= limit
          ? current
          : [...current, id]
    )

  const submit = async () => {
    if ((!canCreate && !pendingCreate) || pending) {
      return
    }

    const input: GroupCreateInput =
      pendingCreate ??
      (contextMode === 'private_advisory'
        ? {
            action: 'create',
            ...(capabilities?.createDefaults ? { reuseExisting: true as const } : {}),
            contextMode: 'private_advisory',
            clientOperationId: createOperationId(),
            memberUserIds: [],
            title: titleValue,
            advisors: [
              ...selectedApps.map(id => ({ type: 'specialist' as const, id })),
              ...selectedAgents.map(id => ({ type: 'assistant' as const, id }))
            ]
          }
        : contextMode === 'shared_group'
          ? {
              action: 'create',
              ...(capabilities?.createDefaults ? { reuseExisting: true as const } : {}),
              contextMode: 'shared_group',
              clientOperationId: createOperationId(),
              memberUserIds: [...selectedPeople],
              title: titleValue,
              ...(selectedApps.length ? { specialistIds: [...selectedApps] } : {}),
              ...(selectedAgents.length ? { assistantIds: [...selectedAgents] } : {})
            }
          : {
              action: 'create',
              ...(capabilities?.createDefaults ? { reuseExisting: true as const } : {}),
              clientOperationId: createOperationId(),
              memberUserIds: [...selectedPeople],
              title: titleValue,
              ...(selectedApps.length ? { specialistIds: [...selectedApps] } : {})
            })

    setPending(true)
    setFailed(false)
    setResult(null)
    setPendingCreate(input)
    submission.current = input.clientOperationId

    try {
      const next = await onOperate(input)

      if (submission.current === input.clientOperationId) {
        setResult(next)
      }
    } catch (error) {
      if (submission.current === input.clientOperationId) {
        setFailed(true)

        // Only an authoritative ledger read can prove no operation was saved.
        // Unknown failures retain the operation ID for an exact retry.
        if (error instanceof Error && error.message === 'group_operation_not_queued') {
          setPendingCreate(null)
        }
      }
    } finally {
      if (submission.current === input.clientOperationId) {
        setPending(false)
      }
    }
  }

  const loading = capabilities === null
  const unavailable = capabilities?.available === false
  const creationDisabled = !pendingCreate && !loading && !unavailable && !createEnabled
  const controlsLocked = pending || Boolean(pendingCreate)

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent aria-busy={pending || loading} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          {loading && (
            <div className="flex items-center gap-2" role="status">
              <Spinner className="size-4 animate-spin" /> {copy.loading}
            </div>
          )}
          {unavailable && <ErrorBanner>{copy.unavailable}</ErrorBanner>}
          {creationDisabled && (
            <ErrorBanner>{requiresUnavailableSharedAgent ? copy.agentsUnavailable : copy.creationDisabled}</ErrorBanner>
          )}
          {!loading && !unavailable && (
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <label
                  className="text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium text-(--atum-ink)"
                  htmlFor="atum-group-create-title"
                >
                  {capabilities?.createDefaults ? copy.nameLabel : t.dm.group.roomName}
                </label>
                <Input
                  autoFocus
                  disabled={controlsLocked}
                  id="atum-group-create-title"
                  maxLength={160}
                  onChange={event => setTitle(event.target.value)}
                  placeholder={capabilities?.createDefaults ? copy.namePlaceholder : undefined}
                  value={title}
                />
                {[...titleValue].length > 80 && (
                  <p
                    className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-destructive"
                    role="alert"
                  >
                    {copy.nameInvalid}
                  </p>
                )}
              </div>
              <PickerSection empty={copy.peopleEmpty} label={copy.members}>
                <p className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                  {copy.memberLimit(maximum)}
                </p>
                {contacts.length ? (
                  contacts.map(contact => (
                    <PickerRow
                      checked={peopleSet.has(contact.userId)}
                      disabled={
                        controlsLocked || (!peopleSet.has(contact.userId) && selectedPeople.length >= maximumContacts)
                      }
                      key={contact.userId}
                      label={`${contact.displayName}${contact.handle ? ` (@${contact.handle})` : ''}`}
                      onChange={() => toggle(contact.userId, setSelectedPeople, maximumContacts)}
                    />
                  ))
                ) : (
                  <p className="text-xs text-(--atum-ink-muted)">{copy.peopleEmpty}</p>
                )}
              </PickerSection>
              <PickerSection empty={copy.appsEmpty} label={copy.specialists}>
                {apps.map(app => {
                  const checked = appsSet.has(app.id)

                  const appEnabled = appAvailable(app)

                  return (
                    <PickerRow
                      checked={checked}
                      disabled={controlsLocked || (!checked && (!appEnabled || selectedApps.length >= appLimit))}
                      key={app.id}
                      onChange={() => toggle(app.id, setSelectedApps, appLimit)}
                    >
                      <GroupParticipantIdentity
                        displayName={app.displayName}
                        status={appEnabled ? undefined : copy.appUnavailable}
                        target={{ type: 'specialist', id: app.id }}
                      />
                    </PickerRow>
                  )
                })}
              </PickerSection>
              <PickerSection empty={copy.agentsEmpty} label={copy.agents}>
                {agents.map(agent => {
                  const checked = agentsSet.has(agent.id)

                  const agentEnabled = agentAvailable(agent)

                  return (
                    <PickerRow
                      action={
                        !privateMode && agent.assistant?.availability === 'assistant_not_approved' ? (
                          <Button
                            onClick={() => setReviewAssistant(agent.assistant!)}
                            size="xs"
                            type="button"
                            variant="ghost"
                          >
                            {t.dm.group.persona.review}
                          </Button>
                        ) : undefined
                      }
                      checked={checked}
                      disabled={controlsLocked || (!checked && (!agentEnabled || selectedAgents.length >= agentLimit))}
                      key={agent.id}
                      onChange={() => toggle(agent.id, setSelectedAgents, agentLimit)}
                    >
                      <GroupParticipantIdentity
                        displayName={agent.displayName}
                        status={
                          agentEnabled
                            ? undefined
                            : hasOtherPerson && !sharedEnabled
                              ? copy.agentsUnavailable
                              : copy.agentUnavailable(agent.availability)
                        }
                        target={{ type: 'assistant', id: agent.id }}
                      />
                    </PickerRow>
                  )
                })}
              </PickerSection>
              <p className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                {contextMode === 'private_advisory'
                  ? copy.privateDisclosure
                  : contextMode === 'shared_group'
                    ? copy.sharedDisclosure
                    : copy.historyDisclosure}
              </p>
            </div>
          )}
          {pending && (
            <div className="flex items-center gap-2" role="status">
              <Spinner className="size-4 animate-spin" /> {copy.sending}
            </div>
          )}
          {activeResult && (
            <p
              role={
                activeResult.state === 'failed_terminal' || activeResult.state === 'conflicted' ? 'alert' : 'status'
              }
            >
              {activeResult.state === 'queued'
                ? copy.queued
                : activeResult.state === 'sent'
                  ? copy.sent
                  : activeResult.state === 'sending'
                    ? copy.sending
                    : copy.failed}
            </p>
          )}
          {failed && <ErrorBanner>{copy.failed}</ErrorBanner>}
          <DialogFooter>
            <Button disabled={pending} onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            <Button
              disabled={pending || (!pendingCreate && !canCreate)}
              onClick={() => void submit()}
              size="sm"
              type="button"
            >
              {pending ? copy.sending : copy.submit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    </>
  )
}

function PickerSection({ children, empty, label }: { children: ReactNode; empty: string; label: string }) {
  const entries = (Array.isArray(children) ? children : [children]).filter(Boolean)

  return (
    <div className="grid gap-2">
      <span className="text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium text-(--atum-ink)">
        {label}
      </span>
      <div aria-label={label} className="grid gap-1" role="group">
        {entries.length ? children : <p className="text-xs text-(--atum-ink-muted)">{empty}</p>}
      </div>
    </div>
  )
}

function PickerRow({
  action,
  checked,
  children,
  disabled,
  label,
  onChange
}: {
  action?: ReactNode
  checked: boolean
  children?: ReactNode
  disabled: boolean
  label?: string
  onChange: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--atum-r-control)] bg-(--atum-sunk) px-3 py-2">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <input aria-label={label} checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
        {children ?? (
          <span className="text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink)">{label}</span>
        )}
      </label>
      {action}
    </div>
  )
}
