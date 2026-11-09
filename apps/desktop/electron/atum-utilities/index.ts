import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { UtilityConnectInput, UtilityDisconnectInput, UtilityError, UtilityResult, UtilitySourcePreference, UtilityStatus } from '../../shared/atum-utilities'
import { OwnerAddressCache, ownerAddresses, resolveCompose, type ResolvedMessage, writeDraft } from '../../shared/gmail-compose'
import { createLabel, fetchAttachment, GmailMailError, mailboxChange } from '../../shared/gmail-mail'
import { parseMatrixGoogleToolRequest } from '../../shared/matrix-google-tool-request'
import { MATRIX_GOOGLE_MAILBOX_ACTIONS, matrixGoogleCanManageMail } from '../../shared/matrix-google-tools'
import { EncryptedStore as SafeStorageAuthStorage, type SafeStorageLike } from '../encrypted-store'
import type { MainLocale } from '../main-i18n'

import type { AppleAdapters } from './apple'
import {
  authorizeGoogle,
  calendarWindow,
  credentialScopes,
  desktopGmailApi,
  googleCalendars,
  type GoogleClient,
  type GoogleCredential,
  type GoogleGrantedServices,
  googleRead,
  grantedServices,
  primaryCalendarOnly,
  refreshGoogle,
  revokeGoogle,
  UtilityFailure
} from './google'
import { composeFailure, executeGoogleWrite, type GoogleEmailMessage, type GoogleEventSnapshot, inspectGoogleEvent, parseUtilityWrite, prepareGoogleEmail } from './google-actions'
import { accountId, decodeUtilities, type SavedGoogleAccount, type SavedSource, type SavedUtilities, sourceId } from './saved-state'
import { UtilityWriteLedger } from './write-ledger'
import { confirmationText, fitsConfirmation, fitsDialog, shortenForDisplay } from './write-preview'

export interface UtilityAccount {
  accountId: string
  generation: number
  root: string
}

interface Dependencies {
  account: () => UtilityAccount | null
  safeStorage: SafeStorageLike
  google: GoogleClient | null
  apple: AppleAdapters
  fetchImpl: typeof fetch
  openExternal: (url: string) => Promise<unknown>
  locale?: () => MainLocale
  confirmWrite?: (preview: { action: 'send-email' | 'create-event' | 'update-event'; detail: string; signal?: AbortSignal }) => Promise<boolean>
  /** The words around the exact message or event in the confirmation, in the person's
   * language. English when absent. */
  writeLabels?: () => UtilityWriteLabels
}

/** Field names in the write confirmation; the values are the exact content. */
export interface UtilityWriteLabels {
  from: string
  to: string
  cc: string
  bcc: string
  attachments: string
  forwarded: string
  subject: string
  inReplyTo: string
  calendar: string
  title: string
  start: string
  end: string
  location: string
  notes: string
  current: string
  after: string
  noInvitations: string
}

