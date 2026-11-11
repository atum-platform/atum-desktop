import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { type MatrixPagesBridge, type MatrixPagesState } from '../../shared/matrix-pages'

import { MatrixWorkplace, workplaceAgent } from './workplace'
import { WORKPLACE_DEVELOPER_PAGES, workplaceDeveloperPages } from './workplace-nav'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const snapshot = (overrides: Partial<MatrixSnapshot> = {}): MatrixSnapshot => ({
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'OWNER' },
  rooms: [{ id: '!agent:test', name: 'Atum', membership: 'join', encrypted: true, agentPrincipal: 'agent-1' }],
  roomId: '!agent:test',
  messages: [],
  error: null,
  agents: [
    {
      principal: 'agent-1',
      userId: '@agent:test',
      name: 'Atum',
      isDefault: true,
      ready: true,
      hermes: 'ready',
      atumModel: true
    },
    {
      principal: 'agent-2',
      userId: '@other:test',
      name: 'Other',
      isDefault: false,
      ready: true,
      hermes: 'ready',
      atumModel: true
    }
  ],
  ...overrides
})

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

function pagesBridge(overrides: Partial<MatrixPagesBridge> = {}): MatrixPagesBridge {
  return {
    open: vi.fn(async () => ({ viewId: 'page-1' })),
    setBounds: vi.fn(async () => ({ ok: true as const })),
    setVisibility: vi.fn(async () => ({ ok: true as const })),
    focus: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(async () => ({ ok: true as const })),
    onState: vi.fn(() => vi.fn()),
    ...overrides
  }
}

function renderWorkplace(props: Partial<ComponentProps<typeof MatrixWorkplace>> = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkplace obstructed={false} preferredAgentPrincipal="agent-1" snapshot={snapshot()} {...props} />
    </I18nProvider>
  )
}

/** Every page's title as For developers lists it, the three that Routines, Drive and the Store replace included.
 * Connections is account-wide (Settings) since 2026-10-31, so the assistant-scoped list omits it. */
const EVERY_PAGE_TITLE = [
  'Scheduled tasks',
  'Files your assistant made',
  'Skills',
  'Model & Memory',
  'Providers',
  'Command center',
  'Star map',
  'MCP servers'
] as const

/** Opens For developers, where every Hermes page is listed. */
const openDevelopers = () => fireEvent.click(screen.getByRole('button', { name: 'For developers' }))

