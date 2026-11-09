import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import type { UtilityError, UtilityMailError, UtilityStatus } from '../../shared/atum-utilities'
import type {
  MatrixGoogleConnectionBridge,
  MatrixGoogleConnectionError,
  MatrixGoogleConnectionGrant,
  MatrixGoogleConnectionResult,
  MatrixGoogleConnectionStatus
} from '../../shared/matrix-google-connections'
import { type MatrixGoogleServices, matrixGoogleServicesOf } from '../../shared/matrix-google-tools'
import { AtumUtilities, type UtilityAccount, type UtilityWriteLabels } from '../atum-utilities'
import { type GoogleClient, UtilityFailure } from '../atum-utilities/google'
import type { SafeStorageLike } from '../encrypted-store'
import type { MainLocale } from '../main-i18n'

const ACCOUNT_KEY = /^[a-f0-9]{64}$/i

/** Exact main-owned context. No renderer value is accepted as an owner. */
export interface MatrixGoogleConnectionOwner {
  accountKey: string
  generation: number
  userId: string
  deviceId: string
  host: object
}

interface MatrixGoogleConnectionsOptions {
  /** A private Matrix directory, never a legacy utilities root. */
  root: string
  owner: () => MatrixGoogleConnectionOwner | null
  safeStorage: SafeStorageLike
  google: GoogleClient | null
  fetchImpl: typeof fetch
  openExternal: (url: string) => Promise<unknown>
  locale?: () => MainLocale
  /**
   * Main's publication boundary. It receives the captured exact owner and must
   * finish before this adapter returns a usable Google source.
   */
  publishFence: (owner: MatrixGoogleConnectionOwner) => Promise<{ v: 1; since: number }>
  /** The owner's native confirmation of the exact message or event. Absent: no writes. */
  confirmWrite?: (preview: { action: 'send-email' | 'create-event' | 'update-event'; detail: string; signal?: AbortSignal }) => Promise<boolean>
  writeLabels?: () => UtilityWriteLabels
  /** Called after any operation that may have changed which services are connected. */
  changed?: () => void
}

/** A tool call's failure: the utility's own code, kept exact (an `outcome_unknown` send
 * may already have happened), plus the adapter's busy and fence refusals. */
export type MatrixGoogleToolError = UtilityError | UtilityMailError | 'busy' | 'fence'

export type MatrixGoogleToolOutcome<T> = { ok: true; value: T } | { ok: false; error: MatrixGoogleToolError }

function validOwner(value: MatrixGoogleConnectionOwner | null): value is MatrixGoogleConnectionOwner {
  return Boolean(value && ACCOUNT_KEY.test(value.accountKey) &&
    Number.isSafeInteger(value.generation) && value.generation >= 0 &&
    typeof value.userId === 'string' && value.userId.length > 0 &&
    typeof value.deviceId === 'string' && value.deviceId.length > 0 &&
    value.host && typeof value.host === 'object')
}

function sameOwner(left: MatrixGoogleConnectionOwner, right: MatrixGoogleConnectionOwner | null): boolean {
  return Boolean(right && left.accountKey === right.accountKey && left.generation === right.generation &&
    left.userId === right.userId && left.deviceId === right.deviceId && left.host === right.host)
}

function privateDirectory(directory: string): void {
  try {
    mkdirSync(directory, { recursive: false, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error('matrix_google_connection_storage')
    }
  }

  try {
    const stat = lstatSync(directory)

    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('matrix_google_connection_storage')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'matrix_google_connection_storage') {
      throw error
    }

    throw new Error('matrix_google_connection_storage')
  }
}

/**
 * Creates only private child paths below the trusted Matrix root. Each segment
 * is lstat'd, so a crafted provider directory cannot redirect the vault.
 */
function connectionRoot(root: string, accountKey: string): string {
  if (!path.isAbsolute(root) || !ACCOUNT_KEY.test(accountKey)) {
    throw new Error('matrix_google_connection_storage')
  }

  privateDirectory(root)
  const providerRoot = path.join(root, 'google-connections')
  privateDirectory(providerRoot)

  const partition = createHash('sha256')
    .update('matrix-google-connection-v1\0', 'utf8')
    .update(accountKey.toLowerCase(), 'utf8')
    .digest('hex')

  const destination = path.join(providerRoot, partition)
  privateDirectory(destination)

  for (const name of ['utilities.credentials.json', 'utilities.credentials.json.tmp']) {
    try {
      const stat = lstatSync(path.join(destination, name))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
        throw new Error('matrix_google_connection_storage')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw new Error('matrix_google_connection_storage') }
    }
  }

  return destination
}

