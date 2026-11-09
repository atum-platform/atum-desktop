import type { MatrixRefreshResult } from '../../../apps/desktop/shared/matrix'

import { browserOAuth, type BrowserOAuth } from './oauth'
import { BrowserFailure, parseRecord, requireScope, sdkConfiguration, type BrowserConfig, type DeviceRecord, type DeviceSession, type PendingLogin } from './record'
import { requireCryptoStores, type DeviceStore } from './storage'
import type { MatrixBinding } from './domain-record'

/** No identity/session split, no recovery of malformed records by inventing a device. */
export class BoundDevice {
  private record?: DeviceRecord
  private rotating?: Promise<MatrixRefreshResult>
  private signingOut = false
  private invalid = false
  private readonly authenticationRun = crypto.randomUUID()
  private credentialGeneration = 0
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly config: BrowserConfig, private readonly store: DeviceStore,
    private readonly oauth: BrowserOAuth = browserOAuth,
    private readonly cryptoExists: (deviceId: string) => Promise<void> = requireCryptoStores,
    private readonly failed: () => void = () => {},
    private readonly mode: 'proof' | 'chat' = 'proof') {}

  async load(): Promise<'empty' | 'pending' | 'active'> {
    const raw = await this.store.read()
    if (raw === undefined) return 'empty'
    this.record = parseRecord(raw, this.config)
    if (this.record.kind === 'login') {
      if (this.record.phase !== 'pending' || Date.now() - this.record.createdAt > 600000 || this.record.createdAt > Date.now()) {
        throw new BrowserFailure('recovery_needed')
      }
      return 'pending'
    }
    if (this.record.phase === 'signed_out') throw new BrowserFailure('signed_out')
    if (this.record.phase !== 'active' && !(this.mode === 'chat' && this.record.phase === 'establishing')) throw new BrowserFailure('recovery_needed')
    if (this.mode === 'proof') await this.cryptoExists(this.record.deviceId)
    // Validate/rotate before the engine can write crypto or sync with stale credentials.
    const refreshed = await this.refresh(this.record.refreshToken)
    if (!refreshed.ok) throw new BrowserFailure('recovery_needed')
    return 'active'
  }

  private save(record: DeviceRecord): Promise<void> {
    // Serialize this record's phase transitions as well as IDB's atomic commits.
    // A late refresh can never overwrite a mismatch's blocked state.
    const work = this.writing.then(async () => {
      if (this.invalid && record.kind === 'session' && ['active', 'establishing', 'refreshing'].includes(record.phase)) {
        throw new BrowserFailure('recovery_needed')
      }
      const next = { ...record, revision: (this.record?.revision ?? 0) + 1 }
      parseRecord(next, this.config)
      await this.store.replace(this.record?.revision ?? null, next)
      this.record = next
    })
    this.writing = work.catch(() => {})
    return work
  }

  async beginLogin(): Promise<URL> {
    // Re-read so even a caller that forgot load cannot overwrite a persisted device.
    if (this.record || await this.store.read() !== undefined) throw new BrowserFailure('recovery_needed')
    const prepared = await this.oauth.prepare(this.config)
    const pending: PendingLogin = { ...this.config, version: 1, revision: 1, kind: 'login', phase: 'pending',
      deviceId: crypto.randomUUID(), storageKey: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
      verifier: prepared.verifier, state: prepared.state, nonce: prepared.nonce, createdAt: Date.now() }
    const url = await this.oauth.authorize(prepared.config, pending)
    await this.save(pending)
    return url
  }

  async callback(url: URL): Promise<void> {
    const record = this.record
    if (!record || record.kind !== 'login' || record.phase !== 'pending' ||
        url.origin + url.pathname !== this.config.redirectUri || url.hash ||
        [...url.searchParams.keys()].some(k => !['code', 'state', 'iss', 'session_state', 'error', 'error_description', 'error_uri'].includes(k)) ||
        url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== record.state ||
        url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') ||
        (url.searchParams.has('iss') && url.searchParams.get('iss') !== record.issuer)) {
      throw new BrowserFailure('signed_out')
    }
    // A spent/uncertain exchange is durable before network I/O, never replayed on reload.
    await this.save({ ...record, phase: 'exchanging' })
    try {
      const tokens = await this.oauth.exchange(record, url)
      const identity = await this.oauth.whoami(record, tokens.accessToken)
      if (identity.deviceId !== record.deviceId || !tokens.subject) throw new BrowserFailure('recovery_needed')
      await this.save({ ...this.config, version: 1, revision: this.record!.revision,
        kind: 'session', phase: 'establishing', deviceId: record.deviceId, storageKey: record.storageKey,
        userId: identity.userId, subject: tokens.subject, scope: tokens.scope,
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt })
    } catch { throw new BrowserFailure('recovery_needed') }
  }

  configuration() {
    const record = this.record
    if (this.invalid || this.signingOut || !record || record.kind !== 'session' || !['active', 'establishing'].includes(record.phase)) throw new BrowserFailure('signed_out')
    return sdkConfiguration(record)
  }

  /** Non-secret binding only; remains available for terminal grant cleanup. */
  identity(): MatrixBinding {
    const record = this.record
    if (!record || record.kind !== 'session') throw new BrowserFailure('signed_out')
    return { issuer: record.issuer, subject: record.subject, userId: record.userId, deviceId: record.deviceId }
  }

  /** Retry correlation expires on reload or any access-token rotation. No credential leaves here. */
  sendEpoch(): string { return `${this.authenticationRun}:${this.credentialGeneration}` }

  closeAdmission(): void { this.signingOut = true }

  async cryptoStarted(): Promise<void> {
    const record = this.record
    if (!record || record.kind !== 'session' || !['active', 'establishing'].includes(record.phase)) throw new BrowserFailure('recovery_needed')
    await this.cryptoExists(record.deviceId)
    if (record.phase === 'establishing') await this.save({ ...record, phase: 'active' })
  }

  /** Consumer chat requires a running SDK, not user recovery/verification setup. */
  async sdkStarted(): Promise<void> {
    if (this.mode === 'proof') return this.cryptoStarted()
    const record = this.record
    if (!record || record.kind !== 'session' || !['active', 'establishing'].includes(record.phase)) throw new BrowserFailure('recovery_needed')
    if (record.phase === 'establishing') await this.save({ ...record, phase: 'active' })
  }

  refresh(handle: string): Promise<MatrixRefreshResult> {
    if (this.invalid || this.signingOut) return Promise.resolve({ ok: false, reauthenticate: true })
    const record = this.record
    if (this.rotating && record?.kind === 'session' && handle === record.refreshToken) return this.rotating
    if (!record || record.kind !== 'session' || !['active', 'establishing'].includes(record.phase) || handle !== record.refreshToken) {
      void this.block()
      return Promise.resolve({ ok: false, reauthenticate: true })
    }
    const phase = record.phase
    const operation = (async (): Promise<MatrixRefreshResult> => {
      try {
        await this.save({ ...record, phase: 'refreshing' })
        const tokens = await this.oauth.refresh(record)
        requireScope(tokens.scope, record.deviceId)
        const identity = await this.oauth.whoami(record, tokens.accessToken)
        if (this.invalid || identity.userId !== record.userId || identity.deviceId !== record.deviceId ||
            (tokens.subject !== undefined && tokens.subject !== record.subject)) {
          throw new BrowserFailure('recovery_needed')
        }
        // Persist the rotated credentials with the exact old identity/key before SDK acknowledgement.
        await this.save({ ...record, phase, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt, scope: tokens.scope })
        this.credentialGeneration++
        return { ok: true, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }
      } catch {
        await this.block()
        return { ok: false, reauthenticate: true }
      }
    })()
    this.rotating = operation.finally(() => { this.rotating = undefined })
    return this.rotating
  }

  private async block() {
    this.invalid = true
    const record = this.record
    if (record?.kind === 'session' && record.phase !== 'signed_out') {
      // Even if disk writes fail, memory becomes unusable. The durable refreshing
      // marker already prevents an uncertain rotation from being reused after reload.
      this.record = { ...record, phase: 'blocked' }
      await this.save(this.record).catch(() => {})
    }
    this.failed()
  }

  async prepareSignOut(): Promise<DeviceSession> {
    // Close admission synchronously, including a refresh arriving while sign-out
    // yields. An already-started rotation settles before the signed-out commit.
    this.closeAdmission()
    await this.rotating
    const record = this.record
    if (!record || record.kind !== 'session') throw new BrowserFailure('signed_out')
    await this.save({ ...record, phase: 'signed_out' })
    return record
  }

  async revokeSignOut(record: DeviceSession): Promise<void> {
    // Preserve crypto and identity. No automatic deletion, replacement login, or device reset.
    await this.oauth.revoke(record)
    if (!['active', 'establishing'].includes(record.phase)) throw new BrowserFailure('recovery_needed')
  }

  async signOut(): Promise<void> {
    await this.revokeSignOut(await this.prepareSignOut())
  }
}
