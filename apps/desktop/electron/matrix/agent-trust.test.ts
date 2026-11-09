import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixSdkCommand } from '../../shared/matrix'

const verification = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock('./agent-verification', () => ({ verifyOwnedMatrixAgent: verification.run }))

import {
  backgroundAgentTrust,
  type MatrixAgentTrustPort,
  prepareMatrixAgentTrust,
  resumeAfterAgentTrust
} from './agent-trust'

const ownerIdentity = { userId: '@owner:example.test', deviceId: 'OWNER' }
const agentIdentity = { userId: '@agent:example.test', deviceId: 'AGENT' }

afterEach(() => vi.resetAllMocks())

function harness(
  options: {
    ownerKey?: string | undefined
    storedKey?: unknown
    status?: unknown
    generatedKey?: unknown
    escrow?: unknown
    escrowError?: Error
    claim?: boolean
    assertCurrent?: () => void
    /** What each store knows of the other device (agentTrustStatus), per call. */
    ownerViews?: unknown[]
    agentViews?: unknown[]
    ownerAfterSasViews?: unknown[]
    agentAfterSasViews?: unknown[]
  } = {}
) {
  const events: string[] = []
  const calls: Array<{ host: 'owner' | 'agent'; value: MatrixSdkCommand }> = []
  const log = vi.fn()
  const ownerKey = 'ownerKey' in options ? options.ownerKey : 'owner-recovery-key'
  const storedKey = options.storedKey === undefined ? null : options.storedKey
  const status = options.status ?? { ready: false, recovery: false }
  const generatedKey = options.generatedKey ?? { id: 'generated-id', key: 'agent-generated-key' }
  const escrow = options.escrow === undefined ? 'agent-generated-key' : options.escrow

  const claim = vi.fn(async () => {
    events.push('claim')

    return options.claim ?? true
  })

  const assertCurrent = options.assertCurrent ?? vi.fn()

  const command = async (host: 'owner' | 'agent', value: MatrixSdkCommand): Promise<unknown> => {
    calls.push({ host, value })

    if (value.kind === 'agentRecoveryKey') {
      events.push(value.key === undefined ? 'owner:read' : 'owner:escrow')

      if (value.key === undefined) {
        return storedKey
      }

      if (options.escrowError) {
        throw options.escrowError
      }

      return escrow
    }

    if (value.kind === 'agentIdentityStatus') {
      events.push('agent:status')

      return status
    }

    if (value.kind === 'recoveryCreateKey') {
      events.push('agent:generate')

      return generatedKey
    }

    if (value.kind === 'agentIdentityCreate') {
      events.push('agent:create')

      return null
    }

    if (value.kind === 'agentIdentityRestore') {
      events.push('agent:restore')

      return null
    }

    // Both devices known, but no cross-signing yet: the handshake runs (an identity just made).
    if (value.kind === 'agentTrustStatus') {
      const afterSas = verification.run.mock.calls.length > 0

      const views = afterSas
        ? host === 'owner'
          ? ownerAfterSasViews
          : agentAfterSasViews
        : host === 'owner'
          ? ownerViews
          : agentViews

      const view = views.length > 1 ? views.shift() : views[0]

      return view
    }

    throw new Error(`unexpected_${host}_${value.kind}`)
  }

  const ownerViews = [
    ...(options.ownerViews ?? [
      {
        ownKey: 'owner-ed25519',
        peerKey: 'agent-ed25519',
        peerIdentityKnown: true,
        peerIdentityVerified: false,
        peerDeviceCrossSigned: false,
        ownDeviceCrossSigned: true
      }
    ])
  ]

  const agentViews = [
    ...(options.agentViews ?? [
      {
        ownKey: 'agent-ed25519',
        peerKey: 'owner-ed25519',
        peerIdentityKnown: true,
        peerIdentityVerified: false,
        peerDeviceCrossSigned: false,
        ownDeviceCrossSigned: true
      }
    ])
  ]

  const ownerAfterSasViews = options.ownerAfterSasViews ?? [crossSigned.owner]
  const agentAfterSasViews = options.agentAfterSasViews ?? [crossSigned.agent]

  const owner: MatrixAgentTrustPort = { identity: ownerIdentity, command: value => command('owner', value) }
  const agent: MatrixAgentTrustPort = { identity: agentIdentity, command: value => command('agent', value) }

  return { agent, assertCurrent, calls, claim, events, owner, ownerKey, log }
}

