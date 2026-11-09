import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect } from 'react'

import type { MatrixMember, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixAliasBridge, MatrixAliasContact } from '../../shared/matrix-aliases'

import { useConversationCopy } from './conversation-copy'
import { type MatrixPeopleContext, validMatrixHandle } from './person-name'

/**
 * People's @handles the alias directory has vouched for, by Matrix ID (ledger AC8). The
 * sources: the signed-in person's own `current`, a lookup that returned a Matrix ID for a
 * handle, and a people-search answer the directory proved. Nothing is guessed from an ID.
 * Kept for one account: signing in as someone else starts from that account's own list.
 */
interface KnownHandles {
  owner: string
  byUser: Readonly<Record<string, string>>
}

export const $matrixHandles = atom<KnownHandles>({ owner: '', byUser: {} })
export const $matrixHandleDirectoryEnabled = atom(true)

/**
 * What this Mac remembers of the list between launches, per account, so a person found once by
 * their @handle keeps it in the roster and the pickers. An entry lives seven days: well inside the
 * 30 days a renamed handle stays held for its old owner (spec/public-handles/v1), so a remembered
 * handle can be out of date for that person but never name someone else. Storage that is missing
 * or refuses is only a missed convenience.
 */
const STORE_PREFIX = 'atum.matrix.verified-handles.v1:'
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

interface StoredHandles {
  v: 1
  byUser: Record<string, { h: string; at: number; source?: 'contacts' | 'exact' }>
}

let learnedAt: Record<string, number> = {}
let learnedSources: Record<string,'contacts'|'exact'> = {}

/**
 * Bumped on every change of the signed-in account, signing out included, so A → signed out → A
 * is two changes. Work begun for one generation (a directory search, a contacts read) is dropped
 * when it lands in another.
 */
let accountGeneration = 0

/** The account handles are kept for now, and its generation. */
export function matrixHandleAccount(): { owner: string; generation: number } {
  return { owner: $matrixHandles.get().owner, generation: accountGeneration }
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function readStored(owner: string, now = Date.now()): Record<string, { h: string; at: number; source?: 'contacts' | 'exact' }> {
  try {
    const raw = storage()?.getItem(STORE_PREFIX + owner)
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredHandles>) : undefined

    if (!parsed || parsed.v !== 1 || !parsed.byUser || typeof parsed.byUser !== 'object') {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed.byUser).filter(
        ([userId, entry]) =>
          userId.startsWith('@') &&
          Boolean(validMatrixHandle(entry?.h)) &&
          typeof entry.at === 'number' &&
          entry.at <= now &&
          now - entry.at < KEEP_MS
      )
    )
  } catch {
    return {}
  }
}

function writeStored(state: KnownHandles) {
  if (!state.owner) {
    return
  }

  try {
    const byUser = Object.fromEntries(
      Object.entries(state.byUser).map(([userId, h]) => [userId, { h, at: learnedAt[userId] ?? Date.now(), source:learnedSources[userId] ?? 'exact' }])
    )

    storage()?.setItem(STORE_PREFIX + state.owner, JSON.stringify({ v: 1, byUser } satisfies StoredHandles))
  } catch {
    // A full or blocked store only means the list is learned again next launch.
  }
}

function setHandles(state: KnownHandles) {
  $matrixHandles.set(state)
  writeStored(state)
}

/** Starts the list for an account, keeping it when the account is the same. */
export function bindMatrixHandleOwner(owner: string) {
  if ($matrixHandles.get().owner !== owner) {
    accountGeneration += 1
    const stored = owner ? readStored(owner) : {}
    learnedAt = Object.fromEntries(Object.entries(stored).map(([userId, entry]) => [userId, entry.at]))
    learnedSources = Object.fromEntries(Object.entries(stored).map(([userId, entry]) => [userId, entry.source === 'contacts' ? 'contacts' : 'exact']))
    $matrixHandles.set({ owner, byUser: Object.fromEntries(Object.entries(stored).map(([userId, entry]) => [userId, entry.h])) })
  }
}

/**
 * Follows the root snapshot: its account while one is signed in, nobody once signed out. Called
 * before the snapshot is published, so nothing renders for an account the list does not belong to.
 * Any other state (starting, an error) keeps the current binding.
 */
export function bindMatrixHandleOwnerFromSnapshot(snapshot: Pick<MatrixSnapshot, 'identity' | 'state'> & Partial<Pick<MatrixSnapshot,'domainEnabled'>>) {
  if (typeof snapshot.domainEnabled==='boolean') {$matrixHandleDirectoryEnabled.set(snapshot.domainEnabled)}
  if (snapshot.identity?.userId) {
    bindMatrixHandleOwner(snapshot.identity.userId)
  } else if (snapshot.state === 'signed_out') {
    bindMatrixHandleOwner('')
  }
}

/** Records that the directory says `userId` holds `handle`. A handle has one holder: a
 * later answer moves it, and nobody else keeps showing it. */
export function rememberMatrixHandle(userId: string, handle: string, source:'contacts'|'exact'='exact') {
  const valid = validMatrixHandle(handle)
  const state = $matrixHandles.get()

  if (!valid || !state.owner || !userId.startsWith('@')) {
    return
  }

  if (source==='contacts' && state.byUser[userId] && learnedSources[userId]==='exact' && state.byUser[userId]!==valid && Date.now()-(learnedAt[userId]??0)<30*60*1000) { return }
  learnedSources[userId] = state.byUser[userId] && learnedSources[userId]==='exact' ? 'exact' : source
  learnedAt[userId] = Date.now()
  if (state.byUser[userId]===valid) { writeStored(state); return }
  const others = Object.entries(state.byUser).filter(([user, held]) => user !== userId && held !== valid)
  learnedAt = { ...learnedAt, [userId]: Date.now() }
  setHandles({ ...state, byUser: Object.fromEntries([...others, [userId, valid]]) })
}

