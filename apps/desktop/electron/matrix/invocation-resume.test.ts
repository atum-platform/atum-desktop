import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixInvocationMessage, MatrixSdkCommand } from '../../shared/matrix'
import { matrixCheckingLine } from '../../shared/matrix-agent-status-copy'
import type { EncryptedStore } from '../encrypted-store'

import { MATRIX_DEFERRED_RETRY_MS } from './hermes-listener'
import { invokeMatrixHermes, MATRIX_AUTOMATIC_WINDOW_MS } from './invocation'
import { LOCAL_TURN_LIMIT_MS, localInvocationRecords } from './local-authority'
import { matrixStatusTransaction, type MatrixTurnEffects } from './turn-effects'

/**
 * R3, "resume instead of refuse" . A turn that
 * is dispatched and then ends without an answer follows three cases: queued again silently when it
 * is shown to have run nothing that matters (a), run again with the facts when a side-effecting
 * tool may have run (b), and otherwise said once to the owner (c) — never silence.
 *
 * The ledger below is the platform's `atum.matrix_invocation` as it must behave once it has the
 * `requeue` operation written in 
 */

afterEach(() => {
  vi.useRealTimers()
})

const HUMAN = { userId: '@owner:test', deviceId: 'HUMAN' }
const ROOM = '!room:test'
const EVENT = '$request'
const LEASE = '00000000-0000-4000-8000-127ad7633157'

interface Row {
  fence: string
  state: 'claimed' | 'dispatched' | 'completed'
  executor: string
  expiresAt: number
  requestHash: string
  senderDevice: string
  transactionId?: string
  publishedEvent?: string
  requeues: number
  resume?: { attempt: number; effect: string; tools: string[] }
}

/** The platform's ledger, shared by every Mac of one owner and agent. */
function ledger(options: { requeue?: boolean } = {}) {
  const { requeue: supportsRequeue = true } = options
  const principal = randomUUID()
  const agentPrincipal = randomUUID()
  let row: Row | undefined
  const calls: Array<{ executor: string; operation: string; input: Record<string, unknown> }> = []

  const answer = (executorId: string, deviceId: string, current: Row) => ({
    owner: principal,
    payer: principal,
    capability: 'local-hermes-turn',
    agentPrincipal,
    agentDevice: deviceId,
    roomId: ROOM,
    eventId: EVENT,
    executorId,
    requestHash: current.requestHash,
    senderDevice: current.senderDevice,
    invocationId: current.fence,
    state: current.state,
    expiresAt: current.expiresAt,
    ...(current.transactionId ? { transactionId: current.transactionId } : {}),
    ...(current.publishedEvent ? { publishedEvent: current.publishedEvent } : {}),
    ...(current.resume ? { resume: current.resume } : {})
  })

  /** The platform's operations, as one Mac (executor) sees them. */
  const as = (executorId: string, deviceId: string) => async (input: Record<string, unknown>) => {
    const operation = String(input.operation)
    calls.push({ executor: executorId, operation, input })

    if (operation === 'recover') {
      return row
        ? {
            state: row.state,
            owner: principal,
            roomId: ROOM,
            eventId: EVENT,
            requestHash: row.requestHash,
            invocationId: row.fence,
            senderDevice: row.senderDevice,
            ...(row.publishedEvent ? { publishedEvent: row.publishedEvent } : {}),
            ...(row.resume ? { resume: row.resume } : {})
          }
        : { state: 'unknown' }
    }

    if (operation === 'requeue' && !supportsRequeue) {
      throw new Error('matrix_invocation_unavailable')
    }

    if (operation === 'claim' && !row) {
      row = {
        fence: randomUUID(),
        state: 'claimed',
        executor: executorId,
        expiresAt: Date.now() + 120_000,
        requestHash: String(input.requestHash),
        senderDevice: String(input.senderDevice),
        requeues: 0
      }
    } else if (operation === 'claim' && row.state === 'claimed' && row.expiresAt <= Date.now()) {
      row = { ...row, executor: executorId, fence: randomUUID(), expiresAt: Date.now() + 120_000 }
    }

    if (!row || row.requestHash !== input.requestHash || row.executor !== executorId) {
      throw new Error('matrix_denied')
    }

    if (operation !== 'claim' && input.invocationId !== row.fence) {
      throw new Error('matrix_denied')
    }

    if (operation === 'dispatch') {
      if (row.state !== 'claimed' || row.expiresAt <= Date.now()) {
        throw new Error('matrix_denied')
      }

      row.state = 'dispatched'
    } else if (operation === 'complete') {
      if (row.state === 'claimed') {
        throw new Error('matrix_denied')
      }

      row.state = 'completed'
      row.transactionId ??= randomUUID()
    } else if (operation === 'published') {
      if (row.state !== 'completed') {
        throw new Error('matrix_denied')
      }

      row.publishedEvent = String(input.publishedEvent)
    } else if (operation === 'requeue') {
      if (row.state !== 'dispatched' || row.requeues >= 2) {
        throw new Error('matrix_denied')
      }

      row = {
        ...row,
        state: 'claimed',
        fence: randomUUID(),
        expiresAt: Date.now(),
        requeues: row.requeues + 1,
        resume: { attempt: row.requeues + 1, effect: String(input.effect), tools: input.tools as string[] }
      }
    }

    return answer(executorId, deviceId, row)
  }

  return {
    as,
    calls,
    operations: () => calls.map(call => call.operation),
    get row() {
      return row
    },
    principal,
    agentPrincipal
  }
}

/** The owner's room, as the Macs see it: every command they send. */
function room() {
  const sent: MatrixSdkCommand[] = []

  const message: MatrixInvocationMessage = {
    roomId: ROOM,
    eventId: EVENT,
    wireType: 'm.room.encrypted',
    sender: HUMAN.userId,
    senderDevice: 'PHONE',
    senderVerified: true,
    timestamp: Date.now(),
    related: false,
    content: { msgtype: 'm.text', body: 'Delete the old drafts' }
  }

  let published = 0

  const read = vi.fn(async (command: MatrixSdkCommand): Promise<unknown> => {
    if (command.kind === 'readInvocation') {
      return message
    }

    sent.push(command)

    return command.kind === 'publishResult' ? `$answer-${++published}` : '$other'
  })

  const results = () => sent.filter(command => command.kind === 'publishResult') as Array<Record<string, unknown>>

  /** The plain chat lines (`publishNotice`), e.g. "I got cut off, let me check": never an answer or a status. */
  const lines = () => sent.filter(command => command.kind === 'publishNotice') as Array<Record<string, unknown>>

  return { read, sent, results, lines, message }
}

