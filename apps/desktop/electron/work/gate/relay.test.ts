import { WORK_RELAY_PLANS, WORK_RELAY_PROVIDER } from '../../../shared/matrix-work-relay'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { handoffBudget, historyCost, selectHistory } from './handoff-helper.cjs'
import { GateLedger } from './ledger'
import type { T3Port } from './ports'
import { WorkRelay } from './relay'
import { ACCOUNT } from './test-support'
import { EVENT_A, EVENT_B, LUNA, makeHarness, REQ_1, REQ_2 } from './test-support'

const clean: (() => void)[] = []
afterEach(() => {
  for (const f of clean.splice(0)) {
    f()
  }
})

function rig() {
  const h = makeHarness()
  clean.push(() => {
    void h.cleanup()
  })
  const selection = { revision: 1, instanceId: 'codex', model: 'test', projectId: 'test', personaRevision: 1 }
  const history = vi.fn(async () => [])

  const owner = vi.fn(async () => ({
    kind: 'ok' as const,
    roomId: '!dm:test',
    encrypted: false,
    body: 'Current intact 🐈',
    originServerTs: h.clock.now()
  }))

  const launch = vi.fn(async () => ({ transport: 'ok' as const, status: 200, data: { runId: 'run1' } }))
  h.t3.launch = launch

  const options = {
    gateId: () => h.gate.gateId(),
    consent: (provider: (typeof WORK_RELAY_PLANS)[number] = 'codex') => ({
      provider,
      state: 'on',
      agents: [LUNA],
      devices: [h.gate.gateId().deviceServiceId],
      alsoWhenScheduled: false,
      revision: 1,
      grantedAt: h.clock.now()
    }),
    localSwitch: () => true,
    ledger: h.ledger,
    sessions: h.sessions,
    t3: h.t3,
    owner: { fetch: owner },
    history: { read: history, boundary: async () => EVENT_B },
    selection: () => selection,
    fence: () => true,
    now: h.clock.now,
    modeLimit: 'auto/default'
  }

  const relay = new WorkRelay(options)

  const input = { request_id: REQ_1, event_id: EVENT_A, room_id: '!dm:test', selection_rev: 1 }

  return { h, options, relay, input, selection, history, owner, launch, ctx: h.ctx(LUNA) }
}