function utilityAccountId(accountKey: string): string {
  return createHash('sha256')
    .update('matrix-google-utility-account-v1\0', 'utf8')
    .update(accountKey.toLowerCase(), 'utf8')
    .digest('hex')
}

function publicError(value: unknown): MatrixGoogleConnectionError {
  if (value instanceof MatrixGoogleFenceFailure) { return 'fence' }
  const code = value instanceof UtilityFailure ? value.code : undefined

  switch (code) {
    case 'cancelled':

    case 'account_changed': return 'cancelled'

    case 'denied': return 'denied'

    case 'reconnect': return 'reconnect'

    case 'storage': return 'storage'

    case 'invalid_input': return 'invalid_input'

    case 'network':

    case 'timeout':

    case 'conflict':

    case 'outcome_unknown': return 'network'

    case 'unavailable': return 'unavailable'

    default: return 'network'
  }
}

class MatrixGoogleFenceFailure extends Error {}

/** Internal provider calls only; renderer input cannot choose these requests. */
function googlePost(input: RequestInfo | URL, init: RequestInit | undefined, endpoint: string): boolean {
  return (typeof input === 'string' || input instanceof URL) && String(input) === endpoint &&
    init?.method === 'POST' && init.body instanceof URLSearchParams
}

/**
 * Matrix-owned projection over AtumUtilities. The utility manager remains the
 * only OAuth implementation and encrypted vault writer; this adapter supplies
 * owner partitioning, handoff fencing and a metadata-only public contract.
 */
export class MatrixGoogleConnections implements MatrixGoogleConnectionBridge {
  private observed: MatrixGoogleConnectionOwner | null = null
  private ownerEpoch = 0
  private activeOwner: MatrixGoogleConnectionOwner | null = null
  private readonly utilities: AtumUtilities

  constructor(private readonly options: MatrixGoogleConnectionsOptions) {
    this.utilities = new AtumUtilities({
      account: () => this.utilityAccount(),
      safeStorage: options.safeStorage,
      google: options.google,
      apple: { available: { calendar: false }, calendar: async () => ({ calendars: [] }) },
      fetchImpl: (input, init) => this.fencedFetch(input, init),
      openExternal: url => this.fencedOpenExternal(url),
      ...(options.locale ? { locale: options.locale } : {}),
      ...(options.confirmWrite ? { confirmWrite: options.confirmWrite } : {}),
      ...(options.writeLabels ? { writeLabels: options.writeLabels } : {})
    })
  }

  /** Whether this build can connect Google at all (its installed-app client is staged). */
  get configured(): boolean {
    return Boolean(this.options.google)
  }

  private savedServices: { key: string; services: MatrixGoogleServices } | null = null

  /**
   * What the current owner's saved grants allow, from the local vault alone: no provider
   * call and no fence publication, so the snapshot can read it on every publish. Null when
   * signed out or the vault can't be read. Cached per owner until an operation changes it.
   */
  services(): MatrixGoogleServices | null {
    const owner = this.currentOwner()

    if (!owner || this.activeOwner) {
      return owner && this.savedServices?.key === owner.accountKey ? this.savedServices.services : null
    }

    if (this.savedServices?.key === owner.accountKey) {
      return this.savedServices.services
    }

    try {
      const status = this.utilities.savedStatus()
      this.remember(owner, status)

      return this.savedServices!.services
    } catch {
      return null
    }
  }

  private remember(owner: MatrixGoogleConnectionOwner, status: UtilityStatus | null | undefined): void {
    if (!status) {
      return
    }

    this.savedServices = {
      key: owner.accountKey,
      services: matrixGoogleServicesOf(status.sources.filter(source => source.provider === 'google' && source.accountKey !== null))
    }
  }

  /**
   * One assistant tool call through the same owner fence as Settings: the account fence is
   * published before any saved grant is read, every provider response is checked against
   * the captured owner, and a handoff cancels the call.
   */
  private async runTool<T>(work: (account: UtilityAccount) => Promise<T>): Promise<MatrixGoogleToolOutcome<T>> {
    let owner: MatrixGoogleConnectionOwner

    try {
      owner = this.capture()
    } catch {
      return { ok: false, error: 'account_changed' }
    }

    if (this.activeOwner) { return { ok: false, error: 'busy' } }
    this.activeOwner = owner

    try {
      if (this.utilities.workspaceProtected()) { await this.publish(owner) }
      const account = this.utilityAccount()

      if (!account) { throw new UtilityFailure('cancelled') }
      const value = await work(account)
      this.assertOwner(owner)

      return { ok: true, value }
    } catch (error) {
      // A handoff is not the owner declining: say the account changed.
      if (!sameOwner(owner, this.currentOwner())) {
        return { ok: false, error: 'account_changed' }
      }

      if (error instanceof MatrixGoogleFenceFailure) { return { ok: false, error: 'fence' } }

      return { ok: false, error: error instanceof UtilityFailure ? error.code : 'network' }
    } finally {
      if (this.activeOwner === owner) {
        this.activeOwner = null
      }
    }
  }

