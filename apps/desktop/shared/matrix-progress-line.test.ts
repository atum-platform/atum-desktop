import { describe, expect, it } from 'vitest'

import type { MatrixNoticeEdit } from './matrix-notice-edit'
import { MATRIX_PROGRESS_LIMITS } from './matrix-progress-kernel'
import {
  MATRIX_PROGRESS_HEADER_MAX,
  matrixHermesProgressEvent,
  MatrixProgressLine,
  type MatrixProgressLineOptions
} from './matrix-progress-line'

const target = { roomId: '!room:test', eventId: '$question' }
const ROOT = '$progress-root'

function harness(options: Partial<MatrixProgressLineOptions> = {}, publishFails?: (command: MatrixNoticeEdit) => boolean) {
  let clock = 1_000_000
  let live = true
  const sent: MatrixNoticeEdit[] = []
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []

  const line = new MatrixProgressLine(
    target,
    {
      current: () => live,
      publish: async command => {
        if (publishFails?.(command)) {
          throw new Error('boom')
        }

        sent.push(command)

        // Each original gets its own event id; an edit or removal names the one it changes.
        return command.replaces ?? `${ROOT}-${sent.filter(each => !each.replaces).length}`
      },
      now: () => clock,
      after: (milliseconds, run) => {
        const timer = { at: clock + milliseconds, run, cancelled: false }
        timers.push(timer)

        return () => {
          timer.cancelled = true
        }
      }
    },
    {
      privateChat: true,
      heartbeatText: minutes => `Vẫn đang làm · ${minutes} phút`,
      transactionFor: generation => `atum-cp-${String(generation).repeat(64)}`,
      ...options
    }
  )

  /** Move the clock, firing due timers in order; publication is awaited between steps. */
  const advance = async (milliseconds: number) => {
    const end = clock + milliseconds

    for (;;) {
      const due = timers.filter(timer => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0]

      if (!due) {
        break
      }

      clock = Math.max(clock, due.at)
      due.cancelled = true
      due.run()
      await Promise.resolve()
      await new Promise(resolve => setImmediate(resolve))
    }

    clock = end
    await new Promise(resolve => setImmediate(resolve))
  }

  const drain = () => new Promise(resolve => setImmediate(resolve))

  return { line, sent, advance, drain, stop: () => (live = false), now: () => clock }
}

