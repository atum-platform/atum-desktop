import type {
  ExecutionDestinationId,
  ExecutionDeviceName,
  ExecutionPolicyError,
  ExecutionPolicyOff,
  ExecutionPolicySnapshot,
  ExecutionPolicyUpdate,
  MatrixExecutionPolicyClientError,
  MatrixExecutionPolicySaveResult,
  MatrixExecutionPolicyView
} from '../../shared/execution-policy'
import {
  executionStatusMatchesPolicy,
  parseExecutionPolicyError,
  parseExecutionPolicyOff,
  parseExecutionPolicySnapshot,
  parseExecutionPolicyUpdate,
  parseExecutionStatusSnapshot
} from '../../shared/execution-policy'

import { readDomainJson } from './domain'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const MAX_RESPONSE_BYTES = 128 * 1024

export const MATRIX_EXECUTION_POLICY_REFRESH_MS = 30_000
export const MATRIX_EXECUTION_POLICY_RETRY_MS = 30_000

export type MatrixExecutionPolicyAction = 'policy' | 'status' | 'update' | 'off' | 'capabilities'

export interface MatrixExecutionPolicyResponse {
  status: number
  value: unknown
}

const HTTP_METHOD: Record<MatrixExecutionPolicyAction, string> = {
  policy: 'GET',
  status: 'GET',
  update: 'PUT',
  off: 'DELETE',
  capabilities: 'OPTIONS'
}

/** One fixed owner route. The caller supplies the main-owned bearer, never the renderer.
 * `off` is the per-agent off switch (`DELETE`, not built in the Shell yet); `capabilities` is the
 * non-destructive `OPTIONS` check that says whether the route answers it (`Allow` names `DELETE`). */
export async function requestMatrixExecutionPolicy(
  resource: string,
  accessToken: string,
  agentPrincipal: string,
  action: MatrixExecutionPolicyAction,
  signal: AbortSignal,
  body?: ExecutionPolicyUpdate | ExecutionPolicyOff
): Promise<MatrixExecutionPolicyResponse> {
  signal.throwIfAborted()

  const writes = action === 'update' || action === 'off'

  if (!UUID.test(agentPrincipal) || writes !== Boolean(body)) {
    throw new Error('matrix_execution_policy_invalid')
  }

  const route = action === 'status' ? 'execution-status' : 'execution-policy'

  const response = await fetch(`${resource}/agents/${encodeURIComponent(agentPrincipal)}/${route}`, {
    method: HTTP_METHOD[action],
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(writes ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
    },
    ...(writes ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal
  })

  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }

  if (action === 'capabilities') {
    await response.body?.cancel()

    return { status: response.status, value: { allow: response.headers.get('allow') ?? '' } }
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_execution_policy_unavailable')
  }

  return { status: response.status, value: await readDomainJson(response, MAX_RESPONSE_BYTES) }
}

export interface MatrixExecutionPolicyScope {
  accountKey: string
  generation: number
}

interface CacheEntry {
  value?: MatrixExecutionPolicyView
  nextAt: number
}

interface MatrixExecutionPolicyControllerOptions {
  scope(): MatrixExecutionPolicyScope | null
  request(
    agentPrincipal: string,
    action: MatrixExecutionPolicyAction,
    signal: AbortSignal,
    body?: ExecutionPolicyUpdate | ExecutionPolicyOff
  ): Promise<MatrixExecutionPolicyResponse>
  changed(): void
  /** Closed, privacy-safe save lifecycle lines for main.log. */
  log?: (line: string) => void
  now?(): number
  /** The owner's names for its Macs (§9.4), by device service id. Asked only when the policy
   * has a Mac destination; a failure omits names rather than staling the policy. Main owns the
   * read's sharing and lifetime (matrixExecutionDeviceNames), so this takes no refresh signal. */
  deviceNames?(): Promise<Record<string, ExecutionDeviceName> | undefined>
}

const UNAVAILABLE: ExecutionPolicyError = { error: 'matrix_503', details: { reason: 'unavailable' } }

const INVALID_RESPONSE: MatrixExecutionPolicyClientError = {
  error: 'matrix_client',
  details: { reason: 'invalid_response' }
}

