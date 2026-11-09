import { useEffect } from 'react'

import { comboAllowedInInput, comboFromEvent, comboOwnedByLocalScope, isEditableTarget } from '@/lib/keybinds/combo'
import { $capture, $comboIndex } from '@/store/keybinds'

export interface MatrixShellShortcuts {
  enabled: boolean
  paletteOpen: boolean
  /** Only actions implemented by the Matrix shell may consume a shared binding. */
  handlers: Readonly<Record<string, () => void>>
}

/** Do not mount the legacy runtime: its handlers own a different account/session. */
export function useShellShortcuts({ enabled, paletteOpen, handlers }: MatrixShellShortcuts): void {
  useEffect(() => {
    if (!enabled) {
      return
    }

    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || $capture.get()) {
        return
      }

      // Consumer text is not a power shortcut, even if a legacy override bound it.
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        return
      }

      const combo = comboFromEvent(event)

      if (!combo || comboOwnedByLocalScope(event.target, combo)) {
        return
      }

      const id = $comboIndex.get().get(combo)
      const run = id ? handlers[id] : undefined

      if (!run || (paletteOpen && id !== 'nav.commandPalette')) {
        return
      }

      if (isEditableTarget(event.target) && !comboAllowedInInput(combo)) {
        return
      }

      // Child-owned dialogs/menus are not all represented in shell state. Their
      // live DOM fence also covers retained closing content. Hidden Settings is
      // always mounted and must not disable the whole shell.
      const covering = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"]')
      ).some(node => {
        // The roster may close/focus itself, but must not open other shell
        // destinations over its focus trap. Nested dialogs still take priority.
        if (
          (id === 'view.toggleSidebar' || id === 'session.focusSearch') &&
          node.matches('[data-atum-roster-drawer]')
        ) {
          return false
        }

        return !node.closest('[hidden], [inert], [data-matrix-command-palette]')
      })

      if (covering) {
        return
      }

      event.preventDefault()
      run()
    }

    window.addEventListener('keydown', keydown)

    return () => window.removeEventListener('keydown', keydown)
  }, [enabled, handlers, paletteOpen])
}
