import type { MatrixProviderOAuthResult } from '../../shared/matrix-provider-settings'

import { matrixHermesHome, type MatrixHermesRuntimeConfig } from './hermes-runtime'
import {
  matrixSubscriptionRequestStatus,
  type MatrixSubscriptionStatusClass
} from './subscription-auth-lifecycle'

/** Account management needs the signed-in account and installed runtime, never an assistant. */
export function matrixSubscriptionAccountAvailable(input: {
  owner: boolean
  runtime: boolean
  identity: boolean
  closing: boolean
  accountReady: boolean
}): boolean {
  return (
    input.owner &&
    input.runtime &&
    input.identity &&
    !input.closing &&
    input.accountReady
  )
}

export const MATRIX_SUBSCRIPTION_HOST_EXECUTOR = 'account-subscriptions'

export function matrixSubscriptionHostExecutor(accountKey: string): string {
  return `${MATRIX_SUBSCRIPTION_HOST_EXECUTOR}:${accountKey}`
}

/**
 * The short-lived credential helper's own Hermes home. It is stable for the Atum account but
 * cannot equal any assistant home: the account key is part of a dedicated executor identity.
 * ChatGPT tokens still go to `matrixAccountCodexScope` through `openMatrixHermes`; this home only
 * holds the helper's non-secret provider configuration and process scratch state.
 */
export function matrixSubscriptionHostHome(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles'>,
  owner: string,
  accountKey: string
): string {
  return matrixHermesHome(config, owner, matrixSubscriptionHostExecutor(accountKey))
}

/** A browser sign-in owns the account-management Hermes until its terminal poll. */
export function updateMatrixSubscriptionSignIn(host: { signIns: number }, active: boolean): boolean {
  host.signIns = Math.max(0, host.signIns + (active ? 1 : -1))

  return !active && host.signIns === 0
}

/**
 * The model check and the account sign-in share one account-scoped auth store. An active sign-in
 * always wins: it is pending, never evidence that the person's plan is signed out. Cloud compute
 * access is evaluated separately by the cloud controller, never by this local sign-in rule.
 */
export function matrixSubscriptionPlanSignInGate(input: {
  signIns: number
  planSignIn: boolean
}): 'pending' | 'required' | undefined {
  return input.signIns > 0 ? 'pending' : input.planSignIn ? 'required' : undefined
}

export type MatrixSubscriptionFollowUpStage = 'agent_refresh'
export type MatrixSubscriptionFollowUpStatus = MatrixSubscriptionStatusClass | 'unavailable'

export interface MatrixSubscriptionFollowUpResult {
  refresh: MatrixSubscriptionFollowUpStatus
}

interface MatrixSubscriptionFollowUpOptions {
  refresh(): Promise<void>
  outcome?(stage: MatrixSubscriptionFollowUpStage, status: MatrixSubscriptionFollowUpStatus): void
}

function reportMatrixSubscriptionFollowUp(
  outcome: MatrixSubscriptionFollowUpOptions['outcome'],
  stage: MatrixSubscriptionFollowUpStage,
  status: MatrixSubscriptionFollowUpStatus
): void {
  try {
    outcome?.(stage, status)
  } catch {
    /* Diagnostics never own execution. */
  }
}

/** Refresh idle assistants after the account plan is saved. Both outcomes are closed status classes:
 * credentials, response bodies, URLs and exception text never enter diagnostics. */
export async function completeMatrixSubscriptionChatGptFollowUp(
  options: MatrixSubscriptionFollowUpOptions
): Promise<MatrixSubscriptionFollowUpResult> {
  const refresh = await completeMatrixSubscriptionAgentRefresh(options)

  return { refresh }
}

async function completeMatrixSubscriptionAgentRefresh(
  options: MatrixSubscriptionFollowUpOptions
): Promise<MatrixSubscriptionFollowUpStatus> {
  const status = await options.refresh()
    .then<MatrixSubscriptionFollowUpStatus>(() => 'ok')
    .catch(error => matrixSubscriptionRequestStatus(error))

  reportMatrixSubscriptionFollowUp(options.outcome, 'agent_refresh', status)

  return status
}

type MatrixSubscriptionRetrySchedule = (run: () => void, delayMs: number) => () => void

function scheduleMatrixSubscriptionRetry(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)

  return () => clearTimeout(timer)
}

/** One account-scoped repair flight. The first attempt is awaitable; failed refresh schedules a bounded retry in the background. A foreground Settings retry pulls the
 * next attempt forward instead of creating a second flight. */
export class MatrixSubscriptionFollowUpRepair {
  private cancelScheduled?: () => void
  private flight?: Promise<MatrixSubscriptionFollowUpResult>
  private refreshReady = false
  private retry = 0
  private stopped = false

  constructor(
    private readonly options: MatrixSubscriptionFollowUpOptions & {
      current(): boolean
      retryDelays?: readonly number[]
      schedule?: MatrixSubscriptionRetrySchedule
    }
  ) {}

  run(): Promise<MatrixSubscriptionFollowUpResult> {
    if (this.stopped || !this.options.current()) {
      return Promise.resolve({ refresh: 'cancelled' })
    }

    if (this.flight) {
      return this.flight
    }

    this.cancelScheduled?.()
    this.cancelScheduled = undefined

    const attempt = (async () => {
      const refresh = this.refreshReady
        ? 'ok' as const
        : await completeMatrixSubscriptionAgentRefresh(this.options)

      this.refreshReady ||= refresh === 'ok'

      return { refresh }
    })()

    this.flight = attempt

    void attempt.then(result => {
      if (this.flight === attempt) {
        this.flight = undefined
      }

      if (result.refresh === 'ok') {
        this.retry = 0
        this.refreshReady = false

        return
      }

      const delays = this.options.retryDelays ?? [5_000, 30_000, 120_000]
      const delay = delays[this.retry]

      if (delay === undefined || this.stopped || !this.options.current()) {
        this.retry = 0
        this.refreshReady = false

        return
      }

      this.retry += 1
      const schedule = this.options.schedule ?? scheduleMatrixSubscriptionRetry
      this.cancelScheduled = schedule(() => {
        this.cancelScheduled = undefined
        void this.run()
      }, delay)
    })

    return attempt
  }

  stop(): void {
    this.stopped = true
    this.refreshReady = false
    this.cancelScheduled?.()
    this.cancelScheduled = undefined
  }
}

/** A durable OAuth save remains connected when the best-effort agent refresh fails. */
export async function finishMatrixSubscriptionChatGptPoll(
  result: MatrixProviderOAuthResult,
  options: {
    complete(): Promise<MatrixSubscriptionFollowUpResult>
  }
): Promise<{ status: 'pending' | 'connected' | 'cancelled' | 'failed' }> {
  if (result.status === 'pending') {
    return { status: 'pending' }
  }

  if (result.status === 'cancelled') {
    return { status: 'cancelled' }
  }

  if (result.status !== 'approved') {
    return { status: 'failed' }
  }

  await options.complete().catch(() => undefined)

  return { status: 'connected' }
}
