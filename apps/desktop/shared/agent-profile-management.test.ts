import { expect, it } from 'vitest'

import { agentProfileRequest, agentProfileResult } from './agent-profile-management'

const PRINCIPAL = '00000000-0000-4000-8000-11e594f48195'

it('keeps model requests closed and decodes only validated image bytes', () => {
  expect(agentProfileRequest({ operation: 'read', target: PRINCIPAL, owner: 'forged' })).toBeUndefined()
  expect(agentProfileRequest({ operation: 'update', expectedDefinitionRevision: 1, expectedIdentityRevision: 1 })).toBeUndefined()
  expect(
    agentProfileRequest({ operation: 'avatar', avatar: { type: 'image/png', base64: 'iVBORw0KGgo=' } })
  ).toMatchObject({ operation: 'avatar', avatar: { type: 'image/png', bytes: expect.any(Uint8Array) } })
  expect(agentProfileRequest({ operation: 'avatar', avatar: { type: 'image/png', base64: 'AAAA' } })).toBeUndefined()
})

it('accepts one closed result shape and binds cloud origin/executor facts', () => {
  const envelope = {
    executorId: '00000000-0000-4000-8000-e79acd97ac88',
    originPrincipal: PRINCIPAL,
    originIsMain: true,
    agents: [
      {
        principal: PRINCIPAL,
        displayName: 'Atum',
        isMain: true,
        definitionRevision: 3,
        identityRevision: 2,
        avatarUrl: null
      }
    ]
  }
  expect(agentProfileResult(envelope, { executorId: envelope.executorId, originPrincipal: PRINCIPAL })).toEqual(envelope)
  expect(agentProfileResult({
    ...envelope,
    agents: [{ ...envelope.agents[0], matrixUser: '@internal:test' }]
  })).toBeUndefined()
  expect(agentProfileResult({ ...envelope, originPrincipal: '00000000-0000-4000-8000-f3e028aaa653' }, {
    originPrincipal: PRINCIPAL
  })).toBeUndefined()
  expect(agentProfileResult({ error: 'denied' })).toEqual({ error: 'denied' })
  expect(agentProfileResult({ error: 'private detail' })).toBeUndefined()
})
