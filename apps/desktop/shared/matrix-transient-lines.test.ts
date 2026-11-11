import { describe, expect, it } from 'vitest'

import type { MatrixMessage } from './matrix'
import { MATRIX_COMPANY_PROGRESS_EXPIRY_MS, matrixCompanyTurnMemory } from './matrix-company-presentation'
import { matrixStatusLineCopy } from './matrix-status-line-copy'
import {
  matrixCompanyLineExpiresAt,
  matrixHideEndedTransientLines,
  matrixLiveWorkingLine,
  matrixWorkingLine
} from './matrix-transient-lines'

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

describe('a company agent working line (agent-turns/1.6) ends only by its exact identity', () => {
  const TASK_A = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f'
  const TASK_B = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e80'

  const identity = (rootId: string, taskId = TASK_A, triggerEventId = rootId) => ({
    companyId: '3c1a9e2b-7d4f-4a10-8b2e-5f6a7b8c9d0e',
    agentPrincipal: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    audience: { kind: 'channel', channelId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e' } as const,
    roomId: '!company:test',
    threadRootEventId: rootId,
    taskId,
    invocationId: 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a',
    revision: 0,
    triggerEventId
  })

  const companyLine = (body: string, rootId: string, phase: 'working' | 'settled' = 'working', taskId = TASK_A) =>
    message({
      body,
      notice: true,
      progress: { profile: 'atum.agent-turns/1.6', scope: 'company', phase, kind: phase === 'settled' ? 'settled' : 'todo', revision: 0 },
      company: identity(rootId, taskId)
    })

  it('keeps thread B\'s line when thread A gets its answer', () => {
    const b = companyLine('Reading the board…', '$b')
    const shown = matrixHideEndedTransientLines([owner('A?'), owner('B?'), b, message({ body: 'Answer A' })], agents)

    expect(shown).toContain(b)
    expect(matrixWorkingLine(shown, agents, AGENT)).toBe(b)
  })

  it('is never ended by a later message of its agent: another task\'s answer, a status, a reply naming no trigger', () => {
    const line = companyLine('Reading the board…', '$a')

    for (const later of [
      message({ body: 'Answer to another task in this thread' }),
      message({ body: 'Stopped.', notice: true }),
      message({ body: 'Let me check one more thing.', interim: true }),
      companyLine('Another task is done', '$a', 'settled', TASK_B)
    ]) {
      expect(matrixWorkingLine([line, later], agents, AGENT)).toBe(line)
    }
  })

  it('is hidden once settled or redacted, and a settled line fences every line of the same identity', () => {
    expect(matrixWorkingLine([companyLine('Done', '$a', 'settled')], agents, AGENT)).toBeUndefined()
    expect(matrixWorkingLine([{ ...companyLine('x', '$a'), redacted: true }], agents, AGENT)).toBeUndefined()

    // Two events of one identity (never published, but a forged or replayed one): settled anywhere wins.
    const replayed = companyLine('Reading the board…', '$a')

    expect(matrixWorkingLine([companyLine('Done', '$a', 'settled'), replayed], agents, AGENT)).toBeUndefined()
    expect(matrixWorkingLine([replayed, companyLine('Done', '$a', 'settled')], agents, AGENT)).toBeUndefined()

    // A settled line of another task fences nothing here.
    const other = companyLine('Reading the board…', '$a', 'working', TASK_B)

    expect(matrixWorkingLine([other, companyLine('Done', '$a', 'settled')], agents, AGENT)).toBe(other)
  })

  it('never ends a personal line by itself, and a personal line still ends on the answer', () => {
    const personal = line('Đang đọc…')

    expect(matrixWorkingLine([personal, companyLine('Reading the board…', '$a')], agents, AGENT)).toEqual(
      expect.objectContaining({ body: 'Reading the board…' })
    )
    expect(matrixHideEndedTransientLines([personal, message({ body: 'Answer' })], agents)).not.toContain(personal)
  })

  it('reads a long history in one pass, and the live line of the kept list without filtering again', () => {
    const lines = Array.from({ length: 2_000 }, (_, index) =>
      companyLine(`Step ${index}`, `$t${index}`, index % 2 ? 'settled' : 'working'))

    const kept = matrixHideEndedTransientLines(lines, agents)

    expect(kept).toHaveLength(1_000)
    expect(matrixLiveWorkingLine(kept, agents, AGENT)?.body).toBe('Step 1998')
  })

  it('keeps a tuple ended once seen settled, even after the settling edit is redacted (working again)', () => {
    const memory = matrixCompanyTurnMemory()
    const settled = { ...companyLine('Done', '$a', 'settled'), id: '$line' }

    expect(matrixWorkingLine([settled], agents, AGENT)).toBeUndefined()
    matrixHideEndedTransientLines([settled], agents, { memory })

    // The settling edit is redacted: the projection now shows the surviving lower working revision.
    const resurrected = { ...companyLine('Reading the board…', '$a'), id: '$line' }

    expect(matrixWorkingLine([resurrected], agents, AGENT)).toBe(resurrected)
    expect(matrixHideEndedTransientLines([resurrected], agents, { memory })).toEqual([])
    // Another tuple is untouched by that memory.
    const other = companyLine('Reading the board…', '$a', 'working', TASK_B)

    expect(matrixHideEndedTransientLines([other], agents, { memory })).toEqual([other])
  })

  it('keeps a tuple ended once a drawn line of it is seen redacted, so a replay of the tuple stays hidden', () => {
    const memory = matrixCompanyTurnMemory()
    const live = { ...companyLine('Reading the board…', '$a'), id: '$line' }

    expect(matrixHideEndedTransientLines([live], agents, { memory })).toEqual([live])
    matrixHideEndedTransientLines([{ ...message({ body: '', redacted: true }), id: '$line' }], agents, { memory })

    const replay = { ...companyLine('Reading the board…', '$a'), id: '$replay' }

    expect(matrixHideEndedTransientLines([replay], agents, { memory })).toEqual([])
  })

  it('expires a line whose newest accepted revision is older than three quiet heartbeats, and expired is not done', () => {
    const memory = matrixCompanyTurnMemory()
    const at = 1_000_000

    const revised = (revisedAt: number, id = '$line') => {
      const each = companyLine('Reading the board…', '$a')

      return { ...each, id, company: { ...each.company!, revisedAt } }
    }

    const live = revised(at)

    // Live through the bound, hidden one millisecond after it.
    expect(matrixHideEndedTransientLines([live], agents, { memory, now: at + MATRIX_COMPANY_PROGRESS_EXPIRY_MS })).toEqual([live])
    expect(matrixHideEndedTransientLines([live], agents, { memory, now: at + MATRIX_COMPANY_PROGRESS_EXPIRY_MS + 1 })).toEqual([])
    // The next expiry is exactly that instant; an expired line schedules nothing more.
    expect(matrixCompanyLineExpiresAt([live], at, memory.ended)).toBe(at + MATRIX_COMPANY_PROGRESS_EXPIRY_MS + 1)
    expect(matrixCompanyLineExpiresAt([live], at + MATRIX_COMPANY_PROGRESS_EXPIRY_MS + 1, memory.ended)).toBeUndefined()

    // Expired is not ended: nothing is remembered, and a newer revision of the tuple shows it again.
    expect(memory.ended.size).toBe(0)
    const later = at + MATRIX_COMPANY_PROGRESS_EXPIRY_MS + 60_000
    const heartbeat = revised(later)

    expect(matrixHideEndedTransientLines([heartbeat], agents, { memory, now: later + 1 })).toEqual([heartbeat])
    // Nor does it end the turn the way an answer does: a personal line is not involved, and the
    // expired line's agent can still show its other live tuple.
    const other = { ...companyLine('Another task', '$a', 'working', TASK_B), id: '$other' }
    const otherLive = { ...other, company: { ...other.company!, revisedAt: later } }

    expect(matrixWorkingLine([live, otherLive], agents, AGENT)).toBe(otherLive)
    expect(
      matrixLiveWorkingLine(
        matrixHideEndedTransientLines([live, otherLive], agents, { memory, now: later + 1 }),
        agents,
        AGENT
      )
    ).toBe(otherLive)
    // A settled tuple never schedules an expiry.
    const done = { ...companyLine('Done', '$a', 'settled'), id: '$done' }

    expect(matrixCompanyLineExpiresAt([{ ...done, company: { ...done.company!, revisedAt: at } }], at)).toBeUndefined()
  })
})
