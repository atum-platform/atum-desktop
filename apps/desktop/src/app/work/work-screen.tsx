import { type CSSProperties, type ReactNode, useContext, useEffect, useState } from 'react'

import { AtumMainHeaderSurface } from '@/app/atum/shell-surface'
import { AccountConnectProgress } from '@/app/connections/connect-sheet'
import { useI18n } from '@/i18n'
import { MatrixGoogleWorkWriteProposals } from '@/matrix/google-write-card'

import type { MatrixWorkBridge, MatrixWorkProjection, MatrixWorkViewState } from '../../../shared/matrix-work'

import { workCopy, type WorkWords } from './copy'
import { useWorkHistoryArrows, useWorkSidebar, WorkModeSwitch, WorkRightPanelToggle, WorkTitle } from './work-band'
import { WorkPreviewContext } from './work-preview'

export interface WorkScreenProps {
  bridge: MatrixWorkBridge
  projection: MatrixWorkProjection
  active: boolean
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

/** The body while the Work guest is starting or unavailable: a Kit state, one line, at most one action. */
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
 * The owner’s embedded Work view and the title bar shared with the Matrix shell.
 */
export function WorkScreen({
  active,
  bridge,
  leadsRow,
  onAddProtons,
  owner,
  projection,
  reserveOverlay,
  windowControls
}: WorkScreenProps) {
  const { locale } = useI18n()
  const copy = workCopy(locale)
  const preview = useContext(WorkPreviewContext)
  const { guest, view } = projection

  useEffect(() => {
    if (active && view === 'starting') {
      void bridge.open().catch(() => {})
    }
  }, [active, bridge, view])

  const sidebar = useWorkSidebar(bridge, active && view === 'ready')
  // The view fills this section from its left edge, so the list's edge in the view is its edge here.
  const roster = sidebar?.open && sidebar.edge > 0 ? sidebar.edge : undefined

  // Coming back to the window re-reads the balance, so "Add Protons" leaves after a top-up.
  useEffect(() => {
    if (!active) {return}

    const refresh = () => void bridge.read().catch(() => null)
    window.addEventListener('focus', refresh)

    return () => window.removeEventListener('focus', refresh)
  }, [active, bridge])

  return (
    <section
      className={active
        ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
        : 'pointer-events-none invisible absolute inset-0 flex min-h-0 flex-col overflow-hidden'}
      data-atum-work={active ? '' : undefined}
      data-atum-work-roster={roster === undefined ? undefined : ''}
      data-atum-work-view={view}
      inert={!active || undefined}
      style={roster === undefined ? undefined : ({ '--atum-work-roster-edge': `${roster}px` } as CSSProperties)}
    >
      {active && (
        <>
          <WorkHistory bridge={bridge} sidebar={sidebar} />
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
              <WorkTitle copy={copy} />
            </div>
          </AtumMainHeaderSurface>
          {owner && <MatrixGoogleWorkWriteProposals key={owner} owner={owner} />}
        </>
      )}
      {/* Keep the guest in this slot while other destinations are open, so its session stays live. */}
      <div
        className={
          projection.view === 'ready'
            ? 'relative min-h-0 flex-1 overflow-hidden rounded-(--atum-r-panel)'
            : 'relative min-h-0 flex-1 overflow-hidden rounded-(--atum-r-panel) bg-(--atum-main-bg) shadow-(--atum-main-edge)'
        }
        data-atum-work-host
      >
        {guest && (
          <webview
            aria-label={copy.title}
            className={view === 'ready' ? 'absolute inset-0 h-full w-full' : 'invisible absolute inset-0 h-full w-full'}
            key={guest.src}
            partition={guest.partition}
            src={guest.src}
          />
        )}
        {active && view === 'ready' && preview}
        {active && view !== 'ready' && <QuietState bridge={bridge} copy={copy} view={view} />}
      </div>
    </section>
  )
}

function WorkHistory({ bridge, sidebar }: { bridge: MatrixWorkBridge; sidebar: ReturnType<typeof useWorkSidebar> }) {
  useWorkHistoryArrows(bridge, sidebar)

  return null
}
