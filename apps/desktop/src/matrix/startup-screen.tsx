import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useI18n } from '@/i18n'
import { Check, X } from '@/lib/icons'
import { useAppViewOverlayHold } from '@/store/use-app-view-overlay'

import {
  matrixAgentHoldsLaunch,
  type MatrixAgentView,
  type MatrixReadiness,
  type MatrixSnapshot
} from '../../shared/matrix'
import { matrixAgentAnswersInCloud } from '../../shared/matrix-agent-actions'
import { matrixFirstRunCopy } from '../../shared/matrix-first-run-copy'

import { useAccountStepCopy } from './account-step-copy'
import { useAppCopy } from './app-copy'
import { useMatrixCopy } from './copy'
import { $matrixDesktopServices } from './desktop-services'
import { MatrixFeedbackForm } from './desktop-settings'
import { runMatrixReadinessAction } from './launch-actions'
import { useLaunchCopy } from './launch-copy'
import { ECLIPSE_TIMING, eclipseFinaleMs, eclipseFlightMs } from './launch-eclipse/engine'
import { LAUNCH_ECLIPSE_DIRECTION, LaunchEclipse } from './launch-eclipse/launch-eclipse'
import { launchEclipseSupported } from './launch-eclipse/renderer'
import { type LaunchFlight, LaunchHero, type LaunchPhase } from './launch-hero'
import { LAUNCH_STEPS, launchGatePercent, launchPercent, launchStepIndex } from './launch-progress'
import { MatrixOwnerDeviceRepairNotice } from './owner-device-repair-notice'
import { matrixReadinessCopy } from './readiness-copy'
import { useSecurityCopy } from './security-copy'
import { RecoveryKeyPanel } from './security-panel'
import { MatrixSignOutConfirm } from './sign-out'
import { SubscriptionConnectDialog } from './subscriptions'

/** A gate blocked this long adds the connection hint (plan 2026-09-26-reliable-local-first-chat §4.5). */
export const MATRIX_STARTUP_HELP_AFTER_MS = 2 * 60_000
/** The finale once the window can open with everything ready: the ring flashes, then the mark flies home. */
const LIT_MS = 550
const LEAVE_MS = 800
const REDUCED_LEAVE_MS = 300
/** The shell appears only after the eclipse has landed, through one bounded cross-fade. */
export const MATRIX_LAUNCH_REVEAL_MS = 300
/** A step still running this long says so, then that it can take a minute (the spec's 5 s). */
const STILL_AFTER_MS = 5_000
const LONG_AFTER_MS = 30_000
/**
 * The eclipse stays on screen at least this long once it is drawn, so the motion reads as
 * designed: every electron rides one full orbit (the slowest ring takes 2.55 s) and the
 * first check lands on the corona before the mark flies home. The window still opens no
 * sooner than the person's chats, account step, and first roster read allow. An assistant
 * starting normally gets this brief wait; its stops and retries belong to its row/chat.
 */
export const MATRIX_LAUNCH_HOLD_MS = 2_600
/** Without motion there is nothing to watch: a short, calm moment, then a cross-fade. */
const REDUCED_HOLD_MS = 900
/** Wider than the compact sign-in window (460): the product window is up. */
const PRODUCT_WIDTH_PX = 600
/** A window that cannot grow (a small display, a refused resize) still gets its launch. */
const REVEAL_FALLBACK_MS = 700

/**
 * The account steps a launch can stop on: the Atum account connection (`connect`) or this
 * Mac's recovery key (`recovery`). They are drawn on the launch, in the product window like
 * the rest of it (window-mode.ts). A failed check of the assistant's own device
 * (`agent_trust_failed`) is not one: it waits in the assistant's chat with Try again
 * (launch-notice.tsx).
 */
export function matrixLaunchAccountStep(snapshot: MatrixSnapshot): 'connect' | 'recovery' | null {
  if (!snapshot.identity) {
    return null
  }

  const readiness = snapshot.readiness

  if (readiness) {
    if (readiness.phase !== 'blocked') {
      return null
    }

    return readiness.code === 'action_required' ? 'connect' : readiness.code === 'recovery_required' ? 'recovery' : null
  }

  return snapshot.state === 'ready' && snapshot.startup?.state === 'action_required' ? 'connect' : null
}

/**
 * The person's own chats are usable: the readiness gate has passed its first step, which
 * waits for this account's chats (the SDK cache or its first sync, electron/matrix/main.ts
 * `createReadiness`). Everything after it is the assistant's.
 */
