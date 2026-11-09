import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type {
  GroupDetail,
  GroupOperationInput,
  GroupOperationResult,
  GroupRoom
} from '../../shared/atum-group-conversations'

import type { MutationFailure } from './types'

export interface PendingGroupOperation extends GroupOperationResult {
  input: GroupOperationInput
  membershipEpoch: number | null
  attemptCount: number
}

export interface GroupStoreBoundary {
  groupRoom(id: string): GroupRoom | null
  groupRoomIds(): string[]
  revokeGroup(id: string): void
  groupRevokedEpoch(id: string): number | null
  getGroupDetail(id: string): GroupDetail | null
  saveGroupDetail(detail: GroupDetail): void
  queueGroupOperation(input: GroupOperationInput, now: string): PendingGroupOperation
  groupOperations(): PendingGroupOperation[]
  dueGroupOperations(now: string): PendingGroupOperation[]
  startGroupOperation(id: string, now: string): void
  settleGroupOperation(id: string, conversationId: string, now: string): void
  failGroupOperation(id: string, failure: MutationFailure): void
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

function validateOperation(input: GroupOperationInput): void {
  if (input.action !== 'create') {
    return
  }

  if (
    input.contextMode !== undefined &&
    input.contextMode !== 'ordinary' &&
    input.contextMode !== 'private_advisory' &&
    input.contextMode !== 'shared_group'
  ) {
    throw new Error('group_context_mode')
  }

  if (input.contextMode === 'shared_group' && input.memberUserIds.length < 1) {
    throw new Error('shared_group_requires_member')
  }
}

/** Shares the existing account database; never creates a second account authority. */
export class GroupStore implements GroupStoreBoundary {
  constructor(
    private readonly db: DatabaseSync,
    private readonly accountId: string
  ) {
    db.prepare("UPDATE messaging_group_operations SET state='queued' WHERE account_id=? AND state='sending'").run(
      accountId
    )
  }

  groupRoomIds(): string[] {
    return this.db
      .prepare("SELECT id FROM messaging_conversations WHERE account_id=? AND kind='group'")
      .all(this.accountId)
      .map(row => String(row.id))
  }

  groupRoom(id: string): GroupRoom | null {
    const row = this.db
      .prepare("SELECT payload_json FROM messaging_conversations WHERE account_id=? AND id=? AND kind='group'")
      .get(this.accountId, id)

    return row ? (JSON.parse(String(row.payload_json)).groupRoom ?? null) : null
  }

  groupRevokedEpoch(id: string): number | null {
    const row = this.db
      .prepare('SELECT membership_epoch FROM messaging_group_revocations WHERE account_id=? AND conversation_id=?')
      .get(this.accountId, id)

    return row ? Number(row.membership_epoch) : null
  }

  revokeGroup(id: string): void {
    this.clearGroup(id, true)
  }

