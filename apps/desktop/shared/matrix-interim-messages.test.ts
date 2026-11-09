import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  MATRIX_INTERIM_MIN_GAP_MS,
  matrixInterimDecision,
  type MatrixInterimInput,
  MatrixInterimMessages,
  matrixRepeatsAnswer
} from './matrix-interim-messages'
import type { MatrixNoticeEdit } from './matrix-notice-edit'

const target = { roomId: '!room:test', eventId: '$question' }

const pack = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../../packages/device-protocol/fixtures/agent-turns/${file}`, import.meta.url), 'utf8'))

function harness(options: { privateChat?: boolean; publishFails?: (command: MatrixNoticeEdit) => boolean } = {}) {
  let clock = 1_000_000
  let live = true
  const sent: MatrixNoticeEdit[] = []
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []

  const interim = new MatrixInterimMessages(
    target,
    {
      current: () => live,
      publish: async command => {
        if (options.publishFails?.(command)) {
          throw new Error('boom')
        }

        sent.push(command)

        return command.replaces ?? `$interim-${sent.filter(each => each.interim).length}`
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
    { privateChat: options.privateChat ?? true, transactionFor: sequence => `atum-ci-${String(sequence).repeat(64)}` }
  )

  const drain = () => new Promise(resolve => setImmediate(resolve))

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

  return { interim, sent, advance, drain, stop: () => (live = false) }
}

describe('interim messages (agent-turns/1.4 A9)', () => {
  it('posts the first remark at once as a real message under a deterministic transaction', async () => {
    const { interim, sent, drain } = harness()

    interim.offer('Để mình xem video này rồi tóm tắt nhé.')
    await drain()
    expect(sent).toEqual([
      {
        ...target,
        body: 'Để mình xem video này rồi tóm tắt nhé.',
        interim: true,
        transactionId: `atum-ci-${'0'.repeat(64)}`
      }
    ])
    // A real message, never a status line or a working line.
    expect(sent[0]).not.toHaveProperty('statusLine')
    expect(sent[0]).not.toHaveProperty('progress')
  })

  it('later remarks go out at most once per 20 s, and a burst keeps only the newest', async () => {
    const { interim, sent, advance, drain } = harness()

    interim.offer('Ack.')
    await drain()
    await advance(5_000)
    interim.offer('Một.')
    interim.offer('Hai.')
    interim.offer('Ba.')
    await drain()
    expect(sent).toHaveLength(1)

    await advance(MATRIX_INTERIM_MIN_GAP_MS)
    expect(sent.map(command => command.body)).toEqual(['Ack.', 'Ba.'])
    expect(sent[1]!.transactionId).toBe(`atum-ci-${'1'.repeat(64)}`)

    // The gap restarts from the moment the second message went out (5 s ago here).
    interim.offer('Bốn.')
    await advance(MATRIX_INTERIM_MIN_GAP_MS - 10_000)
    expect(sent).toHaveLength(2)
    await advance(11_000)
    expect(sent.map(command => command.body)).toEqual(['Ack.', 'Ba.', 'Bốn.'])
  })

  it('does not say the same words twice in a row', async () => {
    const { interim, sent, advance, drain } = harness()

    interim.offer('Đang xem.')
    await drain()
    await advance(MATRIX_INTERIM_MIN_GAP_MS + 1)
    interim.offer('Đang xem.')
    await advance(MATRIX_INTERIM_MIN_GAP_MS + 1)
    expect(sent).toHaveLength(1)
  })

  it('drops a held remark when the turn ends, and removes a published one that repeats the answer', async () => {
    const { interim, sent, advance, drain } = harness()

    interim.offer('Ack.')
    await drain()
    await advance(1_000)
    interim.offer('Hôm nay bạn có hai cuộc họp lúc chín giờ.')
    await interim.end('Hôm nay bạn có hai cuộc họp lúc chín giờ và mười một giờ.')
    await advance(MATRIX_INTERIM_MIN_GAP_MS * 2)

    // The held remark never goes out late; Ack stays (it does not repeat the answer).
    expect(sent.map(command => command.body)).toEqual(['Ack.'])

    const second = harness()
    second.interim.offer('Hôm nay bạn có hai cuộc họp.')
    await second.drain()
    await second.interim.end('Hôm nay bạn có hai cuộc họp.')
    expect(second.sent.at(-1)).toEqual({ ...target, body: '', redact: true, replaces: '$interim-1' })
  })

  it('is silent in a group, once the fence is lost, and after the turn ended', async () => {
    const group = harness({ privateChat: false })
    group.interim.offer('Hello')
    await group.drain()
    expect(group.sent).toEqual([])

    const fenced = harness()
    fenced.stop()
    fenced.interim.offer('Hello')
    await fenced.drain()
    expect(fenced.sent).toEqual([])

    const done = harness()
    await done.interim.end()
    done.interim.offer('Late')
    await done.drain()
    expect(done.sent).toEqual([])
  })

  it('a remark that cannot be published is logged and never fails the turn', async () => {
    const { interim, advance, drain, sent } = harness({ publishFails: () => true })

    interim.offer('One')
    await drain()
    await advance(MATRIX_INTERIM_MIN_GAP_MS + 1)
    interim.offer('Two')
    await advance(1)
    await expect(interim.end('answer')).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  it('waits for a Mac-typed question to be synced before posting', async () => {
    let resolve!: (id: string) => void
    const question = new Promise<string>(done => (resolve = done))
    const sent: MatrixNoticeEdit[] = []

    const interim = new MatrixInterimMessages(
      { roomId: target.roomId, eventId: () => question },
      {
        current: () => true,
        publish: async command => {
          sent.push(command)

          return '$interim'
        },
        now: () => 1,
        after: () => () => undefined
      },
      { privateChat: true, transactionFor: () => `atum-ci-${'0'.repeat(64)}` }
    )

    interim.offer('Ack.')
    await new Promise(done => setImmediate(done))
    expect(sent).toEqual([])
    resolve('$typed-question')
    await interim.end()
    expect(sent[0]).toMatchObject({ eventId: '$typed-question', body: 'Ack.', interim: true })
  })
})

describe('the acknowledgement of a turn that starts work without a word', () => {
  const lines = ['One.', 'Two.', 'Three.']

  it('posts one of the lines as the turn\u2019s first remark, in the same shape as any remark', async () => {
    const { interim, sent, drain } = harness()

    interim.acknowledge(lines)
    await drain()
    expect(sent).toEqual([{ ...target, body: 'One.', interim: true, transactionId: `atum-ci-${'0'.repeat(64)}` }])
    expect(sent[0]).not.toHaveProperty('statusLine')
    expect(sent[0]).not.toHaveProperty('progress')
  })

  it('is said once and never after a remark has gone out', async () => {
    const twice = harness()

    twice.interim.acknowledge(lines)
    twice.interim.acknowledge(lines)
    await twice.drain()
    expect(twice.sent.map(command => command.body)).toEqual(['One.'])

    const spoke = harness()

    spoke.interim.offer('Mình sẽ đọc lịch.')
    await spoke.drain()
    spoke.interim.acknowledge(lines)
    await spoke.drain()
    expect(spoke.sent.map(command => command.body)).toEqual(['Mình sẽ đọc lịch.'])
  })

  it('does not stop the model\u2019s own next remark, which follows the usual gap', async () => {
    const { interim, sent, advance, drain } = harness()

    interim.acknowledge(lines)
    await drain()
    interim.offer('Đã đọc xong, đang tóm tắt.')
    await advance(MATRIX_INTERIM_MIN_GAP_MS - 1_000)
    expect(sent.map(command => command.body)).toEqual(['One.'])
    await advance(2_000)
    expect(sent.map(command => command.body)).toEqual(['One.', 'Đã đọc xong, đang tóm tắt.'])
    expect(sent[1]!.transactionId).toBe(`atum-ci-${'1'.repeat(64)}`)
  })

  it('picks the wording from the turn\u2019s own transaction, so a retry says the same thing', async () => {
    const say = async (suffix: string) => {
      const sent: MatrixNoticeEdit[] = []

      const interim = new MatrixInterimMessages(
        target,
        {
          current: () => true,
          publish: async command => {
            sent.push(command)

            return '$interim'
          },
          now: () => 1,
          after: () => () => undefined
        },
        { privateChat: true, transactionFor: () => `atum-ci-${'a'.repeat(56)}${suffix}` }
      )

      interim.acknowledge(lines)
      await interim.end()

      return sent[0]!.body
    }

    expect([await say('00000000'), await say('00000001'), await say('00000002'), await say('00000003')]).toEqual([
      'One.',
      'Two.',
      'Three.',
      'One.'
    ])
    expect(await say('00000001')).toBe(await say('00000001'))
  })

  it('is silent in a group, once the fence is lost, after the turn ended and with nothing to say', async () => {
    const group = harness({ privateChat: false })
    group.interim.acknowledge(lines)
    await group.drain()
    expect(group.sent).toEqual([])

    const fenced = harness()
    fenced.stop()
    fenced.interim.acknowledge(lines)
    await fenced.drain()
    expect(fenced.sent).toEqual([])

    const done = harness()
    await done.interim.end()
    done.interim.acknowledge(lines)
    await done.drain()
    expect(done.sent).toEqual([])

    const empty = harness()
    empty.interim.acknowledge([])
    await empty.drain()
    expect(empty.sent).toEqual([])
  })

  it('stays when the answer is something else, and is taken back only if the answer says exactly it', async () => {
    const kept = harness()

    kept.interim.acknowledge(lines)
    await kept.drain()
    await kept.interim.end('Hôm nay bạn có hai cuộc họp.')
    expect(kept.sent.filter(command => command.redact)).toEqual([])

    const repeated = harness()

    repeated.interim.acknowledge(['Mình xem ngay nhé.'])
    await repeated.drain()
    await repeated.interim.end('Mình xem ngay nhé.')
    expect(repeated.sent.at(-1)).toEqual({ ...target, body: '', redact: true, replaces: '$interim-1' })
  })

  it('a failed publication is logged and never fails the turn', async () => {
    const { interim, sent, drain } = harness({ publishFails: () => true })

    interim.acknowledge(lines)
    await drain()
    await expect(interim.end('answer')).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })
})

describe('the frozen policy vectors (spec/agent-turns/v1.4)', () => {
  it('decides every interim vector the way the pack does', () => {
    const { vectors } = pack('fixtures/interim-policy.vectors.json') as {
      vectors: Array<MatrixInterimInput & { name: string; decision: string }>
    }

    expect(vectors.length).toBeGreaterThan(0)

    for (const { name, decision, ...input } of vectors) {
      expect(matrixInterimDecision(input), name).toBe(decision)
    }
  })

  it('shares the pack bounds', () => {
    expect(pack('contract.json').parameters.interim_min_gap_ms).toBe(MATRIX_INTERIM_MIN_GAP_MS)
  })
})

describe('matrixRepeatsAnswer', () => {
  it('is the same words or a real sentence contained in the answer, and nothing shorter', () => {
    expect(matrixRepeatsAnswer('Xong rồi!', 'xong rồi')).toBe(true)
    expect(matrixRepeatsAnswer('Hôm nay có hai cuộc họp', 'Hôm nay có hai cuộc họp, lúc chín giờ.')).toBe(true)
    expect(matrixRepeatsAnswer('Ok', 'Ok, mình làm xong rồi nhé.')).toBe(false)
    expect(matrixRepeatsAnswer('Để mình xem video này', 'Video nói về lịch sử.')).toBe(false)
    expect(matrixRepeatsAnswer('Để mình xem', undefined)).toBe(false)
  })
})
