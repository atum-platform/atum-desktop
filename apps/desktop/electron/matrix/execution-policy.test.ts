import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExecutionDeviceName, ExecutionPolicyOff, ExecutionPolicyUpdate } from '../../shared/execution-policy'

import {
  MatrixExecutionPolicyController,
  matrixExecutionPolicyHasLocalDestination,
  matrixExecutionPolicyKeepsLocalRuntime,
  matrixExecutionPolicyLeaseIntent,
  matrixExecutionPolicyListeningAction,
  matrixExecutionPolicyLocalMode,
  matrixExecutionPolicySaveLogLine,
  matrixExecutionPolicyStartsLocalReadiness,
  requestMatrixExecutionPolicy
} from './execution-policy'

const pack = new URL('../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/', import.meta.url)
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, pack), 'utf8'))
const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MAC_A = '00000000-0000-4000-8000-b454f82c5857'

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('execution-policy transport', () => {
  it('uses only the fixed owner routes and main-owned bearer', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(fixture('policy-saved.response.json')))
      .mockResolvedValueOnce(json(fixture('status-working.response.json')))
      .mockResolvedValueOnce(json(fixture('policy-saved.response.json')))

    vi.stubGlobal('fetch', request)
    const signal = new AbortController().signal

    const resource = 'https://shell.test/api/matrix/v1'
    await requestMatrixExecutionPolicy(resource, 'owner-token', AGENT, 'policy', signal)
    await requestMatrixExecutionPolicy(resource, 'owner-token', AGENT, 'status', signal)
    const update = fixture<ExecutionPolicyUpdate>('policy-update.request.json')
    await requestMatrixExecutionPolicy(resource, 'owner-token', AGENT, 'update', signal, update)

    expect(request.mock.calls[0][0]).toBe(`${resource}/agents/${AGENT}/execution-policy`)
    expect(request.mock.calls[1][0]).toBe(`${resource}/agents/${AGENT}/execution-status`)
    expect(request.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    })
    expect(new Headers(request.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer owner-token')
    expect(request.mock.calls[2][1]).toMatchObject({ method: 'PUT', body: JSON.stringify(update) })
  })

  it('surfaces only an explicit 401 for the account refresh path and refuses non-JSON', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 })))
    await expect(
      requestMatrixExecutionPolicy('https://shell.test', 'expired', AGENT, 'policy', new AbortController().signal)
    ).rejects.toThrow('matrix_s1_authentication')

    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('no', { status: 503 })))
    await expect(
      requestMatrixExecutionPolicy('https://shell.test', 'owner-token', AGENT, 'status', new AbortController().signal)
    ).rejects.toThrow('matrix_execution_policy_unavailable')
  })
})

function controllerFixture(
  deviceNames?: () => Promise<Record<string, ExecutionDeviceName> | undefined>,
  log?: (line: string) => void
) {
  let scope = { accountKey: 'owner-a', generation: 1 }
  let now = 100
  const changed = vi.fn()

  const request = vi.fn(async (_principal: string, action: 'policy' | 'status' | 'update') => {
    if (action === 'policy') {
      return { status: 200, value: fixture('policy-saved.response.json') }
    }

    if (action === 'status') {
      return { status: 200, value: fixture('status-working.response.json') }
    }

    throw new Error('unexpected update')
  })

  const controller = new MatrixExecutionPolicyController({
    scope: () => scope,
    request,
    changed,
    now: () => now,
    ...(log ? { log } : {}),
    ...(deviceNames ? { deviceNames } : {})
  })

  controller.activate(scope)
  controller.retain([AGENT])

  return {
    controller,
    request,
    changed,
    setScope: (next: typeof scope) => {
      scope = next
      controller.activate(next)
    },
    advance: (ms: number) => (now += ms)
  }
}

