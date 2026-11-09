import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronRight, CircleIcon, Pause } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixExecutionPolicyBridge, MatrixExecutionPolicyView } from '../../shared/execution-policy'

import { MatrixExecutionDestinationMark } from './execution-machines'
import { type MatrixExecutionMemoryNote, MatrixExecutionPolicyEditor } from './execution-policy-editor'
import { executionPolicyEditorCopy } from './execution-policy-editor-copy'
import { executionPolicyRowSummary, executionPolicyTrigger } from './execution-policy-trigger'

export interface MatrixExecutionPolicyControlProps {
  agentPrincipal: string
  bridge: MatrixExecutionPolicyBridge
  view: MatrixExecutionPolicyView
  /** What happened to this Mac's memory when it took the assistant (MatrixAgentView.memoryNote). */
  memoryNote?: MatrixExecutionMemoryNote
  /**
   * `icon` (default): the title bar's one closed-trigger icon. `row`: the assistant card's
   * "Nơi trả lời" row (§9.4) — the same read-only summary as its value, opening the same editor.
   */
  display?: 'icon' | 'row'
}

/** Title-bar entry for the main-owned H-F cache. A stale policy is visible only as unavailable;
 * it cannot be edited until main completes a fresh strict read. */
export function MatrixExecutionPolicyControl({
  agentPrincipal,
  bridge,
  display = 'icon',
  memoryNote,
  view
}: MatrixExecutionPolicyControlProps) {
  const { locale } = useI18n()
  const copy = executionPolicyEditorCopy(locale)
  const trigger = executionPolicyTrigger(locale, view)
  const content = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // Once a fresh editor is open, keep that component mounted if its save makes main mark the
  // cache stale. The editor owns the unsaved draft and closes its controls until a strict reread.
  const [hadFreshEditor, setHadFreshEditor] = useState(false)

  useEffect(() => {
    if (open && !view.stale) {
      setHadFreshEditor(true)
    }
  }, [open, view.stale])

  const refresh = useCallback(async () => {
    if (refreshing) {
      return
    }

    setRefreshing(true)

    try {
      await bridge.read(agentPrincipal)
    } catch {
      // Main retains the last valid value as stale. The popover keeps its explicit recovery action.
    } finally {
      setRefreshing(false)
    }
  }, [agentPrincipal, bridge, refreshing])

  const changeOpen = (next: boolean) => {
    setOpen(next)

    if (next) {
      if (!view.stale) {
        setHadFreshEditor(true)
      }

      void refresh()
    } else {
      setHadFreshEditor(false)
    }
  }

  // One string for the tooltip and the button's accessible name: a screen reader hears exactly
  // what the pointer sees, memory-note suffix included.
  const tooltip = memoryNote
    ? `${trigger.tooltip} · ${memoryNote === 'local_saved' ? copy.memoryLocalSaved : copy.memoryNote}`
    : trigger.tooltip

  // The card's row is read-only text with the same content as the trigger's one tooltip.
  const summary = display === 'row' ? executionPolicyRowSummary(locale, view) : undefined

  return (
    <Popover onOpenChange={changeOpen} open={open}>
      {summary ? (
        <PopoverTrigger asChild>
          <button
            className="atum-settings-row atum-settings-link"
            data-assistant-card-answer-where
            data-execution-policy-row={summary.kind}
            type="button"
          >
            <span className="atum-settings-row-title shrink-0">{copy.rowTitle}</span>
            {/* The value is only the place, so a long Mac name ellipsizes here and never pushes the label. */}
            <span className="atum-card-row-value ms-auto" title={summary.text}>
              {summary.text}
            </span>
            <ChevronRight aria-hidden className="atum-settings-chevron" />
          </button>
        </PopoverTrigger>
      ) : (
        <Tip label={tooltip}>
          <PopoverTrigger asChild>
            <Button
              aria-label={tooltip}
              className="h-7 px-1.5"
              data-matrix-execution-memory-note={memoryNote}
              data-matrix-execution-policy
              size="xs"
              type="button"
              variant="ghost"
            >
              {trigger.kind === 'destination' ? (
                // One icon, one tooltip: the mark's own label stays inside the control's.
                <MatrixExecutionDestinationMark aria-hidden view={trigger.destination} />
              ) : (
                <span
                  aria-hidden
                  className="grid size-6 place-items-center text-muted-foreground"
                  data-execution-policy-mark={trigger.kind === 'paused' ? 'pause' : 'neutral'}
                  data-execution-policy-trigger={trigger.kind}
                >
                  {trigger.kind === 'paused' ? (
                    <Pause className="size-4" strokeWidth={1.7} />
                  ) : (
                    // Never a cloud while loading: a muted cloud reads as "the cloud is offline".
                    <CircleIcon className="size-4" strokeWidth={1.7} />
                  )}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </Tip>
      )}
      <PopoverContent
        align="end"
        aria-label={copy.title}
        className={cn(
          'max-h-[min(34rem,var(--radix-popover-content-available-height))] w-[22rem] overflow-y-auto p-3',
          // Above a dialog: the assistant card hosts this control as a row (z-[130] content).
          display === 'row' && 'z-[140]'
        )}
        onOpenAutoFocus={event => {
          event.preventDefault()
          content.current?.focus()
        }}
        ref={content}
        side="bottom"
        tabIndex={-1}
      >
        {view.stale && !hadFreshEditor ? (
          <div className="grid justify-items-start gap-2" data-execution-policy-stale>
            <p className="text-xs text-(--atum-ink-muted)" role="status">
              {copy.cacheUnavailable}
            </p>
            <Button disabled={refreshing} onClick={() => void refresh()} size="sm" type="button" variant="secondary">
              {refreshing ? copy.refreshing : copy.refresh}
            </Button>
          </div>
        ) : (
          <MatrixExecutionPolicyEditor
            deviceNames={view.deviceNames}
            memoryNote={memoryNote}
            onRefresh={() => void refresh()}
            policy={view.policy}
            save={update => bridge.save(agentPrincipal, update)}
            stale={view.stale}
            status={view.status}
            // Offered only when the platform answers the off switch (its capability check) and a
            // policy is saved; an older build's bridge has no such call.
            turnOff={
              bridge.turnOff && view.off && view.policy.source === 'saved'
                ? off => bridge.turnOff!(agentPrincipal, off)
                : undefined
            }
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
