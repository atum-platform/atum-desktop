import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ConversationUnavailableError, EarlierConversationError } from '../../shared/agent-conversation'
import type { MatrixTurnLookup } from '../../shared/matrix'
import { EncryptedStore } from '../encrypted-store'

import {
  MATRIX_CRON_PENDING_KEY,
  MATRIX_CRON_STRANDED,
  MatrixCronDelivery,
  type MatrixCronDeliveryDeps,
  type MatrixCronGateway,
  type MatrixCronPost,
  parseCronDeliveryRequest
} from './cron-delivery'

const runId = '00000000-0000-4000-8000-61f1dcf0c470'
const executionId = runId.replaceAll('-', '')

const payload = {
  request_id: 'a1b2c3d4',
  platform: 'matrix',
  room_id: '!alfred:atum.test',
  text: 'Cronjob Response: Morning brief',
  job_id: 'brief',
  execution_id: executionId
}

function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))

  return {
    map,
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void map.set(key, value))
  }
}

const pending = (vault: ReturnType<typeof store>): MatrixCronPost[] =>
  JSON.parse(vault.map.get(MATRIX_CRON_PENDING_KEY) ?? '[]')

function delivery(overrides: Partial<MatrixCronDeliveryDeps> = {}) {
  const vault = store()

  const deps = {
    store: vault,
    requireRoom: vi.fn(async () => {}),
    authorizeManaged: vi.fn(async () => {}),
    publish: vi.fn(async () => '$brief'),
    find: vi.fn(async (): Promise<MatrixTurnLookup> => ({ state: 'absent' })),
    now: () => 1_000,
    log: vi.fn(),
    ...overrides
  }

  return { vault, deps, cron: new MatrixCronDelivery(deps) }
}

