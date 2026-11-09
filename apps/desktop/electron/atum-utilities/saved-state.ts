import { randomUUID } from 'node:crypto'

import type { UtilitySource } from '../../shared/atum-utilities'

import { type GoogleCredential, type GoogleService, UtilityFailure } from './google'

export interface SavedGoogleAccount {
  accountKey: string
  credentials: Partial<Record<GoogleService, GoogleCredential>>
}

export interface SavedSource extends UtilitySource {
  /** Provider IDs stay inside the encrypted, main-owned store. */
  providerRef?: string
}

export interface SavedUtilities {
  version: 3
  accounts: SavedGoogleAccount[]
  sources: SavedSource[]
  appleConnected: boolean
  workspaceProtected?: boolean
  calendarSelectionRequired?: boolean
}

export const sourceId = (): string => `s:${randomUUID()}`
export const accountId = (): string => `g:${randomUUID()}`

/** Converts the old single-slot store without retaining an iCloud password. */
export function decodeUtilities(raw: string | null): { value: SavedUtilities; migrated: boolean } {
  if (!raw) { return { value: { version: 3, accounts: [], sources: [], appleConnected: false, workspaceProtected: false }, migrated: false } }

  try {
    const parsed = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') { throw new Error('shape') }

    if (parsed.version !== undefined) {
      if (![2, 3].includes(parsed.version) || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sources) || typeof parsed.appleConnected !== 'boolean') { throw new Error('version') }
      let migrated = parsed.version === 2

      if (migrated) {
        parsed.version = 3
        parsed.accounts = parsed.accounts.map((item: { accountKey: string; credential: GoogleCredential }) => ({ accountKey: item.accountKey, credentials: { 'email-calendar': item.credential } }))
      }

      if (!parsed.accounts.every((item: SavedGoogleAccount) => typeof item.accountKey === 'string' && item.credentials && Object.keys(item.credentials).length > 0 && Object.entries(item.credentials).every(([service, credential]) => ['email-calendar', 'drive'].includes(service) && typeof credential?.refreshToken === 'string' && typeof credential?.label === 'string' && typeof credential?.clientId === 'string'))) { throw new Error('account') }

      if (!parsed.sources.every((item: SavedSource) => typeof item.id === 'string' && typeof item.label === 'string' && typeof item.enabled === 'boolean' && ['connected', 'reconnect'].includes(item.state) && ['email', 'calendar', 'drive'].includes(item.kind) && ['google', 'apple-calendar'].includes(item.provider) && (item.provider === 'google' ? parsed.accounts.some((account: SavedGoogleAccount) => account.accountKey === item.accountKey && account.credentials[item.kind === 'drive' ? 'drive' : 'email-calendar']) : item.kind === 'calendar'))) { throw new Error('source') }

      // Previous versions could retain Google-derived history after disconnect.
      // An old empty connection list is not evidence that the account is clean.
      if (parsed.workspaceProtected === undefined) { parsed.workspaceProtected = true; migrated = true }

      if (typeof parsed.workspaceProtected !== 'boolean') { throw new Error('protection') }

      return { value: parsed, migrated }
    }

    if (!('email' in parsed) || !('calendar' in parsed)) { throw new Error('shape') }
    const value: SavedUtilities = { version: 3, accounts: [], sources: [], appleConnected: false, workspaceProtected: true }

    for (const kind of ['email', 'calendar'] as const) {
      const entry = parsed[kind]

      if (!entry || entry.provider === 'icloud') { continue }

      if (entry.provider === 'apple-calendar' && kind === 'calendar') {
        value.appleConnected = true
        // Expanded by the first successful native calendar inventory.
        value.sources.push({ id: sourceId(), kind, provider: 'apple-calendar', accountKey: null, label: entry.label, state: entry.state, enabled: true, providerRef: '*' })
      } else if (entry.provider === 'google' && typeof entry.google?.refreshToken === 'string' && typeof entry.google?.label === 'string' && typeof entry.google?.clientId === 'string') {
        let account = value.accounts.find(item => item.credentials['email-calendar']?.refreshToken === entry.google.refreshToken)

        if (!account) { account = { accountKey: accountId(), credentials: { 'email-calendar': entry.google } }; value.accounts.push(account) }
        value.sources.push({ id: sourceId(), kind, provider: 'google', accountKey: account.accountKey, label: kind === 'email' ? entry.google.label : 'Primary calendar', detail: entry.google.label, state: entry.state, enabled: true, ...(kind === 'calendar' ? { providerRef: 'primary', primary: true } : {}) })
      } else { throw new Error('connection') }
    }

    return { value, migrated: true }
  } catch { throw new UtilityFailure('storage') }
}
