import { createHash } from 'node:crypto'

import type { MatrixCommand, MatrixIdentity } from '../../shared/matrix'
import { boundedMatrixDraftText } from '../../shared/matrix-drafts'
import type { EncryptedStore } from '../encrypted-store'

export type PendingMatrixDraft = Extract<MatrixCommand, { kind: 'draft' }>
export type MatrixDraftDelivery = { status: 'saved' | 'pending' }

const PREFIX = 'draft:'
const MAX_PENDING = 200

function keyOf(command: PendingMatrixDraft): string {
  const target = `${command.identity.userId}\0${command.identity.deviceId}\0${command.roomId}\0${command.threadRootId ?? ''}`

  return `${PREFIX}${createHash('sha256').update(target).digest('hex')}`
}

function parse(value: string | null): PendingMatrixDraft | undefined {
  if (!value) {return undefined}

  try {
    const row = JSON.parse(value) as Partial<PendingMatrixDraft>

    if (
      row.kind !== 'draft' ||
      !row.identity ||
      typeof row.identity.userId !== 'string' ||
      typeof row.identity.deviceId !== 'string' ||
      typeof row.roomId !== 'string' ||
      (row.threadRootId !== undefined && typeof row.threadRootId !== 'string') ||
      typeof row.text !== 'string' ||
      boundedMatrixDraftText(row.text) !== row.text
    ) {
      return undefined
    }

    return row as PendingMatrixDraft
  } catch {
    return undefined
  }
}

const sameIdentity = (left: MatrixIdentity, right: MatrixIdentity) =>
  left.userId === right.userId && left.deviceId === right.deviceId

const terminal = (error: unknown) =>
  error instanceof Error && ['matrix_draft_room_unavailable', 'matrix_drafts_stale'].includes(error.message)

/**
 * Native, encrypted pending queue for composer drafts. Remember happens before
 * the SDK write, so an offline renderer acknowledgement never outruns durable
 * local recovery. One record per target means a later edit replaces only that
 * target, and an acknowledgement removes only the exact text it delivered.
 */
export class PendingMatrixDrafts {
  private draining: Promise<void> | null = null

  constructor(private readonly store: Pick<EncryptedStore, 'getItem' | 'keys' | 'removeItem' | 'setItem'>) {}

  async submit(command: PendingMatrixDraft, deliver: (command: PendingMatrixDraft) => Promise<unknown>): Promise<MatrixDraftDelivery> {
    this.remember(command)

    try {
      await deliver(command)
      this.ack(command)

      return { status: 'saved' }
    } catch (error) {
      if (terminal(error)) {
        this.ack(command)
        throw error
      }

      return { status: 'pending' }
    }
  }

  drain(identity: MatrixIdentity, deliver: (command: PendingMatrixDraft) => Promise<unknown>): Promise<void> {
    if (this.draining) {return this.draining}

    this.draining = this.drainOnce(identity, deliver).finally(() => { this.draining = null })

    return this.draining
  }

  private async drainOnce(identity: MatrixIdentity, deliver: (command: PendingMatrixDraft) => Promise<unknown>) {
    for (const key of this.store.keys(PREFIX).slice(0, MAX_PENDING)) {
      const command = parse(this.store.getItem(key))

      if (!command) {
        this.store.removeItem(key)
        continue
      }

      if (!sameIdentity(command.identity, identity)) {continue}

      try {
        await deliver(command)
        this.ack(command)
      } catch (error) {
        if (terminal(error)) {
          this.ack(command)
          continue
        }

        // Connectivity is shared by the remaining records; retry them on the next ready edge.
        return
      }
    }
  }

  private remember(command: PendingMatrixDraft) {
    const keys = this.store.keys(PREFIX)
    const key = keyOf(command)

    if (!keys.includes(key) && keys.length >= MAX_PENDING) {
      throw new Error('matrix_draft_storage_full')
    }

    this.store.setItem(key, JSON.stringify(command))
  }

  private ack(command: PendingMatrixDraft) {
    const key = keyOf(command)
    const current = parse(this.store.getItem(key))

    if (current?.text === command.text) {
      this.store.removeItem(key)
    }
  }
}