describe('execution-policy authoritative cache', () => {
  it('primes every retained policy before the roster integration may continue', async () => {
    let finish!: (value: { status: number; value: unknown }) => void

    const request = vi.fn(async (_principal: string, action: 'policy' | 'status' | 'update') =>
      action === 'policy'
        ? new Promise<{ status: number; value: unknown }>(resolve => {
            finish = resolve
          })
        : { status: 200, value: fixture('status-working.response.json') }
    )

    const controller = new MatrixExecutionPolicyController({
      scope: () => ({ accountKey: 'owner-a', generation: 1 }),
      request,
      changed: vi.fn()
    })

    let settled = false

    const retained = controller.retain([AGENT]).then(() => {
      settled = true
    })

    await Promise.resolve()

    expect(settled).toBe(false)
    expect(controller.snapshot(AGENT)).toBeUndefined()
    finish({ status: 200, value: fixture('policy-saved.response.json') })
    await retained
    expect(controller.snapshot(AGENT)).toMatchObject({ stale: false, policy: { revision: 2 } })
  })

  it('publishes only a strictly parsed matching policy/status pair', async () => {
    const f = controllerFixture()
    const value = await f.controller.read(AGENT)

    expect(value).toMatchObject({ stale: false, policy: { revision: 2 }, status: { state: 'working' } })
    expect(f.controller.snapshot(AGENT)).toEqual(value)
    expect(f.changed).toHaveBeenCalled()
  })

  it('carries the owner’s names beside a fresh policy, and a registry that fails never stales it', async () => {
    const names = vi.fn(async () => ({
      [MAC_A]: { displayName: "Owner's MacBook Air", model: 'MacBook Air', thisMac: true }
    }))

    const f = controllerFixture(names)
    const value = await f.controller.read(AGENT)

    expect(names).toHaveBeenCalledTimes(1)
    expect(value).toMatchObject({
      stale: false,
      deviceNames: { [MAC_A]: { displayName: "Owner's MacBook Air", thisMac: true } }
    })
    // A save keeps the names already known; they are not re-asked on its bare view.
    const update = fixture<ExecutionPolicyUpdate>('policy-update.request.json')

    const accepted = {
      ...fixture<Record<string, unknown>>('policy-default.response.json'),
      revision: 3,
      source: 'saved',
      order: update.order,
      disabled: update.disabled
    }

    f.request.mockImplementationOnce(async () => ({ status: 200, value: accepted }))
    await f.controller.save(AGENT, update)
    expect(f.controller.snapshot(AGENT)?.deviceNames).toEqual(value.deviceNames)

    const down = controllerFixture(async () => {
      throw new Error('registry refused')
    })

    await expect(down.controller.read(AGENT)).resolves.toMatchObject({ stale: false, policy: { revision: 2 } })
    expect(down.controller.snapshot(AGENT)?.deviceNames).toBeUndefined()
  })

  it('does not ask the registry for names when the policy has no Mac in its order', async () => {
    let scope = { accountKey: 'owner-a', generation: 1 }
    const cloudOnly = { ...fixture<Record<string, unknown>>('policy-default.response.json'), order: ['cloud'], disabled: [] }

    const cloudOnlyStatus = {
      ...fixture<Record<string, unknown>>('status-idle.response.json'),
      desired: 'cloud',
      order: ['cloud'],
      disabled: []
    }

    const request = vi.fn(async (_principal: string, action: 'policy' | 'status') =>
      action === 'policy' ? { status: 200, value: cloudOnly } : { status: 200, value: cloudOnlyStatus }
    )

    const names = vi.fn(async () => ({}))

    const controller = new MatrixExecutionPolicyController({
      scope: () => scope,
      request,
      changed: vi.fn(),
      deviceNames: names
    })

    controller.activate(scope)
    await controller.retain([AGENT])

    expect(names).not.toHaveBeenCalled()
  })

  it('keeps a valid policy when status is malformed, never the malformed status', async () => {
    const f = controllerFixture()
    f.request.mockImplementation(async (_principal, action) => ({
      status: 200,
      value: action === 'policy' ? fixture('policy-saved.response.json') : fixture('status-secret.response.json')
    }))

    const value = await f.controller.read(AGENT)
    expect(value.policy.revision).toBe(2)
    expect(value.status).toBeUndefined()
  })

  it('retains the last valid answer as stale after failure and drops it across accounts', async () => {
    const f = controllerFixture()
    await f.controller.read(AGENT)
    f.advance(6_000)
    f.request.mockRejectedValue(new Error('offline'))

    expect(await f.controller.refresh(AGENT, true)).toMatchObject({ stale: true, policy: { revision: 2 } })
    expect(f.controller.snapshot(AGENT)?.stale).toBe(true)
    f.setScope({ accountKey: 'owner-b', generation: 2 })
    expect(f.controller.snapshot(AGENT)).toBeUndefined()
  })

  it('never regresses a cached policy revision on a late provider read', async () => {
    const f = controllerFixture()
    await f.controller.read(AGENT)
    f.request.mockImplementationOnce(async () => ({
      status: 200,
      value: fixture('policy-default.response.json')
    }))

    await expect(f.controller.refresh(AGENT, true)).resolves.toMatchObject({
      stale: true,
      policy: { revision: 2, source: 'saved' }
    })
  })

  it('accepts an exact newer write, rejects malformed success, and preserves closed conflicts', async () => {
    const log = vi.fn<(line: string) => void>()
    const f = controllerFixture(undefined, log)
    await f.controller.read(AGENT)
    const update = fixture<ExecutionPolicyUpdate>('policy-update.request.json')

    const accepted = {
      ...fixture<Record<string, unknown>>('policy-default.response.json'),
      revision: 3,
      source: 'saved',
      order: update.order,
      disabled: update.disabled
    }

    f.request.mockImplementationOnce(async () => ({ status: 200, value: accepted }))
    await expect(f.controller.save(AGENT, update)).resolves.toEqual({ ok: true, value: accepted })
    expect(f.controller.snapshot(AGENT)?.policy).toEqual(accepted)

    f.request.mockImplementationOnce(async () => ({ status: 200, value: { ...accepted, agentPrincipal: MAC_A } }))
    await expect(f.controller.save(AGENT, { ...update, expectedRevision: 3 })).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_client', details: { reason: 'invalid_response' } }
    })
    expect(f.controller.snapshot(AGENT)?.stale).toBe(true)
    expect(log).toHaveBeenLastCalledWith(
      '[Matrix] execution policy save stage=response status=200 reason=invalid_response'
    )
    f.request.mockImplementationOnce(async () => ({ status: 200, value: accepted }))
    await f.controller.read(AGENT)

    f.request.mockImplementationOnce(async () => ({
      status: 409,
      value: { error: 'matrix_409', details: { reason: 'revision_conflict' }, revision: 4 }
    }))
    await expect(f.controller.save(AGENT, { ...update, expectedRevision: 3 })).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_409', details: { reason: 'revision_conflict' }, revision: 4 }
    })
  })

  it('makes a successful save due at once, so an immediate reread fetches the fresh status', async () => {
    const log = vi.fn<(line: string) => void>()
    const f = controllerFixture(undefined, log)
    await f.controller.read(AGENT)
    const update = fixture<ExecutionPolicyUpdate>('policy-update.request.json')

    const accepted = {
      ...fixture<Record<string, unknown>>('policy-default.response.json'),
      revision: 3,
      source: 'saved',
      order: update.order,
      disabled: update.disabled
    }

    const acceptedStatus = {
      ...fixture<Record<string, unknown>>('status-working.response.json'),
      policyRevision: 3,
      order: update.order,
      disabled: update.disabled
    }

    f.request.mockImplementationOnce(async () => ({ status: 200, value: accepted }))
    await expect(f.controller.save(AGENT, update)).resolves.toEqual({ ok: true, value: accepted })
    expect(log).toHaveBeenLastCalledWith('[Matrix] execution policy save stage=response status=200 reason=accepted')

    // The saved entry has no status; a plain read (no force) must not sit on it for 30 s.
    f.request.mockClear()
    f.request.mockImplementation(async (_principal, action) => {
      if (action === 'policy') {
        return { status: 200, value: accepted }
      }

      if (action === 'status') {
        return { status: 200, value: acceptedStatus }
      }

      throw new Error('unexpected request')
    })

    await expect(f.controller.refresh(AGENT)).resolves.toMatchObject({
      stale: false,
      policy: { revision: 3 },
      status: { policyRevision: 3 }
    })
    expect(f.request.mock.calls.map(([, action]) => action)).toContain('policy')
    expect(f.request.mock.calls.map(([, action]) => action)).toContain('status')
  })

  it('marks an unknown write outcome stale and blocks another write until a strict reread', async () => {
    const f = controllerFixture()
    await f.controller.read(AGENT)
    const update = fixture<ExecutionPolicyUpdate>('policy-update.request.json')
    f.request.mockRejectedValueOnce(new Error('offline'))

    await expect(f.controller.save(AGENT, update)).rejects.toThrow('offline')
    expect(f.controller.snapshot(AGENT)?.stale).toBe(true)
    await expect(f.controller.save(AGENT, update)).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_503', details: { reason: 'unavailable' } }
    })
    await f.controller.read(AGENT)
    expect(f.controller.snapshot(AGENT)?.stale).toBe(false)
  })

  it('rejects a renderer revision that is not the fresh cached revision without a provider write', async () => {
    const log = vi.fn<(line: string) => void>()
    const f = controllerFixture(undefined, log)
    await f.controller.read(AGENT)
    const update = fixture<ExecutionPolicyUpdate>('policy-update.request.json')
    f.request.mockClear()

    await expect(f.controller.save(AGENT, { ...update, expectedRevision: 1 })).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_409', details: { reason: 'revision_conflict' }, revision: 2 }
    })
    expect(f.request).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[Matrix] execution policy save stage=revision status=local reason=revision_conflict'
    )
  })

  it('logs save failures with only closed stage, status, and reason fields', async () => {
    const written: string[] = []
    const f = controllerFixture(undefined, line => written.push(line))
    await f.controller.read(AGENT)
    const update = fixture<ExecutionPolicyUpdate>('policy-update.request.json')

    f.request.mockImplementationOnce(async () => ({
      status: 409,
      value: { error: 'matrix_409', details: { reason: 'request_conflict' } }
    }))
    await expect(f.controller.save(AGENT, update)).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_409', details: { reason: 'request_conflict' } }
    })

    f.request.mockRejectedValueOnce(
      new Error(`PUT https://owner-token@example.test/agents/${AGENT} body=${JSON.stringify(update)}`)
    )
    await expect(f.controller.save(AGENT, update)).rejects.toThrow()
    await expect(f.controller.save(AGENT, update)).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_503', details: { reason: 'unavailable' } }
    })

    expect(written).toEqual([
      '[Matrix] execution policy save stage=response status=409 reason=request_conflict',
      '[Matrix] execution policy save stage=request status=error reason=unavailable',
      '[Matrix] execution policy save stage=cache status=local reason=unavailable'
    ])
    expect(written.join('\n')).not.toContain(AGENT)
    expect(written.join('\n')).not.toContain(update.requestId)
    expect(written.join('\n')).not.toContain('example.test')
    expect(written.join('\n')).not.toContain('owner-token')
    expect(
      written.every(line => /^\[Matrix\] execution policy save stage=\w+ status=(?:\w+|\d{3}) reason=\w+$/u.test(line))
    ).toBe(true)
  })

  it('closes malformed diagnostic status values instead of interpolating them', () => {
    expect(matrixExecutionPolicySaveLogLine({ stage: 'response', status: Number.NaN, reason: 'unavailable' })).toBe(
      '[Matrix] execution policy save stage=response status=invalid reason=unavailable'
    )
  })
})