function run(input: ReturnType<typeof harness>, clock?: { now(): number; wait(ms: number): Promise<void> }) {
  return prepareMatrixAgentTrust({
    owner: input.owner,
    agent: input.agent,
    ownerKey: input.ownerKey,
    claim: input.claim,
    assertCurrent: input.assertCurrent,
    log: input.log,
    ...(clock ? { now: clock.now, wait: clock.wait } : {})
  })
}

/** A deterministic clock: waits move time, never the test. */
function clock() {
  let time = 0
  const waits: number[] = []

  return {
    now: () => time,
    wait: async (ms: number) => {
      waits.push(ms)
      time += ms
    },
    waits
  }
}

/** Both stores' views when each identity signed the other and each device is signed. */
const crossSigned = {
  owner: {
    ownKey: 'owner-ed25519',
    peerKey: 'agent-ed25519',
    peerIdentityKnown: true,
    peerIdentityVerified: true,
    peerDeviceCrossSigned: true,
    ownDeviceCrossSigned: true
  },
  agent: {
    ownKey: 'agent-ed25519',
    peerKey: 'owner-ed25519',
    peerIdentityKnown: true,
    peerIdentityVerified: true,
    peerDeviceCrossSigned: true,
    ownDeviceCrossSigned: true
  }
}

it('claims before generating, escrows and readbacks the SDK key, creates the agent identity, then performs SAS', async () => {
  const input = harness()
  verification.run.mockImplementation(async () => {
    input.events.push('sas')
  })

  await run(input)

  expect(input.events).toEqual([
    'owner:read',
    'agent:status',
    'claim',
    'agent:generate',
    'owner:escrow',
    'agent:create',
    'sas'
  ])
  expect(input.calls).toContainEqual({
    host: 'owner',
    value: {
      kind: 'agentRecoveryKey',
      userId: agentIdentity.userId,
      ownerKey: input.ownerKey,
      key: 'agent-generated-key'
    }
  })
  expect(verification.run).toHaveBeenCalledWith(input.owner, input.agent, input.assertCurrent)
})

it('does not create an identity when another Mac holds the initializer claim', async () => {
  const input = harness({ claim: false })

  await expect(run(input)).rejects.toThrow('initialization_pending')
  expect(input.events).toEqual(['owner:read', 'agent:status', 'claim'])
  expect(input.log).toHaveBeenCalledExactlyOnceWith('[Matrix] agent trust branch=initializer_denied')
  expect(verification.run).not.toHaveBeenCalled()
})

it.each(['owner', 'agent'] as const)('records which peer identity is unknown in the %s store without exposing identities or keys', async side => {
  const input = harness({
    status: { ready: true, recovery: true },
    storedKey: 'escrowed-agent-key',
    ownerViews: [{ ...crossSigned.owner, peerIdentityKnown: side !== 'owner', ownDeviceCrossSigned: false }],
    agentViews: [{ ...crossSigned.agent, peerIdentityKnown: side !== 'agent', peerKey: 'old-owner-ed25519' }]
  })

  const time = clock()
  await expect(run(input, time)).rejects.toThrow('matrix_agent_initialization_pending')
  expect(input.claim).not.toHaveBeenCalled()
  expect(verification.run).not.toHaveBeenCalled()
  expect(input.log).toHaveBeenCalledOnce()
  const line = input.log.mock.calls[0]![0]
  expect(line).toContain('branch=peer_identity_unknown')
  expect(line).toContain(`owner_peer_identity_known=${side !== 'owner'}`)
  expect(line).toContain(`agent_peer_identity_known=${side !== 'agent'}`)
  expect(line).toContain('owner_signed=false agent_signed=true')
  expect(line).toContain('owner_key_equal=false agent_key_equal=true')
  expect(time.waits.reduce((sum, ms) => sum + ms, 0)).toBe(5000)

  for (const secret of [ownerIdentity.userId, agentIdentity.userId, ownerIdentity.deviceId,
    agentIdentity.deviceId, 'owner-ed25519', 'agent-ed25519', 'old-owner-ed25519',
    'owner-recovery-key', 'escrowed-agent-key']) {
    expect(line).not.toContain(secret)
  }
})

