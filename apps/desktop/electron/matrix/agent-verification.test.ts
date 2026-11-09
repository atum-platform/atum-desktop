import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixIdentity } from '../../shared/matrix'
import type { MatrixVerification } from '../../shared/matrix-security'

import { type MatrixAgentVerificationPort, verifyOwnedMatrixAgent } from './agent-verification'

const ownerIdentity = { userId: '@owner:example.test', deviceId: 'OWNER' }
const agentIdentity = { userId: '@agent:example.test', deviceId: 'AGENT' }
const decimals: [number, number, number] = [1_234, 5_678, 9_000]

afterEach(() => vi.useRealTimers())

class SasHost implements MatrixAgentVerificationPort {
  request: MatrixVerification | undefined
  peer: SasHost | undefined
  fingerprint = 'ed25519:initial'
  deviceCalls = 0
  readonly calls: Array<Record<string, unknown>> = []
  statusOverride: (() => unknown) | undefined
  private ownerConfirmed = false

  constructor(
    readonly role: 'owner' | 'agent',
    readonly identity: MatrixIdentity,
    readonly other: MatrixIdentity
  ) {}

  async command(value: Parameters<MatrixAgentVerificationPort['command']>[0]): Promise<unknown> {
    this.calls.push(value)

    switch (value.kind) {
      case 'devices':
        this.deviceCalls++

        return [{ ...this.identity, fingerprint: this.fingerprint, verified: false }]

      case 'securityStatus':
        return this.statusOverride?.() ?? { recovery: 'idle', verification: this.request }

      case 'agentVerificationStart':
        if (
          this.role !== 'owner' ||
          value.userId !== this.other.userId ||
          value.deviceId !== this.other.deviceId ||
          !this.peer
        ) {
          throw new Error('unexpected_start')
        }

        this.request = { id: 'owner-request', ...this.other, incoming: false, state: 'requested' }
        this.peer.request = { id: 'agent-request', ...this.identity, incoming: true, state: 'requested' }

        return null

      case 'verificationRespond':
        if (!this.request || value.id !== this.request.id || !this.peer) {
          throw new Error('unexpected_response')
        }

        if (value.action === 'cancel') {
          this.request = { ...this.request, state: 'cancelled' }

          return null
        }

        if (value.action === 'accept' && this.role === 'agent') {
          this.request = { ...this.request, state: 'ready' }
          this.peer.request = { ...this.peer.request!, state: 'ready' }

          return null
        }

        if (value.action === 'start' && this.role === 'owner') {
          this.request = { ...this.request, state: 'compare', decimals }
          this.peer.request = { ...this.peer.request!, state: 'compare', decimals }

          return null
        }

        if (value.action === 'confirm' && this.role === 'owner') {
          this.ownerConfirmed = true

          return null
        }

        if (value.action === 'confirm' && this.role === 'agent' && this.peer.ownerConfirmed) {
          this.request = { ...this.request, state: 'done' }
          this.peer.request = { ...this.peer.request!, state: 'done' }

          return null
        }

        throw new Error('unexpected_response')
    }
  }
}

function hosts() {
  const owner = new SasHost('owner', { ...ownerIdentity }, agentIdentity)
  const agent = new SasHost('agent', { ...agentIdentity }, ownerIdentity)
  owner.peer = agent
  agent.peer = owner

  return { owner, agent }
}

function responses(host: SasHost) {
  return host.calls.filter(call => call.kind === 'verificationRespond')
}

