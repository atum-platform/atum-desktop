import { assertSafeBrowserUrl } from './policy'

/** A restart only creates fresh GET tabs at public HTTPS URLs without URL credentials. */
export function browserUpdateUrl(raw: string): string | null {
  try {
    const url = new URL(assertSafeBrowserUrl(raw))
    if (url.protocol === 'https:' && !url.search && !url.hash) {return url.href}
  } catch {
    // Refuse a URL that the native browser policy would not allow.
  }

  return null
}
