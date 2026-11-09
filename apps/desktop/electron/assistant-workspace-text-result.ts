import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  type AtumFilesystemCapabilityAuthority,
  type FilesystemAccountEnvelope,
  type FilesystemCapabilityActor,
  type FilesystemDecision
} from './atum-filesystem-capability'
import {
  commitAnchoredTextWrite,
  prepareAnchoredTextWrite,
  type WorkspaceTextFileLeaseDescriptor,
  type WorkspaceTextFileLeaseProvider
} from './workspace-text-file-lease'

const MAX_ASSISTANT_TEXT_BYTES = 1024 * 1024

export type AssistantWorkspaceTextFailureCode =
  | 'permission_required'
  | 'permission_denied'
  | 'permission_expired'
  | 'account_stale'
  | 'scope_escape'
  | 'conflict'
  | 'too_large'
  | 'io_failed'

export interface AssistantWorkspaceTextSuccessV1 {
  version: 1
  kind: 'workspace_text_file'
  outcome: 'success'
  descriptor: WorkspaceTextFileLeaseDescriptor
}

export interface AssistantWorkspaceTextFailureV1 {
  version: 1
  kind: 'workspace_text_file'
  outcome: 'failure'
  code: AssistantWorkspaceTextFailureCode
  retryable: boolean
  rendererMessage: string
  incidentRef?: string
}

export type AssistantWorkspaceTextResultV1 = AssistantWorkspaceTextSuccessV1 | AssistantWorkspaceTextFailureV1

export interface AssistantWorkspaceTextCompletionV1 {
  account: FilesystemAccountEnvelope
  actor: FilesystemCapabilityActor
  operationId: string
  receiptId: string
  sessionId: string
  status: 'error' | 'ok'
  toolName: 'write_file'
}

export interface AssistantWorkspaceTextPublishedV1 {
  sessionId: string
  toolCallId: string
  result: AssistantWorkspaceTextResultV1
}

export interface AssistantWorkspaceTextResultWindow {
  isDestroyed(): boolean
  webContents: {
    id: number
    isDestroyed(): boolean
    send(channel: string, event: AssistantWorkspaceTextPublishedV1): void
  }
}

export function publishAssistantWorkspaceTextResultToWindows(
  windows: readonly AssistantWorkspaceTextResultWindow[],
  event: AssistantWorkspaceTextPublishedV1
): readonly string[] {
  const recipients: string[] = []

  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue
    }

    try {
      window.webContents.send('atum:filesystem:assistant-text-result', event)
      recipients.push(String(window.webContents.id))
    } catch {
      // A window can disappear between enumeration and send. Continue so a
      // secondary live session still receives the account-bound outcome.
    }
  }

  return recipients
}

interface AssistantLeaseDelivery {
  adopter: string | null
  dismissed: Set<string>
  recipients: Set<string>
  timer: ReturnType<typeof setTimeout>
}

export interface AssistantWorkspaceTextResultProviderOptions {
  adoptionTimeoutMs?: number
}

const FAILURE_COPY: Record<AssistantWorkspaceTextFailureCode, { retryable: boolean; rendererMessage: string }> = {
  permission_required: {
    retryable: true,
    rendererMessage: 'Allow this file write, then try again.'
  },
  permission_denied: {
    retryable: true,
    rendererMessage: 'The file write was not allowed.'
  },
  permission_expired: {
    retryable: true,
    rendererMessage: 'The file permission expired. Try again.'
  },
  account_stale: {
    retryable: true,
    rendererMessage: 'The account changed before the file was ready. Try again.'
  },
  scope_escape: {
    retryable: false,
    rendererMessage: 'That file is outside the allowed workspace.'
  },
  conflict: {
    retryable: true,
    rendererMessage: 'The file changed before the write completed.'
  },
  too_large: {
    retryable: false,
    rendererMessage: 'This text file is too large to open here.'
  },
  io_failed: {
    retryable: true,
    rendererMessage: 'The file could not be prepared. Try again.'
  }
}

function failure(code: AssistantWorkspaceTextFailureCode, incidentSeed?: string): AssistantWorkspaceTextFailureV1 {
  const copy = FAILURE_COPY[code]

  return {
    version: 1,
    kind: 'workspace_text_file',
    outcome: 'failure',
    code,
    retryable: copy.retryable,
    rendererMessage: copy.rendererMessage,
    ...(incidentSeed
      ? { incidentRef: createHash('sha256').update('atum-write-incident-v1\0').update(incidentSeed).digest('hex').slice(0, 20) }
      : {})
  }
}

function decisionFailureCode(decision: Extract<FilesystemDecision, { allowed: false }>): AssistantWorkspaceTextFailureCode {
  switch (decision.code) {
    case 'CAPABILITY_REPLAYED':

    case 'CAPABILITY_REVOKED':

    case 'CAPABILITY_EXPIRED':
      return 'permission_expired'

    case 'CAPABILITY_TOO_LARGE':
      return 'too_large'

    case 'CAPABILITY_STALE':
      return 'account_stale'

    case 'CAPABILITY_SCOPE_ESCAPE':
      return 'scope_escape'

    default:
      return 'permission_required'
  }
}

