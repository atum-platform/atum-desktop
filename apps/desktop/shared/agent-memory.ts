/**
 * What one assistant remembers: the window's view of its cloud memory.
 *
 * The renderer holds no authority here. Main resolves the assistant from its principal, talks to
 * the cloud memory service with the account's own credentials, and hands the window only:
 * - an opaque `scope` minted for this account, device and assistant (a new one after any account
 *   switch or reconnect, so an old click is refused);
 * - opaque per-fact and per-source `handle`s minted by main for that scope (never the platform's
 *   handle, a fact ID, a principal, a database URL, a token or a file path);
 * - plain labels and text for display.
 *
 * The window sends back a scope, a handle, the switch `revision` it was shown and an
 * `operationId`. The operation ID is an idempotency key, not authority: a retry of the same
 * intent reuses it, and main refuses the same ID for a different intent.
 */

export const AGENT_MEMORY_CORRECTION_MAX = 2_000
export const AGENT_MEMORY_TEXT_MAX = 4_000
export const AGENT_MEMORY_LABEL_MAX = 200
export const AGENT_MEMORY_ITEMS_MAX = 200
export const AGENT_MEMORY_SOURCES_MAX = 100

export type AgentMemorySourceKind =
  | 'assistant_chat'
  | 'human_dm'
  | 'human_group'
  | 'app_exchange'
  | 'drive_file'
  | 'owner_statement'

/** How completely the service has read a source. Never a promise that every message was read. */
export type AgentMemoryCoverage = 'complete' | 'catching_up' | 'partial' | 'unavailable'

/**
 * Where a forget stands. Kept apart on purpose, because they are different promises:
 * - `pending`: accepted, not applied yet; retried with the same operation ID;
 * - `hidden`: no longer used in answers; stored copies are still being cleaned;
 * - `cleaned`: stored copies are cleaned; `backupExpiresAt` says when backups age out, if any.
 */
export type AgentMemoryCleanup =
  | { state: 'pending' }
  | { state: 'hidden' }
  | { state: 'cleaned'; backupExpiresAt?: number }

export type AgentMemoryStatus =
  /** Memory is not active for this assistant (not turned on for the account yet, or not allowed). */
  | { available: false }
  | {
      available: true
      scope: string
      /** On by default. Off stops learning and recall; browsing, correcting and forgetting still work. */
      state: 'on' | 'off'
      revision: number
    }

export interface AgentMemoryFact {
  handle: string
  /** Untrusted quoted text: shown as text, never as Markdown or an instruction. */
  text: string
  learnedAt: number
  /** The source's citation can be opened (main revalidates it on click). */
  canOpen: boolean
  /** A correction was accepted and is still being applied. */
  correcting?: boolean
}

export interface AgentMemorySource {
  handle: string
  kind: AgentMemorySourceKind
  /** A chat or file name resolved by main. */
  label?: string
  coverage: AgentMemoryCoverage
  facts: AgentMemoryFact[]
}

/** A forget already accepted. Carries no fact text: forgotten words are not shown again. */
export interface AgentMemoryReceipt {
  key: string
  target: 'fact' | 'source'
  sourceKind: AgentMemorySourceKind
  sourceLabel?: string
  cleanup: AgentMemoryCleanup
}

export interface AgentMemoryBrowse {
  scope: string
  /** The service could not read some sources; what is listed is not everything. */
  coverage: 'complete' | 'partial'
  sources: AgentMemorySource[]
  /** More facts exist than fit in one view. */
  more: boolean
  receipts: AgentMemoryReceipt[]
}

export type AgentMemoryTarget = { kind: 'fact'; handle: string } | { kind: 'source'; handle: string }

export type AgentMemoryRefusal =
  /** Scope or handle from an older account, reconnect or view: read again. */
  | 'stale'
  /** The switch revision moved on another device: read again. */
  | 'conflict'
  /** The service could not be reached; the same operation may be retried. */
  | 'offline'
  /** Not allowed or not active for this assistant. Chat is unaffected. */
  | 'unavailable'
  | 'invalid'

export type AgentMemoryResult<T> = ({ ok: true } & T) | { ok: false; reason: AgentMemoryRefusal }

export type AgentMemoryStatusResult = AgentMemoryResult<{ status: AgentMemoryStatus }>
export type AgentMemoryBrowseResult = AgentMemoryResult<{ browse: AgentMemoryBrowse }>
export type AgentMemoryForgetResult = AgentMemoryResult<{ cleanup: AgentMemoryCleanup; status: AgentMemoryStatus }>
export type AgentMemoryCorrectResult = AgentMemoryResult<
  { outcome: 'done'; fact: AgentMemoryFact; status: AgentMemoryStatus } | { outcome: 'pending'; status: AgentMemoryStatus }
