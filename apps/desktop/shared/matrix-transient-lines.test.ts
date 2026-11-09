import { describe, expect, it } from 'vitest'

import type { MatrixMessage } from './matrix'
import { matrixStatusLineCopy } from './matrix-status-line-copy'
import { matrixHideEndedTransientLines, matrixWorkingLine } from './matrix-transient-lines'

const AGENT = '@agent:test'
const agents = new Set([AGENT])

let counter = 0

function message(patch: Partial<MatrixMessage>): MatrixMessage {
  return {
    id: `$m${counter++}`,
    sender: AGENT,
    body: 'text',
    timestamp: counter,
    own: false,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...patch
  }
}

const marker = (phase: 'working' | 'waiting' | 'settled' = 'working') =>
  ({ profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase, kind: 'todo', revision: 0 }) as const

const owner = (body: string) => message({ own: true, sender: '@owner:test', body })

const line = (body: string, phase: 'working' | 'waiting' | 'settled' = 'working') =>
  message({ body, notice: true, progress: marker(phase) })

const bodies = (messages: readonly MatrixMessage[]) => messages.map(each => each.body)

describe('hiding working lines whose turn has ended (agent-turns/1.4 A7)', () => {
  it('keeps the line while the turn works, and hides it once the answer arrives', () => {
    const working = [owner('Q'), line('Đang đọc…')]
    expect(bodies(matrixHideEndedTransientLines(working, agents))).toEqual(['Q', 'Đang đọc…'])

    const answered = [...working, message({ body: 'A' })]
    expect(bodies(matrixHideEndedTransientLines(answered, agents))).toEqual(['Q', 'A'])
  })

  it('an interim remark is a real message that does not end the turn', () => {
    const turn = [owner('Q'), message({ body: 'Để mình xem.', interim: true }), line('Đang đọc…')]
    expect(bodies(matrixHideEndedTransientLines(turn, agents))).toEqual(['Q', 'Để mình xem.', 'Đang đọc…'])
    expect(bodies(matrixHideEndedTransientLines([...turn, message({ body: 'A' })], agents))).toEqual([
      'Q',
      'Để mình xem.',
      'A'
    ])
  })

  it('hides settled lines of older builds, and the retired fixed "waiting/waited" status lines', () => {
    const history = [
      owner('Q1'),
      line('Sắp xong.', 'settled'),
      message({ body: 'A1' }),
      owner('Q2'),
      message({ body: matrixStatusLineCopy.vi.waited, notice: true }),
      message({ body: 'Đã chờ máy Mac của bạn.', notice: true }),
      message({ body: 'A2' })
    ]

    expect(bodies(matrixHideEndedTransientLines(history, agents))).toEqual(['Q1', 'A1', 'Q2', 'A2'])
  })

  it('a retired wait line is hidden only when ended, so a live "waiting" still shows', () => {
    const live = [owner('Q'), message({ body: matrixStatusLineCopy.vi.waiting, notice: true })]
    expect(bodies(matrixHideEndedTransientLines(live, agents))).toHaveLength(2)
  })

  it('real outcome notices persist and end the turn', () => {
    const away = message({ body: 'MacBook mẫu đang tắt hoặc đã khoá.', notice: true })
    const turn = [owner('Q'), line('Đang chờ…'), away]
    expect(bodies(matrixHideEndedTransientLines(turn, agents))).toEqual(['Q', away.body])
  })

  it('shows nothing for a message the agent removed (no "deleted" tombstone), but keeps a person\'s', () => {
    const removed = message({ body: '', redacted: true })
    const other = message({ sender: '@friend:test', body: '', redacted: true })
    const mine = message({ own: true, sender: '@owner:test', body: '', redacted: true })
    const kept = matrixHideEndedTransientLines([removed, other, mine], agents)
    expect(kept).toEqual([other, mine])
  })

  it('one agent answering does not end another agent\'s turn, and a stranger\'s notice is never hidden', () => {
    const other = '@other:test'
    const both = new Set([AGENT, other])
    const turn = [owner('Q'), line('Đang đọc…'), message({ sender: other, body: 'Tôi trả lời.' })]
    expect(bodies(matrixHideEndedTransientLines(turn, both))).toEqual(['Q', 'Đang đọc…', 'Tôi trả lời.'])

    const stranger = message({ sender: '@friend:test', body: matrixStatusLineCopy.vi.waited, notice: true })
    expect(matrixHideEndedTransientLines([stranger, message({ body: 'A' })], agents)).toContain(stranger)
  })

  it('a pending or failed message of the agent has not ended the turn', () => {
    const turn = [owner('Q'), line('Đang đọc…'), message({ body: 'A', pending: true })]
    expect(bodies(matrixHideEndedTransientLines(turn, agents))).toEqual(['Q', 'Đang đọc…', 'A'])
  })

  it('does not mutate its input and keeps order', () => {
    const input = [owner('Q'), line('x'), message({ body: 'A' })]
    const copy = [...input]
    matrixHideEndedTransientLines(input, agents)
    expect(input).toEqual(copy)
  })
})

describe('the working line shown under the typing bubble', () => {
  it('is the live progress line while its turn works', () => {
    const worker = line('Đang tìm guesthouse…\n• Kiểm tra giá phòng\n✓ Tìm trên web')
    expect(matrixWorkingLine([owner('Q'), worker], agents)).toBe(worker)
  })

  it('is gone once the answer lands, and never the answer itself', () => {
    const worker = line('Đang tìm guesthouse…')
    expect(matrixWorkingLine([owner('Q'), worker, message({ body: 'A' })], agents)).toBeUndefined()
  })

  it('is still shown when a later interim remark arrives (an interim never ends the turn)', () => {
    const worker = line('Đang tìm guesthouse…')
    expect(matrixWorkingLine([owner('Q'), worker, message({ body: 'Để mình xem.', interim: true })], agents)).toBe(
      worker
    )
  })

  it('shows a live fixed "waiting" line from an older build, but not one whose turn ended', () => {
    const live = message({ body: matrixStatusLineCopy.vi.waiting, notice: true })
    expect(matrixWorkingLine([owner('Q'), live], agents)).toBe(live)

    const ended = message({ body: matrixStatusLineCopy.vi.waited, notice: true })
    expect(matrixWorkingLine([owner('Q'), ended, message({ body: 'A' })], agents)).toBeUndefined()
  })

  it('belongs to the chat\'s own agent when one is named', () => {
    const other = '@other:test'
    const theirs = message({ sender: other, body: 'Đang đọc…', notice: true, progress: marker() })
    expect(matrixWorkingLine([owner('Q'), theirs], new Set([AGENT, other]), AGENT)).toBeUndefined()
    expect(matrixWorkingLine([owner('Q'), theirs], new Set([AGENT, other]), other)).toBe(theirs)
  })

  it('is never a person\'s notice nor a real outcome notice', () => {
    const away = message({ body: 'MacBook mẫu đang tắt hoặc đã khoá.', notice: true })
    expect(matrixWorkingLine([owner('Q'), away], agents)).toBeUndefined()

    const stranger = message({ sender: '@friend:test', body: matrixStatusLineCopy.vi.waiting, notice: true })
    expect(matrixWorkingLine([stranger], agents)).toBeUndefined()
  })
})
