import {
  type AgentSourceAccessSnapshot,
  parseAgentSourceAccessSnapshot
} from '../../../../packages/device-protocol/agent-sources'
import {
  parseAgentSweepClaimResponseV2,
  parseAgentSweepDispatchResponseV2,
  parseAgentSweepReleaseResponseV2,
  parseAgentSweepSettlementResponseV2
} from '../../../../packages/device-protocol/agent-sweep-v2'

import {
  AGENT_SWEEP_PROFILE,
  AGENT_SWEEP_PROFILE_V2,
  AGENT_SWEEP_PROFILE_V11,
  type AgentSweepClaimed,
  type AgentSweepDefer,
  type AgentSweepDispatch,
  type AgentSweepNativeAuthorization,
  type AgentSweepRelease
} from './background-sweep'
import { readDomainJson } from './domain'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const RESPONSE_BYTES = 64 * 1024
const TIMEOUT_MS = 20_000
export const MATRIX_BACKGROUND_SWEEP_SIGNATURE_ACTION = 'BackgroundSweepExecutor' as const

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function defer(value: unknown): AgentSweepDefer | null {
  if (!record(value) || !exact(value, ['profile', 'decision', 'reason', 'notBefore'])) {
    return null
  }

  return (value.profile === AGENT_SWEEP_PROFILE || value.profile === AGENT_SWEEP_PROFILE_V11 ||
      value.profile === AGENT_SWEEP_PROFILE_V2) &&
    value.decision === 'defer' &&
    typeof value.reason === 'string' &&
    Number.isSafeInteger(value.notBefore)
    ? (value as unknown as AgentSweepDefer)
    : null
}

function policy(value: unknown, v11: boolean): boolean {
  if (!record(value) || !Number.isSafeInteger(value.sourceIntervalMs) || Number(value.sourceIntervalMs) <= 0) {
    return false
  }
  if (!v11) {
    return true
  }
  return value.version === 2 &&
    Number.isSafeInteger(value.effectiveSourceIntervalMs) &&
    Number(value.effectiveSourceIntervalMs) >= 3_600_000 &&
    Number(value.effectiveSourceIntervalMs) <= 7_200_000 &&
    record(value.normalWindow) &&
    value.normalWindow.startHour === 8 &&
    value.normalWindow.endHour === 21 &&
    value.warmupReleaseLimit === 2 &&
    value.warmupReleaseBackoffMs === 120_000
}

function nudge(value: Record<string, unknown>, v11: boolean): boolean {
  if (!v11) {
    return true
  }
  if (value.occurrenceKind === 'warmup_nudge') {
    return typeof value.warmupNudgeIndex === 'number' &&
      Number.isInteger(value.warmupNudgeIndex) && value.warmupNudgeIndex >= 1 && value.warmupNudgeIndex <= 4
  }
  return value.occurrenceKind === 'followup_sweep' && !('warmupNudgeIndex' in value)
}

export function parseBackgroundSweepClaim(value: unknown): AgentSweepClaimed | AgentSweepDefer | null {
  if (record(value) && value.profile === AGENT_SWEEP_PROFILE_V2) {
    try { return parseAgentSweepClaimResponseV2(value) }
    catch { return null }
  }
  const deferred = defer(value)
  if (deferred) {
    return deferred
  }
  if (!record(value) || value.decision !== 'claimed') {
    return null
  }
  const v11 = value.profile === AGENT_SWEEP_PROFILE_V11
  const keys = [
    'profile',
    'decision',
    'occurrenceId',
    'occurrenceAt',
    'expiresAt',
    'settingsRevision',
    'ownerTimeZone',
    'policy',
    'sourceWatermarks',
    ...(v11 ? ['effectiveDueAt', 'occurrenceKind', ...('warmupNudgeIndex' in value ? ['warmupNudgeIndex'] : [])] : [])
  ]
  if (!exact(value, keys)) {
    return null
  }

  return (value.profile === AGENT_SWEEP_PROFILE || v11) &&
    typeof value.occurrenceId === 'string' &&
    UUID.test(value.occurrenceId) &&
    Number.isSafeInteger(value.occurrenceAt) &&
    Number.isSafeInteger(value.expiresAt) &&
    Number(value.expiresAt) > Number(value.occurrenceAt) &&
    Number.isSafeInteger(value.settingsRevision) &&
    typeof value.ownerTimeZone === 'string' &&
    policy(value.policy, v11) &&
    record(value.sourceWatermarks) &&
    nudge(value, v11) &&
    (!v11 || value.effectiveDueAt === value.occurrenceAt)
    ? (value as unknown as AgentSweepClaimed)
    : null
}

