import { createHash } from 'node:crypto'

import type { EncryptedStore as SafeStorageAuthStorage } from '../encrypted-store'

import { UtilityFailure } from './google'

interface Receipt {
  digest: string
  state: 'dispatching' | 'complete'
  result?: { id: string; action: string }
}

/** Persist before dispatch: a crash or lost response must never resend an email. */
export class UtilityWriteLedger {
  constructor(private readonly storage: SafeStorageAuthStorage) {}

  private read(): Record<string, Receipt> {
    const raw = this.storage.getItem('operations')

    if (this.storage.failureCode()) { throw new UtilityFailure('storage') }

    if (raw === null) { return {} }

    try {
      const data = JSON.parse(raw)

      if (!data || Array.isArray(data) || typeof data !== 'object' || Object.values(data).some((entry: any) => !entry || typeof entry.digest !== 'string' || !['dispatching', 'complete'].includes(entry.state))) { throw new Error('shape') }

      return data
    } catch { throw new UtilityFailure('storage') }
  }

  lookup(operationId: string, payload: unknown): Receipt | null {
    const saved = this.read()[operationId]

    if (saved && saved.digest !== this.digest(payload)) { throw new UtilityFailure('conflict') }

    return saved ?? null
  }

  begin(operationId: string, payload: unknown): void {
    const entries = this.read()

    if (entries[operationId]) { throw new UtilityFailure('conflict') }
    entries[operationId] = { digest: this.digest(payload), state: 'dispatching' }
    this.save(entries)
  }

  complete(operationId: string, result: { id: string; action: string }): void {
    const entries = this.read()

    if (!entries[operationId]) { throw new UtilityFailure('storage') }
    entries[operationId] = { ...entries[operationId], state: 'complete', result }
    this.save(entries)
  }

  private digest(payload: unknown): string { return createHash('sha256').update(JSON.stringify(payload)).digest('hex') }

  private save(entries: Record<string, Receipt>): void {
    try { this.storage.setItem('operations', JSON.stringify(entries)) }
    catch { throw new UtilityFailure('storage') }
  }
}