it('reports absent peer keys as unknown, never as a proven mismatch', async () => {
  const input = harness({
    status: { ready: true, recovery: true },
    storedKey: 'escrowed-agent-key',
    ownerViews: [{ ...crossSigned.owner, peerKey: undefined, peerIdentityKnown: false }],
    agentViews: [{ ...crossSigned.agent, peerKey: undefined }]
  })

  await expect(run(input, clock())).rejects.toThrow('matrix_agent_initialization_pending')
  expect(input.log.mock.calls[0]![0]).toContain('owner_key_equal=unknown agent_key_equal=unknown')
})

it('propagates the closed identity-query error without waiting, logging identities, or starting SAS', async () => {
  const input = harness({ status: { ready: true, recovery: true }, storedKey: 'escrowed-agent-key' })
  const ownerCommand = input.owner.command

  input.owner.command = async value => {
    if (value.kind === 'agentTrustStatus') {
      throw new Error('matrix_device_query_unavailable')
    }

    return ownerCommand(value)
  }

  const time = clock()

  await expect(run(input, time)).rejects.toThrow('matrix_device_query_unavailable')
  expect(time.waits).toEqual([])
  expect(verification.run).not.toHaveBeenCalled()
  expect(input.log).not.toHaveBeenCalled()
})

it('restores an existing recovery identity with the exact escrowed key without claiming or creating', async () => {
  const input = harness({ storedKey: 'escrowed-agent-key', status: { ready: false, recovery: true } })
  verification.run.mockResolvedValue(undefined)

  await run(input)

  expect(input.events).toEqual(['owner:read', 'agent:status', 'agent:restore'])
  expect(input.calls).toContainEqual({
    host: 'agent',
    value: { kind: 'agentIdentityRestore', key: 'escrowed-agent-key' }
  })
  expect(input.claim).not.toHaveBeenCalled()
  expect(input.events).not.toContain('agent:create')
})

it('verifies a ready agent without resetting its identity', async () => {
  const input = harness({ storedKey: 'escrowed-agent-key', status: { ready: true, recovery: true } })
  verification.run.mockResolvedValue(undefined)

  await run(input)

  expect(input.events).toEqual(['owner:read', 'agent:status'])
  expect(input.claim).not.toHaveBeenCalled()
  expect(input.calls.map(call => call.value.kind)).not.toContain('agentIdentityCreate')
  expect(input.calls.map(call => call.value.kind)).not.toContain('agentIdentityRestore')
  expect(verification.run).toHaveBeenCalledOnce()
})

it('requires the owner recovery key before issuing any native command', async () => {
  const input = harness({ ownerKey: undefined })

  await expect(run(input)).rejects.toThrow('owner_recovery_required')
  expect(input.calls).toEqual([])
  expect(input.claim).not.toHaveBeenCalled()
})

it('fails closed for an existing recovery identity whose escrowed key is absent', async () => {
  const input = harness({ storedKey: null, status: { ready: false, recovery: true } })

  await expect(run(input)).rejects.toThrow('agent_recovery_missing')
  expect(input.events).toEqual(['owner:read', 'agent:status'])
  expect(input.claim).not.toHaveBeenCalled()
  expect(verification.run).not.toHaveBeenCalled()
})

it.each([
  ['invalid identity status', { status: { ready: 'yes', recovery: false } }, 'agent_identity_invalid'],
  ['invalid escrow read', { storedKey: 7 }, 'agent_recovery_invalid'],
  ['invalid SDK-generated recovery key', { generatedKey: { id: 'generated-id', key: '' } }, 'agent_recovery_invalid']
])('fails closed on %s', async (_name, options, error) => {
  const input = harness(options)

  await expect(run(input)).rejects.toThrow(error)
  expect(input.events).not.toContain('agent:create')
  expect(verification.run).not.toHaveBeenCalled()
})

it.each([
  ['conflicting escrow readback', { escrow: 'different-key' }, 'agent_recovery_incomplete'],
  ['escrow write failure', { escrowError: new Error('vault failed') }, 'vault failed']
])('does not create when %s', async (_name, options, error) => {
  const input = harness(options)

  await expect(run(input)).rejects.toThrow(error)
  expect(input.events).toContain('owner:escrow')
  expect(input.events).not.toContain('agent:create')
  expect(verification.run).not.toHaveBeenCalled()
})