/** A file's size for a confirmation: 812 B, 12.3 KB, 4.1 MB. */
function fileSize(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B` }

  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const ENGLISH_WRITE_LABELS: UtilityWriteLabels = {
  from: 'From', to: 'To', cc: 'Cc', bcc: 'Bcc', attachments: 'Attachments', forwarded: 'Forwarded message',
  subject: 'Subject', inReplyTo: 'Replies in the same conversation.',
  calendar: 'Calendar', title: 'Title', start: 'Start', end: 'End', location: 'Location', notes: 'Notes',
  current: 'Current event:', after: 'After changes:',
  noInvitations: 'This changes one personal event. No invitations will be sent.'
}

interface CalendarEntry {
  id: string
  label: string
  primary?: boolean
  detail?: string
  writable?: boolean
}

/**
 * A transient Google credential for a main-process operation. The token is
 * deliberately an argument to the callback rather than a return value or a
 * renderer-facing capability.
 */
export interface GoogleConnectionProof {
  sourceId: string
  accountKey: string
  label: string
  service: 'email' | 'calendar'
}

/** Dedicated installed-app registration, never the user's Supabase sign-in token. */
export function readGoogleClient(file: string): GoogleClient | null {
  try {
    if (statSync(file).size > 16_384) { return null }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const client = parsed.installed

    if (!client || typeof client.client_id !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(client.client_id)) { return null }

    if (client.client_secret !== undefined && typeof client.client_secret !== 'string') { return null }

    return { clientId: client.client_id, clientSecret: client.client_secret }
  } catch { return null }
}

export class AtumUtilities {
  private revision = 0
  private attempt: AbortController | null = null
  private lastVerified: { accountId: string; generation: number; revision: number; at: number; degraded: boolean } | null = null
  private writeInProgress = false
  /** The account's own addresses (primary + verified send-as aliases) for replies, asked of Gmail once per ten minutes. */
  private readonly ownerCache = new OwnerAddressCache()
  private protection: { accountId: string; generation: number; root: string; protected: boolean } | null = null

  constructor(private readonly deps: Dependencies) {}

  private capture(): UtilityAccount {
    const account = this.deps.account()

    if (!account) { throw new UtilityFailure('account_changed') }

    return account
  }

  private assertCurrent(account: UtilityAccount, revision: number): void {
    const current = this.deps.account()

    if (!current || current.accountId !== account.accountId || current.generation !== account.generation || revision !== this.revision) { throw new UtilityFailure('account_changed') }
  }

  private storage(account: UtilityAccount): SafeStorageAuthStorage {
    return new SafeStorageAuthStorage(join(account.root, 'utilities.credentials.json'), this.deps.safeStorage)
  }

  private load(account: UtilityAccount): SavedUtilities {
    const storage = this.storage(account)
    const raw = storage.getItem('connections')

    if (storage.failureCode()) { throw new UtilityFailure('storage') }
    const { value, migrated } = decodeUtilities(raw)

    // Persist migration immediately, scrubbing discontinued iCloud Mail secrets.
    if (migrated) { this.save(account, value, this.revision) }
    this.protection = { ...account, protected: value.workspaceProtected === true }

    return value
  }

  private save(account: UtilityAccount, value: SavedUtilities, revision: number): void {
    this.assertCurrent(account, revision)

    try { this.storage(account).setItem('connections', JSON.stringify(value)) }
    catch { throw new UtilityFailure('storage') }

    this.protection = { ...account, protected: value.workspaceProtected === true }
  }

  private project(account: UtilityAccount, value: SavedUtilities, degraded = false): UtilityStatus {
    return {
      accountId: account.accountId, generation: account.generation,
      sources: value.sources.map(({ id, kind, provider, accountKey, label, detail, primary, state, enabled, writable }) => ({
        id, kind, provider, accountKey, label, detail, primary, state, enabled, writable,
        // Mailbox control follows the grant's scopes (agent email control); the field exists only on Gmail sources.
        ...(kind === 'email' && provider === 'google'
          ? { manageable: matrixGoogleCanManageMail(value.accounts.find(group => group.accountKey === accountKey)?.credentials['email-calendar']?.scopes) }
          : {})
      })),
      available: { google: Boolean(this.deps.google), 'apple-calendar': this.deps.apple.available.calendar }, degraded,
      appleConnected: value.appleConnected, calendarSelectionRequired: value.calendarSelectionRequired
      , workspaceProtected: value.workspaceProtected === true
    }
  }

  private failure(error: unknown): UtilityResult {
    let status: UtilityStatus | null = null

    try { const account = this.capture(); status = this.project(account, this.load(account)) } catch { /* signed out or storage unavailable */ }

    // Mailbox-control codes belong to the assistant's tool answer; Settings only knows its own.
    const code = error instanceof UtilityFailure ? error.code : 'network'

    return { status, error: ['scope_missing', 'not_found', 'label_not_found', 'too_large', 'response_invalid'].includes(code) ? 'network' : code as UtilityError }
  }

  private syncCalendars(saved: SavedUtilities, account: SavedGoogleAccount | null, calendars: CalendarEntry[]): void {
    const key = account?.accountKey ?? null
    const previous = saved.sources.filter(source => source.kind === 'calendar' && source.accountKey === key)
    const legacyApple = previous.find(source => source.providerRef === '*')

    // An empty refresh can be a transient native/provider inventory failure.
    // Keep known preferences; an explicit disconnect still clears the group.
    if (!calendars.length && previous.length) { throw new UtilityFailure('network') }

    if (previous.length && !legacyApple && !calendars.some(calendar => previous.some(source => source.providerRef === calendar.id || (source.providerRef === 'primary' && calendar.primary)))) {
      // Provider identifiers changed: never guess which new calendars replace
      // the user's selections. Surface the need to choose them again.
      saved.calendarSelectionRequired = true
    }

    const firstApple = !account && previous.length === 0 && !saved.appleConnected

    const sources: SavedSource[] = calendars.map(calendar => {
      const existing = previous.find(source => source.providerRef === calendar.id || (source.providerRef === 'primary' && calendar.primary))

      return {
        id: existing?.id ?? sourceId(), kind: 'calendar', provider: account ? 'google' : 'apple-calendar', accountKey: key,
        providerRef: calendar.id, label: calendar.label, detail: account?.credentials['email-calendar']?.label ?? calendar.detail, primary: calendar.primary,
        state: 'connected', enabled: existing?.enabled ?? (account ? Boolean(calendar.primary) : firstApple || Boolean(legacyApple?.enabled))
        , writable: calendar.writable === true
      }
    })

    saved.sources = [...saved.sources.filter(source => source.kind !== 'calendar' || source.accountKey !== key), ...sources]
  }

  /**
   * One consent, one token, for whatever the person allowed: each service reads its own
   * slot, so both slots hold the same credential. A service they left unticked gets no
   * source (and loses an earlier one): the assistant reads only what was granted.
   */
  private async applyOneConsent(saved: SavedUtilities, group: SavedGoogleAccount, credential: GoogleCredential, accessToken: string, signal: AbortSignal): Promise<void> {
    const allowed: GoogleGrantedServices = grantedServices(credential.scopes ?? [])
    const others = (kind: 'email' | 'calendar' | 'drive') => saved.sources.filter(source => source.kind !== kind || source.accountKey !== group.accountKey)

    if (allowed.gmail || allowed.calendar) { group.credentials['email-calendar'] = credential } else { delete group.credentials['email-calendar'] }

    if (allowed.drive) { group.credentials.drive = credential } else { delete group.credentials.drive }

    if (allowed.calendar) {
      const calendars = allowed.calendarList ? await googleCalendars(this.deps.fetchImpl, accessToken, signal) : primaryCalendarOnly(credential.label)
      this.syncCalendars(saved, group, calendars)
    } else {
      saved.sources = others('calendar')

      if (!saved.sources.some(source => source.kind === 'calendar')) { saved.calendarSelectionRequired = false }
    }

    for (const kind of ['email', 'drive'] as const) {
      if (!(kind === 'email' ? allowed.gmail : allowed.drive)) {
        saved.sources = others(kind)

        continue
      }

      let source = saved.sources.find(item => item.kind === kind && item.accountKey === group.accountKey)

      if (!source) {
        source = { id: sourceId(), kind, provider: 'google', accountKey: group.accountKey, label: credential.label, state: 'connected', enabled: true }
        saved.sources.push(source)
      }

      source.state = 'connected'

      if (kind === 'email') { source.writable = allowed.send }
    }
  }

  /**
   * Runs a main-process-only operation with a freshly refreshed Google token.
   *
   * This is intentionally not registered in the renderer IPC or the Hermes
   * utility broker. Callers receive the token only for the duration of their
   * callback, after the selected enabled source and account/revision fence have
   * both been checked.
   */
  async withGoogleConnectionProof<T>(service: 'email' | 'calendar', callback: (accessToken: string, connection: GoogleConnectionProof) => Promise<T> | T): Promise<T> {
    const account = this.capture()
    const revision = this.revision
    const saved = this.load(account)
    const source = saved.sources.find(candidate => candidate.kind === service && candidate.provider === 'google' && candidate.enabled)

    if (!source) { throw new UtilityFailure('unavailable') }

    if (source.state !== 'connected') { throw new UtilityFailure('reconnect') }

    const group = saved.accounts.find(candidate => candidate.accountKey === source.accountKey)

    const credential = group?.credentials['email-calendar']

    if (!group || !credential) { throw new UtilityFailure('reconnect') }

    const token = await refreshGoogle(this.deps.fetchImpl, credential)
    this.assertCurrent(account, revision)
    const result = await callback(token, { sourceId: source.id, accountKey: group.accountKey, label: source.label, service })

    this.assertCurrent(account, revision)

    return result
  }

  async status(): Promise<UtilityResult> {
    try {
      const account = this.capture()
      const revision = this.revision
      const saved = this.load(account)
      const last = this.lastVerified
      let degraded = last?.degraded ?? false

      if (!last || last.accountId !== account.accountId || last.generation !== account.generation || last.revision !== revision || Date.now() - last.at > 60_000) {
        degraded = false
        const signal = AbortSignal.timeout(90_000)
        const groups: (SavedGoogleAccount | null)[] = [...saved.accounts, ...(saved.appleConnected ? [null] : [])]
        await this.forEachBounded(groups, async group => {
          try {
            let calendars: CalendarEntry[]

            if (group) {
              // Verify each consent separately. A failed Drive grant cannot mark
              // working Gmail/Calendar disconnected, or the reverse. The one consent
              // keeps one credential in both slots: refresh it once, and check only
              // the services the person allowed.
              const refreshed = new Map<string, Promise<string>>()

              for (const service of ['email-calendar', 'drive'] as const) {
                const credential = group.credentials[service]

                if (!credential) { continue }
                const matching = () => saved.sources.filter(source => source.accountKey === group.accountKey && (source.kind === 'drive') === (service === 'drive'))

                try {
                  let pending = refreshed.get(credential.refreshToken)

                  if (!pending) {
                    pending = refreshGoogle(this.deps.fetchImpl, credential, signal)
                    refreshed.set(credential.refreshToken, pending)
                  }

                  const token = await pending
                  const allowed = grantedServices(credentialScopes(credential, service))

                  if (service === 'drive') { await googleRead(this.deps.fetchImpl, token, 'drive', {}, undefined, signal) }
                  else {
                    if (allowed.gmail) { await googleRead(this.deps.fetchImpl, token, 'email', {}, undefined, signal) }

                    if (allowed.calendar) {
                      calendars = allowed.calendarList ? await googleCalendars(this.deps.fetchImpl, token, signal) : primaryCalendarOnly(credential.label)
                      this.assertCurrent(account, revision)
                      this.syncCalendars(saved, group, calendars)
                    }
                  }

                  this.assertCurrent(account, revision)
                  matching().forEach(source => { source.state = 'connected' })
                } catch (error) {
                  this.assertCurrent(account, revision)

                  if (error instanceof UtilityFailure && ['reconnect', 'denied'].includes(error.code)) { matching().forEach(source => { source.state = 'reconnect' }) }
                  else { degraded = true }
                }
              }

              return
            } else { calendars = (await this.deps.apple.calendar({ action: 'calendars' }, signal)).calendars }

            this.assertCurrent(account, revision)
            this.syncCalendars(saved, group, calendars)
            saved.sources.filter(source => source.accountKey === (group?.accountKey ?? null)).forEach(source => { source.state = 'connected' })
          } catch (error) {
            this.assertCurrent(account, revision)

            if (error instanceof UtilityFailure && ['reconnect', 'denied'].includes(error.code)) {
              saved.sources.filter(source => source.accountKey === (group?.accountKey ?? null)).forEach(source => { source.state = 'reconnect' })
            } else { degraded = true }
          }
        })

        if (saved.accounts.length || saved.sources.length || saved.appleConnected) { this.save(account, saved, revision) }
        this.lastVerified = { accountId: account.accountId, generation: account.generation, revision, at: Date.now(), degraded }
      }

      this.assertCurrent(account, revision)

      return { status: this.project(account, saved, degraded) }
    } catch (error) { return this.failure(error) }
  }

  cancel(): void {
    this.attempt?.abort()
    this.attempt = null
    this.revision++
  }

  async connect(input: UtilityConnectInput): Promise<UtilityResult> {
    this.cancel()
    const controller = new AbortController()
    this.attempt = controller
    const revision = this.revision
    let pendingGoogle: string | undefined

    try {
      const account = this.capture()

      if (!this.deps.safeStorage.isEncryptionAvailable()) { throw new UtilityFailure('storage') }
      const saved = this.load(account)

      if (input?.provider === 'google') {
        if (!this.deps.google) { throw new UtilityFailure('unavailable') }
        const service = input.service ?? 'email-calendar'

        if (service !== 'email-calendar' && service !== 'drive' && service !== 'google') { throw new UtilityFailure('invalid_input') }
        const labels = saved.accounts.flatMap(item => Object.values(item.credentials).map(credential => credential.label.toLowerCase()))
        const result = await authorizeGoogle(this.deps.google, this.deps.openExternal, this.deps.fetchImpl, controller.signal, 180_000, labels, service, this.deps.locale?.() ?? 'en')
        let group = saved.accounts.find(item => Object.values(item.credentials).some(credential => credential.label.toLowerCase() === result.credential.label.toLowerCase()))

        // A grant now exists, so close the export route before a later Calendar
        // inventory call can observe or return Google-derived material. Persist
        // only the sticky latch first: a new group is not durable until it has a
        // credential, and a re-consent must leave its existing grant untouched
        // when a later step fails.
        if (!group) { pendingGoogle = result.credential.refreshToken }

        if (!saved.workspaceProtected) {
          saved.workspaceProtected = true
          this.save(account, saved, revision)
          this.assertCurrent(account, revision)
        } else {
          this.assertCurrent(account, revision)
        }

        // Re-consent replaces credentials in place. Revoking either token would
        // revoke the same account/project grant, including the replacement.
        if (!group) {
          group = { accountKey: accountId(), credentials: {} }
          saved.accounts.push(group)
        }

        saved.workspaceProtected = true

        if (service === 'google') {
          await this.applyOneConsent(saved, group, result.credential, result.accessToken, controller.signal)
        } else if (service === 'drive') {
          group.credentials[service] = result.credential
          let drive = saved.sources.find(source => source.kind === 'drive' && source.accountKey === group.accountKey)

          if (!drive) {
            drive = { id: sourceId(), kind: 'drive', provider: 'google', accountKey: group.accountKey, label: result.credential.label, state: 'connected', enabled: true }
            saved.sources.push(drive)
          }

          drive.state = 'connected'
        } else {
          group.credentials[service] = result.credential
          const calendars = await googleCalendars(this.deps.fetchImpl, result.accessToken, controller.signal)
          let email = saved.sources.find(source => source.kind === 'email' && source.accountKey === group.accountKey)

          if (!email) {
            email = { id: sourceId(), kind: 'email', provider: 'google', accountKey: group.accountKey, label: result.credential.label, state: 'connected', enabled: true }
            saved.sources.push(email)
          }

          email.state = 'connected'
          email.writable = true
          this.syncCalendars(saved, group, calendars)
        }
      } else if (input?.provider === 'apple-calendar') {
        const result = await this.deps.apple.calendar({ action: 'connect' }, controller.signal)
        this.syncCalendars(saved, null, result.calendars)
        saved.appleConnected = true
      } else { throw new UtilityFailure('invalid_input') }

      this.save(account, saved, revision)
      pendingGoogle = undefined
      this.lastVerified = null

      return { status: this.project(account, saved) }
    } catch (error) {
      if (pendingGoogle) { await revokeGoogle(this.deps.fetchImpl, pendingGoogle).catch(() => {}) }

      return this.failure(error)
    } finally { if (this.attempt === controller) { this.attempt = null } }
  }

  async disconnect(input: UtilityDisconnectInput): Promise<UtilityResult> {
    this.cancel()
    const revision = this.revision

    try {
      const account = this.capture()
      const saved = this.load(account)

      if (input?.provider === 'google') {
        const group = saved.accounts.find(item => item.accountKey === input.accountKey)

        if (!group) { throw new UtilityFailure('invalid_input') }

        // A surviving token revokes the project-wide grant. Try every stored
        // token because one service's older token may already be invalid.
        for (const token of new Set(Object.values(group.credentials).map(credential => credential.refreshToken))) {
          await revokeGoogle(this.deps.fetchImpl, token)
        }

        saved.accounts = saved.accounts.filter(item => item !== group)
        saved.sources = saved.sources.filter(source => source.accountKey !== group.accountKey)
      } else if (input?.provider === 'apple-calendar') {
        saved.sources = saved.sources.filter(source => source.provider !== 'apple-calendar')
        saved.appleConnected = false
      } else { throw new UtilityFailure('invalid_input') }

      if (!saved.sources.some(source => source.kind === 'calendar')) { saved.calendarSelectionRequired = false }
      this.save(account, saved, revision)

      return { status: this.project(account, saved) }
    } catch (error) { return this.failure(error) }
  }

  async setEnabled(preferences: UtilitySourcePreference[]): Promise<UtilityResult> {
    this.cancel()
    const revision = this.revision

    try {
      const account = this.capture()
      const saved = this.load(account)

      if (!Array.isArray(preferences) || preferences.length > 1000 || preferences.some(item => !item || typeof item.enabled !== 'boolean' || !saved.sources.some(source => source.id === item.id))) { throw new UtilityFailure('invalid_input') }

      for (const item of preferences) { saved.sources.find(source => source.id === item.id)!.enabled = item.enabled }

      if (preferences.some(item => saved.sources.find(source => source.id === item.id)?.kind === 'calendar')) { saved.calendarSelectionRequired = false }
      this.save(account, saved, revision)

      return { status: this.project(account, saved) }
    } catch (error) { return this.failure(error) }
  }

  private async forEachBounded<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) { await work(items[next++]) }
    }))
  }

  /** Account-wide: memories, files, skills and later chats can retain source data. */
  workspaceProtected(): boolean {
    const account = this.deps.account()

    if (!account) { this.protection = null;

 return false }

    const cached = this.protection

    if (cached && cached.accountId === account.accountId && cached.generation === account.generation && cached.root === account.root) {
      return cached.protected
    }

    return this.load(account).workspaceProtected === true
  }

  /** The saved projection as it stands: no credential refresh, no provider call. */
  savedStatus(): UtilityStatus {
    const account = this.capture()

    return this.project(account, this.load(account))
  }

  /**
   * Returns the saved Google-source projection without refreshing credentials
   * or querying any provider. This is intentionally limited to the Matrix
   * publication-fence recovery path: it lets the owner revoke or disable an
   * already saved grant while the remote publication boundary is unavailable.
   */
  localGoogleStatusForFenceRecovery(): UtilityStatus {
    const account = this.capture()
    const revision = this.revision

    if (!this.deps.google) { throw new UtilityFailure('unavailable') }

    const saved = this.load(account)
    const hasSavedGoogleSource = saved.sources.some(source => source.provider === 'google' && source.accountKey !== null)

    if (!hasSavedGoogleSource) { throw new UtilityFailure('unavailable') }

    this.assertCurrent(account, revision)

    return this.project(account, saved, true)
  }

  /** Main owns the preview and approval; caller-supplied approval is never accepted. */
  async write(accountId: string, generation: number, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) { throw new UtilityFailure('cancelled') }

    if (this.writeInProgress) { throw new UtilityFailure('conflict') }
    this.writeInProgress = true

    try {
      const account = this.capture()
      const revision = this.revision

      if (account.accountId !== accountId || account.generation !== generation) { throw new UtilityFailure('account_changed') }
      const action = parseUtilityWrite(input)
      const ledger = new UtilityWriteLedger(new SafeStorageAuthStorage(join(account.root, 'utilities.actions.json'), this.deps.safeStorage))
      const previous = ledger.lookup(action.operationId, action)

      if (previous) {
        if (previous.state === 'complete' && previous.result) { return { ...previous.result, operationId: action.operationId, replay: true } }
        throw new UtilityFailure('outcome_unknown')
      }

      const saved = this.load(account)
      const kind = action.action === 'send-email' ? 'email' : 'calendar'
      const source = saved.sources.find(item => item.id === action.sourceId && item.kind === kind && item.enabled)

      if (!source || !this.deps.confirmWrite) { throw new UtilityFailure('unavailable') }

      if (source.state !== 'connected') { throw new UtilityFailure('reconnect') }
      const credential = saved.accounts.find(item => item.accountKey === source.accountKey)?.credentials['email-calendar']

      if (source.provider === 'google' && !credential?.scopes?.includes(`https://www.googleapis.com/auth/${kind === 'email' ? 'gmail.send' : 'calendar.events'}`)) { throw new UtilityFailure('reconnect') }

      if (kind === 'calendar' && !source.writable) { throw new UtilityFailure('denied') }
      const token = credential ? await refreshGoogle(this.deps.fetchImpl, credential) : ''
      this.assertCurrent(account, revision)
      let before: GoogleEventSnapshot | undefined

      if (action.action === 'update-event') {
        before = source.provider === 'google'
          ? await inspectGoogleEvent(this.deps.fetchImpl, token, source.providerRef!, action.id)
          : (await this.deps.apple.calendar({ action: 'event', calendarId: source.providerRef, id: action.id })).event
        this.assertCurrent(account, revision)

        if (!before || before.allDay || (before as GoogleEventSnapshot & { hasAttendees?: boolean; hasRecurrence?: boolean }).hasAttendees || (before as GoogleEventSnapshot & { hasRecurrence?: boolean }).hasRecurrence) { throw new UtilityFailure('unsupported') }
      }

      const label = this.deps.writeLabels?.() ?? ENGLISH_WRITE_LABELS

      // A reply or forward is worked out from the message it answers now, so the owner confirms the real
      // recipients, subject and file names, not the instruction that produced them.
      let composed: ResolvedMessage | undefined

      if (action.action === 'send-email' && source.provider === 'google') {
        try {
          const api = desktopGmailApi(this.deps.fetchImpl, token)
          composed = await resolveCompose(api, action, { owner: () => ownerAddresses(api, credential!.label, this.ownerCache) }, { bytes: false, send: true })
        } catch (error) { throw composeFailure(error) }
        this.assertCurrent(account, revision)
      }

      // Everything the assistant will send must be readable in full in the dialog, and so must the whole
      // dialog; refuse (the assistant is told why) rather than send or show anything partly unseen.
      const calendar = action.action === 'send-email' ? null : action
      const mail = action.action === 'send-email' ? { ...action, ...composed } : null

      // The files the owner is asked about, by name and size (a forward's are the original message's).
      const files: Array<{ filename: string; size: number }> = composed
        ? composed.attachments
        : action.action === 'send-email' ? (action.attachments ?? []).map(file => ({ filename: file.filename, size: Math.floor(file.data.length * 3 / 4) })) : []

      const outgoing = mail
        ? [mail.to.join(', '), (mail.cc ?? []).join(', '), (mail.bcc ?? []).join(', '), mail.subject, mail.body, ...files.map(file => file.filename)]
        : [calendar!.title, calendar!.location ?? '', calendar!.description ?? '']

      if (outgoing.some(text => !fitsConfirmation(text))) { throw new UtilityFailure('invalid_input') }

      // Text being sent is shown whole; existing provider text (not sent) is shortened with an indicator.
      const show = (value: string | undefined, sent: boolean) => sent ? confirmationText(value ?? '') : shortenForDisplay(value ?? '')

      const fields = (event: { title: string; start: string; end: string; location?: string; description?: string }, sent: { title?: boolean; location?: boolean; description?: boolean }) =>
        `${label.title}: ${show(event.title, !!sent.title)}\n${label.start}: ${confirmationText(event.start)}\n${label.end}: ${confirmationText(event.end)}\n${label.location}: ${show(event.location, !!sent.location)}\n${label.notes}:\n${show(event.description, !!sent.description)}`

      const detail = mail
        ? [
          `${label.from}: ${confirmationText(credential!.label)}`,
          `${label.to}: ${confirmationText(mail.to.join(', '))}`,
          ...(mail.cc?.length ? [`${label.cc}: ${confirmationText(mail.cc.join(', '))}`] : []),
          ...(mail.bcc?.length ? [`${label.bcc}: ${confirmationText(mail.bcc.join(', '))}`] : []),
          `${label.subject}: ${confirmationText(mail.subject)}`,
          ...(mail.threadId ? [label.inReplyTo] : []),
          ...(files.length ? [`${label.attachments}: ${files.map(file => `${confirmationText(file.filename)} (${fileSize(file.size)})`).join(', ')}`] : []),
          '',
          confirmationText(mail.body),
          ...(composed?.quote ? ['', `${label.forwarded}:`, shortenForDisplay(composed.quote)] : [])
        ].join('\n')
        : `${label.calendar}: ${confirmationText(source.label)}${source.detail ? ` (${confirmationText(source.detail)})` : ''}\n\n${before ? `${label.current}\n${fields(before, {})}\n\n${label.after}\n` : ''}${fields({ ...before, ...calendar! }, { title: true, location: calendar!.location !== undefined, description: calendar!.description !== undefined })}\n\n${label.noInvitations}`

      if (!fitsDialog(detail)) { throw new UtilityFailure('invalid_input') }

      if (signal?.aborted) { throw new UtilityFailure('cancelled') }
      const approved = await this.deps.confirmWrite({ action: action.action, detail, signal })
      this.assertCurrent(account, revision)

      if (!approved || signal?.aborted) { throw new UtilityFailure('cancelled') }
      // Credential refresh and every account/source fence precede the durable
      // dispatch marker. No provider mutation happens if this write fails.
      // Build the message (and download a forward's original files) before the marker: a message that is
      // too large or malformed is then a plain refusal that sent nothing.
      let email: GoogleEmailMessage | undefined

      if (action.action === 'send-email' && source.provider === 'google') {
        const api = desktopGmailApi(this.deps.fetchImpl, token)
        email = await prepareGoogleEmail(api, credential!.label, action, () => ownerAddresses(api, credential!.label, this.ownerCache))
        this.assertCurrent(account, revision)
      }

      ledger.begin(action.operationId, action)
      let result: { id: string; action: string }

      try {
        if (source.provider === 'google') {
          result = await executeGoogleWrite(this.deps.fetchImpl, token, credential!.label, source.providerRef ?? 'primary', action, before, undefined, email)
        } else {
          const { sourceId: _sourceId, operationId: _operationId, ...payload } = action
          const receipt = await this.deps.apple.calendar({ ...before, ...payload, calendarId: source.providerRef, expectedRevision: before?.revision })

          if (typeof receipt.id !== 'string' || !receipt.id) { throw new UtilityFailure('outcome_unknown') }
          result = { id: receipt.id, action: action.action }
        }

        // Keep the receipt in the originating account even if sign-out happened
        // during the provider request, but never return it into the new account.
        ledger.complete(action.operationId, result)
      } catch (error) {
        if (error instanceof UtilityFailure && ['denied', 'reconnect', 'conflict', 'invalid_input', 'unsupported'].includes(error.code)) { throw error }
        throw new UtilityFailure('outcome_unknown')
      }

      this.assertCurrent(account, revision)

      return { ...result, operationId: action.operationId, sourceId: source.id }
    } finally { this.writeInProgress = false }
  }

  /** One enabled, connected Gmail source and its credential, for a mailbox operation. */
  private mailSource(account: UtilityAccount, sourceIdValue: string): { source: SavedSource; credential: GoogleCredential; saved: SavedUtilities } {
    const saved = this.load(account)
    const source = saved.sources.find(item => item.id === sourceIdValue && item.kind === 'email' && item.provider === 'google')

    if (!source) { throw new UtilityFailure('invalid_input') }

    // The owner's switch for this mailbox is authoritative.
    if (!source.enabled) { throw new UtilityFailure('denied') }

    if (source.state !== 'connected') { throw new UtilityFailure('reconnect') }
    const credential = saved.accounts.find(item => item.accountKey === source.accountKey)?.credentials['email-calendar']

    if (!credential) { throw new UtilityFailure('reconnect') }

    return { source, credential, saved }
  }

  /** A source whose token Google refused is shown as needing reconnection, as a read would. */
  private markReconnect(account: UtilityAccount, sourceIdValue: string, revision: number): void {
    const current = this.load(account)

    current.sources.filter(item => item.id === sourceIdValue).forEach(item => { item.state = 'reconnect' })
    this.save(account, current, revision)
    this.lastVerified = null
  }

  /**
   * Reversible mailbox control for the assistant: labels, archive, read/star, trash and drafts. No
   * owner dialog (nothing here sends, deletes for good or reaches another person), but the grant must
   * include gmail.modify; without it the answer is the typed `scope_missing` before any provider call,
   * and no source is marked broken. The request is the broker's own closed grammar, parsed again here.
   */
  async manage(accountId: string, generation: number, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) { throw new UtilityFailure('cancelled') }
    const account = this.capture()
    const revision = this.revision

    if (account.accountId !== accountId || account.generation !== generation) { throw new UtilityFailure('account_changed') }
    const request = parseMatrixGoogleToolRequest(input)

    if (!request || !MATRIX_GOOGLE_MAILBOX_ACTIONS.has(request.action) || !('sourceId' in request)) { throw new UtilityFailure('invalid_input') }
    const { credential } = this.mailSource(account, request.sourceId)

    if (!matrixGoogleCanManageMail(credentialScopes(credential, 'email-calendar'))) { throw new UtilityFailure('scope_missing') }

    try {
      const token = await refreshGoogle(this.deps.fetchImpl, credential, signal)
      this.assertCurrent(account, revision)
      const api = desktopGmailApi(this.deps.fetchImpl, token, signal)
      let result: Record<string, unknown>

      if (request.action === 'mailbox') { result = await mailboxChange(api, request, true) }
      else if (request.action === 'create_label') { result = await createLabel(api, request, true) }
      else if (request.action === 'create_draft' || request.action === 'update_draft') { result = await writeDraft(api, request, true, { owner: () => ownerAddresses(api, credential.label, this.ownerCache) }) }
      else { throw new UtilityFailure('invalid_input') }

      this.assertCurrent(account, revision)

      return { ...result, sourceId: request.sourceId }
    } catch (error) {
      this.assertCurrent(account, revision)

      if (error instanceof UtilityFailure && error.code === 'reconnect') { this.markReconnect(account, request.sourceId, revision) }

      if (error instanceof GmailMailError) { throw new UtilityFailure(error.code as UtilityFailure['code']) }
      throw error
    }
  }

  /** The bytes of one attachment. Reading only; the caller delivers them as a file, never as tool JSON. */
  async attachment(accountId: string, generation: number, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
    if (signal?.aborted) { throw new UtilityFailure('cancelled') }
    const account = this.capture()
    const revision = this.revision

    if (account.accountId !== accountId || account.generation !== generation) { throw new UtilityFailure('account_changed') }
    const request = parseMatrixGoogleToolRequest(input)

    if (!request || request.action !== 'download_attachment') { throw new UtilityFailure('invalid_input') }
    const { credential } = this.mailSource(account, request.sourceId)

    try {
      const token = await refreshGoogle(this.deps.fetchImpl, credential, signal)
      this.assertCurrent(account, revision)
      const file = await fetchAttachment(desktopGmailApi(this.deps.fetchImpl, token, signal), request)
      this.assertCurrent(account, revision)

      return file
    } catch (error) {
      this.assertCurrent(account, revision)

      if (error instanceof UtilityFailure && error.code === 'reconnect') { this.markReconnect(account, request.sourceId, revision) }

      if (error instanceof GmailMailError) { throw new UtilityFailure(error.code as UtilityFailure['code']) }
      throw error
    }
  }

  /** Only the authenticated personal backend can call this through the broker. */
  async read(accountId: string, generation: number, input: Record<string, unknown>): Promise<unknown> {
    const account = this.capture()
    const revision = this.revision

    if (account.accountId !== accountId || account.generation !== generation) { throw new UtilityFailure('account_changed') }

    if (input.action === 'status') {
      const result = await this.status()
      this.assertCurrent(account, revision)

      return result
    }

    const kind = input.kind

    const actions = { email: ['inbox', 'message', 'thread', 'waiting', 'labels', 'drafts'], calendar: ['events'], drive: ['files', 'file'] }

    if ((kind !== 'email' && kind !== 'calendar' && kind !== 'drive') || !actions[kind].includes(String(input.action))) { throw new UtilityFailure('invalid_input') }
    let saved = this.load(account)

    if (kind === 'calendar' && saved.sources.some(source => source.providerRef === '*')) {
      this.lastVerified = null
      await this.status()
      this.assertCurrent(account, revision)
      saved = this.load(account)
    }

    const available = saved.sources.filter(source => source.kind === kind)
    const ids = input.sources

    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !available.some(source => source.id === id)))) { throw new UtilityFailure('invalid_input') }
    const selected = available.filter(source => Array.isArray(ids) ? ids.includes(source.id) : source.enabled)

    // Native message IDs are only unique within a mailbox. Always name its source.
    if (['message', 'thread', 'file', 'labels', 'drafts'].includes(String(input.action)) && (!Array.isArray(ids) || selected.length !== 1)) { throw new UtilityFailure('invalid_input') }

    if (!selected.length) { return { error: kind === 'calendar' && saved.calendarSelectionRequired ? 'calendar_selection_required' : 'connection_required', kind } }
    const results: any[] = []
    const failures: any[] = []
    const skipped = available.filter(source => !selected.includes(source)).map(source => ({ sourceId: source.id, reason: source.enabled ? 'not_selected' : 'disabled' }))
    const signal = AbortSignal.timeout(90_000)
    const tokens = new Map<string, Promise<string>>()
    await this.forEachBounded(selected, async source => {
      const provenance = { sourceId: source.id, provider: source.provider, label: source.label, account: source.detail }

      try {
        if (signal.aborted) { throw new UtilityFailure('timeout') }

        if (source.providerRef === '*') { throw new UtilityFailure('network') }

        if (source.state !== 'connected') { throw new UtilityFailure('reconnect') }
        let data: any

        if (source.provider === 'google') {
          const group = saved.accounts.find(item => item.accountKey === source.accountKey)

          const credential = group?.credentials[kind === 'drive' ? 'drive' : 'email-calendar']

          if (!group || !credential) { throw new UtilityFailure('reconnect') }
          let token = tokens.get(group.accountKey)

          if (!token) { token = refreshGoogle(this.deps.fetchImpl, credential, signal); tokens.set(group.accountKey, token) }
          // Who replied last is judged against this source's own account, never a caller's value.
          const request = kind === 'email' ? { ...input, owner: credential.label } : input
          data = await googleRead(this.deps.fetchImpl, await token, kind, request, source.providerRef, signal)
        } else {
          const range = calendarWindow(input)
          data = await this.deps.apple.calendar({ action: 'events', start: range.timeMin, end: range.timeMax, calendarIds: [source.providerRef] }, signal)
        }

        this.assertCurrent(account, revision)
        const items = input.action === 'waiting' ? 'threads' : { email: 'messages', calendar: 'events', drive: 'files' }[kind]

        if (input.action === 'thread') { data = { ...data, ...provenance } }
        else if (Array.isArray(data[items])) { data[items] = data[items].map((item: any) => ({ ...item, ...provenance })) }
        else if (['message', 'file', 'labels', 'drafts'].includes(String(input.action)) && !Array.isArray(data[items])) { data = { ...data, ...provenance } }

        results.push({ ...provenance, data })
      } catch (error) {
        this.assertCurrent(account, revision)
        const code = signal.aborted ? 'timeout' : error instanceof UtilityFailure ? error.code : 'network'
        failures.push({ ...provenance, error: code })

        if (code === 'reconnect' || code === 'denied') {
          // Reload before marking a source, preserving concurrent read results.
          const current = this.load(account)
          current.sources.filter(item => item.id === source.id).forEach(item => { item.state = 'reconnect' })
          this.save(account, current, revision)
          this.lastVerified = null
        }
      }
    })
    this.assertCurrent(account, revision)
    const order = (left: any, right: any) => selected.findIndex(source => source.id === left.sourceId) - selected.findIndex(source => source.id === right.sourceId)

    return { kind, results: results.sort(order), failures: failures.sort(order), skipped, partial: failures.length > 0, truncated: results.some(result => result.data.more), overlap: kind === 'calendar' && selected.length > 1 }
  }
}
