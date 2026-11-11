import { randomBytes } from 'node:crypto'

import {
  AGENT_MEMORY_ITEMS_MAX,
  AGENT_MEMORY_LABEL_MAX,
  AGENT_MEMORY_SOURCES_MAX,
  AGENT_MEMORY_TEXT_MAX,
  type AgentMemoryBrowse,
  type AgentMemoryBrowseResult,
  type AgentMemoryCleanup,
  type AgentMemoryCorrectResult,
  type AgentMemoryCoverage,
  type AgentMemoryFact,
  type AgentMemoryForgetResult,
  type AgentMemoryOpenResult,
  type AgentMemoryReceipt,
  type AgentMemoryRefusal,
  type AgentMemorySource,
  type AgentMemorySourceKind,
  type AgentMemoryStatus,
  type AgentMemoryStatusResult,
  parseAgentMemoryRequest
} from '../../shared/agent-memory'

/**
 * Main's side of an assistant's memory page. The cloud memory service is the only authority;
 * this module only keeps the window from carrying any:
 * - the window sees opaque scopes and handles this module mints, never the service's handles;
 * - a scope belongs to one account generation and one assistant, so an account switch or
 *   reconnect (`invalidate`) turns every older scope and handle into `stale`;
 * - a reply that lands after an invalidation is dropped, never shown under the new account;
 * - an operation ID is bound to its first intent; a retry repeats it, a different intent under
 *   the same ID is refused.
 *
 * There is no local brain and no fallback: with no transport, memory is simply not available.
 */

/** Errors a transport throws for an answered refusal. Anything else counts as `offline`. */
export class AgentMemoryServiceError extends Error {
  constructor(readonly code: 'forbidden' | 'conflict' | 'stale' | 'invalid' | 'offline') {
    super(`agent_memory_service_${code}`)
  }
}

export type AgentMemoryServiceStatus = { active: false } | { active: true; enabled: boolean; revision: number }

export interface AgentMemoryServiceFact {
  handle: string
  revision: number
  text: string
  learnedAt: number
  citable: boolean
  correcting?: boolean
}

export interface AgentMemoryServiceSource {
  handle: string
  kind: AgentMemorySourceKind
  label?: string
  coverage: AgentMemoryCoverage
  facts: AgentMemoryServiceFact[]
}

export interface AgentMemoryServiceReceipt {
  handle: string
  target: 'fact' | 'source'
  sourceKind: AgentMemorySourceKind
  sourceLabel?: string
  cleanup: AgentMemoryCleanup
}

export interface AgentMemoryServiceBrowse {
  coverage: 'complete' | 'partial'
  sources: AgentMemoryServiceSource[]
  more: boolean
  receipts: AgentMemoryServiceReceipt[]
}

export type AgentMemoryServiceCitation =
  | { kind: 'matrix_event'; roomId: string; eventId: string }
  | { kind: 'drive_file'; fileId: string; version: string }

/**
 * The cloud memory service, called with the account's own credentials (main holds them). Every
 * mutation carries the operation ID so a retry after an unknown outcome is applied once.
 */
export interface AgentMemoryTransport {
  status(assistantId: string, signal: AbortSignal): Promise<AgentMemoryServiceStatus>
  setEnabled(
    assistantId: string,
    input: { expectedRevision: number; enabled: boolean; operationId: string },
    signal: AbortSignal
  ): Promise<AgentMemoryServiceStatus>
  browse(assistantId: string, signal: AbortSignal): Promise<AgentMemoryServiceBrowse>
  forget(
    assistantId: string,
    input: { target: { kind: 'fact' | 'source'; handle: string }; operationId: string },
    signal: AbortSignal
  ): Promise<{ cleanup: AgentMemoryCleanup; status: AgentMemoryServiceStatus }>
  correct(
    assistantId: string,
    input: { handle: string; expectedRevision: number; text: string; operationId: string },
    signal: AbortSignal
  ): Promise<
    | { outcome: 'done'; fact: AgentMemoryServiceFact; status: AgentMemoryServiceStatus }
    | { outcome: 'pending'; status: AgentMemoryServiceStatus }
  >
  /** The fact's exact current citation after the service rechecks source access, or null. */
  citation(assistantId: string, input: { handle: string }, signal: AbortSignal): Promise<AgentMemoryServiceCitation | null>
}

