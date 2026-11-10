import { afterEach, describe, expect, it, vi } from 'vitest'

import { type AgentSourceGate, type AgentSourceGates, type AgentSourceGateSnapshot } from '../../../../packages/device-protocol/agent-source-gates'

import { MatrixSourceGateSync, readMatrixSourceGatesV2 } from './source-gates'
import { MatrixAccountSourceGates, parseSourceGateSnapshotV2, type SourceGateSnapshotV2, type SourceGateWriteV2 } from './source-gates-v2'
const on = (): AgentSourceGates => ({ google: true, folders: true, messages: true, browser: true, location: true, team_spaces: true })
const snap = (gates: AgentSourceGates, revision = 1): SourceGateSnapshotV2 => ({ authority: 'account', profile: 'atum.agent-source-gates/1', revision, gates })

function harness() {
  let local = { ...on(), messages: false }, remote = snap(on()), merged = false, offline = false, assistants = ['agent']
  let pending: AgentSourceGate[] = []
  const overridden: AgentSourceGate[][] = []
  const applied: AgentSourceGates[] = []

  const write = vi.fn(async (_id: string, input: SourceGateWriteV2) => {
    if (offline) {throw new Error('offline')}
    remote = snap(input.mode === 'set' ? input.gates : Object.fromEntries(Object.entries(remote.gates).map(([key, value]) => [key, value && input.gates[key as keyof AgentSourceGates]])) as AgentSourceGates, remote.revision + 1)

    return remote
  })

  const service = new MatrixAccountSourceGates({ scope: () => ({ accountKey: 'a', generation: 1 }), gates: () => local,
    assistants: async () => assistants, read: async () => { if (offline) {throw new Error('offline');}

 return remote }, write,
    merged: () => merged, markMerged: () => { merged = true }, recordOverridden: gates => { overridden.push(gates) },
    off: gate => { local = { ...local, [gate]: false }; pending = [...new Set([...pending, gate])] },
    pending: () => pending, clearPending: gates => { pending = pending.filter(gate => !gates.includes(gate)) },
    apply: gates => { applied.push(gates); local = gates } })

  return { service, write, applied, overridden, local: () => local, pending: () => pending, merged: () => merged,
    offline: (value: boolean) => { offline = value }, noAssistants: () => { assistants = [] } }
}

afterEach(() => vi.useRealTimers())
describe('account gate takeover', () => {
  it('merges once, records overridden opt-outs, and treats a successful receipt as FINAL', async () => {
    const h = harness()
    h.write.mockImplementation(async (_id, input) => snap(input.mode === 'narrow' ? on() : input.gates))
    await h.service.set('browser', true)
    expect(h.overridden).toEqual([['messages']])
    expect(h.merged()).toBe(true)
    expect(h.local().messages).toBe(true)
    await h.service.set('location', true)
    expect(h.write.mock.calls.filter(call => call[1].mode === 'narrow')).toHaveLength(1)
    expect(h.write.mock.calls.filter(call => call[1].mode === 'set').every(call => call[1].mergeId === undefined)).toBe(true)
  })
  it('turns OFF immediately offline and flushes pending narrowing before any server apply', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.offline(true)
    await h.service.set('browser', false)
    expect(h.local().browser).toBe(false)
    expect(h.pending()).toContain('browser')
    expect(h.applied).toHaveLength(0)
    // Finish the failed background refresh, then reconnect with a stale all-on server.
    await vi.advanceTimersByTimeAsync(0)
    h.offline(false)
    h.service.reconcile()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.pending()).toEqual([])
    expect(h.local().browser).toBe(false)
    expect(h.applied.every(gates => !gates.browser)).toBe(true)
    expect(h.write.mock.calls.some(call => call[1].mode === 'narrow' && !call[1].mergeId && !call[1].gates.browser)).toBe(true)
  })
  it('keeps first-run local toggles working without an assistant', async () => {
    const h = harness(); h.noAssistants()
    await h.service.set('google', false)
    expect(h.local().google).toBe(false)
    await h.service.set('google', true)
    expect(h.local().google).toBe(true)
    expect(h.pending()).toEqual([])
    expect(h.write).not.toHaveBeenCalled()
  })
  it('old reconciler ANDs every input, replays idempotently, and backs off', async () => {
    vi.useFakeTimers()
    let remote = snap({ ...on(), messages: false })
    const receipts = new Map<string, AgentSourceGateSnapshot>()

    const write = vi.fn(async (_id: string, input: { requestId: string; gates: AgentSourceGates }, _signal: AbortSignal) => {
      const receipt = receipts.get(input.requestId)

      if (receipt) {return receipt}
      remote = snap(Object.fromEntries(Object.entries(remote.gates).map(([key, enabled]) => [key, enabled && input.gates[key as AgentSourceGate]])) as AgentSourceGates, remote.revision)
      receipts.set(input.requestId, remote)

      return remote
    })

    const sync = new MatrixSourceGateSync({ scope: () => ({ accountKey: 'a', generation: 1 }), gates: on,
      assistants: async () => ['agent'], read: async () => remote, write })

    sync.reconcile(); await vi.advanceTimersByTimeAsync(0)
    expect(write).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4999); expect(write).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[0]?.[1]).toEqual(write.mock.calls[1]?.[1])
    expect(remote.gates.messages).toBe(false)
    await vi.advanceTimersByTimeAsync(29999); expect(write).toHaveBeenCalledTimes(2)
    sync.stop()
  })
})