describe('Matrix Workplace native host', () => {
  it('says a page could not open in a plain sentence, keeps the code out of it, and tries again', async () => {
    const open = vi
      .fn<MatrixPagesBridge['open']>()
      .mockResolvedValueOnce({ error: 'matrix_pages_runtime_unavailable' })
      .mockResolvedValueOnce({ viewId: 'page-1' })

    const pages = pagesBridge({ open })
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace({ initialPage: 'runtime' })
    const status = await screen.findByText('This page couldn’t open.')
    expect(status.closest('[role="status"]')?.textContent).not.toContain('matrix_pages')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('This page couldn’t open.')).toBeNull())
  })

  // An old direct link can still reach a hidden page; it gives the one current route instead of retrying.
  it('sends a cloud assistant back to its card for model choice, without a retry', async () => {
    const open = vi.fn<MatrixPagesBridge['open']>().mockResolvedValue({ error: 'pages_agent_cloud' })
    window.atumMatrix = { pages: pagesBridge({ open }) } as MatrixUiBridge
    renderWorkplace({ initialPage: 'connections' })
    expect(await screen.findByText('This assistant lives in the cloud. Choose its model from its card.')).toBeTruthy()
    expect(screen.queryByText('This page couldn’t open.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it.each(['pages_agent_not_running', 'pages_agent_unavailable'])(
    'keeps a standby cloud agent on the short host state for %s',
    async error => {
      const open = vi.fn<MatrixPagesBridge['open']>().mockResolvedValue({ error })
      window.atumMatrix = { pages: pagesBridge({ open }) } as MatrixUiBridge
      const cloud = snapshot()
      cloud.agents = cloud.agents!.map(agent =>
        agent.principal === 'agent-1' ? { ...agent, answering: 'cloud' as const, macRole: 'standby' as const } : agent
      )

      renderWorkplace({ initialPage: 'connections', snapshot: cloud })
      expect(await screen.findByText('This page needs this assistant running on this Mac.')).toBeTruthy()
      expect(screen.queryByText('This page couldn’t open.')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    }
  )

  it('defaults to promoted Main, but never substitutes another agent for an unavailable explicit/default scope', async () => {
    const state = snapshot()
    state.agents = state.agents!.map(agent => ({
      ...agent,
      isDefault: agent.principal === 'agent-2',
      name: agent.principal === 'agent-2' ? 'Atum Main' : 'Original assistant'
    }))
    expect(workplaceAgent(state)?.principal).toBe('agent-2')
    expect(workplaceAgent(state, 'agent-1')?.principal).toBe('agent-1')
    expect(workplaceAgent(state, 'missing')).toBeUndefined()
    expect(workplaceAgent({ ...state, agents: [state.agents[0]!] })).toBeUndefined()
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace({ snapshot: state, preferredAgentPrincipal: undefined })
    // The promoted primary goes by its record's name (owner decision D1: it is renameable).
    // The role badge contributes its accessible label after the assistant's name.
    expect(screen.getByRole('button', { name: /^Atum Main/ }).getAttribute('aria-pressed')).toBe('true')
    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: /Scheduled/ }))
    await waitFor(() => expect(pages.open).toHaveBeenCalledWith(expect.objectContaining({ agentPrincipal: 'agent-2' })))
  })

  it('does not open pages in another agent when a selected principal disappears', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    const { rerender } = renderWorkplace({ preferredAgentPrincipal: 'agent-2', initialPage: 'runtime' })
    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentPrincipal: 'agent-2' }))
    )
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkplace
          initialPage="runtime"
          obstructed={false}
          preferredAgentPrincipal="agent-2"
          snapshot={snapshot({ agents: [snapshot().agents![0]!] })}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('status').textContent).toBe('Not available for this assistant yet.')
    await waitFor(() => expect(pages.close).toHaveBeenCalledWith('page-1'))
    expect(pages.open).toHaveBeenCalledOnce()
  })

  it.each([
    ['providers', /Providers/],
    ['mcp', /MCP/]
  ] as const)('opens %s only for the explicitly selected owned agent', async (page, label) => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledWith({
        page,
        agentPrincipal: 'agent-2',
        locale: 'en',
        appearance: 'light'
      })
    )
    await waitFor(() => expect(pages.focus).toHaveBeenCalledWith('page-1'))
  })
  it('opens the real native workplace with the human’s explicit portable appearance, not the OS default', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace({
      snapshot: snapshot({
        displayPreferences: { appearance: { value: 'dark', writable: true }, textSize: { value: 100, writable: true } }
      })
    })
    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: /Scheduled/ }))
    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledWith({
        page: 'scheduled',
        agentPrincipal: 'agent-1',
        locale: 'en',
        appearance: 'dark'
      })
    )
  })
  it('opens selected-owned-agent pages with only locale and appearance, then hides for an overlay', async () => {
    let receiveState: ((state: MatrixPagesState) => void) | undefined

    const pages = pagesBridge({
      onState: vi.fn(listener => {
        receiveState = listener

        return vi.fn()
      })
    })

    window.atumMatrix = { pages } as MatrixUiBridge
    const { rerender } = renderWorkplace()

    expect(screen.getByText('Your assistant’s routines, files and the Store.')).toBeTruthy()
    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: /Scheduled/ }))
    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledWith({
        page: 'scheduled',
        agentPrincipal: 'agent-1',
        locale: 'en',
        appearance: 'light'
      })
    )
    expect(vi.mocked(pages.open).mock.calls[0]?.[0]).not.toHaveProperty('token')
    // The real native ready event precedes the open reply; no later event is
    // needed to leave the loading state and focus the loaded page.
    await waitFor(() => expect(pages.focus).toHaveBeenCalledWith('page-1'))
    expect(screen.queryByRole('status', { name: 'Opening…' })).toBeNull()
    await act(async () => receiveState?.({ viewId: 'page-1', status: 'ready' }))
    expect(pages.focus).toHaveBeenCalledWith('page-1')

    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkplace obstructed preferredAgentPrincipal="agent-1" snapshot={snapshot()} />
      </I18nProvider>
    )
    await waitFor(() =>
      expect(pages.setVisibility).toHaveBeenCalledWith({ viewId: 'page-1', visible: false, overlayActive: true })
    )
  })

  it('opens installed skills and tools for the explicitly selected local agent', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledWith({
        page: 'skills',
        agentPrincipal: 'agent-2',
        locale: 'en',
        appearance: 'light'
      })
    )
    await waitFor(() => expect(pages.focus).toHaveBeenCalledWith('page-1'))
  })

  it('opens model and memory settings for the explicitly selected local agent', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: /Model & Memory/ }))
    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledWith({
        page: 'runtime',
        agentPrincipal: 'agent-2',
        locale: 'en',
        appearance: 'light'
      })
    )
    await waitFor(() => expect(pages.focus).toHaveBeenCalledWith('page-1'))
  })

  it('closes a stale native page when its open finishes after unmount', async () => {
    const opening = deferred<{ viewId: string }>()
    const pages = pagesBridge({ open: vi.fn(() => opening.promise) })
    window.atumMatrix = { pages } as MatrixUiBridge
    const view = renderWorkplace()

    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: 'Files your assistant made' }))
    expect(pages.open).toHaveBeenCalledOnce()
    view.unmount()
    await act(async () => opening.resolve({ viewId: 'late-page' }))
    expect(pages.close).toHaveBeenCalledWith('late-page')
  })

  it('returns to Workplace when the native page dismisses itself', async () => {
    let receive: ((state: MatrixPagesState) => void) | undefined

    const pages = pagesBridge({
      onState: vi.fn(listener => {
        receive = listener

        return vi.fn()
      })
    })

    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace()
    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: /Scheduled/ }))
    await waitFor(() => expect(pages.focus).toHaveBeenCalledWith('page-1'))
    await act(async () => receive?.({ viewId: 'page-1', status: 'destroyed' }))
    expect(screen.getByRole('button', { name: /Scheduled/ })).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Opening…' })).toBeNull()
  })

  it('closes the old page and opens a fresh local scope when the selected agent changes', async () => {
    const first = deferred<{ viewId: string }>()

    const pages = pagesBridge({
      open: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce({ viewId: 'agent-2-page' })
    })

    window.atumMatrix = { pages } as MatrixUiBridge
    const { rerender } = renderWorkplace()

    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: /Scheduled/ }))
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkplace obstructed={false} preferredAgentPrincipal="agent-2" snapshot={snapshot()} />
      </I18nProvider>
    )

    await waitFor(() =>
      expect(pages.open).toHaveBeenLastCalledWith(expect.objectContaining({ agentPrincipal: 'agent-2' }))
    )
    await act(async () => first.resolve({ viewId: 'agent-1-late-page' }))
    expect(pages.close).toHaveBeenCalledWith('agent-1-late-page')
  })
})

