import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $atumStartupHolding } from '@/app/atum/startup-ownership'
import { $desktopBoot, waitForDesktopAccount } from '@/store/boot'
import { GATEWAY_RECONNECT_REQUEST_EVENT } from '@/store/gateway-reconnect'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $desktopOnboarding } from '@/store/onboarding'
import { setGatewayState } from '@/store/session'

import { BootFailureOverlay } from './boot-failure-overlay'
import { GatewayConnectingOverlay } from './gateway-connecting-overlay'

// Repro for the "remote gateway → stuck on CONNECTING, no way to settings"
// report. The connecting overlay (z-1200, full-screen, pointer-events on) used
// to be shown whenever `gatewayState !== 'open' && !boot.error`. The ONLY escape
// hatch — BootFailureOverlay, which has "Use local gateway" / "Sign in" /
// "Retry" — only renders when `boot.error` is set.
//
// useGatewayBoot only calls failDesktopBoot() (which sets boot.error) when the
// INITIAL boot() throws. After the first successful connect (bootCompleted),
// any later socket drop goes through scheduleReconnect(), which loops FOREVER
// against the dead remote. So gatewayState sits at 'closed'/'error' with
// boot.error null. The fix keeps the initial-boot overlay out of post-boot
// reconnects, leaving chat/settings usable while the reconnect loop runs.

function resetStores() {
  setGatewayState('idle')
  $gatewaySwitching.set(false)
  $desktopBoot.set({
    error: null,
    fakeMode: false,
    message: 'ready',
    phase: 'renderer.ready',
    progress: 100,
    running: false,
    timestamp: Date.now(),
    visible: false
  })
  $atumStartupHolding.set(false)
  $desktopOnboarding.set({
    configured: true,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  })
}

beforeEach(resetStores)
afterEach(cleanup)

const isConnectingShown = () => Boolean(document.querySelector('[data-slot="gateway-connecting-overlay"]'))

const isRecoveryShown = () =>
  Boolean(screen.queryByText(/use local gateway/i) || screen.queryByText(/retry/i) || screen.queryByText(/sign in/i))

