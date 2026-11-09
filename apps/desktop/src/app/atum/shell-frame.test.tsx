import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Dialog } from 'radix-ui'
import type { ComponentProps } from 'react'
import { useEffect, useState } from 'react'
import { expect, it, vi } from 'vitest'

import { AtumShellFrame } from './shell-frame'

function frame(overrides: Partial<ComponentProps<typeof AtumShellFrame>> = {}) {
  const closeDrawer = vi.fn()

  const view = render(
    <AtumShellFrame
      compact={false}
      main={() => <section data-testid="main-slot">Main</section>}
      navigation={<nav data-testid="nav-slot">Navigation</nav>}
      onCloseRosterDrawer={closeDrawer}
      roster={<aside data-testid="roster-slot">Roster</aside>}
      rosterDrawerCloseLabel="Close roster"
      rosterDrawerLabel="Conversations"
      rosterDrawerOpen={false}
      sidebarShowing
      workspace={() => <section data-testid="workspace-slot">Workspace</section>}
      workspaceInSplit
      workspaceOpen
      workspaceOverFrame={false}
      workspacePercent={40}
      {...overrides}
    />
  )

  return { closeDrawer, ...view }
}

it('keeps the persistent rail, roster, main and workspace in the established shell geometry', () => {
  const { container } = frame()
  const roster = screen.getByTestId('roster-slot').parentElement!
  const shell = container.querySelector('[data-atum-shell]')!

  expect(roster.hasAttribute('data-atum-roster-slot')).toBe(true)
  expect(shell.querySelector(':scope > [data-atum-destination-rail] [data-testid="nav-slot"]')).toBeTruthy()
  expect(screen.getByTestId('main-slot').parentElement?.style.gridTemplateColumns).toBe(
    'minmax(0, 60fr) minmax(0, 40fr)'
  )
  expect(screen.getByTestId('workspace-slot')).toBeTruthy()
})

it('tells the panels which one follows the rail, so only that one takes the rounded corner', () => {
  const shellOf = (view: ReturnType<typeof frame>) => view.container.querySelector('[data-atum-shell]')!

  // The roster is in the row: it is the first panel after the rail.
  const wide = frame()
  expect(shellOf(wide).hasAttribute('data-atum-rail')).toBe(true)
  expect(shellOf(wide).hasAttribute('data-atum-roster-flow')).toBe(true)
  wide.unmount()

  // Collapsed, or a compact drawer over the main panel: the main panel follows the rail.
  const collapsed = frame({ sidebarShowing: false })
  expect(shellOf(collapsed).hasAttribute('data-atum-roster-flow')).toBe(false)
  collapsed.unmount()

  const compact = frame({ compact: true, rosterDrawerOpen: true })
  expect(shellOf(compact).hasAttribute('data-atum-roster-flow')).toBe(false)
  compact.unmount()

  // No rail: no panel meets the frame at a corner.
  const bare = frame({ navigation: undefined })
  expect(shellOf(bare).hasAttribute('data-atum-rail')).toBe(false)
})

// Preserve user-visible identity, state and recovery behavior across connection changes.
// above the roster panel". macOS zooms or minimises on a double-click and moves the window on a drag
// wherever the page declares a drag region; Blink inherits `-webkit-app-region`, so the shell root
// must declare none, or every transparent layer under it (a pet's stroll) cancels the title rows.
it('gives the whole top strip to the window and declares no app region on the root', () => {
  const { container } = frame()
  const shell = container.querySelector<HTMLElement>('[data-atum-shell]')!
  const band = container.querySelector<HTMLElement>('[data-atum-titlebar-drag]')!

  expect(shell.className).not.toContain('-webkit-app-region')
  expect(band.classList.contains('[-webkit-app-region:drag]')).toBe(true)
  expect(band.classList.contains('h-(--atum-l-header)')).toBe(true)
  expect(band.classList.contains('inset-x-0')).toBe(true)
  // Behind the columns, whose title rows and controls sit over it.
  expect(band.classList.contains('-z-10')).toBe(true)
  expect(band.closest('[data-atum-main]')).toBeTruthy()
  // The rail's controls keep their own opt-out.
  expect(container.querySelector('[data-atum-destination-rail]')?.className).toContain('[-webkit-app-region:no-drag]')
})

it('drops the drag band while the compact roster drawer covers the main column', () => {
  const { container } = frame({ compact: true, rosterDrawerOpen: true })

  expect(container.querySelector('[data-atum-titlebar-drag]')).toBeNull()
})

