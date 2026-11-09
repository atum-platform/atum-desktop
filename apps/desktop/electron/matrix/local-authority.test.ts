import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { EncryptedStore } from '../encrypted-store'

import { LOCAL_TURN_LIMIT_MS, localInvocationRecords } from './local-authority'

function fixture(start = 1_000_000) {
  const entries = new Map<string, string>()
  let now = start

  const store = {
    getItem: (key: string) => entries.get(key) ?? null,
    failureCode: () => null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    assertEncryptionAvailable: () => {}
  } as unknown as EncryptedStore

  const agent = { principal: randomUUID(), agentPrincipal: randomUUID(), deviceId: 'AGENT' }
  const records = localInvocationRecords(store, agent, () => now)
  const authorize = (input: Record<string, unknown>) => records.authorize(input, true)

  const binding = {
    roomId: '!room:test',
    eventId: '$event',
    requestHash: 'a'.repeat(64),
    senderDevice: 'HUMAN',
    executorId: randomUUID()
  }

  return {
    authorize,
    records,
    agent,
    binding,
    entries,
    advance: (ms: number) => void (now += ms),
    call: (operation: string, extra: Record<string, unknown> = {}) =>
      authorize({ ...binding, operation, ...extra }) as Promise<Record<string, unknown>>
  }
}