function vault(initial: Iterable<[string, string]> = []) {
  const entries = new Map<string, string>(initial)

  const store = {
    getItem: (key: string) => entries.get(key) ?? null,
    failureCode: () => null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
    assertEncryptionAvailable: () => {}
  } as unknown as EncryptedStore

  return { entries, store }
}

/** One Mac that holds the agent's answering lease. */
function mac(
  world: { room: ReturnType<typeof room>; ledger: ReturnType<typeof ledger> },
  options: {
    store?: ReturnType<typeof vault>
    execute?: (input: ExecuteInput) => Promise<{ text: string; storedSession: string }>
    automatic?: boolean
    /** The same Mac again (a restart or a new watch): its enrolled identity is the same. */
    like?: { executorId: string; deviceId: string }
  } = {}
) {
  const { automatic = true } = options
  const executorId = options.like?.executorId ?? randomUUID()
  const deviceId = options.like?.deviceId ?? `MAC-${executorId.slice(0, 4)}`
  const own = options.store ?? vault()
  const log = vi.fn()
  const abort = new AbortController()

  const agent = {
    issuer: 'https://id.test',
    subject: 'owner-sub',
    principal: world.ledger.principal,
    agentPrincipal: world.ledger.agentPrincipal,
    executorId,
    userId: '@agent:test',
    deviceId,
    expiresAt: Date.now() + 3_600_000
  }

  const execute = vi.fn(
    options.execute ?? (async () => ({ text: 'Done: removed 3 drafts', storedSession: 'session' }))
  )

  const records = localInvocationRecords(own.store, {
    principal: agent.principal,
    agentPrincipal: agent.agentPrincipal,
    deviceId
  })

  const watch = {
    id: `watch-${executorId}`,
    roomId: ROOM,
    since: Date.now() - 1_000,
    until: Date.now() + 3_600_000,
    sender: HUMAN,
    ...(automatic ? { automatic: { windowStart: world.room.message.timestamp - 1 } } : {})
  }

  const deps = {
    context: () => ({ human: HUMAN, agent }),
    read: world.room.read,
    authorize: vi.fn(world.ledger.as(executorId, deviceId)),
    confirm: vi.fn(async () => true),
    prepare: vi.fn(async () => true),
    execute,
    store: own.store,
    log,
    watch,
    settleRetryMs: [] as readonly number[],
    ...(automatic
      ? { automatic: { leaseToken: LEASE } }
      : {
          // The lease was taken just before the message arrived: from the message's own timestamp,
          // not from this call's clock. world stamped the message earlier, and two or more
          // milliseconds between the two (a slow runner, a GC pause) made the owner's message
          // look older than the lease: matrix_invocation_untrusted.
          local: { records, lease: { notBefore: world.room.message.timestamp - 1, turnLimitMs: LOCAL_TURN_LIMIT_MS } }
        })
  }

  return {
    deps,
    execute,
    log,
    abort,
    vault: own,
    executorId,
    deviceId,
    run: () => invokeMatrixHermes(deps, { roomId: ROOM, eventId: EVENT }, abort.signal),
    lines: () => log.mock.calls.map(([line]) => String(line))
  }
}

interface ExecuteInput {
  text: string
  deadlineAt: number
  signal: AbortSignal
  effects?: MatrixTurnEffects
  onSubmit?: () => void
}

/** A run that fails the way a Hermes run does, after having done `before` to its tracker. */
const failing =
  (before: (effects: MatrixTurnEffects) => void, error: Error = new Error('matrix_hermes_outcome_unknown')) =>
  async ({ effects }: ExecuteInput): Promise<never> => {
    effects?.attach()
    before(effects!)
    throw error
  }

const submitted = (effects: MatrixTurnEffects) => {
  // A Hermes that shows tool starts (turn-effects.ts toolProgress): what a tracked run is judged on.
  effects.toolProgress('all')
  effects.submit()
}

/** A run whose host went away and that never told its tracker anything: nothing can be shown. */
const cutOff =
  (abort: AbortController) =>
  async (): Promise<never> => {
    abort.abort()
    throw new Error('matrix_hermes_outcome_unknown')
  }

const usedTool = (...names: string[]) => (effects: MatrixTurnEffects) => {
  effects.toolProgress('all')
  effects.submit()

  for (const name of names) {
    effects.toolStarted(name)
  }
}

function world(options: { requeue?: boolean; age?: number } = {}) {
  const w = { room: room(), ledger: ledger({ requeue: options.requeue }) }
  w.room.message.timestamp = Date.now() - (options.age ?? 0)

  return w
}

describe('2026-10-17 02:37: a Mac drops its turn nine seconds after dispatch and nobody answers', () => {
  it('queues the run again, and the next holder answers it (case a)', async () => {
    const w = world()
    const macbook = mac(w)
    const mini = mac(w)

    // The Mac's own host went away mid-turn: the run is aborted before Hermes has the prompt.
    macbook.execute.mockImplementation(async ({ effects, signal }: ExecuteInput) => {
      effects?.attach()
      macbook.abort.abort()
      signal.throwIfAborted()

      throw new Error('matrix_hermes_outcome_unknown')
    })

    expect(await macbook.run()).toEqual({
      state: 'deferred',
      reason: 'matrix_requeued',
      // A run that failed: the listener counts it, so a Mac that keeps failing steps aside.
      failed: 'matrix_turn_aborted',
      retryBefore: expect.any(Number)
    })
    expect(w.ledger.row).toMatchObject({ state: 'claimed', requeues: 1, resume: { effect: 'none', tools: [] } })
    expect(w.ledger.operations()).toEqual(['recover', 'claim', 'dispatch', 'heartbeat', 'requeue'])
    expect(w.room.results()).toHaveLength(0)

    // The other Mac takes the lease and finds the message again: it is answered, once.
    expect(await mini.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(mini.execute).toHaveBeenCalledOnce()
    expect(mini.execute.mock.calls[0]![0]).toMatchObject({ text: 'Delete the old drafts' })
    expect((mini.execute.mock.calls[0]![0] as ExecuteInput).text).not.toContain('Atum note')
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).toMatchObject({ body: 'Done: removed 3 drafts' })
    expect(w.room.results()[0]).not.toHaveProperty('status')
    expect(w.ledger.row).toMatchObject({ state: 'completed', publishedEvent: '$answer-1' })

    // And never again.
    expect(await mini.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(mini.execute).toHaveBeenCalledOnce()
  })

  it('does not wait for the other Mac: the same Mac runs it again when the listener offers it', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(failing(() => {}))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    // The listener's retry: a fresh claim on the lapsed one, dispatch, and the answer.
    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(macbook.execute).toHaveBeenCalledTimes(2)
    expect(w.ledger.operations()).toEqual([
      'recover',
      'claim',
      'dispatch',
      'heartbeat',
      'requeue',
      'recover',
      'claim',
      'dispatch',
      'heartbeat',
      'complete',
      'published'
    ])
  })
})

