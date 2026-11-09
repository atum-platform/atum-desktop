import { isGatewayReauthRequired, resolveGatewayWsUrl } from '@hermes/shared'
import { useEffect, useRef } from 'react'

import { $privateAdvisoryTasks } from '@/app/dm/private-advisory-runner'
import type { HermesConnection } from '@/global'
import { HermesGateway } from '@/hermes'
import { translateNow } from '@/i18n'
import { desktopDefaultCwd } from '@/lib/desktop-fs'
import {
  $desktopBoot,
  applyDesktopBootProgress,
  completeDesktopBoot,
  failDesktopBoot,
  setDesktopBootStep,
  waitForDesktopAccount
} from '@/store/boot'
import {
  $gateway,
  closeSecondaryGateways,
  configureGatewayRegistry,
  ensureGatewayForProfile,
  pruneSecondaryGateways,
  reconnectSecondaryGateways,
  reportPrimaryGatewayState,
  setPrimaryGateway,
  touchSecondaryGateways
} from '@/store/gateway'
import { GATEWAY_RECONNECT_REQUEST_EVENT } from '@/store/gateway-reconnect'
import { $gatewaySwitching, wipeSessionListsForGatewaySwitch } from '@/store/gateway-switch'
import { notify, notifyError } from '@/store/notifications'
import { resetProfilesForAccountSwitch } from '@/store/profile'
import { $activeGatewayProfile, normalizeProfileKey, touchActiveGatewayBackend } from '@/store/profile'
import {
  $activeSessionId,
  $connection,
  $currentCwd,
  $sessions,
  ensureDefaultWorkspaceCwd,
  setConnection,
  setCurrentBranch,
  setCurrentCwd,
  setSessionsLoading
} from '@/store/session'
import { $attentionSessionIds, $workingSessionIds, resetTileRuntimeBindings } from '@/store/session-states'
import type { RpcEvent } from '@/types/hermes'

import { stashGatewaySurvivor, survivorIsStale, takeGatewaySurvivor } from './gateway-hmr-survivor'

// After this many consecutive failed reconnects (≈45s with the 1→15s backoff)
// raise a recoverable boot error. Otherwise a dropped remote gateway loops the
// backoff forever behind the fullscreen CONNECTING overlay with no way to reach
// Settings / sign in / switch to local — the "lost connection breaks the app"
// dead end. The next successful reconnect clears it.
const RECONNECT_ESCALATE_AFTER = 6

// A cold boot may win the gateway-open race while the first REST read still
// meets a transient backend/DB failure. Boot stays usable (the sidebar is not
// boot-critical), but a quiet session has no later turn or reconnect to repair
// that one lost read. Retry in the background without holding the boot overlay.
const INITIAL_SESSION_REFRESH_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const

interface GatewayBootOptions {
  beforeConnectionSwitch: () => void
  handleGatewayEvent: (event: RpcEvent) => void
  onConnectionReady: (
    connection: Awaited<ReturnType<NonNullable<typeof window.hermesDesktop>['getConnection']>> | null
  ) => void
  onGatewayReady: (gateway: HermesGateway | null) => void
  refreshHermesConfig: () => Promise<void>
  refreshSessions: () => Promise<void>
}

