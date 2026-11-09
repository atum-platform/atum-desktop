import { randomUUID } from 'node:crypto'

import {
  MATRIX_DAILY_CAP_NOTICE_JOB,
  MATRIX_DAILY_CAP_NOTICE_PROFILE,
  matrixDailyCapNoticeRunId,
  matrixDailyCapNoticeSince,
  parseMatrixDailyCapNotice
} from '../../shared/daily-cap-notice'
import type { DesktopLocale } from '../../shared/desktop-locale'
import type { MatrixSdkCommand, MatrixTurnLookup } from '../../shared/matrix'
import { matrixAgentStatusText } from '../../shared/matrix-agent-status-copy'

import { readDomainJson } from './domain'

const CHECK_INTERVAL_MS = 30_000
const EVENT = /^\$[!-~]+$/

/** The narrow agent facts this delivery needs; main passes its MatrixAgentRuntime. */
export interface MatrixDailyCapNoticeAgent {
  principal?: string
  agentPrincipal?: string
  userId?: string
}

export interface MatrixDailyCapNoticeDeps {
  /** One authenticated owner route call on the existing S1 domain authority. */
  claim(agentPrincipal: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  /** The agent's main conversation, resolved from the projected conversation marker. */
  mainRoom(agent: MatrixDailyCapNoticeAgent): string | undefined
  agentUserId(agent: MatrixDailyCapNoticeAgent): string | undefined
  command(agent: MatrixDailyCapNoticeAgent, command: MatrixSdkCommand): Promise<unknown>
  requireRoom(agent: MatrixDailyCapNoticeAgent, roomId: string): Promise<void>
  locale(agent: MatrixDailyCapNoticeAgent): DesktopLocale
  now?(): number
  log?(line: string): void
}

/** `POST /agents/{principal}/daily-cap-notice`, the MAS-authenticated owner route (0270). */
export async function requestMatrixDailyCapNotice(
  resource: string,
  accessToken: string,
  agentPrincipal: string,
  input: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const response = await fetch(`${resource}/agents/${encodeURIComponent(agentPrincipal)}/daily-cap-notice`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
    redirect: 'error',
    signal
  })
  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_daily_cap_notice_authentication')
  }
  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_daily_cap_notice_unavailable')
  }
  return readDomainJson(response, 4_096)
}

/**
 * The Mac's half of the 80% daily-cap notice: claim once, deliver one quiet line into the agent's
 * main chat, then acknowledge its Matrix event. The platform owns the claim; main owns the agent
 * session; no renderer and no model call participates.
 *
 * The delivered message is an `m.notice` from the agent's existing scheduled post (`publishCron`
 * with `notify:false`) under a deterministic run id. The platform grants only the first atomic
 * reservation for the day; a rival or a same-token replay gets no send grant, so no second device
 * publishes. `findTurn(marker=cron)` lets a runtime acknowledge an event it can already see without
 * sending. Delivery is best-effort at-most-one: a crash or a lost claim answer may miss the notice,
 * and Matrix transaction ids are device-scoped, never a cross-device exactly-once proof.
 */
export class MatrixDailyCapNotices {
  private readonly lastCheck = new Map<string, number>()
  private readonly inFlight = new Set<string>()

  constructor(private readonly options: MatrixDailyCapNoticeDeps) {}

  async check(agent: MatrixDailyCapNoticeAgent, reason = 'turn'): Promise<void> {
    const principal = agent.agentPrincipal ?? agent.principal
    if (!principal) {return}
    const now = this.now()
    if (this.inFlight.has(principal) || now - (this.lastCheck.get(principal) ?? -Infinity) < CHECK_INTERVAL_MS) {return}
    this.lastCheck.set(principal, now)
    this.inFlight.add(principal)
    try {
      await this.deliver(agent, principal, reason)
    } catch (error) {
      this.options.log?.(`[Matrix] daily_cap_notice reason=${reason} outcome=deferred code=${errorCode(error)}`)
    } finally {
      this.inFlight.delete(principal)
    }
  }

  private async deliver(agent: MatrixDailyCapNoticeAgent, principal: string, reason: string): Promise<void> {
    const o = this.options
    const roomId = o.mainRoom(agent)
    const agentUserId = o.agentUserId(agent)
    if (!roomId || !agentUserId) {
      o.log?.(`[Matrix] daily_cap_notice reason=${reason} outcome=deferred code=no_main_room`)
      return
    }
    const claimToken = randomUUID()
    const claim = parseMatrixDailyCapNotice(await o.claim(principal, {
      profile: MATRIX_DAILY_CAP_NOTICE_PROFILE,
      operation: 'claim',
      claimToken
    }, AbortSignal.timeout(10_000)))
    if (claim.state !== 'claim') {return}
    await o.requireRoom(agent, roomId)
    const runId = matrixDailyCapNoticeRunId(claim.noticeKey)
    const prior = await o.command(agent, {
      kind: 'findTurn',
      roomId,
      turnId: runId,
      sender: agentUserId,
      since: matrixDailyCapNoticeSince(claim.day),
      marker: 'cron'
    }) as MatrixTurnLookup
    if (prior?.state === 'unknown') {
      o.log?.(`[Matrix] daily_cap_notice reason=${reason} outcome=deferred code=lookup_unknown`)
      return
    }
    if (prior?.state === 'found') {
      if (typeof prior.eventId === 'string' && EVENT.test(prior.eventId)) {
        await this.acknowledge(principal, claim.noticeKey, prior.eventId, claimToken)
        o.log?.(`[Matrix] daily_cap_notice reason=${reason} outcome=already_published`)
      }
      return
    }
    const published = await o.command(agent, {
      kind: 'publishCron',
      roomId,
      body: matrixAgentStatusText('daily_cap_warning', o.locale(agent)),
      runId,
      jobId: MATRIX_DAILY_CAP_NOTICE_JOB,
      notify: false
    })
    if (typeof published !== 'string' || !EVENT.test(published)) {
      o.log?.(`[Matrix] daily_cap_notice reason=${reason} outcome=deferred code=publish_unconfirmed`)
      return
    }
    await this.acknowledge(principal, claim.noticeKey, published, claimToken)
    o.log?.(`[Matrix] daily_cap_notice reason=${reason} outcome=published`)
  }

  private async acknowledge(principal: string, noticeKey: string, publishedEvent: string, claimToken: string): Promise<void> {
    parseMatrixDailyCapNotice(await this.options.claim(principal, {
      profile: MATRIX_DAILY_CAP_NOTICE_PROFILE,
      operation: 'published',
      claimToken,
      noticeKey,
      publishedEvent
    }, AbortSignal.timeout(10_000)))
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {return /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : 'unavailable'}
  return 'unavailable'
}
