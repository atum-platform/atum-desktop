import { createHash } from 'node:crypto'

import { MATRIX_DECRYPTION_FAILURE_CODES } from '../../shared/matrix-undecryptable'

import { MatrixWindowedLog } from './windowed-log'

const CODES = new Set<string>(MATRIX_DECRYPTION_FAILURE_CODES)

/** The kind of SDK host a line is about; never an agent's or an app's own name. */
function hostKind(role: string): 'human' | 'agent' | 'app' {
  return role === 'human' ? 'human' : role.startsWith('app:') ? 'app' : 'agent'
}

/** A room as a short hash: enough to tell one room's failures from another's across lines. */
export function matrixRoomLogHash(roomId: string): string {
  return createHash('sha256').update(roomId).digest('hex').slice(0, 12)
}

/**
 * Messages an SDK host could not decrypt (owner finding 1b, 2026-10-06: "Can't read this message
 * on this Mac" with nothing in the log to say why). One line per host kind, room and reason
 * (matrix-js-sdk's `DecryptionFailureCode`), then at most one per window with how many there were
 * (windowed-log.ts). The room is hashed; no content, sender, device or event ID is ever written.
 * An observation that isn't exactly `{ roomId, code }` with a listed code says nothing.
 */
export class MatrixUndecryptableLog {
  private readonly log: MatrixWindowedLog

  constructor(write: (line: string) => void, windowMs = 10 * 60_000, now: () => number = Date.now) {
    this.log = new MatrixWindowedLog(write, windowMs, now)
  }

  observe(role: string, value: unknown): void {
    const row = value as { roomId?: unknown; code?: unknown } | null

    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).some(key => key !== 'roomId' && key !== 'code') ||
      typeof row.roomId !== 'string' ||
      !row.roomId.startsWith('!') ||
      row.roomId.length > 1024 ||
      typeof row.code !== 'string' ||
      !CODES.has(row.code)
    ) {
      return
    }

    this.log.line(
      `[Matrix] undecryptable host=${hostKind(role)} room=${matrixRoomLogHash(row.roomId)} reason=${row.code}`
    )
  }
}
