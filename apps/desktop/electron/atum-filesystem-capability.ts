import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'

import { atumConsentRuleKey, DEFAULT_AGENT_ID, isHermesApproval } from '../shared/atum-interaction-capability'
import { isDocumentThemeId } from '../shared/atum-office/document-theme'

import type { AssistantWorkspaceTextResultV1 } from './assistant-workspace-text-result'
import type {
  AtumInteractionCapabilityAuthority,
  InteractionCapabilityDescribeInput,
  InteractionCapabilityUseInput
} from './atum-interaction-capability'
import { accountKeyFor, type AccountScopedPaths } from './atum-messaging'

const DEFAULT_PERSONAL_AGENT_ID = 'atum-personal-assistant'
const MAX_BROKER_BODY_BYTES = 64 * 1024
const MAX_RENDERER_READ_BYTES = 1024 * 1024
const MAX_APPROVED_WRITE_BYTES = 1024 * 1024
const MAX_WRITE_BROKER_BODY_BYTES = MAX_APPROVED_WRITE_BYTES + 64 * 1024
const MAX_SEEN_OPERATIONS = 10_000
const APPROVED_WRITE_GRANT_TTL_MS = 30_000
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export type FilesystemCapabilityName = 'filesystem.read' | 'filesystem.write' | 'filesystem.delete'

export type FilesystemCapabilityActor =
  | { kind: 'personal'; personalAgentId: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'remote_app'; appId: string; instanceId: string }

export interface FilesystemAccountEnvelope {
  accountId: string
  accountGeneration: number
}

export interface FilesystemCapabilityGrant {
  grantId: string
  accountId: string
  accountGeneration: number
  actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
  capability: 'filesystem.read'
  scope: {
    kind: 'filesystem-root'
    canonicalRoot: string
    operations: readonly ['read']
  }
  expiresAt: null
  revocationGeneration: number
  surface: 'backend' | 'renderer-intent'
}

export interface FilesystemWriteGrant {
  grantId: string
  accountId: string
  accountGeneration: number
  actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
  capability: 'filesystem.write'
  scope: {
    kind: 'filesystem-file'
    canonicalPath: string
    canonicalRoot: string
    maxBytes: number
    operations: readonly ['write']
  }
  expiresAt: number
  revocationGeneration: number
  surface: 'backend'
  operationId?: string
}

export type FilesystemGrant = FilesystemCapabilityGrant | FilesystemWriteGrant

export interface FilesystemDecisionInput {
  account: FilesystemAccountEnvelope
  actor: FilesystemCapabilityActor
  /** Agent whose backend is calling, derived by the broker from its credential. */
  agentId?: string
  capability: FilesystemCapabilityName
  grantId?: string
  resourcePath: string
  operationId: string
  contentByteSize?: number
}

export type FilesystemDecision =
  | { allowed: true; canonicalPath: string; grantId: string; writeReceiptId?: undefined }
  | {
      allowed: true
      canonicalPath: string
      grantId: string
      writeReceiptId: string
      writeReceiptExpiresAt: number
    }
  | {
      allowed: false
      code:
        | 'CAPABILITY_DENIED'
        | 'CAPABILITY_REPLAYED'
        | 'CAPABILITY_REVOKED'
        | 'CAPABILITY_STALE'
        | 'CAPABILITY_SCOPE_ESCAPE'
        | 'CAPABILITY_EXPIRED'
        | 'CAPABILITY_TOO_LARGE'
    }

export interface FilesystemRendererIntent {
  intentId: string
  accountGeneration: number
  displayName: string
}

export interface FilesystemRendererReadResult {
  byteSize: number
  text: string
  truncated: boolean
}

interface ActiveAccountContext {
  accountId: string
  generation: number
  paths: AccountScopedPaths
}

interface GrantRecord {
  grant: FilesystemGrant
  rootIdentity: string
  revoked: boolean
  consumed: boolean
}

interface WriteReceiptRecord {
  account: FilesystemAccountEnvelope
  actorKey: string
  /** The agent whose backend earned this receipt; only it may consume it. */
  agentId: string
  canonicalPath: string
  expiresAt: number
  grantId: string
  operationId: string
}

interface IntentRecord {
  account: FilesystemAccountEnvelope
  actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
  grantId: string
  canonicalRoot: string
}

interface DecidedResource {
  canonicalPath: string
}

export interface AtumFilesystemCapabilityAuthorityOptions {
  appendAudit?: typeof appendFileSync
  now?: () => number
}

export interface AssistantWorkspaceWriteCompletionBroker {
  /** Perform one write whose consent Hermes's approval gate has already settled. */
  requestWrite(input: {
    account: FilesystemAccountEnvelope
    actor: FilesystemCapabilityActor
    agentId?: string
    content: string
    operationId: string
    resourcePath: string
    sessionId: string
    abortSignal?: AbortSignal
  }): Promise<AssistantWorkspaceTextResultV1>
}

/**
 * Pure description of one workspace write for Hermes's approval card. `ok:
 * false` means the write is not one Atum executes (outside the workspace, an
 * unsupported type, too large, or a stale account) and Hermes's own
 * `write_file` should run instead.
 */
export type WorkspaceWriteDescription =
  | {
      ok: true
      version: 1
      consent: 'workspace.write'
      ruleKey: string
      intendedEffect: string
      workspaceRelativePath: string
      disposition: 'create' | 'overwrite'
      byteSize: number
      existingByteSize: number
    }
  | {
      ok: false
      /**
       * `CAPABILITY_SCOPE_ESCAPE`, `CAPABILITY_UNSUPPORTED_TYPE`, and
       * `CAPABILITY_TOO_LARGE` are deliberate "not one of ours" answers the
       * Hermes plugin may pass through to plain `write_file`. Every other
       * code — including an unexpected main-side failure, which maps to
       * `CAPABILITY_DENIED` — must block.
       */
      code:
        | 'CAPABILITY_DENIED'
        | 'CAPABILITY_SCOPE_ESCAPE'
        | 'CAPABILITY_STALE'
        | 'CAPABILITY_TOO_LARGE'
        | 'CAPABILITY_UNSUPPORTED_TYPE'
    }

