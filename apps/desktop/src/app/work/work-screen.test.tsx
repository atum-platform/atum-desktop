import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixWorkBridge, MatrixWorkProjection } from '../../../shared/matrix-work'

import { $workEnrollmentDeferred, loadWorkEnrollmentDeferred, resetWorkStoreForTests } from './store'
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
    allowAssistants: vi.fn(async () => {}),
    setAssistants: vi.fn(async () => {}),
    setPlan: vi.fn(async () => {}),
    reconnectAssistants: vi.fn(async () => {}),
    openPlanConnect: vi.fn(async () => {}),
    readPlanConsent: vi.fn(async () => ({ state: 'off' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false })),
    setPlanConsent: vi.fn(async () => ({ state: 'off' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false })),
    revokePlanConsent: vi.fn(async () => ({ state: 'off' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false })),
    setWork: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {})
  }
}

const READY: MatrixWorkProjection = { view: 'ready', assistants: 'on', agents: [], protons: 'ok' }

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
        agentName={principal => NAMES[principal]}
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
    const { work } = show({ view: 'off', assistants: 'off' })

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

describe('WorkScreen: assistants can start work here', () => {
  it('draws nothing for assistants on a Mac without a Work route', () => {
    show({ assistants: 'not_enrolled' })

    expect(window.document.querySelector('[data-atum-work-assistants]')).toBeNull()
    expect(window.document.querySelector('[data-atum-work-band]')).toBeNull()
  })

  it('shows the enrollment text once, naming what it grants, before anything is on (T13)', async () => {
    const { work } = show({ assistants: 'needs_grant' })
    const ask = window.document.querySelector('[data-atum-work-enrollment]')!

    expect(ask.textContent).toContain('Let your assistants work on this Mac?')

    // Starting, reading and stopping work, in every Work folder; every conversation, at any time; Protons;
    // Cloudflare on Atum's account; how to turn it off.
    for (const fact of ['start, read and stop work', 'every folder you add to Work', 'any Work conversation here at any time', 'Protons', 'Cloudflare on Atum’s account', 'turn this off']) {
      expect(ask.textContent).toContain(fact)
    }

    expect(work.allowAssistants).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(work.allowAssistants).toHaveBeenCalledTimes(1))
    expect(work.setAssistants).not.toHaveBeenCalled()
  })

  it('keeps "Not now" on this Mac; the pill brings the text back', () => {
    show({ assistants: 'needs_grant' })

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(window.document.querySelector('[data-atum-work-enrollment]')).toBeNull()
    expect($workEnrollmentDeferred.get()).toBe(true)

    resetWorkStoreForTests()
    loadWorkEnrollmentDeferred()
    expect($workEnrollmentDeferred.get()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Let assistants work here' }))
    expect(window.document.querySelector('[data-atum-work-enrollment]')).toBeTruthy()
  })

  it.each([
    ['on', 'Assistants on', 'What they start shows here with their name. You can step in or stop it anytime.', true],
    ['off', 'Assistants off', 'Your own work here isn’t affected.', false],
    ['holding', 'Assistants paused', 'Paused for a moment while Work finishes an update.', true],
    ['stale', 'Reconnecting', 'Atum is catching up. Assistants can start work again in a moment.', true],
    ['unreachable', 'Assistants can’t reach this Mac', 'Assistants can’t reach this Mac right now.', true]
  ] as const)('reads %s as one quiet state with its switch', (assistants, pill, line, checked) => {
    show({ assistants })

    expect(window.document.querySelector('[data-atum-work-band]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: pill }))
    expect(screen.getByText(line)).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Assistants can start work here' }).getAttribute('aria-checked')).toBe(
      String(checked)
    )
  })

  it('turns assistants off and on from the switch', async () => {
    const { rerender, work } = show({ assistants: 'on' })

    fireEvent.click(screen.getByRole('button', { name: 'Assistants on' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Assistants can start work here' }))
    await waitFor(() => expect(work.setAssistants).toHaveBeenLastCalledWith(false))
    rerender({ assistants: 'off' })
    fireEvent.click(screen.getByRole('switch', { name: 'Assistants can start work here' }))
    await waitFor(() => expect(work.setAssistants).toHaveBeenLastCalledWith(true))
  })

  it('reconnects an unreachable route on request', async () => {
    const { work } = show({ assistants: 'unreachable' })

    fireEvent.click(screen.getByRole('button', { name: 'Assistants can’t reach this Mac' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(work.reconnectAssistants).toHaveBeenCalledTimes(1))
  })

  it('names who is working from the account record, never from the agent, and falls back', () => {
    show({
      agents: [
        { principal: '@luna:example.invalid', running: 1, stopping: false },
        { principal: '@ghost:example.invalid', running: 2, stopping: false },
        { principal: '@nova:example.invalid', running: 0, stopping: true }
      ]
    })

    const pill = screen.getByRole('button', { name: '2 assistants working' })
    fireEvent.click(pill)
    expect(screen.getByText('Luna is working on 1 task')).toBeTruthy()
    expect(screen.getByText('An assistant is working on 2 tasks')).toBeTruthy()
    expect(screen.getByText('Stopping Nova’s work…')).toBeTruthy()
  })

  it('shows one agent by name on the pill', () => {
    show({ agents: [{ principal: '@luna:example.invalid', running: 1, stopping: false }] })

    expect(screen.getByRole('button', { name: 'Luna is working' })).toBeTruthy()
  })

  it('closes the band with Escape and its close button', () => {
    show()

    fireEvent.click(screen.getByRole('button', { name: 'Assistants on' }))
    fireEvent.keyDown(window.document.querySelector('[data-atum-work-band]')!, { key: 'Escape' })
    expect(window.document.querySelector('[data-atum-work-band]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Assistants on' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(window.document.querySelector('[data-atum-work-band]')).toBeNull()
  })

  it('speaks Vietnamese', () => {
    show({ assistants: 'needs_grant' }, { locale: 'vi' })

    expect(screen.getByText('Cho trợ lý làm việc trên máy Mac này?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cho phép' })).toBeTruthy()
    expect(window.document.querySelector('[data-atum-work-enrollment]')!.textContent).toContain('Cloudflare')
  })
})

describe('WorkScreen: the title band (spec §1.4, §8.2)', () => {
  it('titles the page with the Work · Code switch, switches the open project, and puts the switch back when the view refuses', async () => {
    const work = bridge()
    let report: ((snapshot: { projectId: string; mode: 'work' | 'code' } | null) => void) | undefined

    work.getSurfaceMode.mockResolvedValue({ projectId: 'p1', mode: 'work' })
    work.onSurfaceModeChanged.mockImplementation(listener => {
      report = listener

      return () => {}
    })
    show({}, { work })

    const code = await screen.findByRole('button', { name: 'Code' })

    // One place for the name and the mode: the switch is the band's visible title.
    expect(screen.getByRole('heading', { name: 'Work' }).className).toContain('sr-only')
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

  it('runs the view\'s own New thread, and not before the view is ready', () => {
    const work = bridge()
    const { rerender } = show({ view: 'starting' }, { work })

    expect(screen.queryByRole('button', { name: 'New thread' })).toBeNull()
    rerender({ view: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    expect(work.runCommand?.mock.calls).toEqual([['chat.new']])
  })
})
