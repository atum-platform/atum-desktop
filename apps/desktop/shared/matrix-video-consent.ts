/**
 * The owner's one-time consent to video generation with MiniMax (Shell
 * `/api/media/video-generation/consent`, wording `minimax-video-v1`). Server-owned: `current` is
 * true only for this build's wording, and `locale` is the language the platform records the
 * consent in, which the card must show whatever the app's own language is. Never a credential
 * and never a cost.
 */
export const MATRIX_VIDEO_CONSENT_WORDING = 'minimax-video-v1'

/** The languages the platform records the consent wording in. */
export type MatrixVideoConsentLocale = 'en' | 'vi'

export interface MatrixVideoConsentStatus {
  current: boolean
  /** The wording the card shows (server-owned `owner_languages`). */
  locale: MatrixVideoConsentLocale
  /** When the current consent was given (ms since epoch), else null. */
  confirmedAt: number | null
  /** A turn-off is still in flight with its saved key; the next Turn off retries it. */
  revoking?: true
}

export type MatrixVideoConsentAllowResult =
  | { status: 'allowed'; consent: MatrixVideoConsentStatus }
  /** 400/401/403/409: not for this account, or not this wording. Calm, never a retry loop. */
  | { status: 'refused' }
  /** 503 or no answer: nothing was recorded; the person may press Allow again. */
  | { status: 'unavailable' }

export type MatrixVideoConsentRevokeResult =
  | { status: 'revoked' }
  /** Still not confirmed by the platform; the next press retries with the same key. */
  | { status: 'pending' }
  | { status: 'unavailable' }