describe('execution-policy local Mac mode', () => {
  const policy = fixture<any>('policy-saved.response.json')
  const status = fixture<any>('status-working.response.json')

  it('starts only a fresh saved policy that enables this exact Mac', () => {
    expect(matrixExecutionPolicyLocalMode({ policy, status, stale: false }, MAC_A)).toBe('enabled')
    expect(matrixExecutionPolicyLocalMode({ policy: { ...policy, disabled: [] }, stale: false }, MAC_A)).toBe('enabled')
    expect(
      matrixExecutionPolicyLocalMode({ policy: { ...policy, source: 'default', revision: 0 }, stale: false }, MAC_A)
    ).toBe('off')
    expect(matrixExecutionPolicyLocalMode({ policy, stale: true }, MAC_A)).toBe('off')
    expect(matrixExecutionPolicyLocalMode({ policy, stale: false }, '00000000-0000-4000-8000-f1d11edf5c5c')).toBe('off')
  })

  it('starts readiness only when the policy first makes this Mac local', () => {
    expect(matrixExecutionPolicyStartsLocalReadiness(undefined, true)).toBe(true)
    expect(matrixExecutionPolicyStartsLocalReadiness(false, true)).toBe(true)
    expect(matrixExecutionPolicyStartsLocalReadiness(true, true)).toBe(false)
    expect(matrixExecutionPolicyStartsLocalReadiness(true, false)).toBe(false)
    expect(matrixExecutionPolicyStartsLocalReadiness(undefined, false)).toBe(false)
  })

  it('lets the current Mac drain after an owner disable but starts no new disabled term', () => {
    const disabled = { ...policy, disabled: [policy.order[0]] }
    expect(matrixExecutionPolicyLocalMode({ policy: disabled, status, stale: false }, MAC_A)).toBe('draining')
    expect(matrixExecutionPolicyLocalMode({ policy: disabled, stale: false }, MAC_A)).toBe('off')
  })

  it('never turns a legacy lease into saved-policy authority, but drains an exact saved term', () => {
    const disabledCurrent = {
      policy: { ...policy, disabled: [policy.order[0]] },
      status,
      stale: false
    }

    expect(matrixExecutionPolicyKeepsLocalRuntime(undefined, MAC_A, 'held')).toBe(false)
    expect(
      matrixExecutionPolicyKeepsLocalRuntime(
        { policy: { ...policy, source: 'default', revision: 0 }, stale: false },
        MAC_A,
        'held'
      )
    ).toBe(false)
    expect(matrixExecutionPolicyKeepsLocalRuntime({ policy, stale: true }, MAC_A, 'held')).toBe(true)
    expect(matrixExecutionPolicyKeepsLocalRuntime({ policy, stale: true }, MAC_A, 'idle')).toBe(false)
    expect(matrixExecutionPolicyKeepsLocalRuntime(disabledCurrent, MAC_A, 'idle')).toBe(false)
    expect(matrixExecutionPolicyKeepsLocalRuntime(disabledCurrent, MAC_A, 'held')).toBe(true)
    expect(matrixExecutionPolicyListeningAction(disabledCurrent, MAC_A, 'held', false, false)).toBe('drain')
    expect(matrixExecutionPolicyKeepsLocalRuntime({ policy, stale: true }, undefined, 'held')).toBe(false)
    expect(
      matrixExecutionPolicyKeepsLocalRuntime(
        { policy: { ...policy, order: ['cloud'] }, stale: true },
        MAC_A,
        'held'
      )
    ).toBe(false)
    expect(matrixExecutionPolicyHasLocalDestination({ policy, stale: true }, MAC_A)).toBe(true)
  })

  it('arms only the ready exact holder and distinguishes handback from authority loss', () => {
    expect(matrixExecutionPolicyListeningAction({ policy, stale: false }, MAC_A, 'held', true, true)).toBe('arm')
    expect(matrixExecutionPolicyListeningAction({ policy, stale: false }, MAC_A, 'elsewhere', false, true)).toBe(
      'stop'
    )
    expect(matrixExecutionPolicyListeningAction({ policy, stale: true }, MAC_A, 'held', false, false)).toBe('drain')
    expect(matrixExecutionPolicyListeningAction({ policy, stale: false }, MAC_A, 'yielding', false, true)).toBe(
      'drain'
    )
    expect(matrixExecutionPolicyListeningAction({ policy, stale: false }, undefined, 'held', true, true)).toBe(
      'stop'
    )
  })
})