describe('relay admission and frozen receipts (RT2/RT10)', () => {
  it.each(['text', 'history', 'plan', 'model', 'mode', 'threadId', 'provider'])(
    'refuses caller %s before T3',
    async key => {
      const r = rig()
      expect(await r.relay.send(r.ctx, { ...r.input, [key]: 'injected' })).toMatchObject({ class: 'refused' })
      expect(r.launch).not.toHaveBeenCalled()
      expect(r.owner).not.toHaveBeenCalled()
    }
  )
  it.each(WORK_RELAY_PLANS)('launches the selected %s plan with the native permission ceiling', async plan => {
    const r = rig()
    const { instanceId } = WORK_RELAY_PROVIDER[plan]
    r.selection.instanceId = instanceId
    r.options.modeLimit = 'auto-accept-edits/default'
    const planProvider = vi.fn(r.h.t3.planProvider)
    r.h.t3.planProvider = planProvider

    expect(await r.relay.status(r.ctx, r.input.room_id)).toMatchObject({
      selection: { plan, model: 'test' }, connected: true
    })
    expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'accepted' })
    expect(planProvider).toHaveBeenCalledWith(expect.any(String), instanceId)
    expect(r.h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ plan })
    expect(r.launch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      modelSelection: { instanceId, model: 'test' }
    }), plan === 'antigravity' ? 'approval-required/default' : 'auto-accept-edits/default')
  })

  it('refuses an instance outside the plan table before reading the owner event', async () => {
    const r = rig()
    r.selection.instanceId = 'custom'

    expect(await r.relay.status(r.ctx, r.input.room_id)).toMatchObject({ selection: null, connected: false })
    expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'revoked' })
    expect(r.owner).not.toHaveBeenCalled()
    expect(r.launch).not.toHaveBeenCalled()
  })

  it('requires an event and the canonical plain owner DM', async () => {
    const r = rig()
    expect(await r.relay.send(r.ctx, { ...r.input, event_id: undefined })).toMatchObject({ class: 'refused' })
    expect(await r.relay.send(r.ctx, { ...r.input, room_id: '!other:test' })).toMatchObject({ class: 'refused' })
    r.owner.mockResolvedValueOnce({ kind: 'invalid', reason: 'owner_event_not_owner' } as never)
    expect(await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2 })).toMatchObject({
      reason: 'owner_event_not_owner'
    })
    expect(r.launch).not.toHaveBeenCalled()
  })
  it('freezes call and reply across selection, history, cursor changes and process restart', async () => {
    const r = rig()
    const first = await r.relay.send(r.ctx, r.input)
    const row = r.h.ledger.receipt(LUNA, REQ_1)!
    expect(JSON.parse(row.relayJson!).input).toEqual(r.input)
    expect(JSON.parse(row.callJson!).message).toContain('Current intact 🐈')
    r.selection.revision++
    r.history.mockRejectedValue(new Error('redacted'))
    const disk = new GateLedger(join(r.h.dir, 'ledger.sqlite'), ACCOUNT, r.h.clock.now)
    const restarted = new WorkRelay({ ...r.options, ledger: disk })
    expect(JSON.stringify(await restarted.send(r.ctx, r.input))).toBe(JSON.stringify(first))
    disk.close()
    expect(JSON.stringify(await r.relay.send(r.ctx, r.input))).toBe(JSON.stringify(first))
    expect(r.launch).toHaveBeenCalledTimes(1)
    expect(await r.relay.send(r.ctx, { ...r.input, event_id: EVENT_B })).toMatchObject({ reason: 'changed' })
    expect(await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2 })).toMatchObject({ reason: 'event_already_used' })
  })
  it('admits one concurrent send and holds the binding until publication', async () => {
    const r = rig()
    const answers = await Promise.all([r.relay.send(r.ctx, r.input), r.relay.send(r.ctx, r.input)])
    expect(answers.filter(a => a.class === 'accepted')).toHaveLength(1)
    expect(r.launch).toHaveBeenCalledTimes(1)
    expect(await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2, event_id: EVENT_B })).toMatchObject({
      reason: 'operation_open'
    })
    expect(r.relay.close(r.ctx, REQ_1)).toBe(false)
  })
  it('history failure durably refuses without dispatch', async () => {
    const r = rig()
    r.history.mockRejectedValueOnce(new Error('crash'))
    expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'refused', forwarded: false })
    expect(r.h.ledger.receipt(LUNA, REQ_1)?.state).toBe('refused')
    expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'refused' })
    expect(r.launch).not.toHaveBeenCalled()
  })
  it('freezes only the admitted result run final, excluding direct Work and tool output', async () => {
    const r = rig()
    await r.relay.send(r.ctx, r.input)
    r.h.t3.wait = vi.fn(async () => ({
      transport: 'ok' as const,
      status: 200,
      data: { timedOut: false, status: 'completed', resultRun: { runId: 'run1', status: 'completed' } }
    }))
    ;(r.h.t3 as T3Port).readPage = vi.fn(async () => ({
      transport: 'ok' as const,
      status: 200,
      data: {
        hasMore: false,
        items: [
          {
            sourceThreadId: r.h.ledger.receipt(LUNA, REQ_1)!.threadId,
            runId: 'run1',
            type: 'assistant_message',
            itemId: 'final',
            text: 'frozen'
          },
          { runId: 'other', type: 'assistant_message', text: 'private Work input' },
          { runId: 'run1', type: 'command_execution', text: 'tool' }
        ]
      }
    }))
    const first = await r.relay.read(r.ctx, REQ_1, 25_000)
    expect(first).toMatchObject({ class: 'completed', answer: { text: 'frozen', itemId: 'final' } })

    if (process.env.ATUM_RELAY_PROTOCOL) {
      const protocol = await import(/* @vite-ignore */ process.env.ATUM_RELAY_PROTOCOL)
      expect(protocol.WorkRelayReceiptSchema.parse(first)).toEqual(first)
    }

    expect(await r.relay.read(r.ctx, REQ_1, 25_000)).toEqual(first)
    expect((r.h.t3 as T3Port).readPage).toHaveBeenCalledTimes(1)
    expect(r.relay.close(r.ctx, REQ_1)).toBe(true)

    if (process.env.ATUM_RELAY_PROTOCOL) {
      const protocol = await import(/* @vite-ignore */ process.env.ATUM_RELAY_PROTOCOL)
      const closed = r.relay.closeReceipt(r.ctx, REQ_1)
      expect(protocol.WorkRelayReceiptSchema.parse(closed)).toEqual(closed)
    }
  })
})
describe('RT3 native helper budget', () => {
  it.each(['plain', '🐈漢字', 'x'.repeat(70_000)])('keeps whole items and omission counts', text => {
    const messages = Array.from({ length: 60 }, (_, n) => ({
      role: n % 2 ? ('assistant' as const) : ('user' as const),
      text: text.repeat(20),
      itemId: `item${n}`,
      threadId: 'room',
      runId: null,
      providerThreadId: null,
      kind: 'message',
      status: 'completed'
    }))

    const budget = handoffBudget({
      tokenCap: 16_000,
      userText: 'current',
      attachments: [],
      providerThread: { contextUsage: null },
      nativeContextEstimate: 0
    })

    const selected = selectHistory({ messages, budget, coverage: 'DM' })
    expect(selected.messages.length + selected.omittedItems).toBe(messages.length)
    expect(historyCost(selected.messages, selected.context)).toBeLessThanOrEqual(budget)

    for (const m of selected.messages) {
      expect(m.text).toBe(messages.find(x => x.itemId === m.itemId)!.text)
    }
  })
})

