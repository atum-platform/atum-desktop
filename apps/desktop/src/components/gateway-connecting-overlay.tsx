import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { atumStartupOwnsWindow, setAtumStartupHolding } from '@/app/atum/startup-ownership'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $desktopBoot } from '@/store/boot'
import { requestGatewayReconnect } from '@/store/gateway-reconnect'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $gatewayState } from '@/store/session'
import { AppViewOverlayHold } from '@/store/use-app-view-overlay'

// Cold-start visual: the Atum mark emerges once, ringed by quiet concentric
// material circles and a soft warm glow (keyframes live in styles.css as
// .atum-boot-* so the blanket reduced-motion rule collapses them), over a
// tinted glass ground: on macOS the window's vibrancy material shows the
// desktop frosted through `.atum-launch` from the very first frame, the way
// Codex's launch window does; elsewhere the tint is the ground itself. The
// live status line is the real boot step message — already localized,
// Vietnamese-first — never a fabricated progress number.

// Exit choreography (ms): mark + copy fade down + out, hold, then the
// overlay itself fades.
const CONTENT_OUT_MS = 360
const POST_CONTENT_HOLD_MS = 300
const OVERLAY_OUT_MS = 520
// Preview-only: how long to "connect" for, and the pause before replaying.
const PREVIEW_CONNECT_MS = 2600
const PREVIEW_REPLAY_MS = 1100

type Phase = 'live' | 'content-out' | 'overlay-out' | 'gone'

// Dev affordance: a warm Cmd+R reconnects almost instantly, so the overlay
// only flashes. Load with `?connecting=1` to force a looping preview.
function forcedPreview(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return false
  }

  try {
    return new URLSearchParams(window.location.search).get('connecting') === '1'
  } catch {
    return false
  }
}