export function matrixChatReady(snapshot: MatrixSnapshot): boolean {
  const readiness = snapshot.readiness

  // A session still connecting has nothing to show yet, whatever the gate last said.
  if (!snapshot.identity || snapshot.state === 'connecting') {
    return false
  }

  // Builds without the readiness gate: a ready account is a synced one.
  if (!readiness) {
    return snapshot.state === 'ready'
  }

  return (
    readiness.phase === 'ready' || readiness.phase === 'degraded' || (readiness.step ?? 'signed_in') !== 'signed_in'
  )
}

/** Errors that end the account's session rather than its connection; they keep their own handling. */
const SESSION_ENDED = new Set(['matrix_signed_out', 'matrix_sign_out_pending'])

/** This Mac's own chat engine did not start, or stopped (also when the disk is too full to save
 * its sign-in, `matrix_disk_full`): not a network problem. */
export const MATRIX_ENGINE_ERRORS: ReadonlySet<string> = new Set([
  'matrix_sdk_start_failed',
  'matrix_sdk_stopped',
  'matrix_disk_full'
])

/**
 * A saved account whose chats can't be reached at all: its session is in error (its chat
 * engine did not start, or stopped) before the chats were ever ready. That is not a reason
 * to sign in again, so the launch says so with Try again (a new session, `retry`) and the
 * quiet way out, in the product window. A session that was revoked keeps its own notice.
 */
export function matrixLaunchUnreachable(snapshot: MatrixSnapshot): boolean {
  return (
    Boolean(snapshot.identity) &&
    snapshot.state === 'error' &&
    !SESSION_ENDED.has(snapshot.error ?? '') &&
    !matrixChatReady(snapshot)
  )
}

/**
 * What the launch reads for one agent. A cloud-only assistant never ran local setup, so its
 * local readiness was skipped on purpose (main.ts `isCloudOnlyAgent`): the cloud answers it,
 * and a missing or stale local row must not read as "still preparing" or "setup failed".
 * A policy-backed standby (`macRole`) keeps its local readiness: that Mac runs it.
 */
export function matrixLaunchAgentReadiness(agent: MatrixAgentView, since = 0): MatrixReadiness | undefined {
  return matrixAgentAnswersInCloud(agent) ? { phase: 'ready', since: agent.readiness?.since ?? since } : agent.readiness
}

/** One launch subject: the authoritative roster itself, or one named agent on it. */
export interface MatrixLaunchPreparation {
  agent?: MatrixAgentView
  readiness: MatrixReadiness
  roster?: true
}

/** Every rostered assistant holds the launch only while it is still starting normally (shared
 * `matrixAgentHoldsLaunch`): one that stops shows that on its own row/chat and keeps retrying in
 * the background. Missing readiness after the authoritative roster arrives is still preparation,
 * never silently interpreted as an empty/finished agent. */
export function matrixLaunchAgents(snapshot: MatrixSnapshot): MatrixLaunchPreparation[] {
  // Roster authority belongs to the ready Matrix session. While sign-in or chat sync is
  // still connecting, let that earlier launch step speak for itself instead of presenting
  // an invented "assistant is starting" wait before the roster can exist.
  if (!matrixChatReady(snapshot)) {
    return []
  }

  const roster = snapshot.agentRoster

  // A current host always publishes an explicit roster read. Until that first read arrives,
  // the roster is unknown rather than empty; opening here recreates the cold-start race this
  // screen is responsible for making visible.
  if (!roster) {
    return [
      {
        readiness: {
          phase: 'starting',
          step: 'assistant',
          since: snapshot.readiness?.since ?? 0
        },
        roster: true
      }
    ]
  }

  if (roster.state === 'loading') {
    return [
      {
        readiness: { phase: 'starting', step: 'assistant', since: roster.since },
        roster: true
      }
    ]
  }

  // A failed read is an assistant/roster problem, not a reason to hold the app. The existing
  // refresh keeps trying in the background and the shell can render the cache it has.
  if (roster.state !== 'ready') {
    return []
  }

  if (snapshot.agents?.length) {
    return snapshot.agents.flatMap(agent => {
      const readiness =
        matrixLaunchAgentReadiness(agent, roster.since) ??
        ({ phase: 'starting', step: 'assistant', since: roster.since } satisfies MatrixReadiness)

      return matrixAgentHoldsLaunch({ readiness }) ? [{ agent, readiness }] : []
    })
  }

  return snapshot.readiness && matrixAgentHoldsLaunch({ readiness: snapshot.readiness })
    ? [{ readiness: snapshot.readiness }]
    : []
}