it('three ids-only operations reuse the bound thread; close is idempotent after later sends', async () => {
  const r = rig()
  const t3 = r.h.t3 as T3Port
  t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'completed', runs: [], raw: {} }))
  t3.send = vi.fn(async () => ({ transport: 'ok' as const, status: 200, data: { runId: 'run1' } }))
  t3.wait = vi.fn(async () => ({
    transport: 'ok' as const,
    status: 200,
    data: { timedOut: false, status: 'completed' }
  }))
  t3.readPage = vi.fn(async () => ({
    transport: 'ok' as const,
    status: 200,
    data: { hasMore: false, items: [{ type: 'assistant_message', runId: 'run1', itemId: 'answer', text: 'answer' }] }
  }))

  for (const [request_id, event_id] of [
    [REQ_1, EVENT_A],
    [REQ_2, EVENT_B],
    ['AAAAAAAAAAAAAAAAAAAAA3', '$eventC']
  ]) {
    expect(await r.relay.send(r.ctx, { ...r.input, request_id, event_id })).toMatchObject({ class: 'accepted' })
    expect(await r.relay.read(r.ctx, request_id, 25_000)).toMatchObject({ class: 'completed' })
    expect(r.relay.closeReceipt(r.ctx, request_id)).toMatchObject({ class: 'closed' })
  }

  expect(r.launch).toHaveBeenCalledTimes(1)
  expect(t3.send).toHaveBeenCalledTimes(2)
  const calls = vi.mocked(t3.send!).mock.calls
  expect(calls[0][1].threadId).toBe(calls[1][1].threadId)
  expect(Object.keys(calls[0][1]).sort()).toEqual(['clientRequestId', 'message', 'threadId'])
  expect(r.relay.closeReceipt(r.ctx, REQ_1)).toMatchObject({ class: 'closed' })
  expect(r.relay.closeReceipt(r.ctx, 'AAAAAAAAAAAAAAAAAAAAA9')).toMatchObject({ class: 'refused', reason: 'not_owned' })
})
it('reset confirms stop, advances floor, silences old receipts and keeps old thread', async () => {
  const r = rig()
  await r.relay.send(r.ctx, r.input)
  const thread = r.h.ledger.receipt(LUNA, REQ_1)!.threadId!
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'completed', runs: [], raw: {} }))
  expect(await r.relay.reset(r.ctx, '!dm:test', EVENT_B)).toBe(true)
  expect(r.h.t3.count('interrupt')).toBe(1)
  expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'revoked' })
  expect(await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2, event_id: EVENT_B })).toMatchObject({
    class: 'accepted'
  })
  expect(r.history).toHaveBeenLastCalledWith(expect.objectContaining({ floor: EVENT_B }))
  expect(r.h.ledger.receipt(LUNA, REQ_1)!.threadId).toBe(thread)
})

it.skipIf(!process.env.ATUM_RELAY_PROTOCOL)('conforms to the retained P1 contract readers', async () => {
  const protocol = await import(/* @vite-ignore */ process.env.ATUM_RELAY_PROTOCOL!)
  const r = rig()
  expect(protocol.WorkRelaySendArgumentsSchema.parse(r.input)).toEqual(r.input)
  const sent = await r.relay.send(r.ctx, r.input)
  expect(protocol.WorkRelayReceiptSchema.parse(sent)).toEqual(sent)
  expect(
    protocol.WorkRelayFrozenCallSchema.parse(JSON.parse(r.h.ledger.receipt(LUNA, REQ_1)!.relayJson!).frozenCall)
  ).toBeTruthy()
  const status = await r.relay.status(r.ctx, r.input.room_id)
  expect(protocol.WorkRelayStatusSchema.parse(status)).toEqual(status)
  expect(protocol.WorkRelayReceiptSchema.parse(await r.relay.request(r.ctx, REQ_1))).toBeTruthy()
  expect(
    protocol.WorkRelayReceiptSchema.parse(
      await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2, event_id: EVENT_B })
    )
  ).toBeTruthy()
})

it('RT3 derives a budgeted multibyte seed and keeps a long current request intact', async () => {
  const r = rig()
  const body = '🐈 current request '.repeat(2000)
  r.owner.mockResolvedValue({ kind: 'ok', roomId: '!dm:test', encrypted: false, body, originServerTs: r.h.clock.now() })

  const messages = Array.from({ length: 60 }, (_, n) => ({
    role: n % 2 ? ('assistant' as const) : ('user' as const),
    text: `turn ${Math.floor(n / 2) + 1} 漢字 `.repeat(n === 0 ? 20000 : 20),
    itemId: `$history${n}`,
    threadId: '!dm:test',
    runId: null,
    providerThreadId: null,
    kind: 'message',
    status: 'completed'
  }))

  r.history.mockResolvedValue(messages)
  expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'accepted' })
  const row = r.h.ledger.receipt(LUNA, REQ_1)!
  const frozen = JSON.parse(row.relayJson!)
  const call = JSON.parse(row.callJson!)
  expect(call.message.endsWith(body)).toBe(true)
  expect(frozen.snapshot.selected.length + frozen.snapshot.omitted).toBe(60)
  expect(Buffer.byteLength(call.message.slice(0, call.message.indexOf('Current owner request:')))).toBeLessThanOrEqual(
    16000
  )
})

