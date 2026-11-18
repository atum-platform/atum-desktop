import {
  MATRIX_CHATGPT_TRAINING_WORDING,
  MATRIX_CHATGPT_TRANSFER_WORDING,
  type MatrixChatGptTrainingConfirmResult,
  type MatrixChatGptTrainingRevokeResult,
  type MatrixChatGptTrainingStatus
} from '../../shared/matrix-subscriptions'

import {
  FileOwnerConsentRevokeJournal,
  type MatrixOwnerConsentAnswer,
  type MatrixOwnerConsentInit,
  type MatrixOwnerConsentMethod,
  MatrixOwnerConsentRevocation,
  type MatrixOwnerConsentRevokeJournal,
  matrixConsentRecord as record,
  requestMatrixOwnerConsent,
  sameMatrixConsentScope,
  type MatrixOwnerConsentScope as Scope,
  MATRIX_CONSENT_UUID as UUID
} from './owner-consent'

/**
 * The account's one-time "training is off" confirmation for using a ChatGPT plan with Google
 * data (Shell `/api/connections/openai-codex/training-confirmation`, contract r3). The desktop
 * only collects the explicit checkbox and transfer acceptance and forwards them with the MAS
 * owner bearer, the same `account.s1Request` path the carry route uses (chatgpt-carry.ts).
 * Transport and revocation are the shared owner-consent pieces (owner-consent.ts).
 * Owner, timestamps, wording hashes and revisions are server-owned; nothing here is authority.
 */
export const MATRIX_CHATGPT_TRAINING_PATH = '/api/connections/openai-codex/training-confirmation'

export type MatrixChatGptTrainingMethod = MatrixOwnerConsentMethod
export type MatrixChatGptTrainingAnswer = MatrixOwnerConsentAnswer
export type MatrixChatGptTrainingRevokeJournal = MatrixOwnerConsentRevokeJournal
export { FileOwnerConsentRevokeJournal as FileChatGptTrainingRevokeJournal }

export function requestMatrixChatGptTraining(resource: string, accessToken: string,
  method: MatrixChatGptTrainingMethod, signal: AbortSignal, init: MatrixOwnerConsentInit = {}): Promise<MatrixChatGptTrainingAnswer> {
  return requestMatrixOwnerConsent(MATRIX_CHATGPT_TRAINING_PATH, resource, accessToken, method, signal, init)
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

export class MatrixChatGptTrainingConfirmation {
  /** The revocation for this account, kept until a 200 so every retry reuses its key. */
  private readonly revocation: MatrixOwnerConsentRevocation

  constructor(private readonly options: {
    scope(): Scope | null
    call(method: MatrixChatGptTrainingMethod, signal: AbortSignal, init?: MatrixOwnerConsentInit): Promise<MatrixChatGptTrainingAnswer>
    /** Whether this account's agents touch Google (connected now, or the owner fence was ever set). */
    required(): boolean
    /** Where the pending revocation key survives a restart (scoped to the account). */
    journal: MatrixChatGptTrainingRevokeJournal
    sleep?: (ms: number) => Promise<void>
    key?: () => string
  }) {
    this.revocation = new MatrixOwnerConsentRevocation(options)
  }

  /** A new account (or a start-up) loads only that account's pending key, and resumes it. */
  activate(owner: Scope | null): void {
    this.revocation.activate(owner)
  }

  private sameScope(scope: Scope): boolean {
    return sameMatrixConsentScope(this.options.scope(), scope)
  }

  private view(parsed: NonNullable<ReturnType<typeof parseMatrixChatGptTraining>>): MatrixChatGptTrainingStatus {
    return { ...parsed, required: this.options.required(), ...(this.revocation.pending ? { revoking: true } : {}) }
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

    if (!scope || typeof connectionId !== 'string' || !UUID.test(connectionId) || this.revocation.pending) {
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

  /** DELETE with one Idempotency-Key until it lands (a 503 means live relay calls still drain). */
  async revoke(): Promise<MatrixChatGptTrainingRevokeResult> {
    const outcome = await this.revocation.revoke()

    return outcome === 'revoked'
      ? { status: 'revoked', training: { current: false, connectionId: null, confirmedAt: null, required: this.options.required() } }
      : { status: outcome }
  }
}
