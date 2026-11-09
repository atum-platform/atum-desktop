import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { SafeStorageLike } from '../encrypted-store'

import type { MessagingAccountSession, MessagingSessionTokens, MessagingUser } from './types'

export { EncryptedStore as SafeStorageAuthStorage, safeStorageAvailability } from '../encrypted-store'
export type { SafeStorageAvailability, SafeStorageLike } from '../encrypted-store'

interface StoredSessionFile {
  version: 1
  active: { encoding: 'safeStorage'; value: string } | null
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value)

  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('Atum messaging base URL must use HTTPS outside loopback')
  }

  parsed.hash = ''
  parsed.search = ''
  parsed.username = ''
  parsed.password = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  return parsed.toString().replace(/\/$/, '')
}

function parseUser(value: unknown): MessagingUser {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  if (typeof record.id !== 'string' || !record.id) {
    throw new Error('Stored Atum messaging session is missing its account id')
  }

  return {
    id: record.id,
    displayName: typeof record.displayName === 'string' ? record.displayName : null,
    handle: typeof record.handle === 'string' ? record.handle : null
  }
}

function parseTokens(value: unknown): MessagingSessionTokens {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  if (typeof record.accessToken !== 'string' || !record.accessToken) {
    throw new Error('Stored Atum messaging session is missing its access token')
  }

  return {
    accessToken: record.accessToken,
    refreshToken: typeof record.refreshToken === 'string' && record.refreshToken ? record.refreshToken : null,
    expiresAt: typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : null
  }
}

export function parseMessagingAccountSession(value: unknown): MessagingAccountSession {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    baseUrl: normalizeBaseUrl(String(record.baseUrl ?? '')),
    user: parseUser(record.user),
    tokens: parseTokens(record.tokens)
  }
}

/** Main-process-only encrypted storage. No method returns tokens across IPC. */
export class MessagingCredentialVault {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  load(): MessagingAccountSession | null {
    let file: StoredSessionFile

    try {
      file = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredSessionFile
    } catch {
      return null
    }

    if (file?.version !== 1 || !file.active) {
      return null
    }

    if (file.active.encoding !== 'safeStorage' || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Atum messaging credentials cannot be decrypted with OS secure storage')
    }

    return parseMessagingAccountSession(
      JSON.parse(this.safeStorage.decryptString(Buffer.from(file.active.value, 'base64')))
    )
  }

  save(session: MessagingAccountSession): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is required for Atum messaging credentials')
    }

    const normalized = parseMessagingAccountSession(session)
    const encrypted = this.safeStorage.encryptString(JSON.stringify(normalized)).toString('base64')
    this.write({ version: 1, active: { encoding: 'safeStorage', value: encrypted } })
  }

  clear(): void {
    this.write({ version: 1, active: null })
  }

  private write(value: StoredSessionFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    renameSync(temporary, this.filePath)
  }
}

export { normalizeBaseUrl }
