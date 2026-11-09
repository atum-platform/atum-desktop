import {
  type MatrixFounderChatMarker,
  type MatrixFounderChatResult,
  type MatrixFounderContactResult,
  matrixFounderRoster,
  type MatrixFounderSdkCommand,
  type MatrixFounderView,
  type MatrixOfficialAccounts
} from '../../shared/matrix-founder'

import { requireMatrixCaller } from './ipc-policy'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */

/** The person's SDK host as this controller sees it. `token` is the host itself: a restarted
 * host is a new object, so a new generation. */
export interface MatrixFounderHost {
  token: object
  ready: boolean
}

/** How many times telling the host who the founder is is tried again after the host failed or
 * timed out (each at the next read of the official accounts, about six hours apart, or when the
 * host reconnects). */
export const FOUNDER_CHAT_WAITING_RETRIES = 6

/** How long one founder command may take: it can create a room and write two records. */
export const FOUNDER_CHAT_COMMAND_MS = 60_000

/** The SDK's answer, when it is one: anything else is a failed attempt. */
export function matrixFounderChatResult(value: unknown): MatrixFounderChatResult | null {
  const row = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null

  if (row?.state === 'ready') {
    return typeof row.roomId === 'string' && row.roomId.startsWith('!') ? { state: 'ready', roomId: row.roomId } : null
  }

  if (row?.state === 'waiting') {
    return row.reason === 'not_synced' || row.reason === 'founder_not_ready' || row.reason === 'offline'
      ? { state: 'waiting', reason: row.reason }
      : null
  }

  return row?.state === 'declined' || row?.state === 'founder_mode' || row?.state === 'disabled'
    ? { state: row.state }
    : null
}

/**
 * The founder for the window: the platform's, always official, with its handle when the
 * platform gives one, and `roomId` only when the SDK's record names this same founder (a record
 * about an earlier founder never lends its room to the current one).
 */
export function matrixFounderView(
  official: MatrixOfficialAccounts | undefined,
  marker: MatrixFounderChatMarker | undefined,
  /** This account, so the founder's own account is never offered a chat with itself. */
  ownUserId?: string
): MatrixFounderView | undefined {
  const founder = official?.founder?.userId

  if (!founder) {
    return undefined
  }

  const row = official.accounts.find(account => account.userId === founder)
  // The parsed official row's effective presentation (absent legacy fields: default, available).
  const roster = matrixFounderRoster(official)!

  return {
    userId: founder,
    verification: 'official',
    ...(row?.handle ? { handle: row.handle } : {}),
    // Effective presentation, not authority: an existing room and its official mark stay even
    // when the server no longer suggests the Founder.
    rosterDefault: roster.default,
    rosterOrder: roster.order,
    rosterState: roster.state,
    ...(marker?.state === 'present' && marker.founder === founder && marker.roomId ? { roomId: marker.roomId } : {}),
    // The default roster offers a draft, never a chat: only while this account has never had a
    // record of one (an unknown record offers nothing yet), the server suggests it, it is not
    // coming soon, and this is not the founder's own account. The chat is made by the person's
    // first message.
    ...(marker?.state === 'absent' &&
    Boolean(ownUserId) &&
    ownUserId !== founder &&
    roster.default &&
    roster.state !== 'coming_soon'
      ? { offer: true as const }
      : {})
  }
}