it('recovers a lost launch acknowledgement by reading ordinal one without relaunching', async () => {
  const r = rig()
  r.launch.mockResolvedValue({ transport: 'failed', error: 'lost' } as never)
  expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'pending' })
  r.h.t3.read = vi.fn(async () => ({
    kind: 'found' as const,
    status: 'completed',
    runs: [{ ordinal: 1, runId: 'recovered', status: 'completed' }],
    raw: {}
  }))
  const t3 = r.h.t3 as T3Port
  t3.wait = vi.fn(async () => ({
    transport: 'ok' as const,
    status: 200,
    data: { timedOut: false, status: 'completed' }
  }))
  t3.readPage = vi.fn(async () => ({
    transport: 'ok' as const,
    status: 200,
    data: {
      hasMore: false,
      items: [{ runId: 'recovered', type: 'assistant_message', itemId: 'final', text: 'retained' }]
    }
  }))
  expect(await r.relay.read(r.ctx, REQ_1, 25_000)).toMatchObject({
    class: 'completed',
    answer: { runId: 'recovered', text: 'retained' }
  })
  expect(r.launch).toHaveBeenCalledTimes(1)
})

it('provisions a main-owned target only after verified history and freezes its persona on replay', async () => {
  const r = rig()
  const provision = vi.fn(async () => ({ projectId: 'assistant-project', personaRevision: 8 }))
  const relay = new WorkRelay({ ...r.options, provision })
  const first = await relay.send(r.ctx, r.input)
  expect(first.class).toBe('accepted')
  expect(provision).toHaveBeenCalledOnce()
  const row = r.h.ledger.receipt(LUNA, REQ_1)!
  expect(JSON.parse(row.callJson!).projectId).toBe('assistant-project')
  expect(JSON.parse(row.relayJson!).frozenCall.binding.personaRevision).toBe(8)
  expect(await relay.send(r.ctx, r.input)).toEqual(first)
  expect(provision).toHaveBeenCalledOnce()
})

it('does not provision a project/persona when the owner event is unverifiable', async () => {
  const r = rig()
  const provision = vi.fn(async () => ({ projectId: 'assistant-project', personaRevision: 8 }))
  r.owner.mockResolvedValueOnce({ kind: 'unreachable' } as never)
  const relay = new WorkRelay({ ...r.options, provision })
  await relay.send(r.ctx, r.input)
  expect(provision).not.toHaveBeenCalled()
  expect(r.launch).not.toHaveBeenCalled()
})

it('reports disconnected when selection or preflight authority is stale, even when the native provider is connected', async () => {
  const r = rig()

  for (const options of [{ ...r.options, selection: () => undefined }, { ...r.options, fence: () => false }]) {
    const relay = new WorkRelay(options)
    expect(await relay.status(r.ctx, '!dm:test')).toMatchObject({ connected: false })
  }
})

it('G1 voids a non-forwarded admission and releases the binding atomically', async () => {
  const r = rig()
  r.h.t3.incarnation = () => undefined
  expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'refused', receipt: 'void', forwarded: false })
  expect(r.h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ state: 'void', forwarded: false, settled: 'never_sent' })
  expect(await r.relay.status(r.ctx, r.input.room_id)).toMatchObject({ openOperation: null })
  expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'refused', receipt: 'void' })
  expect(r.launch).not.toHaveBeenCalled()
  r.h.t3.incarnation = () => 'ready'
  expect(await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2, event_id: EVENT_B })).toMatchObject({ class: 'accepted' })
  expect(r.launch).toHaveBeenCalledOnce()
})

it('G2 admits a queued owner event after a long hold, but refuses unrelated stale events', async () => {
  const r = rig()
  const queuedAt = r.h.clock.now() + 1000
  await r.relay.send(r.ctx, r.input)
  r.h.clock.advance(3_600_000)
  r.h.ledger.update(LUNA, REQ_1, { settled: 'stopped' })
  expect(r.relay.close(r.ctx, REQ_1)).toBe(true)
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'completed', runs: [], raw: {} }))
  ;(r.h.t3 as T3Port).send = vi.fn(async () => ({ transport: 'ok' as const, status: 200, data: { runId: 'run2' } }))
  r.owner.mockResolvedValue({ kind: 'ok', roomId: '!dm:test', encrypted: false, body: 'queued', originServerTs: queuedAt })
  expect(await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2, event_id: EVENT_B })).toMatchObject({ class: 'accepted' })
})

