import { describe, expect, it } from 'vitest'

import {
  matrixFoldSubscriptionFallbacks,
  matrixGoogleRouteSwitch,
  matrixLatestAnswerFallback,
  matrixSubscriptionFallback
} from './matrix-subscription-fallback'

const descriptor = (args: Record<string, unknown> = { plan: 'chatgpt', reason: 'offline', servedBy: 'nguyet-thuc' }) => ({
  msgtype: 'm.notice',
  body: '',
  'io.atum.presentation': { version: 1, code: 'subscription_fallback', args },
  'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } }
})

describe('the subscription fallback notice', () => {
  it('reads exactly the agent-turns/1.7 descriptor', () => {
    expect(matrixSubscriptionFallback(descriptor())).toEqual({
      plan: 'chatgpt',
      reason: 'offline',
      servedBy: 'nguyet-thuc'
    })
    expect(
      matrixSubscriptionFallback(descriptor({ plan: 'opencode_go', reason: 'rate_limited', servedBy: 'nhat-thuc' }))
    ).toEqual({ plan: 'opencode_go', reason: 'rate_limited', servedBy: 'nhat-thuc' })
  })

  it('refuses anything else: authored text, a price, an unknown plan or reason, no reply', () => {
    expect(matrixSubscriptionFallback({ ...descriptor(), body: 'ChatGPT was offline' })).toBeUndefined()
    expect(matrixSubscriptionFallback({ ...descriptor(), msgtype: 'm.text' })).toBeUndefined()
    expect(
      matrixSubscriptionFallback(descriptor({ plan: 'chatgpt', reason: 'offline', servedBy: 'x', protons: 40 }))
    ).toBeUndefined()
    expect(matrixSubscriptionFallback(descriptor({ plan: 'claude', reason: 'offline', servedBy: 'x' }))).toBeUndefined()
    expect(matrixSubscriptionFallback(descriptor({ plan: 'chatgpt', reason: 'cheaper', servedBy: 'x' }))).toBeUndefined()
    const { 'm.relates_to': _reply, ...unrelated } = descriptor()
    expect(matrixSubscriptionFallback(unrelated)).toBeUndefined()
    expect(matrixSubscriptionFallback(null)).toBeUndefined()
  })

  it('folds each notice onto the answer it replies to and never shows it as a row', () => {
    const fallback = { plan: 'chatgpt' as const, reason: 'offline' as const, servedBy: 'nguyet-thuc' }

    const messages = [
      { id: '$question', sender: '@owner:test', own: true },
      { id: '$answer', sender: '@assistant:test', own: false, replyTo: '$question' },
      { id: '$notice', sender: '@assistant:test', own: false, replyTo: '$answer', subscriptionFallback: fallback },
      { id: '$later', sender: '@assistant:test', own: false }
    ]

    const folded = matrixFoldSubscriptionFallbacks(messages)

    expect(folded.map(each => each.id)).toEqual(['$question', '$answer', '$later'])
    expect(folded[1]).toMatchObject({ answeredByFallback: fallback })
    expect(folded[2]).not.toHaveProperty('answeredByFallback')
  })

  it('never marks someone else’s message, and drops a notice whose answer is not in view', () => {
    const fallback = { plan: 'chatgpt' as const, reason: 'timeout' as const, servedBy: 'nguyet-thuc' }

    const folded = matrixFoldSubscriptionFallbacks([
      { id: '$answer', sender: '@other:test', own: false },
      { id: '$notice', sender: '@assistant:test', own: false, replyTo: '$answer', subscriptionFallback: fallback },
      { id: '$orphan', sender: '@assistant:test', own: false, replyTo: '$gone', subscriptionFallback: fallback }
    ])

    expect(folded).toEqual([{ id: '$answer', sender: '@other:test', own: false }])
  })
})

describe('the Google switch line (S2)', () => {
  const switched = (args: Record<string, unknown> = { servedBy: 'nguyet-thuc' }, body = 'I’m continuing with Nguyệt Thực.') => ({
    msgtype: 'm.notice',
    body,
    'io.atum.presentation': { version: 1, code: 'google_route_switched', args }
  })

  it('reads exactly its descriptor; the host’s own body is ignored', () => {
    expect(matrixGoogleRouteSwitch(switched())).toEqual({ servedBy: 'nguyet-thuc' })
    expect(matrixGoogleRouteSwitch(switched(undefined, ''))).toEqual({ servedBy: 'nguyet-thuc' })
  })

  it('refuses anything else: a price, an unknown version or code, a text message', () => {
    expect(matrixGoogleRouteSwitch(switched({ servedBy: 'nguyet-thuc', protons: 9 }))).toBeUndefined()
    expect(matrixGoogleRouteSwitch(switched({}))).toBeUndefined()
    expect(matrixGoogleRouteSwitch({ ...switched(), msgtype: 'm.text' })).toBeUndefined()
    expect(
      matrixGoogleRouteSwitch({ ...switched(), 'io.atum.presentation': { version: 1, code: 'other', args: { servedBy: 'x' } } })
    ).toBeUndefined()
    expect(matrixGoogleRouteSwitch(descriptor())).toBeUndefined()
  })

  it('shows the first one only, and never one sent by someone who is not an agent', () => {
    const line = { servedBy: 'nguyet-thuc' }
    const agents = new Set(['@assistant:test'])

    const folded = matrixFoldSubscriptionFallbacks(
      [
        { id: '$q', sender: '@owner:test', own: true },
        { id: '$first', sender: '@assistant:test', own: false, googleSwitch: line },
        { id: '$a', sender: '@assistant:test', own: false },
        { id: '$again', sender: '@assistant:test', own: false, googleSwitch: line },
        { id: '$stranger', sender: '@other:test', own: false, googleSwitch: line }
      ],
      agents
    )

    expect(folded.map(each => each.id)).toEqual(['$q', '$first', '$a', '$stranger'])
    expect(folded[1]).toMatchObject({ googleSwitch: line })
    expect(folded[3]).not.toHaveProperty('googleSwitch')
  })
})

describe('whether the agent’s latest reply fell back (the composer chip)', () => {
  const fallback = { plan: 'chatgpt' as const, reason: 'offline' as const, servedBy: 'nguyet-thuc' }
  const agent = '@assistant:test'

  it('reads the notice that follows the latest answer', () => {
    expect(
      matrixLatestAnswerFallback(
        [
          { id: '$q', sender: '@owner:test', own: true },
          { id: '$a', sender: agent, own: false, replyTo: '$q' },
          { id: '$n', sender: agent, own: false, replyTo: '$a', subscriptionFallback: fallback }
        ],
        agent
      )
    ).toEqual(fallback)
  })

  it('clears once a later answer came from the plan, and skips working and switch lines', () => {
    expect(
      matrixLatestAnswerFallback(
        [
          { id: '$a', sender: agent, own: false },
          { id: '$n', sender: agent, own: false, replyTo: '$a', subscriptionFallback: fallback },
          { id: '$b', sender: agent, own: false }
        ],
        agent
      )
    ).toBeUndefined()

    expect(
      matrixLatestAnswerFallback(
        [
          { id: '$a', sender: agent, own: false, answeredByFallback: fallback },
          { id: '$work', sender: agent, own: false, progress: {} },
          { id: '$switch', sender: agent, own: false, googleSwitch: { servedBy: 'nguyet-thuc' } },
          { id: '$mine', sender: '@owner:test', own: true }
        ],
        agent
      )
    ).toEqual(fallback)

    expect(matrixLatestAnswerFallback([{ id: '$a', sender: agent, own: false, answeredByFallback: fallback }], undefined)).toBeUndefined()
  })
})
