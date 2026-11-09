import { describe, expect, it } from 'vitest'

import { matrixPetHatchTarget, matrixPetRecoveryTarget } from './pet-hatch-target'

const scope = { accountKey: 'account', generation: 3 }
const target = { scope: 'account:3', agent: 'agent-a' }
const identity = { principal: 'owner', executorId: 'executor-a' }

function facts(agent: { closed: boolean; agentPrincipal?: string; invocation?: unknown } = { closed: false, agentPrincipal: 'agent-a' }) {
  return {
    scope,
    token: 'account:3',
    agents: [agent],
    identity: (value: typeof agent) => (value === agent ? identity : null),
    runtime: { root: '/runtime' },
    managedModel: true
  }
}

describe("a pet request's account and agent", () => {
  // At launch every agent runs its model check (`invocation: { setup: true }`), and the window's
  // recovery read was then refused with matrix_pet_unavailable on every 0.19.0 start.
  it('answers a recovery read while the agent runs its launch model check', () => {
    const busy = { closed: false, agentPrincipal: 'agent-a', invocation: { setup: true } }
    expect(matrixPetRecoveryTarget(target, facts(busy))).toEqual({ scope, agent: busy, identity })
    expect(() => matrixPetHatchTarget(target, facts(busy))).toThrow('matrix_pet_unavailable')
  })

  it('needs no Hermes runtime or Atum model to read or discard a record, but a hatch does', () => {
    const bare = { ...facts(), runtime: undefined, managedModel: false }
    expect(matrixPetRecoveryTarget(target, bare).identity).toBe(identity)
    expect(() => matrixPetHatchTarget(target, { ...facts(), runtime: undefined })).toThrow('matrix_pet_unavailable')
    expect(() => matrixPetHatchTarget(target, { ...facts(), managedModel: false })).toThrow('matrix_pet_unavailable')
    expect(matrixPetHatchTarget(target, facts()).selectedRuntime).toEqual({ root: '/runtime' })
  })

  it.each([
    ['another account', { ...facts(), token: 'account:4' }],
    ['no signed-in account', { ...facts(), scope: null }],
    ['a closed agent', facts({ closed: true, agentPrincipal: 'agent-a' })],
    ['another agent', facts({ closed: false, agentPrincipal: 'agent-b' })],
    ['an agent not enrolled here', { ...facts(), identity: () => null }]
  ])('refuses %s', (_label, value) => {
    expect(() => matrixPetRecoveryTarget(target, value)).toThrow('matrix_pet_unavailable')
    expect(() => matrixPetHatchTarget(target, value)).toThrow('matrix_pet_unavailable')
  })
})
