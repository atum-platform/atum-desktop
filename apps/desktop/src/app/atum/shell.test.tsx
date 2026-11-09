import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'

vi.mock('@/store/atum-messaging', async () => {
  const { atom, computed } = await import('nanostores')

  const $atumAccountStatus = atom<AtumAccountStatus>({
    state: 'signed_in',
    configured: true,
    account: { id: 'a', displayName: 'Minh' },
    errorCode: null,
    providers: { google: true, password: true }
  })

  const $atumRoster = atom([])

  return {
    $atumAccountScopeId: computed($atumAccountStatus, status => status.account?.id ?? null),
    $atumAccountStatus,
    $atumConnectivity: atom('online'),
    $atumSocialRelationships: atom([]),
    $atumRoster,
    $atumSortedRoster: $atumRoster,
    $atumIsAuthenticated: computed($atumAccountStatus, status => status.state === 'signed_in'),
    cancelAtumSignIn: vi.fn(),
    initializeAtumMessaging: vi.fn(async () => undefined),
    refreshAtumAccountStatus: vi.fn(),
    refreshAtumRoster: vi.fn(),
    refreshAtumStatus: vi.fn(),
    signInToAtum: vi.fn(),
    signInToAtumWithPassword: vi.fn(),
    signOutOfAtum: vi.fn()
  }
})

// Exercise the Linux renderer path even when this file runs on a developer's
// Mac. The workspace and its close control belong to every platform.
const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')

const userAgent = vi
  .spyOn(navigator, 'userAgent', 'get')
  .mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')

const { $atumAccountStatus, $atumSortedRoster } = await import('@/store/atum-messaging')
const { $previewTarget } = await import('@/store/preview')
const { resetManagedModelAccess } = await import('@/store/atum-managed-model')
const { $currentCwd } = await import('@/store/session')
const { $atumUpdate } = await import('@/store/atum-updates')
const { $notifications } = await import('@/store/notifications')
const { completeDesktopBoot, waitForDesktopAccount } = await import('@/store/boot')

const {
  $railDestination,
  $rosterWidth,
  $sidebarOpen,
  $workspaceExpanded,
  $workspaceOpen,
  resetAtumShellState,
  setRosterDrawerOpen
} = await import('@/store/atum-shell')

const { $activeWorkbenchTabId, $visibleWorkbenchTabs, openWorkbenchSingleton, clearWorkbenchTabs } =
  await import('@/store/workbench-tabs')

// These tests exercise shell state and retained workspace behavior, not Vite's
// cold dynamic-module transform. Resolve the shell's React.lazy panel during
// file setup, outside the per-test clock; the dedicated placeholder test below
// still pins the loading-state window controls.
await import('./workspace-panel')
const { AtumShellRoot, AtumWorkspacePlaceholder } = await import('./shell')

const signedIn: AtumAccountStatus = {
  state: 'signed_in',
  configured: true,
  account: { id: 'a', displayName: 'Minh' },
  errorCode: null,
  providers: { google: true, password: true }
}

const writableRoster = $atumSortedRoster as unknown as {
  set(next: Array<Record<string, unknown>>): void
}

const relaunchUpdate = vi.fn(async () => ({ accepted: true }))

function renderShell(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AtumShellRoot />
    </MemoryRouter>
  )
}

afterAll(() => {
  platform.mockRestore()
  userAgent.mockRestore()
})

afterEach(cleanup)

