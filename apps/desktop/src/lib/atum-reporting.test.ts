import { beforeEach, expect, test, vi } from 'vitest'

import { observeReportingGatewayEvent } from './atum-reporting'

const turn = vi.fn()
beforeEach(() => {
  turn.mockClear()
  window.hermesDesktop = { reporting: { turn, capture: vi.fn() } } as unknown as NonNullable<Window['hermesDesktop']>
})
test('streaming emits only the first token and final outcome, never message or tool payloads', () => {
  const event = (type: string, payload: unknown) => observeReportingGatewayEvent({ type, session_id: 'session', payload }, 'local')
  event('message.start', { turn_id: 'turn' })

  for (let i = 0; i < 100; i++) {event('message.delta', { text: 'private chat' })}
  event('tool.complete', { tool_id: 'tool', arguments: 'secret' })
  event('tool.complete', { tool_id: 'tool', arguments: 'secret' })
  event('message.complete', { turn_id: 'old-turn', status: 'complete' })
  event('message.complete', { turn_id: 'turn', status: 'interrupted', text: 'private reply' })
  expect(turn.mock.calls.map(([value]) => value.phase)).toEqual(['start', 'first_token', 'tool', 'finish'])
  expect(turn.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: 'cancelled' })
  expect(JSON.stringify(turn.mock.calls)).not.toMatch(/private|secret/)
})

test('current and legacy scoped error payloads settle a failed turn; stale IDs are ignored', () => {
  for (const terminal of [{ turn_id: 'failure' }, {}]) {
    observeReportingGatewayEvent({ type: 'message.start', session_id: 'failure-session', payload: { turn_id: 'failure' } }, 'local')
    observeReportingGatewayEvent({ type: 'error', session_id: 'failure-session', payload: { turn_id: 'stale', message: 'private error' } }, 'local')
    observeReportingGatewayEvent({ type: 'error', session_id: 'failure-session', payload: { ...terminal, message: 'private error' } }, 'local')
  }

  expect(turn.mock.calls.filter(([value]) => value.phase === 'finish')).toEqual([
    [{ key: 'failure', phase: 'finish', outcome: 'failed' }], [{ key: 'failure', phase: 'finish', outcome: 'failed' }]
  ])
  expect(JSON.stringify(turn.mock.calls)).not.toContain('private error')
})
