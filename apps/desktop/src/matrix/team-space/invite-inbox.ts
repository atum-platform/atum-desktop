import { atom } from 'nanostores'

import type {
  MatrixCompanyBridge,
  MatrixCompanyDirectory,
  MatrixCompanyDirectory11,
  MatrixCompanyInvitation,
  MatrixCompanyValue
} from '../../../shared/matrix-company'

/**
 * The company invitations addressed to the signed-in person, outside Team Space: the rail counts them,
 * so a pending invitation is seen within one directory read without opening Team Space first.
 *
 * It reuses the invitee's own directory (`list`, the self directory): no new request kind. The Team Space
 * workspace publishes every directory it reads here, and the window reads it on sign-in, when it comes to the
 * front and every five minutes (`startCompanyInviteInboxPolling`), backing off after failures. Each answer
 * belongs to one account and to the moment it was asked: a late answer for an account that has since signed
 * out or switched, or one older than what is shown, is dropped, and switching clears it. "Not now" hides an invitation for this run of the app only;
 * nothing here is written to storage.
 */
export interface CompanyInviteInbox {
  accountKey: string
  invitations: readonly MatrixCompanyInvitation[]
  /** Invitations this person put off with "Not now" in this run of the app. */
  dismissed: ReadonlySet<string>
}

export const $companyInviteInbox = atom<CompanyInviteInbox | undefined>(undefined)

/** The healthy cadence: one read every five minutes, plus sign-in and the window coming to the front. */
export const COMPANY_INVITE_INBOX_INTERVAL_MS = 5 * 60_000
/** After a failed read the next waits 1, 2, 4 … minutes, at most 30, or longer when the server says so. */
export const COMPANY_INVITE_INBOX_BACKOFF_BASE_MS = 60_000
export const COMPANY_INVITE_INBOX_BACKOFF_CAP_MS = 30 * 60_000

let activeAccountKey: string | undefined

/*
 * Ordering. Every directory read that publishes here takes a ticket when it is issued, from one sequence shared by the
 * rail's reads and the workspace's. An answer applies only when its ticket is newer than the state already shown and
 * than the last invalidation: an older read never wins merely because it finished later. A change the person made
 * (accepting, declining) and an account switch invalidate every read still in flight.
 */
let ticketSequence = 0
let appliedTicket = 0
let invalidatedBefore = 0

/** Timing for the active account's reads: one in flight at a time, and the cooldown after a failure. */
interface InboxSchedule {
  accountKey: string
  inflight?: Promise<void>
  failures: number
  notBefore: number
}

let schedule: InboxSchedule | undefined

/** The invitee's own directory (1 or 1.1): companies and the invitations addressed to them. */
const isDirectory = (value: MatrixCompanyValue): value is MatrixCompanyDirectory | MatrixCompanyDirectory11 =>
  (value.schemaVersion === 1 || value.schemaVersion === 2) && 'companies' in value && 'invitations' in value &&
  Array.isArray(value.companies) && Array.isArray(value.invitations)

/** A ticket for a directory read about to be sent (or a change's answer about to be shown); see `publishCompanyInviteInbox`. */
export function issueCompanyInviteInboxTicket(): number {
  ticketSequence += 1

  return ticketSequence
}

/** A change to this person's invitations landed: whatever was read before it is out of date. */
export function invalidateCompanyInviteInbox(accountKey: string): void {
  if (accountKey === activeAccountKey) {
    invalidatedBefore = issueCompanyInviteInboxTicket()
  }
}

/** Which account the window is signed in to now. Another account (or signing out) forgets what was held. */
export function setCompanyInviteInboxAccount(accountKey: string | undefined): void {
  if (accountKey === activeAccountKey) {
    return
  }

  activeAccountKey = accountKey
  invalidatedBefore = issueCompanyInviteInboxTicket()
  schedule = undefined

  if ($companyInviteInbox.get()?.accountKey !== accountKey) {
    $companyInviteInbox.set(undefined)
  }
}

/**
 * A directory read for `accountKey` (by the workspace or by `loadCompanyInviteInbox`), issued with `ticket`. It is
 * dropped when it is for another account, is not a directory, or was issued before what is shown or before the last
 * invalidation. Returns whether it was applied.
 */
