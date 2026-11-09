import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { awarenessEvidenceId, AwarenessReader } from './reader'
import type { AwarenessReaderOptions } from './reader'
import type {
  AwarenessEnvelope,
  AwarenessRevision,
  AwarenessSource,
  AwarenessStore,
  AwarenessTransport,
  AwarenessWithdrawal
} from './types'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/contract-inputs.json', import.meta.url), 'utf8'))
const vector = fixtures.vectors['envelope-human-group-message.managed.json'] as AwarenessEnvelope
const source: AwarenessSource = vector.source
const other: AwarenessSource = { kind: 'human_dm', id: '!other:test' }
const drive: AwarenessSource = { kind: 'drive_file', id: 'drive/file' }

const revision: AwarenessRevision = {
  source,
  object: vector.object,
  author: vector.author,
  eventTime: vector.eventTime,
  content: vector.content
}

const instant = vector.observedTime
const suppressionId = '00000000-0000-4000-8000-d63d65f98f72'

function memory() {
  let value: unknown = null

  const store: AwarenessStore = {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async next => {
      value = structuredClone(next)
    })
  }

  return {
    store,
    value: () => structuredClone(value),
    replace: (next: unknown) => {
      value = next
    }
  }
}

function accepted(envelope: AwarenessEnvelope, state = 'accepted') {
  const { replaces: _replaces, ...object } = envelope.object

  return {
    operationId: envelope.operationId,
    source: envelope.source,
    object,
    state,
    acceptedRevision: object.revision
  }
}

function recorded(request: AwarenessWithdrawal) {
  return {
    withdrawalId: request.withdrawalId,
    state: 'recorded',
    recordedAt: instant,
    purgeBy: instant + 86_400_000,
    suppressionIds: [suppressionId]
  }
}

async function setup(input: Partial<AwarenessReaderOptions> = {}, storage = memory()) {
  const state = { active: true, keysAvailable: true, readable: true, live: true }

  const transport = {
    prepare: vi.fn(async () => {}),
    ingest: vi.fn<AwarenessTransport['ingest']>(async envelope => accepted(envelope)),
    withdraw: vi.fn(async (request: AwarenessWithdrawal) => recorded(request)),
    fence: vi.fn(async (notice: { since: number }) => ({ active: true, since: notice.since })),
    coverage: vi.fn<AwarenessTransport['coverage']>(async () => {})
  } satisfies AwarenessTransport

  const options: AwarenessReaderOptions = {
    binding: 'opaque-account/device',
    destination: 'managed',
    create: true,
    store: storage.store,
    transport,
    live: () => state.live,
    now: () => instant,
    readAccess: () => ({ ...state, visibility: 'shared', readable: () => state.readable }),
    ...input
  }

  const reader = await AwarenessReader.open(options)
  await reader.register(source)

  return { reader, transport, storage, options, state }
}

const batch = (value = revision, through = instant) => ({
  source: value.source,
  revisions: [value],
  after: null,
  through,
  complete: true
})

