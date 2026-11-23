import { atom } from 'nanostores'

import { setWorkActive } from '@/app/work/store'

import type { AccountConnectionsView, AccountPlan } from '../../../shared/account-connections'
import { parseAccountConnectionsView } from '../../../shared/account-connections'
import type { MatrixWorkBridge } from '../../../shared/matrix-work'

import { accountPlanRow } from './view'

/** The account's connections, one read for every feature. `undefined`: not read yet; `null`: nothing could answer here. */
export const $accountConnections = atom<AccountConnectionsView | null | undefined>(undefined)

/**
 * The one connect sheet, open for one plan. `allow`: the plan is connected already and only the account's consent is missing (the
 * same sheet, its one sentence is the whole step).
 */
export interface AccountConnectRequest {
  plan: AccountPlan
  mode?: 'connect' | 'allow'
}

export const $accountConnect = atom<AccountConnectRequest | null>(null)

/** After Continue: what the Work title band says until the plan is connected on this Mac. */
export interface AccountConnectProgress {
  plan: AccountPlan
  phase: 'signing_in' | 'done' | 'failed'
}

export const $accountConnectProgress = atom<AccountConnectProgress | null>(null)

export type ConnectionsBridge = Pick<MatrixWorkBridge, 'openPlanConnect' | 'readPlanConsent' | 'setPlan' | 'setPlanConsent'> &
  Partial<Pick<MatrixWorkBridge, 'readConnections'>>

function workBridge(): ConnectionsBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.atumMatrix?.work
}

let reading: Promise<AccountConnectionsView | null> | undefined

/** Read the account's connections once (concurrent callers share it). A failed read keeps the last good one. */
export function loadAccountConnections(bridge: Partial<Pick<MatrixWorkBridge, 'readConnections'>> | undefined = workBridge()) {
  if (!bridge?.readConnections) {
    if ($accountConnections.get() === undefined) {
      $accountConnections.set(null)
    }

    return Promise.resolve($accountConnections.get() ?? null)
  }

  reading ??= bridge
    .readConnections()
    .then(
      value => {
        const view = value === null ? null : parseAccountConnectionsView(value)

        if (view || $accountConnections.get() === undefined) {
          $accountConnections.set(view)
        }

        return $accountConnections.get() ?? null
      },
      () => {
        if ($accountConnections.get() === undefined) {
          $accountConnections.set(null)
        }

        return $accountConnections.get() ?? null
      }
    )
    .finally(() => {
      reading = undefined
    })

  return reading
}

/** Every Connect in Atum lands here: Settings, the picker's rail and its greyed rows, the assistant card, onboarding. */
export function openAccountConnect(plan: AccountPlan, mode: AccountConnectRequest['mode'] = 'connect'): void {
  $accountConnect.set({ plan, mode })
}

export function closeAccountConnect(): void {
  $accountConnect.set(null)
}

/**
 * Q1 (owner 11-23): connecting a plan is the consent for every assistant of the account, through this Mac. The platform's record
 * still names assistants and Macs (C5 makes "all" a value), so this names every assistant Work knows and this Mac, scheduled work
 * included (Q2), then turns this Mac's switch on. Best effort: a failure here never blocks the plan, which still works in Work, and
 * a cloud turn that cannot use it answers on Nguyệt Thực.
 */
export async function grantAccountPlanUse(bridge: ConnectionsBridge, plan: AccountPlan): Promise<void> {
  try {
    const consent = await bridge.readPlanConsent(plan)
    const thisMac = consent.macs.find(mac => mac.thisMac)
    const agents = [...new Set([...(consent.state === 'on' ? consent.agents : []), ...consent.eligible])]

    if (!thisMac || agents.length === 0) {
      return
    }

    const macs = [...new Set([...(consent.state === 'on' ? consent.macs.filter(mac => mac.named).map(mac => mac.id) : []), thisMac.id])]

    await bridge.setPlanConsent({ agents, macs, alsoWhenScheduled: true }, plan)
    await bridge.setPlan(true)
  } catch {
    // The per-Mac switch in Connections still turns it on by hand.
  }
}

export const ACCOUNT_CONNECT_POLL_MS = 3_000
export const ACCOUNT_CONNECT_WAIT_MS = 10 * 60_000
export const ACCOUNT_CONNECT_DONE_MS = 2_500

let watch: { stop(): void } | undefined

function connectedHere(view: AccountConnectionsView | null | undefined, plan: AccountPlan): boolean {
  return accountPlanRow(view, plan).here
}

/**
 * Continue on the sheet. `allow`: record the consent and finish. `connect`: show Work on T3's own sign-in screen for the plan (the
 * maker's own page; Atum never sees the login), then follow the account read until this Mac reports the plan connected.
 */
export async function continueAccountConnect(
  request: AccountConnectRequest,
  bridge: ConnectionsBridge | undefined = workBridge()
): Promise<void> {
  closeAccountConnect()
  watch?.stop()

  if (!bridge) {
    return
  }

  if (request.mode === 'allow') {
    await grantAccountPlanUse(bridge, request.plan)
    finish(request.plan, 'done')

    return
  }

  $accountConnectProgress.set({ plan: request.plan, phase: 'signing_in' })
  setWorkActive(true)

  try {
    await bridge.openPlanConnect(request.plan)
  } catch {
    finish(request.plan, 'failed')

    return
  }

  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const current = { stop: () => { stopped = true; clearTimeout(timer) } }
  watch = current

  const check = async () => {
    const view = await loadAccountConnections(bridge)

    if (stopped) {
      return
    }

    if (connectedHere(view, request.plan)) {
      current.stop()
      await grantAccountPlanUse(bridge, request.plan)
      finish(request.plan, 'done')

      return
    }

    if (Date.now() - started >= ACCOUNT_CONNECT_WAIT_MS) {
      current.stop()
      finish(request.plan, 'failed')

      return
    }

    timer = setTimeout(() => void check(), ACCOUNT_CONNECT_POLL_MS)
  }

  timer = setTimeout(() => void check(), ACCOUNT_CONNECT_POLL_MS)
}

function finish(plan: AccountPlan, phase: 'done' | 'failed'): void {
  $accountConnectProgress.set({ plan, phase })

  if (phase === 'done') {
    setTimeout(() => {
      const now = $accountConnectProgress.get()

      if (now?.plan === plan && now.phase === 'done') {
        $accountConnectProgress.set(null)
      }
    }, ACCOUNT_CONNECT_DONE_MS)
  }
}

export function dismissAccountConnectProgress(): void {
  watch?.stop()
  $accountConnectProgress.set(null)
}

/** Tests only: forget the in-flight read and the watcher. */
export function resetAccountConnectionsForTest(): void {
  watch?.stop()
  watch = undefined
  reading = undefined
  $accountConnections.set(undefined)
  $accountConnect.set(null)
  $accountConnectProgress.set(null)
}