describe('the working line (agent-turns/1.4)', () => {
  it('publishes the first activity as one reply carrying the marker, then edits that one message in place', async () => {
    const { line, sent, advance, drain } = harness()

    line.activity('Đang tra cứu trên web…')
    await drain()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      ...target,
      body: 'Đang tra cứu trên web…',
      statusLine: true,
      transactionId: `atum-cp-${'0'.repeat(64)}`,
      progress: { profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: 'working', kind: 'todo', revision: 0 }
    })
    expect(sent[0]).not.toHaveProperty('replaces')

    // Throttled: a second activity inside 3 s waits, then goes out as the first edit.
    await advance(1_000)
    line.activity('Đang đọc…')
    await drain()
    expect(sent).toHaveLength(1)
    await advance(MATRIX_PROGRESS_LIMITS.minEditMs)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ body: 'Đang đọc…', replaces: `${ROOT}-1`, revision: 1, progress: { revision: 1 } })
    expect(sent[1]).not.toHaveProperty('transactionId')
  })

  it('coalesces a burst of activity into the newest, so it is one edit', async () => {
    const { line, sent, advance } = harness()

    line.activity('One')
    line.activity('Two')
    line.activity('Three')
    await advance(MATRIX_PROGRESS_LIMITS.minEditMs + 10)
    expect(sent.map(command => command.body)).toEqual(['One', 'Three'])
  })

  it('shows the todo list as checkmarks under the activity', async () => {
    const { line, sent, advance } = harness()

    line.activity('Đang đọc…')
    await advance(MATRIX_PROGRESS_LIMITS.minEditMs + 10)
    line.plan([
      { text: 'Đọc lịch', state: 'done' },
      { text: 'Tóm tắt', state: 'active' }
    ])
    await advance(MATRIX_PROGRESS_LIMITS.minEditMs + 10)

    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ body: 'Đang đọc…\n✓ Đọc lịch\n• Tóm tắt', replaces: `${ROOT}-1`, progress: { kind: 'todo' } })
  })

  it('truncates a long activity so the list still fits the notice limit', async () => {
    const { line, sent, drain } = harness()

    line.activity('x'.repeat(5_000))
    await drain()
    expect([...sent[0]!.body].length).toBeLessThanOrEqual(MATRIX_PROGRESS_HEADER_MAX)
    expect(sent[0]!.body.endsWith('…')).toBe(true)
  })

  it('a wait replaces the text with the Mac named, and when it ends the line returns to the activity (never "waited")', async () => {
    const { line, sent, advance, drain } = harness()

    line.activity('Đang đọc…')
    await drain()
    await advance(MATRIX_PROGRESS_LIMITS.minEditMs + 10)
    line.wait('Đang chờ MacBook mẫu…', { device: 'MacBook mẫu' })
    await advance(MATRIX_PROGRESS_LIMITS.minEditMs + 10)
    expect(sent.at(-1)).toMatchObject({
      body: 'Đang chờ MacBook mẫu…',
      replaces: `${ROOT}-1`,
      progress: { kind: 'device', phase: 'waiting', device: 'MacBook mẫu' }
    })

    line.endWait()
    await advance(MATRIX_PROGRESS_LIMITS.minEditMs + 10)
    expect(sent.at(-1)).toMatchObject({ body: 'Đang đọc…', progress: { kind: 'todo', phase: 'working' } })
    expect(sent.map(command => command.body).join('|')).not.toMatch(/đã chờ|waited/i)
  })

  it('a wait that ends with nothing to return to removes the line, and a later activity starts a new one', async () => {
    const { line, sent, advance, drain } = harness()

    line.wait('Đang chờ MacBook mẫu…')
    await drain()
    expect(sent).toHaveLength(1)
    line.endWait()
    await drain()
    expect(sent.at(-1)).toMatchObject({ redact: true, replaces: `${ROOT}-1`, body: '' })

    await advance(MATRIX_PROGRESS_LIMITS.minEditMs + 10)
    line.activity('Đang đọc…')
    await drain()
    const reborn = sent.at(-1)!
    expect(reborn).toMatchObject({ body: 'Đang đọc…', progress: { revision: 0 }, transactionId: `atum-cp-${'1'.repeat(64)}` })
    expect(reborn).not.toHaveProperty('replaces')
  })

  it('REMOVES the line when the turn ends: drains what is in flight, drops the held update, ignores everything later', async () => {
    const { line, sent, advance, drain } = harness()

    line.activity('Đang đọc…')
    await drain()
    await advance(1_000)
    line.activity('Đang chạy tác vụ…')
    line.plan([{ text: 'Đọc lịch', state: 'done' }])
    await line.end()

    // The held update never goes out as a late edit; the original is simply removed, not collapsed.
    expect(sent.map(command => command.body)).toEqual(['Đang đọc…', ''])
    expect(sent.at(-1)).toEqual({ roomId: target.roomId, eventId: target.eventId, body: '', redact: true, replaces: `${ROOT}-1` })
    expect(sent.some(command => command.progress?.phase === 'settled')).toBe(false)
    const count = sent.length

    line.activity('Late')
    line.plan([{ text: 'Late', state: 'done' }])
    line.wait('Late wait')
    await advance(10_000)
    await line.end()
    expect(sent).toHaveLength(count)
  })

  it('removes a line whose first publication was still in flight when the turn ended', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))

    const line = new MatrixProgressLine(
      target,
      {
        current: () => true,
        publish: async command => {
          if (!command.replaces && !command.redact) {
            await gate
          }

          order.push(command.redact ? `redact:${command.replaces}` : `publish:${command.body}`)

          return '$root'
        },
        now: () => 1_000_000,
        after: () => () => undefined
      },
      { privateChat: true, heartbeatText: () => 'beat' }
    )

    line.activity('Đang đọc…')
    const ending = line.end()
    release()
    await ending
    expect(order).toEqual(['publish:Đang đọc…', 'redact:$root'])
  })

  it('retries a failed removal once, and never fails the turn', async () => {
    let failures = 1
    const { line, sent, advance, drain } = harness({}, command => command.redact === true && failures-- > 0)

    line.activity('Đang đọc…')
    await drain()
    const ending = line.end()
    await drain() // the first removal failed; its retry is waiting on a timer
    await advance(2_000)
    await expect(ending).resolves.toBeUndefined()
    expect(sent.filter(command => command.redact)).toHaveLength(1)
  })

  it('shows nothing in a group, and nothing when no activity ever came', async () => {
    const group = harness({ privateChat: false })
    group.line.activity('Hello')
    group.line.plan([{ text: 'A', state: 'done' }])
    group.line.wait('Waiting')
    await group.line.end()
    expect(group.sent).toEqual([])

    const quiet = harness()
    await quiet.line.end()
    expect(quiet.sent).toEqual([])
  })

  it('stops at the edit cap without ever settling', async () => {
    const { line, sent, advance } = harness()

    for (let index = 0; index < 120; index++) {
      line.activity(`Step ${index}`)
      await advance(MATRIX_PROGRESS_LIMITS.minEditMs + 10)
    }

    await line.end()
    const marked = sent.filter(command => command.progress)
    const revisions = marked.map(command => command.progress!.revision)
    expect(Math.max(...revisions)).toBeLessThanOrEqual(MATRIX_PROGRESS_LIMITS.maxEdits)
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(sent.at(-1)).toMatchObject({ redact: true })
  })

  it('says only that work continues, after three quiet minutes', async () => {
    const { line, sent, advance, drain } = harness()

    line.activity('Đang chạy tác vụ…')
    await drain()
    await advance(MATRIX_PROGRESS_LIMITS.heartbeatMs + 31_000)
    const beat = sent.at(-1)!
    expect(beat.body).toMatch(/^Vẫn đang làm · \d+ phút$/)
    expect(beat.progress).toMatchObject({ kind: 'heartbeat', heartbeat: true })
  })

  it('a root that cannot be published turns the line off for the turn without failing it', async () => {
    const { line, sent, advance, drain } = harness({}, command => command.replaces === undefined)

    line.activity('One')
    await drain()
    await advance(10_000)
    line.activity('Two')
    await advance(10_000)
    await expect(line.end()).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  it('publishes nothing once the turn has lost its fence', async () => {
    const { line, sent, stop, drain } = harness()

    stop()
    line.activity('One')
    await drain()
    await line.end()
    expect(sent).toEqual([])
  })
})

