import { describe, expect, it } from 'vitest'

import { type MatrixLocalBrain, type MatrixLocalBrainOwner } from '../local-brain'

import { awarenessLocalTransport, type AwarenessLocalTransportOptions } from './local-transport'
import type { AwarenessCoverage, AwarenessEnvelope, AwarenessTransport, AwarenessWithdrawal } from './types'

const ACCOUNT_A = 'a'.repeat(64)
const ACCOUNT_B = 'b'.repeat(64)

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

interface BrainCall {
  owner: MatrixLocalBrainOwner
  method: string
  params: unknown
}

type Invoke = (transport: AwarenessTransport, signal: AbortSignal) => Promise<unknown>

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

function owner(accountKey = ACCOUNT_A, generation = 1): MatrixLocalBrainOwner {
  return { accountKey, generation }
}

function sameOwner(left: MatrixLocalBrainOwner, right: MatrixLocalBrainOwner | null): boolean {
  return Boolean(
    right && left.accountKey.toLowerCase() === right.accountKey.toLowerCase() && left.generation === right.generation
  )
}

function fixture() {
  let current: MatrixLocalBrainOwner | null = owner()
  let available = true
  const calls: BrainCall[] = []
  const stops: MatrixLocalBrainOwner[] = []
  const replies: Array<(call: BrainCall) => Promise<unknown> | unknown> = []

  const brain: Pick<MatrixLocalBrain, 'ready' | 'call' | 'stop'> = {
    ready: bound => available && sameOwner(bound, current),
    call: (bound, method, params) => {
      const call = { owner: { ...bound }, method, params }
      calls.push(call)
      const reply = replies.shift()

      return reply ? Promise.resolve(reply(call)) : Promise.reject(new Error('unexpected_provider_call'))
    },
    stop: async () => {
      if (current) {
        stops.push({ ...current })
      }

      available = false
    }
  }

  const options = (overrides: Partial<AwarenessLocalTransportOptions> = {}): AwarenessLocalTransportOptions => ({
    destination: 'local',
    brain,
    owner: owner(),
    current: () => current,
    ...overrides
  })

  return {
    brain,
    calls,
    options,
    replies,
    stops,
    setAvailable(value: boolean) {
      available = value
    },
    setCurrent(value: MatrixLocalBrainOwner | null) {
      current = value
    }
  }
}

function envelope(): AwarenessEnvelope {
  return {
    contract: 'atum.awareness/1',
    operationId: 'operation-1',
    source: { kind: 'human_dm', id: '!room:test' },
    object: { kind: 'message', id: '$event', revision: 1 },
    author: { kind: 'human', id: '@person:test' },
    eventTime: 100,
    observedTime: 101,
    content: { text: 'private text', attachments: [] },
    policy: { epoch: 1, visibility: 'joined', googleDerived: false, accountFence: true },
    digest: 'digest'
  }
}

function withdrawal(): AwarenessWithdrawal {
  return {
    operationId: 'operation-2',
    withdrawalId: 'withdrawal-1',
    scope: { kind: 'fact', evidenceId: 'evidence-1' },
    requestedAt: 102,
    reason: 'forget'
  }
}

function coverage(): { entries: AwarenessCoverage[] } {
  return {
    entries: [{
      source: { kind: 'human_dm', id: '!room:test' },
      state: 'ready',
      reasons: [],
      asOf: 103,
      backfill: { priorityWindowDays: 30, complete: true }
    }]
  }
}

const invocations: readonly [string, Invoke][] = [
  ['prepare', (transport, signal) => transport.prepare(signal)],
  ['ingest', (transport, signal) => transport.ingest(envelope(), signal)],
  ['withdraw', (transport, signal) => transport.withdraw(withdrawal(), signal)],
  ['fence', (transport, signal) => transport.fence({ v: 1, since: 99 }, signal)],
  ['coverage', (transport, signal) => transport.coverage(coverage(), signal)]
]

