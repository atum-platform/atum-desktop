import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AtumSegmented } from '@/components/ui/atum-segmented'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'

import type {
  MatrixAgentRoutine,
  MatrixAgentRoutineAction,
  MatrixAgentRoutineRun,
  MatrixAgentRoutinesSnapshot,
  MatrixAgentRoutineUpdate,
  MatrixAgentRoutineWriteSchedule,
  MatrixRoutineError
} from '../../../shared/agent-routines'
import { matrixRoutineTitle } from '../../../shared/agent-routines'
import type { MatrixAgentView } from '../../../shared/matrix'
import { executionMachineName } from '../execution-machines-copy'
import { executionPolicyTrigger } from '../execution-policy-trigger'

import type { AssistantCardCopy } from './copy'
import {
  matrixRoutineClock,
  matrixRoutineDateInput,
  matrixRoutineInstant,
  matrixRoutineNextWords,
  matrixRoutineRunsInCloud,
  matrixRoutineScheduleWords,
  matrixRoutineTimeFromInstant,
  matrixRoutineTimeInput,
  matrixRoutineWeekdayChip,
  matrixRoutineWeekdayList
} from './routines-words'

const MAX_ROUTINES = 64
const EMPTY_WEEKDAYS = [1, 2, 3, 4, 5]

type RoutineKind = MatrixAgentRoutineWriteSchedule['kind']
type Notice = 'failure' | 'conflict' | 'legacy' | 'quota' | { action: 'run'; error: MatrixRoutineError } | undefined

interface Draft {
  title: string
  instruction: string
  kind: RoutineKind
  date: string
  time: string
  weekdays: number[]
  monthDay: number
  enabled: boolean
}

