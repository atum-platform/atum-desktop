import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useCallback, useEffect } from 'react'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import {
  parseRoomPolicy,
  parseRoomUsage,
  withAgentMode,
  withGroupRoutingDisclosure
} from '../../shared/room-participation'
import type { GroupPolicyChange, GroupPolicyRead } from '../../shared/room-participation/runtime'

import { groupAssistantRecipients } from './group-assistants'
import { runMatrixCommand } from './text-document-actions'

interface PolicyState {
  value?: GroupPolicyRead
  pending?: boolean
  failed?: boolean
}

export const $groupRoomPolicies = atom<Record<string, PolicyState>>({})
const requests = new Map<string, Promise<unknown>>()
const refreshed = new Map<string, number>()
const consumers = new Map<string, { count: number; timer: number }>()

const put = (key: string, value: PolicyState) => {
  if (consumers.has(key)) {
    $groupRoomPolicies.set({ ...$groupRoomPolicies.get(), [key]: value })
  }
}

function projection(raw: unknown): GroupPolicyRead {
  const value = raw as Partial<GroupPolicyRead> | null
  const policy = parseRoomPolicy(value?.policy)
  const usage = parseRoomUsage(value?.usage)

  if (!value?.policy || !policy.ok || !usage.ok) {
    throw new Error('matrix_group_policy_unreadable')
  }

  return { policy: policy.value, usage: usage.value }
}

/** Shared by the header and composer; every owner/device/room/roster has its own atom entry. */
export function useGroupRoomPolicy(room: MatrixRoom, snapshot: MatrixSnapshot) {
  const recipients = groupAssistantRecipients(room, snapshot)

  const key =
    snapshot.identity && recipients.length && snapshot.state === 'ready'
      ? JSON.stringify([
          snapshot.identity.userId,
          snapshot.identity.deviceId,
          room.id,
          recipients.map(agent => agent.userId).sort()
        ])
      : ''

  const state = useStore($groupRoomPolicies)[key] ?? {}
  const ownerId = snapshot.identity?.userId ?? ''
  const deviceId = snapshot.identity?.deviceId ?? ''
  const roomId = room.id

  const refresh = useCallback(
    async (force = false) => {
      if (!key || requests.has(key) || $groupRoomPolicies.get()[key]?.pending) {
        return
      }

      if (!force && $groupRoomPolicies.get()[key]?.value && Date.now() - (refreshed.get(key) ?? 0) < 25_000) {
        return
      }

      put(key, { ...$groupRoomPolicies.get()[key], pending: true })

      const request = (async () => {
        try {
          const value = projection(
            await runMatrixCommand({ kind: 'groupPolicy', roomId, identity: { userId: ownerId, deviceId } })
          )

          put(key, { value })

          if (consumers.has(key)) {
            refreshed.set(key, Date.now())
          }
        } catch {
          // A stale projection must not keep promising ambient answers after a failed read.
          put(key, { failed: true })
        }
      })()

      requests.set(key, request)

      try {
        await request
      } finally {
        requests.delete(key)
      }
    },
    [key, roomId, ownerId, deviceId]
  )

  useEffect(() => {
    if (!key) {
      return
    }

    const entry = consumers.get(key) ?? { count: 0, timer: window.setInterval(() => void refresh(), 30_000) }
    entry.count++
    consumers.set(key, entry)
    void refresh()

    return () => {
      entry.count--

      if (entry.count) {
        return
      }

      window.clearInterval(entry.timer)
      consumers.delete(key)
      refreshed.delete(key)
      const { [key]: retired, ...current } = $groupRoomPolicies.get()
      void retired
      $groupRoomPolicies.set(current)
    }
  }, [key, refresh]) // Scope changes retire presentation; old completions only update their own key.

  async function change(change: GroupPolicyChange) {
    const current = $groupRoomPolicies.get()[key]

    if (!key || !current?.value || current.pending || requests.has(key)) {
      return false
    }

    const parsed =
      'agentId' in change
        ? withAgentMode(current.value.policy, change.agentId, change.mode)
        : 'dailyTurns' in change
          ? parseRoomPolicy({ ...current.value.policy, dailyTurns: change.dailyTurns })
          : withGroupRoutingDisclosure(current.value.policy)

    if (!parsed.ok) {
      return false
    }

    put(key, { value: { ...current.value, policy: parsed.value }, pending: true })

    const request = (async () => {
      try {
        const value = projection(
          await runMatrixCommand({ kind: 'groupPolicy', roomId: room.id, identity: snapshot.identity!, change })
        )

        put(key, { value })

        if (consumers.has(key)) {
          refreshed.set(key, Date.now())
        }

        return true
      } catch {
        put(key, { value: current.value, failed: true })

        return false
      }
    })()

    requests.set(key, request)

    try {
      return await request
    } finally {
      requests.delete(key)
    }
  }

  return { ...state, refresh, change }
}

/** Cosmetic recipient choices are local per viewer, never an authority setting. */
export function groupRecipientChoice(ownerId: string, roomId: string) {
  const key = `atum.group-recipient:${JSON.stringify([ownerId, roomId])}`

  return {
    read() {
      try {
        return localStorage.getItem(key) ?? ''
      } catch {
        return ''
      }
    },
    write(value: string) {
      try {
        localStorage.setItem(key, value)
      } catch {
        /* Cosmetic storage may be unavailable. */
      }
    }
  }
}
