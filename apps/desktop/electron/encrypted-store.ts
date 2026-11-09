import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export type SafeStorageAvailability = 'available' | 'probe_failed' | 'unavailable'

/** Closed-enum boot fact: callers may log it without exposing platform/keychain detail. */
export function safeStorageAvailability(safeStorage: SafeStorageLike): SafeStorageAvailability {
  try {
    return safeStorage.isEncryptionAvailable() ? 'available' : 'unavailable'
  } catch {
    return 'probe_failed'
  }
}

interface EncryptedSessionRecord {
  encoding: 'safeStorage'
  value: string
}

interface StoredAuthFile {
  version: 2
  entries: Record<string, EncryptedSessionRecord>
}

/**
 * Electron-main-only encrypted key/value storage. No identity provider dependency.
 * Each value is independently protected by safeStorage; the containing file is
 * an atomic, mode-0600 index. Its storage shape remains compatible with the
 * existing auth adapter. The object is never exposed through a renderer bridge.
 */
export class EncryptedStore {
  private failureCodeValue: string | null = null

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
    /** Every key of this view is stored under this prefix (see scope()); '' for the root. */
    private readonly namespace = ''
  ) {}

  /**
   * A view of the same file whose keys all live under `namespace`, such as one agent's
   * entries: kept apart from everyone else's and removed together by the view's clear().
   * Every operation reads the file afresh, so the root and its views never hold a stale
   * copy of each other's writes.
   */
  scope(namespace: string): EncryptedStore {
    if (!namespace) {
      throw new Error('auth_storage_namespace_invalid')
    }

    return new EncryptedStore(this.filePath, this.safeStorage, this.namespace + namespace)
  }

  /** Read-only, namespace-relative index keys; never decrypts any value. */
  keys(prefix = ''): string[] {
    try {
      const keys = Object.keys(this.read().entries)
        .filter(key => key.startsWith(this.namespace + prefix))
        .map(key => key.slice(this.namespace.length))

      this.failureCodeValue = null

      return keys
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const failure = code.startsWith('auth_storage_') ? code : 'auth_storage_read_failed'
      this.failureCodeValue = failure
      throw new Error(failure)
    }
  }

  getItem(key: string): string | null {
    try {
      const record = this.read()
      const encrypted = record.entries[this.namespace + key]

      if (!encrypted) {
        this.failureCodeValue = null

        return null
      }

      if (encrypted.encoding !== 'safeStorage' || safeStorageAvailability(this.safeStorage) !== 'available') {
        throw new Error('auth_storage_unavailable')
      }

      try {
        const decrypted = this.safeStorage.decryptString(Buffer.from(encrypted.value, 'base64'))
        this.failureCodeValue = null

        return decrypted
      } catch {
        throw new Error('auth_storage_decrypt_failed')
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      this.failureCodeValue = code.startsWith('auth_storage_') ? code : 'auth_storage_read_failed'

      // SupportedStorage consumers expect an unavailable value, not an
      // exception. The main auth adapter reads failureCode() and surfaces the
      // stable error without deleting the encrypted file.
      return null
    }
  }

  failureCode(): string | null {
    return this.failureCodeValue
  }

  assertEncryptionAvailable(): void {
    if (safeStorageAvailability(this.safeStorage) !== 'available') {
      throw new Error('auth_storage_unavailable')
    }
  }

  setItem(key: string, value: string): void {
    if (safeStorageAvailability(this.safeStorage) !== 'available') {
      this.failureCodeValue = 'auth_storage_unavailable'
      throw new Error('auth_storage_unavailable')
    }

    const record = this.read()

    try {
      record.entries[this.namespace + key] = {
        encoding: 'safeStorage',
        value: this.safeStorage.encryptString(value).toString('base64')
      }
    } catch {
      this.failureCodeValue = 'auth_storage_encrypt_failed'
      throw new Error('auth_storage_encrypt_failed')
    }

    this.writeOrFail(record)

    this.failureCodeValue = null
  }

  /** Several entries in one file write: either all of them land or none does. */
  setItems(entries: Record<string, string>): void {
    if (safeStorageAvailability(this.safeStorage) !== 'available') {
      this.failureCodeValue = 'auth_storage_unavailable'
      throw new Error('auth_storage_unavailable')
    }

    const record = this.read()

    try {
      for (const [key, value] of Object.entries(entries)) {
        record.entries[this.namespace + key] = {
          encoding: 'safeStorage',
          value: this.safeStorage.encryptString(value).toString('base64')
        }
      }
    } catch {
      this.failureCodeValue = 'auth_storage_encrypt_failed'
      throw new Error('auth_storage_encrypt_failed')
    }

    this.writeOrFail(record)

    this.failureCodeValue = null
  }

  removeItem(key: string): void {
    const record = this.read()
    const stored = this.namespace + key

    if (!(stored in record.entries)) {
      return
    }

    delete record.entries[stored]
    this.write(record)
    this.failureCodeValue = null
  }

  /** Removes every entry of this view (the whole file for the root, only its own entries
   * for a scope()), except the keys starting with any of `keep`. */
  clear(keep: string | readonly string[] = []): void {
    const kept = (typeof keep === 'string' ? [keep] : keep).map(prefix => this.namespace + prefix)

    if (!this.namespace && kept.length === 0) {
      this.write({ version: 2, entries: {} })
    } else {
      const record = this.read()

      for (const key of Object.keys(record.entries)) {
        if (key.startsWith(this.namespace) && !kept.some(prefix => key.startsWith(prefix))) {
          delete record.entries[key]
        }
      }

      this.write(record)
    }

    this.failureCodeValue = null
  }

  /** A failed write says whether the disk (or the user's quota) had no room, which freeing
   * space fixes (`auth_storage_disk_full`), or anything else (`auth_storage_write_failed`). */
  private writeOrFail(record: StoredAuthFile): void {
    try {
      this.write(record)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const failure = code === 'ENOSPC' || code === 'EDQUOT' ? 'auth_storage_disk_full' : 'auth_storage_write_failed'
      this.failureCodeValue = failure
      throw new Error(failure)
    }
  }

  private read(): StoredAuthFile {
    let raw: string

    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

      if (code === 'ENOENT') {
        return { version: 2, entries: {} }
      }

      throw new Error('auth_storage_read_failed')
    }

    try {
      const parsed = JSON.parse(raw) as Partial<StoredAuthFile>

      if (
        parsed.version !== 2 ||
        !parsed.entries ||
        typeof parsed.entries !== 'object' ||
        Array.isArray(parsed.entries)
      ) {
        throw new Error('auth_storage_corrupt')
      }

      return { version: 2, entries: { ...parsed.entries } }
    } catch (error) {
      if (error instanceof Error && error.message === 'auth_storage_corrupt') {
        throw error
      }

      throw new Error('auth_storage_corrupt')
    }
  }

  private write(value: StoredAuthFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    chmodSync(dirname(this.filePath), 0o700)
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.filePath)
    chmodSync(this.filePath, 0o600)
  }
}
