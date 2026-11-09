import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import {
  type AtumConsentClass,
  atumConsentRuleKey,
  DEFAULT_AGENT_ID,
  type InteractionCapabilityDescriptor,
  type InteractionCapabilityEvent,
  type InteractionCapabilityFailureCode,
  type InteractionCapabilityGrantProjection,
  type InteractionCapabilityName,
  type InteractionCapabilityScope,
  isHermesApproval
} from '../shared/atum-interaction-capability'

import {
  DEFAULT_PERSONAL_AGENT_ID,
  type FilesystemAccountEnvelope,
  type FilesystemCapabilityActor
} from './atum-filesystem-capability'
import { accountKeyFor, type AccountScopedPaths } from './atum-messaging'

const MAX_DURATION_MS = 5 * 60_000
const MIN_DURATION_MS = 1_000

export interface InteractionCapabilityDescribeInput {
  account: FilesystemAccountEnvelope
  actor: FilesystemCapabilityActor
  /**
   * The agent whose backend is calling, derived by the broker from the
   * per-backend credential. Never supplied by the caller: a backend cannot
   * name itself something else.
   */
  agentId?: string
  runtimeSessionId: string
  toolName: string
  toolArgs: Record<string, unknown>
}

export interface InteractionCapabilityUseInput extends InteractionCapabilityDescribeInput {
  operationId: string
  durationMs: number
  /**
   * The Hermes runtime's assertion that its approval gate settled consent for
   * this operation (a fresh answer, a session cache hit, a durable allowlist
   * entry, or a bypass). Possession of the per-process broker token is the
   * runtime authority; this field is validated for shape and recorded as audit
   * metadata, never treated as proof of a human click.
   */
  approval?: unknown
}

export type InteractionCapabilityDescribeResult =
  | ({ ok: true } & InteractionCapabilityDescriptor)
  | { ok: false; code: InteractionCapabilityFailureCode; rendererMessage: string }

export type InteractionCapabilityUseDecision =
  | {
      allowed: true
      grantId: string
      operationId: string
      capability: InteractionCapabilityName
    }
  | {
      allowed: false
      code: InteractionCapabilityFailureCode
      rendererMessage: string
    }

export type InteractionCapabilityFinishResult =
  | { allowed: true }
  | {
      allowed: false
      code: 'CAPABILITY_REVOKED'
      safeBoundary: 'partial_effects'
      completedOperation: boolean
      rendererMessage: string
    }

interface ActiveAccountContext {
  accountId: string
  generation: number
  paths: AccountScopedPaths
}

interface GrantRecord {
  account: FilesystemAccountEnvelope
  actorKey: string
  agentId: string
  projection: InteractionCapabilityGrantProjection
  revoked: boolean
  consumed: boolean
}

interface ActiveUse {
  agentId: string
  grantId: string
  operationId: string
  runtimeSessionId: string
}

export interface AtumInteractionCapabilityAuthorityOptions {
  appendAudit?: typeof appendFileSync
  now?: () => number
}

function actorKey(actor: FilesystemCapabilityActor): string {
  if (actor.kind === 'personal') {
    return `personal:${actor.personalAgentId}`
  }

  if (actor.kind === 'conversation') {
    return `conversation:${actor.conversationId}`
  }

  return `remote_app:${actor.appId}:${actor.instanceId}`
}

function rendererCopy(code: InteractionCapabilityFailureCode): string {
  const copy: Record<InteractionCapabilityFailureCode, string> = {
    CAPABILITY_DENIED: 'This action needs your permission before it can run.',
    CAPABILITY_EXPIRED: 'That permission request expired. Ask again to continue.',
    CAPABILITY_INVALID: 'This action request was not valid.',
    CAPABILITY_REPLAYED: 'This action request was already used.',
    CAPABILITY_REVOKED: 'Permission was revoked, so the action stopped at the next safe point.',
    CAPABILITY_SCOPE_ESCAPE: 'The action fell outside the approved scope.',
    CAPABILITY_STALE: 'The active account changed. Ask again from the current account.'
  }

  return copy[code]
}