describe('local invocation authority', () => {
  it('returns grants in the platform shape and moves claim → dispatch → complete → published', async () => {
    const f = fixture()
    const claimed = await f.call('claim')
    expect(claimed).toMatchObject({
      ...f.binding,
      owner: f.agent.principal,
      payer: f.agent.principal,
      capability: 'local-hermes-turn',
      agentPrincipal: f.agent.agentPrincipal,
      agentDevice: 'AGENT',
      state: 'claimed',
      expiresAt: 1_000_000 + LOCAL_TURN_LIMIT_MS
    })
    const fence = claimed.invocationId
    expect(await f.call('claim')).toMatchObject({ invocationId: fence, state: 'claimed' })
    expect(await f.call('dispatch', { invocationId: fence })).toMatchObject({ state: 'dispatched' })
    const completed = await f.call('complete', { invocationId: fence })
    expect(completed).toMatchObject({ state: 'completed' })
    expect(completed.transactionId).toMatch(/^[\da-f-]{36}$/)
    expect(await f.call('complete', { invocationId: fence })).toMatchObject({ transactionId: completed.transactionId })
    expect(await f.call('published', { invocationId: fence, publishedEvent: '$reply' })).toMatchObject({
      publishedEvent: '$reply'
    })
    // A later claim reports the finished record; it never restarts it.
    expect(await f.call('claim')).toMatchObject({ invocationId: fence, state: 'completed', publishedEvent: '$reply' })
  })

  it('dispatches once, refuses stale fences and mismatched requests, and pins the published event', async () => {
    const f = fixture()
    const fence = (await f.call('claim')).invocationId
    await expect(f.call('dispatch', { invocationId: randomUUID() })).rejects.toThrow('matrix_denied')
    await f.call('dispatch', { invocationId: fence })
    await expect(f.call('dispatch', { invocationId: fence })).rejects.toThrow('matrix_denied')
    await expect(f.authorize({ ...f.binding, requestHash: 'b'.repeat(64), operation: 'claim' })).rejects.toThrow(
      'matrix_denied'
    )
    await expect(f.call('published', { invocationId: fence, publishedEvent: '$reply' })).rejects.toThrow('matrix_denied')
    await f.call('complete', { invocationId: fence })
    await f.call('published', { invocationId: fence, publishedEvent: '$reply' })
    await expect(f.call('published', { invocationId: fence, publishedEvent: '$other' })).rejects.toThrow('matrix_denied')
  })

  it('renews a lapsed, never-dispatched claim with a new fence, but never a lapsed dispatch', async () => {
    const f = fixture()
    const first = (await f.call('claim')).invocationId
    f.advance(LOCAL_TURN_LIMIT_MS + 1)
    await expect(f.call('dispatch', { invocationId: first })).rejects.toThrow('matrix_denied')
    const second = (await f.call('claim')).invocationId
    expect(second).not.toBe(first)
    await f.call('dispatch', { invocationId: second })
    f.advance(LOCAL_TURN_LIMIT_MS + 1)
    expect(await f.call('claim')).toMatchObject({ invocationId: second, state: 'dispatched' })
  })

  it('remembers which authority answers for each message', async () => {
    const f = fixture()
    expect(f.records.route(f.binding.roomId, f.binding.eventId)).toBeNull()
    await f.call('claim')
    expect(f.records.route(f.binding.roomId, f.binding.eventId)).toBe('local')
    f.records.markPlatform(f.binding.roomId, '$other')
    expect(f.records.route(f.binding.roomId, '$other')).toBe('platform')
    expect(f.records.route('!another:test', f.binding.eventId)).toBeNull()
  })

  it('starts a turn only under the lease, but finishes one that already ran without it', async () => {
    const f = fixture()

    const unleased = (operation: string, extra: Record<string, unknown> = {}) =>
      f.records.authorize({ ...f.binding, operation, ...extra }, false) as Promise<Record<string, unknown>>

    await expect(unleased('claim')).rejects.toThrow('matrix_lease_required')
    expect(f.entries.size).toBe(0)
    const fence = (await f.call('claim')).invocationId
    await expect(unleased('claim')).rejects.toThrow('matrix_lease_required')
    await expect(unleased('dispatch', { invocationId: fence })).rejects.toThrow('matrix_lease_required')
    await f.call('dispatch', { invocationId: fence })
    expect(await unleased('claim')).toMatchObject({ invocationId: fence, state: 'dispatched' })
    expect(await unleased('complete', { invocationId: fence })).toMatchObject({ state: 'completed' })
    expect(await unleased('published', { invocationId: fence, publishedEvent: '$reply' })).toMatchObject({
      publishedEvent: '$reply'
    })
  })

  it('refuses unexpected fields and malformed bindings before touching the record', async () => {
    const f = fixture()
    await expect(f.call('claim', { owner: f.agent.principal })).rejects.toThrow('matrix_invalid')
    await expect(f.authorize({ ...f.binding, roomId: 'room', operation: 'claim' })).rejects.toThrow('matrix_invalid')
    await expect(f.call('recover')).rejects.toThrow('matrix_invalid')
    expect(f.entries.size).toBe(0)
  })

  describe('queueing a dispatched run again (R3)', () => {
    it('moves dispatched back to claimed under a new fence, with what the earlier run is known to have done', async () => {
      const f = fixture()
      const first = (await f.call('claim')).invocationId
      await f.call('dispatch', { invocationId: first })

      const queued = await f.call('requeue', { invocationId: first, effect: 'side_effect_possible', tools: ['terminal'] })
      expect(queued).toMatchObject({
        state: 'claimed',
        resume: { attempt: 1, effect: 'side_effect_possible', tools: ['terminal'] }
      })
      expect(queued.invocationId).not.toBe(first)

      // The run that ended can never finish it: its fence is spent.
      await expect(f.call('complete', { invocationId: first })).rejects.toThrow('matrix_denied')
      await expect(f.call('dispatch', { invocationId: first })).rejects.toThrow('matrix_denied')

      // The next claim takes it at once (the claim was lapsed) with a fresh fence and the same facts.
      const again = await f.call('claim')
      expect(again).toMatchObject({ state: 'claimed', resume: { attempt: 1, effect: 'side_effect_possible' } })
      expect(again.invocationId).not.toBe(queued.invocationId)
      expect(again.expiresAt).toBe(1_000_000 + LOCAL_TURN_LIMIT_MS)
      expect(await f.call('dispatch', { invocationId: again.invocationId })).toMatchObject({ state: 'dispatched' })
    })

    it('counts the reruns and refuses a third', async () => {
      const f = fixture()
      let fence = (await f.call('claim')).invocationId

      for (const attempt of [1, 2]) {
        await f.call('dispatch', { invocationId: fence })
        const queued = await f.call('requeue', { invocationId: fence, effect: 'read_only', tools: [] })
        expect(queued).toMatchObject({ resume: { attempt } })
        fence = (await f.call('claim')).invocationId
      }

      await f.call('dispatch', { invocationId: fence })
      await expect(f.call('requeue', { invocationId: fence, effect: 'read_only', tools: [] })).rejects.toThrow(
        'matrix_denied'
      )
    })

    it('only queues a dispatched record, with a known effect, on the right fence', async () => {
      const f = fixture()
      const fence = (await f.call('claim')).invocationId
      // Not dispatched yet: there is nothing to queue.
      await expect(f.call('requeue', { invocationId: fence, effect: 'none', tools: [] })).rejects.toThrow('matrix_denied')
      await f.call('dispatch', { invocationId: fence })
      await expect(f.call('requeue', { invocationId: randomUUID(), effect: 'none', tools: [] })).rejects.toThrow(
        'matrix_denied'
      )
      await expect(f.call('requeue', { invocationId: fence, effect: 'unknown', tools: [] })).rejects.toThrow(
        'matrix_denied'
      )
      await expect(f.call('requeue', { invocationId: fence })).rejects.toThrow('matrix_denied')
      // A completed record is finished, never queued again.
      await f.call('complete', { invocationId: fence })
      await expect(f.call('requeue', { invocationId: fence, effect: 'none', tools: [] })).rejects.toThrow('matrix_denied')
    })

    it('needs no lease to be queued, and still needs one to be started again', async () => {
      const f = fixture()
      const fence = (await f.call('claim')).invocationId
      await f.call('dispatch', { invocationId: fence })

      // The lease was lost with the run: queueing is allowed, starting is not.
      const queued = await f.records.authorize(
        { ...f.binding, operation: 'requeue', invocationId: fence, effect: 'none', tools: [] },
        false
      )

      expect(queued).toMatchObject({ state: 'claimed' })

      await expect(f.records.authorize({ ...f.binding, operation: 'claim' }, false)).rejects.toThrow(
        'matrix_lease_required'
      )
    })

    it('keeps only well-formed tool names', async () => {
      const f = fixture()
      const fence = (await f.call('claim')).invocationId
      await f.call('dispatch', { invocationId: fence })

      const queued = await f.call('requeue', {
        invocationId: fence,
        effect: 'side_effect_possible',
        tools: ['terminal', 'bad name', 7, 'x'.repeat(100)]
      })

      expect(queued).toMatchObject({ resume: { tools: ['terminal'] } })
    })
  })
})