it('verifies the exact portable owner and agent devices with matching standard SAS decimals', async () => {
  const { owner, agent } = hosts()
  let assertions = 0

  await verifyOwnedMatrixAgent(
    owner,
    agent,
    () => {
      assertions++
    },
    { pollMs: 1 }
  )

  expect(assertions).toBeGreaterThan(10)
  expect(owner.calls).toContainEqual({
    kind: 'agentVerificationStart',
    userId: agentIdentity.userId,
    deviceId: agentIdentity.deviceId
  })
  expect(responses(owner)).toEqual([
    { kind: 'verificationRespond', id: 'owner-request', action: 'start' },
    { kind: 'verificationRespond', id: 'owner-request', action: 'confirm' }
  ])
  expect(responses(agent)).toEqual([
    { kind: 'verificationRespond', id: 'agent-request', action: 'accept' },
    { kind: 'verificationRespond', id: 'agent-request', action: 'confirm' }
  ])
  expect(owner.request).toMatchObject({ userId: agentIdentity.userId, deviceId: agentIdentity.deviceId, state: 'done' })
  expect(agent.request).toMatchObject({ userId: ownerIdentity.userId, deviceId: ownerIdentity.deviceId, state: 'done' })
})

it('accepts Rust’s outgoing unknown-device Requested phase, but binds the device before SAS starts', async () => {
  const { owner, agent } = hosts()
  owner.statusOverride = () => ({
    recovery: 'idle',
    verification: owner.request
      ? { ...owner.request, deviceId: owner.request.state === 'requested' ? '' : owner.request.deviceId }
      : undefined
  })
  await verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })
  expect(owner.request?.state).toBe('done')
})

it('never accepts an incoming request without the bound sending device', async () => {
  const { owner, agent } = hosts()
  agent.statusOverride = () => ({
    recovery: 'idle',
    verification: agent.request ? { ...agent.request, deviceId: '' } : undefined
  })
  await expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })).rejects.toThrow('peer')
  expect(responses(agent)).not.toContainEqual(expect.objectContaining({ action: 'accept' }))
})

it('confirms both endpoints concurrently because either SAS confirm may wait for the other', async () => {
  const { owner, agent } = hosts()
  const ownerCommand = owner.command.bind(owner)
  const agentCommand = agent.command.bind(agent)
  let ownerWaiting = false
  let releaseOwner!: () => void

  owner.command = async value => {
    const result = await ownerCommand(value)

    if (value.kind === 'verificationRespond' && value.action === 'confirm') {
      ownerWaiting = true
      await new Promise<void>(resolve => {
        releaseOwner = resolve
      })
    }

    return result
  }

  agent.command = async value => {
    const result = await agentCommand(value)

    if (value.kind === 'verificationRespond' && value.action === 'confirm') {
      expect(ownerWaiting).toBe(true)
      releaseOwner()
    }

    return result
  }

  await verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })
  expect(owner.request?.state).toBe('done')
  expect(agent.request?.state).toBe('done')
})

it('ignores completed prior requests and starts a new verification with fresh local request IDs', async () => {
  const { owner, agent } = hosts()

  await verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })
  owner.request = { ...owner.request!, id: 'prior-owner', state: 'done' }
  agent.request = { ...agent.request!, id: 'prior-agent', state: 'done' }
  const ownerBefore = owner.calls.length

  await verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })

  expect(owner.calls.slice(ownerBefore)).toContainEqual({
    kind: 'agentVerificationStart',
    userId: agentIdentity.userId,
    deviceId: agentIdentity.deviceId
  })
  expect(responses(owner).filter(call => call.id === 'prior-owner')).toEqual([])
  expect(responses(agent).filter(call => call.id === 'prior-agent')).toEqual([])
})

it('rejects different SAS values and cancels only the two tracked local requests', async () => {
  const { owner, agent } = hosts()
  const normal = agent.command.bind(agent)

  agent.command = async value => {
    const result = await normal(value)

    if (value.kind === 'verificationRespond' && value.action === 'start') {
      throw new Error('unreachable')
    }

    if (value.kind === 'securityStatus' && agent.request?.state === 'compare') {
      return { recovery: 'idle', verification: { ...agent.request, decimals: [1_234, 5_678, 9_001] } }
    }

    return result
  }

  await expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })).rejects.toThrow('sas_mismatch')
  expect(responses(owner)).toContainEqual({ kind: 'verificationRespond', id: 'owner-request', action: 'cancel' })
  expect(responses(agent)).toContainEqual({ kind: 'verificationRespond', id: 'agent-request', action: 'cancel' })
  expect(responses(owner)).not.toContainEqual({ kind: 'verificationRespond', id: 'foreign', action: 'cancel' })
})