export type MatrixExecutionPolicySaveStage = 'validate' | 'cache' | 'revision' | 'request' | 'scope' | 'response'
export type MatrixExecutionPolicySaveStatus = 'local' | 'error' | number
export type MatrixExecutionPolicySaveReason =
  | 'invalid'
  | 'unavailable'
  | 'revision_conflict'
  | 'request_conflict'
  | 'inventory_changed'
  | 'queue_busy'
  | 'invalid_response'
  | 'cancelled'
  | 'accepted'

/**
 * One structural save line with no principal, destination, URL, token, request body or raw error.
 * Numeric statuses are bounded to the HTTP range so even a malformed adapter cannot add free text.
 */
export function matrixExecutionPolicySaveLogLine(input: {
  stage: MatrixExecutionPolicySaveStage
  status: MatrixExecutionPolicySaveStatus
  reason: MatrixExecutionPolicySaveReason
}): string {
  const status =
    typeof input.status === 'number'
      ? Number.isInteger(input.status) && input.status >= 100 && input.status <= 599
        ? String(input.status)
        : 'invalid'
      : input.status

  return `[Matrix] execution policy save stage=${input.stage} status=${status} reason=${input.reason}`
}

function sameScope(left: MatrixExecutionPolicyScope | null, right: MatrixExecutionPolicyScope | null): boolean {
  return left?.accountKey === right?.accountKey && left?.generation === right?.generation
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}

function policyFollows(previous: ExecutionPolicySnapshot | undefined, next: ExecutionPolicySnapshot): boolean {
  if (!previous || next.revision > previous.revision) {
    return true
  }

  return (
    next.revision === previous.revision &&
    next.source === previous.source &&
    sameList(next.order, previous.order) &&
    sameSet(next.disabled, previous.disabled)
  )
}

function acceptedPolicy(
  value: unknown,
  agentPrincipal: string,
  update?: ExecutionPolicyUpdate
): ExecutionPolicySnapshot | null {
  const policy = parseExecutionPolicySnapshot(value)

  if (
    !policy ||
    policy.agentPrincipal !== agentPrincipal ||
    (update &&
      (policy.revision <= update.expectedRevision ||
        !sameList(policy.order, update.order) ||
        !sameSet(policy.disabled, update.disabled)))
  ) {
    return null
  }

  return policy
}

/** A refusal that proves nothing changed (a replayed request id, a cloud reply still in flight)
 * leaves the cache as it was; any other conflict or outage makes the cached facts unreliable. */
function failureMakesStale(error: ExecutionPolicyError): boolean {
  return (
    error.error === 'matrix_503' ||
    (error.error === 'matrix_409' && error.details.reason !== 'request_conflict' && error.details.reason !== 'queue_busy')
  )
}

function providerError(response: MatrixExecutionPolicyResponse): ExecutionPolicyError {
  const parsed = parseExecutionPolicyError(response.value)

  if (
    !parsed ||
    (parsed.error === 'matrix_400' && response.status !== 400) ||
    (parsed.error === 'matrix_409' && response.status !== 409) ||
    (parsed.error === 'matrix_503' && response.status !== 503)
  ) {
    return UNAVAILABLE
  }

  return parsed
}

/**
 * Account-generation-scoped cache for H-F. Only validated provider facts enter the cache;
 * failures retain the last valid value as stale and never authorize new local execution.
 */
export class MatrixExecutionPolicyController {
  private owner: MatrixExecutionPolicyScope | null = null
  private readonly entries = new Map<string, CacheEntry>()
  private readonly pending = new Map<string, Promise<MatrixExecutionPolicyView | undefined>>()
  private readonly aborts = new Map<string, AbortController>()
  private retained = new Set<string>()
  private offCapability?: { owner: MatrixExecutionPolicyScope; value: boolean; until: number }