it('G3 replaces an admitted T3 session only after stop and rebinds to a new session key', async () => {
  const r = rig()
  await r.relay.send(r.ctx, r.input)
  const old = JSON.parse(r.h.ledger.receipt(LUNA, REQ_1)!.relayJson!).bindingKey
  r.h.sessions.replace(LUNA)
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'completed', runs: [], raw: {} }))
  expect(await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2, event_id: EVENT_B })).toMatchObject({ class: 'accepted' })
  const next = JSON.parse(r.h.ledger.receipt(LUNA, REQ_2)!.relayJson!)
  expect(next.bindingKey).not.toBe(old)
  expect(next.snapshot.floor).toBe(EVENT_B)
  expect(await r.relay.request(r.ctx, REQ_1)).toMatchObject({ class: 'revoked', stopConfirmed: true })
  expect(r.launch).toHaveBeenCalledTimes(2)
})

it('G5 excludes only published relay replies, retaining ordinary Matrix replies', async () => {
  const r = rig()
  await r.relay.send(r.ctx, r.input)
  r.h.ledger.update(LUNA, REQ_1, { settled: 'stopped' })
  r.relay.close(r.ctx, REQ_1)
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'completed', runs: [], raw: {} }))
  ;(r.h.t3 as T3Port).send = vi.fn(async () => ({ transport: 'ok' as const, status: 200, data: { runId: 'run2' } }))
  const message = { role: 'assistant', kind: 'message', threadId: 'room', runId: null, providerThreadId: null, status: 'completed' }
  r.history.mockResolvedValue([
    { ...message, itemId: '$echo', text: 'relay echo', replyTo: EVENT_A },
    { ...message, itemId: '$normal', text: 'ordinary answer', replyTo: '$other' }
  ] as never)
  await r.relay.send(r.ctx, { ...r.input, request_id: REQ_2, event_id: EVENT_B })
  const call = JSON.parse(r.h.ledger.receipt(LUNA, REQ_2)!.callJson!)
  expect(call.message).not.toContain('relay echo')
  expect(call.message).toContain('ordinary answer')
})

it('G6 reset holds until descendants stop, then settles the receipt and confirms', async () => {
  const r = rig()
  await r.relay.send(r.ctx, r.input)
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'running', runs: [], raw: { thread: { pendingBackgroundTasks: ['child'] } } }))
  expect(await r.relay.resetReceipt(r.ctx, '!dm:test', REQ_2)).toMatchObject({ stopConfirmed: false })
  expect(await r.relay.request(r.ctx, REQ_1)).toMatchObject({ class: 'revoked', stopConfirmed: false })
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'completed', runs: [], raw: {} }))
  expect(await r.relay.resetReceipt(r.ctx, '!dm:test', REQ_2)).toMatchObject({ stopConfirmed: true })
  expect(await r.relay.request(r.ctx, REQ_1)).toMatchObject({ class: 'revoked', stopConfirmed: true })
})

it.each(['approval', 'plan_limit', 'waiting_for_mac'])('C3 reports a known %s hold; G7 read never waits and wait caps at 25s', async hold => {
  const r = rig()
  await r.relay.send(r.ctx, r.input)
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'waiting', runs: [{ runId: 'run1', ordinal: 1, status: 'waiting' }], raw: { thread: { hold } } }))
  r.h.t3.wait = vi.fn(async () => ({ transport: 'ok' as const, data: { timedOut: true, hold } }))
  expect(await r.relay.read(r.ctx, REQ_1)).toMatchObject({ class: 'pending', operation: { phase: 'held', hold } })
  expect(r.h.t3.wait).not.toHaveBeenCalled()
  await r.relay.read(r.ctx, REQ_1, 50_000)
  expect(r.h.t3.wait).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'run1', 25_000)
})


it('G6 reset replays its epoch and frozen boundary without a second stop', async () => {
  const r = rig()
  await r.relay.send(r.ctx, r.input)
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'completed', runs: [], raw: {} }))
  const first = await r.relay.resetReceipt(r.ctx, '!dm:test', REQ_2)
  expect(first).toMatchObject({ class: 'reset', receipt: 'reset', requestId: REQ_2, epoch: 1, stopConfirmed: true })
  expect(await r.relay.resetReceipt(r.ctx, '!dm:test', REQ_2)).toEqual(first)
  expect(r.h.t3.count('interrupt')).toBe(1)
  expect(await r.relay.resetReceipt(r.ctx, '!other:test', REQ_2)).toMatchObject({ class: 'refused', reason: 'changed' })
})

it.each([['consent_off', false, true], ['switch_off', true, false]])('maps %s before admission to a durable fallback refusal', async (reason, consent, localSwitch) => {
  const r = rig()
  const relay = new WorkRelay({ ...r.options, fence: () => false, consent: () => ({ state: consent ? 'on' : 'off' }), localSwitch: () => Boolean(localSwitch) })
  expect(await relay.send(r.ctx, r.input)).toMatchObject({ class: 'refused', forwarded: false, reason })
  expect(r.h.ledger.receipt(LUNA, REQ_1)?.state).toBe('refused')
  expect(r.launch).not.toHaveBeenCalled()
})

it('G2 still refuses stale messages outside the binding queue window', async () => {
  const r = rig()
  r.owner.mockResolvedValue({ kind: 'ok', roomId: '!dm:test', encrypted: false, body: 'stale', originServerTs: r.h.clock.now() - 3_600_000 })
  expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'refused', reason: 'owner_event_too_old', forwarded: false })
})


