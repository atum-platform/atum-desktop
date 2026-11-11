import { newOpaqueToken, OPAQUE_TOKEN, tokenDigest, tokenHandle } from './opaque-token'

/**
 * The model grants the controller's broker admits (atum.cloud-execution/1 §6.3).
 *
 * In production DA issues each grant at dispatch and the gateway checks it live on every
 * request; the broker is the first, local gate: it admits only a grant the controller holds
 * for a task it is running, within the grant's aliases, expiry, request count and
 * concurrency, and it cuts every in-flight request the moment the task is stopped or its
 * lease is lost. The spike (S1) has no DA, so the controller mints its own grants with the
 * same shape.
 *
 * The registry never keeps a token: grants are keyed by the token's SHA-256 digest, and
 * named in logs by a short handle derived from it.
 */

export interface ModelGrant {
  /** Controller-only authority to exchange a failed subscription for managed funding. */
  readonly subscriptionFallback?: { readonly executorId: string; readonly leaseToken: string }
  /** Non-secret handle for logs and measurements. */
  readonly handle: string
  readonly taskId: string
  /**
   * Who serves this grant. `opencode_go` is the account subscription edge: the broker may reach
   * only that edge with it, never the managed Atum gateway (no Proton path exists).
   */
  readonly source: 'atum' | 'opencode_go' | 'chatgpt_plan'
  readonly aliases: readonly string[]
  readonly expiresAt: number
  /** Local cumulative occurrence budget; never changes the platform grant/catalog. */
  readonly runTokenBudget?: true
  /** The output-token cap per request the broker forwards (the gateway caps again). */
  readonly maxOutputTokens: number
  /** The input window the task runs with (the /models answer); absent on spike grants. */
  readonly contextLength?: number
  /** The grant's pinned effort: the broker forwards it in place of whatever the sandbox asks for. */
  readonly effort?: 'low' | 'medium' | 'high'
  /** A protected Google route is useful only with both frozen policy and durable latch state. */
  readonly protection?: { readonly googlePolicy: 'limited_use_v1'; readonly latchState: 'eligible' | 'latched' }
  readonly relay?: {
    readonly ownerPrincipal: string
    readonly agentPrincipal: string
    readonly invocationId: string
    readonly deviceServiceId: string
    readonly revision: number
  }
  /**
   * How many broker admission attempts the task may make in all. This is a local abuse and
   * concurrency bound, not a financial debit: a malformed or unauthorized projection has
   * no upstream call or wallet effect, but still occupies one bounded body-read admission.
   */
  readonly maxRequests: number
  /** How many may be in flight at once. */
  readonly maxConcurrent: number
  /** Present only on a Company AI grant: organization funding, never a Personal fallback. */
  readonly funding?: 'company_wallet'
  readonly profile?: 'atum.company-ai/1' | 'atum.company-private-cos/1' | 'atum.company-ai/2' | 'atum.company-private-cos/2'
}

export type GrantDenial = 'unknown_grant' | 'expired' | 'revoked' | 'exhausted' | 'busy' | 'wrong_source'

export interface GrantAdmission {
  readonly grant: ModelGrant
  /** This request's number under its grant, from 1 (the broker log's `call=`). */
  readonly request: number
  /** Aborted when the grant is revoked (stop, lease loss) while the request is in flight. */
  readonly signal: AbortSignal
  /** Ends the request's hold on the grant's concurrency. Idempotent. */
  end(): void
}

interface Entry {
  grant: ModelGrant
  /** The sandbox address the grant is bound to, once the sandbox exists. */
  source: string | null
  revoked: string | null
  requests: number
  budget?: RunTokenBudget
  used: { inputTokens: number; outputTokens: number }
  inflight: Set<AbortController>
}

export interface RunTokenBudget {
  inputTokens: number
  outputTokens: number
  used?: { inputTokens: number; outputTokens: number }
  /** Durable reservations survive crashes/re-dispatch. Missing usage retains the full reservation. */
  persist(used: { inputTokens: number; outputTokens: number }): void
}
export interface GrantInput {
  subscriptionFallback?: ModelGrant['subscriptionFallback']
  runBudget?: RunTokenBudget
  taskId: string
  aliases: string[]
  source?: 'opencode_go' | 'chatgpt_plan'
  relay?: ModelGrant['relay']
  expiresAt: number
  maxOutputTokens?: number
  contextLength?: number
  effort?: 'low' | 'medium' | 'high'
  protection?: { googlePolicy: 'limited_use_v1'; latchState: 'eligible' | 'latched' }
  maxRequests?: number
  maxConcurrent?: number
  funding?: 'company_wallet'
  profile?: 'atum.company-ai/1' | 'atum.company-private-cos/1' | 'atum.company-ai/2' | 'atum.company-private-cos/2'
}

