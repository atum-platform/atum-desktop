/** Public synthetic default-agent identity vectors; these exercise stable storage shapes. */
import { describe, expect, it } from 'vitest'

import { matrixManagedModelKey } from './account'
import { MATRIX_CRON_PENDING_KEY } from './cron-delivery'
import { matrixFullHermesKey } from './full-hermes'
import { matrixHermesHome } from './hermes-runtime'
import { matrixConversationKey } from './invocation'
import { MATRIX_LOCAL_TURNS_INDEX, matrixLocalTurnOwner } from './local-turn'

const config = { python: '/runtime/python', source: '/runtime/src', profiles: '/profiles' }
const owner = '00000000-0000-4000-8000-afea1db8e695'
const executorId = '00000000-0000-4000-8000-70fa3005afb9'

const agent = {
  issuer: 'https://auth.example/',
  principal: owner,
  agentPrincipal: '00000000-0000-4000-8000-fe8f79f0b46e',
  executorId,
  deviceId: 'ATUM_AGENT_DEVICE'
}

const human = { userId: '@owner:example', deviceId: 'HUMAN_DEVICE' }

describe("the default agent's identity", () => {
  it('keeps its Hermes home path', () => {
    expect(matrixHermesHome(config as never, owner, executorId)).toMatchInlineSnapshot(`"/profiles/bf2c3a6a880415a00899608e079a0a435d730387b226543e780cce0c11c9babd"`)
  })

  it('keeps its conversation keys', () => {
    expect(matrixConversationKey(agent, human, '!room:example')).toMatchInlineSnapshot(`"matrix-conversation-ca85b9ca0046a9620014577196923652d430c253138ace5d18ac6ec4a1b0f6e1"`)
  })

  it('keeps its local-turn owner', () => {
    expect(
      matrixLocalTurnOwner({ human, agentUserId: '@agent:example', agentPrincipal: agent.agentPrincipal })
    ).toMatchInlineSnapshot(`"41f4426725dc8215dd0966a9b67223adc03934e04a94f7ef902d3aded90899cc"`)
  })

  it('keeps its model proxy key', () => {
    expect(matrixManagedModelKey(Buffer.from('fixture-storage-key').toString('base64'))).toMatchInlineSnapshot(`"e9693eeb9838ec4c9ab95426626a99afe00c909f7e8de2ff4b7271ebce461cc9"`)
  })

  it('keeps its vault keys', () => {
    expect({
      localTurns: MATRIX_LOCAL_TURNS_INDEX,
      cronPending: MATRIX_CRON_PENDING_KEY,
      fullHermes: matrixFullHermesKey(executorId)
    }).toMatchInlineSnapshot(`
      {
        "cronPending": "matrix-cron-pending",
        "fullHermes": "matrix-full-hermes:00000000-0000-4000-8000-70fa3005afb9",
        "localTurns": "matrix-local-turns",
      }
    `)
  })
})
