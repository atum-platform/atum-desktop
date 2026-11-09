import { useEffect, useRef } from 'react'

import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixAliasBridge, MatrixAliasErrorCode } from '../../shared/matrix-aliases'
import type { MatrixHandleBackfillDiagnostic } from '../../shared/matrix-handle-diagnostic'

import { claimMatrixAgentHandle, type MatrixAgentHandleRefusal, matrixAgentHandleRetryable } from './agent-handle-claim'
import { matrixAgentHandleCandidates } from './handle-rules'
import { rememberAgentHandle } from './person-handles'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */

/** The first walk after launch waits for the window to settle. */
export const MATRIX_HANDLE_BACKFILL_START_MS = 8_000
/** After the roster changes (an assistant made or hired): room for the create sheet's own claim. */
export const MATRIX_HANDLE_BACKFILL_ROSTER_MS = 20_000
/** Between two assistants. */
export const MATRIX_HANDLE_BACKFILL_GAP_MS = 3_000
/** When the one retry a launch allows runs, if nothing else starts a walk sooner. */
export const MATRIX_HANDLE_BACKFILL_RETRY_MS = 60_000

/** One try, and the one retry. */
const MAX_ATTEMPTS = 2

type BackfillAgent = Pick<MatrixAgentView, 'assistantId' | 'principal' | 'name' | 'userId'>

/** What this launch has done for one account's assistants. */
export interface MatrixHandleBackfillLedger {
  /** Assistants this launch is done with: given a handle, already holding one, or refused in a
   * way another try cannot change. */
  settled: Set<string>
  /** Tries so far, per assistant. */
  attempts: Map<string, number>
  /** The directory's limit: no more walks this launch. */
  stopped: boolean
  /** A walk is running (one at a time, whatever starts it). */
  running: boolean
  /** The launch's first walk has run. */
  started: boolean
  /** The retry walk has been scheduled once. */
  retryScheduled: boolean
}

export function matrixHandleBackfillLedger(): MatrixHandleBackfillLedger {
  return {
    settled: new Set(),
    attempts: new Map(),
    stopped: false,
    running: false,
    started: false,
    retryScheduled: false
  }
}

/** Assistants whose handle the create sheet is claiming itself, and when it started: never raced
 * from here while the sheet's own claim can still be running. Time-bound, so a sheet whose claim
 * failed hands the assistant back to this walk instead of leaving it without a handle. */
const sheetClaims = new Map<string, number>()

/** How long a sheet's claim keeps this walk away from its assistant. */
export const MATRIX_HANDLE_SHEET_CLAIM_MS = 60_000

/** The create sheet calls this before it claims a new assistant's handle. */
export function noteMatrixAgentHandleSheetClaim(assistantId: string, now = Date.now()) {
  sheetClaims.set(assistantId, now)
}

function sheetClaiming(assistantId: string): boolean {
  const since = sheetClaims.get(assistantId)

  return since !== undefined && Date.now() - since < MATRIX_HANDLE_SHEET_CLAIM_MS
}

function open(ledger: MatrixHandleBackfillLedger, assistantId: string): boolean {
  return (
    !sheetClaiming(assistantId) &&
    !ledger.settled.has(assistantId) &&
    (ledger.attempts.get(assistantId) ?? 0) < MAX_ATTEMPTS
  )
}

export interface MatrixHandleBackfillInput {
  bridge: MatrixAliasBridge
  /** The owner's assistants as the window knows them now (read again before each one). */
  agents(): readonly BackfillAgent[]
  ledger: MatrixHandleBackfillLedger
  wait(ms: number): Promise<void>
  log(line: MatrixHandleBackfillDiagnostic): void
  /** False once the window, the account or the roster that started this walk is gone. */
  active(): boolean
  random?: () => number
}

/**
 * One walk over the assistants still without a handle. Returns whether one failed in a way the
 * launch's single retry may still change.
 */
