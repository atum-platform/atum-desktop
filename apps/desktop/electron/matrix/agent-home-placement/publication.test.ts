import { createHash, randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { matrixCronTransaction } from '../../../shared/matrix-turn'
import { MATRIX_CRON_PENDING_KEY, MatrixCronDelivery, type MatrixCronPost } from '../cron-delivery'
import { assertMacJobDeliveryHome, drainMacJobs } from '../mac-job-delivery'
import { macJobAuthority } from '../mac-job-lifecycle'

import type { HomeOperation } from './contract'
import { AgentHomeJournal } from './journal'
import { MemoryStore } from './mac.fixture'
import { Crash, createNode, pass } from './node.fixture'
import { isPublicationError, MacPublications, type PublicationRequest } from './publication'
import { HomeStanding } from './standing'
import { StubMatrixServer } from './stub-platform.fixture'
import { createWorld, fenceOf, mintOperation, signal, type World } from './world.fixture'

const ROOM = '!room:atum.example'
const PREFIX = 'agent-home-publication-v1:'

/** A Mac whose agent is under the placement model and holds the answering lease. */
async function mac() {
  const w = await createWorld({ at: 'a' })
  const me = w.a
  const store = new MemoryStore()
  const journal = new AgentHomeJournal(me.store)

  journal.update(w.agent, entry => {
    entry.managed = true
  })

  const standingFor = (use: AgentHomeJournal) =>
    new HomeStanding({ platform: me.platform, journal: use, me: () => me.deviceServiceId, now: w.clock.now })

  const matrix = new StubMatrixServer()
  let cron = w.clock.now() + 60_000

  /** What the Mac waits with: time passes, the lease is renewed, and the platform's worker comes round once a minute. */
  const sleep = async (ms: number) => {
    w.clock.advance(ms)

    if (w.stub.lease(w.agent)) {
      w.stub.renewLease(w.agent)
    }

    if (w.clock.now() >= cron) {
      w.stub.sweepPublications(matrix)
      cron += 60_000
    }
  }

  const build = (overrides: { waitMs?: number; standing?: HomeStanding } = {}) =>
    new MacPublications({
      platform: me.platform,
      auth: me.auth,
      standing: overrides.standing ?? standingFor(journal),
      leaseFacts: () => {
        const lease = w.stub.lease(w.agent)

        return lease && lease.executorDevice === me.deviceServiceId && lease.expiresAt > w.clock.now()
          ? { leaseId: lease.leaseId, leaseExpiresAtPlatform: lease.expiresAt, executorTerm: lease.term }
          : null
      },
      store: () => store,
      now: w.clock.now,
      sleep,
      waitMs: overrides.waitMs ?? 75_000,
      pollMs: 8_000
    })

  const operation = (): HomeOperation => {
    const value: HomeOperation = { kind: 'invocation', id: randomUUID() }
    w.stub.registerOperation(w.agent, value)

    return value
  }

  return { w, me, store, journal, matrix, build, standingFor, publications: build(), operation }
}

const message = (body: string) => async () => ({ eventType: 'm.room.message' as const, content: { msgtype: 'm.text', body } })

function request(w: World, operation: HomeOperation, overrides: Partial<PublicationRequest> = {}): PublicationRequest {
  return {
    agent: w.agent,
    operation,
    roomId: ROOM,
    transactionId: `atum-${operation.id.slice(0, 8)}`,
    prepare: message('hello'),
    ...overrides
  }
}

const errorOf = async (run: Promise<unknown>) => {
  try {
    await run
  } catch (error) {
    return error
  }

  throw new Error('expected_an_error')
}

const codeOf = (error: unknown) => (isPublicationError(error) ? `${error.code}:${error.detail}` : String(error))

describe('putting a result into a room through the platform', () => {
  it('hands the platform the exact bytes, and returns the event once the platform has sent it', async () => {
    const { w, matrix, publications, operation } = await mac()
    const op = operation()
    const prepare = vi.fn(message('hello'))

    const eventId = await publications.publish(request(w, op, { prepare }), signal())

    expect(eventId).toMatch(/^\$stub-event-1/u)
    expect(prepare).toHaveBeenCalledTimes(1)
    // One event in the room, with the transaction the caller fixed and the bytes that were prepared.
    expect(matrix.events).toHaveLength(1)
    expect(matrix.events[0]).toMatchObject({ roomId: ROOM, eventType: 'm.room.message', transactionId: `atum-${op.id.slice(0, 8)}` })
    expect(JSON.parse(matrix.events[0]!.bytes.toString('utf8'))).toEqual({ msgtype: 'm.text', body: 'hello' })
    // The platform's ledger recorded it, not this Mac.
    expect(w.stub.ledgerPublished(w.agent, op)).toBe(eventId)
    expect(w.stub.outboxRows(w.agent)[0]).toMatchObject({
      state: 'published',
      payloadSha256: createHash('sha256').update(matrix.events[0]!.bytes).digest('hex')
    })
  })

  it('looks at the row again with a fresh frame each time, never the same one twice', async () => {
    const { w, publications, operation } = await mac()

    await publications.publish(request(w, operation()), signal())

    const posts = w.stub.requests.filter(entry => entry.action === 'MatrixPublicationEnqueue')
    // The worker comes round once a minute and the Mac looks every eight seconds: several looks, every one admitted.
    expect(posts.length).toBeGreaterThanOrEqual(5)
    expect(posts.every(entry => entry.status === 200)).toBe(true)
    expect(w.stub.outboxRows(w.agent)).toHaveLength(1)
  })

  it('is pending, not failed, while the worker has not come, and a later call finishes it without preparing again', async () => {
    const { w, store, matrix, build, operation } = await mac()
    const op = operation()
    const prepare = vi.fn(message('hello'))

    const first = await errorOf(build({ waitMs: 20_000 }).publish(request(w, op, { prepare }), signal()))
    expect(codeOf(first)).toBe('matrix_publication_pending:worker')
    expect(matrix.events).toHaveLength(0)

    // The app is opened again: a new object over the same store. Nothing is prepared a second time.
    const again = vi.fn(async () => {
      throw new Error('must_not_prepare_again')
    })

    const eventId = await build().publish(request(w, op, { prepare: again }), signal())

    expect(again).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(matrix.events).toHaveLength(1)
    expect(w.stub.outboxRows(w.agent)).toHaveLength(1)
    expect(eventId).toBe(matrix.events[0]!.eventId)
    expect(store.keys(PREFIX)).toHaveLength(1)
  })

  it('keeps the same outbox row for the same result, so a Mac that lost its record never makes a second row', async () => {
    const { w, store, matrix, build, operation } = await mac()
    const op = operation()

    await errorOf(build({ waitMs: 1_000 }).publish(request(w, op, { prepare: message('first') }), signal()))
    store.removeItem(store.keys(PREFIX)[0]!)

    // Prepared again, differently: the platform holds the first bytes under this very row and says so, by name. That
    // attempt is over at once; it is not asked again, and the answer is the same every time after.
    const again = build({ waitMs: 1_000 })
    const first = codeOf(await errorOf(again.publish(request(w, op, { prepare: message('second 1') }), signal())))
    const asked = w.stub.requests.length
    const codes = [first]

    for (let tries = 2; tries <= 3; tries += 1) {
      codes.push(codeOf(await errorOf(again.publish(request(w, op, { prepare: message(`second ${tries}`) }), signal()))))
    }

    expect(codes).toEqual(['matrix_publication_refused:conflict', 'matrix_publication_refused:conflict', 'matrix_publication_refused:conflict'])
    expect(w.stub.requests.length).toBe(asked)
    expect(w.stub.outboxRows(w.agent)).toHaveLength(1)

    // The original publishes on its own, and the ledger says so; the room has one message, the first.
    w.stub.sweepPublications(matrix)
    expect(matrix.events).toHaveLength(1)
    expect(JSON.parse(matrix.events[0]!.bytes.toString('utf8')).body).toBe('first')
    expect(w.stub.ledgerPublished(w.agent, op)).toBe(matrix.events[0]!.eventId)
  })

  it('shares one hand-over between two callers who ask for the same result at once', async () => {
    const { w, matrix, publications, operation } = await mac()
    const op = operation()
    const prepare = vi.fn(message('hello'))

    const [left, right] = await Promise.all([
      publications.publish(request(w, op, { prepare }), signal()),
      publications.publish(request(w, op, { prepare }), signal())
    ])

    expect(left).toBe(right)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(matrix.events).toHaveLength(1)
  })

  it('does not send twice when Matrix lost the answer: the worker retries the same transaction', async () => {
    const { w, matrix, build, operation } = await mac()
    matrix.failNext = ['lost']

    // The worker comes round once a minute: the first sweep loses the answer, the next one finishes it.
    const eventId = await build({ waitMs: 150_000 }).publish(request(w, operation()), signal())

    expect(matrix.events).toHaveLength(1)
    expect(eventId).toBe(matrix.events[0]!.eventId)
    expect(w.stub.outboxRows(w.agent)[0]!.attempts).toBe(2)
  })

  it('posts a split answer part by part, each under its own transaction, and the ledger names the last part', async () => {
    const { w, matrix, publications, operation } = await mac()
    const op = operation()
    const events: string[] = []

    for (const index of [0, 1, 2]) {
      events.push(
        await publications.publish(
          request(w, op, {
            transactionId: `atum-${op.id.slice(0, 8)}-${index}`,
            part: { index, count: 3 },
            prepare: message(`part ${index}`)
          }),
          signal()
        )
      )
    }

    expect(new Set(events).size).toBe(3)
    expect(matrix.events.map(event => event.transactionId)).toEqual([0, 1, 2].map(index => `atum-${op.id.slice(0, 8)}-${index}`))
    expect(w.stub.outboxRows(w.agent).map(row => `${row.partIndex}/${row.partCount}`)).toEqual(['0/3', '1/3', '2/3'])
    expect(w.stub.ledgerPublished(w.agent, op)).toBe(events[2])
  })
})

describe('what is never done', () => {
  it('sends nothing itself, ever: a platform without the route is an error, and the prepared event waits', async () => {
    const { w, store, matrix, publications, operation } = await mac()
    w.stub.publicationsRoute = false

    const error = await errorOf(publications.publish(request(w, operation()), signal()))

    expect(codeOf(error)).toBe('matrix_publication_unavailable:unsupported')
    expect(matrix.events).toHaveLength(0)
    // What was prepared is kept for when the platform answers.
    expect(store.keys(PREFIX)).toHaveLength(1)
  })

  it('takes a result while the move is only requested: the turn in flight finishes and says its piece', async () => {
    const { w, me, matrix, publications, operation } = await mac()
    const op = operation()
    const placement = w.stub.placement(w.agent)

    await me.platform.requestMove(
      w.agent,
      {
        moveId: randomUUID(),
        idempotencyKey: randomUUID(),
        target: { kind: 'mac', deviceServiceId: w.b.deviceServiceId },
        expectedHomeEpoch: placement.homeEpoch,
        expectedPlacementRevision: placement.placementRevision
      },
      signal()
    )

    const eventId = await publications.publish(request(w, op), signal())

    expect(eventId).toBe(matrix.events[0]!.eventId)
    expect(w.stub.ledgerPublished(w.agent, op)).toBe(eventId)
    expect(w.stub.outboxRows(w.agent)[0]).toMatchObject({ state: 'published', sourceMoveId: w.stub.placement(w.agent).activeMove!.moveId })
  })

  it('is told for good, and does not ask again, once the drain is acknowledged: the row is refused and nothing is sent', async () => {
    const { w, me, matrix, publications, operation } = await mac()
    const op = operation()
    const placement = w.stub.placement(w.agent)

    const requested = await me.platform.requestMove(
      w.agent,
      {
        moveId: randomUUID(),
        idempotencyKey: randomUUID(),
        target: { kind: 'mac', deviceServiceId: w.b.deviceServiceId },
        expectedHomeEpoch: placement.homeEpoch,
        expectedPlacementRevision: placement.placementRevision
      },
      signal()
    )

    if (!requested.ok) {
      throw new Error('move not requested')
    }

    const ack = await me.auth.sign('DrainAck', meta => ({ meta, moveId: requested.value.move.moveId, fence: fenceOf(w, mintOperation()), result: 'quiesced' as const }))
    expect(await me.platform.ackDrain(w.agent, ack as never, signal())).toMatchObject({ ok: true })

    const error = await errorOf(publications.publish(request(w, op), signal()))

    expect(codeOf(error)).toBe('matrix_publication_refused:move_in_progress')
    expect(matrix.events).toHaveLength(0)

    // Final: another ask is answered from the record, with no frame sent.
    const before = w.stub.requests.length

    const again = await errorOf(
      publications.publish(
        request(w, op, {
          prepare: async () => {
            throw new Error('no')
          }
        }),
        signal()
      )
    )

    expect(codeOf(again)).toBe('matrix_publication_refused:move_in_progress')
    expect(w.stub.requests.length).toBe(before)
  })

  it('is not lost to a checkpoint that commits while it is being handed over: the revision is read again and the frame signed again', async () => {
    const { w, matrix, publications, operation } = await mac()
    const op = operation()
    w.stub.advanceRevisionBeforeNextPublication = true

    const eventId = await publications.publish(request(w, op), signal())

    expect(eventId).toBe(matrix.events[0]!.eventId)
    // The first frame was too late and was refused; the next was taken (the rest are looks at the row while the worker came
    // round). One row, one event.
    expect(w.stub.requests.filter(each => each.action === 'MatrixPublicationEnqueue').slice(0, 2).map(each => each.status)).toEqual([403, 200])
    expect(w.stub.outboxRows(w.agent)).toHaveLength(1)
    expect(matrix.events).toHaveLength(1)
  })

  it('does not wait for a minute when the Shell publishes inline: the event id is the answer to the enqueue', async () => {
    const { w, matrix, publications, operation } = await mac()
    w.stub.inlineMatrix = matrix
    const op = operation()
    const started = w.clock.now()

    const eventId = await publications.publish(request(w, op), signal())

    expect(eventId).toBe(matrix.events[0]!.eventId)
    // Not a second of waiting: the cron worker never came round.
    expect(w.clock.now()).toBe(started)
    expect(w.stub.ledgerPublished(w.agent, op)).toBe(eventId)
  })

  it('keeps what it prepared and leaves the platform alone for the minute it asked for when its queue is full', async () => {
    const { w, store, matrix, publications, operation } = await mac()
    const op = operation()
    w.stub.publicationQueueFull = true

    expect(codeOf(await errorOf(publications.publish(request(w, op), signal())))).toBe('matrix_publication_unavailable:queue_full')
    expect(store.keys(PREFIX)).toHaveLength(1)
    expect(w.stub.outboxRows(w.agent)).toHaveLength(0)

    // Within the minute: the same answer, from this Mac's own memory of what the platform asked, with no frame sent.
    const asked = w.stub.requests.length
    w.clock.advance(30_000)
    expect(codeOf(await errorOf(publications.publish(request(w, op), signal())))).toBe('matrix_publication_unavailable:queue_full')
    expect(w.stub.requests.length).toBe(asked)

    // After it, the queue has room, and the very record that was kept goes out.
    w.clock.advance(31_000)
    w.stub.publicationQueueFull = false
    const prepare = vi.fn(message('never prepared again'))
    const eventId = await publications.publish(request(w, op, { prepare }), signal())

    expect(prepare).not.toHaveBeenCalled()
    expect(eventId).toBe(matrix.events[0]!.eventId)
  })

  describe('the rollout: the platform’s worker is switched off', () => {
    it('lets the caller send a result itself when nothing of it was ever enqueued, and forgets the record', async () => {
      const { w, store, matrix, publications, operation } = await mac()
      const op = operation()
      w.stub.publicationsEnabled = false

      const error = await errorOf(publications.publish(request(w, op), signal()))

      expect(codeOf(error)).toBe('matrix_publication_disabled:publication_disabled')
      expect(w.stub.outboxRows(w.agent)).toHaveLength(0)
      // The result is not an outbox result: no record, so the legacy acknowledgement is due for it.
      expect(store.keys(PREFIX)).toEqual([])
      expect(publications.has(w.agent, op)).toBe(false)
      expect(matrix.events).toHaveLength(0)
    })

    it('does not let the caller send around a result of which the platform already holds a part', async () => {
      const { w, store, matrix, publications, operation } = await mac()
      const op = operation()
      w.stub.inlineMatrix = matrix

      // Part 0 is accepted (and published); then the worker is switched off before part 1 is handed over.
      await publications.publish(request(w, op, { part: { index: 0, count: 2 }, transactionId: 'atum-part-0' }), signal())
      w.stub.publicationsEnabled = false

      const error = await errorOf(publications.publish(request(w, op, { part: { index: 1, count: 2 }, transactionId: 'atum-part-1' }), signal()))

      expect(codeOf(error)).toBe('matrix_publication_unavailable:publication_disabled_after_enqueue')
      // Both records stay: the platform owns this message, and part 1 goes out once the worker is back.
      expect(store.keys(PREFIX)).toHaveLength(2)
      expect(publications.has(w.agent, op)).toBe(true)

      w.stub.publicationsEnabled = true
      const eventId = await publications.publish(request(w, op, { part: { index: 1, count: 2 }, transactionId: 'atum-part-1' }), signal())

      expect(eventId).toBe(matrix.events[1]!.eventId)
      expect(matrix.events).toHaveLength(2)
    })

    it('is not fooled by a lookalike: another 503 is only "not yet"', async () => {
      const { w, store, publications, operation } = await mac()
      w.stub.failNextPublication = { status: 503, body: { error: 'matrix_503', details: { reason: 'publication_disabled_soon' } } }

      const error = await errorOf(publications.publish(request(w, operation(), { prepare: message('x') }), signal()))

      expect(codeOf(error)).toBe('matrix_publication_unavailable:unavailable')
      expect(store.keys(PREFIX)).toHaveLength(1)
    })
  })

  it('says uncertain when the platform does, and does not try again behind that', async () => {
    const { w, matrix, build, operation } = await mac()
    const op = operation()
    const publications = build({ waitMs: 1_000 })

    expect(codeOf(await errorOf(publications.publish(request(w, op), signal())))).toBe('matrix_publication_pending:worker')

    // The platform's worker lost track of the send.
    const row = w.stub.outboxRows(w.agent)[0]!
    row.state = 'uncertain'
    row.reason = 'effect_unknown'

    expect(codeOf(await errorOf(publications.publish(request(w, op), signal())))).toBe('matrix_publication_uncertain:effect_unknown')

    // Final: no further look.
    const before = w.stub.requests.length
    expect(codeOf(await errorOf(publications.publish(request(w, op), signal())))).toBe('matrix_publication_uncertain:effect_unknown')
    expect(w.stub.requests.length).toBe(before)
    expect(matrix.events).toHaveLength(0)
  })

  it('treats a permanent Matrix error as final', async () => {
    const { w, matrix, publications, operation } = await mac()
    matrix.failNext = ['permanent']

    expect(codeOf(await errorOf(publications.publish(request(w, operation()), signal())))).toBe('matrix_publication_refused:matrix_error')
  })

  it('does not present anything from a Mac that is no longer the home', async () => {
    const { w, matrix, publications, operation } = await mac()
    w.stub.hijack(w.agent, { kind: 'mac', deviceServiceId: w.b.deviceServiceId })

    const error = await errorOf(publications.publish(request(w, operation()), signal()))

    expect(codeOf(error)).toMatch(/^matrix_publication_unavailable:not_home/u)
    expect(w.stub.requests.filter(entry => entry.action === 'MatrixPublicationEnqueue')).toHaveLength(0)
    expect(matrix.events).toHaveLength(0)
  })

  it('does not present an agent the model has not taken over: it has no fence to sign with', async () => {
    const { w, matrix, build, standingFor, operation } = await mac()
    // A journal that never saw the agent under the model: the standing is "legacy", and there is no placement to fence.
    const publications = build({ standing: standingFor(new AgentHomeJournal(new MemoryStore())) })

    const error = await errorOf(publications.publish(request(w, operation()), signal()))

    expect(codeOf(error)).toBe('matrix_publication_unavailable:lease_term_unavailable')
    expect(matrix.events).toHaveLength(0)
  })

  it('refuses an event the platform could not take, before recording it', async () => {
    const { w, store, publications, operation } = await mac()
    const big = async () => ({ eventType: 'm.room.message' as const, content: { body: 'x'.repeat(131_100) } })

    const error = await errorOf(publications.publish(request(w, operation(), { prepare: big }), signal()))

    expect(codeOf(error)).toBe('matrix_publication_refused:too_large')
    expect(store.keys(PREFIX)).toHaveLength(0)
  })

  it('leaves what it prepared alone when it is stopped, and reports not yet', async () => {
    const { w, store, publications, operation } = await mac()
    const stopped = new AbortController()

    const prepare = async () => {
      // The app stops while the SDK is preparing the event: what was prepared is kept for the next run.
      stopped.abort()

      return { eventType: 'm.room.message' as const, content: { msgtype: 'm.text', body: 'prepared as the app stopped' } }
    }

    const error = await errorOf(publications.publish(request(w, operation(), { prepare }), stopped.signal))

    expect(codeOf(error)).toBe('matrix_publication_pending:aborted')
    expect(store.keys(PREFIX)).toHaveLength(1)
  })

  it('prepares nothing at all once the app has stopped', async () => {
    const { w, store, publications, operation } = await mac()
    const stopped = new AbortController()
    stopped.abort()
    let prepared = 0

    const prepare = async () => {
      prepared += 1

      return { eventType: 'm.room.message' as const, content: { msgtype: 'm.text', body: 'never' } }
    }

    const error = await errorOf(publications.publish(request(w, operation(), { prepare }), stopped.signal))

    expect(codeOf(error)).toBe('matrix_publication_pending:aborted')
    expect(prepared).toBe(0)
    expect(store.keys(PREFIX)).toHaveLength(0)
  })

  it('keeps its finished records for a week and prunes them after, never one still pending', async () => {
    const { w, store, matrix, publications, build, operation } = await mac()
    const old = operation()

    await publications.publish(request(w, old), signal())
    const [finished] = store.keys(PREFIX)
    expect(finished).toBeDefined()

    // One that is still pending (the worker has not come) outlives the week.
    const waiting = operation()
    await errorOf(build({ waitMs: 1_000 }).publish(request(w, waiting), signal()))
    const [, pending] = store.keys(PREFIX)

    w.clock.advance(8 * 24 * 60 * 60_000)
    w.stub.renewLease(w.agent)
    matrix.failNext = []
    await build({ waitMs: 1_000 }).publish(request(w, operation(), { prepare: message('later') }), signal()).catch(() => undefined)

    expect(store.keys(PREFIX)).not.toContain(finished)
    expect(store.keys(PREFIX)).toContain(pending)
  })
})

// D1 adapter proof, not proof of the live N7 occurrence/publication ledger binding.
it('drains a persisted managed result before a Mac target can checkpoint, retaining D1 bytes after source crash', async () => {
  const { w, me, matrix, store, build } = await mac()
  const a = createNode(w, w.a, { files: { 'SOUL.md': 'test agent' } })
  const b = createNode(w, w.b)
  a.runtime.wantsLease = true
  const op: HomeOperation = { kind: 'job', id: randomUUID() }
  w.stub.registerOperation(w.agent, op)

  const post: MatrixCronPost = { roomId: ROOM, text: 'saved output', jobId: 'schedule', runId: op.id,
    since: w.clock.now(), occurrence: { assistantId: randomUUID(), executorId: randomUUID(), occurrenceId: op.id, computeSeconds: 1, home: { homeId: 'home', homeEpoch: 1, executorTerm: 1, leaseId: 'lease' } } }

  store.setItem(MATRIX_CRON_PENDING_KEY, JSON.stringify([post]))
  const placement = w.stub.placement(w.agent)

  const moved = await me.platform.requestMove(w.agent, { moveId: randomUUID(), idempotencyKey: randomUUID(),
    target: { kind: 'mac', deviceServiceId: w.b.deviceServiceId },
    expectedHomeEpoch: placement.homeEpoch, expectedPlacementRevision: placement.placementRevision }, signal())

  expect(moved.ok).toBe(true)
  let publications = build({ waitMs: 1 })
  const prepare = vi.fn(message(post.text))

  const settle = vi.fn(async (_post: MatrixCronPost, event: string) => {
    expect(w.stub.ledgerPublished(w.agent, op)).toBe(event)
  })

  const deps = { store, requireRoom: async () => {}, authorizeManaged: async () => {}, log: () => {},
    find: async () => ({ state: 'absent' as const }), settleManaged: settle,
    publish: () => publications.publish(request(w, op, { transactionId: matrixCronTransaction(op.id), prepare }), signal()) }

  // Crash/discard the source after enqueue but before a publication receipt. Nothing can acknowledge drain.
  await expect(new MatrixCronDelivery(deps).resumeManaged(new AbortController().signal)).resolves.toEqual({ left: 1 })
  expect(settle).not.toHaveBeenCalled()
  publications = build()
  await new MatrixCronDelivery(deps).resumeManaged(new AbortController().signal)
  await new MatrixCronDelivery(deps).resumeManaged(new AbortController().signal)
  expect(matrix.events).toHaveLength(1)
  expect(settle).toHaveBeenCalledTimes(1)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(JSON.parse(store.getItem(MATRIX_CRON_PENDING_KEY)!)[0]).toMatchObject({ settled: true })
  expect(w.stub.outboxRows(w.agent)[0]).toMatchObject({ transactionId: matrixCronTransaction(op.id), state: 'published' })
  const drain = a.runtime.drain.bind(a.runtime)

  a.runtime.drain = async (agent, budget) => {
    await new MatrixCronDelivery(deps).resumeManaged(new AbortController().signal)

    return drain(agent, budget)
  }

  a.crashAt = 'source:drained'
  await expect(pass(a, w.agent)).rejects.toBeInstanceOf(Crash)
  a.restart()
  await pass(a, w.agent)
  expect(w.stub.placement(w.agent).activeMove?.status).toBe('ready_to_commit')
  b.crashAt = 'target:committed'
  await expect(pass(b, w.agent)).rejects.toBeInstanceOf(Crash)
  b.restart()
  await pass(b, w.agent)
  expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: 2, location: { kind: 'mac', deviceServiceId: w.b.deviceServiceId } })
  // In the drain design the target never owns an unpublished result or reruns a model.
  expect(matrix.events).toHaveLength(1)
  expect(settle).toHaveBeenCalledTimes(1)
  const stale: HomeOperation = { kind: 'job', id: randomUUID() }
  w.stub.registerOperation(w.agent, stale)
  await expect(build().publish(request(w, stale), signal())).rejects.toThrow()
  expect(matrix.events).toHaveLength(1)
})