describe('Matrix Workplace for a person, not an operator', () => {
  it('leads with Atum’s own places and keeps every Hermes page behind one collapsed For developers', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace({ onOpenDrive: vi.fn(), onOpenRoutines: vi.fn(), onOpenStore: vi.fn() })

    // Every day: Routines, Drive and the Store, never the pages that do the same job.
    const everyday = window.document.querySelector('[data-matrix-workplace-everyday]') as HTMLElement
    expect(
      Array.from(everyday.querySelectorAll('[data-matrix-workplace-surface]')).map(card =>
        card.getAttribute('data-matrix-workplace-surface')
      )
    ).toEqual(['routines', 'drive', 'store'])

    for (const name of ['Routines', 'Atum Drive', 'Store']) {
      expect(within(everyday).getByRole('button', { name })).toBeTruthy()
    }

    const developers = screen.getByRole('button', { name: 'For developers' })
    expect(developers.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull()

    for (const name of EVERY_PAGE_TITLE) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    fireEvent.click(developers)
    expect(developers.getAttribute('aria-expanded')).toBe('true')

    // One entry holds all nine, the three duplicates included.
    for (const name of EVERY_PAGE_TITLE) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }

    // No line repeats where the pages live: the person already knows they are on this Mac.
    expect(window.document.querySelector('[data-matrix-workplace]')?.textContent).not.toContain('this Mac')
    fireEvent.click(screen.getByRole('button', { name: 'Star map' }))
    await waitFor(() => expect(pages.open).toHaveBeenCalledWith(expect.objectContaining({ page: 'starmap' })))
  })

  it.each(WORKPLACE_DEVELOPER_PAGES)('still opens the %s page, one click inside For developers', async page => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace({ onOpenDrive: vi.fn(), onOpenRoutines: vi.fn(), onOpenStore: vi.fn() })
    openDevelopers()
    fireEvent.click(window.document.querySelector(`[data-matrix-workplace-page-row="${page}"]`) as HTMLElement)
    await waitFor(() => expect(pages.open).toHaveBeenCalledWith(expect.objectContaining({ page })))
  })

  it('shows only Atum places for a cloud assistant, while the dormant and Mac-home paths keep native pages', () => {
    const cloud = snapshot()
    cloud.agents = cloud.agents!.map(agent =>
      agent.principal === 'agent-1' ? { ...agent, answering: 'cloud' as const } : agent
    )
    const props = { onOpenDrive: vi.fn(), onOpenRoutines: vi.fn(), onOpenStore: vi.fn(), snapshot: cloud }

    expect(workplaceDeveloperPages(cloud.agents[0])).toEqual([])
    const first = renderWorkplace(props)
    expect(screen.getByRole('button', { name: 'Routines' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Atum Drive' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Store' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'For developers' })).toBeNull()
    for (const name of ['Model & Memory', 'Providers', 'Connections', 'MCP servers']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    first.unmount()
    renderWorkplace({ ...props, cloudOnly: false })
    openDevelopers()
    expect(screen.getByRole('button', { name: 'Model & Memory' })).toBeTruthy()
    cleanup()

    const mac = {
      ...cloud.agents[0]!,
      home: { lives: { kind: 'mac' as const, name: 'Mac mini', thisMac: false }, move: null, targets: [], issue: null }
    }
    expect(workplaceDeveloperPages(mac)).toEqual(WORKPLACE_DEVELOPER_PAGES)
  })

  it('opens Atum’s own places instead of the Hermes pages, Routines for the assistant that is chosen', () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    const onOpenDrive = vi.fn()
    const onOpenRoutines = vi.fn()
    const onOpenStore = vi.fn()
    renderWorkplace({ onOpenDrive, onOpenRoutines, onOpenStore })

    fireEvent.click(screen.getByRole('button', { name: 'Atum Drive' }))
    expect(onOpenDrive).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Store' }))
    expect(onOpenStore).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Routines' }))
    expect(onOpenRoutines).toHaveBeenLastCalledWith('agent-1')
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    fireEvent.click(screen.getByRole('button', { name: 'Routines' }))
    expect(onOpenRoutines).toHaveBeenLastCalledWith('agent-2')
    expect(pages.open).not.toHaveBeenCalled()
  })

  it('lists only the places this build can open, and still lists every page for developers', () => {
    window.atumMatrix = { pages: pagesBridge() } as MatrixUiBridge
    const { rerender } = renderWorkplace()
    // Nothing to open from here: no empty row of cards, just the way to the pages.
    expect(window.document.querySelector('[data-matrix-workplace-everyday]')).toBeNull()
    openDevelopers()

    for (const name of EVERY_PAGE_TITLE) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }

    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkplace
          obstructed={false}
          onOpenDrive={vi.fn()}
          preferredAgentPrincipal="agent-1"
          snapshot={snapshot()}
        />
      </I18nProvider>
    )
    const everyday = window.document.querySelector('[data-matrix-workplace-everyday]') as HTMLElement
    expect(within(everyday).getAllByRole('button').map(card => card.getAttribute('data-matrix-workplace-surface'))).toEqual(['drive'])
    expect(within(everyday).queryByRole('button', { name: 'Routines' })).toBeNull()
    expect(within(everyday).queryByRole('button', { name: 'Store' })).toBeNull()
  })

  it('frames a page with a breadcrumb that names it and returns to the list with For developers still open', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace({ initialPage: 'runtime' })

    const breadcrumb = screen.getByRole('navigation', { name: 'Workplace' })
    expect(within(breadcrumb).getByRole('heading', { name: 'Model & Memory' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(within(breadcrumb).getByRole('button', { name: 'Back to Workplace' }))
    await waitFor(() => expect(pages.close).toHaveBeenCalledWith('page-1'))
    expect(screen.getByRole('button', { name: 'For developers' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Model & Memory' })).toBeTruthy()
  })

  it('leads a page opened from a chat back to that chat, never into the Workplace list', async () => {
    let receive: ((state: MatrixPagesState) => void) | undefined

    const pages = pagesBridge({
      onState: vi.fn(listener => {
        receive = listener

        return vi.fn()
      })
    })

    const onExit = vi.fn()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace({ initialPage: 'runtime', onExit })

    const breadcrumb = screen.getByRole('navigation', { name: 'Model & Memory' })
    expect(within(breadcrumb).queryByRole('button', { name: 'Back to Workplace' })).toBeNull()
    fireEvent.click(within(breadcrumb).getByRole('button', { name: 'Back to the chat' }))
    expect(onExit).toHaveBeenCalledOnce()
    // The page closing itself leaves the same way.
    await waitFor(() => expect(pages.focus).toHaveBeenCalledWith('page-1'))
    await act(async () => receive?.({ viewId: 'page-1', status: 'destroyed' }))
    expect(onExit).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /Scheduled/ })).toBeNull()
  })

  it('keeps the way back on a side trip whose assistant is gone, without the word Workplace', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    const onExit = vi.fn()

    const { rerender } = renderWorkplace({ initialPage: 'runtime', onExit, preferredAgentPrincipal: 'agent-2' })
    await waitFor(() => expect(pages.open).toHaveBeenCalledOnce())
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkplace
          initialPage="runtime"
          obstructed={false}
          onExit={onExit}
          preferredAgentPrincipal="agent-2"
          snapshot={snapshot({ agents: [snapshot().agents![0]!] })}
        />
      </I18nProvider>
    )

    expect(screen.getByRole('status').textContent).toBe('Not available for this assistant yet.')
    expect(screen.queryByText(/Workplace/)).toBeNull()
    const breadcrumb = screen.getByRole('navigation', { name: 'Model & Memory' })
    fireEvent.click(within(breadcrumb).getByRole('button', { name: 'Back to the chat' }))
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('names Settings as the way back for a page Settings opened', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    const onExit = vi.fn()
    renderWorkplace({ exitTo: 'settings', initialPage: 'skills', onExit })

    const breadcrumb = screen.getByRole('navigation', { name: 'Skills' })
    expect(within(breadcrumb).queryByRole('button', { name: 'Back to the chat' })).toBeNull()
    const back = within(breadcrumb).getByRole('button', { name: 'Back to Settings' })
    expect(back.textContent).toBe('Settings')
    fireEvent.click(back)
    expect(onExit).toHaveBeenCalledOnce()
    await waitFor(() => expect(pages.open).toHaveBeenCalledWith(expect.objectContaining({ page: 'skills' })))
  })

  it('opens the Skills Hub on the skill a Store listing sent, and goes back to the Store', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    const onExit = vi.fn()
    renderWorkplace({
      exitTo: 'store',
      initialHub: 'official/creative/pixel-art',
      initialPage: 'skills',
      onExit,
      preferredAgentPrincipal: 'agent-2'
    })

    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledExactlyOnceWith({
        page: 'skills',
        agentPrincipal: 'agent-2',
        locale: 'en',
        appearance: expect.any(String),
        hub: 'official/creative/pixel-art'
      })
    )

    const back = within(screen.getByRole('navigation', { name: 'Skills' })).getByRole('button', {
      name: 'Back to the Store'
    })

    expect(back.textContent).toBe('Store')
    fireEvent.click(back)
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('opens the Skills page without a Hub skill when nothing sent one', async () => {
    const pages = pagesBridge()
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace({ initialPage: 'skills', onExit: vi.fn() })

    await waitFor(() => expect(pages.open).toHaveBeenCalledOnce())
    expect(vi.mocked(pages.open).mock.calls[0]![0]).not.toHaveProperty('hub')
  })

  it('shows a loader, not a sentence, while a page opens', async () => {
    const opening = deferred<{ viewId: string }>()
    const pages = pagesBridge({ open: vi.fn(() => opening.promise) })
    window.atumMatrix = { pages } as MatrixUiBridge
    renderWorkplace()
    openDevelopers()
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getByRole('status', { name: 'Opening…' })).toBeTruthy()
    await act(async () => opening.resolve({ viewId: 'page-1' }))
    expect(screen.queryByRole('status', { name: 'Opening…' })).toBeNull()
  })

  it('offers no assistant chooser when there is only one assistant', () => {
    window.atumMatrix = { pages: pagesBridge() } as MatrixUiBridge
    renderWorkplace({ snapshot: snapshot({ agents: [snapshot().agents![0]!] }) })
    expect(screen.queryByRole('group', { name: 'Assistant' })).toBeNull()
    openDevelopers()
    expect(screen.getByRole('button', { name: 'Scheduled tasks' })).toBeTruthy()
  })
})
