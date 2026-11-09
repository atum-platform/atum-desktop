import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { MATRIX_ALIAS_CONTACTS_MAX, type MatrixAliasBridge, type MatrixAliasResult } from '../../shared/matrix-aliases'

import { $matrixHandleDirectoryEnabled, $matrixHandles, applyMatrixHandleContacts, bindMatrixHandleOwner, matrixHandleAccount,  matrixHandleVerifiedAt } from './person-handles'

/**
 * Shared handle enrichment for visible names in rosters and people pickers. The
 * server answers related or discoverable identities; exact lookup proofs remain
 * independent. Reads pool 50 IDs, refresh verified values every 30 minutes and
 * cap misses at two hours (cleared earlier when a directory revision changes).
 * This window uses at most 96 reads/day, leaving room under the owner's 300/day
 * server budget for other devices. Network errors never become cached misses.
 * Everything is account-scoped, and domain-off stops queued/periodic work.
 */

/** How long the asks of one render are pooled before one read goes out. */
const BATCH_MS = 250
/** Reads this Mac sends per ten minutes, under the route's 30 so the phone keeps its share. */
const READS_PER_WINDOW = 12
const WINDOW_MS = 10 * 60 * 1000
/** A person the directory had no handle for is not asked again for this long in this window. */
export const MATRIX_HANDLE_REFRESH_MS = 30 * 60 * 1000
const NULL_MEMORY_MS = 2 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const READS_PER_DAY = 96
/** Backoff after a failed read: 30 s, doubling, at most 30 minutes. */
const BACKOFF_BASE_MS = 30 * 1000
const BACKOFF_MAX_MS = 30 * 60 * 1000
/** A refusal (denied, signed out, or a Shell without the route) waits the longest. */
const REFUSED_MS = 30 * 60 * 1000

// The local Matrix ID the route accepts; anything else would make the whole read a 400.
const CONTACT_USER = /^@[a-z0-9._=/-]{1,255}:[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?$/u
const encoder = new TextEncoder()

const server = (userId: string) => userId.slice(userId.indexOf(':') + 1)

interface ContactsState {
  owner: string
  generation: number
  queued: string[]
  inFlight: Set<string>
  /** When each ID was answered with no handle (null), for `NULL_MEMORY_MS`. */
  answeredNull: Map<string, number>
  revision: number
  legacy: boolean
  sentAt: number[]
  failures: number
  waitUntil: number
  timer: ReturnType<typeof setTimeout> | undefined
}

// A read answered after the account changed finds a new state object and is dropped.
const fresh = ({ owner, generation }: { owner: string; generation: number }): ContactsState => ({
  owner,
  generation,
  queued: [],
  inFlight: new Set(),
  answeredNull: new Map(),
  revision:-1,
  sentAt: [],
  legacy:false,
  failures: 0,
  waitUntil: 0,
  timer: undefined
})

let state = fresh(matrixHandleAccount())

function defaultBridge(): MatrixAliasBridge | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.atumMatrix?.aliases
  } catch {
    return undefined
  }
}

let bridgeFor: () => MatrixAliasBridge | undefined = defaultBridge

/** The state of the account generation bound now, started over (timer cancelled) on any change. */
function liveState(): ContactsState {
  const account = matrixHandleAccount()

  if (state.generation !== account.generation) {
    clearTimeout(state.timer)
    state = fresh(account)
  }

  return state
}

// Signing out, switching, or signing back in tears down the last generation's work at once.
$matrixHandles.listen(() => void liveState())
$matrixHandleDirectoryEnabled.listen(enabled=>{
  if (!enabled) {clearTimeout(state.timer);state=fresh(matrixHandleAccount())}
})

function askable(current: ContactsState, userId: string, now: number) {
  if (
    userId === current.owner ||
    !CONTACT_USER.test(userId) ||
    encoder.encode(userId).length > 255 ||
    // Another server's people cannot hold an Atum handle; asking would only spend the budget.
    server(userId) !== server(current.owner) ||
    (Boolean($matrixHandles.get().byUser[userId]) && matrixHandleVerifiedAt(userId) + MATRIX_HANDLE_REFRESH_MS > now) ||
    current.inFlight.has(userId) ||
    current.queued.includes(userId)
  ) {
    return false
  }

  const answered = current.answeredNull.get(userId)

  return answered === undefined || now - answered >= NULL_MEMORY_MS
}

function schedule(current: ContactsState, delay: number) {
  if (current.timer !== undefined || current.inFlight.size > 0 || current.queued.length === 0) {
    return
  }

  current.timer = setTimeout(
    () => {
      current.timer = undefined
      void flush(current)
    },
    Math.max(0, delay)
  )
}

/** When the next read may go: after a backoff, and within this Mac's share of the budget. */
function nextReadAt(current: ContactsState, now: number) {
  current.sentAt = current.sentAt.filter(at => now - at < DAY_MS)
  const windowReads=current.sentAt.filter(at=>now-at<WINDOW_MS)
  const budgetAt = windowReads.length >= READS_PER_WINDOW ? windowReads[0]! + WINDOW_MS : now
  const dailyAt=current.sentAt.length>=READS_PER_DAY ? current.sentAt[0]!+DAY_MS : now

  return Math.max(now, current.waitUntil, budgetAt,dailyAt)
}

