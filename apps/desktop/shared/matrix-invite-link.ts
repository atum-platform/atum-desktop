/** A company invite token is a bearer secret. It may cross only the process-local
 * deep-link/IPC handoff and the authenticated preview/redeem requests. */
export const MATRIX_INVITE_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u
export const MATRIX_INVITE_LINK_MAX_CHARS = 4096

export const MATRIX_INVITE_LINK_IPC = {
  opened: 'matrix-invite-link:opened',
  pending: 'matrix-invite-link:pending'
} as const

export interface MatrixInviteLinkBridge {
  takePending(): Promise<string | null>
  subscribe(listener: (token: string) => void): () => void
}

export function validMatrixInviteLinkToken(value: unknown): value is string {
  return typeof value === 'string' && MATRIX_INVITE_LINK_TOKEN_PATTERN.test(value)
}

/** Parse a pasted first-party-style HTTPS handoff. The hostname is deliberately
 * not pinned: old, staging and owned production origins all use the same `/j/` path. */
export function parseMatrixInviteLinkPaste(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MATRIX_INVITE_LINK_MAX_CHARS) {
    return null
  }
  let url: URL

  try {
    url = new URL(value.trim())
  } catch {
    return null
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)

  return parts.length === 2 && parts[0] === 'j' && validMatrixInviteLinkToken(parts[1]) ? parts[1]! : null
}

/** Parse the OS-owned deep link. Nothing except the validated token survives. */
export function parseMatrixInviteDeepLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MATRIX_INVITE_LINK_MAX_CHARS) {
    return null
  }
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'atum:' || url.hostname !== 'join' || url.username || url.password || url.port ||
    url.search || url.hash) {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)

  return parts.length === 1 && validMatrixInviteLinkToken(parts[0]) ? parts[0]! : null
}

/** Claims malformed join-route attempts too, so a bearer-looking value never falls through to another handler. */
export function isMatrixInviteDeepLinkCandidate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MATRIX_INVITE_LINK_MAX_CHARS) {return false}

  try {
    const url = new URL(value)

    return url.protocol === 'atum:' && url.hostname === 'join'
  } catch {
    return /^atum:\/\/join(?:[/?#]|$)/iu.test(value)
  }
}