/** Prefer a stopped/timed-out agent over work still progressing, then preserve roster order. */
export function matrixLaunchPreparation(snapshot: MatrixSnapshot): MatrixLaunchPreparation | undefined {
  const preparations = matrixLaunchAgents(snapshot)

  return (
    preparations.find(({ readiness }) => readiness.phase === 'blocked' || readiness.phase === 'degraded') ??
    preparations[0]
  )
}

/** Cold start waits only for sign-in/chat sync, an account step, the first roster read, and the
 * brief normal-starting-assistant wait. Assistant, roster-refresh, and app-catalog trouble stays
 * inside the open app and keeps retrying in the background. */
/** The longest the launch waits on a normally starting assistant or the first roster read. A
 * step that never answers must not keep the window closed: after this the app opens and the
 * assistant's own row keeps showing that it is starting. */
export const MATRIX_LAUNCH_START_WAIT_MS = 20_000

/** `waitedMs`: how long this launch screen has been up (omitted means just shown). */
export function matrixStartupBlocking(snapshot: MatrixSnapshot, waitedMs = 0): boolean {
  if (!snapshot.identity || snapshot.state === 'signed_out' || snapshot.state === 'signing_in') {
    return false
  }

  if (snapshot.state === 'error') {
    return matrixLaunchUnreachable(snapshot)
  }

  const readiness = snapshot.readiness

  if (readiness) {
    return (
      !matrixChatReady(snapshot) ||
      matrixLaunchAccountStep(snapshot) !== null ||
      (Boolean(matrixLaunchPreparation(snapshot)) && waitedMs < MATRIX_LAUNCH_START_WAIT_MS)
    )
  }

  // Builds without the readiness gate: the older setup steps.
  if (snapshot.state === 'connecting') {
    return true
  }

  return (
    snapshot.state === 'ready' &&
    (matrixLaunchAccountStep(snapshot) !== null || Boolean(snapshot.domainEnabled && snapshot.startup?.state === 'working'))
  )
}

/** The flight from the hero's sun to the mark in the chat's header, when it is on screen. */
function measureFlight(hero: HTMLElement | null): LaunchFlight | undefined {
  const sun = hero?.querySelector<HTMLElement>('.atum-launch-sun')?.getBoundingClientRect()
  const mark = window.document.querySelector<HTMLElement>('[data-matrix-header-mark] > *')?.getBoundingClientRect()

  if (!sun?.width || !mark?.width) {
    return undefined
  }

  return {
    x: mark.left + mark.width / 2 - (sun.left + sun.width / 2),
    y: mark.top + mark.height / 2 - (sun.top + sun.height / 2),
    // The mark's disc is 57 of its 64 units.
    scale: (mark.width * 0.89) / sun.width
  }
}

/**
 * The account/chat way out of a launch that stops: send feedback or sign out (confirmed in
 * place). Feedback and the confirmation open here, because a sheet would sit under the launch.
 */
