import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  MATRIX_CHATGPT_TRAINING_WORDING,
  MATRIX_CHATGPT_TRANSFER_WORDING,
  type MatrixChatGptTrainingConfirmResult,
  type MatrixChatGptTrainingRevokeResult,
  type MatrixChatGptTrainingStatus
} from '../../shared/matrix-subscriptions'
import { writeFileAtomicSync } from '../atum-staged-swap/store'

import { readDomainJson } from './domain'

/**
 * The account's one-time "training is off" confirmation for using a ChatGPT plan with Google
 * data (Shell `/api/connections/openai-codex/training-confirmation`, contract r3). The desktop
 * only collects the explicit checkbox and transfer acceptance and forwards them with the MAS
 * owner bearer, the same `account.s1Request` path the carry route uses (chatgpt-carry.ts).
 * Owner, timestamps, wording hashes and revisions are server-owned; nothing here is authority.
 */
export const MATRIX_CHATGPT_TRAINING_PATH = '/api/connections/openai-codex/training-confirmation'
const CONTRACT = 'atum.s2.host-bridge/1.0.0'
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu

export type MatrixChatGptTrainingMethod = 'GET' | 'POST' | 'DELETE'
export interface MatrixChatGptTrainingAnswer { status: number; value: unknown }
interface Scope { accountKey: string; generation: number }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function requestMatrixChatGptTraining(resource: string, accessToken: string,
  method: MatrixChatGptTrainingMethod, signal: AbortSignal,
  init: { body?: unknown; idempotencyKey?: string } = {}): Promise<MatrixChatGptTrainingAnswer> {
  const url = new URL(MATRIX_CHATGPT_TRAINING_PATH, resource)

  if (url.protocol !== 'https:') {throw new Error('matrix_chatgpt_training_unavailable')}

  const response = await fetch(url, { method, signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'X-Atum-Host-Bridge-Contract': CONTRACT,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })

  // Let account.s1Request refresh the bearer once; anything else is a status for the caller.
  if (response.status === 401) { await response.body?.cancel(); throw new Error('matrix_s1_authentication') }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel();

 return { status: response.status, value: null }
  }

  try { return { status: response.status, value: await readDomainJson(response, 16 * 1024) } }
  catch { return { status: response.status, value: null } }
}

/** The GET/POST projection, strictly. A wording other than v1 is not current for this build. */
export function parseMatrixChatGptTraining(value: unknown): Omit<MatrixChatGptTrainingStatus, 'required' | 'revoking'> | undefined {
  if (!record(value) || typeof value.current !== 'boolean') {return}
  const { wordingVersion, connectionId, confirmedAt, revision } = value

  if ((wordingVersion !== null && typeof wordingVersion !== 'string') ||
      (connectionId !== null && (typeof connectionId !== 'string' || !UUID.test(connectionId))) ||
      (confirmedAt !== null && (typeof confirmedAt !== 'string' || !Number.isFinite(Date.parse(confirmedAt)))) ||
      (revision !== null && (!Number.isSafeInteger(revision) || Number(revision) < 0))) {
    return
  }

  const current = value.current && wordingVersion === MATRIX_CHATGPT_TRAINING_WORDING

  return {
    current,
    connectionId: connectionId as string | null,
    confirmedAt: current && typeof confirmedAt === 'string' ? Date.parse(confirmedAt) : null
  }
}

/**
 * The pending revocation's Idempotency-Key, per Atum account, kept on disk so a quit or crash
 * mid-drain resumes with the SAME key (the checkout/store intent-journal pattern: written before the
 * first request, cleared only after the server's 200). Nothing else is stored; never a credential.
 */
export interface MatrixChatGptTrainingRevokeJournal {
  read(accountKey: string): string | null
  write(accountKey: string, key: string | null): void
}

export class FileChatGptTrainingRevokeJournal implements MatrixChatGptTrainingRevokeJournal {
  constructor(private readonly root: string) {}

  private file(accountKey: string): string {
    if (!/^[a-f0-9]{64}$/u.test(accountKey)) {throw new Error('matrix_chatgpt_training_invalid')}

    return path.join(this.root, accountKey, 'revoke-intent.json')
  }

  read(accountKey: string): string | null {
    let value: unknown

    try { value = JSON.parse(fs.readFileSync(this.file(accountKey), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return null}
      throw new Error('matrix_chatgpt_training_journal_invalid')
    }

    if (!record(value) || value.version !== 1 || Object.keys(value).length !== 2 ||
        typeof value.idempotencyKey !== 'string' || !UUID.test(value.idempotencyKey)) {
      throw new Error('matrix_chatgpt_training_journal_invalid')
    }

    return value.idempotencyKey
  }

  write(accountKey: string, key: string | null): void {
    const file = this.file(accountKey)

    if (key === null) { fs.rmSync(file, { force: true });

 return }

    if (!UUID.test(key)) {throw new Error('matrix_chatgpt_training_invalid')}
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileAtomicSync(file, JSON.stringify({ version: 1, idempotencyKey: key }))
  }
}

/** Revocation drains live relay leases first: 503 means "not yet"; the SAME key retries. */
const REVOKE_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 5_000] as const