it('uses a modal compact roster drawer and delegates its close action', () => {
  const { closeDrawer, container } = frame({ compact: true, rosterDrawerOpen: true })

  expect(container.querySelector('[data-atum-roster-slot]')).toBeNull()
  expect(screen.getByTestId('roster-slot').closest('[data-atum-roster-drawer]')).toBeTruthy()
  expect(screen.getByRole('dialog', { name: 'Conversations' }).getAttribute('aria-modal')).toBe('true')
  expect(container.querySelector('[data-atum-destination-rail]')?.hasAttribute('inert')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Close roster' }))
  expect(closeDrawer).toHaveBeenCalledOnce()
})

function KeyboardFrame({ compact = true }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false)

  return (
    <AtumShellFrame
      compact={compact}
      main={() => <button onClick={() => setOpen(true)}>Show conversations</button>}
      navigation={<button>Navigation</button>}
      onCloseRosterDrawer={() => setOpen(false)}
      roster={
        <aside>
          <input aria-label="Roster search" />
          <button onKeyDown={event => event.key === 'Escape' && event.preventDefault()}>Own Escape</button>
          <Dialog.Root>
            <Dialog.Trigger>Nested dialog</Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Content aria-describedby={undefined}>
                <Dialog.Title>Nested settings</Dialog.Title>
                <Dialog.Close>Done</Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </aside>
      }
      rosterDrawerCloseLabel="Close roster"
      rosterDrawerLabel="Conversations"
      rosterDrawerOpen={open}
      sidebarShowing
      workspaceInSplit={false}
      workspaceOpen={false}
      workspaceOverFrame={false}
      workspacePercent={40}
    />
  )
}

it('focuses the opened drawer, respects consumed Escape, and returns focus to its opener', () => {
  render(<KeyboardFrame />)
  const opener = screen.getByRole('button', { name: 'Show conversations' })
  opener.focus()
  fireEvent.click(opener)
  const drawer = screen.getByRole('dialog', { name: 'Conversations' })
  expect(window.document.activeElement).toBe(drawer)
  const ownEscape = screen.getByRole('button', { name: 'Own Escape' })
  ownEscape.focus()
  fireEvent.keyDown(ownEscape, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: 'Conversations' })).toBe(drawer)
  // A programmatic background focus attempt must remain contained too.
  screen.getByRole('button', { name: 'Navigation' }).focus()
  expect(drawer.contains(window.document.activeElement)).toBe(true)
  fireEvent.keyDown(drawer, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Conversations' })).toBeNull()
  expect(window.document.activeElement).toBe(opener)
})

it('lets a nested Radix dialog own focus and Escape before returning to the drawer', async () => {
  render(<KeyboardFrame />)
  const opener = screen.getByRole('button', { name: 'Show conversations' })
  opener.focus()
  fireEvent.click(opener)
  const nested = screen.getByRole('button', { name: 'Nested dialog' })
  nested.focus()
  fireEvent.click(nested)
  const dialog = screen.getByRole('dialog', { name: 'Nested settings' })
  expect(dialog.contains(window.document.activeElement)).toBe(true)
  fireEvent.keyDown(window.document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(window.document.activeElement).toBe(nested))
  expect(screen.getByRole('dialog', { name: 'Conversations' })).toBeTruthy()
  fireEvent.keyDown(nested, { key: 'Escape' })
  expect(window.document.activeElement).toBe(opener)
})

it('retains roster focus when a compact drawer becomes a wide sidebar', () => {
  const view = render(<KeyboardFrame />)
  const opener = screen.getByRole('button', { name: 'Show conversations' })
  opener.focus()
  fireEvent.click(opener)
  const search = screen.getByRole('textbox', { name: 'Roster search' })
  search.focus()
  view.rerender(<KeyboardFrame compact={false} />)
  expect(window.document.activeElement).toBe(search)
})

it('leaves IME composition Escape to the input', () => {
  render(<KeyboardFrame />)
  fireEvent.click(screen.getByRole('button', { name: 'Show conversations' }))
  const search = screen.getByRole('textbox', { name: 'Roster search' })
  search.focus()
  fireEvent.keyDown(search, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('dialog', { name: 'Conversations' })).toBeTruthy()
  expect(window.document.activeElement).toBe(search)
})

it('keeps the persistent destination rail when a workspace owns the frame', () => {
  const { container } = frame({ workspaceOverFrame: true })

  expect(container.querySelector('[data-atum-destination-rail]')).toBeTruthy()
  expect(container.querySelector('[data-atum-main]')?.hasAttribute('data-atum-workspace-over-frame')).toBe(true)
})

