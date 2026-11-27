import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixWorkBridge, MatrixWorkProjection } from '../../../shared/matrix-work'

import { resetWorkStoreForTests } from './store'
import { WorkScreen } from './work-screen'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)

    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

beforeEach(() => {
  resetWorkStoreForTests()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

function bridge(): MatrixWorkBridge & { [K in keyof MatrixWorkBridge]: ReturnType<typeof vi.fn> } {
  return {
    getSurfaceMode: vi.fn(async () => null),
    setSurfaceMode: vi.fn(async () => {}),
    onSurfaceModeChanged: vi.fn(() => () => {}),
    runCommand: vi.fn(async () => true),
    read: vi.fn(async () => null),
    show: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    openPlanConnect: vi.fn(async () => {}),
    readPlanConsent: vi.fn(async () => ({ state: 'off' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false })),
    setPlanConsent: vi.fn(async () => ({ state: 'off' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false })),
    revokePlanConsent: vi.fn(async () => ({ state: 'off' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false })),
    setWork: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {})
  }
}

const READY: MatrixWorkProjection = { view: 'ready', protons: 'ok' }

const NAMES: Record<string, string> = { '@luna:example.invalid': 'Luna', '@nova:example.invalid': 'Nova' }

function show(
  projection: Partial<MatrixWorkProjection> = {},
  options: { locale?: Locale; obstructed?: boolean; work?: ReturnType<typeof bridge>; onAddProtons?: () => void } = {}
) {
  const work = options.work ?? bridge()
  const onAddProtons = options.onAddProtons ?? vi.fn()

  const element = (next: Partial<MatrixWorkProjection>, obstructed = options.obstructed ?? false) => (
    <I18nProvider configClient={null} initialLocale={options.locale ?? 'en'}>
      <WorkScreen
        bridge={work}
        obstructed={obstructed}
        onAddProtons={onAddProtons}
        projection={{ ...READY, ...next }}
      />
    </I18nProvider>
  )

  const rendered = render(element(projection))

  return {
    work,
    onAddProtons,
    rerender: (next: Partial<MatrixWorkProjection>, obstructed?: boolean) =>
      rendered.rerender(element({ ...projection, ...next }, obstructed))
  }
}

describe('WorkScreen: the owner view', () => {
  it('asks main to paint the view over its host region and takes it off when it goes', () => {
    const { work } = show({ view: 'starting' })

    expect(screen.getByRole('status').textContent).toContain('Opening Work…')
    expect(work.show).toHaveBeenCalledTimes(1)
    expect(Object.keys(work.show.mock.calls[0][0]).sort()).toEqual(['height', 'width', 'x', 'y'])

    cleanup()
    expect(work.hide).toHaveBeenCalled()
  })

  it('leaves the window while something covers it, and comes back after', () => {
    const { rerender, work } = show({}, { obstructed: false })

    expect(work.show).toHaveBeenCalledTimes(1)
    rerender({}, true)
    expect(work.hide).toHaveBeenCalled()
    rerender({}, false)
    expect(work.show).toHaveBeenCalledTimes(2)
  })

  it('says it could not open, in one line, and tries again on request', async () => {
    const { work } = show({ view: 'unavailable' })

    expect(screen.getByText('Work couldn’t open just now.')).toBeTruthy()
    expect(work.show).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(work.retry).toHaveBeenCalledTimes(1))
  })

  it('shows Work off quietly and paints nothing', () => {
    const { work } = show({ view: 'off' })

    expect(screen.getByText('Work is off on this Mac.')).toBeTruthy()
    expect(work.show).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('offers Add Protons only on an empty balance, and only once the view is there', () => {
    const { onAddProtons, rerender } = show({ protons: 'empty' })

    fireEvent.click(screen.getByRole('button', { name: 'Add Protons' }))
    expect(onAddProtons).toHaveBeenCalledTimes(1)
    rerender({ protons: 'ok' })
    expect(screen.queryByRole('button', { name: 'Add Protons' })).toBeNull()
    rerender({ protons: 'empty', view: 'starting' })
    expect(screen.queryByRole('button', { name: 'Add Protons' })).toBeNull()
  })

  it('re-reads on window focus so Add Protons leaves after a top-up', () => {
    const { work } = show()

    act(() => void window.dispatchEvent(new Event('focus')))
    expect(work.read).toHaveBeenCalledTimes(1)
  })
})

describe('WorkScreen: the title band (spec §1.4, §8.2)', () => {
  it('keeps the page name in B and puts Work · Code in C before the panel toggle, switches the open project, and puts the switch back when the view refuses', async () => {
    const work = bridge()
    let report: ((snapshot: { projectId: string; mode: 'work' | 'code' } | null) => void) | undefined

    work.getSurfaceMode.mockResolvedValue({ projectId: 'p1', mode: 'work' })
    work.onSurfaceModeChanged.mockImplementation(listener => {
      report = listener

      return () => {}
    })
    show({}, { work })

    const code = await screen.findByRole('button', { name: 'Code' })

    // Layout r1 B and C (owner 2026-11-27): the name stays visible at the left, the switch sits in the
    // band's right cluster, where every screen with modes wears its switch.
    const heading = screen.getByRole('heading', { name: 'Work' })
    expect(heading.className).not.toContain('sr-only')
    const header = heading.closest('[data-atum-main-header]')!
    const right = header.lastElementChild!
    expect(right.contains(screen.getByRole('group', { name: 'Mode' }))).toBe(true)
    expect(heading.compareDocumentPosition(screen.getByRole('group', { name: 'Mode' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(code)
    expect(work.setSurfaceMode).toHaveBeenCalledWith('p1', 'code')
    expect(code.getAttribute('aria-pressed')).toBe('true')

    work.setSurfaceMode.mockRejectedValueOnce(new Error('work_mode_not_saved'))
    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() => expect(code.getAttribute('aria-pressed')).toBe('true'))

    // A project with no mode to switch (nothing open) shows no switch at all.
    act(() => report?.(null))
    expect(screen.queryByRole('group', { name: 'Mode' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Work' }).className).not.toContain('sr-only')
  })

  // T3's pencil is the plus menu every screen has (layout r2 §4): New thread, in a worktree, Add project.
  it('runs the view\'s own New thread from the plus menu, and not before the view is ready', async () => {
    const work = bridge()
    const { rerender } = show({ view: 'starting' }, { work })

    expect(screen.queryByRole('button', { name: 'New…' })).toBeNull()
    rerender({ view: 'ready' })
    const plus = screen.getByRole('button', { name: 'New…' })
    fireEvent.pointerDown(plus, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(screen.getByRole('menuitem', { name: /^New thread⌘N$/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Add project/ })).toBeTruthy()
    fireEvent.click(await screen.findByRole('menuitem', { name: /New thread in a worktree/ }))
    expect(work.runCommand?.mock.calls).toEqual([['chat.newWorktree']])
  })
})

describe('Work page Google write card', () => {
  afterEach(() => {
    delete (window as { atumMatrix?: unknown }).atumMatrix
  })

  it('shows a Work request above the view for the account on screen, and nothing without an account', async () => {
    const { googleWorkEntry, GOOGLE_WORK_OWNER } = await import('../../../shared/matrix-google-write-proposal.test-support')
    const { parseMatrixGoogleWorkProposalList } = await import('../../../shared/matrix-google-write-proposal')
    const entry = await googleWorkEntry()

    const writeProposals = vi.fn(async () => ({
      state: 'ok' as const,
      proposals: [],
      work: parseMatrixGoogleWorkProposalList({ proposals: [entry] }) ?? [],
      owner: GOOGLE_WORK_OWNER
    }))

    ;(window as { atumMatrix?: unknown }).atumMatrix = { googleConnections: { writeProposals, writeProposalAction: vi.fn() } }

    const work = bridge()

    const page = (owner?: string) => (
      <I18nProvider configClient={null} initialLocale="en">
        <WorkScreen bridge={work} obstructed={false} onAddProtons={vi.fn()} owner={owner} projection={READY} />
      </I18nProvider>
    )

    const view = render(page(GOOGLE_WORK_OWNER))
    const region = await screen.findByRole('region', { name: 'Send this email?' })
    const host = view.container.querySelector('[data-atum-work-host]')!

    // Above the host, never inside it: main paints the view natively over the host region.
    expect(host.contains(region)).toBe(false)
    expect(region.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    view.rerender(page(undefined))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Send this email?' })).toBeNull())
  })
})