describe('FC D3: a MacBook on battery is out of the failover chain', () => {
  const policy = fixture<any>('policy-saved.response.json')
  const status = fixture<any>('status-working.response.json')
  const view = { policy, stale: false }

  it('starts no term on battery, but a desktop (never on battery) or a MacBook on AC behaves as before', () => {
    expect(matrixExecutionPolicyLocalMode(view, MAC_A, true)).toBe('enabled')
    expect(matrixExecutionPolicyLocalMode(view, MAC_A)).toBe('enabled')
    expect(matrixExecutionPolicyLocalMode(view, MAC_A, false)).toBe('off')
    expect(matrixExecutionPolicyKeepsLocalRuntime(view, MAC_A, 'idle', true)).toBe(true)
    expect(matrixExecutionPolicyKeepsLocalRuntime(view, MAC_A, 'idle', false)).toBe(false)
    expect(matrixExecutionPolicyListeningAction(view, MAC_A, 'held', true, true, true)).toBe('arm')
    expect(matrixExecutionPolicyListeningAction(view, MAC_A, 'held', true, true, false)).toBe('drain')
    expect(matrixExecutionPolicyListeningAction(view, MAC_A, 'idle', false, true, false)).toBe('stop')
  })

  it('lets a reply already running on battery finish, then releases', () => {
    // status-working: this Mac is the current holder and busy.
    expect(status.current).toBe(`mac:${MAC_A}`)
    expect(matrixExecutionPolicyLocalMode({ policy, status, stale: false }, MAC_A, false)).toBe('draining')
    expect(matrixExecutionPolicyKeepsLocalRuntime({ policy, status, stale: false }, MAC_A, 'held', false)).toBe(true)
    // An idle holder is not mid-reply: nothing to finish, so the runtime survives only while the term does.
    expect(matrixExecutionPolicyLocalMode(view, MAC_A, false)).toBe('off')
    expect(matrixExecutionPolicyKeepsLocalRuntime(view, MAC_A, 'idle', false)).toBe(false)
    expect(matrixExecutionPolicyKeepsLocalRuntime(view, MAC_A, 'held', false)).toBe(true)
  })

  it('never attempts a lease on battery: the one place the policy path starts one releases instead', () => {
    const ready = { view, deviceServiceId: MAC_A, competes: true, runtimeReady: true }

    expect(matrixExecutionPolicyLeaseIntent({ ...ready, powerEligible: true })).toBe('start')
    expect(matrixExecutionPolicyLeaseIntent({ ...ready, powerEligible: false })).toBe('unmanaged')
    // 'unmanaged' is not a start: the caller's drain logic only ever releases an idle policy agent.
    expect(matrixExecutionPolicyLeaseIntent({ ...ready, powerEligible: true, runtimeReady: false })).toBe('release')
    expect(matrixExecutionPolicyLeaseIntent({ ...ready, powerEligible: true, competes: false })).toBe('release')
  })
})

