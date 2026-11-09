import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SidebarWorkspaceGroup } from './workspace-group'
import type { SidebarSessionGroup } from './workspace-groups'

describe('agent profile header actions', () => {
  it('exposes pin and rename commands from the visible header menu', async () => {
    const onPin = vi.fn()
    const onRename = vi.fn()

    const group: SidebarSessionGroup = {
      color: '#44aa66',
      id: 'atum-main',
      label: 'Atum',
      mode: 'profile',
      onEditDisplayName: vi.fn(),
      onRenameProfile: onRename,
      onTogglePinned: onPin,
      path: null,
      pinned: false,
      profileName: 'atum-main',
      sessions: []
    }

    render(<SidebarWorkspaceGroup group={group} renderRows={() => null} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Atum' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse'
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin agent' }))
    expect(onPin).toHaveBeenCalledOnce()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Atum' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse'
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename profile…' }))
    expect(onRename).toHaveBeenCalledOnce()
  })
})