/** What a P4 `dispatch` response gives this controller's one bounded Company AI answer. */
export interface CompanyGrantInput {
  taskId: string
  token: string
  expiresAt: number
  maxOutputTokens: number
  contextLength: number
  effort: 'low' | 'medium' | 'high'
  /** The address this controller's own broker request comes from; no sandbox may present it. */
  source: string
}

export const COMPANY_WALLET_FUNDING = 'company_wallet' as const
export const COMPANY_AI_GRANT_PROFILE = 'atum.company-ai/1' as const
export const COMPANY_PRIVATE_COS_GRANT_PROFILE = 'atum.company-private-cos/1' as const

const ALIAS = /^[a-z0-9-]{1,40}$/
/** The provider's own model id (OpenCode Go catalogue): dots and slashes are part of the name. */
const SUBSCRIPTION_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const TASK_ID = /^[a-z0-9][a-z0-9-]{7,63}$/

export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536

/** `::ffff:10.0.0.2` and `10.0.0.2` are the same peer. */
export function normalizeAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export const DEFAULT_MAX_REQUESTS = 1_000
export const DEFAULT_MAX_CONCURRENT = 8

export class ModelGrantRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly clock: () => number = Date.now) {}

  /** Admit a grant DA issued for a task this controller runs (the token is DA's). */
  admit(token: string, input: GrantInput): ModelGrant {
    if (!OPAQUE_TOKEN.test(token)) {
      throw new Error('model_grant_invalid:token')
    }

    if (!TASK_ID.test(input.taskId)) {
      throw new Error('model_grant_invalid:task_id')
    }

    const source = input.source === 'opencode_go' || input.source === 'chatgpt_plan' ? input.source : 'atum'

    if (
      !Array.isArray(input.aliases) ||
      input.aliases.length < 1 ||
      input.aliases.length > 8 ||
      new Set(input.aliases).size !== input.aliases.length ||
      input.aliases.some(alias => source !== 'atum'
        ? typeof alias !== 'string' || !SUBSCRIPTION_MODEL.test(alias)
        : !ALIAS.test(alias)) ||
      (source !== 'atum' && input.aliases.length !== 1)
    ) {
      throw new Error('model_grant_invalid:aliases')
    }

    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.clock()) {
      throw new Error('model_grant_invalid:expires_at')
    }

    const positive = (value: number | undefined, fallback: number, name: string) => {
      const chosen = value ?? fallback

      if (!Number.isSafeInteger(chosen) || chosen < 1) {
        throw new Error(`model_grant_invalid:${name}`)
      }

      return chosen
    }

    if (input.effort !== undefined && !['low', 'medium', 'high'].includes(input.effort)) {
      throw new Error('model_grant_invalid:effort')
    }

    const protectedAlias = input.aliases.length === 1 && input.aliases[0] === 'google-protected'

    if (protectedAlias !== (input.protection !== undefined) || input.protection &&
        (input.protection.googlePolicy !== 'limited_use_v1' || !['eligible', 'latched'].includes(input.protection.latchState))) {
      throw new Error('model_grant_invalid:protection')
    }

    // A subscription token is served by its own edge and has no Atum Proton route.
    if (source !== 'atum' && (input.protection !== undefined || protectedAlias)) {
      throw new Error('model_grant_invalid:protection')
    }

    if (input.subscriptionFallback && (source === 'atum' || ![input.subscriptionFallback.executorId, input.subscriptionFallback.leaseToken].every(v => /^[0-9a-f-]{36}$/.test(v)))) {throw new Error('model_grant_invalid:fallback')}
    const relay = input.relay
    const relayRequired = source === 'chatgpt_plan'

    if (relayRequired !== Boolean(relay) || relay && (
      !/^[0-9a-f-]{36}$/u.test(relay.ownerPrincipal) || !/^[0-9a-f-]{36}$/u.test(relay.agentPrincipal) ||
      !/^[0-9a-f-]{36}$/u.test(relay.invocationId) || !/^[0-9a-f-]{36}$/u.test(relay.deviceServiceId) ||
      relay.invocationId !== input.taskId || !Number.isSafeInteger(relay.revision) || relay.revision < 1
    )) {throw new Error('model_grant_invalid:relay')}

    const company = input.funding !== undefined || input.profile !== undefined

    if (company) {
      const shared = input.profile === COMPANY_AI_GRANT_PROFILE
      const native = input.profile === 'atum.company-ai/2' || input.profile === 'atum.company-private-cos/2'
      const privateCos = input.profile === COMPANY_PRIVATE_COS_GRANT_PROFILE

      if (input.funding !== COMPANY_WALLET_FUNDING || (!shared && !privateCos && !native) ||
          input.aliases.length !== 1 || input.aliases[0] !== 'default' ||
          (shared ? input.maxRequests !== 1 : input.maxRequests === undefined || input.maxRequests < 1) ||
          (native ? input.maxConcurrent !== 8 || input.maxRequests !== 1000 : input.maxConcurrent !== 1) || input.protection !== undefined ||
          input.maxOutputTokens === undefined || input.contextLength === undefined || input.effort === undefined) {
        throw new Error('model_grant_invalid:company')
      }
    }

    this.prune()
    const digest = tokenDigest(token)

    if (this.entries.has(digest)) {
      throw new Error('model_grant_invalid:duplicate')
    }

    const grant: ModelGrant = Object.freeze({
      ...(input.runBudget ? { runTokenBudget: true as const } : {}),
      handle: tokenHandle(token),
      taskId: input.taskId,
      source,
      aliases: Object.freeze([...input.aliases]),
      expiresAt: input.expiresAt,
      maxOutputTokens: positive(input.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 'max_output_tokens'),
      ...(input.contextLength === undefined ? {} : { contextLength: positive(input.contextLength, 1, 'context_length') }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.protection === undefined ? {} : { protection: Object.freeze({ ...input.protection }) }),
      ...(input.subscriptionFallback ? { subscriptionFallback: Object.freeze({ ...input.subscriptionFallback }) } : {}),
      ...(relay === undefined ? {} : { relay: Object.freeze({ ...relay }) }),
      ...(company ? { funding: COMPANY_WALLET_FUNDING, profile: input.profile! } : {}),
      maxRequests: positive(input.maxRequests, DEFAULT_MAX_REQUESTS, 'max_requests'),
      maxConcurrent: positive(input.maxConcurrent, DEFAULT_MAX_CONCURRENT, 'max_concurrent')
    })

    this.entries.set(digest, { grant, source: null, revoked: null, requests: 0, budget: input.runBudget, used: { inputTokens: input.runBudget?.used?.inputTokens ?? 0, outputTokens: input.runBudget?.used?.outputTokens ?? 0 }, inflight: new Set() })

    return grant
  }

  /** Reserve before forwarding, atomically across concurrent parent/child model calls. */
  reserveTokens(token: string, inputBound: number, requestedOutput: number):
    { output: number; settle(input: number | null, output: number | null): void } | null {
    const entry = this.entries.get(tokenDigest(token))!
    const budget = entry.budget

    if (!budget) {return { output: requestedOutput, settle() {} }}
    const output = Math.min(requestedOutput, budget.outputTokens-entry.used.outputTokens)

    if (inputBound > budget.inputTokens-entry.used.inputTokens || output < 1) {return null}
    const reserved = { inputTokens: entry.used.inputTokens+inputBound, outputTokens: entry.used.outputTokens+output }
    budget.persist(reserved) // fail closed before an upstream call if sealing fails
    entry.used = reserved
    let settled = false

    return { output, settle: (input, actualOutput) => {
      if (settled) {return}
      settled = true
      const valid = (n: number | null) => n !== null && Number.isSafeInteger(n) && n >= 0

      const used = {
        inputTokens: entry.used.inputTokens-inputBound+(valid(input) ? input! : inputBound),
        outputTokens: entry.used.outputTokens-output+(valid(actualOutput) ? actualOutput! : output)
      }

      budget.persist(used)
      entry.used = used
    } }
  }

  /** The spike's own grant (S1 has no DA): a fresh token, admitted at once. */
  mint(input: GrantInput): { token: string; grant: ModelGrant } {
    if (input.funding !== undefined || input.profile !== undefined) {throw new Error('model_grant_invalid:company')}
    const token = newOpaqueToken()

    return { token, grant: this.admit(token, input) }
  }

  /**
   * Admit P4's Company AI grant for the controller's own single answer call. The token is
   * bound to the controller's broker address, so a sandbox that somehow learned it is refused
   * as `wrong_source`; one request, one in-flight call, company funding only.
   */
  admitCompany(input: CompanyGrantInput): ModelGrant {
    if (typeof input.source !== 'string' || !input.source) {throw new Error('model_grant_invalid:company_source')}

    const grant = this.admit(input.token, {
      taskId: input.taskId,
      aliases: ['default'],
      expiresAt: input.expiresAt,
      maxOutputTokens: input.maxOutputTokens,
      contextLength: input.contextLength,
      effort: input.effort,
      maxRequests: 1,
      maxConcurrent: 1,
      funding: COMPANY_WALLET_FUNDING,
      profile: COMPANY_AI_GRANT_PROFILE
    })

    this.entries.get(tokenDigest(input.token))!.source = normalizeAddress(input.source)

    return grant
  }

  /** A grant's advertised profile without a source/expiry check (a sandbox guard, not admission). */
  grantOf(token: string | null): ModelGrant | undefined {
    return token && OPAQUE_TOKEN.test(token) ? this.entries.get(tokenDigest(token))?.grant : undefined
  }

  /**
   * Bind a task's grants to its sandbox's address on the task bridge, so the token is worth
   * nothing from anywhere else (another sandbox that somehow learned it included).
   */
  bindSource(taskId: string, address: string): void {
    for (const entry of this.entries.values()) {
      if (entry.grant.taskId === taskId) {
        entry.source = normalizeAddress(address)
      }
    }
  }

  /** Is this token a live grant? Never throws; a denial is a closed code. */
  check(
    token: string | null,
    source?: string | null
  ): { ok: true; grant: ModelGrant } | { ok: false; reason: GrantDenial } {
    const entry = token && OPAQUE_TOKEN.test(token) ? this.entries.get(tokenDigest(token)) : undefined

    if (!entry) {
      return { ok: false, reason: 'unknown_grant' }
    }

    if (entry.revoked) {
      return { ok: false, reason: 'revoked' }
    }

    if (this.clock() >= entry.grant.expiresAt) {
      return { ok: false, reason: 'expired' }
    }

    // A minted/admitted token is not usable until the controller knows its sandbox.
    if (entry.source === null || normalizeAddress(source ?? '') !== entry.source) {
      return { ok: false, reason: 'wrong_source' }
    }

    return { ok: true, grant: entry.grant }
  }

  /** Take one request against the grant: counted, bounded, and cut on revocation. */
  begin(
    token: string | null,
    source?: string | null
  ): { ok: true; admission: GrantAdmission } | { ok: false; reason: GrantDenial } {
    const checked = this.check(token, source)

    if (checked.ok === false) {
      return checked
    }

    const entry = this.entries.get(tokenDigest(token!))!

    if (entry.requests >= entry.grant.maxRequests) {
      return { ok: false, reason: 'exhausted' }
    }

    if (entry.inflight.size >= entry.grant.maxConcurrent) {
      return { ok: false, reason: 'busy' }
    }

    const controller = new AbortController()
    entry.requests += 1
    entry.inflight.add(controller)

    // The grant's own expiry also ends the request: a partitioned controller cannot keep a
    // model call alive past it.
    const remaining = Math.max(0, entry.grant.expiresAt - this.clock())
    const expiry = setTimeout(() => controller.abort(new Error('model_grant_expired')), remaining)
    expiry.unref?.()

    let ended = false

    return {
      ok: true,
      admission: {
        grant: entry.grant,
        request: entry.requests,
        signal: controller.signal,
        end: () => {
          if (!ended) {
            ended = true
            clearTimeout(expiry)
            entry.inflight.delete(controller)
          }
        }
      }
    }
  }

  /**
   * Close every grant of a task to new requests (a turn about to commit): the next request is
   * refused as revoked, while a request already in flight runs to its end, so the gateway bills it
   * as a completed call. `revokeTask` cuts whatever is still in flight.
   */
  closeTask(taskId: string, reason = 'closed'): void {
    for (const entry of this.entries.values()) {
      if (entry.grant.taskId === taskId) {
        entry.revoked ??= reason
      }
    }
  }

  /**
   * Revoke every grant of a task (a stop, a lost lease, the task's end): the next request is
   * refused, and every request in flight is aborted now (a closed grant's too). Returns how many
   * were cut.
   */
  revokeTask(taskId: string, reason = 'revoked'): number {
    let cut = 0

    for (const entry of this.entries.values()) {
      if (entry.grant.taskId !== taskId) {
        continue
      }

      entry.revoked ??= reason

      for (const controller of entry.inflight) {
        controller.abort(new Error(`model_grant_${reason}`))
        cut += 1
      }

      entry.inflight.clear()
    }

    return cut
  }

  /** Drop grants that expired more than a minute ago; their tokens are refused as unknown. */
  prune(): void {
    const cutoff = this.clock() - 60_000

    for (const [digest, entry] of this.entries) {
      if (entry.grant.expiresAt < cutoff && entry.inflight.size === 0) {
        this.entries.delete(digest)
      }
    }
  }

  stats(taskId: string): { requests: number; inflight: number } {
    let requests = 0
    let inflight = 0

    for (const entry of this.entries.values()) {
      if (entry.grant.taskId === taskId) {
        requests += entry.requests
        inflight += entry.inflight.size
      }
    }

    return { requests, inflight }
  }
}