function isPersonalActor(actor: FilesystemCapabilityActor): actor is Extract<
  FilesystemCapabilityActor,
  { kind: 'personal' }
> {
  return actor.kind === 'personal' && actor.personalAgentId === DEFAULT_PERSONAL_AGENT_ID
}

function consentFor(capability: InteractionCapabilityName): AtumConsentClass {
  if (capability === 'computer.observe' || capability === 'computer.control') {
    return capability
  }

  return 'browser'
}

function safeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  try {
    const url = new URL(value)

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null
    }

    return url.origin
  } catch {
    return null
  }
}

function webExtractUrl(value: unknown): string | null {
  let candidate = value

  if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
    const item = candidate as Record<string, unknown>
    candidate = item.url ? item.url : item.href
  }

  if (typeof candidate !== 'string') {
    return null
  }

  const normalized = candidate.trim()

  return normalized || null
}

function sanitizedAppLabel(value: unknown): string {
  if (typeof value !== 'string') {
    return 'the foreground app'
  }

  const compact = value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 80)

  return compact || 'the foreground app'
}

function sanitizedLaunchValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const compact = value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 80)

  return compact || null
}

function sanitizedLaunchTarget(toolArgs: Record<string, unknown>): string {
  const name = sanitizedLaunchValue(toolArgs.name)
  const bundleId = sanitizedLaunchValue(toolArgs.bundle_id)

  if (name && bundleId) {
    return `${JSON.stringify(name)} (bundle id ${JSON.stringify(bundleId)})`
  }

  if (bundleId) {
    return `bundle id ${JSON.stringify(bundleId)}`
  }

  return name ? JSON.stringify(name) : 'an application'
}

function boundedLaunchValues(value: unknown): { shown: string[]; omitted: number } {
  if (!Array.isArray(value)) {
    return { shown: [], omitted: 0 }
  }

  const valid = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 80))
    .filter(Boolean)

  return {
    shown: valid.slice(0, 2),
    omitted: Math.max(0, valid.length - 2)
  }
}

function describedLaunchValues(label: string, value: unknown): string | null {
  const { shown, omitted } = boundedLaunchValues(value)

  if (shown.length === 0) {
    return null
  }

  const suffix = omitted > 0 ? ` (+${omitted} more)` : ''

  return `${label}: ${shown.map(item => JSON.stringify(item)).join(', ')}${suffix}`
}

function launchAppIntendedEffect(toolArgs: Record<string, unknown>): string {
  const parts = [`Launch ${sanitizedLaunchTarget(toolArgs)}`]
  const urls = describedLaunchValues('URLs', toolArgs.urls)
  const additionalArguments = describedLaunchValues('arguments', toolArgs.additional_arguments)

  if (urls) {
    parts.push(urls)
  }

  if (additionalArguments) {
    parts.push(additionalArguments)
  }

  if (toolArgs.creates_new_application_instance === true) {
    parts.push('open a new application instance')
  }

  return parts.join('; ')
}

const COMPUTER_OBSERVE_ACTIONS = new Set(['capture', 'list_apps', 'list_windows', 'wait'])

const COMPUTER_CONTROL_ACTIONS = new Set([
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'set_value',
  'focus_app',
  'launch_app'
])

const BROWSER_TOOL_PREFIX = 'browser_'
const BROWSER_TOOL_NAME_PATTERN = /^browser_[a-z0-9_]{1,64}$/u

function redactedId(value: string): string {
  return createHash('sha256').update('atum-interaction-capability-v1\0').update(value).digest('hex').slice(0, 24)
}

/**
 * Lease and replay identity. The agent is part of the key so two agents can
 * run the same session and operation ids concurrently without one of them
 * finishing, replaying, or blocking the other's operation.
 */
function operationKey(agentId: string, runtimeSessionId: string, operationId: string): string {
  return `${agentId}\0${runtimeSessionId}\0${operationId}`
}

