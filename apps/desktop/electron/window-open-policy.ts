/**
 * Deny-only policy for BrowserWindow `window.open` requests.
 *
 * External URLs the app intentionally opens already pass through audited IPC.
 * A request reaching `setWindowOpenHandler` can instead originate in untrusted
 * renderer or iframe content, so it must never have an external-open side
 * effect (GHSA-9f4c-93c8-jc8g / CVE-2026-70608).
 */

export interface WindowOpenRequestLike {
  url: string
}

export interface WindowOpenDecision {
  action: 'deny'
}

/** Return only the origin/protocol so denied URLs cannot leak query secrets. */
export function describeDeniedUrl(url: string): string {
  try {
    const parsed = new URL(url)

    return parsed.origin === 'null' ? parsed.protocol : parsed.origin
  } catch {
    return '<unparseable>'
  }
}

/**
 * Build a handler that always denies and never opens the requested URL.
 * Observer failures cannot weaken the decision.
 */
export function createWindowOpenHandler(
  onDenied?: (origin: string) => void
): (details: WindowOpenRequestLike) => WindowOpenDecision {
  return details => {
    try {
      onDenied?.(describeDeniedUrl(details.url))
    } catch {
      // Logging failure is not a reason to reconsider the deny decision.
    }

    return { action: 'deny' }
  }
}