export function GatewayConnectingOverlay() {
  const { t } = useI18n()
  const gatewayState = useStore($gatewayState)
  const boot = useStore($desktopBoot)
  const gatewaySwitching = useStore($gatewaySwitching)
  const [previewing] = useState(forcedPreview)
  const reduce = useReducedMotion()
  // Under reduced motion, skip the multi-phase exit choreography (content-out →
  // hold → overlay fade) and jump straight to gone so the overlay unmounts
  // the instant the gateway opens. E2E screenshots rely on this to avoid
  // catching the overlay mid-fade.
  const [phase, setPhase] = useState<Phase>('live')
  // Once cold boot has completed once, never resurrect the fullscreen overlay
  // — soft gateway switches keep the shell and reskeleton the sidebar instead.
  const coldBootDoneRef = useRef(false)

  if (!boot.running && boot.progress >= 100 && !boot.error) {
    coldBootDoneRef.current = true
  }

  // The full-screen connecting overlay is for initial boot only. After a
  // healthy boot, flaky networks / sleep-wake can drop the socket and flip the
  // gateway state back to closed/error while the app reconnects. Do not cover
  // the chat then — users should still be able to type drafts, open settings,
  // and recover instead of staring at a modal startup screen.
  //
  // The predicate itself lives in startup-ownership.ts because the Atum
  // controller must make the mirror-image decision (mount the shell or not)
  // from the same facts, in the same frame.
  const connecting = atumStartupOwnsWindow({
    bootError: boot.error,
    bootProgress: boot.progress,
    bootRunning: boot.running,
    bootVisible: boot.visible,
    coldBootDone: coldBootDoneRef.current,
    gatewayState,
    gatewaySwitching
  })

  // Latches once we've actually shown the overlay, so the brief frame where
  // gatewayState flips to "open" (connecting -> false) before the exit phase
  // kicks in doesn't unmount us and cause a flash.
  const shownRef = useRef(false)

  if (previewing || connecting) {
    shownRef.current = true
  }

  // Publish the startup ownership lock. We hold it while the plate is fully
  // painted and release it the instant we begin fading OURSELVES out, so the
  // Atum shell fades up THROUGH the disappearing plate rather than sitting
  // behind it — the translucent plate must never reveal application UI.
  // Account sign-in and boot failure release immediately so their recovery
  // controls can mount before a gateway is available.
  const holding = boot.phase !== 'renderer.account' && !boot.error && !previewing && shownRef.current && (phase === 'live' || phase === 'content-out')

  useEffect(() => {
    setAtumStartupHolding(holding)

    return () => setAtumStartupHolding(false)
  }, [holding])

  // Kick off the exit when connected: real connect, or a faked timer in preview.
  useEffect(() => {
    if (phase !== 'live') {
      return
    }

    if (previewing) {
      const id = window.setTimeout(() => setPhase('content-out'), PREVIEW_CONNECT_MS)

      return () => window.clearTimeout(id)
    }

    if (gatewayState === 'open' && shownRef.current) {
      // Under reduced motion, skip the multi-phase exit choreography
      // (content-out → hold → overlay fade) and jump straight to gone so the
      // overlay unmounts the instant the gateway opens. E2E screenshots
      // rely on this to avoid catching the overlay mid-fade.
      setPhase(reduce ? 'gone' : 'content-out')
    }
  }, [phase, previewing, gatewayState, reduce])

  // Advance the exit choreography: content-out -> overlay-out -> gone.
  useEffect(() => {
    if (phase === 'content-out') {
      const id = window.setTimeout(() => setPhase('overlay-out'), CONTENT_OUT_MS + POST_CONTENT_HOLD_MS)

      return () => window.clearTimeout(id)
    }

    if (phase === 'overlay-out') {
      const id = window.setTimeout(() => setPhase('gone'), OVERLAY_OUT_MS)

      return () => window.clearTimeout(id)
    }

    // Preview replays so we can keep watching the transition.
    if (phase === 'gone' && previewing) {
      const id = window.setTimeout(() => setPhase('live'), PREVIEW_REPLAY_MS)

      return () => window.clearTimeout(id)
    }
  }, [phase, previewing])

  // Recovery or sign-in owns the screen, even when no gateway has opened yet.
  if ((boot.error || boot.phase === 'renderer.account') && !previewing) {
    return null
  }

  const postBootOffline =
    boot.phase !== 'renderer.account' && coldBootDoneRef.current && !gatewaySwitching &&
    (gatewayState === 'closed' || gatewayState === 'error')

  if (postBootOffline && !previewing) {
    return (
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-[calc(var(--titlebar-height)+0.5rem)] z-[1100] flex justify-center px-3"
        data-slot="gateway-offline-recovery"
        role="status"
      >
        <AppViewOverlayHold />
        <div className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-full border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-3 py-1.5 text-xs text-(--ui-text-secondary) shadow-sm">
          <span>{t.errors.offline ?? t.composer.placeholderReconnecting}</span>
          <Button onClick={requestGatewayReconnect} size="xs" variant="ghost">
            {t.common.retry}
          </Button>
        </div>
      </div>
    )
  }

  // Real connect: once the fade finishes, get out of the way for good.
  if (phase === 'gone' && !previewing) {
    return null
  }

  // Never showed (e.g. gateway already up on a warm reload) — stay out.
  if (!previewing && !connecting && !shownRef.current) {
    return null
  }

  const leaving = phase !== 'live'
  const overlayHidden = phase === 'overlay-out' || phase === 'gone'
  // Render an honest milestone from the machine-readable boot phase. Main's
  // diagnostic messages retain engine detail for logs, but they are not
  // product copy and must not leak the legacy Hermes name here.
  const statusLine = bootStatusLine(boot.phase, t.boot.steps)

  return (
    <div
      className={cn(
        'atum-shell atum-launch fixed inset-0 z-[1200] grid place-items-center p-6 transition-opacity duration-500 ease-out',
        overlayHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      data-slot="gateway-connecting-overlay"
    >
      <AppViewOverlayHold />
      {/* Mock 1d: the ambient rings around the 64px mark on the flat window
          ground — no plate — and one quiet caption 26px from the bottom. The
          live boot step stays available to assistive technology. */}
      <div
        className={cn(
          'flex flex-col items-center transition duration-300 ease-out',
          leaving ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
        )}
      >
        <div className="relative grid size-36 place-items-center" data-slot="gateway-connecting-mark">
          <span aria-hidden="true" className="atum-boot-ring" />
          <span aria-hidden="true" className="atum-boot-ring atum-boot-ring--mid" />
          <span aria-hidden="true" className="atum-boot-ring atum-boot-ring--late" />
          <BrandMark className="atum-boot-mark size-16 rounded-[var(--atum-r-sidebar)]" />
        </div>
        <p className="sr-only" data-slot="gateway-connecting-wordmark">
          Atum
        </p>
      </div>
      <p
        aria-hidden="true"
        className={cn(
          'absolute inset-x-0 bottom-[1.625rem] text-center text-(length:--atum-t-body) text-(--atum-ink-faint) transition-opacity duration-300',
          leaving ? 'opacity-0' : 'opacity-100'
        )}
        data-slot="gateway-connecting-caption"
      >
        {t.atum.startup.opening}
      </p>
      {/* The honest boot step stays the live status for assistive technology. */}
      <p aria-live="polite" className="sr-only" data-slot="gateway-connecting-status" role="status">
        {statusLine}
      </p>
    </div>
  )
}

function bootStatusLine(phase: string, steps: ReturnType<typeof useI18n>['t']['boot']['steps']): string {
  if (phase === 'renderer.config') {
    return steps.loadingSettings
  }

  if (phase === 'renderer.gateway.connect' || phase === 'backend.remote') {
    return steps.connectingGateway
  }

  if (phase === 'renderer.boot') {
    return steps.startingDesktopConnection
  }

  return steps.startingHermesDesktop
}