export interface AgentMemoryHostDeps {
  /** Undefined while managed memory is not activated: every read answers "not available". */
  transport?: AgentMemoryTransport
  /**
   * An opaque key for the signed-in account, its session generation and this device, or
   * undefined when signed out. Any change (switch, reconnect, sign-out) makes older scopes stale.
   */
  account(): string | undefined
  /** The owned, open assistant behind a renderer principal, or undefined. */
  assistant(principal: string): { assistantId: string } | undefined
  /** Opens a revalidated citation in the window (main's own navigation). */
  open(citation: AgentMemoryServiceCitation): Promise<void>
  timeoutMs?: number
  /** Test seam for opaque identifiers. */
  mint?(): string
}

interface Scope {
  generation: number
  accountKey: string
  assistantId: string
  handles: Map<string, { kind: 'fact' | 'source'; platform: string; revision?: number }>
  reverse: Map<string, string>
}

const KINDS: readonly AgentMemorySourceKind[] = [
  'assistant_chat',
  'human_dm',
  'human_group',
  'app_exchange',
  'drive_file',
  'owner_statement'
]

const COVERAGE: readonly AgentMemoryCoverage[] = ['complete', 'catching_up', 'partial', 'unavailable']
const HANDLE_LIMIT = 5_000
const OPERATION_LIMIT = 1_000
const SCOPE_LIMIT = 64
const MAX_TIME = 8_640_000_000_000_000
const SERVICE_HANDLE = /^[!-~]{1,512}$/
const ROOM = /^![^\s:]+:[^\s]+$/
const EVENT = /^\$[^\s]{1,255}$/
const FILE = /^[A-Za-z0-9_-]{1,128}$/

const time = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME

function words(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  // Display text only: no control characters reach the window.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()

  return cleaned && cleaned.length <= max ? cleaned : undefined
}

function cleanup(value: unknown): AgentMemoryCleanup | undefined {
  const v = value as Record<string, unknown> | null

  if (v?.state === 'pending' || v?.state === 'hidden') {
    return { state: v.state }
  }

  if (v?.state === 'cleaned') {
    return time(v.backupExpiresAt) ? { state: 'cleaned', backupExpiresAt: v.backupExpiresAt } : { state: 'cleaned' }
  }

  return undefined
}

function serviceStatus(value: unknown): AgentMemoryServiceStatus | undefined {
  const v = value as Record<string, unknown> | null

  if (v?.active === false) {
    return { active: false }
  }

  return v?.active === true && typeof v.enabled === 'boolean' && Number.isSafeInteger(v.revision) && (v.revision as number) >= 0
    ? { active: true, enabled: v.enabled, revision: v.revision as number }
    : undefined
}

function citation(value: unknown): AgentMemoryServiceCitation | undefined {
  const v = value as Record<string, unknown> | null

  if (v?.kind === 'matrix_event' && typeof v.roomId === 'string' && ROOM.test(v.roomId) &&
      typeof v.eventId === 'string' && EVENT.test(v.eventId)) {
    return { kind: 'matrix_event', roomId: v.roomId, eventId: v.eventId }
  }

  if (v?.kind === 'drive_file' && typeof v.fileId === 'string' && FILE.test(v.fileId) &&
      typeof v.version === 'string' && /^[!-~]{1,128}$/.test(v.version)) {
    return { kind: 'drive_file', fileId: v.fileId, version: v.version }
  }

  return undefined
}