function nativeAuthorization(value: unknown, warmup: boolean): value is AgentSweepNativeAuthorization {
  if (
    !record(value) ||
    !exact(value, ['kind', 'authorizationId', 'expiresAt', 'destination', 'protection', 'attribution', 'limits'])
  ) {
    return false
  }
  const destination = value.destination
  const protection = value.protection
  const attribution = value.attribution
  const limits = value.limits
  return (
    value.kind === 'native' &&
    typeof value.authorizationId === 'string' &&
    UUID.test(value.authorizationId) &&
    Number.isSafeInteger(value.expiresAt) &&
    record(destination) &&
    record(protection) &&
    record(attribution) &&
    record(limits) &&
    typeof destination.destination === 'string' &&
    typeof destination.source === 'string' &&
    typeof destination.model === 'string' &&
    ['low', 'medium', 'high'].includes(String(destination.effort)) &&
    (protection.kind === 'standard' || protection.kind === 'google_protected') &&
    typeof attribution.id === 'string' &&
    UUID.test(attribution.id) &&
    ['atum_managed', 'connected_provider'].includes(String(attribution.lane)) &&
    limits.activeComputeSeconds === (warmup ? 1_800 : 120) &&
    limits.calls === 1 &&
    limits.inputTokens === 8_000 &&
    limits.outputTokens === 1_000 &&
    (limits.maxModelMicroProtons === null || Number.isSafeInteger(limits.maxModelMicroProtons))
  )
}

export function parseBackgroundSweepDispatch(value: unknown): AgentSweepDispatch | null {
  if (record(value) && value.profile === AGENT_SWEEP_PROFILE_V2) {
    try { return parseAgentSweepDispatchResponseV2(value) }
    catch { return null }
  }
  const deferred = defer(value)
  if (deferred) {
    return deferred
  }
  if (!record(value) || value.decision !== 'dispatched') {
    return null
  }
  const v11 = value.profile === AGENT_SWEEP_PROFILE_V11
  if (
    !exact(value, ['profile', 'decision', 'occurrenceId', 'expiresAt', 'settingsRevision', 'authorization',
      ...(v11 ? ['occurrenceKind', 'warmupNudgeIndex'] : [])])
  ) {
    return null
  }
  const warmup = v11 && value.occurrenceKind === 'warmup_nudge'
  return (value.profile === AGENT_SWEEP_PROFILE || v11) &&
    typeof value.occurrenceId === 'string' &&
    UUID.test(value.occurrenceId) &&
    Number.isSafeInteger(value.expiresAt) &&
    Number.isSafeInteger(value.settingsRevision) &&
    (!v11 || value.occurrenceKind === 'warmup_nudge' || value.occurrenceKind === 'followup_sweep') &&
    (v11 ? (warmup ? typeof value.warmupNudgeIndex === 'number' &&
      Number.isInteger(value.warmupNudgeIndex) && value.warmupNudgeIndex >= 1 && value.warmupNudgeIndex <= 4
      : value.warmupNudgeIndex === null) : true) &&
    nativeAuthorization(value.authorization, warmup) &&
    value.authorization.expiresAt === value.expiresAt
    ? (value as unknown as AgentSweepDispatch)
    : null
}

export interface BackgroundSweepSettlement {
  profile: typeof AGENT_SWEEP_PROFILE | typeof AGENT_SWEEP_PROFILE_V11 | typeof AGENT_SWEEP_PROFILE_V2
  state: 'settled'
  occurrenceId: string
  occurrenceKind?: 'followup_sweep' | 'warmup_nudge'
  warmupNudgeIndex?: number
  outcome: 'answered' | 'failed' | 'stopped' | 'uncertain'
  disposition: 'silent' | 'offer' | 'none'
  receiptId: string
  settingsRevision: number
  nextDueAt: number
  publication: { state: 'none' } | { state: 'suppressed'; reason: string } | { state: 'admitted'; outboxId: string }
}

