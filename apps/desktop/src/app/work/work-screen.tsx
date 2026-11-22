import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { AtumMainHeaderSurface } from '@/app/atum/shell-surface'
import { useI18n } from '@/i18n'

import type { MatrixWorkBridge, MatrixWorkProjection, MatrixWorkViewState } from '../../../shared/matrix-work'

import { type WorkAgentNames, WorkAssistantsBand, WorkAssistantsPill } from './assistants'
import { workCopy, type WorkWords } from './copy'
import { WorkRelaySharedContextLine } from './relay-chrome'
import { workRelaySharedContext } from './relay-view'
import { useWorkViewPlacement } from './use-work-view-placement'

export interface WorkScreenProps {
  bridge: MatrixWorkBridge
  projection: MatrixWorkProjection
  /** A modal or menu covers the window: the native view leaves until it closes. */
  obstructed: boolean
  /** The name of an agent from the account's own record; undefined falls back to "An assistant". */
  agentName(principal: string): string | undefined
  /** S's follow-up exposes no Protons action from inside the view, so the title bar carries it. */
  onAddProtons(): void
  windowControls?: ReactNode
  leadsRow?: boolean
  reserveOverlay?: boolean
  /**
   * Relay R1 (O14): assistants whose chat with the owner runs in a thread on this Mac. One line says that what the owner types
   * in those threads can show up in their replies. Absent or empty: no line.
   */
  relayChats?: readonly string[]
}

/** The body while the owner view is not painted: a Kit state, one line, at most one action. */
const QUIET: Record<Exclude<MatrixWorkViewState, 'ready'>, { spinner: boolean; retry: boolean }> = {
  starting: { spinner: true, retry: false },
  unavailable: { spinner: false, retry: true },
  off: { spinner: false, retry: false }
}

function QuietState({ bridge, copy, view }: { bridge: Pick<MatrixWorkBridge, 'retry'>; copy: WorkWords; view: Exclude<MatrixWorkViewState, 'ready'> }) {
  const [busy, setBusy] = useState(false)
  const { retry, spinner } = QUIET[view]

  return (
    <div className="ak-state absolute inset-0 justify-center" data-atum-work-quiet={view} role="status">
      {spinner && <span aria-hidden className="ak-spinner mb-1" />}
      <div className="ak-state-body">{copy.view[view]}</div>
      {retry && (
        <button
          className="ak-btn ak-btn--sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void bridge
              .retry()
              .catch(() => {})
              .finally(() => setBusy(false))
          }}
          type="button"
        >
          {copy.retry}
        </button>
      )}
    </div>
  )
}

/**
 * The Work page (plan §9): the owner's own Work view, full-bleed in Atum's card, with one quiet control
 * for "Assistants can start work here". Work an assistant started is an ordinary thread in the view's own
 * list, marked "Started by {name}" there (FL); this page only says who is working right now.
 */
export function WorkScreen({
  agentName,
  bridge,
  leadsRow,
  obstructed,
  onAddProtons,
  projection,
  relayChats,
  reserveOverlay,
  windowControls
}: WorkScreenProps) {
  const { locale } = useI18n()
  const copy = workCopy(locale)
  const host = useRef<HTMLDivElement>(null)

  const names = useMemo<WorkAgentNames>(
    () => ({ name: principal => agentName(principal) ?? copy.anAssistant }),
    [agentName, copy]
  )

  useWorkViewPlacement(bridge, host, projection.view !== 'off' && projection.view !== 'unavailable' && !obstructed)

  // Coming back to the window re-reads the balance, so "Add Protons" leaves after a top-up.
  useEffect(() => {
    const refresh = () => void bridge.read().catch(() => null)
    window.addEventListener('focus', refresh)

    return () => window.removeEventListener('focus', refresh)
  }, [bridge])

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-atum-work data-atum-work-view={projection.view}>
      <AtumMainHeaderSurface
        actions={
          <div className="flex items-center gap-1.5">
            {projection.view === 'ready' && projection.protons === 'empty' && (
              <button className="ak-btn ak-btn--sm" data-atum-work-add-protons onClick={onAddProtons} type="button">
                {copy.addProtons}
              </button>
            )}
            <WorkAssistantsPill agents={projection.agents} copy={copy} names={names} state={projection.assistants} />
          </div>
        }
        leadsRow={leadsRow ?? false}
        reserveOverlay={reserveOverlay ?? false}
        windowControls={windowControls}
      >
        <h1 className="truncate [font:var(--ak-t-headline)]">{copy.title}</h1>
      </AtumMainHeaderSurface>
      <WorkAssistantsBand
        agents={projection.agents}
        bridge={bridge}
        copy={copy}
        names={names}
        state={projection.assistants}
      />
      {projection.view === 'ready' && (
        <WorkRelaySharedContextLine names={workRelaySharedContext(relayChats ?? []).map(names.name)} />
      )}
      {/* Full-bleed: the host is the card below the title, so main paints the view edge to edge (and
          rounds it with the card's own radius). */}
      <div
        className="relative mb-(--atum-panel-inset) min-h-0 flex-1 overflow-hidden rounded-(--atum-r-panel)"
        data-atum-work-host
        ref={host}
      >
        {projection.view !== 'ready' && <QuietState bridge={bridge} copy={copy} view={projection.view} />}
      </div>
    </section>
  )
}