  constructor(private readonly options: MatrixExecutionPolicyControllerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private logSave(
    stage: MatrixExecutionPolicySaveStage,
    status: MatrixExecutionPolicySaveStatus,
    reason: MatrixExecutionPolicySaveReason
  ): void {
    this.options.log?.(matrixExecutionPolicySaveLogLine({ stage, status, reason }))
  }

  activate(owner: MatrixExecutionPolicyScope | null): void {
    if (sameScope(owner, this.owner)) {
      return
    }

    for (const abort of this.aborts.values()) {
      abort.abort()
    }

    this.owner = owner
    this.entries.clear()
    this.pending.clear()
    this.aborts.clear()
    this.retained.clear()
  }

  async retain(agentPrincipals: readonly string[]): Promise<void> {
    this.activate(this.options.scope())
    const next = new Set(agentPrincipals.filter(principal => UUID.test(principal)))
    let changed = false

    for (const principal of this.retained) {
      if (!next.has(principal)) {
        this.aborts.get(principal)?.abort()
        this.aborts.delete(principal)
        this.pending.delete(principal)
        changed ||= this.entries.delete(principal)
      }
    }

    this.retained = next

    if (changed) {
      this.options.changed()
    }

    await Promise.all([...next].map(principal => this.refresh(principal)))
  }

  snapshot(agentPrincipal: string): MatrixExecutionPolicyView | undefined {
    return this.owner && this.retained.has(agentPrincipal) ? this.entries.get(agentPrincipal)?.value : undefined
  }

  refreshAll(): void {
    for (const principal of this.retained) {
      void this.refresh(principal)
    }
  }

  read(agentPrincipal: string): Promise<MatrixExecutionPolicyView> {
    return this.refresh(agentPrincipal, true).then(value => {
      if (!value || value.stale) {
        throw new Error('matrix_execution_policy_unavailable')
      }

      return value
    })
  }

  refresh(agentPrincipal: string, force = false): Promise<MatrixExecutionPolicyView | undefined> {
    this.activate(this.options.scope())
    const owner = this.owner

    if (!owner || !this.retained.has(agentPrincipal)) {
      return Promise.resolve(undefined)
    }

    const existing = this.entries.get(agentPrincipal)

    if (!force && existing && this.now() < existing.nextAt) {
      return Promise.resolve(existing.value)
    }

    const running = this.pending.get(agentPrincipal)

    if (running) {
      return running
    }

    const abort = new AbortController()
    this.aborts.set(agentPrincipal, abort)

    const live = () =>
      !abort.signal.aborted && sameScope(this.options.scope(), owner) && this.retained.has(agentPrincipal)

    const pending = this.readFresh(agentPrincipal, AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]))
      .then(value => {
        if (!live()) {
          return undefined
        }

        if (!policyFollows(this.entries.get(agentPrincipal)?.value?.policy, value.policy)) {
          throw new Error('matrix_execution_policy_stale')
        }

        this.set(agentPrincipal, { value, nextAt: this.now() + MATRIX_EXECUTION_POLICY_REFRESH_MS })

        return value
      })
      .catch(() => {
        if (!live()) {
          return undefined
        }

        const previous = this.entries.get(agentPrincipal)?.value
        const value = previous ? { ...previous, stale: true } : undefined
        this.set(agentPrincipal, { value, nextAt: this.now() + MATRIX_EXECUTION_POLICY_RETRY_MS })

        return value
      })
      .finally(() => {
        if (this.pending.get(agentPrincipal) === pending) {
          this.pending.delete(agentPrincipal)
          this.aborts.delete(agentPrincipal)
        }
      })

    this.pending.set(agentPrincipal, pending)

