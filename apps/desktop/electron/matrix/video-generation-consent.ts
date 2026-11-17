import {
  MATRIX_VIDEO_CONSENT_WORDING,
  type MatrixVideoConsentAllowResult,
  type MatrixVideoConsentRevokeResult,
  type MatrixVideoConsentStatus
} from '../../shared/matrix-video-consent'

import {
  type MatrixOwnerConsentAnswer,
  type MatrixOwnerConsentCall,
  type MatrixOwnerConsentInit,
  type MatrixOwnerConsentMethod,
  MatrixOwnerConsentRevocation,
  type MatrixOwnerConsentRevokeJournal,
  matrixConsentRecord as record,
  requestMatrixOwnerConsent,
  sameMatrixConsentScope,
  type MatrixOwnerConsentScope as Scope
} from './owner-consent'

/**
 * The owner's one-time video-generation consent (Shell `/api/media/video-generation/consent`,
 * docs/video-generation-consent.md). Main only forwards the person's explicit Allow and Turn off,
 * with the MAS owner bearer through `account.s1Request`, like the ChatGPT training confirmation
 * (chatgpt-training-confirmation.ts) whose transport and revocation it shares (owner-consent.ts).
 * The platform owns the record, the locale, the timestamps and every admission decision.
 */
export const MATRIX_VIDEO_CONSENT_PATH = '/api/media/video-generation/consent'

export function requestMatrixVideoConsent(resource: string, accessToken: string, method: MatrixOwnerConsentMethod,
  signal: AbortSignal, init: MatrixOwnerConsentInit = {}): Promise<MatrixOwnerConsentAnswer> {
  return requestMatrixOwnerConsent(MATRIX_VIDEO_CONSENT_PATH, resource, accessToken, method, signal, init)
}

/**
 * The GET/POST projection, strictly. Another wording is not current for this build, and a
 * projection without a recorded locale, or for another provider, is not read at all: the card
 * could not show the wording the platform records.
 */
export function parseMatrixVideoConsent(value: unknown): Omit<MatrixVideoConsentStatus, 'revoking'> | undefined {
  if (!record(value) || typeof value.current !== 'boolean') {return}
  const { wordingVersion, provider, locale, confirmedAt, revision } = value

  if ((wordingVersion !== null && typeof wordingVersion !== 'string') || provider !== 'minimax' ||
      (locale !== 'en' && locale !== 'vi') ||
      (confirmedAt !== null && (typeof confirmedAt !== 'string' || !Number.isFinite(Date.parse(confirmedAt)))) ||
      (revision !== null && (!Number.isSafeInteger(revision) || Number(revision) < 0))) {
    return
  }

  const current = value.current && wordingVersion === MATRIX_VIDEO_CONSENT_WORDING

  return { current, locale, confirmedAt: current && typeof confirmedAt === 'string' ? Date.parse(confirmedAt) : null }
}

export class MatrixVideoGenerationConsent {
  private readonly revocation: MatrixOwnerConsentRevocation

  constructor(private readonly options: {
    scope(): Scope | null
    call: MatrixOwnerConsentCall
    /** Where a pending turn-off's key survives a restart (scoped to the account). */
    journal: MatrixOwnerConsentRevokeJournal
    sleep?: (ms: number) => Promise<void>
    key?: () => string
  }) {
    this.revocation = new MatrixOwnerConsentRevocation(options)
  }

  /** A new account (or a start-up) loads only that account's pending key, and resumes it. */
  activate(owner: Scope | null): void {
    this.revocation.activate(owner)
  }

  /** A failed read throws: it is "unavailable", never "not consented". */
  async read(): Promise<MatrixVideoConsentStatus> {
    const scope = this.options.scope()

    if (!scope) {throw new Error('matrix_video_consent_unavailable')}
    const answer = await this.options.call('GET', AbortSignal.timeout(15_000))
    const parsed = answer.status === 200 ? parseMatrixVideoConsent(answer.value) : undefined

    if (!parsed || !sameMatrixConsentScope(this.options.scope(), scope)) {throw new Error('matrix_video_consent_unavailable')}

    return { ...parsed, ...(this.revocation.pending ? { revoking: true as const } : {}) }
  }

  /** POST only after the person ticked the box and pressed Allow; never automatic. */
  async allow(): Promise<MatrixVideoConsentAllowResult> {
    const scope = this.options.scope()

    // A turn-off still in flight finishes first, with its own key.
    if (!scope || this.revocation.pending) {return { status: 'unavailable' }}

    const answer = await this.options.call('POST', AbortSignal.timeout(15_000),
      { body: { wordingVersion: MATRIX_VIDEO_CONSENT_WORDING } }).catch(() => undefined)

    if (!answer || !sameMatrixConsentScope(this.options.scope(), scope)) {return { status: 'unavailable' }}

    if ([400, 401, 403, 409].includes(answer.status)) {return { status: 'refused' }}
    const parsed = answer.status === 200 ? parseMatrixVideoConsent(answer.value) : undefined

    return parsed?.current ? { status: 'allowed', consent: parsed } : { status: 'unavailable' }
  }

  /** DELETE with one Idempotency-Key until the platform answers `200 {current:false}`. */
  async revoke(): Promise<MatrixVideoConsentRevokeResult> {
    return { status: await this.revocation.revoke() }
  }
}