describe('case a: nothing reached Hermes, or only model calls and read-only tools ran', () => {
  it.each([
    ['only read-only tools', usedTool('read_file', 'web_search'), 'read_only'],
    ['only the model', submitted, 'read_only']
  ] as const)('queues a run that used %s again, silently', async (_name, before, effect) => {
    const w = world()
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(failing(before))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(w.ledger.row?.resume).toEqual({ attempt: 1, effect, tools: [] })

    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    // Silent: the second run's prompt is the original, and the room saw one answer, no notice.
    expect((macbook.execute.mock.calls[1]![0] as ExecuteInput).text).toBe('Delete the old drafts')
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).not.toHaveProperty('status')
  })

  it('runs it again with the warning however many tools it used and however long their names are', async () => {
    const w = world()
    const macbook = mac(w)
    const tools = Array.from({ length: 12 }, (_, index) => `mcp_a_server_with_a_long_name_tool_number_${index}`.padEnd(45, 'x'))
    macbook.execute.mockImplementationOnce(failing(usedTool(...tools)))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    const text = (macbook.execute.mock.calls[1]![0] as ExecuteInput).text
    expect(text.startsWith('Delete the old drafts\n\n[Atum note')).toBe(true)
    expect(text).toContain('Do not repeat or redo any action')
    expect(text).toContain('tell the person')
  })

  it('runs it again with the warning, and the person\u2019s whole message, when the message is the longest allowed', async () => {
    const w = world()
    w.room.message.content = { msgtype: 'm.text', body: 'y'.repeat(39_900) }
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(failing(usedTool('terminal')))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    const text = (macbook.execute.mock.calls[1]![0] as ExecuteInput).text
    expect(text.length).toBeLessThanOrEqual(48_000)
    expect(text).toContain('tell the person')
    // The warning is never what gives way, and none of the person's words are cut.
    expect(text.startsWith('y'.repeat(39_900))).toBe(true)
  })

  it('queues it again even when the run was cut off from the platform: the proof does not need the lease', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(async ({ effects }: ExecuteInput) => {
      effects?.attach()
      macbook.abort.abort()
      throw new Error('matrix_hermes_outcome_unknown')
    })

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    // Sent on its own authority: the lease token is optional for a requeue, never required.
    expect(w.ledger.calls.at(-1)).toMatchObject({ operation: 'requeue' })
  })
})

describe('case b: a side-effecting tool may have run', () => {
  it('goes back once as a check: one short line, then a prompt that forbids repeating anything, after the owner’s words', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(failing(usedTool('read_file', 'terminal', 'write_file')))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(w.ledger.row?.resume).toEqual({ attempt: 1, effect: 'side_effect_possible', tools: ['terminal', 'write_file'] })
    // The owner hears one human line, not a status and not "couldn't confirm".
    expect(w.room.lines()).toHaveLength(1)
    expect(w.room.lines()[0]).toMatchObject({ roomId: ROOM, eventId: EVENT, body: matrixCheckingLine('vi') })
    expect(w.room.results()).toHaveLength(0)

    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    const { text } = macbook.execute.mock.calls[1]![0] as ExecuteInput
    expect(text.startsWith('Delete the old drafts\n\n[Atum note, not written by the person')).toBe(true)
    expect(text).toContain('terminal, write_file')
    expect(text).not.toContain('read_file')
    expect(text).toContain('This turn is only a check. Do not repeat or redo any action')
    expect(text).toContain('ask whether to do it')
    // One message: the owner's text is untouched and nothing is added as another message.
    expect(macbook.execute.mock.calls[1]![0]).toMatchObject({ text })
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.lines()).toHaveLength(1)
  })

  it('says the notice instead, and no "checking" line, when the platform will not put the message back again (its limit is two)', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute
      .mockImplementationOnce(failing(submitted))
      .mockImplementationOnce(failing(submitted))
      .mockImplementationOnce(failing(usedTool('terminal')))

    expect(await macbook.run()).toMatchObject({ state: 'deferred' })
    expect(await macbook.run()).toMatchObject({ state: 'deferred' })
    // The third run acted and was cut off, but the platform has put the message back twice already: refused, so the owner is told.
    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.lines()).toHaveLength(0)
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
    expect(macbook.execute).toHaveBeenCalledTimes(3)
  })

  it('hands the facts to whichever Mac takes it next', async () => {
    const w = world()
    const macbook = mac(w)
    const mini = mac(w)
    macbook.execute.mockImplementationOnce(failing(usedTool('terminal')))

    expect(await macbook.run()).toMatchObject({ state: 'deferred' })
    expect(await mini.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect((mini.execute.mock.calls[0]![0] as ExecuteInput).text).toContain('terminal')
    expect((mini.execute.mock.calls[0]![0] as ExecuteInput).text).toContain('Atum note')
  })

  it('checks a message once: when the check is cut off too, the owner is told once and nothing loops', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute.mockImplementation(failing(usedTool('terminal')))

    expect(await macbook.run()).toMatchObject({ state: 'deferred' })
    // The second run is the check; it is cut off as well and the owner gets the single notice.
    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(macbook.execute).toHaveBeenCalledTimes(2)
    expect(w.room.lines()).toHaveLength(1)
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
    expect(w.ledger.row).toMatchObject({ state: 'completed', publishedEvent: '$answer-1' })

    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(macbook.execute).toHaveBeenCalledTimes(2)
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.lines()).toHaveLength(1)
  })
})

describe('what earlier runs of the same message did is not forgotten', () => {
  it('keeps the facts when the check only read: a check that is cut off still ends in "could not confirm", not a second check', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute
      .mockImplementationOnce(failing(usedTool('terminal')))
      .mockImplementationOnce(failing(usedTool('read_file')))

    expect(await macbook.run()).toMatchObject({ state: 'deferred' })
    expect(w.ledger.row?.resume).toEqual({ attempt: 1, effect: 'side_effect_possible', tools: ['terminal'] })

    // The check only read, but the first run may have run the terminal: the facts add up and no second check follows.
    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect((macbook.execute.mock.calls[1]![0] as ExecuteInput).text).toContain('terminal')
    expect(macbook.execute).toHaveBeenCalledTimes(2)
    // Not "failed, try again" (the last run only read) but what is true of the message.
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
    expect(w.room.lines()).toHaveLength(1)
  })
})