async function flush(current: ContactsState) {
  if (current !== state || current.inFlight.size > 0 || current.queued.length === 0) {
    return
  }

  const now = Date.now()
  const at = nextReadAt(current, now)

  if (at > now) {
    schedule(current, at - now)

    return
  }

  const bridge = bridgeFor()

  if (!bridge) {
    // No directory in this window (a test, or a build without it): nothing to ask.
    current.queued = []

    return
  }

  const batch = current.queued.splice(0, MATRIX_ALIAS_CONTACTS_MAX)

  for (const userId of batch) {
    current.inFlight.add(userId)
  }

  current.sentAt.push(now)
  let result: MatrixAliasResult

  try {
    result = await bridge.request({ action: 'contacts', matrixUsers: batch, ...(current.legacy ? {} : {schemaVersion:2 as const}) })
    if (!result.ok && result.error==='invalid' && !current.legacy) {
      result=await bridge.request({action:'contacts',matrixUsers:batch})
      if (result.ok) {current.legacy=true}
    }
  } catch {
    result = { ok: false, error: 'unavailable' }
  }

  if (current !== state) {
    return
  }

  for (const userId of batch) {
    current.inFlight.delete(userId)
  }

  const answeredAt = Date.now()

  if (result.ok && result.value.kind === 'contacts') {
    current.failures = 0
    const revision=result.value.revision ?? 0
    if (revision !== current.revision) {
      current.revision=revision
      current.answeredNull.clear()
    }
    applyMatrixHandleContacts(result.value.contacts)

    for (const contact of result.value.contacts) {
      if (!contact.handle) {current.answeredNull.set(contact.matrixUser, answeredAt)}
    }
  } else {
    // Not "no handles", a 400 included (main checked the request, so a 400 is the route's or the
    // contract's trouble, not news about these people): ask again later, first in line. main.log
    // counts the IDs of every failed read.
    current.queued = [...batch.filter(userId => !current.queued.includes(userId)), ...current.queued]
    current.failures += 1
    const error = result.ok ? 'unavailable' : result.error

    const wait =
      error === 'limit'
        ? (!result.ok && result.retryAfterSeconds ? result.retryAfterSeconds * 1000 : WINDOW_MS)
        : error === 'denied' || error === 'missing' || error === 'authentication'
          ? REFUSED_MS
          : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (current.failures - 1))

    current.waitUntil = answeredAt + wait
  }

  schedule(current, BATCH_MS)
}

/**
 * Asks for the @handles of these people, for the account signed in as `owner`. Known handles,
 * the owner themself, other servers' people and anyone just answered are left out; the rest go
 * in the next pooled read.
 */
export function requestMatrixHandles(
  owner: string | undefined,
  userIds: Iterable<string | null | undefined>,
  generation?: number
) {
  const account = matrixHandleAccount()

  // Work for an account that is no longer the one signed in (or begun in an earlier generation of
  // it, before a sign-out) is dropped, never asked with the account signed in now.
  if (!$matrixHandleDirectoryEnabled.get() || !owner || owner !== account.owner || (generation !== undefined && generation !== account.generation)) {
    return
  }

  const work = liveState()
  const now = Date.now()

  for (const userId of userIds) {
    if (userId && askable(work, userId, now)) {
      work.queued.push(userId)
    }
  }

  schedule(work, BATCH_MS)
}

/**
 * Asks, while a list that finds or picks people is on screen, for the @handles of the people it
 * shows. `enabled` is false where no directory exists (the domain is off). The ask repeats only
 * when the set of people changes, never per render.
 */
export function useMatrixHandleContacts(
  owner: string | undefined,
  userIds: readonly (string | null | undefined)[],
  enabled = true
) {
  const directoryEnabled=useStore($matrixHandleDirectoryEnabled)
  const key = [...new Set(userIds.filter((userId): userId is string => Boolean(userId)))].sort().join('\n')

  useEffect(() => {
    if (enabled && directoryEnabled && owner && key) {
      // The list renders for this account; the root binds it first (`bindMatrixHandleOwnerFromSnapshot`).
      bindMatrixHandleOwner(owner)
      requestMatrixHandles(owner, key.split('\n'))
      const timer=setInterval(()=>requestMatrixHandles(owner,key.split('\n')),MATRIX_HANDLE_REFRESH_MS)
      return ()=>clearInterval(timer)
    }
  }, [enabled, directoryEnabled, key, owner])
}

/** Test seams: a bridge of the test's own, and a fresh window. */
export function setMatrixHandleContactsBridgeForTest(bridge: MatrixAliasBridge | undefined) {
  bridgeFor = () => bridge
}

export function resetMatrixHandleContactsForTest() {
  clearTimeout(state.timer)
  state = fresh({ owner: '', generation: -1 })
  bridgeFor = defaultBridge
}
