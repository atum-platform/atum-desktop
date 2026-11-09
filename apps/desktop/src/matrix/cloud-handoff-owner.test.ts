import { describe, expect, it, vi } from 'vitest'

import { type CloudHandoffEvent, CloudOwnerHandoff } from './cloud-handoff-owner'

const enrollmentId = '00000000-0000-4000-8000-576f18824476'
const executorId = '00000000-0000-4000-8000-951c747b3afc'
const principal = '00000000-0000-4000-8000-b62b874557d6'
const ownerDevice = 'OWNER_DEVICE'
const agentDevice = 'AGENT_DEVICE'
const agentUserId = '@agent:example.test'
const now = 1_800_000_000_000
const nonce = 'a'.repeat(43)
const recoveryKey = 'correct horse battery staple'
const slot = `io.atum.agent-recovery.${btoa(agentUserId).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`

const enrollment = () => ({
  enrollments: [
    {
      enrollmentId,
      kind: 'cloud',
      executorId,
      deviceId: agentDevice,
      agentPrincipal: principal,
      state: 'awaiting_trust',
      ownerDevice,
      handoffUntil: now + 60_000
    }
  ]
})

// This is the actual 0146 GET /agents projection, not a handoff-specific alias.
const roster = () => [{ principal, matrixUser: agentUserId }]

function restore(extra: Partial<CloudHandoffEvent> = {}): CloudHandoffEvent {
  return {
    type: 'io.atum.agent_identity.request',
    senderUserId: agentUserId,
    senderDeviceId: agentDevice,
    content: {
      v: 1,
      enrollmentId,
      executorId,
      agentUserId,
      deviceId: agentDevice,
      purpose: 'restore',
      nonce,
      expiresAt: now + 30_000
    },
    ...extra
  }
}

function escrow(extra: Partial<CloudHandoffEvent> = {}): CloudHandoffEvent {
  return {
    type: 'io.atum.agent_identity.escrow',
    senderUserId: agentUserId,
    senderDeviceId: agentDevice,
    content: { v: 1, enrollmentId, executorId, agentUserId, nonce, expiresAt: now + 30_000, slot, recoveryKey },
    ...extra
  }
}

function fixture(
  events: unknown[],
  key: string | null = recoveryKey,
  values: { enrollments?: unknown; roster?: unknown; now?: number } = {}
) {
  let stored = key
  const send = vi.fn(async () => {})

  const storage = vi.fn(async (_user: string, write?: string) => {
    if (write !== undefined) {
      stored = write

      return stored
    }

    return stored
  })

  const handoff = new CloudOwnerHandoff(
    {
      deviceId: ownerDevice,
      enrollments: async () => values.enrollments ?? enrollment(),
      roster: async () => values.roster ?? roster(),
      receive: async () => events,
      send,
      recoveryKey: storage
    },
    () => values.now ?? now
  )

  handoff.remember(enrollmentId)

  return { handoff, send, storage, stored: () => stored }
}

