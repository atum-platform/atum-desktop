import type { WebContents } from 'electron'

import type { OwnerViewPort } from './pairing'
import { partitionFor } from './paths'

/** The slice of an Electron session the owner view needs. `session.fromPartition(...)` satisfies it. */
export interface OwnerSessionLike {
  cookies: { get(filter: { url: string }): Promise<{ name: string }[]> }
  fetch(url: string, init?: { credentials?: 'include' | 'omit' | 'same-origin' }): Promise<{ ok: boolean; json(): Promise<unknown> }>
  clearStorageData(): Promise<void>
  clearCache(): Promise<void>
  clearAuthCache(): Promise<void>
}

export interface OwnerWebContentsLike {
  getURL(): string
  loadURL(url: string): Promise<void>
  isDestroyed(): boolean
  close(): void
  once(event: 'destroyed', listener: () => void): unknown
  navigationHistory: { clear(): void }
}

/**
 * The real owner-view port over an Electron WebContents and the account's
 * `persist:atum-work-<key>` session. "Signed in" is read by main itself with
 * the partition's own cookies (`session.fetch`), so no script runs in the page.
 */
export function createElectronOwnerView(input: {
  contents: WebContents & OwnerWebContentsLike
  session: OwnerSessionLike
  origin: string
}): OwnerViewPort {
  const { contents, session, origin } = input

  return {
    contents,
    load: url => contents.loadURL(url),
    currentUrl: () => (contents.isDestroyed() ? '' : contents.getURL()),
    hasSessionCookie: async () =>
      (await session.cookies.get({ url: origin })).some(cookie => cookie.name.startsWith('t3_session_')),
    signedIn: async () => {
      try {
        const response = await session.fetch(`${origin}/api/auth/session`, { credentials: 'include' })

        return response.ok && (await response.json() as { authenticated?: boolean })?.authenticated === true
      } catch {
        return false
      }
    },
    clearHistory: () => {
      if (!contents.isDestroyed()) {
        contents.navigationHistory.clear()
      }
    },
    clearPartition: async () => {
      await session.clearStorageData()
      await session.clearCache()
      await session.clearAuthCache()
    },
    close: () => {
      if (!contents.isDestroyed()) {
        contents.close()
      }
    },
    onClosed: listener => void contents.once('destroyed', listener)
  }
}

export { partitionFor }