describe('the per-agent off switch (0238 atum.matrix_execution_policy_off; Shell route not built yet)', () => {
  const REQUEST = '00000000-0000-4000-8000-e8d95748107a'
  const off = (expectedRevision = 2): ExecutionPolicyOff => ({ requestId: REQUEST, expectedRevision })

  function offFixture(options: { allow?: string | null; status?: number } = {}) {
    let now = 100
    const scope = { accountKey: 'owner-a', generation: 1 }
    const changed = vi.fn()

    const request = vi.fn(async (_principal: string, action: string, _signal: AbortSignal, _body?: unknown) => {
      if (action === 'policy') {
        return { status: 200, value: fixture('policy-saved.response.json') }
      }

      if (action === 'status') {
        return { status: 200, value: fixture('status-working.response.json') }
      }

      if (action === 'capabilities') {
        return { status: options.status ?? 204, value: { allow: options.allow === undefined ? 'GET, HEAD, OPTIONS, PUT, DELETE' : (options.allow ?? '') } }
      }

      throw new Error('unexpected request')
    })

    const controller = new MatrixExecutionPolicyController({
      scope: () => scope,
      request,
      changed,
      now: () => now
    })

    controller.activate(scope)
    controller.retain([AGENT])

    return { controller, request, changed, advance: (ms: number) => (now += ms) }
  }

  const calls = (f: ReturnType<typeof offFixture>, action: string) => f.request.mock.calls.filter(([, each]) => each === action)

  it('asks the fixed route with DELETE and the exact fenced body, and OPTIONS to find out first', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { allow: 'GET, HEAD, OPTIONS, PUT, DELETE' } }))
      .mockResolvedValueOnce(json(fixture('policy-default.response.json')))

    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const resource = 'https://shell.test/api/matrix/v1'

    await expect(requestMatrixExecutionPolicy(resource, 'owner-token', AGENT, 'capabilities', signal)).resolves.toEqual({
      status: 204,
      value: { allow: 'GET, HEAD, OPTIONS, PUT, DELETE' }
    })
    await requestMatrixExecutionPolicy(resource, 'owner-token', AGENT, 'off', signal, off())

    expect(fetchMock.mock.calls[0]![0]).toBe(`${resource}/agents/${AGENT}/execution-policy`)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'OPTIONS', cache: 'no-store', credentials: 'omit', redirect: 'error' })
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('body')
    expect(fetchMock.mock.calls[1]![0]).toBe(`${resource}/agents/${AGENT}/execution-policy`)
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'DELETE', body: JSON.stringify(off()) })
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer owner-token')
    // An off without a body, or a read with one, is never sent.
    await expect(requestMatrixExecutionPolicy(resource, 'owner-token', AGENT, 'off', signal)).rejects.toThrow(
      'matrix_execution_policy_invalid'
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('offers it only when the platform allows DELETE on the policy route, and only for a saved policy', async () => {
    expect((await offFixture().controller.read(AGENT)).off).toBe(true)
    expect((await offFixture({ allow: 'GET, HEAD, OPTIONS, PUT' }).controller.read(AGENT)).off).toBeUndefined()
    expect((await offFixture({ allow: 'GET, OPTIONS, UNDELETE' }).controller.read(AGENT)).off).toBeUndefined()
    expect((await offFixture({ status: 404, allow: null }).controller.read(AGENT)).off).toBeUndefined()
    expect((await offFixture({ status: 405, allow: 'GET, PUT, DELETE' }).controller.read(AGENT)).off).toBeUndefined()

    // A default policy has nothing saved to turn off, so the platform is not even asked.
    const request = vi.fn(async (_principal: string, action: string, _signal: AbortSignal, _body?: unknown) =>
      action === 'policy'
        ? { status: 200, value: fixture('policy-default.response.json') }
        : action === 'status'
          ? { status: 200, value: fixture('status-idle.response.json') }
          : { status: 204, value: { allow: 'DELETE' } }
    )

    const none = new MatrixExecutionPolicyController({ scope: () => ({ accountKey: 'owner-a', generation: 1 }), request, changed: vi.fn() })
    await none.retain([AGENT])
    expect((await none.read(AGENT)).off).toBeUndefined()
    expect(request.mock.calls.filter(([, action]) => action === 'capabilities')).toHaveLength(0)
  })

  it('asks the platform once, remembers a missing route briefly and an unreachable one not at all', async () => {
    const f = offFixture({ status: 404, allow: null })
    await f.controller.read(AGENT)
    await f.controller.refresh(AGENT, true)
    expect(calls(f, 'capabilities')).toHaveLength(1)

    // The platform ships the route: found after the window, with no restart.
    f.advance(11 * 60_000)
    f.request.mockImplementation(async (_principal, action) =>
      action === 'capabilities'
        ? { status: 204, value: { allow: 'DELETE, GET' } }
        : action === 'policy'
          ? { status: 200, value: fixture('policy-saved.response.json') }
          : { status: 200, value: fixture('status-working.response.json') }
    )
    expect((await f.controller.refresh(AGENT, true))?.off).toBe(true)

    const down = offFixture()
    down.request.mockImplementation(async (_principal, action) => {
      if (action === 'capabilities') {
        throw new Error('offline')
      }

      return action === 'policy'
        ? { status: 200, value: fixture('policy-saved.response.json') }
        : { status: 200, value: fixture('status-working.response.json') }
    })
    expect((await down.controller.read(AGENT)).off).toBeUndefined()
    await down.controller.refresh(AGENT, true)
    expect(calls(down, 'capabilities')).toHaveLength(2)
  })

  it('stops offering it within ten minutes of the platform taking the route away (a rolled-back Shell)', async () => {
    const f = offFixture()
    expect((await f.controller.read(AGENT)).off).toBe(true)

    // Within the window the answer is believed, and the platform is not asked again.
    f.advance(9 * 60_000)
    expect((await f.controller.refresh(AGENT, true))?.off).toBe(true)
    expect(calls(f, 'capabilities')).toHaveLength(1)

    // The Shell is rolled back to a build without DELETE: the control must not outlive the window.
    f.request.mockImplementation(async (_principal, action) =>
      action === 'capabilities'
        ? { status: 204, value: { allow: 'GET, HEAD, OPTIONS, PUT' } }
        : action === 'policy'
          ? { status: 200, value: fixture('policy-saved.response.json') }
          : { status: 200, value: fixture('status-working.response.json') }
    )
    f.advance(2 * 60_000)
    expect((await f.controller.refresh(AGENT, true))?.off).toBeUndefined()
    expect(calls(f, 'capabilities')).toHaveLength(2)
  })

  it('replaces the saved policy with the default one the platform answers, then reads it without regressing', async () => {
    const f = offFixture()
    await f.controller.read(AGENT)
    const defaultPolicy = fixture('policy-default.response.json')
    f.request.mockImplementationOnce(async () => ({ status: 200, value: defaultPolicy }))

    await expect(f.controller.turnOff(AGENT, off())).resolves.toEqual({ ok: true, value: defaultPolicy })
    expect(f.request).toHaveBeenLastCalledWith(AGENT, 'off', expect.any(AbortSignal), off())
    expect(f.controller.snapshot(AGENT)).toEqual({ policy: defaultPolicy, stale: false, off: true })

    // The next read is the default policy again: revision 0 now follows revision 0.
    f.request.mockImplementation(async (_principal, action) =>
      action === 'policy'
        ? { status: 200, value: defaultPolicy }
        : { status: 200, value: fixture('status-idle.response.json') }
    )
    await expect(f.controller.refresh(AGENT, true)).resolves.toMatchObject({ stale: false, policy: { source: 'default', revision: 0 } })
  })

  it('makes no request unless the cached policy is fresh, saved, switchable and at the revision named', async () => {
    const f = offFixture({ allow: 'GET, PUT' })
    await f.controller.read(AGENT)
    f.request.mockClear()

    await expect(f.controller.turnOff(AGENT, off())).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_400', details: { reason: 'invalid' } }
    })

    const g = offFixture()
    await g.controller.read(AGENT)
    g.request.mockClear()
    await expect(g.controller.turnOff(AGENT, off(1))).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_409', details: { reason: 'revision_conflict' }, revision: 2 }
    })
    await expect(g.controller.turnOff(AGENT, { requestId: 'nope', expectedRevision: 2 })).resolves.toMatchObject({ ok: false })
    await expect(g.controller.turnOff(AGENT, { ...off(), extra: 1 })).resolves.toMatchObject({ ok: false })
    expect(g.request).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
  })

  it('keeps a busy refusal as it was, but treats a conflict, a malformed answer or an unknown outcome as unreliable', async () => {
    const busy = offFixture()
    await busy.controller.read(AGENT)
    busy.request.mockImplementationOnce(async () => ({
      status: 409,
      value: { error: 'matrix_409', details: { reason: 'queue_busy' } }
    }))
    await expect(busy.controller.turnOff(AGENT, off())).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_409', details: { reason: 'queue_busy' } }
    })
    expect(busy.controller.snapshot(AGENT)?.stale).toBe(false)
    expect(busy.controller.snapshot(AGENT)?.policy.source).toBe('saved')

    const conflict = offFixture()
    await conflict.controller.read(AGENT)
    conflict.request.mockImplementationOnce(async () => ({
      status: 409,
      value: { error: 'matrix_409', details: { reason: 'revision_conflict' }, revision: 3 }
    }))
    await expect(conflict.controller.turnOff(AGENT, off())).resolves.toMatchObject({ ok: false })
    expect(conflict.controller.snapshot(AGENT)?.stale).toBe(true)

    const wrong = offFixture()
    await wrong.controller.read(AGENT)
    // A saved policy, or someone else's, is not the answer to an off.
    wrong.request.mockImplementationOnce(async () => ({ status: 200, value: fixture('policy-saved.response.json') }))
    await expect(wrong.controller.turnOff(AGENT, off())).resolves.toEqual({
      ok: false,
      error: { error: 'matrix_client', details: { reason: 'invalid_response' } }
    })
    expect(wrong.controller.snapshot(AGENT)?.stale).toBe(true)

    const unknown = offFixture()
    await unknown.controller.read(AGENT)
    unknown.request.mockRejectedValueOnce(new Error('offline'))
    await expect(unknown.controller.turnOff(AGENT, off())).rejects.toThrow('offline')
    expect(unknown.controller.snapshot(AGENT)?.stale).toBe(true)
  })

  it('forgets a cached saved policy when the roster shows another device turned it off, so the default is read', async () => {
    const f = offFixture()
    await f.controller.read(AGENT)
    const defaultPolicy = fixture('policy-default.response.json')
    f.request.mockImplementation(async (_principal, action) =>
      action === 'policy'
        ? { status: 200, value: defaultPolicy }
        : { status: 200, value: fixture('status-idle.response.json') }
    )

    // Without the reset the strict revision rule keeps rejecting the default as a regression.
    f.advance(60_000)
    await expect(f.controller.refresh(AGENT)).resolves.toMatchObject({ stale: true, policy: { source: 'saved' } })

    f.controller.reset(AGENT)
    expect(f.controller.snapshot(AGENT)).toBeUndefined()
    await expect(f.controller.refresh(AGENT, true)).resolves.toMatchObject({ stale: false, policy: { source: 'default', revision: 0 } })
  })
})