    return pending
  }

  async save(agentPrincipal: string, input: unknown): Promise<MatrixExecutionPolicySaveResult> {
    this.activate(this.options.scope())
    const owner = this.owner
    const update = parseExecutionPolicyUpdate(input)

    if (!owner || !this.retained.has(agentPrincipal) || !update) {
      this.logSave('validate', 'local', 'invalid')

      return { ok: false, error: { error: 'matrix_400', details: { reason: 'invalid' } } }
    }

    const current = this.entries.get(agentPrincipal)?.value

    if (!current || current.stale) {
      this.logSave('cache', 'local', 'unavailable')

      return { ok: false, error: UNAVAILABLE }
    }

    if (update.expectedRevision !== current.policy.revision) {
      this.logSave('revision', 'local', 'revision_conflict')

      return {
        ok: false,
        error: {
          error: 'matrix_409',
          details: { reason: 'revision_conflict' },
          revision: current.policy.revision
        }
      }
    }

    // A read begun before this write cannot overwrite or ambiguously freshen its outcome.
    this.aborts.get(agentPrincipal)?.abort()
    this.aborts.delete(agentPrincipal)
    this.pending.delete(agentPrincipal)

    let response: MatrixExecutionPolicyResponse

    try {
      response = await this.options.request(agentPrincipal, 'update', AbortSignal.timeout(15_000), update)
    } catch (error) {
      this.logSave('request', 'error', 'unavailable')
      this.markStale(agentPrincipal)
      throw error
    }

    if (!sameScope(this.options.scope(), owner) || !this.retained.has(agentPrincipal)) {
      this.logSave('scope', 'local', 'cancelled')
      throw new Error('matrix_execution_policy_cancelled')
    }

    if (response.status !== 200) {
      const error = providerError(response)

      if (failureMakesStale(error)) {
        this.markStale(agentPrincipal)
      }

      this.logSave('response', response.status, error.details.reason)

      return { ok: false, error }
    }

    const policy = acceptedPolicy(response.value, agentPrincipal, update)

    if (!policy) {
      this.logSave('response', response.status, 'invalid_response')
      this.markStale(agentPrincipal)

      return { ok: false, error: INVALID_RESPONSE }
    }

    const view: MatrixExecutionPolicyView = {
      policy,
      stale: false,
      ...(current.off ? { off: true } : {}),
      ...(current.deviceNames ? { deviceNames: current.deviceNames } : {})
    }

    // Due at once, not in 30 s: the accepted policy carries no status, and the header re-reads it
    // right after a save to show where the assistant answers now.
    this.set(agentPrincipal, { value: view, nextAt: this.now() })
    this.logSave('response', response.status, 'accepted')

    return { ok: true, value: policy }
  }

  /**
   * The per-agent off switch (0238 `atum.matrix_execution_policy_off`): the saved policy is deleted
   * and the agent returns to the legacy local path. Offered only after the capability check, and
   * fenced exactly like a save: the revision must be the fresh cached one. Revisions restart at 0
   * for the default policy, which a read must never accept over a saved one, so a successful off
   * replaces the cached entry itself (and `reset` does the same when another device turned it off).
   */
  async turnOff(agentPrincipal: string, input: unknown): Promise<MatrixExecutionPolicySaveResult> {
    this.activate(this.options.scope())
    const owner = this.owner
    const off = parseExecutionPolicyOff(input)

    if (!owner || !this.retained.has(agentPrincipal) || !off) {
      return { ok: false, error: { error: 'matrix_400', details: { reason: 'invalid' } } }
    }

    const current = this.entries.get(agentPrincipal)?.value

    if (!current || current.stale) {
      return { ok: false, error: UNAVAILABLE }
    }

    // Nothing is saved, or the platform has no off switch: there is no request to make.
    if (current.policy.source !== 'saved' || current.off !== true) {
      return { ok: false, error: { error: 'matrix_400', details: { reason: 'invalid' } } }
    }

    if (off.expectedRevision !== current.policy.revision) {
      return {
        ok: false,
        error: { error: 'matrix_409', details: { reason: 'revision_conflict' }, revision: current.policy.revision }
      }
    }

    this.aborts.get(agentPrincipal)?.abort()
    this.aborts.delete(agentPrincipal)
    this.pending.delete(agentPrincipal)

    let response: MatrixExecutionPolicyResponse

    try {
      response = await this.options.request(agentPrincipal, 'off', AbortSignal.timeout(15_000), off)
    } catch (error) {
      this.markStale(agentPrincipal)
      throw error
    }

    if (!sameScope(this.options.scope(), owner) || !this.retained.has(agentPrincipal)) {
      throw new Error('matrix_execution_policy_cancelled')
    }

    if (response.status !== 200) {
      const error = providerError(response)

      if (failureMakesStale(error)) {
        this.markStale(agentPrincipal)
      }

      return { ok: false, error }
    }

    const policy = parseExecutionPolicySnapshot(response.value)

    // The answer to an off is the default policy of this agent, at revision 0, or nothing.
    if (!policy || policy.agentPrincipal !== agentPrincipal || policy.source !== 'default') {
      this.markStale(agentPrincipal)

      return { ok: false, error: INVALID_RESPONSE }
    }

    // Read the status of the default policy at once: the old one no longer matches.
    this.set(agentPrincipal, { value: { policy, stale: false, off: true }, nextAt: this.now() })

    return { ok: true, value: policy }
  }

  /** Forgets what is cached for one agent, so the next read starts a new revision history. Used when
   * the roster shows it left the cloud route (the off switch ran, here or on another device). */
  reset(agentPrincipal: string): void {
    this.aborts.get(agentPrincipal)?.abort()
    this.aborts.delete(agentPrincipal)
    this.pending.delete(agentPrincipal)

    if (this.entries.delete(agentPrincipal)) {
      this.options.changed()
    }
  }

  /** Whether the Shell answers the off switch for this owner: its `OPTIONS` allows `DELETE`. Either
   * answer is believed for ten minutes (a route that ships is found, and one rolled back stops being
   * offered, in that time, with no restart); an unreachable one is asked again. */
  private async offSupported(agentPrincipal: string, owner: MatrixExecutionPolicyScope, signal: AbortSignal): Promise<boolean> {
    const known = this.offCapability

    if (known && sameScope(known.owner, owner) && this.now() < known.until) {
      return known.value
    }

    let value = false

    try {
      const response = await this.options.request(agentPrincipal, 'capabilities', signal)
      const allow = (response.value as { allow?: unknown } | null)?.allow
      value = response.status >= 200 && response.status < 300 && typeof allow === 'string' && /(?:^|[\s,])DELETE(?:[\s,]|$)/iu.test(allow)
      this.offCapability = { owner, value, until: this.now() + 10 * 60_000 }
    } catch {
      // Not asked of the platform: not remembered either.
    }

    return value
  }

  private async readFresh(agentPrincipal: string, signal: AbortSignal): Promise<MatrixExecutionPolicyView> {
    const policyResponse = await this.options.request(agentPrincipal, 'policy', signal)
    const policy = policyResponse.status === 200 ? acceptedPolicy(policyResponse.value, agentPrincipal) : null

    if (!policy) {
      throw new Error('matrix_execution_policy_unavailable')
    }

    let status: MatrixExecutionPolicyView['status']

    try {
      const statusResponse = await this.options.request(agentPrincipal, 'status', signal)
      const parsed = statusResponse.status === 200 ? parseExecutionStatusSnapshot(statusResponse.value) : null

      if (parsed && executionStatusMatchesPolicy(policy, parsed)) {
        status = parsed
      }
    } catch {
      // Policy remains authoritative; status is optional and retried on the next refresh.
    }

    // Only a saved policy has anything to turn off.
    const owner = this.owner
    const off = policy.source === 'saved' && owner ? await this.offSupported(agentPrincipal, owner, signal) : false

    // Real names (§9.4) are cosmetic: asked only when a Mac is in the order, and a registry that
    // does not answer leaves the stable ordinal name rather than making the policy stale.
    let deviceNames: Record<string, ExecutionDeviceName> | undefined

    if (policy.order.some(id => id !== 'cloud') && this.options.deviceNames) {
      try {
        deviceNames = await this.options.deviceNames()
      } catch {
        // Kept absent.
      }
    }

    return {
      policy,
      ...(status ? { status } : {}),
      stale: false,
      ...(off ? { off: true } : {}),
      ...(deviceNames && Object.keys(deviceNames).length ? { deviceNames } : {})
    }
  }

  private set(agentPrincipal: string, next: CacheEntry): void {
    const previous = this.entries.get(agentPrincipal)
    this.entries.set(agentPrincipal, next)

    if (JSON.stringify(previous?.value) !== JSON.stringify(next.value)) {
      this.options.changed()
    }
  }

  private markStale(agentPrincipal: string): void {
    const previous = this.entries.get(agentPrincipal)?.value

    if (previous) {
      this.set(agentPrincipal, {
        value: { ...previous, stale: true },
        nextAt: this.now() + MATRIX_EXECUTION_POLICY_RETRY_MS
      })
    }
  }
}