const deferred = () => {
  let resolve!: () => void

  const promise = new Promise<void>(done => {
    resolve = done
  })

  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

describe('AW receipt/control reader', () => {
  it('never closes a source scan while an object withdrawal remains unknown',async()=>{
    const f=await setup()
    await f.reader.ingest(batch())
    f.transport.withdraw.mockRejectedValue(Error('unknown deletion'))
    expect(await f.reader.withdraw({kind:'object',source,objectId:revision.object.id},'delete')).toBe(false)
    const coverage=await f.reader.finishScan(source,{through:instant+1,complete:true})
    expect(coverage).toMatchObject({state:'offline',processedThrough:instant,backfill:{complete:false}})
  })
  it('emits a canonical envelope with owner-bound ports and a receipt-backed scan watermark', async () => {
    const f = await setup()
    const coverage = await f.reader.ingest(batch())
    expect(f.transport.ingest).toHaveBeenCalledTimes(1)
    const envelope = f.transport.ingest.mock.calls[0][0]
    expect(envelope).toMatchObject({
      ...vector,
      operationId: expect.any(String),
      policy: { ...vector.policy, epoch: 1 }
    })
    expect(Object.keys(envelope)).not.toContain('owner')
    expect(coverage).toMatchObject({
      state: 'ready',
      reasons: [],
      processedThrough: instant,
      backfill: { priorityWindowDays: 30, complete: true }
    })
    expect(JSON.stringify(f.storage.value())).not.toContain(vector.content.text)
  })

  it('lost receipt/restart rereads the same object and retries the same operation, digest and observation', async () => {
    const f = await setup()
    f.transport.ingest.mockRejectedValueOnce(new Error('lost ack'))
    expect(await f.reader.ingest(batch())).toMatchObject({ state: 'offline' })
    expect(f.reader.coverage(source).processedThrough).toBeUndefined()
    const first = f.transport.ingest.mock.calls[0][0]
    const restarted = await AwarenessReader.open(f.options)
    expect(restarted.replayHint(source)).toEqual(revision.object)
    f.transport.ingest.mockImplementation(async envelope => accepted(envelope, 'duplicate'))
    expect(await restarted.ingest(batch())).toMatchObject({ state: 'ready', processedThrough: instant })
    expect(f.transport.ingest.mock.calls[1][0]).toEqual(first)
    expect(restarted.replayHint(source)).toBeUndefined()
  })

  it.each(['accepted', 'duplicate', 'superseded'])('accepts a matching durable %s receipt', async state => {
    const f = await setup()
    f.transport.ingest.mockImplementation(async envelope => ({
      ...accepted(envelope, state),
      acceptedRevision: envelope.object.revision + 1
    }))
    expect(await f.reader.ingest(batch())).toMatchObject({ state: 'ready', processedThrough: instant })
  })

  it.each(['google_derived', 'fence_active', 'excluded', 'withdrawn', 'stale_policy_epoch', 'invalid', 'unsupported'])(
    'records named refusal %s without inventing full coverage',
    async reason => {
      const f = await setup()
      f.transport.ingest.mockImplementation(async envelope => {
        const { acceptedRevision: _accepted, ...receipt } = accepted(envelope)

        return { ...receipt, state: 'refused', reason } as never
      })
      expect(await f.reader.ingest(batch())).toMatchObject({ state: 'partial', reasons: ['backfill_pending'] })
      expect(f.reader.replayHint(source)).toBeUndefined()
      expect(f.reader.coverage(source).processedThrough).toBeUndefined()
    }
  )

  it.each([
    'wrong operation',
    'wrong source',
    'wrong object',
    'unknown refusal',
    'extra credential',
    'too old revision'
  ])('keeps unknown receipt pending: %s', async bad => {
    const f = await setup()
    f.transport.ingest.mockImplementation(async envelope => {
      const receipt = accepted(envelope)

      return {
        ...receipt,
        ...(bad === 'wrong operation' ? { operationId: suppressionId } : {}),
        ...(bad === 'wrong source' ? { source: other } : {}),
        ...(bad === 'wrong object' ? { object: { ...receipt.object, id: '$other' } } : {}),
        ...(bad === 'unknown refusal' ? { state: 'refused', reason: 'other' } : {}),
        ...(bad === 'extra credential' ? { token: 'not-allowed' } : {}),
        ...(bad === 'too old revision' ? { acceptedRevision: 0 } : {})
      }
    })
    expect(await f.reader.ingest(batch())).toMatchObject({ state: 'offline' })
    expect(f.reader.replayHint(source)).toEqual(revision.object)
    expect(f.reader.coverage(source).processedThrough).toBeUndefined()
  })

  it('refuses newer/different payloads until the unknown source revision is reread; other sources can flow', async () => {
    const f = await setup()
    f.transport.ingest.mockRejectedValueOnce(new Error('lost'))
    await f.reader.ingest(batch())
    const newer = { ...revision, object: { ...revision.object, id: '$new', revision: 2 } }
    expect(await f.reader.ingest(batch(newer))).toMatchObject({ state: 'catching_up' })
    expect(f.transport.ingest).toHaveBeenCalledTimes(1)
    await f.reader.register(other)
    expect(await f.reader.ingest(batch({ ...revision, source: other }))).toMatchObject({ state: 'ready' })
    expect(f.transport.ingest).toHaveBeenCalledTimes(2)
  })

  it('a hung transport times out without advancing, aborts the port, then permits another source', async () => {
    vi.useFakeTimers()
    const f = await setup({ requestTimeoutMs: 25 })
    let signal: AbortSignal | undefined
    f.transport.ingest.mockImplementationOnce((_envelope, input) => {
      signal = input

      return new Promise(() => {})
    })
    const pending = f.reader.ingest(batch())
    await vi.advanceTimersByTimeAsync(26)
    expect(await pending).toMatchObject({ state: 'offline' })
    expect(signal?.aborted).toBe(true)
    await f.reader.register(other)
    expect(await f.reader.ingest(batch({ ...revision, source: other }))).toMatchObject({ state: 'ready' })
  })

  it('missing keys and pre-join/unreadable revisions never dispatch or jump the watermark', async () => {
    const f = await setup()
    f.state.keysAvailable = false
    expect(await f.reader.ingest(batch())).toMatchObject({ state: 'needs_keys', reasons: ['keys_missing'] })
    f.state.keysAvailable = true
    f.state.readable = false
    f.reader.keysChanged(source)
    expect(await f.reader.ingest(batch())).toMatchObject({ state: 'partial' })
    expect(f.transport.ingest).not.toHaveBeenCalled()
    expect(f.reader.coverage(source).processedThrough).toBeUndefined()
    f.state.readable = true
    expect(await f.reader.ingest(batch())).toMatchObject({ state: 'ready' })
  })

  it('a restart never claims caught up before the next verified scan', async () => {
    const f = await setup()
    await f.reader.ingest(batch())
    const restarted = await AwarenessReader.open(f.options)
    expect(restarted.coverage(source)).toMatchObject({ state: 'catching_up', backfill: { complete: false } })
  })

  it('a missing restart store is not silently recreated without explicit initial provisioning', async () => {
    const f = await setup()
    f.storage.replace(null)
    await expect(AwarenessReader.open({ ...f.options, create: false })).rejects.toThrow('awareness_store_missing')
  })

  it('restore rewind is durable, keeps suppression and reports catching up until actual backfill closes', async () => {
    const f = await setup()
    await f.reader.ingest(batch())
    await f.reader.restoreGap(source, instant - 1000)
    expect(f.reader.coverage(source)).toMatchObject({ state: 'catching_up', processedThrough: instant - 1000 })
    const restarted = await AwarenessReader.open(f.options)
    expect(restarted.coverage(source)).toMatchObject({ state: 'catching_up', processedThrough: instant - 1000 })
    expect(await restarted.ingest(batch())).toMatchObject({ state: 'ready', processedThrough: instant })
  })

  it('temporary sources start excluded, deliberate exclusion survives leave/rejoin and only owner reinclusion moves epoch', async () => {
    const f = await setup()
    await f.reader.register(other, true)
    expect(f.reader.coverage(other)).toMatchObject({ state: 'excluded', reasons: ['temporary_conversation'] })
    expect(await f.reader.setIncluded(source, false)).toBe(true)
    expect(f.transport.withdraw.mock.calls[0][0]).toMatchObject({ reason: 'exclude', policyEpoch: 2 })
    await f.reader.membership(source, 'left')
    expect(await f.reader.membership(source, 'joined')).toBe(false)
    await f.reader.ingest(batch())
    expect(f.transport.ingest).not.toHaveBeenCalled()
    const restarted = await AwarenessReader.open(f.options)
    expect(await restarted.setIncluded(source, true)).toBe(true)
    await restarted.ingest(batch())
    expect(f.transport.ingest.mock.calls[0][0].policy.epoch).toBe(3)
  })

  it('leave purges through recorded receipt before rejoin; rejoin increments access epoch', async () => {
    const f = await setup()
    await f.reader.membership(source, 'left')
    expect(f.transport.withdraw.mock.calls[0][0]).toMatchObject({ reason: 'left_room', policyEpoch: 2 })
    await f.reader.membership(source, 'joined')
    await f.reader.ingest(batch())
    expect(f.transport.ingest.mock.calls[0][0].policy.epoch).toBe(3)
  })

  it('unknown withdrawal blocks replay, survives restart, and its retry keeps IDs before content', async () => {
    const f = await setup()
    const order: string[] = []
    f.transport.withdraw.mockImplementation(async request => {
      order.push('withdraw')

      return recorded(request)
    })
    f.transport.withdraw.mockRejectedValueOnce(new Error('offline'))
    expect(await f.reader.withdraw({ kind: 'object', source, objectId: revision.object.id }, 'forget')).toBe(false)
    const first = f.transport.withdraw.mock.calls[0][0]
    const restarted = await AwarenessReader.open(f.options)
    f.transport.ingest.mockImplementation(async envelope => {
      order.push('ingest')

      return accepted(envelope)
    })
    await restarted.ingest(batch({ ...revision, object: { ...revision.object, id: '$another' } }))
    expect(f.transport.withdraw.mock.calls[1][0]).toEqual(first)
    expect(order).toEqual(['withdraw', 'ingest'])
    expect(JSON.stringify(f.storage.value())).toContain(suppressionId)
    await restarted.ingest(batch())
    expect(f.transport.ingest).toHaveBeenCalledTimes(1)
  })

  it.each(['object', 'fact'])(
    'permanent %s tombstone suppresses edits even after source reinclusion/restart',
    async kind => {
      const f = await setup()
      expect(awarenessEvidenceId(source, revision.object.id)).toBe('70f935cc-2c2a-8913-a35a-81300d46f107')

      const scope =
        kind === 'object'
          ? { kind: 'object' as const, source, objectId: revision.object.id }
          : { kind: 'fact' as const, evidenceId: awarenessEvidenceId(source, revision.object.id) }

      await f.reader.withdraw(scope, 'forget')
      expect(f.transport.withdraw.mock.calls[0][0]).not.toHaveProperty('policyEpoch')
      await f.reader.setIncluded(source, false)
      await f.reader.setIncluded(source, true)
      const restarted = await AwarenessReader.open(f.options)
      const edit = fixtures.vectors['envelope-edit.managed.json'] as AwarenessEnvelope
      await restarted.ingest(batch({ ...revision, object: edit.object }))
      expect(f.transport.ingest).not.toHaveBeenCalled()
      expect(JSON.stringify(f.storage.value())).toContain(suppressionId)
    }
  )

  it('account withdrawal is terminal for this bound owner and never clears on restart', async () => {
    const f = await setup()
    await f.reader.withdraw({ kind: 'account' }, 'account_deleted')
    const restarted = await AwarenessReader.open(f.options)
    expect(await restarted.ingest(batch())).toMatchObject({ state: 'excluded' })
    expect(f.transport.ingest).not.toHaveBeenCalled()
  })

  it('malformed/late purge receipts never acknowledge owner withdrawal success', async () => {
    const f = await setup()
    f.transport.withdraw.mockImplementation(async request => ({ ...recorded(request), purgeBy: instant + 86_400_001 }))
    expect(await f.reader.withdraw({ kind: 'object', source, objectId: '$e' }, 'forget')).toBe(false)
    expect(await f.reader.ingest(batch())).toMatchObject({ state: 'offline' })
    expect(f.transport.ingest).not.toHaveBeenCalled()
  })

  it('retries sticky earliest fence across restart, even if ack was lost; unmarked sources still flow', async () => {
    const f = await setup()
    f.transport.fence.mockRejectedValueOnce(new Error('lost fence ack'))
    expect(await f.reader.observeFence({ v: 1, since: 10 })).toBe(false)
    f.transport.fence.mockRejectedValueOnce(new Error('still offline'))
    expect(await f.reader.ingest(batch())).toMatchObject({ state: 'ready' })
    expect(f.transport.ingest.mock.calls[0][0].policy.accountFence).toBe(true)
    const restarted = await AwarenessReader.open(f.options)
    expect(await restarted.retryControls()).toBe(true)
    await restarted.observeFence({ v: 1, since: 20 })
    expect(f.transport.fence.mock.calls.at(-1)?.[0]).toEqual({ v: 1, since: 10 })
    await restarted.register(drive)
    expect(
      await restarted.ingest(
        batch({ ...revision, source: drive, object: { ...revision.object, kind: 'file_version' } })
      )
    ).toMatchObject({ state: 'paused', reasons: ['google_fence'] })
    expect(f.transport.ingest).toHaveBeenCalledTimes(1)
  })

  it('managed marked and malformed-marked content never dispatch; local marks stay local', async () => {
    const f = await setup()
    const marked = { ...revision, provenance: { v: 1, google: true } }
    expect(await f.reader.ingest(batch(marked))).toMatchObject({ state: 'paused', reasons: ['google_fence'] })
    expect(await f.reader.ingest(batch({ ...marked, provenance: null }))).toMatchObject({
      state: 'paused',
      reasons: ['google_fence']
    })
    expect(f.transport.ingest).not.toHaveBeenCalled()
    const local = await setup({ destination: 'local' })
    await local.reader.ingest(batch(marked))
    expect(local.transport.ingest.mock.calls[0][0].policy.googleDerived).toBe(true)
  })

  it('a fence arriving while token refresh is pending prevents Drive dispatch', async () => {
    const f = await setup()
    await f.reader.register(drive)
    const refresh = deferred()
    const started = deferred()
    f.transport.prepare.mockImplementationOnce(async () => {
      started.resolve()
      await refresh.promise
    })

    const pending = f.reader.ingest(
      batch({ ...revision, source: drive, object: { ...revision.object, kind: 'file_version' } })
    )

    await started.promise
    const fence = f.reader.observeFence({ v: 1, since: 10 })
    refresh.resolve()
    expect(await pending).toMatchObject({ state: 'paused', reasons: ['google_fence'] })
    expect(await fence).toBe(true)
    expect(f.transport.ingest).not.toHaveBeenCalled()
  })

  it.each(['leave', 'key loss', 'stop', 'inactive'])('rechecks %s after refresh before dispatch', async change => {
    const f = await setup()
    const refresh = deferred()
    const started = deferred()
    f.transport.prepare.mockImplementationOnce(async () => {
      started.resolve()
      await refresh.promise
    })
    const pending = f.reader.ingest(batch())
    await started.promise
    let control: Promise<unknown> | undefined

    if (change === 'leave') {
      control = f.reader.membership(source, 'left')
    }

    if (change === 'key loss') {
      f.state.keysAvailable = false
      f.reader.keysChanged(source)
    }

    if (change === 'stop') {
      f.reader.stop()
    }

    if (change === 'inactive') {
      f.state.live = false
    }

    refresh.resolve()
    await pending

    if (control) {
      await control
    }

    expect(f.transport.ingest).not.toHaveBeenCalled()
  })

  it('partial/unparsed attachments and incomplete history never claim full coverage', async () => {
    const f = await setup()

    const value = {
      ...revision,
      content: {
        text: 'attachment',
        attachments: [
          { kind: 'audio' as const, ref: 'mxc://test/a', mime: 'audio/ogg', bytes: 10, parse: 'pending' as const }
        ]
      }
    }

    expect(await f.reader.ingest(batch(value))).toMatchObject({ state: 'partial', reasons: ['unsupported_media'] })
    expect(f.reader.coverage(source).processedThrough).toBeUndefined()
    expect(await f.reader.ingest({ ...batch(), complete: false })).toMatchObject({ state: 'catching_up' })
  })

  it('does not derive watermarks from nonmonotonic Matrix timestamps', async () => {
    const f = await setup()
    expect(await f.reader.ingest(batch({ ...revision, eventTime: instant + 999999 }, instant - 10))).toMatchObject({
      processedThrough: instant - 10
    })
  })

  it('rejects a scan that jumps past an unacknowledged/restore gap even when empty', async () => {
    const f = await setup()
    await expect(f.reader.ingest({ ...batch(), after: instant - 1 })).rejects.toThrow('awareness_batch_invalid')
    await f.reader.ingest(batch())
    await f.reader.restoreGap(source, instant - 1000)
    await expect(f.reader.ingest({ ...batch(), revisions: [], after: instant })).rejects.toThrow(
      'awareness_batch_invalid'
    )
    expect(f.reader.coverage(source)).toMatchObject({ state: 'catching_up', processedThrough: instant - 1000 })
  })

  it('coverage reports are bounded contract values with no empty dispatch', async () => {
    const f = await setup()
    await f.reader.reportCoverage()
    expect(f.transport.coverage.mock.calls[0][0]).toEqual({ entries: [f.reader.coverage(source)] })

    for (let i = 0; i < 201; i++) {
      await f.reader.register({ kind: 'human_dm', id: `!room${i}:test` })
    }

    f.transport.coverage.mockClear()
    await f.reader.reportCoverage()
    expect(f.transport.coverage.mock.calls.map(([report]) => report.entries.length)).toEqual([200, 2])
  })

  it('failed durable save stops further dispatch and does not fake withdrawal success', async () => {
    const f = await setup()
    vi.mocked(f.storage.store.write).mockRejectedValueOnce(new Error('disk full'))
    await expect(f.reader.ingest(batch())).rejects.toThrow('awareness_store_unavailable')
    await expect(f.reader.ingest(batch())).rejects.toThrow('awareness_reader_stopped')
    expect(f.transport.ingest).not.toHaveBeenCalled()
  })

  it.each(['binding', 'source secret', 'epoch', 'duplicate source', 'withdrawal without epoch'])(
    'corrupt or wrong-owner metadata fails closed: %s',
    async bad => {
      const f = await setup()
      const value = f.storage.value() as any

      if (bad === 'binding') {
        value.binding = 'other-owner'
      }

      if (bad === 'source secret') {
        value.sources[0].source.token = 'not-allowed'
      }

      if (bad === 'epoch') {
        value.sources[0].epoch = 0
      }

      if (bad === 'duplicate source') {
        value.sources.push(value.sources[0])
      }

      if (bad === 'withdrawal without epoch') {
        value.withdrawals.push({
          request: {
            operationId: suppressionId,
            withdrawalId: suppressionId,
            scope: { kind: 'source', source },
            reason: 'exclude',
            requestedAt: instant
          }
        })
      }

      f.storage.replace(value)
      await expect(AwarenessReader.open(f.options)).rejects.toThrow('awareness_store_invalid')
      expect(f.transport.ingest).not.toHaveBeenCalled()
    }
  )
})
