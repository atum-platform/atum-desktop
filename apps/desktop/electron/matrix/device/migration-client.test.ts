import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MigrationReport } from '../../../../../packages/device-protocol/migration-messages'

import type { DeviceConnection, DeviceSession } from './connection'
import { DesktopHomeMigration, type MigrationLocalAgent } from './migration-client'
import { MigrationWriterHolds } from './migration-hold'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) {rmSync(directory, { recursive: true, force: true })} })

function fixture(bytes = Buffer.from('synthetic home archive')) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migration-client-'))
  directories.push(dir)
  const archive = path.join(dir, 'home.archive')
  writeFileSync(archive, bytes, { mode: 0o600 })
  let now = Date.now(), current = true, home = true, writable = true
  const values = new Map<string, string>()

  const store = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, failureCode: () => null }

  const holds = new MigrationWriterHolds({ ownerUserId: '@owner:example.test', store, wallNow: () => now, monotonicNow: () => now })

  let session: DeviceSession = { connectionId: randomUUID(), connectionEpoch: 1, localGeneration: 1,
    deviceServiceId: randomUUID(), enrollmentEpoch: 1, accountEpoch: 1 }

  const sent: Array<{ type: string; body: Record<string, unknown> }> = []
  const chunks: Array<{ migrationId: string; offset: number; size: number; bytes: Buffer }> = []

  const connection = {
    session: () => session,
    send: vi.fn(async (type: string, body: Record<string, unknown>) => { sent.push({ type, body });

 return true }),
    sendMigrationChunk: vi.fn((bound: DeviceSession, header: { migrationId: string; offset: number; size: number }, data: Buffer) => {
      if (bound !== session || !writable) {return false}
      chunks.push({ ...header, bytes: Buffer.from(data) })

      return true
    })
  }

  const agent: MigrationLocalAgent = { principal: randomUUID(), userId: '@agent:example.test', current: () => current, hasHome: () => home,
    quiesce: vi.fn(async () => { expect(holds.held(agent.principal)).toBe(true) }),
    snapshot: vi.fn(async () => ({ archive, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, files: 1 })),
    restore: vi.fn(async () => { expect(holds.held(agent.principal)).toBe(false) }), switchToCloud: vi.fn(async () => {}) }

  const confirm = vi.fn(async () => ({ drop: [], takeOther: [] }))

  const client = new DesktopHomeMigration({ connection: () => connection as unknown as DeviceConnection, holds,
    agent: (principal, userId) => principal === agent.principal && userId === agent.userId ? agent : null,
    confirm, changed: vi.fn(), now: () => now })

  const frame = (type: Parameters<typeof client.frame>[0], body: unknown, bound = session) => client.frame(type, body as Record<string, unknown>, bound)
  const offers = () => sent.filter(frame => frame.type === 'MigrationOffer')

  const start = async () => {
    const abort = new AbortController(), outcome = client.start(agent, abort.signal)
    await vi.waitFor(() => expect(offers()).toHaveLength(1))
    const id = offers()[0]!.body.migrationId as string

    return { abort, outcome, id }
  }

  const upload = async (id: string) => {
    frame('MigrationAck', { migrationId: id, deviceServiceId: session.deviceServiceId, outcome: 'send', holdUntil: now + 5_400_000 })
    await vi.waitFor(() => expect(chunks.reduce((total, chunk) => total + chunk.size, 0)).toBe(bytes.length))
    frame('MigrationAck', { migrationId: id, deviceServiceId: session.deviceServiceId, outcome: 'staged',
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }

  const report = (id: string): MigrationReport => ({ migrationId: id, agentPrincipal: agent.principal,
    snapshots: [{ deviceServiceId: session.deviceServiceId, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, files: 1 }],
    missing: [], report: null, reportSha256: null, issuedAt: now, expiresAt: now + 60_000, holdUntil: now + 5_400_000 })

  return { client, agent, holds, frame, start, upload, report, confirm, sent, chunks, offers, connection,
    session: () => session, advance(ms: number) { now += ms }, home(value: boolean) { home = value },
    current(value: boolean) { current = value }, writable(value: boolean) { writable = value },
    reconnect() { const old = session; session = { ...old, connectionId: randomUUID(), connectionEpoch: old.connectionEpoch + 1 }; client.closed(old, 'drop');

 return old } }
}

describe('desktop migration snapshot lifecycle', () => {
  it('uploads only after current-device admission and switches only after owner approval and generation one', async () => {
    const f = fixture(), move = await f.start()
    expect(f.chunks).toEqual([])
    f.frame('MigrationAck', { migrationId: move.id, deviceServiceId: randomUUID(), outcome: 'send', holdUntil: Date.now() + 5_400_000 })
    expect(f.chunks).toEqual([])
    await f.upload(move.id)
    expect(Buffer.concat(f.chunks.map(chunk => chunk.bytes)).toString()).toBe('synthetic home archive')
    f.frame('MigrationReport', f.report(move.id))
    await vi.waitFor(() => expect(f.sent.filter(frame => frame.type === 'MigrationChoose')).toHaveLength(1))
    expect(f.agent.switchToCloud).not.toHaveBeenCalled()
    f.frame('MigrationResult', { migrationId: move.id, agentPrincipal: f.agent.principal, outcome: 'committed', homeGeneration: 1, manifestSha256: 'a'.repeat(64) })
    expect(await move.outcome).toMatchObject({ state: 'moved', staged: true })
    expect(f.agent.switchToCloud).toHaveBeenCalledOnce()
    expect(f.holds.held(f.agent.principal)).toBe(true)
    expect(f.agent.restore).not.toHaveBeenCalled()
  })

  it('rejects a changed report and does not interpret an unsolicited commit as owner approval', async () => {
    const f = fixture(), move = await f.start()
    await f.upload(move.id)
    const report = f.report(move.id)
    report.snapshots[0].sha256 = 'f'.repeat(64)
    f.frame('MigrationReport', report)
    expect(f.confirm).not.toHaveBeenCalled()
    f.frame('MigrationResult', { migrationId: move.id, agentPrincipal: f.agent.principal, outcome: 'committed', homeGeneration: 1, manifestSha256: 'a'.repeat(64) })
    expect(f.agent.switchToCloud).not.toHaveBeenCalled()
    expect(f.holds.held(f.agent.principal)).toBe(true)
  })

  it('finishes an approved commit even when cancellation raced its authoritative result', async () => {
    const f = fixture(), move = await f.start()
    await f.upload(move.id)
    f.frame('MigrationReport', f.report(move.id))
    await vi.waitFor(() => expect(f.sent.filter(frame => frame.type === 'MigrationChoose')).toHaveLength(1))
    move.abort.abort()
    expect(await move.outcome).toMatchObject({ state: 'cancelled' })
    f.frame('MigrationResult', { migrationId: move.id, agentPrincipal: f.agent.principal, outcome: 'refused', reason: 'wrong_state' })
    const committed = { migrationId: move.id, agentPrincipal: f.agent.principal, outcome: 'committed', homeGeneration: 1, manifestSha256: 'a'.repeat(64) }
    f.frame('MigrationResult', committed)
    await vi.waitFor(() => expect(f.agent.switchToCloud).toHaveBeenCalledOnce())
    f.frame('MigrationResult', committed)
    expect(f.agent.switchToCloud).toHaveBeenCalledOnce()
    expect(f.holds.held(f.agent.principal)).toBe(true)
  })

  it('cancels an out-of-window admission before bytes or an unbounded writer hold', async () => {
    const f = fixture(), move = await f.start(), deadline = f.holds.deadline(move.id)
    f.frame('MigrationAck', { migrationId: move.id, deviceServiceId: f.session().deviceServiceId, outcome: 'send', holdUntil: Date.now() + 10 * 365 * 86_400_000 })
    expect(await move.outcome).toMatchObject({ state: 'cancelled' })
    expect(f.holds.deadline(move.id)).toBe(deadline)
    expect(f.chunks).toEqual([])
    f.advance(5_400_000 + 30_001)
    expect(f.holds.held(f.agent.principal)).toBe(false)
  })

  it('bounds a stalled upload and keeps the hold until cancellation is definitive', async () => {
    const f = fixture(), move = await f.start()
    f.writable(false)
    f.frame('MigrationAck', { migrationId: move.id, deviceServiceId: f.session().deviceServiceId, outcome: 'send', holdUntil: f.report(move.id).holdUntil })
    await vi.waitFor(() => expect(f.connection.sendMigrationChunk).toHaveBeenCalled())
    f.advance(15_001)
    expect(await move.outcome).toMatchObject({ state: 'cancelled' })
    expect(f.chunks).toEqual([])
    expect(f.holds.held(f.agent.principal)).toBe(true)
  })

  it('a cancelled upload remains held through a refused cancel until a definitive terminal result', async () => {
    const f = fixture(), move = await f.start()
    await f.upload(move.id)
    move.abort.abort()
    expect(await move.outcome).toMatchObject({ state: 'cancelled' })
    expect(f.holds.held(f.agent.principal)).toBe(true)
    f.frame('MigrationResult', { migrationId: move.id, agentPrincipal: f.agent.principal, outcome: 'refused', reason: 'wrong_state' })
    expect(f.agent.restore).not.toHaveBeenCalled()
    f.frame('MigrationResult', { migrationId: move.id, agentPrincipal: f.agent.principal, outcome: 'failed', reason: 'commit_failed' })
    await vi.waitFor(() => expect(f.agent.restore).toHaveBeenCalledOnce())
    expect(f.holds.held(f.agent.principal)).toBe(false)
  })

  it('never reoffers a fully transmitted archive when its staged acknowledgement was lost', async () => {
    const f = fixture(), move = await f.start()
    await f.upload(move.id)
    f.reconnect()
    await f.client.tick()
    expect(f.offers()).toHaveLength(1)
    expect(f.holds.held(f.agent.principal)).toBe(true)
  })

  it('reoffers a partial upload on a new session with the same migration and no stale-session bytes', async () => {
    const f = fixture(Buffer.alloc(2_000_000, 7)), move = await f.start()
    f.writable(false)
    f.frame('MigrationAck', { migrationId: move.id, deviceServiceId: f.session().deviceServiceId, outcome: 'send', holdUntil: f.report(move.id).holdUntil })
    await vi.waitFor(() => expect(f.connection.sendMigrationChunk).toHaveBeenCalled())
    const old = f.reconnect()
    await vi.waitFor(async () => { await f.client.tick(); expect(f.offers()).toHaveLength(2) })
    expect(f.offers()[1]!.body.migrationId).toBe(move.id)
    expect(f.offers()[1]!.body.connectionId).not.toBe(old.connectionId)
    f.frame('MigrationAck', { migrationId: move.id, deviceServiceId: old.deviceServiceId, outcome: 'send', holdUntil: Date.now() + 5_400_000 }, old)
    expect(f.chunks).toEqual([])
    f.writable(true)
    await f.upload(move.id)
    expect(f.chunks[0]!.offset).toBe(0)
  })

  it('no admission acknowledgement times out before any bytes are sent and releases the unused snapshot', async () => {
    const f = fixture(), move = await f.start()
    f.advance(15_001)
    await f.client.tick()
    expect(await move.outcome).toMatchObject({ state: 'failed', code: 'matrix_migration_admission_timeout' })
    expect(f.agent.restore).toHaveBeenCalledOnce()
    f.frame('MigrationAck', { migrationId: move.id, deviceServiceId: f.session().deviceServiceId, outcome: 'send', holdUntil: Date.now() + 5_400_000 })
    expect(f.chunks).toEqual([])
  })

  it('participant requests bind owner, agent, target, session and epoch before quiescing', async () => {
    const f = fixture(), s = f.session(), now = Date.now(), id = randomUUID()

    const request = { migrationId: id, agentPrincipal: f.agent.principal, agentUserId: f.agent.userId,
      initiatorDeviceServiceId: randomUUID(), targetDeviceServiceId: s.deviceServiceId, connectionId: s.connectionId,
      accountEpoch: s.accountEpoch, enrollmentEpoch: s.enrollmentEpoch, issuedAt: now, expiresAt: now + 60_000, holdUntil: now + 5_400_000 }

    for (const changed of [{ agentUserId: '@other:example.test' }, { targetDeviceServiceId: randomUUID() },
      { connectionId: randomUUID() }, { accountEpoch: 2 }, { expiresAt: now - 31_000 }]) {f.frame('MigrationRequest', { ...request, ...changed })}

    expect(f.agent.quiesce).not.toHaveBeenCalled()
    f.frame('MigrationRequest', request)
    await vi.waitFor(() => expect(f.offers()).toHaveLength(1))
    expect(f.offers()[0]!.body).toMatchObject({ migrationId: id, role: 'participant' })
    expect(f.agent.quiesce).toHaveBeenCalledOnce()
    f.frame('MigrationRequest', request)
    expect(f.agent.quiesce).toHaveBeenCalledOnce()
  })
})
