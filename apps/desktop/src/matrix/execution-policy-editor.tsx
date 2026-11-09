import { type DndContextProps, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'

import { ReorderableList, useSortableBindings } from '@/app/chat/sidebar/reorderable-list'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Cloud, DeviceDesktop, GripVertical } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { AGENT_HOMES_CLOUD_ONLY, cloudOnlyAllowsOrder, cloudOnlyLocksSwitch } from '../../shared/agent-home-cloud-only'
import type {
  ExecutionDestinationId,
  ExecutionDeviceName,
  ExecutionPolicyDraft,
  ExecutionPolicyOff,
  ExecutionPolicySnapshot,
  ExecutionPolicyUpdate,
  ExecutionStatusSnapshot,
  MatrixExecutionPolicySaveResult
} from '../../shared/execution-policy'
import {
  buildExecutionPolicyUpdate,
  executionDestinationViews,
  executionPolicyDestinationViews,
  executionPolicyDraft,
  executionStatusMatchesPolicy,
  parseExecutionPolicySnapshot,
  parseMatrixExecutionPolicySaveError,
  setExecutionDestinationEnabled
} from '../../shared/execution-policy'

import {
  executionMachineName,
  executionMachineStateLabel,
  executionMachineWaitsForPlan
} from './execution-machines-copy'
import {
  executionPolicyEditorCopy,
  type ExecutionPolicyEditorFailure,
  executionPolicyStatusAge
} from './execution-policy-editor-copy'

export type { MatrixExecutionPolicySaveResult } from '../../shared/execution-policy'

/** `without_recent`: this Mac answers without the cloud's latest memory. `local_saved`: the cloud's copy
 * replaced memory this Mac had changed, and the earlier versions are saved on this Mac. */
export type MatrixExecutionMemoryNote = 'local_saved' | 'without_recent'

export interface MatrixExecutionPolicyEditorProps extends Omit<React.ComponentProps<'section'>, 'children'> {
  policy: ExecutionPolicySnapshot
  status?: ExecutionStatusSnapshot
  /** Main retained the last policy after a failed authoritative read/write. Keep a visible draft,
   * but close editing and saving until the controller completes a strict reread. */
  stale?: boolean
  save: (update: ExecutionPolicyUpdate) => Promise<MatrixExecutionPolicySaveResult>
  /** The per-agent off switch (0238). Passed only when the platform answers it for a saved policy. */
  turnOff?: (off: ExecutionPolicyOff) => Promise<MatrixExecutionPolicySaveResult>
  /** What happened to this Mac's memory when it took a cloud assistant (cloud-home-read.ts). */
  memoryNote?: MatrixExecutionMemoryNote
  /** The owner's names for the Macs (§9.4), by device service id; absent keeps the ordinals. */
  deviceNames?: Record<string, ExecutionDeviceName>
  onAccepted?: (policy: ExecutionPolicySnapshot) => void
  onRefresh: () => void
  /** Cloud-only S0: no edit hands the assistant to a Mac. Only tests pass `false`. */
  cloudOnly?: boolean
}

interface RetainedRequest {
  fingerprint: string
  requestId: string
}

/** One write this long after the LAST change: a drop or a toggle is a complete decision. */
const SAVE_DELAY_MS = 1_000

function listEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function setEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}

function policyKey(policy: ExecutionPolicySnapshot): string {
  return JSON.stringify([
    policy.agentPrincipal,
    policy.revision,
    policy.source,
    policy.order,
    [...policy.disabled].toSorted()
  ])
}

function updateFingerprint(policy: ExecutionPolicySnapshot, draft: ExecutionPolicyDraft): string {
  return JSON.stringify([policy.agentPrincipal, policy.revision, draft.order, draft.disabled])
}

function acceptedPolicy(
  value: unknown,
  update: ExecutionPolicyUpdate,
  agentPrincipal: string
): ExecutionPolicySnapshot | null {
  const parsed = parseExecutionPolicySnapshot(value)

  if (
    !parsed ||
    parsed.agentPrincipal !== agentPrincipal ||
    parsed.revision <= update.expectedRevision ||
    !listEquals(parsed.order, update.order) ||
    !setEquals(parsed.disabled, update.disabled)
  ) {
    return null
  }

  return parsed
}

function providerFailure(value: unknown): ExecutionPolicyEditorFailure {
  return parseMatrixExecutionPolicySaveError(value)?.details.reason ?? 'unavailable'
}

