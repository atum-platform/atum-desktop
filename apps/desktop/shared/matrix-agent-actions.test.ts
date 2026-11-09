import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { MatrixExecutionPolicyView } from './execution-policy'
import type { MatrixAgentView } from './matrix'
import {
  matrixAgentActions,
  matrixAgentAnswersInCloud,
  matrixAgentGroupOffer,
  matrixAgentRunsHere
} from './matrix-agent-actions'

const pack = new URL('./execution-policy/fixtures/execution-policy/v1/fixtures/', import.meta.url)

const saved = JSON.parse(
  readFileSync(new URL('policy-saved.response.json', pack), 'utf8')
) as MatrixExecutionPolicyView['policy']

const MAC_A = '00000000-0000-4000-8000-b454f82c5857'

type Agent = Pick<MatrixAgentView, 'ready' | 'answering' | 'macRole' | 'executionPolicy'>

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
const raymondPolicy: MatrixExecutionPolicyView = {
  policy: { ...saved, order: [`mac:${MAC_A}`, 'cloud'], disabled: ['cloud'] },
  stale: false
}

const agent = (overrides: Partial<Agent>): Agent => ({ ready: true, ...overrides })

describe('which actions an assistant offers (0.19.4 Q4, reliability plan R5)', () => {
  it('offers a local assistant what it always did', () => {
    expect(matrixAgentActions(agent({}))).toEqual({ group: true, photo: true, move: true })
    expect(matrixAgentActions(agent({ ready: false }))).toEqual({ group: false, photo: true, move: false })
    expect(matrixAgentGroupOffer(agent({}))).toBe('offered')
    expect(matrixAgentGroupOffer(agent({ ready: false }))).toBe('blocked')
  })

  it('hides group and move for a cloud assistant no Mac answers for, as before', () => {
    expect(matrixAgentActions(agent({ ready: false, answering: 'cloud' }))).toEqual({
      group: false,
      photo: true,
      move: false
    })
    expect(matrixAgentGroupOffer(agent({ ready: false, answering: 'cloud' }))).toBe('hidden')
    // Hosted by a standby Mac only: another destination holds the term, so a group would go unanswered.
    expect(
      matrixAgentGroupOffer(agent({ answering: 'cloud', macRole: 'standby', executionPolicy: raymondPolicy }))
    ).toBe('hidden')
  })

  it("offers Group for Raymond on the Mac that answers for him, whatever the roster's answering flag says", () => {
    const onTheMini = agent({ answering: 'cloud', macRole: 'answering', executionPolicy: raymondPolicy })

    expect(matrixAgentActions(onTheMini).group).toBe(true)
    expect(matrixAgentGroupOffer(onTheMini)).toBe('offered')
  })

  it('still waits for the answering Mac to be ready, and names it blocked rather than hidden', () => {
    const settingUp = agent({ ready: false, answering: 'cloud', macRole: 'answering', executionPolicy: raymondPolicy })

    expect(matrixAgentActions(settingUp).group).toBe(false)
    expect(matrixAgentGroupOffer(settingUp)).toBe('blocked')
  })

  it("offers a cloud-route agent's own pages on the Mac the policy keeps it on, answering or standing by", () => {
    expect(matrixAgentRunsHere({})).toBe(true)
    expect(matrixAgentRunsHere({ answering: 'cloud' })).toBe(false)
    expect(matrixAgentRunsHere({ answering: 'cloud', macRole: 'standby' })).toBe(true)
    expect(matrixAgentRunsHere({ answering: 'cloud', macRole: 'answering' })).toBe(true)
  })

  it('uses the cloud route unless this Mac holds the answering term', () => {
    expect(matrixAgentAnswersInCloud({})).toBe(false)
    expect(matrixAgentAnswersInCloud({ answering: 'cloud' })).toBe(true)
    expect(matrixAgentAnswersInCloud({ answering: 'cloud', macRole: 'standby' })).toBe(true)
    expect(matrixAgentAnswersInCloud({ answering: 'cloud', macRole: 'answering' })).toBe(false)
  })

  it('never offers Move to an agent the platform would refuse to move: a cloud route or a saved policy', () => {
    expect(
      matrixAgentActions(agent({ answering: 'cloud', macRole: 'answering', executionPolicy: raymondPolicy })).move
    ).toBe(false)
    // Roster already local (0238 derives answering from the policy) but the policy still owns it.
    expect(matrixAgentActions(agent({ executionPolicy: raymondPolicy })).move).toBe(false)
    expect(
      matrixAgentActions(
        agent({ executionPolicy: { policy: { ...saved, source: 'default', revision: 0 }, stale: false } })
      ).move
    ).toBe(true)
  })
})