  /** A read for the assistant: the utility's closed read grammar, never a URL or token. */
  toolRead(input: Record<string, unknown>): Promise<MatrixGoogleToolOutcome<unknown>> {
    return this.runTool(account => this.utilities.read(account.accountId, account.generation, input))
  }

  /** A write for the assistant. The utility shows the owner the exact content and waits. */
  toolWrite(input: Record<string, unknown>, signal?: AbortSignal): Promise<MatrixGoogleToolOutcome<unknown>> {
    return this.runTool(account => this.utilities.write(account.accountId, account.generation, input, signal))
  }

  /** A reversible mailbox change for the assistant (labels, archive, read/star, trash, drafts): no dialog. */
  toolMailbox(input: Record<string, unknown>, signal?: AbortSignal): Promise<MatrixGoogleToolOutcome<unknown>> {
    return this.runTool(account => this.utilities.manage(account.accountId, account.generation, input, signal))
  }

  /** One attachment's bytes, for the loopback's raw route; never placed in tool JSON. */
  toolAttachment(input: Record<string, unknown>, signal?: AbortSignal): Promise<MatrixGoogleToolOutcome<{ filename: string; mimeType: string; bytes: Buffer }>> {
    return this.runTool(account => this.utilities.attachment(account.accountId, account.generation, input, signal))
  }

  /** The saved sources and what each account allowed, from the local vault: no provider call. */
  toolStatus(): Promise<MatrixGoogleToolOutcome<UtilityStatus>> {
    return this.runTool(async () => this.utilities.savedStatus())
  }

  private currentOwner(): MatrixGoogleConnectionOwner | null {
    const owner = this.options.owner()

    if (!validOwner(owner)) {
      if (this.observed) {
        this.observed = null
        this.ownerEpoch++
        this.utilities.cancel()
      }
      return null
    }

    if (!sameOwner(owner, this.observed)) {
      this.observed = owner
      this.ownerEpoch++
      this.savedServices = null
      this.utilities.cancel()
    }

    return owner
  }

  private utilityAccount(): UtilityAccount | null {
    const owner = this.currentOwner()

    // Once an operation has captured an owner, a handoff must not let the
    // utility manager's recovery projection open the incoming owner's vault.
    // The outer boundary returns only a closed cancellation for that operation.
    if (!owner || (this.activeOwner && !sameOwner(this.activeOwner, owner))) {
      return null
    }

    try {
      return {
        accountId: utilityAccountId(owner.accountKey),
        // AtumUtilities rechecks this after each provider response. Incrementing
        // the private epoch makes host, user and device handoffs visible there.
        generation: this.ownerEpoch,
        root: connectionRoot(this.options.root, owner.accountKey)
      }
    } catch {
      throw new UtilityFailure('storage')
    }
  }

  private capture(): MatrixGoogleConnectionOwner {
    const owner = this.currentOwner()

    if (!owner) {
      throw new UtilityFailure('cancelled')
    }

    return owner
  }

  private assertOwner(owner: MatrixGoogleConnectionOwner): void {
    if (!sameOwner(owner, this.currentOwner())) {
      throw new UtilityFailure('cancelled')
    }
  }

  private async fencedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const owner = this.activeOwner

    if (!owner) {
      throw new UtilityFailure('cancelled')
    }

    // Revoking the captured operation's old token reduces authority and must
    // remain possible after sign-out/handoff. Only this exact internal request
    // bypasses the fence; it returns no provider material to the new owner.
    if (googlePost(input, init, 'https://oauth2.googleapis.com/revoke') &&
      [...(init!.body as URLSearchParams).keys()].length === 1 &&
      Boolean((init!.body as URLSearchParams).get('token'))) {
      return this.options.fetchImpl(input, init)
    }

    this.assertOwner(owner)
    const response = await this.options.fetchImpl(input, init)
    // A received authorization-code exchange may already have created a grant.
    // Let authorizeGoogle parse its token so the next fenced provider call can
    // trigger cleanup with that token. No source/identity response is exempt.
    if (googlePost(input, init, 'https://oauth2.googleapis.com/token') &&
      (init!.body as URLSearchParams).get('grant_type') === 'authorization_code') {
      return response
    }
    this.assertOwner(owner)

