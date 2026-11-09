import { describe, expect, it, vi } from 'vitest'

import { MatrixInterimMessages } from '../../shared/matrix-interim-messages'
import type { MatrixNoticeEdit } from '../../shared/matrix-notice-edit'
import { MatrixProgressLine } from '../../shared/matrix-progress-line'
import { matrixAcknowledgementCopy } from '../../shared/matrix-status-line-copy'
import { macOwnerFacts, MATRIX_TURN_CONTEXT_HEADER, MATRIX_TURN_STYLE } from '../../shared/matrix-turn-style'
import { MatrixTurnVoice } from '../../shared/matrix-turn-voice'

import { runMatrixHermesTurn } from './hermes-turn'

/**
 * The Mac side of "acknowledge, then keep the owner posted", end to end: Hermes's own event
 * vocabulary (`message.interim` with `redacted_text`, `tool.start`, `tool.complete` of `todo`,
 * `message.complete`) through the real `runMatrixHermesTurn`, the shared `MatrixTurnVoice` wired
 * as main.ts and the Mac-typed engine wire it (`onProgress: event => voice.event(event)`), and
 * what reaches the owner's chat as `publishNotice` commands. The cloud side of the same
 * scenarios is `packages/cloud-controller/test/presentation-signals.test.ts`.
 */

type GatewayEvent = Parameters<Parameters<Parameters<typeof runMatrixHermesTurn>[0]['onAny']>[0]>[0]

const ROOM = '!room:test'
const QUESTION = '$question'