export type MatrixExecutionPolicyLocalMode = 'off' | 'enabled' | 'draining'
export type MatrixExecutionPolicyListeningAction = 'arm' | 'drain' | 'stop'

/** Readiness is a transition effect. Re-running it for an already-local policy cancels the
 * ready gate and can release an acquiring lease before the provider records its attempt. */
export function matrixExecutionPolicyStartsLocalReadiness(
  previous: boolean | undefined,
  local: boolean
): boolean {
  return local && previous !== true
}

/**
 * Only a fresh saved policy can start a Mac; a current holder may drain after being disabled.
 *
 * `powerEligible` is the owner's FC D3 (the keep-awake row on; since 2026-10-20 a MacBook on battery
 * still counts, an awake Mac answers): a Mac whose row is off is out of the chain exactly as if
 * the owner had turned it off. It starts no term, attempts no lease (so the platform stops counting it eligible within
 * its 60 s window) and a reply already running on it finishes first (`draining`). A desktop
 * without a battery is never on battery, so it is always eligible. Defaults to eligible so the
 * policy decision stays testable apart from the power state.
 */
export function matrixExecutionPolicyLocalMode(
  view: MatrixExecutionPolicyView | undefined,
  deviceServiceId: string | undefined,
  powerEligible = true
): MatrixExecutionPolicyLocalMode {
  if (!view || view.stale || view.policy.source !== 'saved' || !deviceServiceId || !UUID.test(deviceServiceId)) {
    return 'off'
  }

  const destination = `mac:${deviceServiceId}` as ExecutionDestinationId

  if (!view.policy.order.includes(destination)) {
    return 'off'
  }

  const out = view.policy.disabled.includes(destination) || !powerEligible

  if (
    view.status?.current === destination &&
    (out || view.status.state === 'yielding') &&
    (view.status.state === 'working' || view.status.state === 'yielding')
  ) {
    return 'draining'
  }

  return out ? 'off' : 'enabled'
}

