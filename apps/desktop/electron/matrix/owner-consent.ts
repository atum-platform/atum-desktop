import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomicSync } from '../atum-staged-swap/store'

import { readDomainJson } from './domain'

/**
 * The owner consents Shell keeps for the desktop (the ChatGPT-with-Google training confirmation,
 * the video-generation consent): the same MAS owner bearer through `account.s1Request`, the same
 * host-bridge contract header, the same `{state}` refusals, and the same revocation that survives a
 * restart. Each consent owns only its path, its body and how it reads the projection. Owner,
 * locale, timestamps, wording hashes and revisions are server-owned; nothing here is authority.
 */
const CONTRACT = 'atum.s2.host-bridge/1.0.0'

export const MATRIX_CONSENT_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu

export type MatrixOwnerConsentMethod = 'GET' | 'POST' | 'DELETE'
export interface MatrixOwnerConsentAnswer { status: number; value: unknown }
export interface MatrixOwnerConsentInit { body?: unknown; idempotencyKey?: string }
export interface MatrixOwnerConsentScope { accountKey: string; generation: number }

export type MatrixOwnerConsentCall = (method: MatrixOwnerConsentMethod, signal: AbortSignal,
  init?: MatrixOwnerConsentInit) => Promise<MatrixOwnerConsentAnswer>

export function matrixConsentRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function sameMatrixConsentScope(now: MatrixOwnerConsentScope | null, scope: MatrixOwnerConsentScope): boolean {
  return now?.accountKey === scope.accountKey && now.generation === scope.generation
}

export async function requestMatrixOwnerConsent(endpoint: string, resource: string, accessToken: string,
  method: MatrixOwnerConsentMethod, signal: AbortSignal, init: MatrixOwnerConsentInit = {}): Promise<MatrixOwnerConsentAnswer> {
  const url = new URL(endpoint, resource)

  if (url.protocol !== 'https:') {throw new Error('matrix_owner_consent_unavailable')}

  const response = await fetch(url, { method, signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'X-Atum-Host-Bridge-Contract': CONTRACT,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })

  // Let account.s1Request refresh the bearer once; anything else is a status for the caller.
  if (response.status === 401) { await response.body?.cancel(); throw new Error('matrix_s1_authentication') }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()

    return { status: response.status, value: null }
  }

  try { return { status: response.status, value: await readDomainJson(response, 16 * 1024) } }
  catch { return { status: response.status, value: null } }
}

/**
 * A pending revocation's Idempotency-Key, per Atum account, kept on disk so a quit or crash
 * mid-revocation resumes with the SAME key (the checkout/store intent-journal pattern: written
 * before the first request, cleared only after the server's 200). Never a credential.
 */
export interface MatrixOwnerConsentRevokeJournal {
  read(accountKey: string): string | null
  write(accountKey: string, key: string | null): void
}

/** `<root>/<accountKey>/revoke-intent.json`, one root per consent. */
export class FileOwnerConsentRevokeJournal implements MatrixOwnerConsentRevokeJournal {
  constructor(private readonly root: string) {}

  private file(accountKey: string): string {
    if (!/^[a-f0-9]{64}$/u.test(accountKey)) {throw new Error('matrix_owner_consent_invalid')}

    return path.join(this.root, accountKey, 'revoke-intent.json')
  }

  read(accountKey: string): string | null {
    let value: unknown

    try { value = JSON.parse(fs.readFileSync(this.file(accountKey), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return null}
      throw new Error('matrix_owner_consent_journal_invalid')
    }

    if (!matrixConsentRecord(value) || value.version !== 1 || Object.keys(value).length !== 2 ||
        typeof value.idempotencyKey !== 'string' || !MATRIX_CONSENT_UUID.test(value.idempotencyKey)) {
      throw new Error('matrix_owner_consent_journal_invalid')
    }

    return value.idempotencyKey
  }

  write(accountKey: string, key: string | null): void {
    const file = this.file(accountKey)

    if (key === null) { fs.rmSync(file, { force: true })

      return }

    if (!MATRIX_CONSENT_UUID.test(key)) {throw new Error('matrix_owner_consent_invalid')}
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileAtomicSync(file, JSON.stringify({ version: 1, idempotencyKey: key }))
  }
}

/** 503 means "not yet" (live calls drain, or the platform blinked): the SAME key retries. */
const REVOKE_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 5_000] as const

export type MatrixOwnerConsentRevokeOutcome = 'revoked' | 'pending' | 'unavailable'

/**
 * One account's revocation: one DELETE flight with one Idempotency-Key until the server answers
 * `200 {current:false}`. Activating an account loads only that account's pending key and resumes it.
 */
export class MatrixOwnerConsentRevocation {
  private owner: MatrixOwnerConsentScope | null = null
  private key?: string
  private flight?: Promise<MatrixOwnerConsentRevokeOutcome>

  constructor(private readonly options: {
    scope(): MatrixOwnerConsentScope | null
    call: MatrixOwnerConsentCall
    journal: MatrixOwnerConsentRevokeJournal
    sleep?: (ms: number) => Promise<void>
    key?: () => string
  }) {}

  /** Whether this account still has a revocation to finish (a confirm is fenced meanwhile). */
  get pending(): boolean {
    return Boolean(this.key)
  }

  activate(owner: MatrixOwnerConsentScope | null): void {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) {return}
    this.owner = owner; this.key = undefined; this.flight = undefined

    if (!owner) {return}

    try { this.key = this.options.journal.read(owner.accountKey) ?? undefined }
    catch { this.key = undefined }

    if (this.key) {void this.revoke()}
  }

  revoke(): Promise<MatrixOwnerConsentRevokeOutcome> {
    this.flight ??= this.once().finally(() => { this.flight = undefined })

    return this.flight
  }

  private async once(): Promise<MatrixOwnerConsentRevokeOutcome> {
    const scope = this.options.scope()

    if (!scope) {return 'unavailable'}
    let key = this.key

    if (!key) {
      key = (this.options.key ?? randomUUID)()

      // The key is on disk before the first DELETE, or no DELETE is sent.
      try { this.options.journal.write(scope.accountKey, key) } catch { return 'unavailable' }
      this.key = key
    }

    const sleep = this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))

    for (let attempt = 0; ; attempt += 1) {
      const answer = await this.options.call('DELETE', AbortSignal.timeout(15_000), { idempotencyKey: key }).catch(() => undefined)

      if (!sameMatrixConsentScope(this.options.scope(), scope)) {return 'unavailable'}

      if (answer?.status === 200 && matrixConsentRecord(answer.value) && answer.value.current === false) {
        // Only the server's 200 ends this revocation. A failed clear just replays it next start.
        try { this.options.journal.write(scope.accountKey, null) } catch { /* replayed harmlessly */ }
        this.key = undefined

        return 'revoked'
      }

      // 503 or a network blink: same key, short backoff. Any other answer keeps the key too.
      if (answer && answer.status !== 503) {return 'unavailable'}
      const delay = REVOKE_BACKOFF_MS[attempt]

      // A long wait: the next press retries with this same key.
      if (delay === undefined) {return 'pending'}
      await sleep(delay)

      if (!sameMatrixConsentScope(this.options.scope(), scope)) {return 'unavailable'}
    }
  }
}
