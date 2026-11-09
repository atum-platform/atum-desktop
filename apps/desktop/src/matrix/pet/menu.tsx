import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'

export interface PetAction {
  id: string
  label: string
  disabled?: boolean
  run(): void
}

interface PetMenuProps {
  actions: readonly PetAction[]
  children: ReactNode
  onOpenChange?(open: boolean): void
}

interface PetActionsProps {
  actions: readonly PetAction[]
}

export function PetMenu({ actions, children, onOpenChange }: PetMenuProps) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-pet-own>
        {actions.map(action => (
          <ContextMenuItem disabled={action.disabled} key={action.id} onSelect={action.run}>
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Exactly the same actions are available from the accessible paw popover. */
export function PetActions({ actions }: PetActionsProps) {
  return (
    <div className="grid grid-cols-2 gap-1">
      {actions.map(action => (
        <Button disabled={action.disabled} key={action.id} onClick={action.run} size="sm" variant="ghost">
          {action.label}
        </Button>
      ))}
    </div>
  )
}
