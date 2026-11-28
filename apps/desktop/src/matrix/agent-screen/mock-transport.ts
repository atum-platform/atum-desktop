import type { AgentScreenOpen, AgentScreenStatus } from '../../../shared/matrix-agent-screen'

import { type AgentScreenBinding, type AgentScreenControl, AgentScreenError, type AgentScreenTransport } from './transport'

/** In-memory transport for the playground and UI tests. The native bridge owns real RFB streams. */
export function mockAgentScreenTransport(
  options: { running?: boolean; owner?: boolean } = {}
): AgentScreenTransport & { setRunning(running: boolean): void } {
  let running = options.running ?? true
  let holder: string | undefined
  let controlRevision = 0

  const status = (sessionId?: string): AgentScreenStatus => {
    if (options.owner === false) {throw new AgentScreenError('forbidden')}

    return { running, holder: holder ? 'human' : 'agent', controlRevision, viewerHasControl: !!holder && holder === sessionId }
  }

  const check = (binding: AgentScreenBinding, revision: number) => {
    status()
    if (!binding.agentPrincipal || revision !== controlRevision) {throw new AgentScreenError('stale_revision')}
  }

  const viewer = (binding: AgentScreenBinding, mode: 'watch' | 'control', sessionId: string): AgentScreenOpen => ({
    viewer: {
      ticket: 'T'.repeat(43),
      sessionId,
      mode,
      binding: { ownerUserId: '@owner:example.test', agentPrincipal: binding.agentPrincipal, computerId: 'fixture' },
      viewerDeviceId: 'DEVICE',
      issuedAt: 0,
      expiresAt: 30_000
    },
    status: status(sessionId)
  })

  const release = (binding: AgentScreenBinding, input: AgentScreenControl) => {
    check(binding, input.expectedControlRevision)
    if (holder !== input.sessionId) {throw new AgentScreenError('stale_revision')}
    holder = undefined
    controlRevision++

    return { released: true as const, status: status() }
  }

  return {
    setRunning: value => {running = value},
    async status(_binding, sessionId) {return status(sessionId)},
    async observe(binding, sessionId = crypto.randomUUID()) {return viewer(binding, 'watch', sessionId)},
    async acquire(binding, { sessionId, expectedControlRevision }) {
      check(binding, expectedControlRevision)
      if (holder !== sessionId) {controlRevision++}
      holder = sessionId

      return viewer(binding, 'control', sessionId)
    },
    async release(binding, input) {return release(binding, input)},
    async handback(binding, input) {
      return { ...release(binding, input), continuation: { askEventId: input.askEventId, roomId: binding.roomId, transactionId: 'R'.repeat(43) } }
    },
    async forceRelease(binding, expectedControlRevision) {
      check(binding, expectedControlRevision)
      if (holder) {controlRevision++}
      holder = undefined

      return { released: true, status: status() }
    },
    connect() {return null}
  }
}