export function publishCompanyInviteInbox(accountKey: string, value: MatrixCompanyValue, ticket: number): boolean {
  if (accountKey !== activeAccountKey || !isDirectory(value) || ticket <= appliedTicket || ticket <= invalidatedBefore) {
    return false
  }

  const previous = $companyInviteInbox.get()
  const dismissed = previous?.accountKey === accountKey ? previous.dismissed : new Set<string>()
  const ids = new Set(value.invitations.map(invitation => invitation.id))

  appliedTicket = ticket
  $companyInviteInbox.set({
    accountKey,
    invitations: value.invitations,
    // A dismissal ends with its invitation.
    dismissed: new Set([...dismissed].filter(id => ids.has(id)))
  })

  return true
}

function scheduleFor(accountKey: string): InboxSchedule {
  if (schedule?.accountKey !== accountKey) {
    schedule = { accountKey, failures: 0, notBefore: 0 }
  }

  return schedule
}

/**
 * Reads the self directory for the signed-in account. Only one read runs at a time: a second ask while one is in flight
 * shares it. After a failure the next read waits (exponential, capped, at least any Retry-After) and asks in between
 * are skipped; a success clears the wait. A failure keeps what was known.
 */
export function loadCompanyInviteInbox(bridge: MatrixCompanyBridge, accountKey: string): Promise<void> {
  if (accountKey !== activeAccountKey) {
    return Promise.resolve()
  }

  const state = scheduleFor(accountKey)

  if (state.inflight) {
    return state.inflight
  }

  if (Date.now() < state.notBefore) {
    return Promise.resolve()
  }

  const ticket = issueCompanyInviteInboxTicket()

  const run = (async () => {
    let failed = true
    let retryAfterSeconds: number | undefined

    try {
      const result = await bridge.request({ action: 'list' })

      if (result.ok) {
        // A superseded answer is not a failure: the server answered.
        failed = !isDirectory(result.value)
        publishCompanyInviteInbox(accountKey, result.value, ticket)
      } else {
        retryAfterSeconds = result.retryAfterSeconds
      }
    } catch {
      // Keep what was known; the next read tries again after the wait.
    }

    // The account changed while this was in flight: its timing went with it.
    if (schedule !== state) {
      return
    }

    if (!failed) {
      state.failures = 0
      state.notBefore = 0

      return
    }

    state.failures += 1
    const backoff = Math.min(COMPANY_INVITE_INBOX_BACKOFF_BASE_MS * 2 ** (state.failures - 1), COMPANY_INVITE_INBOX_BACKOFF_CAP_MS)
    state.notBefore = Date.now() + Math.max(backoff, (retryAfterSeconds ?? 0) * 1000)
  })().finally(() => {
    if (state.inflight === run) {
      state.inflight = undefined
    }
  })

  state.inflight = run

  return run
}

export interface CompanyInviteInboxPolling {
  /** Sign-in or the window coming to the front: read now, unless one is in flight or a failure's wait is running. */
  nudge(): void
  stop(): void
}

/**
 * Keeps the signed-in account's inbox fresh: reads now, then every five minutes while reads succeed, or when the wait
 * after a failure ends. One timer, owned here; `nudge` coalesces with a read in flight and respects the wait.
 */
export function startCompanyInviteInboxPolling(bridge: MatrixCompanyBridge, accountKey: string): CompanyInviteInboxPolling {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const arm = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }

    timer = undefined

    if (stopped) {
      return
    }

    const state = schedule?.accountKey === accountKey ? schedule : undefined
    const now = Date.now()
    const wait = state && state.notBefore > now ? state.notBefore - now : COMPANY_INVITE_INBOX_INTERVAL_MS
    timer = setTimeout(read, wait)
  }

  const read = () => void loadCompanyInviteInbox(bridge, accountKey).then(arm, arm)

  read()

  return {
    nudge: read,
    stop: () => {
      stopped = true

      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }
}

export function dismissCompanyInvitation(accountKey: string, invitationId: string): void {
  const current = $companyInviteInbox.get()

  if (current?.accountKey !== accountKey || current.dismissed.has(invitationId)) {
    return
  }

  $companyInviteInbox.set({ ...current, dismissed: new Set(current.dismissed).add(invitationId) })
}

/** The invitations still waiting for this person's answer, for the account asked about only. */
export function pendingCompanyInvitations(inbox: CompanyInviteInbox | undefined, accountKey: string): MatrixCompanyInvitation[] {
  if (!inbox || inbox.accountKey !== accountKey) {
    return []
  }

  return inbox.invitations.filter(invitation => !inbox.dismissed.has(invitation.id))
}

/** Tests only. */
export function resetCompanyInviteInbox(): void {
  activeAccountKey = undefined
  invalidatedBefore = issueCompanyInviteInboxTicket()
  schedule = undefined
  $companyInviteInbox.set(undefined)
}