describe('CloudOwnerHandoff', () => {
  it('grants a valid restore and escrows only into an empty agent-derived slot', async () => {
    const restoreFixture = fixture([restore()])
    await restoreFixture.handoff.pump()
    expect(restoreFixture.send).toHaveBeenCalledWith(
      { userId: agentUserId, deviceId: agentDevice },
      expect.objectContaining({
        type: 'io.atum.agent_identity.grant',
        content: expect.objectContaining({ recoveryKey })
      })
    )
    const escrowFixture = fixture([escrow()], null)
    await escrowFixture.handoff.pump()
    expect(escrowFixture.stored()).toBe(recoveryKey)
    expect(escrowFixture.send).toHaveBeenCalledWith(
      { userId: agentUserId, deviceId: agentDevice },
      expect.objectContaining({ type: 'io.atum.agent_identity.escrowed' })
    )
  })

  it('never trusts a listed enrollment that this browser did not create or renew', async () => {
    const f = fixture([restore()])

    const unremembered = new CloudOwnerHandoff(
      {
        deviceId: ownerDevice,
        enrollments: async () => enrollment(),
        roster: async () => roster(),
        receive: async () => [restore()],
        send: f.send,
        recoveryKey: f.storage
      },
      () => now
    )

    await unremembered.pump()
    expect(f.storage).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('does not revive an original expired event after a handoff window is renewed', async () => {
    const f = fixture([restore()], recoveryKey, {
      enrollments: { enrollments: [{ ...enrollment().enrollments[0], handoffUntil: now + 120_000 }] },
      now: now + 30_001
    })

    await f.handoff.pump()
    expect(f.storage).not.toHaveBeenCalled()
    expect(f.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'io.atum.agent_identity.refused',
        content: expect.objectContaining({ reason: 'expired' })
      })
    )
  })

  it('uses the actual GET /agents wire and skips other current non-handoff enrollments', async () => {
    const active = {
      ...enrollment().enrollments[0],
      enrollmentId: '00000000-0000-4000-8000-131f2cfdc809',
      state: 'active'
    }

    const f = fixture([restore()], recoveryKey, { enrollments: { enrollments: [active, enrollment().enrollments[0]] } })
    await f.handoff.pump()
    expect(f.send).toHaveBeenCalledWith(
      { userId: agentUserId, deviceId: agentDevice },
      expect.objectContaining({ type: 'io.atum.agent_identity.grant' })
    )
  })

  it('filters another sender/device before payload handling', async () => {
    for (const event of [
      restore({ senderUserId: '@other:example.test' }),
      restore({ senderDeviceId: 'OTHER_DEVICE' })
    ]) {
      const f = fixture([event])
      await f.handoff.pump()
      expect(f.storage).not.toHaveBeenCalled()
      expect(f.send).not.toHaveBeenCalled()
    }
  })

  it('refuses agent, executor, slot and filled-storage mismatches without leaking a key', async () => {
    const cases: [string, CloudHandoffEvent, unknown, unknown, string | null, string][] = [
      [
        'agent',
        restore({ content: { ...(restore().content as object), agentUserId: '@other:example.test' } }),
        enrollment(),
        roster(),
        recoveryKey,
        'wrong_state'
      ],
      [
        'executor',
        restore({ content: { ...(restore().content as object), executorId: '00000000-0000-4000-8000-131f2cfdc809' } }),
        enrollment(),
        roster(),
        recoveryKey,
        'wrong_state'
      ],
      [
        'slot',
        escrow({ content: { ...(escrow().content as object), slot: 'io.atum.agent-recovery.b3RoZXI' } }),
        enrollment(),
        roster(),
        null,
        'wrong_state'
      ],
      ['filled', escrow(), enrollment(), roster(), recoveryKey, 'wrong_state']
    ]

    for (const [_name, event, enrollments, agents, key, reason] of cases) {
      const f = fixture([event], key, { enrollments, roster: agents })
      await f.handoff.pump()
      expect(f.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'io.atum.agent_identity.refused',
          content: expect.objectContaining({ reason })
        })
      )
      expect(f.send.mock.calls.flat().some(value => value === recoveryKey)).toBe(false)
    }
  })

  it('refuses with no_key when current secret storage has no readable owner key and coalesces pumps', async () => {
    const f = fixture([restore()], null)
    await Promise.all([f.handoff.pump(), f.handoff.pump()])
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'io.atum.agent_identity.refused',
        content: expect.objectContaining({ reason: 'no_key' })
      })
    )
    f.handoff.stop()
    await f.handoff.pump()
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('rechecks fresh authority facts after a secret read before exporting a key', async () => {
    let phase = 'open'
    let release!: () => void

    const blocked = new Promise<void>(resolve => {
      release = resolve
    })

    const send = vi.fn(async () => {})

    const storage = vi.fn(async () => {
      await blocked

      return recoveryKey
    })

    const handoff = new CloudOwnerHandoff(
      {
        deviceId: ownerDevice,
        enrollments: async () => (phase === 'open' ? enrollment() : { enrollments: [] }),
        roster: async () => roster(),
        receive: async () => [restore()],
        send,
        recoveryKey: storage
      },
      () => now
    )

    handoff.remember(enrollmentId)
    const pumping = handoff.pump()
    await vi.waitFor(() => expect(storage).toHaveBeenCalledTimes(1))
    phase = 'revoked'
    release()
    await pumping
    expect(send).not.toHaveBeenCalled()
  })
})
