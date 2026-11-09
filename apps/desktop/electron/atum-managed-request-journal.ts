import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface PendingManagedRequest {
  requestId: string
  turnRequestId: string
  bodyHash: string
  reservationId: string | null
  createdAt: number
}

export type ManagedRequestRecoveryErrorCode = 'managed_request_recovery_unavailable' | 'managed_request_recovery_corrupt'

/**
 * The journal is only a recovery aid; it must never turn damaged local state
 * into a new model-request identity.  Callers may surface the retained IDs to
 * support so an affected server-side turn can be reconciled or cancelled.
 */
export class ManagedRequestRecoveryError extends Error {
  constructor(
    readonly code: ManagedRequestRecoveryErrorCode,
    readonly requestIds: string[] = []
  ) {
    super(code)
    this.name = 'ManagedRequestRecoveryError'
  }
}

export interface ManagedRequestCancellationTarget {
  requestId: string
  reservationId: string | null
  modelRequestId: string | null
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const REQUEST_ID_IN_TEXT_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
}

function isPendingManagedRequest(value: unknown): value is PendingManagedRequest {
  return Boolean(value) && typeof value === 'object'
    && isRequestId((value as PendingManagedRequest).requestId)
    && isRequestId((value as PendingManagedRequest).turnRequestId)
    && typeof (value as PendingManagedRequest).bodyHash === 'string'
    && ((value as PendingManagedRequest).reservationId === null || isRequestId((value as PendingManagedRequest).reservationId))
    && typeof (value as PendingManagedRequest).createdAt === 'number'
}

function requestIdsFrom(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return [] }

  const record = value as Record<string, unknown>
  const ids = [record.turnRequestId, record.requestId, record.reservationId].filter(isRequestId)

  return [...new Set(ids)]
}

function requestIdsFromSerialized(value: string): string[] {
  return [...new Set(value.match(REQUEST_ID_IN_TEXT_PATTERN) ?? [])]
}

/** Account-private recovery metadata. No prompt, output, credential, or claim is stored. */
export class ManagedRequestJournal {
  constructor(private readonly filename: string) {}

  private read(): Record<string, unknown> {
    let serialized: string
    let value: unknown

    try {
      serialized = fs.readFileSync(this.filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return {} }
      throw new ManagedRequestRecoveryError('managed_request_recovery_unavailable')
    }

    try {
      value = JSON.parse(serialized)
    } catch {
      throw new ManagedRequestRecoveryError('managed_request_recovery_unavailable', requestIdsFromSerialized(serialized))
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ManagedRequestRecoveryError('managed_request_recovery_unavailable', requestIdsFrom(value))
    }

    return value as Record<string, unknown>
  }

  get(scope: string): PendingManagedRequest | undefined {
    const value = this.read()[this.key(scope)]

    if (value === undefined) { return undefined }

    if (isPendingManagedRequest(value)) { return value }

    // Keep malformed entries in place.  A different conversation can still
    // recover normally, but this exact scope cannot be safely replayed.
    throw new ManagedRequestRecoveryError('managed_request_recovery_corrupt', requestIdsFrom(value))
  }

  /**
   * A Stop may safely use a retained server identity even when optional local
   * recovery fields were damaged.  It never invents an ID or clears evidence.
   */
  cancellationTarget(scope: string): ManagedRequestCancellationTarget | undefined {
    const value = this.read()[this.key(scope)]

    if (value === undefined) { return undefined }

    if (isPendingManagedRequest(value)) {
      return { requestId: value.turnRequestId, reservationId: value.reservationId, modelRequestId: value.requestId }
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ManagedRequestRecoveryError('managed_request_recovery_corrupt')
    }

    const record = value as Record<string, unknown>

    // Model request IDs differ from the turn ID after a tool call. An unknown
    // turn ID can receive a cancellation tombstone without stopping the real
    // reservation, so a surviving model ID is never a cancellation target.
    const requestId = isRequestId(record.turnRequestId) ? record.turnRequestId : null

    const reservationId = isRequestId(record.reservationId) ? record.reservationId : null

    if (!requestId && !reservationId) {
      throw new ManagedRequestRecoveryError('managed_request_recovery_corrupt', requestIdsFrom(value))
    }

    return { requestId: requestId ?? reservationId!, reservationId,
      modelRequestId: isRequestId(record.requestId) ? record.requestId : null }
  }

  set(scope: string, pending: PendingManagedRequest | null): void {
    const records = this.read()
    const key = this.key(scope)

    // Never overwrite or delete malformed evidence for the affected scope.
    // Other scopes remain usable because their records stay independent.
    if (records[key] !== undefined && !isPendingManagedRequest(records[key])) {
      throw new ManagedRequestRecoveryError('managed_request_recovery_corrupt', requestIdsFrom(records[key]))
    }

    if (pending) { records[key] = pending }
    else { delete records[key] }

    this.write(records)
  }

  /**
   * A terminal server response is the sole authority that permits an affected
   * corrupt record to stop blocking its conversation. Keep a private forensic
   * copy first; a later prompt cannot silently overwrite the unknown work.
   */
  clearAfterTerminal(scope: string): void {
    const records = this.read()
    const key = this.key(scope)

    if (records[key] !== undefined && !isPendingManagedRequest(records[key])) {
      this.quarantine()
    }

    delete records[key]
    this.write(records)
  }

  private quarantine(): void {
    const evidence = fs.readFileSync(this.filename)
    const filename = `${this.filename}.${crypto.randomUUID()}.corrupt`
    const descriptor = fs.openSync(filename, 'wx', 0o600)

    try {
      fs.writeFileSync(descriptor, evidence)
      fs.fsyncSync(descriptor)
    } finally { fs.closeSync(descriptor) }
  }

  private write(records: Record<string, unknown>): void {

    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`

    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600)

      try {
        fs.writeFileSync(descriptor, JSON.stringify(records))
        fs.fsyncSync(descriptor)
      } finally { fs.closeSync(descriptor) }

      fs.renameSync(temporary, this.filename)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  private key(scope: string): string {
    return crypto.createHash('sha256').update(scope).digest('hex')
  }
}
