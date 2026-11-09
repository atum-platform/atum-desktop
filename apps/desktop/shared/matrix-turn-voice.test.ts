import { describe, expect, it } from 'vitest'

import { MatrixInterimMessages } from './matrix-interim-messages'
import type { MatrixNoticeEdit } from './matrix-notice-edit'
import { MatrixProgressLine } from './matrix-progress-line'
import { matrixAcknowledgementCopy } from './matrix-status-line-copy'
import { MatrixTurnVoice, type MatrixTurnVoiceOptions } from './matrix-turn-voice'

type Locale = keyof typeof matrixAcknowledgementCopy

const LOCALES: Locale[] = ['vi', 'en', 'ja', 'zh', 'zh-hant']

function fixture(locale: Locale = 'vi', options: MatrixTurnVoiceOptions & { privateChat?: boolean } = {}) {
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
    locale,
    options
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
    const quiet = fixture('en', { acknowledge: false })
    quiet.voice.event({ kind: 'tool', name: 'memory' })
    quiet.voice.event({ kind: 'tool', name: 'some_plugin_tool' })
    await quiet.drain()
    expect(quiet.sent).toEqual([])

    // The acknowledgement is its own message; the working line still says nothing for such a tool.
    const acknowledged = fixture('en')
    acknowledged.voice.event({ kind: 'tool', name: 'some_plugin_tool' })
    await acknowledged.drain()
    expect(acknowledged.sent.map(command => [command.interim ? 'message' : 'line', command.body])).toEqual([
      ['message', expect.any(String)]
    ])

    const english = fixture('en')
    english.voice.event({ kind: 'tool', name: 'terminal' })
    await english.drain()
    expect(english.sent.map(command => command.body)).toEqual([expect.any(String), 'Running a task…'])
    expect(english.sent[1]!.interim).toBeUndefined()
  })

  it('at the end removes the working line, keeps the acknowledgement and takes back a remark that repeats the answer', async () => {
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

describe('a turn that starts work without a word is acknowledged (agent-turns/1.4: acknowledge, then keep working)', () => {
  it('says one short line in the owner’s language when the first thing Hermes does is start a tool, ahead of the working line', async () => {
    for (const locale of LOCALES) {
      const { voice, sent, messages, drain } = fixture(locale)

      voice.event({ kind: 'tool', name: 'web_search' })
      await drain()
      expect(messages(), locale).toHaveLength(1)
      expect(matrixAcknowledgementCopy[locale], locale).toContain(messages()[0])
      // An ordinary interim message, not a notice and not the working line; it goes out first.
      expect(sent[0], locale).toMatchObject({ interim: true, roomId: '!room:test', eventId: '$question' })
      expect(sent[0], locale).not.toHaveProperty('statusLine')
      expect(sent[0], locale).not.toHaveProperty('progress')
      expect(sent[1], locale).toMatchObject({ statusLine: true })
    }
  })

  it('says it once however many tools follow, and the working line keeps updating as before', async () => {
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
    expect(messages()).toHaveLength(1)
    expect(sent.filter(command => !command.interim && !command.redact).length).toBeGreaterThan(0)
  })

  it('says nothing when the agent spoke first: text and then a tool is one acknowledgement, the agent’s own', async () => {
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

  it('counts the todo list as work too, and a tool without a working-line word still gets the acknowledgement', async () => {
    const plan = fixture('en')
    plan.voice.event({ kind: 'plan', todos: [{ text: 'Look', state: 'active' }] })
    await plan.drain()
    expect(plan.messages()).toHaveLength(1)

    const other = fixture('en')
    other.voice.event({ kind: 'tool', name: 'atum_google' })
    await other.drain()
    expect(other.messages()).toHaveLength(1)
    expect(other.sent).toHaveLength(1)
  })

  it('is left out for a turn with scripted words of its own, and in a group', async () => {
    const scripted = fixture('vi', { acknowledge: false })
    scripted.voice.event({ kind: 'tool', name: 'memory' })
    await scripted.drain()
    expect(scripted.sent).toEqual([])

    const group = fixture('vi', { privateChat: false })
    group.voice.event({ kind: 'tool', name: 'web_search' })
    await group.drain()
    expect(group.sent).toEqual([])
  })

  it('keeps the acknowledgement at the end, removes the working line, and posts nothing a second time', async () => {
    const { voice, sent, messages, drain } = fixture()

    voice.event({ kind: 'tool', name: 'read_file' })
    await drain()
    await voice.end('Hôm nay bạn có hai cuộc họp.')
    expect(messages()).toHaveLength(1)
    // Only the working line is taken back; the acknowledgement stays because the answer does not repeat it.
    expect(sent.filter(command => command.redact).map(command => command.replaces)).toEqual(['$line-2'])
    expect(sent.filter(command => command.interim)).toHaveLength(1)
  })
})
