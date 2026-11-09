import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { recordAgentEdit, resetAgentEditReviews } from '@/store/agent-edits'
import { $appViewOverlayCount, resetAppViewOverlayForTests } from '@/store/app-view-overlay'
import {
  $sidebarOpen,
  $workspaceExpanded,
  $workspacePercent,
  ATUM_WORKSPACE_DEFAULT_PERCENT,
  resetAtumShellState
} from '@/store/atum-shell'
import {
  $activeWorkbenchTabId,
  $visibleWorkbenchTabs,
  $workbenchScope,
  $workbenchTabs,
  ensureWorkbenchAppMenu,
  openPreviewWorkbenchTab,
  openWorkbenchBrowser,
  openWorkbenchSingleton,
  resetWorkbenchTabs,
  setWorkbenchScope
} from '@/store/workbench-tabs'

vi.mock('@/store/atum-messaging', () => ({
  $atumAccountScopeId: atom(null),
  $atumIsAuthenticated: atom(false),
  $atumAccountStatus: atom({ account: null }),
  $atumSocialRelationships: { get: () => [], listen: () => () => undefined },
  $atumSortedRoster: { get: () => [], listen: () => () => undefined }
}))
vi.mock('@/app/chat/workbench-resource-pane', () => ({
  closeWorkbenchRegistration: vi.fn(),
  WorkbenchResourcePane: ({ id }: { id: string }) => <div data-testid="resource-pane">{id}</div>
}))

import { resetRememberedAppRoutesForTests } from './use-app-routes'
import { AtumWorkspacePanel } from './workspace-panel'

const workspace = {
  artifact: null,
  artifactWorkspace: null,
  dmConversationId: null,
  scopeKey: 'session',
  showLauncher: true
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="vi">
      <AtumWorkspacePanel workspace={{ ...workspace, scopeKey: $workbenchScope.get() }} />
    </I18nProvider>
      </MemoryRouter>
  )
}

