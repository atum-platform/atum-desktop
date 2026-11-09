import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useMemo } from 'react'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixUserPresence } from '../../shared/matrix-presence'

import { $matrixHandles } from './person-handles'

interface MatrixPresenceState {
  owner: string
  users: Readonly<Record<string, MatrixUserPresence>>
}

export const $matrixPresence = atom<MatrixPresenceState>({ owner: '', users: {} })
let expiryTimer: ReturnType<typeof setTimeout> | undefined

function activeUsers(users: readonly MatrixUserPresence[], now = Date.now()): Readonly<Record<string, MatrixUserPresence>> {
  return Object.fromEntries(users.map(user => {
    const status = user.status?.expiresAt !== undefined && user.status.expiresAt <= now ? undefined : user.status

    return [user.userId, status === user.status ? user : { ...user, status }]
  }))
}

function scheduleExpiry(): void {
  clearTimeout(expiryTimer)
  const state = $matrixPresence.get()

  const next = Object.values(state.users)
    .flatMap(user => user.status?.expiresAt ? [user.status.expiresAt] : [])
    .filter(expiresAt => expiresAt > Date.now())
    .sort((left, right) => left - right)[0]

  if (next !== undefined) {
    expiryTimer = setTimeout(() => {
      const current = $matrixPresence.get()
      $matrixPresence.set({ ...current, users: activeUsers(Object.values(current.users)) })
      scheduleExpiry()
    }, Math.min(next - Date.now() + 1, 2_147_483_647))
  }
}

/** One account owns the cache. A sign-out/account switch removes the old people synchronously. */
export function bindMatrixPresenceSnapshot(snapshot: Pick<MatrixSnapshot, 'identity' | 'presence'>): void {
  const owner = snapshot.identity?.userId ?? ''
  const users = activeUsers(snapshot.presence?.users ?? [])
  const current = $matrixPresence.get()

  if (current.owner !== owner || JSON.stringify(current.users) !== JSON.stringify(users)) {
    $matrixPresence.set({ owner, users })
  }

  scheduleExpiry()
}

export function clearMatrixPresence(): void {
  clearTimeout(expiryTimer)
  expiryTimer = undefined
  $matrixPresence.set({ owner: '', users: {} })
}

export function useMatrixPresence(userId: string | undefined): MatrixUserPresence | undefined {
  const state = useStore($matrixPresence)

  return userId ? state.users[userId] : undefined
}

export interface MatrixTeammateIdentity {
  memberRef: string
  displayName?: string | null
  handle?: string | null
}

/** Resolve cosmetic platform identity only when Matrix evidence is exact and unique. */
export function resolveMatrixTeammatePresence(
  person: MatrixTeammateIdentity,
  users: Readonly<Record<string, MatrixUserPresence>>,
  handles: Readonly<Record<string, string>>
): MatrixUserPresence | undefined {
  if (person.handle) {
    const byHandle = Object.keys(handles).filter(userId => handles[userId] === person.handle)

    if (byHandle.length === 1) {
      return users[byHandle[0]!]
    }
  }

  const name = person.displayName?.trim().normalize('NFKC').toLocaleLowerCase()

  if (!name) {
    return undefined
  }

  const byName = Object.values(users).filter(user =>
    user.displayName?.trim().normalize('NFKC').toLocaleLowerCase() === name
  )

  return byName.length === 1 ? byName[0] : undefined
}

export function useMatrixTeammatePresence(person: MatrixTeammateIdentity): MatrixUserPresence | undefined {
  const state = useStore($matrixPresence)
  const handleState = useStore($matrixHandles)

  return useMemo(
    () => resolveMatrixTeammatePresence(
      { memberRef: person.memberRef, displayName: person.displayName, handle: person.handle },
      state.users,
      handleState.owner === state.owner ? handleState.byUser : {}
    ),
    [handleState, person.displayName, person.handle, person.memberRef, state]
  )
}