export function parseBackgroundSweepSettlement(value: unknown): BackgroundSweepSettlement | null {
  if (record(value) && value.profile === AGENT_SWEEP_PROFILE_V2) {
    try { return parseAgentSweepSettlementResponseV2(value) }
    catch { return null }
  }
  if (!record(value)) {
    return null
  }
  const v11 = value.profile === AGENT_SWEEP_PROFILE_V11
  if (
    !exact(value, [
      'profile',
      'state',
      'occurrenceId',
      'outcome',
      'disposition',
      'receiptId',
      'settingsRevision',
      'nextDueAt',
      'publication',
      ...(v11 ? ['occurrenceKind', ...('warmupNudgeIndex' in value ? ['warmupNudgeIndex'] : [])] : [])
    ]) ||
    !record(value.publication)
  ) {
    return null
  }

  const publication = value.publication
  const publicationValid =
    publication.state === 'none' ||
    (publication.state === 'suppressed' && typeof publication.reason === 'string') ||
    (publication.state === 'admitted' && typeof publication.outboxId === 'string' && UUID.test(publication.outboxId))
  const warmup = v11 && value.occurrenceKind === 'warmup_nudge'

  return (value.profile === AGENT_SWEEP_PROFILE || v11) &&
    value.state === 'settled' &&
    typeof value.occurrenceId === 'string' &&
    UUID.test(value.occurrenceId) &&
    typeof value.receiptId === 'string' &&
    UUID.test(value.receiptId) &&
    ['answered', 'failed', 'stopped', 'uncertain'].includes(String(value.outcome)) &&
    ['silent', 'offer', 'none'].includes(String(value.disposition)) &&
    Number.isSafeInteger(value.settingsRevision) &&
    Number.isSafeInteger(value.nextDueAt) &&
    (!v11 || value.occurrenceKind === 'warmup_nudge' || value.occurrenceKind === 'followup_sweep') &&
    (!v11 || (warmup === ('warmupNudgeIndex' in value))) &&
    publicationValid
    ? (value as unknown as BackgroundSweepSettlement)
    : null
}

export function parseBackgroundSweepRelease(value: unknown): AgentSweepRelease | null {
  if (record(value) && value.profile === AGENT_SWEEP_PROFILE_V2) {
    try { return parseAgentSweepReleaseResponseV2(value) }
    catch { return null }
  }
  if (
    !record(value) ||
    value.profile !== AGENT_SWEEP_PROFILE_V11 ||
    value.occurrenceKind !== 'warmup_nudge' ||
    typeof value.occurrenceId !== 'string' ||
    !UUID.test(value.occurrenceId) ||
    typeof value.warmupNudgeIndex !== 'number' ||
    !Number.isInteger(value.warmupNudgeIndex) ||
    value.warmupNudgeIndex < 1 ||
    value.warmupNudgeIndex > 4
  ) {
    return null
  }

  if (value.decision === 'released') {
    return exact(value, ['profile', 'decision', 'occurrenceId', 'occurrenceKind', 'warmupNudgeIndex', 'releaseCount', 'retryAt']) &&
      (value.releaseCount === 1 || value.releaseCount === 2) &&
      Number.isSafeInteger(value.retryAt) && Number(value.retryAt) > 0
      ? (value as unknown as AgentSweepRelease)
      : null
  }

  if (value.decision !== 'retired') {
    return null
  }

  const publication = value.publication

  return exact(value, ['profile', 'decision', 'occurrenceId', 'occurrenceKind', 'warmupNudgeIndex', 'releaseCount',
    'outcome', 'disposition', 'receiptId', 'settingsRevision', 'nextDueAt', 'publication']) &&
    value.releaseCount === 2 &&
    value.outcome === 'uncertain' &&
    value.disposition === 'none' &&
    typeof value.receiptId === 'string' && UUID.test(value.receiptId) &&
    Number.isSafeInteger(value.settingsRevision) && Number(value.settingsRevision) > 0 &&
    Number.isSafeInteger(value.nextDueAt) && Number(value.nextDueAt) > 0 &&
    record(publication) && exact(publication, ['state']) && publication.state === 'none'
    ? (value as unknown as AgentSweepRelease)
    : null
}

export interface BackgroundSweepPlatformOptions {
  request<T>(send: (accessToken: string, resource: string) => Promise<T>, signal: AbortSignal): Promise<T>
  signClaim(request: unknown): Promise<unknown>
  signActive(request: unknown, occurrenceId: string): Promise<unknown>
  /** Release uses the signed home-lease envelope, like a claim, not the job fence. */
  signRelease?(request: unknown): Promise<unknown>
  fetch?: typeof fetch
}

