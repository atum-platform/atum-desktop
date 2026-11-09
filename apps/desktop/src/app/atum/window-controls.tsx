import { useAtumShellLayout } from './shell-layout'
import { AtumWindowControlsSurface } from './shell-surface'

export { AtumWindowControlsSurface } from './shell-surface'

/**
 * The window controls: the native traffic-light reservation and the sidebar
 * toggle. One component, rendered at the START of whichever top row is
 * leftmost — the sidebar's while it shows, otherwise the chat/Discover header,
 * or the workspace tab bar when that panel owns the frame.
 *
 * The lights are native. Electron draws them at `ATUM_SHELL_WINDOW_BUTTON_POSITION`
 * (electron/atum-window-mode.ts): x 20, in the persistent 52px destination
 * rail, and y centred on the shared 48px chrome band. Content rows begin
 * after that rail, so they reserve only the final 16px of the native group
 * before their toggle. This keeps the real control beside the lights instead
 * of creating a second, floating renderer titlebar.
 */
export function AtumWindowControls({ className }: { className?: string }) {
  const { reserveLights, sidebarLabel, toggleSidebar } = useAtumShellLayout()

  return (
    <AtumWindowControlsSurface
      className={className}
      onToggleSidebar={toggleSidebar}
      reserveLights={reserveLights}
      sidebarLabel={sidebarLabel}
    />
  )
}
