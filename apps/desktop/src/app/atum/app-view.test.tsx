import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { holdAppViewOverlay, overlapsAppView, resetAppViewOverlayForTests } from '@/store/app-view-overlay'

import type { AppViewBridge, AppViewState } from '../../../shared/app-view/ipc'

import { AtumAppView } from './app-view'

type Bridge = AppViewBridge

function fakeBridge(
  openResult: { viewId: string } | { error: string } = { viewId: 'view-1' },
  sequence: string[] = []
) {
  let listener: ((state: AppViewState) => void) | null = null
  const calls: Array<{ name: string; args: unknown[] }> = []

  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args })

      return Promise.resolve({ ok: true as const })
    }

  const bridge: Bridge = {
    open: vi.fn(async input => {
      calls.push({ name: 'open', args: [input] })
      const next = sequence.shift()

      return next ? { viewId: next } : openResult
    }),
    setBounds: record('setBounds') as Bridge['setBounds'],
    setVisibility: record('setVisibility') as Bridge['setVisibility'],
    focus: record('focus') as Bridge['focus'],
    reload: record('reload') as Bridge['reload'],
    close: record('close') as Bridge['close'],
    onState: callback => {
      listener = callback

      return () => {
        listener = null
      }
    }
  }

  return { bridge, calls, emit: (state: AppViewState) => listener?.(state) }
}