it('clears a failed reset latch so the cloud can retry', async () => {
  const r = rig()
  await r.relay.send(r.ctx, r.input)
  const interrupt = vi.spyOn(r.h.t3, 'interrupt').mockRejectedValueOnce(new Error('offline'))
  await expect(r.relay.resetReceipt(r.ctx, '!dm:test', REQ_2, EVENT_B)).rejects.toThrow('offline')
  r.h.t3.read = vi.fn(async () => ({ kind: 'found' as const, status: 'completed', runs: [], raw: {} }))
  expect(await r.relay.resetReceipt(r.ctx, '!dm:test', REQ_2, EVENT_B)).toMatchObject({ stopConfirmed: true })
  expect(interrupt).toHaveBeenCalledTimes(2)
})

it('retains the explicit reset event after a long sleep', async () => {
  const r = rig()

  r.options.history.boundary = async () => { throw new Error('must use owner floor') }
  expect(await r.relay.resetReceipt(r.ctx, '!dm:test', REQ_2, EVENT_A)).toMatchObject({ stopConfirmed: true })
  expect(r.owner).toHaveBeenCalledWith({ agentPrincipal: LUNA, eventId: EVENT_A })
  expect(await r.relay.resetReceipt(r.ctx, '!dm:test', REQ_2, EVENT_B)).toMatchObject({ reason: 'changed' })
})

it('owner Stop cuts publication before interrupt and preserves the history floor', async () => {
  const r = rig()
  await r.relay.send(r.ctx, r.input)
  const before = await r.relay.status(r.ctx, r.input.room_id)
  r.h.t3.interrupt = vi.fn(async () => {
    expect(r.h.ledger.receipt(LUNA, REQ_1)?.stopScope).toBe('agent')

    return { transport: 'failed' as const }
  })
  r.h.t3.read = vi.fn(async () => ({ kind: 'error' as const, code: 'offline' }))
  expect(await r.relay.stop(r.ctx, r.input.room_id, EVENT_B)).toBe(false)
  expect(r.h.t3.interrupt).not.toHaveBeenCalled()
  expect(await r.relay.stop(r.ctx, r.input.room_id, EVENT_A)).toBe(false)
  expect(await r.relay.request(r.ctx, REQ_1)).toMatchObject({ class: 'revoked', stopConfirmed: false })
  expect((await r.relay.status(r.ctx, r.input.room_id)).reset).toEqual(before.reset)
})

