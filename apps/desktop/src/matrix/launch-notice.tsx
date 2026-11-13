import { useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Info } from '@/lib/icons'

import type { MatrixSnapshot } from '../../shared/matrix'

import { matrixAgentAttention, useMatrixAttentionNow } from './agent-attention'
import { runMatrixReadinessAction } from './launch-actions'
import { useLaunchCopy } from './launch-copy'
import { LAUNCH_STEPS, launchPercent, launchStepIndex } from './launch-progress'
import { useModelPickerCopy } from './model-picker-copy'
import { matrixReadinessCopy, matrixSetupCooldown } from './readiness-copy'
import { useSecurityCopy } from './security-copy'
import { RecoveryKeyPanel } from './security-panel'
import { SubscriptionConnectDialog } from './subscriptions'

/** A step still running this long says it can take a minute (the launch's own timing). */
const LONG_AFTER_MS = 30_000

/**
 * What an assistant's readiness asks of its chat, if anything: still starting (the window
 * opened with the person's chats while the assistant wakes up), stopped with a reason and
 * the one action that helps, or paused while the watch sees trouble. A setup waiting out a
 * platform limit is said once for the whole window (app.tsx), so not here.
 */
export function matrixLaunchNoticeKind(
  readiness: MatrixSnapshot['readiness']
): 'starting' | 'blocked' | 'degraded' | null {
  if (!readiness || readiness.phase === 'ready' || matrixSetupCooldown(readiness) !== undefined) {
    return null
  }

  return readiness.phase
}

/** The running step's own clock and a bar that never runs backwards (the launch's rules). */
function useStepProgress(snapshot: MatrixSnapshot, active: boolean) {
  const index = Math.min(launchStepIndex(snapshot), LAUNCH_STEPS.length - 1)
  const [step, setStep] = useState(() => ({ index, at: Date.now() }))
  const [now, setNow] = useState(() => Date.now())
  const [floor, setFloor] = useState(0)

  useEffect(() => {
    setStep(previous => (previous.index === index ? previous : { index, at: Date.now() }))
  }, [index])

  useEffect(() => {
    if (!active) {
      return
    }

    const id = window.setInterval(() => setNow(Date.now()), 1_000)

    return () => window.clearInterval(id)
  }, [active])

  const elapsed = step.index === index ? Math.max(0, now - step.at) : 0
  const percent = Math.min(99, Math.max(floor, launchPercent(index, elapsed)))

  useEffect(() => {
    if (percent > floor) {
      setFloor(percent)
    }
  }, [floor, percent])

  return { elapsed, index, percent }
}

function ProgressLine({ label, percent }: { label: string; percent: number }) {
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className="mt-2 h-1 w-full max-w-64 overflow-hidden rounded-full bg-(--atum-line)"
      role="progressbar"
    >
      <i
        className="block h-full origin-left rounded-full bg-(--atum-ink-soft) transition-transform duration-700 motion-reduce:transition-none"
        style={{ transform: `scaleX(${percent / 100})` }}
      />
    </div>
  )
}

/**
 * The assistant's launch, in its own chat (or, with no chat open yet, in the main panel):
 * "Atum is getting ready…", the step it is on and a thin bar while it starts; once stopped,
 * the reason in plain words and the one action that helps; while paused, why sending is
 * paused. Withdrawn permission explains itself and offers nothing that cannot help.
 */