beforeEach(() => {
  resetAppViewOverlayForTests()

  class RO {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
  vi.stubGlobal('IntersectionObserver', undefined)
})

afterEach(() => {
  // Vitest's stack-ordered hooks run this before RTL's auto-cleanup. Unmount
  // while the bridge and observers still exist, even when an assertion fails.
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

function mount(bridge: Bridge | null, props: Partial<Parameters<typeof AtumAppView>[0]> = {}) {
  ;(window as unknown as { hermesDesktop: { appView?: Bridge } }).hermesDesktop = bridge ? { appView: bridge } : {}

  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <AtumAppView app="moon" routeId="readings" {...props} />
    </I18nProvider>
  )
}

describe('AtumAppView', () => {
  it('opens from {app, route_id}, reports bounds and visibility, and closes on unmount', async () => {
    const { bridge, calls } = fakeBridge()
    const view = mount(bridge)
    // Visibility is a layout effect; geometry is a later passive effect.
    await waitFor(() => expect(calls.some(call => call.name === 'setBounds')).toBe(true))
    expect(calls[0]).toEqual({ name: 'open', args: [{ app: 'moon', route_id: 'readings' }] })

    const bounds = calls.find(call => call.name === 'setBounds')!.args[0] as {
      viewId: string
      bounds: Record<string, number>
    }

    expect(bounds.viewId).toBe('view-1')
    expect(Object.keys(bounds.bounds).sort()).toEqual(['height', 'width', 'x', 'y'])
    expect(calls.find(call => call.name === 'setVisibility')!.args[0]).toEqual({
      viewId: 'view-1',
      visible: true,
      overlayActive: false
    })
    expect(JSON.stringify(calls)).not.toContain('http')
    view.unmount()
    expect(calls.at(-1)).toEqual({ name: 'close', args: ['view-1'] })
  })

  it('detaches while a renderer overlay is open and while hidden', async () => {
    const { bridge, calls } = fakeBridge()
    const view = mount(bridge)
    await waitFor(() => expect(calls.some(call => call.name === 'setVisibility')).toBe(true))
    let release: () => void = () => undefined
    act(() => {
      release = holdAppViewOverlay()
    })
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        name: 'setVisibility',
        args: [{ viewId: 'view-1', visible: true, overlayActive: true }]
      })
    )
    act(() => release())
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        name: 'setVisibility',
        args: [{ viewId: 'view-1', visible: true, overlayActive: false }]
      })
    )
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <AtumAppView app="moon" hidden routeId="readings" />
      </I18nProvider>
    )
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        name: 'setVisibility',
        args: [{ viewId: 'view-1', visible: false, overlayActive: false }]
      })
    )
  })

  it('keeps overlay geometry while detached but clears it when hidden or unmounted', async () => {
    let intersection = (_entries: Array<{ isIntersecting: boolean }>) => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersection) { intersection = callback }
      observe() {}
      disconnect() {}
    })
    const rect = { height: 600, width: 500, x: 50, y: 60 }

    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...rect, bottom: 660, left: 50, right: 550, top: 60, toJSON: () => rect
    })

    const { bridge } = fakeBridge()

    let release = () => {}

    try {
      const view = mount(bridge)
      await waitFor(() => expect(overlapsAppView(rect)).toBe(true))
      await act(async () => { release = holdAppViewOverlay() })
      expect(overlapsAppView(rect)).toBe(true)
      await act(async () => { intersection([{ isIntersecting: false }]) })
      expect(overlapsAppView(rect)).toBe(false)
      await act(async () => { intersection([{ isIntersecting: true }]) })
      expect(overlapsAppView(rect)).toBe(true)
      view.rerender(
        <I18nProvider configClient={null} initialLocale="en">
          <AtumAppView app="moon" hidden routeId="readings" />
        </I18nProvider>
      )
      expect(overlapsAppView(rect)).toBe(false)
      view.rerender(
        <I18nProvider configClient={null} initialLocale="en">
          <AtumAppView app="moon" routeId="readings" />
        </I18nProvider>
      )
      await waitFor(() => expect(overlapsAppView(rect)).toBe(true))
      view.unmount()
      expect(overlapsAppView(rect)).toBe(false)
    } finally {
      act(() => release())
      measure.mockRestore()
    }
  })

  it('renders typed failure states from main and offers a retry only where a fresh launch is safe', async () => {
    const { bridge, calls, emit } = fakeBridge()
    mount(bridge)
    await waitFor(() => expect(calls.some(call => call.name === 'setVisibility')).toBe(true))
    expect(screen.getByRole('status').textContent).toBe('Opening…')
    act(() => emit({ viewId: 'view-1', status: 'error', error: 'security_failure' }))
    expect(screen.getByRole('alert').textContent).toContain('could not be verified')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    act(() => emit({ viewId: 'view-1', status: 'error', error: 'temporarily_unavailable', retryAfterMs: 2000 }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls.at(-1)).toEqual({ name: 'reload', args: ['view-1'] }))
    act(() => emit({ viewId: 'other', status: 'error', error: 'unlinked' }))
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => emit({ viewId: 'view-1', status: 'ready' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a no-platform-link recovery returns to chat without offering Connect', async () => {
    const onConnect = vi.fn()
    const { bridge, emit, calls } = fakeBridge()
    mount(bridge, { onConnect, linkRecovery: { label: 'Back to chat', message: 'Link your account in chat to open this.' } })
    await waitFor(() => expect(calls.some(call => call.name === 'setBounds')).toBe(true))
    act(() => emit({ viewId: 'view-1', status: 'error', error: 'not_linked' }))
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(onConnect).toHaveBeenCalledOnce()
  })

  it('shows the connect state without any login navigation, and fails closed without a bridge', async () => {
    const onConnect = vi.fn()
    const { bridge, calls, emit } = fakeBridge()
    const connected = mount(bridge, { onConnect })
    await waitFor(() => expect(calls.some(call => call.name === 'setBounds')).toBe(true))
    act(() => emit({ viewId: 'view-1', status: 'error', error: 'unlinked' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onConnect).toHaveBeenCalledTimes(1)
    connected.unmount()

    const refused = fakeBridge({ error: 'account_unavailable' })
    const view = mount(refused.bridge)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Sign in to Atum'))
    view.unmount()

    mount(null)
    expect(screen.getByRole('alert').textContent).toContain('Sign in to Atum')
  })

  it('uses an injected bridge, follows its identity, and contains an open rejection', async () => {
    const fallback = fakeBridge()
    const first = fakeBridge({ viewId: 'injected-1' })
    const second = fakeBridge({ viewId: 'injected-2' })
    const view = mount(fallback.bridge, { bridge: first.bridge })

    await waitFor(() => expect(first.calls.some(call => call.name === 'open')).toBe(true))
    expect(fallback.calls.some(call => call.name === 'open')).toBe(false)
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <AtumAppView app="moon" bridge={second.bridge} routeId="readings" />
      </I18nProvider>
    )
    await waitFor(() => expect(first.calls).toContainEqual({ name: 'close', args: ['injected-1'] }))
    await waitFor(() => expect(second.calls.some(call => call.name === 'open')).toBe(true))
    view.unmount()

    const rejected = fakeBridge()
    rejected.bridge.open = vi.fn(async () => {
      throw new Error('offline')
    })
    mount(null, { bridge: rejected.bridge })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable'))
  })
})

/**
 * A view is bound to the manifest it opened under, so when an app's declared
 * reach or version changes main answers `app_unavailable` for good. Reloading
 * that view can only repeat the refusal: recovery has to open a new one.
 */
it('recovers from a changed policy by opening a new view, not reloading the old one', async () => {
  const { bridge, calls, emit } = fakeBridge({ viewId: 'view-1' }, ['view-1', 'view-2'])
  mount(bridge)
  await waitFor(() => expect(calls.some(call => call.name === 'setVisibility')).toBe(true))

  act(() => emit({ viewId: 'view-1', status: 'error', error: 'app_unavailable' }))
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

  // Wait for the replacement view to be fully open, so its geometry effects
  // run inside the test rather than during teardown.
  await waitFor(() => expect(calls.filter(call => call.name === 'open')).toHaveLength(2))
  await waitFor(() =>
    expect(calls).toContainEqual({
      name: 'setBounds',
      args: [{ viewId: 'view-2', bounds: expect.any(Object) }]
    })
  )

  expect(calls.some(call => call.name === 'reload')).toBe(false)

  // The old view is closed before the replacement opens, and the replacement
  // reports its own geometry under its own id.
  const names = calls.map(call => call.name)
  const closeAt = names.indexOf('close')
  const secondOpenAt = names.indexOf('open', names.indexOf('open') + 1)

  expect(closeAt).toBeGreaterThan(-1)
  expect(secondOpenAt).toBeGreaterThan(closeAt)
  expect(calls.some(call => call.name === 'close' && call.args[0] === 'view-1')).toBe(true)
  expect(
    calls.some(call => call.name === 'setVisibility' && (call.args[0] as { viewId: string }).viewId === 'view-2')
  ).toBe(true)
})
