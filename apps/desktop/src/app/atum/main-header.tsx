import type { ComponentProps, ReactNode } from 'react'

import { useAtumShellLayout } from './shell-layout'
import { AtumMainHeaderSurface } from './shell-surface'
import { AtumWindowControls } from './window-controls'

export { AtumMainHeaderSurface } from './shell-surface'

/**
 * The top row of the main column — the chat's identity, or Discover's — at
 * the same height as the sidebar's top row beside it and the workspace tab bar
 * on its other side (`--atum-l-header`). It is not a bar across the window:
 * each column owns its row, and they share a baseline by sharing one token.
 *
 * The identity starts at the desk's left edge, following the owner's titlebar
 * reference. Window controls precede it only when the roster is absent;
 * trailing actions stay at the right edge beside the workspace.
 */
export function AtumMainHeader({
  actions,
  children,
  className,
  ...props
}: ComponentProps<'div'> & { actions?: ReactNode }) {
  const { sidebarShowing, workspaceInSplit, workspaceOverFrame } = useAtumShellLayout()
  const leadsRow = !sidebarShowing && !workspaceOverFrame
  // `--titlebar-tools-right` is the native window-control overlay's width on
  // Windows/Linux (~144px; 0.75rem on macOS, where the controls are on the
  // left). The rightmost column reserves it so its actions never sit under the
  // OS overlay; with the workspace beside it, that column is the workspace.
  const reserveOverlay = !workspaceInSplit

  return (
    <AtumMainHeaderSurface
      actions={actions}
      className={className}
      leadsRow={leadsRow}
      reserveOverlay={reserveOverlay}
      windowControls={<AtumWindowControls />}
      {...props}
    >
      {children}
    </AtumMainHeaderSurface>
  )
}