function normalizedAgentId(agentId: string | undefined): string {
  const trimmed = String(agentId ?? '').trim()

  return trimmed || DEFAULT_AGENT_ID
}

/**
 * Account-partitioned, main-owned adapter for browser and computer use.
 *
 * Hermes owns consent: the user answers Hermes's approval card once under a
 * stable rule key and Hermes remembers it. This authority only describes an
 * operation for that card, then binds the approved operation to the signed-in
 * account as a one-operation lease so revocation still stops it at the next
 * safe boundary and every use is audited. Leases never leave this process and
 * do not survive a restart; durable consent lives in Hermes's allowlist.
 */
export class AtumInteractionCapabilityAuthority {
  private active: ActiveAccountContext | null = null
  private readonly grants = new Map<string, GrantRecord>()
  private readonly activeUses = new Map<string, ActiveUse>()
  private readonly seenOperations = new Set<string>()
  private readonly listeners = new Set<(event: InteractionCapabilityEvent) => void>()

  constructor(private readonly options: AtumInteractionCapabilityAuthorityOptions = {}) {}

  activateAccount(input: { accountId: string; generation: number; paths: AccountScopedPaths }): void {
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.paths.accountKey !== accountKeyFor(input.accountId)
    ) {
      throw new Error('invalid_account_capability_context')
    }