export async function backfillMatrixAgentHandles({
  active,
  agents,
  bridge,
  ledger,
  log,
  random = Math.random,
  wait
}: MatrixHandleBackfillInput): Promise<{ retry: boolean }> {
  const visited = new Set<string>()
  let first = true

  const next = () =>
    agents().find(
      (agent): agent is BackfillAgent & { assistantId: string } =>
        Boolean(agent.assistantId) && !visited.has(agent.assistantId!) && open(ledger, agent.assistantId!)
    )

  for (let agent = next(); agent && !ledger.stopped && active(); agent = next()) {
    const id = agent.assistantId
    visited.add(id)

    if (!first) {
      await wait(MATRIX_HANDLE_BACKFILL_GAP_MS)

      // The sheet may have taken it, or the roster moved on, while this walk waited.
      if (!active() || ledger.stopped || !open(ledger, id)) {
        continue
      }
    }

    first = false
    const attempt = (ledger.attempts.get(id) ?? 0) + 1
    ledger.attempts.set(id, attempt)

    const line = (backfill: MatrixHandleBackfillDiagnostic['backfill'], code: MatrixHandleBackfillDiagnostic['code']) =>
      log({ backfill, agent: agent!.principal.slice(0, 8), code, attempt: attempt === 1 ? 1 : 2 })

    const failed = (reason: MatrixAgentHandleRefusal) => {
      if (reason === 'limit') {
        ledger.stopped = true
        line('limit', 'limit')
      } else if (!matrixAgentHandleRetryable({ ok: false, reason })) {
        ledger.settled.add(id)
        line('refused', reason)
      } else {
        line('failed', reason)
      }
    }

    // A change of the person's own handle whose answer was lost: replaying it is the person's
    // to do in Settings, never this walk's (the claim below would resend it first). The walk
    // stops here; the launch's one retry looks again, in case the person has settled it.
    const journal = await bridge
      .pending()
      .catch(() => ({ ok: false as const, error: 'unavailable' as MatrixAliasErrorCode }))

    if (!journal.ok) {
      // The directory itself did not answer: no handle was tried, so this assistant keeps its
      // attempts, and the walk stops here for the launch's retry instead of spending every
      // assistant's attempts on the same outage.
      if (journal.error === 'limit') {
        failed('limit')

        break
      }

      if (attempt > 1) {
        ledger.attempts.set(id, attempt - 1)
      } else {
        ledger.attempts.delete(id)
      }

      line('failed', journal.error)

      return { retry: !ledger.stopped }
    }

    if (journal.request && !journal.request.assistantId) {
      line('held', 'none')

      break
    }

    const outcome = await claimMatrixAgentHandle(bridge, id, matrixAgentHandleCandidates(agent.name, random)).catch(
      () => ({ ok: false as const, reason: 'unavailable' as const })
    )

    if (!outcome.ok) {
      failed(outcome.reason)

      continue
    }

    ledger.settled.add(id)

    if (outcome.existing) {
      line('kept', 'none')
    } else {
      rememberAgentHandle(agent.userId, outcome.handle, null)
      line('claimed', 'none')
    }
  }

  return {
    retry:
      !ledger.stopped &&
      agents().some(
        agent => agent.assistantId && open(ledger, agent.assistantId) && ledger.attempts.has(agent.assistantId)
      )
  }
}

/** Per account, for this window's life (one launch). */
const ledgers = new Map<string, MatrixHandleBackfillLedger>()

function ledgerFor(owner: string): MatrixHandleBackfillLedger {
  let ledger = ledgers.get(owner)

  if (!ledger) {
    ledger = matrixHandleBackfillLedger()
    ledgers.set(owner, ledger)
  }

  return ledger
}

function sendLine(bridge: MatrixAliasBridge, line: MatrixHandleBackfillDiagnostic) {
  try {
    bridge.diagnostic?.(line)
  } catch {
    // Diagnostics only.
  }
}

/**
 * Mounted once by the window: starts a walk a little after launch, and again whenever the
 * owner's assistants change (one made or hired), once the account, its directory and its
 * roster are ready.
 */
export function useMatrixAgentHandleBackfill(snapshot: MatrixSnapshot) {
  const owner = snapshot.identity?.userId
  // Read inside the effect: only whether there is a directory may restart the walk's timers.
  const directory = Boolean(window.atumMatrix?.aliases)

  const ready = Boolean(
    owner &&
    directory &&
    snapshot.state === 'ready' &&
    snapshot.domainEnabled &&
    snapshot.agentRoster?.state === 'ready'
  )

  // The primary assistant is left to the person: its usual stem ("atum") is reserved, so an
  // automatic claim would give it a fallback handle that a rename then locks for 30 days.
  const agents = snapshot.agents?.filter(agent => !agent.isDefault)
  const latest = useRef<readonly BackfillAgent[]>([])
  useEffect(() => {
    latest.current = agents ?? []
  }, [agents])

  const roster = (agents ?? [])
    .flatMap(agent => (agent.assistantId ? [agent.assistantId] : []))
    .sort()
    .join(',')

  useEffect(() => {
    const bridge = window.atumMatrix?.aliases

    if (!ready || !owner || !bridge || !roster) {
      return
    }

    const ledger = ledgerFor(owner)

    if (ledger.stopped) {
      return
    }

    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => void run(), ms)
    }

    const run = async () => {
      if (!live) {
        return
      }

      // An earlier walk is finishing its last request: start once it has.
      if (ledger.running) {
        schedule(MATRIX_HANDLE_BACKFILL_GAP_MS)

        return
      }

      ledger.running = true
      ledger.started = true

      try {
        const { retry } = await backfillMatrixAgentHandles({
          active: () => live,
          agents: () => latest.current,
          bridge,
          ledger,
          log: line => sendLine(bridge, line),
          wait: ms => new Promise(done => setTimeout(done, ms))
        })

        if (live && retry && !ledger.retryScheduled) {
          ledger.retryScheduled = true
          schedule(MATRIX_HANDLE_BACKFILL_RETRY_MS)
        }
      } finally {
        ledger.running = false
      }
    }

    schedule(ledger.started ? MATRIX_HANDLE_BACKFILL_ROSTER_MS : MATRIX_HANDLE_BACKFILL_START_MS)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [owner, ready, roster])
}