it('does not mutate after assertCurrent becomes stale following an awaited owner read', async () => {
  let checks = 0

  const input = harness({
    assertCurrent: () => {
      checks++

      if (checks === 3) {
        throw new Error('matrix_agent_identity_stale')
      }
    }
  })

  await expect(run(input)).rejects.toThrow('matrix_agent_identity_stale')
  expect(input.events).toEqual(['owner:read'])
  expect(input.claim).not.toHaveBeenCalled()
  expect(verification.run).not.toHaveBeenCalled()
})

it('needs no handshake when the owner and the agent already trust each other by cross-signing', async () => {
  const input = harness({
    storedKey: 'escrowed-agent-key',
    status: { ready: true, recovery: true },
    ownerViews: [crossSigned.owner],
    agentViews: [crossSigned.agent]
  })

  await expect(run(input)).resolves.toBe('cross_signed')
  expect(verification.run).not.toHaveBeenCalled()
  // Read-only questions only: nothing created, restored or started.
  expect(input.calls.map(call => call.value.kind)).toEqual([
    'agentRecoveryKey',
    'agentIdentityStatus',
    'agentTrustStatus',
    'agentTrustStatus'
  ])
  expect(input.calls).toContainEqual({ host: 'owner', value: { kind: 'agentTrustStatus', peer: agentIdentity } })
  expect(input.calls).toContainEqual({ host: 'agent', value: { kind: 'agentTrustStatus', peer: ownerIdentity } })
})

it('says the agent’s device was replaced when its keys changed under the same ID, without a handshake', async () => {
  // Atum Moon on 2026-10-05: its store was lost, it re-uploaded new keys under its old device
  // ID, and the owner's store kept the first ones.
  const input = harness({
    storedKey: 'escrowed-agent-key',
    status: { ready: true, recovery: true },
    ownerViews: [{ ...crossSigned.owner, peerKey: 'agent-ed25519-before' }],
    agentViews: [crossSigned.agent]
  })

  await expect(run(input)).rejects.toThrow('matrix_agent_device_replaced')
  expect(verification.run).not.toHaveBeenCalled()
})

it('says this Mac’s own device was replaced when the agent’s store holds other keys for it', async () => {
  const input = harness({
    storedKey: 'escrowed-agent-key',
    status: { ready: true, recovery: true },
    ownerViews: [crossSigned.owner],
    agentViews: [{ ...crossSigned.agent, peerKey: 'owner-ed25519-before' }]
  })

  await expect(run(input)).rejects.toThrow('matrix_owner_device_replaced')
  expect(verification.run).not.toHaveBeenCalled()
})

it('waits briefly for a store that has not seen the other device yet, then decides', async () => {
  const time = clock()

  const input = harness({
    storedKey: 'escrowed-agent-key',
    status: { ready: true, recovery: true },
    ownerViews: [
      { ...crossSigned.owner, peerKey: undefined },
      { ...crossSigned.owner, peerKey: undefined },
      crossSigned.owner
    ],
    agentViews: [crossSigned.agent]
  })

  await expect(run(input, time)).resolves.toBe('cross_signed')
  expect(time.waits).toEqual([500, 500])
  expect(verification.run).not.toHaveBeenCalled()
})

it('falls back to the handshake when a store still does not know the other device after five seconds', async () => {
  const time = clock()

  const input = harness({
    storedKey: 'escrowed-agent-key',
    status: { ready: true, recovery: true },
    ownerViews: [{ ...crossSigned.owner, peerKey: undefined }],
    agentViews: [crossSigned.agent]
  })

  verification.run.mockResolvedValue(undefined)

  await expect(run(input, time)).resolves.toBe('verified')
  expect(time.waits.reduce((sum, ms) => sum + ms, 0)).toBe(5_000)
  expect(verification.run).toHaveBeenCalledOnce()
})

it.each([
  ['the agent has not signed the owner’s identity', { agent: { peerIdentityVerified: false } }],
  ['the owner has not signed the agent’s identity', { owner: { peerIdentityVerified: false } }],
  ['the agent’s new device is not signed yet', { owner: { peerDeviceCrossSigned: false } }],
  ['the owner’s device on this Mac is not signed yet', { owner: { ownDeviceCrossSigned: false } }]
])('runs the handshake when %s', async (_name, patch) => {
  const input = harness({
    storedKey: 'escrowed-agent-key',
    status: { ready: true, recovery: true },
    ownerViews: [{ ...crossSigned.owner, ...('owner' in patch ? patch.owner : {}) }],
    agentViews: [{ ...crossSigned.agent, ...('agent' in patch ? patch.agent : {}) }]
  })

  verification.run.mockResolvedValue(undefined)

  await expect(run(input)).resolves.toBe('verified')
  expect(verification.run).toHaveBeenCalledOnce()
})

