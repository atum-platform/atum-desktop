import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import type { MatrixEnrollmentIdentity } from '../../../shared/matrix'
import type { MatrixGroupNoticeRequest } from '../../../shared/matrix-group-notice'

import { publishPausedGroupNotice } from './paused-notice'

const day = '2026-10-07'
const now = Date.parse(`${day}T10:00:00Z`)

const identity = (index = 0): MatrixEnrollmentIdentity => ({
  issuer: 'https://issuer.test',
  subject: 'owner',
  principal: 'owner-principal',
  agentPrincipal: `agent-principal-${index}`,
  userId: `@agent${index}:test`,
  executorId: `executor-${index}`,
  deviceId: `MAC-${index}`,
  expiresAt: now + 3600000
})

function fixture() {
  let cap = 3,
    clock = now,
    receipt: string | undefined,
    winner: string | undefined
  let sendLost = false,
    receiptLost = false
  const events = new Map<string, string>()
  const txn = `atum-gd-${'a'.repeat(64)}`

  const authorize = vi.fn(async (input: MatrixGroupNoticeRequest) => {
    if (input.day !== new Date(clock).toISOString().slice(0, 10)) {
      return { version: 1, state: 'not_paused' }
    }

    if (receipt) {
      return { version: 1, state: 'published', day, eventId: receipt }
    }

    if (input.operation === 'published') {
      expect(input.executorId).toBe(winner)
      receipt = input.publishedEvent

      if (receiptLost) {
        receiptLost = false
        throw Error('lost receipt acknowledgment')
      }

      return { version: 1, state: 'published', day, eventId: receipt }
    }

    winner ??= input.executorId

    if (winner !== input.executorId) {
      return { version: 1, state: 'busy' }
    }
    const id = identity(input.executorId === 'executor-0' ? 0 : 1)

    return {
      version: 1,
      state: 'publish',
      owner: id.principal,
      roomId: '!room:test',
      day,
      cap: input.dailyTurns,
      executorId: id.executorId,
      agentPrincipal: id.agentPrincipal,
      agentUserId: id.userId,
      deviceId: id.deviceId,
      transactionId: txn
    }
  })

  const ports = (index = 0) => ({
    now: () => clock,
    readPolicy: vi.fn(async () => ({
      policy: { v: 1 as const, agents: {}, dailyTurns: cap },
      usage: { v: 1 as const, day, turns: 3 }
    })),
    requireRoom: vi.fn(async () => 'lease'),
    authorize,
    publish: vi.fn(async (transaction: string) => {
      const key = `${identity(index).userId}/${identity(index).deviceId}/${transaction}`

      if (!events.has(key)) {
        events.set(key, `$event-${events.size}`)
      }

      if (sendLost) {
        sendLost = false
        throw Error('lost send acknowledgment')
      }

      return events.get(key)!
    }),
    recordUsage: vi.fn(async () => {})
  })

  const run = (p = ports(), index = 0, position = 0) =>
    publishPausedGroupNotice({ roomId: '!room:test', identity: identity(index), position }, p)

  return {
    ports,
    run,
    authorize,
    events,
    get receipt() {
      return receipt
    },
    raise() {
      cap = 4
    },
    rollover() {
      clock = Date.parse('2026-10-08T00:00:00Z')
    },
    loseSend() {
      sendLost = true
    },
    loseReceipt() {
      receiptLost = true
    }
  }
}

