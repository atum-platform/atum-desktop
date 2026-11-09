import { TitlebarControls, type TitlebarTool } from '../shell/titlebar-controls'

interface ProductTitlebarControlsProps {
  atumShellEnabled: boolean
  leftTools?: readonly TitlebarTool[]
  tools?: readonly TitlebarTool[]
  onOpenSettings: () => void
}

/**
 * The Hermes controls are a legacy-shell capability, not global window chrome.
 * Keeping that product boundary in a tiny rendered component makes it testable
 * without source-text guards or mounting the entire gateway controller.
 */
export function ProductTitlebarControls({ atumShellEnabled, ...props }: ProductTitlebarControlsProps) {
  return atumShellEnabled ? null : <TitlebarControls {...props} />
}
