import { useEffect, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { LayoutSidebar, MessagePlus } from '@/lib/icons'

import type { MatrixWorkBridge, WorkBandCommand, WorkSurfaceModeSnapshot } from '../../../shared/matrix-work'

import type { WorkWords } from './copy'

/**
 * Over the roster column: T3's own sidebar toggle and New thread, run in the owner view (the view's
 * brand row is hidden by the Work theme, so these are the only copies). Absent bridge: no buttons.
 */
export function WorkRosterControls({ bridge, copy }: { bridge: Pick<MatrixWorkBridge, 'runCommand'>; copy: WorkWords }) {
  if (!bridge.runCommand) {
    return null
  }

  const run = (command: WorkBandCommand) => void bridge.runCommand?.(command).catch(() => false)

  return (
    <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]" data-atum-work-roster-controls>
      <Tip label={copy.band.toggleSidebar}>
        <button
          aria-label={copy.band.toggleSidebar}
          className="atum-icon-btn size-8"
          onClick={() => run('sidebar.toggle')}
          type="button"
        >
          <LayoutSidebar aria-hidden className="size-[1.125rem]" />
        </button>
      </Tip>
      <Tip label={copy.band.newThread}>
        <button aria-label={copy.band.newThread} className="atum-icon-btn size-8" onClick={() => run('chat.new')} type="button">
          <MessagePlus aria-hidden className="size-[1.125rem]" />
        </button>
      </Tip>
    </div>
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
 * The page's name and its mode in one place (owner 2026-11-23: a "Work" title on the left and a
 * Work/Code switch on the right said the same thing twice). With a project open the name IS the
 * switch, "Work · Code", at the left of the band where a page's name sits; the mode is remembered
 * per project by the view's own project settings. With no project open there is nothing to
 * switch, so the band shows the plain name.
 */
export function WorkTitle({
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
    return <h1 className="truncate [font:var(--ak-t-headline)]">{copy.title}</h1>
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
    <>
      {/* The page keeps its name for assistive tech; the switch is what the eye reads. */}
      <h1 className="sr-only">{copy.title}</h1>
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
    </>
  )
}