describe('reading Hermes events', () => {
  it('reads native interim text and accepts the legacy redacted projection', () => {
    expect(matrixHermesProgressEvent('message.interim', { text: 'raw', redacted_text: 'safe' })).toEqual({
      kind: 'narration',
      text: 'safe'
    })
    expect(matrixHermesProgressEvent('message.interim', { text: 'Safe native commentary', already_streamed: false })).toEqual({
      kind: 'narration', text: 'Safe native commentary'
    })
    expect(matrixHermesProgressEvent('message.interim', { text: '  ', already_streamed: false })).toBeUndefined()
    expect(matrixHermesProgressEvent('message.interim', { reasoning: 'hidden' })).toBeUndefined()
    expect(matrixHermesProgressEvent('reasoning.delta', { text: 'hidden' })).toBeUndefined()
    expect(matrixHermesProgressEvent('message.interim', { text: 'raw', redacted_text: '  ' })).toBeUndefined()
  })

  it('reads the todo list only from the redacted copy, mapping states and skipping cancelled steps', () => {
    const payload = {
      name: 'todo',
      todos: [{ id: '1', content: 'SECRET', status: 'completed' }],
      redacted_todos: [
        { id: '1', content: 'Đọc lịch', status: 'completed' },
        { id: '2', content: 'Tóm tắt', status: 'in_progress' },
        { id: '3', content: 'Gửi thư', status: 'pending' },
        { id: '4', content: 'Bỏ qua', status: 'cancelled' }
      ]
    }

    expect(matrixHermesProgressEvent('tool.complete', payload)).toEqual({
      kind: 'plan',
      todos: [
        { text: 'Đọc lịch', state: 'done' },
        { text: 'Tóm tắt', state: 'active' },
        { text: 'Gửi thư', state: 'pending' }
      ]
    })
    expect(matrixHermesProgressEvent('tool.complete', { name: 'todo', todos: payload.todos })).toBeUndefined()
    expect(matrixHermesProgressEvent('tool.complete', { ...payload, name: 'terminal' })).toBeUndefined()
    expect(matrixHermesProgressEvent('tool.start', payload)).toBeUndefined()
  })
})
