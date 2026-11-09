import { net } from 'electron'

/** Send reporting through Chromium without participating in the default session's credentials or cache. */
export function fetchMatrixReporting(url: string, init: RequestInit) {
  return net.fetch(url, { ...init, credentials: 'omit', cache: 'no-store' })
}