describe('awarenessLocalTransport', () => {
  it('exposes only the bounded awareness port and dispatches every frozen mapping', async () => {
    const f = fixture()
    f.replies.push(
      () => ({ contract: 'atum.awareness/1', status: 'ready' }),
      () => ({ accepted: true }),
      () => ({ recorded: true }),
      () => ({ fenced: true }),
      () => ({ ignored: 'coverage receipt is not exposed' })
    )
    const transport = awarenessLocalTransport(f.options())
    const signal = new AbortController().signal

    await expect(transport.prepare(signal)).resolves.toBeUndefined()
    await expect(transport.ingest(envelope(), signal)).resolves.toEqual({ accepted: true })
    await expect(transport.withdraw(withdrawal(), signal)).resolves.toEqual({ recorded: true })
    await expect(transport.fence({ v: 1, since: 99 }, signal)).resolves.toEqual({ fenced: true })
    await expect(transport.coverage(coverage(), signal)).resolves.toBeUndefined()

    expect(f.calls.map(call => [call.method, call.params])).toEqual([
      ['brain.info', undefined],
      ['brain.ingest', envelope()],
      ['brain.withdraw', withdrawal()],
      ['brain.fence', { v: 1, since: 99 }],
      ['brain.reportCoverage', coverage()]
    ])
    expect(transport).not.toHaveProperty('call')
    expect(transport).not.toHaveProperty('retrieve')
    expect(transport).not.toHaveProperty('credentials')
  })

  it('rejects a non-local destination before creating an adapter', () => {
    const f = fixture()

    expect(() => awarenessLocalTransport(f.options({ destination: 'managed' as never }))).toThrow(
      'awareness_local_transport_invalid'
    )
    expect(f.calls).toEqual([])
    expect(f.stops).toEqual([])
  })

  it('captures the owner so later caller mutation cannot retarget dispatch', async () => {
    const f = fixture()
    const supplied = owner()
    f.setCurrent(owner())
    f.replies.push(() => ({ accepted: true }))
    const transport = awarenessLocalTransport(f.options({ owner: supplied }))
    supplied.accountKey = ACCOUNT_B
    supplied.generation = 2

    await expect(transport.ingest(envelope(), new AbortController().signal)).resolves.toEqual({ accepted: true })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.owner).toEqual(owner())
  })

  it.each(['captured', 'current'])('normalizes the %s account key consistently with native custody', async which => {
    const f = fixture()
    f.setCurrent(owner(which === 'current' ? ACCOUNT_A.toUpperCase() : ACCOUNT_A))
    const transport = awarenessLocalTransport(f.options({ owner: owner(which === 'captured' ? ACCOUNT_A.toUpperCase() : ACCOUNT_A) }))
    f.replies.push(() => ({ contract: 'atum.awareness/1', status: 'ready' }))

    await expect(transport.prepare(new AbortController().signal)).resolves.toBeUndefined()
    expect(f.calls[0]?.owner).toEqual(owner())
  })

  it('accepts the native supervisor\'s zero generation without changing custody', async () => {
    const f = fixture()
    f.setCurrent(owner(ACCOUNT_A, 0))
    const transport = awarenessLocalTransport(f.options({ owner: owner(ACCOUNT_A, 0) }))
    f.replies.push(() => ({ contract: 'atum.awareness/1', status: 'ready' }))

    await expect(transport.prepare(new AbortController().signal)).resolves.toBeUndefined()
    expect(f.calls[0]?.owner).toEqual(owner(ACCOUNT_A, 0))
  })

  it('settles unknown outcomes when native readiness lookup throws without guessing a stop target', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    let fail = false

    const transport = awarenessLocalTransport(f.options({ brain: { ...f.brain, ready: bound => {
      if (fail) { throw new Error('native private detail') }

      return f.brain.ready(bound)
    } } }))

    f.replies.push(() => pending.promise)
    const operation = transport.prepare(new AbortController().signal)
    fail = true
    pending.resolve({ contract: 'atum.awareness/1', status: 'ready' })

    await expect(operation).rejects.toThrow('awareness_local_transport_outcome_unknown')
    expect(f.stops).toEqual([])
    fail = false
    await expect(transport.prepare(new AbortController().signal)).rejects.toThrow('awareness_local_transport_unavailable')
  })

  it('closes admission lookup failures without exposing native details or dispatching', async () => {
    const f = fixture()
    const transport = awarenessLocalTransport(f.options({ current: () => { throw new Error('native private detail') } }))

    await expect(transport.prepare(new AbortController().signal)).rejects.toThrow('awareness_local_transport_unavailable')
    expect(f.calls).toEqual([])
    expect(f.stops).toEqual([])
  })

  it('retires a reply when admission lookup fails after dispatch', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    let fail = false

    const transport = awarenessLocalTransport(f.options({ current: () => {
      if (fail) { throw new Error('native private detail') }

      return owner()
    } }))

    f.replies.push(() => pending.promise)
    const operation = transport.prepare(new AbortController().signal)
    fail = true
    pending.resolve({ contract: 'atum.awareness/1', status: 'ready' })

    await expect(operation).rejects.toThrow('awareness_local_transport_outcome_unknown')
    expect(f.stops).toEqual([owner()])
  })

  it('does not dispatch when cancellation occurs during the admission lookup', async () => {
    const f = fixture()
    const controller = new AbortController()

    const transport = awarenessLocalTransport(f.options({ current: () => {
      controller.abort()

      return owner()
    } }))

    await expect(transport.prepare(controller.signal)).rejects.toThrow('awareness_local_transport_aborted')
    expect(f.calls).toEqual([])
    expect(f.stops).toEqual([])
  })

  it.each(invocations)('%s refuses stale or unavailable custody before provider dispatch', async (_name, invoke) => {
    const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
      f => f.setCurrent(owner(ACCOUNT_B)),
      f => f.setCurrent(owner(ACCOUNT_A, 2)),
      f => f.setCurrent(null),
      f => f.setAvailable(false)
    ]

    for (const configure of cases) {
      const f = fixture()
      const transport = awarenessLocalTransport(f.options())
      configure(f)

      await expect(invoke(transport, new AbortController().signal)).rejects.toThrow('awareness_local_transport_unavailable')
      expect(f.calls).toEqual([])
      expect(f.stops).toEqual([])
    }
  })

  it.each(invocations)('%s refuses a pre-aborted signal without provider work', async (_name, invoke) => {
    const f = fixture()
    const transport = awarenessLocalTransport(f.options())
    const controller = new AbortController()
    controller.abort()

    await expect(invoke(transport, controller.signal)).rejects.toThrow('awareness_local_transport_aborted')
    expect(f.calls).toEqual([])
    expect(f.stops).toEqual([])
  })

  it('retires an aborted in-flight call, stops only its ready provider, and ignores its late result', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    f.replies.push(() => pending.promise)
    const transport = awarenessLocalTransport(f.options())
    const controller = new AbortController()
    const operation = transport.ingest(envelope(), controller.signal)

    expect(f.calls).toHaveLength(1)
    controller.abort()
    await expect(operation).rejects.toThrow('awareness_local_transport_outcome_unknown')
    expect(f.stops).toEqual([owner()])

    pending.resolve({ accepted: true })
    await Promise.resolve()
    await expect(transport.ingest(envelope(), new AbortController().signal)).rejects.toThrow(
      'awareness_local_transport_unavailable'
    )
    expect(f.calls).toHaveLength(1)
  })

  it('removes the abort listener after a normal completion and leaves the provider running', async () => {
    const f = fixture()
    f.replies.push(() => ({ accepted: true }))
    const transport = awarenessLocalTransport(f.options())
    const controller = new AbortController()

    await expect(transport.ingest(envelope(), controller.signal)).resolves.toEqual({ accepted: true })
    controller.abort()
    await Promise.resolve()

    expect(f.stops).toEqual([])
    f.replies.push(() => ({ recorded: true }))
    await expect(transport.withdraw(withdrawal(), new AbortController().signal)).resolves.toEqual({ recorded: true })
  })

  it('retires a stale late reply without stopping a newer owner', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    f.replies.push(() => pending.promise)
    const transport = awarenessLocalTransport(f.options())
    const operation = transport.prepare(new AbortController().signal)

    f.setCurrent(owner(ACCOUNT_B, 2))
    pending.resolve({ contract: 'atum.awareness/1', status: 'ready' })

    await expect(operation).rejects.toThrow('awareness_local_transport_outcome_unknown')
    expect(f.stops).toEqual([])
    await expect(transport.prepare(new AbortController().signal)).rejects.toThrow('awareness_local_transport_unavailable')
  })

  it('redacts a dispatched provider failure, retires the adapter, and stops its ready owner', async () => {
    const f = fixture()
    f.replies.push(() => Promise.reject(new Error('provider detail must not escape')))
    const transport = awarenessLocalTransport(f.options())

    await expect(transport.fence({ v: 1, since: 99 }, new AbortController().signal)).rejects.toThrow(
      'awareness_local_transport_outcome_unknown'
    )
    expect(f.stops).toEqual([owner()])
    await expect(transport.fence({ v: 1, since: 99 }, new AbortController().signal)).rejects.toThrow(
      'awareness_local_transport_unavailable'
    )
  })

  it('rejects and retires a malformed prepare receipt', async () => {
    const f = fixture()
    f.replies.push(() => ({ contract: 'atum.awareness/2', status: 'ready' }))
    const transport = awarenessLocalTransport(f.options())

    await expect(transport.prepare(new AbortController().signal)).rejects.toThrow('awareness_local_transport_invalid')
    expect(f.stops).toEqual([owner()])
    await expect(transport.prepare(new AbortController().signal)).rejects.toThrow('awareness_local_transport_unavailable')
  })
})
