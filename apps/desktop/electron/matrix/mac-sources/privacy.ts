import { createHash } from 'node:crypto'

const OTP_CONTEXT = /\b(?:otp|one[- ]?time|verification|verify|security|login|sign[- ]?in|passcode|m[aã]\s+x[aá]c\s+minh|x[aá]c\s+thực|验证码|驗證碼|認証コード)\b/iu
const SHORT_CODE = /(?<!\d)\d{4,8}(?!\d)/u
const ONLY_CODE = /^\s*(?:\D{0,12})?\d{4,8}(?:\D{0,12})?\s*$/u
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
const EMAIL_ALL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu
const PHONE = /(?<![\p{L}\d])(?:\+\d{1,3}[\d ()./-]{6,}\d|\(\d{2,4}\)[\d ./-]{5,}\d|\d[\d ()./-]{7,}\d)(?![\p{L}\d])/u
const PHONE_ALL = /(?<![\p{L}\d])(?:\+\d{1,3}[\d ()./-]{6,}\d|\(\d{2,4}\)[\d ./-]{5,}\d|\d[\d ()./-]{7,}\d)(?![\p{L}\d])/gu
const STREET = /(?<![\p{L}\d])\d{1,6}(?:\/\d{1,6})?\s+[\p{L}][\p{L}.'’/-]*(?:\s+[\p{L}][\p{L}.'’/-]*){0,5}(?:\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|đường|phố))?(?:,\s*(?:district|ward|quận|phường|q|p)\.?\s*\d{1,3})?(?=$|[.;!?])/giu
const URL_TEXT = /https?:\/\/[^\s<>()]+/giu

const SENSITIVE_URL_WORD = /(?:^|[._~:/?&#=-])(?:access[_-]?token|auth|authorization|bearer|code|confirm(?:ation)?|credential|invite|jwt|key|magic|oauth|pass(?:word|wd)?|recover(?:y)?|redeem|reset|secret|session|share|sid|signature|signed[_-]?headers|token|unsubscribe(?:[_-]?token)?|verif(?:y|ication))(?:$|[._~:/?&#=-])/iu
const SENSITIVE_TITLE = /\b(?:access token|auth(?:entication|orization)? code|confirmation code|credential|invite (?:code|link|token)|login code|magic link|one[- ]time (?:code|password|passcode)|password|passcode|recovery code|reset (?:code|link|password)|security code|session (?:key|token)|sign[- ]?in code|unsubscribe (?:code|link|token)|verification code)\b|\b(?:confirm|recover|redeem|reset|verify)\s+(?:your\s+)?(?:access|account|email|identity|login|password)\b/iu
const OPAQUE_TOKEN_SEGMENT = /^[A-Za-z0-9_-]{24,}$/u
const JWT_SEGMENT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u
const INTRA_DIGIT_SEPARATOR = /(?<=\d)[ \t\u00a0\u2007\u202f\-\u2010-\u2015]+(?=\d)/gu

function normalizeOtpDigits(text: string): string {
  return text.replace(INTRA_DIGIT_SEPARATOR, '')
}

function sensitivePath(pathname: string): boolean {
  let decoded: string

  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return true
  }

  return (
    SENSITIVE_URL_WORD.test(decoded) ||
    decoded
      .split('/')
      .filter(Boolean)
      .some(segment => OPAQUE_TOKEN_SEGMENT.test(segment) || JWT_SEGMENT.test(segment))
  )
}

export function isOtpLike(text: string): boolean {
  const normalized = normalizeOtpDigits(text)

  return (OTP_CONTEXT.test(normalized) && SHORT_CODE.test(normalized)) || ONLY_CODE.test(normalized)
}

export function privateContactLabel(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 6)

  return `Contact ${digest}`
}

export function safeConversationTitle(value: unknown, fallback: string): string {
  const title = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''

  if (!title || EMAIL.test(title) || PHONE.test(title)) {
    return fallback
  }

  return [...title].slice(0, 120).join('')
}

function safeUrlInMessage(raw: string): string {
  try {
    const url = new globalThis.URL(raw)
    const safe = sanitizeHistoryUrl(raw)

    return safe ? `${url.protocol}//${safe.domain}${safe.path}` : '[private link]'
  } catch {
    return '[private link]'
  }
}

/** Remove private contact/address details before message text leaves Electron main. */
export function sanitizeMessageText(value: string): string {
  const sanitized = value
    .replace(URL_TEXT, safeUrlInMessage)
    .replace(EMAIL_ALL, '[private contact]')
    .replace(PHONE_ALL, '[private number]')
    .replace(STREET, '[private address]')

  return [...sanitized]
    .map(character => {
      const code = character.codePointAt(0) ?? 0

      return (code <= 0x1f && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0x7f ? ' ' : character
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
}

export interface SanitizedHistoryUrl {
  domain: string
  path: string
}

/**
 * Browser output never includes a full URL. Sensitive credential/session URLs are dropped before
 * parsing output; safe rows retain only hostname plus path, with query and fragment discarded.
 */
export function sanitizeHistoryUrl(raw: string): SanitizedHistoryUrl | null {
  if (!raw || raw.length > 8_192) {
    return null
  }

  try {
    const url = new globalThis.URL(raw)

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      sensitivePath(url.pathname) ||
      SENSITIVE_URL_WORD.test(url.hash) ||
      [...url.searchParams].some(
        ([key, value]) =>
          SENSITIVE_URL_WORD.test(key) ||
          SENSITIVE_URL_WORD.test(value) ||
          OPAQUE_TOKEN_SEGMENT.test(value) ||
          JWT_SEGMENT.test(value)
      )
    ) {
      return null
    }

    const path = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`

    return {
      domain: url.hostname.toLowerCase().slice(0, 253),
      path: [...path].slice(0, 512).join('') || '/'
    }
  } catch {
    return null
  }
}

export function safeHistoryTitle(value: unknown, fallback: string): string | null {
  if (typeof value !== 'string') {
    return fallback
  }

  const title = value.replace(/\s+/gu, ' ').trim()

  if (SENSITIVE_TITLE.test(title)) {
    return null
  }

  const withoutUrls = title.replace(URL_TEXT, raw => {
    const safe = sanitizeHistoryUrl(raw)

    return safe ? `${safe.domain}${safe.path}` : '[private page]'
  })

  return [...(withoutUrls || fallback)].slice(0, 240).join('')
}