it('refuses a request whose peer identity or device is not the owned agent', async () => {
  const { owner, agent } = hosts()
  agent.statusOverride = () =>
    owner.request
      ? {
          recovery: 'idle',
          verification: {
            id: 'foreign-request',
            userId: '@other:example.test',
            deviceId: 'OTHER',
            incoming: true,
            state: 'requested'
          }
        }
      : { recovery: 'idle' }

  await expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })).rejects.toThrow('peer')
  expect(responses(agent)).toEqual([])
  expect(responses(owner)).toContainEqual({ kind: 'verificationRespond', id: 'owner-request', action: 'cancel' })
})

it('rejects a replacement of either stable local request ID', async () => {
  const { owner, agent } = hosts()
  let ownerStatusReads = 0

  owner.statusOverride = () => {
    ownerStatusReads++

    if (ownerStatusReads > 2 && owner.request) {
      return { recovery: 'idle', verification: { ...owner.request, id: 'replacement' } }
    }

    return { recovery: 'idle', verification: owner.request }
  }

  await expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })).rejects.toThrow('request_replaced')
  expect(responses(owner)).toContainEqual({ kind: 'verificationRespond', id: 'owner-request', action: 'cancel' })
  expect(responses(agent)).toContainEqual({ kind: 'verificationRespond', id: 'agent-request', action: 'cancel' })
})

it('does not act after the current host assertion becomes stale', async () => {
  const { owner, agent } = hosts()
  let checks = 0

  await expect(
    verifyOwnedMatrixAgent(
      owner,
      agent,
      () => {
        checks++

        if (checks > 8) {
          throw new Error('host replaced')
        }
      },
      { pollMs: 1 }
    )
  ).rejects.toThrow('host replaced')

  expect(responses(owner)).toEqual([])
  expect(responses(agent)).toEqual([])
})

it('leaves an existing verification request untouched', async () => {
  const { owner, agent } = hosts()
  owner.request = { id: 'existing', ...agentIdentity, incoming: false, state: 'compare', decimals }

  await expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })).rejects.toThrow('existing')
  expect(owner.calls.some(call => call.kind === 'agentVerificationStart')).toBe(false)
  expect(responses(owner)).toEqual([])
})

it('uses the injected clock to bound a handshake that never reaches either host', async () => {
  const { owner, agent } = hosts()
  const start = owner.command.bind(owner)
  owner.command = async value => (value.kind === 'agentVerificationStart' ? null : start(value))
  let time = 0

  await expect(
    verifyOwnedMatrixAgent(owner, agent, () => {}, {
      now: () => time,
      wait: async milliseconds => {
        time += milliseconds
      },
      pollMs: 5,
      timeoutMs: 20
    })
  ).rejects.toThrow('timeout')
  expect(time).toBe(20)
  expect(responses(owner)).toEqual([])
  expect(responses(agent)).toEqual([])
})

it('does not issue late commands when a stalled port resolves after the deadline', async () => {
  vi.useFakeTimers()
  const { owner, agent } = hosts()
  const normal = owner.command.bind(owner)
  let release!: () => void

  owner.command = async value => {
    if (value.kind === 'agentVerificationStart') {
      await new Promise<void>(resolve => {
        release = resolve
      })

      return null
    }

    return normal(value)
  }

  const pending = verifyOwnedMatrixAgent(owner, agent, () => {}, { timeoutMs: 20, pollMs: 1 })
  const timedOut = expect(pending).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(20)
  await timedOut
  const callsAtTimeout = owner.calls.length + agent.calls.length

  release()
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()

  expect(owner.calls.length + agent.calls.length).toBe(callsAtTimeout)
})