function formatByteSize(byteSize: number): string {
  if (byteSize < 1024) {
    return `${byteSize} B`
  }

  if (byteSize < 1024 * 1024) {
    return `${(byteSize / 1024).toFixed(byteSize < 10 * 1024 ? 1 : 0)} KB`
  }

  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Replay identity. Agents share the account's documents by product decision,
 * but an operation belongs to exactly one agent: two agents may reuse the same
 * operation id concurrently, and neither may consume the other's receipt.
 */
function agentOperationKey(agentId: string, operationId: string): string {
  return `${agentId}\0${operationId}`
}

function normalizedAgentId(agentId: string | undefined): string {
  const trimmed = String(agentId ?? '').trim()

  return trimmed || DEFAULT_AGENT_ID
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

function fileIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode & fsConstants.S_IFMT}`
}

function normalizedComparablePath(value: string): string {
  const normalized = value.normalize('NFC')

  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

function pathIsWithin(root: string, candidate: string): boolean {
  const comparableRoot = normalizedComparablePath(root)
  const comparableCandidate = normalizedComparablePath(candidate)
  const relative = path.relative(comparableRoot, comparableCandidate)

  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function safeBearerMatches(header: string | undefined, expected: string): boolean {
  const supplied = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '')
  const wanted = Buffer.from(expected)

  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted)
}

function redactedId(value: string): string {
  return createHash('sha256').update('atum-capability-audit-v1\0').update(value).digest('hex').slice(0, 24)
}

function validateActor(actor: FilesystemCapabilityActor): void {
  if (actor.kind === 'personal' && actor.personalAgentId.trim()) {
    return
  }

  if (actor.kind === 'conversation' && actor.conversationId.trim()) {
    return
  }

  if (actor.kind === 'remote_app' && actor.appId.trim() && actor.instanceId.trim()) {
    return
  }

  throw new Error('invalid_capability_actor')
}

/**
 * Electron-main authority for the first Atum filesystem capability. It owns
 * account activation, grants, opaque renderer intents, replay state, and the
 * account-scoped redacted audit. The renderer and Python backend can request a
 * decision, but neither can create or widen a grant.
 */
export class AtumFilesystemCapabilityAuthority {
  private active: ActiveAccountContext | null = null
  private readonly grants = new Map<string, GrantRecord>()
  private readonly intents = new Map<string, IntentRecord>()
  private readonly writeReceipts = new Map<string, WriteReceiptRecord>()
  private readonly seenOperations = new Set<string>()
  private revocationGeneration = 0

  constructor(private readonly options: AtumFilesystemCapabilityAuthorityOptions = {}) {}

  activateAccount(input: {
    accountId: string
    generation: number
    paths: AccountScopedPaths
  }): FilesystemCapabilityGrant {
    const legacyWorkspace = path.join(input.paths.root, 'workspace')
    // AccountRootAuthority moves only the files and retains this private alias.
    // An arbitrary external directory must not become an account workspace.
    let ownedWorkspace = input.paths.workspaceRoot === legacyWorkspace

    if (!ownedWorkspace) {
      try {
        const workspace = lstatSync(input.paths.workspaceRoot)
        ownedWorkspace = workspace.isDirectory() && !workspace.isSymbolicLink() && lstatSync(legacyWorkspace).isSymbolicLink() &&
          realpathSync(legacyWorkspace) === realpathSync(input.paths.workspaceRoot)
      } catch { /* Missing aliases cannot authorize an external workspace. */ }
    }

    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.paths.accountKey !== accountKeyFor(input.accountId) ||
      !ownedWorkspace
    ) {
      throw new Error('invalid_account_capability_context')
    }

    this.revokeAll()
    mkdirSync(input.paths.workspaceRoot, { recursive: true, mode: 0o700 })
    chmodSync(input.paths.workspaceRoot, 0o700)
    this.active = { accountId: input.accountId, generation: input.generation, paths: input.paths }

    return this.issueReadGrant({
      account: { accountId: input.accountId, accountGeneration: input.generation },
      actor: { kind: 'personal', personalAgentId: DEFAULT_PERSONAL_AGENT_ID },
      rootPath: input.paths.workspaceRoot
    })
  }

  currentAuthority(): {
    account: FilesystemAccountEnvelope
    actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
  } | null {
    if (!this.active) {
      return null
    }

    return {
      account: { accountId: this.active.accountId, accountGeneration: this.active.generation },
      actor: { kind: 'personal', personalAgentId: DEFAULT_PERSONAL_AGENT_ID }
    }
  }

  currentWorkspaceRoot(): string | null {
    return this.active?.paths.workspaceRoot ?? null
  }

  issueReadGrant(input: {
    account: FilesystemAccountEnvelope
    actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
    rootPath: string
    surface?: FilesystemCapabilityGrant['surface']
  }): FilesystemCapabilityGrant {
    this.assertActiveEnvelope(input.account)
    validateActor(input.actor)
    const canonicalRoot = realpathSync(input.rootPath)
    const rootStat = statSync(canonicalRoot)

    if (!rootStat.isDirectory()) {
      throw new Error('filesystem_scope_root_not_directory')
    }

    const grant: FilesystemCapabilityGrant = {
      grantId: randomUUID(),
      accountId: input.account.accountId,
      accountGeneration: input.account.accountGeneration,
      actor: input.actor,
      capability: 'filesystem.read',
      scope: { kind: 'filesystem-root', canonicalRoot, operations: ['read'] },
      expiresAt: null,
      revocationGeneration: this.revocationGeneration,
      surface: input.surface ?? 'backend'
    }

    this.grants.set(grant.grantId, {
      grant,
      rootIdentity: fileIdentity(rootStat),
      revoked: false,
      consumed: false
    })
    this.audit('request', grant, canonicalRoot, 'requested')
    this.audit('allow', grant, canonicalRoot, 'issued')

    return grant
  }

  /**
   * Trusted-main issuance seam for one explicit personal-assistant write.
   * No renderer or backend route calls this method: S3 may later bind its
   * visible approval flow to this main-owned contract without widening the
   * unchanged Hermes tool schema.
   */
  issueWriteGrant(input: {
    account: FilesystemAccountEnvelope
    actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
    resourcePath: string
    expiresAt: number
    maxBytes?: number
    operationId?: string
  }): FilesystemWriteGrant {
    this.assertActiveEnvelope(input.account)
    validateActor(input.actor)

    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now()) {
      throw new Error('invalid_write_capability_request')
    }

    if (input.operationId !== undefined && !input.operationId.trim()) {
      throw new Error('invalid_write_capability_request')
    }

    const active = this.active!
    const canonicalRoot = realpathSync(active.paths.workspaceRoot)
    const rootStat = statSync(canonicalRoot)
    const canonicalPath = this.resolveWriteCandidate(canonicalRoot, input.resourcePath)
    const extension = path.extname(canonicalPath).toLocaleLowerCase('en-US')
    const maxBytes = input.maxBytes ?? 1024 * 1024

    if (!['.md', '.txt'].includes(extension) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('CAPABILITY_DENIED')
    }

    const grant: FilesystemWriteGrant = {
      grantId: randomUUID(),
      accountId: input.account.accountId,
      accountGeneration: input.account.accountGeneration,
      actor: input.actor,
      capability: 'filesystem.write',
      scope: {
        kind: 'filesystem-file',
        canonicalPath,
        canonicalRoot,
        maxBytes,
        operations: ['write']
      },
      expiresAt: input.expiresAt,
      revocationGeneration: this.revocationGeneration,
      surface: 'backend',
      ...(input.operationId ? { operationId: input.operationId } : {})
    }

    this.grants.set(grant.grantId, {
      grant,
      rootIdentity: fileIdentity(rootStat),
      revoked: false,
      consumed: false
    })
    this.audit('request', grant, canonicalPath, 'requested')
    this.audit('allow', grant, canonicalPath, 'issued')

    return grant
  }

  issueApprovedWriteGrant(input: {
    account: FilesystemAccountEnvelope
    actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
    resourcePath: string
    contentByteSize: number
    operationId: string
  }): void {
    if (
      !Number.isSafeInteger(input.contentByteSize) ||
      input.contentByteSize < 0 ||
      input.contentByteSize > MAX_APPROVED_WRITE_BYTES ||
      !input.operationId.trim()
    ) {
      throw new Error('CAPABILITY_DENIED')
    }

    this.issueWriteGrant({
      account: input.account,
      actor: input.actor,
      resourcePath: input.resourcePath,
      expiresAt: this.now() + APPROVED_WRITE_GRANT_TTL_MS,
      maxBytes: Math.max(1, input.contentByteSize),
      operationId: input.operationId
    })
  }

  /**
   * Describe one workspace write for Hermes's approval card without minting
   * or recording anything. Uses the same canonicalization, type, and size
   * rules as the write itself so the card never describes a write main would
   * later refuse.
   */
  describeWorkspaceWrite(input: {
    account: FilesystemAccountEnvelope
    actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
    /** Present for symmetry with the other broker routes; describe mints nothing. */
    agentId?: string
    resourcePath: string
    contentByteSize: number
    operationId: string
  }): WorkspaceWriteDescription {
    try {
      const resolved = this.resolveApprovedWriteRequest(input)
      let existingByteSize = 0
      let disposition: 'create' | 'overwrite' = 'create'

      try {
        const existing = lstatSync(resolved.canonicalPath)

        if (existing.isFile() && !existing.isSymbolicLink()) {
          existingByteSize = existing.size
          disposition = 'overwrite'
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      const verb = disposition === 'overwrite' ? 'Overwrite' : 'Create'

      return {
        ok: true,
        version: 1,
        consent: 'workspace.write',
        ruleKey: atumConsentRuleKey(this.active!.paths.accountKey, 'workspace.write'),
        intendedEffect: `${verb} ${resolved.workspaceRelativePath} (${formatByteSize(input.contentByteSize)}) in your workspace`,
        workspaceRelativePath: resolved.workspaceRelativePath,
        disposition,
        byteSize: input.contentByteSize,
        existingByteSize
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''

      return {
        ok: false,
        code:
          code === 'capability_scope_escape' || code === 'CAPABILITY_SCOPE_ESCAPE'
            ? 'CAPABILITY_SCOPE_ESCAPE'
            : code === 'CAPABILITY_UNSUPPORTED_TYPE'
              ? 'CAPABILITY_UNSUPPORTED_TYPE'
              : code === 'CAPABILITY_TOO_LARGE'
                ? 'CAPABILITY_TOO_LARGE'
                : code === 'CAPABILITY_STALE'
                  ? 'CAPABILITY_STALE'
                  : 'CAPABILITY_DENIED'
      }
    }
  }

  /** Resolve and validate a candidate for trusted-main approval copy. */
  resolveApprovedWriteRequest(input: {
    account: FilesystemAccountEnvelope
    actor: Extract<FilesystemCapabilityActor, { kind: 'personal' }>
    resourcePath: string
    contentByteSize: number
    operationId: string
  }): { canonicalPath: string; workspaceRelativePath: string } {
    this.assertActiveEnvelope(input.account)
    validateActor(input.actor)

    if (
      actorKey(input.actor) !== actorKey({ kind: 'personal', personalAgentId: DEFAULT_PERSONAL_AGENT_ID }) ||
      !Number.isSafeInteger(input.contentByteSize) ||
      input.contentByteSize < 0 ||
      !input.operationId.trim()
    ) {
      throw new Error('CAPABILITY_DENIED')
    }

    if (input.contentByteSize > MAX_APPROVED_WRITE_BYTES) {
      throw new Error('CAPABILITY_TOO_LARGE')
    }

    const canonicalRoot = realpathSync(this.active!.paths.workspaceRoot)
    const canonicalPath = this.resolveWriteCandidate(canonicalRoot, input.resourcePath)

    if (!['.md', '.txt'].includes(path.extname(canonicalPath).toLocaleLowerCase('en-US'))) {
      // Deliberately distinct from CAPABILITY_DENIED: the desktop outcome only
      // covers text files, and the caller may hand anything else to Hermes.
      throw new Error('CAPABILITY_UNSUPPORTED_TYPE')
    }

    return {
      canonicalPath,
      workspaceRelativePath: path.relative(canonicalRoot, canonicalPath)
    }
  }

  issueRendererIntent(input: { account: FilesystemAccountEnvelope; rootPath: string }): FilesystemRendererIntent {
    const intentId = randomBytes(32).toString('base64url')

    const actor = {
      kind: 'personal' as const,
      personalAgentId: `atum-trusted-renderer:${intentId}`
    }

    const grant = this.issueReadGrant({
      account: input.account,
      actor,
      rootPath: input.rootPath,
      surface: 'renderer-intent'
    })

    this.intents.set(intentId, {
      account: input.account,
      actor,
      canonicalRoot: grant.scope.canonicalRoot,
      grantId: grant.grantId
    })

    return {
      intentId,
      accountGeneration: input.account.accountGeneration,
      displayName: path.basename(grant.scope.canonicalRoot) || path.parse(grant.scope.canonicalRoot).root
    }
  }

  /**
   * Atum Office Phase 0: create one empty text document inside the active
   * account workspace with the first collision-free `<baseName> N<extension>`
   * name. Main owns naming and uses an exclusive create so two chats can never
   * receive the same file. Returns the workspace-relative path the renderer
   * may use as document identity; the absolute path stays in main.
   */
  createWorkspaceTextFile(input: { baseName: string; extension: '.md' | '.txt' }): {
    canonicalPath: string
    workspaceRelativePath: string
  } {
    if (!this.active) {
      throw new Error('CAPABILITY_REVOKED')
    }

    const baseName = String(input.baseName ?? '').trim()

    if (!baseName || baseName.length > 64 || /[\\/\0]/u.test(baseName) || baseName.startsWith('.')) {
      throw new Error('CAPABILITY_DENIED')
    }

    if (!['.md', '.txt'].includes(input.extension)) {
      throw new Error('CAPABILITY_DENIED')
    }

    const canonicalRoot = realpathSync(this.active.paths.workspaceRoot)

    for (let ordinal = 1; ordinal < 10_000; ordinal += 1) {
      const workspaceRelativePath = `${baseName} ${ordinal}${input.extension}`
      const candidate = path.join(canonicalRoot, workspaceRelativePath)
      let fd: number | null = null

      try {
        fd = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)

        return { canonicalPath: candidate, workspaceRelativePath }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Error('WORKSPACE_CREATE_FAILED')
        }
      } finally {
        if (fd !== null) {
          closeSync(fd)
        }
      }
    }

    throw new Error('WORKSPACE_CREATE_FAILED')
  }

  /** Import publication: a fully converted document appears atomically or not at all. */
  createWorkspaceTextDocument(input: { preferredStem: string; text: string }): {
    canonicalPath: string
    workspaceRelativePath: string
    displayName: string
  } {
    if (!this.active) {
      throw new Error('CAPABILITY_REVOKED')
    }

    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

    let stem = String(input.preferredStem ?? '')
      .normalize('NFC')
      .replace(/[\\/]/gu, ' ')
      .replace(/^\.+/u, '')
      .replace(/[. ]+$/u, '')
      .trim()

    stem = Array.from(stem)
      .filter(character => {
        const codePoint = character.codePointAt(0) ?? 0

        return codePoint > 31 && codePoint !== 127
      })
      .join('')

    stem = Array.from(stem)
      .slice(0, 80)
      .join('')
      .replace(/[. ]+$/u, '')

    if (!stem || reserved.test(stem)) {
      stem = `Tài liệu ${stem || 'Word'}`
    }

    const bytes = Buffer.from(String(input.text ?? ''), 'utf8')

    if (bytes.byteLength > MAX_APPROVED_WRITE_BYTES) {
      throw new Error('WORKSPACE_FILE_TOO_LARGE')
    }

    const canonicalRoot = realpathSync(this.active.paths.workspaceRoot)
    const parentIdentity = `${statSync(canonicalRoot).dev}:${statSync(canonicalRoot).ino}`

    const parentFd = openSync(canonicalRoot, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))

    try {
      for (let ordinal = 1; ordinal < 10_000; ordinal += 1) {
        const displayName = `${stem}${ordinal === 1 ? '' : ` (${ordinal})`}.md`
        const target = this.resolveWriteCandidate(canonicalRoot, displayName)

        const temporary = path.join(
          canonicalRoot,
          `.${displayName}.atum-${process.pid}-${randomBytes(12).toString('hex')}`
        )

        let temporaryFd: number | null = null

        try {
          // Write everything to an exclusive temporary entry, then link it into
          // the final name: link(2) refuses an occupied name, so a foreign file
          // can never be replaced (a check-then-rename could race).
          temporaryFd = openSync(
            temporary,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
            0o600
          )
          writeFileSync(temporaryFd, bytes)
          fsyncSync(temporaryFd)
          const written = fstatSync(temporaryFd)
          closeSync(temporaryFd)
          temporaryFd = null

          const rootStat = fstatSync(parentFd)

          if (`${rootStat.dev}:${rootStat.ino}` !== parentIdentity) {
            throw new Error('WORKSPACE_CREATE_FAILED')
          }

          try {
            linkSync(temporary, target)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              continue
            }

            throw new Error('WORKSPACE_CREATE_FAILED')
          }

          // The link is the commit point; directory fsync is best-effort durability.
          try {
            fsyncSync(parentFd)
          } catch {
            // Best effort.
          }

          const published = lstatSync(target)

          if (
            !published.isFile() ||
            published.isSymbolicLink() ||
            `${published.dev}:${published.ino}` !== `${written.dev}:${written.ino}`
          ) {
            throw new Error('WORKSPACE_CREATE_FAILED')
          }

          return { canonicalPath: target, workspaceRelativePath: displayName, displayName }
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message === 'CAPABILITY_REVOKED' ? error.message : 'WORKSPACE_CREATE_FAILED'
          )
        } finally {
          try {
            if (temporaryFd !== null) {
              closeSync(temporaryFd)
            }
          } catch {
            // Closing failed; the unlink below still runs.
          } finally {
            try {
              unlinkSync(temporary)
            } catch {
              // Already gone.
            }
          }
        }
      }
    } finally {
      closeSync(parentFd)
    }

    throw new Error('WORKSPACE_CREATE_FAILED')
  }

  /** Resolve a workspace-relative `.md`/`.txt` document for re-leasing after a relaunch. */
  resolveWorkspaceTextFile(relativePath: string): { canonicalPath: string; workspaceRelativePath: string } {
    if (!this.active) {
      throw new Error('CAPABILITY_REVOKED')
    }

    const requested = String(relativePath ?? '').trim()

    if (!requested || path.isAbsolute(requested) || requested.split(/[\\/]/u).includes('..')) {
      throw new Error('CAPABILITY_SCOPE_ESCAPE')
    }

    const canonicalRoot = realpathSync(this.active.paths.workspaceRoot)
    let canonicalPath: string

    try {
      canonicalPath = this.resolveWriteCandidate(canonicalRoot, requested)
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message === 'capability_scope_escape'
          ? 'CAPABILITY_SCOPE_ESCAPE'
          : 'WORKSPACE_OPEN_FAILED'
      )
    }

    if (!['.md', '.txt'].includes(path.extname(canonicalPath).toLocaleLowerCase('en-US'))) {
      throw new Error('CAPABILITY_DENIED')
    }

    return {
      canonicalPath,
      workspaceRelativePath: path.relative(canonicalRoot, canonicalPath).split(path.sep).join('/')
    }
  }

  decide(input: FilesystemDecisionInput): FilesystemDecision {
    let actor: FilesystemCapabilityActor

    try {
      actor = input.actor
      validateActor(actor)
    } catch {
      return { allowed: false, code: 'CAPABILITY_DENIED' }
    }

    if (!this.active) {
      return { allowed: false, code: 'CAPABILITY_REVOKED' }
    }

    if (
      input.account.accountId !== this.active.accountId ||
      input.account.accountGeneration !== this.active.generation
    ) {
      return { allowed: false, code: 'CAPABILITY_STALE' }
    }

    const agentId = normalizedAgentId(input.agentId)

    if (!input.operationId || this.seenOperations.has(agentOperationKey(agentId, input.operationId))) {
      return { allowed: false, code: 'CAPABILITY_REPLAYED' }
    }

    this.rememberOperation(agentOperationKey(agentId, input.operationId))

    if (actor.kind !== 'personal' || !['filesystem.read', 'filesystem.write'].includes(input.capability)) {
      return { allowed: false, code: 'CAPABILITY_DENIED' }
    }

    const matching = [...this.grants.values()].filter(
      record =>
        !record.revoked &&
        !record.consumed &&
        record.grant.accountId === input.account.accountId &&
        record.grant.accountGeneration === input.account.accountGeneration &&
        actorKey(record.grant.actor) === actorKey(actor) &&
        record.grant.capability === input.capability &&
        (input.grantId ? input.grantId === record.grant.grantId : record.grant.surface === 'backend')
    )

    if (matching.length === 0) {
      return { allowed: false, code: 'CAPABILITY_DENIED' }
    }

    let allowed: { record: GrantRecord; resource: DecidedResource } | null = null
    let deniedCode: Extract<FilesystemDecision, { allowed: false }>['code'] = 'CAPABILITY_SCOPE_ESCAPE'

    for (const record of matching) {
      try {
        allowed = { record, resource: this.resolveGrantedResource(record, input) }

        break
      } catch (error) {
        const code = error instanceof Error ? error.message : ''

        if (code === 'CAPABILITY_EXPIRED' || code === 'CAPABILITY_TOO_LARGE' || code === 'CAPABILITY_DENIED') {
          deniedCode = code
        }
        // Try another independently scoped grant for the same actor. The final
        // result remains a single allow or one redacted scope denial.
      }
    }

    if (!allowed) {
      this.audit('deny', matching[0].grant, input.resourcePath, deniedCode, input.operationId)

      return { allowed: false, code: deniedCode }
    }

    this.audit('allow', allowed.record.grant, allowed.resource.canonicalPath, 'allowed', input.operationId)

    if (allowed.record.grant.capability === 'filesystem.write') {
      const receiptId = randomBytes(32).toString('base64url')
      this.consumeWriteGrant(allowed.record)
      this.writeReceipts.set(receiptId, {
        account: input.account,
        actorKey: actorKey(actor),
        agentId,
        canonicalPath: allowed.resource.canonicalPath,
        expiresAt: allowed.record.grant.expiresAt,
        grantId: allowed.record.grant.grantId,
        operationId: input.operationId
      })

      return {
        allowed: true,
        canonicalPath: allowed.resource.canonicalPath,
        grantId: allowed.record.grant.grantId,
        writeReceiptId: receiptId,
        writeReceiptExpiresAt: allowed.record.grant.expiresAt
      }
    }

    return {
      allowed: true,
      canonicalPath: allowed.resource.canonicalPath,
      grantId: allowed.record.grant.grantId
    }
  }

  consumeWriteReceipt(input: {
    account: FilesystemAccountEnvelope
    actor: FilesystemCapabilityActor
    agentId?: string
    operationId: string
    receiptId: string
  }): { canonicalPath: string } | { code: Extract<FilesystemDecision, { allowed: false }>['code'] } {
    const receipt = this.writeReceipts.get(input.receiptId)

    if (receipt && receipt.agentId !== normalizedAgentId(input.agentId)) {
      // Another agent's receipt. Leave it in place — the agent that earned it
      // may still be about to use it — and refuse this caller.
      return { code: 'CAPABILITY_DENIED' }
    }

    this.writeReceipts.delete(input.receiptId)

    if (!receipt) {
      return { code: 'CAPABILITY_REPLAYED' }
    }

    const grantRecord = this.grants.get(receipt.grantId)
    this.grants.delete(receipt.grantId)

    if (!this.active || !grantRecord || grantRecord.revoked || !grantRecord.consumed) {
      return { code: 'CAPABILITY_REVOKED' }
    }

    if (
      input.account.accountId !== this.active.accountId ||
      input.account.accountGeneration !== this.active.generation ||
      receipt.account.accountId !== input.account.accountId ||
      receipt.account.accountGeneration !== input.account.accountGeneration ||
      receipt.actorKey !== actorKey(input.actor)
    ) {
      return { code: 'CAPABILITY_STALE' }
    }

    if (receipt.operationId !== input.operationId) {
      return { code: 'CAPABILITY_REPLAYED' }
    }

    if (receipt.expiresAt <= this.now()) {
      return { code: 'CAPABILITY_EXPIRED' }
    }

    this.audit('allow', grantRecord.grant, receipt.canonicalPath, 'completed', input.operationId)

    return { canonicalPath: receipt.canonicalPath }
  }

  readRendererIntent(intentId: string, relativePath: string): FilesystemRendererReadResult {
    const intent = this.intents.get(intentId)

    if (!intent) {
      throw new Error('CAPABILITY_REPLAYED')
    }

    this.intents.delete(intentId)
    const requestedPath = path.resolve(intent.canonicalRoot, String(relativePath || '.'))
    const operationId = `renderer:${randomUUID()}`

    try {
      const decision = this.decide({
        account: intent.account,
        actor: intent.actor,
        capability: 'filesystem.read',
        grantId: intent.grantId,
        resourcePath: requestedPath,
        operationId
      })

      if (decision.allowed === false) {
        throw new Error(decision.code)
      }

      const before = statSync(decision.canonicalPath)

      if (!before.isFile()) {
        throw new Error('CAPABILITY_DENIED')
      }

      const fd = openSync(decision.canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))

      try {
        const opened = fstatSync(fd)

        if (fileIdentity(opened) !== fileIdentity(before)) {
          throw new Error('CAPABILITY_SCOPE_ESCAPE')
        }

        const buffer = readFileSync(fd)
        const bytes = buffer.subarray(0, MAX_RENDERER_READ_BYTES)

        return { byteSize: opened.size, text: bytes.toString('utf8'), truncated: opened.size > bytes.length }
      } finally {
        closeSync(fd)
      }
    } finally {
      this.revoke(intent.grantId)
    }
  }

  revoke(grantId: string): void {
    const record = this.grants.get(grantId)

    if (!record || record.revoked) {
      return
    }

    record.revoked = true
    this.revocationGeneration += 1
    this.auditBestEffort('revoke', record.grant, record.grant.scope.canonicalRoot, 'revoked')
  }

  private consumeWriteGrant(record: GrantRecord): void {
    record.consumed = true

    const resource =
      record.grant.capability === 'filesystem.write'
        ? record.grant.scope.canonicalPath
        : record.grant.scope.canonicalRoot

    this.auditBestEffort('revoke', record.grant, resource, 'decision_consumed')
  }

  revokeAccount(account: FilesystemAccountEnvelope): void {
    if (!this.active) {
      return
    }

    if (this.active.accountId !== account.accountId || this.active.generation !== account.accountGeneration) {
      throw new Error('CAPABILITY_STALE')
    }

    this.revokeAll()
    this.active = null
  }

  /** Account-scoped export telemetry. Values are bounded metadata only. */
  auditOfficeExport(input: {
    operation: 'export-document'
    format: string
    durationMs: number
    inputBytes: number
    outputBytes: number
    resultCode: string
    themeId?: string
    themeSchemaVersion?: number
    themeRevision?: number
  }): void {
    if (!this.active) {
      return
    }

    const active = this.active
    mkdirSync(path.dirname(active.paths.capabilityAuditLog), { recursive: true, mode: 0o700 })

    const record = {
      version: 1,
      at: new Date().toISOString(),
      accountKey: active.paths.accountKey,
      accountGeneration: active.generation,
      event: 'allow',
      capability: 'filesystem.export',
      operation: input.operation,
      format: input.format,
      durationMs: Math.max(0, Math.floor(input.durationMs)),
      inputBytes: Math.max(0, Math.floor(input.inputBytes)),
      outputBytes: Math.max(0, Math.floor(input.outputBytes)),
      reason: /^[A-Z0-9_]+$|^ok$/u.test(input.resultCode) ? input.resultCode : 'EXPORT_PUBLISH_FAILED',
      // Theme provenance is bounded exactly as the reason string is: a closed
      // catalogue id and two integers, never a font name or anything else a
      // corrupt metadata file could have carried into the audit log.
      ...(isDocumentThemeId(input.themeId)
        ? {
            themeId: input.themeId,
            themeRevision: Math.max(0, Math.floor(input.themeRevision ?? 0)),
            themeSchemaVersion: Math.max(0, Math.floor(input.themeSchemaVersion ?? 0))
          }
        : {})
    }

    const appendAudit = this.options.appendAudit ?? appendFileSync
    appendAudit(active.paths.capabilityAuditLog, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(active.paths.capabilityAuditLog, 0o600)
  }

  /** One bounded, path-redacted record for every Word import attempt. */
  auditOfficeImport(input: { durationMs: number; inputBytes: number; outputBytes: number; resultCode: string }): void {
    if (!this.active) {
      return
    }

    const active = this.active
    mkdirSync(path.dirname(active.paths.capabilityAuditLog), { recursive: true, mode: 0o700 })

    const record = {
      version: 1,
      at: new Date().toISOString(),
      accountKey: active.paths.accountKey,
      accountGeneration: active.generation,
      event: input.resultCode === 'ok' ? 'allow' : 'deny',
      capability: 'filesystem.import',
      operation: 'import-docx',
      durationMs: Math.max(0, Math.floor(input.durationMs)),
      inputBytes: Math.max(0, Math.floor(input.inputBytes)),
      outputBytes: Math.max(0, Math.floor(input.outputBytes)),
      reason: /^DOCX_IMPORT_[A-Z_]+$|^ok$/u.test(input.resultCode) ? input.resultCode : 'DOCX_IMPORT_FAILED'
    }

    const appendAudit = this.options.appendAudit ?? appendFileSync
    appendAudit(active.paths.capabilityAuditLog, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(active.paths.capabilityAuditLog, 0o600)
  }

  private assertActiveEnvelope(account: FilesystemAccountEnvelope): void {
    if (
      !this.active ||
      this.active.accountId !== account.accountId ||
      this.active.generation !== account.accountGeneration
    ) {
      throw new Error('CAPABILITY_STALE')
    }
  }

  private audit(
    event: 'allow' | 'deny' | 'request' | 'revoke',
    grant: FilesystemGrant,
    resource: string,
    reason: string,
    operationId?: string
  ): void {
    const active = this.active

    if (!active || active.accountId !== grant.accountId || active.generation !== grant.accountGeneration) {
      return
    }

    mkdirSync(path.dirname(active.paths.capabilityAuditLog), { recursive: true, mode: 0o700 })
    chmodSync(path.dirname(active.paths.capabilityAuditLog), 0o700)

    const record = {
      version: 1,
      at: new Date().toISOString(),
      accountKey: active.paths.accountKey,
      accountGeneration: active.generation,
      event,
      actorKind: grant.actor.kind,
      capability: grant.capability,
      grant: redactedId(grant.grantId),
      operation: operationId ? redactedId(operationId) : null,
      resource: redactedId(resource),
      reason
    }

    const appendAudit = this.options.appendAudit ?? appendFileSync
    appendAudit(active.paths.capabilityAuditLog, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(active.paths.capabilityAuditLog, 0o600)
  }

  private rememberOperation(operationId: string): void {
    this.seenOperations.add(operationId)

    if (this.seenOperations.size <= MAX_SEEN_OPERATIONS) {
      return
    }

    const oldest = this.seenOperations.values().next().value

    if (typeof oldest === 'string') {
      this.seenOperations.delete(oldest)
    }
  }

  private resolveGrantedResource(record: GrantRecord, input: FilesystemDecisionInput): DecidedResource {
    const rootStat = statSync(record.grant.scope.canonicalRoot)

    if (!rootStat.isDirectory() || fileIdentity(rootStat) !== record.rootIdentity) {
      throw new Error('capability_root_changed')
    }

    if (record.grant.capability === 'filesystem.write') {
      if (record.grant.operationId && record.grant.operationId !== input.operationId) {
        throw new Error('CAPABILITY_DENIED')
      }

      if (!Number.isSafeInteger(input.contentByteSize) || input.contentByteSize! < 0) {
        throw new Error('CAPABILITY_DENIED')
      }

      if (record.grant.expiresAt <= this.now()) {
        throw new Error('CAPABILITY_EXPIRED')
      }

      if (input.contentByteSize! > record.grant.scope.maxBytes) {
        throw new Error('CAPABILITY_TOO_LARGE')
      }

      const canonicalPath = this.resolveWriteCandidate(record.grant.scope.canonicalRoot, input.resourcePath)

      if (normalizedComparablePath(canonicalPath) !== normalizedComparablePath(record.grant.scope.canonicalPath)) {
        throw new Error('capability_scope_escape')
      }

      return { canonicalPath }
    }

    const canonicalPath = realpathSync(input.resourcePath)

    if (!pathIsWithin(record.grant.scope.canonicalRoot, canonicalPath)) {
      throw new Error('capability_scope_escape')
    }

    statSync(canonicalPath)

    return { canonicalPath }
  }

  private resolveWriteCandidate(canonicalRoot: string, requestedPath: string): string {
    const requested = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(canonicalRoot, requestedPath)

    const canonicalParent = realpathSync(path.dirname(requested))
    const canonicalPath = path.join(canonicalParent, path.basename(requested))

    if (!pathIsWithin(canonicalRoot, canonicalPath)) {
      throw new Error('capability_scope_escape')
    }

    try {
      const existing = lstatSync(canonicalPath)

      if (!existing.isFile() || existing.isSymbolicLink() || realpathSync(canonicalPath) !== canonicalPath) {
        throw new Error('capability_scope_escape')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    return canonicalPath
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private revokeAll(): void {
    const revoked: GrantRecord[] = []

    for (const record of this.grants.values()) {
      if (!record.revoked) {
        record.revoked = true
        revoked.push(record)
      }
    }

    this.grants.clear()
    this.intents.clear()
    this.writeReceipts.clear()
    this.seenOperations.clear()
    this.revocationGeneration += 1

    for (const record of revoked) {
      this.auditBestEffort('revoke', record.grant, record.grant.scope.canonicalRoot, 'account_quiesced')
    }
  }

  private auditBestEffort(event: 'revoke', grant: FilesystemGrant, resource: string, reason: string): void {
    try {
      this.audit(event, grant, resource, reason)
    } catch {
      // Revocation is the authority boundary and must not depend on audit I/O.
    }
  }
}

interface BackendCredential {
  utilityAccount?: FilesystemAccountEnvelope
  routeAccount?: FilesystemAccountEnvelope
  agentId: string
  /** Bumped every time that agent's backend is (re)spawned. */
  generation: number
  token: string
}

interface WorkspaceSourceReadPermit {
  account: FilesystemAccountEnvelope
  credentialToken: string
  expiresAt: number
  remaining: number
}

const WORKSPACE_SOURCE_PERMIT_MS = 120_000

/**
 * Authenticated loopback transport consumed by the bundled Python pre-tool hook.
 *
 * Every backend process gets its OWN bearer token, registered here against the
 * agent it was spawned for and the generation of that spawn. The agent identity
 * used for leases, receipts, replay slots, and audit is derived from that
 * registration, never from anything a caller sends, so one agent's backend
 * cannot present itself as another. Respawning an agent invalidates the old
 * credential; stopping one revokes it outright.
 *
 * Agents deliberately SHARE the account's document workspace (owner decision,
 * 2026-09-04). That sharing is a product feature, not an isolation boundary.
 * What is never shared is a lease, a write receipt, or a replay slot.
 */
export class AtumFilesystemActionBroker {
  private readonly server: http.Server
  private readonly credentials = new Map<string, BackendCredential>()
  private readonly generations = new Map<string, number>()
  /** Short-lived, session-specific grants earned by the protected model proxy. */
  private readonly workspaceSourceReadPermits = new Map<string, WorkspaceSourceReadPermit>()
  private baseUrl: string | null = null
  private starting: Promise<void> | null = null

  constructor(
    private readonly authority: AtumFilesystemCapabilityAuthority,
    private readonly assistantWrites?: AssistantWorkspaceWriteCompletionBroker,
    private readonly interactionAuthority?: AtumInteractionCapabilityAuthority,
    private readonly utilities?: {
      read(accountId: string, generation: number, input: Record<string, unknown>): Promise<unknown>
      write?(accountId: string, generation: number, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
      workspaceProtected?(): boolean
    }
  ) {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  async start(): Promise<void> {
    if (this.baseUrl) {
      return
    }

    if (this.starting) { return this.starting }
    this.starting = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once('error', onError)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError)
        const address = this.server.address()

        if (!address || typeof address === 'string') {
          reject(new Error('filesystem_broker_address_unavailable'))

          return
        }

        this.baseUrl = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })

    try { await this.starting } finally { this.starting = null }
  }

  async stop(): Promise<void> {
    if (!this.server.listening) {
      this.baseUrl = null
      this.workspaceSourceReadPermits.clear()

      return
    }

    await new Promise<void>(resolve => this.server.close(() => resolve()))
    this.baseUrl = null
    this.workspaceSourceReadPermits.clear()
  }

  /**
   * Mint the environment for one backend spawn. Each call issues a fresh
   * credential for that agent and retires the agent's previous one, so a
   * respawned backend cannot be impersonated by the process it replaced.
   */
  backendEnvironment(agentId: string = DEFAULT_AGENT_ID, personalUtilities = false): Record<string, string> {
    if (!this.baseUrl) {
      return { ATUM_FILESYSTEM_CAPABILITY_REQUIRED: '1' }
    }

    const credential = this.issueBackendCredential(agentId, personalUtilities)

    return {
      ATUM_FILESYSTEM_BROKER_TOKEN: credential.token,
      ATUM_FILESYSTEM_BROKER_URL: this.baseUrl,
      ATUM_FILESYSTEM_CAPABILITY_REQUIRED: '1'
    }
  }

  /**
   * The managed-model proxy calls this only after the platform has confirmed a
   * protected Workspace route and the response requested tools. The permit is
   * tied to this backend credential and Hermes session, so a parallel session
   * using another provider cannot consume it.
   */
  privateRequestLive(token: unknown): () => boolean {
    const credential = typeof token === 'string' ? this.resolveCredential(`Bearer ${token}`) : null
    const bound = credential?.routeAccount

    return () => {
      const current = this.authority.currentAuthority()?.account

      return Boolean(credential && bound && this.credentials.has(credential.token) && current
        && current.accountId === bound.accountId && current.accountGeneration === bound.accountGeneration)
    }
  }

  authorizeWorkspaceSourceRead(sessionId: string, requestedPermits: number, backendToken: unknown): void {
    const account = this.authority.currentAuthority()?.account
    const permits = Number.isSafeInteger(requestedPermits) ? Math.min(Math.max(requestedPermits, 1), 5) : 1

    if (!account || !SESSION_ID_PATTERN.test(sessionId)) { return }

    const credential = typeof backendToken === 'string' ? this.resolveCredential(`Bearer ${backendToken}`) : null

    if (!credential || credential.agentId !== DEFAULT_AGENT_ID
      || credential.utilityAccount?.accountId !== account.accountId
      || credential.utilityAccount.accountGeneration !== account.accountGeneration) { return }

    const key = `${credential.token}:${sessionId}`

    this.workspaceSourceReadPermits.set(key, {
      account: { ...account },
      credentialToken: credential.token,
      expiresAt: Date.now() + WORKSPACE_SOURCE_PERMIT_MS,
      remaining: permits,
    })
  }

  issueBackendCredential(agentId: string = DEFAULT_AGENT_ID, personalUtilities = false): BackendCredential {
    const agent = normalizedAgentId(agentId)
    this.revokeBackendCredential(agent)
    const generation = (this.generations.get(agent) ?? 0) + 1
    this.generations.set(agent, generation)
    const credential: BackendCredential = { agentId: agent, generation, token: randomBytes(32).toString('base64url'), routeAccount: this.authority.currentAuthority()?.account, utilityAccount: personalUtilities ? this.authority.currentAuthority()?.account : undefined }
    this.credentials.set(credential.token, credential)

    return credential
  }

  /** Re-home only a running primary backend without the current account binding. */
  needsUtilityRehome(account: FilesystemAccountEnvelope, backendRunning: boolean): boolean {
    if (!backendRunning) { return false }

    return !Array.from(this.credentials.values()).some(credential =>
      credential.agentId === DEFAULT_AGENT_ID && credential.utilityAccount?.accountId === account.accountId && credential.utilityAccount.accountGeneration === account.accountGeneration)
  }

  /** Drop an agent's credential when its backend stops or is replaced. */
  revokeBackendCredential(agentId: string = DEFAULT_AGENT_ID): void {
    const agent = normalizedAgentId(agentId)

    for (const [token, credential] of this.credentials) {
      if (credential.agentId === agent) {
        this.credentials.delete(token)

        for (const [key, permit] of this.workspaceSourceReadPermits) {
          if (permit.credentialToken === token) { this.workspaceSourceReadPermits.delete(key) }
        }
      }
    }
  }

  revokeAllBackendCredentials(): void {
    this.credentials.clear()
    this.workspaceSourceReadPermits.clear()
  }

  private consumeWorkspaceSourceRead(credential: BackendCredential, sessionId: string): boolean {
    const key = `${credential.token}:${sessionId}`
    const permit = this.workspaceSourceReadPermits.get(key)
    const account = credential.utilityAccount

    if (!permit || !account || permit.expiresAt <= Date.now()
        || permit.remaining < 1 || permit.credentialToken !== credential.token
        || permit.account.accountId !== account.accountId
        || permit.account.accountGeneration !== account.accountGeneration) {
      this.workspaceSourceReadPermits.delete(key)

      return false
    }

    permit.remaining -= 1

    if (permit.remaining === 0) { this.workspaceSourceReadPermits.delete(key) }

    return true
  }

  /** Constant-time bearer lookup. Returns the registration, never the caller's claim. */
  private resolveCredential(header: string | undefined): BackendCredential | null {
    for (const credential of this.credentials.values()) {
      if (safeBearerMatches(header, credential.token)) {
        return credential
      }
    }

    return null
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')

    const credential = this.resolveCredential(request.headers.authorization)

    if (!credential) {
      this.reply(response, 401, { allowed: false, code: 'CAPABILITY_DENIED' })

      return
    }

    const agentId = credential.agentId

    if (request.method === 'GET' && request.url === '/v1/utilities/route-authority') {
      const current = this.authority.currentAuthority()?.account
      const bound = credential.routeAccount

      if (!current || !bound || current.accountId !== bound.accountId || current.accountGeneration !== bound.accountGeneration || !this.utilities?.workspaceProtected) {
        this.reply(response, 403, { error: 'account_changed' })

        return
      }

      try {
        this.reply(response, 200, {
          protected: this.utilities.workspaceProtected(), workspaceAlias: 'binh-minh',
          accountKey: accountKeyFor(current.accountId), agentId,
        })
      }
      catch { this.reply(response, 503, { error: 'workspace_route_unavailable' }) }

      return
    }

    if (request.method === 'POST' && ['/v1/utilities/read', '/v1/utilities/write'].includes(request.url ?? '')) {
      const current = this.authority.currentAuthority()
      const bound = credential.utilityAccount

      if (!this.utilities || agentId !== DEFAULT_AGENT_ID || !current || !bound || bound.accountId !== current.account.accountId || bound.accountGeneration !== current.account.accountGeneration) {
        this.reply(response, 403, { error: 'account_changed' })

        return
      }

      try {
        const input = await this.readJson(request)

        if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new Error('invalid_input') }
        const { sessionId, ...utilityInput } = input as Record<string, unknown>

        if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) { throw new Error('invalid_input') }

        if (!this.consumeWorkspaceSourceRead(credential, sessionId)) {
          this.reply(response, 403, { error: 'workspace_model_required' })

          return
        }

        const operation = request.url === '/v1/utilities/write' ? this.utilities.write : this.utilities.read

        if (!operation) { throw new Error('unavailable') }
        const controller = new AbortController()

        const disconnected = () => { if (!response.writableEnded) { controller.abort() } }
        response.once('close', disconnected)
        let result: unknown

        try {
          result = await operation.call(this.utilities, bound.accountId, bound.accountGeneration, utilityInput, controller.signal)
        } finally { response.off('close', disconnected) }

        // The backend may have stopped while a remote read was in flight.
        if (!this.credentials.has(credential.token)) { throw new Error('account_changed') }
        this.reply(response, 200, result)
      } catch (error) {
        const code = error instanceof Error && ['account_changed', 'invalid_input', 'network', 'timeout', 'reconnect', 'unavailable', 'denied', 'cancelled', 'storage', 'conflict', 'unsupported', 'outcome_unknown'].includes(error.message) ? error.message : 'unavailable'
        this.reply(response, 400, { error: code })
      }

      return
    }

    if (request.method === 'POST' && request.url === '/v1/utilities/revoke-workspace-source-reads') {
      if (agentId !== DEFAULT_AGENT_ID) {
        this.reply(response, 403, { error: 'account_changed' })

        return
      }

      this.workspaceSourceReadPermits.clear()
      this.reply(response, 200, { revoked: true })

      return
    }

    if (request.method === 'GET' && request.url === '/v1/filesystem/authority') {
      const authority = this.authority.currentAuthority()

      this.reply(response, authority ? 200 : 403, authority ?? { allowed: false, code: 'CAPABILITY_REVOKED' })

      return
    }

    if (request.method === 'POST' && request.url === '/v1/filesystem/describe-write') {
      try {
        const body = (await this.readJson(request)) as {
          account?: FilesystemAccountEnvelope
          actor?: FilesystemCapabilityActor
          contentByteSize?: unknown
          operationId?: unknown
          resourcePath?: unknown
          sessionId?: unknown
        }

        const current = this.authority.currentAuthority()

        if (
          !current ||
          body.account?.accountId !== current.account.accountId ||
          body.account?.accountGeneration !== current.account.accountGeneration ||
          actorKey(body.actor as FilesystemCapabilityActor) !== actorKey(current.actor) ||
          typeof body.operationId !== 'string' ||
          !body.operationId.trim() ||
          typeof body.resourcePath !== 'string' ||
          !body.resourcePath ||
          typeof body.sessionId !== 'string' ||
          !SESSION_ID_PATTERN.test(body.sessionId) ||
          !Number.isSafeInteger(body.contentByteSize) ||
          (body.contentByteSize as number) < 0
        ) {
          throw new Error('invalid_write_description')
        }

        this.reply(
          response,
          200,
          this.authority.describeWorkspaceWrite({
            account: current.account,
            actor: current.actor,
            agentId,
            contentByteSize: body.contentByteSize as number,
            operationId: body.operationId,
            resourcePath: body.resourcePath
          })
        )
      } catch {
        this.reply(response, 400, { ok: false, code: 'CAPABILITY_DENIED' })
      }

      return
    }

    if (request.method === 'POST' && request.url === '/v1/filesystem/request-write') {
      if (!this.assistantWrites) {
        this.reply(response, 403, { ok: false, code: 'CAPABILITY_DENIED' })

        return
      }

      try {
        const body = (await this.readJson(request, MAX_WRITE_BROKER_BODY_BYTES)) as {
          account?: FilesystemAccountEnvelope
          actor?: FilesystemCapabilityActor
          approval?: unknown
          content?: string
          operationId?: string
          resourcePath?: string
          sessionId?: string
        }

        const current = this.authority.currentAuthority()

        if (
          !current ||
          body.account?.accountId !== current.account.accountId ||
          body.account?.accountGeneration !== current.account.accountGeneration ||
          actorKey(body.actor as FilesystemCapabilityActor) !== actorKey(current.actor) ||
          typeof body.operationId !== 'string' ||
          !body.operationId ||
          typeof body.resourcePath !== 'string' ||
          !body.resourcePath ||
          typeof body.content !== 'string' ||
          typeof body.sessionId !== 'string' ||
          !SESSION_ID_PATTERN.test(body.sessionId)
        ) {
          throw new Error('invalid_write_request')
        }

        // Consent is settled by Hermes's approval gate before the runtime
        // asks main to write. The assertion is required for shape; the
        // per-process broker token is the runtime authority behind it.
        if (!isHermesApproval(body.approval)) {
          this.reply(response, 403, { ok: false, code: 'CAPABILITY_DENIED' })

          return
        }

        const clientConnection = new AbortController()

        const abortForDisconnectedClient = () => {
          if (!response.writableEnded) {
            clientConnection.abort()
          }
        }

        response.once('close', abortForDisconnectedClient)

        let writeResult: AssistantWorkspaceTextResultV1

        try {
          writeResult = await this.assistantWrites.requestWrite({
            account: current.account,
            actor: current.actor,
            agentId,
            content: body.content,
            operationId: body.operationId,
            resourcePath: body.resourcePath,
            sessionId: body.sessionId,
            abortSignal: clientConnection.signal
          })
        } finally {
          response.off('close', abortForDisconnectedClient)
        }

        if (writeResult.outcome !== 'success') {
          this.reply(response, 400, {
            ok: false,
            code: 'CAPABILITY_DENIED',
            rendererMessage: writeResult.rendererMessage
          })

          return
        }

        this.reply(response, 200, { ok: true })
      } catch {
        this.reply(response, 400, { ok: false, code: 'CAPABILITY_DENIED' })
      }

      return
    }

    if (request.method === 'POST' && request.url === '/v1/interaction/describe') {
      if (!this.interactionAuthority) {
        this.reply(response, 403, { ok: false, code: 'CAPABILITY_DENIED' })

        return
      }

      try {
        const body = (await this.readJson(request)) as Partial<InteractionCapabilityDescribeInput>
        const current = this.authority.currentAuthority()

        if (
          !current ||
          body.account?.accountId !== current.account.accountId ||
          body.account?.accountGeneration !== current.account.accountGeneration ||
          actorKey(body.actor as FilesystemCapabilityActor) !== actorKey(current.actor) ||
          typeof body.runtimeSessionId !== 'string' ||
          !SESSION_ID_PATTERN.test(body.runtimeSessionId) ||
          typeof body.toolName !== 'string' ||
          !body.toolName.trim() ||
          !body.toolArgs ||
          typeof body.toolArgs !== 'object' ||
          Array.isArray(body.toolArgs)
        ) {
          throw new Error('invalid_interaction_description')
        }

        this.reply(
          response,
          200,
          this.interactionAuthority.describe({
            account: current.account,
            actor: current.actor,
            agentId,
            runtimeSessionId: body.runtimeSessionId,
            toolName: body.toolName,
            toolArgs: body.toolArgs as Record<string, unknown>
          })
        )
      } catch {
        this.reply(response, 400, { ok: false, code: 'CAPABILITY_DENIED' })
      }

      return
    }

    if (request.method === 'POST' && request.url === '/v1/interaction/request-use') {
      if (!this.interactionAuthority) {
        this.reply(response, 403, { allowed: false, code: 'CAPABILITY_DENIED' })

        return
      }

      try {
        const body = (await this.readJson(request)) as Partial<InteractionCapabilityUseInput>
        const current = this.authority.currentAuthority()

        if (
          !current ||
          body.account?.accountId !== current.account.accountId ||
          body.account?.accountGeneration !== current.account.accountGeneration ||
          actorKey(body.actor as FilesystemCapabilityActor) !== actorKey(current.actor) ||
          typeof body.operationId !== 'string' ||
          !body.operationId.trim() ||
          typeof body.runtimeSessionId !== 'string' ||
          !SESSION_ID_PATTERN.test(body.runtimeSessionId) ||
          typeof body.toolName !== 'string' ||
          !body.toolName.trim() ||
          !body.toolArgs ||
          typeof body.toolArgs !== 'object' ||
          Array.isArray(body.toolArgs) ||
          !Number.isSafeInteger(body.durationMs)
        ) {
          throw new Error('invalid_interaction_request')
        }

        this.reply(
          response,
          200,
          this.interactionAuthority.requestUse({
            account: current.account,
            actor: current.actor,
            agentId,
            operationId: body.operationId,
            runtimeSessionId: body.runtimeSessionId,
            toolName: body.toolName,
            toolArgs: body.toolArgs as Record<string, unknown>,
            durationMs: body.durationMs as number,
            approval: body.approval
          })
        )
      } catch {
        this.reply(response, 400, { allowed: false, code: 'CAPABILITY_DENIED' })
      }

      return
    }

    if (request.method === 'POST' && request.url === '/v1/interaction/finish-use') {
      if (!this.interactionAuthority) {
        this.reply(response, 403, { allowed: false, code: 'CAPABILITY_DENIED' })

        return
      }

      try {
        const body = (await this.readJson(request)) as {
          operationId?: unknown
          completedOperation?: unknown
          runtimeSessionId?: unknown
        }

        if (
          typeof body.operationId !== 'string' ||
          !body.operationId.trim() ||
          typeof body.runtimeSessionId !== 'string' ||
          !SESSION_ID_PATTERN.test(body.runtimeSessionId) ||
          typeof body.completedOperation !== 'boolean'
        ) {
          throw new Error('invalid_interaction_completion')
        }

        this.reply(
          response,
          200,
          this.interactionAuthority.finishUse(body.runtimeSessionId, body.operationId, body.completedOperation, agentId)
        )
      } catch {
        this.reply(response, 400, { allowed: false, code: 'CAPABILITY_DENIED' })
      }

      return
    }

    if (request.method !== 'POST' || request.url !== '/v1/filesystem/decide') {
      this.reply(response, 404, { allowed: false, code: 'CAPABILITY_DENIED' })

      return
    }

    try {
      const body = await this.readJson(request)
      const input = body as FilesystemDecisionInput & { sessionId?: string }

      if (input.capability === 'filesystem.write') {
        this.reply(response, 200, { allowed: false, code: 'CAPABILITY_DENIED' })

        return
      }

      const decision = this.authority.decide({ ...input, agentId })

      this.reply(response, 200, decision)
    } catch {
      this.reply(response, 400, { allowed: false, code: 'CAPABILITY_DENIED' })
    }
  }

  private readJson(request: IncomingMessage, maximumBytes = MAX_BROKER_BODY_BYTES): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0

      request.on('data', chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length

        if (size > maximumBytes) {
          reject(new Error('filesystem_broker_body_too_large'))
          request.destroy()

          return
        }

        chunks.push(bytes)
      })
      request.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
      request.on('error', reject)
    })
  }

  private reply(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status
    response.end(JSON.stringify(body))
  }
}

export { DEFAULT_PERSONAL_AGENT_ID, safeBearerMatches }