beforeEach(() => {
  localStorage.clear()
  resetWorkbenchTabs()
  resetAgentEditReviews()
  resetAppViewOverlayForTests()
  resetRememberedAppRoutesForTests()
  Object.assign(window, {
    hermesDesktop: {
      filesystemCapability: { managedAuthority: true },
      appSurface: {
        routes: vi.fn(async () => ({
          app: 'moon',
          launch: true,
          routes: [
            { id: 'chart', label: { vi: 'Lá số', en: 'Chart' }, icon: 'starmap', placements: ['menu'], session: 'required' },
            { id: 'compose', label: { vi: 'Soạn', en: 'Compose' }, icon: 'starmap', placements: ['composer'], session: 'required' }
          ]
        }))
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('unified workspace panel', () => {
  it('keeps the shared workspace tabbar as the column-height native drag region', () => {
    const { container } = renderPanel()
    const header = container.querySelector('[data-atum-workspace-tabbar]')!
    expect(header.classList.contains('h-(--atum-l-header)')).toBe(true)
    expect(header.classList.contains('[-webkit-app-region:drag]')).toBe(true)
    // Preserve user-visible identity, state and recovery behavior across connection changes.
    expect(screen.getByRole('tablist').className).not.toContain('-webkit-app-region')

  })

  it('collapses the left sidebar when Skills is opened, so the panel gets the width', async () => {
    $sidebarOpen.set(true)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Kỹ năng' }))

    expect($sidebarOpen.get()).toBe(false)
    expect($visibleWorkbenchTabs.get().some(tab => tab.surface.kind === 'tools')).toBe(true)
  })

  it('shows the vi-first surface picker with Files, Browser and the app launcher', () => {
    renderPanel()
    expect(screen.getByRole('heading', { name: 'Không gian của cuộc trò chuyện này' })).toBeTruthy()

    const heading = screen.getByRole('heading', { name: 'Không gian của cuộc trò chuyện này' })
    const actions = Array.from(heading.parentElement!.querySelectorAll('button')).map(button => button.textContent)
    // Files, Browser (Terminal is not a surface yet), and the app launcher.
    // Documents are an app, opened from the launcher — not a fourth surface.
    expect(actions).toEqual(['Tệp', 'Trình duyệt', 'Kỹ năng'])
    expect(screen.queryByRole('button', { name: /Moon|Mở một tệp|Hỏi Atum/ })).toBeNull()
  })

  it('keeps an outgoing owner scope out of a group panel while the shell reconciles navigation', () => {
    const outgoingScope = 'atum-dm:account-a:private-moon'
    const groupScope = 'atum-dm:account-b:shared-room'
    setWorkbenchScope(outgoingScope)
    openWorkbenchSingleton('files')

    render(
      <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="vi">
        <AtumWorkspacePanel workspace={{ ...workspace, dmConversationId: 'shared-room', scopeKey: groupScope }} />
      </I18nProvider>
      </MemoryRouter>
    )

    // `setWorkbenchScope` is an effect. This is the render just before it
    // runs, where the panel used to expose account A's Files tab inside the
    // group conversation for one interactive frame.
    expect(screen.queryByRole('tab', { name: 'Tệp' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Không gian của cuộc trò chuyện này' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Tệp' }))

    expect($workbenchTabs.get().filter(tab => tab.surface.kind === 'files')).toEqual([
      expect.objectContaining({ scopeKey: outgoingScope }),
      expect.objectContaining({ scopeKey: groupScope })
    ])
  })

  it('opens singleton tabs once, supports coexistence, and plus returns to the start page', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Tệp' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mở thẻ mới' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kỹ năng' }))
    act(() => {
      openWorkbenchBrowser({
        id: 'browser-1',
        partition: 'atum-consumer-browser-browser-1',
        status: 'start',
        title: 'Web',
        url: 'https://example.test'
      })
      openWorkbenchSingleton('files')
    })

    expect($visibleWorkbenchTabs.get().map(tab => tab.surface.kind)).toEqual(['files', 'tools', 'browser'])
    expect(screen.getAllByRole('tab')).toHaveLength(3)

    // Preserve user-visible identity, state and recovery behavior across connection changes.
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.parentElement?.classList.contains('[-webkit-app-region:no-drag]')).toBe(true)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Mở thẻ mới' }))
    expect(screen.getByRole('heading', { name: 'Không gian của cuộc trò chuyện này' })).toBeTruthy()
  })

  it('closes the active tab with the existing local ctrl/cmd+w precedent', () => {
    openWorkbenchSingleton('files')
    renderPanel()
    const tab = screen.getByRole('tab', { name: 'Tệp' })
    fireEvent.keyDown(tab, { ctrlKey: true, key: 'w' })
    expect($visibleWorkbenchTabs.get()).toEqual([])
    expect($activeWorkbenchTabId.get()).toBeNull()
  })

  it('projects typed resource registrations without adding them to the utility strip', () => {
    const id = openPreviewWorkbenchTab(
      { kind: 'file', label: 'notes.md', previewKind: 'text', source: '/work/notes.md', url: 'file:///work/notes.md' },
      { restore: 'persistent', scopeKey: 'session' }
    )

    renderPanel()
    const tab = screen.getByRole('tab', { name: 'notes.md' })

    fireEvent.click(tab)
    expect($activeWorkbenchTabId.get()).toBe(id)
    expect(screen.getByTestId('resource-pane').textContent).toBe(id)
  })

  it('marks an open agent review distinctly on its document tab', () => {
    const scopeKey = 'atum-chat:chat-a'
    setWorkbenchScope(scopeKey)
    openPreviewWorkbenchTab(
      {
        kind: 'file',
        label: 'note.md',
        previewKind: 'text',
        source: 'workspace:note.md',
        url: 'workspace-file:lease-a',
        workspaceTextFile: { displayName: 'note.md', fileRef: 'lease-a', workspaceRelativePath: 'note.md' }
      },
      { restore: 'persistent', scopeKey }
    )
    recordAgentEdit(scopeKey, {
      sessionId: 'session-a',
      turnId: 'turn-a',
      restorePath: 'note.md',
      checkpoint: null,
      diff: 'diff',
      diffTruncated: false,
      restoreAvailable: false
    })

    renderPanel()

    expect(screen.getByLabelText('Atum đã chỉnh sửa')).toBeTruthy()
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()
  })

  it('default-activates the pinned app menu and opens a menu-placed route as an app view in the same scope', async () => {
    setWorkbenchScope('conversation-moon')
    ensureWorkbenchAppMenu('conversation-moon', 'moon')
    renderPanel()
    expect(screen.getByRole('tab', { name: 'moon' }).getAttribute('aria-selected')).toBe('true')
    // Composer-placed routes are not menu items.
    expect(screen.queryByRole('button', { name: 'Soạn' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Lá số' }))
    const tabs = $visibleWorkbenchTabs.get()
    expect(tabs[0]).toMatchObject({ pinned: true, surface: { app: 'moon', kind: 'app-menu' } })
    expect(tabs[1]).toMatchObject({ scopeKey: 'conversation-moon', surface: { app: 'moon', kind: 'app-view', routeId: 'chart' }, title: 'Lá số' })
    // Nothing the renderer holds names an origin or a path.
    expect(JSON.stringify(tabs)).not.toContain('moon.example')
    expect(JSON.stringify(tabs)).not.toContain('/chart')
  })
})

describe('an app view at drawer widths', () => {
  /**
   * A native app view paints above the DOM, so the panel asks main to detach
   * it while any renderer surface could cover it. At drawer widths this panel
   * is itself that surface — and also the place the app view lives. Holding
   * the token for as long as the drawer is mounted therefore detached the
   * view for its whole life, and because main paints the content and the
   * renderer draws nothing in its place, every app view opened from an app
   * menu came up blank on a window narrower than the drawer breakpoint.
   */
  it('is detached only while the drawer slides, and attaches once it settles', async () => {
    setWorkbenchScope('conversation-moon')
    ensureWorkbenchAppMenu('conversation-moon', 'moon')

    const view = render(
      <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="vi">
        <AtumWorkspacePanel drawer motionPhase="entering" workspace={{ ...workspace, scopeKey: $workbenchScope.get() }} />
      </I18nProvider>
      </MemoryRouter>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Lá số' }))
    expect($visibleWorkbenchTabs.get()[1]).toMatchObject({ surface: { kind: 'app-view' } })
    expect($appViewOverlayCount.get()).toBe(1)

    view.rerender(
      <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="vi">
        <AtumWorkspacePanel drawer motionPhase="open" workspace={{ ...workspace, scopeKey: $workbenchScope.get() }} />
      </I18nProvider>
      </MemoryRouter>
    )

    expect($appViewOverlayCount.get()).toBe(0)
  })
})

describe('switching into an app before its menu has arrived', () => {
  /**
   * The manifest is a network round trip. While it was outstanding the panel
   * rendered the generic launcher — the same surface the previous
   * conversation shows — so switching to an app looked like nothing had
   * happened, and the launcher's buttons stayed live for seconds.
   */
  it('shows that the app is opening instead of the previous conversation\'s launcher', async () => {
    ;(window.hermesDesktop as { appSurface: { routes: unknown } }).appSurface.routes = vi.fn(() => new Promise(() => undefined))
    setWorkbenchScope('conversation-moon')
    ensureWorkbenchAppMenu('conversation-moon', 'moon')
    renderPanel()

    await screen.findByText('Đang mở…')
    expect(screen.queryByRole('heading', { name: 'Không gian của cuộc trò chuyện này' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tệp' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Trình duyệt' })).toBeNull()
  })
})

describe('the tab bar\u2019s full-frame control (SPEC \u00a71a, "ph\u00f3ng to")', () => {
  /**
   * The control used to snap the split to its 70% maximum, because no
   * full-frame state existed to give it. A panel at 70% is still a panel
   * beside a chat: the person asked for the document, and got a slightly
   * bigger document. It now switches the panel into the very presentation the
   * narrow branch already uses \u2014 the whole frame, one 44px tab bar \u2014 and
   * leaves the split percentage untouched underneath.
   */
  beforeEach(resetAtumShellState)

  it('takes the whole frame instead of nudging the split', () => {
    renderPanel()

    const expand = screen.getByRole('button', { name: 'Ph\u00f3ng to' })
    expect(expand.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(expand)

    expect($workspaceExpanded.get()).toBe(true)
    expect($workspacePercent.get()).toBe(ATUM_WORKSPACE_DEFAULT_PERCENT)
  })

  it('becomes the way back once the panel owns the frame, where there is no edge left to drag', () => {
    $workspaceExpanded.set(true)
    render(
      <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="vi">
        <AtumWorkspacePanel fullFrame workspace={workspace} />
      </I18nProvider>
      </MemoryRouter>
    )

    const collapse = screen.getByRole('button', { name: 'Thu nh\u1ecf' })
    expect(collapse.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.getByRole('complementary').getAttribute('data-atum-full-frame')).toBe('true')

    fireEvent.click(collapse)

    expect($workspaceExpanded.get()).toBe(false)
  })

  it('is not offered on a narrow window, which is full-frame already with no split to return to', () => {
    render(
      <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="vi">
        <AtumWorkspacePanel drawer workspace={workspace} />
      </I18nProvider>
      </MemoryRouter>
    )

    expect(screen.queryByRole('button', { name: 'Ph\u00f3ng to' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Thu nh\u1ecf' })).toBeNull()
  })
})