    return response
  }

  private async fencedOpenExternal(url: string): Promise<unknown> {
    const owner = this.activeOwner

    if (!owner) {
      throw new UtilityFailure('cancelled')
    }

    this.assertOwner(owner)
    const result = await this.options.openExternal(url)
    this.assertOwner(owner)

    return result
  }

  private project(status: Awaited<ReturnType<AtumUtilities['status']>>['status']): MatrixGoogleConnectionStatus {
    if (!status) {
      throw new UtilityFailure('unavailable')
    }

    return {
      sources: status.sources
        .filter(source => source.provider === 'google' && source.accountKey !== null)
        .map(source => ({
          id: source.id,
          groupId: source.accountKey!,
          provider: 'google' as const,
          kind: source.kind,
          label: source.label,
          ...(source.primary ? { primary: true } : {}),
          state: source.state,
          enabled: source.enabled,
          ...(source.writable ? { writable: true } : {})
        })),
      available: status.available.google,
      ...(status.degraded ? { degraded: true } : {})
    }
  }

  private async publish(owner: MatrixGoogleConnectionOwner): Promise<void> {
    let receipt: { v: 1; since: number }
    try { receipt = await this.options.publishFence(owner) } catch { throw new MatrixGoogleFenceFailure() }
    this.assertOwner(owner)

    if (!receipt || receipt.v !== 1 || !Number.isSafeInteger(receipt.since) || receipt.since < 0 || Object.keys(receipt).some(key => key !== 'v' && key !== 'since')) {
      throw new MatrixGoogleFenceFailure()
    }
  }

  private async run(
    action: () => Promise<Awaited<ReturnType<AtumUtilities['status']>>>,
    publication: 'existing' | 'consent' | 'none' = 'existing',
    recoverSavedStatusAfterFenceFailure = false
  ): Promise<MatrixGoogleConnectionResult> {
    let owner: MatrixGoogleConnectionOwner

    try {
      owner = this.capture()
    } catch (error) {
      return { status: null, error: publicError(error) }
    }

    // One utility instance owns its OAuth/refresh state. Never overwrite an
    // in-flight operation's owner, even when another account requests status.
    if (this.activeOwner) { return { status: null, error: 'busy' } }
    this.activeOwner = owner

    try {
      // The SDK fence is published before OAuth, refresh, source inventory, or
      // a provider-verified source projection. A failed fence never makes a
      // Google source usable; status may return saved metadata solely for revoke
      // and disable recovery below.
      // Opening an empty status panel must not publish a permanent Google
      // fence. Existing grants are detected locally before any provider read.
      if (publication === 'consent' || (publication === 'existing' && this.utilities.workspaceProtected())) { await this.publish(owner) }
      const result = await action()
      this.assertOwner(owner)

      if (result.error) {
        return { status: null, error: publicError(new UtilityFailure(result.error)) }
      }

      const status = this.project(result.status)
      this.remember(owner, result.status)
      this.options.changed?.()

      return { status }
    } catch (error) {
      if (!sameOwner(owner, this.currentOwner())) {
        return { status: null, error: 'cancelled' }
      }

      // A fresh settings mount needs the opaque ids from the saved grant to
      // disable or revoke it. Never verify or refresh the provider here: this
      // is a local vault projection solely for a failed status publication.
      if (recoverSavedStatusAfterFenceFailure && error instanceof MatrixGoogleFenceFailure) {
        try {
          const recovered = this.utilities.localGoogleStatusForFenceRecovery()
          this.assertOwner(owner)

          return { status: this.project(recovered) }
        } catch (recoveryError) {
          if (!sameOwner(owner, this.currentOwner())) {
            return { status: null, error: 'cancelled' }
          }

          return { status: null, error: publicError(recoveryError) }
        }
      }

      return { status: null, error: publicError(error) }
    } finally {
      if (this.activeOwner === owner) {
        this.activeOwner = null
      }
    }
  }

  status(): Promise<MatrixGoogleConnectionResult> {
    return this.run(() => this.utilities.status(), 'existing', true)
  }

  connect(grant: MatrixGoogleConnectionGrant): Promise<MatrixGoogleConnectionResult> {
    if (grant !== 'google' && grant !== 'email-calendar' && grant !== 'drive') { return Promise.resolve({ status: null, error: 'invalid_input' }) }
    return this.run(() => this.utilities.connect({ provider: 'google', service: grant }), 'consent')
  }

  disconnect(groupId: string): Promise<MatrixGoogleConnectionResult> {
    return this.run(() => this.utilities.disconnect({ provider: 'google', accountKey: groupId }), 'none')
  }

  setSourcePreferences(preferences: ReadonlyArray<{ id: string; enabled: boolean }>): Promise<MatrixGoogleConnectionResult> {
    return this.run(() => this.utilities.setEnabled([...preferences]), preferences.some(item => item.enabled) ? 'existing' : 'none')
  }
}