describe('case c: otherwise the owner is told, once', () => {
  it('posts "could not confirm" for a run nobody tracked, under the ledger’s own transaction', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute.mockRejectedValueOnce(new Error('lost process'))

    // The owner is told; the run still ended without an answer, and counts as such.
    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'unexpected' })
    const [notice] = w.room.results()
    expect(notice).toMatchObject({
      status: 'couldnt_confirm',
      roomId: ROOM,
      eventId: EVENT,
      transactionId: w.ledger.row!.transactionId,
      invocationId: w.ledger.row!.fence
    })
    // What happened and what to say next, never a "couldn't confirm" meta-notice.
    expect(String(notice!.body)).toMatch(/ngắt giữa chừng/)
    expect(String(notice!.body)).not.toMatch(/chưa xác nhận/)
    expect(String(notice!.body)).toContain('kiểm tra lại')
    expect(w.ledger.row).toMatchObject({ state: 'completed', publishedEvent: '$answer-1' })
    expect(macbook.lines().join('\n')).toContain('[Matrix] invocation notice code=couldnt_confirm source=failure')
  })

  it('says it in the owner’s language', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute.mockRejectedValueOnce(new Error('lost process'))
    ;(macbook.deps as { ownerLocale?: () => string }).ownerLocale = () => 'en'

    await macbook.run()
    expect(String(w.room.results()[0]!.body)).toMatch(/cut off partway/)
    expect(String(w.room.results()[0]!.body)).not.toMatch(/couldn’t confirm/)
  })

  it('says "failed, try again" when the run is shown to have changed nothing but could not be queued', async () => {
    const w = world({ requeue: false })
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(failing(() => {}))

    // An older platform has no requeue: the owner still hears, instead of nothing.
    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.results()[0]).toMatchObject({ status: 'failed' })
    expect(macbook.execute).toHaveBeenCalledOnce()
  })

  it('does not run a run that hit its time limit again, however Hermes reported it', async () => {
    // Hermes ends every failed turn with the same closed code and no cause (hermes-turn.ts), so the
    // time limit is known from the run's own deadline, never from the error.
    vi.useFakeTimers({ toFake: ['Date'] })
    const w = world()
    const macbook = mac(w)

    macbook.execute.mockImplementationOnce(async ({ effects, deadlineAt }: ExecuteInput) => {
      effects?.attach()
      usedTool('terminal')(effects!)
      vi.setSystemTime(deadlineAt + 1_000)

      throw new Error('matrix_hermes_outcome_unknown')
    })

    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
    expect(macbook.execute).toHaveBeenCalledOnce()
    expect(w.ledger.operations()).not.toContain('requeue')
  })

  it('still queues a failure again that came before the time limit, whatever its error chain', async () => {
    const w = world()
    const macbook = mac(w)
    // Even a chain that names a timeout: only the deadline decides.
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    macbook.execute.mockImplementationOnce(failing(usedTool('terminal'), new Error('matrix_hermes_outcome_unknown', { cause: timeout })))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(w.ledger.operations()).toContain('requeue')
  })

  it('says nothing and queues nothing when the owner stopped the run', async () => {
    const w = world()
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(
      failing(usedTool('terminal'), new Error('matrix_turn_stopped', { cause: new Error('matrix_hermes_outcome_unknown') }))
    )

    expect(await macbook.run()).toMatchObject({ state: 'unknown' })
    expect(w.room.results()).toHaveLength(0)
    expect(w.ledger.operations()).toEqual(['recover', 'claim', 'dispatch', 'heartbeat'])
    // Offered again, it stays stopped: nothing is run and nothing is said, however long it waits.
    expect(await macbook.run()).toEqual({ state: 'ignored' })
    expect(macbook.execute).toHaveBeenCalledOnce()
    expect(w.room.results()).toHaveLength(0)
    expect(macbook.lines()).toContain('[Matrix] invocation left alone: the owner stopped it')
  })

  it('keeps Stop final when it lands while the failed run is being queued again', async () => {
    const w = world()
    const macbook = mac(w)
    let stopped = false
    const reach = macbook.deps.authorize.getMockImplementation()!

    // The owner presses Stop while the platform is being asked to queue the message again.
    macbook.deps.authorize.mockImplementation(async input => {
      const answer = await reach(input)

      if (input.operation === 'requeue') {
        stopped = true
      }

      return answer
    })
    ;(macbook.deps as { stopped?: () => boolean }).stopped = () => stopped
    macbook.execute.mockImplementationOnce(failing(usedTool('terminal')))

    expect(await macbook.run()).toMatchObject({ state: 'unknown' })
    expect(w.room.results()).toHaveLength(0)

    // The queued claim cannot be taken back, but this Mac never takes it: nothing runs, nothing is said.
    expect(await macbook.run()).toEqual({ state: 'ignored' })
    expect(macbook.execute).toHaveBeenCalledOnce()
    expect(w.room.results()).toHaveLength(0)
  })

  it('does not post a notice for a run the owner stopped while the platform was unreachable', async () => {
    const w = world({ requeue: false })
    const macbook = mac(w)
    let stopped = false
    ;(macbook.deps as { stopped?: () => boolean }).stopped = () => stopped

    macbook.execute.mockImplementationOnce(async ({ effects }: ExecuteInput) => {
      effects?.attach()
      usedTool('terminal')(effects!)
      stopped = true

      throw new Error('matrix_hermes_outcome_unknown')
    })

    expect(await macbook.run()).toMatchObject({ state: 'unknown' })
    expect(w.room.results()).toHaveLength(0)
    expect(await macbook.run()).toEqual({ state: 'ignored' })
  })

  it.each([
    ['a side effect may have run', usedTool('terminal'), 'couldnt_confirm'],
    ['it only read', submitted, 'failed']
  ] as const)(
    'says so instead of queuing it again when the message can no longer be started (%s)',
    async (_name, before, status) => {
      // The run took almost the whole automatic window: a retry's wait would end past the window, where the
      // listener would give up on it and the freshness check refuse it. Queued, it would be silence.
      const w = world({ age: MATRIX_AUTOMATIC_WINDOW_MS - 10_000 })
      const macbook = mac(w)
      macbook.execute.mockImplementationOnce(failing(before))

      expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
      expect(w.ledger.operations()).not.toContain('requeue')
      expect(w.room.results()).toHaveLength(1)
      expect(w.room.results()[0]).toMatchObject({ status })
      expect(macbook.lines()).toContain('[Matrix] invocation requeue skipped reason=window_closed')
    }
  )

  it('keeps queuing it again while the window leaves room to start it', async () => {
    // Four minutes left: the first retry (5 s) and its margin fit easily.
    const w = world({ age: MATRIX_AUTOMATIC_WINDOW_MS - 4 * 60_000 })
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(failing(submitted))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(w.room.results()).toHaveLength(0)
  })

  it('says so when the listener has no retry left to give it, however much window is left', async () => {
    const w = world()
    const macbook = mac(w)
    ;(macbook.deps as { line?: { queuedAt: number; spent: number } }).line = {
      queuedAt: Date.now(),
      spent: MATRIX_DEFERRED_RETRY_MS.length
    }
    macbook.execute.mockImplementationOnce(failing(submitted))

    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.ledger.operations()).not.toContain('requeue')
    expect(w.room.results()[0]).toMatchObject({ status: 'failed' })
  })

  it('uses the wait its next retry would have: the third retry waits longest', async () => {
    // spent = 2: the next wait is 45 s, so a message with less than 75 s of window is said, not queued.
    const w = world({ age: MATRIX_AUTOMATIC_WINDOW_MS - 50_000 })
    const macbook = mac(w)
    ;(macbook.deps as { line?: { queuedAt: number; spent: number } }).line = { queuedAt: Date.now(), spent: 2 }
    macbook.execute.mockImplementationOnce(failing(submitted))

    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.ledger.operations()).not.toContain('requeue')
  })

  it('tells the owner when a run is cut off after its message can no longer be settled later', async () => {
    // A cut-off run cannot speak, and the next sighting would be refused as too old: its last chance.
    const w = world({ age: MATRIX_AUTOMATIC_WINDOW_MS - 5_000 })
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))

    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
  })

  it('does not tell the owner twice when a cut-off run finds the window closed and the other Mac already reported', async () => {
    const w = world({ age: MATRIX_AUTOMATIC_WINDOW_MS - 5_000 })
    const macbook = mac(w)

    macbook.deps.read = vi.fn(async (command: Parameters<typeof w.room.read>[0]) =>
      command.kind === 'readResult' ? { state: 'published', eventId: '$their-notice' } : w.room.read(command)
    ) as typeof macbook.deps.read
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))

    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.results()).toHaveLength(0)
  })

  it('agrees with the listener on the last retry: a claim about to lapse means the one notice, not a dropped requeue', async () => {
    // Two retries spent; the third waits 45 s and needs 30 s of claim beyond that. This claim has 60 s left.
    const w = world()
    const macbook = mac(w)
    ;(macbook.deps as { line?: { queuedAt: number; spent: number; claimUntil: number } }).line = {
      queuedAt: Date.now(),
      spent: MATRIX_DEFERRED_RETRY_MS.length - 1,
      claimUntil: Date.now() + 60_000
    }
    macbook.execute.mockImplementationOnce(failing(submitted))

    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.ledger.operations()).not.toContain('requeue')
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).toMatchObject({ status: 'failed' })
  })

  it('still queues it again on the last retry when the claim reaches past it', async () => {
    const w = world()
    const macbook = mac(w)
    ;(macbook.deps as { line?: { queuedAt: number; spent: number; claimUntil: number } }).line = {
      queuedAt: Date.now(),
      spent: MATRIX_DEFERRED_RETRY_MS.length - 1,
      claimUntil: Date.now() + 10 * 60_000
    }
    macbook.execute.mockImplementationOnce(failing(submitted))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(w.room.results()).toHaveLength(0)
  })

  it('does not queue a run again that another Mac has already reported (it took over the lease)', async () => {
    const w = world()
    const macbook = mac(w)

    macbook.deps.read = vi.fn(async (command: Parameters<typeof w.room.read>[0]) =>
      command.kind === 'readResult' ? { state: 'published', eventId: '$their-notice' } : w.room.read(command)
    ) as typeof macbook.deps.read

    // Its lease moved: the run was cut off, with a side effect possible.
    macbook.execute.mockImplementationOnce(async ({ effects }: ExecuteInput) => {
      effects?.attach()
      usedTool('terminal')(effects!)
      macbook.abort.abort()

      throw new Error('matrix_hermes_outcome_unknown')
    })

    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.ledger.operations()).not.toContain('requeue')
    expect(w.room.results()).toHaveLength(0)
    // And what it keeps says so: a later sighting answers with that notice, not a second run.
    expect(await mac(w, { store: macbook.vault, like: macbook }).run()).toEqual({
      state: 'published',
      eventId: '$their-notice'
    })
  })

  it('does not act on a saved verdict once another Mac has reported the message', async () => {
    const w = world({ requeue: false })
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(async ({ effects }: ExecuteInput) => {
      effects?.attach()
      submitted(effects!)
      macbook.abort.abort()

      throw new Error('matrix_hermes_outcome_unknown')
    })
    await macbook.run()

    const reported = w.ledger.operations().length
    const again = mac(w, { store: macbook.vault, like: macbook })
    again.deps.read = vi.fn(async (command: Parameters<typeof w.room.read>[0]) =>
      command.kind === 'readResult' ? { state: 'published', eventId: '$their-notice' } : w.room.read(command)
    ) as typeof again.deps.read

    expect(await again.run()).toEqual({ state: 'published', eventId: '$their-notice' })
    expect(again.execute).not.toHaveBeenCalled()
    expect(w.ledger.operations().slice(reported)).not.toContain('requeue')
  })

  it('does not speak for a run that was cut off: the next sighting tells the owner', async () => {
    const w = world({ age: 3 * 60_000 })
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))

    // Cut off and nothing proven: its host is gone, so it posts nothing now.
    expect(await macbook.run()).toMatchObject({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.results()).toHaveLength(0)

    // A fresh look at the message (a new watch of the same Mac): it says so, once.
    const again = mac(w, { store: macbook.vault, like: macbook })
    expect(await again.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(again.execute).not.toHaveBeenCalled()
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
    // It was this Mac's own record, so the ledger holds the notice too: no other Mac repeats it.
    expect(w.ledger.row).toMatchObject({ state: 'completed', publishedEvent: '$answer-1' })
  })
})

