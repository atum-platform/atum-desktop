import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $matrixNavCan, $matrixNavLocal, resetMatrixNav, stepMatrixNav } from '@/matrix/navigation-history'

import { parseWorkSidebar, type WorkSidebarSnapshot } from '../../../shared/matrix-work'

import { useWorkHistoryArrows, WorkRightPanelToggle } from './work-band'

afterEach(() => {
  cleanup()
  resetMatrixNav()
})

describe('Work history through the window’s ← →', () => {
  it('reads back / forward from the view’s sidebar report, and refuses anything but booleans', () => {
    expect(parseWorkSidebar({ open: true, edge: 280, back: true, forward: false })).toEqual({ open: true, edge: 280, back: true })
    expect(parseWorkSidebar({ open: false, edge: 0 })).toEqual({ open: false, edge: 0 })
    expect(parseWorkSidebar({ open: true, edge: 280, back: 'yes' })).toBeNull()
  })

  it('reads the thread’s right panel from the same report, and refuses any other value', () => {
    expect(parseWorkSidebar({ open: true, edge: 280, rightPanel: 'open' })).toEqual({ open: true, edge: 280, rightPanel: 'open' })
    expect(parseWorkSidebar({ open: false, edge: 0, rightPanel: 'closed' })).toEqual({ open: false, edge: 0, rightPanel: 'closed' })
    expect(parseWorkSidebar({ open: true, edge: 280, rightPanel: true })).toBeNull()
  })

  it('puts the right-panel toggle on the title bar only while the view offers a panel, and runs T3’s toggle', () => {
    const runCommand = vi.fn(async () => true)
    const { rerender } = render(<WorkRightPanelToggle bridge={{ runCommand }} locale="en" state={undefined} />)

    expect(screen.queryByRole('button')).toBeNull()

    rerender(<WorkRightPanelToggle bridge={{ runCommand }} locale="en" state="closed" />)
    const toggle = screen.getByRole('button')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(runCommand).toHaveBeenCalledExactlyOnceWith('rightPanel.toggle')

    rerender(<WorkRightPanelToggle bridge={{ runCommand }} locale="en" state="open" />)
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
  })

  it('steps T3’s own history first while it can, then leaves ← → to the window', () => {
    const runCommand = vi.fn(async () => true)
    const bridge = { runCommand }

    const { rerender, unmount } = renderHook(({ sidebar }: { sidebar: WorkSidebarSnapshot | null }) => useWorkHistoryArrows(bridge, sidebar), {
      initialProps: { sidebar: { open: true, edge: 280, back: true } as WorkSidebarSnapshot | null }
    })

    expect($matrixNavCan.get()).toEqual({ back: true, forward: false })
    stepMatrixNav(-1)
    expect(runCommand).toHaveBeenCalledExactlyOnceWith('history.back')

    // At T3's first page the window's own places take over.
    rerender({ sidebar: { open: true, edge: 280 } })
    expect($matrixNavLocal.get()).toMatchObject({ back: false, forward: false })

    unmount()
    expect($matrixNavLocal.get()).toBeNull()
  })
})
