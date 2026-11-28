import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { AppViewOverlayHold } from '@/store/use-app-view-overlay'

import type { MatrixWorkBridge, MatrixWorkProjection } from '../../../shared/matrix-work'

import { resetWorkStoreForTests } from './store'
import { WorkScreen } from './work-screen'

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
    open: vi.fn(async () => {}),
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
  options: { locale?: Locale; work?: ReturnType<typeof bridge>; onAddProtons?: () => void } = {}
) {
  const work = options.work ?? bridge()
  const onAddProtons = options.onAddProtons ?? vi.fn()

  const element = (next: Partial<MatrixWorkProjection>, overlay = false, active = true) => (
    <I18nProvider configClient={null} initialLocale={options.locale ?? 'en'}>
      <WorkScreen
        active={active}
        bridge={work}
        onAddProtons={onAddProtons}
        projection={{ ...READY, ...next }}
      />
      {overlay && <div role="dialog"><AppViewOverlayHold />Account</div>}
    </I18nProvider>
  )

  const rendered = render(element(projection))

  return {
    work,
    onAddProtons,
    host: () => rendered.container.querySelector('[data-atum-work-host]')!,
    rerender: (next: Partial<MatrixWorkProjection>, overlay?: boolean, active?: boolean) =>
      rendered.rerender(element({ ...projection, ...next }, overlay, active))
  }
}

describe('WorkScreen: the owner view', () => {
  it('starts Work on demand and mounts the requested guest before pairing completes', () => {
    const { host, rerender, work } = show({ view: 'starting' })

    expect(screen.getByRole('status').textContent).toContain('Opening Work…')
    expect(work.open).toHaveBeenCalledOnce()
    const guest = { src: 'about:blank#mount', partition: 'persist:atum-work-test' }
    rerender({ guest })
    const embedded = host().querySelector('webview')
    expect(embedded?.getAttribute('src')).toBe(guest.src)
    expect(embedded?.getAttribute('partition')).toBe(guest.partition)
    rerender({ guest, view: 'ready' })
    expect(host().querySelector('webview')).toBe(embedded)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the guest mounted and visible under shell overlays and preserves it across destinations', () => {
    const guest = { src: 'about:blank#mount', partition: 'persist:atum-work-test' }
    const { host, rerender, work } = show({ guest })
    const embedded = host().querySelector('webview')!
    const section = host().closest('section')!
    const visible = () => !section.hasAttribute('inert') && !embedded.classList.contains('invisible')

    rerender({}, true)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(host().querySelector('webview')).toBe(embedded)
    expect(visible()).toBe(true)
    rerender({}, false, false)
    expect(section.hasAttribute('inert')).toBe(true)
    rerender({})
    expect(host().querySelector('webview')).toBe(embedded)
    expect(visible()).toBe(true)
    expect(work.open).not.toHaveBeenCalled()
  })

  it('says it could not open, in one line, and tries again on request', async () => {
    const { work } = show({ view: 'unavailable' })

    expect(screen.getByText('Work couldn’t open just now.')).toBeTruthy()
    expect(work.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(work.retry).toHaveBeenCalledTimes(1))
  })

  it('shows Work off quietly and paints nothing', () => {
    const { work } = show({ view: 'off' })

    expect(screen.getByText('Work is off on this Mac.')).toBeTruthy()
    expect(work.open).not.toHaveBeenCalled()
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

  // Owner 2026-11-28: the band's plus opened the same menu as the view list's own plus. New lives on
  // the list (and the home composer), so the band keeps history, the title, the mode and the panel.
  it('draws no plus in the title band, before or after the view is ready', () => {
    const work = bridge()
    const { rerender } = show({ view: 'starting' }, { work })

    expect(screen.queryByRole('button', { name: 'New…' })).toBeNull()
    rerender({ view: 'ready' })
    expect(screen.queryByRole('button', { name: 'New…' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Work' })).toBeTruthy()
    expect(work.runCommand).not.toHaveBeenCalled()
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
        <WorkScreen active bridge={work} onAddProtons={vi.fn()} owner={owner} projection={READY} />
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