it('fails closed on a malformed trust answer', async () => {
  const input = harness({
    storedKey: 'escrowed-agent-key',
    status: { ready: true, recovery: true },
    ownerViews: [{ ownKey: '', peerIdentityVerified: true }]
  })

  await expect(run(input)).rejects.toThrow('matrix_agent_identity_invalid')
  expect(verification.run).not.toHaveBeenCalled()
})

it('waits for the master identity even when the device key is already known, before starting SAS', async () => {
  const time = clock()

  const input = harness({
    ownerViews: [
      { ...crossSigned.owner, peerIdentityKnown: false, peerIdentityVerified: false },
      { ...crossSigned.owner, peerIdentityVerified: false }
    ],
    agentViews: [crossSigned.agent]
  })

  verification.run.mockImplementation(async () => {
    expect(time.waits).toEqual([500])
  })
  await expect(run(input, time)).resolves.toBe('verified')
})

it('never starts device-only SAS when the master identity stays unknown', async () => {
  const input = harness({
    ownerViews: [{ ...crossSigned.owner, peerIdentityKnown: false, peerIdentityVerified: false }]
  })

  await expect(run(input, clock())).rejects.toThrow('matrix_agent_initialization_pending')
  expect(verification.run).not.toHaveBeenCalled()
})

it('does not claim portable trust when SAS finished but the owner did not sign the master identity', async () => {
  const input = harness({ ownerAfterSasViews: [{ ...crossSigned.owner, peerIdentityVerified: false }] })
  verification.run.mockResolvedValue(undefined)
  await expect(run(input, clock())).rejects.toThrow('matrix_agent_verification_incomplete')
})

it('waits for post-SAS cross-signing propagation without repeating the handshake', async () => {
  const time = clock()

  const input = harness({
    ownerAfterSasViews: [{ ...crossSigned.owner, peerIdentityVerified: false }, crossSigned.owner]
  })

  verification.run.mockResolvedValue(undefined)
  await expect(run(input, time)).resolves.toBe('verified')
  expect(time.waits).toEqual([500])
  expect(verification.run).toHaveBeenCalledOnce()
})

describe('trust off the readiness path (0.20)', () => {
  it('never holds the caller, and logs one closed line when trust fails', async () => {
    const lines: string[] = []
    let fail!: (error: Error) => void
    const trust = vi.fn(() => new Promise((_resolve, reject) => (fail = reject)))
    backgroundAgentTrust(trust, 'readiness', line => lines.push(line))
    expect(trust).toHaveBeenCalledOnce()
    expect(lines).toEqual([])
    fail(new Error('matrix_owner_recovery_required'))
    await vi.waitFor(() =>
      expect(lines).toEqual([
        '[Matrix] agent trust background stage=readiness outcome=failed code=matrix_owner_recovery_required'
      ])
    )
  })

  it('never writes raw error text', async () => {
    const lines: string[] = []
    backgroundAgentTrust(
      async () => Promise.reject(new Error('M_FORBIDDEN @owner:test !room')),
      'connect',
      line => lines.push(line)
    )
    await vi.waitFor(() =>
      expect(lines).toEqual(['[Matrix] agent trust background stage=connect outcome=failed code=unexpected'])
    )
  })

  it('resumes routines whatever trust does once the main room is plain', async () => {
    const resume = vi.fn()
    await resumeAfterAgentTrust(async () => Promise.reject(new Error('matrix_agent_trust_failed')), true, resume)
    expect(resume).toHaveBeenCalledOnce()
  })

  it('keeps waiting for trust while the main room is still encrypted', async () => {
    const resume = vi.fn()
    await resumeAfterAgentTrust(async () => Promise.reject(new Error('matrix_agent_trust_failed')), false, resume)
    expect(resume).not.toHaveBeenCalled()
    await resumeAfterAgentTrust(async () => 'verified', false, resume)
    expect(resume).toHaveBeenCalledOnce()
  })
})
