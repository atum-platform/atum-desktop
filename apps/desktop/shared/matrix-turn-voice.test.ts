import { describe, expect, it } from 'vitest'

import { MatrixInterimMessages } from './matrix-interim-messages'
import type { MatrixNoticeEdit } from './matrix-notice-edit'
import { MatrixProgressLine } from './matrix-progress-line'
import type { matrixProgressCopy } from './matrix-status-line-copy'
import { MatrixTurnVoice } from './matrix-turn-voice'

type Locale = keyof typeof matrixProgressCopy

const LOCALES: Locale[] = ['vi', 'en', 'ja', 'zh', 'zh-hant']

function fixture(locale: Locale = 'vi', options: { privateChat?: boolean } = {}) {
  const sent: MatrixNoticeEdit[] = []

  const port = {
    current: () => true,
    publish: async (command: MatrixNoticeEdit) => {
      sent.push(command)

      return command.replaces ?? (command.interim ? `$interim-${sent.length}` : `$line-${sent.length}`)
    },
    now: () => 1_000_000,
    after: () => () => undefined
  }

  const target = { roomId: '!room:test', eventId: '$question' }
  const privateChat = options.privateChat ?? true

  const voice = new MatrixTurnVoice(
    new MatrixProgressLine(target, port, { privateChat, heartbeatText: () => 'beat' }),
    new MatrixInterimMessages(target, port, { privateChat, transactionFor: n => `atum-ci-${String(n).repeat(64)}` }),
    locale
  )

  const messages = () => sent.filter(command => command.interim).map(command => command.body)

  return { voice, sent, messages, drain: () => new Promise(resolve => setImmediate(resolve)) }
}

describe('one turn voice for the cloud, a Mac answering from the room and a Mac-typed turn', () => {
  it('routes Hermes events: remarks are real messages, tools and the todo list are the one working line', async () => {
    const { voice, sent, drain } = fixture()

    voice.event({ kind: 'narration', text: 'Để mình xem video này rồi tóm tắt nhé.' })
    voice.event({ kind: 'tool', name: 'web_search' })
    await drain()
    expect(sent.map(command => [command.interim ? 'message' : 'line', command.body])).toEqual([
      ['message', 'Để mình xem video này rồi tóm tắt nhé.'],
      ['line', 'Đang tra cứu trên web…']
    ])
  })

  it('keeps the working line quiet for a tool without a category, in the owner’s language otherwise', async () => {
    const quiet = fixture('en')
    quiet.voice.event({ kind: 'tool', name: 'memory' })
    quiet.voice.event({ kind: 'tool', name: 'some_plugin_tool' })
    await quiet.drain()
    expect(quiet.sent).toEqual([])

    const english = fixture('en')
    english.voice.event({ kind: 'tool', name: 'terminal' })
    await english.drain()
    expect(english.sent.map(command => command.body)).toEqual(['Running a task…'])
    expect(english.sent[0]!.interim).toBeUndefined()
  })

  it('at the end removes the working line and takes back a remark that repeats the answer', async () => {
    const { voice, sent, drain } = fixture()

    voice.event({ kind: 'narration', text: 'Hôm nay bạn có hai cuộc họp.' })
    voice.event({ kind: 'tool', name: 'read_file' })
    await drain()
    await voice.end('Hôm nay bạn có hai cuộc họp.')
    expect(sent.filter(command => command.redact).map(command => command.replaces)).toEqual(
      expect.arrayContaining(['$line-2', '$interim-1'])
    )
    expect(sent.filter(command => command.redact)).toHaveLength(2)

    const kept = fixture()
    kept.voice.event({ kind: 'narration', text: 'Để mình xem video này.' })
    await kept.drain()
    await kept.voice.end('Video nói về lịch sử Việt Nam.')
    expect(kept.sent.filter(command => command.redact)).toEqual([])
  })
})

describe('a turn that starts work without a word gets no canned opener (Atum never speaks in the agent’s place)', () => {
  it('publishes no message of ours when the first thing Hermes does is start a tool: the working line goes out alone', async () => {
    for (const locale of LOCALES) {
      const { voice, sent, messages, drain } = fixture(locale)

      voice.event({ kind: 'tool', name: 'web_search' })
      await drain()
      expect(messages(), locale).toEqual([])
      expect(sent, locale).toHaveLength(1)
      expect(sent[0], locale).toMatchObject({ statusLine: true, roomId: '!room:test', eventId: '$question' })
      expect(sent[0], locale).not.toHaveProperty('interim')
    }
  })

  it('stays silent in words however many tools follow, while the working line keeps updating', async () => {
    const { voice, sent, messages, drain } = fixture('en')

    voice.event({ kind: 'tool', name: 'web_search' })
    voice.event({ kind: 'tool', name: 'read_file' })
    voice.event({ kind: 'tool', name: 'terminal' })
    voice.event({
      kind: 'plan',
      todos: [
        { text: 'Look', state: 'done' },
        { text: 'Write', state: 'active' }
      ]
    })
    await drain()
    expect(messages()).toEqual([])
    expect(sent.filter(command => command.statusLine && !command.redact).length).toBeGreaterThan(0)
  })

  it('keeps the agent’s own first sentence exactly as it said it, with nothing added', async () => {
    const { voice, messages, drain } = fixture()

    voice.event({ kind: 'narration', text: 'Để mình xem video này rồi tóm tắt nhé.' })
    voice.event({ kind: 'tool', name: 'web_extract' })
    voice.event({ kind: 'tool', name: 'terminal' })
    await drain()
    expect(messages()).toEqual(['Để mình xem video này rồi tóm tắt nhé.'])
  })

  it('says nothing for a turn that answers without starting anything', async () => {
    const { voice, sent, drain } = fixture()

    await drain()
    await voice.end('Chào bạn!')
    expect(sent).toEqual([])
  })

  it('a todo list or a tool without a working-line word adds no message either', async () => {
    const plan = fixture('en')
    plan.voice.event({ kind: 'plan', todos: [{ text: 'Look', state: 'active' }] })
    await plan.drain()
    expect(plan.messages()).toEqual([])

    const other = fixture('en')
    other.voice.event({ kind: 'tool', name: 'atum_google' })
    await other.drain()
    expect(other.sent).toEqual([])

    const group = fixture('vi', { privateChat: false })
    group.voice.event({ kind: 'tool', name: 'web_search' })
    await group.drain()
    expect(group.sent).toEqual([])
  })

  it('at the end removes only the working line; the answer is the turn’s only message', async () => {
    const { voice, sent, messages, drain } = fixture()

    voice.event({ kind: 'tool', name: 'read_file' })
    await drain()
    await voice.end('Hôm nay bạn có hai cuộc họp.')
    expect(messages()).toEqual([])
    expect(sent.filter(command => command.redact).map(command => command.replaces)).toEqual(['$line-1'])
  })
})
