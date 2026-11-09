import { type MatrixClient, Method } from 'matrix-js-sdk'

import {
  DAILY_TURNS_DEFAULT,
  parseRoomPolicy,
  parseRoomUsage,
  ROOM_AGENTS_ACCOUNT_DATA,
  ROOM_USAGE_ACCOUNT_DATA,
  roomBudget,
  usageAfterClaim,
  withAgentMode,
  withGroupRoutingDisclosure
} from '../../shared/room-participation'
import type {
  GroupPolicyRead,
  GroupPolicySettings,
  GroupRoomTarget,
  GroupUsageChange
} from '../../shared/room-participation/runtime'

import { readGroupRoom } from './assistant-room'

/** Read the server, not a potentially stale sync cache; only the room's owner can write. */
export function matrixRoomPolicy(client: MatrixClient, active: () => boolean, now: () => number = Date.now) {
  const busy = new Set<string>()
  const policyBusy = new Set<string>()
  const live = (target: GroupRoomTarget) => active() && client.getUserId() === target.ownerId

  const check = (target: GroupRoomTarget) => {
    if (!live(target)) {
      throw new Error('matrix_group_changed')
    }
  }

  const fresh = (target: GroupRoomTarget, type: string) =>
    client.http
      .authedRequest<unknown>(
        Method.Get,
        `/user/${encodeURIComponent(target.ownerId)}/rooms/${encodeURIComponent(target.roomId)}/account_data/${type}`
      )
      .catch(error => {
        if (error?.errcode === 'M_NOT_FOUND') {
          return undefined
        }

        throw error
      })

  async function read(target: GroupRoomTarget): Promise<GroupPolicyRead> {
    check(target)
    await readGroupRoom(client, target, () => live(target))

    const [rawPolicy, rawUsage] = await Promise.all([
      fresh(target, ROOM_AGENTS_ACCOUNT_DATA),
      fresh(target, ROOM_USAGE_ACCOUNT_DATA)
    ])

    check(target)
    const policy = parseRoomPolicy(rawPolicy)
    const usage = parseRoomUsage(rawUsage ?? { v: 1, day: new Date(now()).toISOString().slice(0, 10), turns: 0 })

    if (!policy.ok || !usage.ok) {
      throw new Error('matrix_group_policy_unreadable')
    }

    return { policy: policy.value, usage: usage.value }
  }

  return {
    read,
    async settings(input: GroupPolicySettings): Promise<GroupPolicyRead> {
      if (!active() || client.getUserId() !== input.ownerId) {
        throw new Error('matrix_group_changed')
      }

      if (!input.agentIds.length) {
        throw new Error('matrix_group_room_required')
      }

      // Roster authority comes from native; fresh room state proves membership.
      const agentId = input.change && 'agentId' in input.change ? input.change.agentId : input.agentIds[0]!

      if (!input.agentIds.includes(agentId)) {
        throw new Error('matrix_command_invalid')
      }

      const target = { roomId: input.roomId, ownerId: input.ownerId, agentId }

      // Reads never contend with advisory usage writes. Policy and usage are
      // separate account-data records, so their writers have separate locks too.
      if (!input.change) {
        return read(target)
      }

      if (policyBusy.has(input.roomId)) {
        throw new Error('matrix_group_policy_pending')
      }

      policyBusy.add(input.roomId)

      try {
        const current = await read(target)

        const parsed =
          'agentId' in input.change
            ? withAgentMode(current.policy, agentId, input.change.mode)
            : 'dailyTurns' in input.change
              ? parseRoomPolicy({ ...current.policy, dailyTurns: input.change.dailyTurns })
              : withGroupRoutingDisclosure(current.policy)

        if (!parsed.ok) {
          throw new Error('matrix_command_invalid')
        }

        check(target)
        await client.setRoomAccountData(input.roomId, ROOM_AGENTS_ACCOUNT_DATA as never, parsed.value as never)
        check(target)

        return { ...current, policy: parsed.value }
      } finally {
        policyBusy.delete(input.roomId)
      }
    },
    async usage(target: GroupUsageChange): Promise<GroupPolicyRead> {
      check(target)

      if (target.change !== 'claimed' && target.change !== 'paused') {
        throw new Error('matrix_command_invalid')
      }

      if (busy.has(target.roomId)) {
        throw new Error('matrix_group_policy_pending')
      }

      busy.add(target.roomId)

      try {
        const current = await read(target)
        const budget = roomBudget({ now: now(), dailyTurns: target.dailyTurns, usage: current.usage })

        if (
          target.change === 'paused' &&
          (target.day !== budget.day || target.dailyTurns !== (current.policy.dailyTurns ?? DAILY_TURNS_DEFAULT))
        ) {
          return current
        }

        // A lost write acknowledgment or a replayed claimed grant must not count twice.
        // These bounded receipts live in the existing advisory account-data counter.
        const rawClaims = current.usage.day === budget.day ? current.usage.countedClaims : undefined

        if (
          rawClaims !== undefined &&
          (!Array.isArray(rawClaims) ||
            rawClaims.length > 200 ||
            rawClaims.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)))
        ) {
          throw new Error('matrix_group_policy_unreadable')
        }

        const claims = (rawClaims ?? []) as string[]

        if (target.change === 'claimed') {
          if (!target.invocationId || !/^[a-f0-9-]{36}$/i.test(target.invocationId)) {
            throw new Error('matrix_command_invalid')
          }

          if (claims.includes(target.invocationId)) {
            return current
          }

          if (claims.length >= 200) {
            throw new Error('matrix_group_policy_unreadable')
          }
        }

        const usage =
          target.change === 'claimed'
            ? { ...usageAfterClaim(current.usage, budget), countedClaims: [...claims, target.invocationId!] }
            : {
                ...current.usage,
                v: 1 as const,
                day: budget.day,
                turns: Math.max(budget.turns, budget.cap),
                pausedNoticed: true,
                ...(current.usage.day !== budget.day ? { countedClaims: [] } : {})
              }

        // The canonical claim is the money boundary. This account-data counter is advisory.
        check(target)
        await client.setRoomAccountData(target.roomId, ROOM_USAGE_ACCOUNT_DATA as never, usage as never)
        check(target)

        return { ...current, usage }
      } finally {
        busy.delete(target.roomId)
      }
    }
  }
}