it('reads the closed v2 provenance profile and never turns a raw device id into a Mac name', async () => {
  const narrowingDevices = Object.fromEntries(Object.keys(on()).map(gate => [gate, []]))
  narrowingDevices.messages = [{ deviceId: 'RAW-PRIVATE-ID', deviceServiceId: null, deviceName: null, narrowedAt: 123 }]
  const wire = { profile: 'atum.agent-source-gates/2', authority: 'account', gates: { ...on(), messages: false }, revision: 2, narrowingDevices }
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(wire))
  const parsed = await readMatrixSourceGatesV2('https://api.test/api/matrix/v1', 'native-token', '10000000-0000-4000-8000-000000000001', new AbortController().signal, fetchImpl)
  expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Atum-Source-Gates-Profile': '2', Authorization: 'Bearer native-token' })
  expect(parsed.narrowingDevices?.messages[0]?.deviceName).toBeNull()
  expect(() => parseSourceGateSnapshotV2({ ...wire, private: 'unexpected' })).toThrow()
  expect(() => parseSourceGateSnapshotV2({ ...wire, narrowingDevices: { ...narrowingDevices, messages: [{ ...narrowingDevices.messages[0], claimedName: 'Mac' }] } })).toThrow()
})

it('refreshes same-revision server provenance, clears it after set and fences account switches', async () => {
  let scope = { accountKey: 'a', generation: 1 }
  let gates = { ...on(), messages: false }
  const none = () => Object.fromEntries(Object.keys(on()).map(gate => [gate, []])) as NonNullable<SourceGateSnapshotV2['narrowingDevices']>
  let records = none()
  let remote: SourceGateSnapshotV2 = { ...snap(gates, 3), authority: 'account', narrowingDevices: records }

  const changed = vi.fn()

  const service = new MatrixAccountSourceGates({ changed, scope: () => scope, gates: () => gates,
    assistants: async () => ['agent'], read: async () => remote, merged: () => true, markMerged: () => {},
    off: () => {}, pending: () => [], clearPending: () => {}, apply: next => { gates = next },
    write: async (_id, input) => {
      remote = { ...snap(input.gates, 4), authority: 'account', narrowingDevices: none() }

      return snap(input.gates, 4)
    } })

  await service.refreshRead()
  expect(service.heldOff('messages')).toEqual([])
  expect(changed).toHaveBeenCalledTimes(1)
  await service.refreshRead()
  expect(changed).toHaveBeenCalledTimes(1) // No settings read → changed → read loop.
  records = { ...none(), messages: [{ deviceId: 'RAW-ID', deviceServiceId: null, deviceName: 'Other Mac', narrowedAt: 123 }] }
  remote = { ...remote, narrowingDevices: records } // revision stays 3
  await service.refreshRead()
  expect(service.heldOff('messages')).toEqual(['Other Mac'])
  remote = { ...remote, narrowingDevices: { ...records, messages: [{ ...records.messages[0]!, deviceName: null }] } }
  await service.refreshRead()
  expect(service.heldOff('messages')).toEqual([''])
  expect(service.heldOff('messages').join()).not.toContain('RAW-ID')
  await service.set('messages', true)
  expect(service.heldOff('messages')).toEqual([])
  expect(gates.messages).toBe(true)
  gates = { ...gates, messages: false }
  scope = { accountKey: 'b', generation: 2 }
  expect(service.heldOff('messages')).toEqual([])
})

