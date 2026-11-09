import { isEditableTarget } from '@/lib/keybinds/combo'

const COMPOSER_INPUT = '[data-atum-chat] [data-slot="composer-rich-input"]'

/** A dialog, sheet or menu that is open (not merely mounted and hidden) owns focus. */
function covered(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"]')).some(
    node => !node.closest('[hidden], [inert]')
  )
}

/**
 * The message box takes focus when a chat opens, so typing goes somewhere: unless the
 * person is typing elsewhere (the roster search), or a dialog, sheet or menu is open. It
 * never moves focus because something happened in the background; callers run it for an
 * explicit open (a chat chosen, the window's first chat, the skip link).
 */
export function focusMatrixComposer({ ifIdle = false, root = document }: { ifIdle?: boolean; root?: Document } = {}) {
  const input = root.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT)

  if (!input || input.disabled || input.closest('[inert], [hidden]')) {
    return false
  }

  if (ifIdle) {
    const active = root.activeElement

    if (covered(root) || (active && active !== root.body && active !== input && isEditableTarget(active))) {
      return false
    }
  }

  input.focus({ preventScroll: true })
  const end = input.value.length
  input.setSelectionRange(end, end)

  return root.activeElement === input
}
