/**
 * Which agent's backend is acting. Every Atum agent is a Hermes profile, and
 * the master assistant is the default profile. Agents share the account's
 * document workspace by product decision (2026-09-04), but they must never
 * share a lease, a write receipt, or a replay slot, and every audited action
 * names the agent that took it.
 */
export const DEFAULT_AGENT_ID = 'default'

export type InteractionCapabilityName =
  | 'browser.navigate'
  | 'browser.interact'
  | 'computer.observe'
  | 'computer.control'

/**
 * One durable consent the user grants once through Hermes's approval card.
 * Hermes stores it in `command_allowlist` as `plugin_rule:atum:<accountKey>:<consent>`;
 * Atum never keeps a parallel store.
 */
export type AtumConsentClass = 'browser' | 'computer.observe' | 'computer.control' | 'workspace.write'

export const ATUM_CONSENT_CLASSES: readonly AtumConsentClass[] = [
  'browser',
  'computer.observe',
  'computer.control',
  'workspace.write'
]

/** Hermes prefixes every plugin-escalated approval key with `plugin_rule:`. */
export const ATUM_CONSENT_RULE_PREFIX = 'plugin_rule:atum:'

/** Rule key handed to Hermes's gate; Hermes stores it as `plugin_rule:<ruleKey>`. */
export function atumConsentRuleKey(accountKey: string, consent: AtumConsentClass): string {
  return `atum:${accountKey}:${consent}`
}

/** Parse `plugin_rule:atum:<accountKey>:<consent>` back into its consent class. */
export function atumConsentFromAllowlistEntry(entry: string, consentRulePrefix: string): AtumConsentClass | null {
  if (!entry.startsWith(consentRulePrefix)) {
    return null
  }

  const consent = entry.slice(consentRulePrefix.length)

  return (ATUM_CONSENT_CLASSES as readonly string[]).includes(consent) ? (consent as AtumConsentClass) : null
}

/** The only approval assertion Electron main accepts on a lease or write request. */
export function isHermesApproval(value: unknown): value is { authority: 'hermes' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { authority?: unknown }).authority === 'hermes'
  )
}

export type InteractionCapabilityFailureCode =
  | 'CAPABILITY_DENIED'
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_INVALID'
  | 'CAPABILITY_REPLAYED'
  | 'CAPABILITY_REVOKED'
  | 'CAPABILITY_SCOPE_ESCAPE'
  | 'CAPABILITY_STALE'

export type InteractionCapabilityScope =
  | { kind: 'public-web'; mode: 'search' | 'read' | 'interact'; workspaceId: string }
  | { kind: 'browser-origin'; origin: string; workspaceId: string }
  | { kind: 'foreground-session'; runtimeSessionId: string; workspaceId: string }

/** Pure description of one interaction operation, derived by Electron main. */
export interface InteractionCapabilityDescriptor {
  version: 1
  capability: InteractionCapabilityName
  intendedEffect: string
  scope: InteractionCapabilityScope
  consent: AtumConsentClass
  /** The `rule_key` handed to Hermes's approval gate (without the `plugin_rule:` prefix). */
  ruleKey: string
}

export interface InteractionCapabilityGrantProjection {
  version: 1
  grantId: string
  accountSubject: string
  workspaceId: string
  runtimeSessionId: string
  sourceOperationId: string
  capability: InteractionCapabilityName
  intendedEffect: string
  scope: InteractionCapabilityScope
  status: 'ready' | 'active'
  expiresAt: string
}

export type InteractionCapabilitySafeBoundary = 'before_start' | 'stopped' | 'partial_effects'

export type InteractionCapabilityEvent =
  | {
      version: 1
      type: 'use_started'
      grant: InteractionCapabilityGrantProjection
      operationId: string
      occurredAt: string
    }
  | {
      version: 1
      type: 'use_finished'
      grantId: string
      operationId: string
      outcome: 'succeeded' | 'failed' | 'revoked'
      safeBoundary: 'stopped' | 'partial_effects'
      completedOperation: boolean
      rendererMessage: string
      occurredAt: string
    }
  | {
      version: 1
      type: 'revoked'
      grantId: string
      safeBoundary: InteractionCapabilitySafeBoundary
      rendererMessage: string
      occurredAt: string
    }