  /** Cursor reset invalidates pending work without claiming active membership ended. */
  clearGroup(id: string, revoked = false): void {
    const epoch = this.groupRoom(id)?.membershipEpoch ?? this.groupRevokedEpoch(id) ?? 0
    this.db.exec('BEGIN IMMEDIATE')

    try {
      if (revoked) {
        this.db
          .prepare(
            `INSERT INTO messaging_group_revocations VALUES (?,?,?)
          ON CONFLICT(account_id,conversation_id) DO UPDATE SET membership_epoch=max(membership_epoch,excluded.membership_epoch)`
          )
          .run(this.accountId, id, epoch)
      }

      for (const table of [
        'messaging_drafts',
        'messaging_pending_mutations',
        'messaging_pending_read_receipts',
        'messaging_group_operations'
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE account_id=? AND conversation_id=?`).run(this.accountId, id)
      }

      // FK cascades remove messages, receipts, and details in this transaction.
      this.db.prepare('DELETE FROM messaging_conversations WHERE account_id=? AND id=?').run(this.accountId, id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getGroupDetail(id: string): GroupDetail | null {
    const row = this.db
      .prepare('SELECT detail_json FROM messaging_group_details WHERE account_id=? AND conversation_id=?')
      .get(this.accountId, id)

    return row ? JSON.parse(String(row.detail_json)) : null
  }

  saveGroupDetail(detail: GroupDetail): void {
    const room = this.groupRoom(detail.room.conversationId)

    if (!room || room.membershipEpoch !== detail.room.membershipEpoch || room.revision > detail.room.revision) {
      throw new Error('stale_group_membership')
    }

    this.db
      .prepare(
        `INSERT INTO messaging_group_details VALUES (?,?,?)
      ON CONFLICT(account_id,conversation_id) DO UPDATE SET detail_json=excluded.detail_json`
      )
      .run(this.accountId, room.conversationId, JSON.stringify(detail))
  }

  queueGroupOperation(input: GroupOperationInput, now: string): PendingGroupOperation {
    validateOperation(input)
    const request = canonical(input)
    const fingerprint = createHash('sha256').update(request).digest('hex')

    const existing = this.db
      .prepare('SELECT request_fingerprint FROM messaging_group_operations WHERE account_id=? AND operation_id=?')
      .get(this.accountId, input.clientOperationId)

    if (existing && existing.request_fingerprint !== fingerprint) {
      throw new Error('idempotency_conflict')
    }

    const conversationId = input.action === 'create' ? null : input.conversationId
    const room = conversationId ? this.groupRoom(conversationId) : null

    if (!existing && conversationId && (!room || !room.members.some(m => m.userId === this.accountId))) {
      throw new Error('group_membership_ended')
    }

    if (!existing && room?.retiredAt && input.action !== 'leave' && input.action !== 'report') {
      throw new Error('group_retired')
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO messaging_group_operations
      (account_id,operation_id,conversation_id,membership_epoch,request_json,request_fingerprint,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'queued',?,?)`
      )
      .run(
        this.accountId,
        input.clientOperationId,
        conversationId,
        room?.membershipEpoch ?? null,
        request,
        fingerprint,
        now,
        now
      )

    return this.read(input.clientOperationId)!
  }

  groupOperations(): PendingGroupOperation[] {
    return this.db
      .prepare(
        'SELECT * FROM messaging_group_operations WHERE account_id=? ORDER BY created_at DESC,operation_id LIMIT 100'
      )
      .all(this.accountId)
      .map(row => this.decode(row))
  }

  dueGroupOperations(now: string): PendingGroupOperation[] {
    return this.db
      .prepare(
        `SELECT * FROM messaging_group_operations WHERE account_id=? AND state IN ('queued','failed_retryable')
      AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,operation_id LIMIT 100`
      )
      .all(this.accountId, now)
      .map(row => this.decode(row))
  }

  startGroupOperation(id: string, now: string): void {
    this.db
      .prepare(
        "UPDATE messaging_group_operations SET state='sending',attempt_count=attempt_count+1,updated_at=? WHERE account_id=? AND operation_id=?"
      )
      .run(now, this.accountId, id)
  }

  settleGroupOperation(id: string, conversationId: string, now: string): void {
    this.db
      .prepare(
        "UPDATE messaging_group_operations SET state='sent',conversation_id=?,error_code=NULL,next_attempt_at=NULL,updated_at=? WHERE account_id=? AND operation_id=?"
      )
      .run(conversationId, now, this.accountId, id)
  }

  failGroupOperation(id: string, failure: MutationFailure): void {
    const state = failure.conflicted ? 'conflicted' : failure.retryable ? 'failed_retryable' : 'failed_terminal'
    this.db
      .prepare(
        'UPDATE messaging_group_operations SET state=?,error_code=?,next_attempt_at=?,updated_at=? WHERE account_id=? AND operation_id=?'
      )
      .run(
        state,
        failure.code,
        failure.retryable ? (failure.retryAt ?? null) : null,
        failure.now ?? new Date().toISOString(),
        this.accountId,
        id
      )
  }

  private read(id: string): PendingGroupOperation | null {
    const row = this.db
      .prepare('SELECT * FROM messaging_group_operations WHERE account_id=? AND operation_id=?')
      .get(this.accountId, id)

    return row ? this.decode(row) : null
  }

  private decode(row: Record<string, unknown>): PendingGroupOperation {
    return {
      operationId: String(row.operation_id),
      conversationId: row.conversation_id === null ? null : String(row.conversation_id),
      state: row.state as GroupOperationResult['state'],
      errorCode: row.error_code === null ? null : String(row.error_code),
      input: JSON.parse(String(row.request_json)),
      membershipEpoch: row.membership_epoch === null ? null : Number(row.membership_epoch),
      attemptCount: Number(row.attempt_count)
    }
  }
}
