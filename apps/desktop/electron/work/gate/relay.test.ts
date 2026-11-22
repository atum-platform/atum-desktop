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
    consent: () => ({
      provider: 'codex',
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
    history: { read: history },
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
  it('history failure admits nothing; retry claims once', async () => {
    const r = rig()
    r.history.mockRejectedValueOnce(new Error('crash'))
    expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'none' })
    expect(r.h.ledger.receipt(LUNA, REQ_1)).toBeUndefined()
    expect(await r.relay.send(r.ctx, r.input)).toMatchObject({ class: 'accepted' })
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
    const first = await r.relay.read(r.ctx, REQ_1)
    expect(first).toMatchObject({ class: 'completed', answer: { text: 'frozen', itemId: 'final' } })
    if (process.env.ATUM_RELAY_PROTOCOL) {
      const protocol = await import(/* @vite-ignore */ process.env.ATUM_RELAY_PROTOCOL)
      expect(protocol.WorkRelayReceiptSchema.parse(first)).toEqual(first)
    }
    expect(await r.relay.read(r.ctx, REQ_1)).toEqual(first)
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
    expect(await r.relay.read(r.ctx, request_id)).toMatchObject({ class: 'completed' })
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
  expect(await r.relay.read(r.ctx, REQ_1)).toMatchObject({
    class: 'completed',
    answer: { runId: 'recovered', text: 'retained' }
  })
  expect(r.launch).toHaveBeenCalledTimes(1)
})
