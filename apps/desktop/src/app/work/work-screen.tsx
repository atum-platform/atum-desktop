import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'

import { AtumMainHeaderSurface } from '@/app/atum/shell-surface'
import { AccountConnectProgress } from '@/app/connections/connect-sheet'
import { useI18n } from '@/i18n'
import { MatrixGoogleWorkWriteProposals } from '@/matrix/google-write-card'

import { type MatrixWorkBridge, type MatrixWorkProjection, type MatrixWorkViewState, workViewHasNewMenu } from '../../../shared/matrix-work'

import { workCopy, type WorkWords } from './copy'
import { useWorkViewPlacement } from './use-work-view-placement'
import { useWorkHistoryArrows, useWorkSidebar, WorkModeSwitch, WorkRightPanelToggle, WorkRosterControls, WorkTitle } from './work-band'

export interface WorkScreenProps {
  bridge: MatrixWorkBridge
  projection: MatrixWorkProjection
  /** A modal or menu covers the window: the native view leaves until it closes. */
  obstructed: boolean
  /** S's follow-up exposes no Protons action from inside the view, so the title bar carries it. */
  onAddProtons(): void
  windowControls?: ReactNode
  leadsRow?: boolean
  reserveOverlay?: boolean
  /**
   * The signed-in Matrix user. Present: Google changes Work asks for wait above the view on the same
   * owner card an assistant's do, for this account only.
   */
  owner?: string
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
 * The owner’s native Work view and the title bar shared with the Matrix shell.
 */
export function WorkScreen({
  bridge,
  leadsRow,
  obstructed,
  onAddProtons,
  owner,
  projection,
  reserveOverlay,
  windowControls
}: WorkScreenProps) {
  const { locale } = useI18n()
  const copy = workCopy(locale)
  const host = useRef<HTMLDivElement>(null)

  useWorkViewPlacement(bridge, host, projection.view !== 'off' && projection.view !== 'unavailable' && !obstructed)
  const sidebar = useWorkSidebar(bridge, projection.view === 'ready')
  useWorkHistoryArrows(bridge, sidebar)
  // The view fills this section from its left edge, so the list's edge in the view is its edge here.
  const roster = sidebar?.open && sidebar.edge > 0 ? sidebar.edge : undefined
  // New lives once: in the view's left panel when it draws its own plus menu, else here. Until the view's
  // first report the band waits, so a newer view never flashes a second +; a bridge that cannot report keeps it.
  const showBandNewMenu = bridge.onSidebarChanged ? sidebar !== null && !workViewHasNewMenu(sidebar) : true

  // Coming back to the window re-reads the balance, so "Add Protons" leaves after a top-up.
  useEffect(() => {
    const refresh = () => void bridge.read().catch(() => null)
    window.addEventListener('focus', refresh)

    return () => window.removeEventListener('focus', refresh)
  }, [bridge])

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-atum-work
      data-atum-work-roster={roster === undefined ? undefined : ''}
      data-atum-work-view={projection.view}
      style={roster === undefined ? undefined : ({ '--atum-work-roster-edge': `${roster}px` } as CSSProperties)}
    >
      <AtumMainHeaderSurface
        actions={
          <div className="flex min-w-0 items-center gap-1.5">
            {/* The connect sheet's Finish / Done: above the view, never over T3's sign-in. */}
            <AccountConnectProgress />
            {projection.view === 'ready' && projection.protons === 'empty' && (
              <button className="ak-btn ak-btn--sm" data-atum-work-add-protons onClick={onAddProtons} type="button">
                {copy.addProtons}
              </button>
            )}
            {/* C, read from the right edge: the panel toggle last, the mode switch before it (layout r1 C). */}
            <WorkModeSwitch bridge={bridge} copy={copy} ready={projection.view === 'ready'} />
            {projection.view === 'ready' && <WorkRightPanelToggle bridge={bridge} locale={locale} state={sidebar?.rightPanel} />}
          </div>
        }
        leadsRow={leadsRow ?? false}
        reserveOverlay={reserveOverlay ?? false}
        windowControls={windowControls}
      >
        <div className="flex min-w-0 items-center gap-3">
          {projection.view === 'ready' && showBandNewMenu && <WorkRosterControls bridge={bridge} copy={copy} />}
          <WorkTitle copy={copy} thread={projection.view === 'ready' ? sidebar?.thread : null} />
        </div>
      </AtumMainHeaderSurface>
      {/* Above the view, never over it: main paints the view natively, so the host shrinks to make room. */}
      {owner && <MatrixGoogleWorkWriteProposals key={owner} owner={owner} />}
      {/* The shared panel frame (owner, 2026-11-24/25): the host fills the main column, whose padding
          already holds the frame's gutter and foot inset, and main rounds the native view to the panel
          radius (electron-view.ts). Inside, atum-work's `panels` sidebar paints the thread list and the
          thread as two cards on a transparent ground, so the frame shows between them as between every
          screen's left panel and main card. While the view is away the quiet state sits on one card. */}
      <div
        className={
          projection.view === 'ready'
            ? 'relative min-h-0 flex-1 overflow-hidden rounded-(--atum-r-panel)'
            : 'relative min-h-0 flex-1 overflow-hidden rounded-(--atum-r-panel) bg-(--atum-main-bg) shadow-(--atum-main-edge)'
        }
        data-atum-work-host
        ref={host}
      >
        {projection.view !== 'ready' && <QuietState bridge={bridge} copy={copy} view={projection.view} />}
      </div>
    </section>
  )
}
