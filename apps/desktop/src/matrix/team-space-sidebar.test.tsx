import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import {
  TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH,
  TEAM_SPACE_SIDEBAR_MAX_WIDTH,
  TEAM_SPACE_SIDEBAR_MIN_WIDTH,
  TeamSpaceSidebar,
  TeamSpaceSidebarRow,
  TeamSpaceSidebarSection
} from './team-space-sidebar'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function mount(scope = 'account-a') {
  return render(
    <TeamSpaceSidebar label="Channels" resizeLabel="Resize sidebar" scope={scope}>
      <TeamSpaceSidebarSection title="Channels">
        <TeamSpaceSidebarRow icon="#" label="launch" onSelect={() => {}} selected />
      </TeamSpaceSidebarSection>
    </TeamSpaceSidebar>
  )
}

it('persists an account-scoped width through the accessible keyboard separator', async () => {
  const first = mount()
  const separator = screen.getByRole('separator', { name: 'Resize sidebar' })

  expect(separator.getAttribute('aria-valuenow')).toBe(String(TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH))
  fireEvent.keyDown(separator, { key: 'ArrowRight' })
  await waitFor(() => expect(window.localStorage.getItem('atum.team-space.sidebar-width:account-a')).toBe('284'))

  first.unmount()
  mount()
  expect(screen.getByRole('complementary', { name: 'Channels' }).getAttribute('style')).toContain('284px')

  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize sidebar' }), { key: 'End' })
  await waitFor(() => expect(window.localStorage.getItem('atum.team-space.sidebar-width:account-a'))
    .toBe(String(TEAM_SPACE_SIDEBAR_MAX_WIDTH)))
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize sidebar' }), { key: 'Home' })
  await waitFor(() => expect(window.localStorage.getItem('atum.team-space.sidebar-width:account-a'))
    .toBe(String(TEAM_SPACE_SIDEBAR_MIN_WIDTH)))
  fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize sidebar' }))
  await waitFor(() => expect(window.localStorage.getItem('atum.team-space.sidebar-width:account-a'))
    .toBe(String(TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH)))
})

it('keeps widths isolated by signed-in account scope', async () => {
  const first = mount('account-a')
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize sidebar' }), { key: 'ArrowRight', shiftKey: true })
  await waitFor(() => expect(window.localStorage.getItem('atum.team-space.sidebar-width:account-a')).toBe('316'))
  first.unmount()

  mount('account-b')
  expect(screen.getByRole('complementary', { name: 'Channels' }).getAttribute('style'))
    .toContain(`${TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH}px`)
})

it('removes the resize handle from compact focus order and restores width after a cancelled drag', () => {
  const compact = render(
    <TeamSpaceSidebar compactFull label="Channels" resizeLabel="Resize sidebar" scope="account-a">
      <span>launch</span>
    </TeamSpaceSidebar>
  )
  expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull()
  compact.unmount()

  mount()
  const frame = screen.getByRole('complementary', { name: 'Channels' })
  const separator = screen.getByRole('separator', { name: 'Resize sidebar' })
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ width: TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH } as DOMRect)
  fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: 180, pointerId: 1 })
  fireEvent.pointerCancel(window, { pointerId: 1 })
  expect(frame.getAttribute('style')).toContain(`${TEAM_SPACE_SIDEBAR_DEFAULT_WIDTH}px`)
  expect(window.localStorage.getItem('atum.team-space.sidebar-width:account-a')).toBeNull()
})

it('collapses sections and exposes the selected row as the current page', () => {
  const select = vi.fn()
  const prepare = vi.fn()
  render(
    <TeamSpaceSidebarSection title="Channels">
      <TeamSpaceSidebarRow ariaLabel="Open # launch" icon="#" label="launch" onPrepare={prepare}
        onSelect={select} selected />
    </TeamSpaceSidebarSection>
  )

  const row = screen.getByRole('button', { name: 'Open # launch' })
  expect(row.getAttribute('aria-current')).toBe('page')
  fireEvent.focus(row)
  fireEvent.pointerEnter(row)
  fireEvent.click(row)
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(select).toHaveBeenCalledOnce()

  const toggle = screen.getByRole('button', { name: 'Channels' })
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: 'Open # launch' })).toBeNull()
})