    this.revokeAll('Account changed, so browser and computer permissions were cleared.')
    this.active = { accountId: input.accountId, generation: input.generation, paths: input.paths }
  }

  revokeAccount(account: FilesystemAccountEnvelope): void {
    // Revocation is idempotent at the account boundary. A process restart or
    // an account with no interaction leases must not block global Auth logout.
    if (!this.active) {
      return
    }

    this.assertActive(account)
    this.revokeAll('Account changed, so browser and computer permissions were cleared.')
    this.active = null
  }

  subscribe(listener: (event: InteractionCapabilityEvent) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  /** Live one-operation leases (not durable consents, which Hermes owns). */
  listGrants(): InteractionCapabilityGrantProjection[] {
    this.expire()

    return [...this.grants.values()]
      .filter(record => !record.revoked)
      .map(record => ({ ...record.projection, status: record.consumed ? 'active' : 'ready' }))
  }

  /**
   * Pure description of one operation for Hermes's approval card: capability,
   * human wording, scope, and the stable account-scoped rule key. Mints
   * nothing and records nothing.
   */
  describe(input: InteractionCapabilityDescribeInput): InteractionCapabilityDescribeResult {
    if (!this.active) {
      return this.describeFailure('CAPABILITY_REVOKED')
    }

    if (
      input.account.accountId !== this.active.accountId ||
      input.account.accountGeneration !== this.active.generation
    ) {
      return this.describeFailure('CAPABILITY_STALE')
    }

    if (!isPersonalActor(input.actor) || !input.runtimeSessionId.trim()) {
      return this.describeFailure('CAPABILITY_INVALID')
    }

    const descriptor = this.describeUse(input)

    if (!descriptor) {
      return this.describeFailure('CAPABILITY_INVALID')
    }

    return { ok: true, ...descriptor }
  }

  revoke(grantId: string): InteractionCapabilityEvent {
    this.expire()
    const record = this.grants.get(grantId)

    if (!record || record.revoked) {
      throw new Error('CAPABILITY_REVOKED')
    }

    record.revoked = true
    const safeBoundary = record.consumed ? 'partial_effects' : 'before_start'

    const event: InteractionCapabilityEvent = {
      version: 1,
      type: 'revoked',
      grantId,
      safeBoundary,
      rendererMessage:
        safeBoundary === 'partial_effects'
          ? 'Permission was revoked while the action was running. It will stop at the next safe point and may have partial effects.'
          : 'Permission was revoked before the action started.',
      occurredAt: new Date(this.now()).toISOString()
    }

    this.emit(event)
    this.auditBestEffort('revoke', record.projection, record.projection.grantId, null, safeBoundary, record.agentId)

    if (!record.consumed) {
      this.grants.delete(grantId)
    }

    return event
  }

  /**
   * Bind one Hermes-approved operation to the signed-in account as a
   * one-operation lease and start it. Every field is re-validated here; the
   * runtime's approval assertion is required for shape and audited, not
   * trusted as proof.
   */
  requestUse(input: InteractionCapabilityUseInput): InteractionCapabilityUseDecision {
    this.expire()

    if (!this.active) {
      return this.denied('CAPABILITY_REVOKED')
    }

    const agentId = normalizedAgentId(input.agentId)
    const useKey = operationKey(agentId, input.runtimeSessionId, input.operationId)

    if (
      input.account.accountId !== this.active.accountId ||
      input.account.accountGeneration !== this.active.generation
    ) {
      return this.denied('CAPABILITY_STALE')
    }

    if (
      !isPersonalActor(input.actor) ||
      !input.operationId.trim() ||
      !input.runtimeSessionId.trim() ||
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < MIN_DURATION_MS ||
      input.durationMs > MAX_DURATION_MS ||
      this.activeUses.has(useKey)
    ) {
      return this.denied('CAPABILITY_INVALID')
    }

    if (this.seenOperations.has(useKey)) {
      return this.denied('CAPABILITY_REPLAYED')
    }

    const descriptor = this.describeUse(input)

    if (!descriptor) {
      return this.denied('CAPABILITY_INVALID')
    }

    if (!isHermesApproval(input.approval)) {
      return this.denied('CAPABILITY_DENIED')
    }

    const now = this.now()

    const projection: InteractionCapabilityGrantProjection = {
      version: 1,
      grantId: randomUUID(),
      accountSubject: this.active.paths.accountKey,
      workspaceId: this.active.paths.accountKey,
      runtimeSessionId: input.runtimeSessionId,
      sourceOperationId: input.operationId,
      capability: descriptor.capability,
      intendedEffect: descriptor.intendedEffect,
      scope: descriptor.scope,
      status: 'active',
      expiresAt: new Date(now + input.durationMs).toISOString()
    }

    this.audit('allow', projection, projection.grantId, input.operationId, 'hermes_consent', agentId)
    this.grants.set(projection.grantId, {
      account: input.account,
      actorKey: actorKey(input.actor),
      agentId,
      projection,
      revoked: false,
      consumed: true
    })
    this.audit('use', projection, projection.grantId, input.operationId, 'started', agentId)
    this.activeUses.set(useKey, {
      agentId,
      grantId: projection.grantId,
      operationId: input.operationId,
      runtimeSessionId: input.runtimeSessionId
    })
    this.seenOperations.add(useKey)
    this.emit({
      version: 1,
      type: 'use_started',
      grant: projection,
      operationId: input.operationId,
      occurredAt: new Date(now).toISOString()
    })

    return {
      allowed: true,
      grantId: projection.grantId,
      operationId: input.operationId,
      capability: descriptor.capability
    }
  }

  finishUse(
    runtimeSessionId: string,
    operationId: string,
    completedOperation: boolean,
    agentId?: string
  ): InteractionCapabilityFinishResult {
    const useKey = operationKey(normalizedAgentId(agentId), runtimeSessionId, operationId)
    const use = this.activeUses.get(useKey)

    if (!use) {
      return {
        allowed: false,
        code: 'CAPABILITY_REVOKED',
        safeBoundary: 'partial_effects',
        completedOperation,
        rendererMessage: rendererCopy('CAPABILITY_REVOKED')
      }
    }

    this.activeUses.delete(useKey)
    const record = this.grants.get(use.grantId)

    if (!record) {
      return {
        allowed: false,
        code: 'CAPABILITY_REVOKED',
        safeBoundary: 'partial_effects',
        completedOperation,
        rendererMessage: rendererCopy('CAPABILITY_REVOKED')
      }
    }

    this.grants.delete(use.grantId)

    if (record.revoked || Date.parse(record.projection.expiresAt) <= this.now()) {
      const rendererMessage = completedOperation
        ? 'Permission was revoked while the action was running. The operation reported completion before it stopped.'
        : 'Permission was revoked while the action was running. It stopped at the next safe point and may have partial effects.'

      this.emit({
        version: 1,
        type: 'use_finished',
        grantId: record.projection.grantId,
        operationId,
        outcome: 'revoked',
        safeBoundary: 'partial_effects',
        completedOperation,
        rendererMessage,
        occurredAt: new Date(this.now()).toISOString()
      })
      this.auditBestEffort('revoke', record.projection, record.projection.grantId, operationId, 'partial_effects', record.agentId)

      return {
        allowed: false,
        code: 'CAPABILITY_REVOKED',
        safeBoundary: 'partial_effects',
        completedOperation,
        rendererMessage
      }
    }

    this.emit({
      version: 1,
      type: 'use_finished',
      grantId: record.projection.grantId,
      operationId,
      outcome: completedOperation ? 'succeeded' : 'failed',
      safeBoundary: 'stopped',
      completedOperation,
      rendererMessage: completedOperation ? 'The approved action finished.' : 'The approved action stopped without reporting success.',
      occurredAt: new Date(this.now()).toISOString()
    })
    this.auditBestEffort(
      'use',
      record.projection,
      record.projection.grantId,
      operationId,
      completedOperation ? 'succeeded' : 'failed',
      record.agentId
    )

    return { allowed: true }
  }

  private describeUse(input: InteractionCapabilityDescribeInput): InteractionCapabilityDescriptor | null {
    const workspaceId = this.active!.paths.accountKey
    const accountKey = this.active!.paths.accountKey

    const finish = (
      capability: InteractionCapabilityName,
      intendedEffect: string,
      scope: InteractionCapabilityScope
    ): InteractionCapabilityDescriptor => {
      const consent = consentFor(capability)

      return {
        version: 1,
        capability,
        intendedEffect,
        scope,
        consent,
        ruleKey: atumConsentRuleKey(accountKey, consent)
      }
    }

    if (input.toolName === 'web_search') {
      return finish('browser.navigate', 'Search the public web', { kind: 'public-web', mode: 'search', workspaceId })
    }

    if (input.toolName === 'web_extract') {
      const urls = input.toolArgs.urls

      const normalizedUrls = Array.isArray(urls) && urls.length > 0
        ? urls.slice(0, 5).map(webExtractUrl)
        : []

      const validUrls = normalizedUrls.length > 0 && normalizedUrls.every(url => url !== null && safeOrigin(url) !== null)

      return validUrls
        ? finish(
            'browser.navigate',
            normalizedUrls.length === 1 ? 'Read a public web page' : `Read ${normalizedUrls.length} public web pages`,
            { kind: 'public-web', mode: 'read', workspaceId }
          )
        : null
    }

    if (input.toolName === 'browser_navigate') {
      const origin = safeOrigin(input.toolArgs.url)

      return origin
        ? finish('browser.navigate', `Open ${origin}`, { kind: 'browser-origin', origin, workspaceId })
        : null
    }

    if (input.toolName.startsWith(BROWSER_TOOL_PREFIX)) {
      if (!BROWSER_TOOL_NAME_PATTERN.test(input.toolName)) {
        return null
      }

      const action = input.toolName.slice(BROWSER_TOOL_PREFIX.length).replaceAll('_', ' ')

      return finish('browser.interact', `Use the browser (${action})`, { kind: 'public-web', mode: 'interact', workspaceId })
    }

    if (input.toolName === 'computer_use') {
      const action = typeof input.toolArgs.action === 'string' ? input.toolArgs.action.trim().toLocaleLowerCase('en-US') : ''
      const observe = COMPUTER_OBSERVE_ACTIONS.has(action)
      const control = COMPUTER_CONTROL_ACTIONS.has(action)

      if (!observe && !control) {
        return null
      }

      return finish(
        observe ? 'computer.observe' : 'computer.control',
        action === 'launch_app'
          ? launchAppIntendedEffect(input.toolArgs)
          : observe
            ? `Observe ${sanitizedAppLabel(input.toolArgs.app)}`
            : `Use ${action.replaceAll('_', ' ')} in ${sanitizedAppLabel(input.toolArgs.app)}`,
        { kind: 'foreground-session', runtimeSessionId: input.runtimeSessionId, workspaceId }
      )
    }

    return null
  }

  private expire(): void {
    const now = this.now()

    for (const [grantId, record] of this.grants) {
      if (!record.consumed && Date.parse(record.projection.expiresAt) <= now) {
        this.grants.delete(grantId)
      }
    }
  }

  private revokeAll(rendererMessage: string): void {
    const occurredAt = new Date(this.now()).toISOString()

    for (const record of this.grants.values()) {
      if (!record.revoked) {
        record.revoked = true
        this.emit({
          version: 1,
          type: 'revoked',
          grantId: record.projection.grantId,
          safeBoundary: record.consumed ? 'partial_effects' : 'before_start',
          rendererMessage,
          occurredAt
        })
        this.auditBestEffort(
          'revoke',
          record.projection,
          record.projection.grantId,
          null,
          record.consumed ? 'account_quiesced_partial' : 'account_quiesced',
          record.agentId
        )
      }
    }

    this.grants.clear()
    this.activeUses.clear()
    this.seenOperations.clear()
  }

  private assertActive(account: FilesystemAccountEnvelope): void {
    if (
      !this.active ||
      this.active.accountId !== account.accountId ||
      this.active.generation !== account.accountGeneration
    ) {
      throw new Error('CAPABILITY_STALE')
    }
  }

  private denied(code: InteractionCapabilityFailureCode): Extract<InteractionCapabilityUseDecision, { allowed: false }> {
    return { allowed: false, code, rendererMessage: rendererCopy(code) }
  }

  private describeFailure(code: InteractionCapabilityFailureCode): Extract<InteractionCapabilityDescribeResult, { ok: false }> {
    return { ok: false, code, rendererMessage: rendererCopy(code) }
  }

  private audit(
    event: 'allow' | 'deny' | 'request' | 'revoke' | 'use',
    projection: InteractionCapabilityGrantProjection,
    grantId: string | null,
    operationId: string | null,
    reason: string,
    agentId: string = DEFAULT_AGENT_ID
  ): void {
    if (!this.active) {
      return
    }

    const auditDirectory = path.dirname(this.active.paths.capabilityAuditLog)
    mkdirSync(auditDirectory, { recursive: true, mode: 0o700 })
    chmodSync(auditDirectory, 0o700)
    const appendAudit = this.options.appendAudit ?? appendFileSync

    const record = {
      version: 1,
      at: new Date(this.now()).toISOString(),
      accountKey: this.active.paths.accountKey,
      accountGeneration: this.active.generation,
      event,
      actorKind: 'personal',
      // Which agent took the action. Agents share the account's documents by
      // product decision, so the audit is the record of who did what.
      agent: agentId,
      capability: projection.capability,
      request: null,
      grant: grantId ? redactedId(grantId) : null,
      operation: operationId ? redactedId(operationId) : null,
      scope: redactedId(JSON.stringify(projection.scope)),
      reason
    }

    appendAudit(this.active.paths.capabilityAuditLog, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    chmodSync(this.active.paths.capabilityAuditLog, 0o600)
  }

  private auditBestEffort(
    event: 'revoke' | 'use',
    projection: InteractionCapabilityGrantProjection,
    grantId: string,
    operationId: string | null,
    reason: string,
    agentId: string = DEFAULT_AGENT_ID
  ): void {
    try {
      this.audit(event, projection, grantId, operationId, reason, agentId)
    } catch {
      // Revocation and a completed safe-boundary check cannot depend on audit I/O.
    }
  }

  private emit(event: InteractionCapabilityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Projection failure never changes authority.
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

export { MAX_DURATION_MS as INTERACTION_CAPABILITY_MAX_DURATION_MS, rendererCopy as interactionRendererCopy }