export function useGatewayBoot({
  beforeConnectionSwitch,
  handleGatewayEvent,
  onConnectionReady,
  onGatewayReady,
  refreshHermesConfig,
  refreshSessions
}: GatewayBootOptions) {
  const callbacksRef = useRef({
    beforeConnectionSwitch,
    handleGatewayEvent,
    onConnectionReady,
    onGatewayReady,
    refreshHermesConfig,
    refreshSessions
  })

  callbacksRef.current = {
    beforeConnectionSwitch,
    handleGatewayEvent,
    onConnectionReady,
    onGatewayReady,
    refreshHermesConfig,
    refreshSessions
  }

  useEffect(() => {
    let cancelled = false
    const desktop = window.hermesDesktop

    const publish = (next: HermesConnection | null) => {
      callbacksRef.current.onConnectionReady(next)
      setConnection(next)
    }

    if (!desktop) {
      failDesktopBoot(translateNow('boot.errors.ipcBridgeUnavailable'))
      setSessionsLoading(false)

      return () => void (cancelled = true)
    }

    // --- Reconnect-after-sleep machinery -------------------------------------
    // macOS sleep silently drops the renderer's WebSocket. The backend Python
    // process keeps running, but nothing re-opened the socket on wake, so the
    // composer stayed disabled forever on "Starting Hermes...". Once the
    // initial boot succeeds we treat any non-open state as recoverable and
    // reconnect with backoff, and we nudge a reconnect on the OS/browser
    // signals that fire around wake (power resume, network online, the window
    // becoming visible).
    let bootCompleted = false
    let waitingForAccount = false
    let reconnecting = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let initialSessionRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null
    let initialSessionRefreshRetryAttempt = 0
    // Surface "sign in again" once per disconnect episode, not on every backoff
    // tick — a stale OAuth ticket fails every attempt and would otherwise stack
    // identical error toasts (and their haptics). Reset on the next clean open.
    let reauthNotified = false
    // Raised once the reconnect loop crosses RECONNECT_ESCALATE_AFTER so the
    // recovery overlay replaces the dead-end CONNECTING screen. Reset on a clean
    // open or a manual/wake-driven reconnect.
    let escalated = false

    // Wrap the live getter in a call so TS control-flow analysis doesn't narrow
    // `connectionState` to a constant across the early-return guards (the state
    // genuinely changes between reads).
    const gatewayOpen = () => gateway.connectionState === 'open'

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const clearInitialSessionRefreshRetry = () => {
      if (initialSessionRefreshRetryTimer !== null) {
        clearTimeout(initialSessionRefreshRetryTimer)
        initialSessionRefreshRetryTimer = null
      }
    }

    const scheduleInitialSessionRefreshRetry = () => {
      if (cancelled || initialSessionRefreshRetryTimer !== null) {
        return
      }

      const delay = INITIAL_SESSION_REFRESH_RETRY_DELAYS_MS[initialSessionRefreshRetryAttempt]

      if (delay === undefined) {
        setSessionsLoading(false)

        return
      }

      initialSessionRefreshRetryAttempt += 1
      initialSessionRefreshRetryTimer = setTimeout(() => {
        initialSessionRefreshRetryTimer = null

        if (cancelled) {
          return
        }

        void callbacksRef.current
          .refreshSessions()
          .then(() => {
            // A busy backend can answer the aggregate sidebar request with an
            // empty/error slice instead of rejecting it. That is still not a
            // trustworthy cold-start discovery result: a pre-existing account
            // would otherwise stay empty forever because no turn or reconnect
            // occurs to trigger another refresh. New accounts pay only this
            // same bounded, post-boot retry budget.
            if ($sessions.get().length === 0) {
              scheduleInitialSessionRefreshRetry()
            }
          })
          .catch(() => scheduleInitialSessionRefreshRetry())
      }, delay)
    }

    const handleAccountRequired = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)

      // Electron prefixes IPC errors with the method name. Keep the main
      // process's account gate intact and let the existing login shell mount.
      if (!/(?:^|: )atum_runtime_account_required$/.test(message)) {
        return false
      }

      waitingForAccount = true
      bootCompleted = false
      clearReconnectTimer()
      clearInitialSessionRefreshRetry()
      closeSecondaryGateways()
      gateway.close()
      publish(null)
      setSessionsLoading(false)
      waitForDesktopAccount()

      return true
    }

    const attemptReconnect = async () => {
      if (cancelled || waitingForAccount || reconnecting || gatewayOpen() || $gatewaySwitching.get()) {
        return
      }

      reconnecting = true

      try {
        // Drop a stale REMOTE backend cache before re-dialing. After sleep/wake a
        // remote backend can become unreachable, but it has no child process
        // whose 'exit' would clear the main process's cached descriptor — without
        // this the renderer re-dials the same dead endpoint forever and stays on
        // "Starting Hermes…". The probe is a no-op for a healthy or local backend.
        await desktop.revalidateConnection?.().catch(() => undefined)

        const conn = await desktop.getConnection($activeGatewayProfile.get())

        if (cancelled) {
          return
        }

        publish(conn)
        // Re-mint the WS URL before reconnecting. OAuth tickets are single-use
        // with a short TTL, so the ticket baked into the cached conn.wsUrl is
        // dead on every reconnect after the initial boot — reusing it surfaces
        // as an opaque "Could not connect to Hermes gateway". resolveGatewayWsUrl
        // mints a fresh ticket rather than connecting with a stale one. An
        // explicit auth rejection asks for sign-in; transport failures stay in
        // this reconnect loop. For local/token gateways the URL carries a
        // long-lived token and the re-mint is a cheap no-op.
        const wsUrl = await resolveGatewayWsUrl(desktop, conn)
        await gateway.connect(wsUrl)

        if (cancelled) {
          return
        }

        reconnectAttempt = 0
        // A respawned backend re-mints (recycles) runtime ids, so any tile's
        // bound runtime id is now stale — drop them so each tile re-resumes.
        resetTileRuntimeBindings()
        // Resync state that may have moved on the backend while we were asleep.
        await callbacksRef.current.refreshHermesConfig().catch(() => undefined)
        await callbacksRef.current.refreshSessions().catch(() => undefined)
      } catch (err) {
        if (!cancelled && handleAccountRequired(err)) {
          return
        }

        // OAuth session expired mid-reconnect: surface the actionable "sign in
        // again" message once instead of silently looping the backoff against a
        // ticket that can never succeed. Transport failures fall through to the
        // backoff in the finally block below.
        if (!cancelled && isGatewayReauthRequired(err) && !reauthNotified) {
          reauthNotified = true
          notifyError(err, translateNow('boot.errors.gatewaySignInRequired'))
        }
      } finally {
        reconnecting = false

        if (!cancelled && !waitingForAccount && !gatewayOpen() && !$gatewaySwitching.get()) {
          if (reconnectAttempt >= RECONNECT_ESCALATE_AFTER && !escalated) {
            escalated = true
            failDesktopBoot(translateNow('boot.errors.gatewayConnectionLost'))
          }

          scheduleReconnect()
        }
      }
    }

    function scheduleReconnect() {
      if (cancelled || waitingForAccount || reconnecting || reconnectTimer !== null || gatewayOpen() || $gatewaySwitching.get()) {
        return
      }

      // 1s, 2s, 4s … capped at 15s.
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4))
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void attemptReconnect()
      }, delay)
    }

    const reconnectNow = () => {
      if (cancelled || !bootCompleted || $gatewaySwitching.get()) {
        return
      }

      clearReconnectTimer()
      reconnectAttempt = 0
      escalated = false
      reconnectSecondaryGateways()

      if (!gatewayOpen()) {
        void attemptReconnect()
      }
    }

    // Adopt the profile the primary (window) backend booted as, so same-profile
    // resumes are no-op swaps and reconnects target the right backend.
    // Best-effort: a missing preference means "default". Shared by boot + soft
    // switch.
    async function adoptPrimaryProfile() {
      try {
        const pref = await desktop.profile?.get?.()
        const profileKey = (pref?.profile ?? '').trim() || 'default'
        $activeGatewayProfile.set(profileKey)
        setPrimaryGateway(gateway, profileKey)
        void ensureGatewayForProfile(profileKey)
      } catch {
        $activeGatewayProfile.set('default')
      }
    }

    // Seed the working dir from the backend default on a fresh view (nothing
    // open yet). Shared by boot + soft switch.
    async function seedDefaultCwd() {
      await ensureDefaultWorkspaceCwd()
      const remoteDefault = await desktopDefaultCwd().catch(() => null)

      if (remoteDefault?.cwd && !$activeSessionId.get() && !$currentCwd.get()) {
        setCurrentCwd(remoteDefault.cwd)
        setCurrentBranch(remoteDefault.branch || '')
      }
    }

    // Soft gateway-mode apply: main tore down the primary without reloading.
    // Wipe session lists so skeletons retrigger, then re-dial in place.
    const softSwitch = async () => {
      if (cancelled) {
        return
      }

      $gatewaySwitching.set(true)
      waitingForAccount = false
      clearReconnectTimer()
      clearInitialSessionRefreshRetry()
      reconnectAttempt = 0
      escalated = false
      reauthNotified = false
      callbacksRef.current.beforeConnectionSwitch()
      wipeSessionListsForGatewaySwitch()
      resetProfilesForAccountSwitch()

      try {
        gateway.close()
        closeSecondaryGateways()

        const conn = await desktop.getConnection()

        if (cancelled) {
          return
        }

        publish(conn)
        const wsUrl = await resolveGatewayWsUrl(desktop, conn)
        await gateway.connect(wsUrl)

        if (cancelled) {
          return
        }

        // Same shape as boot(): profile first (session scope depends on it),
        // then the independent fetches concurrently.
        await adoptPrimaryProfile()
        await Promise.all([
          seedDefaultCwd(),
          callbacksRef.current.refreshHermesConfig().catch(() => undefined),
          callbacksRef.current.refreshSessions().catch(() => undefined)
        ])
        completeDesktopBoot()
        bootCompleted = true
      } catch (err) {
        if (!cancelled) {
          if (handleAccountRequired(err)) {
            return
          }

          const message = err instanceof Error ? err.message : String(err)
          failDesktopBoot(message)
          setSessionsLoading(false)
        }
      } finally {
        $gatewaySwitching.set(false)
      }
    }

    const offBootProgress = desktop.onBootProgress(payload => {
      // Native runtime progress belongs to the previous attempt until main
      // activates an account; even its late errors must not obscure sign-in.
      if (waitingForAccount) {
        return
      }

      // Soft switch / post-boot startHermes re-emits progress — ignore so the
      // cold-boot CONNECTING overlay stays down. Errors still surface.
      if ($gatewaySwitching.get() || bootCompleted) {
        if (payload.error) {
          applyDesktopBootProgress(payload)
        }

        return
      }

      applyDesktopBootProgress(payload)
    })

    void desktop
      .getBootProgress()
      .then(snapshot => {
        if (!cancelled && !waitingForAccount) {
          applyDesktopBootProgress(snapshot)
        }
      })
      .catch(() => undefined)

    setDesktopBootStep({
      phase: 'renderer.boot',
      message: translateNow('boot.steps.startingDesktopConnection'),
      progress: 6
    })

    // HMR adoption: in a dev hot update, the previous effect instance parked its
    // still-open socket instead of closing it (see the cleanup below). Re-adopt
    // it so an edit doesn't drop the live agent session. A stale (closed) parked
    // socket is discarded and we boot fresh. No-op in production: import.meta.hot
    // is undefined there, so this folds to `null` and the whole survivor module
    // dead-code-eliminates out of the bundle.
    const survivor = import.meta.hot ? takeGatewaySurvivor() : null
    const adoptedFromHmr = Boolean(survivor && !survivorIsStale(survivor))

    if (survivor && !adoptedFromHmr) {
      // Parked socket died between edits (e.g. backend restart) — release it.
      try {
        survivor.gateway.close()
      } catch {
        // ignore
      }
    }

    const gateway = adoptedFromHmr ? survivor!.gateway : new HermesGateway()

    callbacksRef.current.onGatewayReady(gateway)
    setPrimaryGateway(gateway, survivor?.profile ?? normalizeProfileKey($activeGatewayProfile.get()))
    // Secondary (background-profile) sockets funnel into the same handler.
    configureGatewayRegistry({ onEvent: event => callbacksRef.current.handleGatewayEvent(event) })

    const offState = gateway.onState(st => {
      // Mirror to the composer only while the primary is the active profile —
      // a background secondary reconnect mustn't flip the foreground state.
      reportPrimaryGatewayState(st)

      if (st === 'open') {
        reconnectAttempt = 0
        reauthNotified = false
        escalated = false
        clearReconnectTimer()

        // A revalidate-driven reconnect can rebuild the backend in place when the
        // cached remote was found dead, which re-drives the boot-progress overlay.
        // Unlike the initial boot, nothing calls completeDesktopBoot() afterwards,
        // so dismiss it here once we're open again — otherwise the overlay sticks
        // at ~94%. A no-op on a normal (non-rebuild) reconnect.
        if (bootCompleted) {
          completeDesktopBoot()
        }
      } else if (bootCompleted && !$gatewaySwitching.get() && (st === 'closed' || st === 'error')) {
        // The socket dropped after a healthy boot (typically sleep/wake). Try
        // to bring it back instead of leaving the composer stuck disabled.
        scheduleReconnect()
      }
    })

    const sourceProfile = normalizeProfileKey($activeGatewayProfile.get())

    const offEvent = gateway.onEvent(event =>
      callbacksRef.current.handleGatewayEvent({ ...event, profile: sourceProfile })
    )

    // Wake signals: power resume (macOS/Windows), network coming back, and the
    // window regaining focus/visibility. Each nudges an immediate reconnect.
    const offPowerResume = desktop.onPowerResume?.(() => reconnectNow())
    const offConnectionApplied = desktop.onConnectionApplied?.(() => void softSwitch())

    const onOnline = () => reconnectNow()

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reconnectNow()
      }
    }

    window.addEventListener('online', onOnline)
    window.addEventListener(GATEWAY_RECONNECT_REQUEST_EVENT, reconnectNow)
    document.addEventListener('visibilitychange', onVisible)

    // Keep live pool backends alive while this window is open (the main process
    // can't observe the direct renderer↔backend WS). No-op for the primary.
    const keepaliveTimer = setInterval(() => {
      if (waitingForAccount) {
        return
      }

      touchActiveGatewayBackend()
      touchSecondaryGateways()
    }, 60_000)

    // Bound concurrency cost to live work: keep a background socket only while
    // its profile has a running (working) or blocked (needs-input) session.
    // Once that profile goes idle its socket is dropped and its backend is free
    // to idle-reap. The active profile is always spared.
    const recomputeKeptGateways = () => {
      const live = new Set([...$workingSessionIds.get(), ...$attentionSessionIds.get()])
      const keep = new Set<string>()

      for (const session of $sessions.get()) {
        if (live.has(session.id)) {
          keep.add(normalizeProfileKey(session.profile))
        }
      }

      // Advisory sessions are intentionally absent from the ordinary chat
      // list. Their execution task owns the background connection, including
      // startup before a durable session ID exists and tool/approval pauses.
      for (const task of Object.values($privateAdvisoryTasks.get())) {
        if (task.profile && (task.state === 'starting' || task.state === 'running' || task.state === 'needs_input')) {
          keep.add(normalizeProfileKey(task.profile))
        }
      }

      pruneSecondaryGateways(keep)
    }

    const offWorking = $workingSessionIds.subscribe(() => recomputeKeptGateways())
    const offAttention = $attentionSessionIds.subscribe(() => recomputeKeptGateways())
    const offActiveProfile = $activeGatewayProfile.subscribe(() => recomputeKeptGateways())
    const offAdvisoryTasks = $privateAdvisoryTasks.subscribe(() => recomputeKeptGateways())

    const offWindowState = desktop.onWindowStateChanged?.(payload => {
      const current = $connection.get()

      if (current) {
        publish({ ...current, ...payload })
      }
    })

    const offExit = desktop.onBackendExit(() => {
      if (waitingForAccount || $gatewaySwitching.get()) {
        return
      }

      if ($desktopBoot.get().running || $desktopBoot.get().visible) {
        failDesktopBoot(translateNow('boot.errors.backgroundExitedDuringStartup'))
      }

      notify({
        kind: 'error',
        title: translateNow('boot.errors.backendStopped'),
        message: translateNow('boot.errors.backgroundExited'),
        durationMs: 0
      })
    })

    async function boot() {
      try {
        const conn = await desktop.getConnection()

        if (cancelled) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.gateway.connect',
          message: translateNow('boot.steps.connectingGateway'),
          progress: 95
        })
        publish(conn)
        // Mint a fresh WS URL right before connecting. For OAuth gateways the
        // ticket is single-use with a short TTL, so the ticket baked into
        // conn.wsUrl is stale; resolveGatewayWsUrl() re-mints it rather than
        // connecting with a dead ticket. Auth rejection asks for sign-in;
        // connectivity failures remain retryable.
        const wsUrl = await resolveGatewayWsUrl(desktop, conn)
        await gateway.connect(wsUrl)

        if (cancelled) {
          return
        }

        // Profile adoption must land first: refreshSessions scopes its fetch by
        // $profileScope ← $activeGatewayProfile. The remaining three fetches
        // (cwd seed, config, sessions) are independent REST calls — running
        // them serially added their sum to time-to-populated-sidebar when only
        // the max is needed.
        await adoptPrimaryProfile()

        setDesktopBootStep({
          phase: 'renderer.config',
          message: translateNow('boot.steps.loadingSettings'),
          progress: 97
        })

        let initialSessionRefreshFailed = false

        await Promise.all([
          seedDefaultCwd(),
          callbacksRef.current.refreshHermesConfig(),
          // Session-list population is never boot-fatal. The gateway WS is
          // already open by this point — a failed sidebar fetch (transient
          // blip, or an endpoint the fallback couldn't cover) must leave the
          // app usable with an empty sidebar. The bounded post-boot retry below
          // repairs a quiet cold start; reconnect/turn refreshes remain later
          // safety nets. Never brick boot behind the "Hermes couldn't start"
          // overlay. Matches the reconnect + softSwitch call sites.
          callbacksRef.current.refreshSessions().catch(() => {
            initialSessionRefreshFailed = true
            setSessionsLoading(false)
          })
        ])

        if (cancelled) {
          return
        }

        completeDesktopBoot()
        bootCompleted = true

        if (initialSessionRefreshFailed || $sessions.get().length === 0) {
          scheduleInitialSessionRefreshRetry()
        }
      } catch (err) {
        if (!cancelled) {
          if (handleAccountRequired(err)) {
            return
          }

          const message = err instanceof Error ? err.message : String(err)
          failDesktopBoot(message)
          setSessionsLoading(false)
        }
      }
    }

    // Adopt the parked socket without re-running the full boot handshake: the
    // socket is already open, the backend session is untouched, and we already
    // know the profile. We only re-publish the connection, re-sync config +
    // sessions (cheap, and the backend may have moved on between edits), and
    // dismiss any boot overlay. This is what keeps a live, mid-stream session
    // intact across an HMR update.
    async function adoptBoot() {
      bootCompleted = true
      completeDesktopBoot()

      if (survivor?.connection) {
        publish(survivor.connection)
      }

      const profile = survivor?.profile ?? $activeGatewayProfile.get()
      $activeGatewayProfile.set(profile)
      void ensureGatewayForProfile(profile)

      // Mirror the current (already-open) socket state into the composer so the
      // input doesn't sit disabled after the swap.
      reportPrimaryGatewayState(gateway.connectionState)

      await callbacksRef.current.refreshHermesConfig().catch(() => undefined)

      if (cancelled) {
        return
      }

      await callbacksRef.current.refreshSessions().catch(() => undefined)
    }

    if (adoptedFromHmr) {
      void adoptBoot()
    } else {
      void boot()
    }

    return () => {
      cancelled = true
      $gatewaySwitching.set(false)
      clearReconnectTimer()
      clearInitialSessionRefreshRetry()
      clearInterval(keepaliveTimer)
      offWorking()
      offAttention()
      offActiveProfile()
      offAdvisoryTasks()
      window.removeEventListener('online', onOnline)
      window.removeEventListener(GATEWAY_RECONNECT_REQUEST_EVENT, reconnectNow)
      document.removeEventListener('visibilitychange', onVisible)
      offPowerResume?.()
      offConnectionApplied?.()
      offState()
      offEvent()
      offExit()
      offWindowState?.()
      offBootProgress()

      // HMR teardown vs. real unmount. On a hot update we must NOT close the
      // socket — that's the whole bug. Detach this instance's listeners (their
      // closures capture the disposed module), park the still-open gateway, and
      // let the freshly loaded effect re-adopt it. Secondaries are owned by the
      // gateway store (HMR-stable module state), so they survive untouched.
      // Production: import.meta.hot is undefined, so this branch never runs and
      // the original destructive teardown below is byte-for-byte preserved.
      if (import.meta.hot && gateway.connectionState === 'open') {
        stashGatewaySurvivor({
          gateway,
          profile: survivor?.profile ?? $activeGatewayProfile.get(),
          connection: $connection.get()
        })

        return
      }

      closeSecondaryGateways()
      gateway.close()
      publish(null)
      callbacksRef.current.onGatewayReady(null)
      setPrimaryGateway(null)
      $gateway.set(null)
    }
  }, [])
}
