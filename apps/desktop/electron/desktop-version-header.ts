/**
 * The app version the Shell reads to decide what it may sell this Mac (0.18.3: an assistant is
 * sold only to a desktop that can deliver its hire). Main supplies `app.getVersion()`; a value
 * that is not a plain release version is never sent, so the Shell treats that request like an
 * older desktop's (refused, never charged).
 */
export const DESKTOP_VERSION_HEADER = 'X-Atum-Desktop-Version'

const RELEASE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/

/** The header's value for `version`, or undefined when there is none to send. */
export function desktopVersionHeaderValue(version: string | undefined): string | undefined {
  return typeof version === 'string' && RELEASE_VERSION.test(version) ? version : undefined
}