/**
 * Controlled U13-MACHINES policy editor. It prepares a complete revision-fenced write and accepts
 * only the matching authoritative snapshot in return. Main owns network/IPC and the account cache;
 * this component never derives policy from legacy answering flags.
 */
export function MatrixExecutionPolicyEditor({
  className,
  cloudOnly = AGENT_HOMES_CLOUD_ONLY,
  deviceNames,
  onAccepted,
  onRefresh,
  memoryNote,
  policy,
  save,
  stale = false,
  status,
  turnOff,
  ...props
}: MatrixExecutionPolicyEditorProps) {
  const { locale } = useI18n()
  const copy = executionPolicyEditorCopy(locale)
  const latestPolicy = useRef(policy)
  latestPolicy.current = policy
  const externalKey = policyKey(policy)
  const generation = useRef(0)
  const retainedRequest = useRef<RetainedRequest | null>(null)
  // The exact draft a failed write carried, kept so "Try again" replays that body, not a later one.
  const failedDraft = useRef<ExecutionPolicyDraft | null>(null)
  const savingRef = useRef(false)
  const [baseline, setBaseline] = useState(policy)
  const [draft, setDraft] = useState(() => executionPolicyDraft(policy))
  // What the person sees right now, readable from an async write's continuation: a change made
  // while a write is in flight is newer than that write's answer.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline
  const [failure, setFailure] = useState<ExecutionPolicyEditorFailure | null>(null)
  // A failed save and a failed turn-off share one line, but not one way out: only a save retries.
  const [failureSource, setFailureSource] = useState<'save' | 'off'>('save')
  const [saving, setSaving] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)
  const [turningOff, setTurningOff] = useState(false)
  const retainedOff = useRef<{ key: string; requestId: string } | null>(null)
  const turningOffRef = useRef(false)

  useEffect(() => {
    const next = latestPolicy.current

    // The authoritative policy is the one this editor just wrote: nothing changed to reconcile, so
    // a newer draft made during that write stays visible and is written next.
    if (policyKey(next) === policyKey(baselineRef.current)) {
      return
    }

    const nextDraft = executionPolicyDraft(next)
    generation.current += 1
    baselineRef.current = next
    draftRef.current = nextDraft
    setBaseline(next)
    setDraft(nextDraft)
    setFailure(null)
    setFailureSource('save')
    setSaving(false)
    savingRef.current = false
    retainedRequest.current = null
    failedDraft.current = null
    setConfirmingOff(false)
    setTurningOff(false)
    turningOffRef.current = false
    retainedOff.current = null
  }, [externalKey])

  useEffect(
    () => () => {
      generation.current += 1
    },
    []
  )

  const syncedStatus = status && executionStatusMatchesPolicy(baseline, status) ? status : undefined

  const statusById = useMemo(
    () => new Map(syncedStatus ? executionDestinationViews(syncedStatus).map(view => [view.id, view]) : []),
    [syncedStatus]
  )

  const destinations = executionPolicyDestinationViews(draft)
  const dirty = !listEquals(baseline.order, draft.order) || !setEquals(baseline.disabled, draft.disabled)
  const conflict = failure === 'revision_conflict' || failure === 'inventory_changed'
  const reloadRequired = stale || conflict
  const locked = saving || turningOff || reloadRequired
  const allDisabled = draft.disabled.length === draft.order.length

  // 0238: a cloud-first assistant whose owner's plan has ended waits for the plan instead of moving
  // to a Mac. The Macs say so; this says what to do.
  const waitingForPlan = destinations.some(
    destination =>
      destination.enabled &&
      Boolean(statusById.get(destination.id) && executionMachineWaitsForPlan(statusById.get(destination.id)!))
  )

  // The row itself drags after a small distance so a toggle click still lands; the keyboard moves
  // keep the ordering accessible now that the arrow buttons are gone.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const accessibility = useMemo<DndContextProps['accessibility']>(() => {
    const nameOf = (id: string) => {
      const destination = destinations.find(each => each.id === id)

      return destination ? executionMachineName(locale, destination, deviceNames) : id
    }

    const positionOf = (id: string) => {
      const index = destinations.findIndex(destination => destination.id === id)

      return index < 0 ? 1 : index + 1
    }

    return {
      announcements: {
        onDragCancel: ({ active }) => copy.reorderCancel(nameOf(String(active.id)), positionOf(String(active.id))),
        onDragEnd: ({ active, over }) =>
          copy.reorderEnd(nameOf(String(active.id)), positionOf(String(over?.id ?? active.id)), destinations.length),
        onDragOver: ({ active, over }) =>
          copy.reorderOver(nameOf(String(active.id)), positionOf(String(over?.id ?? active.id)), destinations.length),
        onDragStart: ({ active }) => copy.reorderStart(nameOf(String(active.id)))
      },
      screenReaderInstructions: { draggable: copy.reorderInstructions }
    }
  }, [copy, destinations, deviceNames, locale])

  // A drop reports the complete new id order; the draft keeps its own disabled set with it.
  const reorder = (next: string[]) => {
    const order = next as ExecutionDestinationId[]

    // Cloud-only: a drop that would put a Mac ahead of the cloud snaps back on purpose. Macs can
    // still be reordered behind the cloud, so the grip stays enabled rather than locking the list.
    if (!cloudOnlyAllowsOrder(draft.order, order, cloudOnly)) {
      return
    }

    edit({ order: [...order], disabled: order.filter(id => draft.disabled.includes(id)) })
  }

  const edit = (next: ExecutionPolicyDraft) => {
    // A newer edit supersedes any failed draft: "Try again" must never replay a stale body.
    failedDraft.current = null
    draftRef.current = next
    setDraft(next)
    setFailure(null)
  }

  const submit = async (target: ExecutionPolicyDraft = draft) => {
    if (savingRef.current || turningOffRef.current || reloadRequired) {
      return
    }

    if (listEquals(baseline.order, target.order) && setEquals(baseline.disabled, target.disabled)) {
      return
    }

    const fingerprint = updateFingerprint(baseline, target)

    if (retainedRequest.current?.fingerprint !== fingerprint) {
      retainedRequest.current = { fingerprint, requestId: globalThis.crypto.randomUUID() }
    }

    const update = buildExecutionPolicyUpdate(baseline, target, retainedRequest.current.requestId)
    const runGeneration = generation.current
    savingRef.current = true
    setSaving(true)
    setFailure(null)

    try {
      const result = await save(update)

      if (generation.current !== runGeneration) {
        return
      }

      if (result.ok) {
        const accepted = acceptedPolicy(result.value, update, baseline.agentPrincipal)

        if (!accepted) {
          failedDraft.current = target
          setFailureSource('save')
          setFailure('invalid_response')

          return
        }

        failedDraft.current = null
        baselineRef.current = accepted
        setBaseline(accepted)

        // Rebase, never revert: a toggle or reorder made while this write was in flight is newer
        // than the answer. Keep it, and the debounce writes it against the accepted revision.
        if (listEquals(draftRef.current.order, target.order) && setEquals(draftRef.current.disabled, target.disabled)) {
          const next = executionPolicyDraft(accepted)
          draftRef.current = next
          setDraft(next)
        }

        retainedRequest.current = null
        onAccepted?.(accepted)
        // The accepted policy arrives without status; read it now so the header stops guessing.
        onRefresh()

        return
      }

      const nextFailure = providerFailure(result.error)

      if (nextFailure !== 'unavailable') {
        retainedRequest.current = null
      }

      setFailureSource('save')

      if (nextFailure === 'revision_conflict' || nextFailure === 'inventory_changed') {
        // Only an authoritative reload can clear this; the draft stays visible but closed.
        setFailure(nextFailure)

        return
      }

      failedDraft.current = target
      setFailure(nextFailure)
    } catch {
      if (generation.current === runGeneration) {
        // The outcome may be unknown. Retain the exact request id so a same-body retry is safe.
        failedDraft.current = target
        setFailureSource('save')
        setFailure('unavailable')
      }
    } finally {
      if (generation.current === runGeneration) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }

  const submitRef = useRef(submit)
  submitRef.current = submit

  // Every drag or toggle saves itself: one write a second after the last change, coalescing a
  // quick drag-then-toggle into a single PUT of the final draft. A failed write leaves that draft
  // visible and waits for an explicit retry or a new edit; it must not turn into a retry loop.
  useEffect(() => {
    if (!dirty || failure || reloadRequired || saving) {
      return
    }

    const timer = window.setTimeout(() => void submitRef.current(), SAVE_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [dirty, draft, failure, reloadRequired, saving])

  const retry = () => {
    const target = failedDraft.current

    if (!target) {
      return
    }

    failedDraft.current = null
    draftRef.current = target
    setDraft(target)
    setFailure(null)
    void submit(target)
  }

  const submitOff = async () => {
    if (!turnOff || turningOffRef.current || saving || reloadRequired) {
      return
    }

    const key = JSON.stringify([baseline.agentPrincipal, baseline.revision])

    if (retainedOff.current?.key !== key) {
      retainedOff.current = { key, requestId: globalThis.crypto.randomUUID() }
    }

    const off: ExecutionPolicyOff = { requestId: retainedOff.current.requestId, expectedRevision: baseline.revision }
    const runGeneration = generation.current
    turningOffRef.current = true
    setTurningOff(true)
    setFailure(null)

    try {
      const result = await turnOff(off)

      if (generation.current !== runGeneration) {
        return
      }

      if (result.ok) {
        const accepted = parseExecutionPolicySnapshot(result.value)

        if (!accepted || accepted.agentPrincipal !== baseline.agentPrincipal || accepted.source !== 'default') {
          setFailureSource('off')
          setFailure('invalid_response')

          return
        }

        retainedOff.current = null
        setConfirmingOff(false)
        onAccepted?.(accepted)

        return
      }

      const nextFailure = providerFailure(result.error)

      if (nextFailure !== 'unavailable') {
        retainedOff.current = null
      }

      setFailureSource('off')
      setFailure(nextFailure)
    } catch {
      if (generation.current === runGeneration) {
        // The outcome may be unknown. Retain the exact request id so a same-body retry is safe.
        setFailureSource('off')
        setFailure('unavailable')
      }
    } finally {
      if (generation.current === runGeneration) {
        turningOffRef.current = false
        setTurningOff(false)
      }
    }
  }

  return (
    <section
      // One surface: the popover is the card. No inner panel, border or second inset here.
      className={cn('grid gap-3', className)}
      data-execution-policy-editor
      {...props}
    >
      <header>
        <h2 className="text-sm font-semibold text-(--atum-ink)">{copy.title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-(--atum-ink-muted)">{copy.help}</p>
        {syncedStatus && (
          <p className="mt-1 text-xs text-(--atum-ink-muted)" data-execution-policy-freshness>
            {copy.statusAsOf(executionPolicyStatusAge(locale, syncedStatus.asOf))}
          </p>
        )}
        {waitingForPlan && (
          <p className="mt-2 text-xs leading-relaxed text-(--atum-ink)" data-execution-policy-plan-lapsed role="status">
            {copy.planLapsed}
          </p>
        )}
        {memoryNote && (
          <p
            className="mt-2 text-xs leading-relaxed text-(--atum-ink-muted)"
            data-execution-policy-memory-note={memoryNote}
            role="status"
          >
            {memoryNote === 'local_saved' ? copy.memoryLocalSaved : copy.memoryNote}
          </p>
        )}
      </header>

      <ReorderableList
        accessibility={accessibility}
        ids={destinations.map(destination => destination.id)}
        onReorder={reorder}
        sensors={sensors}
      >
        <ol className="grid gap-1.5">
          {destinations.map(destination => {
            const Icon = destination.kind === 'cloud' ? Cloud : DeviceDesktop
            const name = executionMachineName(locale, destination, deviceNames)
            const destinationStatus = statusById.get(destination.id)

            const statusLabel = destinationStatus
              ? executionMachineStateLabel(locale, destinationStatus)
              : status
                ? copy.statusUpdating
                : copy.statusUnavailable

            const draining =
              !destination.enabled &&
              destinationStatus?.current &&
              (destinationStatus.state === 'working' || destinationStatus.state === 'yielding')

            return (
              <SortableExecutionDestination disabled={locked} id={destination.id} key={destination.id}>
                {bindings => (
                  <li
                    className={cn(
                      'group flex min-w-0 items-center gap-2 rounded-md bg-(--atum-sunk) py-1.5 pe-2 ps-1',
                      bindings.dragging && 'opacity-60'
                    )}
                    data-destination-kind={destination.kind}
                    data-enabled={destination.enabled}
                    onPointerDown={bindings.listeners?.onPointerDown as React.PointerEventHandler<HTMLLIElement> | undefined}
                    ref={bindings.ref}
                    style={bindings.style}
                  >
                    {/* The grip is the keyboard activator and the affordance; the whole row drags. It is
                        always drawn (faint, stronger on hover or focus) so the gutter is a handle on every
                        row, never an empty indent, and keyboard reordering stays discoverable. */}
                    <button
                      {...bindings.attributes}
                      aria-label={copy.dragHandle(name)}
                      className="grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded-md text-(--atum-ink-faint) transition-colors hover:text-(--atum-ink) focus-visible:text-(--atum-ink) active:cursor-grabbing disabled:cursor-default group-focus-within:text-(--atum-ink-muted) group-hover:text-(--atum-ink-muted) motion-reduce:transition-none"
                      disabled={locked}
                      onKeyDown={bindings.listeners?.onKeyDown as React.KeyboardEventHandler<HTMLButtonElement> | undefined}
                      type="button"
                    >
                      <GripVertical aria-hidden className="size-4" strokeWidth={1.7} />
                    </button>
                    <Icon aria-hidden className="size-4 shrink-0 text-(--atum-ink-soft)" strokeWidth={1.7} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-(--atum-ink)">{name}</span>
                      <span className="block truncate text-xs text-(--atum-ink-muted)" data-execution-policy-status>
                        {statusLabel}
                      </span>
                      {draining && (
                        <span className="mt-0.5 block text-xs text-pretty text-(--atum-ink-muted)" data-execution-policy-draining>
                          {copy.activeTurn}
                        </span>
                      )}
                    </span>

                    <Switch
                      aria-label={destination.enabled ? copy.turnOff(name) : copy.turnOn(name)}
                      checked={destination.enabled}
                      data-execution-policy-cloud-only-locked={
                        cloudOnlyLocksSwitch(destination.kind, destination.enabled, cloudOnly) || undefined
                      }
                      disabled={locked || cloudOnlyLocksSwitch(destination.kind, destination.enabled, cloudOnly)}
                      onCheckedChange={enabled => edit(setExecutionDestinationEnabled(draft, destination.id, enabled))}
                    />
                  </li>
                )}
              </SortableExecutionDestination>
            )
          })}
        </ol>
      </ReorderableList>

      {allDisabled && (
        // text-wrap: pretty keeps a one-word last line (an orphan) off the footer.
        <p className="text-xs text-pretty text-(--atum-ink-muted)" data-execution-policy-paused role="status">
          {copy.allDisabled}
        </p>
      )}

      {turnOff && baseline.source === 'saved' && (
        <div className="grid gap-2" data-execution-policy-off>
          {confirmingOff ? (
            <>
              <p className="text-xs leading-relaxed text-(--atum-ink-muted)">{copy.turnOffAsk}</p>
              <div className="flex items-center justify-end gap-2">
                <Button
                  disabled={turningOff}
                  onClick={() => setConfirmingOff(false)}
                  size="sm"
                  type="button"
                  variant="text"
                >
                  {copy.turnOffKeep}
                </Button>
                <Button disabled={turningOff || reloadRequired} onClick={() => void submitOff()} size="sm" type="button">
                  {turningOff ? copy.turningOff : copy.turnOffConfirm}
                </Button>
              </div>
            </>
          ) : (
            <Button
              className="justify-self-start"
              disabled={locked}
              onClick={() => setConfirmingOff(true)}
              size="inline"
              type="button"
              variant="text"
            >
              {copy.turnOffFailover}
            </Button>
          )}
        </div>
      )}

      {stale && !failure && (
        <NoticeBand role="status" tone="notice">
          <span className="flex w-full items-start justify-between gap-2 text-xs">
            <span>{copy.cacheUnavailable}</span>
            <Button onClick={onRefresh} size="inline" type="button" variant="textStrong">
              {copy.refresh}
            </Button>
          </span>
        </NoticeBand>
      )}

      {failure && (
        <NoticeBand role="alert" tone="failure">
          <span className="flex w-full items-start justify-between gap-2 text-xs">
            <span>{copy.failure[failure]}</span>
            {reloadRequired ? (
              <Button onClick={onRefresh} size="inline" type="button" variant="textStrong">
                {copy.refresh}
              </Button>
            ) : failureSource === 'save' ? (
              <Button onClick={retry} size="inline" type="button" variant="textStrong">
                {copy.tryAgain}
              </Button>
            ) : null}
          </span>
        </NoticeBand>
      )}
    </section>
  )
}

interface SortableExecutionDestinationProps {
  children: (bindings: ReturnType<typeof useSortableBindings>) => React.ReactNode
  disabled: boolean
  id: string
}

function SortableExecutionDestination({ children, disabled, id }: SortableExecutionDestinationProps) {
  return <>{children(useSortableBindings(id, { disabled }))}</>
}
