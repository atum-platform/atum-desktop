import { describe, expect, it, vi } from 'vitest'

import {
  CHATGPT_RELAY_CLOCK_SKEW_MS,
  CHATGPT_RELAY_REQUEST_MAX_BYTES,
  ChatGptRelayHandler
} from './chatgpt-relay'

const OWNER = '00000000-0000-4000-8000-bd7662a5eeb4'
const AGENT = '00000000-0000-4000-8000-b454f82c5857'
const DEVICE = '00000000-0000-4000-8000-f6222a1106ee'
const CONNECTION = '00000000-0000-4000-8000-f1d11edf5c5c'
const INVOCATION = '00000000-0000-4000-8000-fbfe405ca65f'
const CAPABILITY = '00000000-0000-4000-8000-a9703d75e616'
const now = 1_793_148_000_000
const session = { connectionId: CONNECTION, connectionEpoch: 7, localGeneration: 1,
  deviceServiceId: DEVICE, enrollmentEpoch: 1, accountEpoch: 1 }
const request = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'private prompt' }], stream: false }
const body = (overrides: Record<string, unknown> = {}) => {
  const selected = (overrides.request as Record<string, unknown> | undefined) ?? request
  const { request: _request, ...rest } = overrides
  const requestJson = JSON.stringify(selected)
  return { capabilityId: CAPABILITY, ownerPrincipal: OWNER, agentPrincipal: AGENT,
    invocationId: INVOCATION, model: 'gpt-5.6-luna', effort: 'medium', relayRevision: 1,
    deviceServiceId: DEVICE, connectionId: CONNECTION, connectionEpoch: 7, issuedAt: now,
    expiresAt: now + 60_000, maxResponseBytes: 800_000,
    requestBytes: Buffer.byteLength(requestJson), requestJson, ...rest }
}

function fixture() {
  const log: string[] = []
  const call = vi.fn(async () => ({ status: 200 as const, response: { id: 'answer', object: 'chat.completion',
    model: 'gpt-5.6-luna', choices: [{ index: 0, message: { role: 'assistant', content: 'private answer' }, finish_reason: 'stop' }] },
    diagnostic: { stage: 'response_encode' as const, code: 'ok' as const, exit: 0 } }))
  const subject = new ChatGptRelayHandler({
    authority: () => ({ ownerPrincipal: OWNER, agentPrincipals: [AGENT], deviceServiceId: DEVICE,
      enabled: true, models: ['gpt-5.6-luna'] }),
    call,
    now: () => now,
    log: line => log.push(line)
  })
  return { subject, call, log }
}