/** The audited S1→F1 switch. A legacy/default roster or lease can never synthesize policy
 * authority; only a saved policy may prepare this Mac, while its exact held term may drain. */
export function matrixExecutionPolicyKeepsLocalRuntime(
  view: MatrixExecutionPolicyView | undefined,
  deviceServiceId: string | undefined,
  leaseState: string | undefined,
  powerEligible = true
): boolean {
  const mode = matrixExecutionPolicyLocalMode(view, deviceServiceId, powerEligible)

  return Boolean(
    matrixExecutionPolicyHasLocalDestination(view, deviceServiceId) &&
    (mode === 'enabled' || leaseState === 'held' || leaseState === 'yielding')
  )
}

/** Inventory/identity authority, independent of transient freshness or enablement. */
export function matrixExecutionPolicyHasLocalDestination(
  view: MatrixExecutionPolicyView | undefined,
  deviceServiceId: string | undefined
): boolean {
  return Boolean(
    view?.policy.source === 'saved' &&
      deviceServiceId &&
      UUID.test(deviceServiceId) &&
      view.policy.order.includes(`mac:${deviceServiceId}` as ExecutionDestinationId)
  )
}

export type MatrixExecutionPolicyLeaseIntent = 'start' | 'release' | 'unmanaged'

/**
 * What the saved policy says about this Mac's lease for a cloud-route agent. `start` is the only
 * way the policy path ever attempts a lease: this Mac is an enabled destination, and so is its
 * power (FC D3: a Mac whose keep-awake row is off is out of the chain), and the runtime is ready and
 * competing. Anything else on the policy path releases, and a policy that no longer enables this
 * Mac (`off`, `draining`) is `unmanaged`: the caller's drain logic owns an exact held term.
 */
export function matrixExecutionPolicyLeaseIntent(input: {
  view: MatrixExecutionPolicyView | undefined
  deviceServiceId: string | undefined
  powerEligible: boolean
  competes: boolean
  runtimeReady: boolean
}): MatrixExecutionPolicyLeaseIntent {
  if (matrixExecutionPolicyLocalMode(input.view, input.deviceServiceId, input.powerEligible) !== 'enabled') {
    return 'unmanaged'
  }

  return input.competes && input.runtimeReady ? 'start' : 'release'
}

/** Own-chat intake at the F1 boundary. Only a ready exact holder arms; a valid term that is being
 * handed back drains one admitted turn, while authority loss stops immediately. */
export function matrixExecutionPolicyListeningAction(
  view: MatrixExecutionPolicyView | undefined,
  deviceServiceId: string | undefined,
  leaseState: string | undefined,
  held: boolean,
  runtimeReady: boolean,
  powerEligible = true
): MatrixExecutionPolicyListeningAction {
  const mode = matrixExecutionPolicyLocalMode(view, deviceServiceId, powerEligible)

  if (mode === 'enabled' && held && runtimeReady) {
    return 'arm'
  }

  if (
    mode === 'draining' ||
    leaseState === 'yielding' ||
    (matrixExecutionPolicyHasLocalDestination(view, deviceServiceId) && leaseState === 'held')
  ) {
    return 'drain'
  }

  return 'stop'
}