describe('R1s standing scheduled permits', () => {
  function scheduled(r: ReturnType<typeof rig>, job = 'daily-brief', occurrence = 'one') {
    r.options.consent = () => ({provider: 'codex', state: 'on', agents: [LUNA], devices: [r.h.gate.gateId().deviceServiceId], alsoWhenScheduled: true, revision: 1, grantedAt: 1})

    return {request_id: REQ_1, job_id: job, occurrence_id: occurrence, scheduled_at: r.options.now(), job_name: 'Daily brief', selection_rev: 1,
      permit: {agentPrincipal: LUNA, deviceServiceId: r.h.gate.gateId().deviceServiceId, plan: 'codex', consentRevision: 1, alsoWhenScheduled: true}, prompt: 'Write the daily brief'}
  }

  it('freezes the job prompt, bypasses Matrix, counts once, and replays unchanged', async () => {
    const r = rig(), input = scheduled(r)
    const first = await r.relay.send(r.ctx, input)
    expect(first.class).toBe('accepted')
    expect(r.owner).not.toHaveBeenCalled()
    expect(r.history).not.toHaveBeenCalled()
    expect((r.launch.mock.calls as unknown[][])[0]?.[1]).toMatchObject({message: expect.stringContaining('Scheduled job daily-brief, occurrence one:')})
    r.selection.revision++
    expect(await r.relay.send(r.ctx, input)).toEqual(first)
    expect(r.launch).toHaveBeenCalledTimes(1)
    expect((await r.relay.status(r.ctx, '!none:test')).scheduledUsage).toMatchObject({runs: 1})
    expect(r.h.ledger.scheduledRuns(input.scheduled_at, input.scheduled_at + 1, 'codex')).toBe(1)
    expect(r.h.ledger.scheduledRuns(input.scheduled_at - 1, input.scheduled_at, 'codex')).toBe(0)
    expect(r.h.ledger.scheduledRuns(input.scheduled_at + 1)).toBe(0)
    expect(r.h.ledger.scheduledRuns(input.scheduled_at, input.scheduled_at + 1, 'claude')).toBe(0)
  })
  it.each(['alsoWhenScheduled', 'revision', 'agents', 'devices'])('refuses mismatched consent %s before dispatch', async field => {
    const r = rig(), input = scheduled(r)
    const consent = r.options.consent()
    r.options.consent = () => ({...consent, [field]: field === 'revision' ? 2 : field === 'alsoWhenScheduled' ? false : []})
    expect(await r.relay.send(r.ctx, input)).toMatchObject({class: 'refused', forwarded: false})
    expect(r.launch).not.toHaveBeenCalled()
  })
  it('claims each occurrence once and isolates job/DM bindings', async () => {
    const r = rig(), input = scheduled(r)
    expect((await r.relay.send(r.ctx, input)).class).toBe('accepted')
    expect(await r.relay.send(r.ctx, {...input, request_id: REQ_2})).toMatchObject({reason: 'scheduled_operation_limit'})
    expect(await r.relay.send(r.ctx, {...input, request_id: 'scheduled_request_000003', occurrence_id: 'two'})).toMatchObject({reason: 'scheduled_operation_limit'})
    expect((await r.relay.send(r.ctx, {...input, request_id: 'scheduled_request_000004', job_id: 'sweep'})).class).toBe('refused')
    expect((await r.relay.send(r.ctx, {...r.input, request_id: 'owner_request_000000005'})).class).toBe('accepted')
    expect(r.launch).toHaveBeenCalledTimes(2)
  })
  it('cuts off scheduled receipts when scheduled consent is disabled', async () => {
    const r = rig(), input = scheduled(r)
    expect((await r.relay.send(r.ctx, input)).class).toBe('accepted')
    const consent = r.options.consent()
    const results = r.h.gate.beginConsent({...consent, alsoWhenScheduled: false, revision: 2} as Parameters<typeof r.h.gate.beginConsent>[0])
    expect(results.some(result => result.owed > 0)).toBe(true)
    expect((await r.relay.send(r.ctx, input)).class).toBe('revoked')
  })
  it('refuses stale and future first scheduled admissions', async () => {
    const r = rig(), input = scheduled(r)

    for (const scheduled_at of [r.options.now() - 900_001, r.options.now() + 60_001]) {
      expect((await r.relay.send(r.ctx, {...input, scheduled_at})).class).toBe('refused')
    }

    expect(r.launch).not.toHaveBeenCalled()
  })
  it('rejects mixed envelopes and caller model/mode overrides', async () => {
    const r = rig(), input = scheduled(r)

    for (const extra of [{room_id: '!dm:test'}, {model: 'other'}, {mode: 'full-access'}, {text: 'injected'}]) {
      expect((await r.relay.send(r.ctx, {...input, ...extra})).class).toBe('refused')
    }

    expect(r.launch).not.toHaveBeenCalled()
  })
})