beforeEach(() => {
  completeDesktopBoot()
  relaunchUpdate.mockReset().mockResolvedValue({ accepted: true })
  $atumUpdate.set(null)
  $notifications.set([])
  Object.assign(window, {
    hermesDesktop: {
      ...window.hermesDesktop,
      actionPanelOwner: true,
      appUpdate: {
        relaunch: relaunchUpdate
      }
    }
  })
  window.localStorage.setItem('hermes.desktop.atum.welcomeSeen', 'true')
  resetManagedModelAccess()
  resetAtumShellState()
  clearWorkbenchTabs()
  $activeWorkbenchTabId.set(null)
  // Model the wide demo viewport: per amended R-3 the panel opens by default
  // only at >=1280px; jsdom's 1024px default would model the closed drawer.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  $workspaceOpen.set(true)
  $previewTarget.set(null)
  // No cwd and no preview: the Assistant still exposes Atum's file browser,
  // whose own empty state explains that no folder is open yet.
  $currentCwd.set('')
  $atumAccountStatus.set(signedIn)
  writableRoster.set([])
})

describe('AtumShellRoot — signed in', () => {
  it('closes the portaled account menu when the shell hides its retained roster', async () => {
    const { container } = renderShell()
    fireEvent.keyDown(container.querySelector('[data-atum-account-trigger]')!, { key: 'ArrowDown' })
    expect(await screen.findByRole('menu')).toBeTruthy()
    act(() => $sidebarOpen.set(false))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(container.querySelector('[data-atum-roster]')).toBeTruthy()
    act(() => $sidebarOpen.set(true))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps employee synchronization active while Discover hides the roster', async () => {
    const previous = window.hermesDesktop.agentSync
    const stop = vi.fn()
    const status = vi.fn(async () => [])

    let changed = () => {}
    Object.assign(window.hermesDesktop, {
      agentSync: {
        status,
        onChanged: (callback: () => void) => {
          changed = callback

          return stop
        }
      }
    })
    const { container, unmount } = renderShell()

    try {
      act(() => $railDestination.set('discover'))
      await waitFor(() =>
        expect(container.querySelector<HTMLElement>('[data-atum-roster-slot]')?.style.display).toBe('none')
      )
      status.mockClear()
      act(() => changed())
      await waitFor(() => expect(status).toHaveBeenCalled())
      expect(stop).not.toHaveBeenCalled()
      unmount()
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
      Object.assign(window.hermesDesktop, { agentSync: previous })
    }
  })

  it('enters the normal shell without a blocking welcome or model-provider setup', () => {
    window.localStorage.removeItem('hermes.desktop.atum.welcomeSeen')
    const { container } = renderShell()

    expect(container.querySelector('[data-slot="atum-welcome-storyboard"]')).toBeNull()
    expect(container.textContent).not.toMatch(/API key|OpenRouter|OpenAI|choose (?:a )?provider/iu)
    expect(container.querySelector('[data-atum-chat]')).toBeTruthy()
  })

  it('uses a continuous chrome band with a persistent destination rail and collapsible roster', () => {
    const { container } = renderShell()

    expect(container.querySelector('[data-atum-rim]')).toBeNull()
    expect(container.querySelector('[data-atum-top-bar]')).toBeNull()
    // The only <nav> is the destination switch in the persistent left rail.
    expect(globalThis.document.querySelectorAll('nav')).toHaveLength(1)
    expect(container.textContent).not.toContain('Atum - Siêu ứng dụng AI cho người Việt.')

    const shell = container.querySelector('[data-atum-shell]')!

    expect(shell.firstElementChild!.hasAttribute('data-atum-destination-rail')).toBe(true)
    expect(shell.querySelector(':scope > [data-atum-destination-rail] [data-atum-nav-tray]')).toBeTruthy()
    const roster = shell.querySelector('[data-atum-roster]')!
    expect(roster.classList.contains('atum-sidebar')).toBe(true)
    expect(roster.querySelector('[data-atum-roster-header] [data-atum-traffic-lights]')).toBeTruthy()
    expect(roster.querySelector('[data-atum-roster-header] [aria-label="Hide sidebar"]')).toBeTruthy()

    // The chat column's row carries the identity and, while the sidebar shows,
    // no window controls of its own — they are on the leftmost row only.
    const header = container.querySelector('[data-atum-chat] [data-atum-main-header]')!
    expect(header.querySelector('[data-atum-chat-header]')).toBeTruthy()
    expect(header.querySelector('[data-atum-window-controls]')).toBeNull()
    // The destination switch belongs to the rail, not to the roster account
    // footer and not to a floating dock over the composer.
    expect(roster.querySelector('[data-atum-nav-switch]')).toBeNull()
    expect(shell.querySelector('[data-atum-destination-rail] [data-atum-nav-home]')).toBeTruthy()
    expect(roster.querySelector('[data-atum-nav-dock-reserve]')).toBeNull()
  })

  it('keeps the destination rail exactly where it is when the roster collapses', () => {
    const { container } = renderShell()
    const before = container.querySelector('[data-atum-destination-rail]')

    expect(container.querySelectorAll('[data-atum-destination-rail]')).toHaveLength(1)

    act(() => $sidebarOpen.set(false))

    expect(container.querySelectorAll('[data-atum-destination-rail]')).toHaveLength(1)
    // Same element: not re-mounted, not re-parented.
    expect(container.querySelector('[data-atum-destination-rail]')).toBe(before)
    expect(before!.closest('[data-atum-main]')).toBeNull()
    expect(before!.closest('[data-atum-roster]')).toBeNull()
    expect(before!.closest('[data-atum-main]')).toBeNull()
  })

  it('gives the frame up whole to a workspace that takes it', async () => {
    // "Phóng to" means the panel's box IS the shell's box (SPEC §1a). A tray
    // left at the main column's foot shaves its own height off the top of that
    // claim: a strip of another column showing under a panel that is supposed
    // to be the window. The switch goes where its destinations are, so it
    // leaves with them and returns the moment the panel rejoins the split.
    const { container } = renderShell()

    act(() => $sidebarOpen.set(false))

    expect(container.querySelectorAll('[data-atum-destination-rail]')).toHaveLength(1)

    act(() => $workspaceExpanded.set(true))
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>('[data-atum-roster-slot]')?.style.display).toBe('none')
    )

    expect(container.querySelectorAll('[data-atum-destination-rail]')).toHaveLength(1)

    act(() => $workspaceExpanded.set(false))

    expect(container.querySelectorAll('[data-atum-destination-rail]')).toHaveLength(1)
  })

  it('collapses the roster when Discover opens, keeps the switch put, and gives the roster back if asked', () => {
    const { container } = renderShell()
    const dock = container.querySelector('[data-atum-destination-rail]')
    const slot = () => container.querySelector('[data-atum-roster-slot]')

    // jsdom never fires transitionend, so width and final presence lie here —
    // but the slot's data-atum-motion phase flips synchronously when the shell
    // decides, and it does not lie. #283 skipped this assertion and shipped a
    // roster that stayed open beside the storefront.
    // Present on arrival (mid-entrance under jsdom, which never finishes it).
    expect(slot()?.getAttribute('data-atum-motion')).not.toBe('exiting')

    act(() => $railDestination.set('discover'))
    expect(slot()?.getAttribute('data-atum-motion')).toBe('exiting')
    // Exactly one live sidebar toggle, labelled for what is on screen.
    const toggles = [...container.querySelectorAll('[data-atum-sidebar-toggle]')].filter(el => !el.closest('[inert]'))
    expect(toggles).toHaveLength(1)
    expect(toggles[0]!.getAttribute('aria-label')).toBe('Show sidebar')
    // The switch did not move.
    expect(container.querySelector('[data-atum-destination-rail]')).toBe(dock)
    // Presentation only: the chat preference is untouched.
    expect($sidebarOpen.get()).toBe(true)

    // A default, not a lock.
    fireEvent.click(toggles[0]!)
    expect(slot()?.getAttribute('data-atum-motion')).not.toBe('exiting')

    // Leaving and returning collapses again.
    act(() => $railDestination.set('chat'))
    act(() => $railDestination.set('discover'))
    expect(slot()?.getAttribute('data-atum-motion')).toBe('exiting')
    expect(container.querySelector('[data-atum-destination-rail]')).toBe(dock)
  })

  it('keeps Discover out of the search row and opens settings from the whole account row', async () => {
    const { container } = renderShell()

    const footer = container.querySelector('[data-atum-roster-footer]')!

    expect(footer.querySelector('[aria-label="Account"]')).toBeTruthy()
    // Discover is a destination, not a search action: it lives on the top
    // row's switch, not in the search row.
    expect(container.querySelector('[data-atum-search-actions] [aria-label="Discover"]')).toBeNull()
    const discover = container.querySelector<HTMLElement>('[data-atum-nav-switch] [data-atum-nav-discover]')!
    expect(discover.getAttribute('aria-current')).toBeNull()
    fireEvent.click(discover)
    expect($railDestination.get()).toBe('discover')
    expect(
      container.querySelector('[data-atum-nav-switch] [data-atum-nav-discover]')!.getAttribute('aria-current')
    ).toBe('page')
    expect(
      container.querySelector('[data-atum-nav-switch] [data-atum-nav-workplace]')!.getAttribute('aria-disabled')
    ).toBe('true')
    fireEvent.click(container.querySelector('[data-atum-nav-switch] [data-atum-nav-home]')!)
    expect($railDestination.get()).toBe('chat')
    expect(footer.querySelector('[data-atum-account-name]')!.closest('button')).toBe(
      footer.querySelector('[aria-label="Account"]')
    )
    fireEvent.pointerDown(footer.querySelector('[aria-label="Account"]')!, { button: 0, ctrlKey: false })
    expect(await screen.findByRole('menuitem', { name: 'Settings' })).toBeTruthy()
    // Devices is gone until it is real; appearance lives in Settings.
    expect(screen.queryByRole('button', { name: 'Computer' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Appearance/u })).toBeNull()
  })

  it('gives Discover the whole plate and hides the workspace without disposing it', async () => {
    // Discover is where you add something to Atum. A tool pane left open next
    // to it belongs to a conversation the user is no longer looking at.
    $workspaceOpen.set(true)
    const { container } = renderShell()

    expect(container.querySelector('[data-atum-workspace], [data-atum-workspace-loading]')).toBeTruthy()

    await screen.findByTestId('atum-workspace-close')
    act(() => $railDestination.set('discover'))

    expect(container.querySelector('[data-atum-workspace]')!.hasAttribute('inert')).toBe(true)
    // Presentation only: going back to chat restores what the user had.
    expect($workspaceOpen.get()).toBe(true)
  })

  it('remembers an explicit reveal during Discover until chat returns', async () => {
    $workspaceOpen.set(false)
    const { container } = renderShell()
    act(() => $railDestination.set('discover'))
    act(() => {
      openWorkbenchSingleton('tools')
    })
    const activeTab = $activeWorkbenchTabId.get()

    expect($workspaceOpen.get()).toBe(true)
    expect($railDestination.get()).toBe('discover')
    await screen.findByTestId('atum-workspace-close')
    expect(container.querySelector('[data-atum-workspace]')!.hasAttribute('inert')).toBe(true)
    act(() => $railDestination.set('chat'))
    expect(container.querySelector('[data-atum-workspace]')!.hasAttribute('inert')).toBe(false)
    expect($activeWorkbenchTabId.get()).toBe(activeTab)
  })

  it('preserves the hidden workspace state when Escape is pressed on Discover', () => {
    renderShell()
    act(() => {
      $workspaceOpen.set(true)
      $workspaceExpanded.set(true)
      $railDestination.set('discover')
    })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect($workspaceOpen.get()).toBe(true)
    expect($workspaceExpanded.get()).toBe(true)
  })

  it('offers no way to open a workspace that Discover has no room for', () => {
    // Closed workspace: the chat header offers the open control; Discover must not.
    $workspaceOpen.set(false)
    const { container } = renderShell()

    expect(container.querySelector('[data-atum-chat] [data-atum-main-header] [data-atum-open-workspace]')).toBeTruthy()

    act(() => $railDestination.set('discover'))

    expect(container.querySelector('[data-atum-discover-header]')).toBeTruthy()
    expect(container.querySelector('[data-atum-open-workspace]')).toBeNull()
  })

  it('expands the workspace to the whole frame: the plate steps aside, the chat waits underneath', async () => {
    // SPEC §1a's "phóng to". The plate is hidden, not closed — `$sidebarOpen`
    // keeps the person's choice — and the chat stays mounted so the composer,
    // the transcript and a running turn all survive the trip.
    const { container } = renderShell()

    expect(container.querySelector('[data-atum-roster-slot]')).toBeTruthy()

    act(() => $workspaceExpanded.set(true))

    expect(container.querySelector('[data-atum-roster-slot]')?.getAttribute('data-atum-motion')).toBe('exiting')
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>('[data-atum-roster-slot]')?.style.display).toBe('none')
    )
    expect($sidebarOpen.get()).toBe(true)
    expect(container.querySelector('[data-atum-chat]')).toBeTruthy()
    expect(container.querySelector('[data-atum-chat]')?.hasAttribute('inert')).toBe(true)

    act(() => $workspaceExpanded.set(false))

    expect(container.querySelector('[data-atum-chat]')?.hasAttribute('inert')).toBe(false)
  })

  it('hands the window controls to the full-frame workspace, whose toggle takes the sidebar back', async () => {
    const { container } = renderShell()

    act(() => $workspaceExpanded.set(true))
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>('[data-atum-roster-slot]')?.style.display).toBe('none')
    )

    // The panel owns the frame, so it is the leftmost column: its tab bar
    // leads with the controls, and the covered chat header offers none.
    const toggle = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-atum-workspace-tabbar] [data-atum-sidebar-toggle]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(container.querySelector('[data-atum-chat] [data-atum-window-controls]')).toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('Show sidebar')

    fireEvent.click(toggle)

    expect($workspaceExpanded.get()).toBe(false)
    expect($sidebarOpen.get()).toBe(true)
    await waitFor(() => expect(container.querySelector('[data-atum-roster]')).toBeTruthy())
  })

  it('leaves full frame on Escape', () => {
    renderShell()

    act(() => $workspaceExpanded.set(true))
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true })
    expect($workspaceExpanded.get()).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })

    expect($workspaceExpanded.get()).toBe(false)
  })

  it('opens the identity editor from the sidebar footer without loading unrelated app connections', async () => {
    const linkedApps = vi.fn(async () => [
      { app: 'moon', displayName: 'Moon', state: 'linked' as const, connectedAt: null, lastActiveAt: null }
    ])

    Object.assign(window.hermesDesktop, {
      messaging: { linkedApps } as unknown as typeof window.hermesDesktop.messaging
    })

    renderShell()
    const accountButton = screen.getByRole('button', { name: 'Account' })

    fireEvent.pointerDown(accountButton, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Minh' }))

    const dialog = screen.getByRole('dialog', { name: 'Your account' })

    expect(linkedApps).not.toHaveBeenCalled()
    expect(within(dialog).queryByText('Moon')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Copy Atum ID' })).toBeTruthy()
  })

  it('reveals the downloaded update as a primary button on the right of the footer and relaunches only on click', () => {
    const { container } = renderShell()

    expect(screen.queryByRole('button', { name: 'Relaunch to update' })).toBeNull()

    act(() => $atumUpdate.set({
      armed: true, packaged: true, channel: 'latest', state: 'downloaded', version: '0.18.0', checkedAt: null,
      progress: 100, notes: [], error: null, requiredBelow: null
    }))
    const update = screen.getByRole('button', { name: 'Relaunch to update' })
    const footer = container.querySelector('[data-atum-roster-footer]')!

    // The row sits immediately above the footer, inside the plate.
    expect(update.closest('[data-atum-roster]')).toBeTruthy()
    expect(update.parentElement).toBe(footer)
    expect(relaunchUpdate).not.toHaveBeenCalled()
    fireEvent.click(update)
    expect(relaunchUpdate).toHaveBeenCalledOnce()
  })

  it('explains a restart rejected because another window still has work', async () => {
    relaunchUpdate.mockResolvedValue({ accepted: false })
    $atumUpdate.set({
      armed: true, packaged: true, channel: 'latest', state: 'downloaded', version: '0.18.0', checkedAt: null,
      progress: 100, notes: [], error: null, requiredBelow: null
    })
    renderShell()

    fireEvent.click(screen.getByRole('button', { name: 'Relaunch to update' }))

    await waitFor(() =>
      expect($notifications.get()).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'info', message: expect.stringMatching(/work/i) })])
      )
    )
    expect(relaunchUpdate).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Relaunch to update' })).toBeTruthy()
  })

  it('renders no statusbar and no pane tree', () => {
    const { container } = renderShell()

    expect(container.querySelector('[data-slot="statusbar"]')).toBeNull()
    expect(container.querySelector('[data-pane-tree]')).toBeNull()
  })

  it('aligns the chat identity at the start of its titlebar, without a second header', () => {
    const { container } = renderShell()

    const header = container.querySelector('[data-atum-chat-header]')!

    expect(header).toBeTruthy()
    expect(header.querySelector('[data-atum-chat-title]')!.textContent).toBe('Atum')
    expect(header.querySelector('[data-atum-chat-subtitle]')!.textContent).toBe('Your assistant on this Mac')
    // The identity sits in the row's middle cell; the ⋯ menu (one item, a
    // duplicate of the sidebar's compose control) is gone.
    expect(header.parentElement!.className).toContain('justify-start')
    expect(container.querySelector('[data-atum-chat-menu]')).toBeNull()
    // The workspace is open at this width, so its open control stays hidden.
    expect(container.querySelector('[data-atum-open-workspace]')).toBeNull()
    expect(container.querySelectorAll('[data-atum-chat-header]')).toHaveLength(1)
    expect(container.querySelector('.atum-chat-header')).toBeNull()
  })

  it('starts with the workspace open at a wide viewport and closes it from its own tab bar', async () => {
    const { container } = renderShell()

    expect($workspaceOpen.get()).toBe(true)
    // The workspace panel is an on-demand chunk; its tab bar arrives a tick later.
    const close = await screen.findByTestId('atum-workspace-close')
    expect(close.hasAttribute('aria-disabled')).toBe(false)
    fireEvent.click(close)
    expect($workspaceOpen.get()).toBe(false)
    // With the panel closed the chat header offers the way back in.
    expect(container.querySelector('[data-atum-chat] [data-atum-main-header] [data-atum-open-workspace]')).toBeTruthy()
  })

  it('hides a panel with active tabs and restores the same content when reopened', async () => {
    const { container } = renderShell()
    act(() => openWorkbenchSingleton('tools'))
    const id = $activeWorkbenchTabId.get()
    const close = await screen.findByTestId('atum-workspace-close')
    const panel = container.querySelector('[data-atum-workspace]')!
    fireEvent.click(close)
    expect($workspaceOpen.get()).toBe(false)
    expect($activeWorkbenchTabId.get()).toBe(id)
    expect($visibleWorkbenchTabs.get().some(tab => tab.id === id)).toBe(true)
    fireEvent.transitionEnd(panel)
    await waitFor(() => expect(panel.hasAttribute('inert')).toBe(true))
    fireEvent.click(container.querySelector('[data-atum-open-workspace]')!)
    expect($workspaceOpen.get()).toBe(true)
    expect(container.querySelector('[data-atum-workspace]')).toBe(panel)
    expect($activeWorkbenchTabId.get()).toBe(id)
    expect(panel.hasAttribute('inert')).toBe(false)
  })

  it('starts the transcript and workspace at the SPEC §2 50/50 split', () => {
    const { container } = renderShell()
    const split = container.querySelector<HTMLElement>('[data-atum-main-split]')!

    expect(split.style.gridTemplateColumns).toBe('minmax(0, 50fr) minmax(0, 50fr)')
  })

  it('collapses the sidebar and hands the window controls to the chat row', () => {
    const { container } = renderShell()
    const rosterHeader = () => container.querySelector('[data-atum-roster-header]')
    const chatHeader = () => container.querySelector('[data-atum-chat] [data-atum-main-header]')!
    const toggle = rosterHeader()!.querySelector('[aria-label="Hide sidebar"]')!

    expect(container.querySelector('[data-atum-roster]')).toBeTruthy()
    expect(chatHeader().querySelector('[data-atum-window-controls]')).toBeNull()

    fireEvent.click(toggle)

    expect($sidebarOpen.get()).toBe(false)
    const departing = container.querySelector('[data-atum-roster-slot]')!
    expect(departing.getAttribute('data-atum-motion')).toBe('exiting')
    expect(departing.hasAttribute('inert')).toBe(true)
    fireEvent.transitionEnd(departing, { propertyName: 'width' })

    // The column leaves and the controls move to the row that is now leftmost
    // — the chat's — which is the same height and starts at the same inset,
    // so they keep their place on screen. Exactly one live row hosts them;
    // the hidden roster keeps its state but cannot take input.
    expect((departing as HTMLElement).style.display).toBe('none')
    expect(chatHeader().querySelector('[data-atum-window-controls] [data-atum-traffic-lights]')).toBeTruthy()
    expect(
      Array.from(container.querySelectorAll('[data-atum-window-controls]')).filter(node => !node.closest('[inert]'))
    ).toHaveLength(1)

    fireEvent.click(chatHeader().querySelector('[aria-label="Show sidebar"]')!)

    expect($sidebarOpen.get()).toBe(true)
    expect(container.querySelector('[data-atum-roster]')).toBeTruthy()
    expect(rosterHeader()!.querySelector('[data-atum-traffic-lights]')).toBeTruthy()
    expect(chatHeader().querySelector('[data-atum-window-controls]')).toBeNull()
  })

  it('keeps exactly one live window-control host while the compact drawer leaves', () => {
    // Compact: every max-width query matches. jsdom has no matchMedia, so the
    // shell would otherwise always model the wide window.
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: /max-width/u.test(query),
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined
      })
    })

    try {
      $workspaceOpen.set(false)
      const { container } = renderShell()

      const live = () =>
        Array.from(container.querySelectorAll('[data-atum-window-controls]')).filter(node => !node.closest('[inert]'))

      // Drawer closed: the chat's row hosts the controls.
      expect(
        container.querySelector('[data-atum-chat] [data-atum-main-header] [data-atum-window-controls]')
      ).toBeTruthy()
      expect(live()).toHaveLength(1)

      act(() => setRosterDrawerOpen(true))
      // Drawer open: its own row hosts them, and the main column is inert behind the scrim.
      expect(container.querySelector('[data-atum-roster-drawer] [data-atum-window-controls]')).toBeTruthy()
      expect(container.querySelector('[data-atum-main]')!.hasAttribute('inert')).toBe(true)
      expect(live()).toHaveLength(1)

      act(() => setRosterDrawerOpen(false))
      // Leaving: the chat's row takes them back at once, and the departing
      // drawer (and its scrim) are inert for the length of the animation — so
      // there is never a second live toggle on screen.
      const drawer = container.querySelector('[data-atum-roster-drawer]')!
      expect(drawer.getAttribute('data-atum-motion')).toBe('exiting')
      expect(drawer.hasAttribute('inert')).toBe(true)
      expect(container.querySelector('.atum-drawer-scrim')!.hasAttribute('inert')).toBe(true)
      expect(container.querySelector('[data-atum-main]')!.hasAttribute('inert')).toBe(false)
      expect(live()).toHaveLength(1)

      fireEvent.transitionEnd(drawer.querySelector('[data-atum-roster]')!, { propertyName: 'transform' })
      expect((drawer as HTMLElement).style.display).toBe('none')
      expect(live()).toHaveLength(1)
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
    }
  })

  it('hosts the window controls on the workspace placeholder while a full-frame chunk loads', () => {
    // The chat header stands its controls down as soon as the layout says
    // the workspace owns the frame; the placeholder must pick them up.
    const { container } = render(
      <MemoryRouter>
        <AtumWorkspacePlaceholder overFrame />
      </MemoryRouter>
    )

    expect(
      container.querySelector('[data-atum-workspace-loading] [data-atum-window-controls] [data-atum-sidebar-toggle]')
    ).toBeTruthy()
    expect(container.querySelector('[data-atum-workspace-loading]')!.className).toContain('absolute inset-0')
  })

  it('keeps the sidebar plate at its 268px width with no resize handle', () => {
    const { container } = renderShell()

    expect(container.querySelector('[data-atum-roster] [role="separator"]')).toBeNull()
    expect(container.querySelector('[data-atum-roster]')!.className).toContain('w-(--atum-l-roster)')
    expect($rosterWidth.get()).toBe(268)
  })

  it.each([208, 420])('ignores the saved v1 roster width %i for the fixed v2 slot', async width => {
    $rosterWidth.set(width)
    const { container } = renderShell()

    await waitFor(() =>
      expect(container.querySelector<HTMLElement>('[data-atum-roster-slot]')!.style.width).toBe('268px')
    )
  })

  it('does not change workspace intent when a preview target arrives in the background', () => {
    renderShell()

    expect($workspaceOpen.get()).toBe(true)
    $previewTarget.set({ url: 'http://localhost:3000', kind: 'url' } as never)
    expect($workspaceOpen.get()).toBe(true)
  })
})

