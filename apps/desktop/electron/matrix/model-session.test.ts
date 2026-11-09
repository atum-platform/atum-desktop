import { expect, it, vi } from 'vitest'

import type { JsonRpcGatewayClient } from '../../../shared/src/json-rpc-gateway'

import { applyMatrixSessionEffort, matrixSessionEffortParams, requireMatrixSessionChoice } from './model-session'

function gateway(answer: unknown = { key: 'reasoning', value: 'high' }) {
  const request = vi.fn(async () => answer)

  return { request, port: { request: request as JsonRpcGatewayClient['request'] } }
}

it('creates only a session effort parameter and leaves an absent choice unset', () => {
  expect(matrixSessionEffortParams('high')).toEqual({ reasoning_effort: 'high' })
  expect(matrixSessionEffortParams(undefined)).toEqual({})
  expect(() => matrixSessionEffortParams('xhigh' as never)).toThrow('matrix_session_effort_unavailable')
})

it('applies changed effort to exactly the resumed session, never the profile/global scope', async () => {
  const f = gateway()
  const signal = new AbortController().signal
  await applyMatrixSessionEffort(f.port, 'resumed-session', { reasoning_effort: 'low' }, 'high', signal)
  expect(f.request.mock.calls).toEqual([
    ['config.set', { key: 'reasoning', value: 'high', session_id: 'resumed-session', scope: 'session' }, 15_000, signal]
  ])
})

it('leaves an unchanged or unchosen level alone', async () => {
  const f = gateway()
  await applyMatrixSessionEffort(f.port, 's', { reasoning_effort: 'high' }, 'high', new AbortController().signal)
  await applyMatrixSessionEffort(f.port, 's', { reasoning_effort: 'high' }, undefined, new AbortController().signal)
  expect(f.request).not.toHaveBeenCalled()
})

it.each([undefined, null, {}, { key: 'model', value: 'high' }, { key: 'reasoning', value: 'low' }])(
  'stops before submission when Hermes does not acknowledge the selected level: %j',
  async answer => {
    const f = gateway(answer === undefined ? null : answer)
    const submit = vi.fn()
    await expect(
      (async () => {
        await applyMatrixSessionEffort(f.port, 's', {}, 'high', new AbortController().signal)
        submit()
      })()
    ).rejects.toThrow('matrix_session_effort_unavailable')
    expect(submit).not.toHaveBeenCalled()
  }
)

it('does not expose an upstream refusal and never retries a busy session', async () => {
  const f = gateway()
  f.request.mockRejectedValue({ code: 4009, message: 'credential-canary' })
  await expect(applyMatrixSessionEffort(f.port, 's', {}, 'high', new AbortController().signal)).rejects.toThrow(
    'matrix_session_effort_unavailable'
  )
  expect(f.request).toHaveBeenCalledTimes(1)
})

it('preserves cancellation before and after the await', async () => {
  const f = gateway()
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await expect(applyMatrixSessionEffort(f.port, 's', {}, 'high', controller.signal)).rejects.toThrow('cancelled')
  expect(f.request).not.toHaveBeenCalled()
  const later = new AbortController()
  f.request.mockImplementation(async () => {
    later.abort(new Error('later'))

    return { key: 'reasoning', value: 'high' }
  })
  await expect(applyMatrixSessionEffort(f.port, 's', {}, 'high', later.signal)).rejects.toThrow('later')
})

it('never sends an unscoped or malformed effort write', async () => {
  const f = gateway()

  for (const [session, effort] of [
    ['', 'high'],
    ['s', 'xhigh']
  ] as const) {
    await expect(
      applyMatrixSessionEffort(f.port, session, {}, effort as never, new AbortController().signal)
    ).rejects.toThrow('matrix_session_effort_unavailable')
  }

  expect(f.request).not.toHaveBeenCalled()
})

it('refuses unsupported private choices before native session work, preserving unrelated assistants', () => {
  const principal = '00000000-0000-4000-8000-bd7662a5eeb4'
  const other = '00000000-0000-4000-8000-b454f82c5857'
  const atum = { v: 2 as const, source: 'atum' as const, model: 'nguyet-thuc', effort: 'high' as const }

  const own = {
    v: 2 as const,
    source: 'connection' as const,
    connectionId: 'personal-key',
    model: 'gpt-6-luna',
    effort: 'low' as const
  }

  expect(() => requireMatrixSessionChoice(undefined, principal)).not.toThrow()
  expect(() => requireMatrixSessionChoice({ modelChoice: atum }, principal)).not.toThrow()
  expect(() => requireMatrixSessionChoice({ modelChoice: { ...atum, agents: { [other]: own } } })).toThrow(
    'matrix_model_choice_unavailable'
  )
  expect(() =>
    requireMatrixSessionChoice({ modelChoice: { ...atum, agents: { [other]: own } } }, principal)
  ).not.toThrow()

  for (const room of [
    { modelChoiceInvalid: true as const },
    { modelChoice: own },
    { modelChoice: { ...atum, effort: 'max' as const } },
    { modelChoice: { ...atum, model: 'unadvertised-model' } },
    { modelChoice: { ...atum, agents: { [principal]: own } } },
    { modelChoice: { ...atum, agents: { [principal]: atum } } }
  ]) {
    expect(() => requireMatrixSessionChoice(room, principal)).toThrow('matrix_model_choice_unavailable')
  }
})