function tomorrow(timezone: string): string {
  if (timezone) {
    return matrixRoutineDateInput(Date.now() + 86_400_000, timezone)
  }

  const date = new Date()
  date.setDate(date.getDate() + 1)

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function draftFor(routine: MatrixAgentRoutine | undefined, timezone: string): Draft {
  const empty: Draft = {
    title: '',
    instruction: '',
    kind: 'daily',
    date: tomorrow(timezone),
    time: '08:00',
    weekdays: EMPTY_WEEKDAYS,
    monthDay: 1,
    enabled: true
  }

  if (!routine) {
    return empty
  }

  const schedule = routine.schedule

  switch (schedule.kind) {
    case 'once':
      return {
        ...empty,
        title: routine.title,
        instruction: routine.instruction,
        enabled: routine.enabled,
        kind: 'once',
        date: matrixRoutineDateInput(Date.parse(schedule.runAt), timezone),
        time: matrixRoutineTimeFromInstant(Date.parse(schedule.runAt), timezone)
      }

    case 'daily':
      return {
        ...empty,
        title: routine.title,
        instruction: routine.instruction,
        enabled: routine.enabled,
        kind: 'daily',
        time: matrixRoutineTimeInput(schedule.hour, schedule.minute)
      }

    case 'weekly':
      return {
        ...empty,
        title: routine.title,
        instruction: routine.instruction,
        enabled: routine.enabled,
        kind: 'weekly',
        time: matrixRoutineTimeInput(schedule.hour, schedule.minute),
        weekdays: schedule.weekdays
      }

    case 'monthly':
      return {
        ...empty,
        title: routine.title,
        instruction: routine.instruction,
        enabled: routine.enabled,
        kind: 'monthly',
        time: matrixRoutineTimeInput(schedule.hour, schedule.minute),
        monthDay: schedule.day
      }

    default:
      return empty
  }
}

/** The name the platform stores: what the person typed, else the instruction's first words. */
function routineTitleFor(draft: Draft): string {
  return draft.title.trim() || matrixRoutineTitle(draft.instruction)
}

function draftSchedule(draft: Draft, timezone: string): MatrixAgentRoutineWriteSchedule | null {
  const [hour, minute] = draft.time.split(':').map(Number)

  if (!Number.isSafeInteger(hour) || !Number.isSafeInteger(minute) || hour > 23 || minute > 59) {
    return null
  }

  switch (draft.kind) {
    case 'once': {
      const instant = matrixRoutineInstant(draft.date, draft.time, timezone)

      return instant === null ? null : { kind: 'once', runAt: new Date(instant).toISOString() }
    }

    case 'daily':
      return { kind: 'daily', hour, minute }

    case 'weekly':
      return draft.weekdays.length ? { kind: 'weekly', hour, minute, weekdays: [...draft.weekdays].sort((a, b) => a - b) } : null

    case 'monthly':
      return { kind: 'monthly', day: draft.monthDay, hour, minute }
  }
}

function sameSchedule(left: MatrixAgentRoutineWriteSchedule, right: MatrixAgentRoutineWriteSchedule): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function routineErrorCopy(error: MatrixRoutineError): 'failure' | 'conflict' | 'legacy' | 'quota' {
  return error === 'conflict' ? 'conflict' : error === 'legacy' ? 'legacy' : error === 'quota' ? 'quota' : 'failure'
}

/** Where the assistant answers now, said the same way the card's Nơi trả lời row says it:
 * the policy's current destination when known, else the cloud/local route this Mac holds. */
function routineRunsOn(agent: MatrixAgentView, locale: string, copy: AssistantCardCopy): string {
  const view = agent.executionPolicy

  if (view) {
    const trigger = executionPolicyTrigger(locale, view)

    if (trigger.kind === 'destination') {
      return executionMachineName(locale, trigger.destination, view.deviceNames)
    }
  }

  if (matrixRoutineRunsInCloud(agent)) {
    return copy.routineCloudPlace
  }

  const thisMac = view?.deviceNames ? Object.values(view.deviceNames).find(device => device.thisMac) : undefined

  return thisMac?.displayName ?? copy.routineThisMac
}

/** Every assistant card's scheduled tasks: the row ("3 việc" / "Chưa có") and its in-card
 * panel (list, add, edit, pause, run now, history, delete). Unknown kinds stay in the list
 * read-only so one newer row cannot hide the rest. The routines snapshot is authoritative. */
export function RoutinesRow({
  agent,
  copy,
  initiallyOpen = false,
  locale,
  onMoveToCloud
}: {
  agent: MatrixAgentView
  copy: AssistantCardCopy
  /** The composer's "Add routines" opens the list (and the add form's way in) on arrival. */
  initiallyOpen?: boolean
  locale: string
  /** Opens the card's "Nơi trả lời" editor; absent when this card has no such row. */
  onMoveToCloud?: () => void
}) {
  const { t } = useI18n()
  const bridge = window.atumMatrix?.routines
  const [snapshot, setSnapshot] = useState<MatrixAgentRoutinesSnapshot>()
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(initiallyOpen)
  const row = useRef<HTMLButtonElement>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<Draft>(() => draftFor(undefined, ''))
  const [notice, setNotice] = useState<Notice>()
  const [pending, setPending] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [runs, setRuns] = useState<MatrixAgentRoutineRun[]>()
  const [runsFailed, setRunsFailed] = useState(false)
  const live = useRef(true)
  const deviceTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const [ownerTimeZone, setOwnerTimeZone] = useState<string>()

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  // A38: refreshed whenever the panel opens, so a zone reported on a later roster read is
  // already the default for the next new routine.
  const readOwnerTimeZone = useCallback(() => {
    if (!bridge?.ownerZone) {
      return
    }

    void bridge
      .ownerZone()
      .then(zone => {
        if (live.current) {
          setOwnerTimeZone(zone)
        }
      })
      .catch(() => {
        // The device zone remains the fallback.
      })
  }, [bridge])

  const load = useCallback(async () => {
    if (!bridge || !live.current) {
      return
    }

    setFailed(false)

    try {
      const result = await bridge.read(agent.principal)

      if (!live.current) {
        return
      }

      if (result.ok) {
        setSnapshot(result.snapshot)
      } else {
        setFailed(true)
      }
    } catch {
      if (live.current) {
        setFailed(true)
      }
    }
  }, [agent.principal, bridge])

  useEffect(() => {
    void load()
  }, [load])

  // Arriving from the composer: the person asked for this list, so open it and bring it into view.
  useEffect(() => {
    if (!initiallyOpen) {
      return
    }

    setOpen(true)
    readOwnerTimeZone()
    row.current?.scrollIntoView?.({ block: 'nearest' })
  }, [initiallyOpen, readOwnerTimeZone])

  const apply = (routine: MatrixAgentRoutine) => {
    setSnapshot(current =>
      current
        ? {
            ...current,
            routines: current.routines.some(each => each.id === routine.id)
              ? current.routines.map(each => (each.id === routine.id ? routine : each))
              : [...current.routines, routine]
          }
        : current
    )
  }

  const remove = (id: string) => {
    setSnapshot(current => (current ? { ...current, routines: current.routines.filter(each => each.id !== id) } : current))
  }

  const edit = (routine: MatrixAgentRoutine) => {
    if (routine.schedule.kind === 'interval' || routine.schedule.kind === 'unsupported') {
      return
    }

    setDraft(draftFor(routine, routine.timezone))
    setEditingId(routine.id)
    setDialogOpen(true)
    setNotice(undefined)
    setConfirmDelete(false)
    setRuns(undefined)
    setRunsFailed(false)
  }

  // A38: a new routine belongs to the owner, so it defaults to the zone the platform
  // acknowledged for this sign-in; only an account that never reported falls back to this Mac.
  const createTimeZone = ownerTimeZone ?? deviceTimeZone

  const add = (seed?: { instruction: string }) => {
    setDraft({ ...draftFor(undefined, createTimeZone), ...(seed ? { instruction: seed.instruction } : {}) })
    setEditingId(undefined)
    setDialogOpen(true)
    setNotice(undefined)
    setConfirmDelete(false)
    setRuns(undefined)
  }

  const closeDialog = () => {
    setDialogOpen(false)
    setEditingId(undefined)
    setConfirmDelete(false)
    setNotice(undefined)
  }

  const base = editingId ? snapshot?.routines.find(each => each.id === editingId) : undefined
  const schedule = draftSchedule(draft, base?.timezone ?? createTimeZone)

  const hasDraftChanges = base
    ? routineTitleFor(draft) !== base.title ||
      draft.instruction.trim() !== base.instruction ||
      draft.enabled !== base.enabled ||
      schedule === null ||
      !sameSchedule(schedule, base.schedule as MatrixAgentRoutineWriteSchedule)
    : true

  const changed = base
    ? routineTitleFor(draft) !== base.title ||
      draft.instruction.trim() !== base.instruction ||
      draft.enabled !== base.enabled ||
      (schedule !== null && !sameSchedule(schedule, base.schedule as MatrixAgentRoutineWriteSchedule))
    : true

  const canSave =
    Boolean(bridge) &&
    !saving &&
    draft.instruction.trim().length > 0 &&
    Array.from(draft.instruction.trim()).length <= 20_000 &&
    routineTitleFor(draft).length > 0 &&
    schedule !== null &&
    changed

  useEffect(() => {
    if (!dialogOpen || !base || !bridge) {
      return
    }

    let current = true
    setRunsFailed(false)
    void bridge
      .runs(agent.principal, base.id)
      .then(result => {
        if (!current) {
          return
        }

        if (result.ok) {
          setRuns(result.snapshot.runs)
        } else {
          setRunsFailed(true)
        }
      })
      .catch(() => current && setRunsFailed(true))

    return () => {
      current = false
    }
    // A run may have added one: reload only when the dialog's routine changes.
  }, [agent.principal, base, bridge, dialogOpen])

  const toggle = async (routine: MatrixAgentRoutine) => {
    const schedule = routine.schedule

    if (!bridge || schedule.kind === 'interval' || schedule.kind === 'unsupported') {
      return
    }

    setPending(routine.id)
    setNotice(undefined)

    const input: MatrixAgentRoutineUpdate = {
      principal: agent.principal,
      routineId: routine.id,
      expectedRevision: routine.revision,
      title: routine.title,
      instruction: routine.instruction,
      schedule,
      timezone: routine.timezone,
      enabled: !routine.enabled,
      notifications: routine.notifications
    }

    try {
      const result = await bridge.update(input)

      if (!live.current) {
        return
      }

      if (result.ok && 'routine' in result) {
        apply(result.routine)
      } else if (!result.ok) {
        setNotice(routineErrorCopy(result.error))

        if (result.error === 'conflict' || result.error === 'legacy') {
          void load()
        }
      }
    } finally {
      if (live.current) {
        setPending(undefined)
      }
    }
  }

  const save = async () => {
    if (!bridge || !schedule) {
      return
    }

    const instruction = draft.instruction.trim()
    const title = routineTitleFor(draft)
    setSaving(true)
    setNotice(undefined)

    try {
      const result = base
        ? await bridge.update({
            principal: agent.principal,
            routineId: base.id,
            expectedRevision: base.revision,
            title,
            instruction,
            schedule,
            timezone: base.timezone,
            enabled: draft.enabled,
            notifications: base.notifications
          })
        : await bridge.create({
            principal: agent.principal,
            title,
            instruction,
            schedule,
            timezone: createTimeZone,
            enabled: draft.enabled,
            notifications: true
          })

      if (!live.current) {
        return
      }

      if (result.ok && 'routine' in result) {
        apply(result.routine)
        setDialogOpen(false)
        setEditingId(undefined)
        setConfirmDelete(false)
      } else if (!result.ok) {
        setNotice(routineErrorCopy(result.error))

        if (result.error === 'conflict' || result.error === 'legacy') {
          // Keep the draft and refresh the revision in the background: the next save can win.
          void load()
        }
      }
    } finally {
      if (live.current) {
        setSaving(false)
      }
    }
  }

  const run = async (routine: MatrixAgentRoutine) => {
    if (!bridge) {
      return
    }

    setPending(routine.id)
    setSaving(hasDraftChanges)
    setNotice(undefined)

    try {
      let saved = routine

      // The button describes what is on screen: unchanged forms run the saved routine
      // directly; valid edits are saved once, then that returned revision is run.
      if (hasDraftChanges) {
        if (!canSave || !schedule) {
          setNotice({ action: 'run', error: 'invalid' })

          return
        }

        const updated = await bridge.update({
          principal: agent.principal,
          routineId: routine.id,
          expectedRevision: routine.revision,
          title: routineTitleFor(draft),
          instruction: draft.instruction.trim(),
          schedule,
          timezone: routine.timezone,
          enabled: draft.enabled,
          notifications: routine.notifications
        })

        if (!live.current) {
          return
        }

        if (!updated.ok || !('routine' in updated)) {
          setNotice({ action: 'run', error: updated.ok ? 'invalid' : updated.error })

          if (!updated.ok && (updated.error === 'conflict' || updated.error === 'legacy')) {
            void load()
          }

          return
        }

        saved = updated.routine
        apply(saved)
      }

      const action = (current: MatrixAgentRoutine): MatrixAgentRoutineAction => ({
        principal: agent.principal,
        routineId: current.id,
        expectedRevision: current.revision
      })

      let result = await bridge.run(action(saved))

      // A stale read should not make an unchanged Run now a two-click operation. Re-read
      // authoritative state and retry once; edited drafts never get silently rebased.
      if (!hasDraftChanges && !result.ok && result.error === 'conflict') {
        const refreshed = await bridge.read(agent.principal)

        if (refreshed.ok) {
          setSnapshot(refreshed.snapshot)
          const latest = refreshed.snapshot.routines.find(each => each.id === routine.id)

          if (latest) {
            result = await bridge.run(action(latest))
          }
        }
      }

      if (!live.current) {
        return
      }

      if (result.ok && 'routine' in result) {
        apply(result.routine)

        if (bridge) {
          const history = await bridge.runs(agent.principal, routine.id)

          if (live.current && history.ok) {
            setRuns(history.snapshot.runs)
          }
        }
      } else if (!result.ok) {
        setNotice({ action: 'run', error: result.error })

        if (result.error === 'conflict') {
          void load()
        }
      }
    } catch {
      if (live.current) {
        setNotice({ action: 'run', error: 'unavailable' })
      }
    } finally {
      if (live.current) {
        setSaving(false)
        setPending(undefined)
      }
    }
  }

  const destroy = async (routine: MatrixAgentRoutine) => {
    if (!bridge) {
      return
    }

    setPending(routine.id)
    setNotice(undefined)

    try {
      const result = await bridge.delete({
        principal: agent.principal,
        routineId: routine.id,
        expectedRevision: routine.revision
      })

      if (!live.current) {
        return
      }

      if (result.ok && 'deleted' in result) {
        remove(result.deleted.id)
        setDialogOpen(false)
        setEditingId(undefined)
        setConfirmDelete(false)
      } else if (!result.ok) {
        setNotice(routineErrorCopy(result.error))
      }
    } finally {
      if (live.current) {
        setPending(undefined)
      }
    }
  }

  if (!bridge) {
    return null
  }

  const routineCount = snapshot?.routines.length ?? 0
  const legacy = snapshot?.legacyState
  const quota = routineCount >= MAX_ROUTINES
  const addable = legacy === 'clear' && !quota
  const runsInCloud = matrixRoutineRunsInCloud(agent)
  const runsOnPlace = routineRunsOn(agent, locale, copy)

  return (
    <>
      <button
        aria-expanded={open}
        aria-label={copy.routineRowLabel(routineCount)}
        className="atum-settings-row atum-settings-link"
        data-assistant-card-routines
        onClick={() => {
          if (!open) {
            readOwnerTimeZone()
          }

          setOpen(value => !value)
        }}
        ref={row}
        type="button"
      >
        <span className="atum-settings-row-title min-w-0 flex-1">{copy.routines}</span>
        <span className="atum-card-row-value" data-routine-count>
          {failed ? copy.retry : snapshot ? copy.routineCount(routineCount) : '…'}
        </span>
        <ChevronRight aria-hidden className="atum-settings-chevron" data-open={open || undefined} />
      </button>
      {open && (
        <div className="px-3.5 pb-3" data-routines-panel>
          {!runsInCloud && (
            <div className="mb-2 flex items-start gap-2" data-routines-cloud>
              <p className="min-w-0 flex-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {copy.routineCloudOnly}
              </p>
              {onMoveToCloud && (
                <Button onClick={onMoveToCloud} size="inline" type="button" variant="textStrong">
                  {copy.routineCloudMove}
                </Button>
              )}
            </div>
          )}
          {notice && !dialogOpen && <RoutineNotice copy={copy} notice={notice} />}
          {failed ? (
            <div className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {copy.routineLoadFailed(agent.name ?? '')}
              </span>
              <Button onClick={() => void load()} size="inline" variant="textStrong">
                {copy.retry}
              </Button>
            </div>
          ) : !snapshot ? (
            <p className="py-1.5 text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.routineLoading}</p>
          ) : (
            <div className="space-y-1.5 pt-1">
              {legacy === 'present' ? (
                <p data-routines-legacy="present">{copy.routineLegacyMoving}</p>
              ) : legacy === 'unknown' ? (
                <p data-routines-legacy="unknown">{copy.routinePreparing}</p>
              ) : null}
              {snapshot.routines.length === 0 ? (
                <div data-routines-empty>
                  <p>{copy.routineEmpty}</p>
                  {addable && (
                    <button
                      className="atum-card-pill mt-2"
                      data-routine-suggestion
                      onClick={() => add({ instruction: copy.routineSuggestBriefInstruction })}
                      type="button"
                    >
                      {copy.routineSuggestBrief}
                    </button>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-(--atum-line)" data-routines-list>
                  {snapshot.routines.map(routine => {
                    const readOnly = routine.schedule.kind === 'interval' || routine.schedule.kind === 'unsupported'

                    return (
                      <li className="flex items-center gap-3 py-2" data-routine-id={routine.id} data-routine-row key={routine.id}>
                        <button
                          className="min-w-0 flex-1 text-start"
                          disabled={readOnly}
                          onClick={() => edit(routine)}
                          type="button"
                        >
                          <span className="block truncate text-(length:--atum-t-control) text-(--atum-ink)">
                            {routine.title}
                          </span>
                          <span className="block text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                            {matrixRoutineScheduleWords(routine.schedule, routine.timezone, locale, copy)}
                          </span>
                          <span className="block text-(length:--atum-t-caption) text-(--atum-ink-faint)">
                            {matrixRoutineNextWords(routine, deviceTimeZone, locale, copy)}
                            {readOnly ? ` · ${copy.routineReadOnly}` : ''}
                          </span>
                        </button>
                        {!readOnly && (
                          <Switch
                            aria-label={`${routine.enabled ? copy.routinePause : copy.routineResume}: ${routine.title}`}
                            checked={routine.enabled}
                            data-routine-toggle
                            disabled={pending === routine.id || legacy === 'present'}
                            onCheckedChange={() => void toggle(routine)}
                          />
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {legacy === 'clear' && (
                <Button
                  data-routines-add
                  disabled={quota}
                  onClick={() => add()}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {copy.addRoutine}
                </Button>
              )}
              {quota && (
                <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)" data-routines-quota>
                  {copy.routineQuotaReached(MAX_ROUTINES)}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <Dialog
        onOpenChange={next => {
          if (!next) {
            closeDialog()
          }
        }}
        open={dialogOpen}
      >
        <DialogContent className="z-[150] max-w-lg" data-routine-dialog overlayClassName="z-[140]">
          <DialogHeader>
            <DialogTitle>{base ? copy.routineEdit : copy.addRoutine}</DialogTitle>
            <DialogDescription>{copy.routineDialogSubtitle}</DialogDescription>
          </DialogHeader>
          {notice && <RoutineNotice copy={copy} notice={notice} />}
          <form
            className="space-y-3"
            data-routine-changed={changed ? 'true' : 'false'}
            data-routine-form
            onSubmit={event => {
              event.preventDefault()
              void save()
            }}
          >
            <label className="block space-y-1">
              <span className="block text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {copy.routineRunsOn}
              </span>
              <select
                aria-label={copy.routineRunsOn}
                className="desktop-input-chrome h-8 w-full rounded-md px-2 text-sm text-foreground"
                data-routine-runs-on
                disabled
                onChange={() => {}}
                value={runsOnPlace}
              >
                <option value={runsOnPlace}>{runsOnPlace}</option>
              </select>
            </label>
            {!runsInCloud && (
              <div className="flex items-start gap-2" data-routine-cloud-note>
                <p className="min-w-0 flex-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                  {copy.routineCloudOnly}
                </p>
                {onMoveToCloud && (
                  <Button
                    onClick={() => {
                      setDialogOpen(false)
                      onMoveToCloud()
                    }}
                    size="inline"
                    type="button"
                    variant="textStrong"
                  >
                    {copy.routineCloudMove}
                  </Button>
                )}
              </div>
            )}
            <label className="block space-y-1">
              <span className="block text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {copy.routineTitle}
              </span>
              <Input
                data-routine-name
                maxLength={120}
                onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
                placeholder={copy.routineNamePlaceholder}
                value={draft.title}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {copy.routineInstruction}
              </span>
              <Textarea
                autoFocus
                data-routine-instruction
                maxLength={20_000}
                onChange={event => setDraft(current => ({ ...current, instruction: event.target.value }))}
                placeholder={copy.purposePlaceholder}
                rows={4}
                value={draft.instruction}
              />
            </label>
            <div className="space-y-1.5">
              <span className="block text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {copy.routineSchedule}
              </span>
              <AtumSegmented<'at' | 'repeat'>
                disabled={saving}
                label={copy.routineSchedule}
                onChange={() => {}}
                options={[
                  { id: 'at', label: copy.routineAtTime },
                  { badge: copy.routineComingSoon, disabled: true, id: 'repeat', label: copy.routineRepeat }
                ]}
                value="at"
              />
            </div>
            <AtumSegmented
              disabled={saving}
              label={copy.routineAtTime}
              onChange={kind => setDraft(current => ({ ...current, kind }))}
              options={[
                { id: 'once', label: copy.routineOnce },
                { id: 'daily', label: copy.routineDaily },
                { id: 'weekly', label: copy.routineWeekly },
                { id: 'monthly', label: copy.routineMonthly }
              ]}
              value={draft.kind}
            />
            {draft.kind === 'once' && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={copy.routineDate}
                  data-routine-date
                  onChange={event => setDraft(current => ({ ...current, date: event.target.value }))}
                  type="date"
                  value={draft.date}
                />
                <RoutineTimeField
                  copy={copy}
                  disabled={saving}
                  onChange={time => setDraft(current => ({ ...current, time }))}
                  value={draft.time}
                />
              </div>
            )}
            {draft.kind !== 'once' && (
              <RoutineTimeField
                copy={copy}
                disabled={saving}
                onChange={time => setDraft(current => ({ ...current, time }))}
                value={draft.time}
              />
            )}
            {draft.kind === 'weekly' && (
              <div aria-label={copy.routineWeekdays} className="flex flex-wrap gap-1" role="group">
                {[1, 2, 3, 4, 5, 6, 7].map(day => {
                  const on = draft.weekdays.includes(day)

                  return (
                    <button
                      aria-checked={on}
                      className={
                        on
                          ? 'rounded-full bg-(--atum-ink) px-2.5 py-1 text-(length:--atum-t-caption) text-(--atum-paper)'
                          : 'rounded-full border border-(--atum-line) px-2.5 py-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)'
                      }
                      data-routine-weekday={day}
                      key={day}
                      onClick={() =>
                        setDraft(current => ({
                          ...current,
                          weekdays: on
                            ? current.weekdays.filter(each => each !== day)
                            : [...current.weekdays, day]
                        }))
                      }
                      role="checkbox"
                      type="button"
                    >
                      {matrixRoutineWeekdayChip(day, locale)}
                    </button>
                  )
                })}
              </div>
            )}
            {draft.kind === 'monthly' && (
              <label className="flex items-center gap-2 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {copy.routineMonthDay}
                <select
                  className="desktop-input-chrome rounded-[2.5px] px-2 py-1 text-xs text-foreground"
                  data-routine-month-day
                  onChange={event => setDraft(current => ({ ...current, monthDay: Number(event.target.value) }))}
                  value={draft.monthDay}
                >
                  {Array.from({ length: 28 }, (_, index) => index + 1).map(day => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex items-start gap-3 border-t border-(--atum-line) pt-2" data-routine-enabled>
              <div className="min-w-0 flex-1">
                <span className="block text-(length:--atum-t-control) text-(--atum-ink)">{copy.routineEnabled}</span>
                <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.routineEnabledHint}</p>
              </div>
              <Switch
                aria-label={copy.routineEnabled}
                checked={draft.enabled}
                data-routine-enabled-toggle
                disabled={saving}
                onCheckedChange={enabled => setDraft(current => ({ ...current, enabled }))}
              />
            </div>
            {base && (
              <div className="space-y-2 border-t border-(--atum-line) pt-2">
                <Button
                  data-routine-run
                  disabled={pending === base.id || saving || legacy === 'present' || (hasDraftChanges && !canSave)}
                  onClick={() => void run(base)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {hasDraftChanges ? copy.routineSaveAndRun : copy.routineRunNow}
                </Button>
                <details data-routine-history>
                  <summary className="cursor-pointer text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                    {copy.routineHistory}
                  </summary>
                  <div className="mt-1">
                    {runsFailed ? (
                      <p className="text-(length:--atum-t-caption) text-(--atum-ink-faint)">{copy.saveFailed}</p>
                    ) : !runs ? (
                      <p className="text-(length:--atum-t-caption) text-(--atum-ink-faint)">{copy.routineLoading}</p>
                    ) : runs.length === 0 ? (
                      <p className="text-(length:--atum-t-caption) text-(--atum-ink-faint)">{copy.routineRunsEmpty}</p>
                    ) : (
                      <ul className="space-y-0.5" data-routine-runs>
                        {runs.slice(0, 5).map(run => (
                          <li
                            className="flex items-center justify-between gap-2 text-(length:--atum-t-caption)"
                            data-routine-run-row
                            key={run.occurrenceId}
                          >
                            <span className="text-(--atum-ink-muted)">{runState(run, copy)}</span>
                            <span className="text-(--atum-ink-faint)">
                              {routineRunTime(run.scheduledAt, base.timezone, locale)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </details>
              </div>
            )}
            {confirmDelete && base && (
              <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-2" data-routine-delete-confirm>
                <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.routineDeleteBody}</p>
                <div className="flex items-center gap-2">
                  <Button
                    disabled={pending === base.id}
                    onClick={() => void destroy(base)}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    {t.common.delete}
                  </Button>
                  <Button onClick={() => setConfirmDelete(false)} size="sm" type="button" variant="text">
                    {t.common.cancel}
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter className="items-center">
              {base && (
                <Button
                  className="sm:me-auto"
                  data-routine-delete
                  disabled={pending === base.id || saving}
                  onClick={() => setConfirmDelete(true)}
                  size="sm"
                  type="button"
                  variant="textDestructive"
                >
                  {copy.routineDeleteShort}
                </Button>
              )}
              <div className="flex items-center justify-end gap-3">
                <Button data-routine-cancel onClick={closeDialog} size="sm" type="button" variant="text">
                  {t.common.cancel}
                </Button>
                <Button data-routine-save disabled={!canSave} size="sm" type="submit">
                  {saving ? copy.saving : copy.routineSave}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** One conflict/legacy/quota line, wherever the person is looking (the panel or the dialog). */
function RoutineNotice({ copy, notice }: { copy: AssistantCardCopy; notice: Notice }) {
  const runError = typeof notice === 'object' ? notice.error : undefined
  const key = runError ? `run-${runError}` : notice

  const message = runError
    ? runError === 'conflict'
      ? copy.routineConflict
      : runError === 'legacy'
        ? copy.routineLegacyMoving
        : runError === 'offline'
          ? copy.routineRunOffline
          : runError === 'missing' || runError === 'invalid' || runError === 'denied'
            ? copy.routineRunRefused
            : copy.routineRunFailed
    : notice === 'conflict'
      ? copy.routineConflict
      : notice === 'legacy'
        ? copy.routineLegacyMoving
        : notice === 'quota'
          ? copy.routineQuotaReached(MAX_ROUTINES)
          : copy.saveFailed

  return (
    <NoticeBand
      className="mb-2"
      role={notice === 'legacy' ? 'status' : 'alert'}
      tone={notice === 'conflict' || runError === 'conflict' ? 'notice' : 'failure'}
    >
      <span data-routine-notice={key}>{message}</span>
    </NoticeBand>
  )
}

/** A 24-hour wall clock in two compact selects. The contract and the list both store/read
 * `HH:MM`, so the field never depends on the device's region or its native time control. */
function RoutineTimeField({
  copy,
  disabled,
  onChange,
  value
}: {
  copy: AssistantCardCopy
  disabled: boolean
  onChange(time: string): void
  value: string
}) {
  const [hourText, minuteText] = value.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.routineTime}</span>
      <select
        aria-label={copy.routineHour}
        className="desktop-input-chrome rounded-[2.5px] px-1.5 py-1 text-xs text-foreground"
        data-routine-hour
        disabled={disabled}
        onChange={event => onChange(matrixRoutineTimeInput(Number(event.target.value), minute))}
        value={hour}
      >
        {Array.from({ length: 24 }, (_, index) => (
          <option key={index} value={index}>
            {String(index).padStart(2, '0')}
          </option>
        ))}
      </select>
      <span aria-hidden className="text-(--atum-ink-muted)">
        :
      </span>
      <select
        aria-label={copy.routineMinute}
        className="desktop-input-chrome rounded-[2.5px] px-1.5 py-1 text-xs text-foreground"
        data-routine-minute
        disabled={disabled}
        onChange={event => onChange(matrixRoutineTimeInput(hour, Number(event.target.value)))}
        value={minute}
      >
        {Array.from({ length: 60 }, (_, index) => (
          <option key={index} value={index}>
            {String(index).padStart(2, '0')}
          </option>
        ))}
      </select>
    </div>
  )
}

function runState(run: MatrixAgentRoutineRun, copy: AssistantCardCopy): string {
  switch (run.outcome) {
    case 'answered':
      return copy.routineCompleted

    case 'stopped':
      return copy.routineStopped

    case 'failed':

    case 'uncertain':
      return copy.routineFailed

    default:
      return run.state === 'skipped' ? copy.routineSkipped : copy.routineWaiting
  }
}

function routineRunTime(milliseconds: number, timezone: string, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale === 'zh-hant' ? 'zh-Hant' : locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone
  }).formatToParts(new Date(milliseconds))

  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  const hour = Number(value('hour'))
  const minute = Number(value('minute'))

  return `${value('day')}/${value('month')} ${matrixRoutineClock(hour, minute)}`
}

/** One shared name for the list's weekday sentence (tests and the form read the same list). */
export function routineWeekdayWords(days: readonly number[], locale: string): string {
  return matrixRoutineWeekdayList(days, locale)
}