export function MatrixLaunchNotice({
  cloudOnly = true,
  fail,
  name,
  onBackToAtum,
  onOwnModel,
  onPlanSignIn,
  snapshot,
  variant = 'band'
}: {
  cloudOnly?: boolean
  fail?: () => void
  /** The assistant's name, as its chat shows it. */
  name: string
  /** Deliberately switches this assistant back to Atum's model through native main. */
  onBackToAtum?: () => Promise<unknown> | void
  /** A model of the person's own (Settings › Advanced), when Atum's AI is out of Protons. */
  onOwnModel?: () => void
  /** The compact account-level ChatGPT sign-in (`plan_sign_in`). */
  onPlanSignIn?: () => void
  /** The room's view of the snapshot (its agent's readiness: room-agent.ts). */
  snapshot: MatrixSnapshot
  /** `panel`: the main panel while no chat is open, instead of "No chat open"; `line`: the
   * same, quietly, under the assistant's first message on a first run (first-run-card.tsx). */
  variant?: 'band' | 'panel' | 'line'
}) {
  const { locale, t } = useI18n()
  const shell = t.matrixShell
  const words = useLaunchCopy()
  const modelWords = useModelPickerCopy()
  const securityCopy = useSecurityCopy()
  const readiness = snapshot.readiness
  const kind = matrixLaunchNoticeKind(readiness)
  const progress = useStepProgress(snapshot, kind === 'starting')
  const [pending, setPending] = useState(false)
  const [planSignInOpen, setPlanSignInOpen] = useState(false)
  const now = useMatrixAttentionNow(snapshot)

  if (!kind || !readiness) {
    return null
  }

  // In its chat, quiet while the app is still settling things by itself (agent-attention.ts): a
  // start says so only once it is slow, a passing outage only once it outlasts a launch. A cause
  // every agent shares is the title bar's indicator item, said once: the message box names it.
  const attention = matrixAgentAttention({ readiness, setup: snapshot.assistantSetup, listening: undefined }, now)

  // In its chat a start says nothing at all, however long: the agent is simply not answering
  // yet, as a person might not be, and the message box says you can write ahead. Only a stop
  // that needs the person shows here.
  if (variant === 'band' && (kind === 'starting' || !attention.chatLine || attention.waitsOn)) {
    return null
  }

  const copy = matrixReadinessCopy(readiness, snapshot.startup, { ...shell, ...words }, shell.startupSignedIn, locale)
  const withdrawn = readiness.code === 'authority_withdrawn'
  const recovery = kind === 'blocked' && readiness.code === 'recovery_required'
  const outOfProtons = copy.action === 'top_up'

  const act = () => {
    if (!copy.action) {
      return
    }

    if (copy.action === 'plan_sign_in') {
      if (onPlanSignIn) {
        onPlanSignIn()
      } else {
        setPlanSignInOpen(true)
      }

      return
    }

    setPending(true)
    void runMatrixReadinessAction(copy.action, snapshot)
      .catch(() => fail?.())
      .finally(() => setPending(false))
  }

  const backToAtum = () => {
    if (!onBackToAtum) {
      return
    }

    setPending(true)
    void Promise.resolve(onBackToAtum())
      .catch(() => fail?.())
      .finally(() => setPending(false))
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
            : copy.action === 'reconnect'
              ? words.reconnect
              : copy.action === 'sign_in_again'
                ? words.signInAgain
                : copy.action === 'plan_sign_in'
                  ? words.planSignIn
                  : shell.turnRetry

  const title = kind === 'starting' ? words.gettingReady(name) : recovery ? securityCopy.agentRecoveryTitle : copy.title

  // Starting: the step it is on (the copy's title is that step), then, for a long one, that
  // it can take a minute. Stopped or paused: the reason's own help, or that sending waits.
  const line =
    kind === 'starting'
      ? progress.elapsed >= LONG_AFTER_MS
        ? `${copy.title} ${shell.launchLong}`
        : copy.title
      : // Out of Protons says what a Proton is and why it ran out; every other pause says that sending waits.
        kind === 'degraded' && !withdrawn && !outOfProtons
        ? shell.readinessPaused
        : copy.help

  const storage = snapshot.security?.storage
  const intent = storage === 'present' ? 'restore' : storage === 'absent' ? 'create' : undefined

  const actions =
    kind === 'starting' || (withdrawn && !copy.action) || recovery ? null : (
      <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {copy.action && (
          <Button disabled={pending} onClick={act} size="sm" variant={variant === 'panel' ? 'default' : 'secondary'}>
            {actionLabel}
          </Button>
        )}
        {copy.action === 'plan_sign_in' && onBackToAtum && (
          <Button disabled={pending} onClick={backToAtum} size="sm" variant="text">
            {modelWords.backToAtum}
          </Button>
        )}
        {outOfProtons && onOwnModel && (
          <Button onClick={onOwnModel} size="sm" variant="text">
            {cloudOnly ? modelWords.useYourPlan : shell.protonsOwnModel}
          </Button>
        )}
      </span>
    )

  const body = (
    <>
      <p className="font-medium text-(--atum-ink)">{title}</p>
      {line && <p className="text-(--atum-ink-muted)">{line}</p>}
      {kind === 'starting' && (
        <>
          <ProgressLine label={words.gettingReady(name)} percent={progress.percent} />
        </>
      )}
      {recovery && snapshot.identity && (
        <div className="mt-2 max-w-md" data-matrix-launch-recovery>
          <RecoveryKeyPanel
            intent={intent}
            key={`${snapshot.identity.userId}:${snapshot.identity.deviceId}`}
            launch
            snapshot={snapshot}
          />
        </div>
      )}
      {actions}
      {planSignInOpen && (
        <SubscriptionConnectDialog
          onClose={() => setPlanSignInOpen(false)}
          onConnected={() => {
            setPlanSignInOpen(false)
            void window.atumMatrix.retryReadiness().catch(() => fail?.())
          }}
          open
          provider="openai-codex"
        />
      )}
    </>
  )

  if (variant === 'line') {
    return (
      <div
        className="mt-6 flex w-full max-w-xs flex-col items-center text-center text-(length:--atum-t-body)"
        data-matrix-launch-line={kind}
        role="status"
      >
        {body}
      </div>
    )
  }

  if (variant === 'panel') {
    return (
      <div
        className="m-auto flex max-w-sm flex-col items-center p-8 text-center text-(length:--atum-t-ui)"
        data-matrix-launch-panel={kind}
        role="status"
      >
        <BrandMark className="mb-4 size-10 rounded-[var(--atum-r-sidebar)]" />
        {body}
        {kind === 'starting' && <p className="mt-4 text-(--atum-ink-faint)">{words.gettingReadyPanel}</p>}
      </div>
    )
  }

  // Set in the conversation's own column, like the composer below it.
  return (
    <div className="shrink-0 px-4 pt-3">
      <div
        className="notice-band mx-auto w-full max-w-(--composer-width)"
        data-matrix-launch-notice={kind}
        data-tone="notice"
        role="status"
      >
        <Info aria-hidden className="mt-px size-4 shrink-0" />
        <div className="min-w-0">{body}</div>
      </div>
    </div>
  )
}