it('times out even when both tracked cancellation calls never settle', async () => {
  vi.useFakeTimers()
  const { owner, agent } = hosts()

  for (const host of [owner, agent]) {
    const normal = host.command.bind(host)

    host.command = async value => {
      if (value.kind === 'verificationRespond' && (value.action === 'accept' || value.action === 'cancel')) {
        host.calls.push(value)

        return new Promise(() => {})
      }

      return normal(value)
    }
  }

  const result = expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { timeoutMs: 20, pollMs: 1 }))
    .rejects.toThrow('timeout')

  await vi.advanceTimersByTimeAsync(20)
  await result
  expect(responses(owner)).toContainEqual({ kind: 'verificationRespond', id: 'owner-request', action: 'cancel' })
  expect(responses(agent)).toContainEqual({ kind: 'verificationRespond', id: 'agent-request', action: 'cancel' })
})

it('fails closed when either native device fingerprint rotates mid-handshake', async () => {
  const { owner, agent } = hosts()
  const devices = owner.command.bind(owner)

  owner.command = async value => {
    const result = await devices(value)

    if (value.kind === 'devices' && owner.deviceCalls >= 3) {
      owner.fingerprint = 'ed25519:rotated'

      return [{ ...owner.identity, fingerprint: owner.fingerprint, verified: false }]
    }

    return result
  }

  await expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })).rejects.toThrow('fingerprint_changed')
  expect(responses(owner)).toContainEqual({ kind: 'verificationRespond', id: 'owner-request', action: 'cancel' })
  expect(responses(agent)).toContainEqual({ kind: 'verificationRespond', id: 'agent-request', action: 'cancel' })
})

it('fails at once, with the protocol code and side, when the owner cancels after the agent confirms', async () => {
  const { owner, agent } = hosts()
  const normal = agent.command.bind(agent)

  // Moon on 2026-10-05: the agent's device came back with new keys under the same ID, so the
  // owner's SDK refused its MAC and cancelled (m.key_mismatch) while the agent finished.
  agent.command = async value => {
    if (value.kind === 'verificationRespond' && value.action === 'confirm') {
      agent.calls.push(value)
      owner.request = { ...owner.request!, state: 'cancelled', cancelCode: 'm.key_mismatch', cancelledBy: 'self' }
      agent.request = { ...agent.request!, state: 'done' }

      return null
    }

    return normal(value)
  }

  let time = 0
  let waited = 0

  await expect(
    verifyOwnedMatrixAgent(owner, agent, () => {}, {
      now: () => time,
      wait: async milliseconds => {
        waited += milliseconds
        time += milliseconds
      },
      pollMs: 100,
      timeoutMs: 60_000
    })
  ).rejects.toThrow('matrix_agent_verification_cancelled:m.key_mismatch:owner')

  // One poll at most after the cancel, never the minute-long deadline.
  expect(waited).toBeLessThan(1_000)
})

it('names the agent when the agent side ended the handshake', async () => {
  const { owner, agent } = hosts()
  const normal = owner.command.bind(owner)

  owner.command = async value => {
    const result = await normal(value)

    if (value.kind === 'verificationRespond' && value.action === 'start') {
      agent.request = { ...agent.request!, state: 'cancelled', cancelCode: 'm.user', cancelledBy: 'self' }
      owner.request = { ...owner.request!, state: 'cancelled', cancelCode: 'm.user', cancelledBy: 'peer' }
    }

    return result
  }

  await expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })).rejects.toThrow(
    'matrix_agent_verification_cancelled:m.user:agent'
  )
})

it('reports an unknown cancel without inventing a code', async () => {
  const { owner, agent } = hosts()
  const normal = owner.command.bind(owner)

  owner.command = async value => {
    const result = await normal(value)

    if (value.kind === 'verificationRespond' && value.action === 'start') {
      owner.request = { ...owner.request!, state: 'cancelled', cancelCode: 'not a code!' }
    }

    return result
  }

  await expect(verifyOwnedMatrixAgent(owner, agent, () => {}, { pollMs: 1 })).rejects.toThrow(
    'matrix_agent_verification_cancelled:unknown:unknown'
  )
})