describe('canonical paused notice composition', () => {
  it('two selected leaders on different Macs send only the reserved publication', async () => {
    const f = fixture(),
      first = f.ports(0),
      second = f.ports(1)
    await Promise.all([f.run(first), f.run(second, 1)])
    expect(first.publish.mock.calls.length + second.publish.mock.calls.length).toBe(1)
    expect(f.events.size).toBe(1)
    expect(f.receipt).toBe('$event-0')
    await f.run(second, 1)
    expect(second.publish).not.toHaveBeenCalled()
    expect(second.recordUsage).toHaveBeenCalledWith(day, 3)
  })

  it('same-device restart after lost Matrix acknowledgment keeps one event', async () => {
    const f = fixture()
    f.loseSend()
    await expect(f.run()).rejects.toThrow('lost send acknowledgment')
    expect(f.receipt).toBeUndefined()
    const replacement = f.ports(1)
    await f.run(replacement, 1)
    expect(replacement.publish).not.toHaveBeenCalled()
    const restarted = f.ports(0)
    await f.run(restarted)
    expect(f.events.size).toBe(1)
    expect(f.receipt).toBe('$event-0')
    expect(restarted.recordUsage).toHaveBeenCalledOnce()
  })

  it('lost canonical receipt acknowledgment recovers without an SDK resend', async () => {
    const f = fixture()
    f.loseReceipt()
    await expect(f.run()).rejects.toThrow('lost receipt acknowledgment')
    const next = f.ports(1)
    await f.run(next, 1)
    expect(next.publish).not.toHaveBeenCalled()
    expect(next.recordUsage).toHaveBeenCalledWith(day, 3)
    expect(f.events.size).toBe(1)
  })

  it('raising cap after reservation suppresses stale copy', async () => {
    const f = fixture(),
      p = f.ports()
    p.authorize.mockImplementationOnce(async input => {
      const id = identity()
      f.raise()

      return {
        version: 1,
        state: 'publish',
        owner: id.principal,
        roomId: input.roomId,
        day,
        cap: 3,
        executorId: id.executorId,
        agentPrincipal: id.agentPrincipal,
        agentUserId: id.userId,
        deviceId: id.deviceId,
        transactionId: `atum-gd-${'a'.repeat(64)}`
      }
    })
    await f.run(p)
    expect(p.publish).not.toHaveBeenCalled()
    expect(p.recordUsage).not.toHaveBeenCalled()
  })

  it('cap raised after send still records the real event without pausing the raised cap', async () => {
    const f = fixture(),
      p = f.ports()
    p.publish.mockImplementationOnce(async () => {
      f.raise()

      return '$sent'
    })
    await f.run(p)
    expect(f.receipt).toBe('$sent')
    expect(p.recordUsage).not.toHaveBeenCalled()
  })

  it('midnight receipt cannot mark the new day paused', async () => {
    const f = fixture(),
      p = f.ports()
    p.publish.mockImplementationOnce(async () => {
      f.rollover()

      return '$sent'
    })
    await f.run(p)
    expect(p.recordUsage).not.toHaveBeenCalled()
  })

  it('consumes the pinned provider publication and receipt through the native path', async () => {
    const root = new URL(
      '../../../shared/room-participation/fixtures/group-paused-notice/v1/fixtures/',
      import.meta.url
    )
    const grant = JSON.parse(readFileSync(new URL('publication.json', root), 'utf8'))
    const receipt = JSON.parse(readFileSync(new URL('receipt.json', root), 'utf8'))
    const f = fixture(),
      p = f.ports()
    const publisher = {
      ...identity(),
      principal: grant.owner,
      agentPrincipal: grant.agentPrincipal,
      executorId: grant.executorId,
      userId: grant.agentUserId,
      deviceId: grant.deviceId
    }
    p.authorize.mockResolvedValueOnce(grant).mockResolvedValueOnce(receipt)
    p.publish.mockResolvedValueOnce(receipt.eventId)
    await publishPausedGroupNotice({ roomId: grant.roomId, position: 0, identity: publisher }, p)
    expect(p.publish).toHaveBeenCalledExactlyOnceWith(grant.transactionId, grant.cap)
    expect(p.recordUsage).toHaveBeenCalledExactlyOnceWith(grant.day, grant.cap)
    expect(p.authorize.mock.calls[1][0]).toEqual({
      operation: 'published',
      executorId: grant.executorId,
      leaseToken: 'lease',
      roomId: grant.roomId,
      day: grant.day,
      publishedEvent: receipt.eventId
    })
  })

  it('nonleaders never reserve or publish', async () => {
    const f = fixture(),
      p = f.ports()
    await f.run(p, 0, 1)
    expect(p.authorize).not.toHaveBeenCalled()
    expect(p.publish).not.toHaveBeenCalled()
  })

  it('unavailable authority has no SDK fallback', async () => {
    const f = fixture(),
      p = f.ports()
    p.authorize.mockRejectedValueOnce(Error('matrix_group_notice_unavailable'))
    await expect(f.run(p)).rejects.toThrow('matrix_group_notice_unavailable')
    expect(p.publish).not.toHaveBeenCalled()
    expect(p.recordUsage).not.toHaveBeenCalled()
  })

  it.each([
    'owner',
    'roomId',
    'day',
    'cap',
    'executorId',
    'agentPrincipal',
    'agentUserId',
    'deviceId',
    'transactionId'
  ])('refuses a publication grant with changed %s', async key => {
    const f = fixture(),
      p = f.ports(),
      original = p.authorize.getMockImplementation()!
    p.authorize.mockImplementationOnce(async input => ({ ...(await original(input)), [key]: 'forged' }))
    await expect(f.run(p)).rejects.toThrow('matrix_group_notice_invalid')
    expect(p.publish).not.toHaveBeenCalled()
  })

  it('lease replacement during a policy read refuses the send', async () => {
    const f = fixture(),
      p = f.ports()
    p.requireRoom.mockResolvedValueOnce('lease').mockResolvedValueOnce('lease').mockResolvedValue('replacement')
    await expect(f.run(p)).rejects.toThrow('matrix_group_lease_required')
    expect(p.publish).not.toHaveBeenCalled()
  })
})