describe('ChatGptRelayHandler', () => {
  it('spends one bound capability and returns only the projected answer', async () => {
    const f = fixture()
    await expect(f.subject.handle(body(), session, 'ok')).resolves.toMatchObject({ state: 'completed', status: 200 })
    expect(f.call).toHaveBeenCalledOnce()
    expect(f.log).toEqual([
      `[ChatGPT relay] invocation=${INVOCATION} state=completed stage=response_encode code=ok exit=0 ms=0`
    ])
    const replay = await f.subject.handle(body(), session, 'ok')
    expect(replay).toMatchObject({ state: 'refused', code: 'replayed' })
    expect(f.call).toHaveBeenCalledOnce()
  })

  it.each([
    ['wrong_owner', { ownerPrincipal: AGENT }],
    ['wrong_agent', { agentPrincipal: OWNER }],
    ['wrong_device', { deviceServiceId: AGENT }],
    ['stale_connection', { connectionId: AGENT }],
    ['expired', { issuedAt: now - 60_000, expiresAt: now - 1 }],
    ['invalid_request', {
      issuedAt: now + CHATGPT_RELAY_CLOCK_SKEW_MS + 1,
      expiresAt: now + CHATGPT_RELAY_CLOCK_SKEW_MS + 60_001
    }],
    ['model_unavailable', { model: 'gpt-9-imaginary', request: { ...request, model: 'gpt-9-imaginary' },
      requestBytes: Buffer.byteLength(JSON.stringify({ ...request, model: 'gpt-9-imaginary' })) }]
  ])('refuses %s before a local model call', async (code, change) => {
    const f = fixture()
    expect(await f.subject.handle(body(change), session, 'ok')).toMatchObject({ state: 'refused', code })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('enforces the request byte declaration and hard cap', async () => {
    const f = fixture()
    expect(await f.subject.handle(body({ requestBytes: CHATGPT_RELAY_REQUEST_MAX_BYTES + 1 }), session, 'ok'))
      .toMatchObject({ state: 'refused', code: 'request_too_large' })
    expect(await f.subject.handle(body({ capabilityId: '00000000-0000-4000-8000-f2da1f9533d4', requestBytes: 1 }), session, 'ok'))
      .toMatchObject({ state: 'refused', code: 'invalid_request' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('rechecks the platform relay revision before touching ChatGPT', async () => {
    const call = vi.fn()
    const subject = new ChatGptRelayHandler({
      authority: () => ({ ownerPrincipal: OWNER, agentPrincipals: [AGENT], deviceServiceId: DEVICE,
        enabled: true, models: ['gpt-5.6-luna'] }),
      authorize: async request => request.relayRevision === 2,
      call,
      now: () => now
    })
    await expect(subject.handle(body(), session, 'ok')).resolves.toMatchObject({ state: 'refused', code: 'relay_disabled' })
    expect(call).not.toHaveBeenCalled()
  })

  it('aborts an in-flight call when transfer changes the platform relay revision', async () => {
    vi.useFakeTimers()
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const subject = new ChatGptRelayHandler({
      authority: () => ({ ownerPrincipal: OWNER, agentPrincipals: [AGENT], deviceServiceId: DEVICE,
        enabled: true, models: ['gpt-5.6-luna'] }),
      authorize,
      call: (_input, signal) => new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })),
      now: () => now
    })
    const pending = subject.handle(body(), session, 'ok')
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(pending).resolves.toMatchObject({ state: 'refused', code: 'stopped' })
    expect(authorize).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('aborts in-flight work on disable and logs metadata without content or credentials', async () => {
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const log: string[] = []
    const subject = new ChatGptRelayHandler({
      authority: () => ({ ownerPrincipal: OWNER, agentPrincipals: [AGENT], deviceServiceId: DEVICE,
        enabled: true, models: ['gpt-5.6-luna'] }),
      call: (_input, signal) => new Promise((_resolve, reject) => {
        started()
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
      }),
      now: () => now,
      log: line => log.push(line)
    })
    const pending = subject.handle(body(), session, 'ok')
    await began
    subject.disable()
    await expect(pending).resolves.toMatchObject({ state: 'refused', code: 'stopped' })
    expect(log).toEqual([
      `[ChatGPT relay] invocation=${INVOCATION} state=refused stage=provider_call code=stopped exit=-1 ms=0`
    ])
    expect(log.join('\n')).not.toMatch(/private prompt|private answer|refresh|access[_-]?token|authorization/i)
  })

  it('carries a closed child stage and code into the one refusal log line', async () => {
    const log: string[] = []
    const failure = Object.assign(new Error('raw child words must not be logged'), {
      diagnostic: { stage: 'response_encode', code: 'response_not_serializable', exit: 4 }
    })
    const subject = new ChatGptRelayHandler({
      authority: () => ({ ownerPrincipal: OWNER, agentPrincipals: [AGENT], deviceServiceId: DEVICE,
        enabled: true, models: ['gpt-5.6-luna'] }),
      call: async () => { throw failure },
      now: () => now,
      log: line => log.push(line)
    })

    await expect(subject.handle(body(), session, 'ok')).resolves.toMatchObject({
      state: 'refused', status: 502, code: 'chatgpt_unavailable'
    })
    expect(log).toEqual([
      `[ChatGPT relay] invocation=${INVOCATION} state=refused stage=response_encode code=response_not_serializable exit=4 ms=0`
    ])
    expect(log[0]).not.toContain('raw child words')
  })
})