describe('scheduled results into rooms', () => {
  it('reads a request as Hermes sends it, and nothing else', () => {
    expect(parseCronDeliveryRequest(payload)).toEqual({
      requestId: 'a1b2c3d4',
      roomId: '!alfred:atum.test',
      text: payload.text,
      jobId: 'brief',
      runId
    })

    for (const change of [
      { platform: 'telegram' },
      { room_id: 'alfred' },
      { text: '   ' },
      { job_id: '' },
      { execution_id: 'run-1' },
      { request_id: 'not hex' }
    ]) {
      expect(parseCronDeliveryRequest({ ...payload, ...change })).toBeNull()
    }

    expect(parseCronDeliveryRequest(null)).toBeNull()
  })

  it("posts once as the agent into the agent's own room, then forgets the record", async () => {
    const { cron, deps, vault } = delivery()
    const receipt = await cron.deliver(parseCronDeliveryRequest(payload)!)

    expect(receipt).toEqual({ status: 'delivered', event_id: '$brief' })
    expect(deps.requireRoom).toHaveBeenCalledWith('!alfred:atum.test')
    expect(deps.publish).toHaveBeenCalledWith({ roomId: '!alfred:atum.test', text: payload.text, jobId: 'brief', runId, since: 1_000 })
    expect(pending(vault)).toEqual([])
  })

  it('seals a background offer without publishing until platform admission', async () => {
    const { cron, deps, vault } = delivery()
    const request = parseCronDeliveryRequest(payload)!
    const sealed = await cron.seal(request)

    expect(sealed.outboxId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u)
    expect(sealed.bodySha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(deps.publish).not.toHaveBeenCalled()
    expect(pending(vault)).toEqual([
      expect.objectContaining({ runId, held: true, outboxId: sealed.outboxId, bodySha256: sealed.bodySha256 })
    ])

    await cron.resume()
    expect(deps.find).not.toHaveBeenCalled()
    expect(deps.publish).not.toHaveBeenCalled()

    await expect(cron.admit(runId)).resolves.toEqual({ status: 'delivered', event_id: '$brief' })
    expect(deps.publish).toHaveBeenCalledOnce()
    expect(pending(vault)).toEqual([])
  })

  it('persists admission before a failed send so restart recovery uses read-back', async () => {
    const publish = vi.fn(async (): Promise<string> => Promise.reject(new Error('matrix_send_pending')))
    const first = delivery({ publish })
    await first.cron.seal(parseCronDeliveryRequest(payload)!)
    await first.cron.admit(runId)
    expect(pending(first.vault)[0]).not.toHaveProperty('held')

    const resumed = delivery({
      store: first.vault,
      find: vi.fn(async (): Promise<MatrixTurnLookup> => ({ state: 'found', eventId: '$already' }))
    })

    await resumed.cron.resume()
    expect(resumed.deps.publish).not.toHaveBeenCalled()
    expect(pending(first.vault)).toEqual([])
  })

  it('replays only identical sealed bytes and discards a suppressed offer', async () => {
    const { cron, deps, vault } = delivery()
    const request = parseCronDeliveryRequest(payload)!
    const first = await cron.seal(request)
    await expect(cron.seal(request)).resolves.toEqual(first)
    await expect(cron.seal({ ...request, text: 'changed' })).rejects.toThrow('matrix_cron_seal_conflict')
    expect(deps.publish).not.toHaveBeenCalled()

    await cron.discard(runId)
    expect(pending(vault)).toEqual([])
  })

  it('refuses any other room without posting or keeping anything', async () => {
    const { cron, deps, vault } = delivery({ requireRoom: vi.fn(async () => Promise.reject(new Error('matrix_denied'))) })

    expect(await cron.deliver(parseCronDeliveryRequest(payload)!)).toEqual({ status: 'failed', error: "not this agent's room" })
    expect(deps.publish).not.toHaveBeenCalled()
    expect(vault.map.has(MATRIX_CRON_PENDING_KEY)).toBe(false)
  })

  it('keeps the record while it cannot be sure, and resumes by reading the room first', async () => {
    const publish = vi.fn(async (): Promise<string> => Promise.reject(new Error('matrix_send_pending')))
    const find = vi.fn(async (): Promise<MatrixTurnLookup> => ({ state: 'absent' }))
    const { cron, vault } = delivery({ publish, find })

    expect(await cron.deliver(parseCronDeliveryRequest(payload)!)).toEqual({ status: 'failed', error: 'matrix_send_pending' })
    expect(pending(vault).map(post => post.runId)).toEqual([runId])

    // The next start: the post did land, so it is not posted again.
    find.mockResolvedValueOnce({ state: 'found', eventId: '$brief' })
    await cron.resume()
    expect(publish).toHaveBeenCalledOnce()
    expect(pending(vault)).toEqual([])
  })

  it('posts on resume only when the room proves the post absent', async () => {
    const vault = store({
      [MATRIX_CRON_PENDING_KEY]: JSON.stringify([{ roomId: '!alfred:atum.test', text: 'x', jobId: 'brief', runId, since: 900 }])
    })

    // Unknown: never re-sent, kept for the next resume.
    const unknown = delivery({ store: vault, find: vi.fn(async (): Promise<MatrixTurnLookup> => ({ state: 'unknown' })) })
    await unknown.cron.resume()
    expect(unknown.deps.publish).not.toHaveBeenCalled()
    expect(pending(vault)).toHaveLength(1)

    // Absent: posted, then forgotten.
    const absent = delivery({ store: vault })
    await absent.cron.resume()
    expect(absent.deps.publish).toHaveBeenCalledOnce()
    expect(pending(vault)).toEqual([])
  })

  it('drops what no retry can fix, and what is a day old', async () => {
    const invalid = delivery({ publish: vi.fn(async (): Promise<string> => Promise.reject(new Error('matrix_encrypted_room_required'))) })
    await invalid.cron.deliver(parseCronDeliveryRequest(payload)!)
    expect(pending(invalid.vault)).toEqual([])

    const vault = store({
      [MATRIX_CRON_PENDING_KEY]: JSON.stringify([{ roomId: '!alfred:atum.test', text: 'x', jobId: 'brief', runId, since: 0 }])
    })

    const stale = delivery({ store: vault, now: () => 25 * 60 * 60_000 })
    await stale.cron.resume()
    expect(stale.deps.find).not.toHaveBeenCalled()
    expect(pending(vault)).toEqual([])
    expect(stale.deps.log).toHaveBeenCalledWith(`[Matrix] cron post dropped run=${runId.slice(0, 8)} reason=expired`)
  })

  it('answers a malformed request at once, so Hermes never waits it out', async () => {
    let handler: ((event: { payload?: unknown }) => void) | undefined
    const request = vi.fn(async () => ({ status: 'ok' }))

    const gateway = {
      on: vi.fn((_type: string, next: (event: { payload?: unknown }) => void) => {
        handler = next

        return () => {}
      }),
      request
    }

    const { cron, deps } = delivery()
    cron.listen(gateway as unknown as MatrixCronGateway)
    handler!({ payload: { ...payload, execution_id: 'run-1' } })
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(request).toHaveBeenCalledWith(
      'cron.delivery.respond',
      { request_id: 'a1b2c3d4', result: JSON.stringify({ status: 'failed', error: 'malformed request' }) },
      10_000
    )
    expect(deps.publish).not.toHaveBeenCalled()

    // Without even a request ID there is nothing to answer.
    handler!({ payload: { platform: 'matrix' } })
    await Promise.resolve()
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps pending posts in memory when the vault cannot be written', async () => {
    const vault = store()
    vault.setItem.mockImplementation(() => {
      throw new Error('auth_storage_unavailable')
    })
    const publish = vi.fn(async (): Promise<string> => Promise.reject(new Error('matrix_send_pending')))
    const find = vi.fn(async (): Promise<MatrixTurnLookup> => ({ state: 'found', eventId: '$brief' }))
    const { cron, deps } = delivery({ store: vault, publish, find })

    expect(await cron.deliver(parseCronDeliveryRequest(payload)!)).toEqual({ status: 'failed', error: 'matrix_send_pending' })
    expect(deps.log).toHaveBeenCalledWith('[Matrix] cron pending record not saved: vault_unavailable')

    // Later in the same run the agent can post again: the record is still here.
    await cron.resume()
    expect(find).toHaveBeenCalledOnce()
  })

  it('logs every post it drops, by run', async () => {
    const posts = Array.from({ length: 33 }, (_, index) => ({
      roomId: '!alfred:atum.test',
      text: 'x',
      jobId: 'brief',
      runId: `9f1c2d3e-4b5a-46c7-a8b9-${String(index).padStart(12, '0')}`,
      since: 900
    }))

    const vault = store({ [MATRIX_CRON_PENDING_KEY]: JSON.stringify(posts.slice(0, 32)) })
    const { cron, deps } = delivery({ store: vault })

    await cron.deliver(parseCronDeliveryRequest(payload)!)
    expect(deps.log).toHaveBeenCalledWith('[Matrix] cron post dropped run=9f1c2d3e reason=too_many_pending')
  })

  it('answers each request on the backend connection with its receipt', async () => {
    let handler: ((event: { payload?: unknown }) => void) | undefined
    const request = vi.fn(async () => ({ status: 'ok' }))

    const gateway = {
      on: vi.fn((_type: string, next: (event: { payload?: unknown }) => void) => {
        handler = next

        return () => {}
      }),
      request
    }

    const { cron } = delivery()
    cron.listen(gateway as unknown as MatrixCronGateway)
    expect(gateway.on).toHaveBeenCalledWith('cron.delivery.request', expect.any(Function))
    handler!({ payload })
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(request).toHaveBeenCalledWith(
      'cron.delivery.respond',
      { request_id: 'a1b2c3d4', result: JSON.stringify({ status: 'delivered', event_id: '$brief' }) },
      10_000
    )

    // Not a Matrix delivery: refused at once, never posted.
    handler!({ payload: { ...payload, platform: 'slack' } })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(request.mock.calls[1]).toEqual([
      'cron.delivery.respond',
      { request_id: 'a1b2c3d4', result: JSON.stringify({ status: 'failed', error: 'malformed request' }) },
      10_000
    ])
  })
})

describe("another agent's scheduled posts", () => {
  it('keeps its pending list in its own scope of one vault', async () => {
    const root = new EncryptedStore(join(mkdtempSync(join(tmpdir(), 'cron-')), 'vault.json'), {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    })

    const alfredStore = root.scope('agent:alfred-principal:')
    const publish = vi.fn(async (): Promise<string> => Promise.reject(new Error('matrix_send_pending')))

    const other = new MatrixCronDelivery({
      store: alfredStore,
      requireRoom: vi.fn(async () => {}),
    authorizeManaged: vi.fn(async () => {}),
      publish,
      find: vi.fn(async (): Promise<MatrixTurnLookup> => ({ state: 'absent' })),
      now: () => 1_000,
      log: vi.fn()
    })

    await other.deliver(parseCronDeliveryRequest(payload)!)
    expect(root.getItem(MATRIX_CRON_PENDING_KEY)).toBeNull()
    expect(JSON.parse(alfredStore.getItem(MATRIX_CRON_PENDING_KEY)!)).toHaveLength(1)
  })
})


it('refuses an Earlier scheduled post before recording or publishing it', async () => {
  const { cron, deps, vault } = delivery({ requireRoom: vi.fn(async () => { throw new EarlierConversationError(payload.room_id, '!main:test') }) })
  await expect(cron.deliver(parseCronDeliveryRequest(payload)!)).resolves.toEqual({ status: 'failed', error: 'matrix_earlier_conversation' })
  expect(deps.publish).not.toHaveBeenCalled()
  expect(pending(vault)).toEqual([])
})

it.each([['earlier', false], ['unavailable', true]] as const)('revalidates a pending %s room before cron retry', async (kind, keep) => {
  const { cron, deps, vault } = delivery({ publish: vi.fn(async () => { throw new Error('matrix_send_failed') }) })
  await cron.deliver(parseCronDeliveryRequest(payload)!)
  vi.mocked(deps.publish).mockClear()
  vi.mocked(deps.requireRoom).mockRejectedValue(kind === 'earlier' ? new EarlierConversationError(payload.room_id, '!main:test') : new ConversationUnavailableError())
  await cron.resume()
  expect(deps.publish).not.toHaveBeenCalled()
  expect(pending(vault)).toHaveLength(keep ? 1 : 0)
})

describe('managed occurrence durability in the same outbox', () => {
  const occurrence = { assistantId: 'assistant', executorId: 'executor', occurrenceId: runId, computeSeconds: 1, home: { homeId: 'home', homeEpoch: 1, executorTerm: 1, leaseId: 'lease' } }
  const request = parseCronDeliveryRequest(payload)!

  it('persists before publish and retains settled receipts across restart', async () => {
    const settleManaged = vi.fn(async () => {})
    const { cron, deps, vault } = delivery({ settleManaged })
    vi.mocked(deps.publish).mockImplementation(async () => {
      expect(pending(vault)[0]?.occurrence).toEqual(occurrence)

      return '$brief'
    })
    await Promise.all([cron.deliverManaged(request, occurrence), cron.deliverManaged(request, occurrence)])
    await new MatrixCronDelivery(deps).resume()
    expect(deps.publish).toHaveBeenCalledTimes(1)
    expect(settleManaged).toHaveBeenCalledTimes(1)
    expect(pending(vault)[0]?.settled).toBe(true)
  })

  it('recovers a crash after persist without replaying a model run', async () => {
    const settleManaged = vi.fn(async () => {})
    const { cron, deps, vault } = delivery({ settleManaged })
    vi.mocked(deps.publish).mockRejectedValueOnce(new Error('crash'))
    await expect(cron.deliverManaged(request, occurrence)).rejects.toThrow('managed_delivery_pending')
    expect(pending(vault)).toHaveLength(1)
    await new MatrixCronDelivery(deps).resume()
    expect(settleManaged).toHaveBeenCalledTimes(1)
  })

  it('reads back publication after a crash before persisting its receipt', async () => {
    const settleManaged = vi.fn(async () => {})
    const { cron, deps, vault } = delivery({ settleManaged })
    vi.mocked(deps.publish).mockImplementation(async () => {
      vi.mocked(deps.find).mockResolvedValue({ state: 'found', eventId: '$brief' })
      vault.setItem.mockImplementation(() => { throw new Error('disk') })

      return '$brief'
    })
    await expect(cron.deliverManaged(request, occurrence)).rejects.toThrow('managed_delivery_pending')
    vault.setItem.mockImplementation((key, value) => { vault.map.set(key, value) })
    await new MatrixCronDelivery(deps).resume()
    expect(deps.publish).toHaveBeenCalledTimes(1)
    expect(settleManaged).toHaveBeenCalledTimes(1)
  })

  it('does not publish or acknowledge when the initial durable write fails', async () => {
    const { cron, deps, vault } = delivery({ settleManaged: vi.fn() })
    vault.setItem.mockImplementation(() => { throw new Error('disk') })
    await expect(cron.deliverManaged(request, occurrence)).rejects.toThrow('matrix_cron_vault_unavailable')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('retries only settlement and preserves old pending managed posts', async () => {
    const settleManaged = vi.fn().mockRejectedValueOnce(new Error('lost receipt')).mockResolvedValue(undefined)
    const { cron, deps, vault } = delivery({ settleManaged })
    await expect(cron.deliverManaged(request, occurrence)).rejects.toThrow('managed_delivery_pending')
    await new MatrixCronDelivery({ ...deps, now: () => 10 ** 12 }).resume()
    expect(deps.publish).toHaveBeenCalledTimes(1)
    expect(settleManaged).toHaveBeenCalledTimes(2)
    expect(pending(vault)[0]?.settled).toBe(true)
  })
  it('refuses a new publish after authority loss, keeping the persisted result', async () => {
    const { cron, deps, vault } = delivery({ settleManaged: vi.fn(),
      authorizeManaged: vi.fn(async () => { throw new Error('lease_lost') }) })

    await expect(cron.deliverManaged(request, occurrence)).rejects.toThrow('managed_delivery_pending')
    expect(deps.publish).not.toHaveBeenCalled()
    expect(pending(vault)).toHaveLength(1)
  })

  it('answers native delivery failure when the vault cannot persist it', async () => {
    const { cron, vault } = delivery({ settleManaged: vi.fn() })
    vault.setItem.mockImplementation(() => { throw new Error('disk') })
    let listener: ((event: { payload?: unknown }) => void) | undefined
    const reply = vi.fn(async () => ({}))

    const gateway = { on: (_type: string, fn: typeof listener) => { listener = fn;

 return () => {} }, request: reply } as MatrixCronGateway

    cron.listen(gateway, occurrence)
    listener!({ payload })
    await vi.waitFor(() => expect(reply).toHaveBeenCalled())
    expect(reply.mock.calls[0]).toEqual(['cron.delivery.respond', {
      request_id: payload.request_id, result: JSON.stringify({ status: 'failed', error: 'durable_delivery_unavailable' })
    }, 10_000])
  })

  // Coordinator decision 2026-11-01: only the home that ran an occurrence publishes it, a drain is bounded, and
  // one stuck record never blocks anything else.
  it('never publishes output stranded by another home, and never retries it', async () => {
    const settleManaged = vi.fn(async () => {})
    const authorizeManaged = vi.fn(async () => { throw new Error(MATRIX_CRON_STRANDED) })
    const { cron, deps, vault } = delivery({ settleManaged, authorizeManaged })
    await expect(cron.deliverManaged(request, occurrence)).rejects.toThrow('managed_delivery_pending')
    expect(pending(vault)[0]).toMatchObject({ stranded: true })
    await new MatrixCronDelivery(deps).resume()
    await expect(new MatrixCronDelivery(deps).resumeManaged(new AbortController().signal)).resolves.toEqual({ left: 0 })
    // A repeated host request for the same run is refused, not published.
    await expect(new MatrixCronDelivery(deps).deliverManaged(request, occurrence)).rejects.toThrow('managed_delivery_pending')
    expect(authorizeManaged).toHaveBeenCalledTimes(1)
    expect(deps.publish).not.toHaveBeenCalled()
    expect(settleManaged).not.toHaveBeenCalled()
  })

  it('strands a record its home cannot settle within a day, and prunes finished records after the replay window', async () => {
    let now = 1_000

    const { deps, vault } = delivery({ settleManaged: vi.fn(), now: () => now,
      authorizeManaged: vi.fn(async () => { throw new Error('mac_job_not_home') }) })

    vault.map.set(MATRIX_CRON_PENDING_KEY, JSON.stringify([{ roomId: payload.room_id, text: 'saved', jobId: 'brief', runId, since: 1_000, occurrence }]))
    await new MatrixCronDelivery(deps).resume()
    expect(pending(vault)[0]?.stranded).toBeUndefined()
    now += 24 * 60 * 60_000
    await new MatrixCronDelivery(deps).resume()
    expect(pending(vault)[0]?.stranded).toBe(true)
    now += 48 * 60 * 60_000
    await new MatrixCronDelivery(deps).resume()
    expect(pending(vault)).toEqual([])
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('keeps resuming unmanaged posts past a managed record that cannot settle, backing off its retries', async () => {
    const authorizeManaged = vi.fn(async () => { throw new Error('mac_job_not_home') })
    const { deps, vault } = delivery({ settleManaged: vi.fn(), authorizeManaged })
    const legacyRun = '00000000-0000-4000-8000-3c7615a59429'
    vault.map.set(MATRIX_CRON_PENDING_KEY, JSON.stringify([
      { roomId: payload.room_id, text: 'saved', jobId: 'brief', runId, since: 1_000, occurrence },
      { roomId: payload.room_id, text: 'legacy', jobId: 'other', runId: legacyRun, since: 1_000 }
    ]))
    const cron = new MatrixCronDelivery(deps)
    await expect(cron.resume()).resolves.toBeUndefined()
    await cron.resume()
    expect(authorizeManaged).toHaveBeenCalledTimes(1)
    expect(deps.publish).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.publish).mock.calls[0]?.[0]).toMatchObject({ runId: legacyRun })
  })

  it('bounds a drain by its deadline and answers what is left instead of rejecting', async () => {
    const deadline = new AbortController()

    const authorizeManaged = vi.fn((_post: MatrixCronPost, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      setTimeout(() => deadline.abort(), 5)
    }))

    const { deps, vault } = delivery({ settleManaged: vi.fn(), authorizeManaged })
    vault.map.set(MATRIX_CRON_PENDING_KEY, JSON.stringify([{ roomId: payload.room_id, text: 'saved', jobId: 'brief', runId, since: 1_000, occurrence }]))
    await expect(new MatrixCronDelivery(deps).resumeManaged(deadline.signal)).resolves.toEqual({ left: 1 })
    expect(deps.publish).not.toHaveBeenCalled()
    expect(pending(vault)[0]?.stranded).toBeUndefined()
  })

  it('reads an unmanaged-only outbox as leniently as before, but never drops a malformed managed record', async () => {
    const { deps, vault } = delivery({ settleManaged: vi.fn() })
    vault.map.set(MATRIX_CRON_PENDING_KEY, JSON.stringify([{ junk: true }]))
    await expect(new MatrixCronDelivery(deps).deliver(request)).resolves.toEqual({ status: 'delivered', event_id: '$brief' })
    vault.map.set(MATRIX_CRON_PENDING_KEY, JSON.stringify([{ roomId: payload.room_id, runId, occurrence: { occurrenceId: runId } }]))
    const raw = vault.map.get(MATRIX_CRON_PENDING_KEY)
    await expect(new MatrixCronDelivery(deps).deliver(request)).rejects.toThrow('matrix_cron_vault_unavailable')
    expect(vault.map.get(MATRIX_CRON_PENDING_KEY)).toBe(raw)
  })
})