describe('the next holder', () => {
  it('lets the Mac that dispatched it settle first, then runs it when it did', async () => {
    vi.useFakeTimers()
    const w = world({ age: 30_000 })
    const macbook = mac(w)
    const mini = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))
    await macbook.run()
    expect(w.ledger.row?.state).toBe('dispatched')

    // The mini finds the message dispatched, with the grace (counted from the message) still running.
    const pending = mini.run()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(mini.execute).not.toHaveBeenCalled()
    expect(w.room.results()).toHaveLength(0)

    // The MacBook, back on the network, queues it again from what it kept.
    await w.ledger.as(macbook.executorId, macbook.deviceId)({
      operation: 'requeue',
      roomId: ROOM,
      eventId: EVENT,
      requestHash: w.ledger.row!.requestHash,
      senderDevice: 'PHONE',
      invocationId: w.ledger.row!.fence,
      effect: 'read_only',
      tools: []
    })
    await vi.advanceTimersByTimeAsync(5_000)

    // The mini takes it from the record and answers it: one answer, no notice.
    expect(await pending).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(mini.execute).toHaveBeenCalledOnce()
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).not.toHaveProperty('status')
  })

  it('leaves it alone when the record moved on to another run meanwhile', async () => {
    vi.useFakeTimers()
    const w = world({ age: 30_000 })
    const macbook = mac(w)
    const mini = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))
    await macbook.run()

    const pending = mini.run()
    await vi.advanceTimersByTimeAsync(6_000)
    // Another run took it (a new fence, dispatched again): its holder has it, and nothing is said.
    w.ledger.row!.fence = randomUUID()
    await vi.advanceTimersByTimeAsync(6_000)

    expect(await pending).toEqual({ state: 'unknown' })
    expect(w.room.results()).toHaveLength(0)
    expect(mini.execute).not.toHaveBeenCalled()
  })

  it('says it could not confirm once the grace has passed, under a transaction every Mac would use', async () => {
    vi.useFakeTimers()
    const w = world({ age: 2 * 60_000 })
    const macbook = mac(w)
    const mini = mac(w)
    const other = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))
    await macbook.run()

    // The message is already two minutes old, but the mini has only just found it held: the grace
    // runs from that sighting, so the Mac that dispatched it is given the time to settle it.
    const waiting = mini.run()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.room.results()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await waiting).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(mini.execute).not.toHaveBeenCalled()
    expect(mini.lines()).toEqual([
      '[Matrix] invocation recover skipped state=dispatched',
      '[Matrix] invocation notice code=couldnt_confirm source=recover'
    ])
    const [first] = w.room.results()
    expect(first).toMatchObject({ status: 'couldnt_confirm' })
    expect(first!.transactionId).toBe(first!.invocationId)

    // Offered to this Mac again: the same notice, not a second.
    expect(await mini.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(w.room.results()).toHaveLength(1)

    // Another Mac that never saw the first one posts under the very same transaction (after its
    // own grace, from its own first sighting).
    const next = other.run()
    await vi.advanceTimersByTimeAsync(91_000)
    expect(await next).toEqual({ state: 'published', eventId: '$answer-2' })
    expect(w.room.results()[1]!.transactionId).toBe(first!.transactionId)
  })

  it('keeps the first sighting across a restart, so the grace is not started again', async () => {
    vi.useFakeTimers()
    const w = world({ age: 2 * 60_000 })
    const macbook = mac(w)
    const mini = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))
    await macbook.run()

    const first = mini.run()
    await vi.advanceTimersByTimeAsync(60_000)
    // The mini's app restarts (its vault survives): 30 s of the grace are left, not 90.
    mini.abort.abort()
    await first.catch(() => undefined)
    const restarted = mac(w, { store: mini.vault, like: mini })
    const second = restarted.run()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(w.room.results()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await second).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
  })

  it('never says anything about a record that was completed: its Mac has the answer and posts it', async () => {
    const w = world({ age: 5 * 60_000 })
    const macbook = mac(w)
    const mini = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))
    await macbook.run()
    // The MacBook finished its run and holds the answer; its post has not gone out yet.
    w.ledger.row!.state = 'completed'
    w.ledger.row!.transactionId = randomUUID()

    expect(await mini.run()).toEqual({ state: 'unknown' })
    expect(mini.execute).not.toHaveBeenCalled()
    expect(w.room.results()).toHaveLength(0)
    expect(w.ledger.operations()).not.toContain('requeue')
  })

  it('stops waiting without a notice when the record is completed while it waits', async () => {
    vi.useFakeTimers()
    const w = world({ age: 30_000 })
    const macbook = mac(w)
    const mini = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))
    await macbook.run()

    const waiting = mini.run()
    await vi.advanceTimersByTimeAsync(7_000)
    w.ledger.row!.state = 'completed'
    w.ledger.row!.transactionId = randomUUID()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(await waiting).toEqual({ state: 'unknown' })
    expect(w.room.results()).toHaveLength(0)
  })

  it('answers with the notice this Mac already posted when its record was completed by it', async () => {
    const w = world({ age: 5 * 60_000 })
    const mini = mac(w)
    mini.execute.mockImplementationOnce(cutOff(mini.abort))
    await mini.run()
    // Its notice reached the room and its vault, and the ledger was completed by it; the post's
    // acknowledgement was lost.
    const effects = [...mini.vault.entries.keys()].find(key => key.startsWith('matrix-effects-'))!
    mini.vault.entries.set(effects.replace('matrix-effects-', 'matrix-notice-'), JSON.stringify({ eventId: '$its-notice', code: 'couldnt_confirm' }))
    w.ledger.row!.state = 'completed'
    w.ledger.row!.transactionId = randomUUID()

    const again = mac(w, { store: mini.vault, like: mini })
    expect(await again.run()).toEqual({ state: 'published', eventId: '$its-notice' })
    expect(w.room.results()).toHaveLength(0)
  })

  it('never settles a run that is still going in this process', async () => {
    const w = world({ age: 2 * 60_000 })
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))

    const macbook = mac(w, {
      execute: async () => {
        await held

        return { text: 'late answer', storedSession: 'session' }
      }
    })

    const first = macbook.run()
    await vi.waitFor(() => expect(macbook.execute).toHaveBeenCalledOnce())

    // The same message offered again while its run goes on (a new watch's scan): left alone.
    expect(await macbook.run()).toEqual({ state: 'unknown' })
    expect(w.ledger.operations()).not.toContain('requeue')
    expect(w.room.results()).toHaveLength(0)

    release()
    expect(await first).toEqual({ state: 'published', eventId: '$answer-1' })
  })
})