function LaunchWayOut({
  snapshot
}: {
  snapshot: MatrixSnapshot
}) {
  const words = useLaunchCopy()
  const services = useStore($matrixDesktopServices)
  const [panel, setPanel] = useState<'feedback' | 'sign-out' | null>(null)
  const opened = useRef<HTMLDivElement>(null)
  const feedback = Boolean(services?.reporting.configured && window.atumDesktopServices)

  // The launch scrolls rather than shrinking its hero: bring an opened panel into view.
  useEffect(() => {
    if (panel) {
      opened.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [panel])

  if (panel === 'sign-out') {
    return (
      <div className="atum-launch-way-panel" data-slot="matrix-startup-way-out" ref={opened}>
        <MatrixSignOutConfirm onCancel={() => setPanel(null)} snapshot={snapshot} />
      </div>
    )
  }

  if (panel === 'feedback') {
    return (
      <div className="atum-launch-way-panel" data-slot="matrix-startup-way-out" ref={opened}>
        <p className="text-(length:--atum-t-control) font-semibold text-(--atum-ink)">{words.feedback}</p>
        <MatrixFeedbackForm onClose={() => setPanel(null)} />
      </div>
    )
  }

  return (
    <div className="atum-launch-way-out" data-slot="matrix-startup-way-out">
      {feedback && (
        <Button onClick={() => setPanel('feedback')} size="sm" variant="text">
          {words.feedback}
        </Button>
      )}
      <Button onClick={() => setPanel('sign-out')} size="sm" variant="text">
        {words.signOut}
      </Button>
    </div>
  )
}

/**
 * The launch: the approved welcome motion ("Atum welcome motion" design artifact), drawn at
 * the product window's size after every sign-in and on every signed-in cold start. The
 * eclipse arrives once the window has its size, stays long enough for its motion to read
 * (MATRIX_LAUNCH_HOLD_MS) and for the complete agent roster to be ready, then flies home
 * into the mark in the chat's header. The five checks are still the five electrons; those
 * that pass settle on the corona. Nothing is faked: the bar never reaches 100 before every
 * assistant is ready, and the full "all passed" finale (the diamond ring's flash) plays only
 * when every check passed.
 *
 * A launch that stops keeps the hero where it was, lists the steps with the one that
 * stopped marked, says why in plain words, offers the one action that helps (Try again,
 * signing in again, the one-click Atum connection, or recovery) and, under it, feedback
 * and sign out for the genuine account/chat gates.
 */
export function MatrixStartupScreen({ onDone, snapshot }: { onDone: () => void; snapshot: MatrixSnapshot }) {
  // It covers the window for as long as it is mounted: native views step aside.
  useAppViewOverlayHold()
  const { locale, t } = useI18n()
  const shell = t.matrixShell
  const words = useLaunchCopy()
  const appCopy = useAppCopy()
  const securityCopy = useSecurityCopy()
  const stepCopy = useAccountStepCopy()
  const matrixCopy = useMatrixCopy()
  const reduce = useReducedMotion()
  const hero = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState(false)
  const [finale, setFinale] = useState<'lit' | 'leaving' | null>(null)
  const [revealing, setRevealing] = useState(false)
  const [gone, setGone] = useState(false)
  const [flight, setFlight] = useState<LaunchFlight>()
  // The live eclipse where the window can draw it (WebGL), the CSS hero elsewhere; each has its
  // own timing. A launch ready almost at once gets the eclipse's short finale.
  const [eclipse] = useState(launchEclipseSupported)
  const [brief, setBrief] = useState(false)
  const [planSignInOpen, setPlanSignInOpen] = useState(false)
  // When this launch screen first showed; the brief assistant wait is measured from here.
  const [shownAt] = useState(() => Date.now())
  const [clock, setClock] = useState(() => Date.now())
  const blocking = matrixStartupBlocking(snapshot, clock - shownAt)
  const chatReady = matrixChatReady(snapshot)
  const unreachable = matrixLaunchUnreachable(snapshot)
  const preparation = matrixLaunchPreparation(snapshot)
  const accountStep = matrixLaunchAccountStep(snapshot)
  // Once chats are ready, a stopped/degraded/waiting assistant is no longer launch copy. Its
  // row and chat own the plain-language reason and retry while launch finishes its brief motion.
  const readiness = preparation?.readiness ?? (!chatReady || accountStep ? snapshot.readiness : undefined)
  const preparingAgent = preparation?.agent

  // Every check passed (or, without the readiness gate, the older setup finished), and every
  // agent is ready: one left retrying in the background opens the window without the finale.
  const allPassed =
    !blocking &&
    !preparation &&
    snapshot.startup?.state !== 'failed' &&
    (!readiness || readiness.phase === 'ready') &&
    (snapshot.agents?.length
      ? snapshot.agents.every(agent => matrixLaunchAgentReadiness(agent)?.phase === 'ready')
      : !snapshot.readiness || snapshot.readiness.phase === 'ready')

  const passed = useRef(allPassed)

  // Nothing to wait for when the window first draws (a reload mid-session): open straight
  // to the chat. Every sign-in and cold start begins connecting, so it is shown.
  const [shown] = useState(blocking)
  const blocked = readiness?.phase === 'blocked' || readiness?.phase === 'degraded' ? readiness : undefined
  const recoveryRequired = readiness?.code === 'recovery_required'
  // Without an assistant (no readiness) only the old setup steps apply.
  const legacy = snapshot.state === 'ready' ? snapshot.startup : undefined

  const needsPerson =
    unreachable ||
    Boolean(blocked || readiness?.code || readiness?.retryAt) ||
    legacy?.state === 'action_required'

  const firstRunGettingReady = snapshot.firstRunWelcome === 'open' && !needsPerson

  const stepIndex = Math.min(launchStepIndex({ ...snapshot, readiness }), LAUNCH_STEPS.length)
  // While it waits or stops, on the running step; once the window may open, what really passed.
  const index = blocking ? Math.min(stepIndex, LAUNCH_STEPS.length - 1) : stepIndex
  // Main's `since` is the whole gate's start: each step keeps its own clock here.
  const [step, setStep] = useState(() => ({ index, at: Date.now() }))
  const [now, setNow] = useState(() => Date.now())
  const [floor, setFloor] = useState(0)

  // When the eclipse was first drawn at the product window's size: after a sign-in the window
  // grows out of the compact one first, and the launch is never drawn small.
  const [revealedAt, setRevealedAt] = useState<number | null>(() =>
    window.innerWidth >= PRODUCT_WIDTH_PX ? Date.now() : null
  )

  const [held, setHeld] = useState(false)
  const holdMs = reduce ? REDUCED_HOLD_MS : eclipse ? ECLIPSE_TIMING.holdMs : MATRIX_LAUNCH_HOLD_MS
  const opening = !blocking && held

  useEffect(() => {
    setStep(previous => (previous.index === index ? previous : { index, at: Date.now() }))
  }, [index])

  useEffect(() => {
    passed.current = allPassed
  }, [allPassed])

  useEffect(() => {
    if (revealedAt !== null) {
      return
    }

    const reveal = () => setRevealedAt(previous => previous ?? Date.now())

    const resized = () => {
      if (window.innerWidth >= PRODUCT_WIDTH_PX) {
        reveal()
      }
    }

    window.addEventListener('resize', resized)
    const fallback = window.setTimeout(reveal, REVEAL_FALLBACK_MS)

    return () => {
      window.removeEventListener('resize', resized)
      window.clearTimeout(fallback)
    }
  }, [revealedAt])

  useEffect(() => {
    if (held || revealedAt === null) {
      return
    }

    const id = window.setTimeout(() => setHeld(true), Math.max(0, revealedAt + holdMs - Date.now()))

    return () => window.clearTimeout(id)
  }, [held, holdMs, revealedAt])

  // The hold is for the motion to read, not a wait: once the chats are ready, a key or a click
  // skips the rest of it (a launch that needs the person keeps its controls instead).
  useEffect(() => {
    if (held || blocking || revealedAt === null) {
      return
    }

    const skip = (event: KeyboardEvent | PointerEvent) => {
      if ('key' in event && (event.isComposing || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key))) {
        return
      }

      setHeld(true)
    }

    window.addEventListener('keydown', skip)
    window.addEventListener('pointerdown', skip)

    return () => {
      window.removeEventListener('keydown', skip)
      window.removeEventListener('pointerdown', skip)
    }
  }, [blocking, held, revealedAt])

  useEffect(() => {
    if (finale) {
      return
    }

    const id = window.setInterval(() => {
      const at = Date.now()
      setNow(at)
      setClock(at)
    }, 500)

    return () => window.clearInterval(id)
  }, [finale])

  useEffect(() => {
    if (!shown) {
      onDone()

      return
    }

    if (!opening) {
      setFinale(null)
      setRevealing(false)

      return
    }

    const leaveThenReveal = (ms: number) => {
      let done = 0

      const landed = window.setTimeout(() => {
        // Keep the app covered throughout the flight. Only the completed landing starts the
        // shell reveal, and the overlay stays mounted until that cross-fade finishes.
        setRevealing(true)
        done = window.setTimeout(() => {
          setGone(true)
          onDone()
        }, MATRIX_LAUNCH_REVEAL_MS)
      }, ms)

      return () => {
        window.clearTimeout(landed)
        window.clearTimeout(done)
      }
    }

    if (reduce) {
      setFinale('leaving')

      return leaveThenReveal(REDUCED_LEAVE_MS)
    }

    // A failed assistant or deferred retry releases the window without claiming
    // that every check passed.
    const short = eclipse && revealedAt !== null && Date.now() - revealedAt < ECLIPSE_TIMING.briefBeforeMs
    const litMs = eclipse ? eclipseFinaleMs(LAUNCH_ECLIPSE_DIRECTION, short) : LIT_MS
    const leaveMs = eclipse ? eclipseFlightMs(short) : LEAVE_MS
    setBrief(short)

    if (!passed.current) {
      setFlight(measureFlight(hero.current))
      setFinale('leaving')

      return leaveThenReveal(leaveMs)
    }

    setFinale('lit')

    const fly = window.setTimeout(() => {
      setFlight(measureFlight(hero.current))
      setFinale('leaving')
    }, litMs)

    const done = leaveThenReveal(litMs + leaveMs)

    return () => {
      window.clearTimeout(fly)
      done()
    }
    // revealedAt is read once, as the finale starts; it never restarts the finale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eclipse, onDone, opening, reduce, shown])

  const elapsed = step.index === index ? Math.max(0, now - step.at) : 0
  // The bar fills with the chats (launchGatePercent) and with the eclipse's own moment, and
  // reads 100 only as the window opens. A gate that starts over (after a retry) holds its
  // highest point instead of running backwards, below 100.
  const shownFor = revealedAt === null ? 0 : Math.min(1, Math.max(0, now - revealedAt) / holdMs)
  const motionPercent = Math.floor(99 * shownFor)

  const chatPercent =
    blocking && preparation ? launchPercent(index, elapsed) : chatReady ? 99 : launchGatePercent(elapsed)

  const percent = finale
    ? 100
    : needsPerson
      ? floor
      : Math.min(99, Math.max(floor, Math.min(chatPercent, motionPercent)))

  useEffect(() => {
    const kept = Math.min(99, percent)

    if (kept > floor) {
      setFloor(kept)
    }
  }, [floor, percent])

  if (!shown || gone) {
    return null
  }

  const copy = unreachable
    ? MATRIX_ENGINE_ERRORS.has(snapshot.error ?? '')
      ? {
          title: words.engineTitle,
          help: snapshot.error === 'matrix_disk_full' ? words.diskFullHelp : words.engineHelp,
          action: 'retry' as const
        }
      : { title: words.unreachableTitle, help: words.unreachableHelp, action: 'retry' as const }
    : readiness
      ? matrixReadinessCopy(readiness, snapshot.startup, { ...shell, ...words }, shell.startupSignedIn, locale)
      : {
          title: !legacy
            ? shell.startupSignedIn
            : legacy.state === 'action_required'
              ? shell.startupConnectTitle
              : legacy.state === 'failed'
                ? legacy.step === 'model'
                  ? shell.startupModelFailed
                  : shell.startupAssistantFailed
                : legacy.step === 'model'
                  ? shell.startupModel
                  : shell.startupAssistant,
          help: legacy?.state === 'failed' ? shell.startupFailedHelp : undefined,
          action:
            legacy?.state === 'action_required'
              ? ('connect' as const)
              : legacy?.state === 'failed'
                ? ('retry' as const)
                : undefined
        }

  // The recovery step asks for one thing, by what the account already has on the server.
  const storage = snapshot.security?.storage
  const intent = storage === 'present' ? 'restore' : storage === 'absent' ? 'create' : undefined

  const baseTitle = recoveryRequired
    ? intent === 'restore'
      ? stepCopy.unlockTitle
      : intent === 'create'
        ? stepCopy.setUpTitle
        : securityCopy.agentRecoveryTitle
    : preparation?.roster && (!snapshot.agentRoster || snapshot.agentRoster.state === 'loading')
      ? words.loadingAgents
      : snapshot.apps?.state === 'loading' && chatReady && !preparation
        ? appCopy.loading
        : copy.title

  const preparingName = preparingAgent?.name?.trim() || (preparingAgent?.isDefault ? shell.assistantName : '')
  const title = preparingName ? words.agentStatus(preparingName, baseTitle) : baseTitle

  const help = recoveryRequired
    ? intent === 'restore'
      ? stepCopy.unlockHelp
      : intent === 'create'
        ? stepCopy.setUpHelp
        : copy.help
    : copy.help

  const longWait = Boolean(blocked && copy.action === 'retry' && now - blocked.since >= MATRIX_STARTUP_HELP_AFTER_MS)
  const phase: LaunchPhase = finale ?? (needsPerson ? 'blocked' : 'checking')
  const connecting = pending && copy.action === 'connect'

  // What each check is doing while it runs, and the stream's line once it has passed.
  const labels = [
    shell.startupSignedIn,
    snapshot.startup?.step === 'model' ? shell.startupModel : shell.startupAssistant,
    shell.startupHermes,
    shell.startupAi,
    shell.startupAuthority
  ]

  const passedLines = [
    shell.launchDoneSignedIn,
    shell.launchDoneAssistant,
    shell.launchDoneWorkspace,
    shell.launchDoneAi,
    shell.launchDoneAccount
  ]

  const agentRows = (snapshot.agents ?? []).map((agent, position) => {
    // Another agent's own trust step is its business, retried in the background: its row says it
    // is still being set up, never the security wording (0.19.4). A cloud-only agent reads ready.
    const launchReadiness = matrixLaunchAgentReadiness(agent, snapshot.agentRoster?.since ?? 0)
    const agentReadiness =
      !agent.isDefault && launchReadiness?.code === 'agent_trust_failed'
        ? { ...launchReadiness, code: 'agent_initializing' }
        : launchReadiness
    const name = agent.name?.trim() || (agent.isDefault ? shell.assistantName : agent.userId)
    const ready = agentReadiness?.phase === 'ready'
    const failed = agentReadiness?.phase === 'blocked' || agentReadiness?.phase === 'degraded'
    const status = agentReadiness
      ? ready
        ? words.agentReady
        : matrixReadinessCopy(
            agentReadiness,
            agent.isDefault ? snapshot.startup : undefined,
            { ...shell, ...words },
            shell.startupSignedIn,
            locale
          ).title
      : shell.startupAssistant
    const seconds = agentReadiness ? Math.max(0, Math.floor((now - agentReadiness.since) / 1_000)) : 0

    return (
      <li data-state={ready ? 'done' : failed ? 'failed' : 'current'} key={agent.principal || position}>
        <span aria-hidden className="atum-launch-agent-glyph">
          {ready ? <Check className="size-3" strokeWidth={2.4} /> : failed ? <X className="size-3" /> : <i />}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <strong>{name}</strong>
          <span>{status}</span>
        </span>
        {!ready && <time>{words.agentElapsed(seconds)}</time>}
      </li>
    )
  })

  const agentProgress = agentRows.length ? (
    <ol aria-label={words.loadingAgents} className="atum-launch-agents" data-slot="matrix-startup-agents">
      {agentRows}
    </ol>
  ) : null

  const act = () => {
    if (!copy.action) {
      return
    }

    // A plan sign-in is account-scoped and its compact flow starts a short-lived Hermes of its
    // own. Opening it here is both actionable and independent of the assistant backend that just
    // failed readiness; retrying that backend cannot repair an expired ChatGPT session.
    if (copy.action === 'plan_sign_in') {
      setPlanSignInOpen(true)

      return
    }

    setPending(true)
    // A session that never started is started over; every other stop has its own action.
    const request = unreachable
      ? window.atumMatrix.retry()
      : runMatrixReadinessAction(copy.action, snapshot, preparingAgent)

    void request.catch(() => {}).finally(() => setPending(false))
  }

  const actionLabel =
    copy.action === 'connect'
      ? shell.startupConnectAction
      : copy.action === 'top_up'
        ? words.topUp
        : copy.action === 'sign_in'
          ? words.signInAgain
          : copy.action === 'download'
            ? words.download
            : copy.action === 'plan_sign_in'
              ? words.planSignIn
              : shell.turnRetry

  // The steps so far, as the stream shows them; while stopped, the one that stopped is marked.
  const lines = labels.slice(0, index + 1).map((label, position) => {
    const state = position < index ? 'done' : needsPerson ? 'failed' : 'current'

    return (
      <li data-state={state} key={LAUNCH_STEPS[position]}>
        <span className="atum-launch-glyph">
          {state === 'done' ? (
            <Check className="size-3" strokeWidth={2.4} />
          ) : state === 'failed' ? (
            <X className="size-3" strokeWidth={2.4} />
          ) : (
            <i />
          )}
        </span>
        {state === 'done' ? passedLines[position] : label}
        {state === 'failed' && <span className="sr-only"> · {words.stepFailed}</span>}
      </li>
    )
  })

  return (
    // The launch is always night, whatever the window's appearance: its controls take
    // the dark tokens.
    <div className="dark">
      <div
        className="atum-shell atum-launch-stage fixed inset-0 z-[1200]"
        data-phase={phase}
        data-reduced={reduce || undefined}
        data-revealed={revealedAt !== null || undefined}
        data-revealing={revealing || undefined}
        data-slot="matrix-startup"
      >
        <div aria-hidden className="atum-launch-nun" />
        <div className="atum-launch-column">
          <div ref={hero}>
            {eclipse ? (
              <LaunchEclipse
                brief={brief}
                current={index}
                fallback={
                  <LaunchHero current={index} flight={flight} phase={phase} settled={Math.min(index, LAUNCH_STEPS.length)} />
                }
                phase={phase}
                reduced={reduce}
                settled={Math.min(index, LAUNCH_STEPS.length)}
              />
            ) : (
              <LaunchHero current={index} flight={flight} phase={phase} settled={Math.min(index, LAUNCH_STEPS.length)} />
            )}
          </div>
          {snapshot.deviceDamaged || snapshot.ownerDeviceRepair ? (
            <div className="atum-launch-card">
              <MatrixOwnerDeviceRepairNotice snapshot={snapshot} />
            </div>
          ) : needsPerson ? (
            <div className="atum-launch-blocked" data-slot="matrix-startup-action">
              <h1 className="atum-launch-title">{title}</h1>
              {help && <p className="atum-launch-help">{help}</p>}
              {longWait && (
                <p className="atum-launch-help" data-slot="matrix-startup-help">
                  {shell.readinessHelp}
                </p>
              )}
              {/* The one thing to do comes straight after why, then the quiet way out: the hero keeps
                  its place and everything under it grows downward, so what the checks found (below)
                  is the part that may run past the window's foot, never the button. */}
              {recoveryRequired && snapshot.identity ? (
                <div className="atum-launch-card">
                  <RecoveryKeyPanel
                    intent={intent}
                    key={`${snapshot.identity.userId}:${snapshot.identity.deviceId}`}
                    launch
                    snapshot={snapshot}
                  />
                </div>
              ) : (
                // Recovery resumes the launch by itself: its own panel is the one action.
                copy.action && (
                  <Button
                    aria-busy={connecting || undefined}
                    className="atum-launch-action mt-1"
                    disabled={pending}
                    onClick={act}
                  >
                    {connecting ? matrixCopy.signingIn : actionLabel}
                  </Button>
                )
              )}
              {connecting ? (
                <Button onClick={() => void window.atumMatrix.cancelDomain().catch(() => {})} size="sm" variant="text">
                  {matrixCopy.cancel}
                </Button>
              ) : (
                <LaunchWayOut snapshot={snapshot} />
              )}
              {agentProgress}
              {/* A session that never started has no step to point at ("signing you in" would
                  contradict "you're still signed in"): the sentence says it all. */}
              {!recoveryRequired && !unreachable && (
                <ol aria-label={shell.launchProgress} className="atum-launch-lines" data-slot="matrix-startup-steps">
                  {lines}
                </ol>
              )}
            </div>
          ) : firstRunGettingReady ? (
            <div className="atum-launch-stream" data-matrix-first-run-getting-ready>
              <p aria-live="polite" className="atum-launch-still" role="status">
                {matrixFirstRunCopy(locale).gettingReady}
              </p>
            </div>
          ) : eclipse ? (
            // The live eclipse shows the checks itself (a bead on the moon's edge for each): under
            // it, one quiet line (Atum Kit board, Getting ready), with no percentage or checklist.
            // The progress stays readable to assistive tech.
            <div className="atum-launch-stream" data-matrix-launch-quiet data-slot="matrix-startup-stream">
              <p aria-live="polite" className="atum-launch-still" role="status">
                {phase === 'checking' && elapsed >= LONG_AFTER_MS
                  ? shell.launchLong
                  : phase === 'checking' && elapsed >= STILL_AFTER_MS
                    ? shell.launchStill
                    : matrixFirstRunCopy(locale).gettingReady}
              </p>
              <div
                aria-label={shell.launchProgress}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={percent}
                className="sr-only"
                role="progressbar"
              />
            </div>
          ) : (
            <div className="atum-launch-stream" data-slot="matrix-startup-stream">
              <div className="atum-launch-meter">
                <div
                  aria-label={shell.launchProgress}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={percent}
                  className="atum-launch-bar"
                  role="progressbar"
                >
                  <i style={{ transform: `scaleX(${percent / 100})` }} />
                </div>
                <span aria-hidden className="atum-launch-percent">
                  {percent}%
                </span>
              </div>
              {agentProgress}
              <ol aria-hidden className="atum-launch-lines">
                {lines}
              </ol>
              {phase === 'checking' && elapsed >= STILL_AFTER_MS && (
                <p aria-hidden className="atum-launch-still">
                  {elapsed >= LONG_AFTER_MS ? shell.launchLong : shell.launchStill}
                </p>
              )}
            </div>
          )}
        </div>
        {blocking && !firstRunGettingReady && (
          <p aria-live="polite" className="sr-only" role="status">
            {title}
          </p>
        )}
      </div>
      <SubscriptionConnectDialog
        onClose={() => setPlanSignInOpen(false)}
        onConnected={() => {
          setPlanSignInOpen(false)
          void window.atumMatrix.retryReadiness().catch(() => undefined)
        }}
        open={planSignInOpen}
        provider="openai-codex"
      />
    </div>
  )
}