/** Last directory evidence for the account's cached value; old persisted values refresh. */
export function matrixHandleVerifiedAt(userId:string):number { return learnedAt[userId] ?? 0 }

/** Forgets a person's handle, or whoever held `handle`, once the directory says otherwise
 * (released, or free again). */
export function forgetMatrixHandle({ handle, userId }: { handle?: string; userId?: string }) {
  const state = $matrixHandles.get()
  const kept = Object.entries(state.byUser).filter(([user, held]) => user !== userId && held !== handle)

  if (kept.length !== Object.keys(state.byUser).length) {
    for (const [user,held] of Object.entries(state.byUser)) {
      if (user===userId || held===handle) {delete learnedAt[user];delete learnedSources[user]}
    }
    setHandles({ ...state, byUser: Object.fromEntries(kept) })
  }
}

/** The signed-in person's own handle as Settings just read or claimed it (null: none). */
export function rememberOwnMatrixHandle(handle: string | null) {
  const owner = $matrixHandles.get().owner

  if (!owner) {
    return
  }

  if (handle) {
    rememberMatrixHandle(owner, handle)
  } else {
    forgetMatrixHandle({ userId: owner })
  }
}

/** Contacts evidence refreshes its own entries; exact lookup proofs survive misses. */
export function applyMatrixHandleContacts(contacts: readonly MatrixAliasContact[]) {
  for (const contact of contacts) {
    if (contact.handle) {
      rememberMatrixHandle(contact.matrixUser,contact.handle,'contacts')
    } else if (learnedSources[contact.matrixUser]==='contacts') {
      forgetMatrixHandle({userId:contact.matrixUser})
    }
  }
}

/** An assistant's handle as the directory just confirmed it; the one it replaced answers to
 * nobody now. Without the assistant's Matrix ID only the old handle is forgotten. */
export function rememberAgentHandle(userId: string | undefined, handle: string, previous: string | null) {
  if (previous) {
    forgetMatrixHandle({ handle: previous })
  }

  if (userId) {
    rememberMatrixHandle(userId, handle)
  }
}

/** The verified handles, for the account signed in now. */
export function useMatrixHandles(owner: string | undefined): Readonly<Record<string, string>> {
  const state = useStore($matrixHandles)

  return owner && state.owner === owner ? state.byUser : {}
}

/** The verified handles of whoever this window is signed in as, for surfaces that are keyed by
 * account rather than by Matrix ID (Team space). Empty until the account is bound. */
export function useSignedInMatrixHandles(): Readonly<Record<string, string>> {
  const state = useStore($matrixHandles)

  return state.owner ? state.byUser : {}
}

/** Everything naming the people of a list, search or picker needs: verified handles, the
 * members, who is signed in, and the word for someone unnamed in the window's language. */
export function useMatrixPeople(members: readonly MatrixMember[] | undefined, ownerUserId: string | undefined): MatrixPeopleContext {
  return { handles: useMatrixHandles(ownerUserId), members, ownerUserId, unnamed: useConversationCopy().unnamed }
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function useMatrixChatPeople(members: readonly MatrixMember[] | undefined, ownerUserId: string | undefined): MatrixPeopleContext {
  return { members, ownerUserId, unnamed: useConversationCopy().unnamed }
}

const asked = new Map<string, Promise<void>>()

/** Asks the directory for the signed-in person's own handle, once per account per window. */
export function loadOwnMatrixHandle(owner: string, bridge: MatrixAliasBridge): Promise<void> {
  bindMatrixHandleOwner(owner)
  const pending = asked.get(owner)

  if (pending) {
    return pending
  }

  const request = bridge
    .request({ action: 'current' })
    .then(result => {
      if (!result.ok || result.value.kind !== 'current' || $matrixHandles.get().owner !== owner) {
        // Unanswered: ask again next time something needs it.
        asked.delete(owner)

        return
      }

      if (result.value.alias) {
        rememberMatrixHandle(owner, result.value.alias.handle)
      } else {
        forgetMatrixHandle({ userId: owner })
      }
    })
    .catch(() => void asked.delete(owner))

  asked.set(owner, request)

  return request
}

/** Test seam: forget what was asked, as a new window would. */
export function resetMatrixHandlesForTest() {
  asked.clear()
  accountGeneration += 1
  learnedAt = {}
  learnedSources = {}
  $matrixHandleDirectoryEnabled.set(true)
  $matrixHandles.set({ owner: '', byUser: {} })

  try {
    const store = storage()
    const keys = Array.from({ length: store?.length ?? 0 }, (_, index) => store?.key(index) ?? '')

    for (const key of keys) {
      if (key.startsWith(STORE_PREFIX)) {
        store?.removeItem(key)
      }
    }
  } catch {
    // Nothing remembered to clear.
  }
}

/**
 * The signed-in person's own @handle, once the directory has answered. Asked only where
 * the directory exists (the domain is on and the alias bridge is wired).
 */
export function useOwnMatrixHandle(
  owner: string | undefined,
  enabled: boolean,
  bridge: MatrixAliasBridge | undefined = typeof window === 'undefined' ? undefined : window.atumMatrix?.aliases
): string | undefined {
  const handles = useMatrixHandles(owner)

  useEffect(() => {
    if (!owner) {
      return
    }

    bindMatrixHandleOwner(owner)

    if (enabled && bridge) {
      void loadOwnMatrixHandle(owner, bridge)
    }
  }, [bridge, enabled, owner])

  return owner ? handles[owner] : undefined
}