describe('AtumShellRoot — auth gate', () => {
  it.each(['unconfigured', 'error'] as const)(
    'hides cached workspace content while required account status is %s',
    state => {
      waitForDesktopAccount()
      $atumAccountStatus.set({ ...signedIn, configured: false, account: null, state })
      const { container } = renderShell()

      expect(container.querySelector('[data-atum-roster]')).toBeNull()
      expect(container.querySelector('.atum-plate-chat')).toBeNull()
      expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
    }
  )

  it.each(['signed_out', 'signing_in', 'expired', 'error'] as const)(
    'replaces the entire shell when the account is %s',
    state => {
      $atumAccountStatus.set({ ...signedIn, account: null, state })
      renderShell()

      // The inline-sidebar-form regression cannot come back silently: with the
      // gate up there is no rail, no roster, and no chat plate in the DOM at all.
      expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
      expect(globalThis.document.querySelector('.atum-plate-chat')).toBeNull()
      expect(globalThis.document.querySelector('[data-atum-roster]')).toBeNull()
      expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
    }
  )

  it('keeps the product shell mounted while a signed-in session refreshes', () => {
    $atumAccountStatus.set({ ...signedIn, state: 'refreshing' })
    renderShell()

    expect(screen.getByRole('button', { name: 'Account' })).toBeTruthy()
  })

  it('uses the generic account glyph when no account identity exists', () => {
    $atumAccountStatus.set({ ...signedIn, configured: false, account: null, state: 'unconfigured' })
    const { container } = renderShell()

    const accountButton = screen.getByRole('button', { name: 'Account' })

    expect(accountButton.querySelector('[aria-hidden]')?.textContent).not.toBe('A')
    expect(accountButton.querySelector('svg')).toBeTruthy()
  })

  it('does NOT gate an unconfigured build — the app still works without hosted DMs', () => {
    $atumAccountStatus.set({ ...signedIn, configured: false, account: null, state: 'unconfigured' })
    renderShell()

    expect(screen.getByRole('button', { name: 'Account' })).toBeTruthy()
  })
})