export class MatrixChatGptTrainingConfirmation {
  private owner: Scope | null = null
  /** The revocation in flight for this account, kept until a 200 so every retry reuses its key. */
  private revokeKey?: string
  private revoking?: Promise<MatrixChatGptTrainingRevokeResult>

  constructor(private readonly options: {
    scope(): Scope | null
    call(method: MatrixChatGptTrainingMethod, signal: AbortSignal, init?: { body?: unknown; idempotencyKey?: string }): Promise<MatrixChatGptTrainingAnswer>
    /** Whether this account's agents touch Google (connected now, or the owner fence was ever set). */
    required(): boolean
    /** Where the pending revocation key survives a restart (scoped to the account). */
    journal: MatrixChatGptTrainingRevokeJournal
    sleep?: (ms: number) => Promise<void>
    key?: () => string
  }) {}

  /** A new account (or a start-up) loads only that account's pending key, and resumes it. */
  activate(owner: Scope | null): void {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) {return}
    this.owner = owner; this.revokeKey = undefined; this.revoking = undefined

    if (!owner) {return}

    try { this.revokeKey = this.options.journal.read(owner.accountKey) ?? undefined }
    catch { this.revokeKey = undefined }

    if (this.revokeKey) {void this.revoke()}
  }

  private sameScope(scope: Scope): boolean {
    const now = this.options.scope()

    return now?.accountKey === scope.accountKey && now.generation === scope.generation
  }

  private view(parsed: NonNullable<ReturnType<typeof parseMatrixChatGptTraining>>): MatrixChatGptTrainingStatus {
    return { ...parsed, required: this.options.required(), ...(this.revokeKey ? { revoking: true } : {}) }
  }

  async read(): Promise<MatrixChatGptTrainingStatus> {
    const scope = this.options.scope()

    if (!scope) {throw new Error('matrix_chatgpt_training_unavailable')}
    const answer = await this.options.call('GET', AbortSignal.timeout(15_000))
    const parsed = answer.status === 200 ? parseMatrixChatGptTraining(answer.value) : undefined

    if (!parsed || !this.sameScope(scope)) {throw new Error('matrix_chatgpt_training_unavailable')}

    return this.view(parsed)
  }

  /** POST only after the person ticked the box and pressed Confirm; never automatic. */
  async confirm(connectionId: unknown): Promise<MatrixChatGptTrainingConfirmResult> {
    const scope = this.options.scope()

    if (!scope || typeof connectionId !== 'string' || !UUID.test(connectionId) || this.revokeKey) {
      return { status: 'unavailable' }
    }

    const answer = await this.options.call('POST', AbortSignal.timeout(15_000), { body: {
      wordingVersion: MATRIX_CHATGPT_TRAINING_WORDING, connectionId,
      transferWordingVersion: MATRIX_CHATGPT_TRANSFER_WORDING } }).catch(() => undefined)

    if (!answer || !this.sameScope(scope)) {return { status: 'unavailable' }}

    // The relay changed under the card (new device, fresh sign-in): read again and ask again.
    if (answer.status === 409) {return { status: 'stale' }}
    const parsed = answer.status === 200 ? parseMatrixChatGptTraining(answer.value) : undefined

    return parsed?.current ? { status: 'confirmed', training: this.view(parsed) } : { status: 'unavailable' }
  }

  /** DELETE with one Idempotency-Key until it lands. One flight per account. */
  revoke(): Promise<MatrixChatGptTrainingRevokeResult> {
    this.revoking ??= this.revokeOnce().finally(() => { this.revoking = undefined })

    return this.revoking
  }

  private async revokeOnce(): Promise<MatrixChatGptTrainingRevokeResult> {
    const scope = this.options.scope()

    if (!scope) {return { status: 'unavailable' }}
    let key = this.revokeKey

    if (!key) {
      key = (this.options.key ?? randomUUID)()

      // The key is on disk before the first DELETE, or no DELETE is sent.
      try { this.options.journal.write(scope.accountKey, key) } catch { return { status: 'unavailable' } }
      this.revokeKey = key
    }

    const sleep = this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))

    for (let attempt = 0; ; attempt += 1) {
      const answer = await this.options.call('DELETE', AbortSignal.timeout(15_000), { idempotencyKey: key }).catch(() => undefined)

      if (!this.sameScope(scope)) {return { status: 'unavailable' }}

      if (answer?.status === 200 && record(answer.value) && answer.value.current === false) {
        // Only the server's 200 ends this revocation. A failed clear just replays it next start.
        try { this.options.journal.write(scope.accountKey, null) } catch { /* replayed harmlessly */ }
        this.revokeKey = undefined

        return { status: 'revoked', training: { current: false, connectionId: null, confirmedAt: null, required: this.options.required() } }
      }

      // A live lease still drains (503), or the network blinked: same key, short backoff. Any
      // other answer keeps the key too: only a 200 {current:false} ends this revocation.
      if (answer && answer.status !== 503) {return { status: 'unavailable' }}
      const delay = REVOKE_BACKOFF_MS[attempt]

      // A long drain: the server keeps the fence; the next press retries with this same key.
      if (delay === undefined) {return { status: 'pending' }}
      await sleep(delay)

      if (!this.sameScope(scope)) {return { status: 'unavailable' }}
    }
  }
}