export function createMatrixFounderChat(deps: {
  /** The platform's founder: a Matrix id, null when it names none, undefined while unknown. */
  founder(): string | null | undefined
  host(): MatrixFounderHost | undefined
  command(token: object, command: MatrixFounderSdkCommand): Promise<unknown>
  select(token: object, roomId: string): Promise<unknown>
}) {
  // What the current host was last told, so each host and founder is told once. A stale
  // host/account never is.
  let configured: { token: object; founder: string | null } | undefined
  let running: Promise<void> | undefined
  let contacting: Promise<MatrixFounderContactResult> | undefined
  let waiting = false
  let armed = false
  let retries = 0
  let seen: { token: object; ready: boolean } | undefined
  let stopped = false

  function run(token: object, command: MatrixFounderSdkCommand) {
    // A read or reconnect before this attempt is spent by it.
    waiting = false
    armed = false

    running = deps
      .command(token, command)
      .then(
        value => {
          if (matrixFounderChatResult(value)?.state === 'waiting') {
            waiting = true
            retries += 1
          }
        },
        () => {
          // The host stopped, timed out or refused: a later read or start tries again.
          waiting = true
          retries += 1
        }
      )
      .finally(() => {
        running = undefined
        reconcile()
      })
  }

  /** Cheap and idempotent: main calls it on every publish. It only tells the host who the
   * founder is (trust, official marks, and founder mode on the founder's own account); it never
   * makes a chat, leaves one, or changes a record, room membership or pin. */
  function reconcile(): void {
    if (stopped) {
      return
    }

    const host = deps.host()

    // A host that comes back (offline, then syncing again) may be told again after a failure.
    if (host && seen?.token === host.token && !seen.ready && host.ready) {
      armed = true
    }

    seen = host ? { token: host.token, ready: host.ready } : undefined

    if (running || !host?.ready) {
      return
    }

    const founder = deps.founder()

    // Unknown (an unavailable read) is never "no founder": nothing is decided on it.
    if (founder === undefined) {
      return
    }

    const fresh = configured?.token !== host.token || configured.founder !== founder

    if (!fresh && !(waiting && armed && retries < FOUNDER_CHAT_WAITING_RETRIES)) {
      return
    }

    if (fresh) {
      retries = 0
      waiting = false
    }

    if (founder === null) {
      // A founder this same host was told about is withdrawn (the platform's kill switch):
      // the host stops trusting and auto-joining for it.
      const withdraw = configured?.token === host.token && configured.founder !== null
      configured = { token: host.token, founder: null }
      waiting = false

      if (withdraw) {
        run(host.token, { kind: 'founderChat', founder: null, create: 'none' })
      }

      return
    }

    configured = { token: host.token, founder }
    run(host.token, { kind: 'founderChat', founder, create: 'none' })
  }

  /** The person's first message to the Founder (the draft the roster offers, Contact us, or
   * Add friends): the chat they have, else the one their other device made, else a new one, and
   * selected. Opening the draft never gets here. */
  function contact(): Promise<MatrixFounderContactResult> {
    contacting ??= (async (): Promise<MatrixFounderContactResult> => {
      const host = deps.host()
      const founder = deps.founder()

      if (stopped || !host?.ready || !founder) {
        return { unavailable: true }
      }

      try {
        const result = matrixFounderChatResult(
          await deps.command(host.token, { kind: 'founderChat', founder, create: 'explicit' })
        )

        if (result?.state !== 'ready' || stopped || deps.host()?.token !== host.token) {
          return { unavailable: true }
        }

        configured = { token: host.token, founder }
        waiting = false
        // Opening it is presentation: the chat exists whether or not the select lands.
        await deps.select(host.token, result.roomId).catch(() => {})

        return { roomId: result.roomId }
      } catch {
        return { unavailable: true }
      }
    })().finally(() => {
      contacting = undefined
    })

    return contacting
  }

  return {
    reconcile,
    contact,
    /** The official accounts were read again (good or not): a failed command may try again. */
    refreshed() {
      armed = true
      reconcile()
    },
    /** Signed out: nothing carries over to the next account. */
    reset() {
      configured = undefined
      waiting = false
      armed = false
      retries = 0
      seen = undefined
    },
    stop() {
      stopped = true
    }
  }
}

interface FounderContactContext {
  event: Parameters<typeof requireMatrixCaller>[0]
  ui: Parameters<typeof requireMatrixCaller>[1]
  uiUrl: string
  closing: boolean
  /** Undefined when there is no Founder chat to offer (no domain, signed out). */
  contact(): Promise<MatrixFounderContactResult> | undefined
}

/** The window's `founder-contact` request: from the Matrix window only, as the alias reads. */
export async function handleMatrixFounderContact(context: FounderContactContext): Promise<MatrixFounderContactResult> {
  requireMatrixCaller(context.event, context.ui, context.uiUrl)

  if (context.closing) {
    return { unavailable: true }
  }

  return (await context.contact()) ?? { unavailable: true }
}