export class ShellBackgroundSweepPlatform {
  constructor(private readonly options: BackgroundSweepPlatformOptions) {}

  /** A successful private projection explicitly negotiates `/2`; only route absence selects 1.1. */
  async sources(assistantId: string, signal: AbortSignal): Promise<AgentSourceAccessSnapshot | null> {
    if (!UUID.test(assistantId)) {
      throw new Error('matrix_background_sweep_invalid')
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    let response: Response

    try {
      response = await this.options.request(
        (accessToken, resource) => (this.options.fetch ?? fetch)(
          `${resource}/agents/${encodeURIComponent(assistantId)}/sources`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              'Atum-Agent-Home-Wire': '2.1'
            },
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: bounded
          }
        ),
        bounded
      )
    } catch {
      signal.throwIfAborted()
      throw new Error('matrix_background_sweep_unavailable')
    }

    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel().catch(() => {})
      throw new Error(response.status === 401 || response.status === 403
        ? 'matrix_background_sweep_denied'
        : 'matrix_background_sweep_unavailable')
    }
    const value = await readDomainJson(response, RESPONSE_BYTES).catch(() => undefined)

    try {
      return parseAgentSourceAccessSnapshot(value)
    } catch {
      throw new Error('matrix_background_sweep_unavailable')
    }
  }

  private async call<T>(
    assistantId: string,
    request: Record<string, unknown>,
    occurrenceId: string | undefined,
    signal: AbortSignal,
    parse: (value: unknown) => T | null
  ): Promise<T> {
    return this.send(assistantId, request, occurrenceId, signal, parse)
  }

  private async send<T>(
    assistantId: string,
    request: Record<string, unknown>,
    occurrenceId: string | undefined,
    signal: AbortSignal,
    parse: (value: unknown) => T | null
  ): Promise<T> {
    if (!UUID.test(assistantId)) {
      throw new Error('matrix_background_sweep_invalid')
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    const envelope = occurrenceId === undefined
      ? await this.options.signClaim(request)
      : request.operation === 'release'
        ? await (this.options.signRelease ?? this.options.signClaim)(request)
        : await this.options.signActive(request, occurrenceId)
    let response: Response

    try {
      response = await this.options.request(
        (accessToken, resource) =>
          (this.options.fetch ?? fetch)(
            `${resource}/agents/${encodeURIComponent(assistantId)}/background-sweep/executor`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'Atum-Agent-Home-Wire': '2.1'
              },
              body: JSON.stringify(envelope),
              cache: 'no-store',
              credentials: 'omit',
              redirect: 'error',
              signal: bounded
            }
          ),
        bounded
      )
    } catch {
      signal.throwIfAborted()
      throw new Error('matrix_background_sweep_unavailable')
    }

    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await response.body?.cancel().catch(() => {})
      throw new Error('matrix_background_sweep_unsupported')
    }

    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel().catch(() => {})
      throw new Error('matrix_background_sweep_unavailable')
    }

    const value = await readDomainJson(response, RESPONSE_BYTES).catch(() => undefined)
    const parsed = response.ok ? parse(value) : null

    if (!parsed) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? 'matrix_background_sweep_denied'
          : 'matrix_background_sweep_unavailable'
      )
    }

    return parsed
  }

  async claim(assistantId: string, request: unknown, signal: AbortSignal) {
    return this.call(assistantId, request as Record<string, unknown>, undefined, signal, parseBackgroundSweepClaim)
  }

  async dispatch(assistantId: string, occurrenceId: string, request: unknown, signal: AbortSignal) {
    return this.call(assistantId, request as Record<string, unknown>, occurrenceId, signal,
      parseBackgroundSweepDispatch)
  }

  async settle(assistantId: string, occurrenceId: string, request: unknown, signal: AbortSignal) {
    return this.call(assistantId, request as Record<string, unknown>, occurrenceId, signal,
      parseBackgroundSweepSettlement)
  }

  /** Release drains the claim's recorded 1.1 or 2 profile; it never negotiates or downgrades. */
  async release(assistantId: string, occurrenceId: string, request: unknown, signal: AbortSignal) {
    return this.call(assistantId, request as Record<string, unknown>, occurrenceId, signal,
      parseBackgroundSweepRelease)
  }
}

export function validSweepSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}