// Coordinator decision 2026-11-01: a planned move lets the CURRENT home publish and settle its pending managed
// deliveries inside the D1 drain, bounded by a deadline; past it the move proceeds and they stay the old home's.
// A new home never publishes them, and a stale old home stays fenced. The cloud's commit is the stub's stand-in.
describe('managed job deliveries across a planned move', () => {
  async function moving(target: 'mac' | 'cloud', options: { hang?: boolean } = {}) {
    const { w, me, matrix, store, build, journal, standingFor } = await mac()
    const a = createNode(w, w.a, { files: { 'SOUL.md': 'test agent' } })
    const b = createNode(w, w.b)
    a.runtime.wantsLease = true

    const ctx = { standing: standingFor(journal), platform: me.platform, auth: me.auth, me: () => me.deviceServiceId,
      runtime: { leaseFacts: () => a.runtime.leaseFacts() } }

    const authority = () => macJobAuthority(ctx, w.agent, signal(), true)
    const fence = await authority()
    expect(fence).not.toBeNull()
    const current = async (post: MatrixCronPost) => assertMacJobDeliveryHome(post, await authority())
    const completions = vi.fn()
    const settle = vi.fn()
    const publications = build()

    const deps = {
      store, log: () => {}, requireRoom: async () => {}, find: async () => ({ state: 'absent' as const }),
      authorizeManaged: async (post: MatrixCronPost, bound?: AbortSignal) => {
        await current(post)

        if (options.hang) {
          await new Promise((_resolve, reject) => bound?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        }

        completions(post.runId)
      },
      settleManaged: async (post: MatrixCronPost, event: string) => {
        await current(post)
        settle(post.runId, event)
      },
      publish: async (post: MatrixCronPost) => {
        await current(post)

        return publications.publish(request(w, { kind: 'job', id: post.runId },
          { transactionId: matrixCronTransaction(post.runId), prepare: message(post.text) }), signal())
      }
    }

    const pendingPost = (): MatrixCronPost => {
      const op: HomeOperation = { kind: 'job', id: randomUUID() }
      w.stub.registerOperation(w.agent, op)

      return { roomId: ROOM, text: `output ${op.id.slice(0, 4)}`, jobId: 'schedule', runId: op.id, since: w.clock.now(),
        occurrence: { assistantId: randomUUID(), executorId: randomUUID(), occurrenceId: op.id, computeSeconds: 1,
          home: { homeId: fence!.homeId, homeEpoch: fence!.homeEpoch, executorTerm: fence!.executorTerm, leaseId: fence!.leaseId } } }
    }

    const post = pendingPost()
    store.setItem(MATRIX_CRON_PENDING_KEY, JSON.stringify([post]))
    const placement = w.stub.placement(w.agent)

    if (target === 'mac') {
      const moved = await me.platform.requestMove(w.agent, { moveId: randomUUID(), idempotencyKey: randomUUID(),
        target: { kind: 'mac', deviceServiceId: w.b.deviceServiceId },
        expectedHomeEpoch: placement.homeEpoch, expectedPlacementRevision: placement.placementRevision }, signal())

      expect(moved.ok).toBe(true)
    } else {
      w.stub.requestCloudMove(w.agent)
    }

    // The handle's drain as main composes it: the managed share beside the turn, under the adapter's deadline.
    const drain = a.runtime.drain.bind(a.runtime)
    let atDrain = -1

    a.runtime.drain = async (agent, budget) => {
      await drainMacJobs({ delivery: new MatrixCronDelivery(deps), deadline: AbortSignal.timeout(options.hang ? 20 : 10_000), log: () => {} })
      atDrain = matrix.events.length

      return drain(agent, budget)
    }

    await pass(a, w.agent)
    expect(w.stub.placement(w.agent).activeMove?.status).toBe('ready_to_commit')

    if (target === 'mac') {
      await pass(b, w.agent)
    } else {
      w.stub.commitCloudMove(w.agent)
    }

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: placement.homeEpoch + 1,
      location: target === 'mac' ? { kind: 'mac', deviceServiceId: w.b.deviceServiceId } : { kind: 'cloud' } })

    return { w, a, b, matrix, store, deps, post, pendingPost, completions, settle, atDrain }
  }

  it.each(['mac', 'cloud'] as const)('publishes and settles a pending delivery before a Mac→%s move commits', async target => {
    const { matrix, store, deps, pendingPost, completions, settle, atDrain, post } = await moving(target)
    expect(atDrain).toBe(1)
    expect(matrix.events).toHaveLength(1)
    expect(completions).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(post.runId, expect.stringMatching(/^\$/u))
    expect(JSON.parse(store.getItem(MATRIX_CRON_PENDING_KEY)!)[0]).toMatchObject({ settled: true })

    // The old home, now fenced, holds a late result: it can neither publish nor settle it.
    const late = pendingPost()
    store.setItem(MATRIX_CRON_PENDING_KEY, JSON.stringify([...JSON.parse(store.getItem(MATRIX_CRON_PENDING_KEY)!), late]))
    await expect(new MatrixCronDelivery(deps).resumeManaged(signal())).resolves.toEqual({ left: 1 })
    await new MatrixCronDelivery(deps).resume()
    expect(matrix.events).toHaveLength(1)
    expect(completions).toHaveBeenCalledTimes(1)
  })

  it('lets the move proceed past the deadline; the result stays the old home and is never published, even back home', async () => {
    const { w, a, b, matrix, store, deps, completions, settle, atDrain } = await moving('mac', { hang: true })
    expect(atDrain).toBe(0)
    expect(matrix.events).toHaveLength(0)
    expect(completions).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    await new MatrixCronDelivery({ ...deps, authorizeManaged: async (post: MatrixCronPost) => deps.authorizeManaged(post) }).resume()
    expect(JSON.parse(store.getItem(MATRIX_CRON_PENDING_KEY)!)[0].stranded).toBeUndefined()

    // The agent later moves back to this Mac under a new epoch and term: the old output is stranded, not sent.
    const back = w.stub.placement(w.agent)

    const returned = await w.b.platform.requestMove(w.agent, { moveId: randomUUID(), idempotencyKey: randomUUID(),
      target: { kind: 'mac', deviceServiceId: w.a.deviceServiceId },
      expectedHomeEpoch: back.homeEpoch, expectedPlacementRevision: back.placementRevision }, signal())

    expect(returned.ok).toBe(true)
    // The new home answers under its own term (the old Mac's term ended with the move).
    a.runtime.wantsLease = false
    w.stub.releaseLease(w.agent)
    b.runtime.wantsLease = true
    expect(b.runtime.leaseFacts()).not.toBeNull()

    for (let round = 0; round < 4 && w.stub.placement(w.agent).homeEpoch === back.homeEpoch; round++) {
      await pass(b, w.agent)
      await pass(a, w.agent)
    }

    expect(w.stub.placement(w.agent)).toMatchObject({ homeEpoch: back.homeEpoch + 1, location: { kind: 'mac', deviceServiceId: w.a.deviceServiceId } })
    b.runtime.wantsLease = false
    w.stub.releaseLease(w.agent)
    a.runtime.wantsLease = true
    expect(a.runtime.leaseFacts()?.executorTerm).toBeGreaterThan(0)
    const fresh = new MatrixCronDelivery({ ...deps, authorizeManaged: async (post: MatrixCronPost) => deps.authorizeManaged(post) })
    await expect(fresh.resumeManaged(signal())).resolves.toEqual({ left: 0 })
    expect(JSON.parse(store.getItem(MATRIX_CRON_PENDING_KEY)!)[0]).toMatchObject({ stranded: true })
    expect(matrix.events).toHaveLength(0)
    expect(completions).not.toHaveBeenCalled()
  })

  it('leaves zero events when the old home dies before publishing; it stays fenced when it starts again', async () => {
    const { w, me, matrix, store, build, journal, standingFor } = await mac()
    const a = createNode(w, w.a, { files: { 'SOUL.md': 'test agent' } })
    a.runtime.wantsLease = true

    const ctx = { standing: standingFor(journal), platform: me.platform, auth: me.auth, me: () => me.deviceServiceId,
      runtime: { leaseFacts: () => a.runtime.leaseFacts() } }

    const authority = () => macJobAuthority(ctx, w.agent, signal(), true)
    const fence = (await authority())!
    const op: HomeOperation = { kind: 'job', id: randomUUID() }
    w.stub.registerOperation(w.agent, op)

    const post: MatrixCronPost = { roomId: ROOM, text: 'stranded output', jobId: 'schedule', runId: op.id, since: w.clock.now(),
      occurrence: { assistantId: randomUUID(), executorId: randomUUID(), occurrenceId: op.id, computeSeconds: 1,
        home: { homeId: fence.homeId, homeEpoch: fence.homeEpoch, executorTerm: fence.executorTerm, leaseId: fence.leaseId } } }

    store.setItem(MATRIX_CRON_PENDING_KEY, JSON.stringify([post]))

    // Failover: the platform moves the home to the cloud with no drain; the dead Mac's term is gone.
    w.stub.hijack(w.agent, { kind: 'cloud' })
    w.stub.releaseLease(w.agent)
    a.runtime.wantsLease = false
    const publications = build()
    const current = async (each: MatrixCronPost) => assertMacJobDeliveryHome(each, await authority())
    const publish = vi.fn(async (each: MatrixCronPost) => publications.publish(request(w, op, { transactionId: matrixCronTransaction(each.runId) }), signal()))

    const deps = { store, log: () => {}, requireRoom: async () => {}, find: async () => ({ state: 'absent' as const }), publish,
      authorizeManaged: current, settleManaged: current }

    await new MatrixCronDelivery(deps).resume()
    await expect(new MatrixCronDelivery(deps).resumeManaged(signal())).resolves.toEqual({ left: 1 })
    expect(publish).not.toHaveBeenCalled()
    expect(matrix.events).toHaveLength(0)
    // Its D1 fence refuses even a direct attempt from the stale home.
    await expect(build().publish(request(w, op), signal())).rejects.toThrow()
    expect(matrix.events).toHaveLength(0)
  })
})