function mac(locale: 'vi' | 'en' = 'vi') {
  const handlers = new Set<(event: GatewayEvent) => void>()
  let clock = 1_000_000
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  const published: MatrixNoticeEdit[] = []
  const order: string[] = []

  const request = vi.fn(
    async (method: string): Promise<unknown> =>
      method === 'session.create'
        ? { session_id: 'own', stored_session_id: 'stored', async_delivery: false }
        : method === 'config.get'
          ? { value: 'all' }
          : { status: 'streaming' }
  )

  const gateway = {
    request: request as Parameters<typeof runMatrixHermesTurn>[0]['request'],
    onAny(handler: (event: GatewayEvent) => void) {
      handlers.add(handler)

      return () => void handlers.delete(handler)
    },
    onState(handler: (state: string) => void) {
      handler('open')

      return () => {}
    }
  }

  const port = {
    current: () => true,
    publish: async (command: MatrixNoticeEdit) => {
      published.push(command)
      order.push(
        command.redact
          ? `redact:${command.replaces}`
          : command.interim
            ? `message:${command.body}`
            : `line:${command.body}`
      )

      return command.replaces ?? (command.interim ? `$interim-${published.length}` : `$line-${published.length}`)
    },
    now: () => clock,
    after: (milliseconds: number, run: () => void) => {
      const timer = { at: clock + milliseconds, run, cancelled: false }
      timers.push(timer)

      return () => void (timer.cancelled = true)
    }
  }

  const target = { roomId: ROOM, eventId: QUESTION }

  const voice = new MatrixTurnVoice(
    new MatrixProgressLine(target, port, { privateChat: true, heartbeatText: () => 'Still working' }),
    new MatrixInterimMessages(target, port, {
      privateChat: true,
      transactionFor: sequence => `atum-ci-${String(sequence).repeat(64)}`
    }),
    locale
  )

  const drain = () => new Promise(resolve => setImmediate(resolve))

  /** Let time pass for the voice only (the turn itself runs on real time). */
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
      await drain()
    }

    clock = end
    await drain()
  }

  const emit = (type: string, payload: Record<string, unknown> = {}, session_id = 'own') => {
    for (const handler of handlers) {
      handler({ type, payload, session_id })
    }
  }

  /** One owner turn, as the engine runs it: the voice hears the progress, ends before the answer is posted. */
  const run = async (
    script: (step: { emit: typeof emit; advance: typeof advance }) => Promise<void>,
    text = 'Lịch hôm nay?'
  ) => {
    const pending = runMatrixHermesTurn(gateway, {
      invocationId: 'fence',
      text,
      workspace: '/disposable',
      turnStyle: true,
      onProgress: event => voice.event(event)
    })

    await vi.waitFor(() => expect(handlers.size).toBe(1))
    await vi.waitFor(() => expect(request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
    await script({ emit, advance })

    const result = await pending
    await voice.end(result.text)
    order.push(`answer:${result.text}`)

    return result
  }

  const finish = (answer: string) => {
    emit('message.complete', { text: answer, status: 'complete' })
    emit('session.info', { running: false, stored_session_id: 'stored' })
  }

  const messages = () => published.filter(command => command.interim).map(command => command.body)
  const lines = () => published.filter(command => !command.interim && !command.redact)
  const removed = () => published.filter(command => command.redact)

  return { run, emit, finish, advance, drain, published, order, messages, lines, removed, request }
}

describe('a Mac turn the owner hears narrated (local path)', () => {
  it('text, then a tool: the agent’s own sentence is the acknowledgement, with no second one of ours', async () => {
    const m = mac()

    const result = await m.run(async ({ emit }) => {
      emit('message.interim', { text: 'raw', redacted_text: 'Mình sẽ đọc lịch và tóm tắt.' })
      emit('tool.start', { name: 'read_file', context: 'SECRET PATH' })
      await m.drain()
      emit('tool.complete', { name: 'read_file' })
      m.finish('Hôm nay bạn có hai cuộc họp.')
    })

    expect(result.text).toBe('Hôm nay bạn có hai cuộc họp.')
    expect(m.messages()).toEqual(['Mình sẽ đọc lịch và tóm tắt.'])
    expect(m.lines().map(command => command.body)).toEqual(['Đang đọc…'])
    // The working line is removed, and that is before the answer is posted.
    expect(m.order.at(-1)).toBe('answer:Hôm nay bạn có hai cuộc họp.')
    expect(m.order.indexOf('redact:$line-2')).toBeGreaterThan(-1)
    expect(m.order.indexOf('redact:$line-2')).toBeLessThan(m.order.indexOf('answer:Hôm nay bạn có hai cuộc họp.'))
  })

  it('a tool and no words: one short localized acknowledgement, once, ahead of the working line', async () => {
    const m = mac()

    await m.run(async ({ emit }) => {
      emit('tool.start', { name: 'web_search' })
      emit('tool.start', { name: 'web_search' })
      await m.drain()
      emit('tool.start', { name: 'terminal' })
      m.finish('Đã tìm xong.')
    })

    expect(m.messages()).toHaveLength(1)
    expect(matrixAcknowledgementCopy.vi).toContain(m.messages()[0])
    expect(m.order[0]).toBe(`message:${m.messages()[0]}`)
    expect(m.lines()[0]).toMatchObject({ body: 'Đang tra cứu trên web…', statusLine: true })
    // An ordinary assistant message of the private chat: never a notice, never part of the model's context.
    expect(m.published[0]).toMatchObject({ roomId: ROOM, eventId: QUESTION, interim: true })
    expect(m.published[0]).not.toHaveProperty('statusLine')
    // The acknowledgement stays (it is not the answer); only the working line is taken back.
    expect(m.removed().map(command => command.replaces)).toEqual(['$line-2'])
  })

  it('says it in the owner’s language', async () => {
    const m = mac('en')

    await m.run(async ({ emit }) => {
      emit('tool.start', { name: 'terminal' })
      m.finish('Done.')
    }, 'Run it')

    expect(matrixAcknowledgementCopy.en).toContain(m.messages()[0])
    expect(m.lines().map(command => command.body)).toEqual(['Running a task…'])
  })

  it('tools over time: the working line keeps editing in place, later remarks keep their 20 s gap, nothing is acknowledged twice', async () => {
    const m = mac()

    await m.run(async ({ emit, advance }) => {
      emit('tool.start', { name: 'web_search' })
      await m.drain()
      await advance(3_100)
      emit('tool.start', { name: 'read_file' })
      await m.drain()
      await advance(25_000)
      emit('message.interim', { text: 'raw', redacted_text: 'Đã tìm xong, đang đọc kết quả.' })
      await m.drain()
      emit('tool.complete', {
        name: 'todo',
        redacted_todos: [{ id: '1', content: 'Đọc kết quả', status: 'in_progress' }]
      })
      await m.drain()
      m.finish('Đây là kết quả.')
    })

    const [ack, remark] = m.messages()
    expect(m.messages()).toHaveLength(2)
    expect(matrixAcknowledgementCopy.vi).toContain(ack)
    expect(remark).toBe('Đã tìm xong, đang đọc kết quả.')
    // One working line: the original and its edits, then its removal.
    const [original, ...edits] = m.lines()
    expect(original).toMatchObject({ body: 'Đang tra cứu trên web…', statusLine: true })
    expect(original).not.toHaveProperty('replaces')
    expect(edits.length).toBeGreaterThanOrEqual(1)
    expect(edits.every(command => command.replaces === '$line-2')).toBe(true)
    expect(m.removed().map(command => command.replaces)).toEqual(['$line-2'])
  })

  it('an answer without a tool: nothing is acknowledged, nothing is shown', async () => {
    const m = mac()

    const result = await m.run(async () => {
      m.finish('Chào bạn!')
    }, 'Chào')

    expect(result.text).toBe('Chào bạn!')
    expect(m.published).toEqual([])
    expect(m.order).toEqual(['answer:Chào bạn!'])
  })

  it('a remark that is just the answer is taken back, so the answer is not said twice', async () => {
    const m = mac()

    await m.run(async ({ emit }) => {
      emit('message.interim', { text: 'raw', redacted_text: 'Hôm nay bạn có hai cuộc họp.' })
      emit('tool.start', { name: 'read_file' })
      await m.drain()
      m.finish('Hôm nay bạn có hai cuộc họp.')
    })

    expect(m.messages()).toEqual(['Hôm nay bạn có hai cuộc họp.'])
    expect(m.removed().map(command => command.replaces)).toEqual(expect.arrayContaining(['$interim-1']))
    expect(m.order.indexOf('redact:$interim-1')).toBeLessThan(m.order.indexOf('answer:Hôm nay bạn có hai cuộc họp.'))
  })

  it('asks the agent for this in the one prompt it submits, the cloud’s own line, and in no other request', async () => {
    const m = mac()

    await m.run(async () => {
      m.finish('Xong.')
    }, 'Lịch hôm nay?')

    const submit = m.request.mock.calls.find(call => call[0] === 'prompt.submit') as unknown as [
      string,
      { text: string }
    ]

    const facts = macOwnerFacts()
    const place = facts.timeZone ? `\ntime zone: ${facts.timeZone} (from this Mac)` : ''
    expect(submit[1].text).toBe(`Lịch hôm nay?\n\n${MATRIX_TURN_CONTEXT_HEADER}\n${MATRIX_TURN_STYLE}${place}`)
    expect(JSON.stringify(m.request.mock.calls.filter(call => call[0] !== 'prompt.submit'))).not.toContain('style:')
  })
})
