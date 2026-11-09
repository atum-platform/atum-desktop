import { BrowserFailure } from './record'
import { domainOAuth, DomainHttpFailure, type DomainOAuth, type DomainResource } from './domain-oauth'
import { parseDomainRecord, sameMatrixBinding, type DomainConfig, type DomainPending, type DomainRecord, type DomainSession, type DomainStore, type MatrixBinding } from './domain-record'

/** Independent domain grant. No Matrix credential/key/SDK operation is reachable here. */
export class DomainGrant {
  private record?: DomainRecord
  private rotating?: Promise<boolean>
  private writing: Promise<void> = Promise.resolve()
  private closing = false
  private invalid = false
  private empty = false
  constructor(private readonly config: DomainConfig, private readonly store: DomainStore,
    private readonly matrix: () => MatrixBinding, private readonly oauth: DomainOAuth = domainOAuth) {}

  hasRecord(): Promise<boolean> { return this.store.read().then(value => value !== undefined) }
  canConnect(): boolean {
    return !this.closing && (this.empty || this.record?.kind === 'domain-session' && this.record.phase === 'blocked')
  }
  isActive(): boolean { try { this.admitted(); return true } catch { return false } }

  async load(): Promise<'empty' | 'pending' | 'active'> {
    const raw = await this.store.read()
    this.empty = raw === undefined
    if (this.empty) return 'empty'
    this.record = parseDomainRecord(raw, this.config, this.matrix())
    if (this.record.kind === 'domain-login') {
      if (this.record.phase !== 'pending' || this.record.createdAt > Date.now() || Date.now() - this.record.createdAt > 600000) throw new BrowserFailure('recovery_needed')
      return 'pending'
    }
    if (this.record.phase === 'signed_out') throw new BrowserFailure('signed_out')
    if (this.record.phase !== 'active' || !await this.refresh()) throw new BrowserFailure('recovery_needed')
    return 'active'
  }
  private save(record: DomainRecord): Promise<void> {
    const work = this.writing.then(async () => {
      if (this.invalid && record.kind === 'domain-session' && ['active', 'refreshing'].includes(record.phase)) throw new BrowserFailure('recovery_needed')
      const next = { ...record, revision: (this.record?.revision ?? 0) + 1 }
      // Terminal cleanup keeps the captured binding after Matrix admission closes.
      // Active transitions still compare against the current Matrix identity.
      parseDomainRecord(next, this.config, this.closing &&
        (next.kind === 'domain-login' || ['blocked', 'signed_out'].includes(next.phase)) ? next.matrix : this.matrix())
      await this.store.replace(this.record?.revision ?? null, next)
      this.record = next
      this.empty = false
    })
    this.writing = work.catch(() => {})
    return work
  }
  async beginLogin(): Promise<URL> {
    if (this.closing) throw new BrowserFailure('signed_out')
    await this.rotating
    const raw = await this.store.read()
    if (raw !== undefined) {
      this.record = parseDomainRecord(raw, this.config, this.matrix())
      if (this.record.kind === 'domain-session' && this.record.phase === 'signed_out') throw new BrowserFailure('signed_out')
      if (this.record.kind !== 'domain-session' || this.record.phase !== 'blocked') throw new BrowserFailure('recovery_needed')
    }
    const matrix = this.matrix()
    const prepared = await this.oauth.prepare(this.config)
    if (this.closing || !sameMatrixBinding(matrix, this.matrix())) throw new BrowserFailure('signed_out')
    const pending: DomainPending = { ...this.config, version: 1, revision: 1, matrix, kind: 'domain-login', phase: 'pending',
      verifier: prepared.verifier, state: prepared.state, nonce: prepared.nonce, createdAt: Date.now() }
    const url = await this.oauth.authorize(prepared.config, pending)
    this.invalid = false
    await this.save(pending)
    return url
  }
  async callback(url: URL): Promise<void> {
    const record = this.record
    if (this.closing || !record || record.kind !== 'domain-login' || record.phase !== 'pending' ||
        !sameMatrixBinding(record.matrix, this.matrix()) || record.createdAt > Date.now() || Date.now() - record.createdAt > 600000 ||
        url.origin + url.pathname !== this.config.redirectUri || url.hash ||
        [...url.searchParams.keys()].some(key => !['code', 'state', 'iss', 'session_state', 'error', 'error_description', 'error_uri'].includes(key)) ||
        url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== record.state ||
        url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') || url.searchParams.getAll('iss').length > 1 ||
        (url.searchParams.has('iss') && url.searchParams.get('iss') !== record.issuer)) throw new BrowserFailure('signed_out')
    await this.save({ ...record, phase: 'exchanging' })
    try {
      const tokens = await this.oauth.exchange(record, url)
      const owner = await this.oauth.me(record, tokens.accessToken)
      if (this.closing || !sameMatrixBinding(record.matrix, this.matrix()) || tokens.scope !== 'openid' || tokens.subject !== record.matrix.subject ||
          owner.issuer !== record.issuer || owner.subject !== record.matrix.subject) throw new BrowserFailure('recovery_needed')
      await this.save({ ...this.config, version: 1, revision: this.record!.revision, matrix: record.matrix, kind: 'domain-session', phase: 'active',
        principal: owner.principal, scope: 'openid', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt })
    } catch { this.invalid = true; throw new BrowserFailure('recovery_needed') }
  }
  refresh(): Promise<boolean> {
    if (this.closing || this.invalid) return Promise.resolve(false)
    if (this.rotating) return this.rotating
    const record = this.record
    if (!record || record.kind !== 'domain-session' || record.phase !== 'active') return Promise.resolve(false)
    const operation = (async () => {
      try {
        await this.save({ ...record, phase: 'refreshing' })
        const tokens = await this.oauth.refresh(record)
        const owner = await this.oauth.me(record, tokens.accessToken)
        if (this.invalid || !sameMatrixBinding(record.matrix, this.matrix()) || tokens.scope !== 'openid' ||
            (tokens.subject !== undefined && tokens.subject !== record.matrix.subject) || owner.issuer !== record.issuer ||
            owner.subject !== record.matrix.subject || owner.principal !== record.principal) throw new BrowserFailure('recovery_needed')
        await this.save({ ...record, phase: 'active', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt })
        return true
      } catch {
        this.invalid = true
        const current = this.record
        if (current?.kind === 'domain-session' && current.phase !== 'signed_out') await this.save({ ...current, phase: 'blocked' }).catch(() => {})
        return false
      }
    })()
    this.rotating = operation.finally(() => { this.rotating = undefined })
    return this.rotating
  }
  private admitted(): DomainSession {
    const record = this.record
    if (this.closing || this.invalid || !record || record.kind !== 'domain-session' || record.phase !== 'active' ||
        !sameMatrixBinding(record.matrix, this.matrix())) throw new BrowserFailure('signed_out')
    return record
  }
  async request(resource: DomainResource): Promise<unknown> {
    let record = this.admitted()
    if (record.expiresAt <= Date.now() + 30000) {
      if (!await this.refresh()) throw new BrowserFailure('recovery_needed')
      record = this.admitted()
    }
    const visible = (result: unknown) => {
      const current = this.admitted()
      if (current.principal !== record.principal || !sameMatrixBinding(current.matrix, record.matrix)) throw new BrowserFailure('signed_out')
      return result
    }
    try { return visible(await this.oauth.request(record, record.accessToken, resource)) }
    catch (error) {
      if (!(error instanceof DomainHttpFailure) || error.status !== 401 || !await this.refresh()) throw error
      record = this.admitted()
      return visible(await this.oauth.request(record, record.accessToken, resource))
    }
  }
  closeAdmission(): void { this.closing = true }
  async prepareSignOut(): Promise<DomainSession | undefined> {
    this.closeAdmission()
    await this.rotating
    const record = this.record
    if (!record) return
    if (record.kind === 'domain-login') {
      // Pending has not exchanged a code. Exchanging may have issued a grant
      // before a failed owner check; no durable handle can confirm its revocation.
      await this.save({ ...record, phase: 'exchanging' })
      if (record.phase === 'exchanging') throw new BrowserFailure('recovery_needed')
      return
    }
    await this.save({ ...record, phase: 'signed_out' })
    return record
  }
  async revokeSignOut(record: DomainSession): Promise<void> {
    await this.oauth.revoke(record)
    // An uncertain rotation may have consumed this handle. MAS returns 200 for
    // consumed handles without revoking the newly issued session credentials.
    if (record.phase !== 'active') throw new BrowserFailure('recovery_needed')
  }
  async signOut(): Promise<void> {
    const record = await this.prepareSignOut()
    if (record) await this.revokeSignOut(record)
  }
}