it.each([false, true])('finishes only the actual roster exit transition (compact=%s)', compact => {
  vi.useFakeTimers()

  const props = {
    compact,
    sidebarShowing: true,
    rosterDrawerOpen: true,
    workspaceOpen: false,
    workspaceInSplit: false,
    workspaceOverFrame: false,
    workspacePercent: 40,
    main: () => <div>Main</div>,
    roster: (
      <aside data-atum-roster>
        <button>Nested control</button>
      </aside>
    ),
    rosterDrawerCloseLabel: 'Close roster',
    rosterDrawerLabel: 'Conversations',
    onCloseRosterDrawer: vi.fn()
  }

  const view = render(<AtumShellFrame {...props} />)

  try {
    act(() => vi.advanceTimersByTime(20))
    const roster = view.container.querySelector<HTMLElement>('[data-atum-roster]')!
    const host = roster.parentElement!
    view.rerender(<AtumShellFrame {...props} rosterDrawerOpen={false} sidebarShowing={false} />)
    const propertyName = compact ? 'transform' : 'width'
    fireEvent.transitionEnd(roster.firstElementChild!, { propertyName })
    fireEvent.transitionEnd(compact ? host : roster, { propertyName })
    fireEvent.transitionEnd(compact ? roster : host, { propertyName: 'opacity' })
    expect(host.style.display).not.toBe('none')
    fireEvent.transitionEnd(compact ? roster : host, { propertyName })
    expect(host.style.display).toBe('none')
    expect(view.container.querySelector('.atum-drawer-scrim')).toBeNull()
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})

it('settles a reduced-motion compact exit without a transition event', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true }))
  )

  const props = {
    compact: true,
    sidebarShowing: false,
    rosterDrawerOpen: true,
    workspaceOpen: false,
    workspaceInSplit: false,
    workspaceOverFrame: false,
    workspacePercent: 40,
    main: () => <div>Main</div>,
    roster: <aside data-atum-roster>Roster</aside>,
    rosterDrawerCloseLabel: 'Close roster',
    rosterDrawerLabel: 'Conversations',
    onCloseRosterDrawer: vi.fn()
  }

  const view = render(<AtumShellFrame {...props} />)

  try {
    view.rerender(<AtumShellFrame {...props} rosterDrawerOpen={false} />)
    expect(view.container.querySelector<HTMLElement>('[data-atum-roster-drawer]')?.style.display).toBe('none')
    expect(view.container.querySelector('.atum-drawer-scrim')).toBeNull()
    expect(view.container.querySelector('[data-atum-roster]')).toBeTruthy()
  } finally {
    view.unmount()
    vi.unstubAllGlobals()
  }
})

it('keeps one roster mounted across hide/reopen and layout changes, but makes hidden controls inert', () => {
  vi.useFakeTimers()
  const mounted = vi.fn()
  const unmounted = vi.fn()

  function Roster() {
    const [draft, setDraft] = useState('')
    useEffect(() => {
      mounted()

      return unmounted
    }, [])

    return <input aria-label="Roster draft" onChange={event => setDraft(event.target.value)} value={draft} />
  }

  const props = {
    compact: false,
    sidebarShowing: true,
    rosterDrawerOpen: false,
    workspaceOpen: false,
    workspaceInSplit: false,
    workspaceOverFrame: false,
    workspacePercent: 40,
    main: () => <div>Main</div>,
    roster: <Roster />,
    rosterDrawerCloseLabel: 'Close roster',
    rosterDrawerLabel: 'Conversations',
    onCloseRosterDrawer: vi.fn()
  }

  const view = render(<AtumShellFrame {...props} />)

  try {
    act(() => vi.advanceTimersByTime(300))
    expect(view.container.querySelector<HTMLElement>('[data-atum-roster-slot]')?.style.width).toBe('268px')
    fireEvent.change(screen.getByRole('textbox', { name: 'Roster draft' }), { target: { value: 'pending setup' } })
    view.rerender(<AtumShellFrame {...props} sidebarShowing={false} />)
    expect(view.container.querySelector<HTMLElement>('[data-atum-roster-slot]')?.style.width).toBe('0px')
    act(() => vi.advanceTimersByTime(300))
    expect(unmounted).not.toHaveBeenCalled()
    const input = screen.getByRole('textbox', { hidden: true })
    expect(input.closest('[inert]')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Roster draft' })).toBeNull()
    view.rerender(<AtumShellFrame {...props} compact rosterDrawerOpen />)
    act(() => vi.advanceTimersByTime(300))
    expect((screen.getByRole('textbox', { name: 'Roster draft' }) as HTMLInputElement).value).toBe('pending setup')
    expect(mounted).toHaveBeenCalledOnce()
    view.rerender(<AtumShellFrame {...props} compact />)
    const drawer = input.closest('[data-atum-roster-drawer]')
    expect(drawer?.hasAttribute('inert')).toBe(true)
    expect(view.container.querySelector('.atum-drawer-scrim')?.hasAttribute('inert')).toBe(true)
    act(() => vi.advanceTimersByTime(300))
    view.rerender(<AtumShellFrame {...props} />)
    act(() => vi.advanceTimersByTime(300))
    expect((screen.getByRole('textbox', { name: 'Roster draft' }) as HTMLInputElement).value).toBe('pending setup')
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(mounted).toHaveBeenCalledOnce()
  } finally {
    view.unmount()
    vi.useRealTimers()
  }

  expect(unmounted).toHaveBeenCalledOnce()
})