/** Main-owned receipt-to-lease completion seam. */
export class AssistantWorkspaceTextResultProvider {
  private readonly claimedOperations = new Set<string>()
  private readonly deliveries = new Map<string, AssistantLeaseDelivery>()
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly authority: AtumFilesystemCapabilityAuthority,
    private readonly leases: WorkspaceTextFileLeaseProvider,
    private readonly publish: (event: AssistantWorkspaceTextPublishedV1) => readonly string[] = () => [],
    private readonly options: AssistantWorkspaceTextResultProviderOptions = {}
  ) {}

  /**
   * Perform one already-approved workspace text write.
   *
   * Consent has been settled by Hermes's approval gate before this is called,
   * so there is no human wait here: the write is bound to the account,
   * canonicalized, size- and type-checked, replay-protected, anchored against
   * concurrent modification, receipted, committed, and published.
   */
  async requestWrite(input: {
    account: FilesystemAccountEnvelope
    actor: FilesystemCapabilityActor
    /** Agent whose backend earned this write; only it may consume the receipt. */
    agentId?: string
    content: string
    operationId: string
    resourcePath: string
    sessionId: string
    abortSignal?: AbortSignal
  }): Promise<AssistantWorkspaceTextResultV1> {
    const byteSize = Buffer.byteLength(input.content, 'utf8')
    let result: AssistantWorkspaceTextResultV1
    let descriptor: WorkspaceTextFileLeaseDescriptor | null = null

    try {
      if (input.actor.kind !== 'personal' || !input.sessionId.trim() || !input.operationId.trim()) {
        throw new Error('CAPABILITY_DENIED')
      }

      if (this.claimedOperations.has(input.operationId)) {
        throw new Error('CAPABILITY_REPLAYED')
      }

      this.claimedOperations.add(input.operationId)

      if (this.claimedOperations.size > 10_000) {
        const oldest = this.claimedOperations.values().next().value

        if (typeof oldest === 'string') {
          this.claimedOperations.delete(oldest)
        }
      }

      const resolved = this.authority.resolveApprovedWriteRequest({
        account: input.account,
        actor: input.actor,
        contentByteSize: byteSize,
        operationId: input.operationId,
        resourcePath: input.resourcePath
      })

      const plan = prepareAnchoredTextWrite(resolved.canonicalPath)

      if (input.abortSignal?.aborted) {
        // The Hermes runtime gave up on the request before the write started;
        // do not write on behalf of a caller that will never see the outcome.
        result = failure('permission_expired', input.operationId)
      } else {
        this.authority.issueApprovedWriteGrant({
          account: input.account,
          actor: input.actor,
          contentByteSize: byteSize,
          operationId: input.operationId,
          resourcePath: resolved.canonicalPath
        })

        const decision = this.authority.decide({
          account: input.account,
          actor: input.actor,
          agentId: input.agentId,
          capability: 'filesystem.write',
          contentByteSize: byteSize,
          operationId: input.operationId,
          resourcePath: resolved.canonicalPath
        })

        if (decision.allowed === false) {
          result = failure(decisionFailureCode(decision), input.operationId)
        } else {
          const receipt = this.authority.consumeWriteReceipt({
            account: input.account,
            actor: input.actor,
            agentId: input.agentId,
            operationId: input.operationId,
            receiptId: decision.writeReceiptId
          })

          if ('code' in receipt) {
            result = failure(decisionFailureCode({ allowed: false, code: receipt.code }), input.operationId)
          } else {
            commitAnchoredTextWrite(plan, input.content)
            descriptor = this.leases.openLocal(receipt.canonicalPath)
            result = { version: 1, kind: 'workspace_text_file', outcome: 'success', descriptor }
          }
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      result = failure(
        code === 'CAPABILITY_REPLAYED' || code === 'CAPABILITY_EXPIRED'
          ? 'permission_expired'
          : code === 'WORKSPACE_CONFLICT'
          ? 'conflict'
          : code === 'CAPABILITY_SCOPE_ESCAPE' || code === 'capability_scope_escape' || code === 'CAPABILITY_UNSUPPORTED_TYPE'
            ? 'scope_escape'
            : code === 'WORKSPACE_FILE_TOO_LARGE' || code === 'CAPABILITY_TOO_LARGE'
              ? 'too_large'
              : code === 'CAPABILITY_STALE' || code === 'CAPABILITY_REVOKED'
                ? 'account_stale'
                : 'io_failed',
        input.operationId
      )
    }

    const recipients = this.publish({ sessionId: input.sessionId, toolCallId: input.operationId, result })

    if (descriptor) {
      if (recipients.length === 0) {
        await this.leases.release(descriptor.fileRef)
      } else {
        this.trackDelivery(descriptor.fileRef, recipients)
      }
    }

    return result
  }

  adopt(fileRef: string, ownerId: string): { adopted: true } {
    const delivery = this.requireDelivery(fileRef, ownerId)

    if (delivery.adopter && delivery.adopter !== ownerId) {
      throw new Error('CAPABILITY_DENIED')
    }

    delivery.adopter = ownerId
    clearTimeout(delivery.timer)

    return { adopted: true }
  }

  assertAccess(fileRef: string, ownerId: string): void {
    const delivery = this.deliveries.get(fileRef)

    if (delivery && delivery.adopter !== ownerId) {
      throw new Error('CAPABILITY_DENIED')
    }
  }

  async dismiss(fileRef: string, ownerId: string): Promise<{ released: boolean }> {
    const delivery = this.requireDelivery(fileRef, ownerId)

    if (delivery.adopter) {
      return { released: false }
    }

    delivery.dismissed.add(ownerId)

    if (delivery.dismissed.size < delivery.recipients.size) {
      return { released: false }
    }

    await this.releaseUnadopted(fileRef, delivery)

    return { released: true }
  }

  async release(fileRef: string, ownerId: string): Promise<void> {
    const delivery = this.deliveries.get(fileRef)

    if (delivery) {
      if (delivery.adopter !== ownerId) {
        throw new Error('CAPABILITY_DENIED')
      }

      clearTimeout(delivery.timer)
      this.deliveries.delete(fileRef)
    }

    await this.leases.release(fileRef)
  }

  private requireDelivery(fileRef: string, ownerId: string): AssistantLeaseDelivery {
    const delivery = this.deliveries.get(fileRef)

    if (!delivery || !delivery.recipients.has(ownerId)) {
      throw new Error('CAPABILITY_DENIED')
    }

    return delivery
  }

  private trackDelivery(fileRef: string, recipientIds: readonly string[]): void {
    const recipients = new Set(recipientIds)
    let delivery: AssistantLeaseDelivery

    const timer = setTimeout(() => {
      void this.releaseUnadopted(fileRef, delivery)
    }, this.options.adoptionTimeoutMs ?? 60_000)

    timer.unref?.()
    delivery = { adopter: null, dismissed: new Set<string>(), recipients, timer }
    this.deliveries.set(fileRef, delivery)
  }

  private async releaseUnadopted(fileRef: string, delivery: AssistantLeaseDelivery): Promise<void> {
    if (this.deliveries.get(fileRef) !== delivery || delivery.adopter) {
      return
    }

    clearTimeout(delivery.timer)
    this.deliveries.delete(fileRef)
    await this.leases.release(fileRef)
  }

  trackReceipt(input: {
    account: FilesystemAccountEnvelope
    actor: FilesystemCapabilityActor
    operationId: string
    receiptId: string
    sessionId: string
    expiresAt: number
  }): void {
    const previous = this.pending.get(input.receiptId)

    if (previous) {
      clearTimeout(previous)
    }

    const timer = setTimeout(() => {
      this.pending.delete(input.receiptId)
      this.authority.consumeWriteReceipt({
        account: input.account,
        actor: input.actor,
        operationId: input.operationId,
        receiptId: input.receiptId
      })
      const result = failure('permission_expired', input.operationId)
      this.publish({ sessionId: input.sessionId, toolCallId: input.operationId, result })
    }, Math.max(0, input.expiresAt - Date.now()))

    timer.unref?.()
    this.pending.set(input.receiptId, timer)
  }

  complete(input: AssistantWorkspaceTextCompletionV1): AssistantWorkspaceTextResultV1 {
    const timer = this.pending.get(input.receiptId)

    if (timer) {
      clearTimeout(timer)
      this.pending.delete(input.receiptId)
    }

    const receipt = this.authority.consumeWriteReceipt({
      account: input.account,
      actor: input.actor,
      operationId: input.operationId,
      receiptId: input.receiptId
    })

    let result: AssistantWorkspaceTextResultV1

    if ('code' in receipt) {
      result = failure(decisionFailureCode({ allowed: false, code: receipt.code }), input.operationId)
    } else if (input.toolName !== 'write_file' || input.status !== 'ok') {
      result = failure('io_failed', input.operationId)
    } else {
      result = this.openAuthorizedText(receipt.canonicalPath, input.operationId)
    }

    this.publish({ sessionId: input.sessionId, toolCallId: input.operationId, result })

    return result
  }

  private openAuthorizedText(canonicalPath: string, incidentSeed: string): AssistantWorkspaceTextResultV1 {
    try {
      const extension = path.extname(canonicalPath).toLocaleLowerCase('en-US')
      const file = lstatSync(canonicalPath)

      if (!file.isFile() || file.isSymbolicLink() || !['.md', '.txt'].includes(extension)) {
        return failure('scope_escape', incidentSeed)
      }

      if (file.size > MAX_ASSISTANT_TEXT_BYTES) {
        return failure('too_large', incidentSeed)
      }

      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(canonicalPath))

      return {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: this.leases.openLocal(canonicalPath)
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''

      if (code === 'WORKSPACE_FILE_TOO_LARGE') {
        return failure('too_large', incidentSeed)
      }

      if (code === 'CAPABILITY_STALE' || code === 'CAPABILITY_REVOKED') {
        return failure('account_stale', incidentSeed)
      }

      return failure('io_failed', incidentSeed)
    }
  }
}

export { FAILURE_COPY, MAX_ASSISTANT_TEXT_BYTES }