describe('R3 native questions (RT10, RT14 and RT15)', () => {
  const pending = 'runtime-request:one'
  const answers = [{ id: 'color', question: 'Which color?', options: [{ label: 'Sea blue', value: 'blue' }],
    allowCustomAnswer: false }]
  const questionText = 'Which color?\n1. Sea blue'
  const readQuestion = { request_id: REQ_1, action: 'read' as const }

  function reply(r: ReturnType<typeof rig>, body = 'Sea blue') {
    return { kind: 'ok' as const, roomId: '!dm:test', encrypted: false, body,
      originServerTs: r.h.clock.now(), ...{ questionReply: true } }
  }

  async function questions(detail = answers) {
    const r = rig()
    await r.relay.send(r.ctx, r.input)

    const read = vi.fn(async () => ({ kind: 'found' as const, status: 'waiting', activeRunId: 'run1',
      runs: [{ runId: 'run1', ordinal: 1, status: 'waiting' }], raw: {} }))

    r.h.t3.read = read
    let waiting = true

    const native = vi.fn<NonNullable<T3Port['pendingQuestion']>>(async (_token, _thread, args) => {
      if (args.action === 'list') {return { transport: 'ok', data: { requestIds: waiting ? [pending] : [] } }}

      if (args.action === 'read') {return { transport: 'ok', data: { requestId: pending, questions: detail } }}

      waiting = false

      return { transport: 'ok', data: { sequence: 42 } }
    })

    ;(r.h.t3 as T3Port).pendingQuestion = native
    const respond = { request_id: REQ_1, action: 'respond' as const, question_id: pending, question_event_id: '$question', event_id: EVENT_B }

    return { ...r, native, respond, read }
  }

  it('reads the native question and sends one verified reply across Mac restart and concurrent replay', async () => {
    const r = await questions()
    const pendingSince = r.h.clock.now()
    expect(await r.relay.question(r.ctx, readQuestion)).toMatchObject({
      class: 'question', questionStatus: 'pending', questionId: pending, questionText, questions: answers
    })
    r.h.clock.advance(10)
    r.owner.mockResolvedValue(reply(r, '> quoted question\n\n  sEa BLUE '))
    const outcomes = await Promise.all([r.relay.question(r.ctx, r.respond), r.relay.question(r.ctx, r.respond)])
    expect(outcomes).toContainEqual(expect.objectContaining({ questionStatus: 'answered' }))
    expect(r.owner).toHaveBeenCalledWith(expect.objectContaining({
      eventId: EVENT_B, question: { eventId: '$question', originalEventId: EVENT_A, text: questionText, pendingSince }
    }))
    expect(r.native).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      action: 'respond', requestId: pending, answers: { color: 'blue' }
    })
    const disk = new GateLedger(join(r.h.dir, 'ledger.sqlite'), ACCOUNT, r.h.clock.now)

    try {
      const restarted = new WorkRelay({ ...r.options, ledger: disk })
      expect(await restarted.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'answered' })
      expect(await restarted.question(r.ctx, { ...r.respond, event_id: '$different' })).toMatchObject({ questionStatus: 'closed' })
      expect(await restarted.send(r.ctx, { ...r.input, request_id: REQ_2, event_id: EVENT_B })).toMatchObject({ class: 'refused' })
      expect(r.native.mock.calls.filter(([, , call]) => call.action === 'respond')).toHaveLength(1)
    } finally {
      disk.close()
    }
  })

  it('keeps approvals, answers from unrelated rooms, and questions on other runs out of chat', async () => {
    const r = await questions()
    await r.relay.question(r.ctx, readQuestion)
    r.h.clock.advance(10)
    r.owner.mockResolvedValueOnce({ ...reply(r), roomId: '!other:test' })
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'invalid_answer' })
    r.native.mockResolvedValueOnce({ transport: 'ok', data: { requestIds: ['another-question', pending] } })
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'held' })
    r.native.mockResolvedValueOnce({ transport: 'ok', data: { requestIds: [] } })
    expect(await r.relay.question(r.ctx, { request_id: REQ_1, action: 'read' })).toMatchObject({ questionStatus: 'none' })
    r.read.mockResolvedValue({ kind: 'found', status: 'waiting', activeRunId: 'another-run', runs: [], raw: {} })
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'closed' })
    expect(r.native.mock.calls.some(([, , call]) => call.action === 'respond')).toBe(false)
  })

  it('does not replay a native response after an ambiguous acknowledgement', async () => {
    const r = await questions()
    await r.relay.question(r.ctx, readQuestion)
    r.h.clock.advance(10)
    r.owner.mockResolvedValue(reply(r))
    const native = r.native.getMockImplementation()!
    r.native.mockImplementation(async (token, thread, args) => {
      const reply = await native(token, thread, args)

      return args.action === 'respond' ? { transport: 'failed' } : reply
    })
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'held' })
    expect(await new WorkRelay(r.options).question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'closed' })
    expect(r.native.mock.calls.filter(([, , call]) => call.action === 'respond')).toHaveLength(1)
  })

  it('rejects a reply from before the first read and keeps the original observation across reads', async () => {
    const r = await questions()
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'closed' })

    await r.relay.question(r.ctx, readQuestion)
    // Older than the first read by more than the 60 s clock-skew allowance.
    r.owner.mockResolvedValueOnce({ ...reply(r), originServerTs: r.h.clock.now() - 61_000 })
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'invalid_answer' })
    r.h.clock.advance(10)
    const newer = reply(r, '1')
    r.h.clock.advance(10)
    await r.relay.question(r.ctx, readQuestion)
    r.owner.mockResolvedValue(newer)
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'answered' })
  })

  it('accepts a reply whose server timestamp trails the Mac clock by a few seconds', async () => {
    const r = await questions()
    await r.relay.question(r.ctx, readQuestion)
    r.owner.mockResolvedValue({ ...reply(r), originServerTs: r.h.clock.now() - 5_000 })
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'answered' })
  })

  it.each([2, 7])('keeps a native request with %i questions in Work', async count => {
    const r = await questions(Array.from({ length: count }, (_, index) => ({ ...answers[0], id: `q-${index}` })))
    expect(await r.relay.question(r.ctx, readQuestion)).toMatchObject({ questionStatus: 'none' })
    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'closed' })
    expect(r.native.mock.calls.some(([, , call]) => call.action === 'respond')).toBe(false)
  })

  it('lets the owner replace a definitively rejected answer while the same native request is pending', async () => {
    const r = await questions()
    await r.relay.question(r.ctx, readQuestion)
    r.h.clock.advance(10)
    r.owner.mockResolvedValue(reply(r))
    const native = r.native.getMockImplementation()!
    let rejected = false
    r.native.mockImplementation(async (token, thread, input) => {
      if (input.action === 'respond' && !rejected) {
        rejected = true
        return { transport: 'ok', isError: true }
      }
      return native(token, thread, input)
    })

    expect(await r.relay.question(r.ctx, r.respond)).toMatchObject({ questionStatus: 'invalid_answer' })
    await r.relay.question(r.ctx, readQuestion)
    expect(await r.relay.status(r.ctx, r.input.room_id)).toMatchObject({
      openOperation: { phase: 'held', hold: 'question_invalid' }
    })
    expect(await r.relay.question(r.ctx, { ...r.respond, event_id: '$new-answer' })).toMatchObject({ questionStatus: 'answered' })
    expect(r.native.mock.calls.filter(([, , call]) => call.action === 'respond')).toHaveLength(2)
  })
})