it('does not let a Settings changed-event refresh supersede an explicit set', async () => {
  let gates = { ...on(), browser: false }
  let remote = snap(gates)
  let service!: MatrixAccountSourceGates
  service = new MatrixAccountSourceGates({ scope: () => ({ accountKey: 'a', generation: 1 }), gates: () => gates,
    assistants: async () => ['agent'], read: async () => remote, merged: () => true, markMerged: () => {},
    off: () => {}, pending: () => [], clearPending: () => {}, apply: next => { gates = next },
    changed: () => { void service.refreshRead() }, write: async (_id, input) => { remote = snap(input.gates, 2);

 return remote } })
  await expect(service.set('browser', true)).resolves.toBeUndefined()
  expect(gates.browser).toBe(true)
})

it('fails soft without any v2 merge writes against pre-0427 Shell', async () => {
  const write = vi.fn()

  const service = new MatrixAccountSourceGates({ scope: () => ({ accountKey: 'a', generation: 1 }), gates: on,
    assistants: async () => ['agent'], read: async () => ({ profile: 'atum.agent-source-gates/1', gates: on(), revision: 1 }),
    write, merged: () => false, markMerged: vi.fn(), off: () => {}, pending: () => [], clearPending: () => {}, apply: () => {} })

  await expect(service.set('messages', true)).rejects.toThrow('service update')
  await service.refreshRead()
  await service.refreshRead()
  expect(write).not.toHaveBeenCalled()
  service.stop()
})

it('retries pending OFF only, with the established saturated backoff, and stops when flushed', async () => {
  vi.useFakeTimers()
  let offline = true, pending: AgentSourceGate[] = [], gates = on()

  const read = vi.fn(async () => { if (offline) {throw new Error('offline');}

 return snap(gates) })

  const write = vi.fn(async (_id, input: SourceGateWriteV2) => { gates = input.gates;

 return snap(gates, 2) })

  const service = new MatrixAccountSourceGates({ scope: () => ({ accountKey: 'a', generation: 1 }), gates: () => gates,
    assistants: async () => ['agent'], read, write, merged: () => true, markMerged: () => {},
    off: gate => { gates = { ...gates, [gate]: false }; pending = [gate] }, pending: () => pending,
    clearPending: () => { pending = [] }, apply: value => { gates = value } })

  await service.set('messages', false)
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(4_999); expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2)

  for (const [delay, count] of [[30_000, 3], [120_000, 4], [600_000, 5], [1_800_000, 6]] as const) {
    await vi.advanceTimersByTimeAsync(delay); expect(read).toHaveBeenCalledTimes(count)
  }

  expect(gates.messages).toBe(false)
  offline = false
  await vi.advanceTimersByTimeAsync(1_800_000)
  expect(pending).toEqual([])
  expect(write).toHaveBeenCalledOnce()
  const count = read.mock.calls.length
  await vi.advanceTimersByTimeAsync(1_800_000)
  expect(read).toHaveBeenCalledTimes(count)
  service.stop()
})
