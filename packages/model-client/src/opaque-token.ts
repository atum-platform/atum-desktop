import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** The contract's `opaque_token`: 32 random bytes in unpadded base64url (43 characters). */
export const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

/** How a token is held and named: never the token itself (atum.cloud-execution/1 §6.3.1). */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** A short, non-secret handle for logs and measurements. */
export function tokenHandle(token: string): string {
  return `g_${tokenDigest(token).slice(0, 12)}`
}

export function sameToken(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(expected, 'utf8')

  return a.length === b.length && timingSafeEqual(a, b)
}

/** The bearer token of an `Authorization` header, or null. */
export function bearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null
  }

  const token = header.slice(7).trim()

  return OPAQUE_TOKEN.test(token) ? token : null
}
