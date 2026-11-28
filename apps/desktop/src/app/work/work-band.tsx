import { useEffect, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { LayoutSidebarRight } from '@/lib/icons'
import { setMatrixNavLocal } from '@/matrix/navigation-history'
import { rightPanelToggleCopy } from '@/matrix/right-panel'

import type { MatrixWorkBridge, WorkSidebarSnapshot, WorkSurfaceModeSnapshot } from '../../../shared/matrix-work'

import type { WorkWords } from './copy'

/**
 * The open thread's right panel, toggled from the title bar's right as every screen's panel is (owner
 * 2026-11-25): the same button Chat, Team Space and Drive wear, running T3's own rightPanel.toggle.
 * Absent while the view offers no panel (no thread open, or an older view that does not report one).
 */
export function WorkRightPanelToggle({
  bridge,
  locale,
  state
}: {
  bridge: Pick<MatrixWorkBridge, 'runCommand'>
  locale: Parameters<typeof rightPanelToggleCopy>[0]
  state: WorkSidebarSnapshot['rightPanel']
}) {
  if (!state || !bridge.runCommand) {
    return null
  }

  const open = state === 'open'
  const label = open ? rightPanelToggleCopy(locale).hide : rightPanelToggleCopy(locale).show

  return (
    <Tip label={label}>
      <button
        aria-label={label}
        aria-pressed={open}
        className="atum-icon-btn relative size-7"
        data-atum-work-right-panel-toggle
        onClick={() => void bridge.runCommand?.('rightPanel.toggle').catch(() => false)}
        type="button"
      >
        <LayoutSidebarRight aria-hidden className="size-[1.0625rem]" strokeWidth={1.6} />
      </button>
    </Tip>
  )
}

/** The project the view shows and its mode; null until the view reports one (no project open). */
export function useWorkSurfaceMode(bridge: Pick<MatrixWorkBridge, 'getSurfaceMode' | 'onSurfaceModeChanged'>, ready: boolean) {
  const [snapshot, setSnapshot] = useState<WorkSurfaceModeSnapshot | null>(null)

  // The view lives in another process: read once when it is ready, then follow its reports.
  useEffect(() => {
    if (!ready) {
      setSnapshot(null)

      return
    }

    let live = true
    const stop = bridge.onSurfaceModeChanged(next => live && setSnapshot(next))
    void bridge
      .getSurfaceMode()
      .then(next => live && setSnapshot(next))
      .catch(() => null)

    return () => {
      live = false
      stop()
    }
  }, [bridge, ready])

  return [snapshot, setSnapshot] as const
}

/**
 * The view's thread list as the view reports it, so the band can end the bell at its edge as the chat
 * roster does; null while the view is away or has not reported (the bell then follows the button).
 */
export function useWorkSidebar(bridge: Pick<MatrixWorkBridge, 'getSidebar' | 'onSidebarChanged'>, ready: boolean) {
  const [snapshot, setSnapshot] = useState<WorkSidebarSnapshot | null>(null)

  // Another process: read the last report once, then follow changes.
  useEffect(() => {
    if (!ready || !bridge.onSidebarChanged) {
      setSnapshot(null)

      return
    }

    let live = true
    const stop = bridge.onSidebarChanged(next => live && setSnapshot(next))
    void bridge
      .getSidebar?.()
      .then(next => live && setSnapshot(next))
      .catch(() => null)

    return () => {
      live = false
      stop()
    }
  }, [bridge, ready])

  return snapshot
}

/**
 * The window's ← → step T3's own history first while Work is on screen (layout r2 §1), as they step
 * Drive's folders, then the window's places. The view says whether its history can step (in its
 * sidebar report); a step is T3's own history.back / history.forward through the band.
 */
export function useWorkHistoryArrows(bridge: Pick<MatrixWorkBridge, 'runCommand'>, sidebar: WorkSidebarSnapshot | null) {
  const back = Boolean(bridge.runCommand && sidebar?.back)
  const forward = Boolean(bridge.runCommand && sidebar?.forward)

  useEffect(() => {
    setMatrixNavLocal({
      back,
      forward,
      step: delta => void bridge.runCommand?.(delta < 0 ? 'history.back' : 'history.forward').catch(() => false)
    })
  }, [back, bridge, forward])

  useEffect(() => () => setMatrixNavLocal(null), [])
}

/** The page's name in B (layout r1 B). Its mode switch is in C, beside the panel toggle. */
export function WorkTitle({ copy }: { copy: WorkWords }) {
  return <h1 className="truncate [font:var(--ak-t-headline)]">{copy.title}</h1>
}

/**
 * Work · Code in the title bar's right cluster, just left of the panel toggle, as every screen with modes
 * wears its switch (layout r1 C and the r2 `work-neutral` board; owner 2026-11-27 "I thought our mock up
 * was to put it on the right side on the titlebar"). It supersedes the 11-23 name-is-the-switch layout.
 * The mode is remembered per project by the view's own project settings. With no project open there is
 * nothing to switch, so there is no switch.
 */
export function WorkModeSwitch({
  bridge,
  copy,
  ready
}: {
  bridge: Pick<MatrixWorkBridge, 'getSurfaceMode' | 'onSurfaceModeChanged' | 'setSurfaceMode'>
  copy: WorkWords
  ready: boolean
}) {
  const [snapshot, setSnapshot] = useWorkSurfaceMode(bridge, ready)

  if (!snapshot) {
    return null
  }

  const choose = (mode: 'work' | 'code') => {
    if (mode === snapshot.mode) {
      return
    }

    const before = snapshot
    // Optimistic: the view confirms through onSurfaceModeChanged; a refusal puts the switch back.
    setSnapshot({ ...snapshot, mode })
    void bridge.setSurfaceMode(snapshot.projectId, mode).catch(() => setSnapshot(before))
  }

  return (
    <div aria-label={copy.band.mode} className="ak-seg shrink-0 [-webkit-app-region:no-drag]" data-atum-work-mode-switch role="group">
      {(['work', 'code'] as const).map(mode => (
        <button
          aria-pressed={snapshot.mode === mode}
          className={snapshot.mode === mode ? 'is-selected' : undefined}
          key={mode}
          onClick={() => choose(mode)}
          type="button"
        >
          {copy.band[mode]}
        </button>
      ))}
    </div>
  )
}
