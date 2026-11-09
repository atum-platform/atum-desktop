import type { MatrixEnrollmentIdentity } from '../../../shared/matrix'
import type { MatrixGroupNoticeRequest } from '../../../shared/matrix-group-notice'
import type { GroupPolicyRead } from '../../../shared/room-participation/runtime'

import { groupBudget, groupPauseBudget } from './budget'

interface PausedNoticeInput {
  roomId: string
  position: number
  identity: MatrixEnrollmentIdentity
  canonicalCap?: number
}

interface PausedNoticePorts {
  now?(): number
  readPolicy(): Promise<GroupPolicyRead>
  /** Current token only while the exact enrolled publisher and room remain ready. */
  requireRoom(): Promise<string>
  authorize(input: MatrixGroupNoticeRequest): Promise<unknown>
  publish(transactionId: string, cap: number): Promise<unknown>
  recordUsage(day: string, cap: number): Promise<unknown>
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const event = (value: unknown): value is string =>
  typeof value === 'string' && /^\$.+/.test(value) && value.length <= 1024

/** Canonical reservation -> same-device send -> canonical receipt -> advisory usage.
 * A transport failure leaves the durable reservation for the next trigger/restart.
 * Another device never takes over an ambiguous send. No model or wallet port exists. */
export async function publishPausedGroupNotice(input: PausedNoticeInput, ports: PausedNoticePorts): Promise<void> {
  const now = ports.now ?? Date.now
  const budget = groupPauseBudget(await ports.readPolicy(), { ...input, now: now() })

  if (!budget) {
    return
  }

  const leaseToken = await ports.requireRoom()
  const binding = { roomId: input.roomId, day: budget.day, executorId: input.identity.executorId, leaseToken }
  const grant = await ports.authorize({ ...binding, operation: 'claim', dailyTurns: budget.cap })

  if (!record(grant) || grant.version !== 1) {
    throw new Error('matrix_group_notice_invalid')
  }

  if (grant.state === 'busy' || grant.state === 'not_paused') {
    return
  }

  const fresh = async () => {
    if ((await ports.requireRoom()) !== leaseToken) {
      throw new Error('matrix_group_lease_required')
    }
    const current = groupBudget(await ports.readPolicy(), now())

    if ((await ports.requireRoom()) !== leaseToken) {
      throw new Error('matrix_group_lease_required')
    }

    return current.day === budget.day && current.cap === budget.cap
  }

  if (grant.state === 'publish') {
    if (
      grant.owner !== input.identity.principal ||
      grant.roomId !== binding.roomId ||
      grant.day !== binding.day ||
      grant.cap !== budget.cap ||
      grant.executorId !== binding.executorId ||
      grant.agentPrincipal !== input.identity.agentPrincipal ||
      grant.agentUserId !== input.identity.userId ||
      grant.deviceId !== input.identity.deviceId ||
      typeof grant.transactionId !== 'string' ||
      !/^atum-gd-[a-f0-9]{64}$/.test(grant.transactionId)
    ) {
      throw new Error('matrix_group_notice_invalid')
    }

    if (!(await fresh())) {
      return
    }

    const eventId = await ports.publish(grant.transactionId, budget.cap)

    if (!event(eventId)) {
      throw new Error('matrix_group_notice_invalid')
    }

    if ((await ports.requireRoom()) !== leaseToken) {
      throw new Error('matrix_group_lease_required')
    }
    const receipt = await ports.authorize({ ...binding, operation: 'published', publishedEvent: eventId })

    // UTC rollover during a server-side wait is a non-publication for the new day.
    if (record(receipt) && receipt.version === 1 && receipt.state === 'not_paused') {
      return
    }

    if (
      !record(receipt) ||
      receipt.version !== 1 ||
      receipt.state !== 'published' ||
      receipt.day !== budget.day ||
      receipt.eventId !== eventId
    ) {
      throw new Error('matrix_group_notice_invalid')
    }
  } else if (grant.state !== 'published' || grant.day !== budget.day || !event(grant.eventId)) {
    throw new Error('matrix_group_notice_invalid')
  }

  if (await fresh()) {
    await ports.recordUsage(budget.day, budget.cap)
  }
}
