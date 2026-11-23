import { setTimeout as delay } from 'node:timers/promises'

import type { WebContents } from 'electron'

import { type WorkIncarnation, workPairingOrigin } from '../sidecar/process'

import type { PairingGrantLookup, T3AuthCli } from './t3-auth'

/**
 * What pairing needs from one Work view. `createElectronOwnerView` is the real
 * one; tests drive a fake. Every method answers from the view's own partition.
 */
export interface OwnerViewPort {
  /** The WebContents handed to `WorkHost.bindOwnerView` (isolated preload). */
  contents: WebContents
  load(url: string): Promise<void>
  currentUrl(): string
  /** True when the partition holds the server's owner session cookie (`t3_session_*`). */
  hasSessionCookie(): Promise<boolean>
  /** True when `/api/auth/session` answers `authenticated` with that partition's cookies. */
  signedIn(): Promise<boolean>
  /** Drop the navigation history, so no entry can ever carry the grant. */
  clearHistory(): void
  /** Wipe cookies and storage of the partition. */
  clearPartition(): Promise<void>
  close(): void
  /** Fires once when the view goes away for any reason (user closed it, crash, `close()`). */
  onClosed(listener: () => void): void
}

export type PairingOutcome =
  | { state: 'paired' }
  | { state: 'failed'; reason: 'grant_unavailable' | 'grant_invalid' | 'load_failed' | 'timeout' | 'lookup_failed' }

export interface PairingOptions {
  incarnation: WorkIncarnation
  view: OwnerViewPort
  cli: T3AuthCli
  grants: PairingGrantLookup
  timeoutMs?: number
  pollMs?: number
}

const TOKEN = /#token=([A-Za-z0-9_-]{1,512})$/u

/**
 * Deliver the startup grant once, to the one view, and observe three facts:
 * the view's URL has no fragment, the partition holds the session cookie, and
 * the app reports signed in. Then drop the history. On any failure the grant
 * is revoked, the view closed, the partition cleared, and EVERY session on the
 * home revoked, because a timeout can come after the browser session was
 * already minted: closing the view and revoking the grant alone leaves that
 * cookie alive (review R4-3). The caller then stops the server and runs the
 * full reset before issuing a fresh grant.
 */
export async function pairOwnerView(options: PairingOptions): Promise<PairingOutcome> {
  const { incarnation, view, cli, grants } = options
  const timeoutMs = options.timeoutMs ?? 20_000
  const pollMs = options.pollMs ?? 100

  let url: string | undefined = incarnation.takePairingUrl()

  if (!url) {
    return { state: 'failed', reason: 'grant_unavailable' }
  }

  // Exact form, the child's own port, nothing else. The origin of the URL is
  // compared to the origin the supervisor verified for this incarnation.
  const token = TOKEN.exec(url)?.[1]

  if (!token || workPairingOrigin(url) !== incarnation.origin) {
    url = undefined

    return { state: 'failed', reason: 'grant_invalid' }
  }

  let grantId: string | undefined

  try {
    grantId = grants.idForCredential(token)
  } catch {
    url = undefined

    return await abandon(options, undefined, 'lookup_failed')
  }

  try {
    await view.load(url)
  } catch {
    url = undefined

    return await abandon(options, grantId, 'load_failed')
  } finally {
    url = undefined
  }

  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const current = view.currentUrl()

    if (!current.includes('#') && !current.includes('token=') && (await view.hasSessionCookie()) && (await view.signedIn())) {
      view.clearHistory()

      return { state: 'paired' }
    }

    await delay(pollMs)
  }

  return await abandon(options, grantId, 'timeout')
}

async function abandon(
  { view, cli }: PairingOptions,
  grantId: string | undefined,
  reason: Extract<PairingOutcome, { state: 'failed' }>['reason']
): Promise<PairingOutcome> {
  view.close()

  // Each step runs even when an earlier one fails: the full reset on the
  // stopped home that follows is the backstop, this is the immediate cut.
  await view.clearPartition().catch(() => undefined)

  if (grantId) {
    await cli.revokePairing(grantId).catch(() => undefined)
  }

  try {
    for (const id of await cli.sessionIds()) {
      await cli.revokeSession(id).catch(() => undefined)
    }
  } catch {
    // The reset after the restart revokes what this could not.
  }

  return { state: 'failed', reason }
}
