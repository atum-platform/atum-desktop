import { describe, expect, it } from 'vitest'

import type { ExecutionPolicyUpdate } from '../../../shared/execution-policy'
import {
  executionPolicyOffersChoice,
  executionPolicyRosterLine,
  executionPolicyRowSummary,
  executionPolicyTrigger
} from '../execution-policy-trigger'

import {
  LONG_MAC_NAME,
  playgroundPolicyBridge,
  playgroundPolicyMode,
  playgroundPolicyView,
  withPlaygroundPolicy
} from './execution-policy-fixtures'
import { scenarioSnapshot } from './fixtures'

describe('playground failover fixture', () => {
  it('opens on the Raymond case: the cloud first in the order, the Mac mini answering', () => {
    const view = playgroundPolicyView(undefined)

    expect(view.policy.order[0]).toBe('cloud')
    expect(executionPolicyTrigger('vi', view)).toMatchObject({ kind: 'destination' })
    expect(executionPolicyTrigger('vi', view).tooltip).toBe('Đang trả lời trên Mac mini')
    expect(executionPolicyTrigger('en', view).tooltip).toBe('Answering on Mac mini')
  })

  it('switches every state from ?policy=, naming this Mac as its owner named it', () => {
    expect(playgroundPolicyMode(new URLSearchParams('?policy=paused'))).toBe('paused')
    expect(playgroundPolicyMode(new URLSearchParams('?policy=saving-failed'))).toBe('saving-failed')
    expect(playgroundPolicyMode(new URLSearchParams('?policy=elsewhere'))).toBe('elsewhere')
    expect(playgroundPolicyMode(new URLSearchParams('?policy=other'))).toBeUndefined()

    expect(executionPolicyTrigger('en', playgroundPolicyView('paused')).kind).toBe('paused')
    expect(executionPolicyTrigger('en', playgroundPolicyView('loading')).kind).toBe('loading')
    expect(executionPolicyTrigger('en', playgroundPolicyView('answering')).tooltip).toBe(
      'Answering on MacBook Air (this Mac)'
    )
  })

  it('models a new account’s first Mac, which has no title-bar control because it has no choice', () => {
    expect(playgroundPolicyMode(new URLSearchParams('?policy=single-mac'))).toBe('single-mac')

    const single = playgroundPolicyView('single-mac')
    expect(single.policy.order).toHaveLength(2)
    expect(executionPolicyOffersChoice(single)).toBe(false)
    // The default fixture is the two-Mac owner, who does have one.
    expect(executionPolicyOffersChoice(playgroundPolicyView(undefined), false)).toBe(true)
    // The card's "Where it answers" row still reads the same place for them.
    expect(executionPolicyRowSummary('en', single).text).toBe('Cloud')
  })

  it('reaches the title bar through the default assistant, and fails a save only when asked', async () => {
    const view = playgroundPolicyView('saving-failed')
    const snapshot = withPlaygroundPolicy(scenarioSnapshot('chat'), view)
    const profileAgent = snapshot.agents?.find(agent => agent.isDefault)

    expect(profileAgent?.executionPolicy).toBe(view)

    const update: ExecutionPolicyUpdate = {
      requestId: '00000000-0000-4000-8000-bd7662a5eeb4',
      expectedRevision: view.policy.revision,
      order: [...view.policy.order].reverse(),
      disabled: []
    }

    await expect(playgroundPolicyBridge(undefined).save('agent-atum', update)).resolves.toMatchObject({ ok: true })
    await expect(playgroundPolicyBridge('saving-failed').save('agent-atum', update)).resolves.toMatchObject({
      ok: false,
      error: { error: 'matrix_503' }
    })
  })

  it('offers a Mac that cannot answer while another destination does (?policy=elsewhere)', () => {
    const view = playgroundPolicyView('elsewhere')
    const snapshot = withPlaygroundPolicy(scenarioSnapshot('chat'), view, 'elsewhere')
    const profileAgent = snapshot.agents?.find(agent => agent.isDefault)

    expect(profileAgent?.executionPolicy).toBe(view)
    expect(profileAgent?.readiness).toMatchObject({ phase: 'blocked', code: 'runtime_unavailable' })
    expect(profileAgent?.ready).toBe(false)
    // The roster says the place in its short form; the card row says only the place.
    expect(executionPolicyRosterLine('vi', view, false)).toBe('Trên Mac mini')
    expect(executionPolicyRowSummary('vi', view).text).toBe('Mac mini')
  })

  it('has an error variant whose Try again owns the roster line, and a long-name variant', () => {
    const error = withPlaygroundPolicy(scenarioSnapshot('chat'), playgroundPolicyView('elsewhere-error'), 'elsewhere-error')

    expect(error.agents?.find(agent => agent.isDefault)?.readiness).toMatchObject({ code: 'offline' })
    expect(playgroundPolicyMode(new URLSearchParams('?policy=long-name'))).toBe('long-name')

    const view = playgroundPolicyView('long-name')
    const long = executionPolicyRowSummary('en', view).text

    expect(long).toBe(LONG_MAC_NAME)
    // Long enough that a row without an ellipsis would overflow it, and not a stripped possessive.
    expect(long.length).toBeGreaterThan(40)
    expect(executionPolicyRosterLine('en', view, false)).toBe(`On ${LONG_MAC_NAME}`)
  })
})
