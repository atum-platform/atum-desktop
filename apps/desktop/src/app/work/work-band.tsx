import { useEffect, useState } from 'react'

import { FolderPlus, GitBranch, MessagePlus } from '@/lib/icons'
import { MatrixPlusMenu } from '@/matrix/plus-menu'

import type { MatrixWorkBridge, WorkBandCommand, WorkSidebarSnapshot, WorkSurfaceModeSnapshot } from '../../../shared/matrix-work'

import type { WorkWords } from './copy'

/**
 * New, as the plus menu every screen has (layout r2 §4, owner 2026-11-24): T3's own pencil mapped
 * through the host chrome. New thread ⌘N, New thread in a worktree, then Add project; each runs T3's
 * own command in the owner view. Absent bridge: no button.
 */
export function WorkRosterControls({ bridge, copy }: { bridge: Pick<MatrixWorkBridge, 'runCommand'>; copy: WorkWords }) {
  if (!bridge.runCommand) {
    return null
  }

  const run = (command: WorkBandCommand) => void bridge.runCommand?.(command).catch(() => false)

  return (
    <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]" data-atum-work-roster-controls>
      <MatrixPlusMenu
        items={[
          { id: 'thread', label: copy.band.newThread, icon: <MessagePlus aria-hidden />, shortcut: '⌘N', onSelect: () => run('chat.new') },
          { id: 'worktree', label: copy.band.newWorktreeThread, icon: <GitBranch aria-hidden />, onSelect: () => run('chat.newWorktree') },
          { id: 'project', label: copy.band.addProject, icon: <FolderPlus aria-hidden />, separated: true, onSelect: () => run('project.add') }
        ]}
        label={copy.band.newMenu}
        screen="work"
      />
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