describe('connecting overlay vs recovery surface', () => {
  it('removes gateway recovery controls when account revocation gives login ownership', () => {
    setGatewayState('open')
    render(<GatewayConnectingOverlay />)

    act(() => setGatewayState('closed'))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()

    act(() => waitForDesktopAccount())
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(isConnectingShown()).toBe(false)
    expect(globalThis.document.querySelector('[data-slot="gateway-offline-recovery"]')).toBeNull()
  })

  it('shows Atum-native identity and maps diagnostic boot phases to product copy', async () => {
    $desktopBoot.set({
      ...$desktopBoot.get(),
      message: 'Resolving Hermes backend',
      phase: 'backend.resolve',
      progress: 8,
      running: true,
      visible: true
    })
    setGatewayState('closed')

    const { rerender } = render(<GatewayConnectingOverlay />)

    expect(isConnectingShown()).toBe(true)
    expect(screen.getByText('Atum')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Starting Atum…')
    expect(document.body.textContent).not.toContain('Hermes')
    expect(document.querySelector('[data-slot="gateway-connecting-mark"]')).toBeTruthy()

    $desktopBoot.set({
      ...$desktopBoot.get(),
      message: 'Connecting to remote Hermes backend',
      phase: 'backend.remote',
      progress: 24
    })
    rerender(<GatewayConnectingOverlay />)

    expect(screen.getByRole('status').textContent).toBe('Connecting live desktop gateway')
    expect(document.body.textContent).not.toContain('Hermes')
  })

  it('hard initial-boot failure surfaces the recovery overlay (the working path)', async () => {
    // failDesktopBoot() ran: error set, gateway never opened.
    $desktopBoot.set({
      ...$desktopBoot.get(),
      error: 'Hermes backend did not become ready',
      running: false,
      visible: true
    })
    setGatewayState('error')

    await act(async () => {
      render(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })

    expect(isRecoveryShown()).toBe(true)
    // Startup overlay bows out when boot.error is set.
    expect(isConnectingShown()).toBe(false)
  })

  it('post-boot socket drops do not re-cover the app with the initial CONNECTING overlay', async () => {
    // 1. Initial boot succeeded: gateway opened, boot completed (no error).
    setGatewayState('open')

    let rerender!: (ui: React.ReactElement) => void
    await act(async () => {
      const result = render(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )

      rerender = result.rerender
    })

    expect(isConnectingShown()).toBe(false)

    // 2. The remote VPS socket drops (sleep/wake, remote restart, network).
    //    bootCompleted is true, so useGatewayBoot routes this through
    //    scheduleReconnect() — boot.error stays NULL.
    await act(async () => {
      setGatewayState('closed')
      rerender!(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })

    // The initial-boot connecting overlay stays out of the way, so settings and
    // the composer remain reachable during the reconnect loop.
    expect(isConnectingShown()).toBe(false)
    expect(isRecoveryShown()).toBe(true)
    expect(screen.getByText('Connection lost. Atum will reconnect automatically.')).toBeTruthy()

    // 3. Reconnect loops against the dead remote: gatewayState bounces closed
    //    → error → closed. Until the escalation path sets boot.error, the app
    //    remains usable instead of modal-blocked.
    await act(async () => {
      setGatewayState('error')
      rerender!(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })
    expect($desktopBoot.get().error).toBeNull()
    expect(isConnectingShown()).toBe(false)
    expect(isRecoveryShown()).toBe(true)

    const reconnectRequested = vi.fn()
    window.addEventListener(GATEWAY_RECONNECT_REQUEST_EVENT, reconnectRequested, { once: true })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reconnectRequested).toHaveBeenCalledOnce()
  })

  it('soft gateway switch keeps the shell — no fullscreen CONNECTING', async () => {
    setGatewayState('open')

    const { rerender } = render(
      <>
        <GatewayConnectingOverlay />
        <BootFailureOverlay />
      </>
    )

    await act(async () => {
      $gatewaySwitching.set(true)
      $desktopBoot.set({
        ...$desktopBoot.get(),
        running: true,
        visible: true,
        progress: 4,
        error: null
      })
      setGatewayState('closed')
      rerender(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })

    expect(isConnectingShown()).toBe(false)
    expect(isRecoveryShown()).toBe(false)
  })

  it('FIX: once the prolonged reconnect raises a recoverable boot error, the recovery overlay takes over', async () => {
    // Mirrors what useGatewayBoot.scheduleReconnect() now does after ~45s of
    // failed post-boot reconnects: it calls failDesktopBoot(), flipping the UI
    // from the dead-end CONNECTING overlay to the recovery surface.
    setGatewayState('error')
    $desktopBoot.set({
      ...$desktopBoot.get(),
      error: 'Lost connection to the Hermes gateway and could not reconnect.',
      running: false,
      visible: true
    })

    await act(async () => {
      render(
        <>
          <GatewayConnectingOverlay />
          <BootFailureOverlay />
        </>
      )
    })

    // Escape hatch is now reachable; the connecting overlay bows out.
    expect(isRecoveryShown()).toBe(true)
    expect(screen.getByRole('button', { name: /collect diagnostics/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /gateway settings/i })).toBeNull()
    expect(isConnectingShown()).toBe(false)
  })
})

// Startup ownership: while this overlay is the window's only surface it holds a
// lock the Atum controller reads to keep the shell (and therefore the sign-in
// form) unmounted. The packaged boot screenshot showed the auth form ghosting
// through the translucent startup plate precisely because no such lock existed.
describe('startup ownership lock', () => {
  // The exit choreography is timer-driven (content-out → hold → overlay fade).
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('releases a visible cold-start plate when login is needed before any gateway opens', () => {
    $desktopBoot.set({ ...$desktopBoot.get(), progress: 8, running: true, visible: true })
    setGatewayState('closed')
    render(<GatewayConnectingOverlay />)
    expect(isConnectingShown()).toBe(true)
    expect($atumStartupHolding.get()).toBe(true)

    act(() => waitForDesktopAccount())

    expect(isConnectingShown()).toBe(false)
    expect($atumStartupHolding.get()).toBe(false)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('holds the window during cold boot and releases it as the plate fades out', async () => {
    $desktopBoot.set({ ...$desktopBoot.get(), progress: 8, running: true, visible: true })
    setGatewayState('closed')

    let rerender!: (ui: React.ReactElement) => void
    await act(async () => {
      rerender = render(<GatewayConnectingOverlay />).rerender
    })

    expect(isConnectingShown()).toBe(true)
    expect($atumStartupHolding.get()).toBe(true)

    // The gateway opens: the plate begins its exit choreography. It is still
    // fully painted, so the shell must stay unmounted.
    await act(async () => {
      $desktopBoot.set({ ...$desktopBoot.get(), progress: 100, running: false, visible: false })
      setGatewayState('open')
      rerender(<GatewayConnectingOverlay />)
    })

    expect($atumStartupHolding.get()).toBe(true)

    // Content-out (360ms) + hold (300ms): the overlay now fades ITSELF, which is
    // where the shell is allowed to fade up through it.
    await act(async () => {
      vi.advanceTimersByTime(700)
    })

    expect($atumStartupHolding.get()).toBe(false)
  })

  it('releases immediately on a boot failure so the recovery overlay has a live shell behind it', async () => {
    $desktopBoot.set({ ...$desktopBoot.get(), error: 'backend did not become ready', running: false, visible: true })
    setGatewayState('error')

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    expect($atumStartupHolding.get()).toBe(false)
  })

  it('never takes the lock on a warm reload where the gateway is already open', async () => {
    setGatewayState('open')

    await act(async () => {
      render(<GatewayConnectingOverlay />)
    })

    expect(isConnectingShown()).toBe(false)
    expect($atumStartupHolding.get()).toBe(false)
  })

  it('releases the lock when the overlay unmounts', async () => {
    $desktopBoot.set({ ...$desktopBoot.get(), progress: 8, running: true, visible: true })
    setGatewayState('closed')

    let unmount!: () => void
    await act(async () => {
      unmount = render(<GatewayConnectingOverlay />).unmount
    })

    expect($atumStartupHolding.get()).toBe(true)

    await act(async () => unmount())

    expect($atumStartupHolding.get()).toBe(false)
  })
})