function refusal(error: unknown): AgentMemoryRefusal {
  if (error instanceof AgentMemoryServiceError) {
    return error.code === 'forbidden' ? 'unavailable' : error.code
  }

  return 'offline'
}

export function createAgentMemoryHost(deps: AgentMemoryHostDeps) {
  const mint = deps.mint ?? (() => randomBytes(24).toString('base64url'))
  const timeoutMs = deps.timeoutMs ?? 15_000
  let generation = 0
  const scopes = new Map<string, Scope>()
  const operations = new Map<string, { intent: string; revision?: number }>()

  const accountKey = () => deps.account()

  const current = (scope: Scope) => scope.generation === generation && scope.accountKey === accountKey()

  /** The scope behind a renderer request, only if it is this account's and this assistant's. */
  const resolve = (principal: string, key: string): Scope | undefined => {
    const scope = scopes.get(key)
    const assistant = deps.assistant(principal)

    return scope && assistant && current(scope) && scope.assistantId === assistant.assistantId ? scope : undefined
  }

  const scopeFor = (assistantId: string, account: string): string => {
    for (const [key, scope] of scopes) {
      if (scope.assistantId === assistantId && current(scope)) {
        return key
      }
    }

    if (scopes.size >= SCOPE_LIMIT) {
      scopes.clear()
    }

    const key = mint()
    scopes.set(key, { generation, accountKey: account, assistantId, handles: new Map(), reverse: new Map() })

    return key
  }

  const handleFor = (scope: Scope, kind: 'fact' | 'source', platform: string, revision?: number): string => {
    const reverseKey = `${kind}\n${platform}`
    const existing = scope.reverse.get(reverseKey)

    if (existing) {
      scope.handles.set(existing, { kind, platform, ...(revision !== undefined ? { revision } : {}) })

      return existing
    }

    if (scope.handles.size >= HANDLE_LIMIT) {
      // Older handles become stale; the window reads again.
      scope.handles.clear()
      scope.reverse.clear()
    }

    const handle = mint()
    scope.handles.set(handle, { kind, platform, ...(revision !== undefined ? { revision } : {}) })
    scope.reverse.set(reverseKey, handle)

    return handle
  }

  /**
   * Binds an operation ID to its first intent (and the revision it expected). Returns that first
   * binding on a retry, or undefined when the ID was used for another intent.
   */
  const bind = (operationId: string, intent: string, revision?: number) => {
    const known = operations.get(operationId)

    if (known !== undefined) {
      return known.intent === intent ? known : undefined
    }

    if (operations.size >= OPERATION_LIMIT) {
      operations.delete(operations.keys().next().value as string)
    }

    const bound = { intent, ...(revision !== undefined ? { revision } : {}) }
    operations.set(operationId, bound)

    return bound
  }

  const view = (key: string, status: AgentMemoryServiceStatus): AgentMemoryStatus =>
    status.active ? { available: true, scope: key, state: status.enabled ? 'on' : 'off', revision: status.revision } : { available: false }

  const factView = (scope: Scope, fact: AgentMemoryServiceFact): AgentMemoryFact | undefined => {
    const text = words(fact?.text, AGENT_MEMORY_TEXT_MAX)

    if (!text || typeof fact.handle !== 'string' || !SERVICE_HANDLE.test(fact.handle) ||
        !Number.isSafeInteger(fact.revision) || !time(fact.learnedAt)) {
      return undefined
    }

    return {
      handle: handleFor(scope, 'fact', fact.handle, fact.revision),
      text,
      learnedAt: fact.learnedAt,
      canOpen: fact.citable === true,
      ...(fact.correcting === true ? { correcting: true } : {})
    }
  }

  const browseView = (key: string, scope: Scope, raw: AgentMemoryServiceBrowse): AgentMemoryBrowse | undefined => {
    if (!raw || !Array.isArray(raw.sources) || !Array.isArray(raw.receipts)) {
      return undefined
    }

    let dropped = false
    let count = 0
    const sources: AgentMemorySource[] = []

    for (const source of raw.sources.slice(0, AGENT_MEMORY_SOURCES_MAX)) {
      if (!source || typeof source.handle !== 'string' || !SERVICE_HANDLE.test(source.handle) ||
          !KINDS.includes(source.kind) || !COVERAGE.includes(source.coverage) || !Array.isArray(source.facts)) {
        dropped = true

        continue
      }

      const facts: AgentMemoryFact[] = []

      for (const fact of source.facts) {
        if (count >= AGENT_MEMORY_ITEMS_MAX) {
          dropped = true

          break
        }

        const shown = factView(scope, fact)

        if (shown) {
          facts.push(shown)
          count++
        } else {
          dropped = true
        }
      }

      const label = words(source.label, AGENT_MEMORY_LABEL_MAX)
      sources.push({
        handle: handleFor(scope, 'source', source.handle),
        kind: source.kind,
        ...(label ? { label } : {}),
        coverage: source.coverage,
        facts
      })
    }

    const receipts: AgentMemoryReceipt[] = []

    for (const receipt of raw.receipts.slice(0, AGENT_MEMORY_ITEMS_MAX)) {
      const state = cleanup(receipt?.cleanup)

      if (!state || typeof receipt.handle !== 'string' || !SERVICE_HANDLE.test(receipt.handle) ||
          (receipt.target !== 'fact' && receipt.target !== 'source') || !KINDS.includes(receipt.sourceKind)) {
        continue
      }

      const label = words(receipt.sourceLabel, AGENT_MEMORY_LABEL_MAX)
      // A receipt key is display identity only; it does not open or change anything.
      receipts.push({
        key: handleFor(scope, receipt.target, `receipt\n${receipt.handle}`),
        target: receipt.target,
        sourceKind: receipt.sourceKind,
        ...(label ? { sourceLabel: label } : {}),
        cleanup: state
      })
    }

    return {
      scope: key,
      coverage: raw.coverage === 'complete' && !dropped && raw.sources.length <= AGENT_MEMORY_SOURCES_MAX ? 'complete' : 'partial',
      sources,
      more: raw.more === true || dropped,
      receipts
    }
  }

  async function handle(principal: unknown, input: unknown): Promise<unknown> {
    const request = parseAgentMemoryRequest(input)

    if (typeof principal !== 'string' || !request) {
      return { ok: false, reason: 'invalid' }
    }

    const transport = deps.transport
    const assistant = deps.assistant(principal)
    const account = accountKey()

    if (request.action === 'status') {
      if (!transport || !assistant || !account) {
        return { ok: true, status: { available: false } } satisfies AgentMemoryStatusResult
      }

      const key = scopeFor(assistant.assistantId, account)
      const scope = scopes.get(key) as Scope

      try {
        const status = serviceStatus(await transport.status(assistant.assistantId, AbortSignal.timeout(timeoutMs)))

        if (!current(scope)) {
          return { ok: false, reason: 'stale' }
        }

        return status ? { ok: true, status: view(key, status) } : { ok: false, reason: 'unavailable' }
      } catch (error) {
        const reason = refusal(error)

        // Not allowed for this assistant: one quiet "not available", and chat carries on.
        return reason === 'unavailable' ? { ok: true, status: { available: false } } : { ok: false, reason }
      }
    }

    if (!transport) {
      return { ok: false, reason: 'unavailable' }
    }

    const scope = resolve(principal, request.scope)

    if (!scope) {
      return { ok: false, reason: 'stale' }
    }

    const signal = AbortSignal.timeout(timeoutMs)
    const id = scope.assistantId

    try {
      switch (request.action) {
        case 'setEnabled': {
          if (!bind(request.operationId, `${id}\nenabled\n${request.enabled}\n${request.revision}`)) {
            return { ok: false, reason: 'invalid' }
          }

          const status = serviceStatus(
            await transport.setEnabled(id, {
              expectedRevision: request.revision,
              enabled: request.enabled,
              operationId: request.operationId
            }, signal)
          )

          if (!current(scope)) {
            return { ok: false, reason: 'stale' }
          }

          return status ? { ok: true, status: view(request.scope, status) } : { ok: false, reason: 'unavailable' }
        }

        case 'browse': {
          const raw = await transport.browse(id, signal)

          if (!current(scope)) {
            return { ok: false, reason: 'stale' }
          }

          const browse = browseView(request.scope, scope, raw)

          return browse ? ({ ok: true, browse } satisfies AgentMemoryBrowseResult) : { ok: false, reason: 'unavailable' }
        }

        case 'forget': {
          const target = scope.handles.get(request.target.handle)

          if (!target || target.kind !== request.target.kind || target.platform.startsWith('receipt\n')) {
            return { ok: false, reason: 'stale' }
          }

          if (!bind(request.operationId, `${id}\nforget\n${target.kind}\n${target.platform}`)) {
            return { ok: false, reason: 'invalid' }
          }

          const result = await transport.forget(id, {
            target: { kind: target.kind, handle: target.platform },
            operationId: request.operationId
          }, signal)

          if (!current(scope)) {
            return { ok: false, reason: 'stale' }
          }

          const state = cleanup(result?.cleanup)
          const status = serviceStatus(result?.status)

          return state && status
            ? ({ ok: true, cleanup: state, status: view(request.scope, status) } satisfies AgentMemoryForgetResult)
            : { ok: false, reason: 'unavailable' }
        }

        case 'correct': {
          const target = scope.handles.get(request.handle)

          if (!target || target.kind !== 'fact' || target.revision === undefined) {
            return { ok: false, reason: 'stale' }
          }

          const bound = bind(request.operationId, `${id}\ncorrect\n${target.platform}\n${request.text}`, target.revision)

          if (bound?.revision === undefined) {
            return { ok: false, reason: 'invalid' }
          }

          const result = await transport.correct(id, {
            handle: target.platform,
            // The revision the person was shown when they first saved: a fact changed elsewhere is
            // refused, not overwritten, and a retry expects the same revision as its first attempt.
            expectedRevision: bound.revision,
            text: request.text,
            operationId: request.operationId
          }, signal)

          if (!current(scope)) {
            return { ok: false, reason: 'stale' }
          }

          const status = serviceStatus(result?.status)

          if (!status) {
            return { ok: false, reason: 'unavailable' }
          }

          if (result.outcome === 'pending') {
            return { ok: true, outcome: 'pending', status: view(request.scope, status) } satisfies AgentMemoryCorrectResult
          }

          const fact = result.outcome === 'done' ? factView(scope, result.fact) : undefined

          return fact
            ? ({ ok: true, outcome: 'done', fact, status: view(request.scope, status) } satisfies AgentMemoryCorrectResult)
            : { ok: false, reason: 'unavailable' }
        }

        case 'openSource': {
          const target = scope.handles.get(request.handle)

          if (!target || target.kind !== 'fact') {
            return { ok: false, reason: 'stale' }
          }

          // The citation is asked for now, not remembered from the list: access may have ended.
          const exact = citation(await transport.citation(id, { handle: target.platform }, signal))

          if (!current(scope)) {
            return { ok: false, reason: 'stale' }
          }

          if (!exact) {
            return { ok: false, reason: 'unavailable' }
          }

          await deps.open(exact)

          return { ok: true } satisfies AgentMemoryOpenResult
        }
      }
    } catch (error) {
      if (!current(scope)) {
        return { ok: false, reason: 'stale' }
      }

      return { ok: false, reason: refusal(error) }
    }
  }

  return {
    handle,
    /** Account switch, sign-out or reconnect: every older scope, handle and operation is dropped. */
    invalidate() {
      generation++
      scopes.clear()
      operations.clear()
    }
  }
}

export type AgentMemoryHost = ReturnType<typeof createAgentMemoryHost>
