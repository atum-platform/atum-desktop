import { atom } from 'nanostores'

interface KnownMemberAvatar {
  mxc: string
  avatarUrl: string | null
}

/**
 * Members' public profile photos, by Matrix user and media revision. Display only: the
 * initial renders until the authenticated bridge answers, and a transient failure leaves it
 * in place so the next mount asks again.
 */
export const $matrixMemberAvatars = atom<Record<string, KnownMemberAvatar>>({})

interface MemberProfileHost {
  profiles?: { member?: (userId: string) => Promise<{ userId: string; avatarUrl: string | null }> }
}

const pending = new Map<string, Promise<void>>()

export function loadMatrixMemberAvatar(userId: string, mxc: string) {
  if ($matrixMemberAvatars.get()[userId]?.mxc === mxc || pending.has(`${userId}\n${mxc}`)) {
    return
  }

  // The web client shares this module but has no native profile bridge: read it structurally so both build.
  const host = typeof window === 'undefined' ? undefined : (window as unknown as { atumMatrix?: MemberProfileHost }).atumMatrix
  const bridge = host?.profiles?.member

  if (!bridge) {
    return
  }

  const key = `${userId}\n${mxc}`

  const request = bridge(userId)
    .then(result => {
      if (result.userId !== userId) {
        return
      }

      $matrixMemberAvatars.set({
        ...$matrixMemberAvatars.get(),
        [userId]: { mxc, avatarUrl: result.avatarUrl }
      })
    })
    .catch(() => {
      // The initial stays; a later mount retries.
    })
    .finally(() => pending.delete(key))

  pending.set(key, request)
}