describe('a Mac that crashes or loses the platform', () => {
  it('proves a run that was dispatched and never submitted ran nothing, even after a restart', async () => {
    const w = world({ age: 2 * 60_000 })
    let started!: () => void
    const reached = new Promise<void>(resolve => (started = resolve))
    const never = new Promise<never>(() => {})

    const before = mac(w, {
      execute: async () => {
        started()

        return never
      }
    })

    void before.run()
    await reached

    // The process dies here: only what was durable survives, and in a new process.
    const restarted = mac(w, { store: vault(before.vault.entries), like: before })
    expect(await restarted.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(restarted.execute).toHaveBeenCalledOnce()
    expect((restarted.execute.mock.calls[0]![0] as ExecuteInput).text).toBe('Delete the old drafts')
    expect(w.room.results()[0]).not.toHaveProperty('status')
    expect(w.ledger.operations()).toContain('requeue')
  })

  it('cannot prove a run that was submitted before it crashed, and says so once', async () => {
    const w = world({ age: 2 * 60_000 })
    let started!: () => void
    const reached = new Promise<void>(resolve => (started = resolve))
    const never = new Promise<never>(() => {})

    const before = mac(w, {
      execute: async ({ effects, onSubmit }: ExecuteInput) => {
        effects?.attach()
        onSubmit?.()
        effects?.submit()
        started()

        return never
      }
    })

    void before.run()
    await reached

    const restarted = mac(w, { store: vault(before.vault.entries), like: before })
    expect(await restarted.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(restarted.execute).not.toHaveBeenCalled()
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
    expect(w.ledger.operations()).not.toContain('requeue')
  })

  it('keeps its verdict when it cannot reach the platform, and settles on the next sighting', async () => {
    const w = world()
    const macbook = mac(w)
    const reach = macbook.deps.authorize.getMockImplementation()!
    let down = true

    macbook.deps.authorize.mockImplementation(async input => {
      if (down && input.operation === 'requeue') {
        throw new Error('matrix_invocation_unavailable')
      }

      return reach(input)
    })
    // It only read, and was cut off; the platform cannot be reached to say so.
    macbook.execute.mockImplementationOnce(async ({ effects }: ExecuteInput) => {
      effects?.attach()
      submitted(effects!)
      macbook.abort.abort()
      throw new Error('matrix_hermes_outcome_unknown')
    })
    expect(await macbook.run()).toMatchObject({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.results()).toHaveLength(0)
    const kept = [...macbook.vault.entries.entries()].filter(([key]) => key.startsWith('matrix-effects-'))
    expect(kept).toHaveLength(1)
    expect(JSON.parse(kept[0]![1])).toMatchObject({ phase: 'failed', effect: 'read_only' })

    // Back on the network, in a new watch of the same Mac: the saved verdict queues it again.
    down = false
    const again = mac(w, { store: macbook.vault, like: macbook })
    expect(await again.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(again.execute).toHaveBeenCalledOnce()
    expect(w.ledger.operations()).toContain('requeue')
  })
})

describe('a dispatch whose answer never came back', () => {
  it('ran nothing, so the next sighting queues it again and answers it', async () => {
    const w = world({ age: 2 * 60_000 })
    const macbook = mac(w)
    const reach = macbook.deps.authorize.getMockImplementation()!
    let lose = true

    macbook.deps.authorize.mockImplementation(async input => {
      const answer = await reach(input)

      if (lose && input.operation === 'dispatch') {
        lose = false

        throw new Error('matrix_invocation_unavailable')
      }

      return answer
    })

    // The platform dispatched; the response was lost. Nothing was handed to Hermes.
    await expect(macbook.run()).rejects.toThrow('matrix_invocation_unavailable')
    expect(macbook.execute).not.toHaveBeenCalled()
    expect(w.ledger.row?.state).toBe('dispatched')

    // Seen again by the same Mac (a new watch): its own record shows it never submitted.
    const again = mac(w, { store: macbook.vault, like: macbook })
    expect(await again.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(again.execute).toHaveBeenCalledOnce()
    expect(w.ledger.operations()).toContain('requeue')
    expect(w.room.results()[0]).not.toHaveProperty('status')
  })
})

describe('only the listener’s private-chat turns settle', () => {
  it('leaves an explicit run as it was: failed after dispatch, never run again, nothing posted', async () => {
    const w = world()
    // Typed on this device and run by the person's own consent: no listener to run it again.
    w.room.message.senderDevice = HUMAN.deviceId
    const macbook = mac(w)
    macbook.execute.mockImplementationOnce(failing(() => {}))
    const deps = { ...macbook.deps, watch: undefined, automatic: undefined }

    expect(await invokeMatrixHermes(deps, { roomId: ROOM, eventId: EVENT }, macbook.abort.signal)).toEqual({
      state: 'unknown',
      failed: 'matrix_hermes_outcome_unknown'
    })
    expect(await invokeMatrixHermes(deps, { roomId: ROOM, eventId: EVENT }, macbook.abort.signal)).toEqual({
      state: 'unknown'
    })
    expect(macbook.execute).toHaveBeenCalledOnce()
    expect(w.ledger.operations()).toEqual(['claim', 'dispatch', 'claim'])
    expect(w.room.results()).toHaveLength(0)
  })
})

describe('this Mac’s own records (a local agent answering under its lease)', () => {
  it('queues a run again from its own record and answers it', async () => {
    const w = world()
    const macbook = mac(w, { automatic: false })
    macbook.execute.mockImplementationOnce(failing(usedTool('terminal')))

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect((macbook.execute.mock.calls[1]![0] as ExecuteInput).text).toContain('Atum note')
    // The shared ledger was never involved: this agent's records are local.
    expect(w.ledger.calls).toHaveLength(0)
  })

  it('checks once, then tells the owner when the check is cut off too', async () => {
    const w = world()
    const macbook = mac(w, { automatic: false })
    macbook.execute.mockImplementation(failing(usedTool('terminal')))

    expect(await macbook.run()).toMatchObject({ state: 'deferred' })
    expect(w.room.lines()).toHaveLength(1)
    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.results()[0]).toMatchObject({ status: 'couldnt_confirm' })
    expect(macbook.execute).toHaveBeenCalledTimes(2)
    // Offered again: the record knows the notice, nothing is run or said again.
    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(macbook.execute).toHaveBeenCalledTimes(2)
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.lines()).toHaveLength(1)
  })
})

/**
 * Cross-family review of R3 (Muse Spark 1.3, 2026-10-17), findings 2 and 3: the owner is never left
 * silent when the platform cannot queue a message again, and never told twice.
 */
describe('a claim that lapses before its dispatch lands', () => {
  /** The platform records the dispatch on a claim that had lapsed, and returns a grant that is already over. */
  const lapsing = (macbook: ReturnType<typeof mac>) => {
    const reach = macbook.deps.authorize.getMockImplementation()!

    macbook.deps.authorize.mockImplementation(async input => {
      const answer = await reach(input)

      return input.operation === 'dispatch' ? ({ ...answer, expiresAt: Date.now() - 1 } as typeof answer) : answer
    })
  }

  it('queues it again when the platform can, and the next holder answers it', async () => {
    const w = world({ age: 60_000 })
    const macbook = mac(w)
    lapsing(macbook)

    expect(await macbook.run()).toMatchObject({ state: 'deferred', reason: 'matrix_requeued' })
    expect(macbook.execute).not.toHaveBeenCalled()
    expect(w.ledger.row?.resume).toMatchObject({ attempt: 1, effect: 'none' })
    expect(w.room.results()).toHaveLength(0)

    const again = mac(w, { store: macbook.vault, like: macbook })
    expect(await again.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(again.execute).toHaveBeenCalledOnce()
    expect(w.room.results()[0]).not.toHaveProperty('status')
  })

  it('on an older platform that cannot queue it, offers it again while the window lasts, and then says so once', async () => {
    const w = world({ requeue: false, age: 60_000 })
    const macbook = mac(w)
    lapsing(macbook)

    // Not silent, and nothing run: deferred, so the listener offers it again.
    expect(await macbook.run()).toMatchObject({ state: 'deferred' })
    expect(macbook.execute).not.toHaveBeenCalled()
    expect(w.ledger.operations()).toContain('requeue')
    expect(w.room.results()).toHaveLength(0)

    // The offer again finds its own record (dispatched, never submitted: nothing ran) and says so.
    const again = mac(w, { store: macbook.vault, like: macbook })
    expect(await again.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(again.execute).not.toHaveBeenCalled()
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).toMatchObject({ status: 'failed' })

    // And seen yet again, it is the same notice, never a second.
    expect(await mac(w, { store: macbook.vault, like: macbook }).run()).toEqual({
      state: 'published',
      eventId: '$answer-1'
    })
    expect(w.room.results()).toHaveLength(1)
  })

  it('on an older platform, says so at once when the listener has no retry left to offer it', async () => {
    const w = world({ requeue: false, age: 60_000 })
    const macbook = mac(w)
    const listening = macbook.deps as { line?: { queuedAt: number; spent: number } }

    // The listener has no retry left to give this message.
    listening.line = { queuedAt: Date.now(), spent: MATRIX_DEFERRED_RETRY_MS.length }
    lapsing(macbook)

    expect(await macbook.run()).toEqual({ state: 'published', eventId: '$answer-1' })
    expect(macbook.execute).not.toHaveBeenCalled()
    expect(w.room.results()).toHaveLength(1)
    expect(w.room.results()[0]).toMatchObject({ status: 'failed' })
    expect(macbook.lines()).toContain('[Matrix] invocation notice code=failed source=dispatch')
  })
})

describe('the owner is told once, whichever Mac tells them first', () => {
  it('sees the "failed" notice another Mac posted, not only the "could not confirm" one', async () => {
    // A cut-off run that only read, its window closed: its notice is "failed, try again".
    const w = world({ age: MATRIX_AUTOMATIC_WINDOW_MS - 5_000 })
    const macbook = mac(w)

    const theirs = matrixStatusTransaction({
      agentPrincipal: w.ledger.agentPrincipal,
      roomId: ROOM,
      eventId: EVENT,
      code: 'failed'
    })

    macbook.deps.read = vi.fn(async (command: Parameters<typeof w.room.read>[0]) =>
      command.kind === 'readResult' && (command as { transactionId?: string }).transactionId === theirs
        ? { state: 'published', eventId: '$their-failed' }
        : w.room.read(command)
    ) as typeof macbook.deps.read
    macbook.execute.mockImplementationOnce(async ({ effects }: ExecuteInput) => {
      effects?.attach()
      submitted(effects!)
      macbook.abort.abort()
      throw new Error('matrix_hermes_outcome_unknown')
    })

    expect(await macbook.run()).toEqual({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(w.room.results()).toHaveLength(0)
  })

  /** A Mac that waits out its grace on a record another Mac dispatched; `settle` happens just after its last poll. */
  const waitsThenFindsItSettled = async (
    settle: (mini: ReturnType<typeof mac>, around: ReturnType<typeof world>) => void
  ) => {
    vi.useFakeTimers()
    const w = world({ age: 2 * 60_000 })
    const macbook = mac(w)
    const mini = mac(w)
    macbook.execute.mockImplementationOnce(cutOff(macbook.abort))
    await macbook.run()

    const reach = mini.deps.authorize.getMockImplementation()!
    const lastPoll = Date.now() + 90_000
    let polls = 0

    mini.deps.authorize.mockImplementation(async input => {
      const answer = await reach(input)

      // The first look at the grace's end is the loop's last poll, and it still finds the record held.
      if (input.operation === 'recover' && Date.now() >= lastPoll && ++polls === 1) {
        settle(mini, w)
      }

      return answer
    })

    const waiting = mini.run()
    await vi.advanceTimersByTimeAsync(91_000)

    return { w, mini, outcome: await waiting }
  }

  it('does not post after the grace when the Mac that ran it completed its answer or notice just after the last poll', async () => {
    const { w, mini, outcome } = await waitsThenFindsItSettled((_, ledgerWorld) => {
      ledgerWorld.ledger.row!.state = 'completed'
      ledgerWorld.ledger.row!.transactionId = randomUUID()
      ledgerWorld.ledger.row!.publishedEvent = '$their-notice'
    })

    expect(outcome).toEqual({ state: 'published', eventId: '$their-notice' })
    expect(mini.execute).not.toHaveBeenCalled()
    expect(w.room.results()).toHaveLength(0)
  })

  it('does not post after the grace when another Mac posted the notice under the shared transaction just after the last poll', async () => {
    const { w, mini, outcome } = await waitsThenFindsItSettled((waiting, around) => {
      waiting.deps.read = vi.fn(async (command: Parameters<typeof around.room.read>[0]) =>
        command.kind === 'readResult' ? { state: 'published', eventId: '$their-notice' } : around.room.read(command)
      ) as typeof waiting.deps.read
    })

    expect(outcome).toEqual({ state: 'published', eventId: '$their-notice' })
    expect(mini.execute).not.toHaveBeenCalled()
    expect(w.room.results()).toHaveLength(0)
  })
})