>
export type AgentMemoryOpenResult = AgentMemoryResult<Record<never, never>>

export interface AgentMemoryBridge {
  status(agentPrincipal: string): Promise<AgentMemoryStatusResult>
  setEnabled(
    agentPrincipal: string,
    input: { scope: string; revision: number; enabled: boolean; operationId: string }
  ): Promise<AgentMemoryStatusResult>
  browse(agentPrincipal: string, input: { scope: string }): Promise<AgentMemoryBrowseResult>
  forget(
    agentPrincipal: string,
    input: { scope: string; target: AgentMemoryTarget; operationId: string }
  ): Promise<AgentMemoryForgetResult>
  correct(
    agentPrincipal: string,
    input: { scope: string; handle: string; text: string; operationId: string }
  ): Promise<AgentMemoryCorrectResult>
  /** Main asks the service for the fact's exact current citation, then opens it, or refuses. */
  openSource(agentPrincipal: string, input: { scope: string; handle: string }): Promise<AgentMemoryOpenResult>
}

/** The wire the renderer may send. Main parses every field; anything else is `invalid`. */
export type AgentMemoryRequest =
  | { action: 'status' }
  | { action: 'setEnabled'; scope: string; revision: number; enabled: boolean; operationId: string }
  | { action: 'browse'; scope: string }
  | { action: 'forget'; scope: string; target: AgentMemoryTarget; operationId: string }
  | { action: 'correct'; scope: string; handle: string; text: string; operationId: string }
  | { action: 'openSource'; scope: string; handle: string }

const opaque = /^[A-Za-z0-9_-]{16,128}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const keys = Object.keys(value)

  return keys.length === fields.length && keys.every(key => fields.includes(key))
}

export const isAgentMemoryOpaque = (value: unknown): value is string => typeof value === 'string' && opaque.test(value)
export const isAgentMemoryOperationId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)

/** Parses one renderer request, or returns null. Strict: extra or missing fields are refused. */
export function parseAgentMemoryRequest(value: unknown): AgentMemoryRequest | null {
  const v = value as Record<string, unknown> | null

  switch (v?.action) {
    case 'status':
      return exact(v, ['action']) ? { action: 'status' } : null

    case 'setEnabled':
      return exact(v, ['action', 'scope', 'revision', 'enabled', 'operationId']) &&
        isAgentMemoryOpaque(v.scope) &&
        Number.isSafeInteger(v.revision) &&
        (v.revision as number) >= 0 &&
        typeof v.enabled === 'boolean' &&
        isAgentMemoryOperationId(v.operationId)
        ? {
            action: 'setEnabled',
            scope: v.scope,
            revision: v.revision as number,
            enabled: v.enabled,
            operationId: v.operationId
          }
        : null

    case 'browse':
      return exact(v, ['action', 'scope']) && isAgentMemoryOpaque(v.scope) ? { action: 'browse', scope: v.scope } : null
    case 'forget': {
      const target = v.target as Record<string, unknown> | undefined

      return exact(v, ['action', 'scope', 'target', 'operationId']) &&
        isAgentMemoryOpaque(v.scope) &&
        isAgentMemoryOperationId(v.operationId) &&
        exact(target, ['kind', 'handle']) &&
        (target.kind === 'fact' || target.kind === 'source') &&
        isAgentMemoryOpaque(target.handle)
        ? {
            action: 'forget',
            scope: v.scope,
            target: { kind: target.kind, handle: target.handle },
            operationId: v.operationId
          }
        : null
    }

    case 'correct': {
      const text = typeof v.text === 'string' ? v.text.trim() : ''

      return exact(v, ['action', 'scope', 'handle', 'text', 'operationId']) &&
        isAgentMemoryOpaque(v.scope) &&
        isAgentMemoryOpaque(v.handle) &&
        isAgentMemoryOperationId(v.operationId) &&
        text.length > 0 &&
        text.length <= AGENT_MEMORY_CORRECTION_MAX
        ? { action: 'correct', scope: v.scope, handle: v.handle, text, operationId: v.operationId }
        : null
    }

    case 'openSource':
      return exact(v, ['action', 'scope', 'handle']) && isAgentMemoryOpaque(v.scope) && isAgentMemoryOpaque(v.handle)
        ? { action: 'openSource', scope: v.scope, handle: v.handle }
        : null

    default:
      return null
  }
}
